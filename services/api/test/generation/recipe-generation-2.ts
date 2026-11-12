import { env, exports } from "cloudflare:workers";
import { generationInstructions, generationPromptVersion } from "@pateat/inference";
import { expect, it, vi } from "vitest";
import { saveModelConfig } from "../../src/claude/models";
import { generatedRecipeId } from "@pateat/generation";
import type { RecipeChoiceContext } from "./context";

export function registerRecipeGeneration2(context: RecipeChoiceContext) {
  const {
    ORIGIN,
    DAY_MS,
    slots,
    element,
    observation,
    emailPage,
    passwordPage,
    homePage,
    bigPage,
    route,
    plan,
    holdSlots,
    owner,
    layoutKey,
    post,
    projected,
    generate,
    complete,
    serverTiming,
    rows,
    month,
    day,
    failLogPurge,
    failLogUpdate,
    logRows,
    hashOf,
    twoPageRecipe,
    bigSlots,
    choice,
    asked,
    state,
  } = context;

  it("asks the owner's configured model and effort, and logs them", async () => {
    const device = await owner();
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [choice("claude-sonnet-5-5", "medium", "standard")],
      judge: [choice("claude-opus-5-5", "low", "standard")],
    });
    state.replies.push({
      text: plan([["email", "email"]], "next", "advance"),
      usage: { input_tokens: 3_000, output_tokens: 100 },
    });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(asked()).toEqual([{ model: "claude-sonnet-5-5", effort: "medium", speed: undefined }]);
    expect(
      await rows(
        "SELECT model_id, effort, speed, cost_micro_usd FROM inference_log WHERE owner_id = ?",
        device.ownerId,
      ),
    ).toEqual([
      { model_id: "claude-sonnet-5-5", effort: "medium", speed: "standard", cost_micro_usd: 7_000 },
    ]);
  });

  it("asks the same model at the standard speed when fast mode fails", async () => {
    const device = await owner();
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [
        choice("claude-opus-5-5", "low", "fast"),
        choice("claude-sonnet-5-5", "low", "standard"),
      ],
      judge: [choice("claude-opus-5-5", "low", "standard")],
    });
    state.replies.push(429, {
      text: plan([["email", "email"]], "next", "advance"),
      usage: { input_tokens: 3_000, output_tokens: 100 },
    });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(asked()).toEqual([
      { model: "claude-opus-5-5", effort: "low", speed: "fast" },
      { model: "claude-opus-5-5", effort: "low", speed: undefined },
    ]);
    // The rejected fast call reported no usage, so it counts at fast mode's worst case.
    expect(
      await rows(
        "SELECT model_id, speed, outcome, cost_micro_usd FROM inference_log WHERE owner_id = ? ORDER BY created_at",
        device.ownerId,
      ),
    ).toEqual([
      {
        model_id: "claude-opus-5-5",
        speed: "fast",
        outcome: "rate-limited",
        cost_micro_usd: 64 * 1024 * 8 + 1_024 * 40,
      },
      { model_id: "claude-opus-5-5", speed: "standard", outcome: "ok", cost_micro_usd: 14_000 },
    ]);
  });

  it("gives up when the standard speed fails after fast mode", async () => {
    const device = await owner();
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [
        choice("claude-opus-5-5", "low", "fast"),
        choice("claude-sonnet-5-5", "low", "standard"),
      ],
      judge: [choice("claude-opus-5-5", "low", "standard")],
    });
    state.replies.push(429, 500);
    expect(await generate(device, emailPage)).toMatchObject({ error: "provider-error" });
    expect(asked().map(({ model }) => model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
  });

  it("asks no standard call once the failed fast call reached the daily spend stop", async () => {
    const device = await owner();
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [choice("claude-opus-5-5", "low", "fast")],
      judge: [choice("claude-opus-5-5", "low", "standard")],
    });
    // Under the stop until fast mode's worst case, about $0.57, is charged.
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 0, ?)",
    )
      .bind(device.ownerId, day(), 4_500_000)
      .run();
    state.replies.push(429);
    expect(await generate(device, emailPage)).toMatchObject({ error: "rate-limited" });
    expect(state.sent).toHaveLength(1);
  });

  it("runs a saved fast choice at the standard speed while its fast calls keep failing", async () => {
    const device = await owner();
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [choice("claude-opus-5-5", "low", "fast")],
      judge: [choice("claude-opus-5-5", "low", "standard")],
    });
    const now = Date.now();
    await env.DB.batch(
      [1, 2, 3].map((index) =>
        env.DB.prepare(
          "INSERT INTO inference_log (id, owner_id, role, provider, model_id, speed, origin, path, request, outcome, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'claude-opus-5-5', 'fast', ?, '/', '{}', 'rate-limited', 0, ?)",
        ).bind(crypto.randomUUID(), device.ownerId, ORIGIN, now - index * 1000),
      ),
    );
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(asked()).toEqual([{ model: "claude-opus-5-5", effort: "low", speed: undefined }]);
  });

  it("asks the next choice, not the standard speed, when fast mode refuses", async () => {
    const device = await owner();
    await saveModelConfig(env.DB, device.ownerId, {
      generate: [
        choice("claude-opus-5-5", "low", "fast"),
        choice("claude-sonnet-5-5", "low", "standard"),
      ],
      judge: [choice("claude-opus-5-5", "low", "standard")],
    });
    state.replies.push(
      { refusal: "cyber" },
      { text: plan([["email", "email"]], "next", "advance") },
    );
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
    expect(asked()).toEqual([
      { model: "claude-opus-5-5", effort: "low", speed: "fast" },
      { model: "claude-sonnet-5-5", effort: "low", speed: undefined },
    ]);
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
    state.replies.push({ text: refused, usage: { input_tokens: 2_900, output_tokens: 78 } });
    expect(await generate(device, page)).toEqual({
      version: 1,
      status: "failed",
      error: "invalid-output",
      rejection: { check: "plan", reason: "incompatible-role" },
    });
    // Output the format refuses: only the issue and where it was, never the text.
    const other = await owner();
    state.replies.push({
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
    state.replies.push({ text: "Sign in with the email field." });
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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
    expect(state.sent).toHaveLength(0);
  });

  it("serves the recipe feed when the retention delete fails and logs no error values", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const generated = await generate(device, emailPage);
    if (generated.status !== "recipe") throw new Error(generated.status);
    const purge = failLogPurge();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const feed = await exports.default.fetch("https://pateat.invalid/v1/recipes", {
        headers: { Authorization: `Bearer ${device.token}` },
      });
      expect(feed.status).toBe(200);
      const body = (await feed.json()) as { changes: unknown[] };
      expect({
        ...body,
        changes: body.changes.map((change) => projected({ change }).change),
      }).toEqual({ version: 1, changes: [generated.change], cursor: 1, complete: true });
      expect(purge).toHaveBeenCalledWith(expect.stringMatching(/^delete from "inference_log"/iu));
      expect(error.mock.calls).toEqual([["Inference log purge failed"]]);
    } finally {
      purge.mockRestore();
      error.mockRestore();
    }
  });

  it("records a paid call and its corrected spend when the retention delete fails", async () => {
    const device = await owner();
    state.replies.push({
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
    state.replies.push({
      text: JSON.stringify({ result: { decision: "signed-in", marker: "logout" } }),
    });
    expect((await complete(device, change.recipeId, 2)).body).toMatchObject({
      status: "signed-in",
      change: { revision: 3 },
    });
    const generated = await logRows(device.ownerId);
    const [judged] = await logRows(device.ownerId, "judge");
    const common = { recipe_id: change.recipeId, build: "test-revision" };
    // A first page names no layout; the later page and the judgement name the one it made.
    const layout = { branch: await layoutKey(device.ownerId, change.recipeId) };
    expect(generated.map(({ request: _request, observation_hash: _hash, ...row }) => row)).toEqual([
      {
        ...common,
        branch: "",
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
        ...layout,
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
      ...layout,
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
    state.replies.push({
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
    state.replies.push({ text: JSON.stringify({ result: { decision: "challenge" } }) });
    expect((await complete(judged, change.recipeId, 2)).body).toEqual({
      version: 1,
      status: "challenge",
    });
    // A marker the page lacks fails closed; the row keeps the answer, never its text.
    state.replies.push({
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
      state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    // The password form replaces the email form on the same path.
    const samePath = { ...passwordPage, path: "/login" };
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
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
    state.replies.push({
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
    const calls = state.sent.length;
    const reposted = observation("/session", [
      { id: "c1", role: "email", target: { by: "label", value: "Email address" } },
      element("help", "link", "Help"),
    ]);
    expect((await complete(device, result.change.recipeId, 1, reposted)).body).toEqual({
      version: 1,
      status: "unavailable",
      reason: "not-judgeable",
    });
    expect(state.sent).toHaveLength(calls);
  });

  it("fails a continuation that fills one of the recipe's slots again, storing nothing", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    // The email form shown again where it posted, as after an unknown account.
    const again = { ...emailPage, path: "/login/identifier" };
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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

  it("holds a call slot for the whole call and releases only its own", async () => {
    const device = await owner();
    state.during = async () => {
      // With the other four slots held, a request while the call runs is turned away.
      await holdSlots(device.ownerId, [1, 2, 3, 4]);
      expect(await generate(device, passwordPage)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "busy",
      });
      // A request that took over the abandoned slot keeps it.
      await env.DB.prepare(
        "UPDATE inference_locks SET lock_id = 'other' WHERE owner_id = ? AND slot = 0",
      )
        .bind(device.ownerId)
        .run();
    };
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    await generate(device, emailPage);
    expect(
      await rows(
        "SELECT slot, lock_id FROM inference_locks WHERE owner_id = ? ORDER BY slot",
        device.ownerId,
      ),
    ).toEqual([0, 1, 2, 3, 4].map((slot) => ({ slot, lock_id: "other" })));
  });

  it("refuses an oversized page locally: no call and no charge, and logs it unsent", async () => {
    const device = await owner();
    const big = bigPage();
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
    expect(state.sent).toEqual([]);
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
    ).toEqual([]);
    // Nothing reached the model, so the page is not held for the retry window (ADR 0016).
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("gives an oversized page back: a resend is refused again, not recently-tried", async () => {
    const device = await owner();
    const request = { version: 1, observation: bigPage(), slots: bigSlots, signedIn: false };
    const refused = { version: 1, status: "failed", error: "input-too-large" };
    expect(await (await post(device, "/v1/recipes/generate", request)).json()).toEqual(refused);
    // No model call was made, so the extension frees the page for its next visit (ADR
    // 0016); `recently-tried` would tell it the model was called.
    expect(await (await post(device, "/v1/recipes/generate", request)).json()).toEqual(refused);
    expect(state.sent).toEqual([]);
  });

  it("answers a conflict when this origin's recipe ID holds another origin", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    const elsewhere = {
      version: 1,
      id: recipeId,
      revision: 1,
      origin: "https://other.example.test",
      layouts: [
        {
          key: "1000",
          createdAt: 1000,
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
        },
      ],
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
    expect(state.sent).toEqual([]);
  });
}
