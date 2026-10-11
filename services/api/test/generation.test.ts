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
import { writeRecipe } from "../src/recipe-store";
import { generatedRecipeId } from "../src/recipes/generate";

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
      fieldName: wide,
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
    replies.push({ text: JSON.stringify({ result: { decision: "unclear" } }) });
    expect((await complete(device, change.recipeId, 2)).body).toEqual({
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

  it("refuses a marker on a page that shows the login form again", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const reposted = observation("/session", [
      element("email", "email", "Email"),
      element("help", "link", "Help"),
    ]);
    replies.push({ text: JSON.stringify({ result: { decision: "signed-in", marker: "help" } }) });
    expect((await complete(device, change.recipeId, 2, reposted)).body).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
    });
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
    // A recipe whose last step advances has not been submitted yet.
    const advancing = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(advancing, emailPage);
    expect((await complete(advancing, change.recipeId, 1)).body).toMatchObject({
      reason: "recipe-conflict",
    });
    expect(sent).toHaveLength(calls + 1);
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
