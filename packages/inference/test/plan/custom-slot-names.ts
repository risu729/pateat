import type { LoginObservation } from "@pateat/contracts";
import { customSlotNames, validatePagePlan } from "../../src/plan";
import { expect, it } from "vitest";
import type { Candidate, PlanTestFixtures } from "../../src/plan.test";

type NameOf = (
  extra: Partial<Candidate>,
  page?: Partial<LoginObservation>,
  others?: Candidate[],
) => ReturnType<ReturnType<typeof customSlotNames>["get"]>;

export function registerCustomSlotStorage({
  observation,
  slots,
  action,
}: {
  observation: PlanTestFixtures["observation"];
  slots: PlanTestFixtures["slots"];
  action: PlanTestFixtures["action"];
}) {
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
}

export function registerCustomSlotNames({
  nameOf,
  observation,
  slots,
  input,
  branch,
  account,
}: {
  nameOf: NameOf;
  observation: PlanTestFixtures["observation"];
  slots: PlanTestFixtures["slots"];
  input: PlanTestFixtures["input"];
  branch: PlanTestFixtures["branch"];
  account: PlanTestFixtures["account"];
}) {
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
}
