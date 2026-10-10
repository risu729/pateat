import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { valueShapeSchema, type LoginObservation } from "./observation";
import { checkPlanValues, valueShapeOf } from "./values";

const page = (id: string) => evaluationCorpus.find((entry) => entry.id === id)!;

describe("value shapes", () => {
  it("describes length, classes and email form without characters", () => {
    expect(valueShapeOf("045")).toEqual({ length: 3, classes: ["ascii-digit"], email: false });
    expect(valueShapeOf("user.01@shop.example.test")).toEqual({
      length: 25,
      classes: ["ascii-digit", "ascii-letter", "ascii-symbol"],
      email: true,
    });
    expect(valueShapeOf("会員ＡＢ１　x")).toEqual({
      length: 7,
      classes: ["ascii-letter", "fullwidth", "space", "other"],
      email: false,
    });
    expect(valueShapeOf("")).toBeUndefined();
    expect(valueShapeOf("x".repeat(1025))).toBeUndefined();
    for (const value of ["045", "user.01@shop.example.test", "Sato-7"]) {
      const shape = valueShapeOf(value)!;
      expect(v.safeParse(valueShapeSchema, shape).success).toBe(true);
      expect(JSON.stringify(shape)).not.toContain(value);
    }
  });

  it("keeps the corpus values consistent with their slot shapes", () => {
    for (const entry of evaluationCorpus) {
      for (const slot of entry.slots) {
        if (slot.valueShape === undefined) continue;
        expect(valueShapeOf(entry.values?.[slot.id] ?? ""), `${entry.id}/${slot.id}`).toEqual(
          slot.valueShape,
        );
      }
    }
  });
});

describe("local value check", () => {
  const bank = page("ja-bank-unlabeled-lengths");
  const values = new Map(Object.entries(bank.values!));

  it("accepts the ground-truth mapping and rejects a swapped one", () => {
    expect(
      checkPlanValues(
        bank.observation,
        {
          fields: [
            { slot: "branch-number", candidate: "field-b" },
            { slot: "account-number", candidate: "field-a" },
            { slot: "password", candidate: "field-c" },
          ],
        },
        values,
      ),
    ).toEqual({ ok: true });
    expect(
      checkPlanValues(
        bank.observation,
        {
          fields: [
            { slot: "branch-number", candidate: "field-a" },
            { slot: "account-number", candidate: "field-b" },
          ],
        },
        values,
      ),
    ).toEqual({ ok: false, slot: "account-number", reason: "too-long" });
  });

  it("applies the browser's length, email and number rules", () => {
    const observation: LoginObservation = {
      ...bank.observation,
      candidates: [
        { id: "mail", role: "email", target: { by: "id", value: "mail" } },
        { id: "num", role: "number", target: { by: "id", value: "num" } },
        { id: "code", role: "tel", target: { by: "id", value: "code" }, minLength: 6 },
        { id: "go", role: "button", target: { by: "id", value: "go" } },
      ],
    };
    const check = (candidate: string, value: string | undefined) =>
      checkPlanValues(
        observation,
        { fields: [{ slot: "s", candidate }] },
        new Map(value === undefined ? [] : [["s", value]]),
      );
    expect(check("mail", "user@shop.example.test")).toEqual({ ok: true });
    expect(check("mail", "sato-7")).toEqual({ ok: false, slot: "s", reason: "not-email" });
    expect(check("num", "0123")).toEqual({ ok: true });
    expect(check("num", "１２３")).toEqual({ ok: false, slot: "s", reason: "not-number" });
    expect(check("code", "12345")).toEqual({ ok: false, slot: "s", reason: "too-short" });
    expect(check("code", "123456")).toEqual({ ok: true });
    expect(check("code", undefined)).toEqual({ ok: false, slot: "s", reason: "missing-value" });
    expect(check("code", "")).toEqual({ ok: false, slot: "s", reason: "missing-value" });
    expect(() => check("unknown", "1")).toThrow();
  });
});
