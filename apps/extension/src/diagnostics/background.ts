// Connects the service worker's existing decisions to the local log (ADR 0019).
import type { LocalSettings } from "@pateat/contracts";
import * as v from "valibot";
import type { VaultSyncReport } from "../connections/auto-sync";
import type { VaultTimeoutReport } from "../vault/timeout";
import type { SignInStep } from "../connections/runtime";
import type { RefreshReport } from "../connections/sessions";
import type { SetupReply } from "../connections/types";
import type { PasskeyCreateReport } from "../passkeys/create";
import type { PasskeyRequestReport } from "../passkeys/runtime";
import type { LoginRecordSent } from "../service/login-records";
import type { LoginOutcomeSent } from "../service/outcomes";
import type { ProblemsSent } from "../service/problems";
import type { RecipeUseSent } from "../service/recipe-use";
import type { RecipeSyncChanges, RecipeSyncOutcome } from "../service/recipes";
import {
  KNOWN_ERROR_CODES,
  createLogger,
  formatLogExport,
  stackPositions,
  type KnownSites,
  type LogLevel,
} from "./log";
import { createLoginReporter } from "./login-report";
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
/** Unhandled errors share one rate-limit window of 20 a minute; its origin is not logged. */
const ERROR_SOURCE = { tabId: -1, origin: "", perMinute: 20 };
/** States worth an entry even the first time a worker sees a connection. */
const WARN_STATES: ReadonlySet<string> = new Set([
  "unavailable",
  "review-required",
  "reauthentication-required",
]);

/** Results of a login record's send that are expected, so logged at info (ADR 0055). */
const QUIET_LOGIN_RECORDS: ReadonlySet<string> = new Set(["kept", "refused", "failed:unreachable"]);

/** Results of a recipe use's send that change nothing worth noting, logged at debug (ADR 0058). */
const QUIET_RECIPE_USES: ReadonlySet<string> = new Set(["kept", "refused"]);

const recipeCacheOriginsSchema = v.looseObject({
  recipes: v.array(v.looseObject({ origin: v.string() })),
});

export function createDiagnosticsLog(options: {
  build: { version: string; revision: string };
  settings(): Promise<{ revision: number; settings: LocalSettings }>;
  recipeCache(): Promise<unknown>;
  connections(): Promise<SetupReply>;
  /** Told after each entry is stored that goes to the service (ADR 0066). */
  onProblem?: () => void;
  /** For tests: another database and event target than the worker's. */
  databaseName?: string;
  scope?: Pick<typeof globalThis, "addEventListener">;
}) {
  const pseudonyms = createPseudonyms(
    options.databaseName ? { databaseName: options.databaseName } : {},
  );
  const logger = createLogger({
    pseudonym: pseudonyms,
    ...(options.onProblem ? { onProblem: options.onProblem } : {}),
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
        hosts: [
          ...(settings?.excludedSites ?? []),
          ...(settings?.allowedSites ?? []),
          // ADR 0007: exact hostnames, as the list matches them.
          ...(settings?.passkeyBrowserSites.map(({ hostname }) => ({
            hostname,
            includeSubdomains: false,
          })) ?? []),
        ],
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
    /** Logs a rejection that was caught before it became unhandled, as an unhandled one. */
    rejection: (error: unknown) => unhandled("rejection", error),
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
    /**
     * A settings-page Sync: its outcome code, and on failure the mismatch or decryption
     * check, with the refused item's pseudonym and revision date.
     */
    vaultSync(connectionId: string, reply: SetupReply) {
      const outcome = reply.ok ? reply.kind : reply.error.code;
      void logger.log(
        "vault.sync",
        {
          connection: connectionId,
          outcome,
          check: reply.ok ? undefined : reply.error.check,
          item: reply.ok ? undefined : reply.error.item,
          revised: reply.ok ? undefined : reply.error.revised,
        },
        { level: reply.ok || outcome === "cancelled" ? "info" : "warn" },
      );
    },
    /**
     * A settings-page sign-in step: its result kind, `code-refused` for a code the server
     * refused while the sign-in still waits, an email send's result or the error code. An
     * expired sign-in or a cancel is info; other failures are warnings.
     */
    vaultSignIn(step: SignInStep, reply: SetupReply) {
      const refused =
        reply.ok &&
        ((reply.kind === "mfa-required" && reply.invalidCode) ||
          (reply.kind === "new-device-verification-required" && reply.invalidOtp));
      const outcome = !reply.ok
        ? reply.error.code
        : refused
          ? "code-refused"
          : reply.kind === "email-code"
            ? reply.result
            : reply.kind;
      const failed = reply.ok
        ? reply.kind === "email-code" && reply.result !== "sent"
        : outcome !== "cancelled" && outcome !== "setup-expired";
      void logger.log("vault.sign-in", { step, outcome }, { level: failed ? "warn" : "info" });
    },
    /**
     * An automatic vault check (ADR 0025): debug when nothing changed, info when a sync was
     * applied or waits for a login, else warn.
     */
    vaultCheck(event: VaultSyncReport) {
      // A check repeats every few minutes, also from a newly woken worker; the same stored
      // result again, such as a sign-in that still needs the password and sends nothing,
      // or the same failure with the same cause and status, is only detail. A failure with
      // a new cause or status warns again.
      const repeated =
        event.previous === event.outcome &&
        (event.outcome !== "failed" ||
          (event.previousFailure?.cause === event.cause &&
            event.previousFailure.status === event.status &&
            event.previousFailure.check === event.check));
      void logger.log(
        "vault.check",
        {
          connection: event.connectionId,
          outcome: event.outcome,
          ...(event.outcome === "failed"
            ? {
                cause: event.cause,
                status: event.status,
                check: event.check,
                item: event.item,
                revised: event.revised,
              }
            : {}),
        },
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
    /** The vault timeout acted (ADR 0075): info when every vault closed, else warn. */
    vaultTimeout(event: VaultTimeoutReport) {
      void logger.log("vault.timeout", event, {
        level: event.outcome === "done" ? "info" : "warn",
      });
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
          unreadable: changes.unreadable || undefined,
          roundTripMs: changes.timing?.roundTripMs,
          serverMs: changes.timing?.serverMs,
          networkMs: changes.timing?.networkMs,
        },
        {
          // A change left out waits for an extension update, which only the person can make.
          level: changes.unreadable
            ? "warn"
            : QUIET_SYNC.has(outcome)
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
     * A first login's result code sent to the service: `kept` is info, anything else warn,
     * except an unreachable service, which an offline device meets routinely.
     */
    loginOutcome(sent: LoginOutcomeSent) {
      void logger.log(
        "service.outcome",
        {
          recipe: sent.recipeId,
          recipeRevision: sent.revision,
          branch: sent.branch,
          result: sent.result,
        },
        {
          level: sent.result === "kept" || sent.result === "failed:unreachable" ? "info" : "warn",
        },
      );
    },
    /**
     * One login's record sent to the service (ADR 0055): info when kept, refused (as by a
     * service without the route) or the service was unreachable, else warn, as for a record
     * the contract refused (`failed:invalid-record`). The record is not sent again.
     */
    loginRecord(sent: LoginRecordSent) {
      void logger.log(
        "service.login",
        {
          recipe: sent.recipeId,
          recipeRevision: sent.revision,
          branch: sent.branch,
          result: sent.result,
        },
        { level: QUIET_LOGIN_RECORDS.has(sent.result) ? "info" : "warn" },
      );
    },
    /**
     * A started login's use of a recipe revision sent to the service (ADR 0058): debug when
     * kept or refused (a 404 for a recipe revoked meanwhile, or a service without the
     * route), info when the service was unreachable, else warn. A failed send is not retried.
     */
    recipeUse(sent: RecipeUseSent) {
      void logger.log(
        "service.use",
        {
          recipe: sent.recipeId,
          recipeRevision: sent.revision,
          layout: sent.layout,
          result: sent.result,
        },
        {
          level: QUIET_RECIPE_USES.has(sent.result)
            ? "debug"
            : sent.result === "failed:unreachable"
              ? "info"
              : "warn",
        },
      );
    },
    /**
     * Warning and error lines sent to the service (ADR 0066): debug when kept, else
     * info, never warn, so a failed send does not become a line to send in turn.
     */
    problemsSent(sent: ProblemsSent) {
      void logger.log(
        "service.problems",
        { lines: sent.lines, result: sent.result },
        { level: sent.result === "kept" ? "debug" : "info" },
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
    login: createLoginReporter(logger),
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
