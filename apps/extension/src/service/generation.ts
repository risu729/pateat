import {
  genericSlotIdSchema,
  slotsForPage,
  syncRecipeIdSchema,
  vaultFieldReferenceSchema,
  type LoginBindingTemplate,
  type LoginObservation,
  type LoginRoute,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
  type RecipeGenerationResult,
} from "@pateat/contracts";
import * as v from "valibot";
import type { LoginGeneration } from "../login/runtime";
import type { ServiceConnection } from "./runtime";
import type { ServiceTransport } from "./transport";

/** A page sent for generation is not sent again for this long, whatever came of it (ADR 0016). */
export const GENERATION_RETRY_MS = 24 * 60 * 60 * 1000;
/** Pages remembered at once; the oldest go first. */
export const MAX_GENERATION_ATTEMPTS = 500;
/** Request failures the service reports before any model call (ADR 0027). */
const failedBeforeModel = new Set<string>([
  "incomplete-observation",
  "invalid-request",
  "input-too-large",
]);

// When each origin and path was last sent, so a page is not sent again within a day.
const attemptsSchema = v.strictObject({
  version: v.literal(1),
  attempts: v.pipe(
    v.array(
      v.strictObject({
        origin: v.pipe(v.string(), v.maxLength(2048)),
        path: v.pipe(v.string(), v.maxLength(2048)),
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
  // Every binding check reads the slot maps, so they are kept in memory after one read.
  let slotMaps: Promise<GeneratedSlotMaps["maps"]> | undefined;
  let slotQueue: Promise<unknown> = Promise.resolve();

  function readSlotMaps(): Promise<GeneratedSlotMaps["maps"]> {
    slotMaps ??= slotStorage
      .read()
      .catch(() => undefined)
      .then((stored) => {
        const parsed = v.safeParse(slotMapsSchema, stored);
        return parsed.success ? parsed.output.maps : [];
      });
    return slotMaps;
  }
  /** Replaces one recipe's slot map; nothing is kept in memory that was not written. */
  function rememberSlots(entry: GeneratedSlotMaps["maps"][number]): Promise<boolean> {
    const next = slotQueue.then(async () => {
      const maps = [
        ...(await readSlotMaps()).filter((map) => map.recipeId !== entry.recipeId),
        entry,
      ].slice(-MAX_GENERATED_SLOT_MAPS);
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

  async function recent(): Promise<GenerationAttempts["attempts"]> {
    const parsed = v.safeParse(attemptsSchema, await storage.read().catch(() => undefined));
    const since = now() - GENERATION_RETRY_MS;
    return parsed.success ? parsed.output.attempts.filter((entry) => entry.at > since) : [];
  }
  /** Applies one change to the remembered attempts; fails closed when it cannot write. */
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
      if (!(await connected())) return false;
      await queue;
      return !(await recent()).some(same(origin, path));
    },
    async generate(input: RecipeGenerationRequest) {
      // `totp` is offered only for a page with a code field, so the slots never tell the
      // model whether an account has TOTP (ADR 0027).
      const slots = slotsForPage(input.observation, input.slots);
      if (!slots.length) return "none";
      const request = { ...input, slots };
      const connection = await connected();
      if (!connection) return "none";
      const { origin, path } = request.observation;
      // Claimed before sending, so another tab on the same page does not send it too.
      let claimed = false;
      const stored = await remember((attempts) => {
        if (attempts.some(same(origin, path))) return attempts;
        claimed = true;
        return [...attempts, { origin, path, at: now() }];
      });
      if (!claimed || !stored) return "none";
      const answer = await transport.generateRecipe(
        connection.origin,
        connection.credential,
        request,
      );
      // Nothing reached the model: the page may be sent again on a later visit. The
      // service's request limit refuses before any model call. A timeout or an
      // unexpected answer may follow a model call, so the page stays claimed.
      if (
        (answer.kind === "failed" &&
          (answer.error === "unreachable" || answer.error === "rate-limited")) ||
        (answer.kind === "result" &&
          answer.result.status === "unavailable" &&
          answer.result.reason === "busy")
      ) {
        await remember((attempts) => attempts.filter((entry) => !same(origin, path)(entry)));
        return "none";
      }
      if (answer.kind !== "result" || answer.result.status !== "recipe") return "none";
      // The mapping arrives only with the answer that wrote the recipe; the login binds
      // the custom slots from it until a binding is saved (ADR 0027).
      const { customSlots, change } = answer.result;
      const fields = customSlots && slotFieldsOf(request, customSlots);
      if (fields)
        await rememberSlots({
          service: connection.origin,
          deviceId: connection.deviceId,
          recipeId: change.recipeId,
          slots: fields,
        });
      await sync().catch(() => undefined);
      return "recipe";
    },
    async slotFields(recipeId: string): Promise<LoginBindingTemplate | undefined> {
      const connection = await service.connection().catch(() => undefined);
      if (!connection) return undefined;
      await slotQueue;
      return (await readSlotMaps()).find(
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
      if (!connection) return { verdict: "retry" };
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
        return { verdict: "retry" };
      return { verdict: "unclear" };
    },
  };
}
