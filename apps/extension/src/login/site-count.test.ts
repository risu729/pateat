import type { LocalVaultMetadata } from "@pateat/bitwarden";
import type { SettingsChangeCause, SettingsSnapshot, VaultCatalog } from "@pateat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UriCandidates } from "../crypto/wire";
import { vaultFailure, type VaultResult } from "../vault/record";
import {
  SITE_COUNT_LIMIT,
  STOPPED_RETRY_MS,
  UNANNOUNCED_COUNT_MS,
  countSite,
  countedOrigin,
  createCountScope,
  createSiteCounter,
  recountingSettings,
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
      passkeyBrowserSites: [],
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
  unknownPasskeys?: string[];
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
          unavailableItemIds: rpId === "login.example" ? (vault.unknownPasskeys ?? []) : [],
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
  it("counts HTTP(S) pages only", () => {
    expect(countedOrigin(`${origin}/sign-in?next=1`)).toBe(origin);
    expect(countedOrigin("http://login.example:8080/a")).toBe("http://login.example:8080");
    expect(countedOrigin("file:///tmp/a.html")).toBeUndefined();
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

  it("asks for no passkey on an http: page other than localhost (ADR 0050)", async () => {
    const source = live({ uris: ["a"], passkeys: ["a"] });
    expect(await countSite("http://login.example", scope([source]), run)).toEqual({
      kind: "count",
      count: { usable: 1, matching: 1, unevaluated: 0 },
    });
    expect(source.open.matchUris).toHaveBeenCalledWith("http://login.example/");
    expect(source.open.findPasskeys).not.toHaveBeenCalled();
    await countSite("http://localhost:3000", scope([source]), run);
    expect(source.open.findPasskeys).toHaveBeenCalledWith("localhost");
  });

  it("counts excluded items as matching but not usable", async () => {
    const source = live({ items: [{ id: "a" }, { id: "b" }], uris: ["a", "b"] });
    const snapshot = settings({ excludedItemIds: ["b"] });
    expect(await countSite(origin, scope([source], snapshot), run)).toEqual({
      kind: "count",
      count: { usable: 1, matching: 2, unevaluated: 0, excluded: "items" },
    });
    // A quarantined item is named as waiting for its review.
    const review = {
      ...settings(),
      fieldPolicies: [
        { connectionId, snapshotId, quarantinedItemIds: ["b"], protectedItemIds: [] },
      ],
    };
    expect(await countSite(origin, scope([source], review), run)).toEqual({
      kind: "count",
      count: { usable: 1, matching: 2, unevaluated: 0, excluded: "review" },
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

  it("notes only unevaluated items a login could use", async () => {
    const source = live({ items: [{ id: "a" }, { id: "b" }, { id: "c" }], unknown: ["b", "c"] });
    expect(
      await countSite(origin, scope([source], settings({ excludedItemIds: ["c"] })), run),
    ).toEqual({ kind: "count", count: { usable: 0, matching: 0, unevaluated: 1 } });
    const excluded = settings(
      {},
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
    );
    expect(await countSite(origin, scope([source], excluded), run)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 0, unevaluated: 0 },
    });
  });

  it("notes an unread URI rule by the popup's rule and an unread passkey by the passkey rule", async () => {
    // An item with no field a login could fill is usable only for its passkey.
    const source = live({ items: [{ id: "a", fields: [] }], unknown: ["a"] });
    expect(await countSite(origin, scope([source]), run)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 0, unevaluated: 0 },
    });
    const passkey = live({ items: [{ id: "a", fields: [] }], unknownPasskeys: ["a"] });
    expect(await countSite(origin, scope([passkey]), run)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 0, unevaluated: 1 },
    });
    // A quarantined item is never noted.
    const review = {
      ...settings(),
      fieldPolicies: [
        { connectionId, snapshotId, quarantinedItemIds: ["a"], protectedItemIds: [] },
      ],
    };
    const quarantined = live({ items: [{ id: "a" }], unknown: ["a"] });
    expect(await countSite(origin, scope([quarantined], review), run)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 0, unevaluated: 0 },
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
    let current = handle;
    const manager = {
      status: () => (current ? { handle: current } : {}),
      catalog: vi.fn(async () => ({ ok: true as const, data: metadata([{ id: "a" }]) })),
      matchUris: vi.fn(),
      findPasskeys: vi.fn(),
    };
    return {
      manager,
      setHandle: (next?: { snapshotId: string }) => (current = next),
      deps: {
        settings: { read: async () => snapshot },
        registry: { list: async () => [{ profile: { connectionId } }] },
        vaultFor: () => ({ store: { read: async () => record }, manager }),
      } as never,
    };
  }
  /** The popup's and the logins' matchers; these answer as if the vault closed meanwhile. */
  const match = { uris: vi.fn(async () => undefined), passkeys: vi.fn(async () => undefined) };
  const active = { ok: true as const, data: { state: "active", accepted: { snapshotId } } };

  it.each([
    ["unreadable", { ok: false } as Record, undefined],
    ["locked", { ok: true, data: { state: "disabled" } } as Record, undefined],
    ["locked", { ok: true, data: null } as Record, undefined],
    ["updating", active, { snapshotId: "snapshot-2" }],
  ] as const)("answers %s without any crypto job", async (unchecked, record, handle) => {
    const { deps, manager } = connections(record, handle);
    expect(await createCountScope(deps, match)()).toEqual({ unchecked });
    expect(manager.catalog).not.toHaveBeenCalled();
  });

  it("keys the scope by the settings revision and each accepted snapshot", async () => {
    const closed = await createCountScope(connections(active).deps, match)();
    expect(closed).toMatchObject({ key: JSON.stringify([1, [[connectionId, snapshotId]]]) });
    expect(closed).not.toHaveProperty(["sources", 0, "open"]);
    const open = await createCountScope(connections(active, { snapshotId }).deps, match)();
    expect(open).toMatchObject({ key: JSON.stringify([1, [[connectionId, snapshotId]]]) });
    expect(open).toHaveProperty(["sources", 0, "open"]);
    const disabled = await createCountScope(
      connections(active, { snapshotId }, settings({ enabled: false })).deps,
      match,
    )();
    expect(disabled).toMatchObject({ sources: [], key: JSON.stringify([1, []]) });
  });

  it("matches through the shared matchers and reads each snapshot's catalog once", async () => {
    const { deps, manager } = connections(active, { snapshotId });
    const scopeOf = createCountScope(deps, match);
    const opened = async () => {
      const read = await scopeOf();
      const source = "key" in read ? read.sources[0] : undefined;
      if (!source || !("open" in source) || !source.open) throw new Error("not open");
      return source.open;
    };
    const first = await opened();
    expect(await first.catalog()).toMatchObject({ ok: true, data: { snapshotId } });
    const second = await opened();
    expect(await second.catalog()).toMatchObject({ ok: true, data: { snapshotId } });
    // A vault the matchers no longer find open is locked, never a match of nothing.
    expect(await second.matchUris(`${origin}/`)).toEqual(vaultFailure("crypto-locked"));
    expect(await second.findPasskeys("login.example")).toEqual(vaultFailure("crypto-locked"));
    expect(manager.catalog).toHaveBeenCalledTimes(1);
    expect(manager.matchUris).not.toHaveBeenCalled();
    expect(match.uris).toHaveBeenCalledWith(connectionId, `${origin}/`);
    expect(match.passkeys).toHaveBeenCalledWith(connectionId, "login.example");
  });

  it("keeps only what eligibility reads, and drops it once the vault closes", async () => {
    const { deps, manager, setHandle } = connections(active, { snapshotId });
    const scopeOf = createCountScope(deps, match);
    const opened = async () => {
      const read = await scopeOf();
      const source = "key" in read ? read.sources[0] : undefined;
      if (!source || !("open" in source) || !source.open) throw new Error("not open");
      return source.open;
    };
    const read = await (await opened()).catalog();
    expect(read).toEqual({
      ok: true,
      data: {
        connectionId,
        userId: "user",
        snapshotId,
        groups: [],
        items: [
          {
            id: "a",
            label: "",
            type: 1,
            groupIds: [],
            fields: [{ id: "login.password", label: "", name: null, kind: "text" }],
          },
        ],
      },
    });
    // Closed and opened again on the same snapshot, the catalog is read again.
    setHandle(undefined);
    await scopeOf();
    setHandle({ snapshotId });
    await (await opened()).catalog();
    expect(manager.catalog).toHaveBeenCalledTimes(2);
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
    let unchecked: "locked" | "updating" | undefined;
    const shown = new Map<number, SiteCountState | undefined>();
    const history: [number, SiteCountState | undefined][] = [];
    const events: string[] = [];
    const step = vi.fn<CountStep>(async (job) => {
      events.push("job");
      return { value: await job() };
    });
    let scopes = 0;
    const counter = createSiteCounter({
      scope: async () => {
        scopes += 1;
        events.push("scope");
        return unchecked
          ? { unchecked }
          : { snapshot, sources: [source], key: JSON.stringify([snapshot.revision]) };
      },
      hold: async () => {
        events.push("hold");
        return () => events.push("release");
      },
      step: step as CountStep,
      show: (tabId, _origin, state) => {
        shown.set(tabId, state);
        history.push([tabId, state]);
      },
      storage,
    });
    return {
      counter,
      shown,
      history,
      events,
      step,
      storage,
      stored: () => value,
      setSettings: (next: SettingsSnapshot) => (snapshot = next),
      setSource: (next: CountSource) => (source = next),
      lock: () => (unchecked = "locked"),
      setUnchecked: (next: typeof unchecked) => (unchecked = next),
      scopes: () => scopes,
    };
  }
  const one = { kind: "count", count: { usable: 1, matching: 1, unevaluated: 0 } };

  it("counts on a miss after the announcement, inside the vault hold, and caches it", async () => {
    const h = harness();
    await h.counter.announced(1, `${origin}/sign-in`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
    // The final read of what applies now runs after the hold is released.
    expect(h.events).toEqual(["scope", "hold", "scope", "job", "job", "job", "release", "scope"]);
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

  it("does not count pages other than HTTP(S)", async () => {
    const h = harness();
    await h.counter.announced(1, "file:///tmp/sign-in.html");
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
    // A tab whose page has not announced yet only shows.
    h.counter.loading(2);
    await h.counter.loaded(2, `${origin}/b`);
    h.setSettings(settings({ excludedItemIds: ["a"] }, {}, 2));
    h.history.length = 0;
    await h.counter.refresh();
    await h.counter.idle();
    expect(h.history[0]).toEqual([1, undefined]);
    const gray = {
      kind: "count",
      count: { usable: 0, matching: 1, unevaluated: 0, excluded: "items" },
    };
    expect(h.shown.get(1)).toEqual(gray);
    expect(h.shown.get(2)).toEqual(gray);
    expect(h.step).toHaveBeenCalledTimes(6);
  });

  it("does not count on a change for a tab whose page has not settled", async () => {
    const h = harness();
    h.counter.loading(1);
    await h.counter.loaded(1, `${origin}/`);
    h.setSettings(settings({}, {}, 2));
    await h.counter.refresh();
    await h.counter.idle();
    expect(h.step).not.toHaveBeenCalled();
    expect(h.shown.get(1)).toBeUndefined();
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

  it("counts once a synced or restored vault serves its snapshot", async () => {
    const h = harness();
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    // The record write notifies while the old snapshot is still open.
    h.setSettings(settings({ excludedItemIds: ["a"] }, {}, 2));
    h.setUnchecked("updating");
    await h.counter.refresh();
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual({ kind: "unchecked", reason: "updating" });
    // The vault's opened notice refreshes again.
    h.setUnchecked(undefined);
    await h.counter.refresh();
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual({
      kind: "count",
      count: { usable: 0, matching: 1, unevaluated: 0, excluded: "items" },
    });
  });

  it("recounts after a trusted settings update such as a saved account choice", async () => {
    const saved = vi.fn();
    const snapshot = settings({}, {}, 2);
    const base = {
      read: async () => snapshot,
      update: vi.fn(
        async (
          _revision: number | undefined,
          _cause: SettingsChangeCause,
          _mutate: (current: SettingsSnapshot) => SettingsSnapshot,
        ) => snapshot,
      ),
    };
    const wrapped = recountingSettings(base, saved);
    expect(await wrapped.read()).toBe(snapshot);
    await expect(wrapped.update(1, "account-choice", (current) => current)).resolves.toBe(snapshot);
    expect(base.update).toHaveBeenCalledWith(1, "account-choice", expect.any(Function));
    expect(saved).toHaveBeenCalledTimes(1);
    // A refused update is no save.
    base.update.mockRejectedValueOnce(new Error("revision"));
    await expect(wrapped.update(1, "account-choice", (current) => current)).rejects.toThrow(
      "revision",
    );
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("shows a stored count after a restart even before the vault opens", async () => {
    const h = harness({
      open: false,
      stored: { origins: [[origin, JSON.stringify([1]), one.count]] },
    });
    await h.counter.apply(1, `${origin}/`);
    expect(h.shown.get(1)).toEqual(one);
  });

  /** A step that refuses while another frame's hello is being admitted. */
  function admitting(h: ReturnType<typeof harness>) {
    let busy = true;
    h.step.mockImplementation(async (job) => {
      if (busy) return undefined;
      h.events.push("job");
      return { value: await job() };
    });
    return () => (busy = false);
  }
  const busy = { kind: "unchecked", reason: "busy" };

  it("shows a count an iframe's admission stopped as busy and tries it again", async () => {
    const h = harness();
    const admitted = admitting(h);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(busy);
    expect(h.events.filter((event) => event !== "scope")).toEqual(["hold", "release"]);
    // Still admitting at the first retry; done by the second.
    await vi.advanceTimersByTimeAsync(STOPPED_RETRY_MS[0]);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(busy);
    admitted();
    await vi.advanceTimersByTimeAsync(STOPPED_RETRY_MS[1]);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
    // A finished count is not tried again.
    const calls = h.step.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STOPPED_RETRY_MS.reduce((sum, wait) => sum + wait, 0));
    expect(h.step).toHaveBeenCalledTimes(calls);
  });

  it("tries a stopped count again on another hello or when a login ends", async () => {
    const h = harness();
    const ended = admitting(h);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(busy);
    ended();
    // Another tab's handled hello means the admission that stopped it is over.
    await h.counter.announced(2, "https://other.example/");
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
    const login = admitting(h);
    h.setSettings(settings({}, {}, 2));
    await h.counter.refresh();
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(busy);
    login();
    h.counter.retryStopped();
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
  });

  it("stops trying after the last wait, and for a tab that left the site", async () => {
    const h = harness();
    admitting(h);
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    for (const wait of STOPPED_RETRY_MS) {
      // oxlint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(wait);
      // oxlint-disable-next-line no-await-in-loop
      await h.counter.idle();
    }
    const calls = h.step.mock.calls.length;
    expect(calls).toBe(STOPPED_RETRY_MS.length + 1);
    await vi.advanceTimersByTimeAsync(STOPPED_RETRY_MS.at(-1) ?? 0);
    expect(h.step).toHaveBeenCalledTimes(calls);
    expect(h.shown.get(1)).toEqual(busy);
    // A login's end tries again, but not for an origin no tab shows.
    h.counter.removed(1);
    h.counter.retryStopped();
    await h.counter.idle();
    expect(h.step).toHaveBeenCalledTimes(calls);
  });

  it("shows what applies now when settings change during a count", async () => {
    const h = harness();
    h.step.mockImplementation(async (job) => {
      h.setSettings(settings({ excludedItemIds: ["a"] }, {}, 2));
      return { value: await job() };
    });
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    // The count of the previous settings is cached under their key but not shown.
    expect(h.shown.get(1)).toBeUndefined();
    expect(h.stored()).toEqual({ origins: [[origin, JSON.stringify([1]), one.count]] });
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

  it("shows every open tab's cached count from one read at worker start", async () => {
    const h = harness({ stored: { origins: [[origin, JSON.stringify([1]), one.count]] } });
    await h.counter.applyTabs([
      { id: 1, url: `${origin}/a` },
      { id: 2, url: `${origin}/b` },
      { id: 3, url: "chrome://newtab/" },
      { url: `${origin}/` },
    ]);
    expect(h.shown.get(1)).toEqual(one);
    expect(h.shown.get(2)).toEqual(one);
    expect(h.shown.has(3)).toBe(false);
    expect(h.scopes()).toBe(1);
  });

  it("ignores a stored value it cannot read", async () => {
    const h = harness({ stored: { origins: "nope" } });
    await h.counter.announced(1, `${origin}/`);
    await h.counter.idle();
    expect(h.shown.get(1)).toEqual(one);
  });
});
