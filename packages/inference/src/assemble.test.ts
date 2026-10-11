import type {
  LoginAttributeTarget,
  LoginStep,
  LoginTarget,
  ObservedCandidate,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { addCompletion, appendPageSteps } from "./assemble";

const origin = "https://bank.example";
const target = (value: string): LoginAttributeTarget => ({ by: "id", value });
const page = (path: string, slot: string, purpose: "advance" | "submit"): LoginStep[] => [
  { kind: "fill", path, effect: "prepare", fields: [{ slot, target: target(slot) }] },
  { kind: "click", path, target: target(`${slot}-next`), purpose },
];
const candidate = (
  id: string,
  locator: LoginTarget,
  role: ObservedCandidate["role"] = "button",
) => ({
  id,
  role,
  target: locator,
});

function built(steps: LoginStep[]) {
  const result = appendPageSteps(undefined, { id: "gen-1", origin, steps });
  if (!result.ok) throw new Error(result.reason);
  return result.recipe;
}

describe("generated recipe assembly", () => {
  it("starts a recipe from the first page and appends a later page after an advance", () => {
    const first = built(page("/login", "username", "advance"));
    expect(first).toMatchObject({ id: "gen-1", revision: 1, slots: ["username"] });
    expect(first.maxSubmissions).toBe(1);
    expect(first.completion).toBeUndefined();

    const second = appendPageSteps(first, {
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
  });

  it("takes slots from the steps and keeps the base's other fields", () => {
    const first = { ...built(page("/login", "username", "advance")), rejection: target("error") };
    const next = appendPageSteps(first, {
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.slots).toEqual(["username", "pw"]);
    expect(next.recipe.rejection).toEqual(target("error"));
  });

  it("refuses to append after a submit, to a learned recipe, across origins or past bounds", () => {
    const submitted = built(page("/login", "password", "submit"));
    const next = { id: "gen-1", origin, steps: page("/otp", "otp", "submit") };
    expect(appendPageSteps(submitted, next)).toEqual({ ok: false, reason: "not-advancing" });
    const advancing = built(page("/login", "username", "advance"));
    const learned = { ...advancing, completion: { path: "/home", target: target("x") } };
    expect(appendPageSteps(learned, next)).toEqual({ ok: false, reason: "already-complete" });
    expect(appendPageSteps(advancing, { ...next, origin: "https://other.example" })).toEqual({
      ok: false,
      reason: "origin-mismatch",
    });
    expect(appendPageSteps(advancing, { ...next, steps: [] })).toEqual({
      ok: true,
      recipe: expect.objectContaining({ revision: 2 }),
    });

    let recipe = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: page("/p0", "s0", "advance"),
    });
    for (let index = 1; recipe.ok && index < 9; index += 1)
      recipe = appendPageSteps(recipe.recipe, {
        id: "gen-1",
        origin,
        steps: page(`/p${index}`, `s${index}`, "advance"),
      });
    // A ninth effect exceeds the contract's eight submissions.
    expect(recipe).toEqual({ ok: false, reason: "invalid-recipe" });
  });
});

describe("judged completion", () => {
  const recipe = built([
    ...page("/login", "username", "advance"),
    {
      kind: "fill",
      path: "/pw",
      effect: "prepare",
      fields: [{ slot: "pw", target: target("pw") }],
    },
    { kind: "click", path: "/pw", target: { by: "text", value: "Sign in" }, purpose: "submit" },
  ]);
  const home = { origin, path: "/home", candidates: [candidate("logout", target("logout"))] };

  it("adds a completion once, at the judged page's path", () => {
    const learned = addCompletion(recipe, home, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe).toMatchObject({
      revision: 2,
      completion: { path: "/home", target: target("logout") },
    });
    expect(addCompletion(learned.recipe, home, target("logout"))).toEqual({
      ok: false,
      reason: "already-complete",
    });
  });

  it("refuses a marker that is not on the judged page", () => {
    expect(addCompletion(recipe, home, target("account"))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
  });

  it("refuses a page elsewhere that still shows a field a step fills", () => {
    // The form at /login posts to /session, which shows it again after a failure.
    const reposted = {
      origin,
      path: "/session",
      candidates: [
        candidate("help", target("help")),
        candidate("user", target("username"), "text"),
      ],
    };
    expect(addCompletion(recipe, reposted, target("help"))).toEqual({
      ok: false,
      reason: "login-page",
    });
    // A step's button elsewhere does not make a page a login page.
    const next = {
      origin,
      path: "/home",
      candidates: [candidate("out", target("logout")), candidate("n", target("username-next"))],
    };
    expect(addCompletion(recipe, next, target("logout")).ok).toBe(true);
  });

  it("refuses another origin", () => {
    expect(
      addCompletion(recipe, { ...home, origin: "https://www.bank.example" }, target("logout")),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("refuses a step's own fill, click or text target on the same path, not on another", () => {
    const at = (path: string, marker: LoginTarget) =>
      addCompletion(recipe, { origin, path, candidates: [candidate("m", marker)] }, marker);
    expect(at("/login", target("username"))).toEqual({ ok: false, reason: "step-target" });
    expect(at("/login", target("username-next"))).toEqual({ ok: false, reason: "step-target" });
    expect(at("/pw", { by: "text", value: "Sign in" })).toEqual({
      ok: false,
      reason: "step-target",
    });
    expect(at("/home", target("username-next")).ok).toBe(true);
  });

  it("refuses a step path that still shows the login form, allows it once the form is gone", () => {
    // A failed sign-in back on /login shows the username field next to a Help link.
    const returned = {
      origin,
      path: "/login",
      candidates: [
        candidate("help", target("help")),
        candidate("user", target("username"), "text"),
      ],
    };
    expect(addCompletion(recipe, returned, target("help"))).toEqual({
      ok: false,
      reason: "login-page",
    });
    // A site that signs in in place keeps the path but no longer shows the form.
    const inPlace = { origin, path: "/login", candidates: [candidate("out", target("logout"))] };
    expect(addCompletion(recipe, inPlace, target("logout")).ok).toBe(true);
  });
});
