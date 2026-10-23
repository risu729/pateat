import { recipeUseReportSchema, syncRecipeIdSchema, type RecipeUseReport } from "@pateat/contracts";
import * as v from "valibot";
import type { LoginReport } from "../login/runtime";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Each login that starts on a service recipe revision tells the service, so it does not
// revoke the recipe as unused (ADR 0058), whatever happens after: logins that stop before
// an item's missing password send no login record (ADR 0055) but are use too. The recipe ID and revision only. Sending is best-effort; it never waits on, throws
// into or changes a login, and a failed send is neither retried nor stored.

/**
 * A recipe revision whose use was sent is not sent again for this long: the service counts
 * use in days, so later starts within it, as a login retried at once, add nothing.
 */
export const RECIPE_USE_REPEAT_MS = 60 * 60 * 1000;
/** Recently sent recipe revisions remembered in memory at once; the oldest go first. */
export const MAX_RECENT_RECIPE_USES = 100;

/** One use report that left the device, for the local log (ADR 0019): codes only. */
export type RecipeUseSent = {
  recipeId: string;
  revision: number;
  /** `kept`, `refused`, `rejected`, or `failed:<code>`. */
  result: string;
};

/**
 * The use to send for a login report, or nothing: only a login's `start` report, which the
 * runtime sends once when a new login starts, on a service recipe revision (a valid recipe
 * ID and a revision of at least 1, as for a login record). A login of an item without a
 * password counts as well.
 */
export function recipeUseOf(
  report: LoginReport,
): { recipeId: string; report: RecipeUseReport } | undefined {
  if (report.type !== "start" || !v.is(syncRecipeIdSchema, report.recipeId)) return undefined;
  const parsed = v.safeParse(recipeUseReportSchema, {
    version: 1,
    revision: report.recipeRevision,
  });
  return parsed.success ? { recipeId: report.recipeId, report: parsed.output } : undefined;
}

/**
 * Tells the paired service of each login that starts on a recipe revision (ADR 0058), in
 * the background. A revision sent within `RECIPE_USE_REPEAT_MS` to the same service is not
 * sent again unless that send failed; this is kept in memory only, for at most
 * `MAX_RECENT_RECIPE_USES` revisions.
 */
export function createRecipeUse(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "reportUse">;
  /** Told of each request sent, for the local log; never changes the sending. */
  report?: (sent: RecipeUseSent) => void;
  now?: () => number;
}) {
  const { service, transport } = options;
  const now = options.now ?? Date.now;
  /** When each recently sent service and recipe revision was sent, oldest first. */
  const recent = new Map<string, number>();
  const tell = (sent: RecipeUseSent) => {
    try {
      options.report?.(sent);
    } catch {
      // The log never changes the sending.
    }
  };
  async function send(found: { recipeId: string; report: RecipeUseReport }) {
    const connection = await service.connection().catch(() => undefined);
    if (!connection || connection.rejected) return;
    const { recipeId, report } = found;
    const key = JSON.stringify([connection.origin, recipeId, report.revision]);
    const at = now();
    const sentAt = recent.get(key);
    if (sentAt !== undefined && at - sentAt < RECIPE_USE_REPEAT_MS) return;
    recent.delete(key);
    recent.set(key, at);
    while (recent.size > MAX_RECENT_RECIPE_USES) recent.delete(recent.keys().next().value!);
    let result: OutcomeResult | undefined;
    try {
      result = await transport.reportUse(
        connection.origin,
        connection.credential,
        recipeId,
        report,
      );
    } catch {
      result = undefined;
    }
    // A failed send is not retried, but the next login on the revision may send again.
    if (result?.kind !== "kept" && result?.kind !== "refused" && recent.get(key) === at)
      recent.delete(key);
    tell({
      recipeId,
      revision: report.revision,
      result: !result
        ? "failed:threw"
        : result.kind === "failed"
          ? `failed:${result.error}`
          : result.kind,
    });
  }
  return {
    /** Takes every login report and sends the use of each login that starts. Never throws. */
    observe(report: LoginReport): void {
      try {
        const found = recipeUseOf(report);
        if (found) void send(found).catch(() => undefined);
      } catch {
        // A report must never change the login.
      }
    },
  };
}
