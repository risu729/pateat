import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  setAccessLevel: vi.fn<(options: { accessLevel: string }) => Promise<void>>(),
  defineItem: vi.fn(),
}));
vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { setAccessLevel: h.setAccessLevel } } },
}));
vi.mock("wxt/utils/storage", () => ({ storage: { defineItem: h.defineItem } }));

beforeEach(() => {
  vi.resetModules();
  h.setAccessLevel.mockReset();
  h.defineItem.mockReset();
});

function item(initial: unknown = null) {
  let value = initial;
  return {
    getValue: vi.fn(async () => value),
    setValue: vi.fn(async (next: unknown) => {
      value = next;
    }),
    removeValue: vi.fn(async () => {
      value = null;
    }),
  };
}

describe("trusted storage.local records", () => {
  it("defines the item only after access is restricted and reads null as undefined", async () => {
    const { trustedRecord } = await import("./storage");
    const stored = item();
    h.setAccessLevel.mockResolvedValue(undefined);
    h.defineItem.mockReturnValue(stored);
    const record = trustedRecord<{ a: number }>("pateat.test.v1");
    expect(h.defineItem).not.toHaveBeenCalled();
    expect(await record.read()).toBeUndefined();
    expect(h.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(h.defineItem).toHaveBeenCalledWith("local:pateat.test.v1");
    await record.write({ a: 1 });
    expect(await record.read()).toEqual({ a: 1 });
    await record.clear();
    expect(await record.read()).toBeUndefined();
    expect(h.defineItem).toHaveBeenCalledTimes(1);
    expect(h.setAccessLevel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when access cannot be restricted and retries on a later call", async () => {
    const { trustedRecord } = await import("./storage");
    const stored = item({ a: 1 });
    h.setAccessLevel.mockResolvedValue(undefined);
    h.setAccessLevel.mockRejectedValueOnce(new Error("unsupported"));
    h.defineItem.mockReturnValue(stored);
    const record = trustedRecord<{ a: number }>("pateat.test.v1");
    await expect(record.read()).rejects.toThrow("unsupported");
    await expect(record.write({ a: 2 })).resolves.toBeUndefined();
    expect(h.setAccessLevel).toHaveBeenCalledTimes(2);
    expect(stored.getValue).not.toHaveBeenCalled();
    expect(await record.read()).toEqual({ a: 2 });
  });
});
