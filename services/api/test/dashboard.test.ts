import {
  devicePairResultSchema,
  manageDashboardSchema,
  type ManageDashboard,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  durations,
  summarizeDashboard,
  type DashboardInput,
  type DashboardLogin,
  type DashboardRequest,
} from "../src/dashboard";
import {
  installAccessKeys,
  ORIGIN,
  owner,
  ownerIdFor,
  request,
  type Owner,
} from "./access-helpers";

// Synthetic owners, origins and request log rows only.

installAccessKeys();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A fixed noon, so the days a range touches do not depend on when the test runs. */
const NOW = Date.UTC(2026, 9, 18, 12);

function row(overrides: Partial<DashboardRequest> = {}): DashboardRequest {
  return {
    role: "judge",
    called: true,
    origin: "https://bank.example",
    outcome: "ok",
    recipeId: "gen-bank",
    revision: null,
    recipePage: null,
    build: "a".repeat(40),
    inputTokens: 100,
    outputTokens: 10,
    preModelMs: 400,
    tokenMs: 300,
    modelMs: 2000,
    serverMs: 2500,
    createdAt: NOW - HOUR_MS,
    ...overrides,
  };
}

function login(overrides: Partial<DashboardLogin> = {}): DashboardLogin {
  return {
    recipeId: "gen-bank",
    revision: 1,
    origin: "https://bank.example",
    outcome: "authenticated",
    cause: null,
    extensionBuild: "b".repeat(40),
    totalMs: 4000,
    serviceMs: 0,
    networkMs: 0,
    personMs: 0,
    pageMs: 0,
    createdAt: NOW - HOUR_MS,
    ...overrides,
  };
}

function summarize(overrides: Partial<DashboardInput> = {}): ManageDashboard {
  return v.parse(
    manageDashboardSchema,
    summarizeDashboard({
      range: "7d",
      now: NOW,
      requests: [],
      logins: [],
      firstLogins: [],
      spend: { dayMicroUsd: 0, monthMicroUsd: 0 },
      activeRecipes: 0,
      ...overrides,
    }),
  );
}

describe("dashboard aggregation", () => {
  it("gives the values instead of a p90 below 20 and the nearest-rank p90 from 20", () => {
    expect(durations([])).toEqual({ n: 0, p50: null, values: [] });
    expect(durations([300, 100, 200])).toEqual({ n: 3, p50: 200, values: [100, 200, 300] });
    expect(durations([4, 1, 3, 2])).toEqual({ n: 4, p50: 2, values: [1, 2, 3, 4] });
    const twenty = Array.from({ length: 20 }, (_, index) => (20 - index) * 10);
    expect(durations(twenty)).toEqual({ n: 20, p50: 100, p90: 180 });
  });

  it("counts only recorded times toward latency", () => {
    const data = summarize({
      requests: [
        row({ modelMs: 1000 }),
        row({ modelMs: 3000, serverMs: 3500 }),
        // Logged before the times were recorded.
        row({ preModelMs: null, tokenMs: null, modelMs: null, serverMs: null }),
        row({ role: "generate", modelMs: 9000, serverMs: 10_000, preModelMs: 600, tokenMs: 350 }),
      ],
    });
    const judge = data.llm.find((role) => role.role === "judge")!;
    expect(judge.calls).toBe(3);
    expect(judge.modelMs).toEqual({ n: 2, p50: 1000, values: [1000, 3000] });
    expect(judge.serverMs.n).toBe(2);
    expect(judge.parts).toEqual({
      n: 2,
      preModelOtherMs: 100,
      tokenMs: 300,
      modelMs: 1000,
      afterModelMs: 100,
    });
    expect(judge.inputTokens).toBe(300);
    const generate = data.llm.find((role) => role.role === "generate")!;
    expect(generate.parts).toEqual({
      n: 1,
      preModelOtherMs: 250,
      tokenMs: 350,
      modelMs: 9000,
      afterModelMs: 400,
    });
    // The row without times is counted, never timed.
    expect(data.stats.requests).toContainEqual({ role: "judge", outcome: "ok", count: 3 });
    expect(data.perSite).toEqual([
      {
        origin: "https://bank.example",
        requests: 4,
        serverMs: { n: 3, p50: 3500, values: [2500, 3500, 10_000] },
        modelMs: { n: 3, p50: 3000, values: [1000, 3000, 9000] },
      },
    ]);
  });

  it("keeps requests answered without a model call out of the model's speed", () => {
    const unsent = { called: false, preModelMs: null, tokenMs: null, modelMs: null };
    const data = summarize({
      requests: [
        row(),
        row({ ...unsent, outcome: "busy", serverMs: 40, inputTokens: null, outputTokens: null }),
        row({ ...unsent, outcome: "recipe", serverMs: 30_000, inputTokens: null }),
      ],
    });
    const judge = data.llm.find((role) => role.role === "judge")!;
    expect(judge.calls).toBe(1);
    expect(judge.serverMs).toEqual({ n: 1, p50: 2500, values: [2500] });
    expect(data.slowest.map((entry) => entry.serverMs)).toEqual([2500]);
    expect(data.perSite[0]).toMatchObject({ requests: 3, serverMs: { n: 1, p50: 2500 } });
    expect(data.perBuild[0]).toMatchObject({ requests: 3, serverMs: { n: 1, p50: 2500 } });
    // Each is still a request by its outcome, and only the refusal is a failure.
    expect(data.stats.requests).toHaveLength(3);
    expect(data.failures.map((group) => group.code)).toEqual(["busy"]);
  });

  it("lists every UTC day of the range with gaps, not zeros, for days without model time", () => {
    const data = summarize({
      requests: [
        row({ createdAt: NOW - HOUR_MS, modelMs: 2000 }),
        row({ createdAt: NOW - 2 * HOUR_MS, modelMs: 4000 }),
        row({ role: "generate", createdAt: NOW - 3 * DAY_MS, modelMs: 8000 }),
        row({ createdAt: NOW - 5 * DAY_MS, modelMs: null }),
      ],
      logins: [
        login({ recipeId: "gen-a", createdAt: NOW - HOUR_MS, totalMs: 9000, personMs: 6000 }),
        login({ recipeId: "gen-b", outcome: "timeout", createdAt: NOW - 2 * HOUR_MS }),
        login({ recipeId: "gen-c", createdAt: NOW - 3 * DAY_MS, totalMs: 5000 }),
      ],
    });
    expect(data.from).toBe(NOW - 7 * DAY_MS);
    expect(data.stats.loginsAuthenticated).toBe(2);
    expect(data.stats.logins.reduce((sum, entry) => sum + entry.count, 0)).toBe(3);
    expect(data.daily.map((day) => day.day)).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    const byDay = new Map(data.daily.map((day) => [day.day, day]));
    expect(byDay.get("2026-10-18")).toEqual({
      day: "2026-10-18",
      generateRequests: 0,
      judgeRequests: 2,
      generateModelP50: null,
      judgeModelP50: 2000,
      logins: 2,
      authenticatedLogins: 1,
      // The signed-in login's time less the person's; the timed-out one is not timed.
      loginP50: 3000,
    });
    expect(byDay.get("2026-10-15")).toMatchObject({
      generateModelP50: 8000,
      judgeModelP50: null,
      logins: 1,
      authenticatedLogins: 1,
      loginP50: 5000,
    });
    // A request without model time counts as a request but leaves the median a gap.
    expect(byDay.get("2026-10-13")).toMatchObject({ judgeRequests: 1, judgeModelP50: null });
    expect(byDay.get("2026-10-12")).toMatchObject({
      judgeRequests: 0,
      judgeModelP50: null,
      logins: 0,
      loginP50: null,
    });
  });

  it("keeps the 10 slowest requests and orders sites and builds", () => {
    const requests = Array.from({ length: 12 }, (_, index) =>
      row({
        origin: index % 2 ? "https://slow.example" : "https://fast.example",
        serverMs: (index % 2 ? 5000 : 1000) + index,
        build: index < 6 ? "old-build" : "new-build",
        createdAt: NOW - (12 - index) * HOUR_MS,
      }),
    );
    const data = summarize({ requests: [...requests, row({ serverMs: null, createdAt: NOW })] });
    expect(data.slowest).toHaveLength(10);
    expect(data.slowest[0]).toMatchObject({ origin: "https://slow.example", serverMs: 5011 });
    expect(data.slowest.map((entry) => entry.serverMs)).toEqual(
      data.slowest.map((entry) => entry.serverMs).toSorted((a, b) => b - a),
    );
    expect(data.perSite.map((site) => site.origin)).toEqual([
      "https://slow.example",
      "https://fast.example",
      // No server time, so its median sorts last.
      "https://bank.example",
    ]);
    // The row with the default build is the newest.
    expect(data.perBuild.map((build) => build.build)).toEqual([
      "a".repeat(40),
      "new-build",
      "old-build",
    ]);
  });

  it("groups failures by code apart from the logins that needed the person", () => {
    const data = summarize({
      requests: [
        row({
          outcome: "timeout",
          createdAt: NOW - 3 * HOUR_MS,
          origin: "https://a.example",
          recipeId: "gen-a",
        }),
        row({
          outcome: "timeout",
          createdAt: NOW - HOUR_MS,
          origin: "https://b.example",
          recipeId: "gen-b",
        }),
        row({ outcome: "abstained", createdAt: NOW - 2 * HOUR_MS }),
        row({ outcome: "ok" }),
        row({ role: "generate", recipePage: "first", revision: 1, recipeId: "gen-new" }),
        row({ role: "generate", recipePage: "first", revision: null }),
        row({ role: "generate", recipePage: "continuation", revision: 2 }),
      ],
      logins: [
        login({
          recipeId: "gen-kept",
          revision: 2,
          origin: "https://kept.example",
          outcome: "unknown-submit",
          cause: "settled",
          createdAt: NOW - HOUR_MS,
        }),
        login({ outcome: "challenge", createdAt: NOW - HOUR_MS }),
        login({
          recipeId: "gen-gone",
          origin: "https://gone.example",
          outcome: "watch-abandoned",
          createdAt: NOW - 2 * HOUR_MS,
        }),
        login({ revision: 2, createdAt: NOW }),
      ],
      firstLogins: [{ outcome: "unknown-submit" }, { outcome: "authenticated" }],
    });
    expect(data.failures.map((group) => [group.kind, group.code, group.count])).toEqual([
      ["request", "timeout", 2],
      ["login", "unknown-submit", 1],
      ["request", "abstained", 1],
    ]);
    const timeout = data.failures[0]!;
    expect(timeout).toMatchObject({ lastAt: NOW - HOUR_MS, lastOrigin: "https://b.example" });
    expect(timeout.latest.map((event) => event.origin)).toEqual([
      "https://b.example",
      "https://a.example",
    ]);
    // A login's site is the one its record holds.
    expect(data.failures[1]!.latest).toEqual([
      {
        at: NOW - HOUR_MS,
        origin: "https://kept.example",
        recipeId: "gen-kept",
        revision: 2,
        role: null,
        cause: "settled",
      },
    ]);
    expect(
      data.needsPerson.map((group) => [group.code, group.lastOrigin, group.lastRecipeId]),
    ).toEqual([
      ["challenge", "https://bank.example", "gen-bank"],
      ["watch-abandoned", "https://gone.example", "gen-gone"],
    ]);
    expect(data.stats.recipesGenerated).toBe(1);
    // Every login counts; the first logins are counted apart.
    expect(data.stats.logins).toContainEqual({ outcome: "authenticated", count: 1 });
    expect(data.stats.loginsAuthenticated).toBe(1);
    expect(data.stats.firstLogins).toEqual([
      { outcome: "authenticated", count: 1 },
      { outcome: "unknown-submit", count: 1 },
    ]);
    expect(data.stats.firstLoginsAuthenticated).toBe(1);
  });

  it("times signed-in logins less the person's time, apart for those that waited on the service", () => {
    const data = summarize({
      logins: [
        // Recipe only: of each login, 2000, 1500 and 2500 waited for the site.
        login({ totalMs: 3000, pageMs: 2000, createdAt: NOW - 4 * HOUR_MS }),
        login({
          totalMs: 2000,
          pageMs: 1500,
          origin: "https://mail.example",
          createdAt: NOW - 3 * HOUR_MS,
        }),
        login({ totalMs: 34_000, personMs: 30_000, pageMs: 2500, createdAt: NOW - 2 * HOUR_MS }),
        // Waited on the service: network 300 of service 9000, the site 600, the rest 400.
        login({
          totalMs: 10_000,
          serviceMs: 9000,
          networkMs: 300,
          pageMs: 600,
          extensionBuild: "development",
          createdAt: NOW - HOUR_MS,
        }),
        // A failed login is counted but never timed.
        login({
          outcome: "timeout",
          totalMs: 60_000,
          origin: "https://mail.example",
          createdAt: NOW,
        }),
      ],
    });
    expect(data.logins.count).toBe(5);
    expect(data.logins.loginMs).toEqual({ n: 4, p50: 3000, values: [2000, 3000, 4000, 10_000] });
    expect(data.logins.withService).toEqual({ n: 1, p50: 10_000, values: [10_000] });
    expect(data.logins.recipeOnly).toEqual({ n: 3, p50: 3000, values: [2000, 3000, 4000] });
    expect(data.logins.parts.withService).toEqual({
      n: 1,
      networkMs: 300,
      serviceOtherMs: 8700,
      pageMs: 600,
      otherMs: 400,
      personMs: 0,
    });
    expect(data.logins.parts.recipeOnly).toEqual({
      n: 3,
      networkMs: 0,
      serviceOtherMs: 0,
      pageMs: 2000,
      otherMs: 1000,
      personMs: 0,
    });
    expect(data.logins.perSite).toEqual([
      {
        origin: "https://bank.example",
        logins: 3,
        signedIn: 3,
        loginMs: { n: 3, p50: 4000, values: [3000, 4000, 10_000] },
      },
      {
        origin: "https://mail.example",
        logins: 2,
        signedIn: 1,
        loginMs: { n: 1, p50: 2000, values: [2000] },
      },
    ]);
    // Most recently used first.
    expect(data.logins.perBuild.map((build) => [build.build, build.logins])).toEqual([
      ["b".repeat(40), 4],
      ["development", 1],
    ]);
    expect(data.stats.loginsAuthenticated).toBe(4);
  });

  it("counts a wait for the site only up to the login's own time less the service's", () => {
    const data = summarize({
      logins: [login({ totalMs: 3500, personMs: 500, serviceMs: 1000, pageMs: 9000 })],
    });
    expect(data.logins.parts.withService).toMatchObject({ pageMs: 2000, otherMs: 0 });
  });

  it("keeps the latest 20 of a code", () => {
    const data = summarize({
      requests: Array.from({ length: 25 }, (_, index) =>
        row({ outcome: "provider-error", createdAt: NOW - index * 60_000 }),
      ),
    });
    expect(data.failures[0]!.count).toBe(25);
    expect(data.failures[0]!.latest).toHaveLength(20);
    expect(data.failures[0]!.latest[19]!.at).toBe(NOW - 19 * 60_000);
  });
});

/** Pairs a device for `by` as the extension does (ADR 0020), creating its owner. */
async function pair(by: Owner) {
  const response = await request("/pair", {
    method: "POST",
    access: by.token,
    headers: {
      "Content-Type": "application/json",
      Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    },
    body: JSON.stringify({ version: 1, label: "Test laptop" }),
  });
  expect(response.status).toBe(201);
  v.parse(devicePairResultSchema, await response.json());
  return (await ownerIdFor(by.subject))!;
}

const insertLog = (
  ownerId: string,
  fields: {
    role?: string;
    origin?: string;
    outcome?: string;
    modelMs?: number | null;
    serverMs?: number | null;
    createdAt: number;
    cost?: number;
    /** A request answered without a model call: no provider or model (ADR 0012). */
    unsent?: true;
  },
) =>
  env.DB.prepare(
    "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, recipe_id, input_tokens, output_tokens, cost_micro_usd, pre_model_ms, token_ms, model_ms, server_ms, build, created_at) VALUES (?, ?, ?, ?, ?, ?, '/login', '{}', ?, 'gen-synthetic', 100, 10, ?, 300, 200, ?, ?, 'test-build', ?)",
  ).bind(
    `log-${crypto.randomUUID()}`,
    ownerId,
    fields.role ?? "judge",
    fields.unsent ? null : "anthropic",
    fields.unsent ? null : "m",
    fields.origin ?? "https://bank.example",
    fields.outcome ?? "ok",
    fields.cost ?? 0,
    fields.modelMs === undefined ? 2000 : fields.modelMs,
    fields.serverMs === undefined ? 2600 : fields.serverMs,
    fields.createdAt,
  );

/** A synthetic login record a device sent (ADR 0055). */
const insertLogin = (
  ownerId: string,
  fields: {
    origin?: string;
    outcome?: string;
    cause?: string;
    totalMs?: number;
    serviceMs?: number;
    networkMs?: number;
    personMs?: number;
    pageMs?: number;
    createdAt?: number;
  },
) =>
  env.DB.prepare(
    "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, cause, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'gen-synthetic', '', 1, ?, ?, ?, 'development', ?, ?, ?, ?, ?, ?)",
  ).bind(
    `login-${crypto.randomUUID()}`,
    ownerId,
    fields.origin ?? "https://mine.example",
    fields.outcome ?? "authenticated",
    fields.cause ?? null,
    fields.totalMs ?? 4000,
    fields.serviceMs ?? 0,
    fields.networkMs ?? 0,
    fields.personMs ?? 0,
    fields.pageMs ?? 0,
    fields.createdAt ?? Date.now() - 2 * HOUR_MS,
  );

async function readDashboard(by: Owner, query = "") {
  const response = await request(`/manage/api/dashboard${query}`, { access: by.token });
  expect(response.status).toBe(200);
  return v.parse(manageDashboardSchema, await response.json());
}

describe("owner web UI dashboard", () => {
  it("serves its page behind Access", async () => {
    const { token } = await owner();
    const page = await request("/manage/dashboard", { access: token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pateat test app");
    expect((await request("/manage/dashboard")).status).toBe(401);
    expect((await request("/manage/dashboard", { access: token, method: "POST" })).status).toBe(
      405,
    );
  });

  it("refuses the API without Access, with another range or another method", async () => {
    const by = await owner();
    expect((await request("/manage/api/dashboard")).status).toBe(401);
    const bad = await request("/manage/api/dashboard?range=1y", { access: by.token });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_request" });
    const post = await request("/manage/api/dashboard", {
      access: by.token,
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(post.status).toBe(405);
  });

  it("shows an identity without a paired device an empty dashboard and creates no owner", async () => {
    const by = await owner();
    const data = await readDashboard(by);
    expect(data.range).toBe("7d");
    expect(data.llm.map((role) => role.calls)).toEqual([0, 0]);
    expect(data.failures).toEqual([]);
    expect(data.stats.spend).toEqual({
      dayMicroUsd: 0,
      monthMicroUsd: 0,
      dailyLimitMicroUsd: 5_000_000,
      monthlyLimitMicroUsd: 100_000_000,
    });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("aggregates only the signed-in owner's rows within the range", async () => {
    const first = await owner();
    const second = await owner();
    const [mine, theirs] = [await pair(first), await pair(second)];
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    await env.DB.batch([
      insertLog(mine, { createdAt: now - HOUR_MS, modelMs: 1000 }),
      insertLog(mine, { createdAt: now - 2 * HOUR_MS, modelMs: 3000, outcome: "timeout" }),
      insertLog(mine, { createdAt: now - 3 * DAY_MS, modelMs: 5000, role: "generate" }),
      // Logged before times were recorded.
      insertLog(mine, { createdAt: now - 4 * HOUR_MS, modelMs: null, serverMs: null }),
      // Answered without a model call: a request and a failure, but no model call.
      insertLog(mine, {
        createdAt: now - 5 * HOUR_MS,
        modelMs: null,
        serverMs: 90_000,
        outcome: "busy",
        unsent: true,
      }),
      // A signed-in page sample (ADR 0029): neither a request nor a failure.
      insertLog(mine, {
        createdAt: now - 6 * HOUR_MS,
        modelMs: null,
        serverMs: 80_000,
        origin: "https://sampled.example",
        outcome: "sampled",
        unsent: true,
      }),
      // Outside the 7-day range, and inside the 30-day one.
      insertLog(mine, { createdAt: now - 10 * DAY_MS, modelMs: 7000 }),
      // Another owner's rows never appear.
      insertLog(theirs, {
        createdAt: now - HOUR_MS,
        modelMs: 99_000,
        origin: "https://other.example",
        outcome: "provider-error",
      }),
      env.DB.prepare(
        "INSERT INTO login_outcomes (owner_id, recipe_id, branch, revision, outcome, cause, step, created_at) VALUES (?, 'gen-synthetic', '', 1, 'structural-mismatch', 'settled', 2, ?), (?, 'gen-synthetic', '', 1, 'timeout', null, 1, ?)",
      ).bind(mine, now - HOUR_MS, theirs, now - HOUR_MS),
      env.DB.prepare(
        "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 2, 420000), (?, ?, 9, 7000000), (?, ?, 1, 999)",
      ).bind(mine, day, mine, day.slice(0, 7), theirs, day),
      // The other owner has more active recipes.
      env.DB.prepare(
        "INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at) VALUES (?, 'gen-synthetic', 1, 'active', 1, 'w1', ?), (?, 'gen-synthetic', 1, 'active', 1, 'w2', ?), (?, 'gen-theirs', 1, 'active', 2, 'w3', ?)",
      ).bind(mine, now, theirs, now, theirs, now),
      insertLogin(mine, {
        outcome: "structural-mismatch",
        cause: "target-missing",
        createdAt: now - HOUR_MS,
      }),
      insertLogin(mine, {
        totalMs: 9000,
        serviceMs: 6000,
        networkMs: 400,
        personMs: 2000,
        pageMs: 700,
      }),
      insertLogin(mine, { totalMs: 3000 }),
      // Outside the 7-day range.
      insertLogin(mine, { totalMs: 1000, createdAt: now - 10 * DAY_MS }),
      insertLogin(theirs, { origin: "https://theirs.example", outcome: "timeout" }),
    ]);

    const week = await readDashboard(first);
    const judge = week.llm.find((role) => role.role === "judge")!;
    expect(judge.calls).toBe(3);
    expect(judge.modelMs).toEqual({ n: 2, p50: 1000, values: [1000, 3000] });
    expect(week.llm.find((role) => role.role === "generate")!.modelMs.p50).toBe(5000);
    expect(week.perSite.map((site) => site.origin)).toEqual(["https://bank.example"]);
    expect(week.slowest.every((entry) => entry.origin === "https://bank.example")).toBe(true);
    expect(judge.serverMs.values).not.toContain(90_000);
    expect(week.slowest.map((entry) => entry.serverMs)).not.toContain(90_000);
    expect(week.stats.requests).toContainEqual({ role: "judge", outcome: "busy", count: 1 });
    expect(week.stats.requests.map((entry) => entry.outcome)).not.toContain("sampled");
    expect(week.perBuild).toMatchObject([{ build: "test-build", requests: 5 }]);
    expect(week.daily.reduce((sum, entry) => sum + entry.judgeRequests, 0)).toBe(4);
    expect(week.failures.map((group) => [group.kind, group.code, group.count])).toEqual([
      ["login", "structural-mismatch", 1],
      ["request", "timeout", 1],
      ["request", "busy", 1],
    ]);
    // A login failure comes from the login records, with the site its record holds.
    expect(week.failures[0]).toMatchObject({
      lastOrigin: "https://mine.example",
      lastRecipeId: "gen-synthetic",
    });
    expect(week.failures[0]!.latest[0]!.cause).toBe("target-missing");
    expect(week.stats.activeRecipes).toBe(1);
    expect(week.stats.logins).toEqual([
      { outcome: "authenticated", count: 2 },
      { outcome: "structural-mismatch", count: 1 },
    ]);
    expect(week.stats.loginsAuthenticated).toBe(2);
    // The first-login codes are counted apart.
    expect(week.stats.firstLogins).toEqual([{ outcome: "structural-mismatch", count: 1 }]);
    expect(week.logins.count).toBe(3);
    expect(week.logins.loginMs).toEqual({ n: 2, p50: 3000, values: [3000, 7000] });
    expect(week.logins.withService).toEqual({ n: 1, p50: 7000, values: [7000] });
    expect(week.logins.parts.withService).toMatchObject({
      networkMs: 400,
      serviceOtherMs: 5600,
      pageMs: 700,
      otherMs: 300,
      personMs: 2000,
    });
    expect(week.logins.perSite.map((site) => site.origin)).toEqual(["https://mine.example"]);
    expect(week.stats.spend).toMatchObject({ dayMicroUsd: 420_000, monthMicroUsd: 7_000_000 });
    expect(week.daily).toHaveLength(8);
    const timedDays = new Set(
      [now - HOUR_MS, now - 2 * HOUR_MS].map((at) => new Date(at).toISOString().slice(0, 10)),
    );
    expect(week.daily.filter((entry) => entry.judgeModelP50 !== null)).toHaveLength(timedDays.size);
    expect(week.daily.filter((entry) => entry.generateModelP50 !== null)).toHaveLength(1);

    const month = await readDashboard(first, "?range=30d");
    expect(month.llm.find((role) => role.role === "judge")!.modelMs.values).toEqual([
      1000, 3000, 7000,
    ]);
    expect(month.daily).toHaveLength(31);
    expect(month.logins.count).toBe(4);
    const hours = await readDashboard(first, "?range=24h");
    expect(hours.llm.find((role) => role.role === "generate")!.calls).toBe(0);
  });
});
