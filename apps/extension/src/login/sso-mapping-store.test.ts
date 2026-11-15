import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    setAccessLevel: vi.fn(async () => undefined),
    storage: {
      getItem: vi.fn(async (key: string) => structuredClone(values.get(key) ?? null)),
      setItem: vi.fn(async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
});
vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { setAccessLevel: fake.setAccessLevel } } },
}));
vi.mock("wxt/utils/storage", () => ({ storage: fake.storage }));
import type { VaultConnectionMetadata } from "@pateat/contracts";
const site = {
  provider: "bitwarden",
  server: "cloud-us",
  userId: "synthetic-user",
  itemId: "site-item",
};
const idp = { ...site, userId: "synthetic-idp-user", itemId: "idp-item" };
const mapping = (method = 1) => ({
  source: { ...site, method: { number: method }, sourceEvidence: "E".repeat(43) },
  selected: { ...idp, origin: "https://idp.example.test" },
});
const key = "local:pateat.login.sso-mappings.v1";
const stored = (...entries: unknown[]) => ({ version: 1, entries });
beforeEach(() => {
  vi.resetModules();
  fake.values.clear();
  fake.setAccessLevel.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(fake.storage)) fn.mockClear();
});
const connection = (
  userId: string | undefined,
  items: string[],
  extra: Partial<VaultConnectionMetadata> = {},
): VaultConnectionMetadata => ({
  id: `connection-${userId ?? "locked"}`,
  label: "Synthetic vault",
  provider: "bitwarden",
  server: "cloud-us",
  ...(userId ? { userId, snapshotId: "b0000000-0000-4000-8000-000000000001" } : {}),
  groups: [],
  items: items.map((id) => ({ id, label: id, allowedOrigins: [], groupIds: [], fields: [] })),
  ...extra,
});
describe("trusted SSO mapping storage", () => {
  it("persists only portable account references in a versioned trusted local record", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    const store = createSsoMappingStore();
    expect(await store.read()).toEqual([]);
    expect(await store.save(mapping())).toBe(true);
    expect(fake.setAccessLevel).toHaveBeenCalledExactlyOnceWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    expect(fake.values.get(key)).toEqual(stored(mapping()));
    expect(JSON.stringify(fake.values.get(key))).not.toMatch(
      /username|proof|fieldId|label|connectionId|snapshot/u,
    );
    const restarted = createSsoMappingStore();
    expect(await restarted.read()).toEqual([mapping()]);
  });
  it("keys a method by its portable account, whatever the item ID's letter case", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    const store = createSsoMappingStore();
    await store.save(mapping());
    const upper = {
      ...mapping(),
      source: { ...mapping().source, itemId: "SITE-ITEM" },
      selected: { ...mapping().selected, origin: "https://other-idp.example.test" },
    };
    await store.save(upper);
    expect(await store.read()).toEqual([upper]);
    await store.remove(mapping().source);
    expect(await store.read()).toEqual([]);
  });
  it.each(["save", "remove"] as const)(
    "a %s guard is rechecked inside TrustedRecord after its own await, before durable write",
    async (operation) => {
      const { createSsoMappingStore } = await import("./sso-mapping-store");
      fake.values.set(key, stored(mapping()));
      const store = createSsoMappingStore();
      let active = true;
      const current = () => {
        queueMicrotask(() => {
          active = false;
        });
        return active;
      };
      await expect(
        operation === "save"
          ? store.save(
              {
                ...mapping(),
                selected: { ...mapping().selected, origin: "https://changed.example.test" },
              },
              current,
            )
          : store.remove(mapping().source, current),
      ).rejects.toThrow("record-withdrawn");
      expect(fake.storage.setItem).not.toHaveBeenCalled();
      expect(fake.values.get(key)).toEqual(stored(mapping()));
      expect(await store.save(mapping(2))).toBe(true);
      expect(await store.read()).toHaveLength(2);
    },
  );
  it("serializes replacement and deletion without dropping another method", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    const store = createSsoMappingStore();
    await Promise.all([
      store.save(mapping(1)),
      store.save(mapping(2)),
      store.save({
        ...mapping(1),
        source: { ...mapping(1).source, sourceEvidence: "F".repeat(43) },
      }),
    ]);
    expect(await store.read()).toHaveLength(2);
    expect(
      (await store.read()).find((entry) => entry.source.method.number === 1)?.source.sourceEvidence,
    ).toBe("F".repeat(43));
    expect(await store.remove(mapping(1).source)).toBe(true);
    expect(await store.read()).toEqual([mapping(2)]);
  });
  it.each([
    ["an older array record", [mapping()]],
    ["another version", { version: 2, entries: [mapping()] }],
    ["a record that is not an object", "corrupt"],
    ["an entry with a secret", stored({ ...mapping(), username: "private@example.test" })],
    ["a per-device connection reference", stored({ ...mapping(), source: { connectionId: "c" } })],
    [
      "an origin with a path",
      stored({ ...mapping(), selected: { ...idp, origin: "https://idp.example.test/path" } }),
    ],
    [
      "a vault snapshot",
      stored({ ...mapping(), snapshotId: "b0000000-0000-4000-8000-000000000001" }),
    ],
  ])("counts %s as no mapping, and the next save overwrites it", async (_name, value) => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    fake.values.set(key, value);
    const store = createSsoMappingStore();
    expect(await store.read()).toEqual([]);
    expect(await store.save(mapping(2))).toBe(true);
    expect(fake.values.get(key)).toEqual(stored(mapping(2)));
  });
  it("keeps the entries that parse beside one that does not", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    fake.values.set(key, stored(mapping(1), { broken: true }, mapping(2), mapping(2)));
    expect(await createSsoMappingStore().read()).toEqual([mapping(1), mapping(2)]);
  });
  it("allows an exact-key replacement at capacity but refuses another mapping", async () => {
    const { createSsoMappingStore, SsoMappingLimitError } = await import("./sso-mapping-store");
    fake.values.set(key, stored(...Array.from({ length: 1000 }, (_, index) => mapping(index + 1))));
    const store = createSsoMappingStore();
    expect(await store.save(mapping(1))).toBe(true);
    await expect(store.save(mapping(1001))).rejects.toBeInstanceOf(SsoMappingLimitError);
    expect(await store.read()).toHaveLength(1000);
  });
  it("drops the mappings of gone accounts on save, so a full store frees room", async () => {
    const { createSsoMappingStore, goneFrom } = await import("./sso-mapping-store");
    const gone = { ...mapping(), source: { ...mapping().source, itemId: "deleted-item" } };
    fake.values.set(
      key,
      stored(gone, ...Array.from({ length: 999 }, (_, index) => mapping(index + 1))),
    );
    const catalog = {
      connections: [
        connection("synthetic-user", ["site-item"]),
        connection("synthetic-idp-user", ["idp-item"]),
      ],
    };
    const store = createSsoMappingStore();
    expect(await store.save(mapping(1001), () => true, goneFrom(catalog))).toBe(true);
    const kept = await store.read();
    expect(kept).toHaveLength(1000);
    expect(kept).not.toContainEqual(gone);
  });
  it("prunes mappings whose site or IdP account is gone, never a locked one's", async () => {
    const { createSsoMappingStore, goneFrom } = await import("./sso-mapping-store");
    const idpGone = { ...mapping(2), selected: { ...mapping(2).selected, itemId: "deleted" } };
    const otherAccount = {
      ...mapping(3),
      source: { ...mapping(3).source, userId: "removed-connection" },
    };
    const lockedAccount = {
      ...mapping(4),
      source: { ...mapping(4).source, userId: "locked-user" },
    };
    fake.values.set(key, stored(mapping(1), idpGone, otherAccount, lockedAccount));
    const catalog = {
      connections: [
        connection("synthetic-user", ["site-item"]),
        connection("synthetic-idp-user", ["idp-item"]),
        connection(undefined, [], { lockedUserId: "locked-user", state: "locked" }),
      ],
    };
    const store = createSsoMappingStore();
    expect(await store.prune(goneFrom(catalog))).toBe(2);
    expect(await store.read()).toEqual([mapping(1), lockedAccount]);
    fake.storage.setItem.mockClear();
    expect(await store.prune(goneFrom(catalog))).toBe(0);
    expect(fake.storage.setItem).not.toHaveBeenCalled();
  });
  it("shows nothing gone while a connection's account is unknown", async () => {
    const { goneFrom } = await import("./sso-mapping-store");
    const gone = goneFrom({ connections: [connection(undefined, [])] });
    expect(gone(site)).toBe(false);
    expect(goneFrom({ connections: [] })(site)).toBe(true);
  });
  it("fails closed on local access denial and retries without losing queued work", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    fake.setAccessLevel.mockRejectedValueOnce(new Error("storage-denied"));
    const store = createSsoMappingStore();
    await expect(store.save(mapping())).rejects.toThrow("storage-denied");
    expect(fake.storage.setItem).not.toHaveBeenCalled();
    expect(await store.save(mapping())).toBe(true);
    expect(fake.setAccessLevel).toHaveBeenCalledTimes(2);
  });
});
