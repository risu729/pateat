import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const {
  start,
  offer,
  get,
  pick,
  stale,
  repairedRecipe,
  snapshotId,
  target,
  liveItemPolicy,
  itemId,
} = bindingReviewFixture(fake);

describe("binding repair candidate boundaries", () => {
  it.each([false, true])(
    "offers a Linked field only while its resolved builtin source is allowed (excluded=%s)",
    async (excluded) => {
      const h = start(
        {
          username: true,
          custom: [{ name: "Linked account", kind: "linked", linkedFieldId: "login.username" }],
        },
        excluded
          ? { itemPolicies: [liveItemPolicy(itemId, { excludedFields: ["login.username"] })] }
          : {},
      );
      const review = await offer(h);
      expect(review.slots[0]!.candidates).toEqual(
        excluded ? [] : [{ fieldId: `custom.${snapshotId}.0`, name: "Linked account" }],
      );
      expect(h.fields).not.toHaveBeenCalled();
    },
  );

  it("offers only a TOTP seed to a code slot", async () => {
    const h = start(
      {
        custom: [
          { name: "Ordinary text", kind: "text" },
          { name: "New code seed", kind: "hidden", totpSeed: true },
        ],
      },
      { bindings: [{ ...stale, slots: [{ slot: "totp", field: { custom: "Old seed" } }] }] },
    );
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...repairedRecipe,
        slots: ["totp"],
        steps: [
          { kind: "fill", path: "/signin", fields: [{ slot: "totp", target: target("code") }] },
          repairedRecipe.steps[1],
        ],
      }),
    );
    const review = await offer(h);
    expect(review.slots[0]!.candidates).toEqual([
      { fieldId: `custom.${snapshotId}.1`, name: "New code seed" },
    ]);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("offers every stale custom slot and requires exactly one choice for each", async () => {
    const binding = {
      ...stale,
      slots: [...stale.slots, { slot: "account", field: { custom: "Old account" } }],
    };
    const h = start({}, { bindings: [binding] });
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...repairedRecipe,
        slots: ["branch", "account", "password"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "branch", target: target("branch") },
              { slot: "account", target: target("account") },
              { slot: "password", target: target("password") },
            ],
          },
          repairedRecipe.steps[1],
        ],
      }),
    );
    const review = await offer(h);
    expect(review.slots.map((slot) => slot.slot)).toEqual(["branch", "account"]);
    expect(
      await pick(h, review, [{ slot: "branch", fieldId: review.slots[0]!.candidates[0]!.fieldId }]),
    ).toEqual({ ok: false, reason: "not-a-candidate" });
    expect(
      await pick(h, review, [
        { slot: "branch", fieldId: review.slots[0]!.candidates[0]!.fieldId },
        { slot: "branch", fieldId: review.slots[0]!.candidates[0]!.fieldId },
      ]),
    ).toEqual({ ok: false, reason: "not-a-candidate" });
    expect(h.fields).not.toHaveBeenCalled();
  });

  it.each([
    [{ custom: "Branch" }, "field-ambiguous"],
    [{ custom: "Branch", position: 1, count: 3 }, "field-count-changed"],
  ] as const)(
    "repairs an ambiguous or count-changed reference %j with names and positions",
    async (field, reason) => {
      const h = start(
        {
          custom: [
            { name: "Branch", kind: "text" },
            { name: "Branch", kind: "hidden" },
          ],
        },
        { bindings: [{ ...stale, slots: [{ slot: "branch", field }, stale.slots[1]!] }] },
      );
      expect(await h.hello()).toEqual({ ok: false, reason });
      const review = (await get(h)).repair!;
      expect(review.slots).toEqual([
        {
          slot: "branch",
          name: "Branch",
          reason,
          candidates: [
            { fieldId: `custom.${snapshotId}.0`, name: "Branch (1/2)" },
            { fieldId: `custom.${snapshotId}.1`, name: "Branch (2/2)" },
          ],
        },
      ]);
    },
  );

  it("omits unnamed, reserved SSO, TOTP-seed and unresolved linked fields from a text slot", async () => {
    const h = start({
      custom: [
        { name: null, kind: "text" },
        { name: "", kind: "hidden" },
        { name: " ＳＳＯ ２ ", kind: "text" },
        { name: "Code seed", kind: "hidden", totpSeed: true },
        { name: "Unknown source", kind: "linked", linkedFieldId: "unknown" },
        { name: "Allowed", kind: "hidden" },
      ],
    });
    const review = await offer(h);
    expect(review.slots[0]!.candidates).toEqual([
      { fieldId: `custom.${snapshotId}.5`, name: "Allowed" },
    ]);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it.each(["missing-slot", "broken-builtin"])(
    "does not offer custom repair alongside %s",
    async (kind) => {
      const binding = {
        ...stale,
        slots:
          kind === "missing-slot"
            ? [stale.slots[0]!]
            : [stale.slots[0]!, { slot: "password", field: "username" as const }],
      };
      const h = start({}, { bindings: [binding] });
      expect(await h.hello()).toMatchObject({ ok: false });
      expect((await get(h)).repair).toBeUndefined();
      expect(h.fields).not.toHaveBeenCalled();
    },
  );
});
