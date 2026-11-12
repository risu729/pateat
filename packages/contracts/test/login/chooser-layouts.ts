import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  chooserBranch,
  chooserClickBranch,
  chooserRoute,
  CHOOSER_ENTRY_TARGET,
  continuesRecipe,
  extendsRecipe,
  isLoginRouteRecipe,
  loginChooserRecipeSchema,
  recipeHasRoute,
  storedLoginRecipeSchema,
  storedRecipeSlots,
  storedRecipeStartPath,
  withChooserBranch,
  loginRecipeSchema,
  type ChooserClick,
  type LoginRecipe,
  type LoginTarget,
  findChooserLayout,
  findLayoutRecipe,
  isLoginRecipeDocument,
  layoutRecipe,
  loginChooserDocumentSchema,
  loginRecipeDocumentSchema,
  MAX_RECIPE_DOCUMENT_BYTES,
  MAX_RECIPE_LAYOUTS,
  newestLayout,
  newLayoutKey,
  parseRecipeBranch,
  recipeBranch,
  recipeLayouts,
  routeBodyOf,
  storedBranchRoute,
  storedLayouts,
  toChooserLayout,
  toLoginLayout,
  withChooserLayout,
  withLoginLayout,
  withoutLayout,
  chooserLayouts,
  storedLayoutRecipe,
} from "../../src/login";
import type { LoginTestContext } from "./context";

export function registerChooserRecipes({
  recipe,
  document,
}: Pick<LoginTestContext, "recipe" | "document">): void {
  describe("chooser recipes (ADR 0028)", () => {
    const chooser = (extra: Record<string, unknown> = {}) => ({
      version: 1,
      id: recipe().id,
      revision: recipe().revision,
      origin: recipe().origin,
      chooser: {
        path: "/login",
        other: { by: "text", value: "Sign in with another profile" },
        ...extra,
      },
    });

    /** The chooser stored with one layout of the same buttons and branches (ADR 0060). */
    const storedChooser = (extra: Record<string, unknown> = {}) => {
      const { path, ...layout } = chooser(extra).chooser as Record<string, unknown>;
      return {
        ...chooser(),
        chooser: { path, layouts: [{ key: "1000", createdAt: 1000, ...layout }] },
      };
    };
    const body = () => routeBodyOf(recipe());

    it("stores a chooser without branches, told apart from a login route recipe", () => {
      const parsed = v.parse(storedLoginRecipeSchema, storedChooser());
      expect(parsed).toEqual(storedChooser());
      expect(v.is(loginChooserDocumentSchema, storedChooser())).toBe(true);
      expect(isLoginRecipeDocument(parsed)).toBe(false);
      expect(storedRecipeStartPath(parsed)).toBe("/login");
      expect(v.is(loginChooserRecipeSchema, chooser())).toBe(true);
      expect(isLoginRouteRecipe(v.parse(loginChooserRecipeSchema, chooser()))).toBe(false);
      expect(v.is(loginRecipeSchema, chooser())).toBe(false);
      // The chooser a login runs is never stored as it is.
      expect(v.is(storedLoginRecipeSchema, chooser())).toBe(false);
      expect(
        v.is(storedLoginRecipeSchema, {
          ...chooser(),
          chooser: { path: "/login", layouts: [{ key: "1000", createdAt: 1000 }] },
        }),
      ).toBe(true);
    });

    it("holds each branch as a route under the chooser's ID, revision and origin", () => {
      expect(
        v.is(storedLoginRecipeSchema, storedChooser({ afterAccount: body(), afterOther: body() })),
      ).toBe(true);
      // A stored branch is the route alone; the document carries its ID and revision.
      expect(v.is(storedLoginRecipeSchema, storedChooser({ afterAccount: recipe() }))).toBe(false);
      expect(v.is(storedLoginRecipeSchema, storedChooser({ afterAccount: { steps: [] } }))).toBe(
        false,
      );
      // The projection's branches have the chooser's ID, revision, origin and layout.
      const branch = recipe();
      expect(
        v.is(loginChooserRecipeSchema, chooser({ afterAccount: branch, afterOther: branch })),
      ).toBe(true);
      for (const changed of [
        { id: "other-01" },
        { revision: branch.revision + 1 },
        { origin: "https://other.example.test" },
        { layout: "1000" },
      ])
        expect(
          v.is(loginChooserRecipeSchema, chooser({ afterAccount: { ...branch, ...changed } })),
        ).toBe(false);
    });

    it("names its buttons by a non-input locator, never the same one twice", () => {
      const shown = { by: "text", value: "Log back in" };
      expect(v.is(storedLoginRecipeSchema, storedChooser({ continue: shown }))).toBe(true);
      expect(
        v.is(storedLoginRecipeSchema, storedChooser({ continue: chooser().chooser.other })),
      ).toBe(false);
      expect(
        v.is(
          storedLoginRecipeSchema,
          storedChooser({ other: { by: "autocomplete", value: "username" } }),
        ),
      ).toBe(false);
      // The other-account branch needs its button.
      const withoutOther = storedChooser({ afterOther: body() });
      delete (withoutOther.chooser.layouts[0] as Record<string, unknown>)["other"];
      expect(v.is(storedLoginRecipeSchema, withoutOther)).toBe(false);
    });

    it("never holds a chooser beside a login route member or an entry", () => {
      const { slots, steps } = recipe();
      expect(v.is(storedLoginRecipeSchema, { ...storedChooser(), slots, steps })).toBe(false);
      expect(
        v.is(storedLoginRecipeSchema, { ...storedChooser(), layouts: document().layouts }),
      ).toBe(false);
      expect(
        v.is(storedLoginRecipeSchema, {
          ...storedChooser(),
          entry: { path: "/", target: { by: "text", value: "Login" } },
        }),
      ).toBe(false);
      expect(
        v.is(storedLoginRecipeSchema, { ...document(), chooser: storedChooser().chooser }),
      ).toBe(false);
    });

    it("reads and replaces a branch, moving the other one to the new revision", () => {
      const stored = v.parse(loginChooserRecipeSchema, chooser());
      expect(chooserBranch(stored, "account")).toBeUndefined();
      const account = { ...recipe(), revision: recipe().revision + 1 };
      const first = withChooserBranch(stored, "account", account);
      expect(first).toEqual({
        ...stored,
        revision: account.revision,
        chooser: { ...stored.chooser, afterAccount: account },
      });
      expect(v.is(loginChooserRecipeSchema, first)).toBe(true);
      const other = {
        ...recipe(),
        revision: account.revision + 1,
        slots: [...recipe().slots, "pin"],
      };
      const both = withChooserBranch(first, "other", { ...other, steps: [...other.steps] });
      expect(both.revision).toBe(other.revision);
      expect(chooserBranch(both, "account")).toEqual({ ...account, revision: other.revision });
      expect(chooserBranch(both, "other")?.revision).toBe(other.revision);
      expect(v.is(loginChooserRecipeSchema, both)).toBe(true);
      // A stored chooser's slots are its branches' together; a recipe's are its layouts'.
      const kept = v.parse(loginChooserDocumentSchema, {
        ...chooser(),
        revision: both.revision,
        chooser: { path: "/login", layouts: [toChooserLayout(both, { key: "1", createdAt: 1 })] },
      });
      expect(storedRecipeSlots(kept)).toEqual(["branch", "account", "password", "pin"]);
      expect(storedRecipeSlots(v.parse(loginChooserDocumentSchema, storedChooser()))).toEqual([]);
    });

    it("runs a click on the list, then the steps of the branch it leads to", () => {
      const stored = v.parse(loginChooserRecipeSchema, chooser());
      // Without a branch yet, the login clicks and continues on the next page.
      expect(chooserRoute(stored, "entry")).toEqual({
        version: 1,
        id: stored.id,
        revision: stored.revision,
        origin: stored.origin,
        pageKind: "sign-in",
        slots: ["username"],
        steps: [
          { kind: "click", path: "/login", target: CHOOSER_ENTRY_TARGET, purpose: "advance" },
        ],
        maxSubmissions: 1,
      });
      expect(chooserRoute(stored, "other")?.steps[0]).toMatchObject({
        target: stored.chooser.other,
      });
      // No button, no route.
      expect(chooserRoute(stored, "continue")).toBeUndefined();
      const { alternatives: _alternatives, ...branch } = {
        ...recipe(),
        passkey: undefined,
        alternatives: undefined,
      };
      const both = withChooserBranch(stored, "account", { ...branch, revision: 2 });
      const route = chooserRoute(both, "entry");
      expect(route).toMatchObject({
        revision: 2,
        slots: ["username", "branch", "account", "password"],
        completion: recipe().completion,
        rejection: recipe().rejection,
        maxSubmissions: recipe().maxSubmissions + 1,
      });
      expect(route?.steps).toEqual([
        { kind: "click", path: "/login", target: CHOOSER_ENTRY_TARGET, purpose: "advance" },
        ...recipe().steps,
      ]);
      expect(v.is(loginRecipeSchema, route)).toBe(true);
      // The other branch is still absent: its route is the click alone.
      expect(chooserRoute(both, "other")?.steps).toHaveLength(1);
      expect(chooserRoute(both, "other-shown")).toBeUndefined();
    });

    it("runs the other branch alone when its form shows on the list's path", () => {
      const stored = v.parse(loginChooserRecipeSchema, chooser());
      const onList = {
        ...recipe(),
        steps: recipe().steps.map((step) => ({ ...step, path: "/login" })),
      };
      const { alternatives: _alternatives, passkey: _passkey, ...branch } = onList;
      const shown = withChooserBranch(stored, "other", { ...onList, revision: 2 });
      expect(chooserClickBranch("other-shown")).toBe("other");
      // No click: the branch's own steps, slots and submissions, without its passkey route
      // or alternatives, under the chooser's ID and revision.
      expect(chooserRoute(shown, "other-shown")).toEqual({ ...branch, revision: 2 });
      // A branch that starts on another path never shows on the list's.
      const elsewhere = withChooserBranch(stored, "other", {
        ...onList,
        steps: [{ ...onList.steps[0]!, path: "/email" }, ...onList.steps.slice(1)],
        revision: 2,
      });
      expect(chooserRoute(elsewhere, "other-shown")).toBeUndefined();
    });

    it("never holds a branch whose route with the click on the list is no recipe", () => {
      const base = v.parse(
        loginChooserRecipeSchema,
        chooser({ continue: { by: "text", value: "Log back in" } }),
      );
      const clickStep = (index: number, purpose: "advance" | "submit" = "advance") => ({
        kind: "click" as const,
        path: `/page-${index}`,
        target: { by: "id" as const, value: `next-${index}` },
        purpose,
      });
      const password = (index: number) => ({
        kind: "fill" as const,
        effect: "prepare" as const,
        path: `/page-${index}`,
        fields: [{ slot: "password", target: { by: "id" as const, value: "password" } }],
      });
      const branch = (steps: LoginRecipe["steps"], maxSubmissions: number, extra = {}) => ({
        ...recipe(),
        slots: ["password"],
        steps,
        maxSubmissions,
        ...extra,
      });
      // As many effects as a recipe may have: the click on the list adds one more.
      const effects = (count: number) =>
        branch(
          [
            password(0),
            ...Array.from({ length: count }, (_, index) =>
              clickStep(index, index === count - 1 ? "submit" : "advance"),
            ),
          ],
          count,
        );
      // As many steps as a recipe may have: the click on the list adds one more.
      const steps = (count: number) =>
        branch(
          [
            ...Array.from({ length: count - 1 }, (_, index) => password(index)),
            clickStep(count - 1, "submit"),
          ],
          1,
        );
      // A marker on the button the login clicks on the list would prove the sign-in there.
      const marked = (target: LoginTarget) =>
        branch([password(0), clickStep(0, "submit")], 1, {
          completion: [{ target }],
        });
      const cases: [ChooserClick, ReturnType<typeof branch>][] = [
        ["entry", effects(8)],
        ["other", effects(8)],
        ["entry", steps(32)],
        ["other", steps(32)],
        ["entry", marked(CHOOSER_ENTRY_TARGET)],
        ["continue", marked(base.chooser.continue!)],
        ["other", marked(base.chooser.other!)],
      ];
      for (const [click, invalid] of cases) {
        expect(v.is(loginRecipeSchema, invalid)).toBe(true);
        const held = withChooserBranch(base, chooserClickBranch(click), invalid);
        expect(chooserRoute(held, click)).toBeUndefined();
        expect
          .soft(
            v.is(loginChooserRecipeSchema, held),
            `${click} after ${invalid.steps.length} steps`,
          )
          .toBe(false);
        // The stored chooser holds the same branch in its layout (ADR 0060).
        const stored = {
          ...chooser(),
          chooser: { path: "/login", layouts: [toChooserLayout(held, { key: "1", createdAt: 1 })] },
        };
        expect.soft(v.is(loginChooserDocumentSchema, stored)).toBe(false);
        expect.soft(v.is(storedLoginRecipeSchema, stored)).toBe(false);
        // A second layout that runs does not make the stored chooser hold the first.
        const valid = {
          ...stored,
          chooser: {
            path: "/login",
            layouts: [toChooserLayout(base, { key: "2", createdAt: 2 }), ...stored.chooser.layouts],
          },
        };
        expect.soft(v.is(storedLoginRecipeSchema, valid)).toBe(false);
      }
      // One effect or step fewer runs with the click.
      for (const member of ["account", "other"] as const)
        for (const valid of [effects(7), steps(31), marked({ by: "id", value: "signed-in" })]) {
          const held = withChooserBranch(base, member, valid);
          expect(v.is(loginChooserRecipeSchema, held)).toBe(true);
          expect(chooserRoute(held, member === "account" ? "entry" : "other")).toBeDefined();
          expect(
            v.is(storedLoginRecipeSchema, {
              ...chooser(),
              chooser: {
                path: "/login",
                layouts: [toChooserLayout(held, { key: "1", createdAt: 1 })],
              },
            }),
          ).toBe(true);
        }
    });
  });
}

export function registerChooserPasskey({ recipe }: Pick<LoginTestContext, "recipe">): void {
  describe("a passkey button beside a chooser's list (ADR 0079)", () => {
    const button = { by: "id", value: "passkey-login" } as const;
    /** The passkey-only route (ADR 0053) on `path`, as a chooser layout stores it. */
    const passkeyRoute = (path = "/login", target: LoginTarget = button) => ({
      pageKind: "sign-in" as const,
      slots: [],
      passkeyOnly: true as const,
      passkey: { path, target },
      steps: [{ kind: "click" as const, path, target, purpose: "submit" as const }],
      maxSubmissions: 1,
    });
    const stored = (passkey: unknown) => ({
      version: 1,
      id: recipe().id,
      revision: recipe().revision,
      origin: recipe().origin,
      chooser: {
        path: "/login",
        layouts: [
          {
            key: "1000",
            createdAt: 1000,
            other: { by: "text", value: "Use another account" },
            passkey,
          },
        ],
      },
    });

    it("holds a passkey-only route on the list's path, and nothing else as one", () => {
      expect(v.is(storedLoginRecipeSchema, stored(passkeyRoute()))).toBe(true);
      // Another path, a route that fills, and a passkey route of a password form are refused.
      expect(v.is(storedLoginRecipeSchema, stored(passkeyRoute("/elsewhere")))).toBe(false);
      expect(v.is(storedLoginRecipeSchema, stored(routeBodyOf(recipe())))).toBe(false);
      expect(
        v.is(
          storedLoginRecipeSchema,
          stored({ ...routeBodyOf(recipe()), passkey: passkeyRoute().passkey }),
        ),
      ).toBe(false);
      // Nor a route that is no sign-in, or presses the list's own button.
      expect(
        v.is(storedLoginRecipeSchema, stored({ ...passkeyRoute(), pageKind: "confirm" })),
      ).toBe(false);
      expect(
        v.is(
          storedLoginRecipeSchema,
          stored(passkeyRoute("/login", { by: "text", value: "Use another account" })),
        ),
      ).toBe(false);
    });

    it("runs the button as its own route, and keeps it when a branch is written", () => {
      const held = v.parse(storedLoginRecipeSchema, stored(passkeyRoute()));
      if (!("chooser" in held) || !held.chooser || !("layouts" in held.chooser))
        throw new Error("chooser");
      const [first] = chooserLayouts(held);
      const route = chooserRoute(first!, "passkey");
      expect(route).toEqual({
        version: 1,
        id: held.id,
        revision: held.revision,
        origin: held.origin,
        layout: "1000",
        ...passkeyRoute(),
      });
      expect(chooserClickBranch("passkey")).toBe("passkey");
      expect(recipeHasRoute(route!, "password")).toBe(false);
      // Writing the account branch moves the passkey route to the new revision unchanged.
      const account = { ...recipe(), layout: "1000", revision: first!.revision + 1 };
      const next = withChooserBranch(first!, "account", account);
      expect(chooserBranch(next, "passkey")).toEqual({ ...route, revision: account.revision });
      expect(v.is(loginChooserRecipeSchema, next)).toBe(true);
      // And a passkey route written as a branch keeps the account branch.
      const pressed = withChooserBranch(next, "passkey", {
        ...route!,
        revision: account.revision + 1,
        completion: [{ target: { by: "id", value: "signed-in" } }],
      });
      expect(chooserBranch(pressed, "account")?.revision).toBe(account.revision + 1);
      expect(toChooserLayout(pressed, { key: "1000", createdAt: 1000 }).passkey).toMatchObject({
        passkeyOnly: true,
        completion: [{ target: { by: "id", value: "signed-in" } }],
      });
      // Without the button, no route answers the click.
      const plain = v.parse(loginChooserRecipeSchema, {
        ...first!,
        chooser: { ...first!.chooser, passkey: undefined },
      });
      expect(chooserRoute(plain, "passkey")).toBeUndefined();
    });
  });
}

export function registerRecipeLayouts({
  recipe,
  document,
}: Pick<LoginTestContext, "recipe" | "document">): void {
  describe("recipe layouts (ADR 0060)", () => {
    const second = (change: Partial<LoginRecipe> = {}) =>
      toLoginLayout(
        {
          ...recipe(),
          steps: [
            ...recipe().steps.slice(0, 2),
            {
              kind: "fill",
              effect: "prepare",
              path: "/secret",
              fields: [{ slot: "password", target: { by: "name", value: "secret" } }],
            },
            {
              kind: "click",
              path: "/secret",
              target: { by: "text", value: "Log in" },
              purpose: "submit",
            },
          ],
          completion: [{ target: { by: "id", value: "dashboard" } }],
          ...change,
        },
        { key: "2000", createdAt: 2000 },
      );

    it("stores up to three layouts with distinct keys, all on the recipe's start path", () => {
      const one = document();
      expect(v.is(loginRecipeDocumentSchema, one)).toBe(true);
      const two = { ...one, layouts: [...one.layouts, second()] };
      expect(v.is(storedLoginRecipeSchema, two)).toBe(true);
      const three = {
        ...one,
        layouts: [...two.layouts, { ...second(), key: "3000", createdAt: 3000 }],
      };
      expect(three.layouts).toHaveLength(MAX_RECIPE_LAYOUTS);
      expect(v.is(storedLoginRecipeSchema, three)).toBe(true);
      const four = {
        ...one,
        layouts: [...three.layouts, { ...second(), key: "4000", createdAt: 4000 }],
      };
      expect(v.is(storedLoginRecipeSchema, four)).toBe(false);
      expect(v.is(storedLoginRecipeSchema, { ...one, layouts: [] })).toBe(false);
      // Keys are unique.
      expect(
        v.is(storedLoginRecipeSchema, {
          ...one,
          layouts: [...one.layouts, { ...second(), key: "1000" }],
        }),
      ).toBe(false);
      // Every layout starts on the recipe's start path.
      const elsewhere = toLoginLayout(
        {
          ...recipe(),
          steps: recipe().steps.map((step) => ({ ...step, path: `/other${step.path}` })),
        },
        { key: "2000", createdAt: 2000 },
      );
      expect(v.is(storedLoginRecipeSchema, { ...one, layouts: [...one.layouts, elsewhere] })).toBe(
        false,
      );
      // A key is a decimal creation time; a language is ja or en.
      for (const layout of [
        { ...second(), key: "a1" },
        { ...second(), key: "" },
        { ...second(), language: "fr" },
        { ...second(), createdAt: -1 },
      ])
        expect(v.is(storedLoginRecipeSchema, { ...one, layouts: [one.layouts[0], layout] })).toBe(
          false,
        );
    });

    it("keeps one page kind, and slots one binding holds, over every layout", () => {
      const one = document();
      // All layouts share the start page, so they share its kind (ADR 0035).
      expect(
        v.is(storedLoginRecipeSchema, {
          ...one,
          layouts: [...one.layouts, second({ pageKind: "confirm" })],
        }),
      ).toBe(false);
      expect(
        v.is(storedLoginRecipeSchema, {
          ...one,
          layouts: [{ ...one.layouts[0]!, pageKind: "confirm" }, second({ pageKind: "confirm" })],
        }),
      ).toBe(true);
      // A binding is kept per recipe and holds at most 20 slots, so the layouts' slots
      // together fit one.
      const filling = (names: string[], key: string) =>
        toLoginLayout(
          {
            ...recipe(),
            slots: names,
            steps: [
              {
                kind: "fill",
                effect: "prepare",
                path: "/identity",
                fields: names.map((name) => ({ slot: name, target: { by: "id", value: name } })),
              },
              {
                kind: "click",
                path: "/identity",
                target: { by: "id", value: "next" },
                purpose: "submit",
              },
            ],
            completion: undefined,
            rejection: undefined,
            maxSubmissions: 1,
          },
          { key, createdAt: Number(key) },
        );
      const names = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
      const fits = (left: number, right: number) =>
        v.is(storedLoginRecipeSchema, {
          ...one,
          layouts: [filling(names("a", left), "1000"), filling(names("b", right), "2000")],
        });
      expect(fits(10, 10)).toBe(true);
      expect(fits(10, 11)).toBe(false);
      // A slot both layouts fill counts once.
      expect(
        v.is(storedLoginRecipeSchema, {
          ...one,
          layouts: [filling(names("a", 20), "1000"), filling(names("a", 20), "2000")],
        }),
      ).toBe(true);
    });

    it("keeps a document small enough for a device to write back", () => {
      // A start path and text targets at their longest, on every step of every variant.
      const start = `/${"a".repeat(299)}`;
      const text = (value: string) => ({ by: "text" as const, value: value.padEnd(120, "x") });
      const variant = (name: string) => ({
        slots: [name],
        steps: [
          {
            kind: "fill" as const,
            effect: "prepare" as const,
            path: start,
            fields: [{ slot: name, target: { by: "id" as const, value: name } }],
          },
          ...Array.from({ length: 30 }, (_, index) => ({
            kind: "assert" as const,
            path: start,
            target: text(`${name}-${index}`),
            present: true,
          })),
          {
            kind: "click" as const,
            path: start,
            target: text(`${name}-go`),
            purpose: "submit" as const,
          },
        ],
      });
      const layout = (key: string) => {
        const [first, ...alternatives] = ["a", "b", "c", "d"].map((name) =>
          variant(`${key}${name}`),
        );
        return toLoginLayout(
          {
            ...recipe(),
            ...first!,
            alternatives,
            completion: undefined,
            rejection: undefined,
            maxSubmissions: 1,
          },
          { key, createdAt: Number(key) },
        );
      };
      const sized = (keys: string[]) => ({ ...document(), layouts: keys.map(layout) });
      expect(v.is(storedLoginRecipeSchema, sized(["1000"]))).toBe(true);
      const large = sized(["1000", "2000", "3000"]);
      expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(
        MAX_RECIPE_DOCUMENT_BYTES,
      );
      expect(
        v.safeParse(storedLoginRecipeSchema, large).issues?.map((issue) => issue.message),
      ).toContain("Recipe document too large");
    });

    it("checks each layout's route by the rules of a recipe a login runs", () => {
      const one = document();
      const layout = one.layouts[0]!;
      // A route that fills an undeclared slot is refused, as it is for the recipe a login runs.
      const broken = { ...layout, slots: ["branch", "account"] };
      expect(v.is(loginRecipeSchema, { ...recipe(), slots: broken.slots })).toBe(false);
      expect(v.is(storedLoginRecipeSchema, { ...one, layouts: [broken] })).toBe(false);
      // A layout's marker never names the recipe's own origin.
      const own = {
        ...layout,
        completion: [{ origin: one.origin, target: { by: "id", value: "authenticated" } }],
      };
      expect(v.is(storedLoginRecipeSchema, { ...one, layouts: [own] })).toBe(false);
      expect(v.is(loginRecipeSchema, { ...recipe(), completion: own.completion })).toBe(false);
    });

    it("runs one layout as a recipe under the document's ID, revision and origin", () => {
      const two = v.parse(loginRecipeDocumentSchema, {
        ...document(),
        revision: 4,
        layouts: [...document().layouts, second()],
      });
      const [first, other] = recipeLayouts(two);
      expect(first).toEqual({ ...recipe(), revision: 4, layout: "1000" });
      expect(v.is(loginRecipeSchema, first)).toBe(true);
      // Only the layout's own markers come with it.
      expect(other?.completion).toEqual([{ target: { by: "id", value: "dashboard" } }]);
      expect(other?.layout).toBe("2000");
      expect(findLayoutRecipe(two, "2000")).toEqual(other);
      expect(findLayoutRecipe(two, "3000")).toBeUndefined();
      expect(storedLayoutRecipe(two)).toEqual(other);
      expect(storedLayoutRecipe(two, "1000")).toEqual(first);
      expect(layoutRecipe(two, two.layouts[0]!)).toEqual(first);
      expect(routeBodyOf(first!)).not.toHaveProperty("layout");
      expect(storedLayouts(two)).toEqual([
        { key: "1000", language: "en", createdAt: 1000 },
        { key: "2000", createdAt: 2000 },
      ]);
      expect(newestLayout(two.layouts)?.key).toBe("2000");
      expect(newestLayout([])).toBeUndefined();
      expect(storedRecipeSlots(two)).toEqual(["branch", "account", "password"]);
    });

    it("writes a layout back in place, or after the others when it is new", () => {
      const one = document();
      const changed = { ...recipe(), layout: "1000", maxSubmissions: 3 };
      const replaced = withLoginLayout(
        one,
        toLoginLayout(changed, { key: "1000", language: "en", createdAt: 1000 }),
      );
      expect(replaced.layouts).toHaveLength(1);
      expect(findLayoutRecipe(replaced, "1000")).toEqual(changed);
      const added = withLoginLayout(one, second());
      expect(added.layouts.map((layout) => layout.key)).toEqual(["1000", "2000"]);
      expect(v.is(loginRecipeDocumentSchema, added)).toBe(true);
      // The schema refuses a fourth layout: replacing one is repair's to decide.
      let full = added;
      for (const key of ["3000", "4000"])
        full = withLoginLayout(full, { ...second(), key, createdAt: Number(key) });
      expect(v.is(loginRecipeDocumentSchema, full)).toBe(false);
      // A layout of another page kind replaces every layout: the start page is now that kind.
      const confirm = second({ pageKind: "confirm" });
      expect(withLoginLayout(added, confirm)).toEqual({ ...added, layouts: [confirm] });
    });

    it("removes a layout as the next revision, never the last one", () => {
      const two = { ...document(), layouts: [...document().layouts, second()] };
      expect(withoutLayout(two, "1000")).toEqual({ ...two, revision: 2, layouts: [second()] });
      expect(withoutLayout(two, "3000")).toBeUndefined();
      expect(withoutLayout(document(), "1000")).toBeUndefined();
      const entry = {
        version: 1 as const,
        id: "entry-01",
        revision: 1,
        origin: "https://bank.example",
        entry: { path: "/", target: { by: "text" as const, value: "Login" } },
      };
      expect(withoutLayout(entry, "1000")).toBeUndefined();
      expect(storedLayouts(entry)).toEqual([]);
    });

    it("keys a new layout by its creation time, moved on while another holds it", () => {
      expect(newLayoutKey(1760000000000, [])).toBe("1760000000000");
      expect(newLayoutKey(1000.7, ["1000", "1001"])).toBe("1002");
      expect(newLayoutKey(-5, [])).toBe("0");
    });

    it("names a layout's route, and a chooser layout's branch, by one branch name", () => {
      expect(recipeBranch("1000")).toBe("1000");
      expect(recipeBranch("1000", "account")).toBe("1000:account");
      expect(parseRecipeBranch("1000")).toEqual({ layout: "1000" });
      expect(parseRecipeBranch("1000:other")).toEqual({ layout: "1000", branch: "other" });
      expect(parseRecipeBranch("1000:passkey")).toEqual({ layout: "1000", branch: "passkey" });
      for (const value of ["", "account", "1000:", "1000:both", "x1000"])
        expect(parseRecipeBranch(value)).toBeUndefined();
      const two = { ...document(), layouts: [...document().layouts, second()] };
      expect(storedBranchRoute(two, "2000")?.route?.layout).toBe("2000");
      expect(storedBranchRoute(two, "3000")).toBeUndefined();
      expect(storedBranchRoute(two, "1000:account")).toBeUndefined();
    });

    it("runs one chooser layout with its branches under its key", () => {
      const base = {
        version: 1 as const,
        id: recipe().id,
        revision: 3,
        origin: recipe().origin,
      };
      const stored = v.parse(loginChooserDocumentSchema, {
        ...base,
        chooser: {
          path: "/login",
          layouts: [
            { key: "1000", createdAt: 1000, other: { by: "text", value: "Another" } },
            {
              key: "2000",
              language: "ja",
              createdAt: 2000,
              other: { by: "text", value: "別のアカウント" },
              afterAccount: routeBodyOf(recipe()),
            },
          ],
        },
      });
      const [first, other] = chooserLayouts(stored);
      expect(first).toEqual({
        ...base,
        layout: "1000",
        chooser: { path: "/login", other: { by: "text", value: "Another" } },
      });
      expect(other?.chooser.afterAccount).toEqual({ ...recipe(), revision: 3, layout: "2000" });
      expect(v.is(loginChooserRecipeSchema, other)).toBe(true);
      expect(findChooserLayout(stored, "2000")).toEqual(other);
      expect(storedLayoutRecipe(stored)).toEqual(other);
      expect(storedLayoutRecipe(stored, "1000")).toEqual(first);
      expect(storedLayoutRecipe(stored, "3000")).toBeUndefined();
      expect(chooserRoute(other!, "entry")?.layout).toBe("2000");
      expect(storedBranchRoute(stored, "2000:account")?.route).toEqual(other?.chooser.afterAccount);
      expect(storedBranchRoute(stored, "1000:other")).toEqual({ route: undefined, chooser: first });
      expect(storedBranchRoute(stored, "2000")).toBeUndefined();
      // A branch written back lands in its layout only.
      const next = withChooserBranch(first!, "other", { ...recipe(), revision: 4, layout: "1000" });
      const written = withChooserLayout(
        { ...stored, revision: 4 },
        toChooserLayout(next, { key: "1000", createdAt: 1000 }),
      );
      expect(v.is(loginChooserDocumentSchema, written)).toBe(true);
      expect(findChooserLayout(written, "1000")?.chooser.afterOther).toEqual({
        ...recipe(),
        revision: 4,
        layout: "1000",
      });
      expect(findChooserLayout(written, "2000")?.chooser.afterAccount?.revision).toBe(4);
      expect(withoutLayout(written, "1000")).toMatchObject({
        revision: 5,
        chooser: { layouts: [{ key: "2000" }] },
      });
    });

    it("never extends or continues a recipe from another layout", () => {
      const first = { ...recipe(), layout: "1000" };
      expect(extendsRecipe(first, { ...first, revision: 2 })).toBe(true);
      expect(extendsRecipe(first, { ...first, revision: 2, layout: "2000" })).toBe(false);
      expect(continuesRecipe(first, { ...first, revision: 2, layout: "2000" })).toBe(false);
    });
  });
}
