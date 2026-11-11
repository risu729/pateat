import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_OPENAI_MODEL_CONFIG,
  type DeviceModel,
  type DeviceModelCall,
  type ModelConfig,
} from "@pateat/contracts";
import {
  choiceAttempts,
  CLEF_LIMITS,
  CLEF_MODEL,
  MAX_OUTPUT_TOKENS,
  nextAttempt,
  ROLE_LIMITS,
  roleChoices,
  servedModel,
  type GenerationCall,
  type GenerationCallResult,
  type GenerationCallTimings,
  type RoleChoice,
} from "@pateat/generation";
import {
  modelWorstCaseRates,
  clefModels,
  createClefBindingModel,
  estimateModelCostUsd,
  estimateClefCostUsd,
  outputRejection,
  unknownUsage,
  type FiniteChoiceModel,
  type InferenceOutcome,
} from "@pateat/inference";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { inferenceLocks, inferenceLog } from "../db/schema";
import {
  providerUnavailable,
  resolveModelCredential,
  type ModelCredential,
} from "./provider-credentials";
import { providerModel } from "./provider-model";
import { deviceClefRelay, deviceRelay, reserveOnce, Unsent, type Reservation } from "./call-relays";
import { fastFailingModels, readModelConfig } from "./models";
import { newId } from "@pateat/contracts/ids";

import { periods, addSpend, acquireSlot, limitReached } from "./call-budget";
import {
  purgeExpiredLog,
  observationHash,
  loggedLayout,
  pageKindColumns,
  loggedResult,
} from "./call-log";
import type { Db, CallEnv } from "./call-types";

/**
 * What a call is charged when the provider reports no usage: its upper bound at its
 * model's rates, since a request holds at most `maxInputBytes` tokens (ADR 0003).
 */
const worstCaseMicroUsd = ({ provider, rates }: RoleChoice) => {
  const { input, output } = modelWorstCaseRates(provider, rates, ROLE_LIMITS.maxInputBytes);
  return ROLE_LIMITS.maxInputBytes * input + MAX_OUTPUT_TOKENS * output;
};

type Called<T> = Extract<GenerationCallResult<T>, { status: "called" }>;

/** Whose key a request's calls use: the owner's credential, or the device's (ADR 0040). */
type CallerKey =
  | { credential: ModelCredential }
  /** `index` is the call's place among the request's calls, so its response's. */
  | { device: DeviceModel; index: number };

export async function runCall<T>(
  env: CallEnv,
  ownerId: string,
  call: GenerationCall<T>,
  startedAt: number,
): Promise<GenerationCallResult<T>> {
  const db = drizzle(env.DB);
  const start = Date.now();
  const held = await acquireSlot(db, ownerId, start);
  if (!held) return { status: "unavailable", reason: "busy" };
  try {
    const { device } = call;
    // The spend stops count the owner's credential only; a device's key pays its own calls.
    const blocked =
      (await call.gate?.(start)) ?? (device ? undefined : await limitReached(db, ownerId, start));
    if (blocked) return { status: "unavailable", reason: blocked };

    const reservation = reserveOnce(async () => {
      const refused = await call.beforeSend?.(Date.now());
      if (refused) throw new Unsent(refused);
    });

    const [{ config }, fastFailing] = await Promise.all([
      readModelConfig(env.DB, ownerId),
      fastFailingModels(env.DB, ownerId, Date.now(), device ? "device" : "service"),
    ]);
    // A device authorizes only its selected provider's key. If none of the owner's
    // choices use it, use that provider's defaults instead of requesting another key.
    const defaults =
      device?.provider === "openai" ? DEFAULT_OPENAI_MODEL_CONFIG : DEFAULT_MODEL_CONFIG;
    const configured: ModelConfig = device
      ? {
          generate: config.generate.filter((choice) => choice.provider === device.provider),
          judge: config.judge.filter((choice) => choice.provider === device.provider),
        }
      : config;
    const choices = roleChoices(configured, call.role, fastFailing, defaults);
    const firstProvider = choices[0]?.provider;
    if (!firstProvider) return { status: "unavailable", reason: "credentials-not-configured" };

    // Clef answers first where it can (ADR 0083). A device with its own key calls the
    // models itself, so the service's binding takes no part in its requests.
    if (call.firstChoice && !device && env.AI) {
      const missing = await providerUnavailable(env, ownerId, firstProvider);
      if (missing) return { status: "unavailable", reason: missing };
      let first: Awaited<ReturnType<typeof sendClefCall<T>>>;
      try {
        first = await sendClefCall(
          db,
          ownerId,
          call,
          call.firstChoice,
          createClefBindingModel({ ai: env.AI, modelId: CLEF_MODEL }),
          "service",
          reservation,
          startedAt,
        );
      } catch (error) {
        // `beforeSend` stopped the request before its first model request was sent.
        if (error instanceof Unsent) return { status: "unavailable", reason: error.reason };
        throw error;
      }
      if (first.outcome.status === "ok")
        return {
          status: "called",
          ...first,
          served: { provider: "cloudflare", model: CLEF_MODEL },
          promptVersion: call.firstChoice.promptVersion,
        };
      // Claude's row counts Clef's call in its time before the model. Clef's spend may have reached a stop before Claude is asked.
      const stopped = await limitReached(db, ownerId, Date.now());
      if (stopped) return { status: "unavailable", reason: stopped };
    }

    // A device with its own key and a Cloudflare token makes Clef's calls itself, as it
    // makes Claude's (ADR 0083): they come first among its calls, and Claude's follow.
    let claudeIndex = 0;
    /** Clef's calls the device made, which the row of Claude's last run logs first. */
    let clefToLog = false;
    if (call.firstChoice && device?.clef) {
      const relay = deviceClefRelay(device);
      let probe: InferenceOutcome<T>;
      try {
        probe = await call.firstChoice.invoke(relay.model);
      } catch {
        probe = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
      }
      const next = relay.next();
      if (next) return { status: "device-call", call: next };
      claudeIndex = relay.used();
      clefToLog = true;
      if (probe.status === "ok") {
        let first: Awaited<ReturnType<typeof sendClefCall<T>>>;
        try {
          first = await sendClefCall(
            db,
            ownerId,
            call,
            call.firstChoice,
            // Each run of the role takes the device's responses anew.
            deviceClefRelay(device).model,
            "device",
            reservation,
            startedAt,
          );
        } catch (error) {
          if (error instanceof Unsent) return { status: "unavailable", reason: error.reason };
          throw error;
        }
        // Logged already, whatever it answered this time.
        clefToLog = false;
        if (first.outcome.status === "ok")
          return {
            status: "called",
            ...first,
            served: { provider: "cloudflare", model: CLEF_MODEL },
            promptVersion: call.firstChoice.promptVersion,
          };
      }
    }

    const credentials = new Map<string, ModelCredential>();
    // The role's choices in order (owner decision, 2026-10-23 11:31 UTC): a refusal asks
    // the next choice; fast mode that failed asks the same model at the standard speed; any
    // other failure ends the request. Each call first checks the spend stops. The calls
    // depend on each other's outcome, so they run in turn. A `dry` run writes and logs
    // nothing: it only finds whether the device still has a call to make (ADR 0040).
    const run = async (dry: boolean): Promise<GenerationCallResult<T>> => {
      let last: Called<T> | undefined;
      let index = claudeIndex;
      for (const attempt of choices.flatMap(choiceAttempts)) {
        if (last !== undefined) {
          const next = nextAttempt(last, attempt);
          if (next === "skip") continue;
          // oxlint-disable-next-line no-await-in-loop
          if (next === "stop" || (!device && (await limitReached(db, ownerId, Date.now())))) {
            break;
          }
        }
        let key: CallerKey;
        let tokenMs = 0;
        if (device) key = { device, index };
        else {
          let credential = credentials.get(attempt.provider);
          if (!credential) {
            const tokenStart = Date.now();
            // oxlint-disable-next-line no-await-in-loop
            const resolved = await resolveModelCredential(env, ownerId, attempt.provider);
            tokenMs = Date.now() - tokenStart;
            if (resolved.status !== "ready")
              return { status: "unavailable", reason: resolved.reason, tokenMs };
            credential = resolved.credential;
            credentials.set(attempt.provider, credential);
          }
          key = { credential };
        }
        // oxlint-disable-next-line no-await-in-loop
        const sent = await sendCall(
          db,
          ownerId,
          call,
          { choice: attempt, caller: key, reservation, dry },
          { startedAt, tokenMs },
        );
        if ("deviceCall" in sent) return { status: "device-call", call: sent.deviceCall };
        if (device) index += 1;
        last = {
          status: "called",
          ...sent,
          timings: last
            ? { ...last.timings, modelMs: last.timings.modelMs + sent.timings.modelMs }
            : sent.timings,
          served: servedModel(attempt),
        };
      }
      return last!;
    };
    // The device's responses take effect only once it has made every call the request needs,
    // so a request it answers in several runs reserves its attempt and logs its calls once.
    if (device) {
      const probe = await run(true);
      if (probe.status !== "called") return probe;
    }
    try {
      // Clef's calls the device made are logged once, as Claude's are, before Claude's.
      if (clefToLog && call.firstChoice && device)
        await sendClefCall(
          db,
          ownerId,
          call,
          call.firstChoice,
          deviceClefRelay(device).model,
          "device",
          reservation,
          startedAt,
        );
      return await run(false);
    } catch (error) {
      // `beforeSend` stopped the request before its first model request was sent.
      if (error instanceof Unsent) return { status: "unavailable", reason: error.reason };
      throw error;
    }
  } finally {
    // Only this request's slot: one it lost after `lockMs` belongs to another request now.
    await db
      .delete(inferenceLocks)
      .where(
        and(
          eq(inferenceLocks.ownerId, ownerId),
          eq(inferenceLocks.slot, held.slot),
          eq(inferenceLocks.lockId, held.lockId),
        ),
      );
  }
}

/**
 * Sends one model call for `runCall`, in its slot, then charges it to the spend stops
 * from reported usage at its model's rates (the worst case when usage is unknown) and logs
 * it. Nothing is reserved before the call (owner, 2026-10-23 11:31 and 12:16 UTC): with at
 * most `concurrentCalls` requests at a time per owner, a stop is overshot by at most the
 * calls running when it was crossed (owner, 2026-10-23 22:05 UTC).
 * `callClaude` keeps the calls running past a client disconnect so each is charged. A
 * request the role refused locally was never sent, so it gets no log row here: its route
 * logs it (ADR 0012).
 */
async function sendCall<T>(
  db: Db,
  ownerId: string,
  call: GenerationCall<T>,
  model: { choice: RoleChoice; caller: CallerKey; reservation: Reservation; dry?: boolean },
  time: { startedAt: number; tokenMs: number },
): Promise<
  | { outcome: InferenceOutcome<T>; logId?: string; timings: GenerationCallTimings }
  | { deviceCall: DeviceModelCall["call"] }
> {
  const { choice, caller, reservation, dry } = model;
  // The periods the call started in, even when it ends on the next UTC day.
  const [month, day] = periods(Date.now());

  let outcome: InferenceOutcome<T>;
  const modelStart = Date.now();
  const relay = "device" in caller ? deviceRelay(caller, dry ? undefined : reservation) : undefined;
  try {
    outcome = await call.invoke(
      providerModel(
        choice,
        "device" in caller ? { apiKey: "device" } : caller.credential,
        "device" in caller ? { fetch: relay!.fetch } : { beforeRequest: reservation.run },
      ),
    );
  } catch {
    // The roles return their errors; this only guards the spend and the log row.
    outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
  }
  // A call the device has not made yet: nothing was written, charged or logged for it.
  if (relay?.next) return { deviceCall: relay.next };
  // The device's own time limit ran out, which the role cannot tell from a failed request.
  if (relay?.timedOut && outcome.status === "failed") outcome = { ...outcome, error: "timeout" };
  if (dry) return { outcome, timings: { preModelMs: 0, tokenMs: 0, modelMs: 0 } };
  // A failed write stopped the request before it was sent, so it fails as before a call.
  await reservation.settled();
  if (reservation.error !== undefined) throw reservation.error;
  // Date.now() advances across I/O on Workers, which is all these spans wait on. The
  // first call's writes count before the model call, as they did before it was sent.
  const reservedMs = reservation.ms;
  reservation.ms = 0;
  const timings = {
    preModelMs: modelStart - time.startedAt + reservedMs,
    tokenMs: time.tokenMs,
    modelMs: Date.now() - modelStart - reservedMs,
  };
  const estimate = estimateModelCostUsd(choice.provider, outcome.usage, choice.rates);
  if (outcome.calls === 0) return { outcome, timings };
  const source = relay ? "device" : "service";
  const micro =
    estimate === undefined
      ? worstCaseMicroUsd(choice) * outcome.calls
      : Math.ceil(estimate * 1_000_000);
  const finished = Date.now();
  // Codes only, for the Worker's own logs; the request log row holds the rest.
  const rejection = outcome.status === "failed" ? outputRejection(outcome) : undefined;
  if (rejection)
    console.info("Model output refused", {
      role: call.role,
      promptVersion: call.promptVersion,
      rejection,
    });
  const logId = newId();
  const { recipeId, branch, baseRevision, page } = call.recipe;
  await db.batch([
    db.insert(inferenceLog).values({
      id: logId,
      ownerId,
      role: call.role,
      provider: choice.provider,
      source,
      modelId: choice.modelId,
      effort: choice.effort,
      speed: choice.speed,
      promptVersion: call.promptVersion,
      origin: call.origin,
      path: call.path,
      request: call.request,
      result: loggedResult(call, outcome),
      answer: outcome.answer ?? null,
      outcome: outcome.status === "failed" ? outcome.error : outcome.status,
      recipeId,
      branch,
      layout: loggedLayout(call.recipe),
      baseRevision,
      recipePage: page ?? null,
      ...pageKindColumns(call.request, outcome.answer),
      build: PATEAT_BUILD_REVISION,
      observationHash: await observationHash(call.request.observation),
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costMicroUsd: micro,
      ...timings,
      // The device's token exchange and model call happen where the service cannot time them.
      ...(relay ? { tokenMs: null, modelMs: null } : {}),
      createdAt: finished,
    }),
    // The spend stops count the owner's credential only (ADR 0040).
    ...(relay
      ? []
      : [
          addSpend(db, ownerId, month, outcome.calls, micro),
          addSpend(db, ownerId, day, outcome.calls, micro),
        ]),
  ]);
  try {
    await purgeExpiredLog(db, finished);
  } catch {
    console.error("Inference log purge failed");
  }
  return { outcome, logId, timings };
}

/**
 * Clef's charge for a call that reported no usage: the input bound at its rate, since
 * Clef charges no output (ADR 0083).
 */
const clefWorstCaseMicroUsd = Math.ceil(
  CLEF_LIMITS.maxInputBytes * clefModels[CLEF_MODEL].inputUsdPerMillion,
);

/**
 * Asks Clef through the Workers AI binding for `runCall` (ADR 0083), in the request's
 * slot, after the request's `beforeSend` writes, then charges its calls to the spend stops
 * at Workers AI's rate and logs them in one row with Clef's answers. Like `sendCall`, a
 * request the role refused before any call gets no row.
 */
async function sendClefCall<T>(
  db: Db,
  ownerId: string,
  call: GenerationCall<T>,
  first: NonNullable<GenerationCall<T>["firstChoice"]>,
  /** Clef through the binding, or the calls the device made (ADR 0040), which it pays. */
  clef: FiniteChoiceModel,
  source: "service" | "device",
  reservation: Reservation,
  startedAt: number,
): Promise<{ outcome: InferenceOutcome<T>; logId?: string; timings: GenerationCallTimings }> {
  const [month, day] = periods(Date.now());
  const modelStart = Date.now();
  const model: FiniteChoiceModel = {
    ...clef,
    doDecide: async (options) => {
      await reservation.run();
      return clef.doDecide(options);
    },
  };
  let outcome: InferenceOutcome<T>;
  try {
    outcome = await first.invoke(model);
  } catch {
    // The role returns its errors; this only guards the spend and the log row.
    outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
  }
  await reservation.settled();
  if (reservation.error !== undefined) throw reservation.error;
  const reservedMs = reservation.ms;
  reservation.ms = 0;
  const timings = {
    preModelMs: modelStart - startedAt + reservedMs,
    tokenMs: 0,
    modelMs: Date.now() - modelStart - reservedMs,
  };
  if (outcome.calls === 0) return { outcome, timings };
  const estimate = estimateClefCostUsd(outcome.usage.inputTokens, CLEF_MODEL);
  const micro =
    estimate === undefined
      ? clefWorstCaseMicroUsd * outcome.calls
      : Math.ceil(estimate * 1_000_000);
  const finished = Date.now();
  const logId = newId();
  const { recipeId, branch, baseRevision, page } = call.recipe;
  const result = loggedResult(call, outcome);
  await db.batch([
    db.insert(inferenceLog).values({
      id: logId,
      ownerId,
      role: call.role,
      provider: "cloudflare",
      source,
      modelId: CLEF_MODEL,
      effort: null,
      speed: null,
      promptVersion: first.promptVersion,
      origin: call.origin,
      path: call.path,
      request: call.request,
      result,
      answer: outcome.answer ?? null,
      outcome: outcome.status === "failed" ? outcome.error : outcome.status,
      recipeId,
      branch,
      layout: loggedLayout(call.recipe),
      baseRevision,
      recipePage: page ?? null,
      // Clef answers a plan's kind and `irreversible` in its value, not as a plan answer.
      ...pageKindColumns(
        call.request,
        outcome.status === "ok" && typeof result === "object" && result !== null
          ? { decision: "plan", ...result }
          : undefined,
      ),
      build: PATEAT_BUILD_REVISION,
      observationHash: await observationHash(call.request.observation),
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costMicroUsd: micro,
      ...timings,
      // The device's calls happen where the service cannot time them.
      ...(source === "device" ? { modelMs: null } : {}),
      createdAt: finished,
    }),
    // The spend stops count the owner's own calls only; a device's token pays its own.
    ...(source === "device"
      ? []
      : [
          addSpend(db, ownerId, month, outcome.calls, micro),
          addSpend(db, ownerId, day, outcome.calls, micro),
        ]),
  ]);
  try {
    await purgeExpiredLog(db, finished);
  } catch {
    console.error("Inference log purge failed");
  }
  return { outcome, logId, timings };
}
