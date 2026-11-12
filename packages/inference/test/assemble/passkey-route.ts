import { extendsRecipe } from "@pateat/contracts";
import { expect, it } from "vitest";
import { addCompletion, addHandler, appendPageSteps } from "../../src/assemble";
import type { PasskeyRouteContext } from "./context";

export function registerPasskeyRouteCases({
  origin,
  target,
  page,
  candidate,
  built,
  button,
  signIn,
  withPasskey,
}: PasskeyRouteContext) {
  it("stores the start page's passkey button as the passkey route on a first page", () => {
    expect(withPasskey()).toEqual({
      ...built(signIn),
      passkey: { path: "/login", target: button },
    });
  });

  it("refuses a passkey button on a continued page and keeps a recipe's own", () => {
    const first = page("/login", "username", "advance");
    const started = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: first,
      passkey: button,
    });
    if (!started.ok) throw new Error(started.reason);
    expect(
      appendPageSteps(started.recipe, {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: page("/pw", "pw", "submit"),
        passkey: button,
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    const continued = appendPageSteps(started.recipe, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
      // An account switch that is the passkey button is never kept.
      accountSwitch: button,
    });
    if (!continued.ok) throw new Error(continued.reason);
    expect(continued.recipe.passkey).toEqual({ path: "/login", target: button });
    expect(continued.recipe).not.toHaveProperty("accountSwitch");
  });

  it("learns no marker on the passkey button or a start page that still shows it", () => {
    const recipe = withPasskey();
    const login = (...candidates: ReturnType<typeof candidate>[]) => ({
      origin,
      path: "/login",
      candidates: [candidate("passkey", button), ...candidates],
    });
    expect(addCompletion(recipe, login(), button)).toEqual({ ok: false, reason: "login-page" });
    expect(
      addCompletion(recipe, login(candidate("logout", target("logout"))), target("logout")),
    ).toEqual({ ok: false, reason: "login-page" });
    // A marker proves a sign-in on any path, so the button is none elsewhere either.
    const home = { origin, path: "/home", candidates: [candidate("passkey", button)] };
    expect(addCompletion(recipe, home, button)).toEqual({ ok: false, reason: "step-target" });
  });

  it("adds no handler on the passkey button on the start page", () => {
    const recipe = withPasskey();
    const login = { origin, path: "/login", candidates: [candidate("passkey", button)] };
    expect(addHandler(recipe, login, { kind: "passkey", target: button })).toEqual({
      ok: false,
      reason: "step-target",
    });
    const elsewhere = addHandler(
      recipe,
      { ...login, path: "/login/webauthn" },
      { kind: "passkey", target: button },
    );
    if (!elsewhere.ok) throw new Error(elsewhere.reason);
    expect(extendsRecipe(recipe, elsewhere.recipe)).toBe(true);
  });
}
