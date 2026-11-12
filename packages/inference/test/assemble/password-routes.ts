import { extendsRecipe } from "@pateat/contracts";
import { expect, it } from "vitest";
import { addCompletion, addHandler, appendPageSteps } from "../../src/assemble";
import type { PasswordRoutesContext } from "./context";

export function registerPasswordRoutesCases({
  origin,
  target,
  page,
  built,
  set,
  varied,
  shown,
}: PasswordRoutesContext) {
  it("starts a recipe whose alternatives are the page's other identifier sets", () => {
    const recipe = varied();
    expect(recipe).toMatchObject({
      revision: 1,
      slots: ["branch-number", "account-number", "password"],
      alternatives: [
        { slots: ["contract-number", "password"], steps: set(["contract-number", "password"]) },
      ],
      maxSubmissions: 1,
    });
    // An account switch that a variant clicks is not kept.
    const switched = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: set(["branch-number", "password"]),
      alternatives: [set(["contract-number", "password"], "contract-login")],
      accountSwitch: target("contract-login"),
    });
    expect(switched.ok && switched.recipe.accountSwitch).toBeUndefined();
  });

  it("sizes the submission budget for the variant with the most effects", () => {
    const result = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: set(["branch-number", "password"]),
      alternatives: [
        [
          ...page("/login", "contract-number", "advance"),
          ...page("/password", "pin-code", "submit"),
        ],
      ],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.recipe.maxSubmissions).toBe(2);
    expect(result.recipe.alternatives).toMatchObject([{ slots: ["contract-number", "pin-code"] }]);
  });

  it("continues only a single-variant recipe with a single-variant page", () => {
    // A recipe with variants submits in every one, so no later page belongs to it.
    expect(
      appendPageSteps(varied(), {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: page("/next", "pin", "submit"),
      }),
    ).toEqual({ ok: false, reason: "not-advancing" });
    expect(
      appendPageSteps(built(page("/login", "username", "advance")), {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: page("/password", "password", "submit"),
        alternatives: [page("/password", "pin", "submit")],
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    // Alternatives that advance or repeat a set break the recipe contract.
    expect(
      appendPageSteps(undefined, {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: set(["branch-number", "password"]),
        alternatives: [page("/login", "contract-number", "advance")],
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    expect(
      appendPageSteps(undefined, {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: set(["branch-number", "password"]),
        alternatives: [set(["password"])],
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
  });

  it("learns a completion only away from every variant's elements", () => {
    const recipe = varied();
    // An alternative's field still shown is a sign-in page, whichever variant ran.
    expect(addCompletion(recipe, shown("welcome", "contract-number"), target("welcome"))).toEqual({
      ok: false,
      reason: "login-page",
    });
    expect(addCompletion(recipe, shown("contract-number"), target("contract-number"))).toEqual({
      ok: false,
      reason: "login-page",
    });
    // On the start path, the completion lists every variant's fill fields as absent.
    const learned = addCompletion(recipe, shown("welcome"), target("welcome"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe.completion).toEqual([
      {
        target: target("welcome"),
        absent: ["branch-number", "account-number", "password", "contract-number"].map(target),
      },
    ]);
    expect(extendsRecipe(recipe, learned.recipe)).toBe(true);
    // More than 4 such fields cannot be listed, so nothing is learned there.
    const wide = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: set(["branch-number", "account-number", "password"]),
      alternatives: [set(["contract-number", "pin-code"])],
    });
    if (!wide.ok) throw new Error(wide.reason);
    expect(addCompletion(wide.recipe, shown("welcome"), target("welcome"))).toEqual({
      ok: false,
      reason: "invalid-recipe",
    });
  });

  it("refuses a handler on an alternative's element and keeps the alternatives", () => {
    const recipe = varied();
    expect(
      addHandler(recipe, shown("contract-number"), {
        kind: "passkey",
        target: target("contract-number"),
      }),
    ).toEqual({
      ok: false,
      reason: "step-target",
    });
    const added = addHandler(recipe, shown("security-key"), {
      kind: "passkey",
      target: target("security-key"),
    });
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.alternatives).toEqual(recipe.alternatives);
  });
}
