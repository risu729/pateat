import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  deviceModelSchema,
  deviceModelCallSchema,
  MAX_DEVICE_MODEL_CALLS,
  MAX_DEVICE_MODEL_REQUEST_BYTES,
  MAX_DEVICE_MODEL_RESPONSE_BYTES,
} from "./device-model";

const response = { kind: "response", request: "a".repeat(64), status: 200, body: "{}" };
const call = {
  version: 1,
  status: "model-call",
  call: {
    provider: "openai",
    index: 0,
    headers: { "content-type": "application/json" },
    body: "{}",
  },
};
describe("provider-tagged device relay contracts", () => {
  it("requires the text provider on every request and replay", () => {
    expect(
      v.parse(deviceModelSchema, { provider: "openai", responses: [response], clef: true }),
    ).toEqual({
      provider: "openai",
      responses: [response],
      clef: true,
    });
    for (const provider of [undefined, "cloudflare", "proxy"])
      expect(v.safeParse(deviceModelSchema, { provider, responses: [] }).success).toBe(false);
  });

  it.each([
    { ...call, call: { ...call.call, provider: undefined } },
    { ...call, call: { ...call.call, provider: "proxy" } },
    { ...call, call: { ...call.call, url: "https://attacker.example/collect" } },
    { ...call, call: { ...call.call, headers: { authorization: "Bearer synthetic" } } },
    { ...call, call: { ...call.call, index: MAX_DEVICE_MODEL_CALLS } },
    { ...call, call: { ...call.call, body: "x".repeat(MAX_DEVICE_MODEL_REQUEST_BYTES + 1) } },
  ])("rejects malformed or expanded service capabilities %#", (value) => {
    expect(v.safeParse(deviceModelCallSchema, value).success).toBe(false);
  });

  it("keeps call and response size/count limits on OpenAI relays", () => {
    expect(v.safeParse(deviceModelCallSchema, call).success).toBe(true);
    expect(
      v.safeParse(deviceModelSchema, {
        provider: "openai",
        responses: Array.from({ length: MAX_DEVICE_MODEL_CALLS + 1 }, () => response),
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(deviceModelSchema, {
        provider: "openai",
        responses: [{ ...response, body: "x".repeat(MAX_DEVICE_MODEL_RESPONSE_BYTES + 1) }],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(deviceModelSchema, {
        provider: "openai",
        responses: [{ ...response, request: "not-a-body-hash" }],
      }).success,
    ).toBe(false);
  });
});
