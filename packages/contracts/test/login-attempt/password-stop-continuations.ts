import { describe, expect, it } from "vitest";
import {
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
  validateLoginOperation,
} from "../../src/login-attempt";
import { CHOOSER_ENTRY_TARGET, type LoginRecipe } from "../../src/login";
import type { PasswordStopTestContext } from "./context";

export function registerPasswordStopContinuations({
  document,
  top,
  id,
  emailFirst,
  create,
  answer,
}: Pick<
  PasswordStopTestContext,
  "document" | "top" | "id" | "emailFirst" | "create" | "answer"
>): void {
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
}
