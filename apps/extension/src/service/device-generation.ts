import {
  ssoGenerationRequestSchema,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_OPENAI_MODEL_CONFIG,
  OPENAI_DEVICE_MODEL_URL,
  deviceOpenAIModelCallBody,
  DEVICE_MODEL_URL,
  MAX_ACTIVE_RECIPE_BYTES,
  MAX_ACTIVE_RECIPES,
  deviceModelCallBody,
  deviceModelHeaderNames,
  entryGenerationRequestSchema,
  logoutGenerationRequestSchema,
  completionRequestSchema,
  recipeGenerationRequestSchema,
  storedLayouts,
  syncRecipeIdSchema,
  type DeviceModelCall,
  type DeviceModelResponse,
  type GenerationUnavailableReason,
  type SavedLoginBinding,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  choiceAttempts,
  JUDGEMENT_RESERVATION_MS,
  JUDGEMENTS_PER_RECIPE_DAY,
  utcDayStart,
  CLEF_MODEL,
  generateEntry,
  generateSso,
  generateRecipe,
  generateLogout,
  judgeCompletion,
  nextAttempt,
  pageJudgementVerdicts,
  roleChoices,
  servedModel,
  type GenerationBackend,
  type GenerationCall,
  type GenerationCallResult,
  type JudgementKey,
  type JudgementReservation,
  type JudgementReservationResult,
  type JudgementReservationState,
} from "@pateat/generation";
import {
  clefUrl,
  createClaudeGenerationModel,
  createOpenAIGenerationModel,
  createClefDecisionModel,
  unknownUsage,
  type InferenceOutcome,
} from "@pateat/inference";
import * as v from "valibot";
import type { createDeviceModel } from "./device-model";
import type { createDeviceRecipes } from "./device-recipes";
import type { ServiceConnection } from "./runtime";
import type { InferenceResult, ServiceTransport } from "./transport";

// Generation on a device without a pairing (ADR 0040, owner 2026-10-23 21:11 UTC): the
// service's own generation and judge routes run here, against the recipes this device
// holds and its own text-model key. Nothing is logged: the request log is the service's.

export const DEVICE_GENERATION_KEY = "pateat.device-generation.v1";
/**
 * The origin of the connection generation runs under on a device without a pairing: no
 * service has it, so its requests stay on this device.
 */
export const DEVICE_GENERATION_ORIGIN = "pateat-device:";
/** Entries of each list the record keeps at once; the oldest go first. */
export const MAX_DEVICE_GENERATION_ENTRIES = 2_000;

const textSchema = v.pipe(v.string(), v.maxLength(2048));
const revisionSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const timeSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const judgementKey = {
  recipeId: syncRecipeIdSchema,
  branch: textSchema,
  revision: revisionSchema,
  origin: textSchema,
  path: textSchema,
  promptVersion: textSchema,
};
/**
 * What the service keeps in its tables for the generation routes' limits (ADR 0016, ADR
 * 0027, ADR 0041, ADR 0060), kept here for this device's own requests.
 */
const recordSchema = v.strictObject({
  version: v.literal(2),
  cutoverDay: v.nullable(timeSchema),
  attempts: v.array(
    v.strictObject({
      recipeId: syncRecipeIdSchema,
      branch: textSchema,
      origin: textSchema,
      path: textSchema,
      baseRevision: revisionSchema,
      at: timeSchema,
    }),
  ),
  repairs: v.array(
    v.strictObject({ recipeId: syncRecipeIdSchema, revision: revisionSchema, at: timeSchema }),
  ),
  judgements: v.array(
    v.strictObject({
      ...judgementKey,
      claimId: v.nullable(textSchema),
      verdict: v.nullable(v.picklist(pageJudgementVerdicts)),
      // The digest of the judged description's inputs (ADR 0029 amendment of 2026-11-06).
      inputs: v.nullable(textSchema),
      at: timeSchema,
    }),
  ),
  quotas: v.array(
    v.strictObject({
      ...judgementKey,
      id: textSchema,
      startedAt: timeSchema,
      fingerprint: textSchema,
      day: timeSchema,
      state: v.picklist(["active", "finished", "cancelled"]),
      issuedCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
      responseHash: v.nullable(textSchema),
      processing: v.boolean(),
      previous: v.nullable(
        v.strictObject({
          at: timeSchema,
          verdict: v.nullable(v.picklist(pageJudgementVerdicts)),
          inputs: v.nullable(textSchema),
        }),
      ),
    }),
  ),
  layoutUses: v.array(
    v.strictObject({ recipeId: syncRecipeIdSchema, layout: textSchema, at: timeSchema }),
  ),
});
type DeviceGenerationRecord = v.InferOutput<typeof recordSchema>;

export interface DeviceGenerationStorage {
  read(): Promise<unknown>;
  write(record: DeviceGenerationRecord): Promise<void>;
  clear(): Promise<void>;
}

const empty = (): DeviceGenerationRecord => ({
  version: 2,
  cutoverDay: null,
  quotas: [],
  attempts: [],
  repairs: [],
  judgements: [],
  layoutUses: [],
});
const sameJudgement = (key: JudgementKey) => (entry: JudgementKey) =>
  entry.recipeId === key.recipeId &&
  entry.branch === key.branch &&
  entry.revision === key.revision &&
  entry.origin === key.origin &&
  entry.path === key.path &&
  entry.promptVersion === key.promptVersion;

/** The layout keys a recipe holds, of its own layouts or its chooser's (ADR 0060). */
function layoutKeysOf(recipe: StoredLoginRecipe): string[] {
  return storedLayouts(recipe).map((layout) => layout.key);
}

const activeChange = (recipe: StoredLoginRecipe): SyncRecipeChange => ({
  recipeId: recipe.id,
  revision: recipe.revision,
  state: "active",
  recipe,
});

type DeviceRecipes = Pick<ReturnType<typeof createDeviceRecipes>, "head" | "usage" | "write">;
type DeviceKey = ReturnType<typeof createDeviceModel>["direct"];

/**
 * The generation routes' backend on this device (ADR 0040): its recipes, its own record of
 * the routes' limits, the bindings of its settings, and its key's calls with the default
 * models. Nothing is logged. Forgetting drops cached decisions when recipes are replaced
 * or deleted: a recipe made again starts at revision 1, and must not meet an old answer.
 * Daily quota survives that cache reset, so recreating the same ID cannot reset usage.
 */
export function createDeviceGenerationBackend(options: {
  recipes: DeviceRecipes;
  storage: DeviceGenerationStorage;
  key: DeviceKey;
  bindings: () => Promise<readonly SavedLoginBinding[]>;
  /** Whether a service is paired now: a write that lands after a pairing is refused. */
  paired: () => Promise<boolean>;
  now?: () => number;
}): GenerationBackend & { forget(): Promise<void> } {
  const { recipes, storage, key } = options;
  const now = options.now ?? Date.now;
  // One change at a time, so two pages' requests both keep theirs.
  let queue: Promise<unknown> = Promise.resolve();
  // One request's model calls at a time on this device, until every call it sent has
  // ended; the service runs up to five of an owner's at once (ADR 0018).
  let calling = false;
  const inFlight = new Set<Promise<unknown>>();

  /** The record; one that does not parse counts as empty, as no older format is kept. */
  async function read(): Promise<DeviceGenerationRecord> {
    const raw = await storage.read();
    const parsed = v.safeParse(recordSchema, raw);
    // Old overwritten cache rows cannot reconstruct today's actual usage. A nonempty,
    // unreadable record conservatively closes this day's quota instead of resetting it.
    return parsed.success
      ? parsed.output
      : { ...empty(), cutoverDay: raw === undefined ? null : utcDayStart(now()) };
  }
  async function current() {
    await queue;
    return read();
  }
  async function change(
    apply: (record: DeviceGenerationRecord) => DeviceGenerationRecord,
  ): Promise<void> {
    const next = queue.then(async () => {
      const changed = apply(await read());
      const last = <T>(entries: T[]) => entries.slice(-MAX_DEVICE_GENERATION_ENTRIES);
      await storage.write({
        version: 2,
        cutoverDay: changed.cutoverDay,
        // Quota is independent of the cache's 2,000-entry bound. Keep yesterday for a
        // bounded operation that spans midnight; never evict a live quota for capacity.
        quotas: changed.quotas.filter((entry) => entry.day >= utcDayStart(now()) - 86_400_000),
        attempts: last(changed.attempts),
        repairs: last(changed.repairs),
        judgements: last(changed.judgements),
        layoutUses: last(changed.layoutUses),
      });
      return true;
    });
    queue = next.catch(() => undefined);
    await next;
  }

  function matchesOperation(
    entry: DeviceGenerationRecord["quotas"][number],
    judged: JudgementKey,
    operation: JudgementReservation,
  ) {
    return (
      sameJudgement(judged)(entry) &&
      entry.id === operation.id &&
      entry.startedAt === operation.startedAt &&
      entry.fingerprint === operation.fingerprint
    );
  }
  function reservationState(
    record: DeviceGenerationRecord,
    judged: JudgementKey,
    operation: JudgementReservation,
    at: number,
  ): JudgementReservationState {
    if (operation.startedAt > at || at - operation.startedAt >= JUDGEMENT_RESERVATION_MS)
      return { status: "invalid" };
    const heldOperation = record.quotas.find((entry) => entry.id === operation.id);
    if (!heldOperation) return { status: "missing" };
    if (
      !matchesOperation(heldOperation, judged, operation) ||
      heldOperation.state !== "active" ||
      record.judgements.find(sameJudgement(judged))?.claimId !== operation.id
    )
      return { status: "invalid" };
    return {
      status: "active",
      previous: heldOperation.previous
        ? {
            verdict: heldOperation.previous.verdict,
            inputs: heldOperation.previous.inputs,
          }
        : undefined,
    };
  }

  async function callModel<T>(call: GenerationCall<T>): Promise<GenerationCallResult<T>> {
    if (calling) return { status: "unavailable", reason: "busy" };
    calling = true;
    try {
      const start = now();
      const blocked = await call.gate?.(start);
      if (blocked) return { status: "unavailable", reason: blocked };
      let setting;
      try {
        setting = await key.setting();
      } catch {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      if (!setting) return { status: "unavailable", reason: "credentials-not-configured" };
      // The written record before the first request is sent, once (ADR 0016, ADR 0027).
      let reserved: Promise<GenerationUnavailableReason | void> | undefined;
      const reserve = () => (reserved ??= call.beforeSend?.(now()) ?? Promise.resolve());
      let timedOut = false;
      // The selected provider's fixed URL only, with the key added by `send`; the request the role built
      // is checked as the paired relay checks a service's, and the checked body is sent.
      const direct: typeof globalThis.fetch = async (input, init) => {
        const outbound = new Request(input, init);
        if (
          outbound.url !==
            (setting.provider === "openai" ? OPENAI_DEVICE_MODEL_URL : DEVICE_MODEL_URL) ||
          outbound.method !== "POST"
        )
          throw new TypeError("Unexpected model request");
        const headers: DeviceModelCall["call"]["headers"] = {};
        for (const name of setting.provider === "openai"
          ? (["content-type"] as const)
          : deviceModelHeaderNames) {
          const value = outbound.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        const sent = {
          provider: setting.provider,
          index: 0,
          headers,
          body: await outbound.text(),
        };
        const checked =
          setting.provider === "openai"
            ? deviceOpenAIModelCallBody(sent)
            : deviceModelCallBody(sent);
        if (!checked) throw new TypeError("Unexpected model request");
        // A reason stops the request unsent (ADR 0018); the loop below answers with it.
        if (await reserve()) throw new Error("Model call not sent");
        const sending = key.send(setting.apiKey, sent, checked, outbound.signal);
        inFlight.add(sending);
        try {
          const { response, cost } = await sending;
          // An answer the provider charged is kept even when its spend cannot be written; the
          // count keeps it in memory until it can.
          await key.charge(cost).catch(() => undefined);
          return answer(response);
        } finally {
          inFlight.delete(sending);
        }
      };
      // Clef answers first where it can (ADR 0083), with this device's Cloudflare token.
      const clef = call.firstChoice && (await key.clefSetting().catch(() => undefined));
      if (call.firstChoice && clef) {
        const stop = await key.stopped();
        if (stop) return { status: "unavailable", reason: stop };
        const url = clefUrl(clef.accountId, CLEF_MODEL);
        // The account's Clef URL only, with the token added by `sendClef`.
        const toClef: typeof globalThis.fetch = async (input, init) => {
          const outbound = new Request(input, init);
          if (outbound.url !== url || outbound.method !== "POST")
            throw new TypeError("Unexpected model request");
          const body = await outbound.text();
          if (await reserve()) throw new Error("Model call not sent");
          const sending = key.sendClef(clef, body, outbound.signal);
          inFlight.add(sending);
          try {
            const { response, cost } = await sending;
            await key.charge(cost).catch(() => undefined);
            if (response.kind !== "response") throw new Error("No model response");
            return new Response(response.body, {
              status: response.status,
              headers: { "content-type": "application/json" },
            });
          } finally {
            inFlight.delete(sending);
          }
        };
        const modelStart = now();
        let outcome: InferenceOutcome<T>;
        try {
          outcome = await call.firstChoice.invoke(
            // The token goes with `sendClef` only; the adapter's own header is dropped.
            createClefDecisionModel({
              accountId: clef.accountId,
              apiToken: "device",
              modelId: CLEF_MODEL,
              fetch: toClef,
            }),
          );
        } catch {
          outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
        }
        const refused = reserved && (await reserved);
        if (refused) return { status: "unavailable", reason: refused };
        if (outcome.status === "ok")
          return {
            status: "called",
            outcome,
            timings: { preModelMs: modelStart - start, tokenMs: 0, modelMs: now() - modelStart },
            served: { provider: "cloudflare", model: CLEF_MODEL },
            promptVersion: call.firstChoice.promptVersion,
          };
        // Otherwise the text model answers, its time before the model counting Clef's.
      }

      const answer = (response: DeviceModelResponse) => {
        if (response.kind === "timeout") timedOut = true;
        if (response.kind !== "response") throw new Error("No model response");
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      };

      let last: Extract<GenerationCallResult<T>, { status: "called" }> | undefined;
      const defaults =
        setting.provider === "openai" ? DEFAULT_OPENAI_MODEL_CONFIG : DEFAULT_MODEL_CONFIG;
      for (const attempt of roleChoices(defaults, call.role).flatMap(choiceAttempts)) {
        const next = last === undefined ? "ask" : nextAttempt(last, attempt);
        if (next === "skip") continue;
        if (next === "stop") break;
        // oxlint-disable-next-line no-await-in-loop -- each call follows the one before
        const stop = await key.stopped();
        if (stop) {
          if (last === undefined) return { status: "unavailable", reason: stop };
          break;
        }
        timedOut = false;
        const modelStart = now();
        let outcome: InferenceOutcome<T>;
        try {
          // oxlint-disable-next-line no-await-in-loop
          outcome = await call.invoke(
            // The key goes with `send` only; the provider's own header is dropped.
            attempt.provider === "openai"
              ? createOpenAIGenerationModel({ apiKey: "device", choice: attempt, fetch: direct })
              : createClaudeGenerationModel({ apiKey: "device", choice: attempt, fetch: direct }),
          );
        } catch {
          outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
        }
        if (timedOut && outcome.status === "failed") outcome = { ...outcome, error: "timeout" };
        // A failed write, or a reason, stopped the request before it was sent.
        // oxlint-disable-next-line no-await-in-loop
        const refused = reserved && (await reserved);
        if (refused) return { status: "unavailable", reason: refused };
        const modelMs = now() - modelStart;
        last = {
          status: "called",
          outcome,
          timings: last
            ? { ...last.timings, modelMs: last.timings.modelMs + modelMs }
            : { preModelMs: modelStart - start, tokenMs: 0, modelMs },
          served: servedModel(attempt),
        };
      }
      return last ?? { status: "unavailable", reason: "credentials-not-configured" };
    } finally {
      // A call the role stopped waiting for is cancelled; the next request waits for it.
      await Promise.allSettled(inFlight);
      calling = false;
    }
  }

  return {
    // The one device a repair's limit and each write name here.
    deviceId: "device",
    async readHead(recipeId) {
      const recipe = await recipes.head(recipeId);
      return recipe ? activeChange(recipe) : null;
    },
    // Only the head is kept here.
    async readRevision(recipeId, revision) {
      const recipe = await recipes.head(recipeId);
      return recipe?.revision === revision ? activeChange(recipe) : null;
    },
    hasRecipeRoom: async () => (await recipes.usage()).count < MAX_ACTIVE_RECIPES,
    hasRecipeByteRoom: async (bytes) =>
      (await recipes.usage()).bytes + bytes <= MAX_ACTIVE_RECIPE_BYTES,
    async bindingSlots(origin, recipeId) {
      return (await options.bindings()).flatMap((binding) =>
        binding.origin === origin && binding.recipeId === recipeId
          ? [{ slots: binding.slots }]
          : [],
      );
    },
    async layoutUses(recipeId) {
      const uses = (await current()).layoutUses.filter((use) => use.recipeId === recipeId);
      return uses.length ? new Map(uses.map((use) => [use.layout, use.at])) : undefined;
    },
    async markLayoutUsed(recipeId, layout) {
      const recipe = await recipes.head(recipeId);
      if (!recipe || !layoutKeysOf(recipe).includes(layout)) return;
      const at = now();
      await change((record) => ({
        ...record,
        layoutUses: [
          ...record.layoutUses.filter((use) => use.recipeId !== recipeId || use.layout !== layout),
          { recipeId, layout, at },
        ],
      }));
    },
    async writeRecipe(recipeId, write) {
      const written = await recipes.write(recipeId, write, async () => !(await options.paired()));
      if (!written.ok)
        return written.limited
          ? written
          : {
              ok: false,
              limited: false,
              current: written.current ? activeChange(written.current) : null,
            };
      // The last use of a layout the written recipe no longer has goes with it (ADR 0060).
      const kept = written.recipe ? layoutKeysOf(written.recipe) : [];
      await change((record) => ({
        ...record,
        layoutUses: record.layoutUses.filter(
          (use) => use.recipeId !== recipeId || kept.includes(use.layout),
        ),
      })).catch(() => undefined);
      return {
        ok: true,
        change: written.recipe
          ? activeChange(written.recipe)
          : { recipeId, revision: write.expectedRevision + 1, state: "revoked" },
      };
    },

    async attemptedSince(attempt, since) {
      return (await current()).attempts.some(
        (entry) =>
          entry.recipeId === attempt.recipeId &&
          entry.branch === attempt.branch &&
          entry.path === attempt.path &&
          entry.baseRevision === attempt.baseRevision &&
          entry.at > since,
      );
    },
    recordAttempt(attempt, at, expired) {
      const same = (entry: DeviceGenerationRecord["attempts"][number]) =>
        entry.recipeId === attempt.recipeId &&
        entry.branch === attempt.branch &&
        entry.path === attempt.path &&
        entry.baseRevision === attempt.baseRevision;
      return change((record) => ({
        ...record,
        attempts: [
          ...record.attempts.filter((entry) => !same(entry) && entry.at >= expired),
          { ...attempt, at },
        ],
      }));
    },
    async repairedSince(recipeId, since) {
      return (await current()).repairs.some(
        (entry) => entry.recipeId === recipeId && entry.at >= since,
      );
    },
    recordRepair(recipeId, baseRevision, at, expired) {
      return change((record) => ({
        ...record,
        repairs: [
          ...record.repairs.filter((entry) => entry.recipeId !== recipeId && entry.at >= expired),
          { recipeId, revision: baseRevision, at },
        ],
      }));
    },
    async judgement(judged) {
      const entry = (await current()).judgements.find(sameJudgement(judged));
      return entry && { verdict: entry.verdict, inputs: entry.inputs };
    },
    async judgementReservation(judged, operation, at) {
      return reservationState(await current(), judged, operation, at);
    },
    async reserveJudgement(judged, at, stale, inputs, operation) {
      let result: JudgementReservationResult = { status: "held" };
      await change((record) => {
        const held = reservationState(record, judged, operation, at);
        if (held.status === "active") {
          result = { status: "resumed", previous: held.previous };
          return record;
        }
        if (held.status === "invalid") return record;
        const day = utcDayStart(at);
        const previous = record.judgements.find(sameJudgement(judged));
        if (
          previous &&
          previous.verdict !== "partial" &&
          previous.verdict !== "optional" &&
          !(
            (previous.verdict === "challenge" || previous.verdict === "unclear") &&
            previous.inputs !== inputs
          )
        )
          return record;
        if (
          record.cutoverDay === day ||
          record.quotas.filter(
            (entry) =>
              entry.recipeId === judged.recipeId &&
              entry.day === day &&
              entry.state !== "cancelled",
          ).length >= JUDGEMENTS_PER_RECIPE_DAY
        ) {
          result = { status: "limited" };
          return record;
        }
        result = {
          status: "taken",
          previous: previous && { verdict: previous.verdict, inputs: previous.inputs },
        };
        return {
          ...record,
          quotas: [
            ...record.quotas,
            {
              ...judged,
              ...operation,
              day,
              state: "active",
              issuedCount: 0,
              responseHash: null,
              processing: true,
              previous: previous
                ? { at: previous.at, verdict: previous.verdict, inputs: previous.inputs }
                : null,
            },
          ],
          judgements: [
            ...record.judgements.filter(
              (entry) =>
                !sameJudgement(judged)(entry) &&
                (entry.recipeId !== judged.recipeId ||
                  (entry.revision >= judged.revision &&
                    stale.versions.includes(entry.promptVersion)) ||
                  entry.at >= stale.expired),
            ),
            { ...judged, claimId: operation.id, verdict: null, inputs, at },
          ],
        };
      });
      return result;
    },
    async continueJudgement(judged, operation, responseHashes, at) {
      let admitted = false;
      await change((record) => {
        if (reservationState(record, judged, operation, at).status !== "active") return record;
        return {
          ...record,
          quotas: record.quotas.map((entry) => {
            if (
              entry.id !== operation.id ||
              entry.processing ||
              responseHashes.length === 0 ||
              entry.issuedCount !== responseHashes.length ||
              entry.responseHash !== responseHashes.at(-1)
            )
              return entry;
            admitted = true;
            return { ...entry, processing: true };
          }),
        };
      });
      return admitted;
    },
    async dispatchJudgement(judged, operation, call) {
      let dispatched = false;
      await change((record) => ({
        ...record,
        quotas: record.quotas.map((entry) => {
          if (
            !matchesOperation(entry, judged, operation) ||
            entry.state !== "active" ||
            !entry.processing ||
            entry.issuedCount !== call.index
          )
            return entry;
          dispatched = true;
          return {
            ...entry,
            processing: false,
            issuedCount: call.index + 1,
            responseHash: call.hash,
          };
        }),
      }));
      return dispatched;
    },
    finishJudgement(judged, operation) {
      return change((record) => ({
        ...record,
        quotas: record.quotas.map((entry) =>
          matchesOperation(entry, judged, operation) && entry.state === "active"
            ? { ...entry, state: "finished" }
            : entry,
        ),
      }));
    },
    async cancelJudgement(judged, operation) {
      let cancelled = false;
      await change((record) => {
        const heldOperation = record.quotas.find((entry) =>
          matchesOperation(entry, judged, operation),
        );
        if (!heldOperation || heldOperation.state !== "active") return record;
        cancelled = true;
        const judgements = record.judgements.filter(
          (row) => !(sameJudgement(judged)(row) && row.claimId === operation.id),
        );
        if (heldOperation.previous)
          judgements.push({ ...judged, ...heldOperation.previous, claimId: null });
        return {
          ...record,
          judgements,
          quotas: record.quotas.map((row) =>
            row === heldOperation
              ? { ...row, state: row.issuedCount === 0 ? "cancelled" : "finished" }
              : row,
          ),
        };
      });
      return cancelled;
    },
    keepVerdict(judged, verdict, claimId, inputs) {
      return change((record) => ({
        ...record,
        judgements: record.judgements.map((entry) =>
          sameJudgement(judged)(entry) && entry.claimId === claimId
            ? { ...entry, verdict, ...(inputs === undefined ? {} : { inputs }) }
            : entry,
        ),
      }));
    },

    call: callModel,
    forget() {
      const next = queue.then(async () => {
        const record = await read();
        return storage.write({ ...empty(), quotas: record.quotas, cutoverDay: record.cutoverDay });
      });
      queue = next.catch(() => undefined);
      return next;
    },
    // The request log is the service's; a device without a pairing keeps none (owner,
    // 2026-10-23).
    logUnsent: async () => {},
    keepLogRevision: async () => {},
    logPageSample: async () => false,
  };
}

type Requests = import("./transport").SsoTransport &
  Pick<ServiceTransport, "generateRecipe" | "generateEntry" | "generateLogout" | "judgeCompletion">;

/**
 * The generation routes' answers for this device's own requests, as the transport gives
 * the service's: a request the routes refuse, or an error, as an unexpected response.
 */
export function createDeviceGeneration(backend: GenerationBackend): Requests {
  async function run<T>(work: () => Promise<T | undefined | null>): Promise<InferenceResult<T>> {
    const sent = Date.now();
    const timing = () => ({ timing: { roundTripMs: Date.now() - sent } });
    try {
      const result = await work();
      return result
        ? { kind: "result", result, ...timing() }
        : { kind: "failed", error: "unexpected-response", ...timing() };
    } catch {
      return { kind: "failed", error: "unexpected-response", ...timing() };
    }
  }
  return {
    generateSso: (_origin, _credential, request) =>
      run(async () => {
        const parsed = v.safeParse(ssoGenerationRequestSchema, request);
        return parsed.success ? generateSso(backend, parsed.output) : undefined;
      }),
    generateRecipe: (_origin, _credential, request) =>
      run(async () => {
        const parsed = v.safeParse(recipeGenerationRequestSchema, request);
        return parsed.success ? generateRecipe(backend, parsed.output) : undefined;
      }),
    generateEntry: (_origin, _credential, request) =>
      run(async () => {
        const parsed = v.safeParse(entryGenerationRequestSchema, request);
        return parsed.success ? generateEntry(backend, parsed.output) : undefined;
      }),
    generateLogout: (_origin, _credential, request) =>
      run(async () => {
        const parsed = v.safeParse(logoutGenerationRequestSchema, request);
        return parsed.success ? generateLogout(backend, parsed.output) : undefined;
      }),
    judgeCompletion: (_origin, _credential, recipeId, request) =>
      run(async () => {
        const parsed = v.safeParse(completionRequestSchema, request);
        return parsed.success ? judgeCompletion(backend, recipeId, parsed.output) : undefined;
      }),
  };
}

/**
 * The connection generation uses: the paired service's, or without a pairing this device's
 * own while a key is saved (ADR 0040).
 */
export async function generationConnection(
  paired: () => Promise<ServiceConnection | undefined>,
  hasKey: () => Promise<boolean>,
): Promise<ServiceConnection | undefined> {
  const connection = await paired();
  if (connection) return connection;
  return (await hasKey())
    ? {
        origin: DEVICE_GENERATION_ORIGIN,
        deviceId: DEVICE_GENERATION_ORIGIN,
        credential: "",
        rejected: false,
      }
    : undefined;
}
