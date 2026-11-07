import {
  parseRecipeBranch,
  recipeBranchSchema,
  storedLayoutRecipe,
  storedRecipeSlots,
  slotsForPage,
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type GenerationOutputRejection,
  type LoginBindingTemplate,
  type LoginObservation,
  type LoginRoute,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
  type SemanticSlot,
} from "@pateat/contracts";
import * as v from "valibot";
import type {
  EntryGenerationOutcome,
  GenerationHold,
  GenerationOutcome,
  PageSampleOutcome,
  RecipeRepairClaim,
} from "../login/runtime/report";
import type { LoginGeneration } from "../login/runtime/deps";
import { DEVICE_GENERATION_ORIGIN } from "./device-generation";
import type { ServiceConnection } from "./runtime";
import type { InferenceResult, ServiceTiming, ServiceTransport } from "./transport";

import {
  createGenerationStorage,
  type GenerationBase,
  type GenerationRepair,
  type GenerationAttemptStorage,
  type GeneratedSlotMaps,
  type GeneratedSlotStorage,
  type PageSampleStorage,
  type RecipeReplacementStorage,
} from "./generation-storage";
export {
  GENERATION_RETRY_MS,
  GENERATION_SENDING_MS,
  MAX_GENERATION_ATTEMPTS,
  type GenerationAttemptStorage,
  MAX_GENERATED_SLOT_MAPS,
  type GeneratedSlotStorage,
  MAX_PAGE_SAMPLES,
  type PageSampleStorage,
  RECIPE_REPLACE_INTERVAL_MS,
  MAX_RECIPE_REPLACEMENTS,
  type RecipeReplacementStorage,
} from "./generation-storage";
/** Request failures the service reports before any model call (ADR 0027). */
const failedBeforeModel = new Set<string>([
  "incomplete-observation",
  "invalid-request",
  "input-too-large",
]);

/** The layout key a branch name holds (ADR 0060), if any. */
const layoutOf = (branch: string | undefined) =>
  branch === undefined ? undefined : parseRecipeBranch(branch)?.layout;
/** Whether a branch name names a chooser's branch (ADR 0028). */
const chooserBranchOf = (branch: string | undefined) =>
  branch !== undefined && parseRecipeBranch(branch)?.branch !== undefined;
/**
 * The fields the request's offers named for each slot the service mapped, or nothing when
 * any mapped slot was not a custom-field offer of this request.
 */
function slotFieldsOf(
  request: RecipeGenerationRequest,
  customSlots: NonNullable<Extract<RecipeGenerationResult, { status: "recipe" }>["customSlots"]>,
): GeneratedSlotMaps["maps"][number]["slots"] | undefined {
  const mapped = customSlots.map(({ slot, offered }) => {
    const offer = request.slots.find((entry) => entry.id === offered);
    if (offer?.fieldName === undefined) return undefined;
    return {
      slot,
      field: {
        custom: offer.fieldName,
        ...(offer.fieldPosition
          ? { position: offer.fieldPosition.position, count: offer.fieldPosition.count }
          : {}),
      },
    };
  });
  return mapped.every((entry) => entry !== undefined) ? mapped : undefined;
}

/** Which check refused the model's output, as the local log records it. */
function refused(rejection: GenerationOutputRejection) {
  if (rejection.check === "plan") return { check: "plan", detail: rejection.reason } as const;
  if (rejection.check === "json") return { check: "json" } as const;
  return {
    check: "schema",
    detail: rejection.issue,
    ...(rejection.path ? { path: rejection.path } : {}),
  } as const;
}

/** A sent request's timing, for the local log and the login's own times (ADR 0019). */
const timingOf = (answer: { timing?: ServiceTiming }) =>
  answer.timing ? { timing: answer.timing } : {};

/** Unavailable codes a continuation's later document would get again (ADR 0018). */
const continuationSpent = new Set(["recipe-revoked", "recipe-conflict"]);

/** An answer that is not a recipe, as an outcome for the login runtime and the log. */
type NotRecipe = Exclude<RecipeGenerationResult | EntryGenerationResult, { status: "recipe" }>;
/**
 * The outcome of an answer that is no recipe: an abstention, a failure or refusal with its
 * code, or no answer. A page whose request did not reach the model is marked `retry`
 * (ADR 0016). A continuation of a revoked or since-changed recipe would get the same
 * answer from any later document, so the login spends it (ADR 0018).
 */
function notRecipe(
  answer: InferenceResult<NotRecipe | { status: "recipe" }>,
  base: GenerationBase | undefined,
): Exclude<GenerationOutcome, { outcome: "recipe" }> {
  const result = answer.kind === "result" ? answer.result : undefined;
  const reached =
    result?.status === "abstained" ||
    (result?.status === "failed" && !failedBeforeModel.has(result.error));
  const freed = reached ? {} : ({ retry: true } as const);
  if (!result || result.status === "recipe")
    return {
      outcome: "failed",
      reason: answer.kind === "failed" ? answer.error : "device-rejected",
      ...freed,
    };
  // Only a request with `deviceModel` is answered with a model call, which the device makes
  // before the answer comes here (ADR 0040).
  if (result.status === "model-call")
    return { outcome: "failed", reason: "unexpected-response", retry: true };
  if (result.status === "abstained") return { outcome: "abstained", reason: result.reason };
  if (result.status === "failed")
    return result.rejection
      ? { outcome: "failed", reason: "invalid-output", ...refused(result.rejection) }
      : { outcome: "failed", reason: result.error, ...freed };
  return {
    outcome: "unavailable",
    reason: result.reason,
    ...(base && continuationSpent.has(result.reason) ? {} : freed),
  };
}

/**
 * The extension side of the recipe generation routes (ADR 0018). Requests go only to the
 * paired service with the device credential; a returned recipe reaches the login runtime
 * through the recipe cache, which `sync` and `refresh` update.
 */
export function createLoginGeneration(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "generateRecipe" | "generateEntry" | "judgeCompletion"> &
    Partial<Pick<ServiceTransport, "samplePage">>;
  storage: GenerationAttemptStorage;
  /** Generated slot maps, written before a generated recipe is reported. */
  slotStorage: GeneratedSlotStorage;
  /** Signed-in page samples sent (ADR 0029); without it and `samplePage`, none is sent. */
  sampleStorage?: PageSampleStorage;
  /**
   * Repairs claimed for recipes the chosen item cannot run (ADR 0058 A, amended by ADR
   * 0041); without it, none is claimed.
   */
  replaceStorage?: RecipeReplacementStorage;
  /** A full sync of recipes and settings; resolves once the recipe cache holds them. */
  sync(): Promise<unknown>;
  /**
   * Pulls recipe changes only. A judged page or a continued recipe belongs to a login in
   * progress, which a settings write would stop as a policy change (ADR 0027, ADR 0018).
   */
  refresh(): Promise<unknown>;
  now?: () => number;
}): LoginGeneration {
  const { service, transport, storage, slotStorage, sampleStorage, replaceStorage, sync, refresh } =
    options;
  const now = options.now ?? Date.now;
  const {
    readSlotMaps,
    rememberSlots,
    recent,
    remember,
    same,
    claimSample,
    claimReplace,
    releaseReplace,
  } = createGenerationStorage({ storage, slotStorage, sampleStorage, now });

  async function connected() {
    const connection = await service.connection().catch(() => undefined);
    return connection && !connection.rejected ? connection : undefined;
  }

  /**
   * Claims the page as `sending` and sends it with `call`. The claim is kept for the
   * retry window only when the answer shows the request reached the model; every other
   * end frees the page for its next visit: a refusal before any model call, a timeout or
   * unexpected answer (the service answers `recently-tried` if its model call did happen)
   * and a thrown error alike (ADR 0016). It is settled as soon as the answer is read, and
   * only while it is still this request's claim. A page not sent is answered as `skipped`,
   * marked `retry` when it is left free.
   */
  async function claimed<Result extends { status: string; error?: string }>(
    page: { origin: string; path: string },
    base: GenerationBase | undefined,
    branch: string | undefined,
    repair: GenerationRepair | undefined,
    sent: (() => void) | undefined,
    call: (connection: ServiceConnection) => Promise<InferenceResult<Result>>,
  ): Promise<
    | { outcome: "skipped"; reason: string; retry?: true }
    | { connection: ServiceConnection; answer: InferenceResult<Result> }
  > {
    const connection = await connected();
    if (!connection) return { outcome: "skipped", reason: "not-connected", retry: true };
    const { origin, path } = page;
    // Claimed before sending, so another tab on the same page does not send it too.
    let held: GenerationHold | undefined;
    const claimedAt = now();
    const stored = await remember((attempts) => {
      held = attempts.find(same(origin, path, base, branch, repair))?.state;
      return held
        ? attempts
        : [
            ...attempts,
            {
              origin,
              path,
              ...(base ? { base } : {}),
              ...(branch ? { branch } : {}),
              ...(repair ? { repair } : {}),
              state: "sending",
              at: claimedAt,
            },
          ];
    });
    // A request still in flight frees the page within two minutes unless it reaches the
    // model.
    if (held)
      return {
        outcome: "skipped",
        reason: held,
        ...(held === "sending" ? { retry: true as const } : {}),
      };
    if (!stored) return { outcome: "skipped", reason: "storage-unavailable", retry: true };
    let settled = false;
    const settle = (reached: boolean) => {
      settled = true;
      const at = now();
      return remember((attempts) =>
        attempts.flatMap((entry) =>
          !same(origin, path, base, branch, repair)(entry) ||
          entry.state !== "sending" ||
          entry.at !== claimedAt
            ? [entry]
            : reached
              ? [{ ...entry, state: "sent" as const, at }]
              : [],
        ),
      );
    };
    try {
      sent?.();
      const answer = await call(connection);
      const result = answer.kind === "result" ? answer.result : undefined;
      await settle(
        result?.status === "recipe" ||
          result?.status === "abstained" ||
          (result?.status === "failed" && !failedBeforeModel.has(result.error ?? "")),
      );
      return { connection, answer };
    } finally {
      if (!settled) await settle(false);
    }
  }

  /** Whether the page may be sent for generation now, else why not (ADR 0016). */
  async function available(
    origin: string,
    path: string,
    base?: GenerationBase,
    branch?: string,
  ): Promise<true | GenerationHold> {
    if (!(await connected())) return "not-connected";
    await queue;
    const attempts = await recent().catch(() => []);
    return attempts.find(same(origin, path, base, branch))?.state ?? true;
  }
  /**
   * Claims a repair of a recipe the chosen item cannot run (ADR 0058 A, amended by ADR 0041):
   * once per recipe ID and missing route in 3 days for this service and device, recorded
   * before the request leaves. `release` drops the claim, for a request that never reached
   * the model.
   */
  async function claimRepair(
    store: RecipeReplacementStorage,
    recipeId: string,
    route: LoginRoute,
  ): Promise<RecipeRepairClaim> {
    const connection = await connected();
    if (!connection) return { outcome: "not-due", reason: "not-connected" };
    const claim = await claimReplace(store, connection, recipeId, route);
    if (claim === "recent") return { outcome: "not-due" };
    if (claim === "unavailable") return { outcome: "not-sent", reason: "storage-unavailable" };
    return {
      outcome: "claimed",
      release: async () => {
        await releaseReplace(store, connection, recipeId, route, claim.claimed);
      },
    };
  }

  return {
    available,
    ...(replaceStorage
      ? {
          claimRepair: (recipeId: string, route: LoginRoute) =>
            claimRepair(replaceStorage, recipeId, route),
        }
      : {}),
    async pullRecipes() {
      await refresh();
    },
    async generate(input: RecipeGenerationRequest, sent): Promise<GenerationOutcome> {
      // `totp` is offered only for a page with a code field, so the slots never tell the
      // model whether an account has TOTP (ADR 0027).
      const slots = slotsForPage(input.observation, input.slots);
      // A passkey-only page and a list of accounts (ADR 0028) are sent without slots.
      if (!slots.length && !input.passkeyOnly && input.observation.accounts === undefined)
        return { outcome: "skipped", reason: "no-slots" };
      const request = { ...input, slots };
      const { base, branch, repair } = request;
      const claim = await claimed(request.observation, base, branch, repair, sent, (connection) =>
        transport.generateRecipe(connection.origin, connection.credential, request),
      );
      if ("outcome" in claim) return claim;
      const { connection, answer } = claim;
      const timed = timingOf(answer);
      if (answer.kind !== "result" || answer.result.status !== "recipe")
        return { ...notRecipe(answer, base), ...timed };
      // The mapping arrives only with the answer that wrote the recipe; the login binds
      // the custom slots from it until a binding is saved (ADR 0027).
      const { customSlots, change } = answer.result;
      // A chooser recipe (ADR 0028) answers a list of accounts or a branch's page, and
      // only those. The login runs the layout its page continues, or the newest one, which
      // a first page creates (ADR 0060).
      const chooserPage = request.observation.accounts !== undefined || chooserBranchOf(branch);
      // A recipe may hold both kinds, so a first page takes the newest layout of its own.
      const recipe = storedLayoutRecipe(
        change.recipe,
        layoutOf(branch),
        chooserPage ? "list" : "form",
      );
      if (!recipe || chooserPage !== "chooser" in recipe)
        return { outcome: "unavailable", reason: "recipe-conflict", ...timed };
      const fields = customSlots && slotFieldsOf(request, customSlots);
      if (fields)
        await rememberSlots(
          {
            service: connection.origin,
            deviceId: connection.deviceId,
            recipeId: change.recipeId,
            slots: fields,
          },
          // A continuation answers with only its own page's slots (ADR 0027), and a repair
          // with only its new layout's, beside the layouts it keeps (ADR 0041).
          (request.base ?? request.repair)?.recipeId === change.recipeId && change.revision > 1
            ? storedRecipeSlots(change.recipe)
            : undefined,
        );
      // A continuation's login takes the recipe over at once; a full sync could apply a
      // settings change that stops it (ADR 0018, ADR 0027). Settings follow at the next one.
      await (base ? refresh() : sync()).catch(() => undefined);
      return { outcome: "recipe", recipe, ...timed };
    },
    async generateEntry(request: EntryGenerationRequest, sent): Promise<EntryGenerationOutcome> {
      // An entry's repair is claimed apart from the page's first generation (ADR 0041).
      const claim = await claimed(
        request.observation,
        undefined,
        undefined,
        request.repair,
        sent,
        (connection) => transport.generateEntry(connection.origin, connection.credential, request),
      );
      if ("outcome" in claim) return claim;
      const { answer } = claim;
      const timed = timingOf(answer);
      if (answer.kind !== "result" || answer.result.status !== "recipe")
        return { ...notRecipe(answer, undefined), ...timed };
      // Cached through the full sync as any first page's recipe.
      await sync().catch(() => undefined);
      return { outcome: "recipe", recipe: answer.result.change.recipe, ...timed };
    },
    async slotFields(recipeId: string): Promise<LoginBindingTemplate | undefined> {
      const connection = await service.connection().catch(() => undefined);
      if (!connection) return undefined;
      await slotQueue;
      return (await readSlotMaps())?.find(
        (map) =>
          map.service === connection.origin &&
          map.deviceId === connection.deviceId &&
          map.recipeId === recipeId,
      )?.slots;
    },
    async samplePage(sample, describe, sending): Promise<PageSampleOutcome> {
      if (!transport.samplePage || !sampleStorage) return { outcome: "not-due" };
      const connection = await connected();
      // A device without a pairing keeps no request log, so it has no samples (ADR 0040).
      if (!connection || connection.origin === DEVICE_GENERATION_ORIGIN)
        return { outcome: "not-due", reason: "not-connected" };
      const { recipeId, branch } = sample;
      // The service files a sample under the layout the login ran (ADR 0060).
      if (!v.is(recipeBranchSchema, branch)) return { outcome: "not-due", reason: "no-layout" };
      await sampleQueue;
      const due = await recentSamples().then(
        (samples) => !samples.some(sameSample(connection, recipeId, branch)),
        () => false,
      );
      if (!due) return { outcome: "not-due" };
      // The page is described only once a sample is due.
      const described = await describe();
      if ("unsent" in described) return { outcome: "not-sent", reason: described.unsent };
      const claim = await claimSample(connection, recipeId, branch);
      if (claim === "recent") return { outcome: "not-due" };
      if (claim === "unavailable") return { outcome: "not-sent", reason: "storage-unavailable" };
      // Checked again once recorded; a stopped sample stays recorded.
      const stop = await sending?.().catch(() => "settings-unavailable");
      if (stop) return { outcome: "not-sent", reason: stop };
      const answer = await transport.samplePage(
        connection.origin,
        connection.credential,
        recipeId,
        {
          version: 1,
          revision: sample.revision,
          route: sample.route,
          branch,
          observation: described.observation,
          // The account's slots, as the judge request carries them (owner 2026-10-23).
          slots: slotsForPage(described.observation, described.slots),
        },
      );
      if (answer.kind === "rejected") return { outcome: "failed", reason: "device-rejected" };
      if (answer.kind === "failed") return { outcome: "failed", reason: answer.error };
      return { outcome: answer.kind };
    },
    async judge(
      recipeId: string,
      revision: number,
      route: LoginRoute,
      observation: LoginObservation,
      sent?: () => void,
      branch?: string,
      partial?: true,
      stop?: true,
      slots: readonly SemanticSlot[] = [],
      beside?: true,
    ) {
      const connection = await connected();
      if (!connection) return { verdict: "retry", reason: "not-connected" };
      // The service judges the route of the layout the login ran (ADR 0060).
      if (!v.is(recipeBranchSchema, branch)) return { verdict: "unclear", reason: "no-layout" };
      sent?.();
      const answer = await transport.judgeCompletion(
        connection.origin,
        connection.credential,
        recipeId,
        {
          version: 1,
          revision,
          route,
          branch,
          observation,
          // As for generation, `totp` only on a page with a code field (ADR 0027).
          slots: slotsForPage(observation, slots),
          ...(partial ? { partial } : {}),
          ...(stop ? { stop } : {}),
          ...(beside ? { beside } : {}),
        },
      );
      const result: RecipeCompletionResult | undefined =
        answer.kind === "result" ? answer.result : undefined;
      const timed = timingOf(answer);
      // Later runs use the learned completion; this attempt settles without waiting.
      if (result?.status === "signed-in") void refresh().catch(() => undefined);
      // The login continues with the returned recipe; the cache catches up behind it (ADR 0027).
      // The secret questions the judge paired with the account's slots go with it, for the
      // owner to confirm (ADR 0061).
      if (result?.status === "challenge" && result.change) {
        void refresh().catch(() => undefined);
        // A chooser login's (ADR 0028) is the whole chooser; an entry recipe is never one.
        // Either is the judged layout (ADR 0060).
        const recipe = storedLayoutRecipe(result.change.recipe, layoutOf(branch));
        if (recipe && chooserBranchOf(branch) === "chooser" in recipe)
          return {
            verdict: "challenge",
            recipe,
            ...(result.questions ? { questions: result.questions } : {}),
            ...timed,
          };
      }
      if (
        result?.status === "signed-in" ||
        result?.status === "rejected" ||
        result?.status === "challenge" ||
        result?.status === "optional"
      )
        return { verdict: result.status, ...timed };
      // For the local log: the transport's, the service's or the model call's code.
      const reason =
        answer.kind === "rejected"
          ? "device-rejected"
          : answer.kind === "failed"
            ? answer.error
            : result?.status === "unavailable"
              ? result.reason
              : result?.status === "failed"
                ? result.error
                : undefined;
      const refusal = reason ? { reason } : {};
      // A temporary refusal before any model call (ADR 0027): the service was busy,
      // unreachable or over its own request limit, the device was rejected, or the request
      // failed before the model. Every other answer, including a permanent refusal such as
      // `already-judged` and the provider's rate limit, spends the page.
      if (
        answer.kind === "rejected" ||
        (answer.kind === "failed" &&
          (answer.error === "unreachable" || answer.error === "rate-limited")) ||
        (result?.status === "unavailable" && result.reason === "busy") ||
        (result?.status === "failed" && failedBeforeModel.has(result.error))
      )
        return { verdict: "retry", ...refusal, ...timed };
      return { verdict: "unclear", ...refusal, ...timed };
    },
  };
}

