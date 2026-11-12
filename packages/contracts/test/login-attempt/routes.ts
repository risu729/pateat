import { describe, expect, it } from "vitest";
import {
  attemptPlan,
  attemptRouteChoice,
  attemptUsesCode,
  createAttemptMetadata,
  handlerSlots,
  nextLoginOperation,
  recoverLoginAttempt,
  transitionLoginAttempt,
} from "../../src/login-attempt";
import type { LoginRecipe } from "../../src/login";
import type { LoginAttemptTestContext, LoginAttemptMetadataLike } from "./context";

export function registerPasswordVariants({
  facts,
  document,
  recipe,
  noTimeBefore,
}: Pick<LoginAttemptTestContext, "facts" | "document" | "recipe" | "noTimeBefore">): void {
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
}

export function registerPasskeyRoute({
  facts,
  document,
  recipe,
  noTimeBefore,
}: Pick<LoginAttemptTestContext, "facts" | "document" | "recipe" | "noTimeBefore">): void {
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
        {
          kind: "click",
          path: "/login",
          target: { by: "id", value: "password" },
          purpose: "submit",
        },
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
}

export function registerTotpContracts({
  document,
  recipe,
  detected,
}: Pick<LoginAttemptTestContext, "document" | "recipe" | "detected">): void {
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
}

export function registerPasskeyRouteChanges({
  facts,
  document,
  recipe,
  noTimeBefore,
  readyToClick,
  submitting,
}: Pick<
  LoginAttemptTestContext,
  "facts" | "document" | "recipe" | "noTimeBefore" | "readyToClick" | "submitting"
>): void {
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
      expect(filled).toMatchObject({
        state: "ready",
        route: "passkey",
        stepIndex: 0,
        stepCount: 1,
      });
      expect(filled.usedOperationIds).toEqual(["fill-one"]);
      // And back, while still nothing was submitted.
      const back = transitionLoginAttempt(switched, toPassword);
      expect(back).toMatchObject({
        state: "ready",
        route: "password",
        variant: 0,
        stepIndex: 0,
        stepCount: 2,
        maxSubmissions: 1,
        passkeyLeft: true,
      });
      // Once each way: a page whose request comes back again does not start the login over.
      expect(transitionLoginAttempt(back, toPasskey)).toEqual(back);
    });

    it("never takes the passkey route again after a passkey start went back to the password", () => {
      const back = transitionLoginAttempt(
        transitionLoginAttempt(create({ route: "passkey" }, { fallback: 0 }), { type: "RESOLVE" }),
        toPassword,
      );
      expect(back).toMatchObject({ state: "ready", route: "password", passkeyLeft: true });
      expect(transitionLoginAttempt(back, toPasskey)).toEqual(back);
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
      // A login that only fills while its tab asks for an account.
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
      expect(transitionLoginAttempt({ ...answered, maxSubmissions: 12 }, toPassword)).toMatchObject(
        {
          route: "password",
          submissions: 1,
          maxSubmissions: 12,
        },
      );
      expect(transitionLoginAttempt({ ...answered, maxSubmissions: 11 }, toPassword)).toMatchObject(
        {
          route: "password",
          maxSubmissions: 12,
        },
      );
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
}
