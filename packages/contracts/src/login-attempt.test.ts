import { describe, expect, it } from "vitest";
import {
  addAttemptTime,
  attemptTimes,
  awaitPerson,
  followPage,
  personAnswered,
  attemptPlan,
  attemptRouteChoice,
  attemptUsesCode,
  createAttemptMetadata,
  handlerSlots,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  judgedPages,
  pagesLeft,
  MAX_JUDGED_PAGES,
  transitionLoginAttempt,
  validateLoginOperation,
  withdrawAccountSwitch,
} from "./login-attempt";
import {
  CHOOSER_ENTRY_TARGET,
  type LoginDocument,
  type LoginRecipe,
  type LoginStep,
} from "./login";

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
  pageKind: "sign-in",
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
  completion: [{ target: { by: "id", value: "authenticated" } }],
  rejection: { by: "id", value: "rejected" },
  maxSubmissions: 1,
};

/** A login that took no time before it started. */
const noTimeBefore = { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 };

function detected(selected = recipe) {
  return createAttemptMetadata({
    timing: noTimeBefore,
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
      timing: noTimeBefore,
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

  it("keeps unconfirmed completion through storage and recovery, without permitting resubmission", () => {
    const awaiting = transitionLoginAttempt(submitting(), {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    const ended = transitionLoginAttempt(awaiting, {
      type: "OBSERVED",
      result: "authenticated",
      document,
      unconfirmed: true,
    });
    const restored = recoverLoginAttempt(parseAttemptMetadata(JSON.parse(JSON.stringify(ended))));
    expect(restored).toMatchObject({
      state: "authenticated",
      outcome: "authenticated",
      unconfirmed: true,
    });
    expect(nextLoginOperation(restored, recipe, document, "click-again")).toBeUndefined();
    expect(() => parseAttemptMetadata({ ...awaiting, unconfirmed: true })).toThrow();
    expect(() =>
      transitionLoginAttempt(awaiting, {
        type: "OBSERVED",
        result: "unknown",
        unconfirmed: true,
      }),
    ).toThrow();
    const otherTab = transitionLoginAttempt(awaiting, {
      type: "OBSERVED",
      result: "authenticated",
      document: { ...document, tabId: 8 },
      unconfirmed: true,
    });
    expect(otherTab).toEqual(awaiting);
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
          timing: noTimeBefore,
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

  it("never settles as unknown a login with nothing possibly submitted (ADR 0022)", () => {
    const top: LoginDocument = { ...document, frameId: 0 };
    const next: LoginDocument = { ...top, documentId: "document-next" };
    const ready = transitionLoginAttempt(
      createAttemptMetadata({
        timing: noTimeBefore,
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
    let filled = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    filled = transitionLoginAttempt(filled, { type: "MUTATION_INTENT", operationId: "fill-one" });
    filled = transitionLoginAttempt(filled, { type: "OPERATION_OK", operationId: "fill-one" });
    // A new page of the origin, or a restarted worker, before the first step ran: a page
    // that does not show that step yet is no unknown result, since nothing was submitted.
    for (const [between, paused, page] of [
      [ready, transitionLoginAttempt(ready, { type: "NAVIGATED", document: next }), next],
      [ready, recoverLoginAttempt(ready), top],
    ] as const) {
      expect(paused).toMatchObject({ state: "reconciling", outcome: "interrupted" });
      const unknown = transitionLoginAttempt(
        paused,
        { type: "OBSERVED", result: "unknown", document: page },
        5000,
      );
      expect(unknown.settled).toBeUndefined();
      expect(unknown.watch).toBeUndefined();
      expect(unknown.outcome).not.toBe("unknown-submit");
      // The step goes on with its own bounded wait, as on any page.
      expect(unknown).toMatchObject({
        state: "ready",
        stepIndex: between.stepIndex,
        submissions: 0,
        document: page,
      });
      expect(nextLoginOperation(unknown, recipe, page, "step-again")).toMatchObject({
        stepIndex: between.stepIndex,
      });
    }
    // After a fill the person may have submitted the values themselves: such a page still
    // settles as unknown and is watched.
    const afterFill = transitionLoginAttempt(
      transitionLoginAttempt(filled, { type: "NAVIGATED", document: next }),
      { type: "OBSERVED", result: "unknown", document: next },
      5000,
    );
    expect(afterFill).toMatchObject({
      state: "reconciling",
      outcome: "unknown-submit",
      settled: true,
    });
  });

  it("treats a fill that confirmed it changed nothing as no possible submission (ADR 0022)", () => {
    const top: LoginDocument = { ...document, frameId: 0 };
    const away: LoginDocument = {
      origin: "https://other.example",
      tabId: top.tabId,
      frameId: 0,
      documentId: "document-away",
    };
    let filling = transitionLoginAttempt(
      createAttemptMetadata({
        timing: noTimeBefore,
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
    filling = transitionLoginAttempt(filling, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    filling = transitionLoginAttempt(filling, { type: "MUTATION_INTENT", operationId: "fill-one" });
    const failed = transitionLoginAttempt(filling, {
      type: "FAILED",
      reason: "structural-mismatch",
      mutation: "none",
      operationId: "fill-one",
      document: top,
    });
    expect(failed).toMatchObject({ state: "retryable", retryRequired: true, submissions: 0 });
    // Leaving the origin ends it `interrupted`, not `left-origin`.
    expect(transitionLoginAttempt(failed, { type: "NAVIGATED", document: away })).toMatchObject({
      state: "blocked",
      outcome: "interrupted",
    });
    // A restarted worker finds nothing in flight, and a page without the step is no
    // unknown result: the step is tried again within its retries.
    const restored = recoverLoginAttempt(failed);
    expect(restored).toMatchObject({ state: "reconciling", outcome: "interrupted" });
    const unknown = transitionLoginAttempt(
      restored,
      { type: "OBSERVED", result: "unknown", document: top },
      5000,
    );
    expect(unknown.settled).toBeUndefined();
    expect(unknown.watch).toBeUndefined();
    expect(unknown).toMatchObject({ state: "retryable", stepIndex: 0, retries: 0 });
    expect(transitionLoginAttempt(unknown, { type: "RETRY" })).toMatchObject({
      state: "ready",
      stepIndex: 0,
      retries: 1,
    });
    // A fill that may have reached the page still counts as a possible submission.
    const possible = transitionLoginAttempt(filling, {
      type: "FAILED",
      reason: "structural-mismatch",
      mutation: "possible",
      operationId: "fill-one",
      document: top,
    });
    expect(possible).toMatchObject({ state: "reconciling" });
    expect(transitionLoginAttempt(possible, { type: "NAVIGATED", document: away })).toMatchObject({
      state: "blocked",
      outcome: "left-origin",
    });
    expect(
      transitionLoginAttempt(possible, { type: "OBSERVED", result: "unknown", document: top }),
    ).toMatchObject({ state: "reconciling", outcome: "unknown-submit", settled: true });
    // An advance fill waiting to be tried again is never taken past its own step.
    let advancing = transitionLoginAttempt(
      transitionLoginAttempt(
        createAttemptMetadata({
          timing: noTimeBefore,
          id: "attempt-top",
          recipe,
          policyRevision: 3,
          account: { origin: top.origin, connectionId: "demo-personal", itemId: "primary" },
          choice: { route: "password", variant: 0 },
          facts,
          document: top,
        }),
        { type: "RESOLVE" },
      ),
      { type: "PREPARE", operationId: "fill-one", kind: "fill", effect: "advance" },
    );
    advancing = transitionLoginAttempt(advancing, {
      type: "MUTATION_INTENT",
      operationId: "fill-one",
    });
    advancing = transitionLoginAttempt(advancing, {
      type: "FAILED",
      reason: "structural-mismatch",
      mutation: "none",
      operationId: "fill-one",
      document: top,
    });
    expect(advancing).toMatchObject({
      state: "retryable",
      operationEffect: "advance",
      submissions: 0,
    });
    const again = transitionLoginAttempt(
      recoverLoginAttempt(advancing),
      { type: "OBSERVED", result: "unknown", document: top },
      5000,
    );
    expect(again.stepIndex).toBe(0);
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
    // A TOTP code typed as its own submission whose character the page kept out never went
    // in whole: it ends the attempt, and the submission stays counted (ADR 0027).
    expect(
      transitionLoginAttempt(submit, {
        type: "VALUE_REJECTED",
        operationId: "input-one",
        document,
        stage: "code-refused",
      }),
    ).toMatchObject({ state: "blocked", outcome: "fill-rejected", submissions: 1 });
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
        timing: noTimeBefore,
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
      timing: noTimeBefore,
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
    // A passkey route may keep the password variant it falls back to (ADR 0034).
    expect(parseAttemptMetadata({ ...attempt, route: "passkey" })).toMatchObject({
      route: "passkey",
      variant: 0,
    });
    for (const malformed of [
      { ...attempt, route: "sso" },
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

  it("takes it after a route's code fill when the runtime marks the code as the route's", () => {
    const route = { type: "AUTO_SUBMITTED", operationId: "page-one", routeStep: true } as const;
    let attempt = transitionLoginAttempt(detected(coded), { type: "RESOLVE" });
    // Before anything was filled there is no code to have submitted.
    expect(transitionLoginAttempt(attempt, route)).toEqual(attempt);
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
    // In flight, as a new document finds it, the step becomes the click after the fill.
    expect(transitionLoginAttempt(attempt, route)).toMatchObject({
      state: "reconciling",
      stepIndex: 1,
      operationKind: "click",
      submissions: 1,
    });
    attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
    expect(transitionLoginAttempt(attempt, route)).toMatchObject({
      state: "reconciling",
      stepIndex: 1,
      operationId: "page-one",
      operationKind: "click",
      operationEffect: "submit",
      submissions: 1,
    });
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
      timing: noTimeBefore,
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
      timing: noTimeBefore,
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

  it("answers the start page's own request on a recipe without the button (ADR 0034)", () => {
    const answering = (fallback?: number) =>
      createAttemptMetadata({
        timing: noTimeBefore,
        id: "attempt-passkey",
        recipe,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "passkey" },
        ...(fallback === undefined ? {} : { fallback }),
        facts: { ...facts, passkey: true, discoverablePasskey: true },
        document,
      });
    const attempt = answering();
    expect(attempt).toMatchObject({ route: "passkey", stepCount: 1, maxSubmissions: 1 });
    expect(attempt).not.toHaveProperty("variant");
    // Its one step stands for the answer as a submit on the start page's first field.
    expect(attemptPlan(recipe, attempt)?.map(({ step }) => step)).toEqual([
      { kind: "click", path: "/login", target: { by: "id", value: "password" }, purpose: "submit" },
    ]);
    // The password variant it falls back to is kept as its variant.
    expect(answering(0)).toMatchObject({ route: "passkey", variant: 0, stepCount: 1 });
    expect(attemptRouteChoice(answering(0))).toEqual({ route: "passkey" });
    // A fallback is the passkey route's only: the password route keeps its own variant.
    expect(
      createAttemptMetadata({
        timing: noTimeBefore,
        id: "attempt-password",
        recipe,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "password", variant: 0 },
        fallback: 3,
        facts,
        document,
      }),
    ).toMatchObject({ route: "password", variant: 0 });
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
    // The retry returns to the code fill, which the page's submission cannot skip either.
    const retrying = transitionLoginAttempt(failed, { type: "RETRY" });
    expect(retrying).toMatchObject({ state: "ready", stepIndex: 2 });
    expect(transitionLoginAttempt(retrying, autoSubmitted)).toEqual(retrying);
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

describe("a login on a chooser's list (ADR 0028)", () => {
  const listed = (chooser?: "entry" | "continue" | "other") =>
    transitionLoginAttempt(
      createAttemptMetadata({
        timing: noTimeBefore,
        id: "attempt-list",
        recipe,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "password", variant: 0 },
        facts,
        document,
        ...(chooser ? { chooser } : {}),
      }),
      { type: "RESOLVE" },
    );

  it("records its click, and ends account-not-listed before its first step", () => {
    const attempt = listed("other");
    expect(attempt.chooser).toEqual({ click: "other" });
    const ended = transitionLoginAttempt(attempt, { type: "NOT_LISTED" });
    expect(ended).toMatchObject({
      state: "blocked",
      outcome: "account-not-listed",
      submissions: 0,
    });
    expect(parseAttemptMetadata(ended)).toEqual(ended);
  });

  it("never ends a login that is not a chooser's, or that started its steps, that way", () => {
    expect(transitionLoginAttempt(listed(), { type: "NOT_LISTED" }).state).toBe("ready");
    const started = transitionLoginAttempt(listed("entry"), {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    expect(transitionLoginAttempt(started, { type: "NOT_LISTED" })).toEqual(started);
    let filled = transitionLoginAttempt(started, {
      type: "MUTATION_INTENT",
      operationId: "fill-one",
    });
    filled = transitionLoginAttempt(filled, { type: "OPERATION_OK", operationId: "fill-one" });
    expect(filled).toMatchObject({ state: "ready", stepIndex: 1 });
    expect(transitionLoginAttempt(filled, { type: "NOT_LISTED" })).toEqual(filled);
  });
});

describe("a login watched after a challenge or an unknown result (ADR 0027)", () => {
  const top: LoginDocument = { ...document, frameId: 0, documentId: "top-one" };
  const later: LoginDocument = { ...top, documentId: "top-two" };
  const withPasskey: LoginRecipe = {
    ...recipe,
    passkey: { path: "/login", target: { by: "id", value: "passkey-login" } },
  };
  function awaiting(at: LoginDocument = top, route: "password" | "passkey" = "password") {
    let attempt = transitionLoginAttempt(
      createAttemptMetadata({
        timing: noTimeBefore,
        id: "attempt-watched",
        recipe: withPasskey,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: route === "password" ? { route, variant: 0 } : { route },
        facts: { ...facts, passkey: true, discoverablePasskey: true },
        document: at,
      }),
      { type: "RESOLVE" },
    );
    if (route === "password") {
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
    }
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "click-one",
      kind: "click",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "click-one" });
    return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "click-one" });
  }
  const observed = (
    result: "authenticated" | "credential-rejected" | "challenge" | "unknown",
    at = top,
  ) => ({ type: "OBSERVED" as const, result, document: at });

  it("watches a top-level password login that stops at a challenge", () => {
    const watching = transitionLoginAttempt(awaiting(), observed("challenge"), 1000);
    expect(watching).toMatchObject({
      state: "watching",
      outcome: "challenge",
      watch: { since: 1000, documentId: "top-one", pages: 0 },
    });
    // A restart or a later page of the tab keeps the watch as it was.
    expect(recoverLoginAttempt(watching)).toEqual(watching);
    const moved = transitionLoginAttempt(watching, { type: "NAVIGATED", document: later }, 9000);
    expect(moved).toEqual({ ...watching, document: later });
    // It only reads: no step is issued or prepared.
    expect(nextLoginOperation(moved, withPasskey, later, "operation-two", 0)).toBeUndefined();
    expect(
      transitionLoginAttempt(moved, {
        type: "PREPARE",
        operationId: "operation-two",
        kind: "click",
      }),
    ).toEqual(moved);
    // A page that proves the sign-in completes it; a refused password ends it.
    const done = transitionLoginAttempt(moved, observed("authenticated", later));
    expect(done).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(done).not.toHaveProperty("watch");
    expect(transitionLoginAttempt(moved, observed("credential-rejected", later))).toMatchObject({
      state: "blocked",
      outcome: "credential-rejected",
    });
    // Anything else leaves it watched.
    for (const result of ["challenge", "unknown"] as const)
      expect(transitionLoginAttempt(moved, observed(result, later))).toEqual(moved);
    // The watch ends where the login stopped.
    const ended = transitionLoginAttempt(moved, { type: "WATCH_ENDED" });
    expect(ended).toMatchObject({ state: "blocked", outcome: "challenge" });
    expect(ended).not.toHaveProperty("watch");
    // The first step showing again before a sign-in abandons it (owner, 2026-10-13).
    const abandoned = transitionLoginAttempt(moved, { type: "WATCH_ENDED", abandoned: true });
    expect(abandoned).toMatchObject({ state: "blocked", outcome: "challenge-abandoned" });
    expect(abandoned).not.toHaveProperty("watch");
    // Leaving the origin ends it where it stopped, as the end of the watch does: it never
    // signed in (2026-10-13).
    const left = transitionLoginAttempt(moved, {
      type: "NAVIGATED",
      document: { ...later, origin: "https://elsewhere.example" },
    });
    expect(left).toMatchObject({ state: "blocked", outcome: "challenge" });
    expect(left).not.toHaveProperty("watch");
    const settled = transitionLoginAttempt(awaiting(), observed("unknown"), 1000);
    expect(settled).toMatchObject({ state: "reconciling", settled: true });
    expect(
      transitionLoginAttempt(settled, {
        type: "NAVIGATED",
        document: { ...later, origin: "https://elsewhere.example" },
      }),
    ).toMatchObject({ state: "blocked", outcome: "unknown-submit" });
  });

  it("takes newer settings over only while watched", () => {
    const watching = transitionLoginAttempt(awaiting(), observed("challenge"), 1000);
    const revised = {
      type: "POLICY_REVISED" as const,
      policyRevision: watching.policyRevision + 1,
    };
    expect(transitionLoginAttempt(watching, revised)).toEqual({
      ...watching,
      policyRevision: watching.policyRevision + 1,
    });
    // An older or the same revision changes nothing.
    for (const policyRevision of [watching.policyRevision, watching.policyRevision - 1])
      expect(transitionLoginAttempt(watching, { type: "POLICY_REVISED", policyRevision })).toEqual(
        watching,
      );
    // A login that still issues steps is stopped by newer settings instead.
    const pending = awaiting();
    expect(transitionLoginAttempt(pending, { ...revised, policyRevision: 9 })).toEqual(pending);
  });

  it("keeps a frame's and the passkey route's challenge final", () => {
    expect(
      transitionLoginAttempt(
        awaiting({ ...top, frameId: 2 }),
        observed("challenge", { ...top, frameId: 2 }),
      ),
    ).toMatchObject({ state: "blocked", outcome: "challenge" });
    const passkey = transitionLoginAttempt(awaiting(top, "passkey"), observed("challenge"));
    expect(passkey).toMatchObject({ state: "blocked", outcome: "challenge" });
    expect(passkey).not.toHaveProperty("watch");
  });

  it("watches a result settled as unknown until the attempt moves on or the watch ends", () => {
    const unknown = transitionLoginAttempt(awaiting(), observed("unknown"), 2000);
    expect(unknown).toMatchObject({
      state: "reconciling",
      settled: true,
      watch: { since: 2000, documentId: "top-one", pages: 0 },
    });
    const moved = recoverLoginAttempt(
      transitionLoginAttempt(unknown, { type: "NAVIGATED", document: later }, 5000),
    );
    expect(moved.watch).toEqual(unknown.watch);
    // A challenge on a later page keeps the watch's start.
    expect(transitionLoginAttempt(moved, observed("challenge", later), 7000)).toMatchObject({
      state: "watching",
      watch: { since: 2000, documentId: "top-one" },
    });
    const ended = transitionLoginAttempt(moved, { type: "WATCH_ENDED" });
    expect(ended).toMatchObject({ state: "blocked", outcome: "unknown-submit" });
    expect(ended).not.toHaveProperty("watch");
    expect(transitionLoginAttempt(moved, { type: "WATCH_ENDED", abandoned: true })).toMatchObject({
      state: "blocked",
      outcome: "watch-abandoned",
    });
    // Only a watched login's watch ends.
    const pending = awaiting();
    for (const event of [{ type: "WATCH_ENDED" }, { type: "WATCH_ENDED", abandoned: true }])
      expect(transitionLoginAttempt(recoverLoginAttempt(pending), event)).toEqual(
        recoverLoginAttempt(pending),
      );
    // Moving on drops the watch with the settled result.
    const authenticated = transitionLoginAttempt(moved, observed("authenticated", later));
    expect(authenticated).not.toHaveProperty("watch");
  });

  it("judges at most two pages while watched, apart from the effect step's", () => {
    const judging = { type: "JUDGING" as const, operationId: "click-one" };
    const first = transitionLoginAttempt(awaiting(), judging);
    expect(first.judged).toEqual({ operationId: "click-one", pages: 1 });
    const watching = transitionLoginAttempt(first, observed("challenge"), 1000);
    expect(pagesLeft(watching, "click-one")).toBe(MAX_JUDGED_PAGES);
    const once = transitionLoginAttempt(watching, judging);
    const twice = transitionLoginAttempt(once, judging);
    expect(twice).toMatchObject({ judged: { pages: 1 }, watch: { pages: 2 } });
    expect(pagesLeft(twice, "click-one")).toBe(0);
    expect(transitionLoginAttempt(twice, judging)).toEqual(twice);
    // A page no model saw is given back to the watch.
    expect(
      transitionLoginAttempt(twice, { type: "UNJUDGED", operationId: "click-one" }),
    ).toMatchObject({ judged: { pages: 1 }, watch: { pages: 1 } });
    expect(
      transitionLoginAttempt(watching, { type: "UNJUDGED", operationId: "click-one" }),
    ).toEqual(watching);
  });

  it("refuses a watch on a login that is not watched, and a watched login without one", () => {
    const watching = transitionLoginAttempt(awaiting(), observed("challenge"), 1000);
    expect(() => parseAttemptMetadata({ ...watching, watch: undefined })).toThrow();
    expect(() => parseAttemptMetadata({ ...awaiting(), watch: watching.watch })).toThrow();
    expect(() => parseAttemptMetadata({ ...watching, document: { ...top, frameId: 2 } })).toThrow();
  });
});

describe("route changes for a page's own passkey request (ADR 0034)", () => {
  const keyFacts = { ...facts, passkey: true, discoverablePasskey: true };
  const create = (
    choice: Parameters<typeof createAttemptMetadata>[0]["choice"],
    change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {},
  ) =>
    createAttemptMetadata({
      timing: noTimeBefore,
      id: "attempt-route",
      recipe,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      choice,
      facts: keyFacts,
      document,
      ...change,
    });
  const toPasskey = { type: "ROUTE", route: "passkey", steps: 1 } as const;
  const toPassword = { type: "ROUTE", route: "password", steps: 2 } as const;
  /** A `passkey` route on a recipe without the button whose answer went out. */
  function answering(fallback: number | null = 0) {
    let attempt = transitionLoginAttempt(
      create({ route: "passkey" }, fallback === null ? {} : { fallback }),
      { type: "RESOLVE" },
    );
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "answer-one",
      kind: "click",
      effect: "submit",
    });
    return transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "answer-one" });
  }

  it("switches a password login to the passkey route before anything was submitted", () => {
    const ready = transitionLoginAttempt(create({ route: "password", variant: 0 }), {
      type: "RESOLVE",
    });
    const switched = transitionLoginAttempt(ready, toPasskey);
    expect(switched).toMatchObject({
      state: "ready",
      route: "passkey",
      // The variant it falls back to stays recorded.
      variant: 0,
      stepIndex: 0,
      stepCount: 1,
      submissions: 0,
      maxSubmissions: 1,
    });
    expect(attemptRouteChoice(switched)).toEqual({ route: "passkey" });
    // A filled field stays filled: the switch comes between steps too.
    const filled = transitionLoginAttempt(readyToClick(), toPasskey);
    expect(filled).toMatchObject({ state: "ready", route: "passkey", stepIndex: 0, stepCount: 1 });
    expect(filled.usedOperationIds).toEqual(["fill-one"]);
    // And back, while still nothing was submitted.
    expect(transitionLoginAttempt(switched, toPassword)).toMatchObject({
      state: "ready",
      route: "password",
      variant: 0,
      stepIndex: 0,
      stepCount: 2,
      maxSubmissions: 1,
    });
  });

  it("switches a login on a chooser's list before its click on the list", () => {
    const listed = transitionLoginAttempt(
      create({ route: "password", variant: 0 }, { chooser: "other" }),
      { type: "RESOLVE" },
    );
    const switched = transitionLoginAttempt(listed, toPasskey);
    expect(switched).toMatchObject({
      state: "ready",
      route: "passkey",
      variant: 0,
      stepIndex: 0,
      stepCount: 1,
      submissions: 0,
      chooser: { click: "other" },
    });
  });

  it("refuses a switch that is not between steps of an unsubmitted login", () => {
    const ready = transitionLoginAttempt(create({ route: "password", variant: 0 }), {
      type: "RESOLVE",
    });
    // The same route, or a route of a login without a recorded variant.
    expect(transitionLoginAttempt(ready, { ...toPassword, steps: 2 })).toEqual(ready);
    const button: LoginRecipe = {
      ...recipe,
      passkey: { path: "/login", target: { by: "id", value: "passkey-login" } },
    };
    const clicking = transitionLoginAttempt(create({ route: "passkey" }, { recipe: button }), {
      type: "RESOLVE",
    });
    expect(transitionLoginAttempt(clicking, toPassword)).toEqual(clicking);
    // An operation under way, in its own state or prepared again.
    const filling = transitionLoginAttempt(ready, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    expect(transitionLoginAttempt(filling, toPasskey)).toEqual(filling);
    // A submission, even before its result.
    expect(transitionLoginAttempt(submitting(), toPasskey)).toEqual(submitting());
    // A login that only fills after a logout.
    const fillOnly = transitionLoginAttempt(
      create({ route: "password", variant: 0 }, { fillOnly: true }),
      { type: "RESOLVE" },
    );
    expect(transitionLoginAttempt(fillOnly, toPasskey)).toEqual(fillOnly);
    // A login on a chooser's list once its click on the list, its first submission, went out.
    const listed = transitionLoginAttempt(
      create({ route: "password", variant: 0 }, { chooser: "other" }),
      { type: "RESOLVE" },
    );
    expect(transitionLoginAttempt({ ...listed, submissions: 1 }, toPasskey)).toEqual({
      ...listed,
      submissions: 1,
    });
    // A ready login with a submission behind it, or an entered handler.
    expect(transitionLoginAttempt({ ...ready, submissions: 1 }, toPasskey)).toMatchObject({
      route: "password",
      submissions: 1,
    });
    const handled = { ...ready, stepCount: 3, handlers: [{ index: 0, start: 2 }] };
    expect(transitionLoginAttempt(handled, toPasskey)).toMatchObject({ route: "password" });
    // Before the login resolved.
    const unresolved = create({ route: "password", variant: 0 });
    expect(transitionLoginAttempt(unresolved, toPasskey)).toEqual(unresolved);
  });

  it("falls back to the recorded variant once after the answer, with the password budget", () => {
    const answered = transitionLoginAttempt(answering(), {
      type: "SUBMITTED",
      operationId: "answer-one",
    });
    expect(answered).toMatchObject({ state: "awaiting-result", submissions: 1 });
    const fallen = transitionLoginAttempt(answered, toPassword);
    expect(fallen).toMatchObject({
      state: "ready",
      route: "password",
      variant: 0,
      stepIndex: 0,
      stepCount: 2,
      submissions: 1,
      // The answer does not spend the password route's own budget.
      maxSubmissions: 2,
    });
    expect(fallen.operationId).toBeUndefined();
    expect(fallen.operationKind).toBeUndefined();
    expect(fallen.outcome).toBeUndefined();
    expect(attemptPlan(recipe, fallen)?.map(({ step }) => step)).toEqual(recipe.steps);
    // The password route runs its fill and its submit within that budget.
    let attempt = transitionLoginAttempt(fallen, {
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
    expect(attempt).toMatchObject({ state: "submit-intent", submissions: 2, maxSubmissions: 2 });
    // Never back to the passkey route: it never answers twice.
    const settled = transitionLoginAttempt(attempt, {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    expect(transitionLoginAttempt(settled, toPasskey)).toEqual(settled);
    expect(transitionLoginAttempt(fallen, toPasskey)).toEqual(fallen);
  });

  it("falls back from reconciling after a failed answer", () => {
    const failed = transitionLoginAttempt(answering(), {
      type: "FAILED",
      reason: "timeout",
      mutation: "none",
      operationId: "answer-one",
      document,
    });
    expect(failed).toMatchObject({ state: "reconciling", route: "passkey", submissions: 1 });
    expect(transitionLoginAttempt(failed, toPassword)).toMatchObject({
      state: "ready",
      route: "password",
      variant: 0,
      stepIndex: 0,
      maxSubmissions: 2,
    });
  });

  it("refuses a fallback without a recorded variant, a click or a submission", () => {
    const answered = transitionLoginAttempt(answering(null), {
      type: "SUBMITTED",
      operationId: "answer-one",
    });
    expect(answered).not.toHaveProperty("variant");
    expect(transitionLoginAttempt(answered, toPassword)).toEqual(answered);
    const recorded = transitionLoginAttempt(answering(), {
      type: "SUBMITTED",
      operationId: "answer-one",
    });
    // Only to the password route.
    expect(transitionLoginAttempt(recorded, toPasskey)).toEqual(recorded);
    // Not from the answer's own state, before its result is awaited.
    expect(transitionLoginAttempt(answering(), toPassword)).toEqual(answering());
    // Not after a password login's submission.
    const password = transitionLoginAttempt(submitting(), {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    expect(transitionLoginAttempt(password, toPassword)).toEqual(password);
    // Not after a handler was entered.
    const handled = { ...recorded, stepCount: 2, handlers: [{ index: 0, start: 1 }] };
    expect(transitionLoginAttempt(handled, toPassword)).toMatchObject({ route: "passkey" });
  });

  it("caps the fallback's budget at the attempt's limit", () => {
    const answered = transitionLoginAttempt(answering(), {
      type: "SUBMITTED",
      operationId: "answer-one",
    });
    expect(transitionLoginAttempt({ ...answered, maxSubmissions: 12 }, toPassword)).toMatchObject({
      route: "password",
      submissions: 1,
      maxSubmissions: 12,
    });
    expect(transitionLoginAttempt({ ...answered, maxSubmissions: 11 }, toPassword)).toMatchObject({
      route: "password",
      maxSubmissions: 12,
    });
    // A switch before any submission leaves the budget as it was.
    const ready = transitionLoginAttempt(create({ route: "password", variant: 0 }), {
      type: "RESOLVE",
    });
    expect(
      transitionLoginAttempt(transitionLoginAttempt(ready, toPasskey), toPassword),
    ).toMatchObject({ maxSubmissions: 1 });
  });

  it("refuses a route event without a step", () => {
    const ready = transitionLoginAttempt(create({ route: "password", variant: 0 }), {
      type: "RESOLVE",
    });
    expect(() => transitionLoginAttempt(ready, { ...toPasskey, steps: 0 })).toThrow();
    expect(() => transitionLoginAttempt(ready, { ...toPasskey, route: "sso" })).toThrow();
  });
});

describe("a login that stops before a missing password (ADR 0036)", () => {
  const top: LoginDocument = { ...document, frameId: 0, documentId: "top-stop" };
  const id = (value: string) => ({ by: "id" as const, value });
  /** An identifier-first form: the email, Next, then the password and its button. */
  const emailFirst: LoginRecipe = {
    version: 1,
    id: "synthetic-email-first",
    revision: 1,
    origin: document.origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [{ slot: "username", target: id("email") }],
      },
      { kind: "click", path: "/signin", target: id("next"), purpose: "advance" },
      {
        kind: "fill",
        effect: "prepare",
        path: "/password",
        fields: [{ slot: "password", target: id("password") }],
      },
      { kind: "click", path: "/password", target: id("login"), purpose: "submit" },
    ],
    handlers: [{ kind: "passkey", path: "/verify", target: id("use-key") }],
    maxSubmissions: 2,
  };
  const keyOnly = { password: false, totp: false, passkey: true, discoverablePasskey: false };
  /** A login of the item, stopping at `stopAt` unless it is `null`. */
  const create = (
    change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {},
    stopAt: number | null = 2,
  ) =>
    createAttemptMetadata({
      timing: noTimeBefore,
      id: "attempt-stop",
      recipe: emailFirst,
      policyRevision: 3,
      account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
      choice: { route: "password", variant: 0 },
      facts: keyOnly,
      document: top,
      ...(stopAt === null ? {} : { stopAt }),
      ...change,
    });
  /** The identifier filled and Next clicked, its result still awaited. */
  function advanced(change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {}) {
    let attempt = transitionLoginAttempt(create(change), { type: "RESOLVE" });
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
  /** The password page showed: the login stands at its stop. */
  const atStop = () =>
    transitionLoginAttempt(advanced(), { type: "OBSERVED", result: "continue", document: top });
  const answer = { type: "STOP_ANSWERED", operationId: "answer-one" } as const;

  it("records the stop of a top-level password variant", () => {
    const attempt = create();
    expect(attempt).toMatchObject({ route: "password", variant: 0, stepCount: 4, stopAt: 2 });
    expect(parseAttemptMetadata(attempt)).toEqual(attempt);
    expect(create({}, null)).not.toHaveProperty("stopAt");
    // A passkey route the login switched to keeps it with the variant.
    expect(
      parseAttemptMetadata({ ...attempt, route: "passkey", stepCount: 1, stopAt: 2 }),
    ).toMatchObject({ route: "passkey", stopAt: 2 });
    for (const malformed of [
      { ...attempt, stopAt: 0 },
      { ...attempt, stopAt: 5 },
      { ...attempt, stopAt: 1.5 },
      { ...attempt, route: "passkey", variant: undefined, stepCount: 1 },
      { ...attempt, document: { ...top, frameId: 2 } },
    ])
      expect(() => parseAttemptMetadata(malformed)).toThrow();
    // A chooser login's stop is in the record too (owner, 2026-10-13 06:32 UTC).
    expect(parseAttemptMetadata({ ...attempt, chooser: { click: "entry" } })).toMatchObject({
      chooser: { click: "entry" },
      stopAt: 2,
    });
    // Each is refused for its stop alone.
    const { stopAt: _stopAt, ...unstopped } = attempt;
    for (const valid of [
      { ...unstopped, route: "passkey", variant: undefined, stepCount: 1 },
      { ...unstopped, chooser: { click: "entry" } },
      { ...unstopped, document: { ...top, frameId: 2 } },
    ])
      expect(() => parseAttemptMetadata(valid)).not.toThrow();
    expect(() => create({ document: { ...top, frameId: 2 } })).toThrow();
    expect(() => create({}, 5)).toThrow();
    // A stop just past the plan's last step, as for a route that fills no password and ends
    // with an advance, is in the record too.
    expect(parseAttemptMetadata({ ...attempt, stopAt: 4 })).toMatchObject({
      stepCount: 4,
      stopAt: 4,
    });
    expect(create({}, 4)).toMatchObject({ stepCount: 4, stopAt: 4 });
    // A passkey route without the variant it came from has no stop to keep.
    expect(() => create({ choice: { route: "passkey" } })).toThrow();
    expect(() => create({ choice: { route: "passkey" } }, null)).not.toThrow();
  });

  it("runs the steps before the stop as on any password login", () => {
    const ready = transitionLoginAttempt(create(), { type: "RESOLVE" });
    expect(nextLoginOperation(ready, emailFirst, top, "fill-one")?.stepIndex).toBe(0);
    const awaiting = advanced();
    expect(awaiting).toMatchObject({ state: "awaiting-result", stepIndex: 1, submissions: 1 });
    const stopped = atStop();
    expect(stopped).toMatchObject({ state: "ready", stepIndex: 2, stopAt: 2, submissions: 1 });
    expect(stopped.operationId).toBeUndefined();
  });

  it("never issues, prepares or authorizes the stop's step or a later one", () => {
    const stopped = atStop();
    expect(nextLoginOperation(stopped, emailFirst, top, "fill-two", 1000)).toBeUndefined();
    expect(
      nextLoginOperation({ ...stopped, stepIndex: 3 }, emailFirst, top, "click-two", 1000),
    ).toBeUndefined();
    // Without the stop, the same login would fill the password next.
    const { stopAt: _stopAt, ...unstopped } = stopped;
    const operation = nextLoginOperation(unstopped, emailFirst, top, "fill-two", 1000)!;
    expect(operation).toMatchObject({ stepIndex: 2, step: { kind: "fill", path: "/password" } });
    expect(
      transitionLoginAttempt(stopped, { type: "PREPARE", operationId: "fill-two", kind: "fill" }),
    ).toEqual(stopped);
    // An operation prepared without the stop is refused once the stop is in the record.
    let filling = transitionLoginAttempt(unstopped, {
      type: "PREPARE",
      operationId: "fill-two",
      kind: "fill",
    });
    filling = transitionLoginAttempt(filling, { type: "MUTATION_INTENT", operationId: "fill-two" });
    expect(validateLoginOperation(operation, filling, top, 3, 1001)).toBe(true);
    expect(validateLoginOperation(operation, { ...filling, stopAt: 2 }, top, 3, 1001)).toBe(false);
    const later = nextLoginOperation(
      { ...unstopped, stepIndex: 3, submissions: 1 },
      emailFirst,
      top,
      "click-two",
      1000,
    )!;
    let clicking = transitionLoginAttempt(
      { ...unstopped, stepIndex: 3 },
      { type: "PREPARE", operationId: "click-two", kind: "click" },
    );
    clicking = transitionLoginAttempt(clicking, {
      type: "SUBMIT_INTENT",
      operationId: "click-two",
    });
    expect(validateLoginOperation(later, clicking, top, 3, 1001)).toBe(true);
    expect(validateLoginOperation(later, { ...clicking, stopAt: 2 }, top, 3, 1001)).toBe(false);
    // Nor does the page's own submission take a step at the stop.
    expect(
      transitionLoginAttempt(stopped, {
        type: "AUTO_SUBMITTED",
        operationId: "auto-one",
        routeStep: true,
      }),
    ).toEqual(stopped);
  });

  it("is watched when it ends challenge at its stop", () => {
    const watching = transitionLoginAttempt(
      atStop(),
      { type: "OBSERVED", result: "challenge", document: top },
      1000,
    );
    expect(watching).toMatchObject({
      state: "watching",
      outcome: "challenge",
      stepIndex: 2,
      stopAt: 2,
      watch: { since: 1000, documentId: "top-stop", pages: 0 },
    });
    // A challenge before the stop ends a ready login as before.
    const filled = transitionLoginAttempt(transitionLoginAttempt(create(), { type: "RESOLVE" }), {
      type: "OBSERVED",
      result: "challenge",
      document: top,
    });
    expect(filled).toMatchObject({ state: "blocked", outcome: "challenge" });
    // A challenge from another document is not this login's.
    const stopped = atStop();
    expect(
      transitionLoginAttempt(stopped, {
        type: "OBSERVED",
        result: "challenge",
        document: { ...top, tabId: 8 },
      }),
    ).toEqual(stopped);
  });

  // A move to another origin of the site after the stop: ADR 0027 (2026-10-13) ends a
  // watched login where it stopped, and ADR 0036 rule 5 completes a move after an answer.
  describe("a stop the tab leaves for another origin", () => {
    const moved = { ...top, origin: "https://www.bank.example", documentId: "x" };
    const watchingAtStop = () =>
      transitionLoginAttempt(
        atStop(),
        { type: "OBSERVED", result: "challenge", document: top },
        1000,
      );

    it("ends a watched stop where it stopped, not interrupted", () => {
      const watching = watchingAtStop();
      expect(watching).toMatchObject({ state: "watching", submissions: 1 });
      expect(watching.operationKind).toBeUndefined();
      expect(
        transitionLoginAttempt(watching, { type: "NAVIGATED", document: moved }),
      ).toMatchObject({ state: "blocked", outcome: "challenge" });
    });

    it("completes a watched stop whose move shows a sign-in", () => {
      expect(
        transitionLoginAttempt(watchingAtStop(), {
          type: "NAVIGATED",
          document: moved,
          signedIn: true,
        }),
      ).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    });

    // The bridge's answer can reach the page before STOP_ANSWERED is recorded.
    it("completes a ready stop whose move shows a sign-in", () => {
      const stopped = atStop();
      expect(stopped).toMatchObject({ state: "ready", submissions: 1 });
      expect(
        transitionLoginAttempt(stopped, { type: "NAVIGATED", document: moved, signedIn: true }),
      ).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    });
  });

  it("judges the watch's own pages while watched at its stop, with no operation", () => {
    // Watched at the stop with nothing in flight, the login has no effect step to name, yet
    // its watch's pages are judged as any watched login's are (ADR 0036, ADR 0027).
    const watching = transitionLoginAttempt(
      atStop(),
      { type: "OBSERVED", result: "challenge", document: top },
      1000,
    );
    expect(watching.operationId).toBeUndefined();
    const judging = { type: "JUDGING" } as const;
    const once = transitionLoginAttempt(watching, judging);
    expect(once).toMatchObject({ state: "watching", watch: { pages: 1 } });
    const twice = transitionLoginAttempt(once, judging);
    expect(twice.watch).toMatchObject({ pages: 2 });
    expect(pagesLeft(twice, undefined)).toBe(0);
    // Within the judge's limits.
    expect(transitionLoginAttempt(twice, judging)).toEqual(twice);
    // A page given back counts no more.
    expect(transitionLoginAttempt(twice, { type: "UNJUDGED" }).watch).toMatchObject({
      pages: 1,
    });
    // An operation the login does not hold is not its.
    expect(transitionLoginAttempt(watching, { type: "JUDGING", operationId: "next-one" })).toEqual(
      watching,
    );
    // Nor is a page judged without an operation before the login is watched.
    const stopped = atStop();
    expect(transitionLoginAttempt(stopped, judging)).toEqual(stopped);
    const sent = advanced();
    expect(transitionLoginAttempt(sent, judging)).toEqual(sent);
    expect(transitionLoginAttempt(sent, { type: "UNJUDGED" })).toEqual(sent);
    // A login watched after its advance's own challenge still names that step.
    const challenged = transitionLoginAttempt(
      sent,
      { type: "OBSERVED", result: "challenge", document: top },
      1000,
    );
    expect(challenged).toMatchObject({ state: "watching", operationId: "next-one" });
    expect(transitionLoginAttempt(challenged, judging)).toEqual(challenged);
    expect(
      transitionLoginAttempt(challenged, { type: "JUDGING", operationId: "next-one" }).watch,
    ).toMatchObject({ pages: 1 });
    // Nor is a page judged without one for a login at its stop that settled as unknown
    // after a new page, which is not watched at the stop.
    const settled = transitionLoginAttempt(
      transitionLoginAttempt(atStop(), { type: "NAVIGATED", document: top }),
      { type: "OBSERVED", result: "unknown", document: top },
      1000,
    );
    expect(settled).toMatchObject({ state: "reconciling", settled: true, stepIndex: 2 });
    expect(settled.operationId).toBeUndefined();
    expect(transitionLoginAttempt(settled, judging)).toEqual(settled);
  });

  it("counts an answer at the stop as a submission and goes on no further", () => {
    const answered = transitionLoginAttempt(atStop(), answer);
    expect(answered).toMatchObject({
      state: "reconciling",
      stepIndex: 2,
      stopAt: 2,
      operationId: "answer-one",
      operationKind: "click",
      operationEffect: "submit",
      mutationIntent: true,
      submissions: 2,
    });
    expect(answered.usedOperationIds).toContain("answer-one");
    // Its page never moves the login on to the password, nor enters a handler.
    expect(
      transitionLoginAttempt(answered, { type: "OBSERVED", result: "continue", document: top }),
    ).toEqual(answered);
    expect(
      transitionLoginAttempt(answered, {
        type: "HANDLER",
        handler: 0,
        steps: 1,
        effects: 1,
        document: top,
      }),
    ).toEqual(answered);
    expect(transitionLoginAttempt(answered, answer)).toEqual(answered);
    // It is judged as after a click, and proved or watched like one.
    expect(
      transitionLoginAttempt(answered, { type: "JUDGING", operationId: "answer-one" }).judged,
    ).toEqual({ operationId: "answer-one", pages: 1 });
    expect(
      transitionLoginAttempt(answered, {
        type: "OBSERVED",
        result: "authenticated",
        document: top,
      }),
    ).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(
      transitionLoginAttempt(answered, { type: "OBSERVED", result: "challenge", document: top }),
    ).toMatchObject({ state: "watching", outcome: "challenge" });
  });

  it("refuses an answer away from the stop, past the budget, or with a used operation", () => {
    const stopped = atStop();
    // Before the stop, or before anything was submitted.
    const filling = transitionLoginAttempt(transitionLoginAttempt(create(), { type: "RESOLVE" }), {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    expect(transitionLoginAttempt(filling, answer)).toEqual(filling);
    const before = { ...stopped, stepIndex: 1 };
    expect(transitionLoginAttempt(before, answer)).toEqual(before);
    const unsubmitted = { ...stopped, submissions: 0 };
    expect(transitionLoginAttempt(unsubmitted, answer)).toEqual(unsubmitted);
    // A fill-only login presses nothing.
    const fillOnly = { ...stopped, fillOnly: true as const };
    expect(transitionLoginAttempt(fillOnly, answer)).toEqual(fillOnly);
    // The budget is spent.
    const spent = { ...stopped, submissions: 2 };
    expect(transitionLoginAttempt(spent, answer)).toEqual(spent);
    // An operation id the login used already.
    for (const operationId of ["fill-one", "next-one"])
      expect(transitionLoginAttempt(stopped, { type: "STOP_ANSWERED", operationId })).toEqual(
        stopped,
      );
    // A login without a stop, or one waiting for a retry.
    const { stopAt: _stopAt, ...unstopped } = stopped;
    expect(transitionLoginAttempt(unstopped, answer)).toEqual(unstopped);
    const retrying = { ...stopped, retryRequired: true as const };
    expect(transitionLoginAttempt(retrying, answer)).toEqual(retrying);
    // While the page is still being reconciled after a restart.
    const recovered = recoverLoginAttempt(stopped);
    expect(recovered.state).toBe("reconciling");
    expect(transitionLoginAttempt(recovered, answer)).toEqual(recovered);
    // The restart comes back to the stop, and no further.
    expect(
      transitionLoginAttempt(recovered, { type: "OBSERVED", result: "continue", document: top }),
    ).toMatchObject({ state: "ready", stepIndex: 2, stopAt: 2 });
  });

  it("moves the stop along with a handler entered before it", () => {
    const entered = transitionLoginAttempt(advanced(), {
      type: "HANDLER",
      handler: 0,
      steps: 1,
      effects: 1,
      document: top,
    });
    expect(entered).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 5,
      stopAt: 3,
      maxSubmissions: 3,
      handlers: [{ index: 0, start: 2 }],
    });
    // The handler's click runs; the password fill after it does not.
    expect(nextLoginOperation(entered, emailFirst, top, "key-one", 1000)).toMatchObject({
      stepIndex: 2,
      step: { kind: "click", path: "/verify" },
    });
    expect(
      nextLoginOperation({ ...entered, stepIndex: 3 }, emailFirst, top, "fill-two", 1000),
    ).toBeUndefined();
    // A login without a stop gains none.
    const { stopAt: _stopAt, ...unstopped } = advanced();
    expect(
      transitionLoginAttempt(unstopped, {
        type: "HANDLER",
        handler: 0,
        steps: 1,
        effects: 1,
        document: top,
      }),
    ).not.toHaveProperty("stopAt");
  });

  // Owner, 2026-10-13 05:39 UTC: a passkey button beside the stop step's password field is
  // pressed when the item has a passkey.
  describe("a passkey button beside the stop's password field", () => {
    const button = { type: "HANDLER", handler: 0, steps: 1, effects: 1, document: top } as const;
    const judging = { type: "STOP_JUDGING" } as const;

    it("enters a handler at the stop, before the stop step, which moves along", () => {
      const entered = transitionLoginAttempt(atStop(), button);
      expect(entered).toMatchObject({
        state: "ready",
        stepIndex: 2,
        stepCount: 5,
        stopAt: 3,
        submissions: 1,
        maxSubmissions: 3,
        handlers: [{ index: 0, start: 2 }],
      });
      expect(entered.operationId).toBeUndefined();
      // The handler's click runs; the password fill after it never does.
      expect(nextLoginOperation(entered, emailFirst, top, "key-one", 1000)).toMatchObject({
        stepIndex: 2,
        step: { kind: "click", path: "/verify", target: id("use-key") },
      });
      expect(
        nextLoginOperation({ ...entered, stepIndex: 3 }, emailFirst, top, "fill-two", 1000),
      ).toBeUndefined();
      // Once clicked, the page after it goes on to the stop again, and no further.
      let clicked = transitionLoginAttempt(entered, {
        type: "PREPARE",
        operationId: "key-one",
        kind: "click",
      });
      clicked = transitionLoginAttempt(clicked, { type: "SUBMIT_INTENT", operationId: "key-one" });
      clicked = transitionLoginAttempt(clicked, { type: "SUBMITTED", operationId: "key-one" });
      const back = transitionLoginAttempt(clicked, {
        type: "OBSERVED",
        result: "continue",
        document: top,
      });
      expect(back).toMatchObject({ state: "ready", stepIndex: 3, stopAt: 3, submissions: 2 });
      expect(nextLoginOperation(back, emailFirst, top, "fill-two", 1000)).toBeUndefined();
      // The passkey request the click led to is answered there, within the budget.
      expect(
        transitionLoginAttempt(back, { type: "STOP_ANSWERED", operationId: "answer-one" }),
      ).toMatchObject({ state: "reconciling", stepIndex: 3, submissions: 3 });
      // It never runs twice.
      expect(transitionLoginAttempt(back, button)).toEqual(back);
    });

    it("refuses a handler at the stop without a submission, while retrying or filling only", () => {
      const stopped = atStop();
      for (const refused of [
        { ...stopped, submissions: 0 },
        { ...stopped, retryRequired: true as const },
        { ...stopped, fillOnly: true as const },
        { ...stopped, stepIndex: 1 },
        { ...stopped, handlers: [{ index: 0, start: 2 }], stepCount: 5, stopAt: 3, stepIndex: 3 },
        { ...stopped, maxSubmissions: 12 },
      ])
        expect(transitionLoginAttempt(refused, button)).toEqual(refused);
      // A login without a stop enters one only after an effect step, as before.
      const { stopAt: _stopAt, ...unstopped } = stopped;
      expect(transitionLoginAttempt(unstopped, button)).toEqual(unstopped);
      // Nor from another tab.
      expect(
        transitionLoginAttempt(stopped, { ...button, document: { ...top, tabId: 8 } }),
      ).toEqual(stopped);
    });

    it("records the judgement of the stop's page once, before the request", () => {
      const stopped = atStop();
      const judged = transitionLoginAttempt(stopped, judging);
      expect(judged).toMatchObject({ state: "ready", stepIndex: 2, stopJudged: true });
      expect(parseAttemptMetadata(judged)).toEqual(judged);
      expect(transitionLoginAttempt(judged, judging)).toEqual(judged);
      // A handler learned from it still goes in.
      expect(transitionLoginAttempt(judged, button)).toMatchObject({
        stepIndex: 2,
        stopAt: 3,
        stopJudged: true,
      });
      // Not before the stop, nor at a stop just past the plan's last step, nor without one.
      for (const refused of [
        { ...stopped, stepIndex: 1 },
        { ...stopped, submissions: 0 },
        { ...stopped, fillOnly: true as const },
        { ...stopped, stopAt: 4, stepIndex: 4 },
      ])
        expect(transitionLoginAttempt(refused, judging)).toEqual(refused);
      const { stopAt: _stopAt, ...unstopped } = stopped;
      expect(transitionLoginAttempt(unstopped, judging)).toEqual(unstopped);
      expect(() => parseAttemptMetadata({ ...stopped, stopJudged: false })).toThrow();
      // Only a login with a stop records it.
      const { stopAt: _unstop, ...noStop } = judged;
      expect(() => parseAttemptMetadata(noStop)).toThrow();
      // Answered or watched, it is never judged so again.
      const answered = transitionLoginAttempt(stopped, answer);
      expect(transitionLoginAttempt(answered, judging)).toEqual(answered);
      const watching = transitionLoginAttempt(stopped, {
        type: "OBSERVED",
        result: "challenge",
        document: top,
      });
      expect(transitionLoginAttempt(watching, judging)).toEqual(watching);
    });
  });

  it("never goes back to the password from a passkey route it switched to", () => {
    const ready = transitionLoginAttempt(create(), { type: "RESOLVE" });
    const switched = transitionLoginAttempt(ready, {
      type: "ROUTE",
      route: "passkey",
      steps: 1,
    });
    expect(switched).toMatchObject({ route: "passkey", variant: 0, stopAt: 2, stepCount: 1 });
    const toPassword = { type: "ROUTE", route: "password", steps: 4 } as const;
    expect(transitionLoginAttempt(switched, toPassword)).toEqual(switched);
    let attempt = transitionLoginAttempt(switched, {
      type: "PREPARE",
      operationId: "answer-one",
      kind: "click",
      effect: "submit",
    });
    attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "answer-one" });
    const answered = transitionLoginAttempt(attempt, {
      type: "SUBMITTED",
      operationId: "answer-one",
    });
    expect(answered).toMatchObject({ state: "awaiting-result", submissions: 1 });
    expect(transitionLoginAttempt(answered, toPassword)).toEqual(answered);
    // The same answer without a stop falls back to the variant (ADR 0034).
    const { stopAt: _stopAt, ...unstopped } = answered;
    expect(transitionLoginAttempt(unstopped, toPassword)).toMatchObject({
      state: "ready",
      route: "password",
    });
  });

  describe("a stop just past the plan's last step", () => {
    const { handlers: _handlers, ...base } = emailFirst;
    /** An identifier-first recipe whose page after the identifier is not generated yet. */
    const identifier: LoginRecipe = {
      ...base,
      slots: ["username"],
      steps: emailFirst.steps.slice(0, 2),
      maxSubmissions: 2,
    };
    const created = (stopAt: number | null = 2) => create({ recipe: identifier }, stopAt);
    /** The identifier filled and Next clicked, its result still awaited. */
    function advancedPast(stopAt: number | null = 2) {
      let attempt = transitionLoginAttempt(created(stopAt), { type: "RESOLVE" });
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
      attempt = transitionLoginAttempt(attempt, {
        type: "SUBMIT_INTENT",
        operationId: "next-one",
      });
      return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "next-one" });
    }
    const continued = {
      type: "OBSERVED",
      result: "continue",
      document: top,
    } as const;

    it("enters a passkey handler at that stop, keeping the answer's submission", () => {
      const keyed: LoginRecipe = {
        ...identifier,
        handlers: [{ kind: "passkey", path: "/signin", target: id("use-key") }],
      };
      const stopped = transitionLoginAttempt(advancedPast(), continued);
      expect(stopped).toMatchObject({ stepIndex: 2, stepCount: 2, stopAt: 2, maxSubmissions: 3 });
      const entered = transitionLoginAttempt(stopped, {
        type: "HANDLER",
        handler: 0,
        steps: 1,
        effects: 1,
        document: top,
      });
      // The stop stays just past the plan's last step, which is now the handler's click.
      expect(entered).toMatchObject({
        state: "ready",
        stepIndex: 2,
        stepCount: 3,
        stopAt: 3,
        maxSubmissions: 4,
        handlers: [{ index: 0, start: 2 }],
      });
      expect(nextLoginOperation(entered, keyed, top, "key-one", 1000)).toMatchObject({
        stepIndex: 2,
        step: { kind: "click", target: id("use-key") },
      });
      // The click spends the recipe's budget; the kept submission still answers at the stop.
      let clicked = transitionLoginAttempt(entered, {
        type: "PREPARE",
        operationId: "key-one",
        kind: "click",
      });
      clicked = transitionLoginAttempt(clicked, { type: "SUBMIT_INTENT", operationId: "key-one" });
      expect(clicked).toMatchObject({ state: "submit-intent", submissions: 2 });
      clicked = transitionLoginAttempt(clicked, { type: "SUBMITTED", operationId: "key-one" });
      const back = { ...clicked, state: "ready" as const, stepIndex: 3 };
      const {
        operationId: _a,
        operationKind: _b,
        operationEffect: _c,
        mutationIntent: _d,
        ...idle
      } = back;
      expect(
        transitionLoginAttempt(idle, { type: "STOP_ANSWERED", operationId: "answer-one" }),
      ).toMatchObject({ state: "reconciling", stepIndex: 3, submissions: 3 });
      // A stop past the plan has no stop step whose page could be judged.
      expect(transitionLoginAttempt(stopped, { type: "STOP_JUDGING" })).toEqual(stopped);
    });

    it("goes on from the final advance to the stop, where no step is", () => {
      const awaiting = advancedPast();
      expect(awaiting).toMatchObject({
        state: "awaiting-result",
        stepIndex: 1,
        stepCount: 2,
        stopAt: 2,
        submissions: 1,
      });
      const stopped = transitionLoginAttempt(awaiting, continued);
      expect(stopped).toMatchObject({ state: "ready", stepIndex: 2, stopAt: 2, submissions: 1 });
      expect(stopped.operationId).toBeUndefined();
      // Nothing is issued there.
      expect(nextLoginOperation(stopped, identifier, top, "fill-two", 1000)).toBeUndefined();
      // Back at the stop with nothing in flight, as after a restart, it stands there again.
      expect(transitionLoginAttempt(stopped, continued)).toMatchObject({
        state: "ready",
        stepIndex: 2,
      });
      const recovered = recoverLoginAttempt(stopped);
      expect(recovered.state).toBe("reconciling");
      expect(transitionLoginAttempt(recovered, continued)).toMatchObject({
        state: "ready",
        stepIndex: 2,
        stopAt: 2,
      });
      // A document of another tab is not this login's.
      expect(
        transitionLoginAttempt(awaiting, { ...continued, document: { ...top, tabId: 8 } }),
      ).toEqual(awaiting);
    });

    it("goes on past the final advance only to such a stop", () => {
      // Without a stop the final advance waits for the recipe to be continued (ADR 0018).
      const unstopped = advancedPast(null);
      expect(transitionLoginAttempt(unstopped, continued)).toEqual(unstopped);
      // A stop that is not just past the advance is never reached by going on.
      const early = { ...advancedPast(), stopAt: 1 };
      expect(transitionLoginAttempt(early, continued)).toEqual(early);
      // Nor is the advance's page taken as the stop before the click was made.
      const { mutationIntent: _intent, ...unclicked } = advancedPast();
      const idle = { ...unclicked, submissions: 0 };
      expect(transitionLoginAttempt(idle, continued)).toEqual(idle);
    });

    it("ends challenge, watched, at the stop, and counts an answer there", () => {
      const stopped = transitionLoginAttempt(advancedPast(), continued);
      expect(
        transitionLoginAttempt(stopped, { type: "OBSERVED", result: "challenge", document: top }),
      ).toMatchObject({ state: "watching", outcome: "challenge", stepIndex: 2, stopAt: 2 });
      const answered = transitionLoginAttempt(stopped, answer);
      expect(answered).toMatchObject({
        state: "reconciling",
        stepIndex: 2,
        stopAt: 2,
        operationId: "answer-one",
        submissions: 2,
      });
      // Its page never moves the login on.
      expect(transitionLoginAttempt(answered, continued)).toEqual(answered);
      expect(
        transitionLoginAttempt(answered, {
          type: "OBSERVED",
          result: "authenticated",
          document: top,
        }),
      ).toMatchObject({ state: "authenticated" });
      // An answer before the advance's page showed is refused.
      const awaiting = advancedPast();
      expect(transitionLoginAttempt(awaiting, answer)).toEqual(awaiting);
    });

    it("asks for the recipe to be continued and moves its stop to the password (ADR 0036)", () => {
      const continuing = { type: "CONTINUING", operationId: "next-one" } as const;
      const awaiting = advancedPast();
      expect(awaiting).toMatchObject({ maxSubmissions: 3 });
      const sent = transitionLoginAttempt(awaiting, continuing);
      expect(sent).toMatchObject({ continuation: { operationId: "next-one" } });
      const event = {
        type: "CONTINUED",
        recipeRevision: 2,
        steps: 2,
        effects: 1,
        document: top,
      } as const;
      // The continued password fill is the new stop; the answer's kept submission goes
      // into the continued budget, which counts the password's own submission.
      const moved = transitionLoginAttempt(sent, { ...event, stopAt: 2 });
      expect(moved).toMatchObject({
        state: "ready",
        stepIndex: 2,
        stepCount: 4,
        stopAt: 2,
        maxSubmissions: 3,
      });
      expect(nextLoginOperation(moved, identifier, top, "fill-two", 1000)).toBeUndefined();
      // Continued steps that fill no password and end with an advance keep the stop past
      // them, and the kept submission with it.
      expect(transitionLoginAttempt(sent, { ...event, stopAt: 4 })).toMatchObject({
        state: "ready",
        stepIndex: 2,
        stepCount: 4,
        stopAt: 4,
        maxSubmissions: 4,
      });
      // A login with a stop names its new one, within the continued steps or just past them.
      for (const refused of [event, { ...event, stopAt: 1 }, { ...event, stopAt: 5 }])
        expect(transitionLoginAttempt(sent, refused)).toEqual(parseAttemptMetadata(sent));
      // A login without a stop names none.
      const plain = transitionLoginAttempt(advancedPast(null), continuing);
      expect(transitionLoginAttempt(plain, event)).toMatchObject({ state: "ready", stepCount: 4 });
      expect(transitionLoginAttempt(plain, { ...event, stopAt: 2 })).toEqual(
        parseAttemptMetadata(plain),
      );
      // The kept submission is the answer's alone: no step may spend it.
      const ready = transitionLoginAttempt(created(), { type: "RESOLVE" });
      const spent = parseAttemptMetadata({ ...ready, stepIndex: 1, submissions: 2 });
      expect(nextLoginOperation(spent, identifier, top, "next-two", 1000)).toBeUndefined();
      expect(
        nextLoginOperation({ ...spent, submissions: 1 }, identifier, top, "next-two", 1000),
      ).toBeDefined();
      // A switch to the passkey route gives it back.
      expect(
        transitionLoginAttempt(ready, { type: "ROUTE", route: "passkey", steps: 1 }),
      ).toMatchObject({ route: "passkey", maxSubmissions: 2 });
      // A stop inside the plan never asks: its final advance is past the stop.
      const early = { ...awaiting, stopAt: 1, maxSubmissions: 2 };
      expect(transitionLoginAttempt(early, continuing)).toEqual(parseAttemptMetadata(early));
    });

    it("keeps the reserved submission for the answer at the stop alone", () => {
      // The email and Continue spend the recipe's one submission; the stop keeps one more.
      const single: LoginRecipe = { ...identifier, maxSubmissions: 1 };
      const ready = transitionLoginAttempt(create({ recipe: single }, 2), { type: "RESOLVE" });
      expect(ready).toMatchObject({ stepCount: 2, stopAt: 2, maxSubmissions: 2 });
      // A click with the recipe's budget spent hits the submission limit; the same click
      // without the stop may use the second submission.
      const clicking = transitionLoginAttempt(
        { ...ready, stepIndex: 1 },
        { type: "PREPARE", operationId: "next-one", kind: "click", effect: "advance" },
      );
      const spent = { ...clicking, submissions: 1 };
      expect(
        transitionLoginAttempt(spent, { type: "SUBMIT_INTENT", operationId: "next-one" }),
      ).toMatchObject({ state: "blocked", outcome: "submission-limit" });
      const { stopAt: _clickStop, ...plainClick } = spent;
      expect(
        transitionLoginAttempt(plainClick, { type: "SUBMIT_INTENT", operationId: "next-one" }),
      ).toMatchObject({ state: "submit-intent" });
      // Nor may the page's own submission spend it, for a route step's fill in flight.
      let filling = transitionLoginAttempt(ready, {
        type: "PREPARE",
        operationId: "fill-one",
        kind: "fill",
      });
      filling = transitionLoginAttempt(filling, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      const auto = { type: "AUTO_SUBMITTED", operationId: "auto-one", routeStep: true } as const;
      expect(transitionLoginAttempt(filling, auto)).toMatchObject({
        state: "reconciling",
        submissions: 1,
      });
      const spentFill = parseAttemptMetadata({ ...filling, submissions: 1 });
      expect(transitionLoginAttempt(spentFill, auto)).toEqual(spentFill);
      const { stopAt: _fillStop, ...plainFill } = spentFill;
      expect(transitionLoginAttempt(plainFill, auto)).toMatchObject({
        state: "reconciling",
        submissions: 2,
      });
      // At the stop, the answer takes the kept submission.
      const stopped = parseAttemptMetadata({ ...ready, stepIndex: 2, submissions: 1 });
      expect(transitionLoginAttempt(stopped, answer)).toMatchObject({
        state: "reconciling",
        stepIndex: 2,
        submissions: 2,
        maxSubmissions: 2,
      });
    });
  });

  describe("on a chooser's route (owner, 2026-10-13 06:32 UTC)", () => {
    /** The click on the list's account entry, the advance before the stop (ADR 0028). */
    const listClick = {
      kind: "click" as const,
      path: "/accounts",
      target: CHOOSER_ENTRY_TARGET,
      purpose: "advance" as const,
    };
    /** `chooserRoute`'s shape: the click, then the branch's steps, its budget plus one. */
    const routeOf = (steps: LoginRecipe["steps"], branchSubmissions: number): LoginRecipe => ({
      version: 1,
      id: "synthetic-chooser",
      revision: 1,
      origin: document.origin,
      pageKind: "sign-in",
      slots: ["username", "password"],
      steps: [listClick, ...steps],
      maxSubmissions: branchSubmissions + 1,
    });
    /** A stored branch that asks for the password after the profile's click. */
    const passwordBranch = routeOf(emailFirst.steps.slice(2), 1);
    /** No branch yet: the route is the click alone. */
    const bare = routeOf([], 0);
    const chooserLogin = (used: LoginRecipe, stopAt: number) =>
      transitionLoginAttempt(create({ recipe: used, chooser: "entry" }, stopAt), {
        type: "RESOLVE",
      });
    /** The list's entry clicked, its result still awaited. */
    function clicked(used: LoginRecipe, stopAt: number) {
      let attempt = chooserLogin(used, stopAt);
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "list-one",
        kind: "click",
        effect: "advance",
      });
      attempt = transitionLoginAttempt(attempt, {
        type: "SUBMIT_INTENT",
        operationId: "list-one",
      });
      return transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "list-one" });
    }
    const continued = { type: "OBSERVED", result: "continue", document: top } as const;

    it("stops at the branch's password fill after the click, which spends a submission", () => {
      const ready = chooserLogin(passwordBranch, 1);
      expect(ready).toMatchObject({
        chooser: { click: "entry" },
        stepCount: 3,
        stopAt: 1,
        maxSubmissions: 2,
      });
      expect(nextLoginOperation(ready, passwordBranch, top, "list-one", 1000)).toMatchObject({
        stepIndex: 0,
        step: { kind: "click", target: CHOOSER_ENTRY_TARGET },
      });
      const awaiting = clicked(passwordBranch, 1);
      expect(awaiting).toMatchObject({ state: "awaiting-result", stepIndex: 0, submissions: 1 });
      const stopped = transitionLoginAttempt(awaiting, continued);
      expect(stopped).toMatchObject({ state: "ready", stepIndex: 1, stopAt: 1 });
      // The password fill is never issued, nor authorized once prepared without the stop.
      expect(nextLoginOperation(stopped, passwordBranch, top, "fill-two", 1000)).toBeUndefined();
      const { stopAt: _stopAt, ...unstopped } = stopped;
      const operation = nextLoginOperation(unstopped, passwordBranch, top, "fill-two", 1000)!;
      expect(operation).toMatchObject({ stepIndex: 1, step: { kind: "fill" } });
      let filling = transitionLoginAttempt(unstopped, {
        type: "PREPARE",
        operationId: "fill-two",
        kind: "fill",
      });
      filling = transitionLoginAttempt(filling, {
        type: "MUTATION_INTENT",
        operationId: "fill-two",
      });
      expect(validateLoginOperation(operation, filling, top, 3, 1001)).toBe(true);
      expect(validateLoginOperation(operation, { ...filling, stopAt: 1 }, top, 3, 1001)).toBe(
        false,
      );
      // A restart at the stop stands there again, and never fills the password.
      const recovered = recoverLoginAttempt(stopped);
      const resumed = transitionLoginAttempt(recovered, continued);
      expect(resumed).toMatchObject({ state: "ready", stepIndex: 1, stopAt: 1 });
      expect(nextLoginOperation(resumed, passwordBranch, top, "fill-three", 1000)).toBeUndefined();
      // The answer there spends the branch's own submission.
      expect(transitionLoginAttempt(stopped, answer)).toMatchObject({
        state: "reconciling",
        stepIndex: 1,
        submissions: 2,
        maxSubmissions: 2,
      });
    });

    it("stops just past the click without a branch, keeping one submission for the answer", () => {
      const ready = chooserLogin(bare, 1);
      expect(ready).toMatchObject({ stepCount: 1, stopAt: 1, maxSubmissions: 2 });
      // The click spends the route's own submission, never the kept one.
      expect(nextLoginOperation(ready, bare, top, "list-one", 1000)).toBeDefined();
      expect(
        nextLoginOperation({ ...ready, submissions: 1 }, bare, top, "list-two", 1000),
      ).toBeUndefined();
      const awaiting = clicked(bare, 1);
      const stopped = transitionLoginAttempt(awaiting, continued);
      expect(stopped).toMatchObject({ state: "ready", stepIndex: 1, stopAt: 1, submissions: 1 });
      expect(transitionLoginAttempt(stopped, answer)).toMatchObject({
        state: "reconciling",
        submissions: 2,
      });
      // The branch's page is continued (ADR 0018), and the stop moves into it.
      const sent = transitionLoginAttempt(awaiting, {
        type: "CONTINUING",
        operationId: "list-one",
      });
      expect(sent).toMatchObject({ continuation: { operationId: "list-one" } });
      const event = { type: "CONTINUED", recipeRevision: 2, steps: 2, effects: 1, document: top };
      // A password branch: the password fill is the stop, and the kept submission goes into
      // the branch's budget.
      expect(transitionLoginAttempt(sent, { ...event, stopAt: 1 })).toMatchObject({
        state: "ready",
        stepIndex: 1,
        stepCount: 3,
        stopAt: 1,
        maxSubmissions: 2,
      });
      // An identifier-only branch after another account: the stop lies past it again, and
      // keeps the submission for the answer.
      expect(transitionLoginAttempt(sent, { ...event, stopAt: 3 })).toMatchObject({
        state: "ready",
        stepIndex: 1,
        stepCount: 3,
        stopAt: 3,
        maxSubmissions: 3,
      });
      // It names its new stop, within the branch's steps or just past them.
      for (const refused of [event, { ...event, stopAt: 4 }])
        expect(transitionLoginAttempt(sent, refused)).toEqual(parseAttemptMetadata(sent));
    });

    it("ends without a click when nothing on the list fits, with its stop kept", () => {
      const ready = chooserLogin(bare, 1);
      expect(transitionLoginAttempt(ready, { type: "NOT_LISTED" })).toMatchObject({
        state: "blocked",
        outcome: "account-not-listed",
        submissions: 0,
        stopAt: 1,
      });
    });
  });
});

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
    expect(attemptPlan(twoPages, { ...answering, startStep: undefined })?.[0]?.step).toMatchObject({
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
});

describe("a login's own times for the local log (ADR 0019)", () => {
  const top: LoginDocument = { ...document, frameId: 0, documentId: "top-one" };
  const timing = { since: 1_000, serviceMs: 3_000, networkMs: 400, personMs: 0, pageMs: 0 };
  /** A login whose click was sent at `at`, and that waits for the site's answer since then. */
  function submitted(at = 5_000, on: LoginDocument = top) {
    let attempt = transitionLoginAttempt(
      createAttemptMetadata({
        id: "attempt-timed",
        recipe,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "password", variant: 0 },
        facts,
        document: on,
        timing,
      }),
      { type: "RESOLVE" },
      at,
    );
    for (const event of [
      { type: "PREPARE", operationId: "fill-one", kind: "fill" },
      { type: "MUTATION_INTENT", operationId: "fill-one" },
      { type: "OPERATION_OK", operationId: "fill-one" },
      { type: "PREPARE", operationId: "click-one", kind: "click" },
      { type: "SUBMIT_INTENT", operationId: "click-one" },
      { type: "SUBMITTED", operationId: "click-one" },
    ])
      attempt = transitionLoginAttempt(attempt, event, at);
    return attempt;
  }
  const observed = (result: "authenticated" | "challenge" | "unknown") => ({
    type: "OBSERVED" as const,
    result,
    document: top,
  });
  const sum = (times: ReturnType<typeof attemptTimes>) =>
    times.serviceMs + times.personMs + times.pageMs + times.otherMs;

  it("starts with the time spent before the login, and waits for the site once it clicked", () => {
    expect(submitted().timing).toEqual({ ...timing, pageSince: 5_000 });
    expect(detected().timing).toEqual(noTimeBefore);
  });

  it("counts the wait for the site from a click until the login read its answer", () => {
    const done = transitionLoginAttempt(submitted(), observed("authenticated"), 8_000);
    expect(done.state).toBe("authenticated");
    expect(done.timing).toEqual({ ...timing, pageMs: 3_000 });
    const times = attemptTimes(done, 8_000);
    expect(times).toEqual({
      totalMs: 7_000,
      serviceMs: 3_000,
      networkMs: 400,
      personMs: 0,
      pageMs: 3_000,
      otherMs: 1_000,
    });
    expect(sum(times)).toBe(times.totalMs);
  });

  it("keeps waiting for the site across a new page and a worker restart", () => {
    // The click replaced the document: the restarted worker reads the record back, and
    // the next page resumes the login.
    const restored = recoverLoginAttempt(JSON.parse(JSON.stringify(submitted())));
    expect(restored.timing.pageSince).toBe(5_000);
    const next: LoginDocument = { ...top, documentId: "top-two" };
    const navigated = transitionLoginAttempt(
      restored,
      { type: "NAVIGATED", document: next },
      9_000,
    );
    expect(navigated).toMatchObject({ state: "reconciling", timing: { pageSince: 5_000 } });
    const done = transitionLoginAttempt(
      navigated,
      { type: "OBSERVED", result: "authenticated", document: next },
      11_000,
    );
    expect(attemptTimes(done, 11_000)).toMatchObject({ pageMs: 6_000, otherMs: 1_000 });
  });

  it("moves the wait for the site on by service time, so nothing counts twice", () => {
    const judged = addAttemptTime(submitted(), { serviceMs: 2_000, networkMs: 300 }, 9_000);
    expect(judged.timing.pageSince).toBe(7_000);
    const done = transitionLoginAttempt(judged, observed("authenticated"), 10_000);
    const times = attemptTimes(done, 10_000);
    expect(times).toEqual({
      totalMs: 9_000,
      serviceMs: 5_000,
      networkMs: 700,
      personMs: 0,
      pageMs: 3_000,
      otherMs: 1_000,
    });
    expect(sum(times)).toBe(times.totalMs);
  });

  it("ends the wait for the site while the person acts, and takes it up again after them", () => {
    const waiting = awaitPerson(submitted(), 6_000);
    expect(waiting.timing).toEqual({ ...timing, pageMs: 1_000, personSince: 6_000 });
    // A transition while the person acts starts no wait for the site.
    expect(
      transitionLoginAttempt(waiting, { type: "INTERRUPTED" }, 7_000).timing.pageSince,
    ).toBeUndefined();
    const pressed = followPage(personAnswered(waiting, 9_000), 9_000);
    expect(pressed.timing).toEqual({ ...timing, pageMs: 1_000, personMs: 3_000, pageSince: 9_000 });
    const done = transitionLoginAttempt(pressed, observed("authenticated"), 10_000);
    const times = attemptTimes(done, 10_000);
    expect(times).toMatchObject({ personMs: 3_000, pageMs: 2_000, otherMs: 1_000 });
    expect(sum(times)).toBe(times.totalMs);
    // A login that is not waiting for a step's result waits for no site.
    const ready = transitionLoginAttempt(
      createAttemptMetadata({
        id: "attempt-ready",
        recipe,
        policyRevision: 3,
        account: { origin: document.origin, connectionId: "demo-personal", itemId: "primary" },
        choice: { route: "password", variant: 0 },
        facts,
        document: top,
        timing,
      }),
      { type: "RESOLVE" },
      2_000,
    );
    expect(followPage(ready, 3_000)).toBe(ready);
  });

  it("stops waiting for the site once an unwatched login's result settled as unknown", () => {
    // A login in a frame is never watched: after its result settled, it only waits for a
    // later page, which is neither the site's answer nor the person's time.
    const settled = transitionLoginAttempt(
      submitted(5_000, document),
      { type: "OBSERVED", result: "unknown", document },
      10_000,
    );
    expect(settled).toMatchObject({
      state: "reconciling",
      settled: true,
      timing: { pageMs: 5_000 },
    });
    expect(settled.timing.pageSince).toBeUndefined();
    expect(settled.timing.personSince).toBeUndefined();
    expect(followPage(settled, 20_000)).toBe(settled);
    const restored = recoverLoginAttempt(JSON.parse(JSON.stringify(settled)));
    expect(restored.timing.pageSince).toBeUndefined();
    expect(attemptTimes(restored, 70_000)).toMatchObject({ pageMs: 5_000, personMs: 0 });
  });

  it("counts a watched login's wait as the person's, also across a worker restart", () => {
    const watching = transitionLoginAttempt(submitted(), observed("challenge"), 10_000);
    expect(watching).toMatchObject({
      state: "watching",
      timing: { pageMs: 5_000, personSince: 10_000 },
    });
    expect(watching.timing.pageSince).toBeUndefined();
    // A restarted worker reads the record back and keeps the running wait.
    const restored = recoverLoginAttempt(JSON.parse(JSON.stringify(watching)));
    expect(restored.timing).toEqual(watching.timing);
    expect(attemptTimes(restored, 25_000)).toEqual({
      totalMs: 24_000,
      serviceMs: 3_000,
      networkMs: 400,
      personMs: 15_000,
      pageMs: 5_000,
      otherMs: 1_000,
    });
    // The page that proves the sign-in ends the wait.
    const done = transitionLoginAttempt(restored, observed("authenticated"), 40_000);
    expect(done.state).toBe("authenticated");
    expect(done.timing).toEqual({ ...timing, personMs: 30_000, pageMs: 5_000 });
    expect(attemptTimes(done, 41_000)).toEqual({
      totalMs: 40_000,
      serviceMs: 3_000,
      networkMs: 400,
      personMs: 30_000,
      pageMs: 5_000,
      otherMs: 2_000,
    });
  });

  it("ends a watch that ran out with the person's time up to then", () => {
    const watching = transitionLoginAttempt(submitted(), observed("challenge"), 10_000);
    const ended = transitionLoginAttempt(watching, { type: "WATCH_ENDED" }, 70_000);
    expect(ended).toMatchObject({ state: "blocked", timing: { personMs: 60_000 } });
    expect(ended.timing.personSince).toBeUndefined();
  });

  it("counts the watch of a login whose result settled as unknown as the person's", () => {
    const settled = transitionLoginAttempt(submitted(), observed("unknown"), 10_000);
    expect(settled).toMatchObject({
      state: "reconciling",
      settled: true,
      timing: { pageMs: 5_000, personSince: 10_000 },
    });
    expect(settled.timing.pageSince).toBeUndefined();
    const ended = transitionLoginAttempt(settled, { type: "WATCH_ENDED" }, 70_000);
    expect(ended).toMatchObject({ state: "blocked", timing: { personMs: 60_000 } });
    expect(attemptTimes(ended, 70_000)).toEqual({
      totalMs: 69_000,
      serviceMs: 3_000,
      networkMs: 400,
      personMs: 60_000,
      pageMs: 5_000,
      otherMs: 1_000,
    });
  });

  it("moves a running wait for the person on by service time, so nothing counts twice", () => {
    const waiting = awaitPerson(submitted(), 10_000);
    expect(awaitPerson(waiting, 12_000)).toBe(waiting);
    const judged = addAttemptTime(waiting, { serviceMs: 2_000.4, networkMs: 300 }, 13_000);
    expect(judged.timing).toEqual({
      ...timing,
      serviceMs: 5_000,
      networkMs: 700,
      pageMs: 5_000,
      personSince: 12_000,
    });
    // Service time never moves the wait past now.
    expect(addAttemptTime(waiting, { serviceMs: 9_000 }, 11_000).timing.personSince).toBe(11_000);
    expect(personAnswered(judged, 20_000).timing).toEqual({
      ...timing,
      serviceMs: 5_000,
      networkMs: 700,
      pageMs: 5_000,
      personMs: 8_000,
    });
    const ready = transitionLoginAttempt(submitted(), observed("authenticated"), 6_000);
    expect(personAnswered(ready, 20_000)).toEqual(ready);
  });

  it("never reports a negative time, as after a clock that moved back", () => {
    const attempt = addAttemptTime(submitted(), { serviceMs: 9_000, personMs: -5 }, 5_000);
    expect(attemptTimes(attempt, 500)).toEqual({
      totalMs: 0,
      serviceMs: 12_000,
      networkMs: 400,
      personMs: 0,
      pageMs: 0,
      otherMs: 0,
    });
  });

  it("never lets the wait for the site make the parts more than the total", () => {
    const attempt = parseAttemptMetadata({
      ...submitted(),
      timing: { ...timing, pageMs: 50_000 },
    });
    const times = attemptTimes(attempt, 10_000);
    expect(times).toMatchObject({ totalMs: 9_000, pageMs: 6_000, otherMs: 0 });
    expect(sum(times)).toBe(times.totalMs);
  });
});

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
      { kind: "click", path: "/login/done", target: { by: "id", value: "ok" }, purpose: "submit" },
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
    expect(transitionLoginAttempt(before, layout({ maxSubmissions: 1, steps: 3 }))).toMatchObject({
      layout: "2000",
      maxSubmissions: 1,
    });
    const top = { ...document, frameId: 0 };
    for (const attempt of [
      parseAttemptMetadata({ ...before, layout: undefined }),
      parseAttemptMetadata({ ...before, variant: 1 }),
      parseAttemptMetadata({ ...before, route: "passkey" }),
      parseAttemptMetadata({ ...before, handlers: [{ index: 0, start: 2 }] }),
      parseAttemptMetadata({ ...before, chooser: { click: "entry" } }),
      parseAttemptMetadata({ ...before, fillOnly: true }),
      parseAttemptMetadata({ ...before, document: top, stopAt: 2 }),
    ])
      expect(
        transitionLoginAttempt(attempt, layout({ document: { ...passwordPage, frameId: 0 } })),
      ).toEqual(attempt);
  });

  it("refuses a switch while a step that cannot advance is in flight", () => {
    // The email fill, before its click.
    let attempt = transitionLoginAttempt(detected(first), { type: "RESOLVE" });
    attempt = transitionLoginAttempt(attempt, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill-one" });
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
