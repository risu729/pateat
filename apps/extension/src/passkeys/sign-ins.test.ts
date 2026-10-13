import { describe, expect, it } from "vitest";
import { createSignIns } from "./sign-ins";
import type { SignedTabsStorage } from "./signed-tabs";

const KEY = "pateat.passkey-sign-ins.v1";
const origin = "https://login.example.com";

function memory(initial: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = structuredClone(initial);
  const removed: Array<(tabId: number) => void> = [];
  const storage: SignedTabsStorage = {
    get: async (key) => (key in items ? { [key]: structuredClone(items[key]) } : {}),
    async set(values) {
      Object.assign(items, structuredClone(values));
    },
  };
  return {
    items,
    storage,
    onTabRemoved: (listener: (tabId: number) => void) => removed.push(listener),
    closeTab: (tabId: number) => removed.forEach((listener) => listener(tabId)),
  };
}
/** A clock that moves one second on each reading. */
function ticking(start = 1_000_000) {
  let now = start;
  return () => (now += 1_000);
}
/** One after another, so the order of signing decides what is dropped. */
const inOrder = (adds: Array<() => Promise<void>>) =>
  adds.reduce((done, add) => done.then(add), Promise.resolve());

describe("Pateat's sign-ins per tab (ADR 0007)", () => {
  it("records each sign-in with its time, oldest first", async () => {
    const backing = memory();
    const signIns = createSignIns(backing.storage, backing.onTabRemoved, ticking());
    await signIns.add(7, { origin });
    await signIns.add(7, { origin: "https://www.example.com", rpId: "example.com" });
    expect(await signIns.list(7)).toEqual([
      { origin, at: 1_001_000 },
      { origin: "https://www.example.com", rpId: "example.com", at: 1_002_000 },
    ]);
    expect(await signIns.list(8)).toEqual([]);
  });

  it("replaces a sign-in of the same origin and RP ID, and keeps one with another RP ID", async () => {
    const backing = memory();
    const signIns = createSignIns(backing.storage, backing.onTabRemoved, ticking());
    await signIns.add(7, { origin });
    await signIns.add(7, { origin, rpId: "example.com" });
    await signIns.add(7, { origin: "https://other.example" });
    await signIns.add(7, { origin });
    expect(await signIns.list(7)).toEqual([
      { origin, rpId: "example.com", at: 1_002_000 },
      { origin: "https://other.example", at: 1_003_000 },
      { origin, at: 1_004_000 },
    ]);
  });

  it("keeps the latest four sign-ins of a tab", async () => {
    const backing = memory();
    const signIns = createSignIns(backing.storage, backing.onTabRemoved, ticking());
    await inOrder(
      Array.from(
        { length: 6 },
        (_, index) => () => signIns.add(7, { origin: `https://site${index}.example` }),
      ),
    );
    expect((await signIns.list(7)).map((record) => record.origin)).toEqual([
      "https://site2.example",
      "https://site3.example",
      "https://site4.example",
      "https://site5.example",
    ]);
  });

  it("keeps the 64 tabs that signed in last", async () => {
    const backing = memory();
    const signIns = createSignIns(backing.storage, backing.onTabRemoved, ticking());
    await inOrder(Array.from({ length: 64 }, (_, index) => () => signIns.add(index, { origin })));
    // Signing in again keeps tab 0 over tab 1, which signed in longer ago.
    await signIns.add(0, { origin: "https://other.example" });
    await signIns.add(64, { origin });
    expect(await signIns.list(1)).toEqual([]);
    expect(await signIns.list(0)).toHaveLength(2);
    expect(await signIns.list(64)).toHaveLength(1);
    expect(backing.items[KEY]).toHaveLength(64);
  });

  it("keeps the records across a worker restart and forgets a closed tab", async () => {
    const backing = memory();
    const first = createSignIns(backing.storage, backing.onTabRemoved, () => 5_000);
    await first.add(7, { origin });
    await first.add(8, { origin, rpId: "example.com" });

    const restarted = memory(backing.items);
    const second = createSignIns(restarted.storage, restarted.onTabRemoved, () => 9_000);
    expect(await second.list(7)).toEqual([{ origin, at: 5_000 }]);
    restarted.closeTab(7);
    await expect.poll(() => second.list(7)).toEqual([]);
    expect(await second.list(8)).toEqual([{ origin, rpId: "example.com", at: 5_000 }]);
    await expect
      .poll(() => restarted.items[KEY])
      .toEqual([{ tabId: 8, records: [{ origin, rpId: "example.com", at: 5_000 }] }]);
    // Closing a tab it never recorded changes nothing.
    restarted.closeTab(99);
    expect(await second.list(8)).toHaveLength(1);
  });

  it("keeps stored records when a sign-in arrives before they were read", async () => {
    const backing = memory({ [KEY]: [{ tabId: 7, records: [{ origin, at: 1 }] }] });
    let release!: () => void;
    const slow: SignedTabsStorage = {
      get: async (key) => {
        await new Promise<void>((resolve) => (release = resolve));
        return backing.storage.get(key);
      },
      set: backing.storage.set,
    };
    const signIns = createSignIns(slow, backing.onTabRemoved, () => 2);
    const adding = signIns.add(7, { origin: "https://other.example" });
    release();
    await adding;
    expect(await signIns.list(7)).toEqual([
      { origin, at: 1 },
      { origin: "https://other.example", at: 2 },
    ]);
  });

  it.each([
    ["a negative tab", [{ tabId: -1, records: [{ origin, at: 1 }] }]],
    ["a record without a time", [{ tabId: 7, records: [{ origin }] }]],
    ["an unknown member", [{ tabId: 7, records: [{ origin, at: 1, credentialId: "AQID" }] }]],
    [
      "too many records",
      [{ tabId: 7, records: Array.from({ length: 5 }, (_, at) => ({ origin, at })) }],
    ],
    [
      "too many tabs",
      Array.from({ length: 65 }, (_, tabId) => ({ tabId, records: [{ origin, at: 1 }] })),
    ],
    ["no list", { tabId: 7 }],
  ])("ignores stored records with %s", async (_name, stored) => {
    const backing = memory({ [KEY]: stored });
    const signIns = createSignIns(backing.storage, backing.onTabRemoved);
    expect(await signIns.list(7)).toEqual([]);
    expect(await signIns.list(-1)).toEqual([]);
  });

  it.each([
    ["an empty origin", { origin: "" }],
    ["an overlong origin", { origin: `https://${"a".repeat(2048)}.example` }],
    ["an empty RP ID", { origin, rpId: "" }],
    ["an overlong RP ID", { origin, rpId: "a".repeat(254) }],
  ])("records no sign-in with %s", async (_name, record) => {
    const backing = memory();
    const signIns = createSignIns(backing.storage, backing.onTabRemoved);
    await signIns.add(7, record);
    expect(await signIns.list(7)).toEqual([]);
    expect(backing.items[KEY]).toBeUndefined();
  });

  it("works without storage, losing only what it would have kept", async () => {
    const unavailable: SignedTabsStorage = {
      get: async () => {
        throw new Error("unavailable");
      },
      set: async () => {
        throw new Error("unavailable");
      },
    };
    const closed: Array<(tabId: number) => void> = [];
    const signIns = createSignIns(
      unavailable,
      (listener) => closed.push(listener),
      () => 3,
    );
    await signIns.add(7, { origin });
    await signIns.add(7, { origin: "https://other.example" });
    expect(await signIns.list(7)).toEqual([
      { origin, at: 3 },
      { origin: "https://other.example", at: 3 },
    ]);
    for (const listener of closed) listener(7);
    await expect.poll(() => signIns.list(7)).toEqual([]);
  });
});
