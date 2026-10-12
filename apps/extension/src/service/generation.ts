import {
  genericSlotIdSchema,
  recipeSlots,
  slotsForPage,
  syncRecipeIdSchema,
  vaultFieldReferenceSchema,
  type GenerationOutputRejection,
  type LoginBindingTemplate,
  type LoginObservation,
  type LoginRoute,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
} from "@pateat/contracts";
import * as v from "valibot";
import type { GenerationHold, GenerationOutcome, LoginGeneration } from "../login/runtime";
import type { ServiceConnection } from "./runtime";
import type { ServiceTransport } from "./transport";

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

/**
 * Each origin and path claimed for generation: `sending` while its request is in flight,
 * `sent` once an answer showed the request reached the model (ADR 0016).
 */
const attemptsSchema = v.strictObject({
  version: v.literal(1),
  attempts: v.pipe(
    v.array(
      v.strictObject({
        origin: v.pipe(v.string(), v.maxLength(2048)),
        path: v.pipe(v.string(), v.maxLength(2048)),
        state: v.picklist(["sending", "sent"]),
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

/**
 * The extension side of the recipe generation routes (ADR 0018). Requests go only to the
 * paired service with the device credential; a returned recipe reaches the login runtime
 * through the recipe cache, which `sync` and `refresh` update.
 */
export function createLoginGeneration(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "generateRecipe" | "judgeCompletion">;
  storage: GenerationAttemptStorage;
  /** Generated slot maps, written before a generated recipe is reported. */
  slotStorage: GeneratedSlotStorage;
  /** A full sync of recipes and settings; resolves once the recipe cache holds them. */
  sync(): Promise<unknown>;
  /**
   * Pulls recipe changes only. A judged page belongs to a login in progress, which a
   * settings write would stop as a policy change (ADR 0027).
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
  const same = (origin: string, path: string) => (entry: { origin: string; path: string }) =>
    entry.origin === origin && entry.path === path;

  async function connected() {
    const connection = await service.connection().catch(() => undefined);
    return connection && !connection.rejected ? connection : undefined;
  }

  return {
    async available(origin, path) {
      if (!(await connected())) return "not-connected";
      await queue;
      const attempts = await recent().catch(() => []);
      return attempts.find(same(origin, path))?.state ?? true;
    },
    async generate(input: RecipeGenerationRequest): Promise<GenerationOutcome> {
      // `totp` is offered only for a page with a code field, so the slots never tell the
      // model whether an account has TOTP (ADR 0027).
      const slots = slotsForPage(input.observation, input.slots);
      if (!slots.length) return { outcome: "skipped", reason: "no-slots" };
      const request = { ...input, slots };
      const connection = await connected();
      if (!connection) return { outcome: "skipped", reason: "not-connected" };
      const { origin, path } = request.observation;
      // Claimed before sending, so another tab on the same page does not send it too.
      let held: GenerationHold | undefined;
      const claimedAt = now();
      const stored = await remember((attempts) => {
        held = attempts.find(same(origin, path))?.state;
        return held ? attempts : [...attempts, { origin, path, state: "sending", at: claimedAt }];
      });
      if (held) return { outcome: "skipped", reason: held };
      if (!stored) return { outcome: "skipped", reason: "storage-unavailable" };
      // The claim is kept for the retry window only when the answer shows this request
      // reached the model. Every other end frees the page for its next visit: a refusal before any
      // model call, a timeout or unexpected answer (the service answers `recently-tried`
      // if its model call did happen) and a thrown error alike (ADR 0016). It is settled
      // as soon as the answer is read, and only while it is still this request's claim.
      let settled = false;
      const settle = (reached: boolean) => {
        settled = true;
        const at = now();
        return remember((attempts) =>
          attempts.flatMap((entry) =>
            !same(origin, path)(entry) || entry.state !== "sending" || entry.at !== claimedAt
              ? [entry]
              : reached
                ? [{ ...entry, state: "sent" as const, at }]
                : [],
          ),
        );
      };
      try {
        const answer = await transport.generateRecipe(
          connection.origin,
          connection.credential,
          request,
        );
        const result = answer.kind === "result" ? answer.result : undefined;
        await settle(
          result?.status === "recipe" ||
            result?.status === "abstained" ||
            (result?.status === "failed" && !failedBeforeModel.has(result.error)),
        );
        if (!result)
          return {
            outcome: "failed",
            reason: answer.kind === "failed" ? answer.error : "device-rejected",
          };
        if (result.status === "abstained") return { outcome: "abstained", reason: result.reason };
        if (result.status === "failed")
          return result.rejection
            ? { outcome: "failed", reason: "invalid-output", ...refused(result.rejection) }
            : { outcome: "failed", reason: result.error };
        if (result.status === "unavailable")
          return { outcome: "unavailable", reason: result.reason };
        // The mapping arrives only with the answer that wrote the recipe; the login binds
        // the custom slots from it until a binding is saved (ADR 0027).
        const { customSlots, change } = result;
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
              ? recipeSlots(change.recipe)
              : undefined,
          );
        await sync().catch(() => undefined);
        return { outcome: "recipe" };
      } finally {
        if (!settled) await settle(false);
      }
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
    ) {
      const connection = await connected();
      if (!connection) return { verdict: "retry", reason: "not-connected" };
      const answer = await transport.judgeCompletion(
        connection.origin,
        connection.credential,
        recipeId,
        { version: 1, revision, route, observation },
      );
      const result: RecipeCompletionResult | undefined =
        answer.kind === "result" ? answer.result : undefined;
      // Later runs use the learned completion; this attempt settles without waiting.
      if (result?.status === "signed-in") void refresh().catch(() => undefined);
      // The login continues with the returned recipe; the cache catches up behind it (ADR 0027).
      if (result?.status === "challenge" && result.change) {
        void refresh().catch(() => undefined);
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
