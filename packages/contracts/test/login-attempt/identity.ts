import { describe, expect, it } from "vitest";
import {
  nextLoginOperation,
  parseAttemptMetadata,
  transitionLoginAttempt,
  validateLoginOperation,
} from "../../src/login-attempt";
import type { LoginRecipe } from "../../src/login";
import type { LoginAttemptMetadataLike, LoginAttemptTestContext } from "./context";

export function registerAttemptIdentity({
  document,
  recipe,
  detected,
  readyToClick,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected" | "readyToClick">): void {
  describe("attempt identity and metadata", () => {
    it("allows only the exact live tab, frame and document to issue operations", () => {
      const attempt = transitionLoginAttempt(detected(), { type: "RESOLVE" });
      expect(nextLoginOperation(attempt, recipe, document, "fill-one")).toMatchObject({
        attemptId: attempt.id,
        operationId: "fill-one",
        document,
        stepIndex: 0,
      });
      for (const stale of [
        { ...document, tabId: 8 },
        { ...document, frameId: 0 },
        { ...document, documentId: "document-two" },
        { ...document, origin: "https://evil.example" },
      ])
        expect(nextLoginOperation(attempt, recipe, stale, "fill-one")).toBeUndefined();
    });

    it("keeps the layout the login started on, and runs no other one (ADR 0060)", () => {
      const layered = { ...recipe, layout: "1760000000000" };
      const attempt = transitionLoginAttempt(detected(layered), { type: "RESOLVE" });
      expect(attempt.layout).toBe("1760000000000");
      expect(parseAttemptMetadata(attempt)).toEqual(attempt);
      expect(nextLoginOperation(attempt, layered, document, "fill-one")).toMatchObject({
        operationId: "fill-one",
      });
      for (const other of [{ ...recipe, layout: "1760000000001" }, recipe])
        expect(nextLoginOperation(attempt, other, document, "fill-one")).toBeUndefined();
      // A login on a recipe without layouts keeps none.
      expect(detected()).not.toHaveProperty("layout");
      expect(() => parseAttemptMetadata({ ...attempt, layout: "1000:account" })).toThrow();
    });

    it("excludes values, unknown fields and invalid counts from resumable metadata", () => {
      const attempt = detected();
      expect(parseAttemptMetadata(attempt)).toEqual(attempt);
      for (const malformed of [
        { ...attempt, password: "synthetic-only" },
        { ...attempt, account: { ...attempt.account, value: "synthetic-only" } },
        { ...attempt, submissions: -1 },
        { ...attempt, document: { ...attempt.document, token: "synthetic-only" } },
      ])
        expect(() => parseAttemptMetadata(malformed)).toThrow();
    });

    it("ignores stale operation replies and invalidates in-flight work after navigation", () => {
      const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
      const filling = transitionLoginAttempt(ready, {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      expect(
        transitionLoginAttempt(filling, { type: "OPERATION_OK", operationId: "old-operation" }),
      ).toEqual(filling);
      const navigated = transitionLoginAttempt(filling, {
        type: "NAVIGATED",
        document: { ...document, documentId: "document-two" },
      });
      const late = transitionLoginAttempt(navigated, {
        type: "OPERATION_OK",
        operationId: "fill-one",
      });
      expect(late.stepIndex).toBe(0);
      expect(nextLoginOperation(late, recipe, document, "fill-two")).toBeUndefined();
    });

    it("rechecks policy revision, expiry and browser identity immediately before execution", () => {
      const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
      const operation = nextLoginOperation(ready, recipe, document, "fill-one", 1000)!;
      const filling = transitionLoginAttempt(ready, {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      expect(validateLoginOperation(operation, filling, document, 3, 1001)).toBe(false);
      expect(
        transitionLoginAttempt(filling, { type: "OPERATION_OK", operationId: "fill-one" }),
      ).toEqual(filling);
      const intent = transitionLoginAttempt(filling, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      expect(validateLoginOperation(operation, intent, document, 3, 1001)).toBe(true);
      expect(
        validateLoginOperation(
          {
            ...operation,
            step: {
              kind: "fill",
              effect: "advance",
              event: "input",
              path: "/login",
              fields: [{ slot: "password", target: { by: "id", value: "password" } }],
            },
          },
          intent,
          document,
          3,
          1001,
        ),
      ).toBe(false);
      expect(validateLoginOperation(operation, intent, document, 4, 1001)).toBe(false);
      expect(validateLoginOperation(operation, intent, document, 3, operation.expiresAt)).toBe(
        false,
      );
      for (const stale of [
        { ...document, tabId: 8 },
        { ...document, frameId: 0 },
        { ...document, documentId: "document-two" },
        { ...document, origin: "https://evil.example" },
      ])
        expect(validateLoginOperation(operation, intent, stale, 3, 1001)).toBe(false);
      expect(
        validateLoginOperation(
          { ...operation, operationId: "old-operation" },
          intent,
          document,
          3,
          1001,
        ),
      ).toBe(false);
      expect(validateLoginOperation(operation, ready, document, 3, 1001)).toBe(false);
    });

    it("does not authorize a click before its submission intent is journaled", () => {
      const ready = readyToClick();
      const operation = nextLoginOperation(ready, recipe, document, "click-one", 1000)!;
      const prepared = transitionLoginAttempt(ready, {
        type: "PREPARE",
        operationId: "click-one",
        kind: "click",
      });
      expect(validateLoginOperation(operation, prepared, document, 3, 1001)).toBe(false);
      const intent = transitionLoginAttempt(prepared, {
        type: "SUBMIT_INTENT",
        operationId: "click-one",
      });
      expect(validateLoginOperation(operation, intent, document, 3, 1001)).toBe(true);
      const staleReply = transitionLoginAttempt(intent, {
        type: "SUBMITTED",
        operationId: "old-click",
      });
      expect(staleReply).toEqual(intent);
    });

    it("never issues or authorizes a step with an effect for a fill-only attempt", () => {
      const ready = readyToClick();
      const operation = nextLoginOperation(ready, recipe, document, "click-one", 1000)!;
      const fillOnly = { ...ready, fillOnly: true as const };
      expect(nextLoginOperation(fillOnly, recipe, document, "click-one", 1000)).toBeUndefined();
      const intent = transitionLoginAttempt(
        transitionLoginAttempt(fillOnly, {
          type: "PREPARE",
          operationId: "click-one",
          kind: "click",
        }),
        { type: "SUBMIT_INTENT", operationId: "click-one" },
      );
      expect(validateLoginOperation(operation, intent, document, 3, 1001)).toBe(false);
      // Its preparing fill is issued as for any login.
      const start = {
        ...transitionLoginAttempt(detected(), { type: "RESOLVE" }),
        fillOnly: true as const,
      };
      expect(nextLoginOperation(start, recipe, document, "fill-one")).toMatchObject({
        step: { kind: "fill" },
      });
    });
    it("never issues or authorizes a keypad fill for a fill-only attempt", () => {
      // A page's software keyboard may submit at its last press (ADR 0021 D, 0067).
      const keypadRecipe: LoginRecipe = {
        ...recipe,
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [
              {
                slot: "password",
                target: { by: "id", value: "password" },
                keypad: { by: "id", value: "keys" },
              },
            ],
          },
          ...recipe.steps.slice(1),
        ],
      };
      const ready = transitionLoginAttempt(detected(keypadRecipe), { type: "RESOLVE" });
      const operation = nextLoginOperation(ready, keypadRecipe, document, "fill-one", 1000)!;
      expect(operation).toMatchObject({ step: { kind: "fill" } });
      const intent = (start: LoginAttemptMetadataLike) =>
        transitionLoginAttempt(
          transitionLoginAttempt(start, {
            type: "PREPARE",
            operationId: "fill-one",
            kind: "fill",
            effect: "prepare",
          }),
          { type: "MUTATION_INTENT", operationId: "fill-one" },
        );
      expect(validateLoginOperation(operation, intent(ready), document, 3, 1001)).toBe(true);
      const fillOnly = { ...ready, fillOnly: true as const };
      expect(
        nextLoginOperation(fillOnly, keypadRecipe, document, "fill-one", 1000),
      ).toBeUndefined();
      expect(validateLoginOperation(operation, intent(fillOnly), document, 3, 1001)).toBe(false);
    });
    it("never issues a code fill for a fill-only attempt, nor takes the page's submission of one", () => {
      // A code input may submit at its last digit, as a PIN pad does (ADR 0021 D, ADR 0027).
      const codeRecipe: LoginRecipe = {
        ...recipe,
        slots: ["password", "totp"],
        steps: [
          recipe.steps[0]!,
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [{ slot: "totp", target: { by: "id", value: "otp" } }],
          },
          ...recipe.steps.slice(1),
        ],
      };
      let ready = transitionLoginAttempt(detected(codeRecipe), { type: "RESOLVE" });
      ready = transitionLoginAttempt(ready, {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      ready = transitionLoginAttempt(ready, { type: "MUTATION_INTENT", operationId: "fill-one" });
      ready = transitionLoginAttempt(ready, { type: "OPERATION_OK", operationId: "fill-one" });
      expect(nextLoginOperation(ready, codeRecipe, document, "code-one")).toMatchObject({
        step: { fields: [{ slot: "totp" }] },
      });
      const fillOnly = { ...ready, fillOnly: true as const };
      expect(nextLoginOperation(fillOnly, codeRecipe, document, "code-one")).toBeUndefined();
      // Even a code fill already in flight is never counted as the page's own submission.
      let filling = transitionLoginAttempt(fillOnly, {
        type: "PREPARE",
        operationId: "code-one",
        kind: "fill",
      });
      filling = transitionLoginAttempt(filling, {
        type: "MUTATION_INTENT",
        operationId: "code-one",
      });
      expect(
        transitionLoginAttempt(filling, {
          type: "AUTO_SUBMITTED",
          operationId: "page-one",
          routeStep: true,
        }),
      ).toEqual(filling);
    });
    it("fills a fill-only attempt's step without the code it holds beside other fields", () => {
      const combined: LoginRecipe = {
        ...recipe,
        slots: ["password", "totp"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [
              { slot: "password", target: { by: "id", value: "password" } },
              { slot: "totp", target: { by: "id", value: "otp" } },
            ],
          },
          ...recipe.steps.slice(1),
        ],
      };
      const ready = transitionLoginAttempt(detected(combined), { type: "RESOLVE" });
      const whole = nextLoginOperation(ready, combined, document, "fill-one", 1000)!;
      expect(whole.step).toMatchObject({ fields: [{ slot: "password" }, { slot: "totp" }] });
      const fillOnly = { ...ready, fillOnly: true as const };
      const issued = nextLoginOperation(fillOnly, combined, document, "fill-one", 1000)!;
      expect(issued.step).toMatchObject({ fields: [{ slot: "password" }] });
      expect(issued.step).not.toMatchObject({ fields: [{}, {}] });
      const intent = transitionLoginAttempt(
        transitionLoginAttempt(fillOnly, {
          type: "PREPARE",
          operationId: "fill-one",
          kind: "fill",
        }),
        { type: "MUTATION_INTENT", operationId: "fill-one" },
      );
      expect(validateLoginOperation(issued, intent, document, 3, 1001)).toBe(true);
      // The step with its code is never authorized for it.
      expect(validateLoginOperation(whole, intent, document, 3, 1001)).toBe(false);
    });
  });
}
