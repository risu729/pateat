// Connects the service worker's existing decisions to the local log (ADR 0019).
import type { LocalSettings } from "@pateat/contracts";
import * as v from "valibot";
import type { VaultSyncOutcome } from "../connections/auto-sync";
import type { RefreshReport } from "../connections/sessions";
import type { SetupReply } from "../connections/types";
import type { LoginReport } from "../login/runtime";
import type { PasskeyCreateReport } from "../passkeys/create";
import type { PasskeyRequestReport } from "../passkeys/runtime";
import type { RecipeSyncChanges, RecipeSyncOutcome } from "../service/recipes";
import {
  KNOWN_ERROR_CODES,
  createLogger,
  formatLogExport,
  stackPositions,
  type KnownSites,
  type LogLevel,
} from "./log";
import { createPseudonyms } from "./pseudonym";
import type { DiagnosticsRequest, LogsRequestType, LogsResponse } from "./wire";

type StatusConnection = Extract<SetupReply, { kind: "status" }>["connections"][number];
type VaultView = Pick<StatusConnection, "state" | "providerSession" | "snapshotId">;

/**
 * Routine results stay out of the log unless debug logging is on. `busy` (a settings write
 * that waits for a login, a superseded sync, or attempts that ran out) is logged (ADR 0019).
 */
const QUIET_SYNC: ReadonlySet<RecipeSyncOutcome> = new Set([
  "synced",
  "incomplete",
  "not-connected",
]);
/**
 * A stale announcement that a later one resolves, and a document announcing again while it
 * already carries a login (ADR 0019).
 */
const QUIET_REFUSALS: ReadonlySet<string> = new Set(["stale-document", "duplicate-document"]);
/** Generation skips of ordinary browsing, logged at debug level (ADR 0019, ADR 0028). */
const debugSkips: ReadonlySet<string> = new Set([
  "no-vault-match",
  "not-connected",
  "not-a-list",
  "no-listed-account",
  "nothing-offered",
]);

/** Unhandled errors share one rate-limit window of 20 a minute; its origin is not logged. */
const ERROR_SOURCE = { tabId: -1, origin: "", perMinute: 20 };
/** States worth an entry even the first time a worker sees a connection. */
const WARN_STATES: ReadonlySet<string> = new Set([
  "unavailable",
  "review-required",
  "reauthentication-required",
]);

const recipeCacheOriginsSchema = v.looseObject({
  recipes: v.array(v.looseObject({ origin: v.string() })),
});

export function createDiagnosticsLog(options: {
  build: { version: string; revision: string };
  settings(): Promise<{ revision: number; settings: LocalSettings }>;
  recipeCache(): Promise<unknown>;
  connections(): Promise<SetupReply>;
  /** For tests: another database and event target than the worker's. */
  databaseName?: string;
  scope?: Pick<typeof globalThis, "addEventListener">;
}) {
  const pseudonyms = createPseudonyms(
    options.databaseName ? { databaseName: options.databaseName } : {},
  );
  const logger = createLogger({
    pseudonym: pseudonyms,
    ...(options.databaseName ? { databaseName: options.databaseName } : {}),
    build: options.build,
    async knownSites(): Promise<KnownSites> {
      const [snapshot, cache] = await Promise.all([
        options.settings().catch(() => undefined),
        options.recipeCache().catch(() => undefined),
      ]);
      const recipes = v.safeParse(recipeCacheOriginsSchema, cache);
      const settings = snapshot?.settings;
      return {
        origins: new Set([
          ...(settings?.siteDefaults.map((site) => site.origin) ?? []),
          ...(settings?.bindings.map((binding) => binding.origin) ?? []),
          ...(recipes.success ? recipes.output.recipes.map((recipe) => recipe.origin) : []),
        ]),
        hosts: settings?.excludedSites ?? [],
      };
    },
  });

  const scope = options.scope ?? globalThis;
  const unhandled = (source: "error" | "rejection", error: unknown) =>
    void logger.log(
      "error.unhandled",
      {
        source,
        name: error instanceof Error ? error.name : typeof error,
        message:
          error instanceof Error && KNOWN_ERROR_CODES.has(error.message)
            ? error.message
            : undefined,
        stack: error instanceof Error ? stackPositions(error.stack) : undefined,
      },
      // A fault a page can repeat must not fill the warning and error allowance.
      { source: ERROR_SOURCE },
    );
  scope.addEventListener("error", (event) => unhandled("error", (event as ErrorEvent).error));
  scope.addEventListener("unhandledrejection", (event) =>
    unhandled("rejection", (event as PromiseRejectionEvent).reason),
  );
  void logger.started();

  // Connection states this worker last saw; the first sight of each is a debug entry.
  const vaults = new Map<string, VaultView>();
  let watching: Promise<void> | undefined;
  let again = false;
  async function watchVaults(): Promise<void> {
    const status = await options.connections().catch(() => undefined);
    if (!status?.ok || status.kind !== "status") return;
    for (const entry of status.connections) {
      const prior = vaults.get(entry.connectionId);
      vaults.set(entry.connectionId, {
        state: entry.state,
        providerSession: entry.providerSession,
        ...(entry.snapshotId ? { snapshotId: entry.snapshotId } : {}),
      });
      const synced = prior !== undefined && entry.snapshotId !== prior.snapshotId;
      if (
        prior &&
        !synced &&
        prior.state === entry.state &&
        prior.providerSession === entry.providerSession
      )
        continue;
      // A worker restarts often, so a warning state is logged even at its first sight.
      const level: LogLevel =
        WARN_STATES.has(entry.state) || WARN_STATES.has(entry.providerSession)
          ? "warn"
          : prior
            ? "info"
            : "debug";
      void logger.log(
        "vault.state",
        {
          connection: entry.connectionId,
          state: entry.state,
          previous: prior?.state,
          providerSession: entry.providerSession,
          synced: synced || undefined,
        },
        { level },
      );
    }
  }

  return {
    logger,
    pseudonyms,
    /** Compares connection states after a vault write or setup request. */
    vaultStateMayChange() {
      if (watching) {
        again = true;
        return;
      }
      watching = (async () => {
        do {
          again = false;
          // oxlint-disable-next-line no-await-in-loop -- one status read at a time
          await watchVaults();
        } while (again);
      })().finally(() => (watching = undefined));
    },
    /** A settings-page Sync: its outcome code, and on failure the mismatch check. */
    vaultSync(connectionId: string, reply: SetupReply) {
      const outcome = reply.ok ? reply.kind : reply.error.code;
      void logger.log(
        "vault.sync",
        {
          connection: connectionId,
          outcome,
          check: reply.ok ? undefined : reply.error.check,
        },
        { level: reply.ok || outcome === "cancelled" ? "info" : "warn" },
      );
    },
    /**
     * An automatic vault check (ADR 0025): debug when nothing changed, info when a sync was
     * applied or waits for a login, else warn.
     */
    vaultCheck(event: {
      connectionId: string;
      outcome: VaultSyncOutcome;
      previous?: VaultSyncOutcome | undefined;
    }) {
      // A check repeats every few minutes, also from a newly woken worker; the same stored
      // result again, such as a sign-in that still needs the password and sends nothing,
      // is only detail.
      const repeated = event.previous === event.outcome;
      void logger.log(
        "vault.check",
        { connection: event.connectionId, outcome: event.outcome },
        {
          level:
            event.outcome === "unchanged" ||
            event.outcome === "skipped" ||
            (repeated && event.outcome !== "synced")
              ? "debug"
              : event.outcome === "synced" || event.outcome === "deferred"
                ? "info"
                : "warn",
        },
      );
    },
    /**
     * A Bitwarden refresh request: debug when it succeeded, info when none was sent and why,
     * else warn.
     */
    vaultRefresh(event: RefreshReport) {
      void logger.log(
        "vault.refresh",
        {
          connection: event.connectionId,
          outcome: event.outcome,
          cause: event.cause,
          status: event.status,
        },
        {
          level:
            event.outcome === "refreshed"
              ? "debug"
              : event.outcome === "not-sent"
                ? "info"
                : "warn",
        },
      );
    },
    /** A routine sync is quiet unless it changed the recipe cache. */
    recipeSync(outcome: RecipeSyncOutcome, changes: RecipeSyncChanges) {
      const changed = changes.added + changes.updated + changes.removed > 0;
      void logger.log(
        "service.sync",
        {
          outcome,
          scope: changes.scope,
          added: changes.added || undefined,
          updated: changes.updated || undefined,
          removed: changes.removed || undefined,
        },
        {
          level: QUIET_SYNC.has(outcome)
            ? changed
              ? "info"
              : "debug"
            : outcome === "unreachable" || outcome === "busy"
              ? "info"
              : "warn",
        },
      );
    },
    /**
     * Settings were synced from the service or saved on the settings page: running logins
     * and passkey requests stop. The entry carries the settings revision read when it is written.
     */
    settingsChanged(source: "synced" | "saved") {
      void options
        .settings()
        .then(
          (snapshot) => snapshot.revision,
          () => undefined,
        )
        .then((revision) => logger.log("settings.changed", { source, revision }));
    },
    login(report: LoginReport) {
      const source = { tabId: report.tabId, origin: report.origin };
      if (report.type === "refused")
        void logger.log(
          "login.refused",
          {
            origin: report.origin,
            url: report.url,
            reason: report.reason,
            detail: report.detail,
            candidates: report.candidates,
            frame: report.frame,
          },
          {
            source,
            // One line per reason per login-related page; a held tab refuses every frame on
            // its page, such as each ad frame. A page that gave up trying to start is news.
            level:
              report.repeat ||
              report.unrelated ||
              (QUIET_REFUSALS.has(report.reason) && report.detail !== "gave-up") ||
              (report.frame && report.reason === "tab-busy")
                ? "debug"
                : "info",
          },
        );
      else if (report.type === "start")
        void logger.log(
          "login.start",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            route: report.route,
            variant: report.variant,
            account: report.account,
            candidates: report.candidates,
            item: report.itemId,
            fillOnly: report.fillOnly,
            list: report.click,
          },
          { source },
        );
      else if (report.type === "logout")
        void logger.log(
          "login.logout",
          {
            origin: report.origin,
            recipe: report.recipeId,
            watched: report.watched,
            url: report.url,
          },
          { source },
        );
      else if (report.type === "choice")
        void logger.log(
          "login.choice",
          { origin: report.origin, outcome: report.outcome, url: report.url },
          { source },
        );
      else if (report.type === "exception")
        void logger.log(
          "login.exception",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            route: report.route,
            state: report.state,
            step: report.stepIndex,
            name: report.name,
            // Engine messages can quote input; only Pateat's own codes are kept.
            message:
              report.message && KNOWN_ERROR_CODES.has(report.message) ? report.message : undefined,
            stack: stackPositions(report.stack),
          },
          { source },
        );
      else if (report.type === "generation")
        void logger.log(
          "recipe.generate",
          {
            origin: report.origin,
            url: report.url,
            outcome: report.outcome,
            reason: report.reason,
            // For refused model output: which check refused it, and why.
            check: report.check,
            detail: report.detail,
            path: report.path,
            recipe: report.recipeId,
            baseRevision: report.baseRevision,
            takenOver: report.takenOver,
            page: report.page,
          },
          // A login page without a matching vault item is common and not a problem, nor is
          // a page that is no list of accounts or any page without the service; a request
          // that failed is (ADR 0019).
          {
            source,
            level:
              report.outcome === "skipped" && debugSkips.has(report.reason ?? "")
                ? "debug"
                : report.outcome === "failed"
                  ? "warn"
                  : "info",
          },
        );
      else if (report.type === "judge")
        void logger.log(
          "recipe.judge",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            recipeRevision: report.recipeRevision,
            route: report.route,
            verdict: report.verdict,
            reason: report.reason,
            takenOver: report.takenOver,
            watched: report.watched,
            completed: report.completed,
          },
          // The answer follows, but `sent` is what is left when no answer came (ADR 0019).
          // A request that failed before the model is a problem; with no paired service
          // nothing was sent. A watched login that a judged page did not decide, or that has
          // no page left to judge, stays without a result (ADR 0027).
          {
            source,
            ...((report.verdict === "retry" && report.reason !== "not-connected") ||
            // A login completed though the judge could not decide (ADR 0029).
            report.completed ||
            (report.watched &&
              (report.verdict === "unclear" ||
                report.verdict === "challenge" ||
                (report.verdict === "not-sent" && report.reason === "page-limit")))
              ? { level: "warn" as const }
              : {}),
          },
        );
      else if (report.type === "state")
        void logger.log(
          "login.state",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            route: report.route,
            decision: report.decision,
            // Only the signs that show, to keep the entry short.
            ...Object.fromEntries(
              (["s1", "s2", "s3", "s4", "s5", "f1", "f2", "e1", "e2", "e3"] as const).map(
                (sign) => [sign, report[sign] || undefined],
              ),
            ),
            settled: report.settled,
          },
          // Later pages of a settled attempt repeat what its first page showed.
          { source, level: report.settled ? "debug" : "info" },
        );
      else if (report.type === "handler")
        void logger.log(
          "login.handler",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            handler: report.handler,
            kind: report.kind,
            outcome: report.outcome,
            steps: report.steps,
          },
          { source },
        );
      else if (report.type === "entry")
        void logger.log(
          "login.entry",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            revision: report.revision,
            outcome: report.outcome,
            reason: report.reason,
            detail: report.detail,
          },
          // ADR 0019's levels: a press and the first refusal of each reason on a document
          // are info, a page that names no path to return to (an entry page visited while
          // signed in), a press another document's check holds, and a repeated refusal are
          // debug. An entry that led nowhere is a problem, and its revision is now blocked
          // (ADR 0031).
          {
            source,
            level:
              report.outcome === "blocked"
                ? "warn"
                : report.outcome === "refused" &&
                    (report.repeat ||
                      report.reason === "no-return-target" ||
                      report.reason === "in-progress")
                  ? "debug"
                  : "info",
          },
        );
      else
        void logger.log(
          "login.attempt",
          {
            origin: report.origin,
            url: report.url,
            recipe: report.recipeId,
            route: report.route,
            variant: report.variant,
            state: report.state,
            step: report.stepIndex,
            steps: report.stepCount,
            operation: report.operation,
            effect: report.effect,
            handler: report.handler,
            outcome: report.outcome,
            cause: report.cause,
            reason: report.reason,
            settled: report.settled,
            routeChange: report.routeChange,
          },
          {
            source,
            // A login that stopped, or whose result settled as unknown, did not finish. A resumed
            // attempt that changed nothing repeats what was already logged.
            // A fill-only login after a logout ends by design without pressing anything. A
            // route change is kept for the log too (ADR 0034).
            level: report.repeat
              ? "debug"
              : (report.state === "blocked" &&
                    report.outcome === "cancelled" &&
                    report.reason === "fill-only") ||
                  // A submit that replaced the document leaves no receiver; any other
                  // unanswered message may be a fault, so it shows without debug logging.
                  (report.cause === "document-gone" && report.reason !== "no-receiver") ||
                  // A click left to the person under a CAPTCHA explains a later challenge.
                  report.cause === "captcha-shown"
                ? "info"
                : report.state === "blocked" || report.state === "watching" || report.settled
                  ? "warn"
                  : report.state === "authenticated" ||
                      report.state === "retryable" ||
                      report.routeChange !== undefined
                    ? "info"
                    : "debug",
          },
        );
    },
    passkey(report: PasskeyRequestReport) {
      const { tabId, ...fields } = report;
      void logger.log("passkey.request", fields, { source: { tabId, origin: report.origin } });
    },
    passkeyCreate(report: PasskeyCreateReport) {
      const { tabId, ...fields } = report;
      void logger.log("passkey.create", fields, { source: { tabId, origin: report.origin } });
    },
    /** The page's log requests; never rejects. */
    async handle(
      message: Exclude<DiagnosticsRequest, { type: "diagnostics.status" }>,
    ): Promise<LogsResponse<LogsRequestType>> {
      try {
        switch (message.type) {
          case "diagnostics.logs.export":
            return {
              ok: true,
              text: formatLogExport(await logger.entries(), {
                ...options.build,
                exportedAt: Date.now(),
                includeSites: message.includeSites,
              }),
            };
          case "diagnostics.logs.clear":
            await logger.clear();
            return { ok: true };
          case "diagnostics.logs.debug":
            if (message.enabled) return { ok: true, debugUntil: await logger.enableDebug() };
            await logger.disableDebug();
            return { ok: true };
        }
      } catch {
        return { ok: false, error: "unavailable" };
      }
    },
  };
}
