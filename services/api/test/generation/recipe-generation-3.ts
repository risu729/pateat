import { MAX_ACTIVE_RECIPE_BYTES } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MAX_ACTIVE_RECIPES } from "../../src/limits";
import { writeRecipe } from "../../src/recipe-store";
import { generatedRecipeId, MIN_GENERATION_RECIPE_ROOM_BYTES } from "@pateat/generation";
import { seedRecipeBytes, storedRecipeBytes } from "../recipe-byte-helpers";
import type { GenerationContext } from "./context";

export function registerRecipeGeneration3(context: GenerationContext) {
  const {
    ORIGIN,
    slots,
    element,
    observation,
    emailPage,
    passwordPage,
    route,
    plan,
    owner,
    post,
    documentOf,
    generate,
    complete,
    rows,
    logRows,
    state,
  } = context;

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
    expect(state.sent).toEqual([]);
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
      chooser: {
        path: "/login",
        layouts: [
          { key: "1000", createdAt: 1000, other: { by: "text", value: "Use another account" } },
        ],
      },
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
    expect(state.sent).toEqual([]);
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({
      status: "recipe",
      change: { recipeId: loginId, revision: 1 },
    });
    expect(state.sent).toHaveLength(1);

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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(other, emailPage)).toMatchObject({
      status: "recipe",
      change: { recipeId: loginId, revision: 3, recipe: { revision: 3, slots: ["email"] } },
    });
    expect(state.sent).toHaveLength(2);
  });

  it("refuses an incomplete page without recording an attempt", async () => {
    const device = await owner();
    expect(await generate(device, { ...emailPage, complete: false })).toEqual({
      version: 1,
      status: "failed",
      error: "incomplete-observation",
    });
    expect(state.sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("maps refused and failed token exchanges without a model call or an attempt", async () => {
    const device = await owner();
    state.tokenStatus = 401;
    expect(await generate(device, emailPage)).toMatchObject({ reason: "credentials-rejected" });
    state.tokenStatus = 503;
    expect(await generate(device, emailPage)).toMatchObject({ reason: "token-exchange-failed" });
    expect(state.sent).toEqual([]);
    expect(
      await rows("SELECT * FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([]);
  });

  it("refuses a revoked base, a stale base, a base with no recipe and a non-generated base", async () => {
    const device = await owner();
    const recipeId = await generatedRecipeId(ORIGIN, "/login");
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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
    expect(state.sent).toHaveLength(1);
  });

  it("generates a separate recipe for a page where no recipe of the origin starts", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    // After an account switch the password page of another account is a new start.
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
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
    expect(state.sent).toHaveLength(2);

    // Two recipes that both lead to the same page each get it generated once.
    const widgetPage = { ...emailPage, path: "/" };
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const widget = await generate(device, widgetPage);
    if (widget.status !== "recipe") throw new Error(widget.status);
    const next = observation("/next", [
      element("password", "password", "Password"),
      element("sign-in", "button", "Sign in"),
    ]);
    // In turn, so the queued replies answer the pages in order.
    const continueAt = async (started: typeof first) => {
      state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
      expect(
        await generate(device, next, { recipeId: started.change.recipeId, revision: 1 }),
      ).toMatchObject({ status: "recipe", change: { recipeId: started.change.recipeId } });
    };
    await continueAt(first);
    await continueAt(widget);
    expect(state.sent).toHaveLength(5);

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
            recipe: documentOf({ ...route(first.change.recipe), id: misplacedId, revision: 1 }),
          },
          device.deviceId,
        )
      ).ok,
    ).toBe(true);
    expect(
      await generate(device, passwordPage, { recipeId: misplacedId, revision: 1 }),
    ).toMatchObject({ reason: "recipe-conflict" });
    expect(state.sent).toHaveLength(5);
  });

  it("stores a recipe under a path with [id] and answers every tenant's page with it (ADR 0039)", async () => {
    const device = await owner();
    const tenantPage = { ...passwordPage, path: "/[id]/oauth2/authorize" };
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
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
    expect(state.sent).toHaveLength(1);
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
    state.replies.push({
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
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
    expect(state.sent).toHaveLength(1);

    // Its first page writes the revision after the tombstone, without waiting out the
    // attempt the first recipe made (owner, 2026-10-12).
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toMatchObject({
      status: "recipe",
      change: {
        recipeId: first.change.recipeId,
        revision: 3,
        state: "active",
        recipe: { revision: 3 },
      },
    });
    expect(state.sent).toHaveLength(2);
    expect(
      await rows(
        "SELECT base_revision FROM generation_attempts WHERE owner_id = ? ORDER BY base_revision",
        device.ownerId,
      ),
    ).toEqual([{ base_revision: 0 }, { base_revision: 2 }]);
    // The new recipe is continued as usual.
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES -
        (await storedRecipeBytes(device.ownerId)) -
        MIN_GENERATION_RECIPE_ROOM_BYTES +
        1,
    );
    const limited = { version: 1, status: "unavailable", reason: "recipe-limit" };
    expect(await generate(device, observation("/other", emailPage.candidates))).toEqual(limited);
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toEqual(limited);
    expect(state.sent).toHaveLength(1);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: "/login" }]);
    // A cached active answer costs no call and remains available at the limit.
    expect(await generate(device, emailPage)).toMatchObject({ status: "recipe" });
  });

  it("admits exactly 32 KiB of preflight room and maps a racing continuation's byte refusal", async () => {
    const device = await owner();
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);
    await seedRecipeBytes(
      device.ownerId,
      MAX_ACTIVE_RECIPE_BYTES -
        (await storedRecipeBytes(device.ownerId)) -
        MIN_GENERATION_RECIPE_ROOM_BYTES,
    );
    state.during = async () => {
      await env.DB.prepare(
        "UPDATE recipe_revisions SET document = document || ? WHERE owner_id = ? AND recipe_id = 'byte-seed'",
      )
        .bind(" ".repeat(MIN_GENERATION_RECIPE_ROOM_BYTES), device.ownerId)
        .run();
    };
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toEqual({ version: 1, status: "unavailable", reason: "recipe-limit" });
    expect(state.sent).toHaveLength(2);
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
    state.during = () => seedRecipeBytes(device.ownerId, MAX_ACTIVE_RECIPE_BYTES);
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(await generate(device, emailPage)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(state.sent).toHaveLength(1);
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
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const first = await generate(device, emailPage);
    if (first.status !== "recipe") throw new Error(first.status);

    const other = observation("/signin", emailPage.candidates, "https://other.example.test");
    expect(await generate(device, other)).toEqual({
      version: 1,
      status: "unavailable",
      reason: "recipe-limit",
    });
    expect(state.sent).toHaveLength(1);
    expect(
      await rows("SELECT path FROM generation_attempts WHERE owner_id = ?", device.ownerId),
    ).toEqual([{ path: "/login" }]);
    // Continuing a stored recipe adds none.
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    expect(
      await generate(device, passwordPage, { recipeId: first.change.recipeId, revision: 1 }),
    ).toMatchObject({ status: "recipe", change: { revision: 2 } });
  });
}
