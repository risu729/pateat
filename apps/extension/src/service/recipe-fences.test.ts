import { describe, expect, it, vi } from "vitest";
import { layoutRecipe, parseLoginRecipe, toLoginLayout } from "@pateat/contracts";
import { createDeviceRecipes } from "./device-recipes";
import { createRecipeSync } from "./recipes";

const origin = "https://login.example";
const route = parseLoginRecipe({
  version: 1,
  id: "synthetic-fenced",
  revision: 1,
  origin,
  pageKind: "sign-in",
  slots: ["password"],
  steps: [
    {
      kind: "fill",
      path: "/signin",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
  ],
  completion: [{ target: { by: "id", value: "home" } }],
  maxSubmissions: 1,
});
const document = {
  version: 1 as const,
  id: route.id,
  revision: 1,
  origin,
  layouts: [toLoginLayout(route, { key: "1000", createdAt: 1000 })],
};
const projected = layoutRecipe(document, document.layouts[0]!);

function setup(local: boolean) {
  const connection = {
    origin: "https://service.example",
    deviceId: "50000000-0000-4000-8000-000000000001",
    credential: `pateat_device_${"C".repeat(43)}`,
    rejected: false,
  };
  let deviceValue: unknown = { version: 1, recipes: [document] };
  const deviceStorage = {
    read: vi.fn(async () => structuredClone(deviceValue)),
    write: vi.fn(async (value: unknown) => {
      deviceValue = structuredClone(value);
    }),
    clear: vi.fn(async () => {
      deviceValue = undefined;
    }),
  };
  const device = createDeviceRecipes({
    storage: deviceStorage,
    transport: { writeRecipe: async () => ({ kind: "failed", error: "unavailable" }) as never },
  });
  let pairedEpoch = 0;
  const service = {
    connection: async () => (local ? undefined : connection),
    recordSync: async () => undefined,
    fence: () => {
      const initial = pairedEpoch;
      return () => initial === pairedEpoch;
    },
  };
  let cacheValue: unknown = {
    version: 2,
    origin: connection.origin,
    deviceId: connection.deviceId,
    cursor: 1,
    recipes: [document],
  };
  const cache = {
    readRecovery: async () => undefined,
    writeRecovery: async () => undefined,
    read: vi.fn(async () => structuredClone(cacheValue)),
    write: vi.fn(async (value: unknown) => {
      cacheValue = structuredClone(value);
    }),
    clear: vi.fn(async () => {
      cacheValue = undefined;
    }),
  };
  const sync = createRecipeSync({
    service,
    transport: {
      recipeChanges: async () => ({
        kind: "page",
        page: { version: 1, changes: [], cursor: 1, complete: true },
      }),
    },
    storage: cache,
    schedule: {
      read: async () => undefined,
      write: async () => undefined,
    },
    device,
    build: "synthetic-test",
  });
  return {
    sync,
    device,
    deviceStorage,
    cache,
    rePair: () => {
      pairedEpoch += 1;
    },
  };
}

describe("recipe fences used by a queued binding repair", () => {
  it("keeps a cached recipe fence valid over reads but invalidates it synchronously when clear starts", async () => {
    const h = setup(false);
    const fence = await h.sync.recipes.fence!(projected);
    expect(fence?.()).toBe(true);
    await h.sync.inUse();
    expect(fence?.()).toBe(true);
    const clearing = h.sync.clear();
    expect(fence?.()).toBe(false);
    await clearing;
    expect(await h.sync.recipes.fence!(projected)).toBeUndefined();
  });
  it("invalidates a cached recipe fence when pairing identity changes during another await", async () => {
    const h = setup(false);
    const fence = await h.sync.recipes.fence!(projected);
    h.rePair();
    expect(fence?.()).toBe(false);
  });
  it("invalidates a local recipe fence before a newer document write has finished", async () => {
    const h = setup(true);
    const fence = await h.sync.recipes.fence!(projected);
    expect(fence?.()).toBe(true);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    h.deviceStorage.write.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    const writing = h.device.keep([{ ...document, revision: 2 }]);
    await entered.promise;
    expect(fence?.()).toBe(false);
    expect(await h.sync.recipes.fence!(projected)).toBeUndefined();
    gate.resolve();
    await writing;
    expect(fence?.()).toBe(false);
  });
  it("invalidates a local recipe fence when its stored copy is cleared", async () => {
    const h = setup(true);
    const fence = await h.sync.recipes.fence!(projected);
    await h.device.clear();
    expect(fence?.()).toBe(false);
  });
});
