import {
  problemEntrySchema,
  problemReportEnvelopeSchema,
  type SyncDeviceState,
} from "@pateat/contracts";
import { and, count, eq, gte, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { limitReached, purgeExpiredLog } from "../claude/calls";
import { readWifCredential } from "../claude/credentials";
import { readIssuerConfig, signingKeyImports } from "../claude/issuer";
import { devices, owners, problemLog, settings } from "../db/schema";
import { apiError } from "../http";
import { MAX_PROBLEM_LINES_PER_DAY } from "../limits";
import { activeRecipes } from "../recipe-store";
import { jsonBody, requireJsonBody } from "../validation";

/** One problem report: up to 100 lines of a few short fields each. */
const MAX_PROBLEM_REPORT_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The checks a generation call makes after its spend stop, in the same order. */
async function generationReady(env: ApiEnv["Bindings"], configured: boolean) {
  if (!configured) return "credentials-not-configured" as const;
  const issuer = readIssuerConfig(env);
  return issuer && (await signingKeyImports(issuer))
    ? ("ok" as const)
    : ("issuer-unavailable" as const);
}

export const deviceRoutes = new Hono<ApiEnv>()
  /**
   * The calling device's server-side state for its diagnostics page (ADR 0019): no other
   * device, no IDs, labels or amounts, and no Claude token exchange.
   */
  .get("/", async (c) => {
    const { ownerId, deviceId } = c.get("scope");
    const db = drizzle(c.env.DB);
    const now = Date.now();
    const [[device], [recipes], [stored], credential, limit] = await Promise.all([
      db
        .select({ createdAt: devices.createdAt })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId))),
      // The count the recipe limit uses.
      db
        .select({ total: activeRecipes(ownerId) })
        .from(owners)
        .where(eq(owners.id, ownerId)),
      db
        .select({ revision: settings.revision })
        .from(settings)
        .where(eq(settings.ownerId, ownerId)),
      readWifCredential(c.env.DB, ownerId),
      limitReached(db, ownerId, now),
    ]);
    // The device passed authentication in this request, so its row exists.
    if (!device) return apiError(c, 401, { error: "unauthorized" });
    const state: SyncDeviceState = {
      version: 1,
      pairedAt: device.createdAt,
      recipes: recipes?.total ?? 0,
      settingsRevision: stored?.revision ?? 0,
      generation: limit ?? (await generationReady(c.env, credential !== null)),
    };
    return c.json(state);
  })
  /**
   * The calling device's newest `warn` and `error` local log lines, and `info` lines that
   * say why Pateat did nothing (ADR 0066), as the extension let them leave, one row per
   * line. Each line is checked on its own: one the contract refuses is left out and the
   * others are kept, and only a report with no line that passes is refused. A retry
   * repeats a line's log ID and `seq`, which changes nothing and does not count. A report
   * whose new lines would take the owner's devices past their lines for the last 24 hours
   * is refused whole, and the device sends it again later. The count is read before the
   * insert, so two reports at once may pass the limit by up to one report's lines; that is
   * accepted.
   */
  .post(
    "/problems",
    bodyLimit({
      maxSize: MAX_PROBLEM_REPORT_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
    requireJsonBody,
    jsonBody(problemReportEnvelopeSchema),
    async (c) => {
      const { ownerId, deviceId } = c.get("scope");
      const report = c.req.valid("json");
      const entries = report.entries.flatMap((entry) => {
        const parsed = v.safeParse(problemEntrySchema, entry);
        return parsed.success ? [parsed.output] : [];
      });
      if (entries.length === 0) return apiError(c, 400, { error: "bad_request" });
      if (entries.length < report.entries.length)
        console.warn("Problem lines left out", {
          leftOut: report.entries.length - entries.length,
          extensionBuild: report.extensionBuild,
        });
      const db = drizzle(c.env.DB);
      const now = Date.now();
      const seqs = entries.map((entry) => entry.seq);
      const [[recent], kept] = await db.batch([
        db
          .select({ lines: count() })
          .from(problemLog)
          .where(and(eq(problemLog.ownerId, ownerId), gte(problemLog.createdAt, now - DAY_MS))),
        // A range, not a list, keeps the query within D1's bound parameters.
        db
          .select({ seq: problemLog.seq })
          .from(problemLog)
          .where(
            and(
              eq(problemLog.deviceId, deviceId),
              eq(problemLog.logId, report.logId),
              gte(problemLog.seq, Math.min(...seqs)),
              lte(problemLog.seq, Math.max(...seqs)),
            ),
          ),
      ]);
      const known = new Set(kept.map((row) => row.seq));
      const fresh = entries.filter((entry) => !known.has(entry.seq));
      if (fresh.length === 0) return c.body(null, 204);
      if ((recent?.lines ?? 0) + fresh.length > MAX_PROBLEM_LINES_PER_DAY)
        return apiError(c, 429, { error: "rate_limited" }, { "Retry-After": "3600" });
      const [first, ...rest] = fresh.map((entry) =>
        db
          .insert(problemLog)
          .values({
            ownerId,
            deviceId,
            logId: report.logId,
            seq: entry.seq,
            extensionBuild: report.extensionBuild,
            level: entry.level,
            event: entry.event,
            fields: JSON.stringify(entry.fields),
            loggedAt: entry.time,
            createdAt: now,
          })
          .onConflictDoNothing(),
      );
      await db.batch([first!, ...rest]);
      try {
        await purgeExpiredLog(db, now);
      } catch {
        console.error("Problem log purge failed");
      }
      return c.body(null, 204);
    },
  )
  /** A device revokes its own credential, for example when the owner signs out. */
  .delete("/", async (c) => {
    const { ownerId, deviceId } = c.get("scope");
    await drizzle(c.env.DB)
      .update(devices)
      .set({ revokedAt: Date.now() })
      .where(
        and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId), isNull(devices.revokedAt)),
      );
    return c.body(null, 204);
  });
