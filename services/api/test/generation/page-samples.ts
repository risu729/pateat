import { type SemanticSlot } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { completionInstructions, completionPromptVersion } from "@pateat/inference";
import { expect, it, vi } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../../src/auth";
import type { GenerationContext, Device } from "./context";

export function registerPageSamples(context: GenerationContext) {
  const {
    ORIGIN,
    DAY_MS,
    element,
    observation,
    passwordPage,
    homePage,
    owner,
    layoutKey,
    post,
    rows,
    hashOf,
    twoPageRecipe,
    state,
  } = context;

  // The account's slots, as the judge request carries them (owner 2026-10-23).
  const sampleSlots: SemanticSlot[] = [
    { id: "username", kind: "identifier", description: "account username" },
    {
      id: "custom-1",
      kind: "hidden",
      description: "concealed value of the user's vault field named in fieldName, such as a PIN",
      fieldName: "Synthetic branch PIN",
    },
  ];
  const sample = (device: Device, recipeId: string, body: Record<string, unknown> = {}) =>
    post(device, `/v1/recipes/${recipeId}/page-sample`, {
      version: 1,
      revision: 2,
      route: "password",
      observation: homePage,
      slots: sampleSlots,
      ...body,
    });
  const sampledRows = async (ownerId: string) =>
    (
      await rows(
        "SELECT role, provider, model_id, prompt_version, outcome, origin, path, recipe_id, branch, layout, base_revision, revision, recipe_page, build, observation_hash, request, result, answer, input_tokens, output_tokens, cost_micro_usd FROM inference_log WHERE owner_id = ? AND outcome = 'sampled' ORDER BY created_at",
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
    const calls = state.sent.length;
    const spend = await rows(
      "SELECT period, calls, cost_micro_usd FROM inference_spend WHERE owner_id = ? ORDER BY period",
      device.ownerId,
    );
    const response = await sample(device, change.recipeId);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    expect(state.sent).toHaveLength(calls);
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
        branch: await layoutKey(device.ownerId, change.recipeId),
        // The sampled page's layout (ADR 0060).
        layout: await layoutKey(device.ownerId, change.recipeId),
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
          slots: sampleSlots,
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
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        otherDevice.deviceId,
        device.ownerId,
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
    expect(state.sent).toHaveLength(4);
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
      // A layout the recipe does not have (ADR 0060).
      { branch: "999" },
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
    expect(state.sent).toHaveLength(2);
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

  it("refuses a sample without the account's slots, or with a value in one", async () => {
    const device = await owner();
    const change = await twoPageRecipe(device);
    const before = await logCount(device.ownerId);
    expect((await sample(device, change.recipeId, { slots: undefined })).status).toBe(400);
    expect(
      (
        await sample(device, change.recipeId, {
          slots: [{ ...sampleSlots[0], value: "synthetic-secret" }],
        })
      ).status,
    ).toBe(400);
    expect(await logCount(device.ownerId)).toBe(before);
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
}
