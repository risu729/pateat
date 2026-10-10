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
      path: "/login",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    { kind: "click", path: "/login", target: { by: "id", value: "login" }, purpose: "submit" },
  ],
  completion: { path: "/account", target: { by: "id", value: "authenticated" } },
  rejection: { by: "id", value: "rejected" },
  maxSubmissions: 1,
};

function detected() {
  return createAttemptMetadata({
    id: "attempt-one",
    recipe,
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
    expect(validateLoginOperation(operation, filling, document, 3, 1001)).toBe(true);
    expect(validateLoginOperation(operation, filling, document, 4, 1001)).toBe(false);
    expect(validateLoginOperation(operation, filling, document, 3, operation.expiresAt)).toBe(
      false,
    );
    for (const stale of [
      { ...document, tabId: 8 },
      { ...document, frameId: 0 },
      { ...document, documentId: "document-two" },
      { ...document, origin: "https://evil.example" },
    ])
      expect(validateLoginOperation(operation, filling, stale, 3, 1001)).toBe(false);
    expect(
      validateLoginOperation(
        { ...operation, operationId: "old-operation" },
        filling,
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

  it("reobserves before safely retrying an interrupted fill at the same step", () => {
    const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    const filling = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    const resumed = recoverLoginAttempt(filling);
    expect(nextLoginOperation(resumed, recipe, document, "fill-two")).toBeUndefined();
    const observed = transitionLoginAttempt(resumed, {
      type: "OBSERVED",
      result: "continue",
      document,
    });
    expect(observed).toMatchObject({ state: "ready", stepIndex: 0, submissions: 0 });
    expect(nextLoginOperation(observed, recipe, document, "fill-one")).toBeUndefined();
    expect(nextLoginOperation(observed, recipe, document, "fill-two")).toMatchObject({
      stepIndex: 0,
      step: { kind: "fill" },
    });
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
