import { expect, it, vi } from "vitest";
import { MAX_RECIPE_PAGES_PER_SYNC } from "../../../src/service/recipes";
import type { RecipeChangesResult } from "../../../src/service/transport";
import type { RecipeSyncContext } from "./context";

export function registerSyncPageCases({
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
}: Pick<
  RecipeSyncContext,
  | "SERVICE"
  | "DEVICE"
  | "setup"
  | "recipe"
  | "page"
  | "active"
  | "revoked"
  | "CREDENTIAL"
  | "OTHER_DEVICE"
  | "SITE"
  | "projected"
>) {
  it("does nothing without a paired device and clears a leftover cache", async () => {
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [] };
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
      version: 2,
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
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 7, recipes: [] };
    const { sync, transport } = setup({ stored, pages: [page([], 7)] });
    await sync.sync();
    expect(transport.recipeChanges).toHaveBeenCalledWith(SERVICE, CREDENTIAL, 7);
  });

  it("applies the rest of a page whose change this build cannot read (#959)", async () => {
    const held = recipe("bank-otp", "/otp");
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 2, recipes: [held] };
    const added = recipe("bank-signin", "/login");
    const { sync, cache, report, service } = setup({
      stored,
      pages: [
        {
          kind: "page",
          page: { version: 1, changes: [active(added)], cursor: 6, complete: true },
          unreadable: ["bank-otp"],
        },
      ],
    });
    expect(await sync.sync()).toBe("synced");
    // The recipe written after the unreadable one arrives, the cursor moves past both, and
    // the copy held of the unreadable recipe stays.
    expect(cache()).toEqual({
      ...stored,
      cursor: 6,
      recipes: [held, added],
      unreadableBy: "1c42ad3",
    });
    expect(report).toHaveBeenCalledExactlyOnceWith("synced", {
      scope: "full",
      added: 1,
      updated: 0,
      removed: 0,
      unreadable: 1,
    });
    expect(service.recordSync).toHaveBeenCalledWith(DEVICE, { syncedAt: 5_000 });
  });

  it("reads every head again once another build syncs after a change was left out", async () => {
    const held = recipe("bank-otp", "/otp");
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 6,
      recipes: [held],
      unreadableBy: "0ld0001",
    };
    const added = recipe("bank-signin", "/login");
    const { sync, transport, cache } = setup({ stored, pages: [page([active(added)], 6)] });
    expect(await sync.sync()).toBe("synced");
    expect(transport.recipeChanges).toHaveBeenCalledExactlyOnceWith(SERVICE, CREDENTIAL, 0);
    // The held copy stays while the heads are read again; nothing is left out now.
    expect(cache()).toEqual({
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 6,
      recipes: [held, added],
    });
  });

  it("brings a revision left out once another build can read it", async () => {
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 6,
      recipes: [recipe("bank-signin", "/login")],
      unreadableBy: "0ld0001",
    };
    const newer = recipe("bank-signin", "/login", 2);
    const { sync, cache, report, recovery } = setup({
      stored,
      // A checkpoint of the old build's walk from cursor 6.
      recovery: { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 6, after: 9 },
      pages: [page([active(newer)], 6)],
    });
    expect(await sync.sync()).toBe("synced");
    expect(cache()).toMatchObject({ cursor: 6, recipes: [newer] });
    expect(cache()).not.toHaveProperty("unreadableBy");
    expect(report).toHaveBeenCalledExactlyOnceWith("synced", {
      scope: "full",
      added: 0,
      updated: 1,
      removed: 0,
    });
    // The cursor landing on 6 again never resumes the old walk from 9.
    expect(recovery()).toEqual({
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 0,
      after: 0,
    });
  });

  it("keeps the build that left a change out across later pages", async () => {
    const { sync, cache } = setup({
      pages: [
        {
          kind: "page",
          page: { version: 1, changes: [], cursor: 2, complete: false },
          unreadable: ["bank-otp"],
        },
        page([active(recipe("bank-signin", "/login"))], 4),
      ],
    });
    expect(await sync.sync()).toBe("synced");
    expect(cache()).toMatchObject({ cursor: 4, unreadableBy: "1c42ad3" });
  });

  it("stores the reset of a reread before reading, so a failed one goes on from cursor 0", async () => {
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 6,
      recipes: [],
      unreadableBy: "0ld0001",
    };
    const { sync, cache, transport } = setup({
      stored,
      pages: [{ kind: "failed", error: "unreachable" }, page([], 6)],
    });
    expect(await sync.sync()).toBe("unreachable");
    // The reset is stored before the first page is read, so a later run is an ordinary one.
    const { unreadableBy: _, ...reset } = stored;
    expect(cache()).toEqual({ ...reset, cursor: 0 });
    expect(await sync.sync()).toBe("synced");
    expect(transport.recipeChanges.mock.calls).toEqual([
      [SERVICE, CREDENTIAL, 0],
      [SERVICE, CREDENTIAL, 0],
    ]);
    expect(cache()).not.toHaveProperty("unreadableBy");
  });

  it("does not read the heads again for the build that left a change out", async () => {
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 6,
      recipes: [],
      unreadableBy: "1c42ad3",
    };
    const { sync, transport, cache } = setup({ stored, pages: [page([], 6)] });
    expect(await sync.sync()).toBe("synced");
    expect(transport.recipeChanges).toHaveBeenCalledExactlyOnceWith(SERVICE, CREDENTIAL, 6);
    expect(cache()).toEqual(stored);
  });

  it("starts over for another pairing or an unreadable cache", async () => {
    for (const stored of [
      {
        version: 2,
        origin: SERVICE,
        deviceId: OTHER_DEVICE,
        cursor: 9,
        recipes: [recipe("x", "/")],
      },
      { version: 2, origin: "https://other.example.com", deviceId: DEVICE, cursor: 9, recipes: [] },
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
      version: 2,
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
      projected(recipe("bank-signin", "/login")),
    );
  });

  it("tells a withdrawn recipe from recipes it cannot read", async () => {
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 3,
      recipes: [recipe("bank-signin", "/login")],
    };
    const { sync } = setup({ stored });
    expect(await sync.recipes.withdrawn!(SITE, "bank-signin")).toBe(false);
    expect(await sync.recipes.withdrawn!(SITE, "removed")).toBe(true);
    expect(await sync.recipes.withdrawn!(SITE, "bank-signin", "missing-layout")).toBe(true);
    // Another pairing's cache or one that does not parse is not read, so nothing is withdrawn.
    for (const unread of [{ ...stored, deviceId: OTHER_DEVICE }, { version: 2 }]) {
      const other = setup({ stored: unread });
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      expect(await other.sync.recipes.withdrawn!(SITE, "removed")).toBe(false);
    }
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
}
