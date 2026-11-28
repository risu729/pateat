import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { handoffStopOrMiss, passwordStopOrMiss } from "../../src/login/routes";
import { chooserRoute, loginChooserRecipeSchema } from "../../src/login/document-schema";
import { withChooserBranch } from "../../src/login/layouts";
import { parseLoginRecipe } from "../../src/login/account";

export function registerHandoffRoute(): void {
  describe("the stop of a hand-off after its identifier (ADR 0036, #1847)", () => {
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
    // An SSO item holds neither a password nor a passkey.
    const sso = { password: false, passkey: false };
    const handoff = (
      recipe: ReturnType<typeof emailFirst>,
      lacking: readonly string[] = ["password"],
      facts = sso,
      choice: Parameters<typeof passwordStopOrMiss>[1] = route,
    ) => passwordStopOrMiss(recipe, choice, facts, [], lacking, true);
    const identifierOnly = emailFirst({
      slots: ["username"],
      steps: [fill(["username"], "/login"), click("continue", "/login", "advance")],
      maxSubmissions: 1,
    });

    it("stops after the first advance of an identifier-first route, with no passkey", () => {
      expect(handoff(emailFirst())).toEqual({ stop: 2 });
      // Without the mark the same item takes no route.
      expect(passwordStopOrMiss(emailFirst(), route, sso, ["password"], ["password"])).toEqual({
        miss: "no-passkey",
      });
      // A route that ends with its advance stops just past it.
      expect(handoff(identifierOnly, [])).toEqual({ stop: 2 });
      // The input's own advance counts as the click's would.
      const typed = emailFirst({
        steps: [
          fill(["username"], "/signin", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
      });
      expect(handoff(typed)).toEqual({ stop: 1 });
      // A second advance after the first is past the stop.
      const twice = emailFirst({
        slots: ["username", "password"],
        steps: [
          fill(["username"], "/signin"),
          click("next", "/signin", "advance"),
          click("password-instead", "/method", "advance"),
          fill(["password"], "/password"),
          click("login", "/password", "submit"),
        ],
        maxSubmissions: 3,
      });
      expect(handoff(twice)).toEqual({ stop: 2 });
      // An item that holds a password or a passkey stops there too: nothing else is typed.
      for (const facts of [
        { password: true, passkey: false },
        { password: false, passkey: true },
      ])
        expect(handoff(emailFirst(), [], facts)).toEqual({ stop: 2 });
    });

    it("refuses a route whose steps before the stop fill more than the username", () => {
      const stacked = emailFirst({
        steps: [
          fill(["username", "password"], "/signin"),
          click("next", "/signin", "advance"),
          click("login", "/next", "submit"),
        ],
      });
      expect(handoff(stacked)).toEqual({ miss: "fills-other" });
      const passwordFirst = emailFirst({
        steps: [
          fill(["password"], "/signin"),
          click("next", "/signin", "advance"),
          fill(["username"], "/account"),
          click("login", "/account", "submit"),
        ],
      });
      expect(handoff(passwordFirst)).toEqual({ miss: "fills-other" });
      for (const slot of ["totp", "detail-0", "account"]) {
        const other = emailFirst({
          slots: ["username", slot, "password"],
          steps: [
            fill(["username"], "/signin"),
            fill([slot], "/signin"),
            click("next", "/signin", "advance"),
            fill(["password"], "/password"),
            click("login", "/password", "submit"),
          ],
        });
        expect(handoff(other, [])).toEqual({ miss: "fills-other" });
      }
    });

    it("refuses a route with no advance, no identifier, alternatives or another route", () => {
      const single = emailFirst({
        steps: [fill(["username"], "/signin"), click("login", "/signin", "submit")],
        maxSubmissions: 1,
        slots: ["username"],
      });
      expect(handoff(single, [])).toEqual({ miss: "no-advance" });
      const nothing = emailFirst({
        slots: ["username"],
        steps: [click("continue", "/signin", "advance"), fill(["username"], "/next")],
        maxSubmissions: 1,
      });
      expect(handoff(nothing, [])).toEqual({ miss: "no-identifier" });
      const varied = emailFirst({
        alternatives: [
          {
            slots: ["account", "password"],
            steps: [
              fill(["account"], "/signin"),
              click("next", "/signin", "advance"),
              fill(["password"], "/other"),
              click("login", "/other", "submit"),
            ],
          },
        ],
      });
      for (const variant of [0, 1])
        expect(handoff(varied, [], sso, { route: "password", variant })).toEqual({
          miss: "alternatives",
        });
      const button = emailFirst({ passkey: { path: "/signin", target: id("passkey-login") } });
      expect(handoff(button, [], sso, { route: "passkey" })).toEqual({
        miss: "no-password-step",
      });
      // A username slot the item lacks a value for is refused as for any stop.
      expect(handoff(emailFirst(), ["username"])).toEqual({ miss: "fills-lacking" });
    });

    it("types only the item's own Username before the stop", () => {
      const lacking = [{ slot: "password" }];
      const item = { fields: [] };
      expect(
        handoffStopOrMiss(
          emailFirst(),
          route,
          lacking,
          [{ slot: "username", fieldId: "login.username" }],
          item,
        ),
      ).toEqual({ stopAt: 2, identifierStop: true });
      // A `username` slot read from another field, or left unbound, is more.
      for (const slots of [[{ slot: "username", fieldId: "custom.member-number" }], []])
        expect(handoffStopOrMiss(emailFirst(), route, lacking, slots, item)).toEqual({
          miss: "username-field",
        });
    });

    it("refuses a chooser's route, whose click on the list is its first advance", () => {
      const listed = v.parse(loginChooserRecipeSchema, {
        version: 1,
        id: "synthetic-email-first",
        revision: 1,
        origin: "https://login.example",
        chooser: { path: "/accounts", other: id("other") },
      });
      const branch = parseLoginRecipe({ ...identifierOnly, revision: 2 });
      const other = chooserRoute(withChooserBranch(listed, "other", branch), "other")!;
      expect(handoff(other, [])).toEqual({ miss: "no-identifier" });
    });
  });
}
