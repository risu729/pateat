import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_MODEL_URL,
  type LoginObservation,
  type SsoCompletionRequest,
  type SsoRecipeDocument,
} from "@pateat/contracts";
import { generatedRecipeId } from "@pateat/generation";
import { createDeviceGeneration, createDeviceGenerationBackend } from "./device-generation";
import { createDeviceRecipes } from "./device-recipes";
import { createDeviceModel, type DeviceModelSetting } from "./device-model";

const origin = "https://rp.example.test";
const page: LoginObservation = {
  version: 1,
  origin,
  path: "/home",
  language: "en",
  complete: true,
  candidates: [
    { id: "logout", role: "button", target: { by: "id", value: "logout" }, label: "Sign out" },
  ],
};
type Reply = { decision: string; marker?: string } | { refusal: string } | number;
async function setup(supplied: Reply[] = [{ decision: "signed-in", marker: "logout" }]) {
  const replies = [...supplied];
  const key = "sk-ant-synthetic-sso-completion";
  const calls: {
    url: string;
    body: Record<string, unknown>;
    authorization: string | null;
    apiKey: string | null;
  }[] = [];
  let spend: unknown;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(DEVICE_MODEL_URL);
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({
      url: request.url,
      body,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("No synthetic model reply was queued");
    if (typeof reply === "number")
      return Response.json(
        { type: "error", error: { type: "api_error", message: "Synthetic" } },
        { status: reply },
      );
    if ("refusal" in reply)
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body["model"],
        content: [],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: reply.refusal,
          explanation: "Synthetic refusal",
        },
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    const text = JSON.stringify({ result: reply });
    return Response.json({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: body["model"],
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 100 },
    });
  });
  const setting: DeviceModelSetting = { version: 1, apiKey: key };
  const model = createDeviceModel({
    storage: { read: async () => setting, write: async () => {}, clear: async () => {} },
    spend: {
      read: async () => spend,
      write: async (value) => {
        spend = value;
      },
    },
    limits: async () => ({ dailyUsd: 5, monthlyUsd: 100 }),
    fetch,
  });
  let recipeStore: unknown;
  const recipes = createDeviceRecipes({
    storage: {
      read: async () => structuredClone(recipeStore),
      write: async (value) => {
        recipeStore = structuredClone(value);
      },
      clear: async () => {
        recipeStore = undefined;
      },
    },
    transport: { writeRecipe: vi.fn() },
  });
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
    layouts: [
      {
        key: "2000",
        createdAt: 2000,
        pageKind: "sign-in",
        slots: ["password"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/signin",
            fields: [{ slot: "password", target: { by: "id", value: "password" } }],
          },
          {
            kind: "click",
            path: "/signin",
            target: { by: "id", value: "native-submit" },
            purpose: "submit",
          },
        ],
        completion: [{ target: { by: "id", value: "native-authenticated" } }],
        maxSubmissions: 1,
      },
    ],
  };
  expect(
    await recipes.write(recipeId, { version: 1, state: "active", expectedRevision: 0, recipe }),
  ).toMatchObject({ ok: true });
  let record: unknown;
  const restart = () =>
    createDeviceGenerationBackend({
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
      bindings: async () => [],
      paired: async () => false,
    });
  const backend = restart();
  const generation = createDeviceGeneration(backend);
  const request: SsoCompletionRequest = {
    version: 1,
    kind: "sso-completion",
    revision: 1,
    layout: "1000",
    observation: page,
  };
  const judge = (value: SsoCompletionRequest = request) =>
    generation.judgeCompletion("https://device-generation.invalid", "", recipeId, value);
  return {
    backend,
    generation,
    recipes,
    recipe,
    recipeId,
    request,
    judge,
    calls,
    key,
    fetch,
    restart,
    record: () =>
      structuredClone(record) as { judgements: { verdict: string | null }[] } | undefined,
  };
}

describe("SSO completion through the real device backend and model adapters", () => {
  it("learns only a fresh per-layout RP marker", async () => {
    const h = await setup();
    expect(await h.judge()).toMatchObject({
      kind: "result",
      result: { status: "signed-in", change: { state: "active", revision: 2 } },
    });
    const head = await h.recipes.head(h.recipeId);
    expect(head).toMatchObject({
      revision: 2,
      sso: { layouts: [{ completion: [{ target: { by: "id", value: "logout" } }] }] },
    });
    expect(head && "layouts" in head ? head.layouts : undefined).toEqual(h.recipe.layouts);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.body["model"]).toMatch(/^claude-/u);
    expect(h.calls[0]!.apiKey).toBe(h.key);
    expect(JSON.stringify(h.calls[0]!.body)).not.toMatch(
      /sourceEvidence|usernameProof|idp-vault|synthetic@example/u,
    );
    expect(h.record()?.judgements.map((row) => row.verdict)).toEqual(["signed-in"]);
  });
  it.each([
    { decision: "challenge", status: "challenge" },
    { decision: "optional", status: "unclear" },
    { decision: "unclear", status: "unclear" },
    { decision: "rejected", status: "rejected" },
  ])(
    "never turns $decision into authentication or a learned marker",
    async ({ decision, status }) => {
      const h = await setup([{ decision }]);
      expect(await h.judge()).toMatchObject({ kind: "result", result: { status } });
      expect(await h.recipes.head(h.recipeId)).toEqual(h.recipe);
      expect(h.calls).toHaveLength(1);
      expect(h.record()?.judgements).toHaveLength(1);
    },
  );
  it.each(["Authorize access", "Share email", "Create account"])(
    "refuses %s before any model call or quota reservation",
    async (title) => {
      const h = await setup();
      expect(await h.judge({ ...h.request, observation: { ...page, title } })).toMatchObject({
        kind: "result",
        result: { status: "unavailable", reason: "not-judgeable" },
      });
      expect(h.calls).toEqual([]);
      expect(h.record()?.judgements ?? []).toEqual([]);
    },
  );
  it.each([
    {
      id: "entry",
      role: "button" as const,
      label: "Synthetic",
      target: { by: "id" as const, value: "provider" },
    },
    {
      id: "password",
      role: "password" as const,
      label: "Password",
      target: { by: "id" as const, value: "password" },
    },
  ])(
    "does not call the model while original SSO entry or native credential field $id is present",
    async (candidate) => {
      const h = await setup();
      expect(
        await h.judge({ ...h.request, observation: { ...page, candidates: [candidate] } }),
      ).toMatchObject({
        kind: "result",
        result: { status: "unavailable", reason: "not-judgeable" },
      });
      expect(h.calls).toEqual([]);
      expect(h.record()?.judgements ?? []).toEqual([]);
    },
  );
  it("keeps one judgement of the page across the model fallback", async () => {
    const h = await setup([{ refusal: "cyber" }, { decision: "signed-in", marker: "logout" }]);
    expect(await h.judge()).toMatchObject({ kind: "result", result: { status: "signed-in" } });
    expect(h.calls.length).toBeGreaterThan(1);
    expect(h.record()?.judgements.map((row) => row.verdict)).toEqual(["signed-in"]);
  });
  it("a repeated optional-page request stays judged once across a backend restart", async () => {
    const h = await setup([{ decision: "optional" }]);
    expect(await h.judge()).toMatchObject({ kind: "result", result: { status: "unclear" } });
    const restarted = createDeviceGeneration(h.restart());
    expect(
      await restarted.judgeCompletion(
        "https://device-generation.invalid",
        "",
        h.recipeId,
        h.request,
      ),
    ).toMatchObject({
      kind: "result",
      result: { status: "unavailable", reason: "already-judged" },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.record()?.judgements).toHaveLength(1);
  });
});
