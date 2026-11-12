import { extendsRecipe, type LoginRecipe, type LoginTarget } from "@pateat/contracts";
import { expect, it } from "vitest";
import { addCompletion, addHandler } from "../../src/assemble";
import type { PasskeyHandlerContext } from "./context";

export function registerPasskeyHandlerCases({
  origin,
  target,
  candidate,
  recipe,
  securityKey,
  webauthn,
  passkey,
}: PasskeyHandlerContext) {
  it("adds a handler for the page's button in the next revision, which extends the recipe", () => {
    const added = addHandler(recipe, webauthn(), passkey());
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe).toEqual({
      ...recipe,
      revision: recipe.revision + 1,
      handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
    });
    expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    // Another path gets its own handler, appended after the first.
    const other = { ...webauthn(), path: "/mfa" };
    const second = addHandler(added.recipe, other, passkey());
    if (!second.ok) throw new Error(second.reason);
    expect(second.recipe.handlers).toEqual([
      ...added.recipe.handlers!,
      { kind: "passkey", path: "/mfa", target: securityKey },
    ]);
    expect(extendsRecipe(added.recipe, second.recipe)).toBe(true);
  });

  it("adds a handler to a recipe with a completion, and on a route path", () => {
    const home = { origin, path: "/home", candidates: [candidate("logout", target("logout"))] };
    const learned = addCompletion(recipe, home, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    const added = addHandler(learned.recipe, webauthn(), passkey());
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.completion).toEqual(learned.recipe.completion);
    expect(extendsRecipe(learned.recipe, added.recipe)).toBe(true);
    // A second-factor form that stays on the sign-in path still gets a handler.
    const onRoute = addHandler(recipe, { ...webauthn(), path: "/pw" }, passkey());
    if (!onRoute.ok) throw new Error(onRoute.reason);
    expect(onRoute.recipe.handlers).toEqual([
      { kind: "passkey", path: "/pw", target: securityKey },
    ]);
    expect(onRoute.recipe.steps).toEqual(recipe.steps);
  });

  it("keeps a button whose label names no passkey, as a FIDO page's Verify", () => {
    // Oracle Cloud's FIDO page starts its WebAuthn call from "Verify" (2026-10-13); the
    // judge decides what the button does, and no passkey word is required.
    const verify = { by: "text", value: "Verify" } as const;
    const added = addHandler(
      recipe,
      { origin, path: "/ui/v1/signin", candidates: [candidate("verify", verify)] },
      passkey(verify),
    );
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "passkey", path: "/ui/v1/signin", target: verify },
    ]);
  });

  it("refuses a link or an element the page does not show", () => {
    const link = { by: "text", value: "Use a security key" } as const;
    expect(addHandler(recipe, webauthn(candidate("link", link, "link")), passkey(link))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
    expect(addHandler(recipe, webauthn(), passkey(target("missing")))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
  });

  it.each([
    ["Add a passkey", { by: "text", value: "Add a passkey" }, undefined],
    ["Set up security key", { by: "text", value: "Set up security key" }, undefined],
    ["Register a security key", { by: "text", value: "Register a security key" }, undefined],
    ["パスキーを登録", { by: "text", value: "パスキーを登録" }, undefined],
    ["a labelled registration button", target("passkey"), "Create a passkey"],
    ["an id that adds a passkey", { by: "id", value: "add-passkey" }, undefined],
    ["a name that registers a key", { by: "name", value: "register_key" }, undefined],
    ["a test ID that sets up a key", { by: "test-id", value: "setUpSecurityKey" }, undefined],
  ])("refuses a button that registers a passkey: %s", (_label, locator, label) => {
    const button = {
      ...candidate("register", locator as LoginTarget),
      ...(label ? { label } : {}),
    };
    expect(addHandler(recipe, webauthn(button), passkey(locator as LoginTarget))).toEqual({
      ok: false,
      reason: "registration",
    });
  });

  it("refuses a step's button on that path, the account switch, rejection and marker", () => {
    const signIn = { by: "text", value: "Sign in" } as const;
    expect(
      addHandler(recipe, { ...webauthn(candidate("in", signIn)), path: "/pw" }, passkey(signIn)),
    ).toEqual({ ok: false, reason: "step-target" });
    // The same button on another path is not one of that path's steps.
    expect(addHandler(recipe, webauthn(candidate("in", signIn)), passkey(signIn)).ok).toBe(true);
    const switchTarget = { by: "text", value: "Use another account" } as const;
    const extended: LoginRecipe = {
      ...recipe,
      accountSwitch: switchTarget,
      rejection: target("error"),
      completion: [{ target: target("account") }],
    };
    for (const locator of [switchTarget, target("error"), target("account")])
      expect(addHandler(extended, webauthn(candidate("x", locator)), passkey(locator))).toEqual({
        ok: false,
        reason: "step-target",
      });
  });

  it("refuses a second passkey handler on the same path", () => {
    const added = addHandler(recipe, webauthn(), passkey());
    if (!added.ok) throw new Error(added.reason);
    const other = target("other-key");
    expect(addHandler(added.recipe, webauthn(candidate("other", other)), passkey(other))).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("refuses another origin and a recipe past the handler bound", () => {
    expect(
      addHandler(recipe, { ...webauthn(), origin: "https://www.bank.example" }, passkey()),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
    const full: LoginRecipe = {
      ...recipe,
      handlers: Array.from({ length: 16 }, (_, index) => ({
        kind: "passkey",
        path: `/factor-${index}`,
        target: securityKey,
      })),
    };
    expect(addHandler(full, webauthn(), passkey())).toEqual({
      ok: false,
      reason: "invalid-recipe",
    });
  });

  it("keeps handlers when a completion is learned and refuses a handler's button as marker", () => {
    const added = addHandler(recipe, webauthn(candidate("logout", target("logout"))), passkey());
    if (!added.ok) throw new Error(added.reason);
    expect(
      addCompletion(added.recipe, webauthn(candidate("logout", target("logout"))), securityKey),
    ).toEqual({ ok: false, reason: "login-page" });
    // Nor anywhere else: the button is the handler's.
    expect(
      addCompletion(
        added.recipe,
        { origin, path: "/home", candidates: [candidate("key", securityKey)] },
        securityKey,
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    const home = { origin, path: "/home", candidates: [candidate("logout", target("logout"))] };
    const learned = addCompletion(added.recipe, home, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe.handlers).toEqual(added.recipe.handlers);
    expect(extendsRecipe(added.recipe, learned.recipe)).toBe(true);
  });
}
