import type {
  LoginObservation,
  ObservedCandidate,
  RecipeCompletionResult,
  RecipeGenerationResult,
  SemanticSlot,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import { MAX_ACTIVE_RECIPES } from "../src/limits";
import { writeRecipe } from "../src/recipe-store";
import { generatedRecipeId, staleHead } from "../src/recipes/generate";

// Synthetic owners, devices, federation identifiers and pages only. Anthropic's token
// endpoint and the Messages API are answered locally; no request leaves the test.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ORIGIN = "https://shop.example.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const RESERVED = 64 * 1024 * 4 + 8_192 * 20;

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

const plan = (fields: [string, string][], action: string, purpose: "advance" | "submit") =>
  JSON.stringify({
    result: {
      decision: "plan",
      fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
    },
  });

type Reply = { text: string; usage?: { input_tokens: number; output_tokens: number } } | number;
let replies: Reply[] = [];
/** Runs while a model call is in flight, before its answer. */
let during: (() => Promise<void>) | undefined;
let tokenStatus = 200;
let sent: { authorization: string | null; apiKey: string | null; body: unknown }[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === TOKEN_URL && tokenStatus !== 200)
      return Response.json({ error: "synthetic" }, { status: tokenStatus });
    if (outbound.url === TOKEN_URL)
      return Response.json({
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        expires_in: 600,
      });
    if (outbound.url === MESSAGES_URL) {
      sent.push({
        authorization: outbound.headers.get("authorization"),
        apiKey: outbound.headers.get("x-api-key"),
        body: await outbound.json(),
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
        model: "claude-opus-5-5",
        content: [{ type: "text", text: reply.text }],
        stop_reason: "end_turn",
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
    ...(base === undefined ? {} : { base }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}

async function complete(device: Device, recipeId: string, revision: number, page = homePage) {
  const response = await post(device, `/v1/recipes/${recipeId}/completion`, {
    version: 1,
    revision,
    route: "password",
    observation: page,
  });
  return {
    status: response.status,
    body: (await response.json()) as RecipeCompletionResult | { error: string },
  };
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
    expect(first.change.recipe.completion).toBeUndefined();
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
          recipe: { completion: { path: "/home", target: { by: "id", value: "logout" } } },
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
    expect(log.map((row) => [row.role, row.path, row.outcome])).toEqual([
      ["generate", "/login", "ok"],
      ["generate", "/password", "ok"],
      ["judge", "/home", "ok"],
    ]);
    expect(log[0]).toMatchObject({
      origin: ORIGIN,
      input_tokens: 3_000,
      output_tokens: 900,
      cost_micro_usd: 3_000 * 4 + 900 * 20,
    });
    expect(JSON.parse(String(log[0]!.request))).toMatchObject({ slots, observation: emailPage });
    expect(JSON.parse(String(log[2]!.result))).toEqual({
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

  it("tries a page at most once in 24 hours, abstentions included", async () => {
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
      .bind(Date.now() - DAY_MS - 1, device.ownerId)
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

  it("deletes log rows older than 90 days when it logs a call", async () => {
    const device = await owner();
    const insert = (id: string, age: number) =>
      env.DB.prepare(
        "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'm', ?, '/', '{}', 'ok', 0, ?)",
      ).bind(id, device.ownerId, ORIGIN, Date.now() - age);
    const expired = `log-${crypto.randomUUID()}`;
    const kept = `log-${crypto.randomUUID()}`;
    await env.DB.batch([insert(expired, 91 * DAY_MS), insert(kept, 89 * DAY_MS)]);
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    const ids = (await rows("SELECT id FROM inference_log WHERE id IN (?, ?)", expired, kept)).map(
      (row) => row.id,
    );
    expect(ids).toEqual([kept]);

    // Reading recipes deletes them too, without any new call.
    const later = `log-${crypto.randomUUID()}`;
    await insert(later, 91 * DAY_MS).run();
    const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(feed.status).toBe(200);
    expect(await rows("SELECT id FROM inference_log WHERE id = ?", later)).toEqual([]);
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
    });
    expect(await again.json()).toMatchObject({ status: "recipe", change: { revision: 2 } });
  });

  it("answers with another device's recipe stored during the call", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const other = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
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
    during = async () => {
      const stored = await post(
        device,
        `/v1/recipes/${recipeId}`,
        { version: 1, expectedRevision: 0, state: "active", recipe: other },
        "PUT",
      );
      expect(stored.status).toBe(200);
    };
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "recipe",
      change: { recipeId, revision: 1, state: "active", recipe: other },
    });
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

  it("refuses an oversized page locally: no call, no log row and no charge", async () => {
    const device = await owner();
    // Every field at its bound: the request fits the route's 128 KiB body limit but not
    // the role's 64 KiB input bound.
    const wide = "\u3042".repeat(120);
    const big: LoginObservation = {
      ...observation("/" + "a".repeat(200), [
        {
          id: "p".repeat(64),
          role: "password",
          target: { by: "name", value: "n".repeat(120) },
          label: wide,
          placeholder: wide,
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
          label: wide,
          placeholder: wide,
          group: "g".repeat(64),
        })),
      ]),
      title: wide,
      headings: Array.from({ length: 8 }, () => wide),
    };
    const bigSlots = Array.from({ length: 8 }, (_, index) => ({
      id: `${"s".repeat(62)}${index}`,
      kind: "identifier" as const,
      description: wide,
      // Each offer names a different vault field.
      fieldName: `${"\u3042".repeat(119)}${index}`,
    }));
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: big,
      slots: bigSlots,
    });
    expect(await response.json()).toEqual({
      version: 1,
      status: "failed",
      error: "input-too-large",
    });
    expect(sent).toEqual([]);
    expect(await rows("SELECT * FROM inference_log WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
    expect(
      await rows(
        "SELECT calls, cost_micro_usd FROM inference_spend WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      { calls: 0, cost_micro_usd: 0 },
      { calls: 0, cost_micro_usd: 0 },
    ]);
    // The refusal is deterministic, so it counts toward the 24-hour rule.
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

  it("refuses a revoked recipe, a stale base, a base with no recipe and a non-generated base", async () => {
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
    expect(await generate(device, emailPage)).toMatchObject({ reason: "recipe-revoked" });
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

  it("stops generating once the owner revokes the recipe in the web UI", async () => {
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
    expect(await generate(device, emailPage)).toMatchObject({ reason: "recipe-revoked" });
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toMatchObject({ reason: "recipe-revoked" });
    expect((await complete(device, first.change.recipeId, 1)).body).toMatchObject({
      reason: "recipe-revoked",
    });
    expect(sent).toHaveLength(1);
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
    fields: { slot: string; candidate: string; name?: string }[],
    action: string,
    purpose: "advance" | "submit",
  ) =>
    JSON.stringify({
      result: { decision: "plan", fields, action: { candidate: action, purpose } },
    });
  async function generateCustom(device: Device, page: LoginObservation, base?: unknown) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      slots: customSlots,
      ...(base === undefined ? {} : { base }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RecipeGenerationResult;
  }

  it("stores the generic name and answers the mapping only to the call that wrote it", async () => {
    const device = await owner();
    replies.push({
      text: named(
        [
          { slot: "email", candidate: "email" },
          { slot: "custom-1", candidate: "branch", name: "branch-number" },
        ],
        "next",
        "advance",
      ),
    });
    const first = await generateCustom(device, branchPage);
    expect(first).toMatchObject({
      status: "recipe",
      change: { revision: 1, recipe: { slots: ["email", "branch-number"] } },
      customSlots: [{ slot: "branch-number", offered: "custom-1" }],
    });
    if (first.status !== "recipe") return;
    // The recipe never carries the vault field names.
    expect(JSON.stringify(first.change)).not.toContain("Synthetic");
    expect(first.change.recipe.steps[0]).toMatchObject({
      fields: [
        { slot: "email", target: { by: "id", value: "email" } },
        { slot: "branch-number", target: { by: "id", value: "branch" } },
      ],
    });
    // A request answered with the stored recipe gets no mapping.
    const stored = await generateCustom(device, branchPage);
    expect(stored).toEqual({ version: 1, status: "recipe", change: first.change });
    expect(sent).toHaveLength(1);

    // A continuation maps only its own page's custom slots.
    replies.push({
      text: named([{ slot: "custom-2", candidate: "pin", name: "pin-code" }], "sign-in", "submit"),
    });
    const second = await generateCustom(device, pinPage, {
      recipeId: first.change.recipeId,
      revision: 1,
    });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "branch-number", "pin-code"] } },
      customSlots: [{ slot: "pin-code", offered: "custom-2" }],
    });
  });

  it("drops the alternatives of a continuation's answer", async () => {
    const device = await owner();
    replies.push({
      text: named(
        [{ slot: "custom-1", candidate: "branch", name: "branch-number" }],
        "next",
        "advance",
      ),
    });
    const first = await generateCustom(device, branchPage);
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
          fields: [{ slot: "custom-2", candidate: "pin", name: "pin-code" }],
          action: { candidate: "sign-in", purpose: "submit" },
          alternatives: [
            {
              fields: [{ slot: "custom-1", candidate: "again", name: "branch-number" }],
              action: { candidate: "sign-in", purpose: "submit" },
            },
          ],
        },
      }),
    });
    const second = await generateCustom(device, pinPage, {
      recipeId: first.change.recipeId,
      revision: 1,
    });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["branch-number", "pin-code"] } },
      customSlots: [{ slot: "pin-code", offered: "custom-2" }],
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
      text: named(
        [{ slot: "custom-1", candidate: "branch", name: "branch-number" }],
        "next",
        "advance",
      ),
    });
    const first = await generateCustom(device, branchPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // Another offered field under the same generic name would merge two fields.
    replies.push({
      text: named(
        [{ slot: "custom-2", candidate: "pin", name: "branch-number" }],
        "sign-in",
        "submit",
      ),
    });
    expect(
      await generateCustom(device, pinPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toEqual({ version: 1, status: "failed", error: "recipe-invalid" });
    const head = await rows(
      "SELECT revision FROM recipe_revisions WHERE owner_id = ? AND recipe_id = ?",
      device.ownerId,
      first.change.recipeId,
    );
    expect(head).toEqual([{ revision: 1 }]);
  });

  it("fails a plan that names a slot without a field name or leaves a custom slot unnamed", async () => {
    const device = await owner();
    replies.push({
      text: named([{ slot: "email", candidate: "email", name: "login-email" }], "next", "advance"),
    });
    expect(await generateCustom(device, branchPage)).toMatchObject({ status: "failed" });
    const other = await owner();
    replies.push({
      text: named([{ slot: "custom-1", candidate: "branch" }], "next", "advance"),
    });
    expect(await generateCustom(other, branchPage)).toMatchObject({ status: "failed" });
    expect(
      await rows(
        "SELECT * FROM recipe_revisions WHERE owner_id IN (?, ?)",
        device.ownerId,
        other.ownerId,
      ),
    ).toEqual([]);
  });

  it("answers no mapping with another device's recipe stored during the call", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const other = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      slots: ["email", "branch-number"],
      steps: [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [
            { slot: "email", target: { by: "id", value: "email" } },
            { slot: "branch-number", target: { by: "id", value: "branch" } },
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
          { slot: "custom-1", candidate: "branch", name: "branch-number" },
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
  });
});

describe("completion judgement", () => {
  it("passes rejection through without storing anything", async () => {
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
    expect(
      (
        await complete(device, change.recipeId, 2, {
          ...homePage,
          origin: "https://x.example.test",
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
  const dayStart = () => Date.now() - (Date.now() % DAY_MS);
  const judgements = (device: Device) =>
    rows(
      "SELECT recipe_id, revision, path FROM page_judgements WHERE owner_id = ? ORDER BY recipe_id, revision, path",
      device.ownerId,
    );
  const seed = (device: Device, recipeId: string, revision: number, path: string, at: number) =>
    env.DB.prepare(
      "INSERT INTO page_judgements (owner_id, recipe_id, revision, path, judged_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(device.ownerId, recipeId, revision, path, at)
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
    // The logged request names the route.
    const [logged] = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.request))).toMatchObject({
      route: "password",
      loginPaths: ["/login", "/password"],
    });
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
        recipe: { completion: { path: "/home", target: { by: "id", value: "logout" } } },
      },
    });
    expect(sent).toHaveLength(2);
  });

  it("judges a recipe that already has a completion without changing it on signed-in", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 3 },
    });
    const welcome = observation("/welcome", [element("account", "button", "Account")]);
    replies.push(judgeReply({ decision: "signed-in", marker: "account" }));
    expect((await complete(device, change.recipeId, 3, welcome)).body).toEqual({
      version: 1,
      status: "signed-in",
    });
    expect(sent).toHaveLength(4);
    expect(await head(device, change.recipeId)).toBe(3);
  });

  it("does not judge a page that shows a route fill field or the completion marker", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "signed-in", marker: "logout" }));
    await complete(device, change.recipeId, 2);
    const calls = sent.length;
    const before = await spend(device);
    const stored = await judgements(device);
    for (const page of [
      // The completion marker proves the sign-in already.
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

  it("judges each revision and path once", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    replies.push(judgeReply({ decision: "challenge" }));
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    const calls = sent.length;
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "already-judged",
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

  it("purges older revisions' judgements once their day is over", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    await seed(device, change.recipeId, 1, "/old", dayStart() - 1);
    await seed(device, change.recipeId, 1, "/recent", dayStart());
    await seed(device, change.recipeId, 2, "/current", dayStart() - 1);
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
            steps: change.recipe.steps,
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
          steps: change.recipe.steps,
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
    // A code sent by SMS, or one whose source the page does not say, adds nothing.
    for (const [path, source] of [
      ["/login/sms", "sms"],
      ["/login/code", "unknown"],
    ] as const) {
      replies.push(answer(source));
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Each page is judged on its own.
        (await complete(device, change.recipeId, 3, observation(path, [code, verify]))).body,
      ).toEqual({ version: 1, status: "challenge" });
    }
    expect(await head(device, change.recipeId)).toBe(3);
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
          observation("/account", [code, element("help", "link", "Help")]),
        )
      ).body,
    ).toEqual({ version: 1, status: "failed", error: "invalid-output" });
    expect(await head(device, change.recipeId)).toBe(3);
  });

  it("checks the head again under the lock and names a revocation meanwhile", async () => {
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
    expect(concurrent).toMatchObject({ status: "unavailable" });
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      reason: "already-judged",
    });
    expect(sent).toHaveLength(calls + 1);
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
    { slot: "custom-1", candidate: "branch", name: "branch-number" },
    { slot: "custom-2", candidate: "account", name: "account-number" },
    { slot: "password", candidate: "password" },
  ];
  const byContract = [
    { slot: "custom-3", candidate: "contract", name: "contract-number" },
    { slot: "password", candidate: "password" },
  ];
  const twoSets = (alternative = byContract, purpose: "advance" | "submit" = "submit") =>
    JSON.stringify({
      result: {
        decision: "plan",
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
          slots: ["branch-number", "account-number", "password"],
          alternatives: [{ slots: ["contract-number", "password"] }],
          maxSubmissions: 1,
        },
      },
      // The password slot is named in both sets but is no custom slot; each name once.
      customSlots: [
        { slot: "branch-number", offered: "custom-1" },
        { slot: "account-number", offered: "custom-2" },
        { slot: "contract-number", offered: "custom-3" },
      ],
    });
    if (result.status !== "recipe") return;
    expect(JSON.stringify(result.change)).not.toContain("Synthetic");
    // The request log keeps the sets the model returned.
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).toEqual({
      fields: byBranch,
      action: { candidate: "sign-in", purpose: "submit" },
      alternatives: [{ fields: byContract, action: { candidate: "sign-in", purpose: "submit" } }],
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
    });
    const other = await owner();
    replies.push({
      text: twoSets([
        { slot: "custom-3", candidate: "contract", name: "branch-number" },
        { slot: "password", candidate: "password" },
      ]),
    });
    expect(await generateVariants(other)).toMatchObject({ status: "failed" });
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
          completion: { path: "/home", target: { by: "id", value: "logout" } },
          alternatives: [{ slots: ["contract-number", "password"] }],
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
        { slot: "custom-1", candidate: "branch", name: "branch-number" },
        { slot: "custom-3", candidate: "contract", name: "contract-number" },
        { slot: "password", candidate: "password" },
      ]),
    });
    expect(await generateVariants(device)).toMatchObject({
      status: "recipe",
      change: {
        recipe: {
          slots: ["branch-number", "account-number", "password"],
          alternatives: [{ slots: ["branch-number", "contract-number", "password"] }],
        },
      },
      customSlots: [
        { slot: "branch-number", offered: "custom-1" },
        { slot: "account-number", offered: "custom-2" },
        { slot: "contract-number", offered: "custom-3" },
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
    expect(result.change.recipe.slots).toEqual(["email", "password"]);
    // The log keeps nothing the plan check dropped.
    const [logged] = await rows(
      "SELECT result FROM inference_log WHERE owner_id = ? AND role = 'generate'",
      device.ownerId,
    );
    expect(JSON.parse(String(logged!.result))).not.toHaveProperty("passkeyButton");
  });

  it("tells the judge every path of the password form on the passkey route", async () => {
    const device = await owner();
    replies.push({
      text: JSON.stringify({
        result: {
          decision: "plan",
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
          completion: { path: "/home", target: { by: "id", value: "logout" } },
          passkey: { path: "/login", target: passkeyButton.target },
        },
      },
    });
    const logged = await rows(
      "SELECT request FROM inference_log WHERE owner_id = ? AND role = 'judge'",
      device.ownerId,
    );
    expect(logged).toHaveLength(2);
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
    expect(second.change.recipe.passkey).toEqual({ path: "/login", target: passkeyButton.target });
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
