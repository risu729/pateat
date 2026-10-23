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

/** A text answer, a refusal, or an HTTP error status. */
type Reply = string | number | { refusal: string };

function setup(
  options: {
    setting?: DeviceModelSetting | undefined;
    spend?: DeviceModelSpend;
    replies?: Reply[];
    bindings?: SavedLoginBinding[];
    paired?: boolean;
    /** Runs while a model call is in flight, before its answer. */
    during?: () => Promise<void>;
    writeSpend?: () => Promise<void>;
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
    await options.during?.();
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
      ...(typeof reply === "object"
        ? {
            content: [],
            stop_reason: "refusal",
            stop_details: { type: "refusal", category: reply.refusal, explanation: "synthetic" },
          }
        : { content: [{ type: "text", text: reply }], stop_reason: "end_turn" }),
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
        await options.writeSpend?.();
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
      clear: async () => {
        record = undefined;
      },
    },
    key: model.direct,
    bindings: async () => options.bindings ?? [],
    paired: async () => options.paired ?? false,
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

  it("finds an account switch's logout control with this device's key and keeps it here (ADR 0063)", async () => {
    const reply = JSON.stringify({
      result: { decision: "logout", control: "c1", purpose: "logout" },
    });
    const { generation, recipes, sent } = setup({ replies: [reply] });
    const answer = await generation.generateLogout(DEVICE_GENERATION_ORIGIN, "", {
      version: 1,
      observation: {
        version: 1,
        origin: "https://shop.example.test",
        path: "/home",
        language: "en",
        complete: true,
        candidates: [{ id: "c1", role: "button", target: { by: "text", value: "Sign out" } }],
      },
    });
    if (answer.kind !== "result" || answer.result.status !== "recipe") throw new Error("no recipe");
    expect(answer.result.change.recipe.logout.targets).toEqual([
      expect.objectContaining({ path: "/home", target: { by: "text", value: "Sign out" } }),
    ]);
    expect(await recipes.list()).toEqual([answer.result.change.recipe]);
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

describe("the device's model calls (ADR 0040)", () => {
  const recipeOf = async (generation: ReturnType<typeof setup>["generation"]) => {
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    if (answer.kind !== "result" || answer.result.status !== "recipe") throw new Error("no recipe");
    return answer.result.change;
  };

  it("asks Sonnet 5.5 after Opus 5.5 refuses, and records the attempt once", async () => {
    const { generation, sent, record } = setup({ replies: [{ refusal: "cyber" }, plan] });
    await recipeOf(generation);
    expect(sent.map((call) => call.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect((record() as { attempts: unknown[] }).attempts).toHaveLength(1);
  });

  it("answers busy while another request's call runs, and frees the lock after it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inCall = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { generation } = setup({
      replies: [plan, plan],
      during: async () => {
        started();
        await held;
      },
    });
    const first = generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    await inCall;
    const other = { ...request, observation: { ...page, path: "/signin" } };
    expect(await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", other)).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "busy" },
    });
    release();
    expect(await first).toMatchObject({ kind: "result", result: { status: "recipe" } });
  });

  it("keeps an answer Anthropic charged when its spend cannot be written", async () => {
    const { generation } = setup({
      replies: [plan],
      writeSpend: async () => {
        throw new Error("storage full");
      },
    });
    await recipeOf(generation);
  });

  it("refuses a write that lands after a pairing", async () => {
    const { backend, recipes } = setup({ paired: true });
    const recipe = {
      ...(await recipeOf(setup({ replies: [plan] }).generation)).recipe,
    };
    expect(
      await backend.writeRecipe(
        recipe.id,
        { version: 1, state: "active", expectedRevision: 0, recipe },
        {},
      ),
    ).toEqual({ ok: false, limited: false, current: null });
    expect(await recipes.list()).toEqual([]);
  });

  it("forgets its judgements when the recipes they describe are replaced", async () => {
    const { backend } = setup();
    const key: JudgementKey = {
      recipeId: "gen_synthetic",
      branch: "1",
      revision: 1,
      origin: page.origin,
      path: "/account",
      promptVersion: "v2",
    };
    await backend.recordJudgement(key, 2_000, { expired: 1_000, versions: ["v2"] });
    await backend.keepVerdict(key, "rejected");
    await backend.forget();
    expect(await backend.judgement(key)).toBeUndefined();
  });

  it("keeps the last use of a layout the recipe has, and drops it with the layout", async () => {
    const { generation, backend } = setup({ replies: [plan] });
    const change = await recipeOf(generation);
    if (change.state !== "active" || !("layouts" in change.recipe)) throw new Error("no layouts");
    const layout = change.recipe.layouts[0]!.key;
    await backend.markLayoutUsed(change.recipeId, "999");
    expect(await backend.layoutUses(change.recipeId)).toBeUndefined();
    await backend.markLayoutUsed(change.recipeId, layout);
    expect([...((await backend.layoutUses(change.recipeId)) ?? new Map()).keys()]).toEqual([
      layout,
    ]);
    // A write whose recipe no longer has the layout drops its use.
    const without = {
      ...change.recipe,
      revision: 2,
      layouts: change.recipe.layouts.map((entry) => ({ ...entry, key: "1" })),
    };
    const written = await backend.writeRecipe(
      change.recipeId,
      { version: 1, state: "active", expectedRevision: 1, recipe: without as typeof change.recipe },
      {},
    );
    expect(written.ok).toBe(true);
    expect(await backend.layoutUses(change.recipeId)).toBeUndefined();
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
