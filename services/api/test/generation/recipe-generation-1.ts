import { type RecipeGenerationResult } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { ATTEMPT_WINDOW_MS, generatedRecipeId } from "@pateat/generation";
import type { GenerationContext } from "./context";

export function registerRecipeGeneration1(context: GenerationContext) {
  const {
    ORIGIN,
    WORST_CASE,
    slots,
    emailPage,
    passwordPage,
    route,
    plan,
    holdSlots,
    owner,
    post,
    generate,
    complete,
    rows,
    month,
    day,
    state,
  } = context;

  it("stores the first page's kind, which a continuation keeps (ADR 0035)", async () => {
    const device = await owner();
    state.replies.push({
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
    expect(JSON.stringify(state.sent[0]!.body)).toContain(String.raw`\"signedIn\":true`);
    expect(JSON.stringify(first.change.recipe)).not.toContain("irreversible");
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const stored = await generate(device, emailPage);
    if (stored.status !== "recipe") throw new Error(stored.status);
    // Stands in for a recipe stored before page kinds: its document no longer validates.
    const { pageKind: _kind, ...old } = route(stored.change.recipe);
    await env.DB.prepare("UPDATE recipe_revisions SET document = ? WHERE owner_id = ?")
      .bind(JSON.stringify(old), device.ownerId)
      .run();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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

    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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
    expect(state.sent[0]).toMatchObject({
      authorization: "Bearer synthetic-access-token",
      apiKey: null,
    });

    // Another device asking for the same origin gets the stored recipe without a call.
    expect(await generate(device, emailPage)).toEqual(first);
    expect(state.sent).toHaveLength(1);

    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const second = await generate(device, passwordPage, { recipeId, revision: 1 });
    expect(second).toMatchObject({
      status: "recipe",
      change: { revision: 2, recipe: { slots: ["email", "password"], maxSubmissions: 2 } },
    });

    state.replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }),
    });
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
    const judgePrompt = JSON.stringify(state.sent[2]!.body);
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
    expect(state.sent).toEqual([]);
    // Missing credentials are not an attempt, so the page can be tried once they exist.
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("tries a page at most once in ten minutes, abstentions included", async () => {
    const device = await owner();
    state.replies.push({
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
    expect(state.sent).toHaveLength(1);

    await env.DB.prepare("UPDATE generation_attempts SET attempted_at = ? WHERE owner_id = ?")
      .bind(Date.now() - ATTEMPT_WINDOW_MS - 1, device.ownerId)
      .run();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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
    expect(state.sent).toEqual([]);

    // The number of calls no longer limits a day; only the spend does.
    const many = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 500, ?)",
    )
      .bind(many.ownerId, day(), 4_999_999)
      .run();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(many, emailPage)).toMatchObject({ status: "recipe" });
    expect(state.sent).toHaveLength(1);
  });

  it("makes five calls at a time per owner and takes over an abandoned slot", async () => {
    const device = await owner();
    await holdSlots(device.ownerId);
    expect(await generate(device, emailPage)).toMatchObject({ reason: "busy" });
    expect(state.sent).toEqual([]);

    await env.DB.prepare(
      "UPDATE inference_locks SET expires_at = ? WHERE owner_id = ? AND slot = 3",
    )
      .bind(Date.now() - 1, device.ownerId)
      .run();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    // The slot it took over is freed; the other requests' slots stay.
    expect(
      await rows(
        "SELECT slot FROM inference_locks WHERE owner_id = ? ORDER BY slot",
        device.ownerId,
      ),
    ).toEqual([{ slot: 0 }, { slot: 1 }, { slot: 2 }, { slot: 4 }]);
  });

  it("runs five of an owner's requests at once and answers a sixth busy", async () => {
    const device = await owner();
    let release!: () => void;
    state.held = new Promise((resolve) => {
      release = resolve;
    });
    // Five first pages of different start paths, so five recipes.
    const pages = [1, 2, 3, 4, 5].map((index) => ({ ...emailPage, path: `/login/${index}` }));
    state.replies.push(
      ...pages.map(() => ({ text: plan([["email", "email"]], "next", "advance") })),
    );
    const running = pages.map((page) => generate(device, page));
    try {
      await vi.waitFor(() => expect(state.sent).toHaveLength(5), { timeout: 5_000 });
      expect(
        await rows(
          "SELECT slot FROM inference_locks WHERE owner_id = ? ORDER BY slot",
          device.ownerId,
        ),
      ).toEqual([{ slot: 0 }, { slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }]);
      expect(await generate(device, { ...emailPage, path: "/login/6" })).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
    } finally {
      // Never leave the five requests waiting into the next test.
      release();
    }
    const answers = await Promise.all(running);
    expect(answers.map((answer) => answer.status)).toEqual(Array(5).fill("recipe"));
    expect(
      new Set(answers.map((answer) => answer.status === "recipe" && answer.change.recipeId)).size,
    ).toBe(5);
    expect(state.sent).toHaveLength(5);
    expect(await rows("SELECT * FROM inference_locks WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });

  it("charges the worst case after a failed call that reports no usage", async () => {
    const device = await owner();
    state.replies.push(500);
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
      { calls: 1, cost_micro_usd: WORST_CASE },
      { calls: 1, cost_micro_usd: WORST_CASE },
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
    state.replies.push({ refusal: "cyber", usage: { input_tokens: 3_000, output_tokens: 0 } });
    state.replies.push({
      text: plan([["email", "email"]], "next", "advance"),
      usage: { input_tokens: 3_000, output_tokens: 100 },
    });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(state.sent.map(({ body }) => (body as { model: string }).model)).toEqual([
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
    state.replies.push({ refusal: "cyber" }, { refusal: "general_harms" });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "failed",
      error: "refused",
    });
    expect(state.sent).toHaveLength(2);
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

  it("logs the provider's refusal category code with a refused call (ADR 0014)", async () => {
    const device = await owner();
    state.replies.push({ refusal: "cyber" }, { refusal: "general_harms" });
    expect(await generate(device, emailPage)).toMatchObject({ error: "refused" });
    // The owner approved recording the category code, never the provider's explanation.
    const logged = await rows(
      "SELECT outcome, result FROM inference_log WHERE owner_id = ? ORDER BY created_at",
      device.ownerId,
    );
    expect(
      logged.map(({ outcome, result }) => ({ outcome, result: JSON.parse(String(result)) })),
    ).toEqual([
      { outcome: "refused", result: { refusalCategory: "cyber" } },
      { outcome: "refused", result: { refusalCategory: "general_harms" } },
    ]);
  });

  it("asks no other model once the refused call reached the daily spend stop", async () => {
    const device = await owner();
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 0, ?)",
    )
      .bind(device.ownerId, day(), 4_995_000)
      .run();
    state.replies.push({ refusal: "cyber", usage: { input_tokens: 3_000, output_tokens: 0 } });
    expect(await generate(device, emailPage)).toMatchObject({ error: "refused" });
    expect(state.sent).toHaveLength(1);
  });

  it("asks no other model after a failure that is not a refusal", async () => {
    const device = await owner();
    state.replies.push(500);
    expect(await generate(device, emailPage)).toMatchObject({ error: "provider-error" });
    expect(state.sent).toHaveLength(1);
  });
}
