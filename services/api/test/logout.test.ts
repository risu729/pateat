import type {
  LoginObservation,
  LogoutGenerationResult,
  ObservedCandidate,
  RecipeGenerationResult,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { logoutInstructions, logoutPromptVersion } from "@pateat/inference";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import { revokeUnusedRecipes } from "../src/recipe-store";
import { RECIPE_IDLE_LIMIT_MS } from "../src/limits";
import { generatedRecipeId } from "../src/recipes/generate";
import { generatedLogoutRecipeId } from "../src/recipes/logout";

// ADR 0063: an account switch's signed-in pages, sent to find the control that signs out.
// Synthetic owners, devices and pages only; Anthropic's endpoints are answered locally.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ORIGIN = "https://shop.example.test";

let replies: string[] = [];
let sent: { body: unknown }[] = [];
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
      sent.push({ body: await outbound.json() });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("No synthetic reply queued");
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3_000, output_tokens: 200 },
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

type Device = { ownerId: string; deviceId: string; token: string };
async function owner(): Promise<Device> {
  const ownerId = `owner-${crypto.randomUUID()}`;
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare(
      "INSERT INTO devices (id, owner_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(deviceId, ownerId, await hashDeviceToken(token), Date.now(), Date.now()),
  ]);
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
const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Record<string, unknown>>()
    .then((result) => result.results);

const button = (id: string, text: string): ObservedCandidate => ({
  id,
  role: "button",
  target: { by: "text", value: text },
});
const page = (path: string, candidates: ObservedCandidate[]): LoginObservation => ({
  version: 1,
  origin: ORIGIN,
  path,
  language: "en",
  complete: true,
  candidates,
});
const homePage = page("/home", [
  { id: "c1", role: "button", target: { by: "id", value: "account-menu" }, label: "Account" },
  { id: "c2", role: "link", target: { by: "text", value: "Orders" } },
]);
const menuPage = page("/home", [...homePage.candidates, button("c3", "Sign out")]);
const confirmPage = page("/logout", [button("c1", "Cancel"), button("c2", "Yes, sign out")]);
const logoutAnswer = (control: string, purpose: string) =>
  JSON.stringify({ result: { decision: "logout", control, purpose } });

async function logout(device: Device, observation: LoginObservation, base?: unknown) {
  const response = await post(device, "/v1/recipes/logout", {
    version: 1,
    observation,
    ...(base === undefined ? {} : { base }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as LogoutGenerationResult;
}

describe("logout generation for an account switch (ADR 0063)", () => {
  it("stores the menu, then the logout and its confirmation, as the origin and path's logout recipe", async () => {
    const device = await owner();
    const recipeId = await generatedLogoutRecipeId(ORIGIN, "/home");
    // Keyed apart from a login, chooser or entry recipe that starts on the same path.
    expect(recipeId).not.toBe(await generatedRecipeId(ORIGIN, "/home"));
    replies.push(logoutAnswer("c1", "menu"));
    const first = await logout(device, homePage);
    expect(first).toEqual({
      version: 1,
      status: "recipe",
      change: {
        recipeId,
        revision: 1,
        state: "active",
        recipe: {
          version: 1,
          id: recipeId,
          revision: 1,
          origin: ORIGIN,
          logout: {
            path: "/home",
            targets: [
              {
                kind: "click",
                path: "/home",
                target: { by: "id", value: "account-menu" },
                purpose: "menu",
              },
            ],
          },
        },
      },
    });
    // The logout instructions alone go out, with the page and no vault slot.
    const body = sent[0]!.body as { system: { text: string }[]; messages: unknown[] };
    expect(body.system.map((part) => part.text)).toEqual([logoutInstructions]);
    expect(JSON.stringify(body.messages)).toContain('\\"task\\":\\"logout\\"');
    expect(JSON.stringify(body.messages)).not.toContain("slots");

    replies.push(logoutAnswer("c3", "logout"));
    const second = await logout(device, menuPage, { recipeId, revision: 1 });
    replies.push(logoutAnswer("c2", "confirm"));
    const third = await logout(device, confirmPage, { recipeId, revision: 2 });
    if (third.status !== "recipe") throw new Error(third.status);
    expect(second).toMatchObject({ status: "recipe", change: { revision: 2 } });
    expect(third.change.revision).toBe(3);
    expect(
      third.change.recipe.logout.targets.map((target) => [
        target.path,
        target.target.value,
        target.purpose,
      ]),
    ).toEqual([
      ["/home", "account-menu", "menu"],
      ["/home", "Sign out", "logout"],
      ["/logout", "Yes, sign out", "confirm"],
    ]);

    // A request log row per call, under the generation role with the logout prompt version.
    expect(
      await rows(
        "SELECT role, prompt_version, path, outcome, recipe_id, base_revision, revision, recipe_page FROM inference_log WHERE owner_id = ? ORDER BY created_at",
        device.ownerId,
      ),
    ).toEqual(
      [
        ["/home", 0, 1, "first"],
        ["/home", 1, 2, "continuation"],
        ["/logout", 2, 3, "continuation"],
      ].map(([path, baseRevision, revision, recipePage]) => ({
        role: "generate",
        prompt_version: expect.any(String),
        path,
        outcome: "ok",
        recipe_id: recipeId,
        base_revision: baseRevision,
        revision,
        recipe_page: recipePage,
      })),
    );
    const [logged] = await rows(
      "SELECT prompt_version FROM inference_log WHERE owner_id = ? LIMIT 1",
      device.ownerId,
    );
    expect(logged!["prompt_version"]).toBe(await logoutPromptVersion());

    // The stored recipe answers the path again without a model call, and devices sync it.
    const again = await logout(device, homePage);
    expect(again).toMatchObject({ status: "recipe", change: { revision: 3 } });
    expect(sent).toHaveLength(3);
    const synced = (await (
      await exports.default.fetch("https://pateat.invalid/v1/recipes", {
        headers: { Authorization: `Bearer ${device.token}` },
      })
    ).json()) as { changes: { recipeId: string }[] };
    expect(synced.changes.map((change) => change.recipeId)).toEqual([recipeId]);
  });

  it("stores nothing for a signed-out page or an abstention, and refuses a confirmation first", async () => {
    const device = await owner();
    replies.push(JSON.stringify({ result: { decision: "signed-out" } }));
    expect(await logout(device, homePage)).toEqual({ version: 1, status: "signed-out" });
    replies.push(JSON.stringify({ result: { decision: "abstain", reason: "no-logout-control" } }));
    expect(await logout(device, page("/settings", homePage.candidates))).toEqual({
      version: 1,
      status: "abstained",
      reason: "no-logout-control",
    });
    replies.push(logoutAnswer("c2", "confirm"));
    expect(await logout(device, confirmPage)).toEqual({
      version: 1,
      status: "failed",
      error: "recipe-invalid",
    });
    expect(await rows("SELECT * FROM recipe_heads WHERE owner_id = ?", device.ownerId)).toEqual([]);
    // A page tried within the retry window is not sent again.
    expect(await logout(device, homePage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recently-tried",
    });
    expect(sent).toHaveLength(3);
  });

  it("stops at the daily spend limit before any model call", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, new Date().toISOString().slice(0, 10), 5_000_000)
      .run();
    expect(await logout(device, homePage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "daily-limit",
    });
    expect(sent).toEqual([]);
  });

  it("leaves a login recipe on the same path alone, and refuses a page with a field", async () => {
    const device = await owner();
    replies.push(
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [{ slot: "email", candidate: "email" }],
          action: { candidate: "next", purpose: "advance" },
        },
      }),
    );
    const login = (await (
      await post(device, "/v1/recipes/generate", {
        version: 1,
        observation: page("/home", [
          { id: "email", role: "email", target: { by: "id", value: "email" } },
          { id: "next", role: "button", target: { by: "id", value: "next" } },
        ]),
        slots: [{ id: "email", kind: "identifier", description: "account email address" }],
      })
    ).json()) as RecipeGenerationResult;
    expect(login.status).toBe("recipe");
    replies.push(logoutAnswer("c1", "menu"));
    expect(await logout(device, homePage)).toMatchObject({ status: "recipe" });
    expect(
      await rows("SELECT COUNT(*) AS count FROM recipe_heads WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ count: 2 }]);
    // A logout base under a login recipe's ID is no logout recipe to continue.
    if (login.status !== "recipe") throw new Error(login.status);
    expect(
      await logout(device, menuPage, { recipeId: login.change.recipeId, revision: 1 }),
    ).toEqual({ version: 1, status: "unavailable", reason: "recipe-conflict" });
    const field = await post(device, "/v1/recipes/logout", {
      version: 1,
      observation: page("/home", [
        ...homePage.candidates,
        { id: "q", role: "text", target: { by: "id", value: "search" } },
      ]),
    });
    expect(field.status).toBe(400);
    expect((await post(device, "/v1/recipes/logout", {}, "PUT")).status).toBe(405);
  });

  it("never revokes a logout recipe as unused", async () => {
    const device = await owner();
    replies.push(logoutAnswer("c1", "menu"));
    expect(await logout(device, homePage)).toMatchObject({ status: "recipe" });
    expect(
      await revokeUnusedRecipes(env.DB, device.ownerId, Date.now() + RECIPE_IDLE_LIMIT_MS + 1),
    ).toBe(0);
  });
});
