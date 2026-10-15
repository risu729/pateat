import {
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

function setup(
  options: {
    connection?: ServiceConnection | undefined;
    pages?: RecipeChangesResult[];
    stored?: unknown;
    scheduled?: unknown;
    now?: () => number;
    settings?: SettingsSyncOutcome;
  } = {},
) {
  let value = options.stored;
  let scheduled = options.scheduled;
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
    clear: vi.fn(async () => {
      value = undefined;
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
    const { sync, service, storage, cache, report } = setup({ stored, pages: [page(many, 2)] });
    expect(await sync.sync()).toBe("cache-full");
    expect(storage.write).not.toHaveBeenCalled();
    expect(cache()).toEqual(stored);
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { cacheFull: true });
    // A page that was not written changed nothing.
    expect(report).toHaveBeenCalledWith("cache-full", expect.objectContaining({ added: 0 }));
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

  it("does not keep a disconnected device's recipes written during clearing", async () => {
    const { sync, storage } = setup({
      pages: [page([active(recipe("bank-signin", "/login"))], 1)],
    });
    let finish: () => void = () => undefined;
    storage.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const running = sync.sync();
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce());
    await sync.clear();
    finish();
    expect(await running).toBe("not-connected");
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
    const full = setup({
      settings: "synced",
      pages: [
        page(
          Array.from({ length: 4000 }, (_, index) =>
            active(recipe(`site-${index}`, "/login", 1, `https://site-${index}.example`)),
          ),
          1,
        ),
      ],
    });
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
    const { sync, service } = setup({ connection: unsynced, settings: "synced" });
    expect(await sync.sync()).toBe("synced");
    expect(service.recordSync.mock.calls).toEqual([
      [DEVICE, { settingsSynced: true }],
      [DEVICE, { syncedAt: 5_000 }],
    ]);
  });

  it("records it even when the recipes did not fit, since the settings did sync", async () => {
    const { sync, service } = setup({
      connection: unsynced,
      settings: "synced",
      pages: [
        page(
          Array.from({ length: 4000 }, (_, index) =>
            active(recipe(`site-${index}`, "/login", 1, `https://site-${index}.example`)),
          ),
          1,
        ),
      ],
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
