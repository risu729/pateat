import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "./settings";
import { createSettingsStore, type SettingsStorage } from "./settings-store";

function memoryStorage(initial?: unknown) {
  let value = initial;
  const writes: unknown[] = [];
  const storage: SettingsStorage = {
    async read() {
      return structuredClone(value);
    },
    async write(snapshot) {
      value = structuredClone(snapshot);
      writes.push(value);
    },
  };
  return { storage, writes };
}
const get = { version: 1, type: "settings.get" };
const save = (expectedRevision: number, settings: unknown) => ({
  version: 1,
  type: "settings.save",
  expectedRevision,
  settings,
});

describe("settings an older build stored", () => {
  it("rebuilds a snapshot an older build wrote from the parts that still read", async () => {
    // As written before account policies (ADR 0023) and servers on account references.
    const older = {
      version: 1,
      revision: 9,
      settings: {
        connections: [
          {
            connectionId: "bitwarden-all",
            enabled: true,
            selection: { mode: "all", groupIds: [], itemIds: [] },
            excludedItemIds: [],
            excludedFields: [],
          },
          {
            connectionId: "bitwarden-selected",
            enabled: true,
            selection: { mode: "selected", groupIds: [], itemIds: ["item-1"] },
            excludedItemIds: [],
            excludedFields: [],
          },
        ],
        excludedSites: [{ hostname: "bank.example", includeSubdomains: true }],
        repromptSites: [{ hostname: "card.example", includeSubdomains: false }],
        siteDefaults: [
          { origin: "https://shop.example", provider: "bitwarden", userId: "u-1", itemId: "i-1" },
        ],
        bindings: [],
      },
      changes: [{ revision: 9, cause: "settings-save" }],
      fieldPolicies: [],
    };
    const memory = memoryStorage(older);
    const store = createSettingsStore(memory.storage, { connections: [] });
    const read = await store.handle(get);
    expect(read).toMatchObject({
      ok: true,
      snapshot: {
        revision: 9,
        changes: older.changes,
        settings: {
          ...createDefaultSettings({ connections: [] }),
          // A connection restricted to some items is not used until it is set up again.
          connections: [
            { connectionId: "bitwarden-all", enabled: true },
            { connectionId: "bitwarden-selected", enabled: false },
          ],
          excludedSites: older.settings.excludedSites,
          repromptSites: older.settings.repromptSites,
          // An account without its server cannot be named, so its saved account is gone.
          siteDefaults: [],
        },
      },
    });
    expect(memory.writes).toHaveLength(0);
    expect(await store.handle(save(9, createDefaultSettings({ connections: [] })))).toMatchObject({
      ok: true,
      snapshot: { revision: 10 },
    });
  });

  it("stays refused when an older snapshot's site exclusions do not read", async () => {
    const older = {
      version: 1,
      revision: 3,
      settings: { ...createDefaultSettings(), excludedSites: [{ hostname: "" }] },
    };
    const memory = memoryStorage(older);
    expect(await createSettingsStore(memory.storage).handle(get)).toMatchObject({
      ok: false,
      error: { code: "storage-corrupt" },
    });
  });
});
