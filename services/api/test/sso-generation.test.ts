import {
  deviceModelRequestHash,
  MAX_ACTIVE_RECIPE_BYTES,
  toLoginLayout,
  type LoginObservation,
  type LoginRecipe,
  type ObservedCandidate,
  type RecipeDocument,
  type RecipeGenerationResult,
  type SemanticSlot,
  type SsoGenerationResult,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { generatedRecipeId, MIN_GENERATION_RECIPE_ROOM_BYTES } from "@pateat/generation";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";
import { readFirstPageSources, revokeUnusedRecipes, writeRecipe } from "../src/recipe-store";
import { seedRecipeBytes, storedRecipeBytes } from "./recipe-byte-helpers";

// Label-only SSO entry generation (ADR 0026 amendment of 2026-11-12) through the service's
// generation route. Synthetic owners, devices, federation identifiers and pages only;
// Anthropic's token endpoint and the Messages API are answered locally.

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
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
const observation = (path: string, candidates: ObservedCandidate[]): LoginObservation => ({
  version: 1,
  origin: ORIGIN,
  path,
  language: "en",
  complete: true,
  candidates,
});
const emailPage = observation("/login", [
  element("email", "email", "Email"),
  element("next", "button", "Next"),
]);
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

/** A text answer or a refusal with its category. */
type Reply = { text: string } | { refusal: string };
let replies: Reply[] = [];
/** Runs while a model call is in flight, before its answer. */
let during: (() => Promise<void>) | undefined;
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
      const body = (await outbound.json()) as { model: string };
      sent.push({ body });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("No synthetic reply queued");
      const hook = during;
      during = undefined;
      await hook?.();
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
  during = undefined;
});

type Device = { ownerId: string; deviceId: string; token: string };

/** The owner's call slots (ADR 0018), held by another request for the next minute. */
const holdSlots = (ownerId: string) =>
  env.DB.batch(
    [0, 1, 2, 3, 4].map((slot) =>
      env.DB.prepare(
        "INSERT INTO inference_locks (owner_id, slot, lock_id, expires_at) VALUES (?, ?, 'other', ?)",
      ).bind(ownerId, slot, Date.now() + 60_000),
    ),
  );

async function owner({ claude = true } = {}): Promise<Device> {
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
  if (claude)
    await saveWifCredential(env.DB, ownerId, {
      federationRuleId: "fdrl_01SyntheticRule",
      organizationId: "00000000-0000-4000-8000-000000000000",
      serviceAccountId: "svac_01SyntheticAccount",
      workspaceId: "wrkspc_01SyntheticWorkspace",
    });
  return { ownerId, deviceId, token };
}

const post = (device: Device, path: string, body: unknown) =>
  exports.default.fetch(`https://pateat.invalid${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** The owner's stored head document of a recipe, as the service keeps it. */
async function storedHead(ownerId: string, recipeId: string): Promise<unknown> {
  const document = await env.DB.prepare(
    `SELECT r.document FROM recipe_heads h JOIN recipe_revisions r
      ON r.owner_id = h.owner_id AND r.recipe_id = h.recipe_id AND r.revision = h.revision
      WHERE h.owner_id = ? AND h.recipe_id = ?`,
  )
    .bind(ownerId, recipeId)
    .first<string>("document");
  return document === null ? null : JSON.parse(document);
}

/** A route recipe stored back as a recipe document with that one layout (ADR 0060). */
const documentOf = (recipe: LoginRecipe): StoredLoginRecipe => ({
  version: 1,
  id: recipe.id,
  revision: recipe.revision,
  origin: recipe.origin,
  layouts: [toLoginLayout(recipe, { key: recipe.layout ?? "1000", createdAt: 1000 })],
});

/** A first page's generation request, as a device sends it. */
async function generate(device: Device, page: LoginObservation) {
  const response = await post(device, "/v1/recipes/generate", {
    version: 1,
    observation: page,
    slots,
    signedIn: false,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RecipeGenerationResult;
}

/** The columns the assertions read by name; other columns are compared whole. */
type Row = Record<string, unknown> & Partial<Record<"request" | "result", unknown>>;
const rows = (sql: string, ...values: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...values)
    .all<Row>()
    .then((result) => result.results);
const day = () => new Date().toISOString().slice(0, 10);

describe("label-only declarative SSO generation", () => {
  const page = observation("/login", [
    element("provider", "button", "Continue with Example"),
    element("other", "link", "Continue with Other"),
  ]);
  const ssoPlan = (candidate = "provider", label = "Example") =>
    JSON.stringify({
      result: { decision: "plan", page: "sign-in", entries: [{ label, candidate }] },
    });
  const request = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    kind: "sso",
    observation: page,
    labels: ["Example"],
    ...extra,
  });
  async function sso(device: Device, extra: Record<string, unknown> = {}) {
    const response = await post(device, "/v1/recipes/generate", request(extra));
    expect(response.status).toBe(200);
    return (await response.json()) as SsoGenerationResult;
  }
  async function seed(device: Device, recipe: StoredLoginRecipe, expectedRevision = 0) {
    const written = await writeRecipe(
      env.DB,
      device.ownerId,
      recipe.id,
      {
        version: 1,
        state: "active",
        expectedRevision,
        recipe,
      },
      device.deviceId,
    );
    expect(written.ok).toBe(true);
  }

  it("writes an SSO-only recipe, logs labels and candidates only, and records SSO provenance", async () => {
    const device = await owner();
    replies.push({ text: ssoPlan() });
    const first = await sso(device);
    expect(first).toMatchObject({
      status: "recipe",
      change: {
        revision: 1,
        recipe: {
          sso: {
            path: "/login",
            layouts: [{ entries: [{ label: "Example", target: { by: "id", value: "provider" } }] }],
          },
        },
      },
    });
    if (first.status !== "recipe") throw new Error(first.status);
    expect(first.change.recipe).not.toHaveProperty("layouts");
    const sources = await readFirstPageSources(env.DB, device.ownerId);
    if (!("sso" in first.change.recipe) || !first.change.recipe.sso) throw new Error("no SSO");
    expect(
      sources.get(first.change.recipeId)?.get(first.change.recipe.sso.layouts[0]!.key),
    ).toMatchObject({ origin: "generated" });
    expect(await storedHead(device.ownerId, first.change.recipeId)).toEqual(first.change.recipe);
    const logs = await rows(
      "SELECT role, request, result, revision FROM inference_log WHERE owner_id = ?",
      device.ownerId,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ role: "generate", revision: 1 });
    expect(JSON.parse(String(logs[0]!.request))).toMatchObject({
      labels: ["Example"],
      observation: page,
    });
    expect(JSON.parse(String(logs[0]!.request))).not.toHaveProperty("slots");
    expect(JSON.parse(String(logs[0]!.result))).toEqual({
      entries: [{ label: "Example", candidate: "provider" }],
    });
    expect(
      await rows(
        "SELECT unit, revision, origin FROM recipe_unit_sources WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([expect.objectContaining({ unit: "sso", revision: 1, origin: "generated" })]);
    expect(await sso(device)).toMatchObject({ status: "recipe", change: first.change });
    expect(sent).toHaveLength(1);
  });

  it.each(["slots", "mapping", "idpOrigin", "username", "itemId"])(
    "rejects private extra field %s before inference",
    async (key) => {
      const device = await owner();
      const response = await post(
        device,
        "/v1/recipes/generate",
        request({ [key]: "private-value" }),
      );
      expect(response.status).toBe(400);
      expect(sent).toHaveLength(0);
      expect(
        await rows("SELECT request FROM inference_log WHERE owner_id = ?", device.ownerId),
      ).toEqual([]);
    },
  );

  it.each(["sso-first", "native-first"] as const)(
    "preserves both families when %s completes last",
    async (order) => {
      const device = await owner();
      if (order === "sso-first") {
        replies.push({ text: ssoPlan() }, { text: plan([["email", "email"]], "next", "advance") });
        during = async () => {
          expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
        };
        expect(await sso(device)).toMatchObject({ status: "recipe", change: { revision: 2 } });
      } else {
        replies.push({ text: plan([["email", "email"]], "next", "advance") }, { text: ssoPlan() });
        during = async () => {
          expect(await sso(device)).toMatchObject({ status: "recipe" });
        };
        expect(await generate(device, emailPage)).toMatchObject({
          status: "recipe",
          change: { revision: 2 },
        });
      }
      const recipeId = await generatedRecipeId(ORIGIN, "/login");
      expect(await storedHead(device.ownerId, recipeId)).toMatchObject({
        revision: 2,
        layouts: [
          {
            steps: [
              { fields: [{ slot: "email", target: { by: "id", value: "email" } }] },
              { target: { by: "id", value: "next" } },
            ],
          },
        ],
        sso: {
          layouts: [{ entries: [{ label: "Example", target: { by: "id", value: "provider" } }] }],
        },
      });
      expect(sent).toHaveLength(2);
      expect(
        await rows(
          "SELECT unit FROM recipe_unit_sources WHERE owner_id = ? ORDER BY unit",
          device.ownerId,
        ),
      ).toEqual([
        expect.objectContaining({ unit: "page:0" }),
        expect.objectContaining({ unit: "sso" }),
      ]);
    },
  );

  it("preserves a native answer when an SSO writer takes its same-millisecond layout key", async () => {
    const device = await owner();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 12, 4, 0));
    try {
      replies.push({ text: plan([["email", "email"]], "next", "advance") }, { text: ssoPlan() });
      during = async () => {
        expect(await sso(device)).toMatchObject({ status: "recipe" });
      };
      expect(await generate(device, emailPage)).toMatchObject({
        status: "recipe",
        change: { revision: 2 },
      });
      const recipeId = await generatedRecipeId(ORIGIN, "/login");
      const head = (await storedHead(device.ownerId, recipeId)) as RecipeDocument;
      expect(head.layouts).toHaveLength(1);
      expect(head.sso?.layouts).toHaveLength(1);
      expect(head.layouts![0]!.key).not.toBe(head.sso!.layouts[0]!.key);
      expect(
        await rows(
          "SELECT layout, unit, origin FROM recipe_unit_sources WHERE owner_id = ? ORDER BY unit",
          device.ownerId,
        ),
      ).toEqual([
        { layout: head.layouts![0]!.key, unit: "page:0", origin: "generated" },
        { layout: head.sso!.layouts[0]!.key, unit: "sso", origin: "generated" },
      ]);
      expect(
        await rows(
          "SELECT layout FROM inference_log WHERE owner_id = ? AND result LIKE '%fields%' ",
          device.ownerId,
        ),
      ).toEqual([{ layout: head.layouts![0]!.key }]);
    } finally {
      clock.mockRestore();
    }
  });

  it("requires byte capacity before adding a native family to an SSO-only recipe", async () => {
    const device = await owner();
    replies.push({ text: ssoPlan() });
    expect(await sso(device)).toMatchObject({ status: "recipe" });
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES -
        (await storedRecipeBytes(device.ownerId)) -
        MIN_GENERATION_RECIPE_ROOM_BYTES +
        1,
    );
    expect(await generate(device, emailPage)).toMatchObject({
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(sent).toHaveLength(1);
  });

  it.each([false, true])(
    "prunes stale SSO layouts from a recently used recipe (native sibling: %s)",
    async (mixed) => {
      const device = await owner();
      const recipeId = await generatedRecipeId(ORIGIN, "/login");
      const recent = Date.now();
      const native = documentOf({
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        pageKind: "sign-in",
        slots: ["email"],
        steps: [
          {
            kind: "fill",
            path: "/login",
            effect: "prepare",
            fields: [{ slot: "email", target: { by: "id", value: "email" } }],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "next" },
            purpose: "advance",
          },
        ],
        maxSubmissions: 1,
      });
      const recipe = {
        version: 1 as const,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        ...(mixed && "layouts" in native
          ? { layouts: native.layouts?.map((item) => ({ ...item, createdAt: recent })) }
          : {}),
        sso: {
          path: "/login",
          layouts: [2000, recent].map((time) => ({
            key: String(time),
            createdAt: time,
            entries: [
              { label: "Example", target: { by: "id" as const, value: "provider-" + time } },
            ],
          })),
        },
      };
      await seed(device, recipe);
      expect(await revokeUnusedRecipes(env.DB, device.ownerId, recent)).toBe(0);
      expect(await storedHead(device.ownerId, recipeId)).toMatchObject({
        revision: 2,
        sso: { layouts: [{ key: String(recent) }] },
      });
    },
  );

  it("preserves SSO layouts when a native layout is repaired", async () => {
    const device = await owner();
    replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push({ text: ssoPlan() });
    const mixed = await sso(device);
    if (mixed.status !== "recipe" || !("sso" in mixed.change.recipe)) throw new Error("no SSO");
    const revised = observation("/login", [
      element("email-new", "email", "Email"),
      element("next-new", "button", "Next"),
    ]);
    replies.push({ text: plan([["email", "email-new"]], "next-new", "advance") });
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: revised,
      slots,
      signedIn: false,
      repair: { recipeId: first.change.recipeId, revision: 2 },
    });
    expect(response.status).toBe(200);
    const repaired = (await response.json()) as RecipeGenerationResult;
    expect(repaired).toMatchObject({
      status: "recipe",
      change: {
        revision: 3,
        recipe: {
          sso: mixed.change.recipe.sso,
          layouts: [
            { steps: [{ fields: [{ target: { value: "email" } }] }, {}] },
            { steps: [{ fields: [{ target: { value: "email-new" } }] }, {}] },
          ],
        },
      },
    });
    expect(sent).toHaveLength(3);
  });

  it("repairs SSO over a concurrent native-only write without discarding its new target", async () => {
    const device = await owner();
    replies.push({ text: ssoPlan() });
    const initial = await sso(device);
    if (initial.status !== "recipe") throw new Error(initial.status);
    replies.push({ text: ssoPlan("other") });
    during = async () => {
      await seed(
        device,
        {
          ...initial.change.recipe,
          revision: 2,
          layouts: [
            toLoginLayout(
              {
                version: 1,
                id: initial.change.recipeId,
                revision: 2,
                origin: ORIGIN,
                pageKind: "sign-in",
                slots: ["email"],
                steps: [
                  {
                    kind: "fill",
                    path: "/login",
                    effect: "prepare",
                    fields: [{ slot: "email", target: { by: "id", value: "email" } }],
                  },
                  {
                    kind: "click",
                    path: "/login",
                    target: { by: "id", value: "next" },
                    purpose: "advance",
                  },
                ],
                maxSubmissions: 1,
              },
              { key: "1000", createdAt: 1000 },
            ),
          ],
        },
        1,
      );
    };
    const repaired = await sso(device, {
      repair: { recipeId: initial.change.recipeId, revision: 1 },
    });
    expect(repaired).toMatchObject({
      status: "recipe",
      change: {
        revision: 3,
        recipe: {
          layouts: [{ key: "1000" }],
          sso: {
            layouts: [
              { entries: [{ target: { value: "provider" } }] },
              { entries: [{ target: { value: "other" } }] },
            ],
          },
        },
      },
    });
    expect(sent).toHaveLength(2);
  });

  it.each(["origin", "path"] as const)(
    "never accepts a CAS winner with another %s",
    async (field) => {
      const device = await owner();
      const recipeId = await generatedRecipeId(ORIGIN, "/login");
      replies.push({ text: ssoPlan() });
      during = async () => {
        await seed(device, {
          version: 1,
          id: recipeId,
          revision: 1,
          origin: field === "origin" ? "https://unrelated.example.test" : ORIGIN,
          sso: {
            path: field === "path" ? "/elsewhere" : "/login",
            layouts: [
              {
                key: "1000",
                createdAt: 1000,
                entries: [{ label: "Example", target: { by: "id", value: "wrong" } }],
              },
            ],
          },
        });
      };
      expect(await sso(device)).toMatchObject({ status: "unavailable", reason: "recipe-conflict" });
      expect(await storedHead(device.ownerId, recipeId)).toMatchObject({
        revision: 1,
        sso: { layouts: [{ entries: [{ target: { value: "wrong" } }] }] },
      });
    },
  );

  it("does not overwrite revocation while its model answer is in flight", async () => {
    const device = await owner();
    replies.push({ text: ssoPlan() });
    const first = await sso(device);
    if (first.status !== "recipe") throw new Error(first.status);
    replies.push({ text: ssoPlan("other") });
    during = async () => {
      expect(
        (
          await writeRecipe(
            env.DB,
            device.ownerId,
            first.change.recipeId,
            {
              version: 1,
              state: "revoked",
              expectedRevision: 1,
            },
            null,
          )
        ).ok,
      ).toBe(true);
    };
    expect(
      await sso(device, { repair: { recipeId: first.change.recipeId, revision: 1 } }),
    ).toMatchObject({
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(
      await rows("SELECT revision, state FROM recipe_heads WHERE owner_id = ?", device.ownerId),
    ).toEqual([expect.objectContaining({ revision: 2, state: "revoked" })]);
  });

  it("rejects mismatched repair revisions and limits attempts without switching methods", async () => {
    const device = await owner();
    replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    });
    expect(await sso(device)).toMatchObject({ status: "abstained", reason: "ambiguous" });
    expect(await sso(device)).toMatchObject({ status: "unavailable", reason: "recently-tried" });
    const other = await owner();
    expect(await sso(other, { repair: { recipeId: "gen-other", revision: 1 } })).toMatchObject({
      status: "unavailable",
      reason: "recipe-conflict",
    });
    expect(sent).toHaveLength(1);
  });

  it("keeps provider fallback within the SSO role after a refusal", async () => {
    const device = await owner();
    replies.push({ refusal: "safety" }, { text: ssoPlan() });
    expect(await sso(device)).toMatchObject({ status: "recipe", change: { revision: 1 } });
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      const body = call.body as { messages: { content: { text: string }[] }[] };
      expect(JSON.parse(body.messages[0]!.content[0]!.text)).toEqual({
        task: "sso",
        observation: page,
        labels: ["Example"],
      });
    }
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    expect(await storedHead(device.ownerId, recipeId)).not.toHaveProperty("layouts");
  });

  it("writes no recipe for invented candidates and redacts the invalid model answer", async () => {
    const device = await owner();
    replies.push({ text: ssoPlan("private-invented-candidate") });
    expect(await sso(device)).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(sent).toHaveLength(1);
    expect(await storedHead(device.ownerId, await generatedRecipeId(ORIGIN, "/login"))).toBeNull();
    expect(
      JSON.stringify(
        await rows("SELECT result FROM inference_log WHERE owner_id = ?", device.ownerId),
      ),
    ).not.toContain("private-invented-candidate");
  });

  it("answers a newer SSO winner without overwriting it with a stale model result", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    replies.push({ text: ssoPlan() });
    during = async () => {
      await seed(device, {
        version: 1,
        id: recipeId,
        revision: 1,
        origin: ORIGIN,
        sso: {
          path: "/login",
          layouts: [
            {
              key: "1000",
              createdAt: 1000,
              entries: [{ label: "Example", target: { by: "id", value: "winner" } }],
            },
          ],
        },
      });
    };
    expect(await sso(device)).toMatchObject({
      status: "recipe",
      change: {
        revision: 1,
        recipe: {
          sso: { layouts: [{ entries: [{ target: { value: "winner" } }] }] },
        },
      },
    });
    expect(await storedHead(device.ownerId, recipeId)).toMatchObject({ revision: 1 });
    expect(
      await rows("SELECT revision FROM inference_log WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ revision: null }]);
  });

  it.each(["preflight", "racing-write"] as const)(
    "enforces the SSO byte cap at %s",
    async (stage) => {
      const device = await owner();
      if (stage === "preflight") await seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
      else {
        replies.push({ text: ssoPlan() });
        during = () => seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
      }
      expect(await sso(device)).toMatchObject({ status: "unavailable", reason: "recipe-limit" });
      expect(sent).toHaveLength(stage === "preflight" ? 0 : 1);
      expect(
        await storedHead(device.ownerId, await generatedRecipeId(ORIGIN, "/login")),
      ).toBeNull();
    },
  );

  it("uses existing credential, lock and spend gates", async () => {
    const noCredential = await owner({ claude: false });
    expect(await sso(noCredential)).toMatchObject({
      status: "unavailable",
      reason: "credentials-not-configured",
    });
    const busy = await owner();
    await holdSlots(busy.ownerId);
    expect(await sso(busy)).toMatchObject({ status: "unavailable", reason: "busy" });
    const daily = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(daily.ownerId, day(), 5_000_000)
      .run();
    expect(await sso(daily)).toMatchObject({ status: "unavailable", reason: "daily-limit" });
    expect(sent).toHaveLength(0);
  });

  it("retains at most three SSO layouts using recorded usage while keeping native siblings", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const native = documentOf({
      version: 1,
      id: recipeId,
      revision: 1,
      origin: ORIGIN,
      pageKind: "sign-in",
      slots: ["email"],
      steps: [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [{ slot: "email", target: { by: "id", value: "email" } }],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
      ],
      maxSubmissions: 1,
    });
    await seed(device, {
      ...native,
      sso: {
        path: "/login",
        layouts: [2000, 3000, 4000].map((time) => ({
          key: String(time),
          createdAt: time,
          entries: [{ label: "Example", target: { by: "id" as const, value: String(time) } }],
        })),
      },
    });
    await env.DB.prepare(
      "INSERT INTO recipe_layout_uses (owner_id, recipe_id, layout, last_used_at) VALUES (?, ?, '2000', ?)",
    )
      .bind(device.ownerId, recipeId, Date.now())
      .run();
    replies.push({ text: ssoPlan() });
    const result = await sso(device, { repair: { recipeId, revision: 1 } });
    expect(result).toMatchObject({ status: "recipe", change: { revision: 2 } });
    if (result.status !== "recipe" || !("sso" in result.change.recipe)) throw new Error("no SSO");
    expect(result.change.recipe.sso?.layouts.map((item) => item.key)).toEqual([
      "2000",
      "4000",
      expect.any(String),
    ]);
    expect(result.change.recipe).toMatchObject({
      layouts: "layouts" in native ? native.layouts : undefined,
    });
  });

  it("relays SSO calls through a paired device with no service credential or model call", async () => {
    const device = await owner({ claude: false });
    const offered = await sso(device, { deviceModel: { responses: [] } });
    expect(offered).toMatchObject({ status: "model-call", call: { index: 0 } });
    if (offered.status !== "model-call") throw new Error(offered.status);
    const modelInput = JSON.parse(JSON.parse(offered.call.body).messages[0].content[0].text);
    expect(modelInput).toEqual({ task: "sso", observation: page, labels: ["Example"] });
    const response = {
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: ssoPlan() }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 30 },
    };
    expect(
      await sso(device, {
        deviceModel: {
          responses: [
            {
              kind: "response",
              request: await deviceModelRequestHash(offered.call.body),
              status: 200,
              body: JSON.stringify(response),
            },
          ],
        },
      }),
    ).toMatchObject({ status: "recipe", change: { revision: 1 } });
    expect(sent).toHaveLength(0);
  });
});
