import { describe, expect, it } from "vitest";
import {
  createAttemptMetadata,
  nextLoginOperation,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
  validateLoginOperation,
  type LoginAttemptMetadata,
} from "./login-attempt";
import { holdsOrigin } from "./login-attempt-hold";
import { parseLoginRecipe, type LoginDocument, type LoginRecipe, type LoginStep } from "./login";

const document: LoginDocument = {
  origin: "https://login.example",
  tabId: 7,
  frameId: 2,
  documentId: "first-document",
};
const field = (slot: string) => ({ slot, target: { by: "id" as const, value: slot } });
const recipe = parseLoginRecipe({
  version: 1,
  id: "synthetic-fill",
  revision: 1,
  origin: document.origin,
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    { kind: "fill", path: "/signin", fields: [field("username")] },
    { kind: "click", path: "/signin", target: { by: "id", value: "next" }, purpose: "advance" },
    { kind: "fill", path: "/password", fields: [field("password")] },
    { kind: "click", path: "/password", target: { by: "id", value: "login" }, purpose: "submit" },
  ],
  maxSubmissions: 2,
});
const create = (
  used: LoginRecipe = recipe,
  extra: Partial<Parameters<typeof createAttemptMetadata>[0]> = {},
) =>
  createAttemptMetadata({
    id: "fill-attempt",
    recipe: used,
    policyRevision: 1,
    account: { origin: document.origin, connectionId: "synthetic-vault", itemId: "primary" },
    choice: { route: "password", variant: 0 },
    facts: { password: true, totp: true, passkey: true, discoverablePasskey: true },
    document,
    signInFill: true,
    fillPermissionSource: "site",
    timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    ...extra,
  });
const ready = (used = recipe) => transitionLoginAttempt(create(used), { type: "RESOLVE" });
const intent = (start: LoginAttemptMetadata, mutation = true) => {
  const prepared = transitionLoginAttempt(start, {
    type: "PREPARE",
    operationId: "fill-one",
    kind: "fill",
    effect: "prepare",
  });
  return mutation
    ? transitionLoginAttempt(prepared, { type: "MUTATION_INTENT", operationId: "fill-one" })
    : prepared;
};

describe("sign-in autofill attempt contracts", () => {
  it("records a distinct password mode without granting logout fill or submissions", () => {
    const attempt = create();
    expect(attempt).toMatchObject({
      signInFill: true,
      fillPermissionSource: "site",
      fillSince: expect.any(Number),
      submissions: 0,
    });
    expect(attempt).not.toHaveProperty("fillOnly");
    expect(parseAttemptMetadata(attempt)).toEqual(attempt);
    expect(() => create(recipe, { fillOnly: true })).toThrow();
    expect(() => create(recipe, { choice: { route: "passkey" } })).toThrow();
    expect(holdsOrigin(ready())).toBe(false);
  });

  it.each(["advance", "submit"] as const)(
    "never issues or validates a fill with %s effects",
    (effect) => {
      const used = parseLoginRecipe({
        ...recipe,
        slots: ["username"],
        steps: [
          { kind: "fill", effect, event: "input", path: "/signin", fields: [field("username")] },
        ],
        maxSubmissions: 1,
      });
      const passive = ready(used);
      expect(nextLoginOperation(passive, used, document, "one")).toBeUndefined();
      const auto = { ...passive, signInFill: undefined };
      const operation = nextLoginOperation(auto, used, document, "fill-one", 1000)!;
      expect(
        validateLoginOperation(
          { ...operation, signInFill: true },
          intent(passive),
          document,
          1,
          1001,
        ),
      ).toBe(false);
    },
  );

  it("excludes clicks, code-only fills and every keypad field while retaining ordinary fields beside a code", () => {
    const code: LoginStep = { kind: "fill", path: "/signin", fields: [field("totp")] };
    const keypad: LoginStep = {
      kind: "fill",
      path: "/signin",
      fields: [{ ...field("password"), keypad: { by: "id", value: "keys" } }],
    };
    for (const step of [recipe.steps[1]!, code, keypad]) {
      const used = parseLoginRecipe({
        ...recipe,
        slots: step.kind === "fill" ? step.fields.map((entry) => entry.slot) : ["username"],
        steps: step.kind === "click" ? [recipe.steps[0]!, step] : [step],
        maxSubmissions: 1,
      });
      expect(
        nextLoginOperation(
          step.kind === "click" ? { ...ready(used), stepIndex: 1 } : ready(used),
          used,
          document,
          "unsafe",
        ),
      ).toBeUndefined();
    }
    const mixed = parseLoginRecipe({
      ...recipe,
      slots: ["password", "totp"],
      steps: [{ kind: "fill", path: "/signin", fields: [field("password"), field("totp")] }],
      maxSubmissions: 1,
    });
    expect(nextLoginOperation(ready(mixed), mixed, document, "safe")?.step).toEqual({
      kind: "fill",
      effect: "prepare",
      path: "/signin",
      fields: [field("password")],
    });
  });

  it("binds its operation to mode, policy revision and the exact document scope", () => {
    const start = ready();
    const operation = nextLoginOperation(start, recipe, document, "fill-one", 1000)!;
    const sent = intent(start);
    expect(operation).toMatchObject({ signInFill: true, stepIndex: 0 });
    expect(validateLoginOperation(operation, sent, document, 1, 1001)).toBe(true);
    expect(
      validateLoginOperation({ ...operation, signInFill: undefined }, sent, document, 1, 1001),
    ).toBe(false);
    expect(validateLoginOperation(operation, sent, document, 2, 1001)).toBe(false);
    for (const foreign of [
      { ...document, tabId: 8 },
      { ...document, frameId: 0 },
      { ...document, documentId: "replacement" },
      { ...document, origin: "https://other.example" },
    ]) {
      expect(nextLoginOperation(start, recipe, foreign, "other")).toBeUndefined();
      expect(validateLoginOperation(operation, sent, foreign, 1, 1001)).toBe(false);
      if (foreign.documentId === document.documentId)
        expect(transitionLoginAttempt(sent, { type: "NAVIGATED", document: foreign }).state).toBe(
          "blocked",
        );
    }
  });

  it("consumes a persisted mutation intent once on restart and ignores its late acknowledgement", () => {
    const sent = intent(ready());
    const restored = recoverLoginAttempt(sent);
    expect(restored).toMatchObject({
      state: "ready",
      stepIndex: 1,
      submissions: 0,
      signInFill: true,
    });
    expect(restored.operationId).toBeUndefined();
    expect(recoverLoginAttempt(restored)).toEqual(restored);
    expect(
      transitionLoginAttempt(restored, { type: "OPERATION_OK", operationId: "fill-one" }),
    ).toEqual(restored);
    expect(nextLoginOperation(restored, recipe, document, "again")).toBeUndefined();
    expect(recoverLoginAttempt(intent(ready(), false))).toMatchObject({
      state: "ready",
      stepIndex: 0,
      submissions: 0,
    });
  });

  it("consumes a fill intent on direct new-document navigation without replaying or counting a press", () => {
    const sent = intent(ready());
    const next = { ...document, documentId: "second-document" };
    const moved = transitionLoginAttempt(sent, { type: "NAVIGATED", document: next });
    expect(moved).toMatchObject({ state: "ready", stepIndex: 1, submissions: 0, document: next });
    expect(transitionLoginAttempt(moved, { type: "NAVIGATED", document: next })).toEqual(moved);
    expect(
      transitionLoginAttempt(moved, { type: "OPERATION_OK", operationId: "fill-one" }),
    ).toEqual(moved);
    const before = transitionLoginAttempt(intent(ready(), false), {
      type: "NAVIGATED",
      document: next,
    });
    expect(before).toMatchObject({ state: "ready", stepIndex: 0, submissions: 0 });
  });

  it("retains its structural baseline across restart, progresses without fake clicks and records expiration", () => {
    const measured = transitionLoginAttempt(ready(), {
      type: "FILL_BASELINE",
      nextStep: 2,
      path: "/signin",
      ready: false,
    });
    expect(measured.fillBaseline).toEqual({
      stepIndex: 0,
      nextStep: 2,
      path: "/signin",
      ready: false,
      documentId: document.documentId,
    });
    const completed = transitionLoginAttempt(intent(measured), {
      type: "OPERATION_OK",
      operationId: "fill-one",
    });
    const progressed = transitionLoginAttempt(completed, { type: "FILL_PROGRESS", stepIndex: 2 });
    expect(progressed).toMatchObject({
      state: "ready",
      stepIndex: 2,
      submissions: 0,
      fillBaseline: measured.fillBaseline,
    });
    expect(nextLoginOperation(progressed, recipe, document, "password")?.step).toEqual(
      recipe.steps[2],
    );
    for (const stepIndex of [0, 1, 10])
      expect(transitionLoginAttempt(progressed, { type: "FILL_PROGRESS", stepIndex })).toEqual(
        progressed,
      );
    const expired = transitionLoginAttempt(progressed, { type: "FILL_EXPIRED" });
    expect(expired).toMatchObject({
      state: "blocked",
      outcome: "cancelled",
      fillExpired: true,
      submissions: 0,
    });
    expect(nextLoginOperation(expired, recipe, document, "expired")).toBeUndefined();
    const done = transitionLoginAttempt(progressed, { type: "FILL_DONE" });
    expect(done).toMatchObject({
      state: "blocked",
      outcome: "cancelled",
      fillDone: true,
      stepIndex: 2,
      submissions: 0,
    });
    expect(done.fillExpired).toBeUndefined();
    expect(nextLoginOperation(done, recipe, document, "done")).toBeUndefined();
    const { signInFill: _, ...ordinary } = progressed;
    expect(transitionLoginAttempt(ordinary, { type: "FILL_DONE" })).toEqual(ordinary);
  });

  it("ignores automatic judgement, passkey route switches and automatic submissions", () => {
    const start = ready();
    for (const event of [
      { type: "ROUTE", route: "passkey", steps: 1 },
      { type: "JUDGING", operationId: "judge" },
      { type: "AUTO_SUBMITTED", operationId: "auto" },
    ]) {
      expect(transitionLoginAttempt(start, event)).toEqual(start);
    }
  });
  it("persists a person's after-step continuation without fabricating an operation or submission", () => {
    const first = parseLoginRecipe({
      ...recipe,
      slots: ["username"],
      steps: recipe.steps.slice(0, 2),
      maxSubmissions: 1,
    });
    const atNext = transitionLoginAttempt(intent(ready(first)), {
      type: "OPERATION_OK",
      operationId: "fill-one",
    });
    const pending = transitionLoginAttempt(atNext, { type: "FILL_CONTINUING", after: 1 });
    expect(pending).toMatchObject({
      state: "ready",
      stepIndex: 1,
      continuation: { after: 1 },
      submissions: 0,
    });
    expect(pending.operationId).toBeUndefined();
    expect(recoverLoginAttempt(pending)).toEqual(pending);
    const event = { type: "CONTINUED", recipeRevision: 2, steps: 2, effects: 1, document };
    expect(
      transitionLoginAttempt(pending, { ...event, document: { ...document, documentId: "stale" } }),
    ).toEqual(pending);
    expect(transitionLoginAttempt(pending, { ...event, recipeRevision: 1 })).toEqual(pending);
    const adopted = transitionLoginAttempt(pending, event);
    expect(adopted).toMatchObject({
      state: "ready",
      recipeRevision: 2,
      stepIndex: 2,
      stepCount: 4,
      submissions: 0,
    });
    expect(adopted.continuation).toBeUndefined();
    expect(adopted.operationId).toBeUndefined();
    expect(transitionLoginAttempt(adopted, event)).toEqual(adopted);
  });

  it("releases only the matching passive continuation reservation after a retryable refusal", () => {
    const first = parseLoginRecipe({
      ...recipe,
      slots: ["username"],
      steps: recipe.steps.slice(0, 2),
      maxSubmissions: 1,
    });
    const atNext = transitionLoginAttempt(intent(ready(first)), {
      type: "OPERATION_OK",
      operationId: "fill-one",
    });
    expect(transitionLoginAttempt(atNext, { type: "FILL_CONTINUING", after: 0 })).toEqual(atNext);
    const pending = transitionLoginAttempt(atNext, { type: "FILL_CONTINUING", after: 1 });
    expect(transitionLoginAttempt(pending, { type: "FILL_UNCONTINUED", after: 0 })).toEqual(
      pending,
    );
    expect(
      transitionLoginAttempt(pending, { type: "FILL_UNCONTINUED", after: 1 }).continuation,
    ).toBeUndefined();
    const auto = ready(first);
    expect(
      transitionLoginAttempt(
        { ...auto, signInFill: undefined },
        { type: "FILL_CONTINUING", after: 0 },
      ).continuation,
    ).toBeUndefined();
  });
});
