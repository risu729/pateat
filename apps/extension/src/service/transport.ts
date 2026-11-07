import { createServiceCall } from "./service-call";
import type { ServiceTiming } from "./service-timing";
export {
  serverTimings,
  serviceTiming,
  addTimings,
  type ServiceTiming,
} from "./service-timing";
import {
  devicePairResultSchema,
  profileSchema,
  recipeCompletionResultSchema,
  entryGenerationResultSchema,
  logoutGenerationResultSchema,
  recipeGenerationResultSchema,
  SYNC_PAGE_LIMIT,
  syncDeviceStateSchema,
  syncRecipeChangeSchema,
  syncRecipeChangesSchema,
  syncRecipeIdSchema,
  syncRecipeWriteResultSchema,
  syncSettingsStateSchema,
  type DevicePairResult,
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type LoginOutcomeReport,
  type LoginRecord,
  type LogoutGenerationRequest,
  type LogoutGenerationResult,
  type ProblemReport,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type RecipePageSampleRequest,
  type RecipeUseReport,
  type SyncDeviceState,
  type SyncRecipeChange,
  type SyncRecipeChanges,
  type SyncRecipeWrite,
  type SyncSettingsState,
  type SyncSettingsWrite,
} from "@pateat/contracts";
import * as v from "valibot";

export type TransportFailure = "unreachable" | "unexpected-response" | "rate-limited";

type Profile = v.InferOutput<typeof profileSchema>;
/** The profile a pairing device takes: an existing one, or a new one by name (ADR 0076). */
export type PairProfile = { profileId: string } | { newProfile: string };

/** `POST /pair`'s answer (ADR 0020). */
export type PairResult =
  | { kind: "issued"; result: DevicePairResult }
  /**
   * The owner has profiles and the request chose none, or chose one that is gone or a new
   * name another profile has; `profiles` lists them for the choice (ADR 0076).
   */
  | {
      kind: "profile";
      error: "profile-required" | "profile-not-found" | "profile-name-taken";
      profiles: Profile[];
    }
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
  | {
      kind: "page";
      /** The page without the changes in `unreadable`. */
      page: SyncRecipeChanges;
      /**
       * The recipe IDs of active changes whose recipe this build cannot read, as one the
       * service stored with a locator a newer build added; left out of `page`.
       */
      unreadable?: string[];
    }
  /** The service no longer accepts this device's credential. */
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure }
) &
  Timed;

const writtenRevision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);
/**
 * Each change read before its recipe: an active change's own fields and the recipe's
 * identity must read and match, so only the recipe's body can be left out; a tombstone is
 * read in full with the page.
 */
const recipeChangesPageSchema = v.strictObject({
  ...syncRecipeChangesSchema.entries,
  changes: v.pipe(
    v.array(
      v.union([
        v.pipe(
          v.strictObject({
            recipeId: syncRecipeIdSchema,
            revision: writtenRevision,
            state: v.literal("active"),
            recipe: v.looseObject({ id: v.unknown(), revision: v.unknown() }),
          }),
          v.check(
            (change) =>
              change.recipe.id === change.recipeId && change.recipe.revision === change.revision,
          ),
        ),
        v.looseObject({ recipeId: syncRecipeIdSchema, state: v.literal("revoked") }),
      ]),
    ),
    v.maxLength(SYNC_PAGE_LIMIT),
  ),
});
/**
 * A sync page read change by change: an active change whose recipe this build cannot read,
 * as one stored by a service that is newer than the extension, is left out and named, so
 * the rest of the page and every later page still reach the cache (#959). Undefined when the
 * page itself, a change's own fields or its recipe's identity, or a tombstone does not read.
 */
function readRecipeChanges(
  body: unknown,
): { page: SyncRecipeChanges; unreadable: string[] } | undefined {
  const envelope = v.safeParse(recipeChangesPageSchema, body);
  if (!envelope.success) return undefined;
  // Each change is checked as sent: the identity read drops keys a strict object refuses.
  const sent = (body as { changes: unknown[] }).changes;
  const changes: unknown[] = [];
  const unreadable: string[] = [];
  for (const [index, change] of envelope.output.changes.entries()) {
    if (v.is(syncRecipeChangeSchema, sent[index])) changes.push(sent[index]);
    else if (change.state === "active") unreadable.push(change.recipeId);
    else return undefined;
  }
  // A recipe left out still counts once, so a page naming it twice stays refused.
  if (
    new Set(envelope.output.changes.map((change) => change.recipeId)).size !==
    envelope.output.changes.length
  )
    return undefined;
  const page = v.safeParse(syncRecipeChangesSchema, { ...envelope.output, changes });
  return page.success ? { page: page.output, unreadable } : undefined;
}

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

/**
 * `PUT /v1/recipes/:recipeId`'s answer to a new active recipe from this device (ADR 0040):
 * `written`, `conflict` when the service already holds the ID (also revoked), `refused`
 * for a write it will never take (400, 405, 413 or a 409 that names no recipe), and
 * `failed` for one to try again later, `recipe-limit` included.
 */
export type RecipeWriteResult = (
  | { kind: "written"; change: SyncRecipeChange }
  | { kind: "conflict"; current: SyncRecipeChange }
  | { kind: "refused" }
  | { kind: "rejected" }
  | { kind: "failed"; error: TransportFailure | "recipe-limit" }
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
  /** `retryAfterMs` when a 429 said how long to wait, by `Retry-After` in seconds. */
  | { kind: "failed"; error: TransportFailure; retryAfterMs?: number };

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
  pair(origin: string, label: string, profile?: PairProfile): Promise<PairResult>;
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
   * `POST /v1/recipes/logout`: a signed-in page of an account switch, whose answer names the
   * control that signs out or opens the menu holding it (ADR 0063).
   */
  generateLogout(
    origin: string,
    credential: string,
    request: LogoutGenerationRequest,
  ): Promise<InferenceResult<LogoutGenerationResult>>;
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
   * `POST /v1/device/problems`: the device's `warn` and `error` log lines, and `info` lines
   * saying why Pateat did nothing, not sent yet, as they may leave the device (ADR 0066).
   */
  reportProblems(origin: string, credential: string, report: ProblemReport): Promise<OutcomeResult>;
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
  /** A conditional `PUT /v1/recipes/:recipeId` of a new active recipe (ADR 0040). */
  writeRecipe(
    origin: string,
    credential: string,
    recipeId: string,
    write: SyncRecipeWrite & { state: "active" },
  ): Promise<RecipeWriteResult>;
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
const recipeLimitSchema = v.strictObject({ error: v.literal("recipe_limit") });
const recipeConflictSchema = v.strictObject({
  error: v.literal("recipe_conflict"),
  current: v.nullable(syncRecipeChangeSchema),
});

/** The diagnostics page waits for this read, so it gives up sooner than sync does. */
export const DEVICE_TIMEOUT_MS = 5_000;

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
  const call = createServiceCall(options);
  const timeoutMs = options.timeoutMs ?? 15_000;
  // The service allows the model 60 seconds after exchanging the owner's token.
  const inferenceTimeoutMs = options.inferenceTimeoutMs ?? 90_000;

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
    async pair(origin, label, profile) {
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
          body: JSON.stringify({ version: 1, label, ...profile }),
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
      const profileError =
        response.status === 409 && code === "profile_required"
          ? "profile-required"
          : response.status === 404 && code === "profile_not_found"
            ? "profile-not-found"
            : response.status === 409 && code === "profile_name_taken"
              ? "profile-name-taken"
              : undefined;
      if (profileError) {
        const parsed = v.safeParse(v.object({ profiles: v.array(profileSchema) }), response.body);
        return parsed.success
          ? { kind: "profile", error: profileError, profiles: parsed.output.profiles }
          : { kind: "failed", error: "unexpected-response" };
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
        const read = readRecipeChanges(response.body);
        // A page that moves the cursor backwards would replay or skip changes.
        return read && read.page.cursor >= after
          ? {
              kind: "page",
              page: read.page,
              ...(read.unreadable.length ? { unreadable: read.unreadable } : {}),
              ...timed,
            }
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
    generateLogout(origin, credential, request) {
      return infer(origin, credential, "/v1/recipes/logout", request, logoutGenerationResultSchema);
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
    reportProblems(origin, credential, report) {
      // Until the service has the route, its 404 keeps the lines for a later run.
      return post(origin, credential, "/v1/device/problems", report, true);
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
    async writeRecipe(origin, credential, recipeId, write) {
      const response = await call(
        origin,
        `/v1/recipes/${encodeURIComponent(recipeId)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: JSON.stringify(write),
        },
        { limit: MAX_RECIPE_WRITE_BYTES },
      );
      const timed = { timing: response.timing };
      if ("failed" in response) return { kind: "failed", error: response.failed, ...timed };
      if (response.status === 200) {
        const parsed = v.safeParse(syncRecipeWriteResultSchema, response.body);
        return parsed.success &&
          parsed.output.change.recipeId === recipeId &&
          parsed.output.change.state === "active"
          ? { kind: "written", change: parsed.output.change, ...timed }
          : { kind: "failed", error: "unexpected-response", ...timed };
      }
      if (response.status === 409) {
        const limit = v.safeParse(recipeLimitSchema, response.body);
        if (limit.success) return { kind: "failed", error: "recipe-limit", ...timed };
        const parsed = v.safeParse(recipeConflictSchema, response.body);
        return parsed.success &&
          parsed.output.current !== null &&
          parsed.output.current.recipeId === recipeId
          ? { kind: "conflict", current: parsed.output.current, ...timed }
          : { kind: "refused", ...timed };
      }
      if (rejected(response)) return { kind: "rejected", ...timed };
      if ([400, 405, 413].includes(response.status)) return { kind: "refused", ...timed };
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

  /**
   * A small report the service answers with 204 and no body. With `routeMissingFails`, a
   * 404 or 405, as from a service not yet deployed with the route, is a failure to retry
   * rather than a refusal.
   */
  async function post(
    origin: string,
    credential: string,
    path: string,
    body: unknown,
    routeMissingFails = false,
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
    if (response.status === 429)
      return {
        kind: "failed",
        error: "rate-limited",
        ...("retryAfterMs" in response && response.retryAfterMs !== undefined
          ? { retryAfterMs: response.retryAfterMs }
          : {}),
      };
    if (routeMissingFails && (response.status === 404 || response.status === 405))
      return { kind: "failed", error: "unexpected-response" };
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

