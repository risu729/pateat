import { describe, expect, it } from "vitest";
import {
  nextLoginOperation,
  parseAttemptMetadata,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import type { PasswordStopTestContext } from "./context";

export function registerPasswordStopPasskeys({
  top,
  id,
  emailFirst,
  create,
  atStop,
  answer,
}: Pick<
  PasswordStopTestContext,
  "top" | "id" | "emailFirst" | "create" | "atStop" | "answer"
>): void {
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
    // A settled one, watched, only reads its later pages (owner, 2026-11-08).
    const settled = transitionLoginAttempt(unstopped, {
      type: "OBSERVED",
      result: "unknown",
    });
    expect(settled).toMatchObject({ state: "reconciling", settled: true });
    expect(transitionLoginAttempt(settled, toPassword)).toMatchObject({ route: "passkey" });
  });
}
