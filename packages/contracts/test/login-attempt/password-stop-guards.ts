import { describe, expect, it } from "vitest";
import {
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  pagesLeft,
  transitionLoginAttempt,
  validateLoginOperation,
} from "../../src/login-attempt";
import type { PasswordStopTestContext } from "./context";

export function registerPasswordStopGuards({
  top,
  emailFirst,
  create,
  advanced,
  atStop,
  answer,
}: Pick<
  PasswordStopTestContext,
  "top" | "emailFirst" | "create" | "advanced" | "atStop" | "answer"
>): void {
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
}
