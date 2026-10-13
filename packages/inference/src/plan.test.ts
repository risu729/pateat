import {
  builtInLoginSlots,
  customFieldSlotDescriptions,
  type LoginObservation,
  type SemanticSlot,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import {
  namesPasskey,
  registersPasskey,
  slotAccepts,
  slotAcceptsOn,
  validateGeneratedPage,
  validatePagePlan,
  type GeneratedPagePlan,
  type PagePlan,
} from "./plan";

// Synthetic page only: custom-field slot names and the Hidden fill rule (ADR 0027).

type Candidate = LoginObservation["candidates"][number];
const input = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  role: "text",
  target: { by: "id", value: id },
  ...extra,
});
const observation: LoginObservation = {
  version: 1,
  origin: "https://bank.example.test",
  path: "/login",
  language: "ja",
  complete: true,
  candidates: [
    input("user"),
    input("branch"),
    input("account"),
    input("pin", { role: "password" }),
    input("password", { role: "password" }),
    input("login", { role: "button" }),
  ],
};
const branch: SemanticSlot = {
  id: "custom-1",
  kind: "identifier",
  description: customFieldSlotDescriptions.identifier,
  fieldName: "支店番号",
};
const account: SemanticSlot = {
  id: "custom-2",
  kind: "identifier",
  description: customFieldSlotDescriptions.identifier,
  fieldName: "口座番号",
};
const pin: SemanticSlot = {
  id: "custom-3",
  kind: "hidden",
  description: customFieldSlotDescriptions.hidden,
  fieldName: "PIN",
};
const slots = [builtInLoginSlots.username, builtInLoginSlots.password, branch, account, pin];
const action = { candidate: "login", purpose: "submit" } as const;
const validate = (fields: PagePlan["fields"]) =>
  validatePagePlan(observation, slots, { fields, action });

describe("custom-field slot names (ADR 0027)", () => {
  it("stores a custom-field slot under its generic name and keeps the requested ID", () => {
    const result = validate([
      { slot: "username", candidate: "user" },
      { slot: "custom-1", candidate: "branch", name: "branch-number" },
      { slot: "password", candidate: "password" },
    ]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.fields).toEqual([
      { slot: "username", candidate: "user" },
      { slot: "custom-1", candidate: "branch", name: "branch-number" },
      { slot: "password", candidate: "password" },
    ]);
    expect(result.plan.steps[0]).toMatchObject({
      kind: "fill",
      fields: [
        { slot: "username", target: { by: "id", value: "user" } },
        { slot: "branch-number", target: { by: "id", value: "branch" } },
        { slot: "password", target: { by: "id", value: "password" } },
      ],
    });
    // The owner's field name never reaches the steps.
    expect(JSON.stringify(result.plan.steps)).not.toContain("支店番号");
  });

  it("requires a name exactly for slots that carry a field name", () => {
    expect(validate([{ slot: "custom-1", candidate: "branch" }])).toEqual({
      ok: false,
      reason: "missing-slot-name",
    });
    expect(validate([{ slot: "username", candidate: "user", name: "login-id" }])).toEqual({
      ok: false,
      reason: "unexpected-slot-name",
    });
  });

  it.each([
    ["a field name", "支店番号"],
    ["digits", "branch-1234"],
    ["a built-in slot", "password"],
  ])("refuses a name that is %s", (_label, name) => {
    expect(validate([{ slot: "custom-1", candidate: "branch", name }])).toEqual({
      ok: false,
      reason: "invalid-slot-name",
    });
  });

  it("refuses a name a requested custom slot already has as its ID", () => {
    const named = { ...branch, id: "branch" };
    expect(
      validatePagePlan(observation, [named, account], {
        fields: [{ slot: "custom-2", candidate: "account", name: "branch" }],
        action,
      }),
    ).toEqual({ ok: false, reason: "invalid-slot-name" });
  });

  it("refuses two custom slots given the same name", () => {
    expect(
      validate([
        { slot: "custom-1", candidate: "branch", name: "branch-number" },
        { slot: "custom-2", candidate: "account", name: "branch-number" },
      ]),
    ).toEqual({ ok: false, reason: "duplicate-slot" });
    expect(
      validate([
        { slot: "custom-1", candidate: "branch", name: "branch-number" },
        { slot: "custom-2", candidate: "account", name: "account-number" },
      ]),
    ).toMatchObject({ ok: true });
  });
});

describe("fields located by their visible name (ADR 0037)", () => {
  // A Mantine-built form whose fields only per-load IDs name.
  const named: LoginObservation = {
    ...observation,
    candidates: [
      input("c1", { role: "email", target: { by: "label", value: "メールアドレス" } }),
      input("c2", { role: "password", target: { by: "label", value: "パスワード" } }),
      input("c3", { role: "button", target: { by: "text", value: "ログインする" } }),
    ],
  };

  it("fills each field by the locator the observation offered for it", () => {
    const result = validatePagePlan(named, slots, {
      fields: [
        { slot: "username", candidate: "c1" },
        { slot: "password", candidate: "c2" },
      ],
      action: { candidate: "c3", purpose: "submit" },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.steps).toEqual([
      {
        kind: "fill",
        path: "/login",
        effect: "prepare",
        fields: [
          { slot: "username", target: { by: "label", value: "メールアドレス" } },
          { slot: "password", target: { by: "label", value: "パスワード" } },
        ],
      },
      {
        kind: "click",
        path: "/login",
        target: { by: "text", value: "ログインする" },
        purpose: "submit",
      },
    ]);
  });

  it("never takes a field's name as the action", () => {
    expect(
      validatePagePlan(named, slots, {
        fields: [{ slot: "username", candidate: "c1" }],
        action: { candidate: "c2", purpose: "submit" },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("the Hidden fill rule in plan validation (ADR 0027)", () => {
  it.each<[string, Partial<Candidate>, boolean]>([
    ["a password input", { role: "password" }, true],
    ["a tel input of 4", { role: "tel", maxLength: 4 }, true],
    ["a tel input of 10", { role: "tel", maxLength: 10 }, true],
    ["a numeric text input of 6", { inputMode: "numeric", maxLength: 6 }, true],
    ["a tel input of 11", { role: "tel", maxLength: 11 }, false],
    ["a tel input without a length", { role: "tel" }, false],
    ["a numeric text input without a length", { inputMode: "numeric" }, false],
    ["a plain text input of 4", { maxLength: 4 }, false],
    ["a decimal text input of 4", { inputMode: "decimal", maxLength: 4 }, false],
    ["a number input", { role: "number", inputMode: "numeric" }, false],
    ["an email input", { role: "email", maxLength: 6 }, false],
    ["a registration password", { role: "password", autocomplete: "new-password" }, false],
  ])("a hidden slot for %s: %s", (_label, extra, accepted) => {
    expect(slotAccepts("hidden", input("pin", extra))).toBe(accepted);
  });

  it("validates a plan that fills a hidden slot into an accepted input only", () => {
    expect(validate([{ slot: "custom-3", candidate: "pin", name: "pin-code" }])).toMatchObject({
      ok: true,
    });
    expect(validate([{ slot: "custom-3", candidate: "branch", name: "pin-code" }])).toEqual({
      ok: false,
      reason: "incompatible-role",
    });
  });

  it("leaves the other kinds' roles unchanged", () => {
    expect(slotAccepts("identifier", input("x", { role: "number" }))).toBe(true);
    expect(slotAccepts("secret", input("x", { role: "tel", maxLength: 4 }))).toBe(false);
    // A one-time code takes the executor's TOTP rule: an unlimited number input needs the
    // autocomplete hint.
    expect(slotAccepts("one-time-code", input("x", { role: "number" }))).toBe(false);
    expect(
      slotAccepts("one-time-code", input("x", { role: "number", autocomplete: "one-time-code" })),
    ).toBe(true);
    expect(
      slotAccepts(
        "one-time-code",
        input("x", { role: "text", inputMode: "numeric", maxLength: 6 }),
      ),
    ).toBe(true);
    expect(slotAccepts("one-time-code", input("x", { role: "text" }))).toBe(false);
  });
});

describe("the one-time-code slot in plan validation, probed independently (ADR 0027)", () => {
  const coded = (extra: Partial<Candidate>): LoginObservation => ({
    ...observation,
    candidates: [...observation.candidates, input("otp", extra)],
  });
  const plan = (extra: Partial<Candidate>) =>
    validatePagePlan(coded(extra), [...slots, builtInLoginSlots.totp], {
      fields: [
        { slot: "password", candidate: "password" },
        { slot: "totp", candidate: "otp" },
      ],
      action,
    });

  it.each<[string, Partial<Candidate>]>([
    ["autocomplete=one-time-code", { autocomplete: "one-time-code" }],
    ["a numeric text input of 6", { inputMode: "numeric", maxLength: 6 }],
    ["a tel input of 8", { role: "tel", maxLength: 8 }],
  ])("maps the code into %s", (_label, extra) => {
    expect(plan(extra)).toMatchObject({ ok: true });
  });

  it.each<[string, Partial<Candidate>]>([
    ["a plain text input", {}],
    ["a text input of 6 without a numeric hint", { maxLength: 6 }],
    ["a numeric text input of 11", { inputMode: "numeric", maxLength: 11 }],
    ["a tel input without a length", { role: "tel" }],
    ["a number input without the hint", { role: "number" }],
  ])("refuses the code in %s", (_label, extra) => {
    expect(plan(extra)).toEqual({ ok: false, reason: "incompatible-role" });
  });
});

describe("a lone new-password field on a sign-in form (ADR 0018, 2026-10-12)", () => {
  // Shaped like SBI Securities' login form, with synthetic locators: a username input, a
  // password input marked new-password, a software keyboard button, the login button, a
  // help link and a phone authentication button, all in one form.
  const form = (extra: Partial<Candidate> = {}) => ({ group: "f1", ...extra });
  const sbi = (...more: Candidate[]): LoginObservation => ({
    ...observation,
    origin: "https://securities.example.test",
    candidates: [
      input("c1", form({ label: "ユーザーネーム", autocomplete: "username" })),
      input("c2", form({ role: "password", label: "パスワード", autocomplete: "new-password" })),
      input("c3", form({ role: "button", label: "セキュリティキーボード" })),
      input("c4", form({ role: "button", label: "ログイン" })),
      input("c5", form({ role: "link", label: "ログインできない方" })),
      input("c6", form({ role: "button", label: "電話番号認証" })),
      ...more,
    ],
  });
  const signIn = { candidate: "c4", purpose: "submit" } as const;
  const both: PagePlan["fields"] = [
    { slot: "username", candidate: "c1" },
    { slot: "password", candidate: "c2" },
  ];
  const plan = (page: LoginObservation, fields: PagePlan["fields"] = both) =>
    validatePagePlan(page, slots, { fields, action: signIn });
  const refused = { ok: false, reason: "incompatible-role" };

  it("fills the username and the password and submits", () => {
    expect(plan(sbi())).toMatchObject({
      ok: true,
      plan: {
        steps: [
          {
            kind: "fill",
            fields: [
              { slot: "username", target: { by: "id", value: "c1" } },
              { slot: "password", target: { by: "id", value: "c2" } },
            ],
          },
          { kind: "click", target: { by: "id", value: "c4" }, purpose: "submit" },
        ],
      },
    });
    expect(slotAcceptsOn(sbi(), "secret", sbi().candidates[1]!)).toBe(true);
    // Without the page, a registration password still never qualifies.
    expect(slotAccepts("secret", sbi().candidates[1]!)).toBe(false);
  });

  it.each<[string, Partial<Candidate>]>([
    ["marked email", { role: "email", autocomplete: "email" }],
    ["marked off", { autocomplete: "off" }],
    ["without a mark", {}],
  ])("takes an identifier %s", (_label, extra) => {
    const page = sbi();
    page.candidates[0] = { ...page.candidates[0]!, autocomplete: undefined, ...extra };
    expect(plan(page)).toMatchObject({ ok: true });
  });

  it("fills a Hidden field there under the same rule, but never a one-time code", () => {
    expect(
      plan(sbi(), [
        { slot: "username", candidate: "c1" },
        { slot: "custom-3", candidate: "c2", name: "pin-code" },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      validatePagePlan(sbi(), [builtInLoginSlots.username, builtInLoginSlots.totp], {
        fields: [
          { slot: "username", candidate: "c1" },
          { slot: "totp", candidate: "c2" },
        ],
        action: signIn,
      }),
    ).toEqual(refused);
  });

  it("refuses a confirmation field or a second password field of the form", () => {
    for (const autocomplete of ["new-password", "current-password", undefined] as const)
      expect(
        plan(
          sbi(input("c7", form({ role: "password", label: "パスワード（確認）", autocomplete }))),
        ),
      ).toEqual(refused);
    expect(plan(sbi(input("c7", form({ autocomplete: "current-password" }))))).toEqual(refused);
  });

  it.each<[string, Partial<Candidate>]>([
    ["a name", { autocomplete: "name" }],
    ["a family name", { autocomplete: "family-name" }],
    ["a telephone number", { role: "tel", autocomplete: "tel" }],
    ["a birthday", { autocomplete: "bday" }],
    ["a postal code", { autocomplete: "postal-code" }],
  ])("refuses a form that also asks for %s", (_label, extra) => {
    expect(plan(sbi(input("c7", form(extra))))).toEqual(refused);
  });

  it("refuses an identifier marked for a new password or a personal detail", () => {
    const page = sbi();
    page.candidates[0] = { ...page.candidates[0]!, autocomplete: "new-password" };
    expect(plan(page)).toEqual(refused);
    page.candidates[0] = { ...page.candidates[0]!, role: "tel", autocomplete: "tel" };
    expect(plan(page)).toEqual(refused);
  });

  it("refuses a plan that fills the password without an identifier", () => {
    expect(plan(sbi(), [{ slot: "password", candidate: "c2" }])).toEqual({
      ok: false,
      reason: "lone-new-password",
    });
    // A form with no identifier input never offers the field at all.
    const alone = sbi();
    alone.candidates = alone.candidates.slice(1);
    expect(slotAcceptsOn(alone, "secret", alone.candidates[0]!)).toBe(false);
  });

  it("refuses the field when the page shows a sign-in password elsewhere", () => {
    const login = [
      input("u", { group: "f2" }),
      input("p", { group: "f2", role: "password" }),
      input("go", { group: "f2", role: "button" }),
    ];
    expect(plan(sbi(...login))).toEqual(refused);
    // A registration password elsewhere does not count against it.
    expect(
      plan(sbi(input("r", { group: "f2", role: "password", autocomplete: "new-password" }))),
    ).toMatchObject({ ok: true });
  });

  it.each<[string, Partial<Candidate>]>([
    ["a username input", { autocomplete: "username" }],
    ["a current-password input", { autocomplete: "current-password" }],
    ["a one-time-code input", { autocomplete: "one-time-code" }],
  ])("refuses the field when another form shows %s, as the judge reads a sign-in", (_l, extra) => {
    expect(plan(sbi(input("x", { group: "f2", ...extra })))).toEqual(refused);
  });

  it("refuses an email and new-password sign-up form beside an identifier-first sign-in", () => {
    // The sign-in form asks for the username first; the sign-up form beside it asks for
    // an email and a new password only.
    const page: LoginObservation = {
      ...observation,
      candidates: [
        input("login-id", { group: "f1", autocomplete: "username" }),
        input("next", { group: "f1", role: "button" }),
        input("join-email", { group: "f2", role: "email", autocomplete: "email" }),
        input("join-pass", { group: "f2", role: "password", autocomplete: "new-password" }),
        input("join", { group: "f2", role: "button" }),
      ],
    };
    expect(
      validatePagePlan(page, slots, {
        fields: [
          { slot: "username", candidate: "join-email" },
          { slot: "password", candidate: "join-pass" },
        ],
        action: { candidate: "join", purpose: "submit" },
      }),
    ).toEqual(refused);
  });

  it("refuses a form that also holds a one-time code, as a password reset does", () => {
    expect(plan(sbi(input("c7", form({ role: "tel", autocomplete: "one-time-code" }))))).toEqual(
      refused,
    );
  });
});

describe("several identifier sets on one page (ADR 0027)", () => {
  const contract: SemanticSlot = {
    id: "custom-4",
    kind: "identifier",
    description: customFieldSlotDescriptions.identifier,
    fieldName: "契約者番号",
  };
  const page: LoginObservation = {
    ...observation,
    candidates: [...observation.candidates, input("contract"), input("switch", { role: "link" })],
  };
  const all = [...slots, contract];
  const primary: GeneratedPagePlan = {
    fields: [
      { slot: "custom-1", candidate: "branch", name: "branch-number" },
      { slot: "custom-2", candidate: "account", name: "account-number" },
      { slot: "password", candidate: "password" },
    ],
    action,
  };
  const byContract = {
    fields: [
      { slot: "custom-4", candidate: "contract", name: "contract-number" },
      { slot: "password", candidate: "password" },
    ],
    action,
  };
  const check = (alternatives: GeneratedPagePlan["alternatives"], change: Partial<PagePlan> = {}) =>
    validateGeneratedPage(page, all, { ...primary, ...change, alternatives });

  it("validates each set and returns the alternatives' steps", () => {
    const result = check([byContract]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.fields).toEqual(primary.fields);
    expect(result.plan.alternatives).toHaveLength(1);
    expect(result.plan.alternatives![0]!.steps[0]).toMatchObject({
      kind: "fill",
      fields: [
        { slot: "contract-number", target: { by: "id", value: "contract" } },
        { slot: "password", target: { by: "id", value: "password" } },
      ],
    });
    // Without alternatives the plan is the single page plan.
    expect(check(undefined)).toEqual(validatePagePlan(page, all, primary));
    expect(check([])).toEqual(validatePagePlan(page, all, primary));
  });

  it.each<[string, GeneratedPagePlan["alternatives"], string]>([
    [
      "an alternative that fails plan validation",
      [
        {
          ...byContract,
          fields: [{ slot: "custom-4", candidate: "nowhere", name: "contract-number" }],
        },
      ],
      "unknown-candidate",
    ],
    [
      "another name for the same requested slot",
      [
        {
          fields: [
            { slot: "custom-1", candidate: "branch", name: "branch-code" },
            { slot: "custom-4", candidate: "contract", name: "contract-number" },
          ],
          action,
        },
      ],
      "inconsistent-slot-name",
    ],
    [
      "one name for two requested slots",
      [
        {
          fields: [
            { slot: "custom-4", candidate: "contract", name: "branch-number" },
            { slot: "password", candidate: "password" },
          ],
          action,
        },
      ],
      "duplicate-slot",
    ],
    [
      "the same slots again",
      [{ ...primary, fields: [...primary.fields].reverse() }],
      "duplicate-variant",
    ],
    [
      "a subset of the first set",
      [{ fields: [{ slot: "password", candidate: "pin" }], action }],
      "duplicate-variant",
    ],
    [
      "an action that advances",
      [{ ...byContract, action: { candidate: "login", purpose: "advance" as const } }],
      "variant-advance",
    ],
    [
      // Both sets type one element under different slots: an ambiguous mapping, which
      // could also put a Hidden PIN where the other set puts an identifier.
      "an element filled under another recipe slot",
      [
        {
          fields: [
            { slot: "custom-4", candidate: "branch", name: "contract-number" },
            { slot: "password", candidate: "password" },
          ],
          action,
        },
      ],
      "inconsistent-candidate",
    ],
  ])("refuses %s", (_label, alternatives, reason) => {
    expect(check(alternatives)).toEqual({ ok: false, reason });
  });

  it("refuses a first set that advances once alternatives exist", () => {
    expect(check([byContract], { action: { candidate: "login", purpose: "advance" } })).toEqual({
      ok: false,
      reason: "variant-advance",
    });
  });

  it("refuses an account switch that an alternative fills or clicks", () => {
    expect(check([byContract], { accountSwitch: "switch" })).toMatchObject({ ok: true });
    const switching = {
      fields: [{ slot: "username", candidate: "user" }],
      action: { candidate: "switch", purpose: "submit" as const },
    };
    expect(
      validateGeneratedPage(
        {
          ...page,
          candidates: page.candidates.map((entry) =>
            entry.id === "switch" ? { ...entry, role: "button" } : entry,
          ),
        },
        all,
        { ...primary, accountSwitch: "switch", alternatives: [switching] },
      ),
    ).toEqual({ ok: false, reason: "duplicate-candidate" });
  });

  it("refuses more than 3 alternatives even when each is a distinct valid set", () => {
    const distinct = [
      byContract,
      {
        fields: [
          { slot: "username", candidate: "user" },
          { slot: "password", candidate: "password" },
        ],
        action,
      },
      {
        fields: [
          { slot: "custom-1", candidate: "branch", name: "branch-number" },
          { slot: "custom-3", candidate: "pin", name: "pin-code" },
        ],
        action,
      },
      {
        fields: [
          { slot: "custom-2", candidate: "account", name: "account-number" },
          { slot: "custom-4", candidate: "contract", name: "contract-number" },
        ],
        action,
      },
    ];
    const three = check(distinct.slice(0, 3));
    if (!three.ok) throw new Error(three.reason);
    expect(three.plan.alternatives).toHaveLength(3);
    expect(check(distinct)).toEqual({ ok: false, reason: "too-many-variants" });
  });

  it("refuses a set that contains another set, whichever comes first", () => {
    // An alternative that adds a field to the first set.
    expect(
      check([
        {
          fields: [
            ...primary.fields,
            { slot: "custom-4", candidate: "contract", name: "contract-number" },
          ],
          action,
        },
      ]),
    ).toEqual({ ok: false, reason: "duplicate-variant" });
    // Two alternatives where the later one adds a field to the earlier one.
    expect(
      check([
        byContract,
        {
          fields: [...byContract.fields, { slot: "custom-3", candidate: "pin", name: "pin-code" }],
          action,
        },
      ]),
    ).toEqual({ ok: false, reason: "duplicate-variant" });
  });
});

describe("the start page's passkey sign-in button (ADR 0027)", () => {
  const page: LoginObservation = {
    ...observation,
    candidates: [
      ...observation.candidates,
      input("passkey-login", { role: "button", label: "パスキーでログイン" }),
      input("passkey-help", { role: "link", label: "パスキーについて" }),
      input("add-passkey", { role: "button", label: "Sign in" }),
      input("register", { role: "button", label: "パスキーを登録" }),
      input("contract"),
      input("switch", { role: "link" }),
      // Another candidate with the login button's own locator.
      {
        id: "login-copy",
        role: "button",
        target: { by: "id", value: "login" },
        label: "Sign in with a passkey",
      },
      input("google", { role: "button", label: "Sign in with Google" }),
      input("sso", { role: "button", label: "Sign in with SSO" }),
      input("plain", { role: "button", label: "Log in" }),
    ],
  };
  const fields = [
    { slot: "username", candidate: "user" },
    { slot: "password", candidate: "password" },
  ];
  const generate = (passkeyButton: string | undefined, change: Partial<GeneratedPagePlan> = {}) =>
    validateGeneratedPage(page, slots, { fields, action, passkeyButton, ...change });

  it("keeps a sign-in button the plan does not use, with its locator", () => {
    const result = generate("passkey-login");
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).toMatchObject({
      passkeyButton: "passkey-login",
      passkeyTarget: { by: "id", value: "passkey-login" },
    });
    // The password plan itself is unchanged.
    expect(result.plan.fields).toEqual(fields);
    const plain = validatePagePlan(page, slots, { fields, action });
    if (!plain.ok) throw new Error(plain.reason);
    expect(result.plan.steps).toEqual(plain.plan.steps);
  });

  it.each([
    ["a link", "passkey-help"],
    ["an unknown candidate", "missing"],
    ["a button whose locator reads as adding a passkey", "add-passkey"],
    ["a registration button", "register"],
    ["a field instead of a button", "password"],
    ["a button with the action's locator", "login-copy"],
  ])("drops %s and keeps the plan", (_label, candidate) => {
    const result = generate(candidate);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
    expect(result.plan).not.toHaveProperty("passkeyTarget");
    expect(result.plan.fields).toEqual(fields);
  });

  it("drops the account switch and any element of an alternative set", () => {
    const withSwitch = validateGeneratedPage(
      {
        ...page,
        candidates: [
          ...page.candidates,
          input("other", { role: "button", label: "Sign in with a passkey" }),
        ],
      },
      slots,
      { fields, action, accountSwitch: "other", passkeyButton: "other" },
    );
    if (!withSwitch.ok) throw new Error(withSwitch.reason);
    expect(withSwitch.plan).toMatchObject({ accountSwitch: "other" });
    expect(withSwitch.plan).not.toHaveProperty("passkeyButton");
    const contract: SemanticSlot = { ...branch, id: "custom-4", fieldName: "契約者番号" };
    const alternative = {
      fields: [
        { slot: "custom-4", candidate: "contract", name: "contract-number" },
        { slot: "password", candidate: "password" },
      ],
      action: { candidate: "passkey-login", purpose: "submit" as const },
    };
    const varied = validateGeneratedPage(page, [...slots, contract], {
      fields,
      action,
      alternatives: [alternative],
      passkeyButton: "passkey-login",
    });
    if (!varied.ok) throw new Error(varied.reason);
    expect(varied.plan.alternatives).toHaveLength(1);
    expect(varied.plan).not.toHaveProperty("passkeyButton");
  });

  it("drops the plan's own action even when it names a passkey", () => {
    const result = generate("passkey-login", {
      action: { candidate: "passkey-login", purpose: "submit" },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
  });

  it.each([
    ["a Google sign-in button", "google"],
    ["an SSO button", "sso"],
    ["a button that names no passkey", "plain"],
  ])("drops %s, which names no passkey or security key", (_label, candidate) => {
    const result = generate(candidate);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
    expect(result.plan).not.toHaveProperty("passkeyTarget");
  });

  it("reads passkey words in the label, text and locator alike", () => {
    const button = (label: string | undefined, value: string) => ({
      label,
      target: { by: "id" as const, value },
    });
    for (const [label, value] of [
      [undefined, "passkeyLoginButtonAD"],
      ["Sign in with a passkey", "login"],
      ["Sign in with a Pass Key", "login"],
      ["Use security key", "login"],
      ["Use a SecurityKey", "login"],
      ["パスキーでログイン", "login"],
      ["セキュリティキーでログイン", "login"],
      ["生体認証でログイン", "login"],
      ["Sign in", "webauthn-login"],
      ["FIDO2", "login"],
      [undefined, "signInWithPassKey"],
      ["Use your passkeys", "login"],
      ["セキュリティーキーでログイン", "login"],
      ["Sign in", "fido-login"],
      ["Sign in", "myFido"],
      ["セキュリティキー", "login"],
      ["セキュリティキーを使用", "login"],
    ] as const)
      expect(namesPasskey(button(label, value)), `${label} ${value}`).toBe(true);
    for (const [label, value] of [
      ["Sign in with Google", "google"],
      ["Sign in with SSO", "sso"],
      ["Log in", "login"],
      ["Forgot your password?", "password-reset"],
      ["パスワードでログイン", "password"],
      [undefined, "submit"],
      // Latin words match whole words only.
      ["MyFido", "login"],
      ["Fidor Bank", "login"],
      ["Passkeyless", "login"],
      ["Sign in", "fidorBank"],
      ["Sign in", "passkeyless"],
      // A software keyboard or keypad is not a security key.
      ["Security keyboard", "login"],
      ["Sign in", "securityKeyboard"],
      ["セキュリティキーボード", "login"],
      ["セキュリティーキーボード", "login"],
      ["セキュリティキーパッド", "login"],
      ["セキュリティキーボードを使う", "login"],
    ] as const)
      expect(namesPasskey(button(label, value)), `${label} ${value}`).toBe(false);
    // A text locator reads as a label, never split inside a word.
    expect(namesPasskey({ target: { by: "text", value: "MyFido" } })).toBe(false);
    expect(namesPasskey({ target: { by: "text", value: "Sign in with a passkey" } })).toBe(true);
  });

  it("never rescues a plan that fails its own checks", () => {
    expect(
      generate("passkey-login", { action: { candidate: "passkey-help", purpose: "submit" } }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
  });

  it("reads registration words in the label, text and locator alike", () => {
    const button = (label: string | undefined, value: string) => ({
      label,
      target: { by: "id" as const, value },
    });
    for (const [label, value] of [
      ["Add a passkey", "key"],
      ["Set up security key", "key"],
      ["パスキーを登録", "key"],
      ["パスキーを追加", "key"],
      ["パスキーを作成", "key"],
      ["Sign in", "addPasskey"],
      ["Sign in", "register_key"],
      ["Sign in", "set-up-key"],
      ["Create passkey", "key"],
      ["パスキーを設定", "key"],
      ["生体認証を設定する", "key"],
      ["パスキーを有効にする", "key"],
      ["パスキーを管理", "key"],
      ["Manage passkeys", "key"],
      ["Enable passkey", "key"],
      ["Turn on security key", "key"],
      ["Sign in", "managePasskeys"],
      ["Sign in", "enable-passkey"],
    ] as const)
      expect(registersPasskey(button(label, value)), `${label} ${value}`).toBe(true);
    for (const [label, value] of [
      ["Sign in with a passkey", "passkeyLoginButtonAD"],
      ["パスキーでログイン", "passkey"],
      ["Use security key", "key"],
      [undefined, "signin-passkey"],
      ["セキュリティキーでログイン", "login"],
      ["生体認証でログイン", "login"],
      ["Sign in with a passkey", "login"],
      ["パスキー（設定済みの方）でログイン", "login"],
      ["設定済みのパスキーでログイン", "login"],
      ["有効なパスキーでログイン", "login"],
    ] as const)
      expect(registersPasskey(button(label, value)), `${label} ${value}`).toBe(false);
  });
});
