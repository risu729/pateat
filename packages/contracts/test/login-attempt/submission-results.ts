import { expect, it } from "vitest";
import { holdsOrigin } from "../../src/login-attempt-hold";
import {
  createAttemptMetadata,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
  withdrawAccountSwitch,
} from "../../src/login-attempt";
import type { LoginDocument, LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerSubmissionResults({
  facts,
  document,
  recipe,
  noTimeBefore,
  detected,
  submitting,
}: Pick<
  LoginAttemptTestContext,
  "facts" | "document" | "recipe" | "noTimeBefore" | "detected" | "submitting"
>): void {
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
    // A click the fill left its account check to ends the same way, before anything was
    // submitted (ADR 0049 amendment of 2026-11-03).
    const clicking = submitting();
    expect(clicking).toMatchObject({ state: "submit-intent", submissions: 1 });
    expect(
      transitionLoginAttempt(clicking, {
        type: "WRONG_ACCOUNT",
        operationId: "click-one",
        document,
        switched: true,
      }),
    ).toMatchObject({ state: "blocked", outcome: "account-switched", submissions: 0 });
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
    // A click reports one only for its own operation.
    expect(
      transitionLoginAttempt(submitting(), {
        type: "WRONG_ACCOUNT",
        operationId: "click-two",
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

  // Owner, 2026-11-09: a tab that left during a fill that submits nothing holds nothing;
  // one whose fill the page may submit by itself, as a PIN pad does, still holds.
  it("holds the origin after leaving it during a fill only when the page may submit it", () => {
    const top: LoginDocument = { ...document, frameId: 0 };
    const away: LoginDocument = {
      origin: "https://other.example",
      tabId: top.tabId,
      frameId: 0,
      documentId: "document-away",
    };
    const left = (presses: boolean) => {
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
        ...(presses ? { presses: true as const } : {}),
      });
      filling = transitionLoginAttempt(filling, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      return transitionLoginAttempt(filling, { type: "NAVIGATED", document: away });
    };
    expect(left(false)).toMatchObject({ state: "blocked", outcome: "left-origin", submissions: 0 });
    expect(holdsOrigin(left(false))).toBe(false);
    expect(holdsOrigin(left(true))).toBe(true);
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
    // A tab that shows no web page any more ends the same way (ADR 0022, 2026-11-04).
    expect(transitionLoginAttempt(failed, { type: "LEFT" })).toMatchObject({
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
    expect(transitionLoginAttempt(possible, { type: "LEFT" })).toMatchObject({
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
}
