import { describe, expect, it } from "vitest";
import {
  attemptPlan,
  createAttemptMetadata,
  handlerSlots,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  judgedPages,
  MAX_JUDGED_PAGES,
  transitionLoginAttempt,
  validateLoginOperation,
} from "../../src/login-attempt";
import type { LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext } from "./context";

export function registerSecondFactorHandlers({
  facts,
  document,
  recipe,
  noTimeBefore,
  detected,
}: Pick<
  LoginAttemptTestContext,
  "facts" | "document" | "recipe" | "noTimeBefore" | "detected"
>): void {
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
      attempt = transitionLoginAttempt(attempt, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
      attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill-one" });
      attempt = transitionLoginAttempt(attempt, {
        type: "PREPARE",
        operationId: "click-one",
        kind: "click",
      });
      attempt = transitionLoginAttempt(attempt, {
        type: "SUBMIT_INTENT",
        operationId: "click-one",
      });
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
      clicking = transitionLoginAttempt(clicking, {
        type: "SUBMIT_INTENT",
        operationId: "key-one",
      });
      expect(clicking).toMatchObject({ state: "submit-intent", submissions: 2 });
      expect(validateLoginOperation(operation, clicking, webauthn, 3, 1001)).toBe(true);
      const signedIn = transitionLoginAttempt(
        transitionLoginAttempt(clicking, { type: "SUBMITTED", operationId: "key-one" }),
        { type: "OBSERVED", result: "authenticated", document: webauthn },
      );
      expect(signedIn.state).toBe("authenticated");
    });

    it("enters a handler while reconciling after the page navigated", () => {
      const navigated = transitionLoginAttempt(awaiting(), {
        type: "NAVIGATED",
        document: webauthn,
      });
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
      // A result settled as unknown is watched, in a frame too (ADR 0086): a later page of
      // the watch counts against the watch's own pages (ADR 0027).
      const moved = transitionLoginAttempt(unknown, { type: "NAVIGATED", document: webauthn });
      expect(moved).toMatchObject({ state: "reconciling", judged: { pages: 1 }, watch: {} });
      const second = transitionLoginAttempt(moved, judging);
      expect(second).toMatchObject({
        judged: { operationId: "click-one", pages: 1 },
        watch: { pages: 1 },
      });
      // Before the result settled, a second page of the same step is its last.
      const twice = transitionLoginAttempt(first, judging);
      expect(twice).toMatchObject({ judged: { operationId: "click-one", pages: 2 } });
      expect(judgedPages(twice, "click-one")).toBe(MAX_JUDGED_PAGES);
      expect(transitionLoginAttempt(twice, judging)).toEqual(twice);
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
        nextLoginOperation(
          entered,
          { ...handled, handlers: [handled.handlers![0]!] },
          webauthn,
          "k",
        ),
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
}

export function registerTotpHandler({
  document,
  recipe,
  detected,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected">): void {
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
        const resumed = transitionLoginAttempt(submitted, {
          type: "NAVIGATED",
          document: codePage,
        });
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
      attempt = transitionLoginAttempt(attempt, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
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
      attempt = transitionLoginAttempt(attempt, {
        type: "MUTATION_INTENT",
        operationId: "fill-one",
      });
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
}

export function registerDetailHandler({
  document,
  recipe,
  detected,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected">): void {
  describe("the detail handler in an attempt (ADR 0061)", () => {
    const detail = {
      kind: "detail",
      path: "/confirm",
      fields: [
        { detail: "birth-date", format: "yyyymm", target: { by: "name", value: "birth" } },
        { detail: "phone-last-4", target: { by: "name", value: "phone" } },
      ],
      target: { by: "id", value: "submit" },
    } as const;
    const detailed: LoginRecipe = { ...recipe, handlers: [detail] };
    const confirmPage = { ...document, documentId: "document-confirm" };
    /** After the route's click, with the handler entered to fill input `field`. */
    function entered(field?: number) {
      let attempt = transitionLoginAttempt(detected(detailed), { type: "RESOLVE" });
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
        ...(field === undefined ? {} : { field }),
        steps: 2,
        effects: 1,
        document: confirmPage,
      });
    }
    const fillOf = (name: string) => ({
      step: {
        kind: "fill",
        path: "/confirm",
        fields: [{ slot: "detail", target: { by: "name", value: name } }],
        effect: "prepare",
      },
      handler: 0,
    });
    const click = {
      step: { kind: "click", path: "/confirm", target: detail.target, purpose: "submit" },
      handler: 0,
    };

    it("records the input the login fills and plans its fill and the button's click", () => {
      const attempt = entered(1);
      expect(attempt).toMatchObject({
        state: "ready",
        stepIndex: 2,
        stepCount: 4,
        handlers: [{ index: 0, start: 2, field: 1 }],
      });
      expect(attemptPlan(detailed, attempt)?.slice(2)).toEqual([fillOf("phone"), click]);
    });

    it("keeps the chosen input after a worker restart", () => {
      const restored = recoverLoginAttempt(parseAttemptMetadata(structuredClone(entered(1))));
      expect(restored.handlers).toEqual([{ index: 0, start: 2, field: 1 }]);
      expect(attemptPlan(detailed, restored)?.slice(2)).toEqual([fillOf("phone"), click]);
    });

    it("plans the first input for a handler entered without one", () => {
      const attempt = entered();
      expect(attempt.handlers).toEqual([{ index: 0, start: 2 }]);
      expect(attemptPlan(detailed, attempt)?.slice(2)).toEqual([fillOf("birth"), click]);
      expect(attemptPlan(detailed, entered(0))?.slice(2)).toEqual([fillOf("birth"), click]);
    });

    it("refuses an input beyond a handler's three", () => {
      expect(() => entered(3)).toThrow();
      expect(() => entered(-1)).toThrow();
      expect(() =>
        parseAttemptMetadata({ ...entered(1), handlers: [{ index: 0, start: 2, field: 3 }] }),
      ).toThrow();
    });
  });
}
