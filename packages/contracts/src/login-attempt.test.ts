import { describe, expect, it } from "vitest";
import {
  attemptPlan,
  attemptRouteChoice,
  attemptUsesCode,
  createAttemptMetadata,
  handlerSlots,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  judgedPages,
  MAX_JUDGED_PAGES,
  transitionLoginAttempt,
  validateLoginOperation,
  withdrawAccountSwitch,
} from "./login-attempt";
import type { LoginDocument, LoginRecipe } from "./login";

const facts = { password: true, totp: false, passkey: false, discoverablePasskey: false };
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
    choice: { route: "password", variant: 0 },
    facts,
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
    const awaiting = transitionLoginAttempt(intent, {
      type: "SUBMITTED",
      operationId: "input-one",
    });
    expect(awaiting.state).toBe("awaiting-result");
    expect(
      transitionLoginAttempt(awaiting, { type: "OBSERVED", result: "continue", document }),
    ).toEqual(awaiting);
    const ordinaryUnknown = transitionLoginAttempt(awaiting, {
      type: "OBSERVED",
      result: "unknown",
      document,
    });
    expect(ordinaryUnknown).toMatchObject({
      state: "reconciling",
      outcome: "unknown-submit",
      stepIndex: 0,
      submissions: 1,
    });
    expect(
      nextLoginOperation(ordinaryUnknown, inputRecipe, document, "input-again"),
    ).toBeUndefined();
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
      choice: { route: "password", variant: 0 },
      facts,
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

  it("a final retry ends a retryable attempt with its budget unspent", () => {
    let attempt = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-final",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "FAILED", reason: "structural-mismatch" });
    expect(attempt.state).toBe("retryable");
    expect(transitionLoginAttempt(attempt, { type: "RETRY", final: true })).toMatchObject({
      state: "blocked",
      outcome: "retry-limit",
      retries: 0,
    });
  });

  it("a wrong displayed account ends the attempt without a retry or a spent submission", () => {
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
    for (const stale of [
      { type: "WRONG_ACCOUNT", operationId: "fill-two", document },
      {
        type: "WRONG_ACCOUNT",
        operationId: "fill-one",
        document: { ...document, documentId: "x" },
      },
    ])
      expect(transitionLoginAttempt(intent, stale)).toEqual(intent);
    const wrong = transitionLoginAttempt(intent, {
      type: "WRONG_ACCOUNT",
      operationId: "fill-one",
      document,
    });
    expect(wrong).toMatchObject({ state: "blocked", outcome: "wrong-account", submissions: 0 });
    expect(wrong.mutationIntent).toBeUndefined();
    expect(transitionLoginAttempt(wrong, { type: "RETRY" })).toEqual(wrong);
    // A clicked account switch ends it the same way, under its own outcome.
    expect(
      transitionLoginAttempt(intent, {
        type: "WRONG_ACCOUNT",
        operationId: "fill-one",
        document,
        switched: true,
      }),
    ).toMatchObject({ state: "blocked", outcome: "account-switched", submissions: 0 });
    // Only once per sign-in, and only before anything was submitted.
    for (const spent of [{ accountSwitched: true }, { submissions: 1 }]) {
      const switched = transitionLoginAttempt(parseAttemptMetadata({ ...intent, ...spent }), {
        type: "WRONG_ACCOUNT",
        operationId: "fill-one",
        document,
        switched: true,
      });
      expect(switched).toMatchObject({ state: "blocked", outcome: "wrong-account" });
    }
    // A switch that was not clicked after all ends as `wrong-account`.
    const withdrawn = withdrawAccountSwitch(
      transitionLoginAttempt(intent, {
        type: "WRONG_ACCOUNT",
        operationId: "fill-one",
        document,
        switched: true,
      }),
    );
    expect(withdrawn).toEqual({ ...wrong, outcome: "wrong-account" });
    expect(withdrawAccountSwitch(intent)).toEqual(intent);
    // An input-triggered secret fill gives back the submission it reserved.
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
    let submit = transitionLoginAttempt(detected(inputRecipe), { type: "RESOLVE" });
    submit = transitionLoginAttempt(submit, {
      type: "PREPARE",
      kind: "fill",
      effect: "submit",
      operationId: "input-one",
    });
    submit = transitionLoginAttempt(submit, { type: "MUTATION_INTENT", operationId: "input-one" });
    expect(submit).toMatchObject({ state: "submit-intent", submissions: 1 });
    expect(
      transitionLoginAttempt(submit, { type: "WRONG_ACCOUNT", operationId: "input-one", document }),
    ).toMatchObject({ state: "blocked", outcome: "wrong-account", submissions: 0 });
    // A click never reports a wrong account.
    expect(
      transitionLoginAttempt(submitting(), {
        type: "WRONG_ACCOUNT",
        operationId: "click-one",
        document,
      }).state,
    ).toBe("submit-intent");
  });

  it("ends a top-level attempt whose tab leaves the origin without resubmitting it", () => {
    const top: LoginDocument = { ...document, frameId: 0 };
    const away: LoginDocument = {
      origin: "https://other.example",
      tabId: top.tabId,
      frameId: 0,
      documentId: "document-away",
    };
    const create = () =>
      transitionLoginAttempt(
        createAttemptMetadata({
          id: "attempt-top",
          recipe,
          policyRevision: 3,
          account: { origin: top.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: { route: "password", variant: 0 },
          facts,
          document: top,
        }),
        { type: "RESOLVE" },
      );
    const ready = create();
    const filling = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    const filled = transitionLoginAttempt(filling, {
      type: "MUTATION_INTENT",
      operationId: "fill-one",
    });
    const prepared = transitionLoginAttempt(
      transitionLoginAttempt(filled, { type: "OPERATION_OK", operationId: "fill-one" }),
      { type: "PREPARE", operationId: "click-one", kind: "click" },
    );
    const clicked = transitionLoginAttempt(prepared, {
      type: "SUBMIT_INTENT",
      operationId: "click-one",
    });
    const awaiting = transitionLoginAttempt(clicked, {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    // A possible submission on the previous origin: its result cannot be observed there.
    for (const submitted of [filling, filled, clicked, awaiting]) {
      const left = transitionLoginAttempt(submitted, { type: "NAVIGATED", document: away });
      expect(left).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        document: top,
        submissions: submitted.submissions,
      });
      expect(transitionLoginAttempt(left, { type: "RETRY" })).toEqual(left);
      expect(
        transitionLoginAttempt(left, { type: "OBSERVED", result: "authenticated", document: top }),
      ).toEqual(left);
      expect(nextLoginOperation(left, recipe, top, "click-again")).toBeUndefined();
      expect(nextLoginOperation(recoverLoginAttempt(left), recipe, top, "click-again")).toBe(
        undefined,
      );
      expect(recoverLoginAttempt(parseAttemptMetadata(left))).toEqual(left);
      // A move the runtime confirmed as the sign-in completes the attempt instead.
      expect(
        transitionLoginAttempt(submitted, { type: "NAVIGATED", document: away, signedIn: true }),
      ).toMatchObject({ state: "authenticated", outcome: "authenticated", document: top });
    }
    // Nothing was possibly submitted: the attempt is only interrupted, confirmed or not.
    for (const unsubmitted of [
      ready,
      transitionLoginAttempt(filled, { type: "OPERATION_OK", operationId: "fill-one" }),
      prepared,
    ])
      for (const signedIn of [{}, { signedIn: true as const }])
        expect(
          transitionLoginAttempt(unsubmitted, { type: "NAVIGATED", document: away, ...signedIn }),
        ).toMatchObject({ state: "blocked", outcome: "interrupted", document: top });
    // A navigation within the origin still reconciles the same attempt.
    const next = { ...top, documentId: "document-next" };
    expect(transitionLoginAttempt(awaiting, { type: "NAVIGATED", document: next })).toMatchObject({
      state: "reconciling",
      outcome: "unknown-submit",
      document: next,
    });
    expect(transitionLoginAttempt(ready, { type: "NAVIGATED", document: next })).toMatchObject({
      state: "reconciling",
      outcome: "interrupted",
      document: next,
    });
    // Another tab or a frame is no origin change of this attempt's page.
    for (const elsewhere of [
      { ...away, tabId: top.tabId + 1 },
      { ...away, frameId: 3 },
    ])
      expect(
        transitionLoginAttempt(awaiting, { type: "NAVIGATED", document: elsewhere }),
      ).toMatchObject({ state: "blocked", outcome: "cancelled" });
    // A framed attempt is cancelled by any page outside its scope, as before.
    const framed = transitionLoginAttempt(submitting(), {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    for (const elsewhere of [away, { ...away, frameId: document.frameId }])
      expect(
        transitionLoginAttempt(framed, { type: "NAVIGATED", document: elsewhere }),
      ).toMatchObject({ state: "blocked", outcome: "cancelled" });
  });

  it("values the page would not accept end the attempt without a retry", () => {
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
    for (const stale of [
      { type: "VALUE_REJECTED", operationId: "fill-two", document, stage: "before-fill" },
      {
        type: "VALUE_REJECTED",
        operationId: "fill-one",
        document: { ...document, documentId: "x" },
        stage: "after-fill",
      },
    ])
      expect(transitionLoginAttempt(intent, stale)).toEqual(intent);
    const mismatch = transitionLoginAttempt(intent, {
      type: "VALUE_REJECTED",
      operationId: "fill-one",
      document,
      stage: "before-fill",
    });
    expect(mismatch).toMatchObject({ state: "blocked", outcome: "value-mismatch", submissions: 0 });
    expect(mismatch.mutationIntent).toBeUndefined();
    expect(transitionLoginAttempt(mismatch, { type: "RETRY" })).toEqual(mismatch);
    const rejected = transitionLoginAttempt(intent, {
      type: "VALUE_REJECTED",
      operationId: "fill-one",
      document,
      stage: "after-fill",
    });
    // The fill happened, so the attempt keeps its mutation intent.
    expect(rejected).toMatchObject({
      state: "blocked",
      outcome: "fill-rejected",
      mutationIntent: true,
    });
    // An input-triggered fill gives back its submission only when nothing was filled.
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
    let submit = transitionLoginAttempt(detected(inputRecipe), { type: "RESOLVE" });
    submit = transitionLoginAttempt(submit, {
      type: "PREPARE",
      kind: "fill",
      effect: "submit",
      operationId: "input-one",
    });
    submit = transitionLoginAttempt(submit, { type: "MUTATION_INTENT", operationId: "input-one" });
    expect(
      transitionLoginAttempt(submit, {
        type: "VALUE_REJECTED",
        operationId: "input-one",
        document,
        stage: "before-fill",
      }),
    ).toMatchObject({ state: "blocked", outcome: "value-mismatch", submissions: 0 });
    // It was submitted by its own event, so no after-fill check applies to it.
    expect(
      transitionLoginAttempt(submit, {
        type: "VALUE_REJECTED",
        operationId: "input-one",
        document,
        stage: "after-fill",
      }),
    ).toEqual(submit);
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

  it("takes back an undelivered operation's effect when the policy is revoked", () => {
    const ready = transitionLoginAttempt(detected(), { type: "RESOLVE" });
    const prepared = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "click-one",
      kind: "click",
    });
    const intent = transitionLoginAttempt(prepared, {
      type: "SUBMIT_INTENT",
      operationId: "click-one",
    });
    expect(intent).toMatchObject({ submissions: 1, mutationIntent: true });
    const revoked = transitionLoginAttempt(intent, {
      type: "POLICY_CHANGED",
      undelivered: "click-one",
    });
    expect(revoked).toMatchObject({ state: "blocked", outcome: "policy-changed", submissions: 0 });
    expect(revoked.mutationIntent).toBeUndefined();
    expect(revoked.operationId).toBeUndefined();
    expect(revoked.usedOperationIds).toContain("click-one");
    // A submitting fill reserved a submission; a preparing one did not.
    for (const [effect, submissions] of [
      ["submit", 0],
      ["prepare", 0],
    ] as const) {
      const fill = transitionLoginAttempt(
        transitionLoginAttempt(ready, {
          type: "PREPARE",
          operationId: "fill-one",
          kind: "fill",
          effect,
        }),
        { type: "MUTATION_INTENT", operationId: "fill-one" },
      );
      expect(fill.submissions).toBe(effect === "submit" ? 1 : 0);
      expect(
        transitionLoginAttempt(fill, { type: "POLICY_CHANGED", undelivered: "fill-one" }),
      ).toMatchObject({ state: "blocked", submissions, mutationIntent: undefined });
    }
    // Another operation's name leaves the reserved effect in place.
    expect(
      transitionLoginAttempt(intent, { type: "POLICY_CHANGED", undelivered: "other-one" }),
    ).toMatchObject({ state: "blocked", submissions: 1, mutationIntent: true });
  });
});

describe("second-factor handlers in an attempt (ADR 0027)", () => {
  const securityKey = { by: "text", value: "Use security key" } as const;
  const handled: LoginRecipe = {
    ...recipe,
    handlers: [
      { kind: "passkey", path: "/webauthn", target: securityKey },
      { kind: "passkey", path: "/login", target: { by: "id", value: "use-key" } },
    ],
  };
  const factsWithKey = { ...facts, passkey: true };
  const webauthn = { ...document, documentId: "document-webauthn" };
  const handler = (index = 0, change: Record<string, unknown> = {}) => ({
    type: "HANDLER" as const,
    handler: index,
    steps: 1,
    effects: 1,
    document: webauthn,
    ...change,
  });
  function awaiting(selected = handled) {
    let attempt = transitionLoginAttempt(
      createAttemptMetadata({
        id: "attempt-one",
        recipe: selected,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "password", variant: 0 },
        facts: factsWithKey,
        document,
      }),
      { type: "RESOLVE" },
    );
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
    attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "click-one",
      kind: "click",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "click-one" });
    return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "click-one" });
  }

  it("records the route, the item's facts and no entered handler at the start", () => {
    const attempt = createAttemptMetadata({
      id: "attempt-one",
      recipe: handled,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      choice: { route: "password", variant: 0 },
      facts: factsWithKey,
      document,
    });
    expect(attempt).toMatchObject({
      route: "password",
      variant: 0,
      facts: factsWithKey,
      handlers: [],
      // Only the route's steps; a handler's steps join when it is entered.
      stepCount: 2,
      maxSubmissions: 1,
    });
    expect(parseAttemptMetadata(attempt)).toEqual(attempt);
    for (const malformed of [
      { ...attempt, route: "passkey" },
      { ...attempt, variant: undefined },
      { ...attempt, variant: 4 },
      { ...attempt, facts: { ...facts, sso: true } },
      { ...attempt, facts: { password: true } },
      {
        ...attempt,
        handlers: [
          { index: 0, start: 2 },
          { index: 0, start: 3 },
        ],
      },
      {
        ...attempt,
        handlers: Array.from({ length: 5 }, (_, index) => ({ index, start: index + 2 })),
      },
      { ...attempt, handlers: [{ index: 16, start: 2 }] },
      { ...attempt, stepCount: 41 },
      { ...attempt, maxSubmissions: 13 },
    ])
      expect(() => parseAttemptMetadata(malformed)).toThrow();
  });

  it("enters a handler after the final submission and grows the attempt's budget", () => {
    const before = awaiting();
    expect(before).toMatchObject({ state: "awaiting-result", stepIndex: 1, submissions: 1 });
    const entered = transitionLoginAttempt(before, handler());
    expect(entered).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 3,
      submissions: 1,
      maxSubmissions: 2,
      handlers: [{ index: 0, start: 2 }],
      document: webauthn,
    });
    expect(entered.operationId).toBeUndefined();
    expect(entered.outcome).toBeUndefined();
    // The handler's click is the attempt's next operation, in the handler's document.
    const operation = nextLoginOperation(entered, handled, webauthn, "key-one", 1000)!;
    expect(operation).toMatchObject({
      stepIndex: 2,
      step: { kind: "click", path: "/webauthn", target: securityKey, purpose: "submit" },
      document: webauthn,
    });
    expect(nextLoginOperation(entered, handled, document, "key-one")).toBeUndefined();
    // Its submission fits the grown budget.
    let clicking = transitionLoginAttempt(entered, {
      type: "PREPARE",
      operationId: "key-one",
      kind: "click",
    });
    clicking = transitionLoginAttempt(clicking, { type: "SUBMIT_INTENT", operationId: "key-one" });
    expect(clicking).toMatchObject({ state: "submit-intent", submissions: 2 });
    expect(validateLoginOperation(operation, clicking, webauthn, 3, 1001)).toBe(true);
    const signedIn = transitionLoginAttempt(
      transitionLoginAttempt(clicking, { type: "SUBMITTED", operationId: "key-one" }),
      { type: "OBSERVED", result: "authenticated", document: webauthn },
    );
    expect(signedIn.state).toBe("authenticated");
  });

  it("enters a handler while reconciling after the page navigated", () => {
    const navigated = transitionLoginAttempt(awaiting(), { type: "NAVIGATED", document: webauthn });
    expect(navigated).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
    const entered = transitionLoginAttempt(navigated, handler());
    expect(entered).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 3,
      maxSubmissions: 2,
      handlers: [{ index: 0, start: 2 }],
    });
    expect(entered.outcome).toBeUndefined();
    expect(nextLoginOperation(entered, handled, webauthn, "key-one")?.stepIndex).toBe(2);
  });

  it("runs each handler at most once per login", () => {
    const entered = transitionLoginAttempt(awaiting(), handler());
    let clicked = transitionLoginAttempt(entered, {
      type: "PREPARE",
      operationId: "key-one",
      kind: "click",
    });
    clicked = transitionLoginAttempt(clicked, { type: "SUBMIT_INTENT", operationId: "key-one" });
    clicked = transitionLoginAttempt(clicked, { type: "SUBMITTED", operationId: "key-one" });
    expect(clicked.state).toBe("awaiting-result");
    expect(transitionLoginAttempt(clicked, handler())).toEqual(clicked);
    // Another handler of the recipe may still follow the handler's click.
    expect(transitionLoginAttempt(clicked, handler(1))).toMatchObject({
      state: "ready",
      handlers: [
        { index: 0, start: 2 },
        { index: 1, start: 3 },
      ],
      stepCount: 4,
      maxSubmissions: 3,
    });
  });

  it("refuses a handler outside the result of an effect step", () => {
    // Not from `ready`: nothing was submitted for the handler to follow.
    const ready = transitionLoginAttempt(detected(handled), { type: "RESOLVE" });
    expect(transitionLoginAttempt(ready, handler())).toEqual(ready);
    // Not after a preparing fill whose result is reconciled.
    const filling = transitionLoginAttempt(
      transitionLoginAttempt(ready, { type: "PREPARE", operationId: "fill-one", kind: "fill" }),
      { type: "MUTATION_INTENT", operationId: "fill-one" },
    );
    const interrupted = transitionLoginAttempt(filling, { type: "INTERRUPTED" });
    expect(interrupted.state).toBe("reconciling");
    expect(transitionLoginAttempt(interrupted, handler())).toEqual(interrupted);
    // Not in another tab or frame, or on another origin.
    const before = awaiting();
    for (const elsewhere of [
      { ...webauthn, tabId: 8 },
      { ...webauthn, frameId: 0 },
      { ...webauthn, origin: "https://evil.example" },
    ])
      expect(transitionLoginAttempt(before, handler(0, { document: elsewhere }))).toEqual(before);
    // Not once the attempt ended.
    for (const result of ["authenticated", "challenge"] as const) {
      const ended = transitionLoginAttempt(before, { type: "OBSERVED", result, document });
      expect(transitionLoginAttempt(ended, handler())).toEqual(ended);
    }
  });

  it("refuses a handler beyond the attempt's step, submission and handler caps", () => {
    const before = awaiting();
    const roomy = { ...before, stepCount: 36, maxSubmissions: 10 };
    expect(transitionLoginAttempt(roomy, handler(0, { steps: 4, effects: 2 }))).toMatchObject({
      state: "ready",
      stepCount: 40,
      maxSubmissions: 12,
    });
    const steps = { ...before, stepCount: 37 };
    expect(transitionLoginAttempt(steps, handler(0, { steps: 4 }))).toEqual(steps);
    const effects = { ...before, maxSubmissions: 11 };
    expect(transitionLoginAttempt(effects, handler(0, { effects: 2 }))).toEqual(effects);
    const many = {
      ...before,
      handlers: [2, 3, 4, 5].map((index) => ({ index, start: 1 })),
    };
    expect(transitionLoginAttempt(many, handler())).toEqual(many);
    // The event itself is bounded.
    for (const malformed of [
      handler(0, { steps: 0 }),
      handler(0, { steps: 5 }),
      handler(0, { effects: 0 }),
      handler(16),
    ])
      expect(() => transitionLoginAttempt(before, malformed)).toThrow();
  });

  it("counts at most two judged pages per effect step, across later documents", () => {
    const before = awaiting();
    const judging = { type: "JUDGING" as const, operationId: "click-one" };
    const unjudged = { type: "UNJUDGED" as const, operationId: "click-one" };
    const first = transitionLoginAttempt(before, judging);
    expect(first).toEqual({ ...before, judged: { operationId: "click-one", pages: 1 } });
    // A page no model saw is given back; nothing is given back below zero.
    expect(transitionLoginAttempt(first, unjudged)).toEqual({
      ...before,
      judged: { operationId: "click-one", pages: 0 },
    });
    expect(transitionLoginAttempt(before, unjudged)).toEqual(before);
    // Only the current effect step is judged.
    expect(transitionLoginAttempt(before, { type: "JUDGING", operationId: "fill-one" })).toEqual(
      before,
    );
    const unknown = transitionLoginAttempt(first, {
      type: "OBSERVED",
      result: "unknown",
      document,
    });
    const moved = transitionLoginAttempt(unknown, { type: "NAVIGATED", document: webauthn });
    expect(moved).toMatchObject({ state: "reconciling", judged: { pages: 1 } });
    const second = transitionLoginAttempt(moved, judging);
    expect(second).toMatchObject({ judged: { operationId: "click-one", pages: 2 } });
    expect(judgedPages(second, "click-one")).toBe(MAX_JUDGED_PAGES);
    expect(transitionLoginAttempt(second, judging)).toEqual(second);
    expect(() =>
      parseAttemptMetadata({ ...before, judged: { operationId: "never-used", pages: 1 } }),
    ).toThrow();
    expect(() =>
      parseAttemptMetadata({ ...before, judged: { operationId: "click-one", pages: 3 } }),
    ).toThrow();
  });

  it("marks a result settled as unknown until the attempt moves on", () => {
    const unknown = transitionLoginAttempt(awaiting(), {
      type: "OBSERVED",
      result: "unknown",
      document,
    });
    expect(unknown).toMatchObject({ state: "reconciling", settled: true });
    // A new document or a restart keeps it settled.
    const navigated = transitionLoginAttempt(unknown, { type: "NAVIGATED", document: webauthn });
    expect(recoverLoginAttempt(navigated)).toMatchObject({ settled: true });
    // Entering a handler on the new page moves the attempt on.
    expect(transitionLoginAttempt(navigated, handler())).toMatchObject({ state: "ready" });
    expect(transitionLoginAttempt(navigated, handler())).not.toHaveProperty("settled", true);
    // A result still being reconciled after a restart has not settled.
    expect(recoverLoginAttempt(awaiting())).not.toHaveProperty("settled", true);
  });

  it("takes over only a newer recipe revision", () => {
    const before = awaiting();
    expect(transitionLoginAttempt(before, { type: "REVISED", recipeRevision: 3 })).toEqual({
      ...before,
      recipeRevision: 3,
    });
    for (const recipeRevision of [2, 1])
      expect(transitionLoginAttempt(before, { type: "REVISED", recipeRevision })).toEqual(before);
    // A revised attempt issues operations only for the revision it took over.
    const revised = transitionLoginAttempt(
      transitionLoginAttempt(before, { type: "REVISED", recipeRevision: 3 }),
      handler(),
    );
    expect(nextLoginOperation(revised, handled, webauthn, "key-one")).toBeUndefined();
    expect(
      nextLoginOperation(revised, { ...handled, revision: 3 }, webauthn, "key-one"),
    ).toMatchObject({ stepIndex: 2 });
  });

  it("refuses an operation when the recorded handlers do not match the recipe", () => {
    // The event's step count disagrees with the handler's own steps.
    const mismatched = transitionLoginAttempt(awaiting(), handler(0, { steps: 2 }));
    expect(mismatched.stepCount).toBe(4);
    expect(nextLoginOperation(mismatched, handled, webauthn, "key-one")).toBeUndefined();
    // The recipe lacks the entered handler.
    const entered = transitionLoginAttempt(awaiting(), handler(1));
    expect(
      nextLoginOperation(entered, { ...handled, handlers: [handled.handlers![0]!] }, webauthn, "k"),
    ).toBeUndefined();
    expect(attemptPlan({ ...handled, handlers: undefined }, entered)).toBeUndefined();
  });

  it("continues the route's next step after a handler entered mid-route", () => {
    const threeStep: LoginRecipe = {
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
      handlers: [{ kind: "passkey", path: "/identity", target: securityKey }],
    };
    let attempt = transitionLoginAttempt(detected(threeStep), { type: "RESOLVE" });
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
    attempt = transitionLoginAttempt(attempt, handler());
    expect(attempt).toMatchObject({
      state: "ready",
      stepIndex: 1,
      stepCount: 4,
      maxSubmissions: 3,
      handlers: [{ index: 0, start: 1 }],
    });
    expect(
      attemptPlan(threeStep, attempt)?.map((entry) => [entry.step.kind, entry.handler]),
    ).toEqual([
      ["click", undefined],
      ["click", 0],
      ["fill", undefined],
      ["click", undefined],
    ]);
    expect(nextLoginOperation(attempt, threeStep, webauthn, "key-one")).toMatchObject({
      stepIndex: 1,
      step: { kind: "click", target: securityKey },
    });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "key-one",
      kind: "click",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "key-one" });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "key-one" });
    const passwordPage = { ...document, documentId: "document-password" };
    attempt = transitionLoginAttempt(attempt, {
      type: "OBSERVED",
      result: "continue",
      document: passwordPage,
    });
    expect(attempt).toMatchObject({ state: "ready", stepIndex: 2, submissions: 2 });
    expect(nextLoginOperation(attempt, threeStep, passwordPage, "fill-one")).toMatchObject({
      stepIndex: 2,
      step: { kind: "fill", path: "/login" },
    });
  });
});

describe("the totp handler in an attempt (ADR 0027)", () => {
  const code = {
    kind: "totp",
    path: "/two-factor",
    field: { by: "id", value: "otp" },
    target: { by: "text", value: "Verify" },
  } as const;
  const coded: LoginRecipe = { ...recipe, handlers: [code] };
  const codePage = { ...document, documentId: "document-code" };
  /** After the route's click, with the handler's fill and click entered. */
  function entered() {
    let attempt = transitionLoginAttempt(detected(coded), { type: "RESOLVE" });
    for (const [operationId, kind] of [
      ["fill-one", "fill"],
      ["click-one", "click"],
    ] as const) {
      attempt = transitionLoginAttempt(attempt, { type: "PREPARE", operationId, kind });
      attempt = transitionLoginAttempt(attempt, {
        type: kind === "fill" ? "MUTATION_INTENT" : "SUBMIT_INTENT",
        operationId,
      });
      if (kind === "fill")
        attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId });
    }
    attempt = transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "click-one" });
    return transitionLoginAttempt(attempt, {
      type: "HANDLER",
      handler: 0,
      steps: 2,
      effects: 1,
      document: codePage,
    });
  }
  function filling(attempt = entered()) {
    const prepared = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "code-one",
      kind: "fill",
    });
    return transitionLoginAttempt(prepared, { type: "MUTATION_INTENT", operationId: "code-one" });
  }

  it("fills the code and clicks its button as the handler's two steps", () => {
    const attempt = entered();
    expect(attempt).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 4,
      maxSubmissions: 2,
    });
    expect(attemptPlan(coded, attempt)?.slice(2)).toEqual([
      {
        step: {
          kind: "fill",
          path: "/two-factor",
          fields: [{ slot: "totp", target: { by: "id", value: "otp" } }],
          effect: "prepare",
        },
        handler: 0,
      },
      {
        step: { kind: "click", path: "/two-factor", target: code.target, purpose: "submit" },
        handler: 0,
      },
    ]);
    expect(handlerSlots(coded, attempt)).toEqual(["totp"]);
    expect(handlerSlots(coded, detected(coded))).toEqual([]);
  });

  it("counts a code the route fills or a handler typed as the login's one code", () => {
    expect(attemptUsesCode(coded, detected(coded))).toBe(false);
    expect(attemptUsesCode(coded, entered())).toBe(true);
    const withCode: LoginRecipe = {
      ...coded,
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
        recipe.steps[1]!,
      ],
    };
    expect(attemptUsesCode(withCode, detected(withCode))).toBe(true);
  });

  it("takes the page's own submission after the code fill as the handler's click", () => {
    const filled = transitionLoginAttempt(filling(), {
      type: "OPERATION_OK",
      operationId: "code-one",
    });
    expect(filled).toMatchObject({ state: "ready", stepIndex: 3, submissions: 1 });
    const submitted = transitionLoginAttempt(filled, {
      type: "AUTO_SUBMITTED",
      operationId: "page-one",
    });
    expect(submitted).toMatchObject({
      state: "reconciling",
      stepIndex: 3,
      operationId: "page-one",
      operationKind: "click",
      operationEffect: "submit",
      mutationIntent: true,
      submissions: 2,
    });
    expect(submitted.usedOperationIds).toContain("page-one");
    // The page is settled as after a click, and judged as after one.
    expect(
      transitionLoginAttempt(submitted, { type: "JUDGING", operationId: "page-one" }).judged,
    ).toEqual({ operationId: "page-one", pages: 1 });
    expect(
      transitionLoginAttempt(submitted, {
        type: "OBSERVED",
        result: "authenticated",
        document: codePage,
      }).state,
    ).toBe("authenticated");
    // Nothing is clicked or filled again.
    expect(nextLoginOperation(submitted, coded, codePage, "click-two")).toBeUndefined();
  });

  it("takes it while the code fill is unanswered, as a new document finds it", () => {
    for (const before of [filling(), recoverLoginAttempt(filling())]) {
      const submitted = transitionLoginAttempt(before, {
        type: "AUTO_SUBMITTED",
        operationId: "page-one",
      });
      expect(submitted).toMatchObject({
        state: "reconciling",
        stepIndex: 3,
        operationKind: "click",
        submissions: 2,
      });
      const resumed = transitionLoginAttempt(submitted, { type: "NAVIGATED", document: codePage });
      expect(resumed).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
    }
  });

  it("refuses the page's submission outside a code fill and its click", () => {
    const submitted = (attempt: ReturnType<typeof entered>) =>
      transitionLoginAttempt(attempt, { type: "AUTO_SUBMITTED", operationId: "page-one" });
    // Before any fill was intended.
    const prepared = transitionLoginAttempt(entered(), {
      type: "PREPARE",
      operationId: "code-one",
      kind: "fill",
    });
    expect(submitted(prepared)).toEqual(prepared);
    // After the click ran, or once the budget is spent.
    const clicked = transitionLoginAttempt(
      transitionLoginAttempt(
        transitionLoginAttempt(
          transitionLoginAttempt(filling(), { type: "OPERATION_OK", operationId: "code-one" }),
          { type: "PREPARE", operationId: "verify-one", kind: "click" },
        ),
        { type: "SUBMIT_INTENT", operationId: "verify-one" },
      ),
      { type: "SUBMITTED", operationId: "verify-one" },
    );
    expect(submitted(clicked)).toEqual(clicked);
    const spent = parseAttemptMetadata({
      ...transitionLoginAttempt(filling(), { type: "OPERATION_OK", operationId: "code-one" }),
      submissions: 2,
    });
    expect(submitted(spent)).toEqual(spent);
    // A reused operation ID never counts.
    const filled = transitionLoginAttempt(filling(), {
      type: "OPERATION_OK",
      operationId: "code-one",
    });
    expect(
      transitionLoginAttempt(filled, { type: "AUTO_SUBMITTED", operationId: "code-one" }),
    ).toEqual(filled);
  });

  it("refuses the page's submission on the route's own steps", () => {
    const submitted = (attempt: ReturnType<typeof entered>) =>
      transitionLoginAttempt(attempt, { type: "AUTO_SUBMITTED", operationId: "page-one" });
    // The route's fill, in flight and answered, before the route's click.
    let attempt = transitionLoginAttempt(detected(coded), { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
    expect(attempt).toMatchObject({ state: "executing", operationKind: "fill" });
    expect(submitted(attempt)).toEqual(attempt);
    attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
    expect(attempt).toMatchObject({ state: "ready", stepIndex: 1 });
    expect(submitted(attempt)).toEqual(attempt);
    // The handler entered, before its fill: its click is not next yet.
    const ready = entered();
    expect(ready).toMatchObject({ state: "ready", stepIndex: 2 });
    expect(submitted(ready)).toEqual(ready);
  });
});

describe("password route variants in an attempt (ADR 0027)", () => {
  const contract = {
    slots: ["contract"],
    steps: [
      {
        kind: "fill" as const,
        effect: "prepare" as const,
        path: "/login",
        fields: [{ slot: "contract", target: { by: "id" as const, value: "contract" } }],
      },
      {
        kind: "wait" as const,
        path: "/login",
        target: { by: "id" as const, value: "login" },
        present: true,
        timeoutMs: 1000,
      },
      {
        kind: "click" as const,
        path: "/login",
        target: { by: "id" as const, value: "login" },
        purpose: "submit" as const,
      },
    ],
  };
  const varied: LoginRecipe = { ...recipe, alternatives: [contract] };
  const create = (variant: number) =>
    createAttemptMetadata({
      id: "attempt-variant",
      recipe: varied,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      choice: { route: "password", variant },
      facts,
      document,
    });

  it("records the chosen variant and runs only its steps", () => {
    const attempt = create(1);
    expect(attempt).toMatchObject({ route: "password", variant: 1, stepCount: 3 });
    expect(attemptRouteChoice(attempt)).toEqual({ route: "password", variant: 1 });
    expect(attemptPlan(varied, attempt)?.map(({ step }) => step)).toEqual(contract.steps);
    const ready = transitionLoginAttempt(attempt, { type: "RESOLVE" });
    expect(nextLoginOperation(ready, varied, document, "operation-one", 0)?.step).toEqual(
      contract.steps[0],
    );
    expect(create(0)).toMatchObject({ variant: 0, stepCount: 2 });
    expect(attemptPlan(varied, create(0))?.map(({ step }) => step)).toEqual(recipe.steps);
  });

  it("refuses a variant the recipe lacks", () => {
    expect(() => create(2)).toThrow();
    expect(() => create(-1)).toThrow();
  });
});

describe("the passkey route in an attempt (ADR 0027)", () => {
  const button = { by: "id" as const, value: "passkey-login" };
  const withPasskey: LoginRecipe = { ...recipe, passkey: { path: "/login", target: button } };
  const create = (choice: Parameters<typeof createAttemptMetadata>[0]["choice"]) =>
    createAttemptMetadata({
      id: "attempt-passkey",
      recipe: withPasskey,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      choice,
      facts: { ...facts, passkey: true, discoverablePasskey: true },
      document,
    });

  it("records the route without a variant and runs its one click", () => {
    const attempt = create({ route: "passkey" });
    expect(attempt).toMatchObject({ route: "passkey", stepCount: 1, maxSubmissions: 1 });
    expect(attempt).not.toHaveProperty("variant");
    expect(attemptRouteChoice(attempt)).toEqual({ route: "passkey" });
    const click = { kind: "click", path: "/login", target: button, purpose: "submit" };
    expect(attemptPlan(withPasskey, attempt)?.map(({ step }) => step)).toEqual([click]);
    const ready = transitionLoginAttempt(attempt, { type: "RESOLVE" });
    const operation = nextLoginOperation(ready, withPasskey, document, "operation-one", 0);
    expect(operation?.step).toEqual(click);
    // The click is a submission: it needs its intent journaled first.
    let clicking = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "operation-one",
      kind: "click",
    });
    clicking = transitionLoginAttempt(clicking, {
      type: "SUBMIT_INTENT",
      operationId: "operation-one",
    });
    expect(clicking).toMatchObject({ state: "submit-intent", submissions: 1 });
    // The password route's variant stays its own.
    expect(create({ route: "password", variant: 0 })).toMatchObject({
      route: "password",
      variant: 0,
      stepCount: 2,
    });
  });

  it("has a variant exactly when the route is the password route", () => {
    const passkey = create({ route: "passkey" });
    const password = create({ route: "password", variant: 0 });
    expect(() => parseAttemptMetadata({ ...passkey, variant: 0 })).toThrow();
    expect(() => parseAttemptMetadata({ ...password, variant: undefined })).toThrow();
    expect(parseAttemptMetadata(passkey)).toEqual(passkey);
  });

  it("refuses the route for a recipe without it", () => {
    expect(() =>
      createAttemptMetadata({
        id: "attempt-passkey",
        recipe,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "passkey" },
        facts,
        document,
      }),
    ).toThrow();
  });
});

describe("totp handler attempt contracts, probed independently (ADR 0027)", () => {
  const verify = { by: "text", value: "Verify" } as const;
  const code = {
    kind: "totp",
    path: "/login",
    field: { by: "id", value: "otp" },
    target: verify,
  } as const;
  const key = { kind: "passkey", path: "/webauthn", target: { by: "id", value: "key" } } as const;
  /** A two-page route; the code form shows on the first page after its advance click. */
  const twoPages: LoginRecipe = {
    ...recipe,
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [{ slot: "username", target: { by: "id", value: "username" } }],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
      {
        kind: "fill",
        effect: "prepare",
        path: "/password",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/password", target: { by: "id", value: "go" }, purpose: "submit" },
    ],
    handlers: [code, key],
    maxSubmissions: 2,
  };
  const codePage = { ...document, documentId: "document-code" };
  const run = (attempt: LoginAttemptMetadataLike, events: Record<string, unknown>[]) =>
    events.reduce<LoginAttemptMetadataLike>(
      (current, event) => transitionLoginAttempt(current, event),
      attempt,
    );
  const fill = (operationId: string) => [
    { type: "PREPARE", operationId, kind: "fill" },
    { type: "MUTATION_INTENT", operationId },
    { type: "OPERATION_OK", operationId },
  ];
  const click = (operationId: string) => [
    { type: "PREPARE", operationId, kind: "click" },
    { type: "SUBMIT_INTENT", operationId },
    { type: "SUBMITTED", operationId },
  ];
  const enter = (handler: number, steps: number) => ({
    type: "HANDLER",
    handler,
    steps,
    effects: 1,
    document: codePage,
  });
  /** After the route's advance click, with the totp handler entered at step 2. */
  const entered = () =>
    run(transitionLoginAttempt(detected(twoPages), { type: "RESOLVE" }), [
      ...fill("fill-one"),
      ...click("click-one"),
      enter(0, 2),
    ]);
  const autoSubmitted = { type: "AUTO_SUBMITTED", operationId: "page-one" } as const;

  it("inserts two steps and one effect where the handler was entered, before the route's rest", () => {
    const attempt = entered();
    expect(attempt).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 6,
      maxSubmissions: 3,
      handlers: [{ index: 0, start: 2 }],
    });
    const plan = attemptPlan(twoPages, attempt)!;
    expect(plan.map((entry) => [entry.step.kind, entry.step.path, entry.handler])).toEqual([
      ["fill", "/login", undefined],
      ["click", "/login", undefined],
      ["fill", "/login", 0],
      ["click", "/login", 0],
      ["fill", "/password", undefined],
      ["click", "/password", undefined],
    ]);
    expect(nextLoginOperation(attempt, twoPages, codePage, "code-one")?.step).toEqual(
      plan[2]!.step,
    );
  });

  it("names the totp slot once, whichever other handlers the attempt entered", () => {
    const keyFirst = run(transitionLoginAttempt(detected(twoPages), { type: "RESOLVE" }), [
      ...fill("fill-one"),
      ...click("click-one"),
      { ...enter(1, 1), document: codePage },
    ]);
    expect(handlerSlots(twoPages, keyFirst)).toEqual([]);
    expect(attemptUsesCode(twoPages, keyFirst)).toBe(false);
    const both = run(keyFirst, [...click("key-one"), enter(0, 2)]);
    expect(both.handlers).toEqual([
      { index: 1, start: 2 },
      { index: 0, start: 3 },
    ]);
    expect(handlerSlots(twoPages, both)).toEqual(["totp"]);
    expect(attemptUsesCode(twoPages, both)).toBe(true);
    expect(attemptPlan(twoPages, both)!.map((entry) => entry.handler)).toEqual([
      undefined,
      undefined,
      1,
      0,
      0,
      undefined,
      undefined,
    ]);
    // An entered index the recipe no longer has names no slot.
    expect(handlerSlots(twoPages, { handlers: [{ index: 5, start: 2 }] })).toEqual([]);
  });

  it("counts a code only on the variant whose slots include it, and never on the passkey route", () => {
    const varied: LoginRecipe = {
      ...recipe,
      alternatives: [
        {
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
            recipe.steps[1]!,
          ],
        },
      ],
      passkey: { path: "/login", target: { by: "id", value: "passkey-login" } },
    };
    const meta = (route: "password" | "passkey", variant?: number) => ({
      route,
      ...(variant === undefined ? {} : { variant }),
      handlers: [],
    });
    expect(attemptUsesCode(varied, meta("password", 0))).toBe(false);
    expect(attemptUsesCode(varied, meta("password", 1))).toBe(true);
    expect(attemptUsesCode(varied, meta("passkey"))).toBe(false);
  });

  it("refuses the page's submission once the click was prepared or sent", () => {
    const filled = run(entered(), fill("code-one"));
    const preparing = transitionLoginAttempt(filled, {
      type: "PREPARE",
      operationId: "verify-one",
      kind: "click",
    });
    expect(transitionLoginAttempt(preparing, autoSubmitted)).toEqual(preparing);
    const sending = transitionLoginAttempt(preparing, {
      type: "SUBMIT_INTENT",
      operationId: "verify-one",
    });
    expect(transitionLoginAttempt(sending, autoSubmitted)).toEqual(sending);
  });

  it("takes the page's submission once only", () => {
    const once = transitionLoginAttempt(run(entered(), fill("code-one")), autoSubmitted);
    expect(once).toMatchObject({ state: "reconciling", operationKind: "click", submissions: 2 });
    expect(
      transitionLoginAttempt(once, { type: "AUTO_SUBMITTED", operationId: "page-two" }),
    ).toEqual(once);
  });

  it("refuses the page's submission while a failed code fill awaits its retry", () => {
    const prepared = run(entered(), [{ type: "PREPARE", operationId: "code-one", kind: "fill" }]);
    // The content script proves nothing was typed.
    const failed = transitionLoginAttempt(prepared, {
      type: "FAILED",
      operationId: "code-one",
      reason: "structural-mismatch",
      mutation: "none",
      document: codePage,
    });
    expect(failed.state).toBe("retryable");
    expect(transitionLoginAttempt(failed, autoSubmitted)).toEqual(failed);
  });

  it("moves past the code to the route's next step and never fills the code again", () => {
    for (const before of [
      run(entered(), fill("code-one")),
      run(entered(), [
        { type: "PREPARE", operationId: "code-one", kind: "fill" },
        { type: "MUTATION_INTENT", operationId: "code-one" },
      ]),
    ]) {
      const submitted = transitionLoginAttempt(before, autoSubmitted);
      expect(submitted).toMatchObject({ state: "reconciling", stepIndex: 3, submissions: 2 });
      // The page asks for the password next, as after the handler's click.
      const next = transitionLoginAttempt(submitted, {
        type: "OBSERVED",
        result: "continue",
        document: codePage,
      });
      expect(next).toMatchObject({ state: "ready", stepIndex: 4 });
      const operation = nextLoginOperation(next, twoPages, codePage, "fill-two");
      expect(operation?.step).toEqual(twoPages.steps[2]);
      // The page's operation ID is spent.
      expect(
        transitionLoginAttempt(next, { type: "PREPARE", operationId: "page-one", kind: "fill" }),
      ).toEqual(next);
      // A restart afterwards keeps it as a possible submission.
      expect(recoverLoginAttempt(submitted)).toMatchObject({
        state: "reconciling",
        outcome: "unknown-submit",
      });
    }
  });

  // The page's own submission counts only between a handler's delivered code fill and its
  // click: right after HANDLER the code was never typed.
  it("refuses the page's submission before the code fill was prepared", () => {
    const attempt = entered();
    expect(transitionLoginAttempt(attempt, autoSubmitted)).toEqual(attempt);
  });
  it("refuses the page's submission once a failed code fill is retried", () => {
    const retrying = run(entered(), [
      { type: "PREPARE", operationId: "code-one", kind: "fill" },
      {
        type: "FAILED",
        operationId: "code-one",
        reason: "structural-mismatch",
        mutation: "none",
        document: codePage,
      },
      { type: "RETRY" },
    ]);
    expect(retrying).toMatchObject({ state: "ready", stepIndex: 2 });
    expect(transitionLoginAttempt(retrying, autoSubmitted)).toEqual(retrying);
  });

  // An attempt that entered no handler never takes the page's submission on a route step.
  it("refuses the page's submission on a route step when no handler was entered", () => {
    const routeClick = run(transitionLoginAttempt(detected(twoPages), { type: "RESOLVE" }), [
      ...fill("fill-one"),
    ]);
    expect(transitionLoginAttempt(routeClick, autoSubmitted)).toEqual(routeClick);
  });
});

type LoginAttemptMetadataLike = ReturnType<typeof transitionLoginAttempt>;

describe("a recipe continued after its final advance in an attempt (ADR 0018)", () => {
  const email = (selected: LoginRecipe["steps"]) => ({ ...recipe, revision: 1, steps: selected });
  // An email page that only advances; the password page is generated later.
  const first: LoginRecipe = {
    ...email([
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [{ slot: "username", target: { by: "id", value: "email" } }],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
    ]),
    slots: ["username"],
    completion: undefined,
  };
  const continued: LoginRecipe = {
    ...first,
    revision: 2,
    slots: ["username", "password"],
    steps: [
      ...first.steps,
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
  const passwordPage = { ...document, documentId: "document-password" };
  const continuing = { type: "CONTINUING" as const, operationId: "next-one" };
  const event = (change: Record<string, unknown> = {}) => ({
    type: "CONTINUED" as const,
    recipeRevision: 2,
    steps: 2,
    effects: 1,
    document: passwordPage,
    ...change,
  });
  function advanced() {
    let attempt = transitionLoginAttempt(detected(first), { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
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

  it("records one request per final advance before it is sent, and gives it back", () => {
    const before = advanced();
    expect(before).toMatchObject({ state: "awaiting-result", stepIndex: 1, stepCount: 2 });
    const sent = transitionLoginAttempt(before, continuing);
    expect(sent).toEqual({ ...before, continuation: { operationId: "next-one" } });
    // A second request for the same step is refused, also after a restart.
    expect(transitionLoginAttempt(sent, continuing)).toEqual(sent);
    expect(recoverLoginAttempt(sent)).toMatchObject({
      state: "reconciling",
      continuation: { operationId: "next-one" },
    });
    expect(transitionLoginAttempt(sent, { type: "UNCONTINUED", operationId: "next-one" })).toEqual(
      before,
    );
    expect(
      transitionLoginAttempt(before, { type: "UNCONTINUED", operationId: "next-one" }),
    ).toEqual(before);
    // Only the in-flight operation's page is sent.
    expect(transitionLoginAttempt(before, { ...continuing, operationId: "fill-one" })).toEqual(
      before,
    );
    expect(() =>
      parseAttemptMetadata({ ...before, continuation: { operationId: "never-used" } }),
    ).toThrow();
  });

  it("is never sent after a step that submits or before the final step", () => {
    const submitted = transitionLoginAttempt(submitting(), {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    expect(transitionLoginAttempt(submitted, { ...continuing, operationId: "click-one" })).toEqual(
      submitted,
    );
    // An advance that is not the route's last step continues with the recipe's own steps.
    let attempt = transitionLoginAttempt(detected(continued), { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
    attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "next-one",
      kind: "click",
      effect: "advance",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "next-one" });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "next-one" });
    expect(transitionLoginAttempt(attempt, continuing)).toEqual(attempt);
    // An advance that never got as far as its click has led to no page of its own.
    const { mutationIntent: _intent, ...unclicked } = advanced();
    const idle = { ...unclicked, submissions: 0 };
    expect(transitionLoginAttempt(idle, continuing)).toEqual(idle);
  });

  it("takes over the continued revision with its steps and effects", () => {
    const sent = transitionLoginAttempt(advanced(), continuing);
    const taken = transitionLoginAttempt(sent, event());
    expect(taken).toMatchObject({
      state: "ready",
      recipeRevision: 2,
      stepIndex: 2,
      stepCount: 4,
      submissions: 1,
      maxSubmissions: 2,
      document: passwordPage,
    });
    for (const key of ["operationId", "outcome", "continuation", "settled", "retryRequired"])
      expect(taken[key as keyof typeof taken]).toBeUndefined();
    // The next operation is the continued page's first step, never an earlier one.
    expect(nextLoginOperation(taken, continued, passwordPage, "password-one")).toMatchObject({
      stepIndex: 2,
      step: { kind: "fill", path: "/login/password" },
    });
    expect(nextLoginOperation(taken, first, passwordPage, "password-one")).toBeUndefined();
    // A settled result of a new document is taken over too.
    const navigated = transitionLoginAttempt(
      transitionLoginAttempt(sent, { type: "OBSERVED", result: "unknown", document }),
      { type: "NAVIGATED", document: passwordPage },
    );
    expect(navigated).toMatchObject({ state: "reconciling", settled: true });
    expect(transitionLoginAttempt(navigated, event())).toMatchObject({
      state: "ready",
      stepIndex: 2,
    });
  });

  it("refuses a revision without its request, an older one, or past the attempt's caps", () => {
    const before = advanced();
    const sent = transitionLoginAttempt(before, continuing);
    // No request was recorded for this step.
    expect(transitionLoginAttempt(before, event())).toEqual(before);
    for (const change of [
      { recipeRevision: 1 },
      // The attempt holds at most 40 steps and 12 submissions.
      { steps: 32, effects: 1 },
      { steps: 2, effects: 8 },
      // Another tab's document never takes it over.
      { document: { ...passwordPage, tabId: 8 } },
    ]) {
      const larger =
        "effects" in change && change.effects === 8
          ? parseAttemptMetadata({ ...sent, maxSubmissions: 5 })
          : "steps" in change && change.steps === 32
            ? parseAttemptMetadata({ ...sent, stepCount: 9, stepIndex: 8 })
            : sent;
      expect(transitionLoginAttempt(larger, event(change))).toEqual(larger);
    }
    for (const malformed of [{ steps: 0 }, { steps: 33 }, { effects: 0 }, { effects: 9 }])
      expect(() => transitionLoginAttempt(sent, event(malformed))).toThrow();
    // A recorded request for an earlier step does not count for this one.
    const stale = parseAttemptMetadata({ ...before, continuation: { operationId: "fill-one" } });
    expect(transitionLoginAttempt(stale, event())).toEqual(stale);
  });
});

describe("continuation guards, probed independently (ADR 0018)", () => {
  // An email page that fills the address and advances; the password page comes later.
  const first: LoginRecipe = {
    ...recipe,
    revision: 1,
    slots: ["username"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [{ slot: "username", target: { by: "id", value: "email" } }],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "next" }, purpose: "advance" },
    ],
    completion: undefined,
  };
  const passwordPage = { ...document, documentId: "document-password" };
  const continued = (change: Record<string, unknown> = {}) => ({
    type: "CONTINUED" as const,
    recipeRevision: 2,
    steps: 2,
    effects: 1,
    document: passwordPage,
    ...change,
  });
  const step = (
    attempt: LoginAttemptMetadataLike,
    events: Parameters<typeof transitionLoginAttempt>[1][],
  ) => events.reduce((current, event) => transitionLoginAttempt(current, event), attempt);
  /** Runs a fill and an advancing click with these operation IDs. */
  const fillAndAdvance = (attempt: LoginAttemptMetadataLike, fill: string, click: string) =>
    step(attempt, [
      { type: "PREPARE", operationId: fill, kind: "fill" },
      { type: "MUTATION_INTENT", operationId: fill },
      { type: "OPERATION_OK", operationId: fill },
      { type: "PREPARE", operationId: click, kind: "click", effect: "advance" },
      { type: "SUBMIT_INTENT", operationId: click },
      { type: "SUBMITTED", operationId: click },
    ]);
  const advanced = () =>
    fillAndAdvance(
      transitionLoginAttempt(detected(first), { type: "RESOLVE" }),
      "fill-one",
      "next-one",
    );
  const continuing = (operationId = "next-one") => ({ type: "CONTINUING" as const, operationId });
  const sent = () => transitionLoginAttempt(advanced(), continuing());

  it("accepts CONTINUING only in the states that wait on the advance's page", () => {
    let attempt = transitionLoginAttempt(detected(first), { type: "RESOLVE" });
    // Ready, executing and submit-intent ignore it, even for the operation in flight.
    expect(transitionLoginAttempt(attempt, continuing("fill-one"))).toEqual(attempt);
    attempt = step(attempt, [
      { type: "PREPARE", operationId: "fill-one", kind: "fill" },
      { type: "MUTATION_INTENT", operationId: "fill-one" },
      { type: "OPERATION_OK", operationId: "fill-one" },
      { type: "PREPARE", operationId: "next-one", kind: "click", effect: "advance" },
    ]);
    expect(attempt.state).toBe("executing");
    expect(transitionLoginAttempt(attempt, continuing())).toEqual(attempt);
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "next-one" });
    expect(attempt.state).toBe("submit-intent");
    expect(transitionLoginAttempt(attempt, continuing())).toEqual(attempt);
    // Awaiting the result and, once the page settled or navigated, reconciling accept it.
    const awaiting = transitionLoginAttempt(attempt, {
      type: "SUBMITTED",
      operationId: "next-one",
    });
    expect(transitionLoginAttempt(awaiting, continuing())).toMatchObject({
      state: "awaiting-result",
      continuation: { operationId: "next-one" },
    });
    const reconciling = transitionLoginAttempt(awaiting, {
      type: "NAVIGATED",
      document: passwordPage,
    });
    expect(reconciling.state).toBe("reconciling");
    expect(transitionLoginAttempt(reconciling, continuing())).toMatchObject({
      state: "reconciling",
      continuation: { operationId: "next-one" },
    });
  });

  it("refuses CONTINUING without the advance's mutation intent or a submission", () => {
    const before = advanced();
    expect(before).toMatchObject({ mutationIntent: true, submissions: 1 });
    const { mutationIntent: _intent, ...unclicked } = before;
    for (const record of [
      parseAttemptMetadata({ ...unclicked, state: "reconciling" }),
      parseAttemptMetadata({ ...before, state: "reconciling", submissions: 0 }),
    ])
      expect(transitionLoginAttempt(record, continuing())).toEqual(record);
    // With both, the same record accepts it.
    const reconciling = parseAttemptMetadata({ ...before, state: "reconciling" });
    expect(transitionLoginAttempt(reconciling, continuing()).continuation).toEqual({
      operationId: "next-one",
    });
  });

  it("refuses an older or equal revision and accepts any newer one", () => {
    // The attempt runs revision 3 of the recipe.
    const atThree = parseAttemptMetadata({ ...sent(), recipeRevision: 3 });
    for (const recipeRevision of [1, 2, 3])
      expect(transitionLoginAttempt(atThree, continued({ recipeRevision }))).toEqual(atThree);
    expect(transitionLoginAttempt(atThree, continued({ recipeRevision: 4 }))).toMatchObject({
      state: "ready",
      recipeRevision: 4,
    });
    expect(transitionLoginAttempt(atThree, continued({ recipeRevision: 40 }))).toMatchObject({
      state: "ready",
      recipeRevision: 40,
    });
  });

  it("accepts the step and submission limits reached exactly and refuses them exceeded", () => {
    // 8 steps in, at the final advance: 32 more reach the attempt's 40 steps exactly.
    const long = parseAttemptMetadata({ ...sent(), stepCount: 8, stepIndex: 7 });
    expect(transitionLoginAttempt(long, continued({ steps: 32 }))).toMatchObject({
      state: "ready",
      stepIndex: 8,
      stepCount: 40,
    });
    const longer = parseAttemptMetadata({ ...sent(), stepCount: 9, stepIndex: 8 });
    expect(transitionLoginAttempt(longer, continued({ steps: 32 }))).toEqual(longer);
    expect(transitionLoginAttempt(longer, continued({ steps: 31 }))).toMatchObject({
      state: "ready",
      stepCount: 40,
    });
    // 4 submissions allowed: 8 more effects reach the attempt's 12 exactly.
    const budget = parseAttemptMetadata({ ...sent(), maxSubmissions: 4 });
    expect(transitionLoginAttempt(budget, continued({ effects: 8 }))).toMatchObject({
      state: "ready",
      maxSubmissions: 12,
    });
    const over = parseAttemptMetadata({ ...sent(), maxSubmissions: 5 });
    expect(transitionLoginAttempt(over, continued({ effects: 8 }))).toEqual(over);
    expect(transitionLoginAttempt(over, continued({ effects: 7 }))).toMatchObject({
      maxSubmissions: 12,
    });
    // Both reached at once.
    const both = parseAttemptMetadata({ ...sent(), stepCount: 8, stepIndex: 7, maxSubmissions: 4 });
    expect(transitionLoginAttempt(both, continued({ steps: 32, effects: 8 }))).toMatchObject({
      state: "ready",
      stepCount: 40,
      maxSubmissions: 12,
    });
  });

  it("refuses a document of another frame or origin, and a second CONTINUED", () => {
    const once = sent();
    for (const elsewhere of [
      { ...passwordPage, frameId: 0 },
      { ...passwordPage, origin: "https://other.example" },
    ])
      expect(transitionLoginAttempt(once, continued({ document: elsewhere }))).toEqual(once);
    const taken = transitionLoginAttempt(once, continued());
    expect(taken.state).toBe("ready");
    expect(transitionLoginAttempt(taken, continued({ recipeRevision: 3 }))).toEqual(taken);
  });

  it("ignores every continuation event once the attempt ended", () => {
    const once = sent();
    const stopped = transitionLoginAttempt(once, { type: "POLICY_CHANGED" });
    expect(stopped.state).toBe("blocked");
    for (const event of [
      continuing(),
      { type: "UNCONTINUED" as const, operationId: "next-one" },
      continued(),
    ])
      expect(transitionLoginAttempt(stopped, event)).toEqual(stopped);
  });

  it("chains two continuations within the attempt's limits", () => {
    // Email, Next; member ID, Next; password, Log in.
    let attempt = transitionLoginAttempt(sent(), continued({ steps: 2, effects: 1 }));
    expect(attempt).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 4,
      maxSubmissions: 2,
    });
    attempt = fillAndAdvance(attempt, "member-one", "next-two");
    expect(attempt).toMatchObject({
      state: "awaiting-result",
      stepIndex: 3,
      submissions: 2,
      operationEffect: "advance",
    });
    // The first step's request does not count for the second.
    expect(attempt.continuation).toBeUndefined();
    expect(transitionLoginAttempt(attempt, continued({ recipeRevision: 3 }))).toEqual(attempt);
    expect(transitionLoginAttempt(attempt, continuing("next-one"))).toEqual(attempt);
    attempt = transitionLoginAttempt(attempt, continuing("next-two"));
    expect(attempt.continuation).toEqual({ operationId: "next-two" });
    // The revision taken over first is older now.
    expect(transitionLoginAttempt(attempt, continued({ recipeRevision: 2 }))).toEqual(attempt);
    attempt = transitionLoginAttempt(
      attempt,
      continued({ recipeRevision: 3, document: { ...passwordPage, documentId: "document-three" } }),
    );
    expect(attempt).toMatchObject({
      state: "ready",
      recipeRevision: 3,
      stepIndex: 4,
      stepCount: 6,
      submissions: 2,
      maxSubmissions: 3,
    });
    expect(parseAttemptMetadata(attempt)).toEqual(attempt);
  });
});
