import {
  type EntryGenerationResult,
  type LoginChooserDocument,
  type LoginObservation,
  type LoginRecipeDocument,
  type RecipeGenerationResult,
  isLoginRecipeDocument,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDeviceToken, hashDeviceToken } from "../../src/auth";
import { writeRecipe } from "../../src/recipe-store";
import { generatedRecipeId } from "@pateat/generation";
import type { GenerationContext, Device } from "./context";

export function registerRepair(context: GenerationContext) {
  const {
    ORIGIN,
    DAY_MS,
    slots,
    element,
    observation,
    emailPage,
    passwordPage,
    plan,
    owner,
    post,
    storedHead,
    rows,
    logRows,
    state,
  } = context;

  // The start page after a redesign: the same form with other element IDs.
  const redesigned = observation("/login", [
    element("user-email", "email", "Email"),
    element("continue", "button", "Continue"),
  ]);
  // The password page after a redesign.
  const newPassword = observation("/password", [
    element("passcode", "password", "Password"),
    element("go", "button", "Sign in"),
  ]);
  async function repair(device: Device, page: LoginObservation, target: unknown) {
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: page,
      // A list of accounts goes without slots (ADR 0028).
      slots: page.accounts ? [] : slots,
      repair: target,
      // A start page carries the signedIn hint, a later step's page or a list none (ADR 0035).
      ...((target as { layout?: string } | null)?.layout === undefined && !page.accounts
        ? { signedIn: false }
        : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as RecipeGenerationResult | { error: string },
    };
  }
  /** The two-page recipe with one layout, at revision 2. */
  async function storedRecipe(device: Device) {
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    const started = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: emailPage,
      slots,
      signedIn: false,
    });
    const first = (await started.json()) as RecipeGenerationResult;
    if (first.status !== "recipe" || !isLoginRecipeDocument(first.change.recipe))
      throw new Error("Expected a login recipe");
    const layout = first.change.recipe.layouts[0]!.key;
    state.replies.push({ text: plan([["password", "password"]], "sign-in", "submit") });
    const response = await post(device, "/v1/recipes/generate", {
      version: 1,
      observation: passwordPage,
      slots,
      base: { recipeId: first.change.recipeId, revision: first.change.revision },
      branch: layout,
    });
    const second = (await response.json()) as RecipeGenerationResult;
    if (second.status !== "recipe") throw new Error(second.status);
    return { change: second.change, layout };
  }
  const layoutsOf = (result: RecipeGenerationResult | { error: string }) => {
    if (
      !("status" in result) ||
      result.status !== "recipe" ||
      !isLoginRecipeDocument(result.change.recipe)
    )
      throw new Error("Expected a login recipe");
    return result.change.recipe.layouts;
  };

  it("adds a layout for a changed start page beside the stale one, once a day per device", async () => {
    const device = await owner();
    const { change, layout } = await storedRecipe(device);
    state.replies.push({ text: plan([["email", "user-email"]], "continue", "advance") });
    const repaired = await repair(device, redesigned, { recipeId: change.recipeId, revision: 2 });
    expect(repaired).toMatchObject({
      status: 200,
      body: { status: "recipe", change: { recipeId: change.recipeId, revision: 3 } },
    });
    const layouts = layoutsOf(repaired.body);
    // The stale layout keeps its continuation; the new one has only the new start page.
    expect(
      layouts.map((entry) => [entry.key === layout, entry.language, entry.steps.length]),
    ).toEqual([
      [true, "en", 4],
      [false, "en", 2],
    ]);
    expect(layouts[1]!.steps[0]).toMatchObject({
      fields: [{ target: { by: "id", value: "user-email" } }],
    });
    // The call is logged as a first page's.
    expect((await logRows(device.ownerId)).at(-1)).toMatchObject({
      recipe_id: change.recipeId,
      base_revision: 2,
      revision: 3,
      recipe_page: "first",
    });
    // A second repair the same UTC day from this device is refused before any call.
    const calls = state.sent.length;
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 3 })).body,
    ).toEqual({ version: 1, status: "unavailable", reason: "repair-limit" });
    expect(state.sent).toHaveLength(calls);
    // Another device of the owner has its own repair of the day.
    const otherId = `device-${crypto.randomUUID()}`;
    const otherToken = createDeviceToken();
    await env.DB.prepare(
      "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        otherId,
        device.ownerId,
        device.ownerId,
        await hashDeviceToken(otherToken),
        Date.now(),
        Date.now(),
      )
      .run();
    const other = { ...device, deviceId: otherId, token: otherToken };
    const again = observation("/login", [
      element("login-email", "email", "Email"),
      element("go-on", "button", "Continue"),
    ]);
    state.replies.push({ text: plan([["email", "login-email"]], "go-on", "advance") });
    expect(
      (await repair(other, again, { recipeId: change.recipeId, revision: 3 })).body,
    ).toMatchObject({ status: "recipe", change: { revision: 4 } });
    // The next UTC day allows the first device one again.
    await env.DB.prepare("UPDATE recipe_repairs SET repaired_at = ? WHERE device_id = ?")
      .bind(Date.now() - DAY_MS, device.deviceId)
      .run();
    const third = observation("/login", [
      element("mail", "email", "Email"),
      element("onward", "button", "Continue"),
    ]);
    state.replies.push({ text: plan([["email", "mail"]], "onward", "advance") });
    const replaced = await repair(device, third, { recipeId: change.recipeId, revision: 4 });
    // A fourth layout takes the place of the least recently used one: the stale layout.
    expect(layoutsOf(replaced.body).map((entry) => entry.steps[0])).toMatchObject([
      { fields: [{ target: { value: "user-email" } }] },
      { fields: [{ target: { value: "login-email" } }] },
      { fields: [{ target: { value: "mail" } }] },
    ]);
  });

  it("writes nothing when the model abstains, which still spends the day", async () => {
    const device = await owner();
    const { change } = await storedRecipe(device);
    // A maintenance page answered 200 that kept an input: the model finds no login form.
    state.replies.push({
      text: JSON.stringify({ result: { decision: "abstain", reason: "no-login-form" } }),
    });
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 2 })).body,
    ).toEqual({ version: 1, status: "abstained", reason: "no-login-form" });
    expect(
      await rows(
        "SELECT revision FROM recipe_heads WHERE owner_id = ? AND recipe_id = ?",
        device.ownerId,
        change.recipeId,
      ),
    ).toEqual([{ revision: 2 }]);
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 2 })).body,
    ).toMatchObject({ reason: "repair-limit" });
  });

  it("writes nothing for an answer that is no sign-in page, which still spends the day", async () => {
    const device = await owner();
    const { change } = await storedRecipe(device);
    // A maintenance page answered 200 with a newsletter input, planned as an unclear page.
    const unclear = JSON.parse(plan([["email", "user-email"]], "continue", "advance")) as {
      result: { pageKind: string };
    };
    unclear.result.pageKind = "unclear";
    state.replies.push({ text: JSON.stringify(unclear) });
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 2 })).body,
    ).toEqual({ version: 1, status: "recipe", change });
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 2 })).body,
    ).toMatchObject({ reason: "repair-limit" });
  });

  it("keeps the recipe as it is when the page gives a layout's start page again", async () => {
    const device = await owner();
    const { change } = await storedRecipe(device);
    // The elements were there after all, as on a page that was only slow.
    state.replies.push({ text: plan([["email", "email"]], "next", "advance") });
    expect(
      (await repair(device, emailPage, { recipeId: change.recipeId, revision: 2 })).body,
    ).toEqual({ version: 1, status: "recipe", change });
  });

  it("adds a layout that continues a later step's page from the step before it", async () => {
    const device = await owner();
    const { change, layout } = await storedRecipe(device);
    state.replies.push({ text: plan([["password", "passcode"]], "go", "submit") });
    const repaired = await repair(device, newPassword, {
      recipeId: change.recipeId,
      revision: 2,
      layout,
      step: 2,
    });
    const layouts = layoutsOf(repaired.body);
    expect(layouts).toHaveLength(2);
    expect(layouts[1]!.steps).toMatchObject([
      { kind: "fill", path: "/login", fields: [{ target: { value: "email" } }] },
      { kind: "click", path: "/login", target: { value: "next" }, purpose: "advance" },
      { kind: "fill", path: "/password", fields: [{ target: { value: "passcode" } }] },
      { kind: "click", path: "/password", target: { value: "go" }, purpose: "submit" },
    ]);
    expect((await logRows(device.ownerId)).at(-1)).toMatchObject({ recipe_page: "continuation" });
    // The new layout's pages keep the calls that made them: its start page the first page's,
    // its new page the repair's (ADR 0060 provenance).
    const sources = (await rows(
      "SELECT layout, unit, log_id FROM recipe_unit_sources WHERE owner_id = ? ORDER BY layout, unit",
      device.ownerId,
    )) as { layout: string; unit: string; log_id: string }[];
    const logs = (await rows(
      "SELECT id FROM inference_log WHERE owner_id = ? AND role = 'generate' ORDER BY created_at",
      device.ownerId,
    )) as { id: string }[];
    expect(sources.filter((row) => row.layout === layouts[1]!.key)).toEqual([
      { layout: layouts[1]!.key, unit: "page:0", log_id: logs.at(-3)!.id },
      { layout: layouts[1]!.key, unit: "page:2", log_id: logs.at(-1)!.id },
    ]);
    // A step that follows no advance is no later page to repair.
    expect(
      (
        await repair(device, newPassword, {
          recipeId: change.recipeId,
          revision: 3,
          layout,
          step: 3,
        })
      ).body,
    ).toMatchObject({ reason: "recipe-conflict" });
  });

  describe("chooser and sign-in entry recipes (ADR 0041 section 6, owner 2026-10-23 13:03 UTC)", () => {
    const list = (other: string): LoginObservation => ({
      ...observation("/login", [
        element(other, "button", "Use another account"),
        element("help", "link", "Help"),
      ]),
      accounts: ["[email]"],
    });
    const listAnswer = (other: string) =>
      JSON.stringify({ result: { decision: "account-list", other } });
    const storedChooser = async (device: Device) => {
      state.replies.push({ text: listAnswer("other") });
      const response = await post(device, "/v1/recipes/generate", {
        version: 1,
        observation: list("other"),
        slots: [],
      });
      const body = (await response.json()) as RecipeGenerationResult;
      if (body.status !== "recipe") throw new Error(body.status);
      return body.change;
    };
    it("adds a chooser layout for a list whose buttons changed, and none for the same list", async () => {
      const device = await owner();
      const change = await storedChooser(device);
      state.replies.push({ text: listAnswer("another") });
      const repaired = await repair(device, list("another"), {
        recipeId: change.recipeId,
        revision: 1,
      });
      expect(repaired.body).toMatchObject({ status: "recipe", change: { revision: 2 } });
      const stored = await storedHead(device.ownerId, change.recipeId);
      expect(stored).toMatchObject({
        revision: 2,
        chooser: {
          layouts: [{ other: { value: "other" } }, { other: { value: "another" }, language: "en" }],
        },
      });
      // Another device's repair of the same list writes nothing.
      const otherId = `device-${crypto.randomUUID()}`;
      const otherToken = createDeviceToken();
      await env.DB.prepare(
        "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          otherId,
          device.ownerId,
          device.ownerId,
          await hashDeviceToken(otherToken),
          Date.now(),
          Date.now(),
        )
        .run();
      state.replies.push({ text: listAnswer("other") });
      expect(
        (
          await repair({ ...device, deviceId: otherId, token: otherToken }, list("other"), {
            recipeId: change.recipeId,
            revision: 2,
          })
        ).body,
      ).toMatchObject({ status: "recipe", change: { revision: 2 } });
    });

    it("adds the passkey button beside a chooser's list to its layout, keeping its branches (ADR 0079)", async () => {
      const device = await owner();
      const change = await storedChooser(device);
      const withButton = (target: string): LoginObservation => ({
        ...list("other"),
        candidates: [...list("other").candidates, element(target, "button", "Use a passkey")],
      });
      const answer = (passkeyButton: string) =>
        JSON.stringify({ result: { decision: "account-list", other: "other", passkeyButton } });
      state.replies.push({ text: answer("key") });
      expect(
        (await repair(device, withButton("key"), { recipeId: change.recipeId, revision: 1 })).body,
      ).toMatchObject({ status: "recipe", change: { revision: 2 } });
      const stored = (await storedHead(device.ownerId, change.recipeId)) as LoginChooserDocument;
      expect(stored.chooser.layouts).toHaveLength(1);
      expect(stored.chooser.layouts[0]).toMatchObject({
        other: { value: "other" },
        passkey: { passkeyOnly: true, passkey: { target: { by: "id", value: "key" } } },
      });
      // The next day, the same button writes nothing; another one takes its place.
      const nextDay = () =>
        env.DB.prepare("UPDATE recipe_repairs SET repaired_at = ? WHERE device_id = ?")
          .bind(Date.now() - DAY_MS, device.deviceId)
          .run();
      await nextDay();
      state.replies.push({ text: answer("key") });
      expect(
        (await repair(device, withButton("key"), { recipeId: change.recipeId, revision: 2 })).body,
      ).toMatchObject({ status: "recipe", change: { revision: 2 } });
      await nextDay();
      state.replies.push({ text: answer("passkey") });
      expect(
        (await repair(device, withButton("passkey"), { recipeId: change.recipeId, revision: 2 }))
          .body,
      ).toMatchObject({ status: "recipe", change: { revision: 3 } });
      expect(await storedHead(device.ownerId, change.recipeId)).toMatchObject({
        chooser: {
          layouts: [{ passkey: { passkey: { target: { by: "id", value: "passkey" } } } }],
        },
      });
    });

    it("adds a list beside a login recipe's layouts, and a form beside a chooser's list (#1248)", async () => {
      const device = await owner();
      const { change } = await storedRecipe(device);
      const before = (await storedHead(device.ownerId, change.recipeId)) as LoginRecipeDocument;
      // The start page shows a list of accounts: the list is added, the layouts stay, as the
      // same URL shows either by the state of the browser's session.
      state.replies.push({ text: listAnswer("other") });
      expect(
        (await repair(device, list("other"), { recipeId: change.recipeId, revision: 2 })).body,
      ).toMatchObject({ status: "recipe", change: { revision: 3 } });
      expect(await storedHead(device.ownerId, change.recipeId)).toEqual({
        ...before,
        revision: 3,
        chooser: {
          path: "/login",
          layouts: [expect.objectContaining({ other: { by: "id", value: "other" } })],
        },
      });
      // The next day the page is a form no layout fits: it is added beside the others, and
      // the list stays.
      await env.DB.prepare("UPDATE recipe_repairs SET repaired_at = ? WHERE device_id = ?")
        .bind(Date.now() - DAY_MS, device.deviceId)
        .run();
      state.replies.push({ text: plan([["email", "user-email"]], "continue", "advance") });
      expect(
        (await repair(device, redesigned, { recipeId: change.recipeId, revision: 3 })).body,
      ).toMatchObject({ status: "recipe", change: { revision: 4 } });
      const after = (await storedHead(device.ownerId, change.recipeId)) as LoginRecipeDocument;
      expect(after.layouts[0]).toEqual(before.layouts[0]);
      expect(after.layouts).toMatchObject([
        {},
        { steps: [{ fields: [{ target: { value: "user-email" } }] }, {}] },
      ]);
      expect(after.chooser?.layouts).toHaveLength(1);
    });

    it("adds a form's layout beside a chooser's list whose path shows a form (#1248)", async () => {
      const device = await owner();
      const change = await storedChooser(device);
      const stored = (await storedHead(device.ownerId, change.recipeId)) as LoginChooserDocument;
      state.replies.push({ text: plan([["email", "user-email"]], "continue", "advance") });
      expect(
        (await repair(device, redesigned, { recipeId: change.recipeId, revision: 1 })).body,
      ).toMatchObject({ status: "recipe", change: { revision: 2 } });
      expect(await storedHead(device.ownerId, change.recipeId)).toMatchObject({
        revision: 2,
        chooser: stored.chooser,
        layouts: [{ steps: [{ fields: [{ target: { value: "user-email" } }] }, {}] }],
      });
    });

    it("repairs an entry recipe's link once a day, and keeps it when the model names it again", async () => {
      const device = await owner();
      const recipeId = await generatedRecipeId(ORIGIN, "/en/");
      const top = (text: string) =>
        observation("/en/", [
          { id: "c1", role: "link", target: { by: "text", value: "Create account" } },
          { id: "c2", role: "link", target: { by: "text", value: text } },
        ]);
      const entryAnswer = JSON.stringify({ result: { decision: "entry", entry: "c2" } });
      const entry = async (page: LoginObservation, revision?: number) =>
        (await (
          await post(device, "/v1/recipes/generate", {
            version: 1,
            observation: page,
            ...(revision === undefined ? {} : { repair: { recipeId, revision } }),
          })
        ).json()) as EntryGenerationResult;
      state.replies.push({ text: entryAnswer });
      expect(await entry(top("Login"))).toMatchObject({
        status: "recipe",
        change: { revision: 1 },
      });
      // Translated: the link is named by its new text, as the next revision.
      state.replies.push({ text: entryAnswer });
      expect(await entry(top("ログイン"), 1)).toMatchObject({
        status: "recipe",
        change: { revision: 2, recipe: { entry: { target: { value: "ログイン" } } } },
      });
      // A second repair the same day is refused before any call.
      const calls = state.sent.length;
      expect(await entry(top("Sign in"), 2)).toEqual({
        version: 1,
        status: "unavailable",
        reason: "repair-limit",
      });
      expect(state.sent).toHaveLength(calls);
      // The next day, the same link again writes nothing.
      await env.DB.prepare("UPDATE recipe_repairs SET repaired_at = ? WHERE device_id = ?")
        .bind(Date.now() - DAY_MS, device.deviceId)
        .run();
      state.replies.push({ text: entryAnswer });
      expect(await entry(top("ログイン"), 2)).toMatchObject({
        status: "recipe",
        change: { revision: 2 },
      });
    });
  });

  it("answers a newer, revoked or other recipe without a call", async () => {
    const device = await owner();
    const { change } = await storedRecipe(device);
    const calls = state.sent.length;
    // Another device repaired it, or it learned more: that revision answers.
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 1 })).body,
    ).toEqual({ version: 1, status: "recipe", change });
    // A start page's repair names the recipe that starts on its path.
    const elsewhere = await generatedRecipeId(ORIGIN, "/elsewhere");
    expect(
      (await repair(device, redesigned, { recipeId: elsewhere, revision: 1 })).status,
    ).not.toBe(200);
    // A page without a recipe has nothing to repair.
    const fresh = observation("/fresh", redesigned.candidates);
    expect(
      (
        await repair(device, fresh, {
          recipeId: await generatedRecipeId(ORIGIN, "/fresh"),
          revision: 1,
        })
      ).body,
    ).toMatchObject({ reason: "recipe-conflict" });
    await writeRecipe(
      env.DB,
      device.ownerId,
      change.recipeId,
      { version: 1, expectedRevision: 2, state: "revoked" },
      null,
    );
    expect(
      (await repair(device, redesigned, { recipeId: change.recipeId, revision: 2 })).body,
    ).toMatchObject({ reason: "recipe-revoked" });
    expect(state.sent).toHaveLength(calls);
    expect(await rows("SELECT * FROM recipe_repairs WHERE owner_id = ?", device.ownerId)).toEqual(
      [],
    );
  });
}
