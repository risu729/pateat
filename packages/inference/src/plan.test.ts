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
  carriedSlotNames,
  customSlotNames,
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

  it("refuses it for any other form, field or button", () => {
    for (const extra of [
      input("own", { role: "button", group: "f1" }),
      input("q", { group: undefined }),
    ])
      expect(
        validatePagePlan(page(extra), loginSlots, { fields: both, action: submit }),
        extra.id,
      ).toEqual({ ok: false, reason: "mixed-groups" });
    // Nor for a form beside another password form, beside another button outside every
    // form, or as a passkey or sign-up button.
    for (const extra of [
      input("other", { role: "password", group: "f2" }),
      input("passkey", { role: "button", label: "パスキーでログイン" }),
    ])
      expect(
        validatePagePlan(page(extra), loginSlots, { fields: both, action: submit }),
        extra.id,
      ).toEqual({ ok: false, reason: "mixed-groups" });
    for (const label of ["Sign in with a passkey", "Create a passkey"]) {
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

describe("an accessible-name locator (ADR 0048 amendment of 2026-10-19)", () => {
  it("names no route step's element, as only a password handler's button uses it", () => {
    const named: Candidate = {
      id: "login",
      role: "button",
      target: { by: "accessible-name", value: "Log in" },
    };
    const page = {
      ...observation,
      candidates: [...observation.candidates.filter((entry) => entry.id !== "login"), named],
    };
    expect(
      validatePagePlan(page, slots, {
        fields: [
          { slot: "username", candidate: "user" },
          { slot: "password", candidate: "password" },
        ],
        action,
      }),
    ).toEqual({ ok: false, reason: "unknown-candidate" });
  });
});

describe("custom-field slot names from the page (ADR 0027)", () => {
  it("stores a custom-field slot under its field's text and keeps the requested ID", () => {
    const page: LoginObservation = {
      ...observation,
      candidates: observation.candidates.map((entry) =>
        entry.id === "branch" ? { ...entry, label: "店番号" } : entry,
      ),
    };
    const result = validatePagePlan(page, slots, {
      fields: [
        { slot: "username", candidate: "user" },
        { slot: "custom-1", candidate: "branch" },
        { slot: "password", candidate: "password" },
      ],
      action,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.fields).toEqual([
      { slot: "username", candidate: "user" },
      { slot: "custom-1", candidate: "branch", name: "店番号" },
      { slot: "password", candidate: "password" },
    ]);
    expect(result.plan.steps[0]).toMatchObject({
      kind: "fill",
      fields: [
        { slot: "username", target: { by: "id", value: "user" } },
        { slot: "店番号", target: { by: "id", value: "branch" } },
        { slot: "password", target: { by: "id", value: "password" } },
      ],
    });
    // The owner's field name never reaches the steps.
    expect(JSON.stringify(result.plan.steps)).not.toContain("支店番号");
  });

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

  it.each<[string, Partial<Candidate>, string]>([
    ["its label first", { label: "店番号", placeholder: "店番", description: "支店" }, "店番号"],
    ["its placeholder without a label", { placeholder: "店番", description: "支店" }, "店番"],
    ["its description without a label or placeholder", { description: "支店" }, "支店"],
    ["its id without any of those", { target: { by: "id", value: "brchNum" } }, "brchNum"],
    ["its name attribute", { target: { by: "name", value: "branch_code" } }, "branch_code"],
    ["its test ID", { target: { by: "test-id", value: "branch.code" } }, "branch.code"],
    [
      "a number, never its visible-name locator",
      { target: { by: "label", value: "店番" } },
      "欄 1",
    ],
    [
      "a number, never its autocomplete token",
      { target: { by: "autocomplete", value: "username" } },
      "欄 1",
    ],
    // Owner's choice, 2026-10-18: any language and length, as the page shows it.
    ["Latin text as it is", { label: "Enter your Security number" }, "Enter your Security number"],
  ])("names a field by %s", (_label, extra, name) => {
    expect(nameOf(extra)).toBe(name);
  });

  it.each<[string, Partial<Candidate>, string]>([
    ["a redaction mark", { label: "[account] の店番", placeholder: "店番" }, "店番"],
    [
      "any redaction mark",
      { label: "[email]", placeholder: "[masked]", description: "[number]" },
      "branch",
    ],
    ["a number", { label: "口座 1234567", placeholder: "支店 045" }, "branch"],
    ["a full-width number", { label: "店番３" }, "branch"],
    ["a number in the locator", { target: { by: "id", value: "ctl00$branch" } }, "欄 1"],
  ])("skips text with %s", (_label, extra, name) => {
    expect(nameOf(extra)).toBe(name);
  });

  it("skips a mark or a number past the 60-character cut", () => {
    const long = "a".repeat(55);
    expect(nameOf({ label: `${long} [number] x`, placeholder: "店番" })).toBe("店番");
    expect(nameOf({ label: `${long} b c d 1`, placeholder: "店番" })).toBe("店番");
  });

  it("takes NFKC text with whitespace collapsed and trimmed", () => {
    expect(nameOf({ label: " Ｂｒａｎｃｈ\u3000 ｺｰﾄﾞ\t" })).toBe("Branch コード");
  });

  it("drops invisible characters from the text", () => {
    expect(nameOf({ label: "店\u034f番\ufe0f号\u200b" })).toBe("店番号");
    expect(nameOf({ label: "\u2060\u3164", placeholder: "店番" })).toBe("店番");
  });

  it("drops a trailing copy of the placeholder or description from the label", () => {
    expect(nameOf({ label: "店番 半角数字3桁", placeholder: "半角数字3桁" })).toBe("店番");
    expect(nameOf({ label: "口座番号 半角数字7桁", description: "半角数字7桁" })).toBe("口座番号");
    expect(nameOf({ label: "店番半角数字", placeholder: "半角数字" })).toBe("店番");
    // Never inside a Latin word.
    expect(nameOf({ label: "Keyword", placeholder: "word" })).toBe("Keyword");
    // A label that is only the hint falls to the next source.
    expect(nameOf({ label: "支店コード", placeholder: "支店コード" })).toBe("支店コード");
    expect(nameOf({ label: "3桁", placeholder: "3桁", description: "支店" })).toBe("支店");
  });

  it("cuts a name to 60 characters, never inside a character", () => {
    expect(nameOf({ label: `${"a".repeat(59)} b` })).toBe("a".repeat(59));
    expect(nameOf({ label: "店".repeat(70) })).toBe("店".repeat(60));
    expect(nameOf({ label: `${"a".repeat(59)}😀` })).toBe("a".repeat(59));
  });

  it("numbers fields without a name from the top of the page, in its language", () => {
    const unnamed = [input("c1", { target: { by: "autocomplete", value: "email" } })];
    const named = [input("c2", { label: "メール" }), input("go", { role: "button" })];
    const target = { by: "label" as const, value: "店番" };
    expect(nameOf({ target }, {}, [...unnamed, ...named])).toBe("欄 2");
    expect(nameOf({ target }, { language: "en" }, [...unnamed, ...named])).toBe("field 2");
    expect(nameOf({ target }, { language: "mixed" }, named)).toBe("欄 1");
  });

  it("numbers equal names apart in page order, without case", () => {
    const page: LoginObservation = {
      ...observation,
      candidates: [
        input("branch", { label: "PIN" }),
        input("account", { label: "pin" }),
        input("pin", { role: "password", label: "Pin" }),
        input("login", { role: "button" }),
      ],
    };
    // The model's order never changes the names.
    const names = customSlotNames(page, slots, [
      {
        fields: [
          { slot: "custom-3", candidate: "pin" },
          { slot: "custom-2", candidate: "account" },
          { slot: "custom-1", candidate: "branch" },
        ],
      },
    ]);
    expect(Object.fromEntries(names)).toEqual({
      "custom-1": "PIN",
      "custom-2": "pin 2",
      "custom-3": "Pin 3",
    });
  });

  it("keeps a name apart from the built-in slots and the request's slot IDs", () => {
    expect(nameOf({ label: "Password" })).toBe("Password 2");
    expect(nameOf({ label: "TOTP" })).toBe("TOTP 2");
    const requested = [{ ...branch, id: "Branch" }, account];
    const page = { ...observation, candidates: [input("account", { label: "branch" })] };
    expect(
      customSlotNames(page, requested, [{ fields: [{ slot: "custom-2", candidate: "account" }] }]),
    ).toEqual(new Map([["custom-2", "branch 2"]]));
    // A numbered name still fits in 60 characters.
    const long = "a".repeat(60);
    const twice: LoginObservation = {
      ...observation,
      candidates: [input("branch", { label: long }), input("account", { label: long })],
    };
    expect(
      customSlotNames(twice, slots, [
        {
          fields: [
            { slot: "custom-1", candidate: "branch" },
            { slot: "custom-2", candidate: "account" },
          ],
        },
      ]).get("custom-2"),
    ).toBe(`${"a".repeat(58)} 2`);
  });

  it("names built-in slots never and leaves out unknown elements", () => {
    expect(
      customSlotNames(observation, slots, [
        {
          fields: [
            { slot: "username", candidate: "user" },
            { slot: "custom-1", candidate: "nowhere" },
          ],
        },
      ]),
    ).toEqual(new Map());
  });
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

  it("matches a custom field by name, position and count", () => {
    expect(
      Object.fromEntries(
        carriedSlotNames(requested, [
          binding(
            ["店番", { custom: "支店番号" }],
            ["口座 2", { custom: "口座番号", position: 2, count: 2 }],
          ),
        ]),
      ),
    ).toEqual({ "custom-1": "店番", "custom-4": "口座 2" });
    // A position or count that differs is another field.
    expect(
      carriedSlotNames(requested, [
        binding(["口座", { custom: "口座番号", position: 1, count: 2 }]),
        binding(["口座 3", { custom: "口座番号", position: 2, count: 3 }]),
      ]),
    ).toEqual(new Map());
  });

  it("matches no built-in field", () => {
    expect(
      carriedSlotNames(requested, [
        binding(["username", "username"], ["password", "password"], ["totp", "totp"]),
      ]),
    ).toEqual(new Map());
  });

  it("carries nothing for a field the bindings name differently", () => {
    expect(
      Object.fromEntries(
        carriedSlotNames(requested, [
          binding(["店番", { custom: "支店番号" }], ["口座", { custom: "口座番号" }]),
          binding(["支店", { custom: "支店番号" }], ["口座", { custom: "口座番号" }]),
        ]),
      ),
    ).toEqual({ "custom-2": "口座" });
  });

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

  it("takes a carried name before any page text, which is numbered apart", () => {
    // The account field's own label is the branch field's carried name.
    expect(
      Object.fromEntries(customSlotNames(labelled, slots, both, new Map([["custom-1", "店番"]]))),
    ).toEqual({ "custom-1": "店番", "custom-2": "店番 2" });
  });

  it.each<[string, string]>([
    ["a built-in slot", "Password"],
    ["a request slot ID", "CUSTOM-3"],
    ["no recipe slot ID", "店番  号"],
    ["a name too long", "a".repeat(61)],
  ])("keeps the page's text over %s", (_label, carried) => {
    expect(
      customSlotNames(labelled, slots, both, new Map([["custom-1", carried]])).get("custom-1"),
    ).toBe("支店コード");
  });

  it("carries a name two slots would share for neither", () => {
    expect(
      Object.fromEntries(
        customSlotNames(
          labelled,
          slots,
          both,
          new Map([
            ["custom-1", "Branch"],
            ["custom-2", "branch"],
          ]),
        ),
      ),
    ).toEqual({ "custom-1": "支店コード", "custom-2": "店番" });
  });

  it("reserves the carried name of a slot the page does not fill", () => {
    // The account field's label is the name the unfilled PIN slot carries to a later page.
    const fillsAccount = [{ fields: [{ slot: "custom-2", candidate: "account" }] }];
    expect(
      Object.fromEntries(
        customSlotNames(labelled, slots, fillsAccount, new Map([["custom-3", "店番"]])),
      ),
    ).toEqual({ "custom-2": "店番 2" });
    // Two filled slots carrying one name both take page names, which still avoid it.
    expect(
      Object.fromEntries(
        customSlotNames(
          labelled,
          slots,
          both,
          new Map([
            ["custom-1", "店番"],
            ["custom-2", "店番"],
          ]),
        ),
      ),
    ).toEqual({ "custom-1": "支店コード", "custom-2": "店番 2" });
  });

  it("carries a name on a page after the start page and stores it in the steps", () => {
    const result = validateGeneratedPage(
      labelled,
      slots,
      { fields: [{ slot: "custom-1", candidate: "branch" }], action },
      false,
      new Map([["custom-1", "店番"]]),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.fields).toEqual([{ slot: "custom-1", candidate: "branch", name: "店番" }]);
    expect(result.plan.steps[0]).toMatchObject({
      fields: [{ slot: "店番", target: { by: "id", value: "branch" } }],
    });
    expect(JSON.stringify(result.plan.steps)).not.toContain("支店番号");
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

  it("names a slot from its element in the first set that fills it, in every set", () => {
    const result = check([
      {
        fields: [
          { slot: "custom-4", candidate: "contract" },
          { slot: "custom-2", candidate: "user" },
        ],
        action,
      },
    ]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.alternatives![0]!.fields).toEqual([
      { slot: "custom-4", candidate: "contract", name: "契約番号" },
      { slot: "custom-2", candidate: "user", name: "account" },
    ]);
  });

  it("on a later page, names slots from the first set alone and drops the rest", () => {
    // An earlier field of the same name, which only the alternative fills.
    const later: LoginObservation = {
      ...page,
      candidates: [
        input("old", { label: "契約番号" }),
        ...page.candidates,
        input("passkey-login", { role: "button", label: "パスキーでログイン" }),
      ],
    };
    const draft: GeneratedPagePlan = {
      fields: [
        { slot: "custom-2", candidate: "contract" },
        { slot: "password", candidate: "password" },
      ],
      action,
      alternatives: [{ ...byContract, fields: [{ slot: "custom-4", candidate: "old" }] }],
      passkeyButton: "passkey-login",
    };
    const start = validateGeneratedPage(later, all, draft);
    if (!start.ok) throw new Error(start.reason);
    expect(start.plan.fields[0]).toEqual({
      slot: "custom-2",
      candidate: "contract",
      name: "契約番号 2",
    });
    expect(start.plan.alternatives).toHaveLength(1);
    expect(start.plan.passkeyButton).toBe("passkey-login");
    const next = validateGeneratedPage(later, all, draft, false);
    if (!next.ok) throw new Error(next.reason);
    expect(next.plan.fields[0]).toEqual({
      slot: "custom-2",
      candidate: "contract",
      name: "契約番号",
    });
    expect(next.plan.steps[0]).toMatchObject({
      fields: [{ slot: "契約番号" }, { slot: "password" }],
    });
    expect(next.plan).not.toHaveProperty("alternatives");
    expect(next.plan).not.toHaveProperty("passkeyButton");
    expect(next.plan).not.toHaveProperty("passkeyTarget");
    // The dropped alternatives are still checked.
    expect(
      validateGeneratedPage(
        later,
        all,
        {
          ...draft,
          alternatives: [{ fields: [{ slot: "custom-4", candidate: "nowhere" }], action }],
        },
        false,
      ),
    ).toEqual({ ok: false, reason: "unknown-candidate" });
  });

  it.each<[string, GeneratedPagePlan["alternatives"], string]>([
    [
      "an alternative that fails plan validation",
      [
        {
          ...byContract,
          fields: [{ slot: "custom-4", candidate: "nowhere" }],
        },
      ],
      "unknown-candidate",
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
            { slot: "custom-4", candidate: "branch" },
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
          { slot: "custom-1", candidate: "branch" },
          { slot: "custom-3", candidate: "pin" },
        ],
        action,
      },
      {
        fields: [
          { slot: "custom-2", candidate: "account" },
          { slot: "custom-4", candidate: "contract" },
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
          fields: [...primary.fields, { slot: "custom-4", candidate: "contract" }],
          action,
        },
      ]),
    ).toEqual({ ok: false, reason: "duplicate-variant" });
    // Two alternatives where the later one adds a field to the earlier one.
    expect(
      check([
        byContract,
        {
          fields: [...byContract.fields, { slot: "custom-3", candidate: "pin" }],
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
        { slot: "custom-4", candidate: "contract" },
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

  it("advances after an identifier alone, whatever the model answered", () => {
    for (const answered of ["submit", "advance"] as const)
      expect(purposeOf(emailOnly(emailPage, answered))).toEqual([
        "advance",
        {
          kind: "click",
          path: "/sign_in",
          target: { by: "id", value: "next" },
          purpose: "advance",
        },
      ]);
  });

  it("submits when the form also shows a password or code input the plan leaves empty", () => {
    for (const extra of [
      input("password", { role: "password" }),
      input("code", { role: "tel", maxLength: 6 }),
      input("otp", { autocomplete: "one-time-code" }),
    ]) {
      const page = { ...emailPage, candidates: [...emailPage.candidates, extra] };
      expect(purposeOf(emailOnly(page, "advance"))[0], extra.id).toBe("submit");
    }
  });

  it("advances when that input belongs to another form", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("email", { role: "email", group: "a" }),
        input("next", { role: "button", group: "a" }),
        input("password", { role: "password", group: "b" }),
      ],
    };
    expect(purposeOf(emailOnly(page, "submit"))[0]).toBe("advance");
  });

  it("counts inputs outside any form as one form, apart from a form's own", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("email", { role: "email" }),
        input("next", { role: "button" }),
        input("password", { role: "password", group: "b" }),
      ],
    };
    expect(purposeOf(emailOnly(page, "submit"))[0]).toBe("advance");
    const outside = {
      ...page,
      candidates: [...page.candidates, input("other", { role: "password" })],
    };
    expect(purposeOf(emailOnly(outside, "advance"))[0]).toBe("submit");
  });

  it("reads a later page's purpose from the set it keeps, once alternatives are dropped", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("email", { role: "email" }),
        input("phone", { role: "tel" }),
        input("next", { role: "button" }),
      ],
    };
    const result = validateGeneratedPage(
      page,
      [...slots, { ...branch, id: "custom-4", fieldName: "電話番号" }],
      {
        fields: [{ slot: "username", candidate: "email" }],
        action: { candidate: "next", purpose: "submit" },
        alternatives: [
          {
            fields: [{ slot: "custom-4", candidate: "phone" }],
            action: { candidate: "next", purpose: "submit" },
          },
        ],
      },
      false,
    );
    expect(purposeOf(result)).toEqual([
      "advance",
      { kind: "click", path: "/sign_in", target: { by: "id", value: "next" }, purpose: "advance" },
    ]);
  });

  it("advances after short numeric identifiers the plan fills itself", () => {
    const page: LoginObservation = {
      ...emailPage,
      candidates: [
        input("branch", { role: "tel", maxLength: 3 }),
        input("account", { role: "tel", maxLength: 7 }),
        input("next", { role: "button" }),
      ],
    };
    const result = validateGeneratedPage(page, slots, {
      fields: [
        { slot: "custom-1", candidate: "branch" },
        { slot: "custom-2", candidate: "account" },
      ],
      action: { candidate: "next", purpose: "submit" },
    });
    expect(purposeOf(result)[0]).toBe("advance");
  });

  it("submits after a password, a hidden value or a code, whatever the model answered", () => {
    const result = validateGeneratedPage(observation, slots, {
      fields: [
        { slot: "username", candidate: "user" },
        { slot: "password", candidate: "password" },
      ],
      action: { candidate: "login", purpose: "advance" },
    });
    expect(purposeOf(result)[0]).toBe("submit");
    const pinOnly = validateGeneratedPage(observation, slots, {
      fields: [{ slot: "custom-3", candidate: "pin" }],
      action: { candidate: "login", purpose: "advance" },
    });
    expect(purposeOf(pinOnly)[0]).toBe("submit");
  });

  it("keeps the model's purpose for a page with alternatives, where every set submits", () => {
    const result = validateGeneratedPage(observation, slots, {
      fields: [{ slot: "username", candidate: "user" }],
      action: { candidate: "login", purpose: "advance" },
      alternatives: [
        {
          fields: [
            { slot: "custom-1", candidate: "branch" },
            { slot: "custom-2", candidate: "account" },
          ],
          action: { candidate: "login", purpose: "submit" },
        },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "variant-advance" });
  });
});
