import {
  DEFAULT_MODEL_CONFIG,
  DEVICE_MODEL_URL,
  MAX_ACTIVE_RECIPE_BYTES,
  MAX_ACTIVE_RECIPES,
  deviceModelCallBody,
  deviceModelHeaderNames,
  entryGenerationRequestSchema,
  logoutGenerationRequestSchema,
  recipeCompletionRequestSchema,
  recipeGenerationRequestSchema,
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
  generateEntry,
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
} from "@pateat/generation";
import {
  createClaudeGenerationModel,
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
// holds and its own Anthropic key. Nothing is logged: the request log is the service's.

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
  version: v.literal(1),
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
      verdict: v.nullable(v.picklist(pageJudgementVerdicts)),
      at: timeSchema,
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
  version: 1,
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
  const layouts =
    "layouts" in recipe
      ? recipe.layouts
      : "chooser" in recipe && "layouts" in recipe.chooser
        ? recipe.chooser.layouts
        : [];
  return (layouts as readonly { key: string }[]).map((layout) => layout.key);
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
 * models. Nothing is logged. `forget` drops the record, for when the recipes it describes
 * are replaced or deleted: a recipe made here again starts at revision 1, and must not meet
 * the old revision's judgements.
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
  // One request's model calls at a time, as the service's lock per owner, until every call
  // it sent has ended.
  let calling = false;
  const inFlight = new Set<Promise<unknown>>();

  /** The record; one that does not parse counts as empty, as no older format is kept. */
  async function read(): Promise<DeviceGenerationRecord> {
    const parsed = v.safeParse(recordSchema, await storage.read());
    return parsed.success ? parsed.output : empty();
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
        version: 1,
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

  async function callModel<T>(call: GenerationCall<T>): Promise<GenerationCallResult<T>> {
    if (calling) return { status: "unavailable", reason: "busy" };
    calling = true;
    try {
      const start = now();
      const blocked = await call.gate?.(start);
      if (blocked) return { status: "unavailable", reason: blocked };
      const setting = await key.setting().catch(() => undefined);
      if (!setting) return { status: "unavailable", reason: "credentials-not-configured" };
      // The written record before the first request is sent, once (ADR 0016, ADR 0027).
      // A reason means another request took what `gate` found free: nothing is sent.
      let reserved: Promise<GenerationUnavailableReason | void> | undefined;
      const reserve = () => (reserved ??= call.beforeSend?.(now()) ?? Promise.resolve());
      let timedOut = false;
      // Anthropic's fixed URL only, with the key added by `send`; the request the role built
      // is checked as the paired relay checks a service's, and the checked body is sent.
      const direct: typeof globalThis.fetch = async (input, init) => {
        const outbound = new Request(input, init);
        if (outbound.url !== DEVICE_MODEL_URL || outbound.method !== "POST")
          throw new TypeError("Unexpected model request");
        const headers: DeviceModelCall["call"]["headers"] = {};
        for (const name of deviceModelHeaderNames) {
          const value = outbound.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        const sent = { index: 0, headers, body: await outbound.text() };
        const checked = deviceModelCallBody(sent);
        if (!checked) throw new TypeError("Unexpected model request");
        if (await reserve()) throw new TypeError("The request lost its reservation");
        const sending = key.send(setting.apiKey, sent, checked, outbound.signal);
        inFlight.add(sending);
        try {
          const { response, cost } = await sending;
          // An answer Anthropic charged is kept even when its spend cannot be written; the
          // count keeps it in memory until it can.
          await key.charge(cost).catch(() => undefined);
          return answer(response);
        } finally {
          inFlight.delete(sending);
        }
      };
      const answer = (response: DeviceModelResponse) => {
        if (response.kind === "timeout") timedOut = true;
        if (response.kind !== "response") throw new Error("No model response");
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      };

      let last: Extract<GenerationCallResult<T>, { status: "called" }> | undefined;
      for (const attempt of roleChoices(DEFAULT_MODEL_CONFIG, call.role).flatMap(choiceAttempts)) {
        const next = last === undefined ? "ask" : nextAttempt(last, attempt);
        if (next === "skip") continue;
        if (next === "stop") break;
        // oxlint-disable-next-line no-await-in-loop -- each call follows the one before
        const stop = await key.stopped(setting);
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
            createClaudeGenerationModel({ apiKey: "device", choice: attempt, fetch: direct }),
          );
        } catch {
          outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
        }
        if (timedOut && outcome.status === "failed") outcome = { ...outcome, error: "timeout" };
        // A failed write stopped the request before it was sent, and a reason another
        // request took the reservation.
        // oxlint-disable-next-line no-await-in-loop
        const taken = reserved ? await reserved : undefined;
        if (taken) return { status: "unavailable", reason: taken };
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
      return entry && { verdict: entry.verdict };
    },
    async judgementsSince(recipeId, since) {
      return (await current()).judgements.filter(
        (entry) => entry.recipeId === recipeId && entry.at >= since,
      ).length;
    },
    async recordJudgement(judged, at, stale) {
      let took = false;
      await change((record) => {
        const held = record.judgements.find(sameJudgement(judged));
        took = !held || held.verdict === "partial" || held.verdict === "optional";
        // A `partial` or `optional` verdict takes today's slot again; any other stays.
        const judgements =
          held && held.verdict !== "partial" && held.verdict !== "optional"
            ? record.judgements
            : [
                ...record.judgements.filter((entry) => !sameJudgement(judged)(entry)),
                { ...judged, verdict: null, at },
              ];
        return {
          ...record,
          judgements: judgements.filter(
            (entry) =>
              entry.recipeId !== judged.recipeId ||
              (entry.revision >= judged.revision && stale.versions.includes(entry.promptVersion)) ||
              entry.at >= stale.expired,
          ),
        };
      });
      return took;
    },
    keepVerdict(judged, verdict) {
      return change((record) => ({
        ...record,
        judgements: record.judgements.map((entry) =>
          sameJudgement(judged)(entry) ? { ...entry, verdict } : entry,
        ),
      }));
    },

    call: callModel,
    forget() {
      const next = queue.then(() => storage.clear());
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

type Requests = Pick<
  ServiceTransport,
  "generateRecipe" | "generateEntry" | "generateLogout" | "judgeCompletion"
>;

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
        const parsed = v.safeParse(recipeCompletionRequestSchema, request);
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
