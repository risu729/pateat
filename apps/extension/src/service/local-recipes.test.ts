import { parseLoginRecipe, type LoginRecipe, type StoredLoginRecipe } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createLocalRecipes, MAX_LOCAL_RECIPE_BYTES, type RecipeFile } from "./local-recipes";
import { MAX_RECIPE_CACHE_BYTES } from "./recipes";
import type { ServiceConnection } from "./runtime";
import type { RecipeWriteResult, ServiceTransport } from "./transport";

// Synthetic recipes, service and credential only (ADR 0039).

const SITE = "https://bank.example";
const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const target = (value: string) => ({ by: "id" as const, value });

function recipe(id: string, revision = 1, path = "/login"): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin: SITE,
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
    maxSubmissions: 1,
  });
}
const file = (...recipes: StoredLoginRecipe[]): RecipeFile => ({
  format: "pateat-recipes",
  version: 1,
  recipes,
});

function setup(
  options: {
    stored?: unknown;
    connection?: ServiceConnection | undefined | "unreadable";
    synced?: StoredLoginRecipe[];
    writes?: RecipeWriteResult[];
  } = {},
) {
  let value = options.stored;
  const storage = {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (next: unknown) => {
      value = structuredClone(next);
    }),
    clear: vi.fn(async () => {
      value = undefined;
    }),
  };
  let connection = options.connection;
  const service = {
    connection: vi.fn(async () => {
      if (connection === "unreadable") throw new Error("unreadable");
      return connection;
    }),
  };
  const writes = [...(options.writes ?? [])];
  const transport = {
    writeRecipe: vi.fn<ServiceTransport["writeRecipe"]>(
      async () => writes.shift() ?? { kind: "written" },
    ),
  };
  const local = createLocalRecipes({
    storage,
    service,
    synced: async () => options.synced,
    transport,
  });
  const send = (request: object) => local.handle({ version: 1, ...request });
  return {
    local,
    send,
    storage,
    transport,
    stored: () => value as { recipes: StoredLoginRecipe[] } | undefined,
    pair: (next: ServiceConnection | undefined) => {
      connection = next;
    },
  };
}

describe("recipes kept without a service", () => {
  it("imports a recipe file into an empty device and lists it", async () => {
    const { send, stored, local } = setup();
    expect(await send({ type: "recipes.get" })).toEqual({
      version: 1,
      ok: true,
      state: { source: "device", recipes: [], waiting: 0 },
    });
    const response = await send({ type: "recipes.import", file: file(recipe("a"), recipe("b")) });
    expect(response).toEqual({
      version: 1,
      ok: true,
      state: {
        source: "device",
        recipes: [
          { id: "a", origin: SITE, revision: 1, kind: "login" },
          { id: "b", origin: SITE, revision: 1, kind: "login" },
        ],
        waiting: 0,
      },
      imported: { added: 2, updated: 0, unchanged: 0, skipped: 0 },
    });
    expect(stored()).toEqual({ version: 1, recipes: [recipe("a"), recipe("b")] });
    expect(await local.list()).toEqual([recipe("a"), recipe("b")]);
  });

  it("replaces a kept recipe only with a higher revision", async () => {
    const { send, stored } = setup({
      stored: { version: 1, recipes: [recipe("a", 2), recipe("b", 2), recipe("c", 2)] },
    });
    const response = await send({
      type: "recipes.import",
      file: file(recipe("a", 3, "/new"), recipe("b", 2), recipe("c", 2, "/other"), recipe("d", 1)),
    });
    expect(response).toMatchObject({
      ok: true,
      imported: { added: 1, updated: 1, unchanged: 1, skipped: 1 },
    });
    expect(stored()?.recipes).toEqual([
      recipe("a", 3, "/new"),
      recipe("b", 2),
      recipe("c", 2),
      recipe("d", 1),
    ]);
    // An older revision is skipped too.
    expect(await send({ type: "recipes.import", file: file(recipe("a", 1)) })).toMatchObject({
      imported: { added: 0, updated: 0, unchanged: 0, skipped: 1 },
    });
  });

  it("refuses a file that is not a valid recipe file and changes nothing", async () => {
    const { send, storage } = setup({ stored: { version: 1, recipes: [recipe("a")] } });
    for (const invalid of [
      { recipes: [recipe("b")] },
      { ...file(recipe("b")), format: "other" },
      file(recipe("b"), recipe("b")),
      { ...file(), recipes: [{ ...recipe("b"), revision: -1 }] },
      [recipe("b")],
      "text",
    ])
      // oxlint-disable-next-line no-await-in-loop
      expect(await send({ type: "recipes.import", file: invalid })).toMatchObject({
        ok: false,
        error: "invalid-file",
        state: { source: "device", recipes: [{ id: "a" }] },
      });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("refuses an import that outgrows the recipes' share of local storage", async () => {
    expect(MAX_LOCAL_RECIPE_BYTES).toBe(MAX_RECIPE_CACHE_BYTES);
    const { send, storage } = setup();
    const large = Array.from({ length: Math.ceil(MAX_RECIPE_CACHE_BYTES / 200) }, (_, index) =>
      recipe(`recipe-${index}`),
    );
    expect(await send({ type: "recipes.import", file: file(...large) })).toMatchObject({
      ok: false,
      error: "too-large",
    });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("removes one recipe, and forgets the record with the last one", async () => {
    const { send, stored, storage } = setup({
      stored: { version: 1, recipes: [recipe("a"), recipe("b")] },
    });
    expect(await send({ type: "recipes.remove", recipeId: "a" })).toMatchObject({
      ok: true,
      state: { recipes: [{ id: "b" }] },
    });
    expect(stored()?.recipes).toEqual([recipe("b")]);
    await send({ type: "recipes.remove", recipeId: "b" });
    expect(storage.clear).toHaveBeenCalled();
    expect(stored()).toBeUndefined();
  });

  it("exports the recipes logins use: those kept here, or the paired service's", async () => {
    const unpaired = setup({ stored: { version: 1, recipes: [recipe("a")] } });
    expect(await unpaired.send({ type: "recipes.export" })).toMatchObject({
      ok: true,
      file: file(recipe("a")),
    });
    const paired = setup({
      stored: { version: 1, recipes: [recipe("a")] },
      connection: CONNECTION,
      synced: [recipe("s", 4)],
    });
    expect(await paired.send({ type: "recipes.export" })).toMatchObject({
      ok: true,
      state: {
        source: "service",
        recipes: [{ id: "s", revision: 4 }],
        waiting: 1,
      },
      file: file(recipe("s", 4)),
    });
  });

  it("leaves import and removal to the service while a device is paired", async () => {
    const { send, storage } = setup({
      stored: { version: 1, recipes: [recipe("a")] },
      connection: CONNECTION,
      synced: [],
    });
    for (const request of [
      { type: "recipes.import", file: file(recipe("b")) },
      { type: "recipes.remove", recipeId: "a" },
    ])
      // oxlint-disable-next-line no-await-in-loop
      expect(await send(request)).toMatchObject({ ok: false, error: "paired" });
    expect(storage.write).not.toHaveBeenCalled();
    // Recipes still waiting for an upload may be discarded.
    expect(await send({ type: "recipes.clear" })).toMatchObject({
      ok: true,
      state: { source: "service", waiting: 0 },
    });
  });

  it("serves nothing from an unreadable copy, refuses to import over it, and clears it", async () => {
    const { send, local, stored } = setup({ stored: { version: 2, recipes: [] } });
    expect(await local.list()).toBeUndefined();
    expect(await send({ type: "recipes.get" })).toMatchObject({
      ok: true,
      state: { source: "unavailable", unreadable: true },
    });
    expect(await send({ type: "recipes.import", file: file(recipe("a")) })).toMatchObject({
      ok: false,
      error: "storage-corrupt",
    });
    expect(await send({ type: "recipes.clear" })).toMatchObject({
      ok: true,
      state: { source: "device", recipes: [] },
    });
    expect(stored()).toBeUndefined();
  });

  it("refuses to act when the pairing cannot be read", async () => {
    const { send } = setup({ connection: "unreadable" });
    expect(await send({ type: "recipes.get" })).toMatchObject({
      ok: true,
      state: { source: "unavailable" },
    });
    expect(await send({ type: "recipes.import", file: file(recipe("a")) })).toMatchObject({
      ok: false,
      error: "storage-unavailable",
    });
  });

  it("answers an invalid request without touching storage", async () => {
    const { local, storage } = setup();
    expect(await local.handle({ version: 1, type: "recipes.rename" })).toEqual({
      version: 1,
      ok: false,
      error: "invalid-request",
    });
    expect(storage.read).not.toHaveBeenCalled();
  });
});

describe("uploading kept recipes after pairing", () => {
  it("writes each kept recipe as a new revision 1 and forgets those the service holds", async () => {
    const { local, transport, stored } = setup({
      stored: { version: 1, recipes: [recipe("a", 5), recipe("b"), recipe("c")] },
      writes: [{ kind: "written" }, { kind: "conflict" }, { kind: "refused" }],
    });
    expect(await local.upload(CONNECTION, () => false)).toBe("done");
    expect(transport.writeRecipe).toHaveBeenCalledTimes(3);
    expect(transport.writeRecipe).toHaveBeenNthCalledWith(
      1,
      CONNECTION.origin,
      CONNECTION.credential,
      "a",
      { version: 1, expectedRevision: 0, state: "active", recipe: recipe("a", 1) },
    );
    // The written and the already held recipes are gone; the refused one waits.
    expect(stored()?.recipes).toEqual([recipe("c")]);
  });

  it("stops at a full service or a failed request and keeps the rest", async () => {
    for (const stop of [
      { kind: "limit" },
      { kind: "failed", error: "unreachable" },
    ] satisfies RecipeWriteResult[]) {
      const { local, transport, stored } = setup({
        stored: { version: 1, recipes: [recipe("a"), recipe("b"), recipe("c")] },
        writes: [{ kind: "written" }, stop],
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(await local.upload(CONNECTION, () => false)).toBe("done");
      expect(transport.writeRecipe).toHaveBeenCalledTimes(2);
      expect(stored()?.recipes).toEqual([recipe("b"), recipe("c")]);
    }
  });

  it("reports a rejected device and stops", async () => {
    const { local, transport, stored } = setup({
      stored: { version: 1, recipes: [recipe("a"), recipe("b")] },
      writes: [{ kind: "rejected" }],
    });
    expect(await local.upload(CONNECTION, () => false)).toBe("rejected");
    expect(transport.writeRecipe).toHaveBeenCalledTimes(1);
    expect(stored()?.recipes).toEqual([recipe("a"), recipe("b")]);
  });

  it("stops when the device is disconnected meanwhile", async () => {
    let stale = false;
    const { local, transport, stored } = setup({
      stored: { version: 1, recipes: [recipe("a"), recipe("b")] },
    });
    transport.writeRecipe.mockImplementationOnce(async () => {
      stale = true;
      return { kind: "written" };
    });
    expect(await local.upload(CONNECTION, () => stale)).toBe("done");
    expect(transport.writeRecipe).toHaveBeenCalledTimes(1);
    expect(stored()?.recipes).toEqual([recipe("b")]);
  });

  it("does nothing without kept recipes or with an unreadable copy", async () => {
    for (const stored of [undefined, { version: 1, recipes: "x" }]) {
      const { local, transport } = setup({ stored });
      // oxlint-disable-next-line no-await-in-loop
      expect(await local.upload(CONNECTION, () => false)).toBe("done");
      expect(transport.writeRecipe).not.toHaveBeenCalled();
    }
  });

  it("gives a chooser's branches the chooser's new revision", async () => {
    const branch = { ...recipe("chooser", 3, "/password") };
    const chooser: StoredLoginRecipe = {
      version: 1,
      id: "chooser",
      revision: 3,
      origin: SITE,
      chooser: { path: "/accounts", other: target("other"), afterOther: branch },
    };
    const { local, transport } = setup({ stored: { version: 1, recipes: [chooser] } });
    await local.upload(CONNECTION, () => false);
    expect(transport.writeRecipe.mock.calls[0]![3]).toEqual({
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: {
        ...chooser,
        revision: 1,
        chooser: { ...chooser.chooser, afterOther: { ...branch, revision: 1 } },
      },
    });
  });
});
