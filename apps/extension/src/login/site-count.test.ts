import type { LocalVaultMetadata } from "@pateat/bitwarden";
import type { SettingsSnapshot, VaultCatalog } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UriCandidates } from "../crypto/wire";
import { vaultFailure, type VaultResult } from "../vault/record";
import {
  SITE_COUNT_LIMIT,
  UNANNOUNCED_COUNT_MS,
  countSite,
  countedOrigin,
  createCountScope,
  createSiteCounter,
  type CountScope,
  type CountSource,
  type CountStep,
  type SiteCountState,
} from "./site-count";

const origin = "https://login.example";
const connectionId = "live";
const snapshotId = "snapshot-1";
const run: CountStep = async (job) => ({ value: await job() });

function settings(
  change: Partial<SettingsSnapshot["settings"]["connections"][number]> = {},
  more: Partial<SettingsSnapshot["settings"]> = {},
  revision = 1,
): SettingsSnapshot {
  return {
    version: 1,
    revision,
    settings: {
      connections: [
        {
          connectionId,
          enabled: true,
          selection: { mode: "all", groupIds: [], itemIds: [] },
          excludedItemIds: [],
          excludedFields: [],
          ...change,
        },
      ],
      excludedSites: [],
      siteDefaults: [],
      bindings: [],
      ...more,
    },
  };
}
const field = (id: string) => ({ id, label: id, name: null, kind: "text" as const });
function metadata(items: { id: string; fields?: string[] }[]): LocalVaultMetadata {
  return {
    connectionId,
    userId: "user",
    snapshotId,
    groups: [],
    items: items.map((item) => ({
      id: item.id,
      label: item.id,
      type: 1,
      groupIds: [],
      fields: (item.fields ?? ["login.password"]).map(field),
    })),
  };
}
type Vault = {
  items?: { id: string; fields?: string[] }[];
  uris?: string[];
  passkeys?: string[];
  unknown?: string[];
  catalog?: VaultResult<LocalVaultMetadata>;
};
function live(vault: Vault = {}): Extract<CountSource, { snapshotId: string }> & {
  open: NonNullable<Extract<CountSource, { snapshotId: string }>["open"]>;
} {
  const items = vault.items ?? [{ id: "a" }];
  return {
    connectionId,
    snapshotId,
    open: {
      catalog: vi.fn(async () => vault.catalog ?? { ok: true as const, data: metadata(items) }),
      matchUris: vi.fn(async (url: string): Promise<VaultResult<UriCandidates>> => ({
        ok: true,
        data: {
          connectionId,
          userId: "user",
          snapshotId,
          targetOrigin: new URL(url).origin,
          candidates: (vault.uris ?? []).map((itemId) => ({
            itemId,
            matches: [{ uriIndex: 0, match: 0 as const }],
          })),
          unavailableUris: (vault.unknown ?? []).map((itemId) => ({
            itemId,
            uriIndex: 0,
            reason: "default-match-unavailable" as const,
          })),
          unavailableItemIds: [],
        },
      })),
      findPasskeys: vi.fn(async (rpId: string) => ({
        ok: true as const,
        data: {
          snapshotId,
          rpId,
          candidates: (rpId === "login.example" ? (vault.passkeys ?? []) : []).map((itemId) => ({
            itemId,
          })),
          unavailableItemIds: [],
        },
      })),
    },
  };
}
const scope = (
  sources: CountSource[],
  snapshot = settings(),
): Extract<CountScope, { key: string }> => ({ snapshot, sources, key: "key" });

describe("countedOrigin", () => {
  it("counts HTTPS pages only", () => {
    expect(countedOrigin(`${origin}/sign-in?next=1`)).toBe(origin);
    expect(countedOrigin("http://login.example/")).toBeUndefined();
    expect(countedOrigin("chrome://newtab/")).toBeUndefined();
    expect(countedOrigin(undefined)).toBeUndefined();
    expect(countedOrigin("not a url")).toBeUndefined();
  });
});

describe("countSite", () => {
  it("counts items matching by URI rule or passkey once, for origin/", async () => {
    const source = live({
      items: [{ id: "a" }, { id: "b", fields: [] }, { id: "c" }],
      uris: ["a", "c"],
      passkeys: ["a", "b"],
    });
    expect(await countSite(origin, scope([source]), run)).toEqual({
      kind: "count",
      count: { usable: 3, matching: 3, unevaluated: 0 },
    });
    expect(source.open.matchUris).toHaveBeenCalledWith(`${origin}/`);
  });

  it("counts excluded items as matching but not usable", async () => {
    const source = live({ items: [{ id: "a" }, { id: "b" }], uris: ["a", "b"] });
    const snapshot = settings({ excludedItemIds: ["b"] });
    expect(await countSite(origin, scope([source], snapshot), run)).toEqual({
      kind: "count",
      count: { usable: 1, matching: 2, unevaluated: 0 },
    });
  });

  it.each([
    ["items", settings({ excludedItemIds: ["a", "b"] })],
    [
      "items",
      settings({
        excludedItemIds: ["a"],
        excludedFields: [{ itemId: "b", fieldId: "login.password" }],
      }),
    ],
    [
      "review",
      {
        ...settings(),
        fieldPolicies: [
          { connectionId, snapshotId, quarantinedItemIds: ["a", "b"], protectedItemIds: [] },
        ],
      },
    ],
    [
      "items-review",
      {
        ...settings({ excludedItemIds: ["b"] }),
        fieldPolicies: [
          { connectionId, snapshotId, quarantinedItemIds: ["a"], protectedItemIds: [] },
        ],
      },
    ],
    [
      "site",
      settings({}, { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] }),
    ],
  ] as const)("names why none is usable: %s", async (excluded, snapshot) => {
    const source = live({ items: [{ id: "a" }, { id: "b" }], uris: ["a", "b"] });
    expect(await countSite(origin, scope([source], snapshot as SettingsSnapshot), run)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 2, unevaluated: 0, excluded },
    });
  });

  it("leaves items whose rules could not be evaluated out, noting them", async () => {
    const source = live({ items: [{ id: "a" }, { id: "b" }], uris: ["a"], unknown: ["a", "b"] });
    expect(await countSite(origin, scope([source]), run)).toEqual({
      kind: "count",
      count: { usable: 1, matching: 1, unevaluated: 1 },
    });
  });

  it("matches bundled demo connections by their static origins", async () => {
    const fixed: VaultCatalog["connections"][number] = {
      id: connectionId,
      label: "Demo",
      provider: "dummy",
      groups: [],
      items: [
        {
          id: "a",
          label: "A",
          allowedOrigins: [origin],
          groupIds: [],
          fields: [field("username")],
        },
        {
          id: "b",
          label: "B",
          allowedOrigins: ["https://other.example"],
          groupIds: [],
          fields: [],
        },
      ],
    };
    expect(await countSite(origin, scope([{ connectionId, fixed }]), run)).toEqual({
      kind: "count",
      count: { usable: 1, matching: 1, unevaluated: 0 },
    });
  });

  it("does not count a vault the worker has not opened", async () => {
    expect(await countSite(origin, scope([{ connectionId, snapshotId }]), run)).toEqual({
      kind: "unchecked",
      reason: "not-opened",
    });
  });

  it.each([
    ["stale-vault-handle", "updating"],
    ["crypto-locked", "locked"],
    ["resource-limit", "unreadable"],
  ] as const)("shows a %s failure as not checked (%s)", async (code, reason) => {
    const source = live({ catalog: vaultFailure(code) });
    expect(await countSite(origin, scope([source]), run)).toEqual({ kind: "unchecked", reason });
    expect(source.open.matchUris).not.toHaveBeenCalled();
  });

  it("shows another snapshot than the accepted one as being updated", async () => {
    const source = live({
      catalog: { ok: true, data: { ...metadata([{ id: "a" }]), snapshotId: "snapshot-2" } },
    });
    expect(await countSite(origin, scope([source]), run)).toEqual({
      kind: "unchecked",
      reason: "updating",
    });
  });

  it("stops before the next crypto job when the step refuses it", async () => {
    const source = live({ uris: ["a"] });
    let jobs = 0;
    const step: CountStep = async (job) => ((jobs += 1) === 2 ? undefined : { value: await job() });
    expect(await countSite(origin, scope([source]), step)).toBeUndefined();
    expect(source.open.catalog).toHaveBeenCalledTimes(1);
    expect(source.open.matchUris).not.toHaveBeenCalled();
  });
});

describe("createCountScope", () => {
  type Record = { ok: true; data: unknown } | { ok: false };
  function connections(record: Record, handle?: { snapshotId: string }, snapshot = settings()) {
    const manager = {
      status: () => (handle ? { handle } : {}),
      catalog: vi.fn(),
      matchUris: vi.fn(),
      findPasskeys: vi.fn(),
    };
    return {
      manager,
      deps: {
        settings: { read: async () => snapshot },
        registry: { list: async () => [{ profile: { connectionId } }] },
        vaultFor: () => ({ store: { read: async () => record }, manager }),
      } as never,
    };
  }
  const active = { ok: true as const, data: { state: "active", accepted: { snapshotId } } };

  it.each([
    ["unreadable", { ok: false } as Record, undefined],
    ["locked", { ok: true, data: { state: "disabled" } } as Record, undefined],
    ["locked", { ok: true, data: null } as Record, undefined],
    ["updating", active, { snapshotId: "snapshot-2" }],
  ] as const)("answers %s without any crypto job", async (unchecked, record, handle) => {
    const { deps, manager } = connections(record, handle);
    expect(await createCountScope(deps)()).toEqual({ unchecked });
    expect(manager.catalog).not.toHaveBeenCalled();
  });

  it("keys the scope by the settings revision and each accepted snapshot", async () => {
    const closed = await createCountScope(connections(active).deps)();
    expect(closed).toMatchObject({ key: JSON.stringify([1, [[connectionId, snapshotId]]]) });
    expect(closed).not.toHaveProperty(["sources", 0, "open"]);
    const open = await createCountScope(connections(active, { snapshotId }).deps)();
    expect(open).toMatchObject({ key: JSON.stringify([1, [[connectionId, snapshotId]]]) });
    expect(open).toHaveProperty(["sources", 0, "open"]);
    const disabled = await createCountScope(
      connections(active, { snapshotId }, settings({ enabled: false })).deps,
    )();
    expect(disabled).toMatchObject({ sources: [], key: JSON.stringify([1, []]) });
  });
});

describe("createSiteCounter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function harness(options: { stored?: unknown; open?: boolean } = {}) {
    let value: unknown = options.stored;
    const storage = {
      getValue: vi.fn(async () => value),
      setValue: vi.fn(async (next: unknown) => {
        value = next;
      }),
    };
    let snapshot = settings();
    let source: CountSource =
      options.open === false ? { connectionId, snapshotId } : live({ uris: ["a"] });
    let unchecked: "locked" | undefined;
    const shown = new Map<number, SiteCountState | undefined>();
    const events: string[] = [];
    const step = vi.fn<CountStep>(async (job) => {
      events.push("job");
      return { value: await job() };
    });
    const counter = createSiteCounter({
      scope: async () =>
        unchecked
          ? { unchecked }
          : { snapshot, sources: [source], key: JSON.stringify([snapshot.revision]) },
      hold: async () => {
        events.push("hold");
        return () => events.push("release");
      },
      step: step as CountStep,
      show: (tabId, _origin, state) => shown.set(tabId, state),
      storage,
    });
    return {
      counter,
      shown,
      events,
      step,
      storage,
      stored: () => value,
      setSettings: (next: SettingsSnapshot) => (snapshot = next),
      setSource: (next: CountSource) => (source = next),
      lock: () => (unchecked = "locked"),
    };
  }
  const one = { kind: "count", count: { usable: 1, matching: 1, unevaluated: 0 } };

  it("counts on a miss after the announcement, inside the vault hold, and caches it", async () => {
    const h = harness();
    await h.counter.announced(1, `${origin}/sign-in`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
    expect(h.events).toEqual(["hold", "job", "job", "job", "release"]);
    expect(h.stored()).toEqual({
      origins: [[origin, JSON.stringify([1]), one.count]],
    });
    // A finished load, another tab and a second announcement use the cached count.
    await h.counter.loaded(2, `${origin}/`);
    await h.counter.announced(1, `${origin}/next`);
    await h.counter.idle();
    expect(h.shown.get(2)).toEqual(one);
    expect(h.step).toHaveBeenCalledTimes(3);
  });

  it("only shows a cached count on activation and at worker start", async () => {
    const h = harness();
    await h.counter.apply(1, `${origin}/`);
    await vi.advanceTimersByTimeAsync(UNANNOUNCED_COUNT_MS * 2);
    await h.counter.idle();
    expect(h.step).not.toHaveBeenCalled();
    expect(h.shown.get(1)).toBeUndefined();
  });

  it("counts 5 seconds after a finished load the page never announced", async () => {
    const h = harness();
    await h.counter.loaded(1, `${origin}/`);
    await vi.advanceTimersByTimeAsync(UNANNOUNCED_COUNT_MS - 1);
    expect(h.step).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
  });

  it("does not wait for the timer once the page announced", async () => {
    const h = harness();
    h.counter.loading(1);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    await h.counter.loaded(1, `${origin}/`);
    await vi.advanceTimersByTimeAsync(UNANNOUNCED_COUNT_MS);
    await h.counter.idle();
    expect(h.step).toHaveBeenCalledTimes(3);
  });

  it("does not count pages other than HTTPS", async () => {
    const h = harness();
    await h.counter.announced(1, "http://login.example/");
    await h.counter.loaded(2, "chrome://newtab/");
    await vi.advanceTimersByTimeAsync(UNANNOUNCED_COUNT_MS);
    await h.counter.idle();
    expect(h.step).not.toHaveBeenCalled();
    expect(h.shown.size).toBe(0);
  });

  it("counts again for new settings, and clears the old count meanwhile", async () => {
    const h = harness();
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    h.setSettings(settings({ excludedItemIds: ["a"] }, {}, 2));
    await h.counter.refresh();
    expect(h.shown.get(1)).toBeUndefined();
    expect(h.step).toHaveBeenCalledTimes(3);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 1, unevaluated: 0, excluded: "items" },
    });
  });

  it("shows not checked, and opens nothing, while a vault is closed or locked", async () => {
    const h = harness({ open: false });
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual({ kind: "unchecked", reason: "not-opened" });
    h.lock();
    await h.counter.refresh();
    expect(h.shown.get(1)).toEqual({ kind: "unchecked", reason: "locked" });
    expect(h.step).not.toHaveBeenCalled();
  });

  it("shows a stored count after a restart even before the vault opens", async () => {
    const h = harness({
      open: false,
      stored: { origins: [[origin, JSON.stringify([1]), one.count]] },
    });
    await h.counter.apply(1, `${origin}/`);
    expect(h.shown.get(1)).toEqual(one);
  });

  it("leaves the count to the page's next announcement when a login stops it", async () => {
    const h = harness();
    h.step.mockImplementationOnce(async () => undefined);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toBeUndefined();
    expect(h.events).toEqual(["hold", "release"]);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
  });

  it("does not show a count for a tab that moved on to another site", async () => {
    const h = harness();
    const announced = h.counter.announced(1, `${origin}/`);
    await h.counter.apply(1, "https://other.example/");
    await announced;
    await h.counter.idle();
    expect(h.step).not.toHaveBeenCalled();
    h.counter.removed(1);
    await h.counter.announced(2, `${origin}/`);
    h.counter.removed(2);
    await h.counter.idle();
    expect(h.shown.get(2)).toBeUndefined();
  });

  it(`keeps the ${SITE_COUNT_LIMIT} most recently used origins`, async () => {
    const stored = Array.from({ length: SITE_COUNT_LIMIT }, (_, index) => [
      `https://site-${index}.example`,
      JSON.stringify([1]),
      one.count,
    ]);
    const h = harness({ stored: { origins: stored } });
    // Using the oldest keeps it; the next oldest goes for the new origin.
    await h.counter.apply(1, "https://site-0.example/");
    await h.counter.announced(2, `${origin}/`);
    await h.counter.idle();
    const origins = (h.stored() as { origins: [string][] }).origins.map(([entry]) => entry);
    expect(origins).toHaveLength(SITE_COUNT_LIMIT);
    expect(origins).toContain("https://site-0.example");
    expect(origins).not.toContain("https://site-1.example");
    expect(origins.at(-1)).toBe(origin);
  });

  it("ignores a stored value it cannot read", async () => {
    const h = harness({ stored: { origins: "nope" } });
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
  });
});
