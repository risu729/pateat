// Connects the service worker's existing decisions to the local log (ADR 0019).
import type { LocalSettings } from "@pateat/contracts";
import * as v from "valibot";
import type { SetupReply } from "../connections/types";
import type { LoginReport } from "../login/runtime";
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

/** Routine results stay out of the log unless debug logging is on. */
const QUIET_SYNC: ReadonlySet<RecipeSyncOutcome> = new Set([
  "synced",
  "incomplete",
  "not-connected",
  "busy",
]);
const QUIET_REFUSALS: ReadonlySet<string> = new Set([
  "recipe-not-found",
  "stale-document",
  "generating",
]);

/** Unhandled errors share one rate-limit window; its origin is not logged. */
const ERROR_SOURCE = { tabId: -1, origin: "" };
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
            : outcome === "unreachable"
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
          { origin: report.origin, reason: report.reason },
          { source, level: QUIET_REFUSALS.has(report.reason) ? "debug" : "info" },
        );
      else if (report.type === "generation")
        void logger.log(
          "recipe.generate",
          { origin: report.origin, outcome: report.outcome },
          { source },
        );
      else if (report.type === "judge")
        void logger.log(
          "recipe.judge",
          {
            origin: report.origin,
            recipe: report.recipeId,
            recipeRevision: report.recipeRevision,
            route: report.route,
            verdict: report.verdict,
            reason: report.reason,
            takenOver: report.takenOver,
          },
          // The answer follows; the request alone matters only when no answer came.
          { source, level: report.verdict === "sent" ? "debug" : "info" },
        );
      else if (report.type === "handler")
        void logger.log(
          "login.handler",
          {
            origin: report.origin,
            recipe: report.recipeId,
            handler: report.handler,
            kind: report.kind,
            outcome: report.outcome,
            steps: report.steps,
          },
          { source },
        );
      else
        void logger.log(
          "login.attempt",
          {
            origin: report.origin,
            recipe: report.recipeId,
            state: report.state,
            step: report.stepIndex,
            steps: report.stepCount,
            operation: report.operation,
            effect: report.effect,
            handler: report.handler,
            outcome: report.outcome,
            cause: report.cause,
            reason: report.reason,
          },
          {
            source,
            level:
              report.state === "blocked"
                ? "warn"
                : report.state === "authenticated" || report.state === "retryable"
                  ? "info"
                  : "debug",
          },
        );
    },
    passkey(report: PasskeyRequestReport) {
      const { tabId, ...fields } = report;
      void logger.log("passkey.request", fields, { source: { tabId, origin: report.origin } });
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
            return { ok: true, debugUntil: await logger.enableDebug() };
        }
      } catch {
        return { ok: false, error: "unavailable" };
      }
    },
  };
}
