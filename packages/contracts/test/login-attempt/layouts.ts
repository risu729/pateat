import { describe, expect, it } from "vitest";
import {
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import type { LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerLayoutChanges({
  document,
  recipe,
  detected,
  readyToClick,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected" | "readyToClick">): void {
  describe("a login that switches layouts where they part (ADR 0060)", () => {
    /** An email page, then a password page; layout `1000`. */
    const first: LoginRecipe = {
      ...recipe,
      layout: "1000",
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [{ slot: "username", target: { by: "id", value: "email" } }],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
        {
          kind: "fill",
          effect: "prepare",
          path: "/login/password",
          fields: [{ slot: "password", target: { by: "id", value: "password" } }],
        },
        {
          kind: "click",
          path: "/login/password",
          target: { by: "id", value: "login" },
          purpose: "submit",
        },
      ],
      maxSubmissions: 2,
    };
    /** The same email page, then another password form; layout `2000`. */
    const second: LoginRecipe = {
      ...first,
      layout: "2000",
      steps: [
        ...first.steps.slice(0, 2),
        {
          kind: "fill",
          effect: "prepare",
          path: "/login/password",
          fields: [{ slot: "password", target: { by: "id", value: "passcode" } }],
        },
        {
          kind: "click",
          path: "/login/password",
          target: { by: "id", value: "verify" },
          purpose: "advance",
        },
        {
          kind: "click",
          path: "/login/done",
          target: { by: "id", value: "ok" },
          purpose: "submit",
        },
      ],
      maxSubmissions: 3,
    };
    const passwordPage = { ...document, documentId: "document-password" };
    const layout = (change: Record<string, unknown> = {}) => ({
      type: "LAYOUT" as const,
      layout: "2000",
      recipeRevision: 2,
      steps: 5,
      maxSubmissions: 3,
      document: passwordPage,
      ...change,
    });
    function advanced(selected = first) {
      let attempt = transitionLoginAttempt(detected(selected), { type: "RESOLVE" });
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      attempt = transitionLoginAttempt(attempt, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "next-one",
        kind: "click",
        effect: "advance",
      });
      attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "next-one" });
      return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "next-one" });
    }

    it("goes on to the other layout's step after an advance, and runs only that layout", () => {
      const before = advanced();
      expect(before).toMatchObject({ state: "awaiting-result", layout: "1000", stepIndex: 1 });
      const switched = transitionLoginAttempt(before, layout());
      expect(switched).toMatchObject({
        state: "ready",
        layout: "2000",
        recipeRevision: 2,
        stepIndex: 2,
        stepCount: 5,
        submissions: 1,
        maxSubmissions: 3,
        document: passwordPage,
      });
      expect(switched.operationId).toBeUndefined();
      expect(nextLoginOperation(switched, second, passwordPage, "fill-two")?.step).toEqual(
        second.steps[2],
      );
      expect(nextLoginOperation(switched, first, passwordPage, "fill-two")).toBeUndefined();
      // So does a login that resumes in a new document, its advance still in flight.
      expect(transitionLoginAttempt(recoverLoginAttempt(before), layout())).toMatchObject({
        state: "ready",
        layout: "2000",
        stepIndex: 2,
      });
    });

    it("stays at its step when nothing is in flight", () => {
      const at = transitionLoginAttempt(advanced(), {
        type: "OBSERVED",
        result: "continue",
        document: passwordPage,
      });
      expect(at).toMatchObject({ state: "ready", stepIndex: 2 });
      expect(transitionLoginAttempt(at, layout())).toMatchObject({
        state: "ready",
        layout: "2000",
        stepIndex: 2,
        stepCount: 5,
      });
      // On its first step it has not reached a place where layouts part.
      const start = transitionLoginAttempt(detected(first), { type: "RESOLVE" });
      expect(transitionLoginAttempt(start, layout({ document }))).toEqual(start);
    });

    it("refuses a switch the layout or the attempt does not allow", () => {
      const before = advanced();
      for (const refused of [
        layout({ layout: "1000" }),
        layout({ recipeRevision: 1 }),
        // The layout has no step after the advance.
        layout({ steps: 2 }),
        layout({ document: { ...passwordPage, frameId: 3 } }),
      ])
        expect(transitionLoginAttempt(before, refused)).toEqual(before);
      // A budget of the submissions already spent still holds the switch.
      expect(transitionLoginAttempt(before, layout({ maxSubmissions: 1, steps: 3 }))).toMatchObject(
        {
          layout: "2000",
          maxSubmissions: 1,
        },
      );
      // The same attempt in a top document, as a stop needs one.
      const top = parseAttemptMetadata({ ...before, document: { ...document, frameId: 0 } });
      const topPage = { ...passwordPage, frameId: 0 };
      expect(transitionLoginAttempt(top, layout({ document: topPage }))).toMatchObject({
        layout: "2000",
      });
      for (const attempt of [
        parseAttemptMetadata({ ...top, layout: undefined }),
        parseAttemptMetadata({ ...top, variant: 1 }),
        parseAttemptMetadata({ ...top, route: "passkey" }),
        parseAttemptMetadata({ ...top, handlers: [{ index: 0, start: 2 }] }),
        parseAttemptMetadata({ ...top, chooser: { click: "entry" } }),
        parseAttemptMetadata({ ...top, fillOnly: true }),
        parseAttemptMetadata({ ...top, stopAt: 2 }),
        parseAttemptMetadata({ ...top, mutationIntent: undefined }),
      ])
        expect(transitionLoginAttempt(attempt, layout({ document: topPage }))).toEqual(attempt);
      // Nor does a budget smaller than what the login spent.
      const twice = parseAttemptMetadata({ ...top, submissions: 2 });
      expect(
        transitionLoginAttempt(twice, layout({ document: topPage, maxSubmissions: 1 })),
      ).toEqual(twice);
    });

    it("goes past its own last step only after an advance", () => {
      // The email page's Next was the login's last step: the other layout holds the next page.
      const emailOnly = { ...first, steps: first.steps.slice(0, 2), slots: ["username"] };
      const advancedOnly = advanced(emailOnly);
      expect(advancedOnly).toMatchObject({ stepIndex: 1, stepCount: 2 });
      expect(transitionLoginAttempt(advancedOnly, layout())).toMatchObject({
        layout: "2000",
        stepIndex: 2,
      });
      // After a submission that ended the login's own steps, it does not go on.
      let submitted = transitionLoginAttempt(readyToClick(), {
        type: "PREPARE",
        operationId: "click-one",
        kind: "click",
      });
      submitted = transitionLoginAttempt(submitted, {
        type: "SUBMIT_INTENT",
        operationId: "click-one",
      });
      submitted = transitionLoginAttempt(parseAttemptMetadata({ ...submitted, layout: "1000" }), {
        type: "SUBMITTED",
        operationId: "click-one",
      });
      expect(submitted).toMatchObject({ state: "awaiting-result", stepIndex: 1, stepCount: 2 });
      expect(transitionLoginAttempt(submitted, layout({ document }))).toEqual(submitted);
    });

    it("does not switch while a step must be tried again", () => {
      const at = parseAttemptMetadata({
        ...transitionLoginAttempt(advanced(), {
          type: "OBSERVED",
          result: "continue",
          document: passwordPage,
        }),
        retryRequired: true,
      });
      expect(transitionLoginAttempt(at, layout())).toEqual(at);
    });

    it("refuses a switch while a step that cannot advance is in flight", () => {
      // The email fill, before its click.
      let attempt = transitionLoginAttempt(detected(first), { type: "RESOLVE" });
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      attempt = transitionLoginAttempt(attempt, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      const reconciling = recoverLoginAttempt(attempt);
      expect(reconciling).toMatchObject({ state: "reconciling", operationKind: "fill" });
      expect(transitionLoginAttempt(reconciling, layout())).toEqual(reconciling);
      // The click about to be sent.
      const clicking = transitionLoginAttempt(
        transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" }),
        { type: "PREPARE", operationId: "next-one", kind: "click", effect: "advance" },
      );
      expect(clicking.state).toBe("executing");
      expect(transitionLoginAttempt(clicking, layout())).toEqual(clicking);
    });
  });
}
