import { describe, expect, it, vi } from "vitest";
import { layoutRecipe, toLoginLayout } from "@pateat/contracts";
import { createDeviceRecipes } from "../../service/device-recipes";
import { createRecipeSync } from "../../service/recipes";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { bindingReviewFixture } = await import("./binding-review-fixture");
const { start, offer, pick, stale, repairedRecipe } = bindingReviewFixture(fake);

describe("repair persistence with real recipe and vault freshness fences", () => {
  it.each(["cache-clear", "device-write", "vault-lock"])(
    "keeps the old binding after %s during the final queued profile read",
    async (change) => {
      const document = {
        version: 1 as const,
        id: repairedRecipe.id,
        revision: 1,
        origin: repairedRecipe.origin,
        layouts: [toLoginLayout(repairedRecipe, { key: "1000", createdAt: 1000 })],
      };
      const projected = layoutRecipe(document, document.layouts[0]!);
      let deviceValue: unknown = { version: 1, recipes: [document] };
      const writeGate = Promise.withResolvers<void>();
      const writing = Promise.withResolvers<void>();
      const device = createDeviceRecipes({
        storage: {
          read: async () => structuredClone(deviceValue),
          write: async (value) => {
            writing.resolve();
            await writeGate.promise;
            deviceValue = structuredClone(value);
          },
          clear: async () => {
            deviceValue = undefined;
          },
        },
        transport: { writeRecipe: async () => ({ kind: "failed" }) as never },
      });
      const connection = {
        origin: "https://service.example",
        deviceId: "50000000-0000-4000-8000-000000000001",
        credential: `pateat_device_${"C".repeat(43)}`,
        rejected: false,
      };
      let cache: unknown = {
        version: 2,
        origin: connection.origin,
        deviceId: connection.deviceId,
        cursor: 1,
        recipes: [document],
      };
      const sync = createRecipeSync({
        service: {
          connection: async () => (change === "device-write" ? undefined : connection),
          recordSync: async () => undefined,
          fence: () => () => true,
        },
        transport: {
          recipeChanges: async () => ({
            kind: "page",
            page: { version: 1, changes: [], cursor: 1, complete: true },
          }),
        },
        storage: {
          read: async () => structuredClone(cache),
          readRecovery: async () => undefined,
          writeRecovery: async () => undefined,
          write: async (value) => {
            cache = value;
          },
          clear: async () => {
            cache = undefined;
          },
        },
        schedule: {
          read: async () => undefined,
          write: async () => undefined,
        },
        device,
        build: "synthetic-test",
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let guarded = false;
      let scopes = 0;
      let unlocked = true;
      const h = start({
        bindingSnapshotCurrent: () => unlocked,
        bindingScope: async () => {
          if (guarded && ++scopes === 2) {
            entered.resolve();
            await release.promise;
          }
          return "profile-a";
        },
      });
      h.recipes.recipe.mockResolvedValue(projected);
      h.recipes.fence.mockImplementation((recipe) => sync.recipes.fence!(recipe));
      const review = await offer(h);
      const original = h.store.update.getMockImplementation()!;
      h.store.update.mockImplementationOnce(async (...args) => {
        guarded = true;
        return original(...args);
      });
      fake.state.onReconnect = () => h.hello();
      expect(await pick(h, review)).toEqual({ ok: true });
      await entered.promise;
      let pending: Promise<unknown> | undefined;
      if (change === "cache-clear") await sync.clear();
      if (change === "device-write") {
        pending = device.keep([{ ...document, revision: 2 }]);
        await writing.promise;
      }
      if (change === "vault-lock") unlocked = false;
      release.resolve();
      await vi.waitFor(() =>
        expect(fake.state.session["pateat.login-binding-reviews.v1"]).toEqual([]),
      );
      expect(h.settings.settings.bindings[0]).toEqual(stale);
      expect(fake.state.storage["binding-review.synthetic-settings"]).toBeUndefined();
      writeGate.resolve();
      await pending;
    },
  );
});
