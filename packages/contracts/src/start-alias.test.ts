import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  attemptMetadataSchema,
  chooserLayouts,
  createAttemptMetadata,
  parseLoginRecipe,
  projectionOn,
  projectionStartPath,
  recipeLayouts,
  selectLoginRecipe,
  startsOnPath,
  storedLoginRecipeSchema,
  type LoginChooserDocument,
  type LoginRecipeDocument,
} from "./index";

// A site that shows its sign-in form on whatever page it guards: a recipe learned on one
// path starts on the other paths in its `starts` too, as its projection on that path (ADR
// 0060 amendment of 2026-11-18). Synthetic pages in the shape of USI's Student Portal.
const origin = "https://portal.example";
const LEARNED = "/student/Usi/Forgotten/Success";
const CODE = "/student/SecondFactor/ChooseAndVerifyOtp";
const id = (value: string) => ({ by: "id" as const, value });
const layout = (key: string) => ({
  key,
  createdAt: Number(key),
  pageKind: "sign-in" as const,
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill" as const,
      path: LEARNED,
      effect: "prepare" as const,
      fields: [
        { slot: "username", target: id("UserName") },
        { slot: "password", target: id("Password") },
      ],
    },
    {
      kind: "click" as const,
      path: LEARNED,
      target: { by: "text" as const, value: "Login" },
      purpose: "submit" as const,
    },
  ],
  alternatives: [
    {
      slots: ["email", "password"],
      steps: [
        {
          kind: "fill" as const,
          path: LEARNED,
          effect: "prepare" as const,
          fields: [
            { slot: "email", target: id("Email") },
            { slot: "password", target: id("Password") },
          ],
        },
        {
          kind: "click" as const,
          path: LEARNED,
          target: { by: "text" as const, value: "Login" },
          purpose: "submit" as const,
        },
      ],
    },
  ],
  passkey: { path: LEARNED, target: id("passkey") },
  completion: [{ target: { by: "href" as const, value: LEARNED.toLowerCase() } }],
  handlers: [
    { kind: "passkey" as const, path: LEARNED, target: id("key") },
    {
      kind: "totp" as const,
      path: CODE,
      field: id("MfaOptions_OneTimePasscode"),
      target: id("nextButton"),
    },
  ],
  maxSubmissions: 2,
});
const document = (starts?: string[], recipeId = "gen-learned", key = "1000") =>
  v.parse(storedLoginRecipeSchema, {
    version: 1,
    id: recipeId,
    revision: 2,
    origin,
    layouts: [layout(key)],
    ...(starts ? { starts } : {}),
  }) as LoginRecipeDocument;

describe("a projection on another start path of its recipe", () => {
  const projected = recipeLayouts(document(["/student"]))[0]!;

  it("moves every path that is its start path, and nothing else", () => {
    const moved = projectionOn(projected, "/student");
    expect(projectionStartPath(moved)).toBe("/student");
    expect(moved.steps.map((step) => step.path)).toEqual(["/student", "/student"]);
    expect(moved.alternatives![0]!.steps.map((step) => step.path)).toEqual([
      "/student",
      "/student",
    ]);
    expect(moved.passkey).toEqual({ path: "/student", target: id("passkey") });
    // The code page keeps its own path.
    expect(moved.handlers!.map((handler) => handler.path)).toEqual(["/student", CODE]);
    // A signed-in marker proves a sign-in on any path, a link's path among them.
    expect(moved.completion).toEqual(projected.completion);
    // Still a recipe a login runs, of the same ID, revision and layout.
    expect(parseLoginRecipe(moved)).toEqual(moved);
    expect(moved).toMatchObject({ id: "gen-learned", revision: 2, layout: "1000" });
  });

  it("is the projection itself on its own start path, and moves back", () => {
    expect(projectionOn(projected, LEARNED)).toBe(projected);
    expect(projectionOn(projectionOn(projected, "/student"), LEARNED)).toEqual(projected);
  });

  it("moves a chooser's list and the steps of its branches on the list's path", () => {
    const listed = v.parse(storedLoginRecipeSchema, {
      version: 1,
      id: "gen-list",
      revision: 1,
      origin,
      chooser: {
        path: LEARNED,
        layouts: [
          {
            key: "2000",
            createdAt: 2000,
            other: id("other"),
            afterOther: {
              pageKind: "sign-in",
              slots: ["username", "password"],
              steps: [
                {
                  kind: "fill",
                  path: LEARNED,
                  effect: "prepare",
                  fields: [{ slot: "username", target: id("UserName") }],
                },
                { kind: "click", path: LEARNED, target: id("next"), purpose: "advance" },
                {
                  kind: "fill",
                  path: "/student/password",
                  effect: "prepare",
                  fields: [{ slot: "password", target: id("Password") }],
                },
                {
                  kind: "click",
                  path: "/student/password",
                  target: id("go"),
                  purpose: "submit",
                },
              ],
              handlers: [{ kind: "totp", path: CODE, field: id("code"), target: id("verify") }],
              maxSubmissions: 2,
            },
          },
        ],
      },
      starts: ["/student"],
    }) as LoginChooserDocument;
    const chooser = chooserLayouts(listed)[0]!;
    const moved = projectionOn(chooser, "/student");
    expect(projectionStartPath(moved)).toBe("/student");
    expect(moved.chooser.path).toBe("/student");
    expect(moved.chooser.afterOther!.steps.map((step) => step.path)).toEqual([
      "/student",
      "/student",
      "/student/password",
      "/student/password",
    ]);
    expect(moved.chooser.afterOther!.handlers).toEqual(chooser.chooser.afterOther!.handlers);
    expect(moved.chooser.other).toEqual(chooser.chooser.other);
  });
});

describe("selecting the recipe a new login starts on another start path", () => {
  it("offers the recipe's layouts on that path", () => {
    const stored = document(["/student"]);
    expect(startsOnPath(stored, "/student")).toBe(true);
    expect(startsOnPath(stored, LEARNED)).toBe(true);
    expect(startsOnPath(stored, "/other")).toBe(false);
    const selection = selectLoginRecipe([stored], origin, "/student");
    if (!selection.ok) throw new Error(selection.reason);
    expect(selection.recipe.steps.map((step) => step.path)).toEqual(["/student", "/student"]);
    expect(selection.layouts.map((entry) => projectionStartPath(entry.recipe))).toEqual([
      "/student",
    ]);
    // On its own start path it is offered as it is stored.
    const own = selectLoginRecipe([stored], origin, LEARNED);
    expect(own).toMatchObject({ ok: true, recipe: recipeLayouts(stored)[0] });
  });

  it("starts nothing where another recipe starts too (ADR 0013)", () => {
    const {
      alternatives: _alternatives,
      passkey: _passkey,
      handlers: _handlers,
      ...plain
    } = layout("3000");
    // A second recipe generated on the path, as USI's on `/student`.
    const stray = v.parse(storedLoginRecipeSchema, {
      version: 1,
      id: "gen-stray",
      revision: 1,
      origin,
      layouts: [{ ...plain, steps: plain.steps.map((step) => ({ ...step, path: "/student" })) }],
    });
    expect(selectLoginRecipe([document(["/student"]), stray], origin, "/student")).toEqual({
      ok: false,
      reason: "recipe-ambiguous",
    });
    // Without `starts`, each starts on its own path alone, as before.
    expect(selectLoginRecipe([document(), stray], origin, "/student")).toMatchObject({
      ok: true,
      recipe: { id: "gen-stray" },
    });
    expect(selectLoginRecipe([document()], origin, "/student")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });
});

describe("a login's record of the other start path it started on", () => {
  const recipe = projectionOn(recipeLayouts(document(["/student"]))[0]!, "/student");
  const created = createAttemptMetadata({
    id: "attempt-1",
    recipe,
    policyRevision: 1,
    account: { origin, connectionId: "connection-1", itemId: "item-1" },
    choice: { route: "password", variant: 0 },
    facts: { password: true, totp: true, passkey: false, discoverablePasskey: false },
    document: { tabId: 1, frameId: 0, documentId: "document-1", origin },
    timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
  });

  it("keeps an exact path, and none on the recipe's own start path", () => {
    expect(created.start).toBeUndefined();
    expect(v.parse(attemptMetadataSchema, { ...created, start: "/student" })).toMatchObject({
      start: "/student",
    });
    for (const start of ["student", "/student?x=1", "//student", ""])
      expect(v.safeParse(attemptMetadataSchema, { ...created, start }).success).toBe(false);
  });
});
