import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import {
  projectionOn,
  recipeLayouts,
  storedLoginRecipeSchema,
  type LoginRecipe,
  type LoginRecipeDocument,
  type SsoRecipeDocument,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { createRecipeSync } from "./recipes";

// A site that shows its sign-in form on whatever page it guards: the recipe learned on one
// path starts on the other paths in its `starts` too, as its projection on each (ADR 0060
// amendment of 2026-11-18). Synthetic pages in the shape of USI's Student Portal.

const SERVICE = "https://pateat.example.com";
const SITE = "https://portal.example";
const DEVICE = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const LEARNED = "/student/Usi/Forgotten/Success";
const CODE = "/student/SecondFactor/ChooseAndVerifyOtp";
const id = (value: string) => ({ by: "id" as const, value });
const login = { by: "text" as const, value: "Login" };

const layout = (key: string, path = LEARNED) => ({
  key,
  language: "en" as const,
  createdAt: Number(key),
  pageKind: "sign-in" as const,
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill" as const,
      path,
      effect: "prepare" as const,
      fields: [
        { slot: "username", target: id("UserName") },
        { slot: "password", target: id("Password") },
      ],
    },
    { kind: "click" as const, path, target: login, purpose: "submit" as const },
  ],
  handlers: [
    {
      kind: "totp" as const,
      path: CODE,
      field: id("MfaOptions_OneTimePasscode"),
      target: id("nextButton"),
    },
  ],
  maxSubmissions: 2,
});
const learned = (starts?: string[], keys = ["1000"]) =>
  v.parse(storedLoginRecipeSchema, {
    version: 1,
    id: "gen-learned",
    revision: 2,
    origin: SITE,
    layouts: keys.map((key) => layout(key)),
    ...(starts ? { starts } : {}),
  }) as LoginRecipeDocument;
/** A recipe generated on `/student` itself, as the stray one there was. */
const stray = v.parse(storedLoginRecipeSchema, {
  version: 1,
  id: "gen-stray",
  revision: 1,
  origin: SITE,
  layouts: [layout("3000", "/student")],
}) as LoginRecipeDocument;

function setup(recipes: readonly StoredLoginRecipe[]) {
  const connection = {
    origin: SERVICE,
    deviceId: DEVICE,
    credential: CREDENTIAL,
    rejected: false,
    settingsSynced: true as const,
  };
  const now = Date.now();
  const sync = createRecipeSync({
    service: {
      connection: vi.fn(async () => connection),
      fence: () => () => true,
      recordSync: vi.fn(async () => undefined),
    },
    transport: { recipeChanges: vi.fn() },
    storage: {
      read: async () => ({ version: 2, origin: SERVICE, deviceId: DEVICE, cursor: 3, recipes }),
      write: async () => undefined,
      readRecovery: async () => undefined,
      writeRecovery: async () => undefined,
      clear: async () => undefined,
    },
    // The last sync was just now, so no lookup starts another.
    schedule: {
      read: async () => ({ version: 1, startedAt: now, retryAt: now + 3_600_000 }),
      write: async () => undefined,
    },
    build: "development",
  });
  return sync.recipes;
}
const paths = (recipe: LoginRecipe | undefined) => ({
  steps: recipe?.steps.map((step) => step.path),
  handlers: recipe?.handlers?.map((handler) => handler.path),
});

describe("a recipe that starts on another path (ADR 0060 amendment of 2026-11-18)", () => {
  it("starts on each of its paths, with its first steps there", async () => {
    const recipes = setup([learned(["/student"])]);
    const starts = await recipes.starts(SITE);
    expect(starts.map((start) => start.path)).toEqual([LEARNED, "/student"]);
    expect(starts.map((start) => start.steps.map((step) => step.path))).toEqual([
      [LEARNED],
      ["/student"],
    ]);
    // The form's password alone may start a login later on either path (ADR 0049).
    expect(starts.map((start) => start.later?.map((step) => step.path))).toEqual([
      [LEARNED],
      ["/student"],
    ]);
  });

  it("runs its layouts on that path, with the code page's handler on its own", async () => {
    const recipes = setup([learned(["/student"], ["1000", "2000"])]);
    const recipe = await recipes.recipe(SITE, "/student");
    expect(recipe).toMatchObject({ id: "gen-learned", revision: 2, layout: "2000" });
    expect(paths(recipe)).toEqual({ steps: ["/student", "/student"], handlers: [CODE] });
    const layouts = await recipes.layouts!(SITE, "/student");
    expect(layouts.map((entry) => [entry.recipe.layout, paths(entry.recipe).steps])).toEqual([
      ["1000", ["/student", "/student"]],
      ["2000", ["/student", "/student"]],
    ]);
    // Its own start path runs as stored.
    expect(await recipes.recipe(SITE, LEARNED)).toEqual(
      recipeLayouts(learned(["/student"], ["1000", "2000"]))[1],
    );
    // A layout with a later step on the path, moved there too.
    expect((await recipes.later!(SITE, "/student")).map((entry) => paths(entry).steps)).toEqual([
      ["/student", "/student"],
      ["/student", "/student"],
    ]);
    expect(await recipes.later!(SITE, "/elsewhere")).toEqual([]);
  });

  it("resumes and fences a login on the path it recorded", async () => {
    const stored = learned(["/student"]);
    const recipes = setup([stored]);
    const own = recipeLayouts(stored)[0]!;
    const moved = projectionOn(own, "/student");
    expect(await recipes.recipe(SITE, "/", stored.id, "1000", "/student")).toEqual(moved);
    expect(await recipes.recipe(SITE, "/", stored.id, undefined, "/student")).toEqual(moved);
    // Without a recorded path it resumes on the start path, as before.
    expect(await recipes.recipe(SITE, "/", stored.id, "1000")).toEqual(own);
    // A path the recipe no longer starts on resumes nothing.
    expect(await recipes.recipe(SITE, "/", stored.id, "1000", "/gone")).toBeUndefined();
    expect(await recipes.layoutsOf!(SITE, stored.id, "/student")).toEqual([moved]);
    expect(await recipes.layoutsOf!(SITE, stored.id)).toEqual([own]);
    // The fence takes the projection's own start path.
    expect((await recipes.fence!(moved))?.()).toBe(true);
    expect((await recipes.fence!(own))?.()).toBe(true);
    expect(await recipes.fence!(projectionOn(own, "/gone"))).toBeUndefined();
    expect(await recipes.startAlias!(SITE, stored.id, "/student")).toBe(true);
    expect(await recipes.startAlias!(SITE, stored.id, LEARNED)).toBe(false);
    expect(await recipes.startAlias!(SITE, stored.id, "/gone")).toBe(false);
  });

  it("starts nothing on a path another recipe starts on too (ADR 0013)", async () => {
    const recipes = setup([learned(["/student"]), stray]);
    expect((await recipes.starts(SITE)).map((start) => start.path)).toEqual([
      LEARNED,
      "/student",
      "/student",
    ]);
    expect(await recipes.recipe(SITE, "/student")).toBeUndefined();
    expect(await recipes.layouts!(SITE, "/student")).toEqual([]);
    // The learned recipe still starts on its own path.
    expect(await recipes.recipe(SITE, LEARNED)).toMatchObject({ id: "gen-learned" });
  });

  it("starts as before without other paths", async () => {
    const recipes = setup([learned()]);
    expect((await recipes.starts(SITE)).map((start) => start.path)).toEqual([LEARNED]);
    expect(await recipes.recipe(SITE, "/student")).toBeUndefined();
    expect(await recipes.later!(SITE, "/student")).toEqual([]);
    expect(await recipes.startAlias!(SITE, "gen-learned", "/student")).toBe(false);
  });

  describe("with a list of accounts beside its form (ADR 0028)", () => {
    const listed = v.parse(storedLoginRecipeSchema, {
      ...learned(["/student"]),
      chooser: {
        path: LEARNED,
        layouts: [
          {
            key: "4000",
            createdAt: 4000,
            other: id("other"),
            afterOther: {
              pageKind: "sign-in",
              slots: ["username", "password"],
              steps: layout("4000").steps,
              maxSubmissions: 1,
            },
          },
        ],
      },
    });

    it("shows its list on that path, by path and by a login's recorded path", async () => {
      const recipes = setup([listed]);
      const chooser = await recipes.chooser!(SITE, "/student");
      expect(chooser?.chooser.path).toBe("/student");
      expect(chooser?.chooser.afterOther?.steps.map((step) => step.path)).toEqual([
        "/student",
        "/student",
      ]);
      expect(
        (await recipes.choosers!(SITE, "/student")).map((entry) => entry.recipe.chooser.path),
      ).toEqual(["/student"]);
      expect((await recipes.chooser!(SITE, "/", listed.id, "4000", "/student"))?.chooser.path).toBe(
        "/student",
      );
      expect((await recipes.chooser!(SITE, "/", listed.id, "4000"))?.chooser.path).toBe(LEARNED);
      // The form and the list are one start on each path.
      const starts = await recipes.starts(SITE);
      expect(starts.map((start) => [start.path, start.list])).toEqual([
        [LEARNED, [id("other")]],
        ["/student", [id("other")]],
      ]);
      // The `other` branch's first step is the form's own, once.
      expect(starts[1]!.steps).toEqual([{ ...layout("4000").steps[0], path: "/student" }]);
    });

    it("shows none where another recipe starts too", async () => {
      const recipes = setup([listed, stray]);
      expect(await recipes.chooser!(SITE, "/student")).toBeUndefined();
      expect(await recipes.choosers!(SITE, "/student")).toEqual([]);
    });
  });

  it("offers its SSO entries on that path, and fences them there", async () => {
    const sso = v.parse(storedLoginRecipeSchema, {
      ...learned(["/student"]),
      sso: {
        path: LEARNED,
        layouts: [
          { key: "5000", createdAt: 5000, entries: [{ label: "School", target: id("sso") }] },
        ],
      },
    }) as SsoRecipeDocument;
    const recipes = setup([sso]);
    const [here] = await recipes.sso!(SITE, "/student");
    expect(here?.sso.path).toBe("/student");
    expect((await recipes.sso!(SITE, LEARNED))[0]).toEqual(sso);
    expect((await recipes.sso!(SITE, "/student", sso.id))[0]).toEqual(here);
    expect(await recipes.sso!(SITE, "/elsewhere")).toEqual([]);
    expect((await recipes.ssoFence!(here!))?.()).toBe(true);
    expect((await recipes.ssoFence!(sso))?.()).toBe(true);
  });
});
