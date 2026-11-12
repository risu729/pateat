import { describe, expect, it } from "vitest";
import {
  attemptPlan,
  createAttemptMetadata,
  nextLoginOperation,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import type { LoginRecipe, LoginStep } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerLaterSteps({
  facts,
  document,
  recipe,
  noTimeBefore,
}: Pick<LoginAttemptTestContext, "facts" | "document" | "recipe" | "noTimeBefore">): void {
  describe("a login that starts at a later step (ADR 0049)", () => {
    /** An identifier page and a password page, as a site that remembers the account skips. */
    const twoPages: LoginRecipe = {
      ...recipe,
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [{ slot: "username", target: { by: "id", value: "email" } }],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
        ...recipe.steps.map((step) => ({ ...step, path: "/password" })),
      ],
      maxSubmissions: 2,
    };
    const create = (change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {}) =>
      createAttemptMetadata({
        timing: noTimeBefore,
        id: "attempt-later",
        recipe: twoPages,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "password", variant: 0 },
        facts: { ...facts, passkey: true, discoverablePasskey: true },
        document,
        ...change,
      });

    it("starts at the step and issues it first", () => {
      const ready = transitionLoginAttempt(create({ startAt: 2 }), { type: "RESOLVE" });
      expect(ready).toMatchObject({ stepIndex: 2, stepCount: 4, startStep: 2 });
      expect(nextLoginOperation(ready, twoPages, document, "fill-password")).toMatchObject({
        stepIndex: 2,
        step: { kind: "fill", path: "/password" },
      });
    });

    it("goes back to that step, not the first, after an answered passkey request falls back", () => {
      const ready = transitionLoginAttempt(create({ startAt: 2 }), { type: "RESOLVE" });
      const switched = transitionLoginAttempt(ready, { type: "ROUTE", route: "passkey", steps: 1 });
      expect(switched).toMatchObject({ route: "passkey", stepIndex: 0, startStep: 2 });
      expect(
        transitionLoginAttempt(switched, { type: "ROUTE", route: "password", steps: 4 }),
      ).toMatchObject({ route: "password", stepIndex: 2, stepCount: 4 });
      // A passkey answer that falls back to the variant records the step too.
      const answering = create({ choice: { route: "passkey" }, fallback: 0, startAt: 2 });
      expect(answering).toMatchObject({ route: "passkey", stepIndex: 0, startStep: 2 });
      // The answer stands on that step's page and element, where the form it waits on shows.
      expect(attemptPlan(twoPages, answering)).toEqual([
        {
          step: {
            kind: "click",
            path: "/password",
            target: (twoPages.steps[2] as Extract<LoginStep, { kind: "fill" }>).fields[0]!.target,
            purpose: "submit",
          },
        },
      ]);
      expect(
        attemptPlan(twoPages, { ...answering, startStep: undefined })?.[0]?.step,
      ).toMatchObject({
        path: "/login",
        target: { by: "id", value: "email" },
      });
    });

    it("refuses a start outside the plan, at or past a stop, or on a chooser's branch", () => {
      expect(() => create({ startAt: 4 })).toThrow();
      expect(() =>
        create({ startAt: 2, stopAt: 2, document: { ...document, frameId: 0 } }),
      ).toThrow();
      expect(() => create({ startAt: 2, chooser: "other-shown" })).toThrow();
      expect(() => create({ choice: { route: "passkey" }, startAt: 2 })).toThrow();
    });

    it("starts a one-page form with its password alone, and only then at its first step", () => {
      // One step fills the username and the password together, as on a sign-in page that
      // later shows only its password input for an account it remembers (Duolingo).
      const onePage: LoginRecipe = {
        ...recipe,
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            path: "/login",
            fields: [
              { slot: "username", target: { by: "id", value: "email" } },
              { slot: "password", target: { by: "id", value: "password" } },
            ],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "login" },
            purpose: "submit",
          },
        ],
      };
      const partial = transitionLoginAttempt(
        create({ recipe: onePage, startAt: 0, startPartial: true }),
        { type: "RESOLVE" },
      );
      expect(partial).toMatchObject({ stepIndex: 0, startStep: 0, startPartial: true });
      expect(nextLoginOperation(partial, onePage, document, "fill-password")).toMatchObject({
        stepIndex: 0,
        step: { kind: "fill", fields: [{ slot: "password" }] },
      });
      expect(attemptPlan(onePage, partial)?.[0]?.step).toEqual({
        kind: "fill",
        path: "/login",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      });
      // A whole start never begins at the first step.
      expect(() => create({ recipe: onePage, startAt: 0 })).toThrow();
    });
  });
}
