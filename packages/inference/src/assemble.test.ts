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
import { registerGeneratedCases } from "../test/assemble/generated";
import { registerReplacedAdvanceCases } from "../test/assemble/replaced-advance";
import { registerCompletionCases } from "../test/assemble/completion-markers";
import { registerCompletionSwitchCases } from "../test/assemble/completion-switch";
import { registerPasskeyHandlerCases } from "../test/assemble/passkey-handler";
import { registerAuthenticatorHandlerCases } from "../test/assemble/authenticator-handler";
import { registerPasswordRoutesCases } from "../test/assemble/password-routes";
import { registerPasskeyRouteCases } from "../test/assemble/passkey-route";
import { registerTotpProbesCases } from "../test/assemble/totp-probes";
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
  const result = appendPageSteps(undefined, { pageKind: "sign-in", id: "gen-1", origin, steps });
  if (!result.ok) throw new Error(result.reason);
  return result.recipe;
}

export type AssembleFixtures = {
  origin: typeof origin;
  target: typeof target;
  page: typeof page;
  candidate: typeof candidate;
  built: typeof built;
};

describe("generated recipe assembly", () => {
  registerGeneratedCases({ origin, target, page, built });
});

describe("a page replacing a disabled final advance (ADR 0018 amendment of 2026-11-03)", () => {
  const login = { by: "text", value: "Log In" } as const;
  // The email, then a Log In that stays disabled until a password input opens.
  const first = built([
    {
      kind: "fill",
      path: "/login",
      effect: "prepare",
      fields: [{ slot: "username", target: target("email") }],
    },
    { kind: "click", path: "/login", target: login, purpose: "advance" },
  ]);
  const password: LoginStep = {
    kind: "fill",
    path: "/login",
    effect: "prepare",
    fields: [{ slot: "password", target: target("password") }],
  };
  const submit: LoginStep = { kind: "click", path: "/login", target: login, purpose: "submit" };
  const replace = (steps: LoginStep[], base = first) =>
    appendPageSteps(base, { pageKind: "sign-in", id: "gen-1", origin, steps, replacesLast: true });

  registerReplacedAdvanceCases({ origin, target, page, built, first, password, submit, replace });
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

  registerCompletionCases({ origin, target, candidate, recipe, home });
});

describe("judged completion beside the account switch", () => {
  const other = { by: "text", value: "Switch account" } as const;
  const switched = (() => {
    const first = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: page("/login", "pw", "submit"),
      accountSwitch: other,
    });
    if (!first.ok) throw new Error(first.reason);
    return first.recipe;
  })();

  registerCompletionSwitchCases({ origin, target, page, candidate, built, other, switched });
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

  registerPasskeyHandlerCases({
    origin,
    target,
    candidate,
    recipe,
    securityKey,
    webauthn,
    passkey,
  });
});

describe("judged password handler (ADR 0048)", () => {
  // An identifier page whose Next leads, on the same path, to a page that asks how to
  // confirm the sign-in; the password page is not generated yet.
  const recipe = built(page("/", "username", "advance"));
  const choose = target("choose-password");
  const choice = (...candidates: ObservedCandidate[]) => ({
    origin,
    path: "/",
    candidates: [
      { ...candidate("password", choose), label: "Password" },
      { ...candidate("mobile", target("mobile")), label: "Mobile" },
      ...candidates,
    ],
  });
  const password = (locator: LoginTarget = choose) => ({
    kind: "password" as const,
    target: locator,
  });

  it("adds a handler for the page's button in the next revision, which the route continues", () => {
    const added = addHandler(recipe, choice(), password());
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe).toEqual({
      ...recipe,
      revision: recipe.revision + 1,
      handlers: [{ kind: "password", path: "/", target: choose }],
    });
    expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    // The password page that follows continues the route; the handler stays.
    const continued = appendPageSteps(added.recipe, {
      pageKind: "sign-in",
      id: added.recipe.id,
      origin,
      steps: page("/", "password", "submit"),
    });
    if (!continued.ok) throw new Error(continued.reason);
    expect(continued.recipe.handlers).toEqual(added.recipe.handlers);
    expect(continuesRecipe(added.recipe, continued.recipe)).toBe(true);
    // A second one on that path is refused.
    expect(addHandler(added.recipe, choice(), password())).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it.each([
    ["Forgot password?", "forgot"],
    ["Mobile", "another channel"],
    ["Send a one-time password", "a code"],
    ["パスワードを忘れた方", "Japanese forgot"],
    ["Use Touch ID or password", "a platform sign-in"],
    ["Update password", "another task"],
  ])("refuses a button labelled %s (%s)", (label) => {
    const labelled = { ...choice(), candidates: [{ ...candidate("password", choose), label }] };
    expect(addHandler(recipe, labelled, password())).toEqual({
      ok: false,
      reason: "not-password",
    });
  });

  it("checks the text locator too, and needs a label or a text locator", () => {
    const text = { by: "text", value: "Reset password" } as const;
    const reset = {
      ...choice(),
      candidates: [{ ...candidate("password", text), label: "Password" }],
    };
    expect(addHandler(recipe, reset, password(text))).toEqual({
      ok: false,
      reason: "not-password",
    });
    const unnamed = { ...choice(), candidates: [candidate("password", choose)] };
    expect(addHandler(recipe, unnamed, password())).toEqual({
      ok: false,
      reason: "not-password",
    });
    const named = { by: "text", value: "Use your password" } as const;
    expect(
      addHandler(recipe, { ...choice(), candidates: [candidate("x", named)] }, password(named)).ok,
    ).toBe(true);
  });

  it("refuses a recipe that already fills the password, a link and a route step's button", () => {
    const typed = built([
      ...page("/", "username", "advance"),
      ...page("/pw", "password", "submit"),
    ]);
    expect(addHandler(typed, { ...choice(), path: "/mfa" }, password())).toEqual({
      ok: false,
      reason: "password-filled",
    });
    const link = {
      ...choice(),
      candidates: [{ ...candidate("password", choose, "link"), label: "Password" }],
    };
    expect(addHandler(recipe, link, password())).toEqual({ ok: false, reason: "not-on-page" });
    const next = target("username-next");
    const routed = {
      ...choice(),
      candidates: [{ ...candidate("password", next), label: "Password" }],
    };
    expect(addHandler(recipe, routed, password(next))).toEqual({
      ok: false,
      reason: "step-target",
    });
  });

  describe("a button named by its accessible name (ADR 0048 amendment of 2026-10-19)", () => {
    const named = { by: "accessible-name", value: "Select Password." } as const;
    const select = (value: string = named.value, label: string | undefined = value) => ({
      ...choice(),
      candidates: [
        {
          ...candidate("password", { by: "accessible-name", value }),
          ...(label === undefined ? {} : { label }),
        },
      ],
    });

    it("adds a password handler for it", () => {
      const added = addHandler(recipe, select(), password(named));
      if (!added.ok) throw new Error(added.reason);
      expect(added.recipe.handlers).toEqual([{ kind: "password", path: "/", target: named }]);
      expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    });

    it("checks its name as well as its label", () => {
      const phone = { by: "accessible-name", value: "Select Phone" } as const;
      expect(addHandler(recipe, select(phone.value, "Select Password."), password(phone))).toEqual({
        ok: false,
        reason: "not-password",
      });
      expect(addHandler(recipe, select(named.value, "Select Phone"), password(named))).toEqual({
        ok: false,
        reason: "not-password",
      });
      expect(addHandler(recipe, select(named.value, undefined), password(named)).ok).toBe(true);
    });

    it("is never a passkey or totp handler's button", () => {
      const passkeyPage = select("Use security key");
      const key = { by: "accessible-name", value: "Use security key" } as const;
      expect(addHandler(recipe, passkeyPage, { kind: "passkey", target: key })).toEqual({
        ok: false,
        reason: "invalid-recipe",
      });
      const code = {
        ...candidate("otp", target("otp"), "text"),
        autocomplete: "one-time-code" as const,
      };
      const verify = { by: "accessible-name", value: "Verify" } as const;
      expect(
        addHandler(
          recipe,
          { ...choice(), candidates: [code, candidate("verify", verify)] },
          { kind: "totp", field: target("otp"), target: verify },
        ),
      ).toEqual({ ok: false, reason: "invalid-recipe" });
    });

    it("is never learned as a signed-in marker", () => {
      expect(addCompletion(recipe, { ...select(), path: "/home" }, named)).toEqual({
        ok: false,
        reason: "invalid-recipe",
      });
    });
  });
});

describe("judged authenticator handler (ADR 0081)", () => {
  // A sign-in form that types the password, then, on the same path, a page that asks how
  // to confirm the sign-in with a second factor.
  const recipe = built(page("/login", "password", "submit"));
  const app = { by: "text", value: "Use code from authenticator" } as const;
  const chooser = (...candidates: ObservedCandidate[]) => ({
    origin,
    path: "/login",
    candidates: [
      { ...candidate("app", app), label: app.value },
      { ...candidate("sms", { by: "text", value: "Text me a code" }), label: "Text me a code" },
      ...candidates,
    ],
  });
  const authenticator = (locator: LoginTarget = app) => ({
    kind: "authenticator" as const,
    target: locator,
  });

  registerAuthenticatorHandlerCases({
    origin,
    target,
    candidate,
    recipe,
    app,
    chooser,
    authenticator,
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
    // A plain text input takes the judge's code only without a `maxlength` and with no
    // `inputmode` but `text` or `numeric` (ADR 0027 amendment of 2026-11-08).
    for (const extra of [{ maxLength: 12 }, { inputMode: "tel" as const }])
      expect(
        addHandler(
          recipe,
          {
            origin,
            path: "/two-factor",
            candidates: [
              { ...candidate("otp", target("otp"), "text"), ...extra },
              candidate("verify", verify),
            ],
          },
          totp(),
        ),
      ).toEqual({ ok: false, reason: "not-code-field" });
    // Supabase's code input (issue #1409): a text input with neither.
    expect(
      addHandler(
        recipe,
        {
          origin,
          path: "/two-factor",
          candidates: [
            { ...candidate("otp", target("otp"), "text"), autocomplete: "off" as const },
            candidate("verify", verify),
          ],
        },
        totp(),
      ),
    ).toMatchObject({ ok: true });
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

  it("adds a handler without a button for a code page that shows none (#916)", () => {
    // Slack's two-factor page: six one-digit inputs outside any form and no button.
    const boxes = Array.from({ length: 6 }, (_, index) =>
      codeInput(`otp-${index + 1}`, { maxLength: 1 }),
    );
    const loose = { origin, path: "/two-factor", candidates: boxes };
    const added = addHandler(recipe, loose, { kind: "totp", field: target("otp-1") });
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "totp", path: "/two-factor", field: target("otp-1") },
    ]);
    expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    // A form that shows a button submits the code with it.
    const withButton = {
      origin,
      path: "/two-factor",
      candidates: [
        ...boxes.map((box) => ({ ...box, group: "code" })),
        { ...candidate("verify", verify), group: "code" },
      ],
    };
    expect(addHandler(recipe, withButton, { kind: "totp", field: target("otp-1") })).toEqual({
      ok: false,
      reason: "not-code-field",
    });
    // Its inputs are still never a route step's elements.
    const routed = {
      origin,
      path: "/pw",
      candidates: [...boxes.slice(0, 5), codeInput("pw", { maxLength: 1 })],
    };
    expect(addHandler(recipe, routed, { kind: "totp", field: target("otp-1") })).toEqual({
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

describe("judged detail handler (ADR 0061)", () => {
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
  // A synthetic page that asks for the birth year and month or a phone's last four digits.
  const confirm = target("confirm");
  const input = (
    id: string,
    role: ObservedCandidate["role"],
    extra: Partial<Omit<ObservedCandidate, "target">> = {},
  ) => ({ ...candidate(id, target(id), role), group: "form-1", ...extra });
  const birthInput = input("birth", "text", { maxLength: 6 });
  const phoneInput = input("phone", "tel", { maxLength: 4 });
  const button = (locator: LoginTarget = confirm) => ({
    ...candidate("confirm", locator),
    group: "form-1",
  });
  const detailPage = (path = "/verify", ...candidates: ObservedCandidate[]) => ({
    origin,
    path,
    candidates: [birthInput, phoneInput, button(), ...candidates],
  });
  const birth = {
    detail: "birth-date" as const,
    format: "yyyymm" as const,
    target: target("birth"),
  };
  const phone = { detail: "phone-last-4" as const, target: target("phone") };
  const detail = (
    fields: {
      detail: "birth-date" | "phone-last-4";
      format?: "yyyymm";
      target: LoginAttributeTarget;
    }[] = [birth, phone],
    locator: LoginTarget = confirm,
  ) => ({ kind: "detail" as const, fields, target: locator });

  it("adds a handler for the inputs and their button, which extends the recipe", () => {
    const added = addHandler(recipe, detailPage(), detail());
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "detail", path: "/verify", fields: [birth, phone], target: confirm },
    ]);
    expect(added.recipe.revision).toBe(recipe.revision + 1);
    expect(added.recipe.steps).toEqual(recipe.steps);
    expect(extendsRecipe(recipe, added.recipe)).toBe(true);
    // A passkey handler on the same path is a handler of another kind.
    const key = { by: "text", value: "Use security key" } as const;
    const both = addHandler(added.recipe, detailPage("/verify", candidate("key", key)), {
      kind: "passkey",
      target: key,
    });
    expect(both.ok && both.recipe.handlers?.map((handler) => handler.kind)).toEqual([
      "detail",
      "passkey",
    ]);
    // On a route path, the route's sign-in form may show beside inputs of its own.
    const onRoute = addHandler(
      recipe,
      detailPage("/pw", input("pw", "password"), candidate("in", signIn)),
      detail([phone]),
    );
    expect(onRoute.ok && onRoute.recipe.handlers).toEqual([
      { kind: "detail", path: "/pw", fields: [phone], target: confirm },
    ]);
  });

  it("refuses an input or button the page does not show", () => {
    for (const handler of [
      detail([birth, { ...phone, target: target("missing") }]),
      detail([birth], target("missing")),
    ])
      expect(addHandler(recipe, detailPage(), handler)).toEqual({
        ok: false,
        reason: "not-on-page",
      });
    // The button must be a button, and each input an input.
    const linked = { ...detailPage(), candidates: [birthInput, input("confirm", "link")] };
    expect(addHandler(recipe, linked, detail([birth]))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
    const pressed = { ...detailPage(), candidates: [{ ...button(target("birth")) }, button()] };
    expect(addHandler(recipe, pressed, detail([birth]))).toEqual({
      ok: false,
      reason: "not-on-page",
    });
  });

  it("refuses an input that detailInputRefusal refuses with its button", () => {
    for (const candidates of [
      // Shorter than the value, a password input for a birth date, a sign-in field, and a
      // button of another form.
      [birthInput, input("phone", "tel", { maxLength: 3 }), button()],
      [input("birth", "password"), phoneInput, button()],
      [birthInput, input("phone", "tel", { autocomplete: "one-time-code" }), button()],
      [birthInput, input("phone", "tel", { group: "form-2" }), button()],
    ])
      expect(addHandler(recipe, { ...detailPage(), candidates }, detail())).toEqual({
        ok: false,
        reason: "not-detail-field",
      });
  });

  it("adds a value split over selects or boxes, each part checked again (ADR 0061)", () => {
    const selects = ["year", "month", "day"].map((id) => input(id, "select"));
    const boxes = ["c1", "c2", "c3", "c4"].map((id) => input(id, "tel", { maxLength: 4 }));
    const date = {
      detail: "birth-date" as const,
      parts: [
        { part: "year" as const, format: "yyyy" as const, target: target("year") },
        { part: "month" as const, format: "mm" as const, target: target("month") },
        { part: "day" as const, format: "d" as const, target: target("day") },
      ],
    };
    const card = {
      detail: "card-number" as const,
      parts: boxes.map((_box, at) => ({ part: at + 1, length: 4, target: target(`c${at + 1}`) })),
    };
    const shown = { ...detailPage(), candidates: [...selects, ...boxes, button()] };
    const added = addHandler(recipe, shown, {
      kind: "detail",
      fields: [date, card],
      target: confirm,
    });
    if (!added.ok) throw new Error(added.reason);
    expect(added.recipe.handlers).toEqual([
      { kind: "detail", path: "/verify", fields: [date, card], target: confirm },
    ]);
    // A box whose maxlength is no longer its group's length, a select for a card's digits,
    // and a part the page does not show are refused.
    for (const [candidates, reason] of [
      [
        [...selects, ...boxes.slice(0, 3), input("c4", "tel", { maxLength: 3 }), button()],
        "not-detail-field",
      ],
      [[...selects, ...boxes.slice(0, 3), input("c4", "select"), button()], "not-detail-field"],
      [[...selects.slice(0, 2), ...boxes, button()], "not-on-page"],
    ] as const)
      expect(
        addHandler(
          recipe,
          { ...shown, candidates: [...candidates] },
          { kind: "detail", fields: [date, card], target: confirm },
        ),
      ).toEqual({ ok: false, reason });
  });

  it("refuses a route field or button, and another handler's element on that path", () => {
    // The route's password field on its path, and a field the route fills on any path.
    for (const [path, field] of [
      ["/pw", "pw"],
      ["/verify", "username"],
    ] as const)
      expect(
        addHandler(
          recipe,
          detailPage(path, input(field, "text")),
          detail([birth, { ...phone, target: target(field) }]),
        ),
      ).toEqual({ ok: false, reason: "step-target" });
    // The route's button on its path.
    expect(
      addHandler(
        recipe,
        { ...detailPage("/pw"), candidates: [birthInput, { ...button(signIn) }] },
        detail([birth], signIn),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    // A totp handler's code field on the same path.
    const codeInput = input("otp", "tel", { maxLength: 6 });
    const coded = addHandler(
      recipe,
      { origin, path: "/verify", candidates: [codeInput, { ...button(target("verify")) }] },
      { kind: "totp", field: target("otp"), target: target("verify") },
    );
    if (!coded.ok) throw new Error(coded.reason);
    expect(
      addHandler(
        coded.recipe,
        detailPage("/verify", codeInput),
        detail([{ ...phone, target: target("otp") }]),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    // On another path it is another element.
    expect(
      addHandler(
        coded.recipe,
        detailPage("/other", codeInput),
        detail([{ ...phone, target: target("otp") }]),
      ).ok,
    ).toBe(true);
    // Nor the account switch, rejection or a marker.
    const extended: LoginRecipe = {
      ...recipe,
      rejection: target("error"),
      completion: [{ target: target("account") }],
    };
    expect(
      addHandler(
        extended,
        detailPage("/verify", { ...button(target("error")) }),
        detail([birth], target("error")),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
    expect(
      addHandler(
        extended,
        detailPage("/verify", input("account", "tel")),
        detail([{ ...phone, target: target("account") }]),
      ),
    ).toEqual({ ok: false, reason: "step-target" });
  });

  it("refuses a second detail handler on the same path", () => {
    const added = addHandler(recipe, detailPage(), detail([birth]));
    if (!added.ok) throw new Error(added.reason);
    expect(addHandler(added.recipe, detailPage(), detail([phone]))).toEqual({
      ok: false,
      reason: "duplicate",
    });
    // On another path it is another page.
    expect(addHandler(added.recipe, detailPage("/verify-2"), detail([phone])).ok).toBe(true);
    // One input named twice breaks the recipe contract.
    expect(addHandler(recipe, detailPage(), detail([phone, phone]))).toEqual({
      ok: false,
      reason: "invalid-recipe",
    });
  });

  it("refuses another origin", () => {
    expect(
      addHandler(recipe, { ...detailPage(), origin: "https://www.bank.example" }, detail()),
    ).toEqual({ ok: false, reason: "origin-mismatch" });
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
      pageKind: "sign-in",
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

  registerPasswordRoutesCases({ origin, target, page, built, set, varied, shown });
});

describe("the passkey route in generated recipes (ADR 0027)", () => {
  const button = { by: "text", value: "Sign in with a passkey" } as const;
  const signIn = page("/login", "username", "submit");
  const withPasskey = () => {
    const result = appendPageSteps(undefined, {
      pageKind: "sign-in",
      id: "gen-1",
      origin,
      steps: signIn,
      passkey: button,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.recipe;
  };

  registerPasskeyRouteCases({
    origin,
    target,
    page,
    candidate,
    built,
    button,
    signIn,
    withPasskey,
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

  registerTotpProbesCases({ target, candidate, verify, key, recipe, code, at, totp });
});
