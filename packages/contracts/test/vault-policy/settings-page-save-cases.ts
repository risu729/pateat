import { expect, it } from "vitest";
import {
  getItemEligibility,
  isFieldExcluded,
  type CustomFieldReview,
  type LocalSettings,
} from "../../src/settings";
import { createSettingsStore } from "../../src/settings-store";
import type { VaultPolicyTestFixtures } from "../../src/vault-policy.test";

export function registerSettingsPageSaveTests({
  memoryStorage,
  settings,
  catalog,
  itemPolicy,
  review,
  evidence,
  item,
  custom,
  snapshotId,
  save,
}: VaultPolicyTestFixtures) {
  const pin = { custom: "PIN", position: 2, count: 3 } as const;
  const stored = (value: LocalSettings) =>
    memoryStorage({ version: 1, revision: 3, settings: value });
  const storeFor = (memory: ReturnType<typeof memoryStorage>, live = catalog()) =>
    createSettingsStore(memory.storage, live);

  it("keeps the stored review records, whatever the page sends", async () => {
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: [pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory);
    const sent = (revision: number, customFieldReviews: CustomFieldReview[]) =>
      store.handle(
        save(
          revision,
          settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })], customFieldReviews }),
        ),
      );
    // Saves are queued in order, so each one names the revision the previous one wrote.
    const responses = await Promise.all([
      sent(3, []),
      sent(4, [review({ evidence: evidence("c") })]),
      sent(5, [review(), review({ itemId: "item-2" })]),
    ]);
    expect(responses).toMatchObject([
      { ok: true, snapshot: { revision: 4, settings: { customFieldReviews: [review()] } } },
      { ok: true, snapshot: { revision: 5, settings: { customFieldReviews: [review()] } } },
      { ok: true, snapshot: { revision: 6, settings: { customFieldReviews: [review()] } } },
    ]);
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
  });

  it("keeps the stored custom-field exclusions of an item waiting for review", async () => {
    const blocked = catalog([
      item({ evidence: evidence("b"), revisionDate: "2026-10-12T00:00:00Z" }),
    ]);
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: ["login.password", pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory, blocked);
    // Built-in exclusions change; custom ones are restored, and a new one is not added.
    const response = await store.handle(
      save(
        3,
        settings({
          itemPolicies: [
            itemPolicy({
              selected: true,
              excludedFields: ["login.username", { custom: "Branch", position: 1, count: 1 }],
            }),
          ],
        }),
      ),
    );
    expect(response).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies).toEqual([
      itemPolicy({ selected: true, excludedFields: ["login.username", pin] }),
    ]);
    // Removing the item's policy keeps an entry with its custom exclusions only.
    expect(await store.handle(save(4, settings()))).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies).toEqual([itemPolicy({ excludedFields: [pin] })]);
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
  });

  it("keeps the stored custom-field exclusions of an item waiting for a vault sync", async () => {
    const stale = catalog([
      item({ evidence: evidence("b"), revisionDate: "2026-01-01T00:00:00Z" }),
    ]);
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: [pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory, stale);
    expect(
      await store.handle(save(3, settings({ itemPolicies: [itemPolicy({ excluded: true })] }))),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies).toEqual([
      itemPolicy({ excluded: true, excludedFields: [pin] }),
    ]);
  });

  it("records the current evidence when an item gains its first custom-field exclusion", async () => {
    const memory = stored(settings());
    const store = storeFor(memory);
    expect(
      await store.handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] })),
      ),
    ).toMatchObject({ ok: true, snapshot: { revision: 4 } });
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
    // The item is reviewed and its exclusion applies.
    expect(getItemEligibility(memory.value!.settings, catalog(), "vault", "item-1")).toMatchObject({
      eligible: true,
    });
    expect(isFieldExcluded(memory.value!.settings, catalog(), "vault", "item-1", custom(2))).toBe(
      true,
    );
    // A later change of a reviewed item's exclusions keeps the existing record.
    const branch = { custom: "Branch", position: 1, count: 1 } as const;
    expect(
      await store.handle(
        save(4, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin, branch] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies[0]!.excludedFields).toEqual([pin, branch]);
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
    const later = catalog([item({ evidence: evidence("b") })]);
    const relaxed = storeFor(memory, later);
    expect(
      await relaxed.handle(
        save(5, settings({ itemPolicies: [itemPolicy({ excludedFields: [] })] })),
      ),
    ).toMatchObject({ ok: true });
    // The evidence changed, so the item waits for review and keeps its stored references.
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
    expect(memory.value!.settings.itemPolicies[0]!.excludedFields).toEqual([pin, branch]);
  });

  it("records the first exclusion once for an account connected twice", async () => {
    const one = catalog();
    const twice = { connections: [...one.connections, { ...one.connections[0]!, id: "again" }] };
    const memory = stored(settings());
    expect(
      await storeFor(memory, twice).handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] }), [
          { connectionId: "vault", snapshotId },
          { connectionId: "again", snapshotId },
        ]),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
  });

  it.each([
    ["another snapshot", [{ connectionId: "vault", snapshotId: crypto.randomUUID() }]],
    ["no snapshot", []],
  ])(
    "records no evidence for a first exclusion edited against %s; the item waits for review",
    async (_, shown) => {
      const memory = stored(settings());
      const store = storeFor(memory);
      expect(
        await store.handle(
          save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] }), shown),
        ),
      ).toMatchObject({ ok: true, snapshot: { revision: 4 } });
      // The exclusion is kept, and the item is reviewed against the fields it has now.
      expect(memory.value!.settings.itemPolicies).toEqual([itemPolicy({ excludedFields: [pin] })]);
      expect(memory.value!.settings.customFieldReviews).toEqual([]);
      expect(
        getItemEligibility(memory.value!.settings, catalog(), "vault", "item-1"),
      ).toMatchObject({ eligible: false, reason: "review-required" });
    },
  );

  it("records nothing for built-in exclusions or an item without evidence", async () => {
    const memory = stored(settings());
    const store = storeFor(
      memory,
      catalog([item({ evidence: undefined, revisionDate: undefined })]),
    );
    expect(
      await store.handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: ["login.password"] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.customFieldReviews).toEqual([]);
    expect(
      await store.handle(
        save(4, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.customFieldReviews).toEqual([]);
    // Without a record, the item waits for review rather than silently using the field.
    expect(
      getItemEligibility(
        memory.value!.settings,
        catalog([item({ evidence: undefined, revisionDate: undefined })]),
        "vault",
        "item-1",
      ),
    ).toEqual({
      eligible: false,
      reason: "review-required",
    });
  });

  it("refuses a save whose kept exclusions exceed the item limit, without writing", async () => {
    const blocked = catalog([item({ evidence: evidence("b") })]);
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: [pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory, blocked);
    const builtins = Array.from({ length: 1000 }, (_, index) => `field.${index}`);
    expect(
      await store.handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: builtins })] })),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid-settings" } });
    expect(memory.writes).toHaveLength(0);
  });

  it("leaves trusted updates unchanged", async () => {
    const memory = stored(settings({ customFieldReviews: [review()] }));
    const store = storeFor(memory, catalog([item({ evidence: evidence("b") })]));
    const next = await store.update(3, "field-review", (snapshot) => ({
      ...snapshot,
      settings: { ...snapshot.settings, customFieldReviews: [review({ evidence: evidence("b") })] },
    }));
    expect(next.revision).toBe(4);
    expect(memory.value!.settings.customFieldReviews).toEqual([
      review({ evidence: evidence("b") }),
    ]);
  });
}
