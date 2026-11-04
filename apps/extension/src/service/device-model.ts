import {
  DEVICE_MODEL_TIMEOUT_MS,
  DEVICE_MODEL_URL,
  deviceModelHeaderNames,
  deviceModelRequestHash,
  deviceModelCallBody,
  MAX_DEVICE_MODEL_CALLS,
  MAX_DEVICE_MODEL_OUTPUT_TOKENS,
  MAX_DEVICE_MODEL_RESPONSE_BYTES,
  type DeviceModel,
  type DeviceModelCall,
  type DeviceModelResponse,
  type GenerationUnavailableReason,
  modelSpendLimitsSchema,
  type LocalSettings,
} from "@pateat/contracts";
import {
  claudeModelRates,
  claudePricing,
  estimateClaudeCost,
  type ClaudeRates,
} from "@pateat/inference/claude-rates";
import { clefModels, clefUrl, estimateClefCostUsd } from "@pateat/inference/clef-models";
import * as v from "valibot";
import type { InferenceResult, ServiceTiming, ServiceTransport } from "./transport";

// A paired device's own Anthropic API key (ADR 0040): with one saved, this device makes the
// model calls of the service's generation and judge routes itself, and the service only
// keeps the recipes and settings it shares. The key stays in this device's trusted
// `storage.local`, and is sent to Anthropic only, never to the service.

export const DEVICE_MODEL_KEY = "pateat.device-model.v1";
export const DEVICE_MODEL_SPEND_KEY = "pateat.device-model-spend.v1";
/** The spend stops of a profile that set none, as the service's own (owner, 2026-10-23 12:49 UTC). */
export const DEFAULT_DEVICE_DAILY_LIMIT_USD = 5;
export const DEFAULT_DEVICE_MONTHLY_LIMIT_USD = 100;

/** The profile's spend limits in US dollars, or the defaults when it set none. */
export function spendLimits(settings: Pick<LocalSettings, "modelSpendLimits">): {
  dailyUsd: number;
  monthlyUsd: number;
} {
  return (
    settings.modelSpendLimits ?? {
      dailyUsd: DEFAULT_DEVICE_DAILY_LIMIT_USD,
      monthlyUsd: DEFAULT_DEVICE_MONTHLY_LIMIT_USD,
    }
  );
}

/**
 * The spend limits from a stored setting, unvalidated: the defaults when absent. A value
 * that does not parse throws, so no call is made against limits that cannot be read.
 */
export function parseSpendLimits(stored: unknown): { dailyUsd: number; monthlyUsd: number } {
  if (stored === undefined) return spendLimits({});
  return v.parse(modelSpendLimitsSchema, stored);
}
export { MAX_DEVICE_LIMIT_USD } from "@pateat/contracts";
/** An Anthropic API key as pasted: printable ASCII without spaces. */
export const deviceModelKeySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(8),
  v.maxLength(256),
  v.regex(/^[\x21-\x7e]+$/u),
);
/**
 * The saved key. Its spend limits are the synced profile setting `modelSpendLimits`
 * (ADR 0024); a record from before that still holds its old limits, which are dropped.
 */
export const deviceModelSettingSchema = v.object({
  version: v.literal(1),
  apiKey: deviceModelKeySchema,
});
export type DeviceModelSetting = v.InferOutput<typeof deviceModelSettingSchema>;

/**
 * This device's Cloudflare account and API token for Clef (ADR 0083): with them and an
 * Anthropic key saved, a device without a pairing asks Clef first for a sign-in form. Kept
 * like the key, on this device only.
 */
export const DEVICE_CLEF_KEY = "pateat.device-clef.v1";
/** A Cloudflare account ID as pasted: 32 hexadecimal characters. */
export const deviceClefAccountSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.regex(/^[0-9a-f]{32}$/u),
);
export const deviceClefSettingSchema = v.object({
  version: v.literal(1),
  accountId: deviceClefAccountSchema,
  apiToken: deviceModelKeySchema,
});
export type DeviceClefSetting = v.InferOutput<typeof deviceClefSettingSchema>;
/** The saved account and token; none when nothing is saved or the record cannot be read. */
export function parseDeviceClefSetting(stored: unknown): DeviceClefSetting | undefined {
  const parsed = v.safeParse(deviceClefSettingSchema, stored);
  return parsed.success ? parsed.output : undefined;
}
/** The one Clef model a device asks, as the service does (ADR 0083). */
const CLEF_MODEL = "clef";
/** What a Clef call answered: Workers AI's status and body, or no answer. */
export type DeviceClefResponse =
  | { kind: "response"; status: number; body: string }
  | { kind: "timeout" }
  | { kind: "unreachable" };

/**
 * What a Clef call cost, from the input tokens Workers AI reported at Clef's published
 * rate (Clef charges no output); its whole context when usage is missing, as after a
 * timeout, and nothing for a call that never reached Cloudflare or that it refused.
 */
export function clefCallCostMicroUsd(response: DeviceClefResponse): number {
  const worst = Math.ceil(
    clefModels[CLEF_MODEL].contextTokens * clefModels[CLEF_MODEL].inputUsdPerMillion,
  );
  if (response.kind === "unreachable") return 0;
  if (response.kind === "timeout") return worst;
  let tokens: unknown;
  try {
    tokens = (JSON.parse(response.body) as { result?: { usage?: { input_tokens?: unknown } } })
      .result?.usage?.input_tokens;
  } catch {
    // Not JSON: no answer was given, so nothing was charged.
  }
  if (typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0)
    return Math.ceil((estimateClefCostUsd(tokens, CLEF_MODEL) ?? 0) * 1_000_000);
  return response.status < 300 ? worst : 0;
}

const microUsd = v.pipe(v.number(), v.integer(), v.minValue(0));
/** What this device's key spent in the current UTC day and month, as estimated here. */
const spendSchema = v.strictObject({
  version: v.literal(1),
  day: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/u)),
  dayMicroUsd: microUsd,
  month: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}$/u)),
  monthMicroUsd: microUsd,
});
export type DeviceModelSpend = v.InferOutput<typeof spendSchema>;

export interface DeviceModelStorage {
  read(): Promise<unknown>;
  write(value: DeviceModelSetting): Promise<void>;
  clear(): Promise<void>;
}
export interface DeviceModelSpendStorage {
  read(): Promise<unknown>;
  write(value: DeviceModelSpend): Promise<void>;
}

/** The saved key and stops; none when nothing is saved or the record cannot be read. */
export function parseDeviceModelSetting(stored: unknown): DeviceModelSetting | undefined {
  const parsed = v.safeParse(deviceModelSettingSchema, stored);
  return parsed.success ? parsed.output : undefined;
}

const periods = (now: number) => {
  const day = new Date(now).toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
};

/** The spend of the current day and month; an earlier period's counts as nothing. */
export function currentSpend(stored: unknown, now: number) {
  const parsed = v.safeParse(spendSchema, stored);
  const { day, month } = periods(now);
  return {
    dayMicroUsd: parsed.success && parsed.output.day === day ? parsed.output.dayMicroUsd : 0,
    monthMicroUsd:
      parsed.success && parsed.output.month === month ? parsed.output.monthMicroUsd : 0,
  };
}

/** The highest rates the pricing page lists, for a model it does not price. */
const highestRates = (): ClaudeRates => {
  const all = Object.values(claudePricing.models);
  return {
    input: Math.max(...all.map((rates) => rates.input)),
    output: Math.max(...all.map((rates) => rates.output)),
  };
};
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
/**
 * A call's largest prompt and answer: the service bounds a prompt at 64 KiB
 * (`ROLE_LIMITS`), and a token is at least a byte, so a longer body counts its bytes.
 */
const worstCaseUsage = (body: string) => ({
  inputTokens: Math.max(64 * 1024, byteLength(body)),
  outputTokens: MAX_DEVICE_MODEL_OUTPUT_TOKENS,
});

/**
 * What a call cost, from the usage Anthropic reported at its model's published rates; the
 * worst case when usage is missing, as after a timeout, and nothing for a call that never
 * reached Anthropic or that it refused with an error before answering.
 */
export function callCostMicroUsd(body: string, response: DeviceModelResponse): number {
  if (response.kind === "unreachable") return 0;
  let model: unknown;
  let fast = false;
  try {
    const sent = JSON.parse(body) as { model?: unknown; speed?: unknown };
    model = sent.model;
    fast = sent.speed === "fast";
  } catch {
    // The service built the body; an unreadable one is charged at the highest rates.
  }
  const rates =
    (typeof model === "string" ? claudeModelRates(model, fast ? "fast" : "standard") : undefined) ??
    highestRates();
  let usage = response.kind === "timeout" ? worstCaseUsage(body) : undefined;
  if (response.kind === "response") {
    try {
      const reported = (
        JSON.parse(response.body) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }
      ).usage;
      if (typeof reported?.input_tokens === "number" && typeof reported.output_tokens === "number")
        usage = { inputTokens: reported.input_tokens, outputTokens: reported.output_tokens };
    } catch {
      // Not JSON: no answer was given, so nothing was charged.
    }
    if (!usage && response.status < 300) usage = worstCaseUsage(body);
  }
  if (!usage) return 0;
  return Math.ceil((estimateClaudeCost(usage, rates) ?? 0) * 1_000_000);
}

type DeviceModelRequests = Pick<
  ServiceTransport,
  "generateRecipe" | "generateEntry" | "generateLogout" | "judgeCompletion"
>;
const timed = ({ timing }: { timing?: ServiceTiming }) => (timing ? { timing } : {});
/** Every answer of the four routes can say the service did not call the model. */
type Unavailable = { version: 1; status: "unavailable"; reason: GenerationUnavailableReason };

/**
 * The service's generation, logout (ADR 0063) and judge requests, made with this device's key when one is
 * saved (ADR 0040): each `model-call` answer is sent to Anthropic here and the request is
 * sent again with the responses so far, until the service answers otherwise. A spend stop
 * reached here answers as the service's own stops do. Without a key the requests go as
 * they are, and the service uses the owner's credential.
 */
export function createDeviceModel(options: {
  storage: DeviceModelStorage;
  /** This device's Cloudflare account and token for Clef (ADR 0083), if any. */
  clef?: { read(): Promise<unknown> };
  spend: DeviceModelSpendStorage;
  /** The profile's spend limits, read before each call; a rejection stops the call. */
  limits: () => Promise<{ dailyUsd: number; monthlyUsd: number }>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  const { storage, spend } = options;
  const fetchModel = options.fetch ?? ((...request) => globalThis.fetch(...request));
  const now = options.now ?? Date.now;
  // Spend is added one call at a time, so two requests at once both count.
  let spendQueue: Promise<unknown> = Promise.resolve();
  // What calls cost that could not be written yet; it still counts toward the limits.
  let unrecorded = 0;

  // A spend count that cannot be read, or reads as something else, stops the calls
  // rather than counting as nothing spent.
  async function spentAt(at: number) {
    const stored = await spend.read();
    if (stored !== undefined && !v.is(spendSchema, stored))
      throw new Error("The spend count is unreadable");
    return currentSpend(stored, at);
  }
  async function stopped() {
    const limits = await options.limits();
    const counted = await spentAt(now());
    const spent = {
      dayMicroUsd: counted.dayMicroUsd + unrecorded,
      monthMicroUsd: counted.monthMicroUsd + unrecorded,
    };
    if (spent.monthMicroUsd >= limits.monthlyUsd * 1_000_000) return "monthly-limit";
    if (spent.dayMicroUsd >= limits.dailyUsd * 1_000_000) return "daily-limit";
    return undefined;
  }
  async function add() {
    const at = now();
    const spent = await spentAt(at);
    const micro = unrecorded;
    await spend.write({
      version: 1,
      ...periods(at),
      dayMicroUsd: spent.dayMicroUsd + micro,
      monthMicroUsd: spent.monthMicroUsd + micro,
    });
    unrecorded -= micro;
  }
  function charge(micro: number) {
    if (micro === 0) return Promise.resolve();
    unrecorded += micro;
    const added = spendQueue.then(() => add());
    spendQueue = added.catch(() => undefined);
    return added;
  }

  /**
   * Sends one model call with the key, to Anthropic's fixed URL only, and what it cost.
   */
  async function send(
    apiKey: string,
    call: DeviceModelCall["call"],
    body: string,
    /** Ends the call early, as the role's own time limit does on a device without a pairing. */
    signal?: AbortSignal,
  ): Promise<{ response: DeviceModelResponse; cost: number }> {
    const request = await deviceModelRequestHash(call.body);
    const headers = new Headers();
    for (const name of deviceModelHeaderNames) {
      const value = call.headers[name];
      if (value !== undefined) headers.set(name, value);
    }
    headers.set("x-api-key", apiKey);
    // Anthropic asks a caller with a browser origin to say it holds the key itself.
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), DEVICE_MODEL_TIMEOUT_MS);
    const stop = () => timeout.abort();
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) stop();
    const failed = (kind: "timeout" | "unreachable") => ({ kind, request }) as const;
    try {
      let response: Response;
      try {
        response = await fetchModel(DEVICE_MODEL_URL, {
          method: "POST",
          headers,
          body,
          credentials: "omit",
          redirect: "error",
          signal: timeout.signal,
        });
      } catch {
        const kind = timeout.signal.aborted ? "timeout" : "unreachable";
        return { response: failed(kind), cost: callCostMicroUsd(call.body, failed(kind)) };
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        // Anthropic answered, so the call may have been charged: count its worst case.
        const kind = timeout.signal.aborted ? "timeout" : "unreachable";
        return { response: failed(kind), cost: callCostMicroUsd(call.body, failed("timeout")) };
      }
      const answered = { kind: "response", request, status: response.status, body: text } as const;
      const cost = callCostMicroUsd(call.body, answered);
      // An answer too large to pass on is no answer the service could take, but Anthropic
      // still charged it.
      if (byteLength(text) > MAX_DEVICE_MODEL_RESPONSE_BYTES)
        return { response: failed("unreachable"), cost };
      return { response: answered, cost };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  /**
   * Sends one Clef call with the token, to the account's Workers AI URL for Clef only, and
   * what it cost (ADR 0083).
   */
  async function sendClef(
    setting: DeviceClefSetting,
    body: string,
    /** Ends the call early, as the role's own time limit does. */
    signal?: AbortSignal,
  ): Promise<{ response: DeviceClefResponse; cost: number }> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), DEVICE_MODEL_TIMEOUT_MS);
    const stop = () => timeout.abort();
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) stop();
    const failed = (kind: "timeout" | "unreachable") => {
      const response = { kind } as const;
      return { response, cost: clefCallCostMicroUsd(response) };
    };
    try {
      let response: Response;
      try {
        response = await fetchModel(clefUrl(setting.accountId, CLEF_MODEL), {
          method: "POST",
          headers: {
            authorization: `Bearer ${setting.apiToken}`,
            "content-type": "application/json",
          },
          body,
          credentials: "omit",
          redirect: "error",
          signal: timeout.signal,
        });
      } catch {
        return failed(timeout.signal.aborted ? "timeout" : "unreachable");
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        // Cloudflare answered, so the call may have been charged: count its worst case.
        return { response: { kind: "unreachable" }, cost: failed("timeout").cost };
      }
      const answered = { kind: "response", status: response.status, body: text } as const;
      const cost = clefCallCostMicroUsd(answered);
      if (byteLength(text) > MAX_DEVICE_MODEL_RESPONSE_BYTES)
        return { response: { kind: "unreachable" }, cost };
      return { response: answered, cost };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  async function relay<Result extends { status: string }>(
    request: (deviceModel: DeviceModel | undefined) => Promise<InferenceResult<Result>>,
  ): Promise<InferenceResult<Result | Unavailable>> {
    let stored: unknown;
    try {
      stored = await storage.read();
    } catch {
      // Never the owner's credential on the service in place of a key that could not be
      // read.
      return { kind: "failed", error: "unexpected-response" };
    }
    const setting = parseDeviceModelSetting(stored);
    // A record that is no key this version can read fails too, rather than using the
    // service's credential.
    if (!setting && stored !== undefined) return { kind: "failed", error: "unexpected-response" };
    if (!setting) return request(undefined);
    const responses: DeviceModelResponse[] = [];
    // A service that keeps asking for calls again is stopped after twice the most a
    // request needs.
    for (let made = 0; ; made += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each call depends on the answer before
      const answer = await request({ responses: [...responses] });
      if (answer.kind !== "result" || answer.result.status !== "model-call") return answer;
      const { call } = answer.result as unknown as DeviceModelCall;
      // A call the routes never make (tools, streaming, a larger answer, another beta) is
      // not sent: a service, possibly someone else's, gets no other use of the key.
      const body = deviceModelCallBody(call);
      if (call.index > responses.length || made >= 2 * MAX_DEVICE_MODEL_CALLS || !body)
        return { kind: "failed", error: "unexpected-response", ...timed(answer) };
      let stop: Awaited<ReturnType<typeof stopped>>;
      try {
        // oxlint-disable-next-line no-await-in-loop
        stop = await stopped();
      } catch {
        return { kind: "failed", error: "unexpected-response", ...timed(answer) };
      }
      if (stop)
        return {
          kind: "result",
          result: { version: 1, status: "unavailable", reason: stop },
          ...timed(answer),
        };
      // oxlint-disable-next-line no-await-in-loop
      const { response, cost } = await send(setting.apiKey, call, body);
      try {
        // oxlint-disable-next-line no-await-in-loop
        await charge(cost);
      } catch {
        return { kind: "failed", error: "unexpected-response", ...timed(answer) };
      }
      // A call asked again replaces the response it had and every one after it.
      responses.length = call.index;
      responses.push(response);
    }
  }

  return {
    /**
     * The key's own calls, for generation on a device without a pairing (ADR 0040): the
     * saved setting (none without one; rejects for a record that cannot be read or is no
     * key), the spend stop it reached, one call to Anthropic, and its cost.
     */
    direct: {
      async setting(): Promise<DeviceModelSetting | undefined> {
        const stored = await storage.read();
        const setting = parseDeviceModelSetting(stored);
        if (!setting && stored !== undefined) throw new Error("The saved key is unreadable");
        return setting;
      },
      /**
       * The saved Cloudflare account and token for Clef (ADR 0083); none without one, or
       * for a record that cannot be read, so that Claude answers alone.
       */
      async clefSetting(): Promise<DeviceClefSetting | undefined> {
        return parseDeviceClefSetting(await options.clef?.read());
      },
      stopped,
      send,
      sendClef,
      charge,
    },
    /** The four requests, made with this device's key when one is saved. */
    wrap(transport: DeviceModelRequests): DeviceModelRequests {
      return {
        generateRecipe: (origin, credential, request) =>
          relay((deviceModel) =>
            transport.generateRecipe(origin, credential, {
              ...request,
              ...(deviceModel ? { deviceModel } : {}),
            }),
          ) as ReturnType<DeviceModelRequests["generateRecipe"]>,
        generateEntry: (origin, credential, request) =>
          relay((deviceModel) =>
            transport.generateEntry(origin, credential, {
              ...request,
              ...(deviceModel ? { deviceModel } : {}),
            }),
          ) as ReturnType<DeviceModelRequests["generateEntry"]>,
        generateLogout: (origin, credential, request) =>
          relay((deviceModel) =>
            transport.generateLogout(origin, credential, {
              ...request,
              ...(deviceModel ? { deviceModel } : {}),
            }),
          ) as ReturnType<DeviceModelRequests["generateLogout"]>,
        judgeCompletion: (origin, credential, recipeId, request) =>
          relay((deviceModel) =>
            transport.judgeCompletion(origin, credential, recipeId, {
              ...request,
              ...(deviceModel ? { deviceModel } : {}),
            }),
          ) as ReturnType<DeviceModelRequests["judgeCompletion"]>,
      };
    },
  };
}
