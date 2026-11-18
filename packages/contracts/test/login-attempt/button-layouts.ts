import { describe, expect, it } from "vitest";
import { attemptPlan } from "../../src/login-attempt/operations";
import { createAttemptMetadata, transitionLoginAttempt } from "../../src/login-attempt";
import type { LoginAttemptEvent } from "../../src/login-attempt/events";
import type { LoginRecipe } from "../../src/login/route-schema";
import { identifierLayoutAfter } from "../../src/login/routes";
import type { LoginAttemptTestContext } from "./context";

/**
 * A passkey button that leads to a step asking for the account first, as on Qantas's
 * sign-in (#1675): the login goes on with the layout learned there (ADR 0060 amendment of
 * 2026-11-18).
 */
export function registerButtonLayouts({
  document,
  recipe,
  noTimeBefore,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "noTimeBefore">): void {
  describe("a passkey button's step that asks for the account (ADR 0060)", () => {
    const top = { ...document, frameId: 0 };
    const id = (value: string) => ({ by: "id" as const, value });
    const form: LoginRecipe = {
      ...recipe,
      layout: "1000",
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [
            { slot: "username", target: id("member") },
            { slot: "password", target: id("pin") },
          ],
        },
        { kind: "click", path: "/login", target: id("login"), purpose: "submit" },
      ],
      passkey: { path: "/login", target: id("passkey") },
    };
    const step: LoginRecipe = {
      ...recipe,
      layout: "2000",
      slots: ["username"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [{ slot: "username", target: id("member") }],
        },
        { kind: "click", path: "/login", target: id("continue"), purpose: "advance" },
      ],
      completion: undefined,
    };
    it("names a layout of the recipe that asks for the account and goes on", () => {
      expect(identifierLayoutAfter(form, step)).toBe(true);
      // A generated slot's own name counts as the account's, as any slot but the password's
      // or a code's does.
      const named = {
        ...step,
        slots: ["0"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [{ slot: "0", target: id("member") }],
          },
          step.steps[1]!,
        ],
      } as LoginRecipe;
      expect(identifierLayoutAfter(form, named)).toBe(true);
      // Never without a button, for itself, or for another recipe's layout.
      const { passkey: _button, ...buttonless } = form;
      expect(identifierLayoutAfter(buttonless, step)).toBe(false);
      expect(identifierLayoutAfter(form, { ...step, layout: "1000" })).toBe(false);
      expect(identifierLayoutAfter(form, { ...step, id: "other-recipe" })).toBe(false);
      expect(identifierLayoutAfter(form, { ...step, layout: undefined })).toBe(false);
    });
    it.each<[string, Partial<LoginRecipe>]>([
      [
        "fills a password",
        {
          slots: ["password"],
          steps: [
            {
              kind: "fill",
              effect: "prepare",
              path: "/login",
              fields: [{ slot: "password", target: id("member") }],
            },
            { kind: "click", path: "/login", target: id("continue"), purpose: "advance" },
          ],
        },
      ],
      [
        "fills a code",
        {
          slots: ["totp"],
          steps: [
            {
              kind: "fill",
              effect: "prepare",
              path: "/login",
              fields: [{ slot: "totp", target: id("member") }],
            },
            { kind: "click", path: "/login", target: id("continue"), purpose: "advance" },
          ],
        },
      ],
      [
        "ends with a submission",
        {
          steps: [
            {
              kind: "fill",
              effect: "prepare",
              path: "/login",
              fields: [{ slot: "username", target: id("member") }],
            },
            { kind: "click", path: "/login", target: id("continue"), purpose: "submit" },
          ],
        },
      ],
      [
        "starts on another path",
        {
          steps: [
            {
              kind: "fill",
              effect: "prepare",
              path: "/other",
              fields: [{ slot: "username", target: id("member") }],
            },
            { kind: "click", path: "/other", target: id("continue"), purpose: "advance" },
          ],
        },
      ],
      [
        "fills nothing",
        {
          slots: [],
          steps: [{ kind: "click", path: "/login", target: id("go"), purpose: "advance" }],
        },
      ],
      ["has a passkey button of its own", { passkey: { path: "/login", target: id("passkey") } }],
      ["is passkey-only", { passkeyOnly: true }],
      ["belongs to another origin", { origin: "https://other.example" }],
      ["is of an older revision", { revision: form.revision - 1 }],
      [
        "has alternatives",
        {
          alternatives: [
            {
              slots: ["email"],
              steps: [
                {
                  kind: "fill",
                  effect: "prepare",
                  path: "/login",
                  fields: [{ slot: "email", target: id("member") }],
                },
                { kind: "click", path: "/login", target: id("continue"), purpose: "advance" },
              ],
            },
          ],
        },
      ],
      [
        "has handlers",
        {
          handlers: [
            {
              kind: "totp",
              path: "/login",
              steps: [
                { kind: "fill", path: "/login", fields: [{ slot: "totp", target: id("code") }] },
              ],
            },
          ],
        } as unknown as Partial<LoginRecipe>,
      ],
    ])("never names a layout that %s", (_label, change) => {
      expect(identifierLayoutAfter(form, { ...step, ...change } as LoginRecipe)).toBe(false);
    });

    const started = (change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {}) =>
      transitionLoginAttempt(
        createAttemptMetadata({
          timing: noTimeBefore,
          id: "attempt-button",
          recipe: form,
          policyRevision: 3,
          account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: { route: "passkey" },
          facts: { password: true, totp: false, passkey: true, discoverablePasskey: true },
          document: top,
          ...change,
        }),
        { type: "RESOLVE" },
      );
    /** The button's click, in flight once the page took it. */
    const clicked = (change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {}) => {
      let attempt = started(change);
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "button",
        kind: "click",
      });
      attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "button" });
      return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "button" });
    };
    const event = (change: Record<string, unknown> = {}) =>
      ({
        type: "IDENTIFIER_LAYOUT",
        layout: "2000",
        recipeRevision: 2,
        steps: 2,
        maxSubmissions: 1,
        document: top,
        ...change,
      }) as LoginAttemptEvent;
    it("runs the layout's steps from its first and stops just past them", () => {
      const before = clicked();
      expect(before).toMatchObject({ state: "awaiting-result", route: "passkey", submissions: 1 });
      const after = transitionLoginAttempt(before, event());
      expect(after).toMatchObject({
        state: "ready",
        route: "password",
        variant: 0,
        layout: "2000",
        stepIndex: 0,
        stepCount: 2,
        stopAt: 2,
        passkeyButton: true,
        passkeyLeft: true,
        submissions: 1,
        // The button's click, Continue's, and one kept for the answer at the stop.
        maxSubmissions: 3,
      });
      expect(after.operationId).toBeUndefined();
      expect(attemptPlan(step, after)?.map((entry) => entry.step)).toEqual(step.steps);
      // It never goes back to the button, nor asks to continue the recipe.
      expect(transitionLoginAttempt(after, { type: "ROUTE", route: "passkey", steps: 1 })).toEqual(
        after,
      );
    });
    /** The layout's identifier filled and its Continue in flight. */
    const continued = () => {
      let attempt = transitionLoginAttempt(clicked(), event());
      for (const [operationId, kind, effect] of [
        ["fill", "fill", "prepare"],
        ["continue", "click", "advance"],
      ] as const) {
        attempt = transitionLoginAttempt(attempt, { type: "PREPARE", operationId, kind, effect });
        if (kind === "fill") {
          attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId });
          attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId });
        } else {
          attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId });
          attempt = transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId });
        }
      }
      return attempt;
    };
    it("never asks to continue the recipe after the layout's Continue", () => {
      const after = continued();
      expect(after).toMatchObject({ stepIndex: 1, operationEffect: "advance", submissions: 2 });
      const request = { type: "CONTINUING", operationId: "continue" } as const;
      expect(transitionLoginAttempt(after, request)).toEqual(after);
      // The same login without the mark would ask.
      const { passkeyButton: _mark, ...unmarked } = after;
      expect(transitionLoginAttempt(unmarked, request).continuation).toEqual({
        operationId: "continue",
      });
    });
    it("keeps its stop just past the layout's steps", () => {
      const after = transitionLoginAttempt(clicked(), event());
      expect(() => transitionLoginAttempt({ ...after, stopAt: 1 }, { type: "RESOLVE" })).toThrow(
        /stops just past/,
      );
      expect(() =>
        transitionLoginAttempt(
          { ...clicked(), passkeyButton: true },
          { type: "SUBMITTED", operationId: "button" },
        ),
      ).toThrow(/stops just past/);
    });
    it("is taken from a settled result too while it is not watched", () => {
      const reconciling = transitionLoginAttempt(clicked(), { type: "INTERRUPTED" });
      expect(reconciling.state).toBe("reconciling");
      expect(transitionLoginAttempt(reconciling, event()).layout).toBe("2000");
    });
    it.each<[string, () => ReturnType<typeof clicked>, Record<string, unknown>]>([
      ["before the click", () => started(), {}],
      ["for the same layout", () => clicked(), { layout: "1000" }],
      ["from an older revision", () => clicked(), { recipeRevision: 1 }],
      ["in another tab", () => clicked(), { document: { ...top, tabId: 8 } }],
      ["past the attempt's submission cap", () => clicked(), { maxSubmissions: 11 }],
      [
        "once the result settled as unknown",
        () =>
          transitionLoginAttempt(clicked(), {
            type: "OBSERVED",
            result: "unknown",
            document: top,
          }),
        {},
      ],
      [
        "on the password route",
        () => {
          let attempt = started({ choice: { route: "password", variant: 0 } });
          attempt = transitionLoginAttempt(attempt, {
            type: "PREPARE",
            operationId: "fill",
            kind: "fill",
          });
          attempt = transitionLoginAttempt(attempt, {
            type: "MUTATION_INTENT",
            operationId: "fill",
          });
          attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill" });
          attempt = transitionLoginAttempt(attempt, {
            type: "PREPARE",
            operationId: "login",
            kind: "click",
          });
          attempt = transitionLoginAttempt(attempt, {
            type: "SUBMIT_INTENT",
            operationId: "login",
          });
          return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "login" });
        },
        {},
      ],
      ["in a frame", () => clicked({ document: document }), { document }],
    ])("is refused %s", (_label, attempt, change) => {
      const before = attempt();
      expect(transitionLoginAttempt(before, event(change))).toEqual(before);
    });
  });
}
