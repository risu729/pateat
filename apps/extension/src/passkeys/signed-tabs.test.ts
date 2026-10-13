import { describe, expect, it } from "vitest";
import { createSignedTabs, type SignedTabsStorage } from "./signed-tabs";

const KEY = "pateat.passkey-signed.v1";

function memory(initial: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = { ...initial };
  const removed: Array<(tabId: number) => void> = [];
  const storage: SignedTabsStorage = {
    get: async (key) => (key in items ? { [key]: items[key] } : {}),
    async set(values) {
      Object.assign(items, values);
    },
  };
  return {
    items,
    storage,
    onTabRemoved: (listener: (tabId: number) => void) => removed.push(listener),
    closeTab: (tabId: number) => removed.forEach((listener) => listener(tabId)),
  };
}

describe("tabs Pateat signed in from", () => {
  it("keeps the record across a worker restart and forgets a closed tab", async () => {
    const backing = memory();
    const first = createSignedTabs(backing.storage, backing.onTabRemoved);
    await first.add(7, "example.com");
    await first.add(7, "other.example");
    await first.add(8, "example.com");
    expect(await first.has(7, "example.com")).toBe(true);
    expect(await first.has(8, "other.example")).toBe(false);

    const restarted = memory(backing.items);
    const second = createSignedTabs(restarted.storage, restarted.onTabRemoved);
    expect(await second.has(7, "other.example")).toBe(true);
    restarted.closeTab(7);
    await expect.poll(() => second.has(7, "example.com")).toBe(false);
    expect(await second.has(8, "example.com")).toBe(true);
    await expect.poll(() => restarted.items[KEY]).toEqual([{ tabId: 8, rpIds: ["example.com"] }]);
  });

  it("ignores a malformed record and bounds what it keeps", async () => {
    const backing = memory({ [KEY]: [{ tabId: -1, rpIds: ["example.com"] }] });
    const tabs = createSignedTabs(backing.storage, backing.onTabRemoved);
    expect(await tabs.has(-1, "example.com")).toBe(false);
    // One after another, so the order of signing decides what is dropped.
    const inOrder = (adds: Array<() => Promise<void>>) =>
      adds.reduce((done, add) => done.then(add), Promise.resolve());
    await inOrder(
      Array.from({ length: 10 }, (_, index) => () => tabs.add(7, `rp${index}.example`)),
    );
    expect(await tabs.has(7, "rp1.example")).toBe(false);
    expect(await tabs.has(7, "rp9.example")).toBe(true);
    await inOrder(
      Array.from({ length: 300 }, (_, index) => () => tabs.add(index + 100, "example.com")),
    );
    expect(await tabs.has(7, "rp9.example")).toBe(false);
    expect(await tabs.has(399, "example.com")).toBe(true);
    expect(backing.items[KEY]).toHaveLength(256);
  });

  it("works without storage", async () => {
    const tabs = createSignedTabs(
      {
        get: async () => {
          throw new Error("unavailable");
        },
        set: async () => {
          throw new Error("unavailable");
        },
      },
      () => {},
    );
    await tabs.add(7, "example.com");
    expect(await tabs.has(7, "example.com")).toBe(true);
  });
});
