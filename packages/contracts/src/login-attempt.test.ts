import { describe, expect, it } from "vitest";
import {
  createAttemptMetadata,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
  validateLoginOperation,
} from "./login-attempt";
import type { LoginDocument, LoginRecipe } from "./login";

const document: LoginDocument = {
  origin: "https://bank.example",
  tabId: 7,
  frameId: 2,
  documentId: "document-one",
};
const recipe: LoginRecipe = {
  version: 1,
  id: "synthetic-login",
  revision: 2,
  origin: document.origin,
  slots: ["password"],
  steps: [
    {
      kind: "fill",
      effect: "prepare",
      path: "/login",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    { kind: "click", path: "/login", target: { by: "id", value: "login" }, purpose: "submit" },
  ],
  completion: { path: "/account", target: { by: "id", value: "authenticated" } },
  rejection: { by: "id", value: "rejected" },
  maxSubmissions: 1,
};

function detected(selected = recipe) {
  return createAttemptMetadata({
    id: "attempt-one",
    recipe: selected,
    policyRevision: 3,
    account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
    document,
  });
}

function readyToClick() {
  let attempt = transitionLoginAttempt(detected(), { type: "RESOLVE" });
  attempt = transitionLoginAttempt(attempt, {
    type: "PREPARE",
    operationId: "fill-one",
    kind: "fill",
  });
  attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
  return transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
}

function submitting() {
  let attempt = transitionLoginAttempt(readyToClick(), {
    type: "PREPARE",
    operationId: "click-one",
    kind: "click",
  });
  return transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "click-one" });
}

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
    expect(validateLoginOperation(operation, intent, document, 3, operation.expiresAt)).toBe(false);
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
});

describe("submission and failure reconciliation", () => {
  it("journals an input submission before authorization and reserves its budget once", () => {
    const inputRecipe: LoginRecipe = {
      ...recipe,
      steps: [
        {
          kind: "fill",
          effect: "submit",
          event: "input",
          path: "/login",
          fields: [{ slot: "password", target: { by: "id", value: "password" } }],
        },
      ],
    };
    const ready = transitionLoginAttempt(detected(inputRecipe), { type: "RESOLVE" });
    const operation = nextLoginOperation(ready, inputRecipe, document, "input-one", 1000)!;
    const prepared = transitionLoginAttempt(ready, {
      type: "PREPARE",
      kind: "fill",
      effect: "submit",
      operationId: "input-one",
    });
    expect(validateLoginOperation(operation, prepared, document, 3, 1001)).toBe(false);
    const intent = transitionLoginAttempt(prepared, {
      type: "MUTATION_INTENT",
      operationId: "input-one",
    });
    expect(intent).toMatchObject({
      state: "submit-intent",
      operationKind: "fill",
      operationEffect: "submit",
      mutationIntent: true,
      submissions: 1,
    });
    expect(validateLoginOperation(operation, intent, document, 3, 1001)).toBe(true);
    expect(
      transitionLoginAttempt(intent, { type: "MUTATION_INTENT", operationId: "input-one" }),
    ).toEqual(intent);
    for (const interrupted of [
      intent,
      transitionLoginAttempt(intent, { type: "SUBMITTED", operationId: "input-one" }),
    ]) {
      const restored = recoverLoginAttempt(parseAttemptMetadata(interrupted));
      const observed = transitionLoginAttempt(restored, {
        type: "OBSERVED",
        result: "continue",
        document,
      });
      expect(observed).toMatchObject({ state: "reconciling", stepIndex: 0, submissions: 1 });
      expect(nextLoginOperation(observed, inputRecipe, document, "input-again")).toBeUndefined();
      expect(transitionLoginAttempt(observed, { type: "RETRY" })).toEqual(observed);
    }
    const preflight = transitionLoginAttempt(intent, {
      type: "FAILED",
      reason: "structural-mismatch",
      mutation: "none",
      operationId: "input-one",
      document,
    });
    expect(preflight).toMatchObject({ state: "retryable", submissions: 0 });
    const retry = transitionLoginAttempt(preflight, { type: "RETRY" });
    expect(nextLoginOperation(retry, inputRecipe, document, "input-one")).toBeUndefined();
    expect(nextLoginOperation(retry, inputRecipe, document, "input-two")).toBeDefined();
    for (const unproven of [
      { type: "FAILED", reason: "structural-mismatch", mutation: "none" } as const,
      {
        type: "FAILED",
        reason: "timeout",
        mutation: "possible",
        operationId: "input-one",
        document,
      } as const,
      { type: "FAILED", reason: "timeout", operationId: "input-one", document } as const,
    ]) {
      const failed = transitionLoginAttempt(intent, unproven);
      expect(failed).toMatchObject({ state: "reconciling", mutationIntent: true, submissions: 1 });
      expect(transitionLoginAttempt(failed, { type: "RETRY" })).toEqual(failed);
    }
    for (const stale of [
      { operationId: "old-input", document },
      { operationId: "input-one", document: { ...document, documentId: "old-document" } },
      { operationId: "input-one", document: { ...document, tabId: 8 } },
    ])
      expect(
        transitionLoginAttempt(intent, {
          type: "FAILED",
          reason: "structural-mismatch",
          mutation: "none",
          ...stale,
        }),
      ).toEqual(intent);
  });

  it("advances an input stage only after explicit intent and matching next-document evidence", () => {
    const advanceRecipe: LoginRecipe = {
      ...recipe,
      maxSubmissions: 2,
      steps: [
        {
          kind: "fill",
          effect: "advance",
          event: "change",
          path: "/identity",
          fields: [{ slot: "password", target: { by: "id", value: "identity" } }],
        },
        ...recipe.steps,
      ],
    };
    const ready = transitionLoginAttempt(detected(advanceRecipe), { type: "RESOLVE" });
    const prepared = transitionLoginAttempt(ready, {
      type: "PREPARE",
      kind: "fill",
      effect: "advance",
      operationId: "advance-input",
    });
    const nextDocument = { ...document, documentId: "next-document" };
    const noIntent = transitionLoginAttempt(recoverLoginAttempt(prepared), {
      type: "OBSERVED",
      result: "continue",
      document: nextDocument,
    });
    expect(noIntent).toMatchObject({ state: "reconciling", stepIndex: 0, submissions: 0 });
    const intent = transitionLoginAttempt(prepared, {
      type: "MUTATION_INTENT",
      operationId: "advance-input",
    });
    const restored = recoverLoginAttempt(parseAttemptMetadata(intent));
    for (const invalid of [
      { ...nextDocument, tabId: 8 },
      { ...nextDocument, frameId: 0 },
      { ...nextDocument, origin: "https://evil.example" },
    ]) {
      expect(
        transitionLoginAttempt(restored, {
          type: "OBSERVED",
          result: "continue",
          document: invalid,
        }),
      ).toEqual(restored);
    }
    const continued = transitionLoginAttempt(restored, {
      type: "OBSERVED",
      result: "continue",
      document: nextDocument,
    });
    expect(continued).toMatchObject({
      state: "ready",
      stepIndex: 1,
      submissions: 1,
      document: nextDocument,
    });
    expect(nextLoginOperation(continued, advanceRecipe, document, "next-fill")).toBeUndefined();
    expect(nextLoginOperation(continued, advanceRecipe, nextDocument, "next-fill")).toMatchObject({
      stepIndex: 1,
    });
  });

  it("a possibly mutated preparation fill cannot become retryable after a structural failure", () => {
    const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    const prepared = transitionLoginAttempt(ready, {
      type: "PREPARE",
      kind: "fill",
      operationId: "fill-one",
    });
    const intent = transitionLoginAttempt(prepared, {
      type: "MUTATION_INTENT",
      operationId: "fill-one",
    });
    const failed = transitionLoginAttempt(intent, {
      type: "FAILED",
      reason: "structural-mismatch",
      mutation: "possible",
    });
    expect(failed.state).toBe("reconciling");
    const restored = recoverLoginAttempt(parseAttemptMetadata(failed));
    expect(transitionLoginAttempt(restored, { type: "RETRY" })).toEqual(restored);
    expect(nextLoginOperation(restored, recipe, document, "fill-again")).toBeUndefined();
    const preflight = transitionLoginAttempt(intent, {
      type: "FAILED",
      reason: "structural-mismatch",
      mutation: "none",
      operationId: "fill-one",
      document,
    });
    expect(preflight).toMatchObject({ state: "retryable", submissions: 0 });
    const retry = transitionLoginAttempt(preflight, { type: "RETRY" });
    expect(retry).toMatchObject({ state: "ready", retries: 1 });
    expect(nextLoginOperation(retry, recipe, document, "fill-one")).toBeUndefined();
    expect(nextLoginOperation(retry, recipe, document, "fill-again")).toBeDefined();
  });
  it("cannot bypass the structural retry budget by restarting between failures", () => {
    let attempt = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    for (let failure = 0; failure < 3; failure++) {
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: `restarted-fill-${failure}`,
        kind: "fill",
      });
      attempt = transitionLoginAttempt(attempt, { type: "FAILED", reason: "structural-mismatch" });
      const restored = recoverLoginAttempt(parseAttemptMetadata(attempt));
      const observed = transitionLoginAttempt(restored, {
        type: "OBSERVED",
        result: "continue",
        document,
      });
      expect(
        nextLoginOperation(observed, recipe, document, `unguarded-fill-${failure}`),
      ).toBeUndefined();
      attempt = transitionLoginAttempt(observed, { type: "RETRY" });
      if (failure < 2) {
        expect(attempt).toMatchObject({ state: "ready", retries: failure + 1 });
      } else {
        expect(attempt).toMatchObject({ state: "blocked", outcome: "retry-limit", retries: 2 });
      }
    }
  });

  it("never replays an interrupted preparation fill merely because its fields remain visible", () => {
    const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    const filling = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    const intent = transitionLoginAttempt(filling, {
      type: "MUTATION_INTENT",
      operationId: "fill-one",
    });
    const resumed = recoverLoginAttempt(intent);
    expect(nextLoginOperation(resumed, recipe, document, "fill-two")).toBeUndefined();
    const observed = transitionLoginAttempt(resumed, {
      type: "OBSERVED",
      result: "continue",
      document,
    });
    expect(observed).toMatchObject({ state: "reconciling", stepIndex: 0, submissions: 0 });
    expect(nextLoginOperation(observed, recipe, document, "fill-one")).toBeUndefined();
    expect(nextLoginOperation(observed, recipe, document, "fill-two")).toBeUndefined();
  });

  it("continues a journaled multi-page advance only in the same origin, tab and frame", () => {
    const twoPage: LoginRecipe = {
      ...recipe,
      maxSubmissions: 2,
      steps: [
        {
          kind: "click",
          path: "/identity",
          target: { by: "id", value: "next" },
          purpose: "advance",
        },
        ...recipe.steps,
      ],
    };
    let attempt = createAttemptMetadata({
      id: "multi-page",
      recipe: twoPage,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      document,
    });
    attempt = transitionLoginAttempt(attempt, { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "advance-one",
      kind: "click",
      effect: "advance",
    });
    attempt = transitionLoginAttempt(attempt, {
      type: "SUBMIT_INTENT",
      operationId: "advance-one",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "advance-one" });
    for (const unauthorized of [
      { ...document, origin: "https://evil.example" },
      { ...document, tabId: 8 },
      { ...document, frameId: 0 },
    ])
      expect(
        transitionLoginAttempt(attempt, {
          type: "OBSERVED",
          result: "continue",
          document: unauthorized,
        }),
      ).toEqual(attempt);
    const nextDocument = { ...document, documentId: "document-two" };
    const continued = transitionLoginAttempt(attempt, {
      type: "OBSERVED",
      result: "continue",
      document: nextDocument,
    });
    expect(continued).toMatchObject({
      state: "ready",
      stepIndex: 1,
      submissions: 1,
      document: nextDocument,
    });
    expect(nextLoginOperation(continued, twoPage, document, "fill-next")).toBeUndefined();
    expect(nextLoginOperation(continued, twoPage, nextDocument, "fill-next")).toMatchObject({
      stepIndex: 1,
      step: { kind: "fill" },
      document: nextDocument,
    });
  });

  it("persists submission intent before click and never replays it after interruption", () => {
    const intent = submitting();
    expect(intent.submissions).toBe(1);
    for (const interrupted of [
      intent,
      transitionLoginAttempt(intent, { type: "SUBMITTED", operationId: "click-one" }),
      transitionLoginAttempt(intent, { type: "INTERRUPTED" }),
    ]) {
      const restored = recoverLoginAttempt(parseAttemptMetadata(interrupted));
      expect(nextLoginOperation(restored, recipe, document, "click-again")).toBeUndefined();
      expect(restored.submissions).toBe(1);
      expect(restored.state).toBe("reconciling");
    }
  });

  it("keeps unknown outcomes blocked from resubmission until observation resolves them", () => {
    const awaiting = transitionLoginAttempt(submitting(), {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    const unknown = transitionLoginAttempt(awaiting, { type: "OBSERVED", result: "unknown" });
    expect(nextLoginOperation(unknown, recipe, document, "click-again")).toBeUndefined();
    const authenticated = transitionLoginAttempt(unknown, {
      type: "OBSERVED",
      result: "authenticated",
    });
    expect(authenticated.state).toBe("authenticated");
    expect(nextLoginOperation(authenticated, recipe, document, "click-again")).toBeUndefined();
  });

  it("credential rejection is terminal while structural failure has a finite retry budget", () => {
    const awaiting = transitionLoginAttempt(submitting(), {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    const rejected = transitionLoginAttempt(awaiting, {
      type: "OBSERVED",
      result: "credential-rejected",
    });
    expect(rejected.outcome).toBe("credential-rejected");
    expect(transitionLoginAttempt(rejected, { type: "RETRY" })).toEqual(rejected);
    let structural = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    for (let retry = 0; retry < 3; retry++) {
      structural = transitionLoginAttempt(structural, {
        type: "PREPARE",
        operationId: `fill-${retry}`,
        kind: "fill",
      });
      structural = transitionLoginAttempt(structural, {
        type: "FAILED",
        reason: "structural-mismatch",
      });
      if (retry < 2) {
        expect(structural.state).toBe("retryable");
        structural = transitionLoginAttempt(structural, { type: "RETRY" });
      }
    }
    expect(
      nextLoginOperation(
        transitionLoginAttempt(structural, { type: "RETRY" }),
        recipe,
        document,
        "fill-again",
      ),
    ).toBeUndefined();
  });

  it("policy revocation cancels in-flight work and stale replies cannot restore it", () => {
    const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    const filling = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    const revoked = transitionLoginAttempt(filling, { type: "POLICY_CHANGED" });
    expect(revoked.state).toBe("blocked");
    expect(
      transitionLoginAttempt(revoked, { type: "OPERATION_OK", operationId: "fill-one" }),
    ).toEqual(revoked);
    expect(nextLoginOperation(revoked, recipe, document, "fill-again")).toBeUndefined();
  });
});
