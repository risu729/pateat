import { registerCustomSlotStorage, registerCustomSlotNames } from "../test/plan/custom-slot-names";
import { registerSavedBindingMatches, registerCarriedSlotNames } from "../test/plan/saved-bindings";
import { registerIdentifierSets } from "../test/plan/identifier-sets";
import { registerPasskeyEntry } from "../test/plan/passkey-entry";
import { registerActionPurpose } from "../test/plan/action-purpose";
import {
  builtInLoginSlots,
  customFieldSlotDescriptions,
  type LoginObservation,
  type SavedLoginBinding,
  type SemanticSlot,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import {
  actionPurpose,
  customSlotNames,
  slotAccepts,
  slotAcceptsOn,
  validateGeneratedPage,
  validatePagePlan,
  type GeneratedPagePlan,
  type PagePlan,
} from "./plan";

// Synthetic page only: custom-field slot names and the Hidden fill rule (ADR 0027).

type Candidate = LoginObservation["candidates"][number];
export type PlanTestFixtures = {
  candidate: Candidate;
  observation: typeof observation;
  slots: typeof slots;
  action: typeof action;
  input: typeof input;
  branch: typeof branch;
  account: typeof account;
};

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

describe("a button beside a form without one of its own", () => {
  // Sakura Internet's login page (2026-10-23): the ID and password in a form, links to
  // reset them in it, and the login button just after the form.
  const page = (...extra: Candidate[]): LoginObservation => ({
    ...observation,
    candidates: [
      input("member", { group: "f1" }),
      input("forgot", { role: "link", group: "f1" }),
      input("pass", { role: "password", group: "f1" }),
      input("go", { role: "button" }),
      ...extra,
    ],
  });
  const loginSlots = [builtInLoginSlots.username, builtInLoginSlots.password];
  const both = [
    { slot: "username", candidate: "member" },
    { slot: "password", candidate: "pass" },
  ];
  const submit = { candidate: "go", purpose: "submit" } as const;

  it("presses it for that form", () => {
    expect(validatePagePlan(page(), loginSlots, { fields: both, action: submit }).ok).toBe(true);
    // An identifier alone submits, as the form still shows its password.
    const member = [{ slot: "username", candidate: "member" }];
    expect(actionPurpose(page(), loginSlots, { fields: member, action: submit }, "advance")).toBe(
      "submit",
    );
  });

  it("presses it when other buttons outside every form follow it", () => {
    // LeetCode's sign-in page (2026-11-07): the username and password in a form, then the
    // "Sign In" button outside it, then a "Sign Up" button outside it too.
    const signUp = input("up", { role: "button", label: "Sign Up" });
    expect(validatePagePlan(page(signUp), loginSlots, { fields: both, action: submit }).ok).toBe(
      true,
    );
    expect(
      actionPurpose(page(signUp), loginSlots, { fields: [both[0]!], action: submit }, "advance"),
    ).toBe("submit");
    // So it may when the form's last element is a link or checkbox of the form.
    const remember = page(signUp);
    remember.candidates.splice(3, 0, input("keep", { role: "checkbox", group: "f1" }));
    expect(validatePagePlan(remember, loginSlots, { fields: both, action: submit }).ok).toBe(true);
    // Not between two elements of the form, as a field of it the page places later.
    const split = page();
    split.candidates.push(input("later", { group: "f1" }));
    expect(validatePagePlan(split, loginSlots, { fields: both, action: submit })).toEqual({
      ok: false,
      reason: "mixed-groups",
    });
    // A known limit: the check reads order, not words, so the first button of a row after
    // the form is taken whatever it says, as "Cancel" before "Sign in"; only words that
    // name a passkey or registering, as "Create account", refuse it.
    const row = page(input("in", { role: "button", label: "Sign in" }));
    row.candidates[3] = input("go", { role: "button", label: "Cancel" });
    expect(validatePagePlan(row, loginSlots, { fields: both, action: submit }).ok).toBe(true);
    expect(
      validatePagePlan(row, loginSlots, {
        fields: both,
        action: { candidate: "in", purpose: "submit" },
      }),
    ).toEqual({ ok: false, reason: "mixed-groups" });
    row.candidates[3] = input("go", { role: "button", label: "Create account" });
    expect(validatePagePlan(row, loginSlots, { fields: both, action: submit })).toEqual({
      ok: false,
      reason: "mixed-groups",
    });
    // The following button is no form's button: pressing it after the fields is refused.
    expect(
      validatePagePlan(page(signUp), loginSlots, {
        fields: both,
        action: { candidate: "up", purpose: "submit" },
      }),
    ).toEqual({ ok: false, reason: "mixed-groups" });
  });

  it("refuses it for any other form, field or button", () => {
    for (const extra of [
      input("own", { role: "button", group: "f1" }),
      input("q", { group: undefined }),
    ])
      expect(
        validatePagePlan(page(extra), loginSlots, { fields: both, action: submit }),
        extra.id,
      ).toEqual({ ok: false, reason: "mixed-groups" });
    // Nor for a form beside another password form, or after another button outside every
    // form that comes between the form and it, or as a passkey, sign-up, reset or help
    // button (`registersPasskey` words).
    expect(
      validatePagePlan(page(input("other", { role: "password", group: "f2" })), loginSlots, {
        fields: both,
        action: submit,
      }),
    ).toEqual({ ok: false, reason: "mixed-groups" });
    const between = page();
    between.candidates.splice(
      3,
      0,
      input("passkey", { role: "button", label: "パスキーでログイン" }),
    );
    expect(validatePagePlan(between, loginSlots, { fields: both, action: submit })).toEqual({
      ok: false,
      reason: "mixed-groups",
    });
    for (const label of ["Sign in with a passkey", "Create a passkey", "Reset", "Need help?"]) {
      const named = page();
      named.candidates[3] = input("go", { role: "button", label });
      expect(validatePagePlan(named, loginSlots, { fields: both, action: submit }), label).toEqual({
        ok: false,
        reason: "mixed-groups",
      });
    }
    // A form without a password field never takes it, as an identifier form beside it.
    const identifier = page();
    identifier.candidates.splice(2, 1);
    expect(
      validatePagePlan(identifier, loginSlots, {
        fields: [{ slot: "username", candidate: "member" }],
        action: submit,
      }),
    ).toEqual({ ok: false, reason: "mixed-groups" });
    // Fields of two forms never share it.
    const two = page(input("other", { role: "password", group: "f2" }));
    expect(
      validatePagePlan(two, loginSlots, {
        fields: [
          { slot: "username", candidate: "member" },
          { slot: "password", candidate: "other" },
        ],
        action: submit,
      }),
    ).toEqual({ ok: false, reason: "mixed-groups" });
  });
});

describe("an accessible-name locator (ADR 0048 amendments)", () => {
  const named: Candidate = {
    id: "login",
    role: "button",
    target: { by: "accessible-name", value: "Log in" },
  };
  const page = {
    ...observation,
    candidates: [...observation.candidates.filter((entry) => entry.id !== "login"), named],
  };
  const fields = [
    { slot: "username", candidate: "user" },
    { slot: "password", candidate: "password" },
  ];

  it("names the plan's click (ADR 0048 amendment of 2026-10-23)", () => {
    const result = validatePagePlan(page, slots, { fields, action });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.steps.at(-1)).toEqual({
      kind: "click",
      path: observation.path,
      target: named.target,
      purpose: "submit",
    });
  });

  it("never names the account switch", () => {
    const other: Candidate = {
      id: "other",
      role: "button",
      target: { by: "accessible-name", value: "Use another account" },
    };
    expect(
      validatePagePlan({ ...observation, candidates: [...observation.candidates, other] }, slots, {
        fields,
        action,
        accountSwitch: "other",
      }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
  });
});

describe("a field on the page's software keyboard (ADR 0067)", () => {
  it("is filled with the keypad the observation names, which the model never gives", () => {
    const keypad = { by: "id", value: "soft-keys" } as const;
    const page: LoginObservation = {
      ...observation,
      candidates: observation.candidates.map((entry) =>
        entry.id === "password" ? { ...entry, keypad } : entry,
      ),
    };
    const result = validatePagePlan(page, slots, {
      fields: [
        { slot: "username", candidate: "user" },
        { slot: "password", candidate: "password" },
      ],
      action,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.steps[0]).toMatchObject({
      kind: "fill",
      fields: [
        { slot: "username", target: { by: "id", value: "user" } },
        { slot: "password", target: { by: "id", value: "password" }, keypad },
      ],
    });
    expect(
      result.plan.steps[0]!.kind === "fill" && result.plan.steps[0]!.fields[0],
    ).not.toHaveProperty("keypad");
  });
});

describe("custom-field slot names from the page (ADR 0027)", () => {
  registerCustomSlotStorage({ observation, slots, action });

  /** The name the branch slot gets when its field looks like `extra`. */
  const nameOf = (
    extra: Partial<Candidate>,
    page: Partial<LoginObservation> = {},
    others: Candidate[] = [],
  ) =>
    customSlotNames(
      { ...observation, ...page, candidates: [...others, input("branch", extra)] },
      slots,
      [{ fields: [{ slot: "custom-1", candidate: "branch" }] }],
    ).get("custom-1");

  registerCustomSlotNames({ nameOf, observation, slots, input, branch, account });
});

describe("slot names carried from the saved bindings (ADR 0027, 2026-10-19)", () => {
  const duplicate: SemanticSlot = {
    ...account,
    id: "custom-4",
    fieldName: "口座番号",
    fieldPosition: { position: 2, count: 2 },
  };
  const requested = [...slots, duplicate];
  const binding = (...entries: [string, SavedLoginBinding["slots"][number]["field"]][]) => ({
    slots: entries.map(([slot, field]) => ({ slot, field })),
  });

  registerSavedBindingMatches({ requested, binding });

  const labelled: LoginObservation = {
    ...observation,
    candidates: observation.candidates.map((entry) =>
      entry.id === "branch"
        ? { ...entry, label: "支店コード" }
        : entry.id === "account"
          ? { ...entry, label: "店番" }
          : entry,
    ),
  };
  const both = [
    {
      fields: [
        { slot: "custom-1", candidate: "branch" },
        { slot: "custom-2", candidate: "account" },
      ],
    },
  ];

  registerCarriedSlotNames({ labelled, slots, both, action });
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
    expect(validate([{ slot: "custom-3", candidate: "pin" }])).toMatchObject({
      ok: true,
    });
    expect(validate([{ slot: "custom-3", candidate: "branch" }])).toEqual({
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
        { slot: "custom-3", candidate: "c2" },
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
    candidates: [
      ...observation.candidates,
      input("contract", { label: "契約番号" }),
      input("switch", { role: "link" }),
    ],
  };
  const all = [...slots, contract];
  const primary: GeneratedPagePlan = {
    fields: [
      { slot: "custom-1", candidate: "branch" },
      { slot: "custom-2", candidate: "account" },
      { slot: "password", candidate: "password" },
    ],
    action,
  };
  const byContract = {
    fields: [
      { slot: "custom-4", candidate: "contract" },
      { slot: "password", candidate: "password" },
    ],
    action,
  };
  const check = (alternatives: GeneratedPagePlan["alternatives"], change: Partial<PagePlan> = {}) =>
    validateGeneratedPage(page, all, { ...primary, ...change, alternatives });

  it("validates each set and returns the alternatives' steps", () => {
    const result = check([byContract]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.fields).toEqual([
      { slot: "custom-1", candidate: "branch", name: "branch" },
      { slot: "custom-2", candidate: "account", name: "account" },
      { slot: "password", candidate: "password" },
    ]);
    expect(result.plan.alternatives).toHaveLength(1);
    expect(result.plan.alternatives![0]!.steps[0]).toMatchObject({
      kind: "fill",
      fields: [
        { slot: "契約番号", target: { by: "id", value: "contract" } },
        { slot: "password", target: { by: "id", value: "password" } },
      ],
    });
    // Without alternatives the plan is the single page plan.
    expect(check(undefined)).toEqual(validatePagePlan(page, all, primary));
    expect(check([])).toEqual(validatePagePlan(page, all, primary));
  });

  registerIdentifierSets({ check, page, all, primary, byContract, input, action });
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

  registerPasskeyEntry({ generate, page, fields, slots, branch, input, action });
});

describe("the action's purpose read from the page (owner 2026-10-22, #834)", () => {
  const emailPage: LoginObservation = {
    ...observation,
    path: "/sign_in",
    candidates: [input("email", { role: "email" }), input("next", { role: "button" })],
  };
  const emailOnly = (page: LoginObservation, purpose: "advance" | "submit") =>
    validateGeneratedPage(page, slots, {
      fields: [{ slot: "username", candidate: "email" }],
      action: { candidate: "next", purpose },
    });
  const purposeOf = (result: ReturnType<typeof validateGeneratedPage>) => {
    if (!result.ok) throw new Error(result.reason);
    return [result.plan.action.purpose, result.plan.steps.at(-1)];
  };

  registerActionPurpose({ emailPage, emailOnly, purposeOf, branch, input, observation, slots });
});

describe("a form that shows no button (ADR 0064)", () => {
  const form: LoginObservation = {
    ...observation,
    candidates: [
      input("phone", { role: "button", group: "f1" }),
      input("user", { autocomplete: "username", group: "f1" }),
      input("password", { role: "password", group: "f1" }),
      input("outside"),
      input("code", { autocomplete: "one-time-code", group: "f1" }),
    ],
  };
  const user = { slot: "username", candidate: "user" };
  const password = { slot: "password", candidate: "password" };
  const target = (value: string) => ({ by: "id", value });

  it("presses Enter in the last field when the action is that field", () => {
    expect(
      validatePagePlan(form, slots, {
        fields: [user],
        action: { candidate: "user", purpose: "advance" },
      }),
    ).toEqual({
      ok: true,
      plan: {
        fields: [user],
        action: { candidate: "user", purpose: "advance" },
        steps: [
          {
            kind: "fill",
            path: "/login",
            fields: [{ slot: "username", target: target("user") }],
            effect: "prepare",
          },
          {
            kind: "click",
            path: "/login",
            target: target("user"),
            purpose: "advance",
            press: "enter",
          },
        ],
      },
    });
    const both = validatePagePlan(form, slots, {
      fields: [user, password],
      action: { candidate: "password", purpose: "submit" },
    });
    if (!both.ok) throw new Error(both.reason);
    expect(both.plan.steps.at(-1)).toEqual({
      kind: "click",
      path: "/login",
      target: target("password"),
      purpose: "submit",
      press: "enter",
    });
  });

  it("refuses another field, a field outside a form, a code and an unfilled field", () => {
    const refused = (fields: PagePlan["fields"], candidate: string) =>
      validatePagePlan(form, [...slots, builtInLoginSlots.totp], {
        fields,
        action: { candidate, purpose: "submit" },
      });
    expect(refused([user, password], "user")).toEqual({
      ok: false,
      reason: "duplicate-candidate",
    });
    expect(refused([{ slot: "username", candidate: "outside" }], "outside")).toEqual({
      ok: false,
      reason: "duplicate-candidate",
    });
    expect(refused([{ slot: "totp", candidate: "code" }], "code")).toEqual({
      ok: false,
      reason: "duplicate-candidate",
    });
    expect(refused([user], "password")).toEqual({ ok: false, reason: "incompatible-role" });
  });

  it("reads the purpose from the page, on the start page and after it", () => {
    const draft: GeneratedPagePlan = {
      fields: [user],
      action: { candidate: "user", purpose: "submit" },
    };
    for (const startPage of [true, false]) {
      const result = validateGeneratedPage(form, slots, draft, startPage);
      if (!result.ok) throw new Error(result.reason);
      // The form still shows an empty password input, which the submission sends.
      expect(result.plan.steps.at(-1)).toMatchObject({ purpose: "submit", press: "enter" });
    }
    const alone = {
      ...form,
      candidates: form.candidates.filter((c) => c.id !== "password" && c.id !== "code"),
    };
    for (const startPage of [true, false]) {
      const result = validateGeneratedPage(alone, slots, draft, startPage);
      if (!result.ok) throw new Error(result.reason);
      expect(result.plan.action.purpose).toBe("advance");
      expect(result.plan.steps.at(-1)).toMatchObject({ purpose: "advance", press: "enter" });
    }
  });
});
