import {
  parseLoginRecipe,
  toLoginLayout,
  type LoginRecipeDocument,
  type SyncRecipeChange,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDeviceRecipes, type DeviceRecipeStorage } from "./device-recipes";
import type { ServiceConnection } from "./runtime";
import type { RecipeWriteResult, ServiceTransport } from "./transport";

// Synthetic service, credential and recipes only.

const SITE = "https://bank.example";
const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const target = (value: string) => ({ by: "id" as const, value });

function recipe(id: string, revision = 4, path = "/login"): LoginRecipeDocument {
  const route = parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin: SITE,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        path,
        fields: [
          { slot: "username", target: target("user") },
          { slot: "password", target: target("pass") },
        ],
      },
      { kind: "click", path, target: target("login"), purpose: "submit" },
    ],
    completion: [{ target: target("welcome") }],
    maxSubmissions: 1,
  });
  return {
    version: 1,
    id,
    revision,
    origin: SITE,
    layouts: [toLoginLayout(route, { key: "1000", createdAt: 1000 })],
  };
}

function memory(initial?: unknown) {
  let value = initial;
  const storage: DeviceRecipeStorage & { value(): unknown } = {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (store) => {
      value = structuredClone(store);
    }),
    clear: vi.fn(async () => {
      value = undefined;
    }),
    value: () => value,
  };
  return storage;
}

const change = (value: LoginRecipeDocument): SyncRecipeChange => ({
  recipeId: value.id,
  revision: 1,
  state: "active",
  recipe: { ...value, revision: 1 },
});

function setup(
  initial?: unknown,
  answers: ((id: string) => RecipeWriteResult) | RecipeWriteResult[] = (id) => ({
    kind: "written",
    change: change(recipe(id)),
  }),
  maxBytes?: number,
) {
  const storage = memory(initial);
  const queue = Array.isArray(answers) ? [...answers] : undefined;
  const writeRecipe = vi.fn<ServiceTransport["writeRecipe"]>(async (_origin, _credential, id) =>
    queue ? queue.shift()! : (answers as (id: string) => RecipeWriteResult)(id),
  );
  const recipes = createDeviceRecipes({
    storage,
    transport: { writeRecipe },
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { storage, writeRecipe, recipes };
}

describe("recipes this device holds as its own (ADR 0040)", () => {
  it("keeps recipes, replacing one only with a newer revision", async () => {
    const { recipes } = setup({ version: 1, recipes: [recipe("a", 4), recipe("b", 2)] });
    const newer = { ...recipe("b", 3, "/signin") };
    await recipes.keep([recipe("a", 3, "/other"), newer, recipe("c", 1)]);
    expect(await recipes.list()).toEqual([recipe("a", 4), newer, recipe("c", 1)]);
    expect(await recipes.count()).toBe(3);
  });

  it("keeps nothing when the result would not fit", async () => {
    // Room for two recipes, not three.
    const room = new TextEncoder().encode(
      JSON.stringify({ version: 1, recipes: [recipe("a"), recipe("b")] }),
    ).byteLength;
    const { recipes, storage } = setup({ version: 1, recipes: [recipe("a")] }, undefined, room);
    await expect(recipes.keep([recipe("b"), recipe("c")])).rejects.toThrow();
    expect(storage.write).not.toHaveBeenCalled();
    await recipes.keep([recipe("b")]);
    expect(await recipes.count()).toBe(2);
  });

  it("counts a copy it cannot read as unreadable, and deletes it", async () => {
    const { recipes, storage } = setup({ version: 1, recipes: [{ id: "broken" }] });
    expect(await recipes.count()).toBeUndefined();
    await expect(recipes.list()).rejects.toThrow();
    await recipes.clear();
    expect(storage.value()).toBeUndefined();
    expect(await recipes.count()).toBe(0);
  });

  it("uploads each recipe once as a new one at revision 1, and forgets those the service holds", async () => {
    const held = [recipe("a"), recipe("b")];
    const { recipes, writeRecipe, storage } = setup({ version: 1, recipes: held }, [
      { kind: "written", change: change(recipe("a")) },
      // The service already holds `b`, also revoked: its copy wins.
      { kind: "conflict", current: { recipeId: "b", revision: 2, state: "revoked" } },
    ]);
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    expect(writeRecipe.mock.calls.map(([, , id, write]) => [id, write])).toEqual([
      [
        "a",
        { version: 1, expectedRevision: 0, state: "active", recipe: { ...held[0], revision: 1 } },
      ],
      [
        "b",
        { version: 1, expectedRevision: 0, state: "active", recipe: { ...held[1], revision: 1 } },
      ],
    ]);
    expect(storage.value()).toBeUndefined();
  });

  it("keeps a recipe the service refuses for good, and never sends it again", async () => {
    const { recipes, writeRecipe } = setup({ version: 1, recipes: [recipe("a"), recipe("b")] }, [
      { kind: "refused" },
      { kind: "written", change: change(recipe("b")) },
    ]);
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    expect(await recipes.list()).toEqual([recipe("a")]);
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    expect(writeRecipe).toHaveBeenCalledTimes(2);
    // A newer copy kept later under the ID goes up again.
    await recipes.keep([recipe("a", 5)]);
    writeRecipe.mockResolvedValueOnce({ kind: "written", change: change(recipe("a")) });
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    expect(writeRecipe).toHaveBeenCalledTimes(3);
    expect(await recipes.count()).toBe(0);
  });

  it.each<[string, RecipeWriteResult, "retry" | "rejected"]>([
    ["a full service", { kind: "failed", error: "recipe-limit" }, "retry"],
    ["a refused rate", { kind: "failed", error: "rate-limited" }, "retry"],
    ["a server error", { kind: "failed", error: "unexpected-response" }, "retry"],
    ["no connection", { kind: "failed", error: "unreachable" }, "retry"],
    ["a revoked device", { kind: "rejected" }, "rejected"],
  ])("stops at %s and keeps the rest for the next full sync", async (_name, answer, outcome) => {
    const { recipes, writeRecipe } = setup({ version: 1, recipes: [recipe("a"), recipe("b")] }, [
      { kind: "written", change: change(recipe("a")) },
      answer,
    ]);
    expect(await recipes.upload(CONNECTION, () => false)).toBe(outcome);
    expect(writeRecipe).toHaveBeenCalledTimes(2);
    expect(await recipes.list()).toEqual([recipe("b")]);
  });

  it("forgets nothing when the device was disconnected meanwhile", async () => {
    let stale = false;
    const { recipes } = setup({ version: 1, recipes: [recipe("a")] }, () => {
      stale = true;
      return { kind: "written", change: change(recipe("a")) };
    });
    await recipes.upload(CONNECTION, () => stale);
    expect(await recipes.list()).toEqual([recipe("a")]);
  });

  it("keeps a copy kept under the ID while it was uploading", async () => {
    const { recipes } = setup({ version: 1, recipes: [recipe("a")] });
    const uploading = recipes.upload(CONNECTION, () => false);
    await recipes.keep([recipe("a", 9)]);
    await uploading;
    expect(await recipes.list()).toEqual([recipe("a", 9)]);
  });
});
