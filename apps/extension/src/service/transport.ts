import {
  devicePairResultSchema,
  profileSchema,
  recipeCompletionResultSchema,
  entryGenerationResultSchema,
  recipeGenerationResultSchema,
  SYNC_PAGE_LIMIT,
  syncDeviceStateSchema,
  syncRecipeChangeSchema,
  syncRecipeChangesSchema,
  syncRecipeWriteResultSchema,
  syncSettingsStateSchema,
  type DevicePairResult,
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type LoginOutcomeReport,
  type LoginRecord,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type RecipePageSampleRequest,
  type RecipeUseReport,
  type SyncDeviceState,
  type SyncRecipeChange,
  type SyncRecipeChanges,
  type SyncSettingsState,
  type SyncSettingsWrite,
} from "@pateat/contracts";
import * as v from "valibot";

export type TransportFailure = "unreachable" | "unexpected-response" | "rate-limited";

/**
 * How long one request to the service took, for the local log (ADR 0019): from just before
 * it was sent until its body was read (`roundTripMs`), and from the answer's
 * `Server-Timing` header, the service's own time (`total`), its token exchange (`token`)
 * and model call (`model`). `networkMs` is the round trip less the service's time: the
 * network both ways, the Worker's start and the body's transfer. An answer without the
 * header, such as an edge error page, or no answer at all has the round trip only.
 */
export type ServiceTiming = {
  roundTripMs: number;
  serverMs?: number;
  networkMs?: number;
  tokenMs?: number;
  modelMs?: number;
};

/** The longest `dur` taken from a `Server-Timing` header: a day; anything longer is wrong. */
const MAX_SERVER_TIMING_MS = 86_400_000;

/**
 * A `Server-Timing` header's metric `dur`ations by name; malformed entries, and durations
 * that are not finite or longer than a day, are skipped.
 */
export function serverTimings(header: string | null | undefined): Map<string, number> {
  const metrics = new Map<string, number>();
  if (!header) return metrics;
  // Entries and their parameters are separated outside quoted `desc` values.
  for (const entry of header.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/gu) ?? []) {
    const [name, ...parameters] = (entry.match(/(?:[^;"]|"(?:[^"\\]|\\.)*")+/gu) ?? []).map(
      (part) => part.trim(),
    );
    if (!name || metrics.has(name)) continue;
    for (const parameter of parameters) {
      const match = /^dur\s*=\s*"?([0-9]+(?:\.[0-9]+)?)"?$/iu.exec(parameter);
      if (match) {
        const duration = Number(match[1]);
        if (Number.isFinite(duration) && duration <= MAX_SERVER_TIMING_MS)
          metrics.set(name, Math.round(duration));
        break;
      }
    }
  }
  return metrics;
}

/** One request's timing from its round trip and its answer's `Server-Timing` header. */
export function serviceTiming(roundTripMs: number, header?: string | null): ServiceTiming {
  const roundTrip = Math.max(0, Math.round(roundTripMs));
  const metrics = serverTimings(header);
  const server = metrics.get("total");
  const token = metrics.get("token");
  const model = metrics.get("model");
  return {
    roundTripMs: roundTrip,
    ...(server === undefined
      ? {}
      : { serverMs: server, networkMs: Math.max(0, roundTrip - server) }),
    ...(token === undefined ? {} : { tokenMs: token }),
    ...(model === undefined ? {} : { modelMs: model }),
  };
}

/**
 * Several requests' timing added up, as for one sync: the service's and the network's
 * time only when every request had the service's time.
 */
export function addTimings(
  total: ServiceTiming | undefined,
  next: ServiceTiming | undefined,
): ServiceTiming | undefined {
  if (!total || !next) return total ?? next;
  return {
    roundTripMs: total.roundTripMs + next.roundTripMs,
    ...(total.serverMs === undefined || next.serverMs === undefined
      ? {}
      : {
          serverMs: total.serverMs + next.serverMs,
          networkMs: (total.networkMs ?? 0) + (next.networkMs ?? 0),
        }),
  };
}

/** `POST /pair`'s answer (ADR 0020). */
export type PairResult =
  | { kind: "issued"; result: DevicePairResult }
  | { kind: "profile-required"; profiles: {id: string; name: string}[] }
  /**
   * No login session reached the service: a redirect, a `401`, or a body that is not
   * JSON, such as the Access login page, with any status below 500 except 429.
   */
  | { kind: "sign-in-needed" }
  | {
      kind: "failed";
      error:
        | TransportFailure
        | "sign-in-rejected"
        | "extension-not-allowed"
        | "pairing-unavailable"
        | "access-keys-unavailable";
    };

export type RevokeResult = { kind: "revoked" } | { kind: "failed"; error: TransportFailure };

/** `GET /v1/device`: the service's view of this device, for diagnostics only. */
export type DeviceStateResult =
  | { kind: "state"; state: SyncDeviceState }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

/** A sync or generation request's result, with how long the request took when it was sent. */
type Timed = { timing?: ServiceTiming };

export type RecipeChangesResult = (
  | { kind: "page"; page: SyncRecipeChanges }
  /** The service no longer accepts this device's credential. */
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure }
) &
  Timed;

export type SettingsResult = (
  | { kind: "state"; state: SyncSettingsState }
  /** The write named a stale revision; `current` is the service's state now. */
  | { kind: "conflict"; current: SyncSettingsState }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure }
) &
  Timed;

/**
 * `PUT /v1/recipes/:recipeId`'s answer to a revocation (ADR 0058 A): `revoked` with the
 * tombstone written, or `conflict` when the head was no longer the expected revision, with
 * the service's head now (`null` for none).
 */
export type RecipeRevokeResult = (
  | { kind: "revoked"; change: SyncRecipeChange }
  | { kind: "conflict"; current: SyncRecipeChange | null }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure }
) &
  Timed;

/** A recipe generation route's answer (ADR 0018); every answer is a 200 with a status. */
/** `timeout`: no answer in time, though the service may have called the model. */
export type InferenceResult<T> = (
  | { kind: "result"; result: T }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure | "timeout" }
) &
  Timed;

/**
 * `POST /v1/recipes/:recipeId/outcome`'s, `/logins`' and `/use`'s answer: `kept` for a 204 (a repeat
 * outcome is one too), `refused` for any other answer below 500 the service gives a request
 * it will never take, such as a recipe it does not hold.
 */
export type OutcomeResult =
  | { kind: "kept" }
  | { kind: "refused" }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

/**
 * `POST /v1/recipes/:recipeId/page-sample`'s answer (ADR 0029): `kept` when the service
 * logged the page, `recent` when it had a sample of the recipe and branch already, `gone`
 * for a 404: the recipe or its revision is no longer the owner's, as when it was revoked
 * meanwhile, `refused` for a 400: the service turned the page away, as one still showing a
 * fill field of the route.
 */
export type PageSampleResult =
  | { kind: "kept" | "recent" | "gone" | "refused" }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure };

export interface ServiceTransport {
  /**
   * `POST /pair` with the browser's login session to the service. The only call that
   * sends cookies; it sends no device credential.
   */
  pair(origin: string, label: string, profileId?: string): Promise<PairResult>;
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
  /**
   * `POST /v1/recipes/generate` without slots: a page without a login form, whose answer
   * names its sign-in entry (ADR 0031).
   */
  generateEntry(
    origin: string,
    credential: string,
    request: EntryGenerationRequest,
  ): Promise<InferenceResult<EntryGenerationResult>>;
  /**
   * `POST /v1/recipes/:recipeId/outcome`: how the first login of a recipe revision ended,
   * as codes only (ADR 0019, amended 2026-10-18).
   */
  reportOutcome(
    origin: string,
    credential: string,
    recipeId: string,
    report: LoginOutcomeReport,
  ): Promise<OutcomeResult>;
  /**
   * `POST /v1/recipes/:recipeId/logins`: one ended login's result code and times, without
   * its site or any value (ADR 0055).
   */
  reportLogin(
    origin: string,
    credential: string,
    recipeId: string,
    record: LoginRecord,
  ): Promise<OutcomeResult>;
  /**
   * `POST /v1/recipes/:recipeId/use`: a login started on a recipe revision, its revision
   * only, so the service keeps the recipe (ADR 0058).
   */
  reportUse(
    origin: string,
    credential: string,
    recipeId: string,
    report: RecipeUseReport,
  ): Promise<OutcomeResult>;
  /**
   * A conditional `PUT /v1/recipes/:recipeId` that revokes the recipe whose head is
   * `expectedRevision`, as the owner's revoke on `/manage` does: for a recipe the chosen
   * item cannot run, so its page is generated again (ADR 0058 A). (`revoke` revokes the
   * device's own credential.)
   */
  revokeRecipe(
    origin: string,
    credential: string,
    recipeId: string,
    expectedRevision: number,
  ): Promise<RecipeRevokeResult>;
  /** `POST /v1/recipes/:recipeId/completion`: the page after a recipe's final submission. */
  judgeCompletion(
    origin: string,
    credential: string,
    recipeId: string,
    request: RecipeCompletionRequest,
  ): Promise<InferenceResult<RecipeCompletionResult>>;
  /**
   * `POST /v1/recipes/:recipeId/page-sample`: a repeat login's signed-in page, which the
   * service logs without a model call (ADR 0029).
   */
  samplePage(
    origin: string,
    credential: string,
    recipeId: string,
    request: RecipePageSampleRequest,
  ): Promise<PageSampleResult>;
}

const errorSchema = v.object({ error: v.string() });
const MAX_RESPONSE_BYTES = 16 * 1024;
/** A full page of recipes; the service accepts each recipe write up to 128 KiB. */
const MAX_RECIPE_PAGE_BYTES = 16 * 1024 * 1024;
/** The service accepts settings writes up to 128 KiB; reads stay within twice that. */
const MAX_SETTINGS_BYTES = 256 * 1024;
/** A generated recipe change; the service accepts recipes up to 128 KiB. */
const MAX_INFERENCE_BYTES = 256 * 1024;
/** A recipe write's answer, which may carry the service's head; recipes are up to 128 KiB. */
const MAX_RECIPE_WRITE_BYTES = 256 * 1024;
const settingsConflictSchema = v.strictObject({
  error: v.literal("settings_conflict"),
  current: syncSettingsStateSchema,
});
const recipeConflictSchema = v.strictObject({
  error: v.literal("recipe_conflict"),
  current: v.nullable(syncRecipeChangeSchema),
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

/** Per-call options; only pairing sends the browser's login session. */
type CallOptions = {
  limit?: number;
  timeout?: number;
  /**
   * Sends the browser's cookies for the service and leaves redirects unfollowed.
   * A redirect or a body that is not JSON then means the login front-end answered
   * instead of the Worker, so the caller is told to sign in. A non-JSON 429 or 5xx is
   * an edge error page, such as Cloudflare's rate-limit or server error pages, and is
   * reported as rate limiting or an unexpected response instead.
   */
  session?: boolean;
};

function isJson(response: Response) {
  const type = response.headers.get("Content-Type") ?? "";
  return type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/**
 * Talks only to the configured service origin. Redirects, caches and referrers are
 * refused, and cookies are sent only to `POST /pair`; bodies are size-bounded and
 * validated before use.
 */
export function createServiceTransport(
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    inferenceTimeoutMs?: number;
    now?: () => number;
  } = {},
): ServiceTransport {
  const fetchResponse = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000;
  // The service allows the model 60 seconds after exchanging the owner's token.
  const inferenceTimeoutMs = options.inferenceTimeoutMs ?? 90_000;

  async function call(
    origin: string,
    path: string,
    init: RequestInit,
    { limit = MAX_RESPONSE_BYTES, timeout = timeoutMs, session = false }: CallOptions = {},
  ) {
    const url = new URL(path, origin).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // Measured from just before the request leaves until its body is read or it fails.
    const sentAt = now();
    let headers: Headers | undefined;
    const timing = () => serviceTiming(now() - sentAt, headers?.get("Server-Timing"));
    try {
      const response = await fetchResponse(url, {
        ...init,
        signal: controller.signal,
        redirect: session ? "manual" : "error",
        credentials: session ? "include" : "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      headers = response.headers;
      // Decided before reading the body: a login or edge error page is never parsed.
      // Status 0 falls through to "unexpected-response" for any caller that ignores
      // `signIn`.
      if (session && (response.type === "opaqueredirect" || !isJson(response))) {
        void response.body?.cancel().catch(() => undefined);
        if (response.type !== "opaqueredirect" && response.status === 429)
          return { failed: "rate-limited" as const, timing: timing() };
        if (response.type !== "opaqueredirect" && response.status >= 500)
          return { failed: "unexpected-response" as const, timing: timing() };
        return { status: 0, body: undefined, signIn: true as const, timing: timing() };
      }
      if (response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        return { failed: "unexpected-response" as const, timing: timing() };
      }
      const text = await readBounded(response, limit);
      if (text === undefined) return { failed: "unexpected-response" as const, timing: timing() };
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        return { failed: "unexpected-response" as const, timing: timing() };
      }
      return { status: response.status, body, timing: timing() };
    } catch {
      return {
        failed: "unreachable" as const,
        ...(controller.signal.aborted ? { timedOut: true as const } : {}),
        timing: timing(),
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
    async pair(origin, label, profileId) {
      const response = await call(
        origin,
        "/pair",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Asks Access to answer an expired session with a 401 instead of a redirect.
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({ version: 1, label, ...(profileId ? { profileId } : {}) }),
        },
        { session: true },
      );
      if ("signIn" in response) return { kind: "sign-in-needed" };
      if ("failed" in response) return { kind: "failed", error: response.failed };
      if (response.status === 201) {
        const parsed = v.safeParse(devicePairResultSchema, response.body);
        return parsed.success
          ? { kind: "issued", result: parsed.output }
          : { kind: "failed", error: "unexpected-response" };
      }
      const code = errorCode(response.body);
      if (response.status === 409 && code === "profile_required") {
        const parsed = v.safeParse(v.object({ profiles: v.array(profileSchema) }), response.body);
        if (parsed.success) return { kind: "profile-required", profiles: parsed.output.profiles };
      }
      if (response.status === 401) return { kind: "sign-in-needed" };
      if (response.status === 403 && code === "forbidden")
        return { kind: "failed", error: "sign-in-rejected" };
      if (response.status === 403 && code === "extension_not_allowed")
        return { kind: "failed", error: "extension-not-allowed" };
      if (response.status === 503 && code === "access_keys_unavailable")
        return { kind: "failed", error: "access-keys-unavailable" };
      if (response.status === 503) return { kind: "failed", error: "pairing-unavailable" };
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
        { timeout: Math.min(timeoutMs, DEVICE_TIMEOUT_MS) },
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
        { limit: MAX_RECIPE_PAGE_BYTES },
      );
      const timed = { timing: response.timing };
      if ("failed" in response) return { kind: "failed", error: response.failed, ...timed };
      if (response.status === 200) {
        const parsed = v.safeParse(syncRecipeChangesSchema, response.body);
        // A page that moves the cursor backwards would replay or skip changes.
        return parsed.success && parsed.output.cursor >= after
          ? { kind: "page", page: parsed.output, ...timed }
          : { kind: "failed", error: "unexpected-response", ...timed };
      }
      if (rejected(response)) return { kind: "rejected", ...timed };
      if (response.status === 429) return { kind: "failed", error: "rate-limited", ...timed };
      return { kind: "failed", error: "unexpected-response", ...timed };
    },
    async settings(origin, credential) {
      return settingsResult(
        await call(
          origin,
          "/v1/settings",
          { method: "GET", headers: { Authorization: `Bearer ${credential}` } },
          { limit: MAX_SETTINGS_BYTES },
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
          { limit: MAX_SETTINGS_BYTES },
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
    generateEntry(origin, credential, request) {
      return infer(
        origin,
        credential,
        "/v1/recipes/generate",
        request,
        entryGenerationResultSchema,
      );
    },
    reportOutcome(origin, credential, recipeId, report) {
      return post(
        origin,
        credential,
        `/v1/recipes/${encodeURIComponent(recipeId)}/outcome`,
        report,
      );
    },
    reportLogin(origin, credential, recipeId, record) {
      return post(origin, credential, `/v1/recipes/${encodeURIComponent(recipeId)}/logins`, record);
    },
    reportUse(origin, credential, recipeId, report) {
      return post(origin, credential, `/v1/recipes/${encodeURIComponent(recipeId)}/use`, report);
    },
    async revokeRecipe(origin, credential, recipeId, expectedRevision) {
      const response = await call(
        origin,
        `/v1/recipes/${encodeURIComponent(recipeId)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, expectedRevision, state: "revoked" }),
        },
        { limit: MAX_RECIPE_WRITE_BYTES },
      );
      const timed = { timing: response.timing };
      if ("failed" in response) return { kind: "failed", error: response.failed, ...timed };
      if (response.status === 200) {
        const parsed = v.safeParse(syncRecipeWriteResultSchema, response.body);
        // Only this recipe's tombstone is the answer to this write.
        return parsed.success &&
          parsed.output.change.recipeId === recipeId &&
          parsed.output.change.state === "revoked"
          ? { kind: "revoked", change: parsed.output.change, ...timed }
          : { kind: "failed", error: "unexpected-response", ...timed };
      }
      if (response.status === 409) {
        const parsed = v.safeParse(recipeConflictSchema, response.body);
        return parsed.success &&
          (parsed.output.current === null || parsed.output.current.recipeId === recipeId)
          ? { kind: "conflict", current: parsed.output.current, ...timed }
          : { kind: "failed", error: "unexpected-response", ...timed };
      }
      if (rejected(response)) return { kind: "rejected", ...timed };
      if (response.status === 429) return { kind: "failed", error: "rate-limited", ...timed };
      return { kind: "failed", error: "unexpected-response", ...timed };
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
    async samplePage(origin, credential, recipeId, request) {
      const response = await call(
        origin,
        `/v1/recipes/${encodeURIComponent(recipeId)}/page-sample`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      if ("failed" in response) return { kind: "failed", error: response.failed };
      if (response.status === 201) return { kind: "kept" };
      if (response.status === 204) return { kind: "recent" };
      if (response.status === 404) return { kind: "gone" };
      if (response.status === 400) return { kind: "refused" };
      if (rejected(response)) return { kind: "rejected" };
      if (response.status === 429) return { kind: "failed", error: "rate-limited" };
      return { kind: "failed", error: "unexpected-response" };
    },
  };

  /** A small report the service answers with 204 and no body. */
  async function post(
    origin: string,
    credential: string,
    path: string,
    body: unknown,
  ): Promise<OutcomeResult> {
    const response = await call(
      origin,
      path,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { timeout: Math.min(timeoutMs, DEVICE_TIMEOUT_MS) },
    );
    if ("failed" in response) return { kind: "failed", error: response.failed };
    if (response.status === 204) return { kind: "kept" };
    if (rejected(response)) return { kind: "rejected" };
    if (response.status === 429) return { kind: "failed", error: "rate-limited" };
    if (response.status >= 400 && response.status < 500) return { kind: "refused" };
    return { kind: "failed", error: "unexpected-response" };
  }

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
      { limit: MAX_INFERENCE_BYTES, timeout: inferenceTimeoutMs },
    );
    const timed = { timing: response.timing };
    if ("failed" in response)
      return {
        kind: "failed",
        error: "timedOut" in response ? "timeout" : response.failed,
        ...timed,
      };
    if (response.status === 200) {
      const parsed = v.safeParse(schema, response.body);
      return parsed.success
        ? { kind: "result", result: parsed.output, ...timed }
        : { kind: "failed", error: "unexpected-response", ...timed };
    }
    if (rejected(response)) return { kind: "rejected", ...timed };
    if (response.status === 429) return { kind: "failed", error: "rate-limited", ...timed };
    return { kind: "failed", error: "unexpected-response", ...timed };
  }

  function settingsResult(response: Awaited<ReturnType<typeof call>>): SettingsResult {
    const timed = { timing: response.timing };
    if ("failed" in response) return { kind: "failed", error: response.failed, ...timed };
    if (response.status === 200) {
      const parsed = v.safeParse(syncSettingsStateSchema, response.body);
      return parsed.success
        ? { kind: "state", state: parsed.output, ...timed }
        : { kind: "failed", error: "unexpected-response", ...timed };
    }
    if (response.status === 409) {
      const parsed = v.safeParse(settingsConflictSchema, response.body);
      return parsed.success
        ? { kind: "conflict", current: parsed.output.current, ...timed }
        : { kind: "failed", error: "unexpected-response", ...timed };
    }
    if (rejected(response)) return { kind: "rejected", ...timed };
    if (response.status === 429) return { kind: "failed", error: "rate-limited", ...timed };
    return { kind: "failed", error: "unexpected-response", ...timed };
  }
}
