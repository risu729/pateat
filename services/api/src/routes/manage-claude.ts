import {
  manageClaudeWriteSchema,
  type ManageClaude,
  type ManageClaudeTest,
} from "@pateat/contracts";
import { Hono, type Context } from "hono";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import {
  readWifCredential,
  resolveClaudeCredential,
  saveWifCredential,
} from "../claude/credentials";
import { ASSERTION_AUDIENCE, ownerSubject, readIssuerConfig } from "../claude/issuer";
import { apiError } from "../http";
import { findOwner } from "../owners";
import { jsonBody, requireJsonBody } from "../validation";

/** The stored identifiers; a row the schema no longer accepts reads as invalid. */
async function readStored(db: D1Database, ownerId: string) {
  try {
    return { identifiers: await readWifCredential(db, ownerId), storedInvalid: false };
  } catch (error) {
    if (!v.isValiError(error)) throw error;
    return { identifiers: null, storedInvalid: true };
  }
}

async function claudeState(c: Context<ApiEnv>, ownerId: string): Promise<ManageClaude> {
  return {
    version: 1,
    console: {
      issuer: readIssuerConfig(c.env)?.issuer ?? null,
      subject: ownerSubject(ownerId),
      audience: ASSERTION_AUDIENCE,
    },
    ...(await readStored(c.env.DB, ownerId)),
  };
}

/**
 * The web UI's Claude credentials (ADR 0015) under `/manage/api/claude`, behind the same
 * Access, same-origin, rate and body checks as the rest of `/manage/api`. Identifiers
 * belong to an owner, who exists once a device was paired.
 */
export const manageClaudeRoutes = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    return c.json(await claudeState(c, ownerId));
  })
  .put("/", requireJsonBody, jsonBody(manageClaudeWriteSchema), async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    await saveWifCredential(c.env.DB, ownerId, c.req.valid("json").identifiers);
    return c.json(await claudeState(c, ownerId));
  })
  // Exchanges one assertion without calling Claude, so it costs nothing. The token is
  // discarded; only the outcome is returned.
  .post("/test", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    let result: ManageClaudeTest["result"];
    try {
      const outcome = await resolveClaudeCredential(c.env, ownerId);
      result =
        outcome.status === "ready"
          ? {
              status: "ready",
              expiresInSeconds: Math.max(0, Math.round((outcome.expiresAt - Date.now()) / 1000)),
            }
          : outcome;
    } catch (error) {
      if (!v.isValiError(error)) throw error;
      result = { status: "stored_invalid" };
    }
    return c.json({ version: 1, result } satisfies ManageClaudeTest);
  });
