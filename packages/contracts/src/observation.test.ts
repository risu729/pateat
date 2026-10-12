import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  builtInLoginSlots,
  genericSlotIdSchema,
  loginObservationSchema,
  semanticSlotsSchema,
  isCodeField,
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
    ["branch", true],
    ["branch-number", true],
    ["store-branch-code-id", true],
    ["store-branch-code-id-x", false],
    ["store-branch-code-ids-extra", false],
    ["a", false],
    ["branch-n", false],
    ["Branch-number", false],
    ["branch_number", false],
    ["branch--number", false],
    ["-branch", false],
    ["branch-", false],
    ["branch2", false],
    ["account-number-1234", false],
    ["支店番号", false],
    ["username", false],
    ["password", false],
    ["totp", false],
    ["user-name", true],
    ["", false],
  ])("treats %j as a generic slot ID: %s", (value, valid) => {
    expect(v.is(genericSlotIdSchema, value)).toBe(valid);
  });

  it("bounds a generic slot ID at 40 characters", () => {
    const words = (length: number) =>
      ["a".repeat(length - 30), "b".repeat(9), "c".repeat(9), "d".repeat(9)].join("-");
    expect(words(40)).toHaveLength(40);
    expect(v.is(genericSlotIdSchema, words(40))).toBe(true);
    expect(v.is(genericSlotIdSchema, words(41))).toBe(false);
  });
});
