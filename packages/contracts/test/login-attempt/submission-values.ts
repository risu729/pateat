import { expect, it } from "vitest";
import { nextLoginOperation, transitionLoginAttempt } from "../../src/login-attempt";
import { type LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerSubmissionValues({
  document,
  recipe,
  detected,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected">): void {
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
    // A split detail value that fits none of its inputs, such as a select with no option
    // for its part, leaves the page to the person (ADR 0061, owner 2026-10-23 12:26 UTC).
    const unfit = transitionLoginAttempt(
      intent,
      {
        type: "VALUE_REJECTED",
        operationId: "fill-one",
        document,
        stage: "before-fill",
        challenge: true,
      },
      4000,
    );
    // A password login is watched for the person's finish, as after a judged challenge
    // (ADR 0027), in a frame (ADR 0086) as in the tab's page.
    expect(unfit).toMatchObject({
      state: "watching",
      outcome: "challenge",
      submissions: 0,
      watch: { since: 4000, documentId: "document-one" },
    });
    expect(unfit.mutationIntent).toBeUndefined();
    const topDocument = { ...document, frameId: 0 };
    let topIntent = transitionLoginAttempt(
      { ...detected(), document: topDocument },
      { type: "RESOLVE" },
    );
    topIntent = transitionLoginAttempt(topIntent, {
      type: "PREPARE",
      operationId: "fill-one",
      kind: "fill",
    });
    topIntent = transitionLoginAttempt(topIntent, {
      type: "MUTATION_INTENT",
      operationId: "fill-one",
    });
    const watched = transitionLoginAttempt(
      topIntent,
      {
        type: "VALUE_REJECTED",
        operationId: "fill-one",
        document: topDocument,
        stage: "before-fill",
        challenge: true,
      },
      4000,
    );
    expect(watched).toMatchObject({
      state: "watching",
      outcome: "challenge",
      submissions: 0,
      watch: { since: 4000, documentId: "document-one" },
    });
    expect(watched.mutationIntent).toBeUndefined();
    // A value that does not fit is no challenge, and is not watched.
    expect(
      transitionLoginAttempt(topIntent, {
        type: "VALUE_REJECTED",
        operationId: "fill-one",
        document: topDocument,
        stage: "before-fill",
      }),
    ).toMatchObject({ state: "blocked", outcome: "value-mismatch" });
    expect(
      transitionLoginAttempt(intent, {
        type: "VALUE_REJECTED",
        operationId: "fill-one",
        document,
        stage: "after-fill",
        challenge: true,
      }),
    ).toEqual(intent);
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
    // A click whose check failed before it went out is still taken back.
    const unsent = transitionLoginAttempt(intent, { type: "FAILED", reason: "timeout" });
    expect(unsent).toMatchObject({ state: "reconciling", submissions: 1 });
    expect(
      transitionLoginAttempt(unsent, { type: "POLICY_CHANGED", undelivered: "click-one" }),
    ).toMatchObject({ state: "blocked", submissions: 0, mutationIntent: undefined });
    // An operation the page said it took was delivered.
    const submitted = transitionLoginAttempt(intent, {
      type: "SUBMITTED",
      operationId: "click-one",
    });
    expect(
      transitionLoginAttempt(submitted, { type: "POLICY_CHANGED", undelivered: "click-one" }),
    ).toMatchObject({ state: "blocked", submissions: 1, mutationIntent: true });
  });
}
