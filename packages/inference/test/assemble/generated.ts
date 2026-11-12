import { continuesRecipe, extendsRecipe } from "@pateat/contracts";
import { expect, it } from "vitest";
import { appendPageSteps } from "../../src/assemble";
import type { GeneratedContext } from "./context";

export function registerGeneratedCases({ origin, target, page, built }: GeneratedContext) {
  it("starts a recipe from the first page and appends a later page after an advance", () => {
    const first = built(page("/login", "username", "advance"));
    expect(first).toMatchObject({ id: "gen-1", revision: 1, slots: ["username"] });
    expect(first.maxSubmissions).toBe(1);
    expect(first.completion).toBeUndefined();

    const second = appendPageSteps(first, {
      pageKind: "sign-in",
      id: "ignored",
      origin,
      steps: page("/password", "password", "submit"),
    });
    if (!second.ok) throw new Error(second.reason);
    expect(second.recipe).toMatchObject({
      id: "gen-1",
      revision: 2,
      slots: ["username", "password"],
      maxSubmissions: 2,
    });
    expect(second.recipe.steps).toHaveLength(4);
    // A login running the first revision at its final advance can take this one over.
    expect(continuesRecipe(first, second.recipe)).toBe(true);
    expect(extendsRecipe(first, second.recipe)).toBe(false);
  });

  it("stores the first page's kind and keeps it for a continuation (ADR 0035)", () => {
    const first = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: page("/verify", "username", "advance"),
      pageKind: "confirm",
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.recipe.pageKind).toBe("confirm");
    const next = appendPageSteps(first.recipe, {
      id: "gen-1",
      origin,
      steps: page("/password", "password", "submit"),
      pageKind: "sign-in",
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.pageKind).toBe("confirm");
    expect(continuesRecipe(first.recipe, next.recipe)).toBe(true);
  });

  it("takes slots from the steps and keeps the base's other fields", () => {
    const first = { ...built(page("/login", "username", "advance")), rejection: target("error") };
    const next = appendPageSteps(first, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.slots).toEqual(["username", "pw"]);
    expect(next.recipe.rejection).toEqual(target("error"));
  });

  it("keeps the first account switch that no step clicks", () => {
    const other = { by: "text", value: "Use another account" } as const;
    const first = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/login", "username", "advance"),
      accountSwitch: other,
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.recipe.accountSwitch).toEqual(other);
    const next = appendPageSteps(first.recipe, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
      accountSwitch: target("elsewhere"),
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.accountSwitch).toEqual(other);
    // A switch that a step also clicks is left out rather than failing the recipe.
    const clicked = appendPageSteps(first.recipe, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: [
        {
          kind: "fill",
          path: "/pw",
          effect: "prepare",
          fields: [{ slot: "pw", target: target("pw") }],
        },
        { kind: "click", path: "/pw", target: other, purpose: "submit" },
      ],
      accountSwitch: target("switch"),
    });
    if (!clicked.ok) throw new Error(clicked.reason);
    expect(clicked.recipe.accountSwitch).toEqual(target("switch"));
  });

  it("refuses to append after a submit, to a learned recipe, across origins or past bounds", () => {
    const submitted = built(page("/login", "password", "submit"));
    const next = {
      id: "gen-1",
      origin,
      steps: page("/otp", "otp", "submit"),
      pageKind: "sign-in" as const,
    };
    expect(appendPageSteps(submitted, next)).toEqual({ ok: false, reason: "not-advancing" });
    const advancing = built(page("/login", "username", "advance"));
    const learned = { ...advancing, completion: [{ target: target("x") }] };
    expect(appendPageSteps(learned, next)).toEqual({ ok: false, reason: "already-complete" });
    expect(appendPageSteps(advancing, { ...next, origin: "https://other.example" })).toEqual({
      ok: false,
      reason: "origin-mismatch",
    });
    // The identifier form shown again where it posted is not the next page.
    expect(
      appendPageSteps(advancing, {
        ...next,
        steps: page("/login/identifier", "username", "advance"),
      }),
    ).toEqual({ ok: false, reason: "slot-refilled" });
    expect(appendPageSteps(advancing, { ...next, steps: [] })).toEqual({
      ok: true,
      recipe: expect.objectContaining({ revision: 2 }),
    });

    let recipe = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/p0", "s0", "advance"),
    });
    for (let index = 1; recipe.ok && index < 9; index += 1)
      recipe = appendPageSteps(recipe.recipe, {
        pageKind: "sign-in",
        id: "gen-1",
        origin,
        steps: page(`/p${index}`, `s${index}`, "advance"),
      });
    // A ninth effect exceeds the contract's eight submissions.
    expect(recipe).toEqual({ ok: false, reason: "invalid-recipe" });
  });
}
