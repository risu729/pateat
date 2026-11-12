import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_MODEL_URL,
  OPENAI_DEVICE_MODEL_URL,
  deviceModelRequestHash,
  type DeviceModelCall,
  type SsoCompletionRequest,
} from "@pateat/contracts";
import { createDeviceModel, type DeviceModelSetting } from "./device-model";
import { createServiceTransport } from "./transport";

const service = "https://service.example.test";
const credential = "pateat_device_" + "C".repeat(43);
const recipeId = "gen-0123456789abcdef0123456789abcdef";
const request: SsoCompletionRequest = {
  version: 1,
  kind: "sso-completion",
  revision: 1,
  layout: "1000",
  observation: {
    version: 1,
    origin: "https://rp.example.test",
    path: "/home",
    language: "en",
    complete: true,
    candidates: [
      { id: "logout", role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
    ],
  },
};
const now = Date.UTC(2026, 10, 12, 12);
const callFor = (provider: "anthropic" | "openai"): DeviceModelCall["call"] => ({
  provider,
  index: 0,
  headers:
    provider === "anthropic"
      ? { "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json" },
  body: JSON.stringify(
    provider === "anthropic"
      ? {
          model: "claude-opus-5-5",
          max_tokens: 1024,
          system: "Synthetic instructions",
          messages: [{ role: "user", content: [{ type: "text", text: "Synthetic page" }] }],
        }
      : {
          model: "gpt-6.1-sol",
          input: [
            { role: "developer", content: "Synthetic instructions" },
            { role: "user", content: [{ type: "input_text", text: "Synthetic page" }] },
          ],
          max_output_tokens: 1024,
          store: false,
          service_tier: "default",
          reasoning: { effort: "low" },
          include: ["reasoning.encrypted_content"],
          text: {
            format: {
              type: "json_schema",
              name: "synthetic",
              strict: false,
              schema: { type: "object" },
            },
          },
        },
  ),
});

describe("paired SSO completion through the real service and device-model clients", () => {
  it.each(["anthropic", "openai"] as const)(
    "keeps %s provider, new request kind and one server judgement identity across a relay",
    async (provider) => {
      const call = callFor(provider);
      const key =
        provider === "anthropic"
          ? "sk-ant-synthetic-sso-return-abcd"
          : "synthetic-openai-sso-return-key";
      let spend: unknown;
      const providerRequests: Request[] = [];
      const providerFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const outbound = new Request(input, init);
        providerRequests.push(outbound);
        expect(outbound.url).toBe(
          provider === "openai" ? OPENAI_DEVICE_MODEL_URL : DEVICE_MODEL_URL,
        );
        return Response.json({ usage: { input_tokens: 1000, output_tokens: 100 } });
      });
      const bodies: SsoCompletionRequest[] = [];
      const serviceFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        expect(String(input)).toBe(service + "/v1/recipes/" + recipeId + "/completion");
        const body = JSON.parse(init!.body as string) as SsoCompletionRequest;
        bodies.push(body);
        const result =
          bodies.length === 1
            ? {
                version: 1,
                status: "model-call",
                call,
                judgement: { id: body.deviceModel!.judgement!.id, startedAt: now },
              }
            : { version: 1, status: "signed-in" };
        const response = Response.json(result);
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      });
      const setting: DeviceModelSetting = { version: 1, provider, apiKey: key };
      const model = createDeviceModel({
        storage: { read: async () => setting, write: async () => {}, clear: async () => {} },
        spend: {
          read: async () => spend,
          write: async (value) => {
            spend = value;
          },
        },
        limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
        fetch: providerFetch,
        now: () => now,
      });
      const wrapped = model.wrap(createServiceTransport({ fetch: serviceFetch }));
      expect(await wrapped.judgeCompletion(service, credential, recipeId, request)).toMatchObject({
        kind: "result",
        result: { status: "signed-in" },
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(serviceFetch).toHaveBeenCalledTimes(2);
      expect(bodies[0]).toMatchObject({
        ...request,
        deviceModel: { provider, responses: [], judgement: { id: expect.any(String) } },
      });
      expect(bodies[1]).toMatchObject({
        ...request,
        deviceModel: {
          provider,
          judgement: { id: bodies[0]!.deviceModel!.judgement!.id, startedAt: now },
          responses: [
            { kind: "response", request: await deviceModelRequestHash(call.body), status: 200 },
          ],
        },
      });
      expect(providerRequests[0]!.headers.get("authorization")).toBe(
        provider === "openai" ? "Bearer " + key : null,
      );
      expect(providerRequests[0]!.headers.get("x-api-key")).toBe(
        provider === "anthropic" ? key : null,
      );
      expect(JSON.stringify(bodies)).not.toContain(key);
      expect(JSON.stringify(bodies)).not.toMatch(
        /username|sourceEvidence|usernameProof|idp-vault/u,
      );
    },
  );
});
