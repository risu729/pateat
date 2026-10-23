import {
  isLoginRouteRecipe,
  MAX_ACTIVE_RECIPE_BYTES,
  type EntryGenerationResult,
  type LoginObservation,
  type LoginRecipe,
  type ObservedCandidate,
  type RecipeCompletionResult,
  type RecipeGenerationResult,
  type SemanticSlot,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import {
  accountListGenerationInstructions,
  accountListGenerationPromptVersion,
  completionInstructions,
  completionPromptVersion,
  completionStopPromptVersion,
  entryGenerationInstructions,
  entryGenerationPromptVersion,
  entryInstruction,
  generationInstructions,
  generationPromptVersion,
  passkeyOnlyGenerationInstructions,
  passkeyOnlyGenerationPromptVersion,
} from "@pateat/inference";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import { MAX_ACTIVE_RECIPES } from "../src/limits";
import { writeRecipe } from "../src/recipe-store";
import { documentBytes, seedRecipeBytes, storedRecipeBytes } from "./recipe-byte-helpers";
import {
  ATTEMPT_WINDOW_MS,
  generatedRecipeId,
  MIN_GENERATION_RECIPE_ROOM_BYTES,
  staleHead,
} from "../src/recipes/generate";

// Synthetic owners, devices, federation identifiers and pages only. Anthropic's token
// endpoint and the Messages API are answered locally; no request leaves the test.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ORIGIN = "https://shop.example.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVED = 64 * 1024 * 4 + 1_024 * 20;

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
const observation = (
  path: string,
  candidates: ObservedCandidate[],
  origin = ORIGIN,
): LoginObservation => ({
  version: 1,
  origin,
  path,
  language: "en",
  complete: true,
  candidates,
});
const emailPage = observation("/login", [
  element("email", "email", "Email"),
  element("next", "button", "Next"),
]);
const passwordPage = observation("/password", [
  element("password", "password", "Password"),
  element("sign-in", "button", "Sign in"),
]);
const homePage = observation("/home", [
  element("logout", "button", "Sign out"),
  element("help", "link", "Help"),
]);

/**
 * A page with every field at its bound: a request for it fits the route's 128 KiB body
 * limit but not a role's 64 KiB input bound.
 */
const WIDE = "\u3042".repeat(120);
const bigPage = (): LoginObservation => ({
  ...observation("/" + "a".repeat(200), [
    {
      id: "p".repeat(64),
      role: "password",
      target: { by: "name", value: "n".repeat(120) },
      label: WIDE,
      placeholder: WIDE,
      autocomplete: "current-password",
      group: "g".repeat(64),
      maxLength: 1024,
      minLength: 1000,
      inputMode: "text",
    },
    ...Array.from({ length: 47 }, (_, index) => ({
      id: `${"b".repeat(60)}${String(index).padStart(4, "0")}`,
      role: "button" as const,
      target: { by: "text" as const, value: `${"\u3044".repeat(116)}${index}` },
      label: WIDE,
      placeholder: WIDE,
      group: "g".repeat(64),
    })),
  ]),
  title: WIDE,
  headings: Array.from({ length: 8 }, () => WIDE),
});

/** A stored recipe that must be a route recipe, as every form page's answer is. */
const route = (recipe: StoredLoginRecipe): LoginRecipe => {
  if (!isLoginRouteRecipe(recipe)) throw new Error("Expected a route recipe");
  return recipe;
};
const plan = (fields: [string, string][], action: string, purpose: "advance" | "submit") =>
  JSON.stringify({
    result: {
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
    },
  });

type Usage = { input_tokens: number; output_tokens: number };
/** A text answer, a refusal with its category, or an HTTP error status. */
type Reply = { text: string; usage?: Usage } | { refusal: string; usage?: Usage } | number;
let replies: Reply[] = [];
/** Runs while a model call is in flight, before its answer. */
let during: (() => Promise<void>) | undefined;
let tokenStatus = 200;
/** How long the synthetic token exchange takes. */
let tokenDelayMs = 0;
let sent: { authorization: string | null; apiKey: string | null; body: unknown }[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === TOKEN_URL && tokenDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
    if (outbound.url === TOKEN_URL && tokenStatus !== 200)
      return Response.json({ error: "synthetic" }, { status: tokenStatus });
    if (outbound.url === TOKEN_URL)
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        expires_in: 600,
      });
    if (outbound.url === MESSAGES_URL) {
      const body = (await outbound.json()) as { model: string };
      sent.push({
        authorization: outbound.headers.get("authorization"),
        apiKey: outbound.headers.get("x-api-key"),
        body,
      });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("No synthetic reply queued");
      const hook = during;
      during = undefined;
      await hook?.();
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
        ...("refusal" in reply
          ? {
              content: [],
              stop_reason: "refusal",
              stop_details: { type: "refusal", category: reply.refusal, explanation: "synthetic" },
            }
          : { content: [{ type: "text", text: reply.text }], stop_reason: "end_turn" }),
        stop_sequence: null,
        usage: reply.usage ?? { input_tokens: 3_000, output_tokens: 900 },
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
  during = undefined;
  tokenStatus = 200;
  tokenDelayMs = 0;
});

type Device = { ownerId: string; deviceId: string; token: string };

async function owner({ claude = true } = {}): Promise<Device> {
  const ownerId = `owner-${crypto.randomUUID()}`;
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(deviceId, ownerId, await hashDeviceToken(token), Date.now(), Date.now()),
  ]);
  if (claude)
    await saveWifCredential(env.DB, ownerId, {
      federationRuleId: "fdrl_01SyntheticRule",
      organizationId: "00000000-0000-4000-8000-000000000000",
      serviceAccountId: "svac_01SyntheticAccount",
      workspaceId: "wrkspc_01SyntheticWorkspace",
    });
  return { ownerId, deviceId, token };
}

function post(device: Device, path: string, body: unknown, method = "POST") {
  return exports.default.fetch(`https://pateat.invalid${path}`, {
    method,
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function generate(device: Device, page: LoginObservation, base?: unknown) {
  const response = await post(device, "/v1/recipes/generate", {
    version: 1,
    observation: page,
    slots,
    // A first page that lists no accounts carries the signedIn hint (ADR 0035).
    ...(base === undefined ? (page.accounts === undefined ? { signedIn: false } : {}) : { base }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}

async function complete(
  device: Device,
  recipeId: string,
  revision: number,
  page = homePage,
  partial?: true,
) {
  const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
    version: 1,
    revision,
    route: "password",
    observation: page,
    ...(partial ? { partial } : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as RecipeCompletionResult | { error: string },
  };
}

/** Each `Server-Timing` metric's duration by name; Cloudflare may add its own entries. */
function serverTiming(response: Response) {
  return Object.fromEntries(
    (response.headers.get("Server-Timing") ?? "").split(",").map((entry) => {
      const [name = "", ...params] = entry.trim().split(";");
      const duration = params.find((param) => param.startsWith("dur="));
      return [name, duration === undefined ? undefined : Number(duration.slice(4))];
    }),
  );
}

/** The columns the assertions read by name; other columns are compared whole. */
type Row = Record<string, unknown> &
  Partial<Record<"id" | "role" | "path" | "outcome" | "request" | "result", unknown>>;
const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Row>()
    .then((result) => result.results);
const month = () => new Date().toISOString().slice(0, 7);
const day = () => new Date().toISOString().slice(0, 10);

/** Only the retention delete fails; inserts, spend corrections and recipe reads use D1. */
function failLogPurge() {
  const prepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    if (/^delete from "inference_log"/iu.test(query))
      throw new Error("synthetic private log values");
    return prepare(query);
  });
}

/** Only the request log's update of `column` fails; everything else uses D1. */
function failLogUpdate(column: "revision" | "server_ms") {
  const prepare = env.DB.prepare.bind(env.DB);
  return vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
    if (query.toLowerCase().startsWith(`update "inference_log" set "${column}"`))
      throw new Error("synthetic private log values");
    return prepare(query);
  });
}

/** The request log columns that tie a row to its recipe (ADR 0012, owner 2026-10-18). */
const logRows = async (ownerId: string, role = "generate") =>
  (
    await rows(
      "SELECT recipe_id, branch, base_revision, revision, recipe_page, build, observation_hash, answer, request FROM inference_log WHERE owner_id = ? AND role = ? ORDER BY created_at",
      ownerId,
      role,
    )
  ).map(({ answer, request, ...row }) => ({
    ...(row as Record<
      "recipe_id" | "branch" | "base_revision" | "revision" | "recipe_page" | "build",
      unknown
    > & { observation_hash: unknown }),
    answer: answer === null ? null : (JSON.parse(String(answer)) as unknown),
    request: JSON.parse(String(request)) as { observation: unknown },
  }));
const hashOf = async (value: unknown) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  )
    .toHex()
    .slice(0, 12);

/** Generates the two-page recipe and returns its last change. */
async function twoPageRecipe(device: Device) {
  replies.push({ text: plan([["email", "email"]], "next", "advance") });
  const first = await generate(device, emailPage);
  if (first.status !== "recipe") throw new Error(first.status);
  replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
  const second = await generate(device, passwordPage, {
    recipeId: first.change.recipeId,
    revision: first.change.revision,
  });
  if (second.status !== "recipe") throw new Error(second.status);
  return second.change;
}

describe("recipe generation", () => {
  it("stores the first page's kind, which a continuation keeps (ADR 0035)", async () => {
    const device = await owner();
    replies.push({
      text: JSON.stringify({
        result: {
          ...JSON.parse(plan([["email", "email"]], "next", "advance")).result,
          pageKind: "confirm",
          irreversible: "yes",
        },
      }),
    });
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots,
      signedIn: true,
    });
    const first = (await response.json()) as RecipeGenerationResult;
    if (first.status !== "recipe") throw new Error(first.status);
    expect(route(first.change.recipe).pageKind).toBe("confirm");
    // The hint reaches the model beside the page; `irreversible` is never stored.
    expect(JSON.stringify(sent[0]!.body)).toContain(String.raw`\"signedIn\":true`);
    expect(JSON.stringify(first.change.recipe)).not.toContain("irreversible");
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    expect(route(second.change.recipe).pageKind).toBe("confirm");
    expect(
      await rows(
        "SELECT signed_in, page_kind, irreversible FROM inference_log WHERE owner_id = ? ORDER BY base_revision",
        device.ownerId,
      ),
    ).toEqual([
      { signed_in: 1, page_kind: "confirm", irreversible: "yes" },
      { signed_in: null, page_kind: "sign-in", irreversible: "no" },
    ]);
  });

  it("generates a recipe stored without a page kind again rather than reading it as sign-in (ADR 0035)", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const stored = await generate(device, emailPage);
    if (stored.status !== "recipe") throw new Error(stored.status);
    // Stands in for a recipe stored before page kinds: its document no longer validates.
    const { pageKind: _kind, ...old } = route(stored.change.recipe);
    await env.DB.prepare("UPDATE recipe_revisions SET document = ? WHERE owner_id = ?")
      .bind(JSON.stringify(old), device.ownerId)
      .run();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const again = await generate(device, emailPage);
    expect(again).toMatchObject({
      status: "recipe",
      change: { recipeId: stored.change.recipeId, revision: stored.change.revision + 1 },
    });
    if (again.status !== "recipe") return;
    expect(route(again.change.recipe).pageKind).toBe("sign-in");
  });

  it("builds a recipe page by page, learns its completion and logs every call", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");

    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    expect(first).toMatchObject({
      status: "recipe",
      change: {
        recipeId,
        revision: 1,
        state: "active",
        recipe: { origin: ORIGIN, slots: ["email"], maxSubmissions: 1 },
      },
    });
    if (first.status !== "recipe") return;
    expect(route(first.change.recipe).completion).toBeUndefined();
    // The access token from the exchange is the credential; no API key is sent.
    expect(sent[0]).toMatchObject({ authorization: "Bearer synthetic-access-token", apiKey: null });

    // Another device asking for the same origin gets the stored recipe without a call.
    expect(await generate(device, emailPage)).toEqual(first);
    expect(sent).toHaveLength(1);

    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, { recipeId, revision: 1 });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "password"], maxSubmissions: 2 } },
    });

    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }) });
    const judged = await complete(device, recipeId, 2);
    expect(judged).toMatchObject({
      status: 200,
      body: {
        status: "signed-in",
        change: {
          revision: 3,
          recipe: { completion: [{ target: { by: "id", value: "logout" } }] },
        },
      },
    });
    // The judge sees the login paths taken from the stored recipe.
    const judgePrompt = JSON.stringify(sent[2]!.body);
    expect(judgePrompt).toContain(String.raw`\"loginPaths\":[\"/login\",\"/password\"]`);

    // The synced change feed carries the learned recipe.
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(await feed.json()).toMatchObject({ changes: [{ recipeId, revision: 3 }] });
    // Every generated and learned revision records the device that asked for it.
    expect(
      await rows(
        "SELECT revision, created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ? ORDER BY revision",
        device.ownerId,
        recipeId,
      ),
    ).toEqual([1, 2, 3].map((revision) => ({ revision, created_by_device_id: device.deviceId })));

    const log = await rows(
      "SELECT role, origin, path, outcome, input_tokens, output_tokens, cost_micro_usd, request, result FROM inference_log WHERE owner_id = ? ORDER BY created_at",
      device.ownerId,
    );
    // The request answered with the stored recipe is logged too, at no cost.
    expect(log.map((row) => [row.role, row.path, row.outcome])).toEqual([
      ["generate", "/login", "ok"],
      ["generate", "/login", "recipe"],
      ["generate", "/password", "ok"],
      ["judge", "/home", "ok"],
    ]);
    expect(log[1]).toMatchObject({ input_tokens: null, output_tokens: null, cost_micro_usd: 0 });
    expect(log[0]).toMatchObject({
      origin: ORIGIN,
      input_tokens: 3_000,
      output_tokens: 900,
      cost_micro_usd: 3_000 * 4 + 900 * 20,
    });
    expect(JSON.parse(String(log[0]!.request))).toMatchObject({ slots, observation: emailPage });
    expect(JSON.parse(String(log[3]!.result))).toEqual({
      decision: "signed-in",
      target: { by: "id", value: "logout" },
    });
    const spend = await rows(
      "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
      device.ownerId,
    );
    expect(spend).toEqual([
      { period: month(), calls: 3, cost_micro_usd: 90_000 },
      { period: day(), calls: 3, cost_micro_usd: 90_000 },
    ]);
    expect(await rows("SELECT * FROM inference_locks WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });

  it("answers unavailable without a call when credentials are missing", async () => {
    const device = await owner({ claude: false });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "credentials-not-configured",
    });
    expect(sent).toEqual([]);
    // Missing credentials are not an attempt, so the page can be tried once they exist.
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("tries a page at most once in ten minutes, abstentions included", async () => {
    const device = await owner();
    replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "abstained",
      reason: "ambiguous",
    });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recently-tried",
    });
    expect(sent).toHaveLength(1);

    await env.DB.prepare("UPDATE generation_attempts SET attempted_at = ? WHERE owner_id = ?")
      .bind(Date.now() - ATTEMPT_WINDOW_MS - 1, device.ownerId)
      .run();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
  });

  it("stops at the monthly and daily spend limits", async () => {
    const monthly = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(monthly.ownerId, month(), 100_000_000)
      .run();
    expect(await generate(monthly, emailPage)).toMatchObject({ reason: "monthly-limit" });

    const daily = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(daily.ownerId, day(), 5_000_000)
      .run();
    expect(await generate(daily, emailPage)).toMatchObject({ reason: "daily-limit" });
    expect(sent).toEqual([]);

    // The number of calls no longer limits a day; only the spend does.
    const many = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 500, ?)",
    )
      .bind(many.ownerId, day(), 4_999_999)
      .run();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(many, emailPage)).toMatchObject({ status: "recipe" });
    expect(sent).toHaveLength(1);
  });

  it("makes one call at a time per owner and takes over an abandoned lock", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_locks (owner_id, lock_id, expires_at) VALUES (?, 'other', ?)",
    )
      .bind(device.ownerId, Date.now() + 60_000)
      .run();
    expect(await generate(device, emailPage)).toMatchObject({ reason: "busy" });
    expect(sent).toEqual([]);

    await env.DB.prepare("UPDATE inference_locks SET expires_at = ? WHERE owner_id = ?")
      .bind(Date.now() - 1, device.ownerId)
      .run();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
  });

  it("charges the reserved upper bound when a failed call reports no usage", async () => {
    const device = await owner();
    replies.push(500);
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "failed",
      error: "provider-error",
    });
    expect(
      await rows(
        "SELECT calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      { calls: 1, cost_micro_usd: RESERVED },
      { calls: 1, cost_micro_usd: RESERVED },
    ]);
    expect(
      await rows(
        "SELECT outcome, input_tokens FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ outcome: "provider-error", input_tokens: null }]);
  });

  it("asks Sonnet 5.5 once when Opus 5.5 refuses, and logs and charges both calls", async () => {
    const device = await owner();
    replies.push({ refusal: "cyber", usage: { input_tokens: 3_000, output_tokens: 0 } });
    replies.push({
      text: plan([["email", "email"]], "next", "advance"),
      usage: { input_tokens: 3_000, output_tokens: 100 },
    });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(sent.map(({ body }) => (body as { model: string }).model)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    // 3,000 input tokens at $4, then 3,000 at $2 and 100 output tokens at $10, per million.
    expect(
      await rows(
        "SELECT model_id, outcome, cost_micro_usd FROM inference_log WHERE owner_id = ? ORDER BY created_at",
        device.ownerId,
      ),
    ).toEqual([
      { model_id: "claude-opus-5-5", outcome: "refused", cost_micro_usd: 12_000 },
      { model_id: "claude-sonnet-5-5", outcome: "ok", cost_micro_usd: 7_000 },
    ]);
    expect(
      await rows(
        "SELECT calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      { calls: 2, cost_micro_usd: 19_000 },
      { calls: 2, cost_micro_usd: 19_000 },
    ]);
  });

  it("ends the request when Sonnet 5.5 refuses too, without a third call", async () => {
    const device = await owner();
    replies.push({ refusal: "cyber" }, { refusal: "general_harms" });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "failed",
      error: "refused",
    });
    expect(sent).toHaveLength(2);
    expect(
      await rows(
        "SELECT model_id, outcome FROM inference_log WHERE owner_id = ? ORDER BY created_at",
        device.ownerId,
      ),
    ).toEqual([
      { model_id: "claude-opus-5-5", outcome: "refused" },
      { model_id: "claude-sonnet-5-5", outcome: "refused" },
    ]);
  });

  it("asks no other model once the refused call reached the daily spend stop", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 0, ?)",
    )
      .bind(device.ownerId, day(), 4_995_000)
      .run();
    replies.push({ refusal: "cyber", usage: { input_tokens: 3_000, output_tokens: 0 } });
    expect(await generate(device, emailPage)).toMatchObject({ error: "refused" });
    expect(sent).toHaveLength(1);
  });

  it("asks no other model after a failure that is not a refusal", async () => {
    const device = await owner();
    replies.push(500);
    expect(await generate(device, emailPage)).toMatchObject({ error: "provider-error" });
    expect(sent).toHaveLength(1);
  });

  it("names the check that refused the output and logs the refused plan by reference", async () => {
    const device = await owner();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // A password for a sign-up form's `new-password` input, which a confirmation field
    // follows: the plan check refuses it.
    const page = observation("/login", [
      element("email", "email", "Email"),
      { ...element("password", "password", "Password"), autocomplete: "new-password" },
      { ...element("confirm", "password", "Confirm password"), autocomplete: "new-password" },
      element("sign-in", "button", "Sign in"),
    ]);
    const refused = JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: [
          { slot: "email", candidate: "email" },
          { slot: "password", candidate: "password" },
        ],
        action: { candidate: "Sign in", purpose: "submit" },
      },
    });
    replies.push({ text: refused, usage: { input_tokens: 2_900, output_tokens: 78 } });
    expect(await generate(device, page)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "incompatible-role" },
    });
    // Output the format refuses: only the issue and where it was, never the text.
    const other = await owner();
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "email", candidate: "email" }],
          action: { candidate: "sign-in", purpose: "Sign in now" },
        },
      }),
    });
    expect(await generate(other, emailPage)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "schema", issue: "picklist", path: "result.action.purpose" },
    });
    const third = await owner();
    replies.push({ text: "Sign in with the email field." });
    expect(await generate(third, emailPage)).toMatchObject({ rejection: { check: "json" } });

    const version = await generationPromptVersion();
    const logged = (
      await Promise.all(
        [device, other, third].map((each) =>
          rows(
            "SELECT outcome, prompt_version, input_tokens, output_tokens, result, signed_in, page_kind, irreversible FROM inference_log WHERE owner_id = ?",
            each.ownerId,
          ),
        ),
      )
    ).flat();
    expect(logged.map((row) => ({ ...row, result: JSON.parse(String(row.result)) }))).toEqual([
      {
        outcome: "invalid-output",
        prompt_version: version,
        input_tokens: 2_900,
        output_tokens: 78,
        // The refused plan's answered kind is kept for evaluation (ADR 0035).
        signed_in: 0,
        page_kind: "sign-in",
        irreversible: "no",
        result: {
          rejection: { check: "plan", reason: "incompatible-role" },
          // The action's text is not a candidate of the page, so it is not kept.
          output: {
            result: {
              pageKind: "sign-in",
              irreversible: "no",
              fields: [
                { slot: "email", candidate: "email" },
                { slot: "password", candidate: "password" },
              ],
              action: { candidate: "?", purpose: "submit" },
            },
          },
        },
      },
      {
        outcome: "invalid-output",
        prompt_version: version,
        input_tokens: 3_000,
        output_tokens: 900,
        signed_in: 0,
        page_kind: null,
        irreversible: null,
        result: {
          rejection: { check: "schema", issue: "picklist", path: "result.action.purpose" },
        },
      },
      {
        outcome: "invalid-output",
        prompt_version: version,
        input_tokens: 3_000,
        output_tokens: 900,
        signed_in: 0,
        page_kind: null,
        irreversible: null,
        result: { rejection: { check: "json" } },
      },
    ]);
    expect(JSON.stringify(logged.map((row) => row.result))).not.toMatch(/Sign in/u);
    expect(info).toHaveBeenCalledWith("Model output refused", {
      role: "generate",
      promptVersion: version,
      rejection: { check: "plan", reason: "incompatible-role" },
    });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/Sign in/u);
    info.mockRestore();
  });

  it("deletes log rows older than a year when it logs a call", async () => {
    const device = await owner();
    const insert = (id: string, age: number) =>
      env.DB.prepare(
        "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'm', ?, '/', '{}', 'ok', 0, ?)",
      ).bind(id, device.ownerId, ORIGIN, Date.now() - age);
    const expired = `log-${crypto.randomUUID()}`;
    const kept = `log-${crypto.randomUUID()}`;
    // Every row is kept for a year (owner, 2026-10-18), past the earlier 90 days.
    await env.DB.batch([insert(expired, 366 * DAY_MS), insert(kept, 364 * DAY_MS)]);
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    const ids = (await rows("SELECT id FROM inference_log WHERE id IN (?, ?)", expired, kept)).map(
      (row) => row.id,
    );
    expect(ids).toEqual([kept]);
  });

  it("deletes expired logs and keeps 364-day logs when recipes are read without a call", async () => {
    const device = await owner({ claude: false });
    const insert = (id: string, age: number) =>
      env.DB.prepare(
        "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'm', ?, '/', '{}', 'ok', 0, ?)",
      ).bind(id, device.ownerId, ORIGIN, Date.now() - age);
    const expired = `log-${crypto.randomUUID()}`;
    const kept = `log-${crypto.randomUUID()}`;
    await env.DB.batch([insert(expired, 366 * DAY_MS), insert(kept, 364 * DAY_MS)]);
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(feed.status).toBe(200);
    expect(await feed.json()).toEqual({ version: 1, changes: [], cursor: 0, complete: true });
    expect(await rows("SELECT id FROM inference_log WHERE id IN (?, ?)", expired, kept)).toEqual([
      { id: kept },
    ]);
    expect(sent).toHaveLength(0);
  });

  it("serves the recipe feed when the retention delete fails and logs no error values", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const generated = await generate(device, emailPage);
    if (generated.status !== "recipe") throw new Error(generated.status);
    const purge = failLogPurge();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
        headers: { Authorization: `Bearer ${device.token}` },
      });
      expect(feed.status).toBe(200);
      expect(await feed.json()).toEqual({
        version: 1,
        changes: [generated.change],
        cursor: 1,
        complete: true,
      });
      expect(purge).toHaveBeenCalledWith(expect.stringMatching(/^delete from "inference_log"/iu));
      expect(error.mock.calls).toEqual([["Inference log purge failed"]]);
    } finally {
      purge.mockRestore();
      error.mockRestore();
    }
  });

  it("records a paid call and its corrected spend when the retention delete fails", async () => {
    const device = await owner();
    replies.push({
      text: plan([["email", "email"]], "next", "advance"),
      usage: { input_tokens: 3_000, output_tokens: 900 },
    });
    const purge = failLogPurge();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
      expect(
        await rows(
          "SELECT outcome, input_tokens, output_tokens, cost_micro_usd FROM inference_log WHERE owner_id = ?",
          device.ownerId,
        ),
      ).toEqual([
        { outcome: "ok", input_tokens: 3_000, output_tokens: 900, cost_micro_usd: 30_000 },
      ]);
      expect(
        await rows(
          "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
          device.ownerId,
        ),
      ).toEqual([
        { period: month(), calls: 1, cost_micro_usd: 30_000 },
        { period: day(), calls: 1, cost_micro_usd: 30_000 },
      ]);
      expect(
        await rows("SELECT lock_id FROM inference_locks WHERE owner_id = ?", device.ownerId),
      ).toEqual([]);
      expect(purge).toHaveBeenCalledWith(expect.stringMatching(/^delete from "inference_log"/iu));
      expect(error.mock.calls).toEqual([["Inference log purge failed"]]);
    } finally {
      purge.mockRestore();
      error.mockRestore();
    }
  });

  it("logs each call's recipe, revisions, build, page hash and own answer", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }) });
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 3 },
    });
    const generated = await logRows(device.ownerId);
    const [judged] = await logRows(device.ownerId, "judge");
    const common = { recipe_id: change.recipeId, branch: "", build: "test-revision" };
    expect(generated.map(({ request: _request, observation_hash: _hash, ...row }) => row)).toEqual([
      {
        ...common,
        base_revision: 0,
        revision: 1,
        recipe_page: "first",
        answer: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "email", candidate: "email" }],
          action: { candidate: "next", purpose: "advance" },
        },
      },
      {
        ...common,
        base_revision: 1,
        revision: 2,
        recipe_page: "continuation",
        answer: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "password", candidate: "password" }],
          action: { candidate: "sign-in", purpose: "submit" },
        },
      },
    ]);
    expect(judged).toMatchObject({
      ...common,
      base_revision: 2,
      revision: 3,
      recipe_page: null,
      answer: { decision: "signed-in", marker: "logout" },
    });
    // The hash is of the observation as the row's request holds it.
    const all = [...generated, judged!];
    expect(all.map((row) => row.observation_hash)).toEqual(
      await Promise.all(all.map((row) => hashOf(row.request.observation))),
    );
    expect(new Set(all.map((row) => row.observation_hash)).size).toBe(3);
    // `request` stays the instructions and input as sent: a first page with the device's
    // signedIn hint (ADR 0035), a continuation without it.
    expect(Object.keys(generated[0]!.request)).toEqual([
      "instructions",
      "slots",
      "signedIn",
      "observation",
    ]);
    expect(Object.keys(generated[1]!.request)).toEqual(["instructions", "slots", "observation"]);
    expect(
      await rows(
        "SELECT signed_in, page_kind, irreversible FROM inference_log WHERE owner_id = ? ORDER BY base_revision",
        device.ownerId,
      ),
    ).toEqual([
      { signed_in: 0, page_kind: "sign-in", irreversible: "no" },
      { signed_in: null, page_kind: "sign-in", irreversible: "no" },
      // A judgement answers no page kind.
      { signed_in: null, page_kind: null, irreversible: null },
    ]);
  });

  it("logs no revision for a call that wrote none, and a refused judgement's answer", async () => {
    const device = await owner();
    replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    });
    expect(await generate(device, emailPage)).toMatchObject({ status: "abstained" });
    expect(await logRows(device.ownerId)).toMatchObject([
      {
        base_revision: 0,
        revision: null,
        recipe_page: "first",
        answer: { decision: "abstain", reason: "ambiguous" },
      },
    ]);

    const judged = await owner();
    const change = await twoPageRecipe(judged);
    // A challenge with no handler to keep writes nothing.
    replies.push({ text: JSON.stringify({ result: { decision: "challenge" } }) });
    expect((await complete(judged, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    // A marker the page lacks fails closed; the row keeps the answer, never its text.
    replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "Sign out now" } }),
    });
    const account = { ...homePage, path: "/account" };
    expect((await complete(judged, change.recipeId, 2, account)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
    const rowsJudged = await rows(
      "SELECT outcome, result, answer, base_revision, revision FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY created_at",
      judged.ownerId,
    );
    expect(
      rowsJudged.map((row) => ({ ...row, answer: JSON.parse(String(row["answer"])) })),
    ).toEqual([
      {
        outcome: "ok",
        result: JSON.stringify({ decision: "challenge" }),
        answer: { decision: "challenge" },
        base_revision: 2,
        revision: null,
      },
      {
        outcome: "invalid-output",
        result: null,
        answer: { decision: "signed-in", marker: "?" },
        base_revision: 2,
        revision: null,
      },
    ]);
    expect(JSON.stringify(rowsJudged)).not.toMatch(/Sign out now/u);
  });

  it("answers the login and logs no revision when the revision update fails", async () => {
    const device = await owner();
    const update = failLogUpdate("revision");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      replies.push({ text: plan([["email", "email"]], "next", "advance") });
      expect(await generate(device, emailPage)).toMatchObject({
        status: "recipe",
        change: { revision: 1 },
      });
      expect(update).toHaveBeenCalledWith(expect.stringMatching(/^update "inference_log"/iu));
      expect(warn.mock.calls).toEqual([["Inference log revision not kept"]]);
    } finally {
      update.mockRestore();
      warn.mockRestore();
    }
    expect(await logRows(device.ownerId)).toMatchObject([{ revision: null, recipe_page: "first" }]);
  });

  it("generates the next form of a login that stays on one path", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    // The password form replaces the email form on the same path.
    const samePath = { ...passwordPage, path: "/login" };
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(await generate(device, samePath, { recipeId, revision: 1 })).toMatchObject({
      status: "recipe",
      change: { revision: 2 },
    });
    // The first page on that path now gets the stored recipe without a call.
    const again = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots,
      signedIn: false,
    });
    expect(await again.json()).toMatchObject({ status: "recipe", change: { revision: 2 } });
  });

  it("stores fields located by their visible name, as the page offered them (ADR 0037)", async () => {
    const device = await owner();
    // A form whose fields only per-load IDs name.
    const named = observation("/signin", [
      { id: "c1", role: "email", target: { by: "label", value: "Email address" } },
      { id: "c2", role: "password", target: { by: "label", value: "Password" } },
      element("sign-in", "button", "Sign in"),
    ]);
    replies.push({
      text: plan(
        [
          ["email", "c1"],
          ["password", "c2"],
        ],
        "sign-in",
        "submit",
      ),
    });
    const result = await generate(device, named);
    if (result.status !== "recipe") throw new Error(result.status);
    expect(route(result.change.recipe).steps[0]).toMatchObject({
      kind: "fill",
      fields: [
        { slot: "email", target: { by: "label", value: "Email address" } },
        { slot: "password", target: { by: "label", value: "Password" } },
      ],
    });
    // The page after it that still shows the form by those names is not judged.
    const calls = sent.length;
    const reposted = observation("/session", [
      { id: "c1", role: "email", target: { by: "label", value: "Email address" } },
      element("help", "link", "Help"),
    ]);
    expect((await complete(device, result.change.recipeId, 1, reposted)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(sent).toHaveLength(calls);
  });

  it("fails a continuation that fills one of the recipe's slots again, storing nothing", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    // The email form shown again where it posted, as after an unknown account.
    const again = { ...emailPage, path: "/login/identifier" };
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, again, { recipeId, revision: 1 })).toEqual({
      version: 1,
      status: "failed",
      error: "recipe-invalid",
    });
    expect(
      await rows(
        "SELECT revision FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        recipeId,
      ),
    ).toEqual([{ revision: 1 }]);
  });

  it("holds the owner's lock for the whole call and releases only its own", async () => {
    const device = await owner();
    during = async () => {
      // A second request while the call runs is turned away.
      expect(await generate(device, passwordPage)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
      // A request that took over an abandoned lock keeps it.
      await env.DB.prepare("UPDATE inference_locks SET lock_id = 'other' WHERE owner_id = ?")
        .bind(device.ownerId)
        .run();
    };
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    expect(
      await rows("SELECT lock_id FROM inference_locks WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ lock_id: "other" }]);
  });

  it("refuses an oversized page locally: no call and no charge, and logs it unsent", async () => {
    const device = await owner();
    const big = bigPage();
    const bigSlots = Array.from({ length: 8 }, (_, index) => ({
      id: `${"s".repeat(62)}${index}`,
      kind: "identifier" as const,
      description: WIDE,
      // Each offer names a different vault field.
      fieldName: `${"\u3042".repeat(119)}${index}`,
    }));
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: big,
      slots: bigSlots,
      signedIn: false,
    });
    expect(await response.json()).toEqual({
      version: 1,
      status: "failed",
      error: "input-too-large",
    });
    // The credential step ran, but no model request was sent.
    expect(Object.keys(serverTiming(response)).sort()).toEqual(["token", "total"]);
    expect(sent).toEqual([]);
    // One row, as the model would have received the request (ADR 0012, owner 2026-10-18).
    expect(
      await rows(
        "SELECT provider, model_id, outcome, input_tokens, output_tokens, cost_micro_usd, result, answer FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      {
        provider: null,
        model_id: null,
        outcome: "input-too-large",
        input_tokens: null,
        output_tokens: null,
        cost_micro_usd: 0,
        result: null,
        answer: null,
      },
    ]);
    const logged = await logRows(device.ownerId);
    expect(logged).toEqual([
      {
        recipe_id: await generatedRecipeId(ORIGIN, big.path),
        branch: "",
        base_revision: 0,
        revision: null,
        recipe_page: "first",
        build: "test-revision",
        observation_hash: await hashOf(logged[0]!.request.observation),
        answer: null,
        request: {
          instructions: generationInstructions,
          slots: bigSlots,
          signedIn: false,
          observation: big,
        },
      },
    ]);
    expect(
      await rows(
        "SELECT calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      { calls: 0, cost_micro_usd: 0 },
      { calls: 0, cost_micro_usd: 0 },
    ]);
    // The refusal is deterministic, so it counts toward the retry window.
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: big.path }]);
  });

  it("answers a conflict when this origin's recipe ID holds another origin", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const elsewhere = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: "https://other.example.test",
      pageKind: "sign-in",
      slots: ["email"],
      steps: [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [{ slot: "email", target: { by: "id", value: "e" } }],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "go" }, purpose: "submit" },
      ],
      maxSubmissions: 1,
    };
    const stored = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 0, state: "active", recipe: elsewhere },
      "PUT",
    );
    expect(stored.status).toBe(200);
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(sent).toEqual([]);
  });

  it("never generates, continues or judges an entry recipe stored under the page's ID", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    // ADR 0031: a recipe whose only member is `entry`, written by a device for now.
    const entry = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      entry: { path: "/login", target: { by: "text", value: "Login" } },
    };
    const stored = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 0, state: "active", recipe: entry },
      "PUT",
    );
    expect(stored.status).toBe(200);
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    expect(await generate(device, emailPage)).toEqual(conflict);
    expect(await generate(device, passwordPage, { recipeId, revision: 1 })).toEqual(conflict);
    expect(await complete(device, recipeId, 1)).toEqual({ status: 200, body: conflict });
    expect(sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("never answers a form page, a route's next page or its judgement with a chooser recipe", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    // ADR 0028: a recipe whose only member is `chooser`, written by a device for now.
    const chooser = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      chooser: { path: "/login", other: { by: "text", value: "Use another account" } },
    };
    const stored = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 0, state: "active", recipe: chooser },
      "PUT",
    );
    expect(stored.status).toBe(200);
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    expect(await generate(device, emailPage)).toEqual(conflict);
    expect(await generate(device, passwordPage, { recipeId, revision: 1 })).toEqual(conflict);
    expect(await complete(device, recipeId, 1)).toEqual({ status: 200, body: conflict });
    expect(sent).toEqual([]);
  });

  it("generates a first page beside an entry recipe of another path, and after one is revoked", async () => {
    const device = await owner();
    const entryWrite = (id: string, path: string) => ({
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: {
        version: 1,
        id,
        revision: 1,
        origin: ORIGIN,
        entry: { path, target: { by: "text", value: "Login" } },
      },
    });
    const loginId = await generatedRecipeId(ORIGIN, "/login");
    // The top page's entry recipe leaves the login page's own recipe to be generated.
    const topId = await generatedRecipeId(ORIGIN, "/");
    expect((await post(device, `/v1/recipes/${topId}`, entryWrite(topId, "/"), "PUT")).status).toBe(
      200,
    );
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({
      status: "recipe",
      change: { recipeId: loginId, revision: 1 },
    });
    expect(sent).toHaveLength(1);

    // A revoked entry recipe is generated again from its page as the revision after its
    // tombstone, as any revoked recipe is.
    const other = await owner();
    expect(
      (await post(other, `/v1/recipes/${loginId}`, entryWrite(loginId, "/login"), "PUT")).status,
    ).toBe(200);
    const revoked = await post(
      other,
      `/v1/recipes/${loginId}`,
      { version: 1, expectedRevision: 1, state: "revoked" },
      "PUT",
    );
    expect(revoked.status).toBe(200);
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(other, emailPage)).toMatchObject({
      status: "recipe",
      change: { recipeId: loginId, revision: 3, recipe: { revision: 3, slots: ["email"] } },
    });
    expect(sent).toHaveLength(2);
  });

  it("refuses an incomplete page without recording an attempt", async () => {
    const device = await owner();
    expect(await generate(device, { ...emailPage, complete: false })).toEqual({
      version: 1,
      status: "failed",
      error: "incomplete-observation",
    });
    expect(sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("maps refused and failed token exchanges without a model call or an attempt", async () => {
    const device = await owner();
    tokenStatus = 401;
    expect(await generate(device, emailPage)).toMatchObject({ reason: "credentials-rejected" });
    tokenStatus = 503;
    expect(await generate(device, emailPage)).toMatchObject({ reason: "token-exchange-failed" });
    expect(sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("refuses a revoked base, a stale base, a base with no recipe and a non-generated base", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);

    // A stale base gets the current recipe back without a call.
    const stale = await generate(device, passwordPage, { recipeId, revision: 7 });
    expect(stale).toMatchObject({ status: "recipe", change: { revision: 1 } });
    const otherId = await generatedRecipeId("https://other.example.test", "/login");
    const mismatch = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: passwordPage,
      slots,
      base: { recipeId: otherId, revision: 1 },
    });
    expect(await mismatch.json()).toMatchObject({ reason: "recipe-conflict" });
    // Only a generated recipe can be continued.
    const manual = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: passwordPage,
      slots,
      base: { recipeId: "synthetic-identity", revision: 1 },
    });
    expect(manual.status).toBe(400);

    const revoke = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 1, state: "revoked" },
      "PUT",
    );
    expect(revoke.status).toBe(200);
    expect(await generate(device, passwordPage, { recipeId, revision: 2 })).toMatchObject({
      reason: "recipe-revoked",
    });
    expect(sent).toHaveLength(1);
  });

  it("generates a separate recipe for a page where no recipe of the origin starts", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // After an account switch the password page of another account is a new start.
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage);
    if (second.status !== "recipe") throw new Error(second.status);
    expect(second.change).toMatchObject({
      recipeId: await generatedRecipeId(ORIGIN, "/password"),
      revision: 1,
      recipe: { steps: [{ path: "/password" }, { path: "/password" }] },
    });
    expect(second.change.recipeId).not.toBe(first.change.recipeId);
    // Each start path answers with its own recipe from then on, without a call.
    expect(await generate(device, emailPage)).toMatchObject({
      change: { recipeId: first.change.recipeId },
    });
    expect(await generate(device, passwordPage)).toMatchObject({
      change: { recipeId: second.change.recipeId },
    });
    expect(sent).toHaveLength(2);

    // Two recipes that both lead to the same page each get it generated once.
    const widgetPage = { ...emailPage, path: "/" };
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const widget = await generate(device, widgetPage);
    if (widget.status !== "recipe") throw new Error(widget.status);
    const next = observation("/next", [
      element("password", "password", "Password"),
      element("sign-in", "button", "Sign in"),
    ]);
    // Sequential: one call at a time per owner.
    const continueAt = async (started: typeof first) => {
      replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
      expect(
        await generate(device, next, { recipeId: started.change.recipeId, revision: 1 }),
      ).toMatchObject({ status: "recipe", change: { recipeId: started.change.recipeId } });
    };
    await continueAt(first);
    await continueAt(widget);
    expect(sent).toHaveLength(5);

    // A recipe stored under the ID of a path it does not start on is not continued.
    const misplacedId = await generatedRecipeId(ORIGIN, "/elsewhere");
    expect(
      (
        await writeRecipe(
          env.DB,
          device.ownerId,
          misplacedId,
          {
            version: 1,
            expectedRevision: 0,
            state: "active",
            recipe: { ...first.change.recipe, id: misplacedId, revision: 1 },
          },
          device.deviceId,
        )
      ).ok,
    ).toBe(true);
    expect(
      await generate(device, passwordPage, { recipeId: misplacedId, revision: 1 }),
    ).toMatchObject({ reason: "recipe-conflict" });
    expect(sent).toHaveLength(5);
  });

  it("stores a recipe under a path with [id] and answers every tenant's page with it (ADR 0039)", async () => {
    const device = await owner();
    const tenantPage = { ...passwordPage, path: "/[id]/oauth2/authorize" };
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const first = await generate(device, tenantPage);
    if (first.status !== "recipe") throw new Error(first.status);
    expect(first.change).toMatchObject({
      recipeId: await generatedRecipeId(ORIGIN, "/[id]/oauth2/authorize"),
      recipe: {
        steps: [{ path: "/[id]/oauth2/authorize" }, { path: "/[id]/oauth2/authorize" }],
      },
    });
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: "/[id]/oauth2/authorize" }]);
    // The same page, from another tenant, is answered with that recipe without a call.
    expect(await generate(device, tenantPage)).toMatchObject({
      status: "recipe",
      change: { recipeId: first.change.recipeId },
    });
    expect(sent).toHaveLength(1);
  });

  it("stores the account switch the model names", async () => {
    const device = await owner();
    const remembered = observation("/password", [
      element("password", "password", "Password"),
      element("sign-in", "button", "Sign in"),
      {
        id: "switch",
        role: "link",
        target: { by: "text", value: "Use another account" },
        label: "Use another account",
      },
    ]);
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "password", candidate: "password" }],
          action: { candidate: "sign-in", purpose: "submit" },
          accountSwitch: "switch",
        },
      }),
    });
    expect(await generate(device, remembered)).toMatchObject({
      status: "recipe",
      change: { recipe: { accountSwitch: { by: "text", value: "Use another account" } } },
    });
  });

  it("generates a recipe the owner revoked in the web UI again from its first page", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // The web UI's revoke route writes this, with no writing device.
    const revoked = await writeRecipe(
      env.DB,
      device.ownerId,
      first.change.recipeId,
      { version: 1, expectedRevision: 1, state: "revoked" },
      null,
    );
    expect(revoked.ok).toBe(true);
    // A later page never continues it, and its pages are not judged.
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 2 }),
    ).toMatchObject({ reason: "recipe-revoked" });
    expect((await complete(device, first.change.recipeId, 1)).body).toMatchObject({
      reason: "recipe-revoked",
    });
    expect(sent).toHaveLength(1);

    // Its first page writes the revision after the tombstone, without waiting out the
    // attempt the first recipe made (owner, 2026-10-12).
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({
      status: "recipe",
      change: {
        recipeId: first.change.recipeId,
        revision: 3,
        state: "active",
        recipe: { revision: 3 },
      },
    });
    expect(sent).toHaveLength(2);
    expect(
      await rows(
        "SELECT base_revision FROM generation_attempts WHERE owner_id = ? ORDER BY base_revision",
        device.ownerId,
      ),
    ).toEqual([{ base_revision: 0 }, { base_revision: 2 }]);
    // The new recipe is continued as usual.
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 3 }),
    ).toMatchObject({ status: "recipe", change: { revision: 4 } });
    // The page generated again after the tombstone starts its recipe, as the first one did.
    expect(
      (await logRows(device.ownerId)).map(({ base_revision, revision, recipe_page }) => ({
        base_revision,
        revision,
        recipe_page,
      })),
    ).toEqual([
      { base_revision: 0, revision: 1, recipe_page: "first" },
      // The continuation refused as `recipe-revoked`, on the tombstone.
      { base_revision: 2, revision: null, recipe_page: "continuation" },
      { base_revision: 2, revision: 3, recipe_page: "first" },
      { base_revision: 3, revision: 4, recipe_page: "continuation" },
    ]);
  });

  it("refuses new pages and continuations before the model call with less than 32 KiB left", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES -
        documentBytes(first.change.recipe) -
        MIN_GENERATION_RECIPE_ROOM_BYTES +
        1,
    );
    const limited = { version: 1, status: "unavailable", reason: "recipe-limit" };
    expect(await generate(device, observation("/other", emailPage.candidates))).toEqual(limited);
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toEqual(limited);
    expect(sent).toHaveLength(1);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: "/login" }]);
    // A cached active answer costs no call and remains available at the limit.
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
  });

  it("admits exactly 32 KiB of preflight room and maps a racing continuation's byte refusal", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES -
        documentBytes(first.change.recipe) -
        MIN_GENERATION_RECIPE_ROOM_BYTES,
    );
    during = async () => {
      await env.DB.prepare(
        "UPDATE recipe_revisions SET document = document || ? WHERE owner_id = ? AND recipe_id = 'byte-seed'",
      )
        .bind(" ".repeat(MIN_GENERATION_RECIPE_ROOM_BYTES), device.ownerId)
        .run();
    };
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toEqual({ version: 1, status: "unavailable", reason: "recipe-limit" });
    expect(sent).toHaveLength(2);
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        first.change.recipeId,
      ),
    ).toEqual([{ revision: 1 }]);
    expect(await storedRecipeBytes(device.ownerId)).toBe(MAX_ACTIVE_RECIPE_BYTES);
  });

  it("maps a new recipe's byte refusal after the model call", async () => {
    const device = await owner();
    during = () => seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(sent).toHaveLength(1);
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        await generatedRecipeId(ORIGIN, emailPage.path),
      ),
    ).toEqual([]);
  });

  it("needs room for one more active recipe before a first page's call", async () => {
    const device = await owner();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at)
       SELECT ?, 'seeded-' || i, 1, 'active', 1000000 + i, 'seed-' || i, ? FROM n`,
    )
      .bind(MAX_ACTIVE_RECIPES - 1, device.ownerId, Date.now())
      .run();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);

    const other = observation("/signin", emailPage.candidates, "https://other.example.test");
    expect(await generate(device, other)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(sent).toHaveLength(1);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: "/login" }]);
    // Continuing a stored recipe adds none.
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toMatchObject({ status: "recipe", change: { revision: 2 } });
  });
});

describe("custom-field slots (ADR 0027)", () => {
  const branch: SemanticSlot = {
    id: "custom-1",
    kind: "identifier",
    description: "value of the user's vault field named in fieldName",
    fieldName: "Synthetic branch field",
  };
  const pin: SemanticSlot = {
    id: "custom-2",
    kind: "hidden",
    description: "concealed value of the user's vault field named in fieldName, such as a PIN",
    fieldName: "Synthetic PIN field",
  };
  const customSlots = [...slots, branch, pin];
  const branchPage = observation("/login", [
    element("email", "email", "Email"),
    element("branch", "text", "Branch"),
    element("next", "button", "Next"),
  ]);
  const pinPage = observation("/password", [
    { ...element("pin", "tel", "PIN"), maxLength: 4 },
    element("again", "text", "Branch again"),
    element("sign-in", "button", "Sign in"),
  ]);
  const named = (
    fields: { slot: string; candidate: string }[],
    action: string,
    purpose: "advance" | "submit",
  ) =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields,
        action: { candidate: action, purpose },
      },
    });
  async function generateCustom(device: Device, page: LoginObservation, base?: unknown) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots: customSlots,
      ...(base === undefined ? (page.accounts ? {} : { signedIn: false }) : { base }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }

  it("stores the page's name for the field and answers the mapping only to the call that wrote it", async () => {
    const device = await owner();
    replies.push({
      text: named(
        [
          { slot: "email", candidate: "email" },
          { slot: "custom-1", candidate: "branch" },
        ],
        "next",
        "advance",
      ),
    });
    const first = await generateCustom(device, branchPage);
    expect(first).toMatchObject({
      status: "recipe",
      change: { revision: 1, recipe: { slots: ["email", "Branch"] } },
      customSlots: [{ slot: "Branch", offered: "custom-1" }],
    });
    if (first.status !== "recipe") return;
    // The recipe never carries the vault field names.
    expect(JSON.stringify(first.change)).not.toContain("Synthetic");
    expect(route(first.change.recipe).steps[0]).toMatchObject({
      fields: [
        { slot: "email", target: { by: "id", value: "email" } },
        { slot: "Branch", target: { by: "id", value: "branch" } },
      ],
    });
    // A request answered with the stored recipe gets no mapping.
    const stored = await generateCustom(device, branchPage);
    expect(stored).toEqual({ version: 1, status: "recipe", change: first.change });
    expect(sent).toHaveLength(1);

    // A continuation maps only its own page's custom slots.
    replies.push({
      text: named([{ slot: "custom-2", candidate: "pin" }], "sign-in", "submit"),
    });
    const second = await generateCustom(device, pinPage, {
      recipeId: first.change.recipeId,
      revision: 1,
    });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "Branch", "PIN"] } },
      customSlots: [{ slot: "PIN", offered: "custom-2" }],
    });
  });

  it("drops the alternatives of a continuation's answer, which name no slot", async () => {
    const device = await owner();
    replies.push({
      text: named([{ slot: "custom-1", candidate: "branch" }], "next", "advance"),
    });
    const first = await generateCustom(device, branchPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // An earlier field named the same, which only the dropped alternative fills, would
    // have taken the name and left `PIN 2` stored without a `PIN`.
    const twoPinPage = observation("/password", [
      element("old-pin", "text", "PIN"),
      ...pinPage.candidates,
    ]);
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "custom-2", candidate: "pin" }],
          action: { candidate: "sign-in", purpose: "submit" },
          alternatives: [
            {
              fields: [{ slot: "custom-1", candidate: "old-pin" }],
              action: { candidate: "sign-in", purpose: "submit" },
            },
          ],
        },
      }),
    });
    const second = await generateCustom(device, twoPinPage, {
      recipeId: first.change.recipeId,
      revision: 1,
    });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["Branch", "PIN"] } },
      customSlots: [{ slot: "PIN", offered: "custom-2" }],
    });
    if (second.status !== "recipe") return;
    expect(second.change.recipe).not.toHaveProperty("alternatives");
  });

  it("answers no mapping for a recipe without custom slots", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const result = await generateCustom(device, branchPage);
    expect(result).toMatchObject({ status: "recipe" });
    expect(result).not.toHaveProperty("customSlots");
  });

  it("fails a continuation that reuses a slot name the recipe already has", async () => {
    const device = await owner();
    replies.push({
      text: named([{ slot: "custom-1", candidate: "branch" }], "next", "advance"),
    });
    const first = await generateCustom(device, branchPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // Another offered field the next page names the same, in any case, would merge two
    // fields; it is refused, not numbered apart (ADR 0018).
    const branchPinPage = observation("/password", [
      { ...element("pin", "tel", "BRANCH"), maxLength: 4 },
      element("sign-in", "button", "Sign in"),
    ]);
    replies.push({ text: named([{ slot: "custom-2", candidate: "pin" }], "sign-in", "submit") });
    expect(
      await generateCustom(device, branchPinPage, {
        recipeId: first.change.recipeId,
        revision: 1,
      }),
    ).toEqual({ version: 1, status: "failed", error: "recipe-invalid" });
    const head = await rows(
      "SELECT revision FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ?",
      device.ownerId,
      first.change.recipeId,
    );
    expect(head).toEqual([{ revision: 1 }]);
  });

  it("answers no mapping with another device's recipe stored during the call", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const other = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      pageKind: "sign-in",
      slots: ["email", "Branch"],
      steps: [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [
            { slot: "email", target: { by: "id", value: "email" } },
            { slot: "Branch", target: { by: "id", value: "branch" } },
          ],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
      ],
      maxSubmissions: 1,
    };
    during = async () => {
      const stored = await post(
        device,
        `/v1/recipes/${recipeId}`,
        { version: 1, expectedRevision: 0, state: "active", recipe: other },
        "PUT",
      );
      expect(stored.status).toBe(200);
    };
    replies.push({
      text: named(
        [
          { slot: "email", candidate: "email" },
          { slot: "custom-1", candidate: "branch" },
        ],
        "next",
        "advance",
      ),
    });
    expect(await generateCustom(device, branchPage)).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe: other },
    });
    // The call's own write lost, so its row names no revision.
    expect(await logRows(device.ownerId)).toMatchObject([
      { recipe_id: recipeId, base_revision: 0, revision: null, recipe_page: "first" },
    ]);
  });
});

describe("slot names carried from the saved bindings (ADR 0027, 2026-10-19)", () => {
  const branch: SemanticSlot = {
    id: "custom-1",
    kind: "identifier",
    description: "value of the user's vault field named in fieldName",
    fieldName: "Synthetic branch field",
  };
  const pin: SemanticSlot = {
    id: "custom-2",
    kind: "hidden",
    description: "concealed value of the user's vault field named in fieldName, such as a PIN",
    fieldName: "Synthetic PIN field",
  };
  const customSlots = [...slots, branch, pin];
  const branchPage = (label = "Branch code") =>
    observation("/login", [
      element("email", "email", "Email"),
      element("branch", "text", label),
      element("next", "button", "Next"),
    ]);
  const pinPage = (label = "PIN") =>
    observation("/password", [
      { ...element("pin", "tel", label), maxLength: 4 },
      element("sign-in", "button", "Sign in"),
    ]);
  const fields = (...pairs: [string, string][]) =>
    pairs.map(([slot, candidate]) => ({ slot, candidate }));
  const named = (
    filled: { slot: string; candidate: string }[],
    action: string,
    purpose: "advance" | "submit",
  ) =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: filled,
        action: { candidate: action, purpose },
      },
    });
  const branchField = { custom: "Synthetic branch field" };
  const pinField = { custom: "Synthetic PIN field" };
  type Entry = { slot: string; field: unknown };
  /** One synthetic account's saved binding of `recipeId`, with the email as its username. */
  const binding = (recipeId: string, item: string, ...entries: Entry[]) => ({
    recipeId,
    origin: ORIGIN,
    provider: "bitwarden",
    userId: "user-1",
    itemId: item,
    itemName: `Synthetic ${item}`,
    slots: [{ slot: "email", field: "username" }, ...entries],
  });
  async function saveBindings(device: Device, ...bindings: ReturnType<typeof binding>[]) {
    const response = await post(
      device,
      "/v1/settings",
      {
        version: 1,
        expectedRevision: 0,
        settings: {
          connections: [],
          excludedSites: [],
          passkeyBrowserSites: [],
          siteDefaults: [],
          bindings,
        },
      },
      "PUT",
    );
    expect(response.status).toBe(200);
  }
  async function generateCustom(
    device: Device,
    page: LoginObservation,
    base?: unknown,
    branchName?: string,
  ) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots: customSlots,
      ...(base === undefined ? (page.accounts ? {} : { signedIn: false }) : { base }),
      ...(branchName === undefined ? {} : { branch: branchName }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }
  /** The prompt of the last model call, as sent. */
  const lastPrompt = () => JSON.stringify(sent.at(-1)?.body);

  it("keeps a revoked recipe's slot name when its page is generated again with new wording", async () => {
    const device = await owner();
    replies.push({
      text: named(fields(["email", "email"], ["custom-1", "branch"]), "next", "advance"),
    });
    const first = await generateCustom(device, branchPage("店番"));
    expect(first).toMatchObject({ change: { recipe: { slots: ["email", "店番"] } } });
    if (first.status !== "recipe") throw new Error(first.status);
    const { recipeId } = first.change;
    // A binding of another recipe or origin names the same field otherwise, and is not read.
    const elsewhere = binding("gen-other", "item-1", { slot: "支店", field: branchField });
    await saveBindings(
      device,
      binding(recipeId, "item-1", { slot: "店番", field: branchField }),
      elsewhere,
      { ...elsewhere, recipeId, origin: "https://other.example.test" },
    );
    expect(
      await writeRecipe(
        env.DB,
        device.ownerId,
        recipeId,
        { version: 1, expectedRevision: 1, state: "revoked" },
        null,
      ),
    ).toMatchObject({ ok: true });

    replies.push({
      text: named(fields(["email", "email"], ["custom-1", "branch"]), "next", "advance"),
    });
    const again = await generateCustom(device, branchPage("支店コード (半角)"));
    expect(again).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 3, recipe: { slots: ["email", "店番"] } },
      customSlots: [{ slot: "店番", offered: "custom-1" }],
    });
    if (again.status !== "recipe") return;
    expect(route(again.change.recipe).steps[0]).toMatchObject({
      fields: [
        { slot: "email", target: { by: "id", value: "email" } },
        { slot: "店番", target: { by: "id", value: "branch" } },
      ],
    });
    // Nothing of the bindings reaches the model, and no vault field name the recipe.
    expect(lastPrompt()).not.toContain("店番");
    expect(lastPrompt()).not.toContain("item-1");
    expect(JSON.stringify(again.change)).not.toContain("Synthetic");
    // The accepted plan's logged result has the carried name (ADR 0012).
    const [, logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate' ORDER BY created_at",
      device.ownerId,
    );
    expect(String(logged?.result)).toContain("店番");
  });

  it("carries a name on a continuation page", async () => {
    const device = await owner();
    replies.push({ text: named(fields(["email", "email"]), "next", "advance") });
    const first = await generateCustom(device, branchPage());
    if (first.status !== "recipe") throw new Error(first.status);
    await saveBindings(
      device,
      binding(first.change.recipeId, "item-1", { slot: "暗証", field: pinField }),
    );
    replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
    expect(
      await generateCustom(device, pinPage(), { recipeId: first.change.recipeId, revision: 1 }),
    ).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "暗証"] } },
      customSlots: [{ slot: "暗証", offered: "custom-2" }],
    });
  });

  it("carries a name on a chooser branch's page", async () => {
    const device = await owner();
    const listPage: LoginObservation = {
      ...observation("/login", [element("other", "button", "Use another account")]),
      accounts: ["[email]"],
    };
    replies.push({
      text: JSON.stringify({ result: { decision: "account-list", other: "other" } }),
    });
    const list = await generateCustom(device, listPage);
    if (list.status !== "recipe") throw new Error(list.status);
    await saveBindings(
      device,
      binding(list.change.recipeId, "item-1", { slot: "店番", field: branchField }),
    );
    replies.push({
      text: named(fields(["email", "email"], ["custom-1", "branch"]), "next", "advance"),
    });
    expect(
      await generateCustom(
        device,
        branchPage(),
        { recipeId: list.change.recipeId, revision: 1 },
        "other",
      ),
    ).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { chooser: { afterOther: { slots: ["email", "店番"] } } } },
      customSlots: [{ slot: "店番", offered: "custom-1" }],
    });
  });

  /** A first page generated after `bindings` of its recipe were saved, without a recipe. */
  async function firstPageAfter(
    page: LoginObservation,
    filled: [string, string][],
    ...entries: Entry[][]
  ) {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, page.path);
    await saveBindings(
      device,
      ...entries.map((entry, index) => binding(recipeId, `item-${index + 1}`, ...entry)),
    );
    replies.push({ text: named(fields(...filled), "next", "advance") });
    return generateCustom(device, page);
  }

  it("carries nothing for a field two accounts' bindings name differently", async () => {
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "店番", field: branchField }],
        [{ slot: "支店", field: branchField }],
      ),
    ).toMatchObject({ status: "recipe", change: { recipe: { slots: ["Branch code"] } } });
  });

  it("keeps the page's name over a carried name that is not a custom slot ID or is taken", async () => {
    // A request slot ID, in another case.
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "CUSTOM-2", field: branchField }],
      ),
    ).toMatchObject({ change: { recipe: { slots: ["Branch code"] } } });
    // A built-in slot.
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "Password", field: branchField }],
      ),
    ).toMatchObject({ change: { recipe: { slots: ["Branch code"] } } });
  });

  it("takes a carried name before the page's text names another field the same", async () => {
    const page = observation("/login", [
      element("branch", "text", "店番"),
      { ...element("pin", "tel", "暗証番号"), maxLength: 4 },
      element("next", "button", "Next"),
    ]);
    expect(
      await firstPageAfter(
        page,
        [
          ["custom-1", "branch"],
          ["custom-2", "pin"],
        ],
        [{ slot: "店番", field: pinField }],
      ),
    ).toMatchObject({
      status: "recipe",
      change: { recipe: { slots: ["店番 2", "店番"] } },
      customSlots: [
        { slot: "店番 2", offered: "custom-1" },
        { slot: "店番", offered: "custom-2" },
      ],
    });
  });

  it("carries a name two accounts' bindings agree on", async () => {
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [{ slot: "店番", field: branchField }],
        [{ slot: "店番", field: branchField }],
      ),
    ).toMatchObject({ status: "recipe", change: { recipe: { slots: ["店番"] } } });
  });

  it("reads no other owner's bindings of the same origin and recipe", async () => {
    const other = await owner();
    await saveBindings(
      other,
      binding(await generatedRecipeId(ORIGIN, "/login"), "item-1", {
        slot: "店番",
        field: branchField,
      }),
    );
    expect(await firstPageAfter(branchPage(), [["custom-1", "branch"]])).toMatchObject({
      status: "recipe",
      change: { recipe: { slots: ["Branch code"] } },
    });
  });

  it("fails without a model call when the stored settings fail their schema", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO settings (owner_id, revision, document, updated_at) VALUES (?, 1, ?, ?)",
    )
      .bind(device.ownerId, JSON.stringify({ bindings: "synthetic" }), Date.now())
      .run();
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: branchPage(),
      slots: customSlots,
      signedIn: false,
    });
    expect(response.status).toBe(500);
    expect(sent).toHaveLength(0);
    // A list of accounts and a page without a custom-field offer never read the settings.
    replies.push({
      text: JSON.stringify({ result: { decision: "account-list", other: "other" } }),
    });
    expect(
      await generateCustom(device, {
        ...observation("/accounts", [element("other", "button", "Use another account")]),
        accounts: ["[email]"],
      }),
    ).toMatchObject({ status: "recipe" });
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(sent).toHaveLength(2);
  });

  it("reserves a later page's carried name on the first page, so the later page keeps it", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    await saveBindings(device, binding(recipeId, "item-1", { slot: "店番", field: pinField }));
    // The first page's unbound field reads as the PIN's carried name.
    replies.push({ text: named(fields(["custom-1", "branch"]), "next", "advance") });
    const first = await generateCustom(device, branchPage("店番"));
    expect(first).toMatchObject({
      change: { recipe: { slots: ["店番 2"] } },
      customSlots: [{ slot: "店番 2", offered: "custom-1" }],
    });
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
    expect(await generateCustom(device, pinPage(), { recipeId, revision: 1 })).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["店番 2", "店番"] } },
      customSlots: [{ slot: "店番", offered: "custom-2" }],
    });
  });

  it("ignores bindings of built-in fields", async () => {
    expect(
      await firstPageAfter(
        branchPage(),
        [["custom-1", "branch"]],
        [
          { slot: "店番", field: "password" },
          { slot: "暗証", field: "totp" },
        ],
      ),
    ).toMatchObject({ change: { recipe: { slots: ["Branch code"] } } });
  });

  describe("a continuation's clash with the recipe it continues", () => {
    /** The first page, named `Branch` from the page, with `bindings` saved after it. */
    async function continued(...entries: Entry[]) {
      const device = await owner();
      replies.push({ text: named(fields(["custom-1", "branch"]), "next", "advance") });
      const first = await generateCustom(device, branchPage("Branch"));
      if (first.status !== "recipe") throw new Error(first.status);
      await saveBindings(
        device,
        binding(
          first.change.recipeId,
          "item-1",
          { slot: "Branch", field: branchField },
          ...entries,
        ),
      );
      return { device, base: { recipeId: first.change.recipeId, revision: 1 } };
    }
    const refused = { version: 1, status: "failed", error: "recipe-invalid" };

    it("refuses a carried name the recipe already has", async () => {
      const { device, base } = await continued({ slot: "branch", field: pinField });
      replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
      expect(await generateCustom(device, pinPage(), base)).toEqual(refused);
    });

    it("refuses a page whose own text the recipe already has, whatever it carries", async () => {
      const { device, base } = await continued({ slot: "暗証", field: pinField });
      replies.push({ text: named(fields(["custom-2", "pin"]), "sign-in", "submit") });
      expect(await generateCustom(device, pinPage("BRANCH"), base)).toEqual(refused);
    });

    it("refuses the recipe's field asked again under its carried name", async () => {
      const { device, base } = await continued();
      replies.push({ text: named(fields(["custom-1", "branch"]), "next", "advance") });
      expect(
        await generateCustom(
          device,
          observation("/again", [
            element("branch", "text", "Branch again"),
            element("next", "button", "Next"),
          ]),
          base,
        ),
      ).toEqual(refused);
    });
  });
});

describe("completion judgement", () => {
  it("passes rejection through, keeping only the verdict", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect(await complete(device, change.recipeId, 2)).toEqual({
      status: 200,
      body: { version: 1, status: "rejected" },
    });
    // Each revision and path is judged once, so another page path is sent.
    replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect(
      (await complete(device, change.recipeId, 2, { ...homePage, path: "/welcome" })).body,
    ).toEqual({
      version: 1,
      status: "unclear",
    });
    const [head] = await rows(
      "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
      device.ownerId,
      change.recipeId,
    );
    expect(head).toEqual({ revision: 2 });
    // A path judged `rejected` is answered so again; one the model could not decide is
    // only `already-judged` (ADR 0029).
    const calls = sent.length;
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-rejected",
    });
    expect(
      (await complete(device, change.recipeId, 2, { ...homePage, path: "/welcome" })).body,
    ).toEqual({ version: 1, status: "unavailable", reason: "already-judged" });
    expect(sent).toHaveLength(calls);
  });

  // A description that left out a disabled field may hide a code field waiting for its code
  // (owner, 2026-10-12, ADR 0029).
  it("judges a path again in full after the model could not decide a partial page", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const verdict = async () =>
      (
        await rows(
          "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
          device.ownerId,
        )
      ).map((row) => row["verdict"]);
    replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2, homePage, true)).body).toEqual({
      version: 1,
      status: "unclear",
    });
    expect(await verdict()).toEqual(["partial"]);
    // Left out again, the page is not judged again, and the answer never completes it.
    const calls = sent.length;
    expect((await complete(device, change.recipeId, 2, homePage, true)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
    });
    expect(sent).toHaveLength(calls);
    // Described in full, the path is judged again, and its verdict is kept as usual.
    replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unclear",
    });
    expect(sent).toHaveLength(calls + 1);
    expect(await verdict()).toEqual(["unclear"]);
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
    });
    expect(sent).toHaveLength(calls + 1);
  });

  it("keeps a partial page's decided verdict as for any page", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }) });
    expect((await complete(device, change.recipeId, 2, homePage, true)).body).toMatchObject({
      version: 1,
      status: "signed-in",
    });
    expect(
      await rows(
        "SELECT verdict FROM page_judgements WHERE owner_id = ? AND path = '/home'",
        device.ownerId,
      ),
    ).toEqual([{ verdict: "signed-in" }]);
  });

  it("logs which check refused a judgement's output, as codes only", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // A code source outside the list: the output format refuses it.
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "challenge",
          code: { field: "logout", submit: "help", source: "Text message to your phone" },
        },
      }),
    });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
    const [logged] = await rows(
      "SELECT outcome, prompt_version, result FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect({ ...logged, result: JSON.parse(String(logged!.result)) }).toEqual({
      outcome: "invalid-output",
      prompt_version: await completionPromptVersion(),
      result: {
        rejection: { check: "schema", issue: "picklist", path: "result.code.source" },
      },
    });
    expect(String(logged!.result)).not.toMatch(/phone/u);
    expect(info).toHaveBeenCalledWith("Model output refused", {
      role: "judge",
      promptVersion: await completionPromptVersion(),
      rejection: { check: "schema", issue: "picklist", path: "result.code.source" },
    });
    info.mockRestore();
    // The failed request left the path without a verdict, so a later login of the
    // revision never completes on it (ADR 0029).
    const calls = sent.length;
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judgement-unanswered",
    });
    expect(sent).toHaveLength(calls);
  });

  it("does not judge a page that shows the login form again", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = sent.length;
    const reposted = observation("/session", [
      element("email", "email", "Email"),
      element("help", "link", "Help"),
    ]);
    expect((await complete(device, change.recipeId, 2, reposted)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(sent).toHaveLength(calls);
  });

  it("checks the recipe, revision, origin and owner before any call", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = sent.length;

    expect((await complete(device, change.recipeId, 1)).body).toMatchObject({
      reason: "recipe-conflict",
    });
    // Another origin is judged only over HTTPS (ADR 0022).
    expect(
      (
        await complete(device, change.recipeId, 2, {
          ...homePage,
          origin: "http://www.example.test",
        })
      ).status,
    ).toBe(400);
    expect((await complete(device, "gen-missing", 1)).status).toBe(404);
    // Another owner cannot see or judge this owner's recipe.
    expect((await complete(await owner(), change.recipeId, 2)).status).toBe(404);
    expect(sent).toHaveLength(calls);
  });

  it("answers other methods with 405", async () => {
    const device = await owner();
    const responses = await Promise.all(
      ["/v1/recipes/generate", "/v1/recipes/gen-1/completion"].map((path) =>
        exports.default.fetch(`https://pateat.invalid${path}`, {
          headers: { Authorization: `Bearer ${device.token}` },
        }),
      ),
    );
    const put = await post(device, "/v1/recipes/generate", {}, "PUT");
    for (const response of [...responses, put]) {
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
    }
  });
});

describe("page judgement (ADR 0027)", () => {
  const judgeReply = (result: unknown) => ({ text: JSON.stringify({ result }) });
  const webauthnPage = observation("/login/webauthn", [
    element("key", "button", "Use security key"),
    element("recovery", "link", "Use a recovery code"),
  ]);
  // One clock read: the clock can tick between two, which gives the previous day's last
  // millisecond and lets the judgement purge delete a row seeded as today's.
  const dayStart = () => {
    const now = Date.now();
    return now - (now % DAY_MS);
  };
  const judgements = (device: Device) =>
    rows(
      "SELECT recipe_id, revision, path FROM page_judgements WHERE owner_id = ? ORDER BY recipe_id, revision, path",
      device.ownerId,
    );
  /** A judgement row; without a prompt version, as an earlier judge left it. */
  const seed = (
    device: Device,
    recipeId: string,
    revision: number,
    path: string,
    at: number,
    {
      promptVersion = "",
      verdict = null,
    }: { promptVersion?: string; verdict?: string | null } = {},
  ) =>
    env.DB.prepare(
      "INSERT INTO page_judgements (owner_id, recipe_id, revision, origin, path, prompt_version, judged_at, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(device.ownerId, recipeId, revision, ORIGIN, path, promptVersion, at, verdict)
      .run();
  const spend = (device: Device) =>
    rows(
      "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
      device.ownerId,
    );
  const head = async (device: Device, recipeId: string) =>
    (
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        recipeId,
      )
    )[0]?.["revision"];

  it("names the route, which must be one the stored recipe has", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = sent.length;
    const unknownRoute = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      revision: 2,
      route: "sso",
      observation: homePage,
    });
    expect(unknownRoute.status).toBe(400);
    // A known route the stored recipe does not have is a conflict, with no model call.
    const passkeyRoute = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      revision: 2,
      route: "passkey",
      observation: homePage,
    });
    expect(await passkeyRoute.json()).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(sent).toHaveLength(calls);
    replies.push(judgeReply({ decision: "rejected" }));
    const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      revision: 2,
      route: "password",
      observation: homePage,
    });
    expect(await response.json()).toEqual({ version: 1, status: "rejected" });
    // The logged request names the route, and the row the judge's prompt version. The
    // conflict's row has no login paths: the stored revision has no such route.
    const [conflict, logged] = await rows(
      "SELECT request, prompt_version, outcome FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY created_at",
      device.ownerId,
    );
    expect(conflict!.outcome).toBe("recipe-conflict");
    const conflictRequest = JSON.parse(String(conflict!.request)) as Record<string, unknown>;
    expect(conflictRequest).toMatchObject({ route: "passkey", observation: homePage });
    expect(conflictRequest).not.toHaveProperty("loginPaths");
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "password",
      loginPaths: ["/login", "/password"],
    });
    expect(logged!["prompt_version"]).toBe(await completionPromptVersion());
    expect(logged!["prompt_version"]).not.toBe(await generationPromptVersion());
  });

  it("judges the page after an advance whose next step never appeared", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, first.change.recipeId, 1)).body).toMatchObject({
      status: "signed-in",
      change: {
        revision: 2,
        recipe: { completion: [{ target: { by: "id", value: "logout" } }] },
      },
    });
    expect(sent).toHaveLength(2);
  });

  it("adds a later signed-in page's marker, up to four (ADR 0029)", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 3 },
    });
    const markers = ["account", "settings", "inbox"];
    for (const [index, marker] of markers.entries()) {
      const page = observation(`/${marker}`, [element(marker, "button", "Account")]);
      replies.push(judgeReply({ decision: "signed-in", marker }));
      // oxlint-disable-next-line no-await-in-loop -- Each marker lands in its own revision.
      expect((await complete(device, change.recipeId, 3 + index, page)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 4 + index,
          recipe: {
            completion: ["logout", ...markers.slice(0, index + 1)].map((value) => ({
              target: { by: "id", value },
            })),
          },
        },
      });
    }
    // With four, a later signed-in page changes nothing.
    const fifth = observation("/fifth", [element("fifth", "button", "Account")]);
    replies.push(judgeReply({ decision: "signed-in", marker: "fifth" }));
    expect((await complete(device, change.recipeId, 6, fifth)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(sent).toHaveLength(7);
    expect(await head(device, change.recipeId)).toBe(6);
  });

  it("answers signed-in without a change when a later marker cannot be added", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    await complete(device, change.recipeId, 2);
    // The judge names the first page's Next button, which is never a marker (ADR 0029).
    const welcome = observation("/welcome", [element("next", "button", "Next")]);
    replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
    expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  it("does not judge a page that shows a route fill field or a signed-in marker", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    await complete(device, change.recipeId, 2);
    const calls = sent.length;
    const before = await spend(device);
    const stored = await judgements(device);
    for (const page of [
      // A marker proves the sign-in already, on any path.
      observation("/elsewhere", [element("logout", "button", "Sign out")]),
      // A route's fill field on another path than its step's.
      observation("/session", [
        element("password", "password", "Password"),
        element("help", "link", "Help"),
      ]),
    ])
      // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
      expect((await complete(device, change.recipeId, 3, page)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
    expect(sent).toHaveLength(calls);
    expect(await spend(device)).toEqual(before);
    expect(await judgements(device)).toEqual(stored);
  });

  it("maps a first marker write refused for bytes to recipe-limit", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES - documentBytes(change.recipe));
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    const answer = await complete(device, change.recipeId, 2, homePage);
    expect(answer.body).toEqual({ version: 1, status: "unavailable", reason: "recipe-limit" });
    expect(await head(device, change.recipeId)).toBe(2);
    expect(sent).toHaveLength(3);
  });

  it("answers signed-in when a later marker is refused for bytes", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    const first = await complete(device, change.recipeId, 2, homePage);
    if (!("change" in first.body) || !first.body.change) throw new Error("no change");
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES - documentBytes(first.body.change.recipe),
    );
    const account = observation("/account", [element("account", "button", "Account")]);
    replies.push(judgeReply({ decision: "signed-in", marker: "account" }));
    expect((await complete(device, change.recipeId, 3, account)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(await head(device, change.recipeId)).toBe(3);
    expect(sent).toHaveLength(4);
  });

  it("answers challenge when its handler is refused for bytes", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES - documentBytes(change.recipe));
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const answer = await complete(device, change.recipeId, 2, webauthnPage);
    expect(answer.body).toEqual({ version: 1, status: "challenge" });
    expect(await head(device, change.recipeId)).toBe(2);
    expect(sent).toHaveLength(3);
  });

  it("judges each revision and path once", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "challenge" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    const calls = sent.length;
    // The earlier judgement was `challenge`, so the page never completes a login (ADR 0029).
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(sent).toHaveLength(calls);
    // Another path of the same revision is judged; here it adds a handler.
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    expect((await complete(device, change.recipeId, 2, webauthnPage)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    // The new revision may judge the first path again.
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, change.recipeId, 3)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 4 },
    });
    expect(sent).toHaveLength(calls + 2);
    expect(await judgements(device)).toEqual([
      { recipe_id: change.recipeId, revision: 2, path: "/home" },
      { recipe_id: change.recipeId, revision: 2, path: "/login/webauthn" },
      { recipe_id: change.recipeId, revision: 3, path: "/home" },
    ]);
  });

  describe("a page of another origin of the site (ADR 0022)", () => {
    const moved = (path: string, candidates: ObservedCandidate[]) =>
      observation(path, candidates, "https://www.example.test");
    const movedHome = moved("/home", [
      element("logout", "button", "Sign out"),
      element("help", "link", "Help"),
    ]);
    const origins = (device: Device) =>
      rows(
        "SELECT origin, path, verdict FROM page_judgements WHERE owner_id = ? ORDER BY origin, verdict",
        device.ownerId,
      );

    it("judges it apart from the recipe's origin and learns its marker with that origin", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // The recipe's own `/home` at the same revision does not count as this page judged.
      replies.push(judgeReply({ decision: "unclear" }));
      expect((await complete(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unclear",
      });
      replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      expect((await complete(device, change.recipeId, 2, movedHome)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 3,
          recipe: {
            completion: [
              { target: { by: "id", value: "logout" }, origin: "https://www.example.test" },
            ],
          },
        },
      });
      // The recipe's own origin, on the same path, is another page with its own marker.
      replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      expect((await complete(device, change.recipeId, 3)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 4,
          recipe: {
            completion: [
              { target: { by: "id", value: "logout" }, origin: "https://www.example.test" },
              { target: { by: "id", value: "logout" } },
            ],
          },
        },
      });
      expect(await origins(device)).toEqual([
        { origin: ORIGIN, path: "/home", verdict: "signed-in" },
        { origin: ORIGIN, path: "/home", verdict: "unclear" },
        { origin: "https://www.example.test", path: "/home", verdict: "signed-in" },
      ]);
      // Its marker now proves the sign-in there, so the page is not judged again.
      const calls = sent.length;
      expect((await complete(device, change.recipeId, 4, movedHome)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
      expect(sent).toHaveLength(calls);
    });

    it("answers a page judged signed-in before as such, and an undecided one as already judged", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // The first page's Next button is never a marker, so nothing is learned there.
      const welcome = moved("/welcome", [element("next", "button", "Next")]);
      replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      await complete(device, change.recipeId, 2);
      replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
      expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
        version: 1,
        status: "signed-in",
      });
      const unclear = moved("/later", [element("help", "link", "Help")]);
      replies.push(judgeReply({ decision: "unclear" }));
      expect((await complete(device, change.recipeId, 3, unclear)).body).toEqual({
        version: 1,
        status: "unclear",
      });
      const calls = sent.length;
      expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-signed-in",
      });
      expect((await complete(device, change.recipeId, 3, unclear)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "already-judged",
      });
      expect(sent).toHaveLength(calls);
    });

    it("answers signed-in when its marker cannot be learned, as a later request would", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // The first page's Next button is never a marker, and the recipe has none yet.
      replies.push(judgeReply({ decision: "signed-in", marker: "next" }));
      expect(
        (
          await complete(
            device,
            change.recipeId,
            2,
            moved("/welcome", [element("next", "button", "Next")]),
          )
        ).body,
      ).toEqual({ version: 1, status: "signed-in" });
      expect(await head(device, change.recipeId)).toBe(2);
    });

    it("judges it only for a password login", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = sent.length;
      const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
        version: 1,
        revision: 2,
        route: "passkey",
        observation: movedHome,
      });
      expect(response.status).toBe(400);
      expect(sent).toHaveLength(calls);
    });

    it("keeps no handler for a challenge there", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
      expect(
        (
          await complete(
            device,
            change.recipeId,
            2,
            moved("/login/webauthn", [element("key", "button", "Use security key")]),
          )
        ).body,
      ).toEqual({ version: 1, status: "challenge" });
      expect(await head(device, change.recipeId)).toBe(2);
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "passkey", kept: false, reason: "origin-mismatch" }],
      });
    });

    it("judges a page of another site a password login moved to after a second factor", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const portal = "https://portal.elsewhere.test";
      const portalHome = observation("/home", [element("logout", "button", "Sign out")], portal);
      // A page answered by itself may ask for the passkey, so no recipe step shows it: the
      // extension alone knows the second factor (ADR 0022).
      replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      expect((await complete(device, change.recipeId, 2, portalHome)).body).toMatchObject({
        status: "signed-in",
        change: {
          revision: 3,
          recipe: { completion: [{ target: { by: "id", value: "logout" }, origin: portal }] },
        },
      });
      const calls = sent.length;
      // Only over HTTPS, and only for the password route.
      expect(
        (
          await complete(device, change.recipeId, 3, {
            ...portalHome,
            origin: "http://portal.test",
          })
        ).status,
      ).toBe(400);
      const passkey = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
        version: 1,
        revision: 3,
        route: "passkey",
        observation: portalHome,
      });
      expect(passkey.status).toBe(400);
      expect(sent).toHaveLength(calls);
    });

    it("judges its page on a recipe path when it shows no field to fill", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // `/password` is a path of the recipe's own origin; only its sign-in button shows here.
      replies.push(judgeReply({ decision: "unclear" }));
      expect(
        (
          await complete(
            device,
            change.recipeId,
            2,
            moved("/password", [element("sign-in", "button", "Sign in")]),
          )
        ).body,
      ).toEqual({ version: 1, status: "unclear" });
    });
  });

  it("judges a path again once the judge changed", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    // An earlier judge judged the page `challenge` and kept no handler, as for a code split
    // into one-digit inputs before those were learned.
    await seed(device, change.recipeId, 2, "/login/webauthn", dayStart(), {
      verdict: "challenge",
    });
    const calls = sent.length;
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    expect((await complete(device, change.recipeId, 2, webauthnPage)).body).toMatchObject({
      status: "challenge",
      change: { revision: 3 },
    });
    expect(sent).toHaveLength(calls + 1);
    // The earlier row keeps its verdict beside the new one.
    expect(
      await rows(
        "SELECT prompt_version, verdict FROM page_judgements WHERE owner_id = ? AND path = ? ORDER BY prompt_version",
        device.ownerId,
        "/login/webauthn",
      ),
    ).toEqual([
      { prompt_version: "", verdict: "challenge" },
      { prompt_version: await completionPromptVersion(), verdict: "challenge" },
    ]);
    // The current judge's own verdict still stops a repeat.
    await seed(device, change.recipeId, 3, "/home", dayStart(), {
      promptVersion: await completionPromptVersion(),
      verdict: "challenge",
    });
    expect((await complete(device, change.recipeId, 3)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-challenge",
    });
    expect(sent).toHaveLength(calls + 1);
  });

  it("judges a recipe at most 20 times a UTC day, whatever the path", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = sent.length;
    for (let index = 0; index < 20; index++)
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seed(device, change.recipeId, 1, `/p${index}`, dayStart() + index);
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judgement-limit",
    });
    expect(sent).toHaveLength(calls);
  });

  it("counts only this recipe's judgements of the current UTC day", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    for (let index = 0; index < 19; index++)
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seed(device, change.recipeId, 2, `/today-${index}`, dayStart() + index);
    for (let index = 0; index < 5; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seed(device, change.recipeId, 2, `/yesterday-${index}`, dayStart() - 1 - index);
      // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
      await seed(device, "gen-other", 1, `/other-${index}`, dayStart() + index);
    }
    replies.push(judgeReply({ decision: "rejected" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    // That was the 20th today; the next page waits for the next UTC day.
    expect(
      (await complete(device, change.recipeId, 2, { ...homePage, path: "/welcome" })).body,
    ).toMatchObject({ reason: "judgement-limit" });
  });

  it("purges older revisions' and judges' judgements once their day is over", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const promptVersion = await completionPromptVersion();
    await seed(device, change.recipeId, 1, "/old", dayStart() - 1);
    await seed(device, change.recipeId, 1, "/recent", dayStart());
    await seed(device, change.recipeId, 2, "/current", dayStart() - 1, { promptVersion });
    await seed(device, change.recipeId, 2, "/earlier-judge", dayStart() - 1);
    await seed(device, "gen-other", 1, "/other", dayStart() - 1);
    replies.push(judgeReply({ decision: "rejected" }));
    await complete(device, change.recipeId, 2);
    expect(await judgements(device)).toEqual([
      { recipe_id: change.recipeId, revision: 1, path: "/recent" },
      { recipe_id: change.recipeId, revision: 2, path: "/current" },
      { recipe_id: change.recipeId, revision: 2, path: "/home" },
      { recipe_id: "gen-other", revision: 1, path: "/other" },
    ]);
  });

  it("adds a passkey handler for a challenge naming a security-key button", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const judged = await complete(device, change.recipeId, 2, webauthnPage);
    expect(judged).toMatchObject({
      status: 200,
      body: {
        version: 1,
        status: "challenge",
        change: {
          recipeId: change.recipeId,
          revision: 3,
          state: "active",
          recipe: {
            revision: 3,
            steps: route(change.recipe).steps,
            handlers: [
              { kind: "passkey", path: "/login/webauthn", target: { by: "id", value: "key" } },
            ],
          },
        },
      },
    });
    expect(await head(device, change.recipeId)).toBe(3);
    expect(
      await rows(
        "SELECT created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ? AND revision = 3",
        device.ownerId,
        change.recipeId,
      ),
    ).toEqual([{ created_by_device_id: device.deviceId }]);
    // Later judgements tell the model the handler's path is part of the login.
    replies.push(judgeReply({ decision: "unclear" }));
    await complete(device, change.recipeId, 3);
    expect(JSON.stringify(sent.at(-1)!.body)).toContain(
      String.raw`\"loginPaths\":[\"/login\",\"/password\",\"/login/webauthn\"]`,
    );
    // The handler's revision is on its judgement's row; the undecided page wrote none.
    expect(
      (await logRows(device.ownerId, "judge")).map(({ base_revision, revision, answer }) => ({
        base_revision,
        revision,
        answer,
      })),
    ).toEqual([
      { base_revision: 2, revision: 3, answer: { decision: "challenge", passkeyButton: "key" } },
      { base_revision: 3, revision: null, answer: { decision: "unclear" } },
    ]);
  });

  it("answers a plain challenge for a registration button or a duplicate handler", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const register = observation("/login/webauthn", [
      element("add", "button", "Add a passkey"),
      element("key", "button", "Use security key"),
    ]);
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "add" }));
    expect((await complete(device, change.recipeId, 2, register)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(await head(device, change.recipeId)).toBe(2);
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    const added = await complete(device, change.recipeId, 2, { ...webauthnPage, path: "/mfa" });
    expect(added.body).toMatchObject({ status: "challenge", change: { revision: 3 } });
    // Another button on a path that already has a passkey handler adds nothing.
    const again = observation("/mfa", [element("other", "button", "Use your passkey")]);
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "other" }));
    expect((await complete(device, change.recipeId, 3, again)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  describe("a page that asks how to confirm the sign-in (ADR 0048)", () => {
    // The page after the identifier's Next: no inputs, a choice of how to verify.
    const choicePage = (label = "Password") =>
      observation("/login", [
        element("choose-password", "button", label),
        element("mobile", "button", "Mobile"),
        element("cancel", "link", "Cancel"),
      ]);
    const passwordHandler = {
      kind: "password",
      path: "/login",
      target: { by: "id", value: "choose-password" },
    };
    async function identifierRecipe(device: Device) {
      replies.push({ text: plan([["email", "email"]], "next", "advance") });
      const first = await generate(device, emailPage);
      if (first.status !== "recipe") throw new Error(first.status);
      return first.change;
    }

    it("adds a password handler, which a continuation of the route keeps", async () => {
      const device = await owner();
      const info = vi.spyOn(console, "info");
      const change = await identifierRecipe(device);
      replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      const judged = await complete(device, change.recipeId, 1, choicePage());
      expect(judged.body).toMatchObject({
        status: "challenge",
        change: {
          revision: 2,
          recipe: { steps: route(change.recipe).steps, handlers: [passwordHandler] },
        },
      });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: true }],
      });
      // The judge was told what such a page and its button are.
      expect(JSON.stringify(sent.at(-1)!.body)).toContain("passwordButton is the button");
      // The password page after the press continues the route; the handler stays.
      replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
      const continued = await generate(device, passwordPage, {
        recipeId: change.recipeId,
        revision: 2,
      });
      if (continued.status !== "recipe") throw new Error(continued.status);
      expect(continued.change.revision).toBe(3);
      expect(route(continued.change.recipe)).toMatchObject({
        steps: [
          { kind: "fill", path: "/login" },
          { kind: "click", path: "/login", purpose: "advance" },
          { kind: "fill", path: "/password" },
          { kind: "click", path: "/password", purpose: "submit" },
        ],
        handlers: [passwordHandler],
      });
      info.mockRestore();
    });

    it("answers a plain challenge for a button that does not name the password", async () => {
      const device = await owner();
      const change = await identifierRecipe(device);
      const info = vi.spyOn(console, "info");
      replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      expect(
        (await complete(device, change.recipeId, 1, choicePage("Forgot password?"))).body,
      ).toEqual({ version: 1, status: "challenge" });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: false, reason: "not-password" }],
      });
      expect(await head(device, change.recipeId)).toBe(1);
      info.mockRestore();
    });

    it("never learns one for a recipe that already types the password", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info");
      const later = observation("/verify", [element("choose-password", "button", "Password")]);
      replies.push(judgeReply({ decision: "challenge", passwordButton: "choose-password" }));
      expect((await complete(device, change.recipeId, 2, later)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [{ kind: "password", kept: false, reason: "password-filled" }],
      });
      expect(await head(device, change.recipeId)).toBe(2);
      info.mockRestore();
    });
  });

  it("adds a totp handler for an authenticator app code, beside a passkey handler in one revision", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const code = {
      ...element("app-code", "text", "Authentication code"),
      autocomplete: "one-time-code" as const,
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const verify = element("verify", "button", "Verify");
    const mfa = observation("/login/mfa", [
      code,
      verify,
      element("key", "button", "Use security key"),
    ]);
    const answer = (source: string, passkeyButton?: string) =>
      judgeReply({
        decision: "challenge",
        ...(passkeyButton ? { passkeyButton } : {}),
        code: { field: "app-code", submit: "verify", source },
      });
    replies.push(answer("authenticator-app", "key"));
    expect((await complete(device, change.recipeId, 2, mfa)).body).toMatchObject({
      status: "challenge",
      change: {
        revision: 3,
        recipe: {
          revision: 3,
          steps: route(change.recipe).steps,
          handlers: [
            { kind: "passkey", path: "/login/mfa", target: { by: "id", value: "key" } },
            {
              kind: "totp",
              path: "/login/mfa",
              field: { by: "id", value: "app-code" },
              target: { by: "id", value: "verify" },
            },
          ],
        },
      },
    });
    expect(await head(device, change.recipeId)).toBe(3);
    // A code sent by SMS or email adds nothing.
    for (const [path, source] of [
      ["/login/sms", "sms"],
      ["/login/email", "email"],
    ] as const) {
      replies.push(answer(source));
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Each page is judged on its own.
        (await complete(device, change.recipeId, 3, observation(path, [code, verify]))).body,
      ).toEqual({ version: 1, status: "challenge" });
    }
    expect(await head(device, change.recipeId)).toBe(3);
    // A code whose source the page does not say adds a totp handler (owner, 2026-10-13).
    replies.push(answer("unknown"));
    expect(
      (await complete(device, change.recipeId, 3, observation("/login/code", [code, verify]))).body,
    ).toMatchObject({
      status: "challenge",
      change: {
        revision: 4,
        recipe: {
          handlers: [
            { kind: "passkey", path: "/login/mfa" },
            { kind: "totp", path: "/login/mfa" },
            {
              kind: "totp",
              path: "/login/code",
              field: { by: "id", value: "app-code" },
              target: { by: "id", value: "verify" },
            },
          ],
        },
      },
    });
    expect(await head(device, change.recipeId)).toBe(4);
  });

  it("does not learn a completion on a page that shows a totp handler's code field", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const code = {
      ...element("app-code", "text", "Authentication code"),
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    replies.push(
      judgeReply({
        decision: "challenge",
        code: { field: "app-code", submit: "verify", source: "authenticator-app" },
      }),
    );
    const mfa = observation("/login/mfa", [code, element("verify", "button", "Verify")]);
    expect((await complete(device, change.recipeId, 2, mfa)).body).toMatchObject({
      change: { revision: 3 },
    });
    // The code page again, with a link the model takes for a signed-in marker.
    replies.push(judgeReply({ decision: "signed-in", marker: "help" }));
    expect(
      (
        await complete(
          device,
          change.recipeId,
          3,
          observation("/login/mfa", [code, element("help", "link", "Help")]),
        )
      ).body,
    ).toEqual({ version: 1, status: "failed", error: "invalid-output" });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  describe("totp handlers, probed independently", () => {
    const appCode = {
      ...element("app-code", "text", "Authentication code"),
      autocomplete: "one-time-code" as const,
      inputMode: "numeric" as const,
      maxLength: 6,
    };
    const verify = element("verify", "button", "Verify");
    const code = (source: string) => ({ field: "app-code", submit: "verify", source });

    it("keeps the code when the named passkey button fails its checks, and the reverse", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // A registration button stores no passkey handler; the code still lands.
      const register = observation("/login/mfa", [
        appCode,
        verify,
        element("add", "button", "Add a passkey"),
      ]);
      replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "add",
          code: code("authenticator-app"),
        }),
      );
      const first = await complete(device, change.recipeId, 2, register);
      expect(first.body).toMatchObject({
        status: "challenge",
        change: {
          revision: 3,
          recipe: {
            handlers: [
              {
                kind: "totp",
                path: "/login/mfa",
                field: { by: "id", value: "app-code" },
                target: { by: "id", value: "verify" },
              },
            ],
          },
        },
      });
      // A field the TOTP fill rule refuses stores no totp handler; the passkey button lands.
      const plain = observation("/login/key", [
        element("plain", "text", "Code"),
        verify,
        element("key", "button", "Use security key"),
      ]);
      replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "key",
          code: { field: "plain", submit: "verify", source: "authenticator-app" },
        }),
      );
      const second = await complete(device, change.recipeId, 3, plain);
      expect(second.body).toMatchObject({ change: { revision: 4 } });
      if (!("change" in second.body) || !second.body.change) throw new Error("no change");
      expect(route(second.body.change.recipe).handlers?.map((handler) => handler.kind)).toEqual([
        "totp",
        "passkey",
      ]);
    });

    it("stores a code step in the sign-in form that reuses the route's button", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const sameForm = observation("/password", [appCode, element("sign-in", "button", "Sign in")]);
      replies.push(
        judgeReply({
          decision: "challenge",
          code: { field: "app-code", submit: "sign-in", source: "authenticator-app" },
        }),
      );
      expect((await complete(device, change.recipeId, 2, sameForm)).body).toMatchObject({
        change: {
          revision: 3,
          recipe: {
            steps: route(change.recipe).steps,
            handlers: [
              {
                kind: "totp",
                path: "/password",
                field: { by: "id", value: "app-code" },
                target: { by: "id", value: "sign-in" },
              },
            ],
          },
        },
      });
    });

    it("logs the kept handler's locators only, and refuses a page carrying values", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      replies.push(judgeReply({ decision: "challenge", code: code("authenticator-app") }));
      await complete(device, change.recipeId, 2, observation("/login/mfa", [appCode, verify]));
      replies.push(judgeReply({ decision: "challenge", code: code("sms") }));
      await complete(device, change.recipeId, 3, observation("/login/sms", [appCode, verify]));
      const logged = await rows(
        "SELECT request, result FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY created_at",
        device.ownerId,
      );
      expect(logged.map((row) => JSON.parse(String(row.result)))).toEqual([
        {
          decision: "challenge",
          totp: { field: { by: "id", value: "app-code" }, target: { by: "id", value: "verify" } },
        },
        // Why the SMS code was dropped, without an element.
        { decision: "challenge", totpDropped: "source-sms" },
      ]);
      // A synthetic code typed into the page never reaches the service or its log.
      const calls = sent.length;
      const withValue = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
        version: 1,
        revision: 3,
        route: "password",
        observation: observation("/login/other", [
          { ...appCode, value: "012345" } as never,
          verify,
        ]),
      });
      expect(withValue.status).toBe(400);
      expect(sent).toHaveLength(calls);
      const all = await rows(
        "SELECT request, result FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      );
      expect(JSON.stringify(all)).not.toContain("012345");
    });
  });

  it("names a revoked, moved or missing head as stale", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    expect(staleHead(change, 2)).toBeUndefined();
    const revoked = { recipeId: change.recipeId, revision: 3, state: "revoked" } as const;
    expect(staleHead(revoked, 2)).toBe("recipe-revoked");
    expect(staleHead(change, 1)).toBe("recipe-conflict");
    expect(staleHead(null, 2)).toBe("recipe-conflict");
  });

  it("makes one model call for a page sent twice at once", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = sent.length;
    let concurrent: unknown;
    during = async () => {
      concurrent = (await complete(device, change.recipeId, 2)).body;
    };
    replies.push(judgeReply({ decision: "rejected" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    // The owner's lock answers the second request while the first is judged.
    expect(concurrent).toEqual({ version: 1, status: "unavailable", reason: "busy" });
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      reason: "judged-rejected",
    });
    expect(sent).toHaveLength(calls + 1);
  });

  // Owner, 2026-10-13 05:39 UTC: a login of an item without a password but with a passkey
  // that stops before the password has that page judged for a passkey button beside the
  // password field (ADR 0036).
  describe("a page at a login's stop before a missing password (ADR 0036)", () => {
    const passkey = element("passkey", "button", "Sign in with a passkey");
    const stopPage = observation("/password", [
      ...passwordPage.candidates,
      passkey,
      element("add-passkey", "button", "Add a passkey"),
    ]);
    async function atStop(
      device: Device,
      recipeId: string,
      revision: number,
      page: LoginObservation = stopPage,
      extra: Record<string, unknown> = {},
    ) {
      const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        revision,
        route: "password",
        observation: page,
        stop: true,
        ...extra,
      });
      return {
        status: response.status,
        body: (await response.json()) as RecipeCompletionResult | { error: string },
      };
    }
    const stopRows = async (device: Device) =>
      rows(
        "SELECT revision, path, prompt_version, verdict FROM page_judgements WHERE owner_id = ? ORDER BY revision, path, prompt_version",
        device.ownerId,
      );

    it("still refuses the sign-in page from any other request, with no call", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const calls = sent.length;
      for (const page of [stopPage, emailPage, passwordPage])
        // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
        expect((await complete(device, change.recipeId, 2, page)).body).toEqual({
          version: 1,
          status: "unavailable",
          reason: "not-judgeable",
        });
      expect(sent).toHaveLength(calls);
      expect(await stopRows(device)).toEqual([]);
    });

    it("keeps only a passkey handler for the button beside the password field", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const code = {
        ...element("app-code", "text", "Authentication code"),
        autocomplete: "one-time-code" as const,
        inputMode: "numeric" as const,
        maxLength: 6,
      };
      const page = observation("/password", [
        ...stopPage.candidates,
        code,
        element("choose-password", "button", "Use your password"),
      ]);
      replies.push(
        judgeReply({
          decision: "challenge",
          passkeyButton: "passkey",
          passwordButton: "choose-password",
          code: { field: "app-code", submit: "sign-in", source: "authenticator-app" },
        }),
      );
      const judged = await atStop(device, change.recipeId, 2, page);
      expect(judged).toMatchObject({
        status: 200,
        body: {
          version: 1,
          status: "challenge",
          change: {
            revision: 3,
            recipe: {
              steps: route(change.recipe).steps,
              handlers: [{ kind: "passkey", path: "/password", target: passkey.target }],
            },
          },
        },
      });
      expect(await head(device, change.recipeId)).toBe(3);
      // The next revision's stop page on that path has its handler: never sent again.
      const before = sent.length;
      expect((await atStop(device, change.recipeId, 3, page)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
      expect(sent).toHaveLength(before);
      // The code beside it is never learned there, and the log says so without elements.
      expect(info).toHaveBeenCalledWith("Judged page handlers", {
        recipeId: change.recipeId,
        handlers: [
          { kind: "passkey", kept: true },
          { kind: "password", kept: false, reason: "stop" },
          { kind: "totp", kept: false, reason: "stop" },
        ],
      });
      info.mockRestore();
      // The model got the stop's instructions, under their own prompt version.
      const [logged] = await rows(
        "SELECT request, prompt_version FROM inference_log WHERE owner_id = ? AND role = 'judge'",
        device.ownerId,
      );
      expect(logged!["prompt_version"]).toBe(await completionStopPromptVersion());
      expect(logged!["prompt_version"]).not.toBe(await completionPromptVersion());
      expect(JSON.parse(String(logged!.request))).toMatchObject({
        route: "password",
        stop: true,
        loginPaths: ["/login", "/password"],
      });
      expect(JSON.stringify(sent.at(-1)!.body)).toContain(
        "This sign-in page still shows its password field",
      );
      expect(await stopRows(device)).toEqual([
        {
          revision: 2,
          path: "/password",
          prompt_version: await completionStopPromptVersion(),
          verdict: "challenge",
        },
      ]);
    });

    it("keeps no marker, rejection or registration button from the stop's page", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      // A button that adds a passkey is refused as on any page.
      replies.push(judgeReply({ decision: "challenge", passkeyButton: "add-passkey" }));
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      // A rejection is no rejection here, and a marker beside the password field fails
      // closed as on any sign-in page.
      replies.push(judgeReply({ decision: "rejected" }));
      expect(
        (await atStop(device, change.recipeId, 2, { ...stopPage, path: "/password/retry" })).body,
      ).toEqual({ version: 1, status: "unclear" });
      replies.push(judgeReply({ decision: "signed-in", marker: "passkey" }));
      expect(
        (await atStop(device, change.recipeId, 2, { ...stopPage, path: "/password/again" })).body,
      ).toEqual({ version: 1, status: "failed", error: "invalid-output" });
      expect(await head(device, change.recipeId)).toBe(2);
      expect((await stopRows(device)).map((row) => [row["path"], row["verdict"]]).sort()).toEqual([
        ["/password", "challenge"],
        ["/password/again", null],
        ["/password/retry", "unclear"],
      ]);
      // Each path is judged once, as for any page: a later stop's page is not sent again.
      const calls = sent.length;
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-challenge",
      });
      expect(sent).toHaveLength(calls);
    });

    it("refuses a stop's page without the route's password field, or with a marker", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
      await complete(device, change.recipeId, 2);
      const calls = sent.length;
      for (const page of [
        // No password field of the route: not a stop's page.
        observation("/password", [passkey, element("help", "link", "Help")]),
        emailPage,
        // Another password input than the route's.
        observation("/password", [element("other-password", "password", "Password"), passkey]),
        // The password field beside a signed-in marker.
        observation("/password", [...stopPage.candidates, element("logout", "button", "Out")]),
      ])
        // oxlint-disable-next-line no-await-in-loop -- Each page is sent on its own.
        expect((await atStop(device, change.recipeId, 3, page)).body).toEqual({
          version: 1,
          status: "unavailable",
          reason: "not-judgeable",
        });
      // A stop is a password login's, on the recipe's origin.
      expect(
        (await atStop(device, change.recipeId, 3, stopPage, { route: "passkey" })).status,
      ).toBe(400);
      expect(
        (
          await atStop(device, change.recipeId, 3, {
            ...stopPage,
            origin: "https://www.example.test",
          })
        ).body,
      ).toEqual({ version: 1, status: "unavailable", reason: "not-judgeable" });
      expect(sent).toHaveLength(calls);
    });

    it("keeps a stop's judgements apart from other pages' of the path, within the day's 20", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      replies.push(judgeReply({ decision: "challenge" }));
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "challenge",
      });
      // A code page on the same path after a password is still judged, and may learn its
      // handler: the stop's row does not answer it.
      const codePage = observation("/password", [
        {
          ...element("app-code", "text", "Authentication code"),
          autocomplete: "one-time-code" as const,
          inputMode: "numeric" as const,
          maxLength: 6,
        },
        element("verify", "button", "Verify"),
      ]);
      replies.push(
        judgeReply({
          decision: "challenge",
          code: { field: "app-code", submit: "verify", source: "authenticator-app" },
        }),
      );
      expect((await complete(device, change.recipeId, 2, codePage)).body).toMatchObject({
        status: "challenge",
        change: { revision: 3, recipe: { handlers: [{ kind: "totp", path: "/password" }] } },
      });
      // A stop's judgement counts toward the recipe's 20 a day.
      for (let index = 0; index < 18; index++)
        // oxlint-disable-next-line no-await-in-loop -- Synthetic rows, inserted in order.
        await seed(device, change.recipeId, 3, `/p${index}`, dayStart() + index);
      const calls = sent.length;
      expect((await atStop(device, change.recipeId, 3)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judgement-limit",
      });
      expect(sent).toHaveLength(calls);
    });

    it("keeps the current stop judge's rows when another page purges older ones", async () => {
      const device = await owner();
      const change = await twoPageRecipe(device);
      const stopVersion = await completionStopPromptVersion();
      await seed(device, change.recipeId, 2, "/password", dayStart() - 1, {
        promptVersion: stopVersion,
        verdict: "challenge",
      });
      await seed(device, change.recipeId, 2, "/earlier-judge", dayStart() - 1);
      replies.push(judgeReply({ decision: "rejected" }));
      await complete(device, change.recipeId, 2);
      expect(await judgements(device)).toEqual([
        { recipe_id: change.recipeId, revision: 2, path: "/home" },
        { recipe_id: change.recipeId, revision: 2, path: "/password" },
      ]);
      // And the stop's own repeat is answered from it, with no call.
      const calls = sent.length;
      expect((await atStop(device, change.recipeId, 2)).body).toEqual({
        version: 1,
        status: "unavailable",
        reason: "judged-challenge",
      });
      expect(sent).toHaveLength(calls);
    });
  });
});

describe("password route variants (ADR 0027)", () => {
  const custom = (id: string, fieldName: string): SemanticSlot => ({
    id,
    kind: "identifier",
    description: "value of the user's vault field named in fieldName",
    fieldName,
  });
  const variantSlots = [
    ...slots,
    custom("custom-1", "Synthetic branch field"),
    custom("custom-2", "Synthetic account field"),
    custom("custom-3", "Synthetic contract field"),
  ];
  const twoSetsPage = observation("/login", [
    element("branch", "text", "Branch"),
    element("account", "text", "Account"),
    element("contract", "text", "Or contract number"),
    element("password", "password", "Password"),
    element("sign-in", "button", "Sign in"),
  ]);
  const byBranch = [
    { slot: "custom-1", candidate: "branch" },
    { slot: "custom-2", candidate: "account" },
    { slot: "password", candidate: "password" },
  ];
  const byContract = [
    { slot: "custom-3", candidate: "contract" },
    { slot: "password", candidate: "password" },
  ];
  const twoSets = (alternative = byContract, purpose: "advance" | "submit" = "submit") =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: byBranch,
        action: { candidate: "sign-in", purpose: "submit" },
        alternatives: [{ fields: alternative, action: { candidate: "sign-in", purpose } }],
      },
    });
  async function generateVariants(device: Device) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: twoSetsPage,
      slots: variantSlots,
      signedIn: false,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }

  it("stores each identifier set as a variant and maps the custom slots of all of them", async () => {
    const device = await owner();
    replies.push({ text: twoSets() });
    const result = await generateVariants(device);
    expect(result).toMatchObject({
      status: "recipe",
      change: {
        revision: 1,
        recipe: {
          slots: ["Branch", "Account", "password"],
          alternatives: [{ slots: ["Or contract number", "password"] }],
          maxSubmissions: 1,
        },
      },
      // The password slot is named in both sets but is no custom slot; each name once.
      customSlots: [
        { slot: "Branch", offered: "custom-1" },
        { slot: "Account", offered: "custom-2" },
        { slot: "Or contract number", offered: "custom-3" },
      ],
    });
    if (result.status !== "recipe") return;
    expect(JSON.stringify(result.change)).not.toContain("Synthetic");
    // The request log keeps the sets the model returned, with the names the page gave.
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    const [branch, account, password] = byBranch;
    expect(JSON.parse(String(logged!.result))).toEqual({
      pageKind: "sign-in",
      irreversible: "no",
      fields: [{ ...branch, name: "Branch" }, { ...account, name: "Account" }, password],
      action: { candidate: "sign-in", purpose: "submit" },
      alternatives: [
        {
          fields: [{ ...byContract[0], name: "Or contract number" }, byContract[1]],
          action: { candidate: "sign-in", purpose: "submit" },
        },
      ],
    });
    // A recipe whose sets all submit is never continued.
    expect(
      await generate(device, passwordPage, { recipeId: result.change.recipeId, revision: 1 }),
    ).toEqual({ version: 1, status: "unavailable", reason: "recipe-conflict" });
    expect(sent).toHaveLength(1);
  });

  it("fails the whole plan when an alternative does not pass the checks", async () => {
    const device = await owner();
    replies.push({ text: twoSets(byContract, "advance") });
    expect(await generateVariants(device)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "variant-advance" },
    });
    const other = await owner();
    replies.push({
      text: twoSets([
        { slot: "custom-3", candidate: "branch" },
        { slot: "password", candidate: "password" },
      ]),
    });
    expect(await generateVariants(other)).toMatchObject({
      status: "failed",
      rejection: { check: "plan", reason: "inconsistent-candidate" },
    });
    expect(
      await rows(
        "SELECT * FROM recipe_revisions WHERE owner_id IN (?, ?)",
        device.ownerId,
        other.ownerId,
      ),
    ).toEqual([]);
  });

  it("does not judge a page that shows any variant's fill field, and never takes a variant", async () => {
    const device = await owner();
    replies.push({ text: twoSets() });
    const result = await generateVariants(device);
    if (result.status !== "recipe") throw new Error(result.status);
    const calls = sent.length;
    const contractAgain = observation("/error", [
      element("contract", "text", "Contract number"),
      element("retry", "button", "Try again"),
    ]);
    expect((await complete(device, result.change.recipeId, 1, contractAgain)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    const named = await post(device, `/v1/recipes/${result.change.recipeId}/completion`, {
      version: 1,
      revision: 1,
      route: "password",
      variant: 1,
      observation: homePage,
    });
    expect(named.status).toBe(400);
    expect(sent).toHaveLength(calls);
    // A signed-in page elsewhere learns the completion and keeps the alternatives.
    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }) });
    expect((await complete(device, result.change.recipeId, 1)).body).toMatchObject({
      status: "signed-in",
      change: {
        revision: 2,
        recipe: {
          completion: [{ target: { by: "id", value: "logout" } }],
          alternatives: [{ slots: ["Or contract number", "password"] }],
        },
      },
    });
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "password",
      loginPaths: ["/login"],
    });
    expect(JSON.parse(String(logged!.request))).not.toHaveProperty("variant");
  });

  it("maps a custom slot that several sets share once", async () => {
    const device = await owner();
    // Both sets ask for the branch number; the second adds a contract number instead of
    // the account number.
    replies.push({
      text: twoSets([
        { slot: "custom-1", candidate: "branch" },
        { slot: "custom-3", candidate: "contract" },
        { slot: "password", candidate: "password" },
      ]),
    });
    expect(await generateVariants(device)).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          slots: ["Branch", "Account", "password"],
          alternatives: [{ slots: ["Branch", "Or contract number", "password"] }],
        },
      },
      customSlots: [
        { slot: "Branch", offered: "custom-1" },
        { slot: "Account", offered: "custom-2" },
        { slot: "Or contract number", offered: "custom-3" },
      ],
    });
  });

  it("names every variant's path to the judge and refuses a page on any of them", async () => {
    const device = await owner();
    // An owner-written recipe whose second variant continues on its own page.
    const recipeId = "shop-variants";
    const fill = (path: string, slot: string) => ({
      kind: "fill" as const,
      effect: "prepare" as const,
      path,
      fields: [{ slot, target: { by: "id" as const, value: slot } }],
    });
    const click = (path: string, value: string, purpose: "advance" | "submit") => ({
      kind: "click" as const,
      path,
      target: { by: "id" as const, value },
      purpose,
    });
    const stored = await post(
      device,
      `/v1/recipes/${recipeId}`,
      {
        version: 1,
        expectedRevision: 0,
        state: "active",
        recipe: {
          version: 1,
          id: recipeId,
          revision: 1,
          origin: ORIGIN,
          pageKind: "sign-in",
          slots: ["email"],
          steps: [fill("/login", "email"), click("/login", "sign-in", "submit")],
          alternatives: [
            {
              slots: ["member", "pin"],
              steps: [
                fill("/login", "member"),
                click("/login", "next", "advance"),
                fill("/verify", "pin"),
                click("/verify", "confirm", "submit"),
              ],
            },
          ],
          maxSubmissions: 2,
        },
      },
      "PUT",
    );
    expect(stored.status).toBe(200);
    // The alternative's later field, shown on another path, is still a sign-in page.
    const pinAgain = observation("/retry", [element("pin", "password", "PIN")]);
    expect((await complete(device, recipeId, 1, pinAgain)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(sent).toEqual([]);
    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }) });
    expect((await complete(device, recipeId, 1)).body).toMatchObject({ status: "signed-in" });
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      loginPaths: ["/login", "/verify"],
    });
  });
});

describe("the passkey route (ADR 0027)", () => {
  const passkeyButton = {
    id: "passkey",
    role: "button" as const,
    target: { by: "text" as const, value: "Sign in with a passkey" },
    label: "Sign in with a passkey",
  };
  const signInPage = observation("/login", [
    element("email", "email", "Email"),
    element("password", "password", "Password"),
    element("sign-in", "button", "Sign in"),
    passkeyButton,
    element("add-passkey", "button", "Add a passkey"),
  ]);
  const answer = (button: string | undefined, purpose: "advance" | "submit" = "submit") =>
    JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields:
          purpose === "submit"
            ? [
                { slot: "email", candidate: "email" },
                { slot: "password", candidate: "password" },
              ]
            : [{ slot: "email", candidate: "email" }],
        action: { candidate: purpose === "submit" ? "sign-in" : "next", purpose },
        ...(button ? { passkeyButton: button } : {}),
      },
    });
  async function judge(device: Device, recipeId: string, revision: number, page: LoginObservation) {
    const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
      version: 1,
      revision,
      route: "passkey",
      observation: page,
    });
    return (await response.json()) as RecipeCompletionResult;
  }

  it("stores the start page's passkey button as the route and logs what the model named", async () => {
    const device = await owner();
    replies.push({ text: answer("passkey") });
    const result = await generate(device, signInPage);
    expect(result).toMatchObject({
      status: "recipe",
      change: {
        revision: 1,
        recipe: {
          slots: ["email", "password"],
          passkey: { path: "/login", target: passkeyButton.target },
        },
      },
    });
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).toMatchObject({ passkeyButton: "passkey" });
  });

  it.each([
    ["a registration button", "add-passkey"],
    ["the page action", "sign-in"],
    ["a candidate the page lacks", "missing"],
  ])("drops %s and stores the password route alone", async (_label, button) => {
    const device = await owner();
    replies.push({ text: answer(button) });
    const result = await generate(device, signInPage);
    if (result.status !== "recipe") throw new Error(result.status);
    expect(result.change.recipe).not.toHaveProperty("passkey");
    expect(route(result.change.recipe).slots).toEqual(["email", "password"]);
    // The result keeps nothing the plan check dropped; the model's own answer keeps what
    // it named, as `?` when the page lacks it.
    const [row] = await logRows(device.ownerId);
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).not.toHaveProperty("passkeyButton");
    expect(row!.answer).toMatchObject({
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      passkeyButton: button === "missing" ? "?" : button,
    });
  });

  it("tells the judge every path of the password form on the passkey route", async () => {
    const device = await owner();
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "email", candidate: "email" }],
          action: { candidate: "next", purpose: "advance" },
          passkeyButton: "passkey",
        },
      }),
    });
    const first = await generate(
      device,
      observation("/login", [...emailPage.candidates, passkeyButton]),
    );
    if (first.status !== "recipe") throw new Error(first.status);
    expect(first.change.recipe).toMatchObject({ passkey: { path: "/login" } });
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    const { recipeId, revision } = second.change;
    // The password page after the passkey click is the sign-in page, not a page to learn.
    const calls = sent.length;
    expect(await judge(device, recipeId, revision, passwordPage)).toMatchObject({
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(sent).toHaveLength(calls);
    replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect(await judge(device, recipeId, revision, homePage)).toMatchObject({
      status: "rejected",
    });
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "passkey",
      loginPaths: ["/login", "/password"],
    });
  });

  it("ignores a passkey button on a continued page", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    const passwordWithPasskey = observation("/password", [
      ...passwordPage.candidates,
      passkeyButton,
    ]);
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [{ slot: "password", candidate: "password" }],
          action: { candidate: "sign-in", purpose: "submit" },
          passkeyButton: "passkey",
        },
      }),
    });
    const second = await generate(device, passwordWithPasskey, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    expect(second.change.revision).toBe(2);
    expect(second.change.recipe).not.toHaveProperty("passkey");
  });

  it("judges the passkey route's pages, but not its start page while the button shows", async () => {
    const device = await owner();
    replies.push({ text: answer("passkey") });
    const result = await generate(device, signInPage);
    if (result.status !== "recipe") throw new Error(result.status);
    const { recipeId } = result.change;
    const calls = sent.length;
    // The passkey exchange may still run on the start page: not judged.
    const stillThere = observation("/login", [passkeyButton, element("help", "link", "Help")]);
    expect(await judge(device, recipeId, 1, stillThere)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(sent).toHaveLength(calls);
    // The password form showing again without the button is still the sign-in page, on
    // the start path or any other: judging it would spend the start path's one judgement
    // and could add a handler there (ADR 0027).
    for (const formAgain of [
      observation("/login", [
        element("email", "email", "Email"),
        element("password", "password", "Password"),
        element("sign-in", "button", "Sign in"),
      ]),
      observation("/login", [element("password", "password", "Password")]),
      observation("/retry", [element("email", "email", "Email")]),
    ])
      // Sequential, so each refusal is seen before the next request.
      // eslint-disable-next-line no-await-in-loop
      expect(await judge(device, recipeId, 1, formAgain)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "not-judgeable",
      });
    expect(sent).toHaveLength(calls);
    // Another path with the same text is another element, so that page is judged.
    replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect(await judge(device, recipeId, 1, observation("/help", [passkeyButton]))).toEqual({
      version: 1,
      status: "rejected",
    });
    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }) });
    expect(await judge(device, recipeId, 1, homePage)).toMatchObject({
      status: "signed-in",
      change: {
        revision: 2,
        recipe: {
          completion: [{ target: { by: "id", value: "logout" } }],
          passkey: { path: "/login", target: passkeyButton.target },
        },
      },
    });
    // The four pages not judged are logged unsent, with the same request.
    const logged = await rows(
      "SELECT request, model_id FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(logged.filter((row) => row["model_id"] !== null)).toHaveLength(2);
    expect(logged).toHaveLength(6);
    for (const row of logged)
      expect(JSON.parse(String(row.request))).toMatchObject({
        route: "passkey",
        loginPaths: ["/login"],
      });
    // On the password route, the button alone does not keep the start page from a judgement.
    replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect((await complete(device, recipeId, 2, stillThere)).body).toEqual({
      version: 1,
      status: "rejected",
    });
  });

  it("tells the judge every sign-in path on both routes of a recipe of two pages", async () => {
    const device = await owner();
    const start = observation("/login", [
      element("email", "email", "Email"),
      element("next", "button", "Next"),
      passkeyButton,
    ]);
    replies.push({ text: answer("passkey", "advance") });
    const first = await generate(device, start);
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, {
      recipeId: first.change.recipeId,
      revision: first.change.revision,
    });
    if (second.status !== "recipe") throw new Error(second.status);
    const { recipeId, revision } = second.change;
    // The continuation keeps the start page's route.
    expect(route(second.change.recipe).passkey).toEqual({
      path: "/login",
      target: passkeyButton.target,
    });
    const rejected = JSON.stringify({ result: { decision: "rejected" } });
    replies.push({ text: rejected });
    expect(await judge(device, recipeId, revision, homePage)).toEqual({
      version: 1,
      status: "rejected",
    });
    replies.push({ text: rejected });
    const elsewhere = observation("/elsewhere", [element("help", "link", "Help")]);
    expect((await complete(device, recipeId, revision, elsewhere)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    const logged = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge' ORDER BY path",
      device.ownerId,
    );
    expect(logged.map((row) => JSON.parse(String(row.request)))).toMatchObject([
      // `/elsewhere`, on the password route
      { route: "password", loginPaths: ["/login", "/password"] },
      // `/home`, on the passkey route
      { route: "passkey", loginPaths: ["/login", "/password"] },
    ]);
  });
});

describe("account lists and chooser branches (ADR 0028)", () => {
  const listPage: LoginObservation = {
    ...observation("/login", [
      element("other", "button", "Sign in with another profile"),
      element("help", "link", "Help"),
    ]),
    accounts: ["[email] Last used", "[email]"],
  };
  const listAnswer = (controls: { other?: string; continue?: string }) =>
    JSON.stringify({ result: { decision: "account-list", ...controls } });
  const judgeReply = (result: unknown) => ({ text: JSON.stringify({ result }) });
  async function branchGenerate(
    device: Device,
    page: LoginObservation,
    base: { recipeId: string; revision: number },
    branch: string,
  ) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots,
      base,
      branch,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }
  /** Stores the list as a chooser with an `other` button and returns its change. */
  async function chooser(device: Device) {
    replies.push({ text: listAnswer({ other: "other" }) });
    const answer = await generate(device, listPage);
    if (answer.status !== "recipe") throw new Error(answer.status);
    return answer.change;
  }

  it("stores a branch's page as sign-in whatever kind the model answers (ADR 0035)", async () => {
    const device = await owner();
    const change = await chooser(device);
    replies.push({
      text: JSON.stringify({
        result: {
          ...JSON.parse(plan([["email", "email"]], "next", "advance")).result,
          pageKind: "confirm",
          irreversible: "unclear",
        },
      }),
    });
    const answer = await branchGenerate(
      device,
      emailPage,
      { recipeId: change.recipeId, revision: change.revision },
      "other",
    );
    if (answer.status !== "recipe" || !("chooser" in answer.change.recipe))
      throw new Error(answer.status);
    expect(answer.change.recipe.chooser.afterOther?.pageKind).toBe("sign-in");
    // The log keeps what the model answered.
    expect(
      await rows(
        "SELECT signed_in, page_kind, irreversible FROM inference_log WHERE owner_id = ? AND recipe_page = 'continuation'",
        device.ownerId,
      ),
    ).toEqual([{ signed_in: null, page_kind: "confirm", irreversible: "unclear" }]);
  });

  it("stores a list of accounts as a chooser recipe and logs its controls by reference", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const change = await chooser(device);
    expect(change).toEqual({
      recipeId,
      revision: 1,
      state: "active",
      recipe: {
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        chooser: { path: "/login", other: { by: "id", value: "other" } },
      },
    });
    // The page went to the model with its accounts as the observation redacted them.
    expect(JSON.stringify(sent[0]!.body)).toContain(
      String.raw`\"accounts\":[\"[email] Last used\",\"[email]\"]`,
    );
    const [logged] = await rows(
      "SELECT outcome, result, prompt_version, request FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logged!.outcome).toBe("ok");
    expect(JSON.parse(String(logged!.result))).toEqual({ accountList: true, other: "other" });
    // Only a list's request carries the list line, with its own prompt version.
    expect(logged!["prompt_version"]).toBe(await accountListGenerationPromptVersion());
    expect(JSON.parse(String(logged!["request"]))).toMatchObject({
      instructions: accountListGenerationInstructions,
    });
    expect(await accountListGenerationPromptVersion()).not.toBe(await generationPromptVersion());
    expect(
      await rows(
        "SELECT recipe_id, branch, path, base_revision FROM generation_attempts WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ recipe_id: recipeId, branch: "", path: "/login", base_revision: 0 }]);
    // Another device sending the list gets the chooser without a call; a form page on the
    // same path gets no recipe from it.
    expect(await generate(device, listPage)).toEqual({ version: 1, status: "recipe", change });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(sent).toHaveLength(1);
  });

  it("stores a shown account's continue button beside the other one", async () => {
    const device = await owner();
    const wise = {
      ...observation("/login", [
        element("log-back-in", "button", "Log back in"),
        element("another", "button", "Use another account"),
      ]),
      accounts: ["[masked]"],
    };
    replies.push({ text: listAnswer({ other: "another", continue: "log-back-in" }) });
    expect(await generate(device, wise)).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          chooser: {
            path: "/login",
            other: { by: "id", value: "another" },
            continue: { by: "id", value: "log-back-in" },
          },
        },
      },
    });
  });

  it("refuses a plan for a list, a list for a form and controls that may be accounts", async () => {
    const expectRefused = async (page: LoginObservation, text: string, reason: string) => {
      const device = await owner();
      replies.push({ text });
      expect(await generate(device, page)).toEqual({
        version: 1,
        status: "failed",
        error: "invalid-output",
        rejection: { check: "plan", reason },
      });
      expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual(
        [],
      );
    };
    await expectRefused(
      { ...listPage, candidates: [...listPage.candidates, element("email", "email", "Email")] },
      plan([["email", "email"]], "other", "advance"),
      "unexpected-plan",
    );
    await expectRefused(emailPage, listAnswer({ other: "next" }), "unexpected-account-list");
    await expectRefused(listPage, listAnswer({ other: "missing" }), "unknown-candidate");
    await expectRefused(
      listPage,
      listAnswer({ other: "other", continue: "other" }),
      "duplicate-candidate",
    );
    await expectRefused(
      {
        ...listPage,
        candidates: [...listPage.candidates, element("profile", "button", "[email] Last used")],
      },
      listAnswer({ other: "profile" }),
      "account-text",
    );
  });

  it("stores no chooser naming no control for a list whose accounts are no entries", async () => {
    const device = await owner();
    // As on a card that shows the account above its buttons: no account is clicked itself.
    const beside: LoginObservation = { ...listPage, accounts: ["[email]"], accountEntries: 0 };
    replies.push({ text: listAnswer({}) });
    expect(await generate(device, beside)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "no-list-control" },
    });
    expect(sent).toHaveLength(1);
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
    expect(await rows("SELECT * FROM recipe_revisions WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    const [logged] = await rows(
      "SELECT outcome FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logged!.outcome).toBe("invalid-output");
  });

  it("generates each branch's pages into the chooser, with attempts kept apart", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    // The page after a listed profile: the password alone.
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const account = await branchGenerate(
      device,
      passwordPage,
      { recipeId, revision: 1 },
      "account",
    );
    const afterAccount = {
      version: 1,
      id: recipeId,
      revision: 2,
      origin: ORIGIN,
      pageKind: "sign-in",
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          path: "/password",
          fields: [{ slot: "password", target: { by: "id", value: "password" } }],
          effect: "prepare",
        },
        {
          kind: "click",
          path: "/password",
          target: { by: "id", value: "sign-in" },
          purpose: "submit",
        },
      ],
      maxSubmissions: 1,
    };
    expect(account).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { revision: 2, chooser: { afterAccount } } },
    });
    // The other button's branch starts with the email form, and continues after it.
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const other = await branchGenerate(device, emailPage, { recipeId, revision: 2 }, "other");
    expect(other).toMatchObject({
      status: "recipe",
      change: {
        revision: 3,
        recipe: {
          chooser: {
            afterAccount: { ...afterAccount, revision: 3 },
            afterOther: { revision: 3, slots: ["email"], maxSubmissions: 1 },
          },
        },
      },
    });
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const next = await branchGenerate(device, passwordPage, { recipeId, revision: 3 }, "other");
    expect(next).toMatchObject({
      status: "recipe",
      change: {
        revision: 4,
        recipe: {
          chooser: {
            afterOther: { revision: 4, slots: ["email", "password"], maxSubmissions: 2 },
          },
        },
      },
    });
    // The account branch has submitted, so nothing continues it.
    expect(await branchGenerate(device, homePage, { recipeId, revision: 4 }, "account")).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(
      await rows(
        "SELECT branch, path, base_revision FROM generation_attempts WHERE owner_id = ? ORDER BY base_revision",
        device.ownerId,
      ),
    ).toEqual([
      { branch: "", path: "/login", base_revision: 0 },
      { branch: "account", path: "/password", base_revision: 1 },
      { branch: "other", path: "/login", base_revision: 2 },
      { branch: "other", path: "/password", base_revision: 3 },
    ]);
    expect(sent).toHaveLength(4);
    // The list starts the chooser; each branch's page continues it.
    expect(
      (await logRows(device.ownerId)).map(({ branch, base_revision, revision, recipe_page }) => ({
        branch,
        base_revision,
        revision,
        recipe_page,
      })),
    ).toEqual([
      { branch: "", base_revision: 0, revision: 1, recipe_page: "first" },
      { branch: "account", base_revision: 1, revision: 2, recipe_page: "continuation" },
      { branch: "other", base_revision: 2, revision: 3, recipe_page: "continuation" },
      { branch: "other", base_revision: 3, revision: 4, recipe_page: "continuation" },
      // The account branch's page refused as `recipe-conflict`.
      { branch: "account", base_revision: 4, revision: null, recipe_page: "continuation" },
    ]);
  });

  it("tries each branch's page on its own within the retry window", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    });
    expect(
      await branchGenerate(device, emailPage, { recipeId, revision: 1 }, "account"),
    ).toMatchObject({ status: "abstained" });
    // The same path and revision on the other branch is another page.
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(
      await branchGenerate(device, emailPage, { recipeId, revision: 1 }, "other"),
    ).toMatchObject({ status: "recipe", change: { revision: 2 } });
    expect(sent).toHaveLength(3);
  });

  it("refuses a branch the chooser cannot take, without a model call", async () => {
    const device = await owner();
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    // A chooser without an `other` button has no other branch.
    replies.push({ text: listAnswer({}) });
    const bare = await generate(device, listPage);
    if (bare.status !== "recipe") throw new Error(bare.status);
    const { recipeId } = bare.change;
    expect(await branchGenerate(device, emailPage, { recipeId, revision: 1 }, "other")).toEqual(
      conflict,
    );
    // A route recipe has no branches.
    const routeOwner = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(
      routeOwner,
      observation("/start", [
        element("email", "email", "Email"),
        element("next", "button", "Next"),
      ]),
    );
    if (first.status !== "recipe") throw new Error(first.status);
    expect(
      await branchGenerate(
        routeOwner,
        passwordPage,
        { recipeId: first.change.recipeId, revision: 1 },
        "account",
      ),
    ).toEqual(conflict);
    // A list is only ever a first page, and a branch needs a base.
    expect(await generate(device, listPage, { recipeId, revision: 1 })).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-request",
    });
    const unbased = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots,
      branch: "account",
    });
    expect(unbased.status).toBe(400);
    expect(sent).toHaveLength(2);
  });

  it("judges a branch's pages and learns into that branch only", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    await branchGenerate(device, passwordPage, { recipeId, revision: 1 }, "account");
    const judge = (branch?: string) =>
      post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        revision: 2,
        route: "password",
        ...(branch ? { branch } : {}),
        observation: homePage,
      }).then(async (response) => response.json());
    const conflict = { version: 1, status: "unavailable", reason: "recipe-conflict" };
    // The chooser has no route of its own, and the other branch has none yet.
    expect(await judge()).toEqual(conflict);
    expect(await judge("other")).toEqual(conflict);
    const calls = sent.length;
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect(await judge("account")).toMatchObject({
      status: "signed-in",
      change: {
        revision: 3,
        recipe: {
          chooser: {
            path: "/login",
            afterAccount: {
              revision: 3,
              completion: [{ target: { by: "id", value: "logout" } }],
            },
          },
        },
      },
    });
    expect(sent).toHaveLength(calls + 1);
    // The judge is told the list's path as a login path too.
    expect(JSON.stringify(sent.at(-1)!.body)).toContain(
      String.raw`\"loginPaths\":[\"/login\",\"/password\"]`,
    );
    expect(
      await rows(
        "SELECT branch, revision, path FROM page_judgements WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ branch: "account", revision: 2, path: "/home" }]);
  });

  it("keeps a branch's page written during the call onto the other branch's newer chooser", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const account = await branchGenerate(
      device,
      passwordPage,
      { recipeId, revision: 1 },
      "account",
    );
    if (account.status !== "recipe" || !("chooser" in account.change.recipe))
      throw new Error(account.status);
    const atTwo = account.change.recipe;
    // While the other branch's page is generated, a judgement of the account branch on
    // another device stores revision 3.
    const judged = {
      ...atTwo,
      revision: 3,
      chooser: {
        ...atTwo.chooser,
        afterAccount: {
          ...atTwo.chooser.afterAccount!,
          revision: 3,
          completion: [{ target: { by: "id", value: "logout" } }],
        },
      },
    };
    during = async () => {
      const put = await post(
        device,
        `/v1/recipes/${recipeId}`,
        { version: 1, expectedRevision: 2, state: "active", recipe: judged },
        "PUT",
      );
      expect(put.status).toBe(200);
    };
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(
      await branchGenerate(device, emailPage, { recipeId, revision: 2 }, "other"),
    ).toMatchObject({
      status: "recipe",
      change: {
        revision: 4,
        recipe: {
          revision: 4,
          chooser: {
            afterAccount: { revision: 4, completion: judged.chooser.afterAccount.completion },
            afterOther: { revision: 4, slots: ["email"] },
          },
        },
      },
    });
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        recipeId,
      ),
    ).toEqual([{ revision: 4 }]);
    // The log keeps the revision the rebased write stored, not the one the call started on.
    expect(await logRows(device.ownerId)).toContainEqual(
      expect.objectContaining({
        branch: "other",
        base_revision: 2,
        revision: 4,
        recipe_page: "continuation",
      }),
    );
  });

  it("adds a handler into a branch and never judges the list shown again", async () => {
    const device = await owner();
    const { recipeId } = await chooser(device);
    replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    await branchGenerate(device, passwordPage, { recipeId, revision: 1 }, "account");
    const judge = (page: LoginObservation) =>
      post(device, `/v1/recipes/${recipeId}/completion`, {
        version: 1,
        revision: 2,
        route: "password",
        branch: "account",
        observation: page,
      }).then(async (response) => response.json());
    const calls = sent.length;
    expect(await judge(listPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(sent).toHaveLength(calls);
    replies.push(judgeReply({ decision: "challenge", passkeyButton: "key" }));
    expect(
      await judge(
        observation("/login/webauthn", [
          element("key", "button", "Use security key"),
          element("recovery", "link", "Use a recovery code"),
        ]),
      ),
    ).toMatchObject({
      status: "challenge",
      change: {
        revision: 3,
        recipe: {
          chooser: {
            path: "/login",
            other: { by: "id", value: "other" },
            afterAccount: {
              revision: 3,
              handlers: [
                { kind: "passkey", path: "/login/webauthn", target: { by: "id", value: "key" } },
              ],
            },
          },
        },
      },
    });
  });
});

describe("sign-in entry pages (ADR 0031)", () => {
  // A synthetic top page the site sent the visitor to before signing in: no field, a
  // sign-up link, the sign-in link and a button.
  const link = (id: string, text: string) => ({
    id,
    role: "link" as const,
    target: { by: "text" as const, value: text },
  });
  const topPage = observation("/en/", [
    link("c1", "Create account"),
    link("c2", "Login"),
    { id: "c3", role: "button", target: { by: "text", value: "Search" } },
  ]);
  const entryAnswer = (candidate: string) =>
    JSON.stringify({ result: { decision: "entry", entry: candidate } });
  const abstain = JSON.stringify({ result: { decision: "abstain", reason: "no-login-form" } });

  async function generateEntry(device: Device, page: LoginObservation) {
    const response = await post(device, "/v1/recipes/generate", { version: 1, observation: page });
    expect(response.status).toBe(200);
    return (await response.json()) as EntryGenerationResult;
  }

  it("refuses entry generation before the model call when less than 32 KiB remains", async () => {
    const device = await owner();
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES - MIN_GENERATION_RECIPE_ROOM_BYTES + 1,
    );
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(sent).toHaveLength(0);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("maps entry generation's byte refusal after the model call", async () => {
    const device = await owner();
    during = () => seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
    replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(sent).toHaveLength(1);
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        await generatedRecipeId(ORIGIN, topPage.path),
      ),
    ).toEqual([]);
  });

  it("stores the named link as the entry recipe of the page's origin and path", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    replies.push({ text: entryAnswer("c2") });
    const recipe = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      entry: { path: "/en/", target: { by: "text", value: "Login" } },
    };
    const answer = await generateEntry(device, topPage);
    expect(answer).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe },
    });
    // The entry line goes into this request only, and no slot is sent.
    const body = sent[0]!.body as {
      system: { text: string }[];
      messages: { content: { text: string }[] }[];
    };
    expect(body.system.map((part) => part.text)).toEqual([entryGenerationInstructions]);
    expect(entryGenerationInstructions).toContain(entryInstruction);
    expect(JSON.parse(body.messages[0]!.content[0]!.text)).toEqual({
      task: "entry",
      observation: topPage,
    });

    // Asking again answers with the stored recipe without a call.
    expect(await generateEntry(device, topPage)).toEqual(answer);
    expect(sent).toHaveLength(1);
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(await feed.json()).toMatchObject({ changes: [{ recipeId, revision: 1, recipe }] });

    const log = await rows(
      "SELECT role, path, outcome, prompt_version, request, result FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(
      log.map((row) => ({
        ...row,
        request: JSON.parse(String(row.request)),
        result: JSON.parse(String(row.result)),
      })),
    ).toEqual([
      {
        role: "generate",
        path: "/en/",
        outcome: "ok",
        prompt_version: await entryGenerationPromptVersion(),
        request: { instructions: entryGenerationInstructions, observation: topPage },
        result: { entry: "c2" },
      },
      // Asking again is logged as answered with the stored recipe.
      {
        role: "generate",
        path: "/en/",
        outcome: "recipe",
        prompt_version: await entryGenerationPromptVersion(),
        request: { instructions: entryGenerationInstructions, observation: topPage },
        result: null,
      },
    ]);
    expect(await logRows(device.ownerId)).toMatchObject([
      {
        recipe_id: recipeId,
        branch: "",
        base_revision: 0,
        revision: 1,
        recipe_page: "first",
        build: "test-revision",
        observation_hash: await hashOf(topPage),
        answer: { decision: "entry", entry: "c2" },
      },
      {
        recipe_id: recipeId,
        branch: "",
        base_revision: 1,
        revision: null,
        recipe_page: "first",
        observation_hash: await hashOf(topPage),
        answer: null,
      },
    ]);
    expect(await entryGenerationPromptVersion()).not.toBe(await generationPromptVersion());
    expect(
      await rows(
        "SELECT recipe_id, path, base_revision FROM generation_attempts WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ recipe_id: recipeId, path: "/en/", base_revision: 0 }]);

    // A page request never gets the entry line.
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(JSON.stringify(sent[1]!.body)).not.toContain(entryInstruction);
  });

  it("refuses an entry for a page request and a plan for an entry request", async () => {
    const device = await owner();
    replies.push({ text: entryAnswer("next") });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "unexpected-entry" },
    });
    const other = await owner();
    replies.push({ text: plan([["email", "c2"]], "c3", "submit") });
    expect(await generateEntry(other, topPage)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "unexpected-plan" },
    });
    const logged = async (each: Device) =>
      (
        await rows(
          "SELECT outcome, prompt_version, result FROM inference_log WHERE owner_id = ?",
          each.ownerId,
        )
      ).map((row) => ({ ...row, result: JSON.parse(String(row.result)) }));
    expect(await logged(device)).toEqual([
      {
        outcome: "invalid-output",
        prompt_version: await generationPromptVersion(),
        result: {
          rejection: { check: "plan", reason: "unexpected-entry" },
          output: { result: { decision: "entry", entry: "next" } },
        },
      },
    ]);
    // The plan is kept by reference; its slot is not one the request offered.
    expect(await logged(other)).toEqual([
      {
        outcome: "invalid-output",
        prompt_version: await entryGenerationPromptVersion(),
        result: {
          rejection: { check: "plan", reason: "unexpected-plan" },
          output: {
            result: {
              pageKind: "sign-in",
              irreversible: "no",
              fields: [{ slot: "?", candidate: "c2" }],
              action: { candidate: "c3", purpose: "submit" },
            },
          },
        },
      },
    ]);
    // Neither stored anything, and both count toward the retry window.
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", other.ownerId)).toEqual([]);
    expect(await generateEntry(other, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recently-tried",
    });
  });

  it.each([
    ["a button", "c3", topPage, "incompatible-role"],
    ["an unknown candidate", "Login", topPage, "unknown-candidate"],
    [
      "a link whose text may name an account",
      "c4",
      observation("/en/", [link("c2", "Login"), link("c4", "Continue as [email]")]),
      "account-text",
    ],
    [
      "a link whose label holds a number",
      "c4",
      observation("/en/", [
        link("c2", "Login"),
        {
          id: "c4",
          role: "link",
          target: { by: "id", value: "account" },
          label: "Member [number]",
        },
      ]),
      "account-text",
    ],
    [
      "a link whose label holds a masked value",
      "c4",
      observation("/en/", [
        link("c2", "Login"),
        { ...link("c4", "Account"), label: "Account [masked]" },
      ]),
      "account-text",
    ],
  ] as const)("refuses an entry that names %s", async (_name, candidate, page, reason) => {
    const device = await owner();
    replies.push({ text: entryAnswer(candidate) });
    expect(await generateEntry(device, page)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason },
    });
    const [row] = await rows("SELECT result FROM inference_log WHERE owner_id = ?", device.ownerId);
    // A name that is no candidate of the page is not kept.
    expect(JSON.parse(String(row!.result))).toMatchObject({
      output: { result: { decision: "entry", entry: candidate === "Login" ? "?" : candidate } },
    });
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
  });

  it("refuses an entry request with a field, accounts or a base before any call", async () => {
    const device = await owner();
    const send = (body: unknown) => post(device, "/v1/recipes/generate", body);
    const bodies = [
      { version: 1, observation: emailPage },
      {
        version: 1,
        observation: { ...topPage, accounts: ["[email]"] },
      },
      {
        version: 1,
        observation: topPage,
        base: { recipeId: await generatedRecipeId(ORIGIN, "/en/"), revision: 1 },
      },
      { version: 1, observation: topPage, slots: [] },
    ];
    expect((await Promise.all(bodies.map(send))).map((response) => response.status)).toEqual(
      bodies.map(() => 400),
    );
    expect(await generateEntry(device, { ...topPage, complete: false })).toEqual({
      version: 1,
      status: "failed",
      error: "incomplete-observation",
    });
    expect(sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("logs an abstention and tries the page again only after ten minutes", async () => {
    const device = await owner();
    replies.push({ text: abstain });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "abstained",
      reason: "no-login-form",
    });
    const log = await rows(
      "SELECT outcome, result FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(log.map((row) => ({ ...row, result: JSON.parse(String(row.result)) }))).toEqual([
      { outcome: "abstained", result: { reason: "no-login-form" } },
    ]);
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
    // The window is per origin and path, whatever kind of request tried it.
    expect(await generateEntry(device, topPage)).toMatchObject({ reason: "recently-tried" });
    expect(await generate(device, { ...emailPage, path: "/en/" })).toMatchObject({
      reason: "recently-tried",
    });
    expect(sent).toHaveLength(1);

    await env.DB.prepare("UPDATE generation_attempts SET attempted_at = ? WHERE owner_id = ?")
      .bind(Date.now() - ATTEMPT_WINDOW_MS - 1, device.ownerId)
      .run();
    replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toMatchObject({
      status: "recipe",
      change: { revision: 1, recipe: { entry: { path: "/en/" } } },
    });
  });

  it("answers recipe-conflict when a login recipe starts on the entry page's path", async () => {
    const device = await owner();
    // A page with a form on `/en/` generated a login recipe there first.
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, { ...emailPage, path: "/en/" })).toMatchObject({
      status: "recipe",
    });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-conflict",
    });
    // So does a chooser recipe (ADR 0028) stored there.
    const other = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    const chooser = {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: {
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        chooser: { path: "/en/", other: { by: "text", value: "Use another account" } },
      },
    };
    expect((await post(other, `/v1/recipes/${recipeId}`, chooser, "PUT")).status).toBe(200);
    expect(await generateEntry(other, topPage)).toMatchObject({ reason: "recipe-conflict" });
    expect(sent).toHaveLength(1);
  });

  it("generates a revoked entry recipe again as the revision after its tombstone", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toMatchObject({ status: "recipe" });
    const revoked = await post(
      device,
      `/v1/recipes/${recipeId}`,
      { version: 1, expectedRevision: 1, state: "revoked" },
      "PUT",
    );
    expect(revoked.status).toBe(200);
    await env.DB.prepare("UPDATE generation_attempts SET attempted_at = ? WHERE owner_id = ?")
      .bind(Date.now() - ATTEMPT_WINDOW_MS - 1, device.ownerId)
      .run();
    replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toMatchObject({
      status: "recipe",
      change: { recipeId, revision: 3, recipe: { revision: 3 } },
    });
  });

  it("answers with the entry recipe another device stored while the call ran", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/en/");
    const theirs = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      entry: { path: "/en/", target: { by: "text", value: "Sign in" } },
    } as const;
    during = async () => {
      const written = await writeRecipe(
        env.DB,
        device.ownerId,
        recipeId,
        { version: 1, state: "active", expectedRevision: 0, recipe: theirs },
        device.deviceId,
      );
      expect(written.ok).toBe(true);
    };
    replies.push({ text: entryAnswer("c2") });
    expect(await generateEntry(device, topPage)).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe: theirs },
    });
  });
});

describe("requests answered without a model call (ADR 0012)", () => {
  /** Each column of the owner's rows answered without a call, oldest first. */
  const unsentRows = async (ownerId: string) =>
    (
      await rows(
        "SELECT role, provider, model_id, outcome, origin, path, recipe_id, branch, base_revision, revision, recipe_page, build, observation_hash, request, result, answer, input_tokens, output_tokens, cost_micro_usd FROM inference_log WHERE owner_id = ? AND model_id IS NULL ORDER BY created_at",
        ownerId,
      )
    ).map((row) => ({ ...row, request: JSON.parse(String(row.request)) as unknown }));
  const unsent = {
    provider: null,
    model_id: null,
    revision: null,
    build: "test-revision",
    result: null,
    answer: null,
    input_tokens: null,
    output_tokens: null,
    cost_micro_usd: 0,
  };
  const holdLock = (ownerId: string) =>
    env.DB.prepare(
      "INSERT INTO inference_locks (owner_id, lock_id, expires_at) VALUES (?, 'other', ?)",
    )
      .bind(ownerId, Date.now() + 60_000)
      .run();

  it("logs a page refused at the daily spend limit, which the limit does not count", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, day(), 5_000_000)
      .run();
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "daily-limit",
    });
    expect(sent).toEqual([]);
    expect(await unsentRows(device.ownerId)).toEqual([
      {
        ...unsent,
        role: "generate",
        outcome: "daily-limit",
        origin: ORIGIN,
        path: "/login",
        recipe_id: await generatedRecipeId(ORIGIN, "/login"),
        branch: "",
        base_revision: 0,
        recipe_page: "first",
        observation_hash: await hashOf(emailPage),
        request: {
          instructions: generationInstructions,
          slots,
          signedIn: false,
          observation: emailPage,
        },
      },
    ]);
    expect(
      await rows("SELECT COUNT(*) AS count FROM inference_log WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ count: 1 }]);
    // Neither the spend nor the number of calls changes.
    expect(
      await rows(
        "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([{ period: day(), calls: 1, cost_micro_usd: 5_000_000 }]);
  });

  it("logs a busy refusal once per page in ten minutes", async () => {
    const device = await owner();
    await holdLock(device.ownerId);
    const busy = { version: 1, status: "unavailable", reason: "busy" };
    // A client repeating the page adds no row; another page does.
    expect(await generate(device, emailPage)).toEqual(busy);
    expect(await generate(device, emailPage)).toEqual(busy);
    expect(await generate(device, passwordPage)).toEqual(busy);
    expect(
      (await unsentRows(device.ownerId)).map(({ outcome, path }) => ({ outcome, path })),
    ).toEqual([
      { outcome: "busy", path: "/login" },
      { outcome: "busy", path: "/password" },
    ]);
    await env.DB.prepare("UPDATE inference_log SET created_at = ? WHERE owner_id = ?")
      .bind(Date.now() - 10 * 60 * 1000 - 1, device.ownerId)
      .run();
    expect(await generate(device, emailPage)).toEqual(busy);
    expect(await unsentRows(device.ownerId)).toHaveLength(3);
    expect(sent).toEqual([]);
    expect(await rows("SELECT * FROM inference_spend WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    // The other request's lock stays.
    expect(
      await rows("SELECT lock_id FROM inference_locks WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ lock_id: "other" }]);
  });

  it("logs a page judged before, with the login paths the judge would have got", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push({ text: JSON.stringify({ result: { decision: "rejected" } }) });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "rejected",
    });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "judged-rejected",
    });
    expect(sent).toHaveLength(3);
    const [called] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge' AND model_id IS NOT NULL",
      device.ownerId,
    );
    const request = {
      instructions: completionInstructions,
      recipeId: change.recipeId,
      route: "password",
      loginPaths: ["/login", "/password"],
      observation: homePage,
    };
    expect(JSON.parse(String(called!.request))).toEqual(request);
    expect(await unsentRows(device.ownerId)).toEqual([
      {
        ...unsent,
        role: "judge",
        outcome: "judged-rejected",
        origin: ORIGIN,
        path: "/home",
        recipe_id: change.recipeId,
        branch: "",
        base_revision: 2,
        recipe_page: null,
        observation_hash: await hashOf(homePage),
        request,
      },
    ]);
  });

  it("logs no request whose body or recipe the route refuses", async () => {
    const device = await owner();
    const invalid = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: { ...emailPage, version: 2 },
      slots,
    });
    expect(invalid.status).toBe(400);
    // Only a recipe's first page that lists no accounts carries the signedIn hint (ADR 0035).
    for (const body of [
      {
        version: 1,
        observation: emailPage,
        slots,
        base: { recipeId: "gen-1", revision: 1 },
        signedIn: false,
      },
      {
        version: 1,
        observation: { ...emailPage, accounts: ["[email]"] },
        slots,
        signedIn: true,
      },
    ])
      // oxlint-disable-next-line no-await-in-loop -- Each body is refused on its own.
      expect((await post(device, "/v1/recipes/generate", body)).status).toBe(400);
    const unknownRoute = await post(
      device,
      `/v1/recipes/${await generatedRecipeId(ORIGIN, "/login")}/completion`,
      {
        version: 1,
        revision: 1,
        route: "sso",
        observation: homePage,
      },
    );
    expect(unknownRoute.status).toBe(400);
    expect((await complete(device, await generatedRecipeId(ORIGIN, "/login"), 1)).status).toBe(404);
    expect(await rows("SELECT * FROM inference_log WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });

  it("answers the same when the row cannot be written", async () => {
    const device = await owner();
    await holdLock(device.ownerId);
    const prepare = env.DB.prepare.bind(env.DB);
    const insert = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      if (/^insert into "inference_log"/iu.test(query))
        throw new Error("synthetic private log values");
      return prepare(query);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await generate(device, emailPage)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
      expect(insert).toHaveBeenCalledWith(expect.stringMatching(/^insert into "inference_log"/iu));
      expect(warn.mock.calls).toEqual([
        ["Inference log row not kept", { role: "generate", outcome: "busy" }],
      ]);
    } finally {
      insert.mockRestore();
      warn.mockRestore();
    }
    expect(await rows("SELECT * FROM inference_log WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });

  it("logs the same page offered with other slots again", async () => {
    const device = await owner();
    await holdLock(device.ownerId);
    const otherSlots: SemanticSlot[] = [
      ...slots,
      { id: "member", kind: "identifier", description: "membership number" },
    ];
    expect(await generate(device, emailPage)).toMatchObject({ reason: "busy" });
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots: otherSlots,
      signedIn: false,
    });
    expect(await response.json()).toMatchObject({ reason: "busy" });
    expect((await unsentRows(device.ownerId)).map((row) => row.request)).toEqual([
      { instructions: generationInstructions, slots, signedIn: false, observation: emailPage },
      {
        instructions: generationInstructions,
        slots: otherSlots,
        signedIn: false,
        observation: emailPage,
      },
    ]);
  });

  it("logs at most 500 requests answered without a call per owner and UTC day", async () => {
    const device = await owner();
    await holdLock(device.ownerId);
    const now = Date.now();
    const insert = (id: string, at: number, modelId: string | null, outcome = "busy") =>
      env.DB.prepare(
        "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', NULL, ?, ?, '/', '{}', ?, 0, ?)",
      ).bind(id, device.ownerId, modelId, ORIGIN, outcome, at);
    // 499 of today count; yesterday's, a model call's and signed-in page samples
    // (ADR 0029) do not.
    await env.DB.batch([
      ...Array.from({ length: 499 }, (_, index) => insert(`today-${index}`, now - 1, null)),
      insert("yesterday", now - (now % DAY_MS) - 1, null),
      insert("called", now - 1, "claude-opus-5-5"),
      ...Array.from({ length: 3 }, (_, index) =>
        insert(`sampled-${index}`, now - 1, null, "sampled"),
      ),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await generate(device, emailPage)).toMatchObject({ reason: "busy" });
      expect(warn).not.toHaveBeenCalled();
      // The 501st row of the day is not written, and the answer stays the same.
      expect(await generate(device, passwordPage)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
      expect(warn.mock.calls).toEqual([
        ["Inference log row over the daily cap", { role: "generate", outcome: "busy" }],
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(
      await rows(
        "SELECT path FROM inference_log WHERE owner_id = ? AND model_id IS NULL AND path != '/'",
        device.ownerId,
      ),
    ).toEqual([{ path: "/login" }]);
  });

  it.each([
    {
      outcome: "recently-tried",
      role: "generate",
      ask: async (device: Device) => {
        replies.push({
          text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
        });
        await generate(device, emailPage);
        return generate(device, emailPage);
      },
    },
    {
      outcome: "incomplete-observation",
      role: "generate",
      ask: (device: Device) => generate(device, { ...emailPage, complete: false }),
    },
    {
      outcome: "credentials-not-configured",
      role: "generate",
      claude: false,
      ask: (device: Device) => generate(device, emailPage),
    },
    {
      outcome: "judgement-limit",
      role: "judge",
      ask: async (device: Device) => {
        const change = await twoPageRecipe(device);
        const now = Date.now();
        const dayStart = now - (now % DAY_MS);
        await env.DB.batch(
          Array.from({ length: 20 }, (_, index) =>
            env.DB.prepare(
              "INSERT INTO page_judgements (owner_id, recipe_id, revision, origin, path, prompt_version, judged_at) VALUES (?, ?, 1, ?, ?, '', ?)",
            ).bind(device.ownerId, change.recipeId, ORIGIN, `/p${index}`, dayStart + index),
          ),
        );
        return (await complete(device, change.recipeId, 2)).body;
      },
    },
    {
      outcome: "input-too-large",
      role: "judge",
      ask: async (device: Device) => {
        const change = await twoPageRecipe(device);
        return (await complete(device, change.recipeId, 2, bigPage())).body;
      },
    },
  ])("logs one row for $outcome", async ({ outcome, role, claude, ask }) => {
    const device = await owner({ claude: claude ?? true });
    const calls = sent.length;
    const answer = await ask(device);
    expect(answer).toMatchObject(
      outcome === "incomplete-observation" || outcome === "input-too-large"
        ? { status: "failed", error: outcome }
        : { status: "unavailable", reason: outcome },
    );
    const unsentOfRole = (await unsentRows(device.ownerId)).filter((row) => row.role === role);
    expect(unsentOfRole).toMatchObject([{ ...unsent, outcome }]);
    // Only the calls the case itself made reached the model.
    expect(sent.length - calls).toBe(
      (
        await rows(
          "SELECT id FROM inference_log WHERE owner_id = ? AND model_id IS NOT NULL",
          device.ownerId,
        )
      ).length,
    );
  });
});

describe("request timing", () => {
  const timingRows = (ownerId: string, role: string) =>
    rows(
      "SELECT id, outcome, pre_model_ms, token_ms, model_ms, server_ms FROM inference_log WHERE owner_id = ? AND role = ? ORDER BY created_at",
      ownerId,
      role,
    );
  /** The rows once every response's server time update has run. */
  const settledRows = (ownerId: string, role: string) =>
    vi.waitFor(async () => {
      const found = await timingRows(ownerId, role);
      expect(found.every((row) => row["server_ms"] !== null)).toBe(true);
      return found;
    });
  const slowModel = () => {
    during = () => new Promise((resolve) => setTimeout(resolve, 40));
  };
  const generateResponse = (device: Device, page: LoginObservation) =>
    post(device, "/v1/recipes/generate", { version: 1, observation: page, slots, signedIn: false });

  it("logs and reports each call's times, for ok, abstained and failed calls", async () => {
    const device = await owner();
    tokenDelayMs = 40;
    const answers: unknown[] = [];
    const timings: Record<string, number | undefined>[] = [];
    replies.push(
      { text: plan([["email", "email"]], "next", "advance") },
      { text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }) },
      500,
    );
    for (const path of ["/login", "/other", "/third"]) {
      slowModel();
      // eslint-disable-next-line no-await-in-loop
      const response = await generateResponse(device, { ...emailPage, path });
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      answers.push(((await response.json()) as { status: string }).status);
      timings.push(serverTiming(response));
    }
    expect(answers).toEqual(["recipe", "abstained", "failed"]);
    const logged = await settledRows(device.ownerId, "generate");
    expect(logged.map((row) => row["outcome"])).toEqual(["ok", "abstained", "provider-error"]);
    for (const [index, row] of logged.entries()) {
      const {
        pre_model_ms: preModel,
        token_ms: token,
        model_ms: model,
        server_ms: server,
      } = row as Record<"pre_model_ms" | "token_ms" | "model_ms" | "server_ms", number>;
      expect(token).toBeGreaterThanOrEqual(30);
      expect(preModel).toBeGreaterThanOrEqual(token);
      expect(model).toBeGreaterThanOrEqual(30);
      expect(server).toBeGreaterThanOrEqual(preModel + model);
      // The response reports the same call; `total` also covers the request's own work.
      expect(timings[index]).toMatchObject({ token, model });
      expect(timings[index]?.["total"]).toBeGreaterThanOrEqual(token + model);
    }
  });

  it("keeps the server time of a judgement that wrote no recipe", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    slowModel();
    const response = await post(device, `/v1/recipes/${change.recipeId}/completion`, {
      version: 1,
      revision: 2,
      route: "password",
      observation: homePage,
    });
    expect(await response.json()).toEqual({ version: 1, status: "unclear" });
    expect(serverTiming(response)).toMatchObject({
      total: expect.any(Number),
      token: expect.any(Number),
      model: expect.any(Number),
    });
    const [row] = await settledRows(device.ownerId, "judge");
    expect(row).toMatchObject({ outcome: "abstained", model_ms: expect.any(Number) });
    expect(row?.["model_ms"]).toBeGreaterThanOrEqual(30);
    expect(row?.["server_ms"]).toBeGreaterThanOrEqual(Number(row?.["model_ms"]));
  });

  it("updates the server time on the owner's own row only", async () => {
    const device = await owner();
    const prepare = env.DB.prepare.bind(env.DB);
    const updates: { query: string; values: unknown[] }[] = [];
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (!query.toLowerCase().startsWith('update "inference_log" set "server_ms"'))
        return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        updates.push({ query, values });
        return bind(...values);
      };
      return statement;
    });
    try {
      replies.push({ text: plan([["email", "email"]], "next", "advance") });
      expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
      await settledRows(device.ownerId, "generate");
    } finally {
      spy.mockRestore();
    }
    const [row] = await timingRows(device.ownerId, "generate");
    expect(updates).toEqual([
      {
        query: expect.stringMatching(
          /where \("inference_log"\."id" = \? and "inference_log"\."owner_id" = \?\)$/u,
        ),
        values: [row?.["server_ms"], row?.["id"], device.ownerId],
      },
    ]);
  });

  it("answers in full when the server time update fails", async () => {
    const device = await owner();
    const update = failLogUpdate("server_ms");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      replies.push({ text: plan([["email", "email"]], "next", "advance") });
      const response = await generateResponse(device, emailPage);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "recipe", change: { revision: 1 } });
      await vi.waitFor(() =>
        expect(warn.mock.calls).toEqual([["Inference log server time not kept"]]),
      );
    } finally {
      update.mockRestore();
      warn.mockRestore();
    }
    expect(await logRows(device.ownerId)).toMatchObject([{ revision: 1 }]);
    expect(await timingRows(device.ownerId, "generate")).toMatchObject([
      { outcome: "ok", model_ms: expect.any(Number), server_ms: null },
    ]);
  });

  it("reports the total of every device response, and the token time of a credential refusal", async () => {
    const device = await owner();
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(feed.status).toBe(200);
    expect(Object.keys(serverTiming(feed))).toEqual(["total"]);
    const unauthenticated = await exports.default.fetch("https://pateat.invalid/v1/recipes");
    expect(unauthenticated.status).toBe(401);
    expect(Object.keys(serverTiming(unauthenticated))).toEqual(["total"]);
    expect(unauthenticated.headers.get("Timing-Allow-Origin")).toBeNull();

    tokenStatus = 503;
    const failed = await generateResponse(device, emailPage);
    expect(await failed.json()).toMatchObject({ reason: "token-exchange-failed" });
    expect(Object.keys(serverTiming(failed)).sort()).toEqual(["token", "total"]);
    // A missing credential is refused at the same step, without a model request.
    const unconfigured = await generateResponse(await owner({ claude: false }), emailPage);
    expect(await unconfigured.json()).toMatchObject({ reason: "credentials-not-configured" });
    expect(Object.keys(serverTiming(unconfigured)).sort()).toEqual(["token", "total"]);
  });

  it("keeps the server time of a request answered without a model call, and no call times", async () => {
    const device = await owner();
    // Refused by the credential step inside the call, and by the route before any call.
    tokenStatus = 503;
    const failed = await generateResponse(device, emailPage);
    expect(await failed.json()).toMatchObject({ reason: "token-exchange-failed" });
    const incomplete = await generateResponse(device, {
      ...emailPage,
      path: "/other",
      complete: false,
    });
    expect(await incomplete.json()).toMatchObject({ error: "incomplete-observation" });
    expect(Object.keys(serverTiming(incomplete))).toEqual(["total"]);
    const logged = await settledRows(device.ownerId, "generate");
    expect(logged).toEqual([
      expect.objectContaining({
        outcome: "token-exchange-failed",
        pre_model_ms: null,
        token_ms: null,
        model_ms: null,
        server_ms: expect.any(Number),
      }),
      expect.objectContaining({
        outcome: "incomplete-observation",
        pre_model_ms: null,
        token_ms: null,
        model_ms: null,
        server_ms: expect.any(Number),
      }),
    ]);
  });
});

describe("signed-in page samples (ADR 0029, owner 2026-10-18 08:05 UTC)", () => {
  const sample = (device: Device, recipeId: string, body: Record<string, unknown> = {}) =>
    post(device, `/v1/recipes/${recipeId}/page-sample`, {
      version: 1,
      revision: 2,
      route: "password",
      observation: homePage,
      ...body,
    });
  const sampledRows = async (ownerId: string) =>
    (
      await rows(
        "SELECT role, provider, model_id, prompt_version, outcome, origin, path, recipe_id, branch, base_revision, revision, recipe_page, build, observation_hash, request, result, answer, input_tokens, output_tokens, cost_micro_usd FROM inference_log WHERE owner_id = ? AND outcome = 'sampled' ORDER BY created_at",
        ownerId,
      )
    ).map((row) => ({ ...row, request: JSON.parse(String(row.request)) as unknown }));
  const logCount = async (ownerId: string) =>
    (await rows("SELECT COUNT(*) AS count FROM inference_log WHERE owner_id = ?", ownerId))[0]![
      "count"
    ];

  it("logs the page as the judge would have received it, without a model call", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const calls = sent.length;
    const spend = await rows(
      "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
      device.ownerId,
    );
    const response = await sample(device, change.recipeId);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    expect(sent).toHaveLength(calls);
    expect(await sampledRows(device.ownerId)).toEqual([
      {
        role: "judge",
        provider: null,
        model_id: null,
        prompt_version: await completionPromptVersion(),
        outcome: "sampled",
        origin: ORIGIN,
        path: "/home",
        recipe_id: change.recipeId,
        branch: "",
        base_revision: 2,
        revision: null,
        recipe_page: null,
        build: "test-revision",
        observation_hash: await hashOf(homePage),
        request: {
          instructions: completionInstructions,
          recipeId: change.recipeId,
          route: "password",
          loginPaths: ["/login", "/password"],
          observation: homePage,
        },
        result: null,
        answer: null,
        input_tokens: null,
        output_tokens: null,
        cost_micro_usd: 0,
      },
    ]);
    // As a request answered without a call, it has no model times, only its server time.
    const timed = await vi.waitFor(async () => {
      const [found] = await rows(
        "SELECT pre_model_ms, token_ms, model_ms, server_ms FROM inference_log WHERE owner_id = ? AND outcome = 'sampled'",
        device.ownerId,
      );
      expect(found?.["server_ms"]).not.toBeNull();
      return found;
    });
    expect(timed).toEqual({
      pre_model_ms: null,
      token_ms: null,
      model_ms: null,
      server_ms: expect.any(Number),
    });
    // The spend the limits count is unchanged.
    expect(
      await rows(
        "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
        device.ownerId,
      ),
    ).toEqual(spend);
  });

  it("keeps one sample of a recipe in 30 days, whichever device sends it", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    expect((await sample(device, change.recipeId)).status).toBe(201);
    // Another page, revision or device of the owner within 30 days writes nothing.
    const otherDevice = { ...device, deviceId: `device-${crypto.randomUUID()}` };
    otherDevice.token = createDeviceToken();
    await env.DB.prepare(
      "INSERT INTO devices (id, owner_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        otherDevice.deviceId,
        device.ownerId,
        await hashDeviceToken(otherDevice.token),
        Date.now(),
        Date.now(),
      )
      .run();
    const other = observation("/account", [element("logout", "button", "Sign out")]);
    expect((await sample(device, change.recipeId, { observation: other })).status).toBe(204);
    expect((await sample(device, change.recipeId, { revision: 1 })).status).toBe(204);
    expect((await sample(otherDevice, change.recipeId)).status).toBe(204);
    expect(await sampledRows(device.ownerId)).toHaveLength(1);
    // Just inside 30 days it still counts; past them, a new sample is kept.
    const interval = 30 * DAY_MS;
    await env.DB.prepare(
      "UPDATE inference_log SET created_at = ? WHERE owner_id = ? AND outcome = 'sampled'",
    )
      .bind(Date.now() - interval + 60_000, device.ownerId)
      .run();
    expect((await sample(device, change.recipeId)).status).toBe(204);
    await env.DB.prepare(
      "UPDATE inference_log SET created_at = ? WHERE owner_id = ? AND outcome = 'sampled'",
    )
      .bind(Date.now() - interval - 1, device.ownerId)
      .run();
    expect((await sample(device, change.recipeId, { observation: other })).status).toBe(201);
    expect((await sampledRows(device.ownerId)).map(({ path }) => path)).toEqual([
      "/home",
      "/account",
    ]);
    // Another owner's sample of the same recipe ID does not count for this one.
    const stranger = await owner();
    const theirs = await twoPageRecipe(stranger);
    expect(theirs.recipeId).toBe(change.recipeId);
    expect((await sample(stranger, theirs.recipeId)).status).toBe(201);
    expect(sent).toHaveLength(4);
  });

  it("keeps a sample past the daily cap of requests answered without a call", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 500 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', NULL, NULL, ?, '/', '{}', 'busy', 0, ?)",
        ).bind(`${device.ownerId}-busy-${index}`, device.ownerId, ORIGIN, now - 1),
      ),
    );
    expect((await sample(device, change.recipeId)).status).toBe(201);
    expect(await sampledRows(device.ownerId)).toHaveLength(1);
  });

  it("deletes samples older than a year when it keeps one", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    expect((await sample(device, change.recipeId)).status).toBe(201);
    await env.DB.prepare(
      "UPDATE inference_log SET created_at = ? WHERE owner_id = ? AND outcome = 'sampled'",
    )
      .bind(Date.now() - 366 * DAY_MS, device.ownerId)
      .run();
    expect((await sample(device, change.recipeId)).status).toBe(201);
    expect(
      await rows(
        "SELECT COUNT(*) AS count FROM inference_log WHERE owner_id = ? AND outcome = 'sampled' AND created_at < ?",
        device.ownerId,
        Date.now() - 365 * DAY_MS,
      ),
    ).toEqual([{ count: 0 }]);
    expect(await sampledRows(device.ownerId)).toHaveLength(1);
  });

  it("refuses another owner's recipe, an unknown or revoked revision and pages it cannot end on", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const before = await logCount(device.ownerId);
    // Not found: a missing recipe, a revision never written, another owner's recipe.
    expect((await sample(device, "gen-missing")).status).toBe(404);
    expect((await sample(device, change.recipeId, { revision: 3 })).status).toBe(404);
    expect((await sample(await owner(), change.recipeId)).status).toBe(404);
    const refused = [
      // Pages the revision cannot have ended on.
      { observation: { ...homePage, origin: "https://www.shop.example.test" } },
      { observation: { ...homePage, complete: false } },
      { route: "passkey" },
      { branch: "account" },
      // Bodies that fail validation.
      { version: 2 },
      { partial: true },
      { route: "sso" },
      { observation: { ...homePage, version: 2 } },
    ];
    const statuses = await Promise.all(
      refused.map(async (body) => (await sample(device, change.recipeId, body)).status),
    );
    expect(statuses).toEqual(refused.map(() => 400));
    // A revoked recipe keeps only its tombstone.
    const revoked = await post(
      device,
      `/v1/recipes/${change.recipeId}`,
      { version: 1, expectedRevision: 2, state: "revoked" },
      "PUT",
    );
    expect(revoked.status).toBe(200);
    expect((await sample(device, change.recipeId)).status).toBe(404);
    expect((await sample(device, change.recipeId, { revision: 3 })).status).toBe(404);
    expect(await logCount(device.ownerId)).toBe(before);
    expect(sent).toHaveLength(2);
  });

  it("refuses a page that still shows one of the route's fill fields, as the judge does", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const before = await logCount(device.ownerId);
    // The sign-in page itself, a home page that still shows the password field, and the
    // email field on a path of no sign-in step: none is a signed-in page.
    const pages = [
      passwordPage,
      observation("/home", [
        element("logout", "button", "Sign out"),
        element("password", "password", "Password"),
      ]),
      observation("/account", [
        element("logout", "button", "Sign out"),
        element("email", "email", "Email"),
      ]),
    ];
    const statuses = await Promise.all(
      pages.map(
        async (page) => (await sample(device, change.recipeId, { observation: page })).status,
      ),
    );
    expect(statuses).toEqual([400, 400, 400]);
    expect(await logCount(device.ownerId)).toBe(before);
    // None of them holds off the recipe's signed-in page.
    expect((await sample(device, change.recipeId)).status).toBe(201);
    expect((await sampledRows(device.ownerId)).map(({ path }) => path)).toEqual(["/home"]);
  });

  it("answers other methods with 405", async () => {
    const device = await owner();
    const response = await exports.default.fetch(
      "https://pateat.invalid/v1/recipes/gen-1/page-sample",
      { headers: { Authorization: `Bearer ${device.token}` } },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});

describe("passkey-only authenticated recipe generation", () => {
  it("persists and reuses a click-only passkey recipe from a locally mocked model", async () => {
    const device = await owner();
    const page = observation("/passkey-login", [
      element("login-key", "button", "Sign in with a passkey"),
    ]);
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [],
          action: { candidate: "login-key", purpose: "submit" },
          passkeyButton: "login-key",
        },
      }),
    });
    const body = { version: 1, observation: page, slots: [], passkeyOnly: true, signedIn: false };
    const response = await post(device, "/v1/recipes/generate", body);
    expect(response.status).toBe(200);
    const first = (await response.json()) as RecipeGenerationResult;
    expect(first).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          passkeyOnly: true,
          slots: [],
          steps: [{ kind: "click", purpose: "submit", path: "/passkey-login" }],
        },
      },
    });
    expect(sent).toHaveLength(1);
    // The page goes out with the passkey-only instructions alone, logged under their own
    // prompt version; a request with slots keeps the generation role's (ADR 0053).
    const system = (sent[0]!.body as { system: { text: string }[] }).system;
    expect(system.map((part) => part.text)).toEqual([passkeyOnlyGenerationInstructions]);
    const [logged] = await rows(
      "SELECT prompt_version, request FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logged!["prompt_version"]).toBe(await passkeyOnlyGenerationPromptVersion());
    expect(JSON.parse(String(logged!["request"]))).toMatchObject({
      instructions: passkeyOnlyGenerationInstructions,
      slots: [],
      passkeyOnly: true,
    });
    expect(await passkeyOnlyGenerationPromptVersion()).not.toBe(await generationPromptVersion());
    expect(passkeyOnlyGenerationInstructions).not.toBe(generationInstructions);
    const again = await post(device, "/v1/recipes/generate", body);
    expect(await again.json()).toEqual(first);
    expect(sent).toHaveLength(1);
    const unmarked = await post(device, "/v1/recipes/generate", {
      ...body,
      passkeyOnly: undefined,
    });
    expect(unmarked.status).toBe(400);
    expect(sent).toHaveLength(1);
  });
});
