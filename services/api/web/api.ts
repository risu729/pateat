import {
  manageDashboardSchema,
  manageClaudeSchema,
  manageClaudeTestSchema,
  manageDevicesSchema,
  manageErrorSchema,
  manageModelsSchema,
  manageRecipeConflictSchema,
  manageRecipesSchema,
  manageRequestLogDeletedSchema,
  manageRequestLogSchema,
  manageSettingsConflictSchema,
  syncRecipeWriteResultSchema,
  syncSettingsStateSchema,
  type LocalSettings,
  type ManageDashboardRange,
  type ManageErrorCode,
  type ModelConfig,
  type SyncSettingsState,
  type WifIdentifiers,
} from "@pateat/contracts";
import * as v from "valibot";

/** A failed API call; `code` is `network` when no answer arrived. */
export class ManageApiError extends Error {
  readonly code:
    | ManageErrorCode
    | "settings_conflict"
    | "recipe_conflict"
    | "network"
    | "unexpected-response";
  constructor(code: ManageApiError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ManageFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Calls the same-origin `/manage/api`. An expired Access session answers with a
 * redirect to the sign-in page, which a `fetch` cannot follow across origins, so it
 * surfaces as `network`.
 */
async function call(fetcher: ManageFetch, path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetcher(`/manage/api${path}`, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
    });
  } catch {
    throw new ManageApiError("network");
  }
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 409 && v.is(manageSettingsConflictSchema, body))
    throw new ManageApiError("settings_conflict");
  if (response.status === 409 && v.is(manageRecipeConflictSchema, body))
    throw new ManageApiError("recipe_conflict");
  const error = v.safeParse(manageErrorSchema, body);
  throw new ManageApiError(error.success ? error.output.error : "unexpected-response");
}

async function read<TSchema extends v.GenericSchema>(response: Response, schema: TSchema) {
  const parsed = v.safeParse(schema, await response.json().catch(() => undefined));
  if (!parsed.success) throw new ManageApiError("unexpected-response");
  return parsed.output as v.InferOutput<TSchema>;
}

export function createManageClient(fetcher: ManageFetch = (input, init) => fetch(input, init)) {
  return {
    /** The dashboard's aggregates over the range, ending now. */
    async dashboard(range: ManageDashboardRange) {
      return read(await call(fetcher, `/dashboard?range=${range}`), manageDashboardSchema);
    },
    async devices() {
      return read(await call(fetcher, "/devices"), manageDevicesSchema);
    },
    async revokeDevice(deviceId: string) {
      await call(fetcher, `/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });
    },
    async settings() {
      return read(await call(fetcher, "/settings"), syncSettingsStateSchema);
    },
    /** Replaces the settings only if nobody wrote since `expectedRevision`. */
    async saveSettings(
      expectedRevision: number,
      settings: LocalSettings,
    ): Promise<SyncSettingsState> {
      const response = await call(fetcher, "/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision, settings }),
      });
      return read(response, syncSettingsStateSchema);
    },
    async recipes() {
      return read(await call(fetcher, "/recipes"), manageRecipesSchema);
    },
    /** Revokes the recipe only if `expectedRevision` is still its current revision. */
    async revokeRecipe(recipeId: string, expectedRevision: number) {
      const response = await call(fetcher, `/recipes/${encodeURIComponent(recipeId)}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision }),
      });
      return read(response, syncRecipeWriteResultSchema);
    },
    /**
     * Removes one layout of the recipe (ADR 0060) only if `expectedRevision` is still its
     * current revision; removing its last layout revokes it.
     */
    async revokeLayout(recipeId: string, layout: string, expectedRevision: number) {
      const response = await call(
        fetcher,
        `/recipes/${encodeURIComponent(recipeId)}/layouts/${encodeURIComponent(layout)}/revoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, expectedRevision }),
        },
      );
      return read(response, syncRecipeWriteResultSchema);
    },
    /** The model configuration and the models it may name (ADR 0014). */
    async models() {
      return read(await call(fetcher, "/models"), manageModelsSchema);
    },
    async saveModels(config: ModelConfig) {
      const response = await call(fetcher, "/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, config }),
      });
      return read(response, manageModelsSchema);
    },
    async requestLog() {
      return read(await call(fetcher, "/request-log"), manageRequestLogSchema);
    },
    /** Deletes every request the owner's log holds; recipes and settings stay. */
    async deleteRequestLog() {
      const response = await call(fetcher, "/request-log", { method: "DELETE" });
      return read(response, manageRequestLogDeletedSchema);
    },
    /** The Claude Console values for this owner and the identifiers saved here. */
    async claude() {
      return read(await call(fetcher, "/claude"), manageClaudeSchema);
    },
    async saveClaude(identifiers: WifIdentifiers) {
      const response = await call(fetcher, "/claude", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, identifiers }),
      });
      return read(response, manageClaudeSchema);
    },
    /** Exchanges one token with the saved identifiers; the token never reaches the page. */
    async testClaude() {
      return read(await call(fetcher, "/claude/test", { method: "POST" }), manageClaudeTestSchema);
    },
  };
}

export type ManageClient = ReturnType<typeof createManageClient>;

export function describeError(error: unknown): string {
  const code = error instanceof ManageApiError ? error.code : "unexpected-response";
  switch (code) {
    case "network":
    case "unauthorized":
      return "Your sign-in may have expired. Reload the page to sign in again.";
    case "forbidden":
      return "Your sign-in could not be verified. Reload the page to sign in again.";
    case "access_unavailable":
      return "Owner sign-in is not configured for this service.";
    case "access_keys_unavailable":
      return "Your sign-in could not be checked. Try again later.";
    case "not_found":
      return "It no longer exists. Reload the page.";
    case "not_paired":
      return "No device is paired with this account yet. Pair a device first; settings and Claude identifiers belong to an account with a paired device.";
    case "payload_too_large":
      return "The change was refused because the settings would be too large. Remove some entries first.";
    case "recipe_conflict":
      return "The recipe changed elsewhere or is already revoked. The page now shows its current state.";
    case "settings_conflict":
      return "The settings changed elsewhere, for example by a device sync. The page now shows the current settings; make the change again.";
    case "model_unavailable":
      return "A choice names a model, effort or speed that is no longer offered. The page now shows the current list; choose again.";
    case "rate_limited":
      return "Too many requests in the last minute. Wait a minute and try again.";
    case "bad_request":
      return "The change was refused because the settings would be invalid, for example over a list limit.";
    default:
      return "Something went wrong. Try again later.";
  }
}
