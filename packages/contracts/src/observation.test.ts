import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { loginObservationSchema, semanticSlotsSchema } from "./observation";

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
});
