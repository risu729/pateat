import { parseLoginRecipe, type LoginRecipe, type SyncRecipeChange } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createRecipeSync,
  MAX_RECIPE_CACHE_BYTES,
  MAX_RECIPE_PAGES_PER_SYNC,
  RECIPE_SYNC_RATE_LIMIT_MS,
  RECIPE_SYNC_STALE_MS,
} from "./recipes";
import type { ServiceConnection } from "./runtime";
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
    completion: { path: "/home", target: target("welcome") },
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
  const sync = createRecipeSync({
    service,
    transport,
    storage,
    schedule,
    now: options.now ?? (() => 5_000),
  });
  return {
    sync,
    service,
    transport,
    storage,
    cache: () => value as Record<string, unknown>,
    schedule: () => scheduled,
  };
}

describe("recipe sync", () => {
  it("does nothing without a paired device", async () => {
    const { sync, transport } = setup({ connection: undefined });
    expect(await sync.sync()).toBe("not-connected");
    expect(transport.recipeChanges).not.toHaveBeenCalled();
  });

  it("applies pages of changes and records a complete sync", async () => {
    const first = recipe("bank-signin", "/login");
    const second = recipe("bank-otp", "/otp");
    const { sync, transport, service, cache } = setup({
      pages: [
        page([active(first), active(second)], 2, false),
        page([revoked("bank-otp", 2), active(recipe("bank-signin", "/login", 2))], 4),
      ],
    });
    expect(await sync.sync()).toBe("synced");
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
    const { sync, storage, service } = setup({
      pages: [page([active(recipe("bank-signin", "/login"))], 1)],
    });
    storage.write.mockRejectedValueOnce(new Error("quota"));
    expect(await sync.sync()).toBe("storage-unavailable");
    expect(service.recordSync).not.toHaveBeenCalled();
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
    const { sync, service, storage, cache } = setup({ stored, pages: [page(many, 2)] });
    expect(await sync.sync()).toBe("cache-full");
    expect(storage.write).not.toHaveBeenCalled();
    expect(cache()).toEqual(stored);
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { cacheFull: true });
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
    const { sync, storage } = setup();
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
    // Storage keeps whatever landed last, but the lookup never serves the old copy again.
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("clears a leftover cache once no device is paired", async () => {
    const stored = { version: 1, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [] };
    const { sync, cache } = setup({ stored, connection: undefined });
    expect(await sync.sync()).toBe("not-connected");
    expect(cache()).toBeUndefined();
  });

  it("starts a new sync requested right after the last one finished", async () => {
    const { sync, transport } = setup();
    await sync.sync().then(() => sync.sync());
    expect(transport.recipeChanges).toHaveBeenCalledTimes(2);
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

  it("starts only on a recipe's first step", async () => {
    const { sync } = setup({ stored });
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(signin);
    expect(await sync.recipes.recipe(SITE, "/password")).toBeUndefined();
    expect(await sync.recipes.recipe("https://unknown.example", "/login")).toBeUndefined();
  });

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
