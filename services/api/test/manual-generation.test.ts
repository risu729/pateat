import type { LoginObservation, RecipeGenerationResult, SemanticSlot } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";

// Explicit first-page retries from the popup (ADR 0088). Synthetic owners, devices and pages
// only; Anthropic's token endpoint and the Messages API are answered locally.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const slots: SemanticSlot[] = [
  { id: "email", kind: "identifier", description: "account email address" },
  { id: "password", kind: "secret", description: "account password" },
];
const emailPage: LoginObservation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [
    { id: "email", role: "email", target: { by: "id", value: "email" }, label: "Email" },
    { id: "next", role: "button", target: { by: "id", value: "next" }, label: "Next" },
  ],
};
const advance = JSON.stringify({
  result: {
    decision: "plan",
    pageKind: "sign-in",
    irreversible: "no",
    fields: [{ slot: "email", candidate: "email" }],
    action: { candidate: "next", purpose: "advance" },
  },
});

let replies: string[] = [];
let sent: unknown[] = [];
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
      const body = (await outbound.json()) as { model: string };
      sent.push(body);
      const text = replies.shift();
      if (text === undefined) throw new Error("No synthetic reply queued");
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text }],
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
beforeEach(() => {
  replies = [];
  sent = [];
});

type Device = { ownerId: string; token: string };
async function owner(): Promise<Device> {
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
async function generate(device: Device, manual = false) {
  const response = await exports.default.fetch("https://pateat.invalid/v1/recipes/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      observation: emailPage,
      slots,
      signedIn: false,
      ...(manual ? { manual: true } : {}),
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}
const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Record<string, unknown>>()
    .then((result) => result.results);
const attempts = (device: Device) =>
  rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId);

describe("explicit first-page retries from the popup", () => {
  it("retries a recent abstention while recording and charging the new call", async () => {
    const device = await owner();
    replies.push(JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }));
    expect(await generate(device)).toMatchObject({ status: "abstained" });
    expect(await generate(device)).toMatchObject({ reason: "recently-tried" });
    replies.push(advance);
    expect(await generate(device, true)).toMatchObject({ status: "recipe" });
    expect(sent).toHaveLength(2);
    expect(await attempts(device)).toEqual([{ path: "/login" }]);
    const spend = await rows(
      "SELECT calls FROM inference_spend WHERE owner_id = ?",
      device.ownerId,
    );
    expect(spend).toHaveLength(2);
    expect(spend.every((row) => row["calls"] === 2)).toBe(true);
  });

  it.each(["monthly", "daily"] as const)("keeps the %s spend limit", async (period) => {
    const device = await owner();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(
        device.ownerId,
        period === "monthly" ? now.slice(0, 7) : now.slice(0, 10),
        period === "monthly" ? 100_000_000 : 5_000_000,
      )
      .run();
    expect(await generate(device, true)).toMatchObject({
      status: "unavailable",
      reason: `${period}-limit`,
    });
    expect(sent).toEqual([]);
    expect(await attempts(device)).toEqual([]);
  });

  it("keeps the per-owner model concurrency limit", async () => {
    const device = await owner();
    // Every call slot (ADR 0018) is held by another request for the next minute.
    await env.DB.batch(
      [0, 1, 2, 3, 4].map((slot) =>
        env.DB.prepare(
          "INSERT INTO inference_locks (owner_id, slot, lock_id, expires_at) VALUES (?, ?, 'other', ?)",
        ).bind(device.ownerId, slot, Date.now() + 60_000),
      ),
    );
    expect(await generate(device, true)).toMatchObject({ status: "unavailable", reason: "busy" });
    expect(sent).toEqual([]);
    expect(await attempts(device)).toEqual([]);
  });
});
