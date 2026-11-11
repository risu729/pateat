import { manageOpenAIWriteSchema } from "@pateat/contracts";
import { Hono } from "hono";
import type { ApiEnv } from "../auth";
import { apiError } from "../http";
import {
  CredentialStorageUnavailable,
  deleteOpenAICredential,
  openAICredentialState,
  saveOpenAICredential,
} from "../openai/credentials";
import { findOwner } from "../owners";
import { jsonBody, requireJsonBody } from "../validation";

/** Owner-only key management; setup never sends a request to the provider. */
export const manageOpenAIRoutes = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    return c.json(await openAICredentialState(c.env, ownerId));
  })
  .put("/", requireJsonBody, jsonBody(manageOpenAIWriteSchema), async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    try {
      await saveOpenAICredential(c.env, ownerId, c.req.valid("json").apiKey);
    } catch (error) {
      if (!(error instanceof CredentialStorageUnavailable)) throw error;
      return apiError(c, 503, { error: "credential_storage_unavailable" });
    }
    return c.json(await openAICredentialState(c.env, ownerId));
  })
  .delete("/", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    await deleteOpenAICredential(c.env, ownerId);
    return c.json(await openAICredentialState(c.env, ownerId));
  });
