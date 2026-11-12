import { expect, it, vi } from "vitest";
import type { StoredLoginRecipe } from "@pateat/contracts";
import { laterReadiness } from "../../../src/login/wire";
import type { RecipeChangesResult } from "../../../src/service/transport";
import { RECIPE_SYNC_STALE_MS, RECIPE_SYNC_WAIT_MS } from "../../../src/service/recipes";
import type { CachedLookupContext } from "./context";

export function registerCachedLookupCases({
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
}: Pick<
  CachedLookupContext,
  | "setup"
  | "stored"
  | "SITE"
  | "projected"
  | "signin"
  | "recipe"
  | "page"
  | "revoked"
  | "SERVICE"
  | "OTHER_DEVICE"
  | "CREDENTIAL"
  | "DEVICE"
>) {
  it("returns a resumed attempt's own recipe by ID on any step", async () => {
    const { sync } = setup({ stored });
    expect(await sync.recipes.recipe(SITE, "/password", "bank-signin")).toEqual(projected(signin));
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
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
    expect(await sync.recipes.recipe(SITE, "/")).toBeUndefined();
    expect(await sync.recipes.recipe(SITE, "/", "bank-home")).toBeUndefined();
    expect(await sync.recipes.starts(SITE)).toEqual([
      {
        path: "/login",
        steps: [projected(signin).steps[0]],
        later: [laterReadiness({ step: projected(signin).steps[1]! })],
      },
    ]);
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

  it("lists an origin's own logout recipes (ADR 0063), apart from its login recipes", async () => {
    const logout: StoredLoginRecipe = {
      version: 1,
      id: "bank-logout",
      revision: 1,
      origin: SITE,
      logout: {
        path: "/login",
        targets: [
          {
            kind: "click",
            path: "/login",
            target: { by: "text", value: "Sign out" },
            purpose: "logout",
          },
        ],
      },
    };
    const other = { ...logout, id: "other-logout", origin: "https://other.example" };
    const { sync } = setup({
      pages: [
        page(
          [logout, other].map((value) => ({
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
    expect(await sync.recipes.logouts!(SITE)).toEqual([logout]);
    expect(await sync.recipes.logouts!("https://unknown.example")).toEqual([]);
    // On the login recipe's start path, it neither replaces it nor starts a login.
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
    expect((await sync.recipes.starts(SITE)).map((start) => start.path)).toEqual(["/login"]);
    expect(await sync.recipes.entries(SITE)).toEqual([]);
    expect(
      await setup({ stored: { ...stored, recipes: [logout] }, connection: undefined }).sync.recipes
        .logouts!(SITE),
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
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledOnce());
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
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

  it("tells a recipe withdrawn once the sync a lookup started revoked it", async () => {
    let release: (result: RecipeChangesResult) => void = () => undefined;
    const { sync, transport } = setup({ stored, now: () => RECIPE_SYNC_STALE_MS });
    transport.recipeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    // The lookup still answers from the cache it starts refreshing.
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
    const withdrawn = sync.recipes.withdrawn!(SITE, signin.id);
    await vi.waitFor(() => expect(transport.recipeChanges).toHaveBeenCalledOnce());
    release(page([revoked(signin.id, 2)], 3));
    expect(await withdrawn).toBe(true);
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("stops waiting for a sync that does not answer", async () => {
    vi.useFakeTimers();
    try {
      const { sync, transport } = setup({ stored, now: () => RECIPE_SYNC_STALE_MS });
      transport.recipeChanges.mockImplementationOnce(() => new Promise(() => undefined));
      await sync.recipes.recipe(SITE, "/login");
      const withdrawn = sync.recipes.withdrawn!(SITE, signin.id);
      await vi.advanceTimersByTimeAsync(RECIPE_SYNC_WAIT_MS);
      expect(await withdrawn).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh for a device the service rejected", async () => {
    const { sync, service, transport } = setup({ stored });
    service.connection.mockResolvedValue({
      origin: SERVICE,
      deviceId: DEVICE,
      credential: CREDENTIAL,
      rejected: true,
    });
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(signin));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.recipeChanges).not.toHaveBeenCalled();
  });
}
