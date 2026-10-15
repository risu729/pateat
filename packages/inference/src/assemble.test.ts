import {
  continuesRecipe,
  extendsRecipe,
  type LoginAttributeTarget,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
  type ObservedCandidate,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { addCompletion, addHandler, appendPageSteps } from "./assemble";

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
    // A login running the first revision at its final advance can take this one over.
    expect(continuesRecipe(first, second.recipe)).toBe(true);
    expect(extendsRecipe(first, second.recipe)).toBe(false);
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

  it("stores the first page's kind, which a continuation keeps (ADR 0035)", () => {
    const first = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: page("/login", "username", "advance"),
      pageKind: "unclear",
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.recipe.pageKind).toBe("unclear");
    const next = appendPageSteps(first.recipe, {
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
      pageKind: "sign-in",
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.pageKind).toBe("unclear");
    expect(continuesRecipe(first.recipe, next.recipe)).toBe(true);
    // A recipe stored before page kinds stays without one.
    const old = appendPageSteps(built(page("/login", "username", "advance")), {
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
      pageKind: "confirm",
    });
    if (!old.ok) throw new Error(old.reason);
    expect(old.recipe.pageKind).toBeUndefined();
  });

  it("keeps the first account switch that no step clicks", () => {
    const other = { by: "text", value: "Use another account" } as const;
    const first = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: page("/login", "username", "advance"),
      accountSwitch: other,
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.recipe.accountSwitch).toEqual(other);
    const next = appendPageSteps(first.recipe, {
      id: "gen-1",
      origin,
      steps: page("/pw", "pw", "submit"),
      accountSwitch: target("elsewhere"),
    });
    if (!next.ok) throw new Error(next.reason);
    expect(next.recipe.accountSwitch).toEqual(other);
    // A switch that a step also clicks is left out rather than failing the recipe.
    const clicked = appendPageSteps(first.recipe, {
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
    const next = { id: "gen-1", origin, steps: page("/otp", "otp", "submit") };
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
    expect(at("/login", target("username"))).toEqual({ ok: false, reason: "step-target" });
    expect(at("/login", target("username-next"))).toEqual({ ok: false, reason: "step-target" });
    expect(at("/pw", { by: "text", value: "Sign in" })).toEqual({
      ok: false,
      reason: "step-target",
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
});

describe("judged passkey handler (ADR 0027)", () => {
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
  const securityKey = { by: "text", value: "Use security key" } as const;
  const webauthn = (...candidates: ReturnType<typeof candidate>[]) => ({
    origin,
    path: "/login/webauthn",
    candidates: [candidate("key", securityKey), ...candidates],
  });
  const passkey = (locator: LoginTarget = securityKey) => ({
    kind: "passkey" as const,
    target: locator,
  });

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
    ).toEqual({ ok: false, reason: "step-target" });
    const home = { origin, path: "/home", candidates: [candidate("logout", target("logout"))] };
    const learned = addCompletion(added.recipe, home, target("logout"));
    if (!learned.ok) throw new Error(learned.reason);
    expect(learned.recipe.handlers).toEqual(added.recipe.handlers);
    expect(extendsRecipe(added.recipe, learned.recipe)).toBe(true);
  });
});

describe("judged totp handler (ADR 0027)", () => {
  const signIn = { by: "text", value: "Sign in" } as const;
  const recipe = built([
    ...page("/login", "username", "advance"),
    {
      kind: "fill",
      path: "/pw",
      effect: "prepare",
      fields: [{ slot: "pw", target: target("pw") }],
    },
    { kind: "click", path: "/pw", target: signIn, purpose: "submit" },
  ]);
  const verify = { by: "text", value: "Verify" } as const;
  const codeInput = (id = "otp", extra: Partial<Omit<ObservedCandidate, "target">> = {}) => ({
    ...candidate(id, target(id), "text"),
    autocomplete: "one-time-code" as const,
    ...extra,
  });
  const codePage = (path = "/two-factor", ...candidates: ReturnType<typeof candidate>[]) => ({
    origin,
    path,
    candidates: [codeInput(), candidate("verify", verify), ...candidates],
  });
  const totp = (field: LoginAttributeTarget = target("otp"), button: LoginTarget = verify) => ({
    kind: "totp" as const,
    field,
    target: button,
  });

  it("adds a handler for the code field and its button, which extends the recipe", () => {
    const added = addHandler(recipe, codePage(), totp());
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "totp", path: "/two-factor", field: target("otp"), target: verify },
    ]);
    expect(added.recipe.revision).toBe(recipe.revision + 1);
    expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    // A passkey handler on the same path is a handler of another kind.
    const key = { by: "text", value: "Use security key" } as const;
    const both = addHandler(added.recipe, codePage("/two-factor", candidate("key", key)), {
      kind: "passkey",
      target: key,
    });
    expect(both.ok && both.recipe.handlers?.map((handler) => handler.kind)).toEqual([
      "totp",
      "passkey",
    ]);
    expect(addHandler(added.recipe, codePage(), totp())).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("refuses a field that is not a code field or not an input of the page", () => {
    const plain = {
      origin,
      path: "/two-factor",
      candidates: [candidate("otp", target("otp"), "text"), candidate("verify", verify)],
    };
    expect(addHandler(recipe, plain, totp())).toEqual({ ok: false, reason: "not-code-field" });
    // The judge's checks hold here too: at least 6 characters, one code input per form,
    // and a button of its form.
    for (const refused of [
      {
        ...codePage(),
        candidates: [codeInput("otp", { maxLength: 1 }), candidate("verify", verify)],
      },
      codePage("/two-factor", codeInput("otp-2")),
      {
        ...codePage(),
        candidates: [codeInput("otp", { group: "code" }), candidate("verify", verify)],
      },
    ])
      expect(addHandler(recipe, refused, totp())).toEqual({ ok: false, reason: "not-code-field" });
    expect(addHandler(recipe, codePage(), totp(target("missing")))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
    expect(addHandler(recipe, codePage(), totp(target("otp"), target("missing")))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
  });

  it("accepts the first input of a code split into one input per digit, and no other", () => {
    const boxes = Array.from({ length: 6 }, (_, index) =>
      codeInput(`otp-${index + 1}`, { maxLength: 1 }),
    );
    const split = {
      origin,
      path: "/two-factor",
      candidates: [...boxes, candidate("verify", verify)],
    };
    const added = addHandler(recipe, split, totp(target("otp-1")));
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "totp", path: "/two-factor", field: target("otp-1"), target: verify },
    ]);
    expect(addHandler(recipe, split, totp(target("otp-2")))).toEqual({
      ok: false,
      reason: "not-code-field",
    });
    // Every input of the code is filled, so none may be a route step's element.
    const routed = {
      origin,
      path: "/pw",
      candidates: [
        ...boxes.slice(0, 5),
        codeInput("pw", { maxLength: 1 }),
        candidate("in", signIn),
      ],
    };
    expect(addHandler(recipe, routed, totp(target("otp-1"), signIn))).toEqual({
      ok: false,
      reason: "step-target",
    });
  });

  it("accepts the route's submit button on that path when the code field is new", () => {
    // A sign-in form that asks for the code after the password, with the same button.
    const sameForm = {
      origin,
      path: "/pw",
      candidates: [codeInput(), candidate("in", signIn)],
    };
    const added = addHandler(recipe, sameForm, totp(target("otp"), signIn));
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "totp", path: "/pw", field: target("otp"), target: signIn },
    ]);
    // A field the route fills is never the code field.
    const pw = { origin, path: "/pw", candidates: [codeInput("pw"), candidate("in", signIn)] };
    expect(addHandler(recipe, pw, totp(target("pw"), signIn))).toEqual({
      ok: false,
      reason: "step-target",
    });
  });

  it("refuses the account switch, rejection or marker as either element", () => {
    const extended: LoginRecipe = {
      ...recipe,
      accountSwitch: { by: "text", value: "Use another account" },
      rejection: target("error"),
      completion: [{ target: target("account") }],
    };
    expect(
      addHandler(
        extended,
        codePage("/two-factor", candidate("error", target("error"))),
        totp(target("otp"), target("error")),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    expect(
      addHandler(
        extended,
        {
          origin,
          path: "/two-factor",
          candidates: [codeInput("account"), candidate("verify", verify)],
        },
        totp(target("account")),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
  });
});

describe("password route variants in generated recipes (ADR 0027)", () => {
  const set = (slots: string[], button = "login"): LoginStep[] => [
    {
      kind: "fill",
      path: "/login",
      effect: "prepare",
      fields: slots.map((slot) => ({ slot, target: target(slot) })),
    },
    { kind: "click", path: "/login", target: target(button), purpose: "submit" },
  ];
  const varied = () => {
    const result = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: set(["branch-number", "account-number", "password"]),
      alternatives: [set(["contract-number", "password"])],
    });
    if (!result.ok) throw new Error(result.reason);
    return result.recipe;
  };
  const shown = (...ids: string[]) => ({
    origin,
    path: "/login",
    candidates: ids.map((id) => candidate(id, target(id))),
  });

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
      appendPageSteps(varied(), { id: "gen-1", origin, steps: page("/next", "pin", "submit") }),
    ).toEqual({ ok: false, reason: "not-advancing" });
    expect(
      appendPageSteps(built(page("/login", "username", "advance")), {
        id: "gen-1",
        origin,
        steps: page("/password", "password", "submit"),
        alternatives: [page("/password", "pin", "submit")],
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    // Alternatives that advance or repeat a set break the recipe contract.
    expect(
      appendPageSteps(undefined, {
        id: "gen-1",
        origin,
        steps: set(["branch-number", "password"]),
        alternatives: [page("/login", "contract-number", "advance")],
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    expect(
      appendPageSteps(undefined, {
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
      reason: "step-target",
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
});

describe("the passkey route in generated recipes (ADR 0027)", () => {
  const button = { by: "text", value: "Sign in with a passkey" } as const;
  const signIn = page("/login", "username", "submit");
  const withPasskey = () => {
    const result = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: signIn,
      passkey: button,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.recipe;
  };

  it("stores the start page's passkey button as the passkey route on a first page", () => {
    expect(withPasskey()).toEqual({
      ...built(signIn),
      passkey: { path: "/login", target: button },
    });
  });

  it("refuses a passkey button on a continued page and keeps a recipe's own", () => {
    const first = page("/login", "username", "advance");
    const started = appendPageSteps(undefined, {
      id: "gen-1",
      origin,
      steps: first,
      passkey: button,
    });
    if (!started.ok) throw new Error(started.reason);
    expect(
      appendPageSteps(started.recipe, {
        id: "gen-1",
        origin,
        steps: page("/pw", "pw", "submit"),
        passkey: button,
      }),
    ).toEqual({ ok: false, reason: "invalid-recipe" });
    const continued = appendPageSteps(started.recipe, {
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
    expect(addCompletion(recipe, login(), button)).toEqual({ ok: false, reason: "step-target" });
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
});

describe("totp handler assembly, probed independently (ADR 0027)", () => {
  const signIn = { by: "text", value: "Sign in" } as const;
  const verify = { by: "text", value: "Verify" } as const;
  const key = { by: "text", value: "Use security key" } as const;
  // Username on /login (advance), password on /pw (submit).
  const recipe = built([
    ...page("/login", "username", "advance"),
    {
      kind: "fill",
      path: "/pw",
      effect: "prepare",
      fields: [{ slot: "pw", target: target("pw") }],
    },
    { kind: "click", path: "/pw", target: signIn, purpose: "submit" },
  ]);
  const code = (id: string, extra: Partial<Omit<ObservedCandidate, "target">> = {}) => ({
    ...candidate(id, target(id), "text"),
    inputMode: "numeric" as const,
    maxLength: 6,
    ...extra,
  });
  const at = (path: string, ...candidates: ReturnType<typeof candidate>[]) => ({
    origin,
    path,
    candidates,
  });
  const totp = (field: LoginAttributeTarget = target("otp"), button: LoginTarget = verify) => ({
    kind: "totp" as const,
    field,
    target: button,
  });

  it("refuses a field the page shows only as a button or link", () => {
    for (const role of ["button", "link"] as const)
      expect(
        addHandler(
          recipe,
          at("/two-factor", candidate("otp", target("otp"), role), candidate("v", verify)),
          totp(),
        ),
      ).toEqual({ ok: false, reason: "not-on-page" });
  });

  it("refuses a field the route fills on any path, even when it looks like a code input", () => {
    // `username` is filled on /login; the code page is elsewhere.
    expect(
      addHandler(
        recipe,
        at("/two-factor", code("username"), candidate("v", verify)),
        totp(target("username")),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("accepts the route's advance button on its path as the code's button", () => {
    const next = target("username-next");
    const added = addHandler(
      recipe,
      at("/login", code("otp"), candidate("next", next)),
      totp(target("otp"), next),
    );
    expect(added.ok && added.recipe.handlers).toEqual([
      { kind: "totp", path: "/login", field: target("otp"), target: next },
    ]);
  });

  it("refuses the passkey route's button on its path as the code's button", () => {
    const passkeyButton = target("passkey-login");
    const withRoute: LoginRecipe = {
      ...recipe,
      passkey: { path: "/login", target: passkeyButton },
    };
    expect(
      addHandler(
        withRoute,
        at("/login", code("otp"), candidate("pk", passkeyButton)),
        totp(target("otp"), passkeyButton),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("refuses another handler's element on that path, in either order", () => {
    const withKey = addHandler(
      recipe,
      at("/two-factor", candidate("key", key), code("otp"), candidate("v", verify)),
      { kind: "passkey", target: key },
    );
    if (!withKey.ok) throw new Error(withKey.reason);
    // The code's button is the passkey handler's button.
    expect(
      addHandler(
        withKey.recipe,
        at("/two-factor", candidate("key", key), code("otp")),
        totp(target("otp"), key),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    // A passkey button that is the totp handler's button.
    const withCode = addHandler(
      recipe,
      at("/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!withCode.ok) throw new Error(withCode.reason);
    expect(
      addHandler(withCode.recipe, at("/two-factor", code("otp"), candidate("v", verify)), {
        kind: "passkey",
        target: verify,
      }),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("refuses a duplicate even when the new elements differ", () => {
    const added = addHandler(
      recipe,
      at("/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!added.ok) throw new Error(added.reason);
    const go = target("go");
    expect(
      addHandler(
        added.recipe,
        at("/two-factor", code("otp2"), candidate("go", go)),
        totp(target("otp2"), go),
      ),
    ).toEqual({ ok: false, reason: "duplicate" });
    // A second code page on another path is a handler of its own.
    const again = addHandler(
      added.recipe,
      at("/two-factor/again", code("otp2"), candidate("go", go)),
      totp(target("otp2"), go),
    );
    expect(again.ok && again.recipe.handlers?.length).toBe(2);
  });

  it("refuses a code field on another origin", () => {
    expect(
      addHandler(
        recipe,
        {
          ...at("/two-factor", code("otp"), candidate("v", verify)),
          origin: "https://evil.example",
        },
        totp(),
      ),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("refuses a handler on a path with a replaced segment, which names no real page", () => {
    expect(
      addHandler(recipe, at("/[id]/two-factor", code("otp"), candidate("v", verify)), totp()),
    ).toEqual({ ok: false, reason: "redacted-path" });
  });

  it("learns no completion beside the handler's code field on its path, but beside other inputs", () => {
    const added = addHandler(
      recipe,
      at("/two-factor", code("otp"), candidate("v", verify)),
      totp(),
    );
    if (!added.ok) throw new Error(added.reason);
    // The handler's field on its own path blocks a completion there.
    expect(
      addCompletion(
        added.recipe,
        at("/two-factor", code("otp"), candidate("logout", target("logout"))),
        target("logout"),
      ),
    ).toEqual({ ok: false, reason: "login-page" });
    // The same locator on another path is not the handler's field.
    expect(
      addCompletion(
        added.recipe,
        at("/account", code("otp"), candidate("logout", target("logout"))),
        target("logout"),
      ).ok,
    ).toBe(true);
    // Another code-like field there is not the handler's, and the marker is learned.
    const learned = addCompletion(
      added.recipe,
      at("/account", code("pin"), candidate("logout", target("logout"))),
      target("logout"),
    );
    expect(learned.ok && learned.recipe.completion).toEqual([{ target: target("logout") }]);
    // The handler's button recurring there does not block it.
    const button = addCompletion(
      added.recipe,
      at("/account", candidate("v", verify), candidate("logout", target("logout"))),
      target("logout"),
    );
    expect(button.ok).toBe(true);
    // Its button is never a marker, on any path (ADR 0029).
    expect(addCompletion(added.recipe, at("/account", candidate("v", verify)), verify)).toEqual({
      ok: false,
      reason: "step-target",
    });
  });
});
