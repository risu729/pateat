import { expect, it, vi } from "vitest";
import { MAX_RECIPE_CACHE_BYTES, MAX_RECIPE_PAGES_PER_SYNC } from "../../../src/service/recipes";
import type { RecipeChangesResult } from "../../../src/service/transport";
import type { RecipeSyncFixtures } from "./context";

export function registerSyncCapacityCases({
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
}: Pick<
  RecipeSyncFixtures,
  | "SERVICE"
  | "DEVICE"
  | "recipe"
  | "active"
  | "setup"
  | "page"
  | "crowdedCache"
  | "incoming"
  | "revoked"
  | "CREDENTIAL"
  | "SITE"
>) {
  it("stops before the cache outgrows its share of local storage", async () => {
    const stored = {
      version: 2,
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
}
