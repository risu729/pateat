import {
  enrollmentRedeemResultSchema,
  SYNC_PAGE_LIMIT,
  syncRecipeChangesSchema,
  type EnrollmentRedeemResult,
  type SyncRecipeChanges,
} from "@pateat/contracts";
import * as v from "valibot";

export type TransportFailure = "unreachable" | "unexpected-response" | "rate-limited";

export type RedeemResult =
  | { kind: "issued"; result: EnrollmentRedeemResult }
  | { kind: "pending" }
  | { kind: "code-mismatch" }
  | { kind: "failed"; error: TransportFailure };

export type RevokeResult = { kind: "revoked" } | { kind: "failed"; error: TransportFailure };

export type RecipeChangesResult =
  | { kind: "page"; page: SyncRecipeChanges }
  /** The service no longer accepts this device's credential. */
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

export interface ServiceTransport {
  redeem(origin: string, verifier: string): Promise<RedeemResult>;
  revoke(origin: string, credential: string): Promise<RevokeResult>;
  /** One page of recipe changes after `after`, as returned by `GET /v1/recipes`. */
  recipeChanges(origin: string, credential: string, after: number): Promise<RecipeChangesResult>;
}

const errorSchema = v.object({ error: v.string() });
const MAX_RESPONSE_BYTES = 16 * 1024;
/** A full page of recipes; the service accepts each recipe write up to 128 KiB. */
const MAX_RECIPE_PAGE_BYTES = 16 * 1024 * 1024;

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

/**
 * Talks only to the configured service origin. Redirects, cookies, caches and
 * referrers are refused; bodies are size-bounded and validated before use.
 */
export function createServiceTransport(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): ServiceTransport {
  const fetchResponse = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call(
    origin: string,
    path: string,
    init: RequestInit,
    limit: number = MAX_RESPONSE_BYTES,
  ) {
    const url = new URL(path, origin).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      return { failed: "unreachable" as const };
    } finally {
      clearTimeout(timer);
    }
  }

  function errorCode(body: unknown) {
    const parsed = v.safeParse(errorSchema, body);
    return parsed.success ? parsed.output.error : undefined;
  }
  /** Either 401 code means the service no longer accepts this credential. */
  function rejected(response: { status: number; body: unknown }) {
    const code = errorCode(response.body);
    return response.status === 401 && (code === "unauthorized" || code === "device_revoked");
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
  };
}
