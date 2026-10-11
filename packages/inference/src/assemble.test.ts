import type { LoginStep } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { addCompletion, appendPageSteps } from "./assemble";

const origin = "https://bank.example";
const id = { by: "id" as const, value: "" };
const target = (value: string) => ({ ...id, value });
const page = (path: string, slot: string, purpose: "advance" | "submit"): LoginStep[] => [
  { kind: "fill", path, effect: "prepare", fields: [{ slot, target: target(slot) }] },
  { kind: "click", path, target: target(`${slot}-next`), purpose },
];

describe("generated recipe assembly", () => {
  it("starts a recipe from the first page and appends a later page after an advance", () => {
    const first = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      slots: ["username"],
      steps: page("/login", "username", "advance"),
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.recipe).toMatchObject({ id: "gen-1", revision: 1, maxSubmissions: 1 });
    expect(first.recipe.completion).toBeUndefined();

    const second = appendPageSteps(first.recipe, {
      id: "ignored",
      origin,
      slots: ["username", "password"],
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
  });

  it("refuses to append after a submit, to a learned recipe, across origins or past bounds", () => {
    const submitted = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      slots: ["password"],
      steps: page("/login", "password", "submit"),
    });
    if (!submitted.ok) throw new Error(submitted.reason);
    const next = { id: "gen-1", origin, slots: ["otp"], steps: page("/otp", "otp", "submit") };
    expect(appendPageSteps(submitted.recipe, next)).toEqual({ ok: false, reason: "not-advancing" });
    expect(
      appendPageSteps({ ...submitted.recipe, completion: { path: "/home", target: target("x") } }, next),
    ).toEqual({ ok: false, reason: "already-complete" });
    expect(
      appendPageSteps(submitted.recipe, { ...next, origin: "https://other.example" }),
    ).toEqual({ ok: false, reason: "origin-mismatch" });

    let recipe = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      slots: ["s0"],
      steps: page("/p0", "s0", "advance"),
    });
    for (let index = 1; recipe.ok && index < 9; index += 1)
      recipe = appendPageSteps(recipe.recipe, {
        id: "gen-1",
        origin,
        slots: [`s${index}`],
        steps: page(`/p${index}`, `s${index}`, "advance"),
      });
    // A ninth effect exceeds the contract's eight submissions.
    expect(recipe).toEqual({ ok: false, reason: "too-long" });
  });

  it("adds a judged completion once and never one of the recipe's own targets", () => {
    const built = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      slots: ["password"],
      steps: page("/login", "password", "submit"),
    });
    if (!built.ok) throw new Error(built.reason);
    const learned = addCompletion(built.recipe, { path: "/home", target: target("logout") });
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe).toMatchObject({
      revision: 2,
      completion: { path: "/home", target: target("logout") },
    });
    expect(addCompletion(learned.recipe, { path: "/home", target: target("menu") })).toEqual({
      ok: false,
      reason: "already-complete",
    });
    expect(
      addCompletion(built.recipe, { path: "/login", target: target("password-next") }),
    ).toEqual({ ok: false, reason: "step-target" });
  });
});
