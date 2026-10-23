import {
  deviceModelCallBody,
  deviceModelRequestHash,
  type DeviceModelResponse,
  type LoginObservation,
  type LogoutGenerationResult,
  type ObservedCandidate,
  type RecipeGenerationResult,
  type SemanticSlot,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import { CLAUDE_CALL_LIMITS } from "../src/claude/calls";
import { saveModelConfig } from "../src/claude/models";

// A paired device that makes the model calls with its own key (ADR 0040). Synthetic owners,
// devices and pages only; any request to Anthropic fails the test, since the service must
// never make a device's calls itself.

const ORIGIN = "https://shop.example.test";

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
const loginPage: LoginObservation = {
  version: 1,
  origin: ORIGIN,
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

let outbound = 0;
beforeAll(() => {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (new Request(input, init).url.startsWith("https://api.anthropic.com/")) {
      outbound += 1;
      throw new Error("The service sent a device's model call itself");
    }
    return originalFetch(input, init);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  outbound = 0;
});

type Device = { ownerId: string; token: string };

async function owner({ claude = false } = {}): Promise<Device> {
  const ownerId = `owner-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
      ownerId,
      ownerId,
    ),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      `device-${crypto.randomUUID()}`,
      ownerId,
      ownerId,
      await hashDeviceToken(token),
      Date.now(),
      Date.now(),
    ),
  ]);
  if (claude)
    await saveWifCredential(env.DB, ownerId, {
      federationRuleId: "fdrl_01SyntheticRule",
      organizationId: "00000000-0000-4000-8000-000000000000",
      serviceAccountId: "svac_01SyntheticAccount",
      workspaceId: "wrkspc_01SyntheticWorkspace",
    });
  return { ownerId, token };
}

async function generate(device: Device, responses: DeviceModelResponse[]) {
  const response = await exports.default.fetch("https://pateat.invalid/v1/recipes/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      observation: loginPage,
      slots,
      signedIn: false,
      deviceModel: { responses },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}

/** An account switch's signed-in page (ADR 0063), sent with the device's responses so far. */
async function logout(device: Device, responses: DeviceModelResponse[]) {
  const response = await exports.default.fetch("https://pateat.invalid/v1/recipes/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      observation: {
        version: 1,
        origin: ORIGIN,
        path: "/home",
        language: "en",
        complete: true,
        candidates: [
          { id: "c1", role: "link", target: { by: "text", value: "Orders" } },
          { id: "c2", role: "button", target: { by: "text", value: "Sign out" } },
        ],
      } satisfies LoginObservation,
      deviceModel: { responses },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as LogoutGenerationResult;
}

/** The model call a `model-call` answer names, which the test then answers. */
function modelCall(answer: RecipeGenerationResult | LogoutGenerationResult) {
  if (answer.status !== "model-call")
    throw new Error(`Expected a model call, got ${answer.status}`);
  // Every call the routes hand over is one a device sends with its key.
  expect(deviceModelCallBody(answer.call)).toBe(answer.call.body);
  return answer.call;
}

/** Anthropic's answer to `body`: the text, or a refusal. */
async function answered(
  body: string,
  reply: { text: string } | { refusal: string },
): Promise<DeviceModelResponse> {
  const { model } = JSON.parse(body) as { model: string };
  return {
    kind: "response",
    request: await deviceModelRequestHash(body),
    status: 200,
    body: JSON.stringify({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model,
      ...("refusal" in reply
        ? {
            content: [],
            stop_reason: "refusal",
            stop_details: { type: "refusal", category: reply.refusal, explanation: "synthetic" },
          }
        : { content: [{ type: "text", text: reply.text }], stop_reason: "end_turn" }),
      stop_sequence: null,
      usage: { input_tokens: 3_000, output_tokens: 900 },
    }),
  };
}

type Row = Partial<Record<"source" | "model_id" | "outcome", unknown>> & Record<string, unknown>;
const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Row>()
    .then((result) => result.results);
const logOf = (ownerId: string) =>
  rows(
    "SELECT source, model_id, outcome, input_tokens, output_tokens, cost_micro_usd, token_ms, model_ms FROM inference_log WHERE owner_id = ? ORDER BY created_at",
    ownerId,
  );

describe("model calls a paired device makes with its own key (ADR 0040)", () => {
  it("hands the call to the device, then writes the recipe from its response", async () => {
    // No credential on the service: the device's key is all the route needs.
    const device = await owner();
    const call = modelCall(await generate(device, []));
    expect(call.index).toBe(0);
    const sent = JSON.parse(call.body) as { model: string };
    expect(sent.model).toBe("claude-opus-5-5");
    // Only the provider's own headers; no key of the service's is ever handed over.
    expect(Object.keys(call.headers).toSorted()).toEqual(
      expect.arrayContaining(["anthropic-version", "content-type"]),
    );
    expect(call.body).not.toContain("device");
    // Nothing is reserved, charged or logged until the device answers.
    expect(await logOf(device.ownerId)).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);

    const answer = await generate(device, [await answered(call.body, { text: plan })]);
    expect(answer.status).toBe("recipe");
    if (answer.status !== "recipe") return;
    expect(answer.change.recipeId).toMatch(/^gen-/u);
    expect(answer.customSlots).toBeUndefined();

    expect(await logOf(device.ownerId)).toEqual([
      {
        source: "device",
        model_id: "claude-opus-5-5",
        outcome: "ok",
        input_tokens: 3_000,
        output_tokens: 900,
        cost_micro_usd: expect.any(Number),
        token_ms: null,
        model_ms: null,
      },
    ]);
    // The spend stops count the owner's credential only.
    expect(await rows("SELECT * FROM inference_spend WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toHaveLength(1);
    expect(outbound).toBe(0);
  });

  it("hands an account switch's logout call to the device, then stores its click", async () => {
    const device = await owner();
    const call = modelCall(await logout(device, []));
    expect(call.index).toBe(0);
    expect(await logOf(device.ownerId)).toEqual([]);
    const reply = JSON.stringify({
      result: { decision: "logout", control: "c2", purpose: "logout" },
    });
    const answer = await logout(device, [await answered(call.body, { text: reply })]);
    expect(answer.status).toBe("recipe");
    if (answer.status !== "recipe") return;
    expect(answer.change.recipe.logout.targets).toEqual([
      expect.objectContaining({ path: "/home", target: { by: "text", value: "Sign out" } }),
    ]);
    expect((await logOf(device.ownerId)).map((row) => [row.source, row.outcome])).toEqual([
      ["device", "ok"],
    ]);
    expect(await rows("SELECT * FROM inference_spend WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    expect(outbound).toBe(0);
  });

  it("asks the next model choice after a refusal, as with the owner's credential", async () => {
    const device = await owner();
    const first = modelCall(await generate(device, []));
    const refused = await answered(first.body, { refusal: "cyber" });
    const second = modelCall(await generate(device, [refused]));
    expect(second.index).toBe(1);
    expect((JSON.parse(second.body) as { model: string }).model).toBe("claude-sonnet-5-5");
    const answer = await generate(device, [refused, await answered(second.body, { text: plan })]);
    expect(answer.status).toBe("recipe");
    expect((await logOf(device.ownerId)).map((row) => [row.model_id, row.outcome])).toEqual([
      ["claude-opus-5-5", "refused"],
      ["claude-sonnet-5-5", "ok"],
    ]);
  });

  it("hands over a fast mode call, then the standard one after it is rate limited", async () => {
    const device = await owner();
    const choice = (model: string, speed: "standard" | "fast") => ({
      provider: "anthropic" as const,
      model,
      effort: "low" as const,
      speed,
    });
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [choice("claude-opus-5-5", "fast"), choice("claude-sonnet-5-5", "standard")],
      judge: [choice("claude-opus-5-5", "standard")],
    });
    const fast = modelCall(await generate(device, []));
    expect(JSON.parse(fast.body)).toMatchObject({ model: "claude-opus-5-5", speed: "fast" });
    expect(fast.headers["anthropic-beta"]).toContain("fast-mode");
    const limited: DeviceModelResponse = {
      kind: "response",
      request: await deviceModelRequestHash(fast.body),
      status: 429,
      body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } }),
    };
    const standard = modelCall(await generate(device, [limited]));
    expect(standard.index).toBe(1);
    expect(JSON.parse(standard.body)).toMatchObject({ model: "claude-opus-5-5" });
    expect(JSON.parse(standard.body)).not.toHaveProperty("speed", "fast");
    const answer = await generate(device, [limited, await answered(standard.body, { text: plan })]);
    expect(answer.status).toBe("recipe");
    expect((await logOf(device.ownerId)).map((row) => [row.source, row.outcome])).toEqual([
      ["device", "rate-limited"],
      ["device", "ok"],
    ]);
  });

  it("asks for the call again when the device answered another request body", async () => {
    const device = await owner();
    const call = modelCall(await generate(device, []));
    const stale = await answered(`${call.body} `, { text: plan });
    const again = modelCall(await generate(device, [stale]));
    expect(again).toEqual(call);
    expect(await logOf(device.ownerId)).toEqual([]);
  });

  it("logs a call the device's time limit ended as a timeout", async () => {
    const device = await owner();
    const call = modelCall(await generate(device, []));
    const answer = await generate(device, [
      { kind: "timeout", request: await deviceModelRequestHash(call.body) },
    ]);
    expect(answer).toEqual({ version: 1, status: "failed", error: "timeout" });
    expect((await logOf(device.ownerId)).map((row) => [row.source, row.outcome])).toEqual([
      ["device", "timeout"],
    ]);
  });

  it("is not stopped by the owner's spend stop, which counts the service's calls", async () => {
    const device = await owner({ claude: true });
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, today, CLAUDE_CALL_LIMITS.dailyMicroUsd)
      .run();
    expect((await generate(device, [])).status).toBe("model-call");
    expect(outbound).toBe(0);
  });

  it("refuses more responses than a request makes calls", async () => {
    const device = await owner();
    const call = modelCall(await generate(device, []));
    const response = await answered(call.body, { text: plan });
    const sent = await exports.default.fetch("https://pateat.invalid/v1/recipes/generate", {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        observation: loginPage,
        slots,
        signedIn: false,
        deviceModel: { responses: Array.from({ length: 7 }, () => response) },
      }),
    });
    expect(sent.status).toBe(400);
  });
});
