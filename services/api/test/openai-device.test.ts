import {
  deviceOpenAIModelCallBody,
  deviceModelCallSchema,
  deviceModelRequestHash,
  recipeGenerationResultSchema,
  storedLayouts,
  type DeviceModelResponse,
  type LoginObservation,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { app } from "../src/app";
import { saveModelConfig } from "../src/claude/models";
import { saveOpenAICredential } from "../src/openai/credentials";
import { DEFAULT_OPENAI_MODEL_CONFIG } from "@pateat/contracts";

// No service credential is configured; every text call must be handed to the device.
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("A paired device must make its own provider calls");
  });
});
afterAll(() => vi.restoreAllMocks());
const origin = "https://openai-relay.example.test";
const page = (path: string, candidates: LoginObservation["candidates"]): LoginObservation => ({
  version: 1,
  origin,
  path,
  language: "en",
  complete: true,
  candidates,
});
const login = page("/login", [
  { id: "email", role: "email", target: { by: "id", value: "email" }, label: "Email" },
  { id: "password", role: "password", target: { by: "id", value: "password" }, label: "Password" },
  { id: "submit", role: "button", target: { by: "id", value: "submit" }, label: "Sign in" },
]);
const home = page("/home", [
  { id: "logout", role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
]);
const slots = [
  { id: "email", kind: "identifier", description: "Account email" },
  { id: "password", kind: "secret", description: "Account password" },
];
const plan = {
  result: {
    decision: "plan",
    pageKind: "sign-in",
    irreversible: "no",
    fields: [
      { slot: "email", candidate: "email" },
      { slot: "password", candidate: "password" },
    ],
    action: { candidate: "submit", purpose: "submit" },
  },
};

async function device() {
  const ownerId = crypto.randomUUID();
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(ownerId),
    env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
      ownerId,
      ownerId,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      ownerId,
      ownerId,
      await hashDeviceToken(token),
      Date.now(),
      Date.now(),
    ),
  ]);
  return { ownerId, token };
}

async function post(
  token: string,
  path: string,
  body: object,
  responses: DeviceModelResponse[] = [],
  provider = "openai",
) {
  const response = await exports.default.fetch(`https://pateat.invalid${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, deviceModel: { provider, responses } }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function call(reply: Awaited<ReturnType<typeof post>>) {
  expect(reply.status).toBe(200);
  const parsed = v.parse(deviceModelCallSchema, reply.body);
  expect(parsed.call.provider).toBe("openai");
  expect(deviceOpenAIModelCallBody(parsed.call)).toBe(parsed.call.body);
  expect(parsed.call.headers).toEqual({ "content-type": "application/json" });
  const body = JSON.parse(parsed.call.body);
  expect(body).toMatchObject({ model: "gpt-6.1-sol", store: false, service_tier: "default" });
  expect(body).not.toHaveProperty("stream");
  expect(body).not.toHaveProperty("tools");
  expect(body).not.toHaveProperty("previous_response_id");
  expect(JSON.stringify(parsed)).not.toContain("Authorization");
  return parsed.call;
}

async function answer(
  body: string,
  result: unknown,
  refusal = false,
): Promise<DeviceModelResponse> {
  return {
    kind: "response",
    request: await deviceModelRequestHash(body),
    status: 200,
    body: JSON.stringify({
      id: "resp_synthetic",
      model: JSON.parse(body).model,
      output: [
        {
          type: "message",
          id: "msg_synthetic",
          role: "assistant",
          content: [
            refusal
              ? { type: "refusal", refusal: "Synthetic refusal" }
              : { type: "output_text", text: JSON.stringify(result), annotations: [] },
          ],
        },
      ],
      usage: {
        input_tokens: 3000,
        output_tokens: 900,
        input_tokens_details: { cached_tokens: 1000 },
        output_tokens_details: { reasoning_tokens: 400 },
      },
    }),
  };
}

describe("OpenAI calls relayed to a paired device", () => {
  it("uses the owner's decrypted key for a service call and records service spend", async () => {
    const by = await device();
    const bindings = {
      DB: env.DB,
      OWNER_LIMITER: env.OWNER_LIMITER,
      INFERENCE_CREDENTIAL_KEY: "52".repeat(32),
    };
    const secret = "synthetic-owner-service-key";
    await saveOpenAICredential(bindings, by.ownerId, secret);
    await saveModelConfig(env.DB, by.ownerId, DEFAULT_OPENAI_MODEL_CONFIG);
    let requests = 0;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
      const sent = new Request(input, init);
      expect(sent.url).toBe("https://api.openai.com/v1/responses");
      expect(sent.method).toBe("POST");
      expect(sent.headers.get("Authorization")).toBe(`Bearer ${secret}`);
      const body = await sent.text();
      expect(
        deviceOpenAIModelCallBody({
          index: 0,
          provider: "openai",
          headers: { "content-type": "application/json" },
          body,
        }),
      ).toBe(body);
      requests += 1;
      const response = await answer(body, plan);
      if (response.kind !== "response") throw new Error("Expected synthetic response");
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    });
    const pending: Promise<unknown>[] = [];
    const result = await app.request(
      "https://pateat.invalid/v1/recipes/generate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${by.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, observation: login, slots, signedIn: false }),
      },
      bindings,
      { waitUntil: (promise) => pending.push(promise), passThroughOnException() {}, props: {} },
    );
    await Promise.all(pending);
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(JSON.parse(text)).toMatchObject({ status: "recipe" });
    expect(text).not.toContain(secret);
    expect(requests).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT provider, source, cost_micro_usd FROM inference_log WHERE owner_id = ?",
        )
          .bind(by.ownerId)
          .all()
      ).results,
    ).toEqual([{ provider: "openai", source: "service", cost_micro_usd: 24000 }]);
    expect(
      (
        await env.DB.prepare("SELECT calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?")
          .bind(by.ownerId)
          .all()
      ).results,
    ).toEqual([
      { calls: 1, cost_micro_usd: 24000 },
      { calls: 1, cost_micro_usd: 24000 },
    ]);
  });

  it("generates and judges a recipe with the device's provider and logs its cost without charging service spend", async () => {
    const by = await device();
    const request = { version: 1, observation: login, slots, signedIn: false };
    const first = call(await post(by.token, "/v1/recipes/generate", request));
    const generated = v.parse(
      recipeGenerationResultSchema,
      (await post(by.token, "/v1/recipes/generate", request, [await answer(first.body, plan)]))
        .body,
    );
    if (generated.status !== "recipe") throw new Error("Expected generated recipe");
    const { recipeId, revision, recipe } = generated.change;
    const judgedBody = {
      version: 1,
      revision,
      branch: storedLayouts(recipe)[0]!.key,
      route: "password",
      slots: [],
      observation: home,
    };
    const judgePath = `/v1/recipes/${recipeId}/completion`;
    const judge = call(await post(by.token, judgePath, judgedBody));
    expect(
      (
        await post(by.token, judgePath, judgedBody, [
          await answer(judge.body, { result: { decision: "signed-in", marker: "logout" } }),
        ])
      ).body,
    ).toMatchObject({ status: "signed-in" });
    const log = (
      await env.DB.prepare(
        "SELECT provider, source, role, input_tokens, output_tokens, cost_micro_usd FROM inference_log WHERE owner_id = ? ORDER BY created_at",
      )
        .bind(by.ownerId)
        .all()
    ).results;
    expect(log).toEqual([
      {
        provider: "openai",
        source: "device",
        role: "generate",
        input_tokens: 3000,
        output_tokens: 900,
        cost_micro_usd: 24000,
      },
      {
        provider: "openai",
        source: "device",
        role: "judge",
        input_tokens: 3000,
        output_tokens: 900,
        cost_micro_usd: 24000,
      },
    ]);
    expect(
      (
        await env.DB.prepare("SELECT * FROM inference_spend WHERE owner_id = ?")
          .bind(by.ownerId)
          .all()
      ).results,
    ).toEqual([]);
  });

  it.each(["entry", "logout"])("hands over and validates the %s route's response", async (kind) => {
    const by = await device();
    const entry = page("/en/", [
      { id: "login", role: "link", target: { by: "text", value: "Login" } },
    ]);
    const path = kind === "entry" ? "/v1/recipes/generate" : "/v1/recipes/logout";
    const body = { version: 1, observation: kind === "entry" ? entry : home };
    const sent = call(await post(by.token, path, body));
    const result =
      kind === "entry"
        ? { decision: "entry", entry: "login" }
        : { decision: "logout", control: "logout", purpose: "logout" };
    expect(
      (await post(by.token, path, body, [await answer(sent.body, { result })])).body,
    ).toMatchObject({ status: "recipe" });
  });

  it("uses OpenAI fallback after refusal and refuses mismatched or invalid provider capabilities", async () => {
    const by = await device();
    const request = { version: 1, observation: login, slots, signedIn: false };
    const first = call(await post(by.token, "/v1/recipes/generate", request));
    const refused = await answer(first.body, {}, true);
    const second = v.parse(
      deviceModelCallSchema,
      (await post(by.token, "/v1/recipes/generate", request, [refused])).body,
    ).call;
    expect(second.provider).toBe("openai");
    expect(JSON.parse(second.body).model).toBe("gpt-6.1-terra");
    expect(second.index).toBe(1);
    const mismatched = { ...refused, request: "0".repeat(64) };
    expect(call(await post(by.token, "/v1/recipes/generate", request, [mismatched])).index).toBe(0);
    expect((await post(by.token, "/v1/recipes/generate", request, [], "cloudflare")).status).toBe(
      400,
    );
    expect((await post(by.token, "/v1/recipes/generate", request, [], "unknown")).status).toBe(400);
  });
});
