import type {
  LoginObservation,
  ObservedCandidate,
  RecipeGenerationResult,
  SemanticSlot,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { fieldDecisionPromptVersion, generationPromptVersion } from "@pateat/inference";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";

// Clef first, Claude when Clef abstains (ADR 0083). Synthetic owners and pages only: the
// Workers AI binding, Anthropic's token endpoint and the Messages API are answered
// locally, and no request leaves the test.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const slots: SemanticSlot[] = [
  { id: "email", kind: "identifier", description: "account email address" },
  { id: "password", kind: "secret", description: "account password" },
];
const element = (id: string, role: ObservedCandidate["role"], label: string) => ({
  id,
  role,
  target: { by: "id" as const, value: id },
  label,
});
const page: LoginObservation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [
    element("email", "email", "Email"),
    element("password", "password", "Password"),
    element("sign-in", "button", "Sign in"),
  ],
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

/** Clef's answers for the page by Clef-safe question ID; unlisted choices answer none. */
const truth: Record<string, string> = {
  "el.email": "s:email",
  "el.password": "s:password",
  "slot.email": "c:email",
  "slot.password": "c:password",
  action: "c:sign-in",
};
type Run = { model: string; input: { questions: Record<string, { criteria?: object }> } };
let runs: Run[] = [];
/** The probability Clef puts on each choice, and what the binding does instead. */
let clef: { confidence: number; fail?: true; usage?: object } = { confidence: 0.9 };
const ai = {
  run: async (model: string, input: unknown) => {
    const call = input as Run["input"];
    runs.push({ model, input: call });
    if (clef.fail) throw new Error("synthetic Workers AI failure");
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(call.questions)) {
      if (question.criteria === undefined) {
        answers[id] = { type: "noul", noul: id === "signin" ? 0.95 : 0.05 };
        continue;
      }
      const options = Object.keys(question.criteria);
      const choice = truth[id] ?? "none";
      const rest = Math.round(((1 - clef.confidence) / (options.length - 1)) * 10_000) / 10_000;
      answers[id] = {
        type: "choice",
        choice,
        probabilities: Object.fromEntries(
          options.map((option) => [option, option === choice ? clef.confidence : rest]),
        ),
        confidence: 0.5,
      };
    }
    return {
      model: "clef",
      answers,
      usage: clef.usage ?? { input_tokens: 1_000, output_tokens: 0 },
    };
  },
};

let messages = 0;
const originalFetch = globalThis.fetch;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === TOKEN_URL)
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        expires_in: 600,
      });
    if (outbound.url === MESSAGES_URL) {
      messages += 1;
      const body = (await outbound.json()) as { model: string };
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: plan }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3_000, output_tokens: 900 },
      });
    }
    return originalFetch(input, init);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});
const bindings = env as unknown as { AI?: unknown };
beforeEach(() => {
  runs = [];
  messages = 0;
  clef = { confidence: 0.9 };
  bindings.AI = ai;
});
afterEach(() => {
  delete bindings.AI;
});

async function owner() {
  const ownerId = crypto.randomUUID();
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
      ownerId,
      ownerId,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, ownerId, ownerId, await hashDeviceToken(token), Date.now(), Date.now()),
  ]);
  await saveWifCredential(env.DB, ownerId, {
    federationRuleId: "fdrl_01SyntheticRule",
    organizationId: "00000000-0000-4000-8000-000000000000",
    serviceAccountId: "svac_01SyntheticAccount",
    workspaceId: "wrkspc_01SyntheticWorkspace",
  });
  return { ownerId, token };
}

async function generate(device: { token: string }, extra: Record<string, unknown> = {}) {
  const response = await exports.default.fetch("https://pateat.invalid/v1/recipes/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    // A first page carries the signedIn hint (ADR 0035).
    body: JSON.stringify({ version: 1, observation: page, slots, signedIn: false, ...extra }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}

const logRows = (ownerId: string) =>
  env.DB.prepare(
    `SELECT provider, model_id, effort, speed, prompt_version, outcome, input_tokens,
        cost_micro_usd, page_kind, irreversible
      FROM inference_log WHERE owner_id = ? ORDER BY created_at, provider DESC`,
  )
    .bind(ownerId)
    .all()
    .then(({ results }) => results);
const spent = (ownerId: string) =>
  env.DB.prepare(
    "SELECT calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? AND length(period) = 10",
  )
    .bind(ownerId)
    .first();

describe("Clef first for sign-in forms (ADR 0083)", () => {
  it("stores Clef's answer without asking Claude, and logs and charges both calls", async () => {
    const device = await owner();
    const result = await generate(device);
    expect(result.status).toBe("recipe");
    expect(messages).toBe(0);
    expect(runs.map(({ model }) => model)).toEqual(["@cf/cloudflare/clef", "@cf/cloudflare/clef"]);
    // Two calls of 1,000 input tokens at $0.24 per million.
    expect(await logRows(device.ownerId)).toEqual([
      {
        provider: "cloudflare",
        model_id: "clef",
        effort: null,
        speed: null,
        prompt_version: await fieldDecisionPromptVersion(),
        outcome: "ok",
        input_tokens: 2_000,
        cost_micro_usd: 480,
        page_kind: "sign-in",
        irreversible: "no",
      },
    ]);
    expect(await spent(device.ownerId)).toEqual({ calls: 2, cost_micro_usd: 480 });
    const unit = await env.DB.prepare(
      "SELECT DISTINCT provider, model, prompt_version FROM recipe_unit_sources WHERE owner_id = ?",
    )
      .bind(device.ownerId)
      .all();
    expect(unit.results).toEqual([
      { provider: "cloudflare", model: "clef", prompt_version: await fieldDecisionPromptVersion() },
    ]);
  });

  it("asks Claude when Clef abstains, with a row for each", async () => {
    const device = await owner();
    clef = { confidence: 0.6 };
    expect((await generate(device)).status).toBe("recipe");
    expect(messages).toBe(1);
    const rows = await logRows(device.ownerId);
    expect(rows.map((row) => [row["provider"], row["outcome"], row["prompt_version"]])).toEqual([
      ["cloudflare", "abstained", await fieldDecisionPromptVersion()],
      ["anthropic", "ok", await generationPromptVersion()],
    ]);
  });

  it("asks Claude when the binding fails, charging Clef's calls at the worst case", async () => {
    const device = await owner();
    clef = { confidence: 0.9, fail: true };
    expect((await generate(device)).status).toBe("recipe");
    expect(messages).toBe(1);
    const [clefRow] = await logRows(device.ownerId);
    expect(clefRow).toMatchObject({ provider: "cloudflare", outcome: "provider-error" });
    // 63,488 bytes of input at $0.24 per million, for each call.
    expect(clefRow!["cost_micro_usd"]).toBe(2 * 15_238);
  });

  it("stops before Claude when Clef's calls reached the daily spend stop", async () => {
    const device = await owner();
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, day, 5_000_000 - 100)
      .run();
    clef = { confidence: 0.6 };
    expect(await generate(device)).toMatchObject({ status: "unavailable", reason: "daily-limit" });
    expect(runs).toHaveLength(2);
    expect(messages).toBe(0);
  });

  it("asks no model for an owner without a Claude credential", async () => {
    const device = await owner();
    await env.DB.prepare("DELETE FROM inference_credentials WHERE owner_id = ?")
      .bind(device.ownerId)
      .run();
    expect(await generate(device)).toMatchObject({
      status: "unavailable",
      reason: "credentials-not-configured",
    });
    expect(runs).toHaveLength(0);
  });

  it("leaves a page the device saw signed in to Claude without asking Clef", async () => {
    const device = await owner();
    expect((await generate(device, { signedIn: true })).status).toBe("recipe");
    expect(runs).toHaveLength(0);
    expect(messages).toBe(1);
  });

  it("asks Claude alone without the binding", async () => {
    delete bindings.AI;
    const device = await owner();
    expect((await generate(device)).status).toBe("recipe");
    expect(runs).toHaveLength(0);
    expect(messages).toBe(1);
  });
});
