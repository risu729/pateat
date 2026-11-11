import {
  DEVICE_MODEL_URL,
  OPENAI_DEVICE_MODEL_URL,
  deviceModelHeaderNames,
  deviceModelRequestHash,
  type DeviceModel,
  type DeviceModelCall,
  type GenerationUnavailableReason,
} from "@pateat/contracts";
import { CLEF_MODEL } from "@pateat/generation";
import { clefUrl, createClefDecisionModel } from "@pateat/inference";

// The writes a request makes once before its first model call, and the fetches that hand a
// paired device the calls it makes with its own key and token (ADR 0040, ADR 0083).

/**
 * A request's `beforeSend` writes, run once before its first model request. `settled`
 * waits for a write that outlived the call, as one the role's timeout cut short; `ms` is
 * its duration, which belongs before the model call.
 */
export type Reservation = {
  run: () => Promise<void>;
  settled: () => Promise<void>;
  ms: number;
  error?: unknown;
};

/** A request `beforeSend` stopped before its first model request, with the answer's reason. */
export class Unsent extends Error {
  readonly reason: GenerationUnavailableReason;
  constructor(reason: GenerationUnavailableReason) {
    super("Model call not sent");
    this.reason = reason;
  }
}

export function reserveOnce(write: () => Promise<void>): Reservation {
  let written: Promise<void> | undefined;
  const reservation: Reservation = {
    run: () => {
      written ??= (async () => {
        const start = Date.now();
        try {
          await write();
        } catch (error) {
          reservation.error = error;
          throw error;
        }
        reservation.ms = Date.now() - start;
      })();
      return written;
    },
    settled: async () => {
      await written?.catch(() => {});
    },
    ms: 0,
  };
  return reservation;
}

/**
 * The fetch of a call the device makes (ADR 0040). With the device's response for this
 * call, it answers with that response once the request's `beforeSend` writes ran, as a
 * sent call would; without one, or when this run built another body than the one the
 * device sent, it keeps the call in `next` for the device to make and fails the role's
 * request, which is then neither charged nor logged.
 */
export function deviceRelay(
  caller: { device: DeviceModel; index: number },
  /** Absent for a dry run, which writes nothing. */
  reservation: Reservation | undefined,
) {
  const relay: {
    fetch: typeof globalThis.fetch;
    next?: DeviceModelCall["call"];
    timedOut?: true;
  } = {
    fetch: async (input, init) => {
      const outbound = new Request(input, init);
      // The provider adapter pins the URL; anything else is never handed to the device.
      const expected =
        caller.device.provider === "openai" ? OPENAI_DEVICE_MODEL_URL : DEVICE_MODEL_URL;
      if (outbound.url !== expected || outbound.method !== "POST")
        throw new TypeError("Unexpected model request");
      const body = await outbound.text();
      const response = caller.device.responses[caller.index];
      if (!response || response.request !== (await deviceModelRequestHash(body))) {
        const headers: Partial<Record<(typeof deviceModelHeaderNames)[number], string>> = {};
        for (const name of deviceModelHeaderNames) {
          const value = outbound.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        relay.next = { index: caller.index, provider: caller.device.provider, headers, body };
        throw new Error("Model call left to the device");
      }
      await reservation?.run();
      if (response.kind === "timeout") relay.timedOut = true;
      if (response.kind !== "response") throw new Error("No model response on the device");
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return relay;
}

/** The account the service names in Clef calls it hands a device, which uses its own. */
const DEVICE_CLEF_ACCOUNT = "0".repeat(32);
const DEVICE_CLEF_URL = clefUrl(DEVICE_CLEF_ACCOUNT, CLEF_MODEL);
/** How many of a request's first device calls are Clef's: the form call and the page call. */
const DEVICE_CLEF_CALLS = 2;

/**
 * Clef's calls on a device (ADR 0083), the first `DEVICE_CLEF_CALLS` of its calls. The two
 * run at once, so each takes the response the device made for its own body, whichever
 * place that holds; a call without one is left to the device as `next`, at the first place
 * no call of this run took. `used` is how many places Clef's calls took, where Claude's
 * begin.
 */
export function deviceClefRelay(device: DeviceModel) {
  const places = device.responses.slice(0, DEVICE_CLEF_CALLS);
  const taken = new Set<number>();
  const missing: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const outbound = new Request(input, init);
    // The adapter pins the URL; anything else is never handed to the device.
    if (outbound.url !== DEVICE_CLEF_URL || outbound.method !== "POST")
      throw new TypeError("Unexpected model request");
    const body = await outbound.text();
    const hash = await deviceModelRequestHash(body);
    const place = places.findIndex(
      (response, index) => !taken.has(index) && response.request === hash,
    );
    if (place === -1) {
      missing.push(body);
      throw new Error("Model call left to the device");
    }
    taken.add(place);
    const response = places[place]!;
    if (response.kind !== "response") throw new Error("No model response on the device");
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    model: createClefDecisionModel({
      accountId: DEVICE_CLEF_ACCOUNT,
      apiToken: "device",
      modelId: CLEF_MODEL,
      fetch,
    }),
    next(): DeviceModelCall["call"] | undefined {
      const body = missing[0];
      if (body === undefined) return undefined;
      let index = 0;
      while (taken.has(index)) index += 1;
      return {
        index,
        provider: "cloudflare",
        headers: { "content-type": "application/json" },
        body,
      };
    },
    used: () => (taken.size === 0 ? 0 : Math.max(...taken) + 1),
  };
}
