import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  builtInLoginSlots,
  customSlotIdSchema,
  loginObservationSchema,
  semanticSlotsSchema,
  isCodeField,
  showsBesideForm,
  showsCodeField,
  slotsForPage,
} from "./observation";

const base = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  title: "Sign in",
  candidates: [
    {
      id: "email",
      role: "email",
      target: { by: "id", value: "email" },
      label: "Email address",
      autocomplete: "username",
    },
    { id: "password", role: "password", target: { by: "id", value: "password" } },
    { id: "sign-in", role: "button", target: { by: "id", value: "sign-in" }, label: "Sign in" },
  ],
} as const;
const parse = (value: unknown) => v.safeParse(loginObservationSchema, value).success;

describe("observation contract", () => {
  it("carries sign-in and personal-data autocomplete tokens only", () => {
    const candidate = base.candidates[0]!;
    for (const autocomplete of ["username", "new-password", "off", "given-name", "tel", "bday"])
      expect(parse({ ...base, candidates: [{ ...candidate, autocomplete }] })).toBe(true);
    for (const autocomplete of ["cc-number", "webauthn", "shipping tel"])
      expect(parse({ ...base, candidates: [{ ...candidate, autocomplete }] })).toBe(false);
  });

  it("rejects values, oversized or control-character text and unsafe structure", () => {
    expect(parse(base)).toBe(true);
    const candidate = base.candidates[0]!;
    expect(parse({ ...base, candidates: [{ ...candidate, value: "synthetic" }] })).toBe(false);
    expect(parse({ ...base, candidates: [{ ...candidate, label: "x".repeat(121) }] })).toBe(false);
    for (const character of ["\u0000", "\u0085", "\u202e", "\u2028", "\u2029", "\u200b"])
      expect(parse({ ...base, candidates: [{ ...candidate, label: `a${character}b` }] })).toBe(
        false,
      );
    expect(parse({ ...base, candidates: [{ ...candidate, label: "会員ＩＤ（半角）" }] })).toBe(
      true,
    );
    expect(
      parse({
        ...base,
        candidates: [candidate, { ...candidate, target: { by: "id", value: "other" } }],
      }),
    ).toBe(false);
    expect(parse({ ...base, candidates: [candidate, { ...candidate, id: "other" }] })).toBe(false);
    const button = base.candidates[2]!;
    const text = { by: "text", value: "Sign in" };
    expect(parse({ ...base, candidates: [candidate, { ...button, target: text }] })).toBe(true);
    expect(parse({ ...base, candidates: [{ ...candidate, target: text }] })).toBe(false);
    // A link may be an account switch, located by its text.
    const link = { ...button, role: "link", target: { by: "text", value: "Use another account" } };
    expect(parse({ ...base, candidates: [candidate, link] })).toBe(true);
    // An autocomplete token names a field only.
    const token = { by: "autocomplete", value: "username" };
    expect(parse({ ...base, candidates: [{ ...candidate, target: token }] })).toBe(true);
    expect(parse({ ...base, candidates: [candidate, { ...button, target: token }] })).toBe(false);
    // So does a visible name (ADR 0037).
    const name = { by: "label", value: "Email address" };
    expect(parse({ ...base, candidates: [{ ...candidate, target: name }, button] })).toBe(true);
    expect(parse({ ...base, candidates: [candidate, { ...button, target: name }] })).toBe(false);
    expect(parse({ ...base, candidates: [candidate, { ...link, target: name }] })).toBe(false);
    // An accessible name names a button only (ADR 0048 amendment of 2026-10-19).
    const named = { by: "accessible-name", value: "Select Password." };
    expect(parse({ ...base, candidates: [candidate, { ...button, target: named }] })).toBe(true);
    expect(parse({ ...base, candidates: [candidate, { ...link, target: named }] })).toBe(false);
    expect(parse({ ...base, candidates: [{ ...candidate, target: named }, button] })).toBe(false);
    expect(parse({ ...base, path: "/login?next=/" })).toBe(false);
    expect(parse({ ...base, origin: "https://shop.example.test/login" })).toBe(false);
    expect(parse({ ...base, html: "<form></form>" })).toBe(false);
    expect(
      parse({
        ...base,
        candidates: Array.from({ length: 49 }, (_, index) => ({
          ...candidate,
          id: `c${index}`,
          target: { by: "id", value: `c${index}` },
        })),
      }),
    ).toBe(false);
  });

  it("rejects duplicate or unbounded slots", () => {
    const slot = { id: "password", kind: "secret", description: "account password" };
    expect(v.safeParse(semanticSlotsSchema, [slot]).success).toBe(true);
    expect(v.safeParse(semanticSlotsSchema, [slot, slot]).success).toBe(false);
    expect(v.safeParse(semanticSlotsSchema, []).success).toBe(false);
    expect(v.safeParse(semanticSlotsSchema, [{ ...slot, kind: "cookie" }]).success).toBe(false);
  });

  it("accepts value shapes only on identifier slots and in canonical form", () => {
    const shape = { length: 3, classes: ["ascii-digit"], email: false };
    const slot = { id: "branch", kind: "identifier", description: "bank branch number" };
    const accepts = (value: object) => v.safeParse(semanticSlotsSchema, [value]).success;
    expect(accepts({ ...slot, fieldName: "支店番号", valueShape: shape })).toBe(true);
    for (const kind of ["secret", "one-time-code"])
      expect(accepts({ ...slot, kind, valueShape: shape })).toBe(false);
    // Canonical order keeps the shape from revealing which class appears first.
    expect(
      accepts({ ...slot, valueShape: { ...shape, classes: ["ascii-letter", "ascii-digit"] } }),
    ).toBe(false);
    expect(
      accepts({ ...slot, valueShape: { ...shape, classes: ["ascii-digit", "ascii-digit"] } }),
    ).toBe(false);
    expect(accepts({ ...slot, valueShape: { ...shape, classes: [] } })).toBe(false);
    expect(accepts({ ...slot, valueShape: { ...shape, sample: "045" } })).toBe(false);
    expect(accepts({ ...slot, valueShape: { ...shape, length: 0 } })).toBe(false);
    expect(accepts({ ...slot, fieldName: "支店\u200b番号" })).toBe(false);
    expect(accepts({ ...slot, fieldName: "x".repeat(121) })).toBe(false);
  });

  it("bounds page input constraints", () => {
    const candidate = base.candidates[0]!;
    const withConstraints = (extra: object) =>
      parse({ ...base, candidates: [{ ...candidate, ...extra }] });
    expect(withConstraints({ maxLength: 7, minLength: 7, inputMode: "numeric" })).toBe(true);
    expect(withConstraints({ maxLength: 3, minLength: 4 })).toBe(false);
    expect(withConstraints({ maxLength: 0 })).toBe(false);
    expect(withConstraints({ maxLength: 1.5 })).toBe(false);
    expect(withConstraints({ inputMode: "kana" })).toBe(false);
    expect(withConstraints({ pattern: "[0-9]{3}" })).toBe(false);
    // Browsers ignore lengths on number inputs, and non-fill elements take no input.
    expect(withConstraints({ role: "number", maxLength: 3 })).toBe(false);
    expect(withConstraints({ role: "number", inputMode: "numeric" })).toBe(true);
    expect(withConstraints({ role: "button", maxLength: 3 })).toBe(false);
    expect(withConstraints({ role: "link", inputMode: "text" })).toBe(false);
  });

  it("takes descriptions only on fill roles, as bounded page text", () => {
    const candidate = base.candidates[0]!;
    const withDescription = (extra: object) =>
      parse({ ...base, candidates: [{ ...candidate, ...extra }] });
    expect(withDescription({ description: "半角数字3桁" })).toBe(true);
    expect(withDescription({ role: "number", description: "3 digits" })).toBe(true);
    expect(withDescription({ role: "button", description: "3 digits" })).toBe(false);
    expect(withDescription({ role: "checkbox", description: "3 digits" })).toBe(false);
    expect(withDescription({ description: "" })).toBe(false);
    expect(withDescription({ description: "x".repeat(121) })).toBe(false);
    expect(withDescription({ description: "a\u202eb" })).toBe(false);
  });

  it("bounds a signed-in page's header text at 1,000 characters (ADR 0029)", () => {
    expect(parse({ ...base, headerText: "Home [account] Settings" })).toBe(true);
    expect(parse({ ...base, headerText: "x".repeat(1000) })).toBe(true);
    expect(parse({ ...base, headerText: "x".repeat(1001) })).toBe(false);
    expect(parse({ ...base, headerText: "" })).toBe(false);
    expect(parse({ ...base, headerText: "a\nb" })).toBe(false);
  });

  it("takes up to three texts near a code field, only on a page with one (ADR 0027)", () => {
    const code = {
      ...base,
      candidates: [
        ...base.candidates,
        {
          id: "code",
          role: "text",
          target: { by: "id", value: "code" },
          autocomplete: "one-time-code",
        },
      ],
    };
    expect(parse({ ...code, nearCode: ["Enter the code from your authenticator app"] })).toBe(true);
    expect(parse({ ...code, nearCode: ["a", "b", "c"] })).toBe(true);
    expect(parse({ ...code, nearCode: ["a", "b", "c", "d"] })).toBe(false);
    expect(parse({ ...code, nearCode: [] })).toBe(false);
    expect(parse({ ...code, nearCode: ["x".repeat(121)] })).toBe(false);
    expect(parse({ ...code, nearCode: ["a\nb"] })).toBe(false);
    expect(parse({ ...base, nearCode: ["Enter the code"] })).toBe(false);
  });

  it("takes up to three texts near the buttons, only on a page with a button and no code field (ADR 0027)", () => {
    const verify =
      "To verify your credentials using FIDO Authenticator Security Key, click Verify.";
    expect(parse({ ...base, nearButtons: [verify] })).toBe(true);
    expect(parse({ ...base, nearButtons: ["a", "b", "c"] })).toBe(true);
    expect(parse({ ...base, nearButtons: ["x".repeat(120)] })).toBe(true);
    expect(parse({ ...base, nearButtons: ["a", "b", "c", "d"] })).toBe(false);
    expect(parse({ ...base, nearButtons: [] })).toBe(false);
    expect(parse({ ...base, nearButtons: ["x".repeat(121)] })).toBe(false);
    expect(parse({ ...base, nearButtons: ["a\nb"] })).toBe(false);
    expect(parse({ ...base, nearButtons: [""] })).toBe(false);
    // A page with a code field carries the texts near it instead, with or without them.
    const code = {
      ...base,
      candidates: [
        ...base.candidates,
        {
          id: "code",
          role: "text",
          target: { by: "id", value: "code" },
          autocomplete: "one-time-code",
        },
      ],
    };
    expect(parse({ ...code, nearButtons: [verify] })).toBe(false);
    expect(parse({ ...code, nearCode: [verify], nearButtons: [verify] })).toBe(false);
    // A page without a button carries none, even one with links.
    const withoutButton = base.candidates.filter((candidate) => candidate.role !== "button");
    expect(parse({ ...base, candidates: withoutButton })).toBe(true);
    expect(parse({ ...base, candidates: withoutButton, nearButtons: [verify] })).toBe(false);
    expect(
      parse({
        ...base,
        candidates: [
          ...withoutButton,
          { id: "help", role: "link", target: { by: "text", value: "Help" }, label: "Help" },
        ],
        nearButtons: [verify],
      }),
    ).toBe(false);
  });
});

describe("account lists (ADR 0028)", () => {
  it("allows no candidates only with an account list of 1 to 8 texts", () => {
    const list = { ...base, candidates: [] };
    expect(parse({ ...list, accounts: ["Taro [email] Last used"] })).toBe(true);
    expect(parse(list)).toBe(false);
    expect(parse({ ...list, accounts: [] })).toBe(false);
    expect(parse({ ...list, accounts: Array.from({ length: 9 }, () => "[email]") })).toBe(false);
    expect(parse({ ...list, accounts: ["x".repeat(121)] })).toBe(false);
  });

  it("counts account entries only within the list of accounts", () => {
    const list = { ...base, candidates: [], accounts: ["[email]", "Taro [masked]"] };
    for (const accountEntries of [0, 1, 2]) expect(parse({ ...list, accountEntries })).toBe(true);
    expect(parse({ ...list, accountEntries: 3 })).toBe(false);
    expect(parse({ ...list, accountEntries: -1 })).toBe(false);
    expect(parse({ ...list, accountEntries: 1.5 })).toBe(false);
    expect(parse({ ...base, accountEntries: 0 })).toBe(false);
    expect(parse({ ...base, accountEntries: 1 })).toBe(false);
    expect(parse({ ...base, accounts: ["[email]"], accountEntries: 1 })).toBe(true);
  });
});

describe("code fields on a generated page (ADR 0027)", () => {
  const field = (extra: object) => ({
    candidates: [
      ...base.candidates,
      { id: "code", role: "text", target: { by: "id", value: "code" }, ...extra },
    ],
  });
  const slots = Object.values(builtInLoginSlots);

  it.each([
    ["autocomplete=one-time-code", { autocomplete: "one-time-code" }],
    ["a tel input of 6", { role: "tel", maxLength: 6 }],
    ["a numeric text input of 6", { inputMode: "numeric", maxLength: 6 }],
    ["a numeric text input of 10", { inputMode: "numeric", maxLength: 10 }],
    ["a number input marked one-time-code", { role: "number", autocomplete: "one-time-code" }],
  ])("offers totp for a page with %s", (_label, extra) => {
    const page = field(extra);
    expect(parse({ ...base, ...page })).toBe(true);
    expect(showsCodeField(page as never)).toBe(true);
    expect(isCodeField(page.candidates.at(-1) as never)).toBe(true);
    expect(slotsForPage(page as never, slots)).toEqual(slots);
  });

  it.each([
    ["only a sign-in form", {}],
    ["a text input of 6", { maxLength: 6 }],
    ["a numeric text input without a length", { inputMode: "numeric" }],
    ["a tel input of 20", { role: "tel", maxLength: 20 }],
    ["a tel input without a length", { role: "tel" }],
    ["a numeric text input of 11", { inputMode: "numeric", maxLength: 11 }],
    // The executor needs a length of 1 to 10, which observations omit on number inputs.
    ["a number input without the hint", { role: "number" }],
  ])("drops totp for a page with %s", (_label, extra) => {
    const page = field(extra);
    expect(parse({ ...base, ...page })).toBe(true);
    expect(showsCodeField(page as never)).toBe(false);
    expect(isCodeField(page.candidates.at(-1) as never)).toBe(false);
    expect(slotsForPage(page as never, slots)).toEqual([
      builtInLoginSlots.username,
      builtInLoginSlots.password,
    ]);
  });

  it("judges each element on its own, as the executor's TOTP fill rule does", () => {
    const candidate = (extra: object) =>
      ({ id: "x", role: "text", target: { by: "id", value: "x" }, ...extra }) as never;
    // The bounds of the length rule.
    expect(isCodeField(candidate({ inputMode: "numeric", maxLength: 1 }))).toBe(true);
    expect(isCodeField(candidate({ role: "tel", maxLength: 10 }))).toBe(true);
    expect(isCodeField(candidate({ role: "tel", maxLength: 11 }))).toBe(false);
    // The hint alone counts, on any input the executor fills.
    expect(isCodeField(candidate({ role: "password", autocomplete: "one-time-code" }))).toBe(true);
    expect(isCodeField(candidate({ autocomplete: "current-password", maxLength: 6 }))).toBe(false);
    // One code field among other inputs makes the page show one.
    const page = {
      candidates: [
        candidate({}),
        candidate({
          id: "y",
          inputMode: "numeric",
          maxLength: 6,
          target: { by: "id", value: "y" },
        }),
      ],
    };
    expect(showsCodeField(page)).toBe(true);
    expect(showsCodeField({ candidates: [] })).toBe(false);
  });

  it("keeps every other slot, including custom ones, and may leave none", () => {
    const page = field({});
    const branch = { id: "branch", kind: "identifier", description: "bank branch number" } as const;
    expect(slotsForPage(page as never, [branch, builtInLoginSlots.totp])).toEqual([branch]);
    expect(slotsForPage(page as never, [builtInLoginSlots.totp])).toEqual([]);
  });
});

describe("custom-field slots (ADR 0027)", () => {
  const custom = (extra: object = {}) => ({
    id: "custom-1",
    kind: "identifier",
    description: "value of the user's vault field named in fieldName",
    fieldName: "Branch number",
    ...extra,
  });
  const accepts = (slots: object[]) => v.safeParse(semanticSlotsSchema, slots).success;

  it("accepts a hidden slot but never a shape on it", () => {
    expect(accepts([custom({ kind: "hidden", fieldName: "PIN" })])).toBe(true);
    const shape = { length: 4, classes: ["ascii-digit"], email: false };
    expect(accepts([custom({ kind: "hidden", fieldName: "PIN", valueShape: shape })])).toBe(false);
  });

  it("allows a field position only with a field name, a count of 2 or more and a position within it", () => {
    expect(accepts([custom({ fieldPosition: { position: 2, count: 2 } })])).toBe(true);
    expect(accepts([custom({ fieldPosition: { position: 1, count: 1000 } })])).toBe(true);
    for (const fieldPosition of [
      { position: 1, count: 1 },
      { position: 3, count: 2 },
      { position: 0, count: 2 },
      { position: 1.5, count: 2 },
      { position: 1, count: 1001 },
      { position: 1 },
      { position: 1, count: 2, index: 0 },
    ])
      expect(accepts([custom({ fieldPosition })])).toBe(false);
    const { fieldName: _name, ...unnamed } = custom();
    expect(accepts([{ ...unnamed, fieldPosition: { position: 1, count: 2 } }])).toBe(false);
  });

  it("allows up to 20 slots", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        custom({ id: `custom-${index + 1}`, fieldName: `Field ${index + 1}` }),
      );
    expect(accepts(many(20))).toBe(true);
    expect(accepts(many(21))).toBe(false);
  });

  it("refuses two slots that name the same vault field", () => {
    const second = { id: "custom-2" };
    expect(accepts([custom(), custom({ ...second, fieldName: "Branch" })])).toBe(true);
    expect(accepts([custom(), custom(second)])).toBe(false);
    // Positions tell same-name fields apart; the same position twice does not.
    const at = (position: number) => ({ fieldPosition: { position, count: 2 } });
    expect(accepts([custom(at(1)), custom({ ...second, ...at(2) })])).toBe(true);
    expect(accepts([custom(at(1)), custom({ ...second, ...at(1) })])).toBe(false);
    expect(accepts([custom(), custom({ ...second, ...at(1) })])).toBe(true);
    // Slots without a field name never clash with each other.
    expect(accepts([builtInLoginSlots.username, builtInLoginSlots.password])).toBe(true);
  });

  it.each([
    ["branch-number", true],
    ["店番号", true],
    ["会員番号 (ログインID)", true],
    ["Enter your Security number", true],
    ["欄 1", true],
    ["brchNum", true],
    ["custom-1", true],
    ["Password 2", true],
    ["", false],
    [" 店番号", false],
    ["店番号 ", false],
    ["店番  号", false],
    ["店番\u3000号", false],
    ["店番\t号", false],
    ["店番\n号", false],
    ["店番\u200b号", false],
    ["\u202e店番号", false],
    ["店番\u034f号", false],
    ["店番号\ufe0f", false],
    ["\u1160", false],
    ["店番\u115f号", false],
    ["Ｂｒａｎｃｈ", false],
    ["ｺｰﾄﾞ", false],
    ["username", false],
    ["Password", false],
    ["TOTP", false],
  ])("treats %j as a custom slot ID: %s", (value, valid) => {
    expect(v.is(customSlotIdSchema, value)).toBe(valid);
  });

  it("bounds a slot ID at 60 characters", () => {
    expect(v.is(customSlotIdSchema, "店".repeat(60))).toBe(true);
    expect(v.is(customSlotIdSchema, "店".repeat(61))).toBe(false);
  });
});

// ADR 0061: a sign-in sidebar left shown behind a lightbox form that asks for a detail.
// Synthetic page, shaped like a card site's.
describe("a form beside the sign-in form (ADR 0061)", () => {
  const id = (value: string) => ({ by: "id", value }) as const;
  const sidebar = [
    { id: "c1", role: "text", target: id("user"), group: "side" },
    { id: "c2", role: "password", target: id("pw"), group: "side" },
    { id: "c3", role: "button", target: id("login"), group: "side" },
  ] as const;
  const lightbox = [
    { id: "c4", role: "text", target: id("birth"), group: "box", maxLength: 6 },
    { id: "c5", role: "tel", target: id("phone"), group: "box", maxLength: 4 },
    { id: "c6", role: "button", target: id("submit"), group: "box" },
  ] as const;
  const fills = [id("user"), id("pw")];
  const page = (candidates: readonly object[]) =>
    v.parse(loginObservationSchema, { ...base, candidates });

  it("finds a text-like input with its own button in another form", () => {
    expect(showsBesideForm(page([...sidebar, ...lightbox]), fills)).toBe(true);
    // A number input counts as a text-like one.
    expect(
      showsBesideForm(
        page([
          ...sidebar,
          { id: "c4", role: "number", target: id("birth"), group: "box" },
          lightbox[2],
        ]),
        fills,
      ),
    ).toBe(true);
  });

  it("needs a route fill field shown, another form, a text-like input and its button", () => {
    // No fill field of the route shows.
    expect(showsBesideForm(page(lightbox), fills)).toBe(false);
    // The other inputs are in the sign-in form.
    expect(
      showsBesideForm(
        page([...sidebar, ...lightbox.map((entry) => ({ ...entry, group: "side" }))]),
        fills,
      ),
    ).toBe(false);
    // Nor when one fill field of the route is in that form too.
    expect(
      showsBesideForm(page([sidebar[0], { ...sidebar[1], group: "box" }, ...lightbox]), fills),
    ).toBe(false);
    // Nor without a button of that form.
    expect(showsBesideForm(page([...sidebar, lightbox[0], lightbox[1]]), fills)).toBe(false);
    // Nor with only a password input there, nor with inputs outside any form.
    expect(
      showsBesideForm(page([...sidebar, { ...lightbox[0], role: "password" }, lightbox[2]]), fills),
    ).toBe(false);
    expect(
      showsBesideForm(
        page([
          ...sidebar,
          { id: "c4", role: "text", target: id("birth") },
          { id: "c6", role: "button", target: id("submit") },
        ]),
        fills,
      ),
    ).toBe(false);
    // A route fill field is never the other form's input.
    expect(
      showsBesideForm(page([sidebar[1], { ...sidebar[0], group: "box" }, lightbox[2]]), fills),
    ).toBe(false);
  });
});
