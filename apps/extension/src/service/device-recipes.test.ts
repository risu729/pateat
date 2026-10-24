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
    expect(await recipes.keep([recipe("a", 3, "/other"), newer, recipe("c", 1)])).toBe(2);
    expect(await recipes.list()).toEqual([recipe("a", 4), newer, recipe("c", 1)]);
    expect(await recipes.count()).toBe(3);
  });

  it("writes nothing when every recipe given is kept already at that revision or newer", async () => {
    const { recipes, storage } = setup({ version: 1, recipes: [recipe("a", 4)] });
    expect(await recipes.keep([recipe("a", 4, "/other"), recipe("a", 2)])).toBe(0);
    expect(storage.write).not.toHaveBeenCalled();
    expect(await recipes.list()).toEqual([recipe("a", 4)]);
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

  it("keeps nothing when the result would hold more recipes than allowed", async () => {
    const { recipes, storage } = setup({ version: 1, recipes: [recipe("a")] });
    await expect(recipes.keep([recipe("b"), recipe("c")], 2)).rejects.toThrow();
    expect(storage.write).not.toHaveBeenCalled();
    expect(await recipes.keep([recipe("b")], 2)).toBe(1);
  });

  it("counts a copy it cannot read as unreadable, and deletes it", async () => {
    const { recipes, storage } = setup({ version: 1, recipes: [{ id: "broken" }] });
    expect(await recipes.count()).toBe(-1);
    await expect(recipes.list()).rejects.toThrow();
    await recipes.clear();
    expect(storage.value()).toBeUndefined();
    expect(await recipes.count()).toBe(0);
  });

  it("counts nothing while storage is unavailable, which may pass", async () => {
    const { recipes, storage } = setup({ version: 1, recipes: [recipe("a")] });
    vi.mocked(storage.read).mockRejectedValueOnce(new Error("unavailable"));
    expect(await recipes.count()).toBeUndefined();
    expect(await recipes.count()).toBe(1);
  });

  it("uploads each recipe as a new one at revision 1, and forgets one the service revoked", async () => {
    const held = [recipe("a"), recipe("b"), recipe("c")];
    const { recipes, writeRecipe, storage } = setup({ version: 1, recipes: held }, [
      { kind: "written", change: change(recipe("a")) },
      // The service already holds `b` revoked: its copy wins.
      { kind: "conflict", current: { recipeId: "b", revision: 2, state: "revoked" } },
      { kind: "conflict", current: change(recipe("c")) },
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
      [
        "c",
        { version: 1, expectedRevision: 0, state: "active", recipe: { ...held[2], revision: 1 } },
      ],
    ]);
    // Those the service holds active stay until the synced cache holds them too, so a
    // disconnect that keeps the synced recipes cannot miss them.
    expect(await recipes.list()).toEqual([recipe("a"), recipe("c")]);
    await recipes.forget(new Set(["a", "c", "other"]), () => true);
    expect(await recipes.count()).toBe(2);
    await recipes.forget(new Set(["a", "c", "other"]), () => false);
    expect(storage.value()).toBeUndefined();
  });

  it("keeps a recipe the service refuses for good, and never sends it again", async () => {
    const { recipes, writeRecipe } = setup({ version: 1, recipes: [recipe("a"), recipe("b")] }, [
      { kind: "refused" },
      { kind: "written", change: change(recipe("b")) },
    ]);
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    await recipes.forget(new Set(["b"]), () => false);
    expect(await recipes.list()).toEqual([recipe("a")]);
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    expect(writeRecipe).toHaveBeenCalledTimes(2);
    // A newer copy kept later under the ID goes up again.
    await recipes.keep([recipe("a", 5)]);
    writeRecipe.mockResolvedValueOnce({ kind: "written", change: change(recipe("a")) });
    expect(await recipes.upload(CONNECTION, () => false)).toBe("done");
    expect(writeRecipe).toHaveBeenCalledTimes(3);
    await recipes.forget(new Set(["a"]), () => false);
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
    expect(await recipes.list()).toEqual([recipe("a"), recipe("b")]);
  });

  it("forgets nothing when the device was disconnected meanwhile", async () => {
    let stale = false;
    const { recipes } = setup({ version: 1, recipes: [recipe("a")] }, () => {
      stale = true;
      return { kind: "conflict", current: { recipeId: "a", revision: 2, state: "revoked" } };
    });
    await recipes.upload(CONNECTION, () => stale);
    expect(await recipes.list()).toEqual([recipe("a")]);
  });

  it("keeps a copy kept under the ID while it was uploading", async () => {
    const { recipes } = setup({ version: 1, recipes: [recipe("a")] }, [
      { kind: "conflict", current: { recipeId: "a", revision: 2, state: "revoked" } },
    ]);
    const uploading = recipes.upload(CONNECTION, () => false);
    await recipes.keep([recipe("a", 9)]);
    await uploading;
    expect(await recipes.list()).toEqual([recipe("a", 9)]);
  });
});

describe("recipes written on this device without a pairing (ADR 0040)", () => {
  const write = (value: LoginRecipeDocument, expectedRevision: number) => ({
    version: 1 as const,
    state: "active" as const,
    expectedRevision,
    recipe: value,
  });

  it("writes only over the revision a write expects", async () => {
    const { recipes } = setup({ version: 1, recipes: [recipe("a", 2)] });
    expect(await recipes.write("a", write(recipe("a", 2), 1))).toEqual({
      ok: false,
      limited: false,
      current: recipe("a", 2),
    });
    expect(await recipes.write("a", write(recipe("a", 3, "/signin"), 2))).toEqual({
      ok: true,
      recipe: recipe("a", 3, "/signin"),
    });
    expect(await recipes.head("a")).toEqual(recipe("a", 3, "/signin"));
    expect(await recipes.write("b", write(recipe("b", 1), 0))).toEqual({
      ok: true,
      recipe: recipe("b", 1),
    });
    expect((await recipes.usage()).count).toBe(2);
  });

  it("refuses a write the check says no to, and one of another recipe's ID", async () => {
    const { recipes } = setup();
    expect(await recipes.write("a", write(recipe("a", 1), 0), async () => false)).toEqual({
      ok: false,
      limited: false,
      current: undefined,
    });
    expect(await recipes.write("b", write(recipe("a", 1), 0))).toEqual({
      ok: false,
      limited: false,
      current: undefined,
    });
    expect(await recipes.list()).toEqual([]);
  });

  it("holds a write that would not fit, but not one that shrinks a recipe", async () => {
    const large = recipe("a", 1, `/${"x".repeat(200)}`);
    const room = new TextEncoder().encode(
      JSON.stringify({ version: 1, recipes: [large] }),
    ).byteLength;
    const { recipes } = setup({ version: 1, recipes: [large] }, undefined, room);
    expect(await recipes.write("b", write(recipe("b", 1), 0))).toEqual({
      ok: false,
      limited: true,
    });
    expect(await recipes.write("a", write(recipe("a", 2), 1))).toEqual({
      ok: true,
      recipe: recipe("a", 2),
    });
  });

  it("removes a recipe it revokes", async () => {
    const { recipes } = setup({ version: 1, recipes: [recipe("a", 2)] });
    expect(await recipes.write("a", { version: 1, state: "revoked", expectedRevision: 2 })).toEqual(
      { ok: true, recipe: undefined },
    );
    expect(await recipes.list()).toEqual([]);
  });
});
