import {
  slotsForPage,
  type LoginObservation,
  type LoginRoute,
  type RecipeCompletionResult,
  type RecipeGenerationRequest,
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

/**
 * The extension side of the recipe generation routes (ADR 0018). Requests go only to the
 * paired service with the device credential; a returned recipe reaches the login runtime
 * through the recipe cache, which `sync` and `refresh` update.
 */
export function createLoginGeneration(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "generateRecipe" | "judgeCompletion">;
  storage: GenerationAttemptStorage;
  /** A full sync of recipes and settings; resolves once the recipe cache holds them. */
  sync(): Promise<unknown>;
  /**
   * Pulls recipe changes only. A judged page belongs to a login in progress, which a
   * settings write would stop as a policy change (ADR 0027).
   */
  refresh(): Promise<unknown>;
  now?: () => number;
}): LoginGeneration {
  const { service, transport, storage, sync, refresh } = options;
  const now = options.now ?? Date.now;
  // Writes are serialized so two pages sent together are both remembered.
  let queue: Promise<unknown> = Promise.resolve();

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
      await sync().catch(() => undefined);
      return "recipe";
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
