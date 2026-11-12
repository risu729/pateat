import type { LoginObservation, SavedLoginBinding, SemanticSlot } from "@pateat/contracts";
import { carriedSlotNames, customSlotNames, validateGeneratedPage } from "../../src/plan";
import { expect, it } from "vitest";
import type { PlanTestFixtures } from "../../src/plan.test";

type Binding = (
  ...entries: [string, SavedLoginBinding["slots"][number]["field"]][]
) => Pick<SavedLoginBinding, "slots">;

export function registerSavedBindingMatches({
  requested,
  binding,
}: {
  requested: SemanticSlot[];
  binding: Binding;
}) {
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
}

export function registerCarriedSlotNames({
  labelled,
  slots,
  both,
  action,
}: {
  labelled: LoginObservation;
  slots: PlanTestFixtures["slots"];
  both: Parameters<typeof customSlotNames>[2];
  action: PlanTestFixtures["action"];
}) {
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
}
