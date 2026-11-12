import {
  layoutRecipe,
  parseLoginRecipe,
  toLoginLayout,
  type LoginRecipe,
  type LoginRecipeDocument,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createRecipeSync,
  MAX_RECIPE_CACHE_BYTES,
  RECIPE_SYNC_RATE_LIMIT_MS,
  RECIPE_SYNC_STALE_MS,
} from "./recipes";
import type { ServiceConnection } from "./runtime";
import type { SettingsSyncOutcome } from "./settings-sync";
import type { RecipeChangesResult, ServiceTransport } from "./transport";
import { registerSyncPageCases } from "../../test/service/recipes/sync-pages";
import { registerSyncRecoveryCases } from "../../test/service/recipes/sync-recovery";
import { registerSyncCapacityCases } from "../../test/service/recipes/sync-capacity";
import { registerSyncLayoutCases } from "../../test/service/recipes/sync-layouts";
import { registerCachedLookupCases } from "../../test/service/recipes/cached-lookup";

// Synthetic service, credential and recipes only.

const SERVICE = "https://pateat.example.com";
const SITE = "https://bank.example";
const DEVICE = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const OTHER_DEVICE = "7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const target = (value: string) => ({ by: "id" as const, value });

function route(id: string, firstPath: string, revision = 1, origin = SITE): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin,
    pageKind: "sign-in",
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
/** The route stored with one layout (ADR 0060), as the service sends it. */
function storedOf(value: LoginRecipe, key = "1000"): LoginRecipeDocument {
  const { version, id, revision, origin } = value;
  return {
    version,
    id,
    revision,
    origin,
    layouts: [toLoginLayout(value, { key, createdAt: Number(key) })],
  };
}
/** A stored recipe with one layout of the route. */
const recipe = (...args: Parameters<typeof route>) => storedOf(route(...args));
/** The recipe a login runs of a stored recipe's only layout. */
const projected = (value: LoginRecipeDocument) => layoutRecipe(value, value.layouts[0]!);
const active = (value: StoredLoginRecipe): SyncRecipeChange => ({
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
  const heldRoute = route("cached-one", "/login");
  const held = storedOf(heldRoute);
  const other = { ...held, id: "cached-two" };
  // Long, valid paths and locators fill the real byte limit with fewer recipes.
  // This keeps schema validation, storage cloning and assertions inexpensive under
  // CI coverage, while all tests still exercise the actual 2 MiB boundary.
  const filler = storedOf(
    parseLoginRecipe({
      ...heldRoute,
      id: "fill-00000",
      steps: [
        ...heldRoute.steps.slice(0, 2),
        ...Array.from({ length: 29 }, () => ({
          kind: "assert",
          path: `/${"p".repeat(299)}`,
          target: target("p".repeat(120)),
          present: true,
        })),
        heldRoute.steps.at(-1),
      ],
    }),
  );
  const empty = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 7, recipes: [] };
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
  cache.recipes[0] = storedOf(
    parseLoginRecipe({
      ...projected(held),
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
    }),
  );
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
    build?: string;
    device?: NonNullable<Parameters<typeof createRecipeSync>[0]["device"]>;
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
  // A device that completed its first settings sync, unless a test says otherwise.
  const connection =
    "connection" in options
      ? options.connection
      : {
          origin: SERVICE,
          deviceId: DEVICE,
          credential: CREDENTIAL,
          rejected: false,
          settingsSynced: true as const,
        };
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
    run: vi.fn<NonNullable<Parameters<typeof createRecipeSync>[0]["settings"]>["run"]>(
      async () => options.settings ?? "synced",
    ),
    clear: vi.fn(async () => undefined),
  };
  const report = vi.fn();
  const settingsSynced = vi.fn();
  const sync = createRecipeSync({
    service,
    transport,
    storage,
    schedule,
    report,
    settingsSynced,
    build: options.build ?? "1c42ad3",
    now: options.now ?? (() => 5_000),
    ...(options.settings ? { settings: settingsSync } : {}),
    ...(options.device ? { device: options.device } : {}),
  });
  return {
    sync,
    report,
    settingsSync,
    settingsSynced,
    service,
    transport,
    storage,
    cache: () => value as Record<string, unknown>,
    schedule: () => scheduled,
    recovery: () => recovery,
  };
}

export type RecipeSyncFixtures = {
  SERVICE: typeof SERVICE;
  DEVICE: typeof DEVICE;
  setup: typeof setup;
  recipe: typeof recipe;
  page: typeof page;
  active: typeof active;
  revoked: typeof revoked;
  CREDENTIAL: typeof CREDENTIAL;
  OTHER_DEVICE: typeof OTHER_DEVICE;
  SITE: typeof SITE;
  projected: typeof projected;
  route: typeof route;
  storedOf: typeof storedOf;
  target: typeof target;
  exactCache: typeof exactCache;
  incoming: typeof incoming;
  liveFeed: typeof liveFeed;
  crowdedCache: typeof crowdedCache;
};

describe("recipe sync", () => {
  registerSyncPageCases({
    SERVICE,
    DEVICE,
    setup,
    recipe,
    page,
    active,
    revoked,
    CREDENTIAL,
    OTHER_DEVICE,
    SITE,
    projected,
  });

  registerSyncRecoveryCases({
    route,
    storedOf,
    target,
    SERVICE,
    DEVICE,
    setup,
    page,
    active,
    exactCache,
    recipe,
    revoked,
    incoming,
    liveFeed,
    crowdedCache,
    OTHER_DEVICE,
    CREDENTIAL,
    projected,
  });

  registerSyncCapacityCases({
    SERVICE,
    DEVICE,
    recipe,
    active,
    setup,
    page,
    crowdedCache,
    incoming,
    revoked,
    CREDENTIAL,
    SITE,
  });

  registerSyncLayoutCases({
    setup,
    page,
    active,
    recipe,
    SERVICE,
    DEVICE,
    SITE,
    target,
    route,
    storedOf,
    projected,
  });
});

describe("settings in the same sync", () => {
  it("syncs settings after recipes and records one complete sync", async () => {
    const { sync, settingsSync, service } = setup({ settings: "synced" });
    expect(await sync.sync()).toBe("synced");
    expect(settingsSync.run).toHaveBeenCalledWith(
      {
        origin: SERVICE,
        deviceId: DEVICE,
        credential: CREDENTIAL,
        rejected: false,
        settingsSynced: true,
      },
      expect.any(Function),
      expect.any(Function),
    );
    expect(service.recordSync).toHaveBeenCalledExactlyOnceWith(DEVICE, { syncedAt: 5_000 });
  });

  it("adds up how long the run's requests took for its log entry (ADR 0019)", async () => {
    const { sync, settingsSync, report } = setup({
      settings: "synced",
      pages: [
        { ...page([], 1, false), timing: { roundTripMs: 300, serverMs: 120, networkMs: 180 } },
        { ...page([], 2), timing: { roundTripMs: 200, serverMs: 50, networkMs: 150 } },
      ],
    });
    settingsSync.run.mockImplementation(async (_connection, _stale, timed) => {
      timed?.({ roundTripMs: 100, serverMs: 40, networkMs: 60 });
      return "synced";
    });
    expect(await sync.sync()).toBe("synced");
    expect(report).toHaveBeenCalledExactlyOnceWith("synced", {
      scope: "full",
      added: 0,
      updated: 0,
      removed: 0,
      timing: { roundTripMs: 600, serverMs: 210, networkMs: 390 },
    });
  });

  it("keeps only the round trip when a request had no service time", async () => {
    const { sync, report } = setup({
      pages: [
        { ...page([], 1, false), timing: { roundTripMs: 300, serverMs: 120, networkMs: 180 } },
        { ...page([], 2), timing: { roundTripMs: 200 } },
      ],
    });
    expect(await sync.sync()).toBe("synced");
    expect(report.mock.calls[0]![1]).toMatchObject({ timing: { roundTripMs: 500 } });
    expect(report.mock.calls[0]![1].timing).not.toHaveProperty("serverMs");
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

describe("the first settings sync since pairing (ADR 0023)", () => {
  const unsynced: ServiceConnection = {
    origin: SERVICE,
    deviceId: DEVICE,
    credential: CREDENTIAL,
    rejected: false,
  };

  it("records that settings synced, then the complete sync", async () => {
    const { sync, service, settingsSynced } = setup({ connection: unsynced, settings: "synced" });
    expect(await sync.sync()).toBe("synced");
    expect(service.recordSync.mock.calls).toEqual([
      [DEVICE, { settingsSynced: true }],
      [DEVICE, { syncedAt: 5_000 }],
    ]);
    // Its listeners read the vault items again, even when the merge changed nothing.
    expect(settingsSynced).toHaveBeenCalledOnce();
    // A later sync of an already synced device does not call it again.
    const again = setup({ settings: "synced" });
    expect(await again.sync.sync()).toBe("synced");
    expect(again.settingsSynced).not.toHaveBeenCalled();
  });

  it("records it even when the recipes did not fit, since the settings did sync", async () => {
    const size = new TextEncoder().encode(JSON.stringify(recipe("site-0", "/login"))).byteLength;
    const many = Array.from({ length: Math.ceil(MAX_RECIPE_CACHE_BYTES / size) + 1 }, (_, index) =>
      active(recipe(`site-${index}`, "/login", 1, `https://site-${index}.example`)),
    );
    const { sync, service } = setup({
      connection: unsynced,
      settings: "synced",
      pages: [page(many, 1), page(many, 1)],
    });
    expect(await sync.sync()).toBe("cache-full");
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { settingsSynced: true });
  });

  it("records it once only", async () => {
    const { sync, service } = setup({ settings: "synced" });
    expect(await sync.sync()).toBe("synced");
    expect(service.recordSync).not.toHaveBeenCalledWith(DEVICE, { settingsSynced: true });
  });

  it.each<SettingsSyncOutcome>([
    "too-large",
    "rejected",
    "busy",
    "unreachable",
    "storage-unavailable",
  ])("does not record it when settings ended %s", async (outcome) => {
    const { sync, service } = setup({ connection: unsynced, settings: outcome });
    await sync.sync();
    expect(service.recordSync).not.toHaveBeenCalledWith(DEVICE, { settingsSynced: true });
  });

  it("does not record it for a rejected recipe request or a recipes-only sync", async () => {
    const rejected = setup({
      connection: unsynced,
      settings: "synced",
      pages: [{ kind: "rejected" }],
    });
    expect(await rejected.sync.sync()).toBe("rejected");
    expect(rejected.settingsSync.run).not.toHaveBeenCalled();
    expect(rejected.service.recordSync).toHaveBeenCalledExactlyOnceWith(DEVICE, {
      rejected: true,
    });
    const recipesOnly = setup({ connection: unsynced, settings: "synced" });
    expect(await recipesOnly.sync.sync({ settings: false })).toBe("synced");
    expect(recipesOnly.service.recordSync).not.toHaveBeenCalled();
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

  it("syncs now when the clock moves backwards in the same worker", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let time = 2 * DAY;
    const h = setup({ now: () => time });
    expect(await h.sync.sync()).toBe("synced");
    expect(h.transport.recipeChanges).toHaveBeenCalledOnce();
    time -= DAY;

    // A new worker over the same storage treats the schedule as due now.
    const restarted = setup({ now: () => time, scheduled: h.schedule() });
    restarted.sync.refreshIfStale();
    await vi.waitFor(() => expect(restarted.transport.recipeChanges).toHaveBeenCalledOnce());

    // So does the worker that recorded it.
    h.sync.refreshIfStale();
    await flush();
    expect(h.transport.recipeChanges).toHaveBeenCalledTimes(2);
  });

  it("ends a rate-limit back-off when the clock moves backwards", async () => {
    let time = 10 * RECIPE_SYNC_RATE_LIMIT_MS;
    const h = setup({ now: () => time, pages: [{ kind: "failed", error: "rate-limited" }] });
    expect(await h.sync.sync()).toBe("rate-limited");
    time -= RECIPE_SYNC_RATE_LIMIT_MS;
    h.sync.refreshIfStale();
    await flush();
    expect(h.transport.recipeChanges).toHaveBeenCalledTimes(2);
  });
});

describe("cached recipe lookup", () => {
  const signin = recipe("bank-signin", "/login");
  const stored = {
    version: 2,
    origin: SERVICE,
    deviceId: DEVICE,
    cursor: 2,
    recipes: [signin, recipe("other-site", "/login", 1, "https://other.example")],
  };

  registerCachedLookupCases({
    setup,
    stored,
    SITE,
    projected,
    signin,
    recipe,
    page,
    revoked,
    SERVICE,
    OTHER_DEVICE,
    CREDENTIAL,
    DEVICE,
  });
});

describe("recipes this device holds as its own (ADR 0040)", () => {
  const held = recipe("bank-held", "/login");
  function device(recipes: readonly StoredLoginRecipe[] | Error = [held]) {
    return {
      list: vi.fn(async () => {
        if (recipes instanceof Error) throw recipes;
        return recipes;
      }),
      upload: vi.fn<NonNullable<Parameters<typeof createRecipeSync>[0]["device"]>["upload"]>(
        async () => "done",
      ),
      forget: vi.fn<NonNullable<Parameters<typeof createRecipeSync>[0]["device"]>["forget"]>(
        async () => undefined,
      ),
    };
  }

  it("serves them for logins while no service is paired", async () => {
    const { sync, transport } = setup({ connection: undefined, device: device() });
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(held));
    expect(await sync.recipes.routes!(SITE)).toHaveLength(1);
    expect(await sync.recipes.recipe("https://other.example", "/login")).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.recipeChanges).not.toHaveBeenCalled();
  });

  it("serves none when they or the pairing cannot be read", async () => {
    expect(
      await setup({
        connection: undefined,
        device: device(new Error("unreadable")),
      }).sync.recipes.recipe(SITE, "/login"),
    ).toBeUndefined();
    const broken = setup({ device: device() });
    broken.service.connection.mockRejectedValue(new Error("unreadable"));
    expect(await broken.sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("uses the paired service's cache, not them, while paired", async () => {
    const signin = recipe("bank-signin", "/login");
    const { sync } = setup({
      stored: { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 2, recipes: [signin] },
      device: device(),
    });
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
    expect(await sync.recipes.recipe(SITE, "/login", "bank-held")).toBeUndefined();
  });

  it("uploads them on a full sync before pulling, so the pull brings them back", async () => {
    const own = device();
    const { sync, transport } = setup({ device: own });
    own.upload.mockImplementation(async () => {
      expect(transport.recipeChanges).not.toHaveBeenCalled();
      return "done";
    });
    expect(await sync.sync()).toBe("synced");
    expect(own.upload).toHaveBeenCalledExactlyOnceWith(
      {
        origin: SERVICE,
        deviceId: DEVICE,
        credential: CREDENTIAL,
        rejected: false,
        settingsSynced: true,
      },
      expect.any(Function),
    );
    expect(transport.recipeChanges).toHaveBeenCalled();
  });

  it("does not upload on a recipes-only sync, for a rejected device, or unpaired", async () => {
    const devices = [device(), device(), device()] as const;
    expect(await setup({ device: devices[0] }).sync.sync({ settings: false })).toBe("synced");
    expect(
      await setup({
        device: devices[1],
        connection: { origin: SERVICE, deviceId: DEVICE, credential: CREDENTIAL, rejected: true },
      }).sync.sync(),
    ).toBe("rejected");
    expect(await setup({ device: devices[2], connection: undefined }).sync.sync()).toBe(
      "not-connected",
    );
    for (const own of devices) expect(own.upload).not.toHaveBeenCalled();
  });

  it("still pulls when an upload fails", async () => {
    const own = device();
    own.upload.mockRejectedValue(new Error("unavailable"));
    const { sync, transport } = setup({ device: own });
    expect(await sync.sync()).toBe("synced");
    expect(transport.recipeChanges).toHaveBeenCalled();
  });

  it("forgets those the synced cache holds after the pull", async () => {
    const own = device();
    const { sync } = setup({ device: own, pages: [page([active(held)], 3)] });
    expect(await sync.sync()).toBe("synced");
    expect(own.forget).toHaveBeenCalledExactlyOnceWith(
      new Set(["bank-held"]),
      expect.any(Function),
    );
    expect(own.forget.mock.calls[0]![1]()).toBe(false);
  });

  it("stops a running sync before a disconnect copies the synced recipes", async () => {
    const own = device();
    const signin = recipe("bank-signin", "/login");
    const h = setup({
      device: own,
      stored: { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 2, recipes: [signin] },
    });
    let release: (result: RecipeChangesResult) => void = () => undefined;
    h.transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = h.sync.sync();
    await vi.waitFor(() => expect(h.transport.recipeChanges).toHaveBeenCalledOnce());
    expect(await h.sync.synced()).toEqual([signin]);
    const [, stale] = own.upload.mock.calls[0]!;
    expect(stale()).toBe(true);
    release(page([active(held)], 3));
    expect(await running).toBe("not-connected");
    expect(own.forget).not.toHaveBeenCalled();
  });

  it("refuses to copy a synced cache it cannot read", async () => {
    const h = setup({ device: device(), stored: { version: 2, broken: true } });
    await expect(h.sync.synced()).rejects.toThrow();
    const down = setup({ device: device() });
    down.storage.read.mockRejectedValueOnce(new Error("unavailable"));
    await expect(down.sync.synced()).rejects.toThrow();
    // No cache yet: nothing to keep.
    await expect(setup({ device: device() }).sync.synced()).resolves.toEqual([]);
    expect(await setup({ device: device(), connection: undefined }).sync.synced()).toBeUndefined();
  });
});
