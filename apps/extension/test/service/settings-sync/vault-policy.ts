import type { VaultPolicyContext } from "./context";

export function registerVaultPolicy({
  it,
  settingsOf,
  localConnection,
  accountPolicy,
  demoEntries,
  itemPolicy,
  review,
  setup,
  expect,
  CONNECTION,
  never,
  state,
  syncedSettings,
  mergeSyncedSettings,
  owner,
  binding,
  baseOf,
  demo,
}: VaultPolicyContext) {
  it("uploads each account's policy and reviews, never the demo provider's, and keeps those here", async () => {
    const local = settingsOf({
      connections: [localConnection],
      accountPolicies: [accountPolicy(), ...demoEntries.accountPolicies],
      itemPolicies: [
        itemPolicy("item-1", {
          excludedFields: ["login.totp", { custom: "PIN", position: 1, count: 2 }],
        }),
        ...demoEntries.itemPolicies,
      ],
      customFieldReviews: [review("item-1"), ...demoEntries.customFieldReviews],
    });
    const { sync, service, local: after } = setup({ local });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service()).toEqual(
      state(
        1,
        settingsOf({
          accountPolicies: [accountPolicy()],
          itemPolicies: [
            itemPolicy("item-1", {
              excludedFields: ["login.totp", { custom: "PIN", position: 1, count: 2 }],
            }),
          ],
          customFieldReviews: [review("item-1")],
        }),
      ),
    );
    expect(JSON.stringify(service())).not.toContain("dummy");
    expect(after()).toEqual({ version: 1, revision: 7, settings: local });
  });

  it("merges per account and per item, and the service wins an entry both sides changed", () => {
    const agreed = syncedSettings(
      settingsOf({
        accountPolicies: [accountPolicy()],
        itemPolicies: [itemPolicy("item-1")],
        customFieldReviews: [review("item-1")],
      }),
    );
    const local = syncedSettings(
      settingsOf({
        // Turned off on this device.
        accountPolicies: [accountPolicy(false)],
        // An item selected on this device.
        itemPolicies: [itemPolicy("item-1"), itemPolicy("item-2", { selected: true })],
        // Reviewed again on this device.
        customFieldReviews: [review("item-1", "b")],
      }),
    );
    const service = syncedSettings(
      settingsOf({
        accountPolicies: [accountPolicy()],
        // Excluded on another device.
        itemPolicies: [itemPolicy("item-1", { excluded: true })],
        // Reviewed on another device too, and another item reviewed there.
        customFieldReviews: [review("item-1", "c"), review("item-3", "d")],
      }),
    );
    expect(mergeSyncedSettings({ service: agreed, local: agreed }, local, service)).toEqual(
      syncedSettings(
        settingsOf({
          accountPolicies: [accountPolicy(false)],
          itemPolicies: [
            itemPolicy("item-1", { excluded: true }),
            itemPolicy("item-2", { selected: true }),
          ],
          customFieldReviews: [review("item-1", "c"), review("item-3", "d")],
        }),
      ),
    );
  });

  it("removes a policy or review deleted on either side", () => {
    const agreed = syncedSettings(
      settingsOf({
        accountPolicies: [accountPolicy()],
        itemPolicies: [
          itemPolicy("item-1", { selected: true }),
          itemPolicy("item-2", { selected: true }),
        ],
        customFieldReviews: [review("item-1"), review("item-2")],
      }),
    );
    const merged = mergeSyncedSettings(
      { service: agreed, local: agreed },
      { ...agreed, itemPolicies: [itemPolicy("item-2", { selected: true })] },
      { ...agreed, customFieldReviews: [review("item-1")] },
    );
    expect(merged).toMatchObject({
      accountPolicies: [accountPolicy()],
      itemPolicies: [itemPolicy("item-2", { selected: true })],
      customFieldReviews: [review("item-1")],
    });
  });

  it("takes an item's policy and review from one side, so a review keeps its exclusions", () => {
    const pin = { custom: "PIN", position: 1, count: 1 };
    const secret = { custom: "Secret", position: 1, count: 1 };
    const agreed = syncedSettings(
      settingsOf({
        accountPolicies: [accountPolicy()],
        itemPolicies: [itemPolicy("item-1", { excludedFields: [pin] })],
        customFieldReviews: [review("item-1")],
      }),
    );
    // Reviewed here: the new field Secret is excluded too.
    const local = {
      ...agreed,
      itemPolicies: [itemPolicy("item-1", { excludedFields: [pin, secret] })],
      customFieldReviews: [review("item-1", "b")],
    };
    // Meanwhile another device excluded a built-in field of the same item.
    const service = {
      ...agreed,
      itemPolicies: [itemPolicy("item-1", { excludedFields: ["login.totp", pin] })],
    };
    const merged = mergeSyncedSettings({ service: agreed, local: agreed }, local, service);
    // The service's copy wins for the whole item: the old review stays with its exclusions,
    // so the item waits for review again instead of using Secret.
    expect(merged.itemPolicies).toEqual(service.itemPolicies);
    expect(merged.customFieldReviews).toEqual(agreed.customFieldReviews);
    // A change on one side only still applies to both lists of the item.
    expect(mergeSyncedSettings({ service: agreed, local: agreed }, local, agreed)).toMatchObject({
      itemPolicies: local.itemPolicies,
      customFieldReviews: local.customFieldReviews,
    });
  });

  it("keeps a user ID's entries on another server apart, including bindings", async () => {
    const elsewhere = { ...owner, server: "https://vault.example.test" };
    const local = settingsOf({
      accountPolicies: [accountPolicy()],
      customFieldReviews: [review("item-1")],
      bindings: [binding("https://bank.example")],
    });
    const remote = settingsOf({
      accountPolicies: [accountPolicy(false, elsewhere)],
      customFieldReviews: [review("item-1", "e", elsewhere)],
      bindings: [{ ...binding("https://bank.example"), server: elsewhere.server }],
    });
    // Both sides added their entries since an empty agreed copy of this profile.
    const {
      sync,
      service,
      local: after,
    } = setup({
      local,
      service: state(3, remote),
      base: baseOf(2, settingsOf()),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = settingsOf({
      accountPolicies: [accountPolicy(false, elsewhere), accountPolicy()],
      customFieldReviews: [review("item-1", "e", elsewhere), review("item-1")],
      bindings: [
        { ...binding("https://bank.example"), server: elsewhere.server },
        binding("https://bank.example"),
      ],
    });
    expect(service()).toEqual(state(4, merged));
    expect(after()?.settings).toEqual(merged);
  });

  it("lets a binding differing only in its server win as its own entry", () => {
    const agreed = syncedSettings(settingsOf({ bindings: [binding("https://bank.example")] }));
    const moved = { ...binding("https://bank.example", "totp"), server: "cloud-eu" };
    // The service's change to the cloud-us binding wins; the cloud-eu one is added.
    expect(
      mergeSyncedSettings(
        { service: agreed, local: agreed },
        syncedSettings(settingsOf({ bindings: [binding("https://bank.example"), moved] })),
        syncedSettings(settingsOf({ bindings: [binding("https://bank.example", "totp")] })),
      ).bindings,
    ).toEqual([binding("https://bank.example", "totp"), moved]);
  });

  it("applies service changes and keeps this device's demo entries, ignoring any on the service", async () => {
    const agreed = settingsOf({
      accountPolicies: [accountPolicy()],
      itemPolicies: [itemPolicy("item-1")],
    });
    const remote = settingsOf({
      accountPolicies: [accountPolicy(false), accountPolicy(false, demo)],
      itemPolicies: [itemPolicy("item-1", { excluded: true })],
      customFieldReviews: [review("item-1")],
    });
    const {
      sync,
      transport,
      local: after,
      applied,
    } = setup({
      local: {
        ...agreed,
        connections: [localConnection],
        accountPolicies: [...agreed.accountPolicies, ...demoEntries.accountPolicies],
        itemPolicies: [...agreed.itemPolicies, ...demoEntries.itemPolicies],
        customFieldReviews: demoEntries.customFieldReviews,
      },
      service: state(5, remote),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings).toEqual(
      settingsOf({
        connections: [localConnection],
        accountPolicies: [accountPolicy(false), ...demoEntries.accountPolicies],
        itemPolicies: [itemPolicy("item-1", { excluded: true }), ...demoEntries.itemPolicies],
        customFieldReviews: [review("item-1"), ...demoEntries.customFieldReviews],
      }),
    );
    expect(applied).toHaveBeenCalledOnce();
    // The service's own demo entry is not part of the synced settings, so nothing is uploaded.
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });

  it("applies nothing when the merged policies would exceed their limits", async () => {
    const many = Array.from({ length: 1000 }, (_, index) => review(`item-${index}`));
    const { sync, local: after } = setup({
      local: settingsOf({ customFieldReviews: [review("local-item")] }),
      service: state(3, settingsOf({ customFieldReviews: many })),
      base: baseOf(2, settingsOf()),
    });
    expect(await sync.run(CONNECTION, never)).toBe("too-large");
    expect(after()?.settings.customFieldReviews).toEqual([review("local-item")]);
  });
}
