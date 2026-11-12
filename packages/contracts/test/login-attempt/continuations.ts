import { describe, expect, it } from "vitest";
import {
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import type { LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext, LoginAttemptMetadataLike } from "./context";

export function registerRecipeContinuations({
  document,
  recipe,
  detected,
  submitting,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected" | "submitting">): void {
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
      expect(
        transitionLoginAttempt(sent, { type: "UNCONTINUED", operationId: "next-one" }),
      ).toEqual(before);
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
      expect(
        transitionLoginAttempt(submitted, { ...continuing, operationId: "click-one" }),
      ).toEqual(submitted);
      // An advance that is not the route's last step continues with the recipe's own steps.
      let attempt = transitionLoginAttempt(detected(continued), { type: "RESOLVE" });
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
}

export function registerContinuationGuards({
  document,
  recipe,
  detected,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected">): void {
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
      const both = parseAttemptMetadata({
        ...sent(),
        stepCount: 8,
        stepIndex: 7,
        maxSubmissions: 4,
      });
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
        continued({
          recipeRevision: 3,
          document: { ...passwordPage, documentId: "document-three" },
        }),
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
}

export function registerReplacedAdvances({
  document,
  recipe,
  detected,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected">): void {
  describe("a disabled final advance replaced by its page (ADR 0018 amendment of 2026-11-03)", () => {
    // An email page whose Log In stays disabled until a password input opens after the email.
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
        { kind: "click", path: "/login", target: { by: "id", value: "login" }, purpose: "advance" },
      ],
    };
    const step = (
      attempt: LoginAttemptMetadataLike,
      events: Parameters<typeof transitionLoginAttempt>[1][],
    ) => events.reduce((current, event) => transitionLoginAttempt(current, event), attempt);
    /** At the disabled click: the email is filled, nothing is in flight. */
    const atClick = (selected = first) =>
      step(transitionLoginAttempt(detected(selected), { type: "RESOLVE" }), [
        { type: "PREPARE", operationId: "fill-one", kind: "fill" },
        { type: "MUTATION_INTENT", operationId: "fill-one" },
        { type: "OPERATION_OK", operationId: "fill-one" },
      ]);
    const continuing = { type: "CONTINUING" as const, before: 1 };
    const replaced = (change: Record<string, unknown> = {}) => ({
      type: "CONTINUED" as const,
      recipeRevision: 2,
      steps: 2,
      effects: 1,
      document,
      replacesLast: true as const,
      ...change,
    });

    it("records one request for the final step and takes the page's steps in its place", () => {
      const ready = atClick();
      expect(ready).toMatchObject({ state: "ready", stepIndex: 1, stepCount: 2 });
      const sent = transitionLoginAttempt(ready, continuing);
      expect(sent).toMatchObject({ state: "ready", continuation: { before: 1 } });
      expect(parseAttemptMetadata(sent)).toEqual(sent);
      // A second request for the same step is ignored.
      expect(transitionLoginAttempt(sent, continuing)).toEqual(sent);
      // Fill the password, then Log In: the login stays at its step, now the page's first.
      const taken = transitionLoginAttempt(sent, replaced());
      expect(taken).toMatchObject({
        state: "ready",
        recipeRevision: 2,
        stepIndex: 1,
        stepCount: 3,
        maxSubmissions: 1,
        submissions: 0,
      });
      expect(taken.continuation).toBeUndefined();
      expect(parseAttemptMetadata(taken)).toEqual(taken);
      // The request is spent: the same step never asks again, nor takes another revision.
      expect(transitionLoginAttempt(taken, replaced({ recipeRevision: 3 }))).toEqual(taken);
    });

    it("gives back a request that reached no model, once", () => {
      const sent = transitionLoginAttempt(atClick(), continuing);
      const back = transitionLoginAttempt(sent, { type: "UNCONTINUED", before: 1 });
      expect(back.continuation).toBeUndefined();
      expect(transitionLoginAttempt(back, { type: "UNCONTINUED", before: 1 })).toEqual(back);
      expect(transitionLoginAttempt(sent, { type: "UNCONTINUED", before: 0 })).toEqual(sent);
      expect(
        transitionLoginAttempt(sent, { type: "UNCONTINUED", operationId: "fill-one" }),
      ).toEqual(sent);
    });

    it("refuses a step other than the final one, and a login in flight", () => {
      const start = transitionLoginAttempt(detected(first), { type: "RESOLVE" });
      expect(start.stepIndex).toBe(0);
      expect(transitionLoginAttempt(start, { type: "CONTINUING", before: 0 })).toEqual(start);
      const ready = atClick();
      expect(transitionLoginAttempt(ready, { type: "CONTINUING", before: 0 })).toEqual(ready);
      const clicking = transitionLoginAttempt(ready, {
        type: "PREPARE",
        operationId: "login-one",
        kind: "click",
        effect: "advance",
      });
      expect(clicking.state).toBe("executing");
      expect(transitionLoginAttempt(clicking, continuing)).toEqual(clicking);
    });

    it("refuses a login with a stop, a handler, another route or variant, or only filling", () => {
      const ready = atClick();
      for (const change of [
        { stopAt: 2, document: { ...document, frameId: 0 } },
        { route: "passkey" },
        { variant: 1 },
        { fillOnly: true },
        { retryRequired: true },
      ]) {
        const record = { ...ready, ...change } as LoginAttemptMetadataLike;
        expect(transitionLoginAttempt(record, continuing)).toEqual(record);
      }
      // Without a recorded request, or with an advance's, the page's steps are refused.
      expect(transitionLoginAttempt(ready, replaced())).toEqual(ready);
      const stale = { ...ready, continuation: { before: 0 } } as LoginAttemptMetadataLike;
      expect(transitionLoginAttempt(stale, replaced())).toEqual(stale);
    });

    it("keeps the caps and the scope, and needs a newer revision", () => {
      const sent = transitionLoginAttempt(atClick(), continuing);
      expect(transitionLoginAttempt(sent, replaced({ recipeRevision: 1 }))).toEqual(sent);
      expect(transitionLoginAttempt(sent, replaced({ stopAt: 2 }))).toEqual(sent);
      expect(
        transitionLoginAttempt(sent, replaced({ document: { ...document, frameId: 0 } })),
      ).toEqual(sent);
      // 9 steps in, at the last: 32 in its place reach the attempt's 40 steps exactly.
      const long = parseAttemptMetadata({
        ...sent,
        stepCount: 9,
        stepIndex: 8,
        continuation: { before: 8 },
      });
      expect(transitionLoginAttempt(long, replaced({ steps: 32 }))).toMatchObject({
        stepIndex: 8,
        stepCount: 40,
      });
      const longer = parseAttemptMetadata({
        ...long,
        stepCount: 10,
        stepIndex: 9,
        continuation: { before: 9 },
      });
      expect(transitionLoginAttempt(longer, replaced({ steps: 32 }))).toEqual(longer);
      // 12 submissions at most: 8 effects in place of one of 5 reach them exactly.
      const budget = parseAttemptMetadata({ ...sent, maxSubmissions: 5 });
      expect(transitionLoginAttempt(budget, replaced({ effects: 8 }))).toMatchObject({
        maxSubmissions: 12,
      });
      const over = parseAttemptMetadata({ ...sent, maxSubmissions: 6 });
      expect(transitionLoginAttempt(over, replaced({ effects: 8 }))).toEqual(over);
      // An advance's continuation takes no replacing page, nor the reverse.
      const { replacesLast: _replaces, ...following } = replaced();
      expect(transitionLoginAttempt(sent, following)).toEqual(sent);
    });
  });
}
