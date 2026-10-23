import {
  DEVICE_MODEL_URL,
  type LoginObservation,
  type RecipeGenerationRequest,
  type SavedLoginBinding,
} from "@pateat/contracts";
import type { JudgementKey } from "@pateat/generation";
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceGeneration,
  createDeviceGenerationBackend,
  DEVICE_GENERATION_ORIGIN,
  generationConnection,
} from "./device-generation";
import { createDeviceModel, type DeviceModelSetting, type DeviceModelSpend } from "./device-model";
import { createDeviceRecipes } from "./device-recipes";

// A synthetic key, pages and Anthropic; nothing leaves the test.

const KEY = "sk-ant-synthetic-0000-abcd";
const SETTING: DeviceModelSetting = {
  version: 1,
  apiKey: KEY,
  dailyLimitUsd: 5,
  monthlyLimitUsd: 100,
};
const page: LoginObservation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [
    { id: "email", role: "email", target: { by: "id", value: "email" }, label: "Email" },
    {
      id: "password",
      role: "password",
      target: { by: "id", value: "password" },
      label: "Password",
    },
    { id: "sign-in", role: "button", target: { by: "id", value: "sign-in" }, label: "Sign in" },
  ],
};
const request: RecipeGenerationRequest = {
  version: 1,
  observation: page,
  slots: [
    { id: "email", kind: "identifier", description: "account email address" },
    { id: "password", kind: "secret", description: "account password" },
  ],
  signedIn: false,
};
const plan = JSON.stringify({
  result: {
    decision: "plan",
    pageKind: "sign-in",
    irreversible: "no",
    fields: [
      { slot: "email", candidate: "email" },
      { slot: "password", candidate: "password" },
    ],
    action: { candidate: "sign-in", purpose: "submit" },
  },
});

/** A text answer, or an HTTP error status. */
type Reply = string | number;

function setup(
  options: {
    setting?: DeviceModelSetting | undefined;
    spend?: DeviceModelSpend;
    replies?: Reply[];
    bindings?: SavedLoginBinding[];
  } = {},
) {
  const replies = [...(options.replies ?? [])];
  const sent: { apiKey: string | null; authorization: string | null; model: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const outbound = new Request(input, init);
    if (outbound.url !== DEVICE_MODEL_URL) throw new Error("Unexpected request");
    const body = (await outbound.json()) as { model: string };
    sent.push({
      apiKey: outbound.headers.get("x-api-key"),
      authorization: outbound.headers.get("authorization"),
      model: body.model,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("No synthetic reply queued");
    if (typeof reply === "number")
      return Response.json(
        { type: "error", error: { type: "api_error", message: "synthetic" } },
        { status: reply },
      );
    return Response.json({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3_000, output_tokens: 300 },
    });
  });
  let spend: unknown = options.spend;
  const model = createDeviceModel({
    storage: {
      read: async () => ("setting" in options ? options.setting : SETTING),
      write: async () => {},
      clear: async () => {},
    },
    spend: {
      read: async () => spend,
      write: async (value) => {
        spend = value;
      },
    },
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  let stored: unknown;
  const recipes = createDeviceRecipes({
    storage: {
      read: async () => structuredClone(stored),
      write: async (value) => {
        stored = structuredClone(value);
      },
      clear: async () => {
        stored = undefined;
      },
    },
    transport: { writeRecipe: vi.fn() },
  });
  let record: unknown;
  const backend = createDeviceGenerationBackend({
    recipes,
    storage: {
      read: async () => structuredClone(record),
      write: async (value) => {
        record = structuredClone(value);
      },
    },
    key: model.direct,
    bindings: async () => options.bindings ?? [],
  });
  const generation = createDeviceGeneration(backend);
  return {
    backend,
    generation,
    recipes,
    sent,
    spend: () => spend as DeviceModelSpend | undefined,
    record: () => record,
  };
}

describe("generation on a device without a pairing (ADR 0040)", () => {
  it("generates a recipe with this device's key and keeps it here", async () => {
    const { generation, recipes, sent, spend } = setup({ replies: [plan] });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({ kind: "result", result: { status: "recipe" } });
    if (answer.kind !== "result" || answer.result.status !== "recipe") throw new Error("no recipe");
    const { change } = answer.result;
    expect(change.revision).toBe(1);
    expect(await recipes.list()).toEqual([change.recipe]);
    // The key goes to Anthropic only, as its own header, with the default model.
    expect(sent).toEqual([{ apiKey: KEY, authorization: null, model: "claude-opus-5-5" }]);
    expect(spend()?.dayMicroUsd).toBeGreaterThan(0);

    // The same page answers with the recipe kept here, without another call.
    const again = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(again).toMatchObject({ kind: "result", result: { status: "recipe", change } });
    expect(sent).toHaveLength(1);
  });

  it("holds a page whose call failed for the retry window", async () => {
    const { generation, sent } = setup({ replies: [500] });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({
      kind: "result",
      result: { status: "failed", error: "provider-error" },
    });
    expect(sent).toHaveLength(1);
    // The attempt was recorded before the call, so the page waits out the retry window.
    const again = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(again).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "recently-tried" },
    });
    expect(sent).toHaveLength(1);
  });

  it("calls no model without a saved key", async () => {
    const { generation, sent, record } = setup({ setting: undefined });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "credentials-not-configured" },
    });
    expect(sent).toEqual([]);
    // Nothing was sent, so the page is not held.
    expect(record()).toBeUndefined();
  });

  it("stops at the key's spend limit", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { generation, sent } = setup({
      replies: [plan],
      spend: {
        version: 1,
        day,
        dayMicroUsd: 5_000_000,
        month: day.slice(0, 7),
        monthMicroUsd: 5_000_000,
      },
    });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "daily-limit" },
    });
    expect(sent).toEqual([]);
  });

  it("answers a request the routes refuse as an unexpected response", async () => {
    const { generation, sent } = setup({ replies: [plan] });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", {
      ...request,
      version: 2,
    } as unknown as RecipeGenerationRequest);
    expect(answer).toMatchObject({ kind: "failed", error: "unexpected-response" });
    expect(sent).toEqual([]);
  });

  it("reads the bindings of this device's settings for one recipe", async () => {
    const binding = {
      origin: page.origin,
      recipeId: "r1",
      slots: [{ slot: "email", field: "username" }],
    } as unknown as SavedLoginBinding;
    const other = { ...binding, recipeId: "r2" } as SavedLoginBinding;
    const { backend } = setup({ bindings: [binding, other] });
    expect(await backend.bindingSlots(page.origin, "r1")).toEqual([{ slots: binding.slots }]);
  });

  it("keeps judgements as the service's table does", async () => {
    const { backend } = setup();
    const key: JudgementKey = {
      recipeId: "gen_synthetic",
      branch: "1",
      revision: 2,
      origin: page.origin,
      path: "/home",
      promptVersion: "v2",
    };
    const stale = { expired: 1_000, versions: ["v2"] };
    await backend.recordJudgement({ ...key, revision: 1 }, 500, stale);
    await backend.recordJudgement({ ...key, promptVersion: "v1" }, 2_000, stale);
    await backend.recordJudgement(key, 2_000, stale);
    expect(await backend.judgement(key)).toEqual({ verdict: null });
    // An older revision judged before the day started is forgotten; today's row stays.
    expect(await backend.judgement({ ...key, revision: 1 })).toBeUndefined();
    expect(await backend.judgement({ ...key, promptVersion: "v1" })).toEqual({ verdict: null });
    expect(await backend.judgementsSince(key.recipeId, 1_000)).toBe(2);

    // A kept verdict stays; a `partial` one takes the slot again.
    await backend.keepVerdict(key, "signed-in");
    await backend.recordJudgement(key, 3_000, stale);
    expect(await backend.judgement(key)).toEqual({ verdict: "signed-in" });
    await backend.keepVerdict(key, "partial");
    await backend.recordJudgement(key, 3_000, stale);
    expect(await backend.judgement(key)).toEqual({ verdict: null });
  });

  it("keeps attempts and repairs within their windows", async () => {
    const { backend } = setup();
    const attempt = {
      recipeId: "gen_synthetic",
      branch: "",
      origin: page.origin,
      path: "/login",
      baseRevision: 0,
    };
    await backend.recordAttempt(attempt, 1_000, 0);
    expect(await backend.attemptedSince(attempt, 999)).toBe(true);
    expect(await backend.attemptedSince(attempt, 1_000)).toBe(false);
    // Another attempt forgets those made before its window.
    await backend.recordAttempt({ ...attempt, path: "/other" }, 5_000, 2_000);
    expect(await backend.attemptedSince(attempt, 0)).toBe(false);

    await backend.recordRepair("gen_synthetic", 1, 1_000, 0);
    expect(await backend.repairedSince("gen_synthetic", 1_000)).toBe(true);
    expect(await backend.repairedSince("gen_synthetic", 1_001)).toBe(false);
  });

  it("writes a recipe only over the revision it expects", async () => {
    const { generation, backend } = setup({ replies: [plan] });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    if (answer.kind !== "result" || answer.result.status !== "recipe") throw new Error("no recipe");
    const { change } = answer.result;
    const written = await backend.writeRecipe(
      change.recipeId,
      { version: 1, state: "active", expectedRevision: 0, recipe: change.recipe },
      {},
    );
    expect(written).toEqual({ ok: false, limited: false, current: change });
  });
});

describe("the connection generation runs under (ADR 0040)", () => {
  const paired = {
    origin: "https://pateat.example.com",
    deviceId: "device-1",
    credential: "synthetic",
    rejected: false,
  };

  it("is the paired service's", async () => {
    expect(
      await generationConnection(
        async () => paired,
        async () => true,
      ),
    ).toBe(paired);
  });

  it("is this device's own without a pairing while a key is saved", async () => {
    expect(
      await generationConnection(
        async () => undefined,
        async () => true,
      ),
    ).toMatchObject({ origin: DEVICE_GENERATION_ORIGIN, rejected: false });
    expect(
      await generationConnection(
        async () => undefined,
        async () => false,
      ),
    ).toBeUndefined();
  });
});
