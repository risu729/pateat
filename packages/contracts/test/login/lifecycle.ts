import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  chooseLoginRoute,
  chooserRoute,
  heldRouteMissing,
  isLoginRouteRecipe,
  loginAutocompleteTokens,
  loginChooserRecipeSchema,
  loginEntryRecipeSchema,
  loginLogoutRecipeSchema,
  passwordStopOrMiss,
  recipeHasRoute,
  laterStartSteps,
  storedLoginRecipeSchema,
  storedRecipeSlots,
  storedRecipeStartPath,
  withChooserBranch,
  loginRecipeSchema,
  parseLoginRecipe,
  type StoredLoginRecipe,
  isLoginRecipeDocument,
} from "../../src/login";
import type { LoginTestContext } from "./context";

export function registerEntryRecipes({
  recipe,
  document,
}: Pick<LoginTestContext, "recipe" | "document">): void {
  describe("entry recipes (ADR 0031)", () => {
    const entry = () => ({
      version: 1,
      id: "entry-01",
      revision: 1,
      origin: "https://www.example.test",
      entry: { path: "/en/", target: { by: "text", value: "Login" } },
    });

    it("stores a recipe with only an entry, told apart from a login route recipe", () => {
      const stored = v.parse(storedLoginRecipeSchema, entry());
      expect(stored).toEqual(entry());
      expect(v.is(loginEntryRecipeSchema, entry())).toBe(true);
      expect(isLoginRecipeDocument(stored)).toBe(false);
      expect(storedRecipeStartPath(stored)).toBe("/en/");
      const route = v.parse(storedLoginRecipeSchema, document());
      expect(isLoginRecipeDocument(route)).toBe(true);
      expect(storedRecipeStartPath(route)).toBe("/identity");
      // A login runs only a recipe with a route.
      expect(v.is(loginRecipeSchema, entry())).toBe(false);
      expect(isLoginRouteRecipe(v.parse(loginEntryRecipeSchema, entry()))).toBe(false);
      expect(isLoginRouteRecipe(recipe())).toBe(true);
    });

    it("accepts an id, name, test-id or text locator as the entry's target", () => {
      for (const target of [
        { by: "id", value: "login-link" },
        { by: "name", value: "login" },
        { by: "test-id", value: "header-login" },
        { by: "text", value: "Sign in" },
      ])
        expect(v.is(storedLoginRecipeSchema, { ...entry(), entry: { path: "/", target } })).toBe(
          true,
        );
    });

    it("refuses an autocomplete locator, which names only an input, as the entry's target", () => {
      for (const value of loginAutocompleteTokens)
        expect(
          v.is(storedLoginRecipeSchema, {
            ...entry(),
            entry: { path: "/", target: { by: "autocomplete", value } },
          }),
        ).toBe(false);
    });

    it("treats only a recipe with layouts as a stored login route recipe", () => {
      // A later kind without layouts never passes as one.
      const { layouts: _layouts, ...rest } = document();
      const other = { ...rest, later: {} } as unknown as StoredLoginRecipe;
      expect(isLoginRecipeDocument(other)).toBe(false);
      expect(() => storedRecipeStartPath(other)).toThrow("Unknown stored recipe kind");
      // The recipe a login runs is never stored as it is.
      expect(v.is(storedLoginRecipeSchema, recipe())).toBe(false);
    });

    it("never holds an entry beside a login route member", () => {
      const { slots, steps, maxSubmissions, completion, rejection } = recipe();
      for (const extra of [
        { slots },
        { steps },
        { slots, steps, maxSubmissions },
        { maxSubmissions },
        { completion },
        { rejection },
        { accountSwitch: { by: "text", value: "Use another account" } },
        { passkey: { path: "/en/", target: { by: "text", value: "Passkey" } } },
        { handlers: [{ kind: "passkey", path: "/2fa", target: { by: "id", value: "key" } }] },
        { alternatives: [{ slots, steps }] },
        { layouts: document().layouts },
      ])
        expect(v.is(storedLoginRecipeSchema, { ...entry(), ...extra })).toBe(false);
      expect(v.is(storedLoginRecipeSchema, { ...document(), entry: entry().entry })).toBe(false);
    });

    it("refuses a recipe with neither an entry nor a route, and an incomplete entry", () => {
      const { entry: _entry, ...bare } = entry();
      expect(v.is(storedLoginRecipeSchema, bare)).toBe(false);
      expect(v.is(storedLoginRecipeSchema, { ...bare, slots: ["username"] })).toBe(false);
      for (const value of [
        { path: "/en/" },
        { target: { by: "text", value: "Login" } },
        { path: "/en/?return_to=%2F", target: { by: "text", value: "Login" } },
        { path: "https://www.example.test/", target: { by: "text", value: "Login" } },
        { path: "/en/", target: { by: "css", value: "a.login" } },
        { path: "/en/", target: { by: "text", value: " Login" } },
        { path: "/en/", target: { by: "text", value: "Login" }, href: "/login" },
      ])
        expect(v.is(storedLoginRecipeSchema, { ...entry(), entry: value })).toBe(false);
    });
  });
}

export function registerPasswordStop(): void {
  describe("the stop before a missing password (ADR 0036)", () => {
    /** The stop of `passwordStopOrMiss` alone, or undefined when the login takes no route. */
    const passwordStop = (...args: Parameters<typeof passwordStopOrMiss>) => {
      const result = passwordStopOrMiss(...args);
      return "stop" in result ? result.stop : undefined;
    };
    const id = (value: string) => ({ by: "id" as const, value });
    const fill = (slots: string[], path: string, effect?: "advance") => ({
      kind: "fill" as const,
      path,
      fields: slots.map((slot) => ({ slot, target: id(slot) })),
      ...(effect ? { effect, event: "input" as const } : {}),
    });
    const click = (value: string, path: string, purpose: "advance" | "submit") => ({
      kind: "click" as const,
      path,
      target: id(value),
      purpose,
    });
    /** An identifier-first form: the email, Next, then the password and its button. */
    const emailFirst = (change: Record<string, unknown> = {}) =>
      parseLoginRecipe({
        version: 1,
        id: "synthetic-email-first",
        revision: 1,
        origin: "https://login.example",
        pageKind: "sign-in",
        slots: ["username", "password"],
        steps: [
          fill(["username"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
        maxSubmissions: 2,
        ...change,
      });
    const route = { route: "password", variant: 0 } as const;
    const keyOnly = { password: false, passkey: true };

    it("stops at the password fill when an advance comes before it", () => {
      expect(passwordStop(emailFirst(), route, keyOnly, ["password"], ["password"])).toBe(2);
      // The input's own advance counts as the click's would.
      const typed = emailFirst({
        steps: [
          fill(["username"], "/signin", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
      });
      expect(passwordStop(typed, route, keyOnly, ["password"], ["password"])).toBe(1);
      // The first step that fills one of the slots read from the empty password.
      const confirmed = emailFirst({
        slots: ["username", "current", "password"],
        steps: [
          fill(["username"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["current"], "/password"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
      });
      expect(passwordStop(confirmed, route, keyOnly, ["current", "password"], ["current"])).toBe(2);
    });

    it("never stops for an item with a password, without a passkey or on another route", () => {
      const plain = emailFirst();
      expect(
        passwordStop(plain, route, { password: true, passkey: true }, ["password"], []),
      ).toBeUndefined();
      expect(
        passwordStop(plain, route, { password: false, passkey: false }, ["password"], ["password"]),
      ).toBeUndefined();
      const button = emailFirst({ passkey: { path: "/signin", target: id("passkey-login") } });
      expect(
        passwordStop(button, { route: "passkey" }, keyOnly, ["password"], ["password"]),
      ).toBeUndefined();
      // The binding reads no slot from the empty password: nothing to stop at.
      expect(passwordStop(plain, route, keyOnly, [], [])).toBeUndefined();
    });

    it("never stops on a single-page form or without an advance before the password", () => {
      const single = emailFirst({
        steps: [fill(["username", "password"], "/signin"), click("login", "/signin", "submit")],
        maxSubmissions: 1,
      });
      expect(passwordStop(single, route, keyOnly, ["password"], ["password"])).toBeUndefined();
      const stacked = emailFirst({
        steps: [
          fill(["username"], "/signin"),
          fill(["password"], "/signin"),
          click("login", "/signin", "submit"),
        ],
        maxSubmissions: 1,
      });
      expect(passwordStop(stacked, route, keyOnly, ["password"], ["password"])).toBeUndefined();
      const first = emailFirst({
        steps: [
          fill(["password"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["username"], "/account"),
          click("login", "/account", "submit"),
        ],
      });
      expect(passwordStop(first, route, keyOnly, ["password"], ["password"])).toBeUndefined();
    });

    it("never stops on a recipe with alternatives", () => {
      const varied = emailFirst({
        alternatives: [
          {
            slots: ["account", "password"],
            steps: [
              fill(["account"], "/signin"),
              click("next", "/signin", "advance"),
              fill(["password"], "/password"),
              click("login", "/password", "submit"),
            ],
          },
        ],
      });
      for (const variant of [0, 1])
        expect(
          passwordStop(varied, { route: "password", variant }, keyOnly, ["password"], ["password"]),
        ).toBeUndefined();
    });

    it("never stops after a step that fills another value the item lacks", () => {
      const code = emailFirst({
        slots: ["username", "totp", "password"],
        steps: [
          fill(["username", "totp"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
      });
      expect(
        passwordStop(code, route, keyOnly, ["password"], ["totp", "password"]),
      ).toBeUndefined();
      // A code the item holds is no reason to refuse.
      expect(passwordStop(code, route, keyOnly, ["password"], ["password"])).toBe(2);
      // A lacking value filled only after the stop is never reached.
      const after = emailFirst({
        slots: ["username", "password", "totp"],
        steps: [
          fill(["username"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "advance"),
          fill(["totp"], "/code"),
          click("verify", "/code", "submit"),
        ],
        maxSubmissions: 3,
      });
      expect(passwordStop(after, route, keyOnly, ["password"], ["password", "totp"])).toBe(2);
    });

    it("names the stop, or which condition failed, for the log", () => {
      const plain = emailFirst();
      expect(passwordStopOrMiss(plain, route, keyOnly, ["password"], ["password"])).toEqual({
        stop: 2,
      });
      // The item holds its password, or no usable passkey.
      for (const facts of [
        { password: true, passkey: true },
        { password: false, passkey: false },
        { password: true, passkey: false },
      ])
        expect(passwordStopOrMiss(plain, route, facts, ["password"], ["password"])).toEqual({
          miss: "no-passkey",
        });
      // The recipe has alternatives, on any variant.
      const varied = emailFirst({
        alternatives: [
          {
            slots: ["account", "password"],
            steps: [
              fill(["account"], "/signin"),
              click("next", "/signin", "advance"),
              fill(["password"], "/password"),
              click("login", "/password", "submit"),
            ],
          },
        ],
      });
      for (const variant of [0, 1])
        expect(
          passwordStopOrMiss(
            varied,
            { route: "password", variant },
            keyOnly,
            ["password"],
            ["password"],
          ),
        ).toEqual({ miss: "alternatives" });
      // The passkey route, or a route that fills none of the slots read from the password.
      const button = emailFirst({ passkey: { path: "/signin", target: id("passkey-login") } });
      expect(
        passwordStopOrMiss(button, { route: "passkey" }, keyOnly, ["password"], ["password"]),
      ).toEqual({ miss: "no-password-step" });
      expect(passwordStopOrMiss(plain, route, keyOnly, [], [])).toEqual({
        miss: "no-password-step",
      });
      expect(passwordStopOrMiss(plain, route, keyOnly, ["current"], ["current"])).toEqual({
        miss: "no-password-step",
      });
      // No advance before the password: the one-page form, a stacked form, or the password first.
      const single = emailFirst({
        steps: [fill(["username", "password"], "/signin"), click("login", "/signin", "submit")],
        maxSubmissions: 1,
      });
      expect(passwordStopOrMiss(single, route, keyOnly, ["password"], ["password"])).toEqual({
        miss: "no-advance",
      });
      const stacked = emailFirst({
        steps: [
          fill(["username"], "/signin"),
          fill(["password"], "/signin"),
          click("login", "/signin", "submit"),
        ],
        maxSubmissions: 1,
      });
      expect(passwordStopOrMiss(stacked, route, keyOnly, ["password"], ["password"])).toEqual({
        miss: "no-advance",
      });
      const first = emailFirst({
        steps: [
          fill(["password"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["username"], "/account"),
          click("login", "/account", "submit"),
        ],
      });
      expect(passwordStopOrMiss(first, route, keyOnly, ["password"], ["password"])).toEqual({
        miss: "no-advance",
      });
      // A step before the password fills another value the item lacks.
      const code = emailFirst({
        slots: ["username", "totp", "password"],
        steps: [
          fill(["username", "totp"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
      });
      expect(passwordStopOrMiss(code, route, keyOnly, ["password"], ["totp", "password"])).toEqual({
        miss: "fills-lacking",
      });
      // The first condition that fails is named: the passkey before the alternatives.
      expect(
        passwordStopOrMiss(varied, route, { password: false, passkey: false }, ["password"], []),
      ).toEqual({ miss: "no-passkey" });
    });

    it("stops just past a route that fills no password and ends with an advance", () => {
      // An identifier-first recipe whose page after the identifier is not generated yet.
      const identifier = emailFirst({
        slots: ["username"],
        steps: [fill(["username"], "/login"), click("continue", "/login", "advance")],
        maxSubmissions: 1,
      });
      // Its binding reads nothing from the empty password, or a slot no step fills.
      expect(passwordStopOrMiss(identifier, route, keyOnly, [], [])).toEqual({ stop: 2 });
      expect(passwordStopOrMiss(identifier, route, keyOnly, ["password"], ["password"])).toEqual({
        stop: 2,
      });
      expect(passwordStop(identifier, route, keyOnly, [], [])).toBe(2);
      // The input's own advance counts as the click's would.
      const typed = emailFirst({
        slots: ["username"],
        steps: [fill(["username"], "/login", "advance")],
        maxSubmissions: 1,
      });
      expect(passwordStopOrMiss(typed, route, keyOnly, [], [])).toEqual({ stop: 1 });
      // A route that ends with a submit or a plain fill has no stop.
      const submitted = emailFirst({
        slots: ["username"],
        steps: [fill(["username"], "/login"), click("continue", "/login", "submit")],
        maxSubmissions: 1,
      });
      expect(passwordStopOrMiss(submitted, route, keyOnly, [], [])).toEqual({
        miss: "no-password-step",
      });
      const filled = emailFirst({
        slots: ["username"],
        steps: [click("continue", "/login", "advance"), fill(["username"], "/next")],
        maxSubmissions: 1,
      });
      expect(passwordStopOrMiss(filled, route, keyOnly, [], [])).toEqual({
        miss: "no-password-step",
      });
      // The other conditions still hold for such a stop.
      expect(
        passwordStopOrMiss(identifier, route, { password: false, passkey: false }, [], []),
      ).toEqual({ miss: "no-passkey" });
      expect(
        passwordStopOrMiss(identifier, route, { password: true, passkey: true }, [], []),
      ).toEqual({ miss: "no-passkey" });
      const code = emailFirst({
        slots: ["username", "totp"],
        steps: [fill(["username", "totp"], "/login"), click("continue", "/login", "advance")],
        maxSubmissions: 1,
      });
      expect(passwordStopOrMiss(code, route, keyOnly, [], ["totp"])).toEqual({
        miss: "fills-lacking",
      });
      // A recipe with alternatives submits on every variant, so none ends with an advance.
      // A route with a password step still stops at that step, never past the plan.
      expect(passwordStopOrMiss(emailFirst(), route, keyOnly, ["password"], ["password"])).toEqual({
        stop: 2,
      });
    });

    it("stops on a chooser's route in or just past the branch its click leads to", () => {
      // The click on the list is the advance before the stop (owner, 2026-10-13 06:32 UTC).
      const listed = v.parse(loginChooserRecipeSchema, {
        version: 1,
        id: "synthetic-email-first",
        revision: 1,
        origin: "https://login.example",
        chooser: { path: "/accounts", other: id("other") },
      });
      // Without its branch the route is the click alone: the stop lies just past it.
      const bare = chooserRoute(listed, "entry")!;
      expect(passwordStopOrMiss(bare, route, keyOnly, [], [])).toEqual({ stop: 1 });
      // A branch that asks for the password stops at its password fill.
      const password = parseLoginRecipe({
        ...emailFirst(),
        revision: 2,
        slots: ["password"],
        steps: [fill(["password"], "/accounts"), click("login", "/accounts", "submit")],
        maxSubmissions: 1,
      });
      const account = chooserRoute(withChooserBranch(listed, "account", password), "entry")!;
      expect(passwordStopOrMiss(account, route, keyOnly, ["password"], ["password"])).toEqual({
        stop: 1,
      });
      // An identifier-only branch after another account stops just past its own advance.
      const identifier = parseLoginRecipe({
        ...emailFirst(),
        revision: 2,
        slots: ["username"],
        steps: [fill(["username"], "/accounts"), click("continue", "/accounts", "advance")],
        maxSubmissions: 1,
      });
      const other = chooserRoute(withChooserBranch(listed, "other", identifier), "other")!;
      expect(other.steps).toHaveLength(3);
      expect(passwordStopOrMiss(other, route, keyOnly, [], [])).toEqual({ stop: 3 });
      // A branch that fills a value the item lacks before the password takes no stop.
      const code = parseLoginRecipe({
        ...emailFirst(),
        revision: 2,
        slots: ["totp", "password"],
        steps: [
          fill(["totp"], "/accounts"),
          fill(["password"], "/accounts"),
          click("login", "/accounts", "submit"),
        ],
        maxSubmissions: 1,
      });
      const coded = chooserRoute(withChooserBranch(listed, "account", code), "entry")!;
      expect(passwordStopOrMiss(coded, route, keyOnly, ["password"], ["totp", "password"])).toEqual(
        {
          miss: "fills-lacking",
        },
      );
      // A branch that submits without a password has no stop.
      const submitted = parseLoginRecipe({
        ...identifier,
        steps: [fill(["username"], "/accounts"), click("continue", "/accounts", "submit")],
      });
      expect(
        passwordStopOrMiss(
          chooserRoute(withChooserBranch(listed, "other", submitted), "other")!,
          route,
          keyOnly,
          [],
          [],
        ),
      ).toEqual({ miss: "no-password-step" });
    });
  });
}

export function registerLaterStartSteps(): void {
  describe("later steps a login may start at (ADR 0049)", () => {
    const field = (slot: string, value: string) => ({ slot, target: { by: "id" as const, value } });
    const remembered = parseLoginRecipe({
      version: 1,
      id: "synthetic-later",
      revision: 1,
      origin: "https://login.example",
      pageKind: "sign-in",
      slots: ["username", "password", "totp"],
      steps: [
        { kind: "fill", path: "/signin", fields: [field("username", "email")] },
        { kind: "click", path: "/signin", target: { by: "id", value: "next" }, purpose: "advance" },
        { kind: "fill", path: "/password", fields: [field("password", "password")] },
        {
          kind: "click",
          path: "/password",
          target: { by: "id", value: "login" },
          purpose: "advance",
        },
        { kind: "fill", path: "/code", fields: [field("totp", "code")] },
        { kind: "click", path: "/code", target: { by: "id", value: "verify" }, purpose: "submit" },
      ],
      alternatives: [
        {
          slots: ["contract", "password"],
          steps: [
            { kind: "fill", path: "/signin", fields: [field("contract", "contract")] },
            {
              kind: "click",
              path: "/signin",
              target: { by: "id", value: "next" },
              purpose: "advance",
            },
            { kind: "fill", path: "/password", fields: [field("password", "password")] },
            {
              kind: "click",
              path: "/password",
              target: { by: "id", value: "login" },
              purpose: "submit",
            },
          ],
        },
      ],
      maxSubmissions: 3,
    });

    it("lists every variant's later fill steps, but not a first step or a code alone", () => {
      expect(
        laterStartSteps(remembered).map(({ variant, index, step }) => [variant, index, step.path]),
      ).toEqual([
        [0, 2, "/password"],
        [1, 2, "/password"],
      ]);
    });

    it("also lists a fill step that fills the password with an identifier, with its password alone", () => {
      const onePage = parseLoginRecipe({
        version: 1,
        id: "one-page",
        revision: 1,
        origin: "https://example.test",
        pageKind: "sign-in",
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            path: "/login",
            fields: [field("username", "username"), field("password", "password")],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "login" },
            purpose: "submit",
          },
        ],
        maxSubmissions: 1,
      });
      const starts = laterStartSteps(onePage);
      expect(starts).toMatchObject([
        { variant: 0, index: 0, step: { kind: "fill", path: "/login" }, partial: true },
      ]);
      expect(starts[0]!.step.fields).toEqual([field("password", "password")]);
      // The username input it drops must not show for it to start (ADR 0049).
      expect(starts[0]!.absent).toEqual([{ by: "id", value: "username" }]);
      // A step that fills the password alone, or an identifier alone, has no such start.
      expect(laterStartSteps(remembered).some((entry) => entry.partial)).toBe(false);
    });
  });
}

export function registerMissingRoutes({ recipe }: Pick<LoginTestContext, "recipe">): void {
  describe("the route a recipe lacks for the item (ADR 0058 A)", () => {
    const id = (value: string) => ({ by: "id" as const, value });
    const plain = () => parseLoginRecipe(recipe());
    const button = () =>
      parseLoginRecipe({
        ...recipe(),
        passkey: { path: "/identity", target: id("passkey-login") },
      });
    const facts = (password: boolean, discoverablePasskey: boolean) => ({
      password,
      discoverablePasskey,
    });

    it("names the passkey route for a discoverable passkey on a recipe without its button", () => {
      // An item with a discoverable passkey and no password, on a page the passkey scripts run on.
      expect(heldRouteMissing(plain(), facts(false, true), true)).toBe("passkey");
      // Holding a password as well does not change it: the recipe still lacks the button.
      expect(heldRouteMissing(plain(), facts(true, true), true)).toBe("passkey");
    });

    it("never counts a passkey that is not discoverable", () => {
      expect(heldRouteMissing(plain(), facts(false, false), true)).toBeUndefined();
      expect(heldRouteMissing(plain(), facts(false, false), false)).toBeUndefined();
    });

    it("names nothing for a recipe that already has the passkey button", () => {
      expect(recipeHasRoute(button(), "passkey")).toBe(true);
      expect(heldRouteMissing(button(), facts(false, true), true)).toBeUndefined();
      expect(heldRouteMissing(button(), facts(true, true), true)).toBeUndefined();
    });

    it("names no passkey route on a page the passkey scripts do not run on (ADR 0050)", () => {
      expect(heldRouteMissing(plain(), facts(false, true), false)).toBeUndefined();
      // The item's password is still taken by the recipe's password route.
      expect(heldRouteMissing(plain(), facts(true, true), false)).toBeUndefined();
    });

    it("names the password route for a password on a passkey-only recipe (ADR 0053)", () => {
      const only = parseLoginRecipe({
        version: 1,
        id: "bank-login",
        revision: 1,
        origin: "https://bank.example",
        pageKind: "sign-in",
        slots: [],
        passkeyOnly: true,
        passkey: { path: "/identity", target: id("passkey-login") },
        steps: [
          { kind: "click", path: "/identity", target: id("passkey-login"), purpose: "submit" },
        ],
        maxSubmissions: 1,
      });
      expect(recipeHasRoute(only, "password")).toBe(false);
      expect(recipeHasRoute(only, "passkey")).toBe(true);
      // A password and no discoverable passkey: the recipe has no route for the password.
      expect(heldRouteMissing(only, facts(true, false), true)).toBe("password");
      expect(heldRouteMissing(only, facts(true, false), false)).toBe("password");
      // A discoverable passkey alone: the recipe has the passkey route.
      expect(heldRouteMissing(only, facts(false, true), true)).toBeUndefined();
      // With the password beside it, the plan takes the passkey route and never asks.
      expect(chooseLoginRoute(only, facts(true, true), [])).toEqual({ route: "passkey" });
      // Neither: nothing the recipe lacks.
      expect(heldRouteMissing(only, facts(false, false), true)).toBeUndefined();
      expect(heldRouteMissing(only, facts(false, false), false)).toBeUndefined();
    });

    it("names no password route while the recipe has a password variant", () => {
      // A password alone names nothing on a recipe with a password variant.
      expect(recipeHasRoute(plain(), "password")).toBe(true);
      expect(heldRouteMissing(plain(), facts(true, false), true)).toBeUndefined();
      expect(heldRouteMissing(plain(), facts(true, false), false)).toBeUndefined();
      expect(heldRouteMissing(button(), facts(true, false), true)).toBeUndefined();
      const varied = parseLoginRecipe({
        ...recipe(),
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              {
                kind: "fill",
                path: "/identity",
                fields: [
                  { slot: "contract", target: id("contract") },
                  { slot: "password", target: id("pin") },
                ],
              },
              { kind: "click", path: "/identity", target: id("contract-login"), purpose: "submit" },
            ],
          },
        ],
        maxSubmissions: 3,
      });
      expect(heldRouteMissing(varied, facts(true, false), true)).toBeUndefined();
      expect(heldRouteMissing(varied, facts(false, true), true)).toBe("passkey");
    });

    it("names nothing for an item that holds neither", () => {
      expect(heldRouteMissing(plain(), facts(false, false), true)).toBeUndefined();
      expect(heldRouteMissing(button(), facts(false, false), true)).toBeUndefined();
    });
  });
}

export function registerLogoutRecipes({ recipe }: Pick<LoginTestContext, "recipe">): void {
  describe("logout recipes (ADR 0063)", () => {
    const click = (path: string, value: string, purpose: string) => ({
      kind: "click",
      path,
      target: { by: "text", value },
      purpose,
    });
    const logout = (targets: unknown[] = [click("/home", "Account", "menu")]) => ({
      version: 1,
      id: "gen-logout-01",
      revision: 1,
      origin: "https://www.example.test",
      logout: { path: "/home", targets },
    });

    it("stores a recipe with only a logout, which starts no login and fills nothing", () => {
      const stored = v.parse(storedLoginRecipeSchema, logout());
      expect(stored).toEqual(logout());
      expect(v.is(loginLogoutRecipeSchema, logout())).toBe(true);
      expect(isLoginRouteRecipe(stored)).toBe(false);
      expect(storedRecipeStartPath(stored)).toBe("/home");
      expect(storedRecipeSlots(stored)).toEqual([]);
      expect(v.is(loginRecipeSchema, logout())).toBe(false);
      expect(v.is(loginEntryRecipeSchema, logout())).toBe(false);
    });

    it("holds the menu, the logout and its confirmation in order, at most three clicks", () => {
      const full = [
        click("/home", "Account", "menu"),
        click("/home", "Sign out", "logout"),
        click("/logout", "Yes, sign out", "confirm"),
      ];
      expect(v.is(storedLoginRecipeSchema, logout(full))).toBe(true);
      expect(v.is(storedLoginRecipeSchema, logout([...full, click("/", "Again", "logout")]))).toBe(
        false,
      );
      expect(v.is(storedLoginRecipeSchema, logout([]))).toBe(false);
      // The first click is on the recipe's path.
      expect(v.is(storedLoginRecipeSchema, logout([click("/other", "Account", "menu")]))).toBe(
        false,
      );
      // A confirmation only follows the logout, as the last click.
      expect(
        v.is(
          storedLoginRecipeSchema,
          logout([click("/home", "Account", "menu"), click("/home", "Yes", "confirm")]),
        ),
      ).toBe(false);
      expect(
        v.is(
          storedLoginRecipeSchema,
          logout([
            click("/home", "Sign out", "logout"),
            click("/home", "Yes", "confirm"),
            click("/home", "Account", "menu"),
          ]),
        ),
      ).toBe(false);
    });

    it("names a control by id, name, test-id, text or accessible name, never an input locator", () => {
      for (const target of [
        { by: "id", value: "logout" },
        { by: "name", value: "logout" },
        { by: "test-id", value: "account-menu" },
        // An icon-only menu named by its aria-label or title (ADR 0063).
        { by: "accessible-name", value: "Account menu" },
      ])
        expect(
          v.is(
            storedLoginRecipeSchema,
            logout([{ kind: "click", path: "/home", target, purpose: "logout" }]),
          ),
        ).toBe(true);
      for (const target of [
        { by: "autocomplete", value: "username" },
        { by: "label", value: "Sign out" },
        { by: "href", value: "/logout" },
      ])
        expect(
          v.is(
            storedLoginRecipeSchema,
            logout([{ kind: "click", path: "/home", target, purpose: "logout" }]),
          ),
        ).toBe(false);
    });

    it("never holds a logout beside a login route or entry member", () => {
      const { slots, steps } = recipe();
      for (const extra of [
        { slots },
        { steps },
        { entry: { path: "/home", target: { by: "text", value: "Login" } } },
      ])
        expect(v.is(storedLoginRecipeSchema, { ...logout(), ...extra })).toBe(false);
    });
  });
}
