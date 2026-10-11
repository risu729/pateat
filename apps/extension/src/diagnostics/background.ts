// Connects the service worker's existing decisions to the local log (ADR 0019).
import type { LocalSettings } from "@pateat/contracts";
import * as v from "valibot";
import type { SetupReply } from "../connections/types";
import type { LoginReport } from "../login/runtime";
import type { PasskeyRequestReport } from "../passkeys/runtime";
import type { RecipeSyncOutcome } from "../service/recipes";
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

const recipeCacheOriginsSchema = v.looseObject({
  recipes: v.array(v.looseObject({ origin: v.string() })),
});

export function createDiagnosticsLog(options: {
  build: { version: string; revision: string };
  settings(): Promise<LocalSettings>;
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
      const [settings, cache] = await Promise.all([
        options.settings().catch(() => undefined),
        options.recipeCache().catch(() => undefined),
      ]);
      const recipes = v.safeParse(recipeCacheOriginsSchema, cache);
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
    void logger.log("error.unhandled", {
      source,
      name: error instanceof Error ? error.name : typeof error,
      message:
        error instanceof Error && KNOWN_ERROR_CODES.has(error.message) ? error.message : undefined,
      stack: error instanceof Error ? stackPositions(error.stack) : undefined,
    });
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
      const level: LogLevel = !prior
        ? "debug"
        : entry.state === "unavailable" ||
            entry.state === "review-required" ||
            entry.providerSession === "reauthentication-required"
          ? "warn"
          : "info";
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
    recipeSync(outcome: RecipeSyncOutcome) {
      void logger.log(
        "service.sync",
        { outcome },
        { level: QUIET_SYNC.has(outcome) ? "debug" : outcome === "unreachable" ? "info" : "warn" },
      );
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
      else
        void logger.log(
          "login.attempt",
          {
            origin: report.origin,
            recipe: report.recipeId,
            state: report.state,
            step: report.stepIndex,
            steps: report.stepCount,
            outcome: report.outcome,
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
