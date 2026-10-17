import {
  chooserBranchSchema,
  genericSlotIdSchema,
  isLoginRouteRecipe,
  storedRecipeSlots,
  slotsForPage,
  syncRecipeIdSchema,
  vaultFieldReferenceSchema,
  type ChooserBranch,
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type GenerationOutputRejection,
  type LoginBindingTemplate,
  type LoginObservation,
  type LoginRoute,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
} from "@pateat/contracts";
import * as v from "valibot";
import type {
  EntryGenerationOutcome,
  GenerationHold,
  GenerationOutcome,
  LoginGeneration,
} from "../login/runtime";
import type { ServiceConnection } from "./runtime";
import type { InferenceResult, ServiceTransport } from "./transport";

/**
 * A page whose request reached the model is not sent again for this long, whatever came of
 * it: the service's retry window (ADR 0016, owner 2026-10-12).
 */
export const GENERATION_RETRY_MS = 10 * 60 * 1000;
/**
 * How long a page stays claimed while its request is in flight: longer than the
 * transport's 90-second inference timeout, so a claim whose request was lost with a
 * stopped or reloaded worker frees the page soon after (ADR 0016).
 */
export const GENERATION_SENDING_MS = 2 * 60 * 1000;
/** Pages remembered at once; the oldest go first. */
export const MAX_GENERATION_ATTEMPTS = 500;
/** Request failures the service reports before any model call (ADR 0027). */
const failedBeforeModel = new Set<string>([
  "incomplete-observation",
  "invalid-request",
  "input-too-large",
]);

/** The recipe revision a page continues after its final `advance` step (ADR 0018). */
type GenerationBase = NonNullable<RecipeGenerationRequest["base"]>;
/**
 * Each origin and path claimed for generation: `sending` while its request is in flight,
 * `sent` once an answer showed the request reached the model (ADR 0016). A page that
 * continues a recipe is claimed under that recipe revision, not under its path alone
 * (ADR 0018), as the service's own rule does.
 */
const attemptsSchema = v.strictObject({
  version: v.literal(1),
  attempts: v.pipe(
    v.array(
      v.strictObject({
        origin: v.pipe(v.string(), v.maxLength(2048)),
        path: v.pipe(v.string(), v.maxLength(2048)),
        state: v.picklist(["sending", "sent"]),
        base: v.optional(
          v.strictObject({
            recipeId: syncRecipeIdSchema,
            revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
          }),
        ),
        /** For a chooser's page (ADR 0028): the branch it continues. */
        branch: v.optional(chooserBranchSchema),
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
    v.maxLength(MAX_GENERATION_ATTEMPTS),
  ),
});
type GenerationAttempts = v.InferOutput<typeof attemptsSchema>;

export interface GenerationAttemptStorage {
  read(): Promise<unknown>;
  write(attempts: GenerationAttempts): Promise<void>;
}

/** Generated recipes whose custom-field slots this device remembers; the oldest go first. */
export const MAX_GENERATED_SLOT_MAPS = 200;
/**
 * Which vault field each custom slot of a recipe generated from this device names, from
 * the request that produced it (ADR 0027). It is kept per service and device, since a
 * generated recipe's ID depends only on its origin and start path, so a device paired
 * again or with another service never reuses an old map.
 */
const slotMapsSchema = v.strictObject({
  version: v.literal(1),
  maps: v.pipe(
    v.array(
      v.strictObject({
        service: v.pipe(v.string(), v.maxLength(2048)),
        deviceId: v.pipe(v.string(), v.maxLength(200)),
        recipeId: syncRecipeIdSchema,
        slots: v.pipe(
          v.array(v.strictObject({ slot: genericSlotIdSchema, field: vaultFieldReferenceSchema })),
          v.minLength(1),
          v.maxLength(20),
        ),
      }),
    ),
    v.maxLength(MAX_GENERATED_SLOT_MAPS),
  ),
});
type GeneratedSlotMaps = v.InferOutput<typeof slotMapsSchema>;

export interface GeneratedSlotStorage {
  read(): Promise<unknown>;
  write(maps: GeneratedSlotMaps): Promise<void>;
}

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
  transport: Pick<ServiceTransport, "generateRecipe" | "generateEntry" | "judgeCompletion">;
  storage: GenerationAttemptStorage;
  /** Generated slot maps, written before a generated recipe is reported. */
  slotStorage: GeneratedSlotStorage;
  /** A full sync of recipes and settings; resolves once the recipe cache holds them. */
  sync(): Promise<unknown>;
  /**
   * Pulls recipe changes only. A judged page or a continued recipe belongs to a login in
   * progress, which a settings write would stop as a policy change (ADR 0027, ADR 0018).
   */
  refresh(): Promise<unknown>;
  now?: () => number;
}): LoginGeneration {
  const { service, transport, storage, slotStorage, sync, refresh } = options;
  const now = options.now ?? Date.now;
  // Writes are serialized so two pages sent together are both remembered.
  let queue: Promise<unknown> = Promise.resolve();
  // Every binding check reads the slot maps, so they are kept in memory after one read. A
  // read that fails is not kept, so the next call reads storage again; stored maps that do
  // not parse count as none, since no older format is kept (ADR 0027).
  let slotMaps: Promise<GeneratedSlotMaps["maps"] | undefined> | undefined;
  let slotQueue: Promise<unknown> = Promise.resolve();

  function readSlotMaps(): Promise<GeneratedSlotMaps["maps"] | undefined> {
    if (slotMaps) return slotMaps;
    const read: Promise<GeneratedSlotMaps["maps"] | undefined> = slotStorage.read().then(
      (stored) => {
        const parsed = v.safeParse(slotMapsSchema, stored);
        return parsed.success ? parsed.output.maps : [];
      },
      () => {
        if (slotMaps === read) slotMaps = undefined;
        return undefined;
      },
    );
    slotMaps = read;
    return read;
  }
  /**
   * Stores one recipe's slot map. A continuation's map is added to the map of the recipe
   * it continues; a new recipe replaces any map under its ID. Nothing is written when the
   * stored maps could not be read, so other recipes' maps are never dropped, and nothing
   * is kept in memory that was not written.
   */
  function rememberSlots(
    entry: GeneratedSlotMaps["maps"][number],
    /** The continued recipe's slots, when the answer continues a recipe. */
    continued: readonly string[] | undefined,
  ): Promise<boolean> {
    const next = slotQueue.then(async () => {
      const current = await readSlotMaps();
      if (!current) return false;
      // Slots the continued recipe still has and this answer does not name again.
      const kept = continued
        ? (current
            .find(
              (map) =>
                map.service === entry.service &&
                map.deviceId === entry.deviceId &&
                map.recipeId === entry.recipeId,
            )
            ?.slots.filter(
              ({ slot }) =>
                continued.includes(slot) && !entry.slots.some((added) => added.slot === slot),
            ) ?? [])
        : [];
      const merged = { ...entry, slots: [...kept, ...entry.slots] };
      const maps = [...current.filter((map) => map.recipeId !== entry.recipeId), merged].slice(
        -MAX_GENERATED_SLOT_MAPS,
      );
      try {
        await slotStorage.write({ version: 1, maps });
      } catch (error) {
        slotMaps = undefined;
        throw error;
      }
      slotMaps = Promise.resolve(maps);
      return true;
    });
    slotQueue = next.catch(() => undefined);
    return next.catch(() => false);
  }

  /** The claims still in force; stored claims that do not parse count as none. */
  async function recent(): Promise<GenerationAttempts["attempts"]> {
    const parsed = v.safeParse(attemptsSchema, await storage.read());
    const at = now();
    return parsed.success
      ? parsed.output.attempts.filter(
          (entry) =>
            entry.at > at - (entry.state === "sent" ? GENERATION_RETRY_MS : GENERATION_SENDING_MS),
        )
      : [];
  }
  /**
   * Applies one change to the remembered attempts; fails closed when it cannot read or
   * write, so a failed read never drops the other pages' claims.
   */
  function remember(
    change: (attempts: GenerationAttempts["attempts"]) => GenerationAttempts["attempts"],
  ): Promise<boolean> {
    const next = queue.then(async () => {
      const attempts = change(await recent()).slice(-MAX_GENERATION_ATTEMPTS);
      await storage.write({ version: 1, attempts });
      return true;
    });
    queue = next.catch(() => undefined);
    return next.catch(() => false);
  }
  const same =
    (origin: string, path: string, base?: GenerationBase, branch?: ChooserBranch) =>
    (entry: GenerationAttempts["attempts"][number]) =>
      entry.origin === origin &&
      entry.path === path &&
      entry.base?.recipeId === base?.recipeId &&
      entry.base?.revision === base?.revision &&
      entry.branch === branch;

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
    branch: ChooserBranch | undefined,
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
      held = attempts.find(same(origin, path, base, branch))?.state;
      return held
        ? attempts
        : [
            ...attempts,
            {
              origin,
              path,
              ...(base ? { base } : {}),
              ...(branch ? { branch } : {}),
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
          !same(origin, path, base, branch)(entry) ||
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

  return {
    async available(origin, path, base, branch) {
      if (!(await connected())) return "not-connected";
      await queue;
      const attempts = await recent().catch(() => []);
      return attempts.find(same(origin, path, base, branch))?.state ?? true;
    },
    async generate(input: RecipeGenerationRequest, sent): Promise<GenerationOutcome> {
      // `totp` is offered only for a page with a code field, so the slots never tell the
      // model whether an account has TOTP (ADR 0027).
      const slots = slotsForPage(input.observation, input.slots);
      if (!slots.length) return { outcome: "skipped", reason: "no-slots" };
      const request = { ...input, slots };
      const { base, branch } = request;
      const claim = await claimed(request.observation, base, branch, sent, (connection) =>
        transport.generateRecipe(connection.origin, connection.credential, request),
      );
      if ("outcome" in claim) return claim;
      const { connection, answer } = claim;
      if (answer.kind !== "result" || answer.result.status !== "recipe")
        return notRecipe(answer, base);
      // The mapping arrives only with the answer that wrote the recipe; the login binds
      // the custom slots from it until a binding is saved (ADR 0027).
      const { customSlots, change } = answer.result;
      // A chooser recipe (ADR 0028) answers a list of accounts or a branch's page, and
      // only those.
      if (
        request.observation.accounts !== undefined || request.branch !== undefined
          ? !("chooser" in change.recipe)
          : !isLoginRouteRecipe(change.recipe)
      )
        return { outcome: "unavailable", reason: "recipe-conflict" };
      const fields = customSlots && slotFieldsOf(request, customSlots);
      if (fields)
        await rememberSlots(
          {
            service: connection.origin,
            deviceId: connection.deviceId,
            recipeId: change.recipeId,
            slots: fields,
          },
          // A continuation answers with only its own page's slots (ADR 0027).
          request.base?.recipeId === change.recipeId && change.revision > 1
            ? storedRecipeSlots(change.recipe)
            : undefined,
        );
      // A continuation's login takes the recipe over at once; a full sync could apply a
      // settings change that stops it (ADR 0018, ADR 0027). Settings follow at the next one.
      await (base ? refresh() : sync()).catch(() => undefined);
      return { outcome: "recipe", recipe: change.recipe };
    },
    async generateEntry(request: EntryGenerationRequest, sent): Promise<EntryGenerationOutcome> {
      const claim = await claimed(request.observation, undefined, undefined, sent, (connection) =>
        transport.generateEntry(connection.origin, connection.credential, request),
      );
      if ("outcome" in claim) return claim;
      const { answer } = claim;
      if (answer.kind !== "result" || answer.result.status !== "recipe")
        return notRecipe(answer, undefined);
      // Cached through the full sync as any first page's recipe.
      await sync().catch(() => undefined);
      return { outcome: "recipe", recipe: answer.result.change.recipe };
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
    async judge(
      recipeId: string,
      revision: number,
      route: LoginRoute,
      observation: LoginObservation,
      sent?: () => void,
      branch?: ChooserBranch,
      partial?: true,
      stop?: true,
    ) {
      const connection = await connected();
      if (!connection) return { verdict: "retry", reason: "not-connected" };
      sent?.();
      const answer = await transport.judgeCompletion(
        connection.origin,
        connection.credential,
        recipeId,
        {
          version: 1,
          revision,
          route,
          ...(branch ? { branch } : {}),
          observation,
          ...(partial ? { partial } : {}),
          ...(stop ? { stop } : {}),
        },
      );
      const result: RecipeCompletionResult | undefined =
        answer.kind === "result" ? answer.result : undefined;
      // Later runs use the learned completion; this attempt settles without waiting.
      if (result?.status === "signed-in") void refresh().catch(() => undefined);
      // The login continues with the returned recipe; the cache catches up behind it (ADR 0027).
      if (result?.status === "challenge" && result.change) {
        void refresh().catch(() => undefined);
        // A chooser login's (ADR 0028) is the whole chooser; an entry recipe is never one.
        if (branch ? "chooser" in result.change.recipe : isLoginRouteRecipe(result.change.recipe))
          return { verdict: "challenge", recipe: result.change.recipe };
      }
      if (
        result?.status === "signed-in" ||
        result?.status === "rejected" ||
        result?.status === "challenge"
      )
        return { verdict: result.status };
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
        return { verdict: "retry", ...refusal };
      return { verdict: "unclear", ...refusal };
    },
  };
}
