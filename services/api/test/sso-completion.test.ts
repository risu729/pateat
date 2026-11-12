import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  deviceModelRequestHash,
  type SsoCompletionRequest,
  type SsoRecipeDocument,
} from "@pateat/contracts";
import {
  judgeCompletion,
  generatedRecipeId,
  type GenerationBackend,
  type GenerationCall,
  type GenerationCallResult,
} from "@pateat/generation";
import { textModel, textResult } from "../../../packages/inference/src/testing/fake-models";
import { d1Backend } from "../src/recipes/backend";
import { createDeviceToken, hashDeviceToken } from "../src/auth";

const origin = "https://rp.example.test";
const modelBody = JSON.stringify({
  model: "gpt-6.1-sol",
  input: [{ role: "user", content: "Synthetic RP return" }],
});
async function setup() {
  const ownerId = crypto.randomUUID();
  const deviceId = "device-" + crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now),
    env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
      ownerId,
      ownerId,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, ownerId, ownerId, await hashDeviceToken(createDeviceToken()), now, now),
  ]);
  const backend = d1Backend(env, { ownerId, deviceId, profileId: ownerId }, { startedAt: now });
  const recipeId = await generatedRecipeId(origin, "/signin");
  const recipe: SsoRecipeDocument = {
    version: 1,
    id: recipeId,
    revision: 1,
    origin,
    sso: {
      path: "/signin",
      layouts: [
        {
          key: "1000",
          createdAt: 1000,
          entries: [{ label: "Synthetic provider", target: { by: "id", value: "provider" } }],
        },
      ],
    },
  };
  expect(
    await backend.writeRecipe(
      recipeId,
      { version: 1, state: "active", expectedRevision: 0, recipe },
      { sources: { origin: "device" } },
    ),
  ).toMatchObject({ ok: true });
  const request: SsoCompletionRequest = {
    version: 1,
    kind: "sso-completion",
    revision: 1,
    layout: "1000",
    observation: {
      version: 1,
      origin,
      path: "/home",
      language: "en",
      complete: true,
      candidates: [
        { id: "logout", role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
      ],
    },
  };
  let modelCalls = 0;
  const model = textModel(async () => {
    modelCalls++;
    return textResult(JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }));
  });
  const call: GenerationBackend["call"] = async <T>(
    input: GenerationCall<T>,
  ): Promise<GenerationCallResult<T>> => {
    const blocked = await input.gate?.(Date.now());
    if (blocked) return { status: "unavailable", reason: blocked };
    if (input.device && input.device.responses.length === 0)
      return {
        status: "device-call",
        call: {
          provider: "openai",
          index: 0,
          headers: { "content-type": "application/json" },
          body: modelBody,
        },
      };
    const refused = await input.beforeSend?.(Date.now());
    if (refused) return { status: "unavailable", reason: refused };
    return {
      status: "called",
      outcome: await input.invoke(model as unknown as Parameters<typeof input.invoke>[0]),
      served: { provider: "openai", model: "gpt-6.1-sol", effort: "low", speed: "standard" },
      timings: { preModelMs: 0, tokenMs: 0, modelMs: 0 },
    };
  };
  const generationBackend = { ...backend, call };
  const quotaCount = async () =>
    (await env.DB.prepare(
      "SELECT count(*) AS n FROM judgement_reservations WHERE owner_id = ? AND state != 'cancelled'",
    )
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  return {
    ownerId,
    recipeId,
    request,
    backend,
    generationBackend,
    quotaCount,
    calls: () => modelCalls,
  };
}
describe("dedicated SSO completion uses real local D1 persistence", () => {
  it("stores the learned per-layout marker and its provider-tagged judged provenance", async () => {
    const h = await setup();
    expect(await judgeCompletion(h.generationBackend, h.recipeId, h.request)).toMatchObject({
      status: "signed-in",
      change: { revision: 2, state: "active" },
    });
    const head = await h.backend.readHead(h.recipeId);
    expect(head).toMatchObject({
      state: "active",
      recipe: { sso: { layouts: [{ completion: [{ target: { by: "id", value: "logout" } }] }] } },
    });
    const units = await env.DB.prepare(
      "SELECT unit, origin, provider FROM recipe_unit_sources WHERE owner_id = ? AND recipe_id = ?",
    )
      .bind(h.ownerId, h.recipeId)
      .all();
    expect(units.results).toContainEqual(
      expect.objectContaining({ unit: "sso-marker:0", origin: "judged", provider: "openai" }),
    );
    expect(await h.quotaCount()).toBe(1);
    expect(h.calls()).toBe(1);
  });
  it("pairs dispatch and its exact response hash to one durable reservation without replay", async () => {
    const h = await setup();
    const id = crypto.randomUUID();
    const first = await judgeCompletion(h.generationBackend, h.recipeId, {
      ...h.request,
      deviceModel: { provider: "openai", responses: [], judgement: { id } },
    });
    expect(first).toMatchObject({
      status: "model-call",
      call: { provider: "openai" },
      judgement: { id, startedAt: expect.any(Number) },
    });
    if (!first || first.status !== "model-call" || !first.judgement)
      throw new Error("Expected a paired judgement grant");
    expect(await h.quotaCount()).toBe(1);
    const complete: SsoCompletionRequest = {
      ...h.request,
      deviceModel: {
        provider: "openai",
        judgement: first.judgement,
        responses: [
          {
            kind: "response",
            request: await deviceModelRequestHash(modelBody),
            status: 200,
            body: "Synthetic provider response",
          },
        ],
      },
    };
    expect(await judgeCompletion(h.generationBackend, h.recipeId, complete)).toMatchObject({
      status: "signed-in",
      change: { revision: 2 },
    });
    expect(await h.quotaCount()).toBe(1);
    expect(h.calls()).toBe(1);
    expect(await judgeCompletion(h.generationBackend, h.recipeId, complete)).toMatchObject({
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(await h.quotaCount()).toBe(1);
    expect(h.calls()).toBe(1);
  });
});
