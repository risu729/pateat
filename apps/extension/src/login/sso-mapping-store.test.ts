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
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const continuity = {
  provider: "bitwarden",
  server: "cloud-us",
  userId: "synthetic-user",
  snapshotId,
};
const mapping = (method = 1) => ({
  source: {
    account: { connectionId: "site", itemId: "site-item" },
    method: { number: method },
    sourceEvidence: "E".repeat(43),
  },
  selected: {
    account: { connectionId: "idp", itemId: "idp-item" },
    origin: "https://idp.example.test",
  },
  sourceContinuity: continuity,
  selectedContinuity: { ...continuity, userId: "synthetic-idp-user" },
});
const key = "local:pateat.login.sso-mappings";
beforeEach(() => {
  vi.resetModules();
  fake.values.clear();
  fake.setAccessLevel.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(fake.storage)) fn.mockClear();
});
describe("trusted SSO mapping storage", () => {
  it("persists only opaque continuity references through the actual trusted local record", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    const store = createSsoMappingStore();
    expect(await store.read()).toEqual([]);
    expect(await store.save(mapping())).toBe(true);
    expect(fake.setAccessLevel).toHaveBeenCalledExactlyOnceWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    expect(fake.values.get(key)).toEqual([mapping()]);
    expect(JSON.stringify(fake.values.get(key))).not.toMatch(/username|proof|fieldId|label/u);
    const restarted = createSsoMappingStore();
    expect(await restarted.read()).toEqual([mapping()]);
  });
  it.each(["save", "remove"] as const)(
    "a %s guard is rechecked inside TrustedRecord after its own await, before durable write",
    async (operation) => {
      const { createSsoMappingStore } = await import("./sso-mapping-store");
      fake.values.set(key, [mapping()]);
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
      expect(fake.values.get(key)).toEqual([mapping()]);
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
  it.each(["extra-secret", "duplicate", "corrupt-origin", "corrupt-snapshot", "too-many"] as const)(
    "refuses %s storage without overwriting it",
    async (corruption) => {
      const { createSsoMappingStore } = await import("./sso-mapping-store");
      let value: unknown = [mapping()];
      if (corruption === "extra-secret")
        value = [{ ...mapping(), username: "private-synthetic@example.test" }];
      if (corruption === "duplicate") value = [mapping(), mapping()];
      if (corruption === "corrupt-origin")
        value = [
          {
            ...mapping(),
            selected: { ...mapping().selected, origin: "https://idp.example.test/path" },
          },
        ];
      if (corruption === "corrupt-snapshot")
        value = [
          { ...mapping(), selectedContinuity: { ...continuity, snapshotId: "not-a-snapshot" } },
        ];
      if (corruption === "too-many")
        value = Array.from({ length: 1001 }, (_, index) => mapping(index + 1));
      fake.values.set(key, value);
      const store = createSsoMappingStore();
      await expect(store.read()).rejects.toThrow();
      await expect(store.save(mapping())).rejects.toThrow();
      expect(fake.storage.setItem).not.toHaveBeenCalled();
      expect(fake.values.get(key)).toEqual(value);
    },
  );
  it("allows an exact-key replacement at capacity but refuses another mapping", async () => {
    const { createSsoMappingStore } = await import("./sso-mapping-store");
    fake.values.set(
      key,
      Array.from({ length: 1000 }, (_, index) => mapping(index + 1)),
    );
    const store = createSsoMappingStore();
    expect(await store.save(mapping(1))).toBe(true);
    await expect(store.save(mapping(1001))).rejects.toThrow("mapping-limit");
    expect(await store.read()).toHaveLength(1000);
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
