import { extendsRecipe } from "@pateat/contracts";
import { expect, it } from "vitest";
import { addCompletion, addHandler } from "../../src/assemble";
import type { AuthenticatorHandlerContext } from "./context";

export function registerAuthenticatorHandlerCases({
  origin,
  target,
  candidate,
  recipe,
  app,
  chooser,
  authenticator,
}: AuthenticatorHandlerContext) {
  it("adds a handler for the page's button after a recipe that types the password", () => {
    const added = addHandler(recipe, chooser(), authenticator());
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe).toEqual({
      ...recipe,
      revision: recipe.revision + 1,
      handlers: [{ kind: "authenticator", path: "/login", target: app }],
    });
    expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    // The code page that follows on the same path adds its own `totp` handler beside it.
    const code = target("digit-1");
    const codePage = {
      origin,
      path: "/login",
      candidates: [
        {
          ...candidate("code", code, "text"),
          autocomplete: "one-time-code" as const,
          inputMode: "numeric" as const,
          maxLength: 6,
        },
        { ...candidate("continue", target("continue")), label: "Continue" },
      ],
    };
    const both = addHandler(added.recipe, codePage, {
      kind: "totp",
      field: code,
      target: target("continue"),
    });
    if (!both.ok) throw new Error(both.reason);
    expect(both.recipe.handlers?.map((handler) => handler.kind)).toEqual(["authenticator", "totp"]);
    expect(addHandler(added.recipe, chooser(), authenticator())).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it.each([
    ["Text me a code", "a text message"],
    ["Use backup code", "a backup code"],
    ["Approve a request on my authenticator app", "a push approval"],
    ["Use a security key or built-in authenticator", "a passkey"],
    ["Set up an authenticator app", "another task"],
    ["別の方法を試す", "another way"],
  ])("refuses a button labelled %s (%s)", (label) => {
    const labelled = { ...chooser(), candidates: [{ ...candidate("app", app), label }] };
    expect(addHandler(recipe, labelled, authenticator())).toEqual({
      ok: false,
      reason: "not-authenticator",
    });
  });

  it("checks the text locator too, needs a label or a text locator, and takes no link", () => {
    const sms = { by: "text", value: "Text me a code" } as const;
    expect(addHandler(recipe, chooser(), authenticator(sms))).toEqual({
      ok: false,
      reason: "not-authenticator",
    });
    const unnamed = { ...chooser(), candidates: [candidate("app", target("app"))] };
    expect(addHandler(recipe, unnamed, authenticator(target("app")))).toEqual({
      ok: false,
      reason: "not-authenticator",
    });
    const link = {
      ...chooser(),
      candidates: [{ ...candidate("app", app, "link"), label: app.value }],
    };
    expect(addHandler(recipe, link, authenticator())).toEqual({
      ok: false,
      reason: "not-on-page",
    });
  });

  it("refuses a route step's button", () => {
    const login = target("password-next");
    const routed = {
      ...chooser(),
      candidates: [{ ...candidate("app", login), label: "Authenticator app" }],
    };
    expect(addHandler(recipe, routed, authenticator(login))).toEqual({
      ok: false,
      reason: "step-target",
    });
  });

  it("is never learned as a signed-in marker, which the extension may not find again", () => {
    // The extension names a `role="button"` choice by its text on a judged page; a
    // marker's lookup takes links, never such a widget (ADR 0081 amendment of 2026-11-03).
    expect(addCompletion(recipe, { ...chooser(), path: "/home" }, app)).toEqual({
      ok: false,
      reason: "sign-in-choice",
    });
    const sms = { by: "text", value: "Text me a code" } as const;
    expect(addCompletion(recipe, { ...chooser(), path: "/home" }, sms).ok).toBe(true);
    // A text button of a page that shows a code input, which may be a widget too.
    const codePage = {
      origin,
      path: "/home",
      candidates: [
        // A code input by its numeric hint and length, which a signed-in answer reaches.
        {
          ...candidate("code", target("code"), "text"),
          inputMode: "numeric" as const,
          maxLength: 6,
        },
        candidate("continue", { by: "text", value: "Continue" }),
        candidate("help", target("help"), "link"),
      ],
    };
    expect(addCompletion(recipe, codePage, { by: "text", value: "Continue" })).toEqual({
      ok: false,
      reason: "sign-in-choice",
    });
    expect(addCompletion(recipe, codePage, target("help")).ok).toBe(true);
    // A page that still shows the login's own button is a login page first.
    const login = { ...chooser(candidate("next", target("password-next"))), path: "/login" };
    expect(addCompletion(recipe, login, app)).toEqual({ ok: false, reason: "login-page" });
  });
}
