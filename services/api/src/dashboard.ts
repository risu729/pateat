import {
  MANAGE_DASHBOARD_P90_MIN,
  MANAGE_DASHBOARD_RANGE_MS,
  type ManageDashboard,
  type ManageDashboardEvent,
  type ManageDashboardFailure,
  type ManageDashboardRange,
  type ManageDurations,
  type ManageLoginParts,
} from "@pateat/contracts";
import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { CLAUDE_CALL_LIMITS } from "./claude/calls";
import {
  inferenceLog,
  inferenceSpend,
  loginOutcomes,
  loginTimings,
  recipeHeads,
} from "./db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Request log roles, with an account switch's logout (ADR 0063) apart from generation. */
const ROLES = ["generate", "judge", "logout"] as const;
type Role = (typeof ROLES)[number];
const SLOWEST = 10;
const LATEST_PER_CODE = 20;
/**
 * Login results that waited for the person or that the person stopped: the ordinary
 * steps of a site that asks for a code or an approval, not failures.
 */
const NEEDS_PERSON = new Set(["challenge", "challenge-abandoned", "watch-abandoned", "cancelled"]);

/** The request log columns the dashboard reads. */
export type DashboardRequest = {
  role: Role;
  /**
   * Whether the request called the model: a row with a model. A request answered without
   * a call (ADR 0012) counts as a request and by its outcome, never in the model's times.
   */
  called: boolean;
  origin: string;
  outcome: string;
  recipeId: string | null;
  revision: number | null;
  recipePage: "first" | "continuation" | "logout" | null;
  build: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  preModelMs: number | null;
  tokenMs: number | null;
  modelMs: number | null;
  serverMs: number | null;
  createdAt: number;
};
/** The login record columns the dashboard reads (ADR 0055). */
export type DashboardLogin = {
  recipeId: string;
  revision: number;
  origin: string;
  outcome: string;
  cause: string | null;
  extensionBuild: string;
  totalMs: number;
  serviceMs: number;
  networkMs: number;
  personMs: number;
  pageMs: number;
  createdAt: number;
};
export type DashboardInput = {
  range: ManageDashboardRange;
  now: number;
  requests: DashboardRequest[];
  /** Every login a device reported in the range. */
  logins: DashboardLogin[];
  /** The result codes of the first login with each recipe revision (ADR 0019). */
  firstLogins: { outcome: string }[];
  spend: { dayMicroUsd: number; monthMicroUsd: number };
  activeRecipes: number;
};

/** The nearest-rank percentile `q` of ascending values. */
const rank = (sorted: number[], q: number) =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
const median = (values: number[]) =>
  values.length
    ? rank(
        values.toSorted((a, b) => a - b),
        0.5,
      )
    : null;

export function durations(values: number[]): ManageDurations {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  if (n >= MANAGE_DASHBOARD_P90_MIN) return { n, p50: rank(sorted, 0.5), p90: rank(sorted, 0.9) };
  return { n, p50: n ? rank(sorted, 0.5) : null, values: sorted };
}

/** The values a row has for `pick`, skipping rows without one. */
function present<T>(rows: T[], pick: (row: T) => number | null): number[] {
  return rows.flatMap((row) => {
    const value = pick(row);
    return value === null ? [] : [value];
  });
}

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A login's own time: its total less the person's, never below 0. */
const loginTime = (row: DashboardLogin) => Math.max(0, row.totalMs - row.personMs);
const signedIn = (row: DashboardLogin) => row.outcome === "authenticated";

/** A login's wait for the site, never more than its own time less the service's. */
const pageTime = (row: DashboardLogin) =>
  Math.min(row.pageMs, Math.max(0, loginTime(row) - row.serviceMs));

/** The median of each part of a login's time (`manageLoginPartsSchema`). */
function loginParts(rows: DashboardLogin[]): ManageLoginParts {
  return {
    n: rows.length,
    networkMs: median(rows.map((row) => Math.min(row.networkMs, row.serviceMs))),
    serviceOtherMs: median(rows.map((row) => Math.max(0, row.serviceMs - row.networkMs))),
    pageMs: median(rows.map(pageTime)),
    otherMs: median(rows.map((row) => Math.max(0, loginTime(row) - row.serviceMs - pageTime(row)))),
    personMs: median(rows.map((row) => row.personMs)),
  };
}

/** Result codes by outcome, most frequent first. */
const outcomeCounts = (rows: { outcome: string }[]) =>
  [...Map.groupBy(rows, (row) => row.outcome)]
    .map(([outcome, group]) => ({ outcome, count: group.length }))
    .toSorted((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome));

/** Groups result codes, keeping each code's latest rows; `events` must be newest first. */
function failureGroups(
  events: { kind: ManageDashboardFailure["kind"]; code: string; event: ManageDashboardEvent }[],
): ManageDashboardFailure[] {
  return [...Map.groupBy(events, (entry) => `${entry.kind}\u0000${entry.code}`).values()]
    .map((group) => {
      const [last] = group;
      return {
        kind: last!.kind,
        code: last!.code,
        count: group.length,
        lastAt: last!.event.at,
        lastOrigin: last!.event.origin,
        lastRecipeId: last!.event.recipeId,
        latest: group.slice(0, LATEST_PER_CODE).map((entry) => entry.event),
      };
    })
    .toSorted((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/** Aggregates the range's rows in the Worker; D1 has no percentile function. */
export function summarizeDashboard(input: DashboardInput): ManageDashboard {
  const { range, now } = input;
  const from = now - MANAGE_DASHBOARD_RANGE_MS[range];
  const requests = input.requests.toSorted((a, b) => b.createdAt - a.createdAt);

  // Latency counts only the times a row has; rows logged before they were recorded have none.
  // Speed is the speed of model calls: a request answered without one has a server time
  // but no call, so it never counts there.
  const calls = requests.filter((row) => row.called);
  const llm = ROLES.map((role) => {
    const rows = calls.filter((row) => row.role === role);
    const timed = rows.flatMap((row) =>
      row.preModelMs !== null &&
      row.tokenMs !== null &&
      row.modelMs !== null &&
      row.serverMs !== null
        ? [
            {
              preModelOther: Math.max(0, row.preModelMs - row.tokenMs),
              token: row.tokenMs,
              model: row.modelMs,
              afterModel: Math.max(0, row.serverMs - row.preModelMs - row.modelMs),
            },
          ]
        : [],
    );
    return {
      role,
      calls: rows.length,
      modelMs: durations(present(rows, (row) => row.modelMs)),
      tokenMs: durations(present(rows, (row) => row.tokenMs)),
      preModelMs: durations(present(rows, (row) => row.preModelMs)),
      serverMs: durations(present(rows, (row) => row.serverMs)),
      parts: {
        n: timed.length,
        preModelOtherMs: median(timed.map((row) => row.preModelOther)),
        tokenMs: median(timed.map((row) => row.token)),
        modelMs: median(timed.map((row) => row.model)),
        afterModelMs: median(timed.map((row) => row.afterModel)),
      },
      inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    };
  });

  const logins = input.logins.toSorted((a, b) => b.createdAt - a.createdAt);
  const byDay = Map.groupBy(requests, (row) => utcDay(row.createdAt));
  const loginsByDay = Map.groupBy(logins, (row) => utcDay(row.createdAt));
  const daily: ManageDashboard["daily"] = [];
  for (let day = Date.parse(utcDay(from)); day <= now; day += DAY_MS) {
    const key = utcDay(day);
    const rows = byDay.get(key) ?? [];
    const modelP50 = (role: Role) =>
      median(
        present(
          rows.filter((row) => row.role === role),
          (row) => row.modelMs,
        ),
      );
    daily.push({
      day: key,
      generateRequests: rows.filter((row) => row.role === "generate").length,
      judgeRequests: rows.filter((row) => row.role === "judge").length,
      generateModelP50: modelP50("generate"),
      judgeModelP50: modelP50("judge"),
      logins: loginsByDay.get(key)?.length ?? 0,
      authenticatedLogins: loginsByDay.get(key)?.filter(signedIn).length ?? 0,
      loginP50: median((loginsByDay.get(key) ?? []).filter(signedIn).map(loginTime)),
    });
  }

  // Login speed counts the logins that signed in; every login counts toward the counts.
  const signedInLogins = logins.filter(signedIn);
  const waited = signedInLogins.filter((row) => row.serviceMs > 0);
  const recipeOnly = signedInLogins.filter((row) => row.serviceMs === 0);
  const loginSites = [...Map.groupBy(logins, (row) => row.origin)]
    .map(([origin, rows]) => ({
      origin,
      logins: rows.length,
      signedIn: rows.filter(signedIn).length,
      loginMs: durations(rows.filter(signedIn).map(loginTime)),
    }))
    .toSorted(
      (a, b) =>
        (b.loginMs.p50 ?? -1) - (a.loginMs.p50 ?? -1) ||
        b.logins - a.logins ||
        a.origin.localeCompare(b.origin),
    );
  // `logins` is newest first, so each group's first row is its last use.
  const loginBuilds = [...Map.groupBy(logins, (row) => row.extensionBuild)].map(
    ([build, rows]) => ({
      build,
      logins: rows.length,
      lastAt: rows[0]!.createdAt,
      loginMs: durations(rows.filter(signedIn).map(loginTime)),
    }),
  );

  const slowest = calls
    .filter((row): row is DashboardRequest & { serverMs: number } => row.serverMs !== null)
    .toSorted((a, b) => b.serverMs - a.serverMs || b.createdAt - a.createdAt)
    .slice(0, SLOWEST)
    .map((row) => ({
      at: row.createdAt,
      role: row.role,
      origin: row.origin,
      outcome: row.outcome,
      tokenMs: row.tokenMs,
      modelMs: row.modelMs,
      serverMs: row.serverMs,
    }));

  const perSite = [...Map.groupBy(requests, (row) => row.origin)]
    .map(([origin, rows]) => ({
      origin,
      requests: rows.length,
      serverMs: durations(present(rows, (row) => (row.called ? row.serverMs : null))),
      modelMs: durations(present(rows, (row) => row.modelMs)),
    }))
    .toSorted(
      (a, b) =>
        (b.serverMs.p50 ?? -1) - (a.serverMs.p50 ?? -1) ||
        (b.modelMs.p50 ?? -1) - (a.modelMs.p50 ?? -1) ||
        a.origin.localeCompare(b.origin),
    );

  // `requests` is newest first, so each group's first row is its last use.
  const perBuild = [...Map.groupBy(requests, (row) => row.build)].map(([build, rows]) => ({
    build,
    requests: rows.length,
    lastAt: rows[0]!.createdAt,
    modelMs: durations(present(rows, (row) => row.modelMs)),
    serverMs: durations(present(rows, (row) => (row.called ? row.serverMs : null))),
  }));

  const requestCounts = [
    ...Map.groupBy(requests, (row) => `${row.role}\u0000${row.outcome}`).values(),
  ]
    .map((rows) => ({ role: rows[0]!.role, outcome: rows[0]!.outcome, count: rows.length }))
    .toSorted((a, b) => b.count - a.count || a.role.localeCompare(b.role));

  // A request answered with a recipe another request stored (`recipe`) did not fail.
  const requestEvents = requests
    .filter((row) => row.outcome !== "ok" && row.outcome !== "recipe")
    .map((row) => ({
      kind: "request" as const,
      code: row.outcome,
      at: row.createdAt,
      event: {
        at: row.createdAt,
        origin: row.origin,
        recipeId: row.recipeId,
        revision: row.revision,
        role: row.role,
        cause: null,
      },
    }));
  const loginEvents = logins
    .filter((row) => !signedIn(row))
    .map((row) => ({
      kind: "login" as const,
      code: row.outcome,
      at: row.createdAt,
      event: {
        at: row.createdAt,
        origin: row.origin,
        recipeId: row.recipeId,
        revision: row.revision,
        role: null,
        cause: row.cause,
      },
    }));
  const events = [...requestEvents, ...loginEvents].toSorted((a, b) => b.at - a.at);

  return {
    version: 1,
    range,
    from,
    to: now,
    logins: {
      count: logins.length,
      loginMs: durations(signedInLogins.map(loginTime)),
      withService: durations(waited.map(loginTime)),
      recipeOnly: durations(recipeOnly.map(loginTime)),
      parts: { withService: loginParts(waited), recipeOnly: loginParts(recipeOnly) },
      perSite: loginSites,
      perBuild: loginBuilds,
    },
    llm,
    daily,
    slowest,
    perSite,
    perBuild,
    stats: {
      requests: requestCounts,
      logins: outcomeCounts(logins),
      loginsAuthenticated: signedInLogins.length,
      firstLogins: outcomeCounts(input.firstLogins),
      firstLoginsAuthenticated: input.firstLogins.filter((row) => row.outcome === "authenticated")
        .length,
      inputTokens: requests.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: requests.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      spend: {
        ...input.spend,
        dailyLimitMicroUsd: CLAUDE_CALL_LIMITS.dailyMicroUsd,
        monthlyLimitMicroUsd: CLAUDE_CALL_LIMITS.monthlyMicroUsd,
      },
      activeRecipes: input.activeRecipes,
      recipesGenerated: requests.filter(
        (row) => row.role === "generate" && row.recipePage === "first" && row.revision !== null,
      ).length,
    },
    failures: failureGroups(
      events.filter((entry) => !(entry.kind === "login" && NEEDS_PERSON.has(entry.code))),
    ),
    needsPerson: failureGroups(
      events.filter((entry) => entry.kind === "login" && NEEDS_PERSON.has(entry.code)),
    ),
  };
}

/**
 * Reads the owner's rows for the range, only the columns the dashboard needs, and
 * aggregates them. An identity without an owner sees an empty dashboard. A signed-in page
 * sample (ADR 0029, outcome `sampled`) is no request a device waited on, so it is left out:
 * it counts neither as a request nor as a failure.
 */
export async function readDashboard(
  d1: D1Database,
  ownerId: string | null,
  range: ManageDashboardRange,
  now: number,
): Promise<ManageDashboard> {
  const empty: DashboardInput = {
    range,
    now,
    requests: [],
    logins: [],
    firstLogins: [],
    spend: { dayMicroUsd: 0, monthMicroUsd: 0 },
    activeRecipes: 0,
  };
  if (!ownerId) return summarizeDashboard(empty);
  const db = drizzle(d1);
  const from = now - MANAGE_DASHBOARD_RANGE_MS[range];
  const day = utcDay(now);
  const month = day.slice(0, 7);
  const [requests, logins, firstLogins, spend, [active]] = await db.batch([
    db
      .select({
        role: inferenceLog.role,
        called: sql<number>`${inferenceLog.modelId} IS NOT NULL`.mapWith(Boolean),
        origin: inferenceLog.origin,
        outcome: inferenceLog.outcome,
        recipeId: inferenceLog.recipeId,
        revision: inferenceLog.revision,
        recipePage: inferenceLog.recipePage,
        build: inferenceLog.build,
        inputTokens: inferenceLog.inputTokens,
        outputTokens: inferenceLog.outputTokens,
        preModelMs: inferenceLog.preModelMs,
        tokenMs: inferenceLog.tokenMs,
        modelMs: inferenceLog.modelMs,
        serverMs: inferenceLog.serverMs,
        createdAt: inferenceLog.createdAt,
      })
      .from(inferenceLog)
      .where(
        and(
          eq(inferenceLog.ownerId, ownerId),
          gte(inferenceLog.createdAt, from),
          ne(inferenceLog.outcome, "sampled"),
        ),
      )
      .orderBy(desc(inferenceLog.createdAt)),
    db
      .select({
        recipeId: loginTimings.recipeId,
        revision: loginTimings.revision,
        origin: loginTimings.origin,
        outcome: loginTimings.outcome,
        cause: loginTimings.cause,
        extensionBuild: loginTimings.extensionBuild,
        totalMs: loginTimings.totalMs,
        serviceMs: loginTimings.serviceMs,
        networkMs: loginTimings.networkMs,
        personMs: loginTimings.personMs,
        pageMs: loginTimings.pageMs,
        createdAt: loginTimings.createdAt,
      })
      .from(loginTimings)
      .where(and(eq(loginTimings.ownerId, ownerId), gte(loginTimings.createdAt, from)))
      .orderBy(desc(loginTimings.createdAt)),
    db
      .select({ outcome: loginOutcomes.outcome })
      .from(loginOutcomes)
      .where(and(eq(loginOutcomes.ownerId, ownerId), gte(loginOutcomes.createdAt, from))),
    db
      .select({ period: inferenceSpend.period, costMicroUsd: inferenceSpend.costMicroUsd })
      .from(inferenceSpend)
      .where(
        and(eq(inferenceSpend.ownerId, ownerId), inArray(inferenceSpend.period, [month, day])),
      ),
    db
      .select({ recipes: count() })
      .from(recipeHeads)
      .where(and(eq(recipeHeads.ownerId, ownerId), eq(recipeHeads.state, "active"))),
  ]);
  const spent = (period: string) => spend.find((row) => row.period === period)?.costMicroUsd ?? 0;
  return summarizeDashboard({
    range,
    now,
    // An account switch's logout (ADR 0063) is logged as generation on its own page.
    requests: requests.map((row) =>
      row.recipePage === "logout" ? { ...row, role: "logout" as const } : row,
    ),
    logins,
    firstLogins,
    // A period's sum is never negative once its call is settled; clamp it for the contract.
    spend: { dayMicroUsd: Math.max(0, spent(day)), monthMicroUsd: Math.max(0, spent(month)) },
    activeRecipes: active?.recipes ?? 0,
  });
}
