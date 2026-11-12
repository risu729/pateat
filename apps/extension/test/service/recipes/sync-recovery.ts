import { expect, it, vi } from "vitest";
import { type LoginRecipe, MAX_ACTIVE_RECIPE_BYTES, parseLoginRecipe } from "@pateat/contracts";
import { MAX_RECIPE_CACHE_BYTES, MAX_RECIPE_PAGES_PER_SYNC } from "../../../src/service/recipes";
import type { RecipeSyncFixtures } from "./context";

export function registerSyncRecoveryCases({
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
}: Pick<
  RecipeSyncFixtures,
  | "route"
  | "storedOf"
  | "target"
  | "SERVICE"
  | "DEVICE"
  | "setup"
  | "page"
  | "active"
  | "exactCache"
  | "recipe"
  | "revoked"
  | "incoming"
  | "liveFeed"
  | "crowdedCache"
  | "OTHER_DEVICE"
  | "CREDENTIAL"
  | "projected"
>) {
  it("recovers additions before later shrinking current heads when both service snapshots fit", async () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const smallRoute = route("old-000", "/login");
    const small = storedOf(smallRoute);
    const large = storedOf(
      parseLoginRecipe({
        ...smallRoute,
        steps: [
          ...smallRoute.steps.slice(0, 2),
          ...Array.from({ length: 29 }, () => ({
            kind: "assert",
            path: `/${"p".repeat(299)}`,
            target: target("p".repeat(120)),
            present: true,
          })),
          smallRoute.steps.at(-1),
        ],
      }),
    );
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
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: old };
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
        version: 2,
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
      recovery: { version: 2, ...record },
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
        recovery: { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 0, after: 99 },
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
    stored.recipes[1] = storedOf(
      parseLoginRecipe({
        ...route("cached-two", "/x"),
        completion: [{ target: { by: "text", value: "x" } }],
      }),
    );
    const growing = storedOf(
      parseLoginRecipe({
        ...projected(stored.recipes[1]!),
        revision: 2,
        completion: [{ target: { by: "text", value: "日" } }],
      }),
    );
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
    loaded({ version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 7, after: 99 });
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
}
