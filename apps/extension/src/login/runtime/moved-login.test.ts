import { describe, expect, it, vi } from "vitest";
import type { LoginAttemptMetadata } from "@pateat/contracts";
import type { Runtime } from "./state";

vi.mock("wxt/browser", () => ({ browser: {} }));
const { movedLogin } = await import("./moves");

// ADR 0036 amendment of 2026-11-17 (owner's option D): which logins a page the tab moved
// to may answer a passkey request for.
const origin = "https://login.example";
const auth = "https://auth.login.example";
function runtime(extra: Partial<LoginAttemptMetadata> = {}) {
  const now = Date.now();
  const metadata = {
    version: 1,
    id: "attempt",
    recipeId: "recipe",
    recipeRevision: 1,
    policyRevision: 1,
    account: { origin, connectionId: "connection", itemId: "item" },
    route: "password",
    variant: 0,
    facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
    handlers: [],
    document: { origin, tabId: 1, frameId: 0, documentId: "sign-in" },
    state: "executing",
    stepIndex: 1,
    stepCount: 4,
    submissions: 0,
    maxSubmissions: 2,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    changedAt: now,
    timing: { since: now, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    ...extra,
  } as LoginAttemptMetadata;
  return {
    vars: { loaded: Promise.resolve() },
    attempts: new Map([[1, { metadata, running: true }]]),
    persisted: new Map(),
    effects: new Map([
      [
        1,
        {
          attemptId: "attempt",
          at: now - 1000,
          document: metadata.document,
          submits: false,
          passkey: false,
          request: false,
        },
      ],
    ]),
    passkeyPages: new Map(),
    passkeyAnswers: new Map(),
    passkeyRequests: new Map([[`1 ${auth}`, now]]),
  } as unknown as Runtime;
}

describe("the login a passkey request of a moved page is answered for", () => {
  it("is a running login whose tab moved within 30 seconds of its last step", async () => {
    expect(await movedLogin(runtime(), 1, auth, "auth-page")).toEqual({
      connectionId: "connection",
      itemId: "item",
      origin,
      sameSite: true,
    });
  });

  it.each<[string, Partial<LoginAttemptMetadata>]>([
    ["settled as unknown", { settled: true }],
    ["only filling", { fillOnly: true }],
    ["watched", { state: "watching" }],
    ["ended", { state: "blocked", outcome: "left-origin" }],
  ])("is not a login %s", async (_name, extra) => {
    expect(await movedLogin(runtime(extra), 1, auth, "auth-page")).toBeUndefined();
  });

  it("is not a login of the page's own origin, which runs there", async () => {
    const rt = runtime();
    rt.passkeyRequests.set(`1 ${origin}`, Date.now());
    expect(await movedLogin(rt, 1, origin, "sign-in")).toBeUndefined();
  });
});
