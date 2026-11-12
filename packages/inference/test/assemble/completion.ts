import { extendsRecipe, type LoginTarget } from "@pateat/contracts";
import { expect, it } from "vitest";
import { addCompletion } from "../../src/assemble";
import type { CompletionContext } from "./context";

export function registerCompletionCases({
  origin,
  target,
  candidate,
  recipe,
  home,
}: CompletionContext) {
  it("adds a marker without a path, then later ones up to four (ADR 0029)", () => {
    const learned = addCompletion(recipe, home, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe).toMatchObject({
      revision: 2,
      completion: [{ target: target("logout") }],
    });
    expect(addCompletion(learned.recipe, home, target("logout"))).toEqual({
      ok: false,
      reason: "already-learned",
    });
    // Another signed-in page's marker comes after it, so a running login takes it over.
    const account = { origin, path: "/account", candidates: [candidate("me", target("me"))] };
    const second = addCompletion(learned.recipe, account, target("me"));
    if (!second.ok) throw new Error(second.reason);
    expect(second.recipe).toMatchObject({
      revision: 3,
      completion: [{ target: target("logout") }, { target: target("me") }],
    });
    expect(extendsRecipe(learned.recipe, second.recipe)).toBe(true);
    let full = second.recipe;
    for (const value of ["c", "d"]) {
      const added = addCompletion(
        full,
        { origin, path: "/home", candidates: [candidate(value, target(value))] },
        target(value),
      );
      if (!added.ok) throw new Error(added.reason);
      full = added.recipe;
    }
    expect(full.completion).toHaveLength(4);
    expect(
      addCompletion(
        full,
        { origin, path: "/home", candidates: [candidate("e", target("e"))] },
        target("e"),
      ),
    ).toEqual({ ok: false, reason: "marker-limit" });
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

  it("stores the origin of another site the tab moved to after a second factor (ADR 0022)", () => {
    const other = { ...home, origin: "https://www.other.example" };
    const learned = addCompletion(recipe, other, target("logout"));
    expect(learned.ok && learned.recipe.completion).toEqual([
      { target: target("logout"), origin: "https://www.other.example" },
    ]);
    expect(
      addCompletion(recipe, { ...other, origin: "http://www.other.example" }, target("logout")),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("stores the origin of another origin of the site the tab moved to (ADR 0022)", () => {
    const www = "https://www.bank.example";
    // The recipe's own `/login` is not that origin's path, so nothing is needed absent.
    const moved = { ...home, origin: www, path: "/login" };
    const learned = addCompletion(recipe, moved, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe.completion).toEqual([{ target: target("logout"), origin: www }]);
    expect(addCompletion(learned.recipe, moved, target("logout"))).toEqual({
      ok: false,
      reason: "already-learned",
    });
    // The same element on the recipe's own origin is a marker of its own.
    const own = addCompletion(learned.recipe, home, target("logout"));
    expect(own.ok && own.recipe.completion).toEqual([
      { target: target("logout"), origin: www },
      { target: target("logout") },
    ]);
    // A field a step fills still shows a login page there.
    expect(
      addCompletion(
        recipe,
        { ...moved, candidates: [...moved.candidates, candidate("u", target("username"), "text")] },
        target("logout"),
      ),
    ).toEqual({ ok: false, reason: "login-page" });
    expect(
      addCompletion(recipe, { ...moved, origin: "http://www.bank.example" }, target("logout")),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("stores a link located by its path as a marker (ADR 0029)", () => {
    const link = { by: "href", value: "/my" } as const;
    const shown = {
      origin,
      path: "/home",
      candidates: [{ id: "my", role: "link" as const, target: link, label: "Nick" }],
    };
    const learned = addCompletion(recipe, shown, link);
    expect(learned.ok && learned.recipe.completion).toEqual([{ target: link }]);
  });

  it("refuses a step's own fill, click or text target on any path", () => {
    const at = (path: string, marker: LoginTarget) =>
      addCompletion(recipe, { origin, path, candidates: [candidate("m", marker)] }, marker);
    // On a step's own path, the page is the login's own before the marker is looked at.
    expect(at("/login", target("username"))).toEqual({ ok: false, reason: "login-page" });
    expect(at("/login", target("username-next"))).toEqual({ ok: false, reason: "login-page" });
    expect(at("/pw", { by: "text", value: "Sign in" })).toEqual({
      ok: false,
      reason: "login-page",
    });
    // A marker proves a sign-in wherever it shows, the step's own page included.
    expect(at("/home", target("username-next"))).toEqual({ ok: false, reason: "step-target" });
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
    // A site that signs in in place keeps the path but no longer shows the form. The
    // executor must then also find that path's field missing.
    const inPlace = { origin, path: "/login", candidates: [candidate("out", target("logout"))] };
    const learned = addCompletion(recipe, inPlace, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe.completion).toEqual([
      { target: target("logout"), absent: [target("username")] },
    ]);
    // A completion on a path without steps needs nothing else.
    const elsewhere = addCompletion(
      recipe,
      { origin, path: "/home", candidates: inPlace.candidates },
      target("logout"),
    );
    expect(elsewhere.ok && elsewhere.recipe.completion).toEqual([{ target: target("logout") }]);
  });
}
