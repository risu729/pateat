import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { loginStepSchema } from "./login/targets";
import { splitIdentifier, splitMismatch } from "./login/split";
import { loginObservationSchema } from "./observation";

// An identifier split over several inputs (ADR 0089): the value's parts, the recipe's fill
// field and the login page's mark. Synthetic values only.
describe("splitIdentifier", () => {
  const boxes = [4, 4, 5];

  it("takes out spaces and hyphens, then gives each box its length and the last the rest", () => {
    expect(splitIdentifier("1234-5678-12345", boxes)).toEqual(["1234", "5678", "12345"]);
    expect(splitIdentifier("1234567812345", boxes)).toEqual(["1234", "5678", "12345"]);
    expect(splitIdentifier("1234 5678 1234", boxes)).toEqual(["1234", "5678", "1234"]);
    expect(splitIdentifier("12345678 1", boxes)).toEqual(["1234", "5678", "1"]);
  });

  it("folds full-width digits, hyphens and spaces, and keeps letters", () => {
    expect(splitIdentifier("１２３４－５６７８\u3000１２３４５", boxes)).toEqual([
      "1234",
      "5678",
      "12345",
    ]);
    expect(splitIdentifier("1234\u20135678\u221212345", boxes)).toEqual(["1234", "5678", "12345"]);
    expect(splitIdentifier("AB12-CD34", [4, 4])).toEqual(["AB12", "CD34"]);
  });

  it("fits nothing too long, too short or empty", () => {
    expect(splitIdentifier("1234-5678-123456", boxes)).toBeUndefined();
    expect(splitIdentifier("1234-5678", boxes)).toBeUndefined();
    expect(splitIdentifier("1234-567", boxes)).toBeUndefined();
    expect(splitIdentifier(" - ", boxes)).toBeUndefined();
    expect(splitMismatch("1234-5678-123456", boxes)).toBe("too-long");
    expect(splitMismatch("1234-5678", boxes)).toBe("too-short");
    expect(splitMismatch("", boxes)).toBe("missing-value");
    expect(splitMismatch(undefined, boxes)).toBe("missing-value");
    expect(splitMismatch("1234-5678-1", boxes)).toBeUndefined();
  });
});

describe("a split fill field", () => {
  const fill = (field: Record<string, unknown>, effect?: "advance") =>
    v.safeParse(loginStepSchema, {
      kind: "fill",
      path: "/login",
      fields: [{ slot: "username", target: { by: "name", value: "number1" }, ...field }],
      ...(effect ? { effect, event: "input" } : {}),
    }).success;

  it("names 2 to 6 parts of 2 to 8 characters", () => {
    expect(fill({ split: [4, 4, 5] })).toBe(true);
    expect(fill({ split: [2, 8] })).toBe(true);
    expect(fill({ split: [3, 3, 3, 3, 3, 3] })).toBe(true);
    for (const split of [[4], [], [1, 4], [4, 9], [3, 3, 3, 3, 3, 3, 3], [4.5, 4], ["4", "4"]])
      expect(fill({ split })).toBe(false);
  });

  it("is never entered on a keypad or by an effectful fill", () => {
    expect(fill({ split: [4, 4], keypad: { by: "id", value: "pad" } })).toBe(false);
    expect(fill({ split: [4, 4] }, "advance")).toBe(false);
    expect(fill({}, "advance")).toBe(true);
  });
});

describe("a split part's mark on a login page", () => {
  const part = (at: number, extra: Record<string, unknown> = {}) => ({
    id: `c${at}`,
    role: "text",
    target: { by: "name", value: `number${at}` },
    maxLength: at === 3 ? 5 : 4,
    group: "f1",
    split: { group: "s1", part: at, of: 3 },
    ...extra,
  });
  const page = (candidates: unknown[]) =>
    v.safeParse(loginObservationSchema, {
      version: 1,
      origin: "https://bank.example.test",
      path: "/login",
      language: "ja",
      complete: true,
      candidates: [
        ...candidates,
        { id: "next", role: "button", target: { by: "id", value: "next" }, group: "f1" },
      ],
    }).success;

  it("holds each part once, in order, in one form", () => {
    expect(page([part(1), part(2), part(3)])).toBe(true);
    expect(page([part(1), part(2)])).toBe(false);
    expect(page([part(2), part(1), part(3)])).toBe(false);
    expect(page([part(1), part(2), part(3, { group: "f2" })])).toBe(false);
    expect(page([part(1), part(2), part(3, { split: { group: "s1", part: 3, of: 4 } })])).toBe(
      false,
    );
  });

  it("marks only text and tel fields of 2 to 8 characters", () => {
    expect(page([part(1, { role: "tel" }), part(2), part(3)])).toBe(true);
    expect(page([part(1, { role: "password" }), part(2), part(3)])).toBe(false);
    expect(page([part(1, { maxLength: 1 }), part(2), part(3)])).toBe(false);
    expect(page([part(1, { maxLength: undefined }), part(2), part(3)])).toBe(false);
    expect(page([part(1, { split: { group: "s1", part: 1, of: 7 } })])).toBe(false);
  });
});
