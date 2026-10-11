import {
  builtInLoginSlots,
  customFieldSlotDescriptions,
  type LoginObservation,
  type SemanticSlot,
} from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { slotAccepts, validatePagePlan, type PagePlan } from "./plan";

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
    ["upper case", "Branch"],
    ["a built-in slot", "password"],
    ["another requested slot's ID", "username"],
    ["five words", "the-bank-branch-number-code"],
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
    expect(slotAccepts("one-time-code", input("x", { role: "number" }))).toBe(true);
  });
});
