import * as v from "valibot";
import type { SignedTabsStorage } from "./signed-tabs";

/** Session storage outlives a worker restart, and ends with the browser session. */
const STORAGE_KEY = "pateat.passkey-sign-ins.v1";
const MAX_TABS = 64;
const MAX_RECORDS = 4;

const recordSchema = v.strictObject({
  origin: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  rpId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(253))),
  at: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const storedSchema = v.pipe(
  v.array(
    v.strictObject({
      tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
      records: v.pipe(v.array(recordSchema), v.maxLength(MAX_RECORDS)),
    }),
  ),
  v.maxLength(MAX_TABS),
);

/** Where and when Pateat signed a tab in: a login's origin, or a passkey's origin and RP ID. */
export type SignInRecord = v.InferOutput<typeof recordSchema>;

/** Pateat's own sign-ins per tab, which a site's passkey registration may follow (ADR 0007). */
export interface SignIns {
  /** Records a sign-in now; a storage failure only loses it. */
  add(tabId: number, record: { readonly origin: string; readonly rpId?: string }): Promise<void>;
  /** The tab's latest sign-ins, oldest first; none when storage failed. */
  list(tabId: number): Promise<readonly SignInRecord[]>;
}

/**
 * Remembers, per tab, where Pateat last signed in: a login that reached signed in on any
 * route, and each passkey assertion it returned. A closed tab is forgotten, and only the
 * latest few tabs and records are kept.
 */
export function createSignIns(
  storage: SignedTabsStorage,
  onTabRemoved: (listener: (tabId: number) => void) => void,
  now: () => number = Date.now,
): SignIns {
  // In the order they last signed in, so the oldest tab goes first.
  const tabs = new Map<number, readonly SignInRecord[]>();
  // Every change happens after this load; storage failures only lose the records.
  const load = async () => {
    const stored = await storage.get(STORAGE_KEY).catch(() => ({}) as Record<string, unknown>);
    const parsed = v.safeParse(storedSchema, stored[STORAGE_KEY] ?? []);
    if (parsed.success) for (const entry of parsed.output) tabs.set(entry.tabId, entry.records);
  };
  const loaded = load();
  let queue: Promise<void> = Promise.resolve();
  const save = () => {
    const entries = [...tabs].map(([tabId, records]) => ({ tabId, records }));
    queue = queue.then(
      () => storage.set({ [STORAGE_KEY]: entries }).catch(() => undefined),
      () => undefined,
    );
    return queue;
  };
  onTabRemoved((tabId) => {
    const forget = async () => {
      await loaded;
      if (tabs.delete(tabId)) await save();
    };
    void forget();
  });
  return {
    async add(tabId, { origin, rpId }) {
      await loaded;
      const record: SignInRecord = { origin, ...(rpId === undefined ? {} : { rpId }), at: now() };
      if (!v.is(recordSchema, record)) return;
      const records = [
        ...(tabs.get(tabId) ?? []).filter(
          (entry) => entry.origin !== origin || entry.rpId !== rpId,
        ),
        record,
      ];
      tabs.delete(tabId);
      tabs.set(tabId, records.slice(-MAX_RECORDS));
      for (const oldest of tabs.keys()) {
        if (tabs.size <= MAX_TABS) break;
        tabs.delete(oldest);
      }
      await save();
    },
    async list(tabId) {
      await loaded;
      return tabs.get(tabId) ?? [];
    },
  };
}
