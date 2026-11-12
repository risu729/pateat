import type { LoginObservation, SemanticSlot } from "@pateat/contracts";
import { validateGeneratedPage, type GeneratedPagePlan, type PagePlan } from "../../src/plan";
import { expect, it } from "vitest";
import type { PlanTestFixtures } from "../../src/plan.test";

type Check = (
  alternatives: GeneratedPagePlan["alternatives"],
  change?: Partial<PagePlan>,
) => ReturnType<typeof validateGeneratedPage>;

export function registerIdentifierSets({
  check,
  page,
  all,
  primary,
  byContract,
  input,
  action,
}: {
  check: Check;
  page: LoginObservation;
  all: SemanticSlot[];
  primary: GeneratedPagePlan;
  byContract: Pick<PagePlan, "fields"> & { action: PlanTestFixtures["action"] };
  input: PlanTestFixtures["input"];
  action: PlanTestFixtures["action"];
}) {
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
}
