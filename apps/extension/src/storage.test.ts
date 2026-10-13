import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    setAccessLevel: vi.fn<(options: { accessLevel: string }) => Promise<void>>(),
    storage: {
      // WXT storage reads a missing value as null and removes a value set to null.
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: unknown) => {
        if (value === null) values.delete(key);
        else values.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
  };
});
vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { setAccessLevel: h.setAccessLevel } } },
}));
vi.mock("wxt/utils/storage", () => ({ storage: h.storage }));

beforeEach(() => {
  vi.resetModules();
  h.values.clear();
  h.setAccessLevel.mockReset();
  h.setAccessLevel.mockResolvedValue(undefined);
  for (const fn of Object.values(h.storage)) fn.mockClear();
});

describe("trusted storage.local records", () => {
  it("restricts access before the first read and reads a missing value as undefined", async () => {
    const { trustedRecord } = await import("./storage");
    const record = trustedRecord<{ a: number }>("pateat.test.v1");
    expect(await record.read()).toBeUndefined();
    expect(h.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(h.storage.getItem).toHaveBeenCalledWith("local:pateat.test.v1");
    await record.write({ a: 1 });
    expect(await record.read()).toEqual({ a: 1 });
    await record.clear();
    expect(await record.read()).toBeUndefined();
    expect(h.setAccessLevel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when access cannot be restricted and retries on a later call", async () => {
    const { trustedRecord } = await import("./storage");
    h.values.set("local:pateat.test.v1", { a: 1 });
    h.setAccessLevel.mockRejectedValueOnce(new Error("unsupported"));
    const record = trustedRecord<{ a: number }>("pateat.test.v1");
    await expect(record.read()).rejects.toThrow("unsupported");
    expect(h.storage.getItem).not.toHaveBeenCalled();
    await record.write({ a: 2 });
    expect(h.setAccessLevel).toHaveBeenCalledTimes(2);
    expect(await record.read()).toEqual({ a: 2 });
  });

  it("keeps session values in storage.session", async () => {
    const { sessionValue } = await import("./storage");
    const value = sessionValue("session:pateat.test.v1");
    expect(await value.getValue()).toBeNull();
    await value.setValue([1]);
    expect(h.values.get("session:pateat.test.v1")).toEqual([1]);
    expect(h.setAccessLevel).not.toHaveBeenCalled();
  });
});
