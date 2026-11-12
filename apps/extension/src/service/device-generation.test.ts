import {
  DEVICE_MODEL_URL,
  OPENAI_DEVICE_MODEL_URL,
  isLoginRecipeDocument,
  type LoginObservation,
  type RecipeGenerationRequest,
  type SavedLoginBinding,
} from "@pateat/contracts";
import type { JudgementKey, JudgementReservation } from "@pateat/generation";
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceGeneration,
  createDeviceGenerationBackend,
  DEVICE_GENERATION_ORIGIN,
  generationConnection,
} from "./device-generation";
import {
  createDeviceModel,
  type DeviceClefSetting,
  type DeviceModelSetting,
  type DeviceModelSpend,
} from "./device-model";
import { createDeviceRecipes } from "./device-recipes";

// A synthetic key, pages and Anthropic; nothing leaves the test.

const KEY = "sk-ant-synthetic-0000-abcd";
const SETTING: DeviceModelSetting = {
  version: 1,
  provider: "anthropic",
  apiKey: KEY,
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

const CLEF: DeviceClefSetting = {
  version: 1,
  accountId: "0123456789abcdef0123456789abcdef",
  apiToken: "synthetic-cloudflare-token",
};
const CLEF_URL =
  "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef";
/** Clef's answers for `page` by Clef-safe question ID; unlisted choices answer none. */
const truth: Record<string, string> = {
  "el.email": "s:email",
  "el.password": "s:password",
  "slot.email": "c:email",
  "slot.password": "c:password",
  action: "c:sign-in",
};
/** Workers AI's answer to a Clef call, with `confidence` on each right choice. */
function clefAnswer(
  questions: Record<string, { criteria?: Record<string, unknown> }>,
  confidence: number,
) {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.criteria === undefined) {
      answers[id] = { type: "noul", noul: id === "signin" ? 0.95 : 0.05 };
      continue;
    }
    const options = Object.keys(question.criteria);
    const choice = truth[id] ?? "none";
    const rest = Math.round(((1 - confidence) / (options.length - 1)) * 10_000) / 10_000;
    answers[id] = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        options.map((option) => [option, option === choice ? confidence : rest]),
      ),
    };
  }
  return {
    success: true,
    result: { model: "clef", answers, usage: { input_tokens: 1_000, output_tokens: 0 } },
  };
}

/** A text answer, a refusal, or an HTTP error status. */
type Reply = string | number | { refusal: string };

function setup(
  options: {
    setting?: DeviceModelSetting | undefined;
    /** This device's Cloudflare token for Clef, and how Clef answers: its confidence or a status. */
    clef?: { setting: DeviceClefSetting; confidence?: number; status?: number };
    spend?: DeviceModelSpend;
    replies?: Reply[];
    bindings?: SavedLoginBinding[];
    paired?: boolean;
    /** Runs while a model call is in flight, before its answer. */
    during?: () => Promise<void>;
    writeSpend?: () => Promise<void>;
    now?: () => number;
  } = {},
) {
  const replies = [...(options.replies ?? [])];
  const wire: Request[] = [];
  const sent: { apiKey: string | null; authorization: string | null; model: string }[] = [];
  const clefSent: { authorization: string | null }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const outbound = new Request(input, init);
    if (outbound.url === CLEF_URL && options.clef) {
      clefSent.push({ authorization: outbound.headers.get("authorization") });
      if (options.clef.status !== undefined)
        return Response.json({ success: false, errors: [] }, { status: options.clef.status });
      const body = (await outbound.json()) as {
        questions: Record<string, { criteria?: Record<string, unknown> }>;
      };
      return Response.json(clefAnswer(body.questions, options.clef.confidence ?? 0.9));
    }
    const openai = options.setting?.provider === "openai";
    if (outbound.url !== (openai ? OPENAI_DEVICE_MODEL_URL : DEVICE_MODEL_URL))
      throw new Error("Unexpected request");
    wire.push(outbound.clone());
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
    if (openai)
      return Response.json({
        id: "resp_synthetic",
        model: body.model,
        output: [
          {
            type: "message",
            id: "msg_synthetic",
            role: "assistant",
            content:
              typeof reply === "object"
                ? [{ type: "refusal", refusal: "Synthetic refusal" }]
                : [{ type: "output_text", text: reply, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 12_000,
          output_tokens: 100,
          input_tokens_details: {
            cached_tokens: 4_000,
            cache_write_tokens: 7_000,
            cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
          },
          output_tokens_details: { reasoning_tokens: 80 },
        },
      });
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
    limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
    storage: {
      read: async () => ("setting" in options ? options.setting : SETTING),
      write: async () => {},
      clear: async () => {},
    },
    clef: { read: async () => options.clef?.setting },
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
    ...(options.now ? { now: options.now } : {}),
  });
  const generation = createDeviceGeneration(backend);
  return {
    backend,
    generation,
    recipes,
    sent,
    wire,
    clefSent,
    spend: () => spend as DeviceModelSpend | undefined,
    record: () => record,
  };
}

describe("OpenAI generation on a device without a pairing", () => {
  const setting: DeviceModelSetting = {
    version: 1,
    provider: "openai",
    apiKey: "synthetic-openai-local-key",
  };

  it("generates locally through the actual Responses SDK with the provider's own defaults", async () => {
    const { generation, recipes, sent, wire, record, spend } = setup({ setting, replies: [plan] });
    const result = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(result).toMatchObject({ kind: "result", result: { status: "recipe" } });
    expect(sent).toEqual([
      { apiKey: null, authorization: `Bearer ${setting.apiKey}`, model: "gpt-6.1-sol" },
    ]);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.url).toBe(OPENAI_DEVICE_MODEL_URL);
    const body = await wire[0]!.json();
    expect(body).toMatchObject({
      model: "gpt-6.1-sol",
      store: false,
      service_tier: "default",
      reasoning: { effort: "low" },
    });
    expect(body.reasoning).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("tools");
    expect(spend()?.dayMicroUsd).toBe(30_900);
    expect(JSON.stringify([result, await recipes.list(), record(), spend()])).not.toContain(
      setting.apiKey,
    );
    expect(await recipes.list()).toHaveLength(1);
  });

  it("falls back from Sol to Terra after refusal with the same OpenAI credential", async () => {
    const { generation, sent } = setup({ setting, replies: [{ refusal: "synthetic" }, plan] });
    expect(await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request)).toMatchObject({
      kind: "result",
      result: { status: "recipe" },
    });
    expect(sent.map((entry) => [entry.model, entry.authorization, entry.apiKey])).toEqual([
      ["gpt-6.1-sol", `Bearer ${setting.apiKey}`, null],
      ["gpt-6.1-terra", `Bearer ${setting.apiKey}`, null],
    ]);
  });

  it("returns a provider failure without trying Anthropic or writing a recipe", async () => {
    const { generation, recipes, sent } = setup({ setting, replies: [429] });
    expect(await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request)).toMatchObject({
      kind: "result",
      result: { status: "failed", error: "rate-limited" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe("gpt-6.1-sol");
    expect(await recipes.list()).toEqual([]);
  });

  it.each([0.9, 0.6])(
    "preserves independent Clef first choice at confidence %s",
    async (confidence) => {
      const { generation, sent, clefSent } = setup({
        setting,
        replies: [plan],
        clef: { setting: CLEF, confidence },
      });
      expect(await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request)).toMatchObject({
        kind: "result",
        result: { status: "recipe" },
      });
      expect(clefSent).toHaveLength(2);
      expect(clefSent.every((entry) => entry.authorization === `Bearer ${CLEF.apiToken}`)).toBe(
        true,
      );
      expect(sent).toHaveLength(confidence === 0.9 ? 0 : 1);
      if (sent.length) expect(sent[0]?.model).toBe("gpt-6.1-sol");
    },
  );
});

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

  it("keeps claim-bound judgements and counts each replacement separately", async () => {
    const { backend } = setup({ now: () => 2_000 });
    const key: JudgementKey = {
      recipeId: "gen_synthetic",
      branch: "1",
      revision: 2,
      origin: page.origin,
      path: "/home",
      promptVersion: "v2",
    };
    const stale = { expired: 1_000, versions: ["v2"] };
    const claim = (): JudgementReservation => ({
      id: crypto.randomUUID(),
      startedAt: 2_000,
      fingerprint: "synthetic",
    });
    const first = claim();
    expect((await backend.reserveJudgement(key, 2_000, stale, "a1", first)).status).toBe("taken");
    expect((await backend.reserveJudgement(key, 2_000, stale, "b2", claim())).status).toBe("held");
    expect(await backend.judgement(key)).toEqual({ verdict: null, inputs: "a1" });
    await backend.keepVerdict(key, "partial", first.id);
    await backend.finishJudgement(key, first);
    const second = claim();
    expect((await backend.reserveJudgement(key, 2_000, stale, "b2", second)).status).toBe("taken");
    await backend.keepVerdict(key, "signed-in", first.id);
    expect(await backend.judgement(key)).toEqual({ verdict: null, inputs: "b2" });
    await backend.keepVerdict(key, "challenge", second.id);
    await backend.finishJudgement(key, second);
    expect((await backend.reserveJudgement(key, 2_000, stale, "b2", claim())).status).toBe("held");
    const third = claim();
    expect((await backend.reserveJudgement(key, 2_000, stale, "a1", third)).status).toBe("taken");
    await backend.keepVerdict(key, "unclear", third.id);
    await backend.finishJudgement(key, third);
    expect((await backend.reserveJudgement(key, 2_000, stale, "a1", claim())).status).toBe("held");
    expect((await backend.reserveJudgement(key, 2_000, stale, "b2", claim())).status).toBe("taken");
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

  it("sends nothing when the write before the first call stops the request", async () => {
    const { backend, sent, spend } = setup({ replies: [plan] });
    // As a judge request that finds another one's row (ADR 0018).
    const generation = createDeviceGeneration({
      ...backend,
      call: (call) => backend.call({ ...call, beforeSend: async () => "judgement-unanswered" }),
    });
    expect(await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request)).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "judgement-unanswered" },
    });
    expect(sent).toEqual([]);
    expect(spend()).toBeUndefined();
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
    const { backend } = setup({ now: () => 2_000 });
    const key: JudgementKey = {
      recipeId: "gen_synthetic",
      branch: "1",
      revision: 1,
      origin: page.origin,
      path: "/account",
      promptVersion: "v2",
    };
    const claim = { id: crypto.randomUUID(), startedAt: 2_000, fingerprint: "synthetic" };
    await backend.reserveJudgement(key, 2_000, { expired: 1_000, versions: ["v2"] }, "a1", claim);
    await backend.keepVerdict(key, "rejected", claim.id);
    await backend.forget();
    expect(await backend.judgement(key)).toBeUndefined();
  });

  it("keeps the last use of a layout the recipe has, and drops it with the layout", async () => {
    const { generation, backend } = setup({ replies: [plan] });
    const change = await recipeOf(generation);
    if (change.state !== "active" || !isLoginRecipeDocument(change.recipe))
      throw new Error("no layouts");
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

describe("Clef first with this device's Cloudflare token (ADR 0083)", () => {
  it("keeps Clef's answer without asking Claude, charging both calls to the device", async () => {
    const { generation, recipes, sent, clefSent, spend } = setup({ clef: { setting: CLEF } });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({ kind: "result", result: { status: "recipe" } });
    expect(await recipes.list()).toHaveLength(1);
    expect(sent).toEqual([]);
    // The token goes to the account's Clef URL only, as a bearer token, once per call.
    expect(clefSent).toEqual([
      { authorization: `Bearer ${CLEF.apiToken}` },
      { authorization: `Bearer ${CLEF.apiToken}` },
    ]);
    // Two calls of 1,000 input tokens at $0.24 per million.
    expect(spend()).toMatchObject({ dayMicroUsd: 480, monthMicroUsd: 480 });
  });

  it("asks Claude when Clef abstains, charging both", async () => {
    const { generation, sent, clefSent, spend } = setup({
      clef: { setting: CLEF, confidence: 0.6 },
      replies: [plan],
    });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({ kind: "result", result: { status: "recipe" } });
    expect(clefSent).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(spend()!.dayMicroUsd).toBeGreaterThan(480);
  });

  it("asks Claude when Workers AI refuses the token, charging nothing for Clef", async () => {
    const { generation, sent, clefSent } = setup({
      clef: { setting: CLEF, status: 403 },
      replies: [plan],
    });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({ kind: "result", result: { status: "recipe" } });
    expect(clefSent.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  it("leaves a page the device saw signed in to Claude", async () => {
    const { generation, sent, clefSent } = setup({ clef: { setting: CLEF }, replies: [plan] });
    await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", { ...request, signedIn: true });
    expect(clefSent).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("asks no model without an Anthropic key, even with a Cloudflare token", async () => {
    const { generation, sent, clefSent } = setup({ setting: undefined, clef: { setting: CLEF } });
    const answer = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(answer).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "credentials-not-configured" },
    });
    expect(clefSent).toEqual([]);
    expect(sent).toEqual([]);
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

describe("standalone label-only SSO generation", () => {
  const ssoRequest = {
    version: 1 as const,
    kind: "sso" as const,
    labels: ["Example"],
    observation: {
      ...page,
      candidates: [
        ...page.candidates,
        {
          id: "provider",
          role: "button" as const,
          label: "Continue with Example",
          target: { by: "id" as const, value: "provider" },
        },
      ],
    },
  };
  const ssoPlan = JSON.stringify({
    result: {
      decision: "plan",
      page: "sign-in",
      entries: [{ label: "Example", candidate: "provider" }],
    },
  });

  it("keeps SSO and native siblings with no SSO slot mapping", async () => {
    const { generation, recipes, sent } = setup({ replies: [ssoPlan, plan] });
    const sso = await generation.generateSso(DEVICE_GENERATION_ORIGIN, "", ssoRequest);
    expect(sso).toMatchObject({
      kind: "result",
      result: { status: "recipe", change: { revision: 1 } },
    });
    expect(sso).not.toHaveProperty("result.slots");
    expect(sso).not.toHaveProperty("result.slotMap");
    const native = await generation.generateRecipe(DEVICE_GENERATION_ORIGIN, "", request);
    expect(native).toMatchObject({
      kind: "result",
      result: { status: "recipe", change: { revision: 2 } },
    });
    expect(await recipes.list()).toEqual([
      expect.objectContaining({
        layouts: expect.any(Array),
        sso: {
          path: "/login",
          layouts: [
            expect.objectContaining({
              entries: [{ label: "Example", target: { by: "id", value: "provider" } }],
            }),
          ],
        },
      }),
    ]);
    expect(sent).toHaveLength(2);
  });

  it("validates label-only requests before making a call or writing an attempt", async () => {
    const { generation, sent, record } = setup();
    expect(
      await generation.generateSso(DEVICE_GENERATION_ORIGIN, "", {
        ...ssoRequest,
        slots: request.slots,
      } as typeof ssoRequest),
    ).toMatchObject({ kind: "failed", error: "unexpected-response" });
    expect(sent).toHaveLength(0);
    expect(record()).toBeUndefined();
  });

  it("keeps credential and spending gates for SSO-only pages", async () => {
    const missing = setup({ setting: undefined });
    expect(
      await missing.generation.generateSso(DEVICE_GENERATION_ORIGIN, "", ssoRequest),
    ).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "credentials-not-configured" },
    });
    expect(missing.sent).toHaveLength(0);
    const day = new Date().toISOString().slice(0, 10);
    const limited = setup({
      spend: {
        version: 1,
        day,
        dayMicroUsd: 5_000_000,
        month: day.slice(0, 7),
        monthMicroUsd: 5_000_000,
      },
    });
    expect(
      await limited.generation.generateSso(DEVICE_GENERATION_ORIGIN, "", ssoRequest),
    ).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "daily-limit" },
    });
    expect(limited.sent).toHaveLength(0);
  });
});
