import {
  enrollmentRedeemResultSchema,
  recipeCompletionResultSchema,
  recipeGenerationResultSchema,
  SYNC_PAGE_LIMIT,
  syncDeviceStateSchema,
  syncRecipeChangesSchema,
  syncSettingsStateSchema,
  type EnrollmentRedeemResult,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type SyncDeviceState,
  type SyncRecipeChanges,
  type SyncSettingsState,
  type SyncSettingsWrite,
} from "@pateat/contracts";
import * as v from "valibot";

export type TransportFailure = "unreachable" | "unexpected-response" | "rate-limited";

export type RedeemResult =
  | { kind: "issued"; result: EnrollmentRedeemResult }
  | { kind: "pending" }
  | { kind: "code-mismatch" }
  | { kind: "failed"; error: TransportFailure };

export type RevokeResult = { kind: "revoked" } | { kind: "failed"; error: TransportFailure };

/** `GET /v1/device`: the service's view of this device, for diagnostics only. */
export type DeviceStateResult =
  | { kind: "state"; state: SyncDeviceState }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

export type RecipeChangesResult =
  | { kind: "page"; page: SyncRecipeChanges }
  /** The service no longer accepts this device's credential. */
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

export type SettingsResult =
  | { kind: "state"; state: SyncSettingsState }
  /** The write named a stale revision; `current` is the service's state now. */
  | { kind: "conflict"; current: SyncSettingsState }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

/** A recipe generation route's answer (ADR 0018); every answer is a 200 with a status. */
/** `timeout`: no answer in time, though the service may have called the model. */
export type InferenceResult<T> =
  | { kind: "result"; result: T }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure | "timeout" };

export interface ServiceTransport {
  redeem(origin: string, verifier: string): Promise<RedeemResult>;
  revoke(origin: string, credential: string): Promise<RevokeResult>;
  /** `GET /v1/device`: what the service holds for this device's owner. */
  device(origin: string, credential: string): Promise<DeviceStateResult>;
  /** One page of recipe changes after `after`, as returned by `GET /v1/recipes`. */
  recipeChanges(origin: string, credential: string, after: number): Promise<RecipeChangesResult>;
  /** The owner's synced settings document, as returned by `GET /v1/settings`. */
  settings(origin: string, credential: string): Promise<SettingsResult>;
  /** A conditional `PUT /v1/settings`; a stale revision answers with a conflict. */
  saveSettings(
    origin: string,
    credential: string,
    write: SyncSettingsWrite,
  ): Promise<SettingsResult>;
  /** `POST /v1/recipes/generate`: one login page's observation (ADR 0018). */
  generateRecipe(
    origin: string,
    credential: string,
    request: RecipeGenerationRequest,
  ): Promise<InferenceResult<RecipeGenerationResult>>;
  /** `POST /v1/recipes/:recipeId/completion`: the page after a recipe's final submission. */
  judgeCompletion(
    origin: string,
    credential: string,
    recipeId: string,
    request: RecipeCompletionRequest,
  ): Promise<InferenceResult<RecipeCompletionResult>>;
}

const errorSchema = v.object({ error: v.string() });
const MAX_RESPONSE_BYTES = 16 * 1024;
/** A full page of recipes; the service accepts each recipe write up to 128 KiB. */
const MAX_RECIPE_PAGE_BYTES = 16 * 1024 * 1024;
/** The service accepts settings writes up to 128 KiB; reads stay within twice that. */
const MAX_SETTINGS_BYTES = 256 * 1024;
/** A generated recipe change; the service accepts recipes up to 128 KiB. */
const MAX_INFERENCE_BYTES = 256 * 1024;
const settingsConflictSchema = v.strictObject({
  error: v.literal("settings_conflict"),
  current: syncSettingsStateSchema,
});

/** Reads at most the byte limit, cancelling the stream instead of buffering more. */
async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- stream chunks arrive in order
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The diagnostics page waits for this read, so it gives up sooner than sync does. */
export const DEVICE_TIMEOUT_MS = 5_000;

/**
 * Talks only to the configured service origin. Redirects, cookies, caches and
 * referrers are refused; bodies are size-bounded and validated before use.
 */
export function createServiceTransport(
  options: { fetch?: typeof fetch; timeoutMs?: number; inferenceTimeoutMs?: number } = {},
): ServiceTransport {
  const fetchResponse = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  // The service allows the model 60 seconds after exchanging the owner's token.
  const inferenceTimeoutMs = options.inferenceTimeoutMs ?? 90_000;

  async function call(
    origin: string,
    path: string,
    init: RequestInit,
    limit: number = MAX_RESPONSE_BYTES,
    timeout = timeoutMs,
  ) {
    const url = new URL(path, origin).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchResponse(url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return { failed: "unexpected-response" as const };
      }
      const text = await readBounded(response, limit);
      if (text === undefined) return { failed: "unexpected-response" as const };
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        return { failed: "unexpected-response" as const };
      }
      return { status: response.status, body };
    } catch {
      return {
        failed: "unreachable" as const,
        ...(controller.signal.aborted ? { timedOut: true as const } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function errorCode(body: unknown) {
    const parsed = v.safeParse(errorSchema, body);
    return parsed.success ? parsed.output.error : undefined;
  }
  /** Each of these 401 codes means the service no longer accepts this credential. */
  function rejected(response: { status: number; body: unknown }) {
    const code = errorCode(response.body);
    return (
      response.status === 401 &&
      (code === "unauthorized" || code === "device_revoked" || code === "device_expired")
    );
  }

  return {
    async redeem(origin, verifier) {
      const response = await call(origin, "/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, verifier }),
      });
      if ("failed" in response) return { kind: "failed", error: response.failed };
      if (response.status === 200) {
        const parsed = v.safeParse(enrollmentRedeemResultSchema, response.body);
        return parsed.success
          ? { kind: "issued", result: parsed.output }
          : { kind: "failed", error: "unexpected-response" };
      }
      const code = errorCode(response.body);
      if (response.status === 404 && code === "enrollment_not_found") return { kind: "pending" };
      if (response.status === 409 && code === "enrollment_code_mismatch")
        return { kind: "code-mismatch" };
      if (response.status === 429) return { kind: "failed", error: "rate-limited" };
      return { kind: "failed", error: "unexpected-response" };
    },
    async revoke(origin, credential) {
      const response = await call(origin, "/v1/device", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${credential}` },
      });
      if ("failed" in response) return { kind: "failed", error: response.failed };
      if (response.status === 204) return { kind: "revoked" };
      if (rejected(response)) return { kind: "revoked" };
      if (response.status === 429) return { kind: "failed", error: "rate-limited" };
      return { kind: "failed", error: "unexpected-response" };
    },
    async device(origin, credential) {
      const response = await call(
        origin,
        "/v1/device",
        { method: "GET", headers: { Authorization: `Bearer ${credential}` } },
        MAX_RESPONSE_BYTES,
        Math.min(timeoutMs, DEVICE_TIMEOUT_MS),
      );
      if ("failed" in response) return { kind: "failed", error: response.failed };
      if (response.status === 200) {
        const parsed = v.safeParse(syncDeviceStateSchema, response.body);
        return parsed.success
          ? { kind: "state", state: parsed.output }
          : { kind: "failed", error: "unexpected-response" };
      }
      if (rejected(response)) return { kind: "rejected" };
      if (response.status === 429) return { kind: "failed", error: "rate-limited" };
      return { kind: "failed", error: "unexpected-response" };
    },
    async recipeChanges(origin, credential, after) {
      const query = new URLSearchParams({ after: String(after), limit: String(SYNC_PAGE_LIMIT) });
      const response = await call(
        origin,
        `/v1/recipes?${query}`,
        { method: "GET", headers: { Authorization: `Bearer ${credential}` } },
        MAX_RECIPE_PAGE_BYTES,
      );
      if ("failed" in response) return { kind: "failed", error: response.failed };
      if (response.status === 200) {
        const parsed = v.safeParse(syncRecipeChangesSchema, response.body);
        // A page that moves the cursor backwards would replay or skip changes.
        return parsed.success && parsed.output.cursor >= after
          ? { kind: "page", page: parsed.output }
          : { kind: "failed", error: "unexpected-response" };
      }
      if (rejected(response)) return { kind: "rejected" };
      if (response.status === 429) return { kind: "failed", error: "rate-limited" };
      return { kind: "failed", error: "unexpected-response" };
    },
    async settings(origin, credential) {
      return settingsResult(
        await call(
          origin,
          "/v1/settings",
          { method: "GET", headers: { Authorization: `Bearer ${credential}` } },
          MAX_SETTINGS_BYTES,
        ),
      );
    },
    async saveSettings(origin, credential, write) {
      return settingsResult(
        await call(
          origin,
          "/v1/settings",
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${credential}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(write),
          },
          MAX_SETTINGS_BYTES,
        ),
      );
    },
    generateRecipe(origin, credential, request) {
      return infer(
        origin,
        credential,
        "/v1/recipes/generate",
        request,
        recipeGenerationResultSchema,
      );
    },
    judgeCompletion(origin, credential, recipeId, request) {
      return infer(
        origin,
        credential,
        `/v1/recipes/${encodeURIComponent(recipeId)}/completion`,
        request,
        recipeCompletionResultSchema,
      );
    },
  };

  async function infer<T>(
    origin: string,
    credential: string,
    path: string,
    body: unknown,
    schema: v.GenericSchema<unknown, T>,
  ): Promise<InferenceResult<T>> {
    const response = await call(
      origin,
      path,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      MAX_INFERENCE_BYTES,
      inferenceTimeoutMs,
    );
    if ("failed" in response)
      return { kind: "failed", error: "timedOut" in response ? "timeout" : response.failed };
    if (response.status === 200) {
      const parsed = v.safeParse(schema, response.body);
      return parsed.success
        ? { kind: "result", result: parsed.output }
        : { kind: "failed", error: "unexpected-response" };
    }
    if (rejected(response)) return { kind: "rejected" };
    if (response.status === 429) return { kind: "failed", error: "rate-limited" };
    return { kind: "failed", error: "unexpected-response" };
  }

  function settingsResult(response: Awaited<ReturnType<typeof call>>): SettingsResult {
    if ("failed" in response) return { kind: "failed", error: response.failed };
    if (response.status === 200) {
      const parsed = v.safeParse(syncSettingsStateSchema, response.body);
      return parsed.success
        ? { kind: "state", state: parsed.output }
        : { kind: "failed", error: "unexpected-response" };
    }
    if (response.status === 409) {
      const parsed = v.safeParse(settingsConflictSchema, response.body);
      return parsed.success
        ? { kind: "conflict", current: parsed.output.current }
        : { kind: "failed", error: "unexpected-response" };
    }
    if (rejected(response)) return { kind: "rejected" };
    if (response.status === 429) return { kind: "failed", error: "rate-limited" };
    return { kind: "failed", error: "unexpected-response" };
  }
}
