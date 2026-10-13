import * as v from "valibot";

/** Session storage outlives a worker restart, and ends with the browser session. */
const STORAGE_KEY = "pateat.passkey-signed.v1";
const MAX_TABS = 256;
const MAX_RP_IDS = 8;

const storedSchema = v.pipe(
  v.array(
    v.strictObject({
      tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
      rpIds: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(253))),
        v.maxLength(MAX_RP_IDS),
      ),
    }),
  ),
  v.maxLength(MAX_TABS),
);

export interface SignedTabsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The RP IDs Pateat returned an assertion for, per tab (ADR 0021 part D). */
export interface SignedTabs {
  has(tabId: number, rpId: string): Promise<boolean>;
  add(tabId: number, rpId: string): Promise<void>;
  /** Moves a tab's records to the new ID Chrome gave the tab when it replaced it. */
  replaced(added: number, removed: number): Promise<void>;
}

/**
 * Remembers, per tab, the RP IDs Pateat signed for, so a later username-less request there,
 * which may follow a logout, asks again. A closed tab is forgotten.
 */
export function createSignedTabs(
  storage: SignedTabsStorage,
  onTabRemoved: (listener: (tabId: number) => void) => void,
): SignedTabs {
  // In the order they were last signed in, so the oldest tab goes first.
  const tabs = new Map<number, readonly string[]>();
  // Every change happens after this load; storage failures only lose the record.
  const load = async () => {
    const stored = await storage.get(STORAGE_KEY).catch(() => ({}) as Record<string, unknown>);
    const parsed = v.safeParse(storedSchema, stored[STORAGE_KEY] ?? []);
    if (parsed.success) for (const entry of parsed.output) tabs.set(entry.tabId, entry.rpIds);
  };
  const loaded = load();
  let queue: Promise<void> = Promise.resolve();
  const save = () => {
    const entries = [...tabs].map(([tabId, rpIds]) => ({ tabId, rpIds }));
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
    async has(tabId, rpId) {
      await loaded;
      return tabs.get(tabId)?.includes(rpId) ?? false;
    },
    async replaced(added, removed) {
      await loaded;
      if (!tabs.has(removed)) return;
      // In place, so the tab keeps its turn among the oldest.
      const moved = [...tabs].map(
        ([tabId, entry]) => [tabId === removed ? added : tabId, entry] as const,
      );
      tabs.clear();
      for (const [tabId, entry] of moved) tabs.set(tabId, entry);
      await save();
    },
    async add(tabId, rpId) {
      await loaded;
      const rpIds = [...(tabs.get(tabId) ?? []).filter((entry) => entry !== rpId), rpId];
      tabs.delete(tabId);
      tabs.set(tabId, rpIds.slice(-MAX_RP_IDS));
      for (const oldest of tabs.keys()) {
        if (tabs.size <= MAX_TABS) break;
        tabs.delete(oldest);
      }
      await save();
    },
  };
}
