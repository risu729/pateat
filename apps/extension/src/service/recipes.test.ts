import {
  MAX_ACTIVE_RECIPE_BYTES,
  parseLoginRecipe,
  type LoginRecipe,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createRecipeSync,
  MAX_RECIPE_CACHE_BYTES,
  MAX_RECIPE_PAGES_PER_SYNC,
  RECIPE_SYNC_RATE_LIMIT_MS,
  RECIPE_SYNC_STALE_MS,
} from "./recipes";
import type { ServiceConnection } from "./runtime";
import type { SettingsSyncOutcome } from "./settings-sync";
import type { RecipeChangesResult, ServiceTransport } from "./transport";

// Synthetic service, credential and recipes only.

const SERVICE = "https://pateat.example.com";
const SITE = "https://bank.example";
const DEVICE = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const OTHER_DEVICE = "7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const target = (value: string) => ({ by: "id" as const, value });

function recipe(id: string, firstPath: string, revision = 1, origin = SITE): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin,
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: firstPath, fields: [{ slot: "username", target: target("user") }] },
      { kind: "fill", path: "/password", fields: [{ slot: "password", target: target("pass") }] },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    completion: [{ target: target("welcome") }],
    maxSubmissions: 1,
  });
}
const active = (value: LoginRecipe): SyncRecipeChange => ({
  recipeId: value.id,
  revision: value.revision,
  state: "active",
  recipe: value,
});
const revoked = (recipeId: string, revision: number): SyncRecipeChange => ({
  recipeId,
  revision,
  state: "revoked",
});
const page = (
  changes: SyncRecipeChange[],
  cursor: number,
  complete = true,
): RecipeChangesResult => ({
  kind: "page",
  page: { version: 1, changes, cursor, complete },
});

/** A valid cache with less than one incoming recipe's worth of room left. */
function crowdedCache() {
  const held = recipe("cached-one", "/login");
  const other = { ...held, id: "cached-two" };
  // Long, valid paths and locators fill the real byte limit with fewer recipes.
  // This keeps schema validation, storage cloning and assertions inexpensive under
  // CI coverage, while all tests still exercise the actual 2 MiB boundary.
  const filler = parseLoginRecipe({
    ...held,
    id: "fill-00000",
    steps: [
      ...held.steps.slice(0, 2),
      ...Array.from({ length: 29 }, () => ({
        kind: "assert",
        path: `/${"p".repeat(299)}`,
        target: target("p".repeat(120)),
        present: true,
      })),
      held.steps.at(-1),
    ],
  });
  const empty = { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 7, recipes: [] };
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const smallBytes = bytes(held) + 1;
  const fillerBytes = bytes(filler) + 1;
  const available = MAX_RECIPE_CACHE_BYTES - bytes(empty) - 2 * smallBytes + 1;
  const fillerCount = Math.floor(available / fillerBytes);
  const smallCount = Math.floor((available - fillerCount * fillerBytes) / smallBytes);
  const recipes = [
    held,
    other,
    ...Array.from({ length: fillerCount }, (_, index) => ({
      ...filler,
      id: `fill-${String(index).padStart(5, "0")}`,
    })),
    ...Array.from({ length: smallCount }, (_, index) => ({
      ...held,
      id: `site-${String(index).padStart(5, "0")}`,
    })),
  ];
  return { ...empty, recipes };
}

function exactCache() {
  const cache = crowdedCache();
  const held = cache.recipes[0]!;
  let left = MAX_RECIPE_CACHE_BYTES - new TextEncoder().encode(JSON.stringify(cache)).byteLength;
  const pad = (value: string, limit: number) => {
    const added = Math.min(left, limit - value.length);
    left -= added;
    return value + "p".repeat(added);
  };
  cache.recipes[0] = parseLoginRecipe({
    ...held,
    steps: [
      {
        kind: "fill",
        path: pad("/login", 300),
        fields: [{ slot: "username", target: target(pad("user", 120)) }],
      },
      {
        kind: "fill",
        path: pad("/password", 300),
        fields: [{ slot: "password", target: target(pad("pass", 120)) }],
      },
      { kind: "click", path: "/password", target: target(pad("login", 120)), purpose: "submit" },
    ],
  });
  expect(left).toBe(0);
  expect(new TextEncoder().encode(JSON.stringify(cache)).byteLength).toBe(MAX_RECIPE_CACHE_BYTES);
  return cache;
}

/** Latest heads with actual service page sizes and monotonic sequences. */
function liveFeed(changes: SyncRecipeChange[], start = 7) {
  const heads = changes.map((change, index) => ({ sequence: start + index + 1, change }));
  return async (_origin: string, _credential: string, after: number) => {
    const remaining = heads.filter((head) => head.sequence > after);
    const selected = remaining.slice(0, 100);
    return page(
      selected.map((head) => head.change),
      selected.at(-1)?.sequence ?? after,
      remaining.length <= 100,
    );
  };
}

const incoming = () => [
  active(recipe("incoming-a", "/login")),
  active(recipe("incoming-b", "/login")),
];

function setup(
  options: {
    connection?: ServiceConnection | undefined;
    pages?: RecipeChangesResult[];
    stored?: unknown;
    scheduled?: unknown;
    recovery?: unknown;
    now?: () => number;
    settings?: SettingsSyncOutcome;
  } = {},
) {
  let value = options.stored;
  let scheduled = options.scheduled;
  let recovery = options.recovery;
  const schedule = {
    read: vi.fn(async () => structuredClone(scheduled)),
    write: vi.fn(async (next: unknown) => {
      scheduled = structuredClone(next);
    }),
  };
  const storage = {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (cache: unknown) => {
      value = structuredClone(cache);
    }),
    readRecovery: vi.fn(async () => structuredClone(recovery)),
    writeRecovery: vi.fn(async (next: unknown) => {
      recovery = structuredClone(next);
    }),
    clear: vi.fn(async () => {
      value = undefined;
      recovery = undefined;
    }),
  };
  const connection =
    "connection" in options
      ? options.connection
      : { origin: SERVICE, deviceId: DEVICE, credential: CREDENTIAL, rejected: false };
  const service = {
    connection: vi.fn<() => Promise<ServiceConnection | undefined>>(async () => connection),
    recordSync: vi.fn(async () => undefined),
  };
  const pages = [...(options.pages ?? [page([], 0)])];
  const transport = {
    recipeChanges: vi.fn<ServiceTransport["recipeChanges"]>(
      async () => pages.shift() ?? page([], 0),
    ),
  };
  const settingsSync = {
    run: vi.fn(async () => options.settings ?? "synced"),
    clear: vi.fn(async () => undefined),
  };
  const report = vi.fn();
  const sync = createRecipeSync({
    service,
    transport,
    storage,
    schedule,
    report,
    now: options.now ?? (() => 5_000),
    ...(options.settings ? { settings: settingsSync } : {}),
  });
  return {
    sync,
    report,
    settingsSync,
    service,
    transport,
    storage,
    cache: () => value as Record<string, unknown>,
    schedule: () => scheduled,
    recovery: () => recovery,
  };
}

describe("recipe sync", () => {
  it("does nothing without a paired device and clears a leftover cache", async () => {
    const stored = { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [] };
    const { sync, transport, report, cache } = setup({ stored, connection: undefined });
    expect(await sync.sync()).toBe("not-connected");
    expect(cache()).toBeUndefined();
    expect(transport.recipeChanges).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith("not-connected", {
      scope: "full",
      added: 0,
      updated: 0,
      removed: 0,
    });
  });

  it("applies pages of changes and records a complete sync", async () => {
    const first = recipe("bank-signin", "/login");
    const second = recipe("bank-otp", "/otp");
    const { sync, transport, service, cache, report } = setup({
      pages: [
        page([active(first), active(second)], 2, false),
        page([revoked("bank-otp", 2), active(recipe("bank-signin", "/login", 2))], 4),
      ],
    });
    expect(await sync.sync()).toBe("synced");
    // The log counts both pages' changes against the cache they were applied to.
    expect(report).toHaveBeenCalledExactlyOnceWith("synced", {
      scope: "full",
      added: 2,
      updated: 1,
      removed: 1,
    });
    expect(transport.recipeChanges.mock.calls).toEqual([
      [SERVICE, CREDENTIAL, 0],
      [SERVICE, CREDENTIAL, 2],
    ]);
    expect(cache()).toEqual({
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 4,
      recipes: [recipe("bank-signin", "/login", 2)],
    });
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { syncedAt: 5_000 });
  });

  it("counts no change for a recipe added and revoked in one page or an uncached revoke", async () => {
    const { sync, report } = setup({
      pages: [
        page([active(recipe("bank-otp", "/otp")), revoked("bank-otp", 2), revoked("x", 3)], 3),
      ],
    });
    expect(await sync.sync()).toBe("synced");
    expect(report).toHaveBeenCalledExactlyOnceWith("synced", {
      scope: "full",
      added: 0,
      updated: 0,
      removed: 0,
    });
  });

  it("continues from the stored cursor", async () => {
    const stored = { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 7, recipes: [] };
    const { sync, transport } = setup({ stored, pages: [page([], 7)] });
    await sync.sync();
    expect(transport.recipeChanges).toHaveBeenCalledWith(SERVICE, CREDENTIAL, 7);
  });

  it("starts over for another pairing or an unreadable cache", async () => {
    for (const stored of [
      {
        version: 1,
        origin: SERVICE,
        deviceId: OTHER_DEVICE,
        cursor: 9,
        recipes: [recipe("x", "/")],
      },
      { version: 1, origin: "https://other.example.com", deviceId: DEVICE, cursor: 9, recipes: [] },
      { version: 2 },
    ]) {
      const { sync, transport, cache } = setup({ stored, pages: [page([], 0)] });
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      await sync.sync();
      expect(transport.recipeChanges).toHaveBeenCalledWith(SERVICE, CREDENTIAL, 0);
      expect(cache()).toMatchObject({ deviceId: DEVICE, cursor: 0, recipes: [] });
    }
  });

  it("keeps the cache and stops syncing once the service rejects the device", async () => {
    const stored = {
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 3,
      recipes: [recipe("bank-signin", "/login")],
    };
    const { sync, service, cache } = setup({ stored, pages: [{ kind: "rejected" }] });
    expect(await sync.sync()).toBe("rejected");
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { rejected: true });
    expect(cache()).toEqual(stored);

    const later = setup({
      stored,
      connection: { origin: SERVICE, deviceId: DEVICE, credential: CREDENTIAL, rejected: true },
    });
    expect(await later.sync.sync()).toBe("rejected");
    expect(later.transport.recipeChanges).not.toHaveBeenCalled();
    expect(await later.sync.recipes.recipe(SITE, "/login")).toEqual(
      recipe("bank-signin", "/login"),
    );
  });

  it("keeps the last consistent copy when a page fails", async () => {
    const { sync, cache, service } = setup({
      pages: [
        page([active(recipe("bank-signin", "/login"))], 1, false),
        { kind: "failed", error: "unreachable" },
      ],
    });
    expect(await sync.sync()).toBe("unreachable");
    expect(cache()).toMatchObject({ cursor: 1, recipes: [recipe("bank-signin", "/login")] });
    expect(service.recordSync).not.toHaveBeenCalled();
  });

  it("does not advance the cursor when the cache cannot be written", async () => {
    const { sync, storage, service, transport } = setup({
      pages: [page([active(recipe("bank-signin", "/login"))], 1)],
    });
    storage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await sync.sync()).toBe("storage-unavailable");
    expect(service.recordSync).not.toHaveBeenCalled();
    // The next sync asks again from the old cursor.
    await sync.sync();
    expect(transport.recipeChanges).toHaveBeenLastCalledWith(SERVICE, CREDENTIAL, 0);
  });

  it("refuses an incomplete page that does not move the cursor", async () => {
    const { sync, transport } = setup({ pages: [page([], 0, false)] });
    expect(await sync.sync()).toBe("unexpected-response");
    expect(transport.recipeChanges).toHaveBeenCalledOnce();
  });

  it("reads a bounded number of pages per sync", async () => {
    const pages = Array.from({ length: MAX_RECIPE_PAGES_PER_SYNC + 1 }, (_, index) =>
      page([], index + 1, false),
    );
    const { sync, transport, service } = setup({ pages });
    expect(await sync.sync()).toBe("incomplete");
    expect(transport.recipeChanges).toHaveBeenCalledTimes(MAX_RECIPE_PAGES_PER_SYNC);
    expect(service.recordSync).not.toHaveBeenCalled();
  });

  it("joins a sync that is already running", async () => {
    let release: (result: RecipeChangesResult) => void = () => undefined;
    const { sync, transport } = setup();
    transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = sync.sync();
    const second = sync.sync();
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledOnce());
    release(page([], 0));
    expect(await first).toBe("synced");
    expect(await second).toBe("synced");
    // The joined request runs once more, so changes made meanwhile are not missed.
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
  });

  it("syncs a device paired while an older device's sync was running", async () => {
    let release: (result: RecipeChangesResult) => void = () => undefined;
    const { sync, transport, service, cache } = setup();
    transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = sync.sync();
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledOnce());
    const NEXT = `pateat_device_${"N".repeat(43)}`;
    service.connection.mockResolvedValue({
      origin: SERVICE,
      deviceId: OTHER_DEVICE,
      credential: NEXT,
      rejected: false,
    });
    const paired = sync.sync();
    release({ kind: "rejected" });
    expect(await first).toBe("synced");
    expect(await paired).toBe("synced");
    expect(transport.recipeChanges).toHaveBeenLastCalledWith(SERVICE, NEXT, 0);
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { rejected: true });
    expect(service.recordSync).toHaveBeenLastCalledWith(OTHER_DEVICE, { syncedAt: 5_000 });
    expect(cache()).toMatchObject({ deviceId: OTHER_DEVICE });
  });

  it("recovers additions before later shrinking current heads when both service snapshots fit", async () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const small = recipe("old-000", "/login");
    const large = parseLoginRecipe({
      ...small,
      steps: [
        ...small.steps.slice(0, 2),
        ...Array.from({ length: 29 }, () => ({
          kind: "assert",
          path: `/${"p".repeat(299)}`,
          target: target("p".repeat(120)),
          present: true,
        })),
        small.steps.at(-1),
      ],
    });
    const old = Array.from(
      { length: Math.floor((MAX_ACTIVE_RECIPE_BYTES * 0.9) / bytes(large)) },
      (_, i) => ({ ...large, id: `old-${String(i).padStart(3, "0")}` }),
    );
    const added = Array.from(
      { length: Math.floor((MAX_ACTIVE_RECIPE_BYTES * 0.65) / bytes(large)) },
      (_, i) => ({ ...large, id: `new-${String(i).padStart(3, "0")}` }),
    );
    // The service first shrinks these to revision 2, admits the new recipes, then
    // writes equal-sized revision 3s. Its latest-head feed sorts the new recipes first.
    const shrunk = old.map((held) => ({ ...small, id: held.id, revision: 3 }));
    expect(old.length).toBeLessThanOrEqual(100);
    expect(added.length).toBeLessThanOrEqual(100);
    // Both the old service snapshot and the final heads obey its active-document cap.
    expect(old.reduce((sum, held) => sum + bytes(held), 0)).toBeLessThan(MAX_ACTIVE_RECIPE_BYTES);
    expect([...added, ...shrunk].reduce((sum, held) => sum + bytes(held), 0)).toBeLessThan(
      MAX_ACTIVE_RECIPE_BYTES,
    );
    const stored = { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: old };
    expect(bytes({ ...stored, recipes: [...old, ...added] })).toBeGreaterThan(
      MAX_RECIPE_CACHE_BYTES,
    );
    const { sync, cache, transport } = setup({ stored });
    // These shrinking current heads are later than the additions in the live feed.
    transport.recipeChanges.mockImplementation(async (_origin, _credential, cursor) =>
      cursor === 1 ? page(added.map(active), 2, false) : page(shrunk.map(active), 3),
    );
    expect(await sync.sync()).toBe("synced");
    expect(cache()).toEqual({ ...stored, cursor: 3, recipes: [...shrunk, ...added] });
    expect(bytes(cache())).toBeLessThan(MAX_RECIPE_CACHE_BYTES);
    expect(transport.recipeChanges.mock.calls.map(([, , cursor]) => cursor)).toEqual([1, 2, 1, 2]);
  });

  it.each(["shrinks", "revocations"] as const)(
    "continues %s beyond 50 pages across worker restarts with an exactly full old cache",
    async (reducing) => {
      const stored = exactCache();
      const shrunk = stored.recipes.map((held) => recipe(held.id, "/login", 3));
      const reductions =
        reducing === "shrinks"
          ? shrunk.map(active)
          : stored.recipes.map((held) => revoked(held.id, 3));
      const heads = [
        ...incoming(),
        ...Array.from({ length: 5_000 }, (_, index) => revoked(`gone-${index}`, 2)),
        ...reductions,
      ];
      const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      expect(
        [...incoming(), ...shrunk.map(active)].reduce(
          (sum, change) => sum + (change.state === "active" ? bytes(change.recipe) : 0),
          0,
        ),
      ).toBeLessThan(MAX_ACTIVE_RECIPE_BYTES);
      const first = setup({ stored });
      first.transport.recipeChanges.mockImplementation(liveFeed(heads));
      expect(await first.sync.sync()).toBe("cache-full");
      expect(first.cache()).toEqual(stored);
      expect(first.recovery()).toEqual({
        version: 1,
        origin: SERVICE,
        deviceId: DEVICE,
        cursor: 7,
        after: 5_007,
      });
      expect(bytes(first.cache())).toBe(MAX_RECIPE_CACHE_BYTES);
      expect(bytes(first.recovery())).toBeLessThan(256);
      expect(first.transport.recipeChanges).toHaveBeenCalledTimes(MAX_RECIPE_PAGES_PER_SYNC + 1);
      expect(first.report).toHaveBeenCalledWith("cache-full", {
        scope: "full",
        added: 0,
        updated: 0,
        removed: 0,
      });
      const second = setup({ stored: first.cache(), recovery: first.recovery() });
      second.transport.recipeChanges.mockImplementation(liveFeed(heads));
      expect(await second.sync.sync()).toBe("incomplete");
      expect(
        second.transport.recipeChanges.mock.calls.slice(0, 2).map(([, , cursor]) => cursor),
      ).toEqual([7, 5_007]);
      expect(second.transport.recipeChanges).toHaveBeenCalledTimes(MAX_RECIPE_PAGES_PER_SYNC + 1);
      expect(second.cache()).toMatchObject({ cursor: 4_807 });
      expect(bytes(second.cache())).toBeLessThan(MAX_RECIPE_CACHE_BYTES);
      const third = setup({ stored: second.cache(), recovery: second.recovery() });
      third.transport.recipeChanges.mockImplementation(liveFeed(heads));
      expect(await third.sync.sync()).toBe("synced");
      expect(third.cache()).toEqual({
        ...stored,
        cursor: 7 + heads.length,
        recipes: [
          ...(reducing === "shrinks" ? shrunk : []),
          recipe("incoming-a", "/login"),
          recipe("incoming-b", "/login"),
        ],
      });
      expect(third.report).toHaveBeenCalledWith("synced", {
        scope: "full",
        added: 0,
        updated: 0,
        removed: 0,
      });
    },
  );

  it("retains a safely saved shrink when its checkpoint fails and repeats work after restart", async () => {
    const stored = crowdedCache();
    const shrinking = recipe(stored.recipes[2]!.id, "/small", 2);
    const first = setup({
      stored,
      pages: [page(incoming(), 9, false), page([active(shrinking)], 10)],
    });
    first.storage.writeRecovery.mockRejectedValueOnce(new Error("checkpoint unavailable"));
    expect(await first.sync.sync()).toBe("storage-unavailable");
    expect(first.transport.recipeChanges).toHaveBeenCalledOnce();
    expect(first.cache()).toEqual(stored);
    expect(first.recovery()).toBeUndefined();
    const second = setup({
      stored,
      pages: [page(incoming(), 9, false), page([active(shrinking)], 10)],
    });
    const write = second.storage.writeRecovery.getMockImplementation()!;
    second.storage.writeRecovery.mockImplementationOnce(write);
    second.storage.writeRecovery.mockRejectedValueOnce(new Error("checkpoint unavailable"));
    expect(await second.sync.sync()).toBe("storage-unavailable");
    expect(second.cache()).toEqual({
      ...stored,
      recipes: [stored.recipes[0], stored.recipes[1], shrinking, ...stored.recipes.slice(3)],
    });
    expect(second.recovery()).toMatchObject({ cursor: 7, after: 9 });
    expect(second.report).toHaveBeenCalledWith("storage-unavailable", {
      scope: "full",
      added: 0,
      updated: 1,
      removed: 0,
    });
    expect(second.transport.recipeChanges).toHaveBeenCalledTimes(2);
    const restarted = setup({
      stored: second.cache(),
      recovery: second.recovery(),
      pages: [page([...incoming(), active(shrinking)], 10)],
    });
    expect(await restarted.sync.sync()).toBe("synced");
    expect(restarted.report).toHaveBeenCalledWith("synced", {
      scope: "full",
      added: 2,
      updated: 0,
      removed: 0,
    });
  });

  it("does not checkpoint a failed shrinking cache write", async () => {
    const stored = crowdedCache();
    const shrinking = recipe(stored.recipes[2]!.id, "/small", 2);
    const h = setup({ stored, pages: [page(incoming(), 9, false), page([active(shrinking)], 10)] });
    h.storage.write.mockRejectedValueOnce(new Error("cache unavailable"));
    expect(await h.sync.sync()).toBe("storage-unavailable");
    expect(h.cache()).toEqual(stored);
    expect(h.recovery()).toMatchObject({ cursor: 7, after: 9 });
    expect(h.transport.recipeChanges).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledWith(
      "storage-unavailable",
      expect.objectContaining({ updated: 0 }),
    );
  });

  it("preserves the cache when its recovery checkpoint cannot be read", async () => {
    const stored = crowdedCache();
    const h = setup({ stored });
    h.storage.readRecovery.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await h.sync.sync()).toBe("storage-unavailable");
    expect(h.cache()).toEqual(stored);
    expect(h.transport.recipeChanges).not.toHaveBeenCalled();
  });

  it.each([
    { origin: "https://other.example", deviceId: DEVICE, cursor: 7, after: 99 },
    { origin: SERVICE, deviceId: OTHER_DEVICE, cursor: 7, after: 99 },
    { origin: SERVICE, deviceId: DEVICE, cursor: 6, after: 99 },
    { origin: SERVICE, deviceId: DEVICE, cursor: 7, after: 6 },
    { origin: SERVICE, deviceId: DEVICE, cursor: 7, after: "99" },
  ])("ignores an invalid or differently bound checkpoint: %j", async (record) => {
    const h = setup({
      stored: crowdedCache(),
      recovery: { version: 1, ...record },
      pages: [page(incoming(), 9, false), page([], 10), page(incoming(), 9, false)],
    });
    expect(await h.sync.sync()).toBe("cache-full");
    expect(h.transport.recipeChanges.mock.calls.map(([, , cursor]) => cursor)).toEqual([7, 9, 7]);
  });

  it.each([undefined, { version: 1, recipes: "invalid" }])(
    "does not resume lookahead without a valid paired cache: %j",
    async (stored) => {
      const h = setup({
        stored,
        recovery: { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 0, after: 99 },
        pages: [page(incoming(), 9)],
      });
      expect(await h.sync.sync()).toBe("synced");
      expect(h.storage.readRecovery).not.toHaveBeenCalled();
      expect(h.transport.recipeChanges).toHaveBeenCalledExactlyOnceWith(SERVICE, CREDENTIAL, 0);
      expect(h.cache()).toMatchObject({ cursor: 9 });
    },
  );

  it("never downgrades a newer held revision during lookahead or its normal retry", async () => {
    const stored = crowdedCache();
    const latest = recipe("cached-two", "/latest", 4);
    stored.recipes[1] = latest;
    const shrinking = recipe(stored.recipes[2]!.id, "/small", 2);
    const old = active(recipe("cached-two", "/old", 2));
    const h = setup({
      stored,
      pages: [
        page([...incoming(), old], 9, false),
        page([active(shrinking), old], 10),
        page([...incoming(), old], 9, false),
        page([active(shrinking)], 10),
      ],
    });
    expect(await h.sync.sync()).toBe("synced");
    expect(
      (h.cache()["recipes"] as LoginRecipe[]).find((held) => held.id === "cached-two"),
    ).toEqual(latest);
    expect(h.report).toHaveBeenCalledWith("synced", {
      scope: "full",
      added: 2,
      updated: 1,
      removed: 0,
    });
  });

  it.each([false, true])(
    "refetches current heads after a concurrent revocation (republished: %s)",
    async (republished) => {
      const stored = crowdedCache();
      const shrinking = recipe(stored.recipes[2]!.id, "/small", 2);
      const oldHead = active(recipe("cached-one", "/old", 2));
      const current = republished
        ? active(recipe("cached-one", "/new", 4))
        : revoked("cached-one", 3);
      const h = setup({
        stored,
        pages: [
          page([...incoming(), oldHead], 9, false),
          page([active(shrinking), revoked("cached-one", 3)], 11),
          page([...incoming(), current], 12),
        ],
      });
      expect(await h.sync.sync()).toBe("synced");
      expect(h.transport.recipeChanges.mock.calls.map(([, , cursor]) => cursor)).toEqual([7, 9, 7]);
      expect(
        (h.cache()["recipes"] as LoginRecipe[]).find((held) => held.id === "cached-one"),
      ).toEqual(republished ? recipe("cached-one", "/new", 4) : undefined);
      expect(h.report).toHaveBeenCalledWith("synced", {
        scope: "full",
        added: republished ? 3 : 2,
        updated: 2,
        removed: 1,
      });
    },
  );

  it("rejects a UTF-8 growing active head during lookahead even when its character count is unchanged", async () => {
    const stored = crowdedCache();
    stored.recipes[1] = parseLoginRecipe({
      ...recipe("cached-two", "/x"),
      completion: [{ target: { by: "text", value: "x" } }],
    });
    const growing = parseLoginRecipe({
      ...stored.recipes[1],
      revision: 2,
      completion: [{ target: { by: "text", value: "日" } }],
    });
    const h = setup({
      stored,
      pages: [page(incoming(), 9, false), page([active(growing)], 10), page(incoming(), 9, false)],
    });
    expect(await h.sync.sync()).toBe("cache-full");
    expect(h.cache()).toEqual(stored);
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(h.report).toHaveBeenCalledWith("cache-full", {
      scope: "full",
      added: 0,
      updated: 0,
      removed: 0,
    });
  });

  it("does not use a checkpoint loaded after disconnect clearing", async () => {
    const h = setup({ stored: crowdedCache() });
    let loaded: (value: unknown) => void = () => undefined;
    h.storage.readRecovery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    const running = h.sync.sync();
    await vi.waitFor(() => expect(h.storage.readRecovery).toHaveBeenCalledOnce());
    await h.sync.clear();
    loaded({ version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 7, after: 99 });
    expect(await running).toBe("not-connected");
    expect(h.transport.recipeChanges).not.toHaveBeenCalled();
    expect(h.cache()).toBeUndefined();
    expect(h.recovery()).toBeUndefined();
  });

  it("waits for a late checkpoint write before clearing and re-pairing", async () => {
    const h = setup({ stored: crowdedCache(), pages: [page(incoming(), 9, false)] });
    const write = h.storage.writeRecovery.getMockImplementation()!;
    let finish: () => void = () => undefined;
    h.storage.writeRecovery.mockImplementationOnce(async (next) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await write(next);
    });
    const running = h.sync.sync();
    await vi.waitFor(() => expect(h.storage.writeRecovery).toHaveBeenCalledOnce());
    const clearing = h.sync.clear();
    expect(h.storage.clear).not.toHaveBeenCalled();
    finish();
    await clearing;
    expect(await running).toBe("not-connected");
    expect(h.cache()).toBeUndefined();
    expect(h.recovery()).toBeUndefined();
    const restarted = setup({ stored: h.cache(), recovery: h.recovery(), pages: [page([], 0)] });
    expect(await restarted.sync.sync()).toBe("synced");
    expect(restarted.transport.recipeChanges).toHaveBeenCalledExactlyOnceWith(
      SERVICE,
      CREDENTIAL,
      0,
    );
  });

  it("stops before the cache outgrows its share of local storage", async () => {
    const stored = {
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 1,
      recipes: [recipe("bank-signin", "/login")],
    };
    const size = new TextEncoder().encode(JSON.stringify(recipe("site-0", "/login"))).byteLength;
    const many = Array.from({ length: Math.ceil(MAX_RECIPE_CACHE_BYTES / size) + 1 }, (_, index) =>
      active(recipe(`site-${index}`, "/login", 1, `https://site-${index}.example`)),
    );
    const { sync, service, storage, cache, report } = setup({
      stored,
      pages: [page(many, 2), page(many, 2)],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(storage.write).not.toHaveBeenCalled();
    expect(cache()).toEqual(stored);
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { cacheFull: true });
    // A page that was not written changed nothing.
    expect(report).toHaveBeenCalledWith("cache-full", expect.objectContaining({ added: 0 }));
  });

  it("removes a later revocation without advancing past an overflowing page", async () => {
    const stored = crowdedCache();
    const { sync, transport, storage, cache, report } = setup({
      stored,
      pages: [
        page(incoming(), 9, false),
        page([revoked("cached-one", 2)], 10),
        page(incoming(), 9, false),
      ],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(storage.write).toHaveBeenCalledOnce();
    expect(cache()).toEqual({ ...stored, recipes: stored.recipes.slice(1) });
    expect(transport.recipeChanges.mock.calls).toEqual([
      [SERVICE, CREDENTIAL, 7],
      [SERVICE, CREDENTIAL, 9],
      [SERVICE, CREDENTIAL, 7],
    ]);
    expect(await sync.recipes.recipe(SITE, "/login", "cached-one")).toBeUndefined();
    expect(report).toHaveBeenCalledWith("cache-full", {
      scope: "full",
      added: 0,
      updated: 0,
      removed: 1,
    });
  });

  it("applies revocations inside the overflowing page itself", async () => {
    const stored = crowdedCache();
    const overflowing = [
      ...incoming(),
      active(recipe("incoming-c", "/login")),
      revoked("cached-one", 2),
    ];
    const { sync, storage, cache } = setup({
      stored,
      pages: [page(overflowing, 11), page(overflowing, 11)],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(storage.write).toHaveBeenCalledOnce();
    expect(cache()).toEqual({ ...stored, recipes: stored.recipes.slice(1) });
  });

  it("keeps a reactivation missing while applying a non-growing update to a held recipe", async () => {
    const stored = crowdedCache();
    const { sync, cache, report } = setup({
      stored,
      pages: [
        page(incoming(), 9, false),
        page([revoked("cached-one", 2)], 10, false),
        page(
          [active(recipe("cached-one", "/login", 3)), active(recipe("cached-two", "/new", 2))],
          12,
        ),
        page(incoming(), 9, false),
      ],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(cache()).toEqual({
      ...stored,
      recipes: [recipe("cached-two", "/new", 2), ...stored.recipes.slice(2)],
    });
    expect(report).toHaveBeenCalledWith(
      "cache-full",
      expect.objectContaining({ updated: 1, removed: 1 }),
    );
  });

  it("retries the stuck page in the same sync when revocations free enough room", async () => {
    const stored = crowdedCache();
    const removals = [revoked("cached-one", 2), revoked("cached-two", 2)];
    const { sync, transport, storage, cache, report } = setup({
      stored,
      pages: [
        page(incoming(), 9, false),
        page(removals, 11),
        page(incoming(), 9, false),
        page(removals, 11),
      ],
    });
    expect(await sync.sync()).toBe("synced");
    expect(storage.write.mock.calls.map(([value]) => (value as { cursor: number }).cursor)).toEqual(
      [7, 9, 11],
    );
    expect(transport.recipeChanges.mock.calls.map(([, , cursor]) => cursor)).toEqual([7, 9, 7, 9]);
    expect(cache()).toEqual({
      ...stored,
      cursor: 11,
      recipes: [
        ...stored.recipes.slice(2),
        recipe("incoming-a", "/login"),
        recipe("incoming-b", "/login"),
      ],
    });
    expect(report).toHaveBeenCalledWith("synced", {
      scope: "full",
      added: 2,
      updated: 0,
      removed: 2,
    });
  });

  it("bounds the revoke-only walk and retries once without skipping unseen pages", async () => {
    const stored = crowdedCache();
    const { sync, transport, cache } = setup({
      stored,
      pages: [
        page(incoming(), 9, false),
        ...Array.from({ length: MAX_RECIPE_PAGES_PER_SYNC - 1 }, (_, index) =>
          page(
            index === MAX_RECIPE_PAGES_PER_SYNC - 2 ? [revoked("cached-one", 2)] : [],
            10 + index,
            false,
          ),
        ),
        page(incoming(), 9, false),
        page([revoked("cached-two", 2)], 60),
      ],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(transport.recipeChanges).toHaveBeenCalledTimes(MAX_RECIPE_PAGES_PER_SYNC + 1);
    expect(transport.recipeChanges).toHaveBeenLastCalledWith(SERVICE, CREDENTIAL, 7);
    expect(cache()).toEqual({ ...stored, recipes: stored.recipes.slice(1) });
  });

  it("keeps revocations newly returned by a still-overflowing retry", async () => {
    const stored = crowdedCache();
    const { sync, cache, transport } = setup({
      stored,
      pages: [
        page([...incoming(), active(recipe("incoming-c", "/login"))], 10),
        page([...incoming(), active(recipe("incoming-c", "/login")), revoked("cached-one", 2)], 11),
      ],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(cache()).toEqual({ ...stored, recipes: stored.recipes.slice(1) });
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
  });

  it("does not advance to the scan cursor when a fitting retry exhausts the page budget", async () => {
    const stored = crowdedCache();
    const { sync, cache, transport } = setup({
      stored,
      pages: [
        page(incoming(), 9, false),
        ...Array.from({ length: MAX_RECIPE_PAGES_PER_SYNC - 1 }, (_, index) =>
          page(
            index === MAX_RECIPE_PAGES_PER_SYNC - 2
              ? [revoked("cached-one", 2), revoked("cached-two", 2)]
              : [],
            10 + index,
            false,
          ),
        ),
        page(incoming(), 9, false),
      ],
    });
    expect(await sync.sync()).toBe("incomplete");
    expect(cache()).toMatchObject({ cursor: 9 });
    expect(transport.recipeChanges).toHaveBeenCalledTimes(MAX_RECIPE_PAGES_PER_SYNC + 1);
  });

  it("records a rejected device during the revoke-only walk", async () => {
    const stored = crowdedCache();
    const { sync, service, cache, transport } = setup({
      stored,
      pages: [page(incoming(), 9, false), { kind: "rejected" }],
    });
    expect(await sync.sync()).toBe("rejected");
    expect(service.recordSync).toHaveBeenCalledExactlyOnceWith(DEVICE, { rejected: true });
    expect(cache()).toEqual(stored);
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
  });

  it("shares the page limit with normal pages read before an overflow", async () => {
    const full = crowdedCache();
    const stored = { ...full, recipes: full.recipes.slice(0, 2) };
    const { sync, transport, cache } = setup({
      stored,
      pages: [
        // Fill the cache in the last two normal pages instead of rewriting 2 MiB
        // on every empty page. Both active pages obey the 100-change service limit.
        ...Array.from({ length: MAX_RECIPE_PAGES_PER_SYNC - 1 }, (_, index) =>
          page(
            index === MAX_RECIPE_PAGES_PER_SYNC - 3
              ? full.recipes.slice(2, 102).map(active)
              : index === MAX_RECIPE_PAGES_PER_SYNC - 2
                ? full.recipes.slice(102).map(active)
                : [],
            8 + index,
            false,
          ),
        ),
        page(
          [...incoming(), active(recipe("incoming-c", "/login")), revoked("cached-one", 2)],
          60,
          false,
        ),
        page(incoming(), 59, false),
      ],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(transport.recipeChanges).toHaveBeenCalledTimes(MAX_RECIPE_PAGES_PER_SYNC + 1);
    expect(transport.recipeChanges).toHaveBeenLastCalledWith(SERVICE, CREDENTIAL, 56);
    expect(cache()).toEqual({ ...full, cursor: 56, recipes: full.recipes.slice(1) });
  });

  it.each(["unreachable", "rate-limited", "unexpected-response"] as const)(
    "keeps applied revocations if a later overflow request is %s",
    async (error) => {
      const stored = crowdedCache();
      const { sync, cache, report } = setup({
        stored,
        pages: [
          page(incoming(), 9, false),
          page([revoked("cached-one", 2)], 10, false),
          { kind: "failed", error },
        ],
      });
      expect(await sync.sync()).toBe(error);
      expect(cache()).toEqual({ ...stored, recipes: stored.recipes.slice(1) });
      expect(report).toHaveBeenCalledWith(error, expect.objectContaining({ removed: 1 }));
    },
  );

  it("does not retry or lose the old cache if persisting a revocation fails", async () => {
    const stored = crowdedCache();
    const { sync, storage, transport, cache, report } = setup({
      stored,
      pages: [page(incoming(), 9, false), page([revoked("cached-one", 2)], 10)],
    });
    storage.write.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await sync.sync()).toBe("storage-unavailable");
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
    expect(cache()).toEqual(stored);
    expect(report).toHaveBeenCalledWith(
      "storage-unavailable",
      expect.objectContaining({ removed: 0 }),
    );
  });

  it("rejects a stalled local scan cursor instead of walking the same page repeatedly", async () => {
    const stored = crowdedCache();
    const { sync, storage, transport } = setup({
      stored,
      pages: [page(incoming(), 9, false), page([revoked("cached-one", 2)], 9, false)],
    });
    expect(await sync.sync()).toBe("unexpected-response");
    expect(storage.write).not.toHaveBeenCalled();
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
  });

  it("does not restore revoked recipes after a disconnect during the overflow walk", async () => {
    const stored = crowdedCache();
    const { sync, transport, storage, cache } = setup({ stored });
    let release: (result: RecipeChangesResult) => void = () => undefined;
    transport.recipeChanges.mockResolvedValueOnce(page(incoming(), 9, false));
    transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = sync.sync();
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledTimes(2));
    await sync.clear();
    release(page([revoked("cached-one", 2)], 10));
    expect(await running).toBe("not-connected");
    expect(storage.write).not.toHaveBeenCalled();
    expect(cache()).toBeUndefined();
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
  });

  it("does not write a disconnected device's recipes back after clearing", async () => {
    let release: (result: RecipeChangesResult) => void = () => undefined;
    const { sync, transport, storage, cache } = setup();
    transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = sync.sync();
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledOnce());
    await sync.clear();
    release(page([active(recipe("bank-signin", "/login"))], 3));
    expect(await running).toBe("not-connected");
    expect(storage.write).not.toHaveBeenCalled();
    expect(cache()).toBeUndefined();
  });

  it("erases a late durable cache write before disconnect clearing resolves", async () => {
    const h = setup({ pages: [page([active(recipe("bank-signin", "/login"))], 1)] });
    const write = h.storage.write.getMockImplementation()!;
    let finish: () => void = () => undefined;
    h.storage.write.mockImplementationOnce(async (next) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await write(next);
    });
    const running = h.sync.sync();
    await vi.waitFor(() => expect(h.storage.write).toHaveBeenCalledOnce());
    const clearing = h.sync.clear();
    expect(h.storage.clear).not.toHaveBeenCalled();
    finish();
    await clearing;
    expect(await running).toBe("not-connected");
    expect(h.cache()).toBeUndefined();
    expect(h.recovery()).toBeUndefined();
  });

  it("does not use a disconnected device's credential after loading its cache", async () => {
    const { sync, storage, transport } = setup();
    let loaded: (value: unknown) => void = () => undefined;
    storage.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    const running = sync.sync();
    await vi.waitFor(() => expect(storage.read).toHaveBeenCalledOnce());
    await sync.clear();
    loaded(undefined);
    expect(await running).toBe("not-connected");
    expect(transport.recipeChanges).not.toHaveBeenCalled();
  });

  it("keeps the cache when the paired device cannot be read", async () => {
    const stored = { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [] };
    const { sync, service, cache } = setup({ stored });
    service.connection.mockRejectedValue(new Error("storage"));
    expect(await sync.sync()).toBe("storage-unavailable");
    expect(cache()).toEqual(stored);
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("forgets the cache when its device is disconnected", async () => {
    const stored = {
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 1,
      recipes: [recipe("bank-signin", "/login")],
    };
    const { sync, cache } = setup({
      stored,
      scheduled: { version: 1, startedAt: 0, retryAt: 9e9 },
    });
    expect(await sync.recipes.recipe(SITE, "/login")).toBeDefined();
    await sync.clear();
    expect(cache()).toBeUndefined();
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("lists where every cached recipe for an origin starts, with each variant's first step", async () => {
    const contract = {
      slots: ["contract"],
      steps: [
        {
          kind: "fill" as const,
          path: "/login",
          effect: "prepare" as const,
          fields: [{ slot: "contract", target: target("contract") }],
        },
        {
          kind: "click" as const,
          path: "/login",
          target: target("go"),
          purpose: "submit" as const,
        },
      ],
    };
    const single = recipe("bank-signin", "/login");
    const varied = parseLoginRecipe({
      ...recipe("bank-app", "/app/login"),
      slots: ["username"],
      steps: [
        {
          kind: "fill",
          path: "/app/login",
          fields: [{ slot: "username", target: target("user") }],
        },
        { kind: "click", path: "/app/login", target: target("go"), purpose: "submit" },
      ],
      alternatives: [
        { ...contract, steps: contract.steps.map((step) => ({ ...step, path: "/app/login" })) },
      ],
    });
    const stored = {
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 1,
      recipes: [single, varied],
    };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    expect(await sync.recipes.starts(SITE)).toEqual([
      { path: "/login", steps: [single.steps[0]] },
      { path: "/app/login", steps: [varied.steps[0], varied.alternatives![0]!.steps[0]] },
    ]);
    expect(await sync.recipes.starts("https://other.example")).toEqual([]);
    await sync.clear();
    expect(await sync.recipes.starts(SITE)).toEqual([]);
  });

  it("finds a chooser (ADR 0028) by its list's path or its ID, never where a login starts", async () => {
    const other = { by: "text" as const, value: "Use another profile" };
    const chooser = {
      version: 1 as const,
      id: "bank-chooser",
      revision: 1,
      origin: SITE,
      chooser: { path: "/profiles", other },
    };
    const clash = { ...chooser, id: "bank-clash", chooser: { path: "/login" } };
    const stored = {
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 1,
      recipes: [recipe("bank-signin", "/login"), chooser, clash],
    };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    expect(await sync.recipes.chooser!(SITE, "/profiles")).toEqual(chooser);
    expect(await sync.recipes.chooser!(SITE, "/elsewhere", "bank-chooser")).toEqual(chooser);
    expect(await sync.recipes.chooser!(SITE, "/login")).toBeUndefined();
    expect(await sync.recipes.chooser!("https://other.example", "/profiles")).toBeUndefined();
    // A chooser is never a login recipe, by path or by ID.
    expect(await sync.recipes.recipe(SITE, "/profiles", "bank-chooser")).toBeUndefined();
    expect(await sync.recipes.starts(SITE)).toContainEqual({
      path: "/profiles",
      steps: [],
      list: [other],
    });
  });

  it("starts a chooser (ADR 0028) also on its other branch's first step on the list's path", async () => {
    const other = { by: "text" as const, value: "Use another profile" };
    const branch = (path: string) => ({ ...recipe("bank-chooser", path), revision: 2 });
    const chooser = (path: string) => ({
      version: 1 as const,
      id: "bank-chooser",
      revision: 2,
      origin: SITE,
      chooser: { path: "/profiles", other, afterOther: branch(path) },
    });
    for (const [path, steps] of [
      ["/profiles", [branch("/profiles").steps[0]]],
      // A branch that starts elsewhere is reached only through the click.
      ["/email", []],
    ] as const) {
      const stored = {
        version: 1,
        origin: SERVICE,
        deviceId: DEVICE,
        cursor: 1,
        recipes: [chooser(path)],
      };
      const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
      // eslint-disable-next-line no-await-in-loop
      expect(await sync.recipes.starts(SITE)).toEqual([
        { path: "/profiles", steps, list: [other] },
      ]);
    }
  });
});

describe("settings in the same sync", () => {
  it("syncs settings after recipes and records one complete sync", async () => {
    const { sync, settingsSync, service } = setup({ settings: "synced" });
    expect(await sync.sync()).toBe("synced");
    expect(settingsSync.run).toHaveBeenCalledWith(
      { origin: SERVICE, deviceId: DEVICE, credential: CREDENTIAL, rejected: false },
      expect.any(Function),
    );
    expect(service.recordSync).toHaveBeenCalledExactlyOnceWith(DEVICE, { syncedAt: 5_000 });
  });

  it("does not record a complete sync when settings did not sync", async () => {
    const { sync, service } = setup({ settings: "unreachable" });
    expect(await sync.sync()).toBe("unreachable");
    expect(service.recordSync).not.toHaveBeenCalled();
  });

  it("marks the device rejected when the settings request is refused", async () => {
    const { sync, service } = setup({ settings: "rejected" });
    expect(await sync.sync()).toBe("rejected");
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { rejected: true });
  });

  it("still syncs settings when recipes do not fit, but skips them when unreachable", async () => {
    const changes = Array.from({ length: 4000 }, (_, index) =>
      active(recipe(`site-${index}`, "/login", 1, `https://site-${index}.example`)),
    );
    const full = setup({ settings: "synced", pages: [page(changes, 1), page(changes, 1)] });
    expect(await full.sync.sync()).toBe("cache-full");
    expect(full.settingsSync.run).toHaveBeenCalledOnce();

    const down = setup({ settings: "synced", pages: [{ kind: "failed", error: "unreachable" }] });
    expect(await down.sync.sync()).toBe("unreachable");
    expect(down.settingsSync.run).not.toHaveBeenCalled();
  });

  it("shows settings that exceed their limits like a full cache", async () => {
    const { sync, service } = setup({ settings: "too-large" });
    expect(await sync.sync()).toBe("too-large");
    expect(service.recordSync).toHaveBeenCalledExactlyOnceWith(DEVICE, { cacheFull: true });
  });

  it("forgets the settings base with the recipe cache", async () => {
    const { sync, settingsSync } = setup({ settings: "synced" });
    await sync.clear();
    expect(settingsSync.clear).toHaveBeenCalledOnce();
  });
});

describe("recipes-only sync after a judged page (ADR 0027)", () => {
  /** Holds the first recipe page until released, so a second request joins the run. */
  function held(h: ReturnType<typeof setup>) {
    let release: (result: RecipeChangesResult) => void = () => undefined;
    h.transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    return (result: RecipeChangesResult) => release(result);
  }

  it("pulls recipes into the cache without settings, a recorded sync or a schedule move", async () => {
    const learned = recipe("bank-signin", "/login", 2);
    const h = setup({ settings: "synced", pages: [page([active(learned)], 3)] });
    expect(await h.sync.sync({ settings: false })).toBe("synced");
    expect(h.cache()).toMatchObject({ cursor: 3, recipes: [learned] });
    expect(h.settingsSync.run).not.toHaveBeenCalled();
    expect(h.service.recordSync).not.toHaveBeenCalled();
    expect(h.schedule()).toBeUndefined();
    expect(h.report).toHaveBeenCalledExactlyOnceWith("synced", {
      scope: "recipes",
      added: 1,
      updated: 0,
      removed: 0,
    });
  });

  it("runs settings once after a recipes-only sync that a full sync joined", async () => {
    const h = setup({ settings: "synced" });
    const release = held(h);
    const refresh = h.sync.sync({ settings: false });
    await vi.waitFor(() => expect(h.transport.recipeChanges).toHaveBeenCalledOnce());
    const full = h.sync.sync();
    expect(h.settingsSync.run).not.toHaveBeenCalled();
    release(page([], 0));
    expect(await refresh).toBe("synced");
    expect(await full).toBe("synced");
    expect(h.transport.recipeChanges).toHaveBeenCalledTimes(2);
    expect(h.settingsSync.run).toHaveBeenCalledOnce();
    expect(h.service.recordSync).toHaveBeenCalledExactlyOnceWith(DEVICE, { syncedAt: 5_000 });
    expect(h.schedule()).toEqual({
      version: 1,
      startedAt: 5_000,
      retryAt: 5_000 + RECIPE_SYNC_STALE_MS,
    });
  });

  it("adds no settings run when a recipes-only sync joins a full one", async () => {
    const h = setup({ settings: "synced" });
    const release = held(h);
    const full = h.sync.sync();
    await vi.waitFor(() => expect(h.transport.recipeChanges).toHaveBeenCalledOnce());
    const refresh = h.sync.sync({ settings: false });
    release(page([], 0));
    expect(await full).toBe("synced");
    expect(await refresh).toBe("synced");
    // The joined request still pulls recipes once more, but without settings.
    expect(h.transport.recipeChanges).toHaveBeenCalledTimes(2);
    expect(h.settingsSync.run).toHaveBeenCalledOnce();
    expect(h.service.recordSync).toHaveBeenCalledOnce();
  });
});

describe("recipe sync schedule", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps the schedule across worker restarts", async () => {
    const recent = setup({
      now: () => 10_000,
      scheduled: { version: 1, startedAt: 9_000, retryAt: 9_000 + RECIPE_SYNC_STALE_MS },
    });
    recent.sync.refreshIfStale();
    await flush();
    expect(recent.transport.recipeChanges).not.toHaveBeenCalled();

    for (const scheduled of [
      undefined,
      { version: 1, startedAt: 0, retryAt: RECIPE_SYNC_STALE_MS },
      // A clock that moved backwards does not postpone syncing.
      { version: 1, startedAt: 9e9, retryAt: 9e9 },
    ]) {
      const due = setup({ now: () => RECIPE_SYNC_STALE_MS, scheduled });
      due.sync.refreshIfStale();
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      await vi.waitFor(() => expect(due.transport.recipeChanges).toHaveBeenCalledOnce());
    }
  });

  it("records each attempt and backs off after a rate limit", async () => {
    const synced = setup({ now: () => 7_000 });
    await synced.sync.sync();
    expect(synced.schedule()).toEqual({
      version: 1,
      startedAt: 7_000,
      retryAt: 7_000 + RECIPE_SYNC_STALE_MS,
    });

    let time = 7_000;
    const limited = setup({
      now: () => time,
      pages: [{ kind: "failed", error: "rate-limited" }],
    });
    expect(await limited.sync.sync()).toBe("rate-limited");
    expect(limited.schedule()).toEqual({
      version: 1,
      startedAt: 7_000,
      retryAt: 7_000 + RECIPE_SYNC_RATE_LIMIT_MS,
    });
    time += RECIPE_SYNC_STALE_MS;
    limited.sync.refreshIfStale();
    await flush();
    expect(limited.transport.recipeChanges).toHaveBeenCalledOnce();
  });
});

describe("cached recipe lookup", () => {
  const signin = recipe("bank-signin", "/login");
  const stored = {
    version: 1,
    origin: SERVICE,
    deviceId: DEVICE,
    cursor: 2,
    recipes: [signin, recipe("other-site", "/login", 1, "https://other.example")],
  };

  it("returns a resumed attempt's own recipe by ID on any step", async () => {
    const { sync } = setup({ stored });
    expect(await sync.recipes.recipe(SITE, "/password", "bank-signin")).toEqual(signin);
    expect(await sync.recipes.recipe(SITE, "/password", "other-site")).toBeUndefined();
  });

  it("refuses to guess between two recipes starting on one page", async () => {
    const { sync } = setup({
      stored: { ...stored, recipes: [signin, recipe("bank-alt", "/login")] },
    });
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("caches an entry recipe (ADR 0031) but never starts, resumes or lists it", async () => {
    const entry: StoredLoginRecipe = {
      version: 1,
      id: "bank-entry",
      revision: 1,
      origin: SITE,
      entry: { path: "/login", target: { by: "text", value: "Login" } },
    };
    const home = { ...entry, id: "bank-home", entry: { ...entry.entry, path: "/" } };
    const { sync, cache } = setup({
      pages: [
        page(
          [entry, home].map((value) => ({
            recipeId: value.id,
            revision: 1,
            state: "active" as const,
            recipe: value,
          })),
          3,
        ),
      ],
      stored,
    });
    expect(await sync.sync()).toBe("synced");
    expect(cache()["recipes"]).toEqual([...stored.recipes, entry, home]);
    // Sharing the login recipe's start path, it neither replaces nor ambiguates it.
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(signin);
    expect(await sync.recipes.recipe(SITE, "/")).toBeUndefined();
    expect(await sync.recipes.recipe(SITE, "/", "bank-home")).toBeUndefined();
    expect(await sync.recipes.starts(SITE)).toEqual([{ path: "/login", steps: [signin.steps[0]] }]);
  });

  it("lists an origin's own entry recipes (ADR 0031), as the sync revises or revokes them", async () => {
    const entry: StoredLoginRecipe = {
      version: 1,
      id: "bank-entry",
      revision: 1,
      origin: SITE,
      entry: { path: "/", target: { by: "text", value: "Login" } },
    };
    // Another origin of the same site, and another site.
    const www = { ...entry, id: "www-entry", origin: "https://www.bank.example" };
    const other = { ...entry, id: "other-entry", origin: "https://other.example" };
    const change = (value: StoredLoginRecipe, revision = value.revision) => ({
      recipeId: value.id,
      revision,
      state: "active" as const,
      recipe: { ...value, revision },
    });
    const { sync } = setup({
      pages: [
        page([change(entry), change(www), change(other)], 3),
        page([change(entry, 2), revoked("www-entry", 2)], 5),
      ],
      stored,
    });
    expect(await sync.sync()).toBe("synced");
    expect(await sync.recipes.entries(SITE)).toEqual([entry]);
    expect(await sync.recipes.entries("https://www.bank.example")).toEqual([www]);
    expect(await sync.recipes.entries("https://unknown.example")).toEqual([]);
    expect(await sync.recipes.entries(SITE.replace("https:", "http:"))).toEqual([]);
    // A newer revision replaces the cached one; a revoked recipe is no longer listed.
    expect(await sync.sync()).toBe("synced");
    expect(await sync.recipes.entries(SITE)).toEqual([{ ...entry, revision: 2 }]);
    expect(await sync.recipes.entries("https://www.bank.example")).toEqual([]);
    // Nothing is listed without a paired device or from another device's cache.
    const cached = { ...stored, recipes: [...stored.recipes, entry] };
    expect(await setup({ stored: cached }).sync.recipes.entries(SITE)).toEqual([entry]);
    expect(
      await setup({ stored: cached, connection: undefined }).sync.recipes.entries(SITE),
    ).toEqual([]);
    expect(
      await setup({
        stored: cached,
        connection: {
          origin: SERVICE,
          deviceId: OTHER_DEVICE,
          credential: CREDENTIAL,
          rejected: false,
        },
      }).sync.recipes.entries(SITE),
    ).toEqual([]);
  });

  it("serves nothing without a paired device or for another device's cache", async () => {
    expect(
      await setup({ stored, connection: undefined }).sync.recipes.recipe(SITE, "/login"),
    ).toBeUndefined();
    expect(
      await setup({
        stored,
        connection: {
          origin: SERVICE,
          deviceId: OTHER_DEVICE,
          credential: CREDENTIAL,
          rejected: false,
        },
      }).sync.recipes.recipe(SITE, "/login"),
    ).toBeUndefined();
  });

  it("refreshes a stale cache in the background without waiting for it", async () => {
    let time = 0;
    let release: (result: RecipeChangesResult) => void = () => undefined;
    const { sync, transport } = setup({ stored, now: () => time });
    transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    // The lookup answers from the cache while the first sync is still running.
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(signin);
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledOnce());
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(signin);
    release(page([], 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    time += RECIPE_SYNC_STALE_MS - 1;
    await sync.recipes.recipe(SITE, "/login");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.recipeChanges).toHaveBeenCalledOnce();
    time += 1;
    await sync.recipes.recipe(SITE, "/login");
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledTimes(2));
  });

  it("does not refresh for a device the service rejected", async () => {
    const { sync, service, transport } = setup({ stored });
    service.connection.mockResolvedValue({
      origin: SERVICE,
      deviceId: DEVICE,
      credential: CREDENTIAL,
      rejected: true,
    });
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(signin);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.recipeChanges).not.toHaveBeenCalled();
  });
});
