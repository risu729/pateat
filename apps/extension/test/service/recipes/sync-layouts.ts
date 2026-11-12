import { expect, it, vi } from "vitest";
import type { RecipeChangesResult } from "../../../src/service/transport";
import { parseLoginRecipe, routeBodyOf, toLoginLayout } from "@pateat/contracts";
import { laterReadiness } from "../../../src/login/wire";
import type { LoginRecipeDocument } from "@pateat/contracts";
import type { RecipeSyncContext } from "./context";

export function registerSyncLayoutCases({
  setup,
  page,
  active,
  recipe,
  SERVICE,
  DEVICE,
  SITE,
  target,
  route,
  storedOf,
  projected,
}: Pick<
  RecipeSyncContext,
  | "setup"
  | "page"
  | "active"
  | "recipe"
  | "SERVICE"
  | "DEVICE"
  | "SITE"
  | "target"
  | "route"
  | "storedOf"
  | "projected"
>) {
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

  it("erases a late durable cache write before disconnect clearing resolves", async () => {
    const h = setup({ pages: [page([active(recipe("bank-signin", "/login"))], 1)] });
    const write = h.storage.write.getMockImplementation()!;
    let finish: () => void = () => undefined;
    h.storage.write.mockImplementationOnce(async (next) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await write(next);
    });
    const running = h.sync.sync();
    await vi.waitFor(() => expect(h.storage.write).toHaveBeenCalledOnce());
    const clearing = h.sync.clear();
    expect(h.storage.clear).not.toHaveBeenCalled();
    finish();
    await clearing;
    expect(await running).toBe("not-connected");
    expect(h.cache()).toBeUndefined();
    expect(h.recovery()).toBeUndefined();
  });

  it("does not use a disconnected device's credential after loading its cache", async () => {
    const { sync, storage, transport } = setup();
    let loaded: (value: unknown) => void = () => undefined;
    storage.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    const running = sync.sync();
    await vi.waitFor(() => expect(storage.read).toHaveBeenCalledOnce());
    await sync.clear();
    loaded(undefined);
    expect(await running).toBe("not-connected");
    expect(transport.recipeChanges).not.toHaveBeenCalled();
  });

  it("keeps the cache when the paired device cannot be read", async () => {
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [] };
    const { sync, service, cache } = setup({ stored });
    service.connection.mockRejectedValue(new Error("storage"));
    expect(await sync.sync()).toBe("storage-unavailable");
    expect(cache()).toEqual(stored);
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
  });

  it("forgets the cache when its device is disconnected", async () => {
    const stored = {
      version: 2,
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

  it("lists where every cached recipe for an origin starts, with each variant's first step", async () => {
    const contract = {
      slots: ["contract"],
      steps: [
        {
          kind: "fill" as const,
          path: "/login",
          effect: "prepare" as const,
          fields: [{ slot: "contract", target: target("contract") }],
        },
        {
          kind: "click" as const,
          path: "/login",
          target: target("go"),
          purpose: "submit" as const,
        },
      ],
    };
    const single = route("bank-signin", "/login");
    const varied = parseLoginRecipe({
      ...route("bank-app", "/app/login"),
      slots: ["username"],
      steps: [
        {
          kind: "fill",
          path: "/app/login",
          fields: [{ slot: "username", target: target("user") }],
        },
        { kind: "click", path: "/app/login", target: target("go"), purpose: "submit" },
      ],
      alternatives: [
        { ...contract, steps: contract.steps.map((step) => ({ ...step, path: "/app/login" })) },
      ],
    });
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 1,
      recipes: [storedOf(single), storedOf(varied)],
    };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    expect(await sync.recipes.starts(SITE)).toEqual([
      // The password page after the login page, where a login may also start (ADR 0049).
      {
        path: "/login",
        steps: [single.steps[0]],
        later: [laterReadiness({ step: single.steps[1]! })],
      },
      { path: "/app/login", steps: [varied.steps[0], varied.alternatives![0]!.steps[0]] },
    ]);
    expect(await sync.recipes.later!(SITE, "/password")).toEqual([{ ...single, layout: "1000" }]);
    expect(await sync.recipes.later!(SITE, "/login")).toEqual([]);
    expect(await sync.recipes.starts("https://other.example")).toEqual([]);
    await sync.clear();
    expect(await sync.recipes.starts(SITE)).toEqual([]);
    expect(await sync.recipes.later!(SITE, "/password")).toEqual([]);
  });

  it("runs one layout of a recipe (ADR 0060): the one named, or else the newest", async () => {
    const first = route("bank-signin", "/login");
    const second = parseLoginRecipe({
      ...first,
      steps: [
        { kind: "fill", path: "/login", fields: [{ slot: "username", target: target("email") }] },
        { kind: "fill", path: "/secret", fields: [{ slot: "password", target: target("secret") }] },
        { kind: "click", path: "/secret", target: target("go"), purpose: "submit" },
      ],
      completion: [{ target: target("home") }],
    });
    const layered: LoginRecipeDocument = {
      ...storedOf(first),
      layouts: [
        toLoginLayout(first, { key: "1000", language: "ja", createdAt: 1000 }),
        toLoginLayout(second, { key: "2000", createdAt: 2000 }),
      ],
    };
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [layered] };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    const one = { ...first, layout: "1000" };
    const two = { ...second, layout: "2000" };
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(two);
    expect(await sync.recipes.recipe(SITE, "/x", "bank-signin")).toEqual(two);
    expect(await sync.recipes.recipe(SITE, "/x", "bank-signin", "1000")).toEqual(one);
    // A layout removed meanwhile is gone for the login that ran it.
    expect(await sync.recipes.recipe(SITE, "/x", "bank-signin", "3000")).toBeUndefined();
    expect(await sync.recipes.layouts!(SITE, "/login")).toEqual([
      { recipe: one, language: "ja", createdAt: 1000 },
      { recipe: two, createdAt: 2000 },
    ]);
    expect(await sync.recipes.layouts!(SITE, "/secret")).toEqual([]);
    // Each layout's own markers, for a sign-in check that reads them all.
    expect(await sync.recipes.layoutsOf!(SITE, "bank-signin")).toEqual([one, two]);
    expect(await sync.recipes.layoutsOf!(SITE, "bank-other")).toEqual([]);
    // One start with every layout's first steps and later steps, each once.
    expect(await sync.recipes.starts(SITE)).toEqual([
      {
        path: "/login",
        steps: [first.steps[0], second.steps[0]],
        later: [first.steps[1], second.steps[1]].map((step) => laterReadiness({ step: step! })),
      },
    ]);
    // A later step of either layout lists that layout alone.
    expect(await sync.recipes.later!(SITE, "/password")).toEqual([one]);
    expect(await sync.recipes.later!(SITE, "/secret")).toEqual([two]);
  });

  it("runs no layout of a recipe generated as confirm, and routes every layout (ADR 0035, ADR 0060)", async () => {
    const first = parseLoginRecipe({ ...route("bank-signin", "/login"), pageKind: "confirm" });
    const second = parseLoginRecipe({
      ...first,
      steps: [
        { kind: "fill", path: "/login", fields: [{ slot: "username", target: target("email") }] },
        { kind: "fill", path: "/secret", fields: [{ slot: "password", target: target("secret") }] },
        { kind: "click", path: "/secret", target: target("go"), purpose: "submit" },
      ],
    });
    // Every layout of a recipe has its start page's kind.
    const layered: LoginRecipeDocument = {
      ...storedOf(first),
      layouts: [
        toLoginLayout(first, { key: "1000", createdAt: 1000 }),
        toLoginLayout(second, { key: "2000", createdAt: 2000 }),
      ],
    };
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [layered] };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    const one = { ...first, layout: "1000" };
    const two = { ...second, layout: "2000" };
    // No layout is chosen, named or started at a later step.
    expect(await sync.recipes.recipe(SITE, "/login")).toBeUndefined();
    expect(await sync.recipes.recipe(SITE, "/x", "bank-signin")).toBeUndefined();
    expect(await sync.recipes.recipe(SITE, "/x", "bank-signin", "2000")).toBeUndefined();
    expect(await sync.recipes.layouts!(SITE, "/login")).toEqual([]);
    expect(await sync.recipes.starts(SITE)).toEqual([]);
    expect(await sync.recipes.later!(SITE, "/secret")).toEqual([]);
    // Every layout is still a route of the origin, as a logout check reads them.
    expect(await sync.recipes.routes!(SITE)).toEqual([one, two]);
  });

  it("ignores a cache written before layouts (ADR 0060), so every recipe is pulled again", async () => {
    const old = {
      version: 1,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 9,
      recipes: [route("bank-signin", "/login")],
    };
    const { sync, cache, transport } = setup({
      stored: old,
      pages: [page([active(recipe("bank-signin", "/login", 2))], 3)],
    });
    expect(await sync.sync()).toBe("synced");
    expect(transport.recipeChanges.mock.calls.map(([, , cursor]) => cursor)).toEqual([0]);
    expect(cache()).toEqual({
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 3,
      recipes: [recipe("bank-signin", "/login", 2)],
    });
  });

  it("finds a chooser (ADR 0028) by its list's path or its ID, never where a login starts", async () => {
    const other = { by: "text" as const, value: "Use another profile" };
    const chooser = {
      version: 1 as const,
      id: "bank-chooser",
      revision: 1,
      origin: SITE,
      chooser: { path: "/profiles", layouts: [{ key: "1000", createdAt: 1000, other }] },
    };
    const clash = {
      ...chooser,
      id: "bank-clash",
      chooser: { path: "/login", layouts: [{ key: "1000", createdAt: 1000 }] },
    };
    const stored = {
      version: 2,
      origin: SERVICE,
      deviceId: DEVICE,
      cursor: 1,
      recipes: [recipe("bank-signin", "/login"), chooser, clash],
    };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    const runs = {
      version: 1,
      id: "bank-chooser",
      revision: 1,
      origin: SITE,
      layout: "1000",
      chooser: { path: "/profiles", other },
    };
    expect(await sync.recipes.chooser!(SITE, "/profiles")).toEqual(runs);
    expect(await sync.recipes.chooser!(SITE, "/elsewhere", "bank-chooser")).toEqual(runs);
    expect(await sync.recipes.chooser!(SITE, "/elsewhere", "bank-chooser", "1000")).toEqual(runs);
    expect(await sync.recipes.chooser!(SITE, "/elsewhere", "bank-chooser", "2000")).toBeUndefined();
    expect(await sync.recipes.choosers!(SITE, "/profiles")).toEqual([
      { recipe: runs, createdAt: 1000 },
    ]);
    expect(await sync.recipes.chooser!(SITE, "/login")).toBeUndefined();
    expect(await sync.recipes.choosers!(SITE, "/login")).toEqual([]);
    expect(await sync.recipes.chooser!("https://other.example", "/profiles")).toBeUndefined();
    // A chooser is never a login recipe, by path or by ID.
    expect(await sync.recipes.recipe(SITE, "/profiles", "bank-chooser")).toBeUndefined();
    // A chooser login resumes on its chooser, which is withdrawn only without its layout.
    expect(await sync.recipes.withdrawn!(SITE, "bank-chooser", "1000")).toBe(false);
    expect(await sync.recipes.withdrawn!(SITE, "bank-chooser", "2000")).toBe(true);
    expect(await sync.recipes.starts(SITE)).toContainEqual({
      path: "/profiles",
      steps: [],
      list: [other],
    });
  });

  it("holds a recipe's sign-in form and its list on one path as one start (#1248)", async () => {
    const verify = { by: "text" as const, value: "Verify" };
    const form = recipe("bank-signin", "/login");
    const both = {
      ...form,
      chooser: { path: "/login", layouts: [{ key: "2000", createdAt: 2000, continue: verify }] },
    };
    const stored = { version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 1, recipes: [both] };
    const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
    const list = {
      version: 1,
      id: "bank-signin",
      revision: 1,
      origin: SITE,
      layout: "2000",
      chooser: { path: "/login", continue: verify },
    };
    // The form's layouts and the list each answer their own lookup on the same path.
    expect(await sync.recipes.recipe(SITE, "/login")).toEqual(projected(form));
    expect(await sync.recipes.chooser!(SITE, "/login")).toEqual(list);
    expect(await sync.recipes.choosers!(SITE, "/login")).toEqual([
      { recipe: list, createdAt: 2000 },
    ]);
    // One start, so the path is not left out as one several recipes start on.
    expect(await sync.recipes.starts(SITE)).toEqual([
      {
        path: "/login",
        steps: [form.layouts[0]!.steps[0]],
        list: [verify],
        later: [expect.objectContaining({ path: "/password", later: true })],
      },
    ]);
    // A login resumes on its own layout of either kind, by keys unique over both.
    expect(await sync.recipes.withdrawn!(SITE, "bank-signin", "1000")).toBe(false);
    expect(await sync.recipes.withdrawn!(SITE, "bank-signin", "2000")).toBe(false);
    expect(await sync.recipes.withdrawn!(SITE, "bank-signin", "3000")).toBe(true);
    expect(await sync.recipes.chooser!(SITE, "/elsewhere", "bank-signin", "1000")).toBeUndefined();
    expect(await sync.recipes.recipe(SITE, "/elsewhere", "bank-signin", "2000")).toBeUndefined();
    expect(await sync.recipes.layoutsOf!(SITE, "bank-signin")).toEqual([projected(form)]);
  });

  it("starts a chooser (ADR 0028) also on its other branch's first step on the list's path", async () => {
    const other = { by: "text" as const, value: "Use another profile" };
    const continueButton = { by: "text" as const, value: "Continue" };
    const branch = (path: string) => routeBodyOf(route("bank-chooser", path, 2));
    const chooser = (path: string) => ({
      version: 1 as const,
      id: "bank-chooser",
      revision: 2,
      origin: SITE,
      chooser: {
        path: "/profiles",
        layouts: [
          { key: "1000", createdAt: 1000, other, afterOther: branch(path) },
          // Another layout's buttons count too (ADR 0060).
          { key: "2000", createdAt: 2000, other, continue: continueButton },
        ],
      },
    });
    for (const [path, steps] of [
      ["/profiles", [branch("/profiles").steps[0]]],
      // A branch that starts elsewhere is reached only through the click.
      ["/email", []],
    ] as const) {
      const stored = {
        version: 2,
        origin: SERVICE,
        deviceId: DEVICE,
        cursor: 1,
        recipes: [chooser(path)],
      };
      const { sync } = setup({ stored, scheduled: { version: 1, startedAt: 0, retryAt: 9e9 } });
      // eslint-disable-next-line no-await-in-loop
      expect(await sync.recipes.starts(SITE)).toEqual([
        { path: "/profiles", steps, list: [other, continueButton] },
      ]);
      // A branch's password page never starts a login by itself (ADR 0049).
      // eslint-disable-next-line no-await-in-loop
      expect(await sync.recipes.later!(SITE, "/password")).toEqual([]);
      // A chooser login's sign-in check reads its branches' markers.
      // eslint-disable-next-line no-await-in-loop
      expect(await sync.recipes.layoutsOf!(SITE, "bank-chooser")).toEqual([
        { ...route("bank-chooser", path, 2), layout: "1000" },
      ]);
    }
  });
}
