import { describe, expect, it } from "vitest";
import { createAttemptMetadata, transitionLoginAttempt } from "./login-attempt";
import type { LoginDocument } from "./login/account";
import type { LoginRecipe } from "./login/route-schema";

// A watched login enters one `totp` handler for the authenticator app's code its page asks
// for after the person's own step, as Luma's dialog does after its emailed code (ADR 0027
// amendment of 2026-11-17).

const top: LoginDocument = {
  origin: "https://events.example",
  tabId: 4,
  frameId: 0,
  documentId: "dialog",
};
const id = (value: string) => ({ by: "id" as const, value });
/** The email and Continue; the code pages follow on the same path. */
const emailOnly: LoginRecipe = {
  version: 1,
  id: "synthetic-email-code",
  revision: 2,
  origin: top.origin,
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill",
      effect: "prepare",
      path: "/signin",
      fields: [{ slot: "username", target: id("email") }],
    },
    { kind: "click", path: "/signin", target: id("continue"), purpose: "advance" },
  ],
  handlers: [{ kind: "totp", path: "/signin", field: id("code") }],
  maxSubmissions: 1,
};
const noTimeBefore = { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 };
const facts = { password: false, totp: true, passkey: false, discoverablePasskey: false };
const handler = { type: "HANDLER", handler: 0, steps: 1, effects: 1, document: top } as const;

/** The email filled and Continue clicked: the item has no password, so it stops past them. */
function watchedAtStop(change: Partial<Parameters<typeof createAttemptMetadata>[0]> = {}) {
  let attempt = createAttemptMetadata({
    timing: noTimeBefore,
    id: "attempt-watched",
    recipe: emailOnly,
    policyRevision: 1,
    account: { origin: top.origin, connectionId: "demo-personal", itemId: "primary" },
    choice: { route: "password", variant: 0 },
    facts,
    document: top,
    stopAt: 2,
    ...change,
  });
  attempt = transitionLoginAttempt(attempt, { type: "RESOLVE" });
  attempt = transitionLoginAttempt(attempt, { type: "PREPARE", operationId: "fill", kind: "fill" });
  attempt = transitionLoginAttempt(attempt, { type: "MUTATION_INTENT", operationId: "fill" });
  attempt = transitionLoginAttempt(attempt, { type: "OPERATION_OK", operationId: "fill" });
  attempt = transitionLoginAttempt(attempt, {
    type: "PREPARE",
    operationId: "continue",
    kind: "click",
    effect: "advance",
  });
  attempt = transitionLoginAttempt(attempt, { type: "SUBMIT_INTENT", operationId: "continue" });
  attempt = transitionLoginAttempt(attempt, { type: "SUBMITTED", operationId: "continue" });
  attempt = transitionLoginAttempt(attempt, {
    type: "OBSERVED",
    result: "continue",
    document: top,
  });
  return transitionLoginAttempt(attempt, { type: "OBSERVED", result: "challenge", document: top });
}

describe("a totp handler entered while watched (ADR 0027 amendment of 2026-11-17)", () => {
  it("goes in at the stop, which moves past it, and the watch ends", () => {
    const watched = watchedAtStop();
    expect(watched).toMatchObject({ state: "watching", stepIndex: 2, stopAt: 2 });
    expect(watched.watch).toBeDefined();
    const entered = transitionLoginAttempt(watched, handler);
    expect(entered).toMatchObject({
      state: "ready",
      stepIndex: 2,
      stepCount: 3,
      stopAt: 3,
      handlers: [{ index: 0, start: 2 }],
    });
    expect(entered.watch).toBeUndefined();
    // Its result shown as a challenge again is watched again; the handler never runs twice.
    const again = transitionLoginAttempt(
      { ...entered, stepIndex: 3 },
      { type: "OBSERVED", result: "challenge", document: top },
    );
    expect(again.state).toBe("watching");
    expect(transitionLoginAttempt(again, handler).state).toBe("watching");
  });

  it("is refused to a login that only fills, and for another document's scope", () => {
    expect(transitionLoginAttempt(watchedAtStop({ fillOnly: true }), handler).state).not.toBe(
      "ready",
    );
    const watched = watchedAtStop();
    expect(
      transitionLoginAttempt(watched, {
        ...handler,
        document: { ...top, origin: "https://other.example" },
      }).state,
    ).toBe("watching");
  });
});
