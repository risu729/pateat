import * as v from "valibot";

// A paired device that holds its own Anthropic API key makes the model calls of the
// service's generation and judge routes itself (ADR 0040). The service keeps every other
// step of the route: its checks and limits, the input it builds, the checks of the answer
// and the write. It answers a request that needs a model call with that call, the device
// sends it with its key and sends the request again with the provider's response, and the
// service runs the route again with the responses given so far.

/** The only URL a device sends a model call to; never one the service names. */
export const DEVICE_MODEL_URL = "https://api.anthropic.com/v1/messages";
/**
 * The most model calls one request makes: three model choices, each fast and then at the
 * standard speed (`CLAUDE_CALL_LIMITS.lockMs` in the service).
 */
export const MAX_DEVICE_MODEL_CALLS = 6;
/** How long the device waits for one model call, as the service waits for its own. */
export const DEVICE_MODEL_TIMEOUT_MS = 10_000;
/** A provider response the device passes back; an answer is at most 1,024 tokens. */
export const MAX_DEVICE_MODEL_RESPONSE_BYTES = 16 * 1024;
/** The body of a model call: the route's input is at most 64 KiB, escaped once more. */
export const MAX_DEVICE_MODEL_REQUEST_BYTES = 160 * 1024;
/** The headers of a model call the device sends as the service gave them, besides its key. */
export const deviceModelHeaderNames = [
  "anthropic-version",
  "anthropic-beta",
  "content-type",
] as const;

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
/** The SHA-256 of a model call's body, as lowercase hex. */
const requestHash = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

/**
 * One model call the device made, in order: the provider's response, or that none came
 * back in time (`timeout`) or at all (`unreachable`). `request` is the SHA-256 of the body
 * it sent, so a route that builds another body on a later run never takes this response.
 */
export const deviceModelResponseSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("response"),
    request: requestHash,
    status: v.pipe(v.number(), v.integer(), v.minValue(200), v.maxValue(599)),
    body: v.pipe(
      v.string(),
      v.check(
        (body) => byteLength(body) <= MAX_DEVICE_MODEL_RESPONSE_BYTES,
        "A model response over the limit",
      ),
    ),
  }),
  v.strictObject({ kind: v.literal("timeout"), request: requestHash }),
  v.strictObject({ kind: v.literal("unreachable"), request: requestHash }),
]);

/**
 * `deviceModel` on a generation, entry or judge request: the device makes the model calls
 * with its own key, and `responses` are those it made for this request so far.
 */
export const deviceModelSchema = v.strictObject({
  responses: v.pipe(v.array(deviceModelResponseSchema), v.maxLength(MAX_DEVICE_MODEL_CALLS)),
});

/**
 * The answer to a request with `deviceModel` that needs a model call: the device sends
 * `body` to `DEVICE_MODEL_URL` with `headers` and its key, and sends the request again with
 * its first `index` responses and this one.
 */
export const deviceModelCallSchema = v.strictObject({
  version: v.literal(1),
  status: v.literal("model-call"),
  call: v.strictObject({
    index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DEVICE_MODEL_CALLS - 1)),
    headers: v.record(
      v.picklist(deviceModelHeaderNames),
      v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    ),
    body: v.pipe(
      v.string(),
      v.check(
        (body) => byteLength(body) <= MAX_DEVICE_MODEL_REQUEST_BYTES,
        "A model call over the limit",
      ),
    ),
  }),
});

/** The most output tokens a model call may ask for, as `MAX_OUTPUT_TOKENS` in @pateat/generation. */
export const MAX_DEVICE_MODEL_OUTPUT_TOKENS = 1_024;
/** The only `anthropic-beta` value a device sends: fast mode's. */
export const deviceModelBetas = ["fast-mode-2026-02-01"] as const;

const textBlock = v.strictObject({ type: v.literal("text"), text: v.string() });
const text = v.union([v.string(), v.array(textBlock)]);
/**
 * The Messages request a device sends with its key: text in and structured text out,
 * nothing that runs tools, streams or calls other servers, so a service, possibly someone
 * else's, can use the key for nothing but the routes' own model calls.
 */
const deviceModelBodySchema = v.strictObject({
  model: v.pipe(v.string(), v.regex(/^claude-[a-z0-9-]+$/u)),
  max_tokens: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_DEVICE_MODEL_OUTPUT_TOKENS),
  ),
  speed: v.optional(v.picklist(["fast", "standard"])),
  output_config: v.optional(
    v.strictObject({
      effort: v.optional(v.picklist(["low", "medium", "high", "xhigh", "max"])),
      format: v.optional(
        v.strictObject({
          type: v.literal("json_schema"),
          schema: v.record(v.string(), v.unknown()),
        }),
      ),
    }),
  ),
  system: v.optional(text),
  messages: v.pipe(
    v.array(v.strictObject({ role: v.picklist(["user", "assistant"]), content: text })),
    v.minLength(1),
  ),
});

/**
 * The body a device sends for this call with its key, or none when it is not one the
 * routes make (`deviceModelBodySchema`). It is the checked body written again, so a key
 * given twice never reaches Anthropic with the value the check did not see.
 */
export function deviceModelCallBody(call: DeviceModelCall["call"]): string | undefined {
  const betas = call.headers["anthropic-beta"]?.split(",").map((beta) => beta.trim()) ?? [];
  if (!betas.every((beta) => (deviceModelBetas as readonly string[]).includes(beta)))
    return undefined;
  if (
    call.headers["content-type"] !== undefined &&
    call.headers["content-type"] !== "application/json"
  )
    return undefined;
  let body: unknown;
  try {
    body = JSON.parse(call.body);
  } catch {
    return undefined;
  }
  return v.is(deviceModelBodySchema, body) ? JSON.stringify(body) : undefined;
}

export type DeviceModelResponse = v.InferOutput<typeof deviceModelResponseSchema>;
export type DeviceModel = v.InferOutput<typeof deviceModelSchema>;
export type DeviceModelCall = v.InferOutput<typeof deviceModelCallSchema>;

/** The SHA-256 of a model call's body, as `deviceModelResponseSchema` names it. */
export async function deviceModelRequestHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return new Uint8Array(digest).toHex();
}
