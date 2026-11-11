import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings, type LoginAttemptMetadata } from "@pateat/contracts";
import type { Runtime } from "./state";
import type { Execution, LiveDocument } from "./types";
import { frameKey, recordKey } from "./steps";

const calls = vi.hoisted(() => ({
  reconnect: vi.fn(async () => ({ ok: true })),
  forget: vi.fn(async (_rt: unknown, _key: string) => undefined),
}));
vi.mock("wxt/browser", () => ({
  browser: {
    tabs: {
      get: async () => ({ id: 1, url: "https://login.example/signin" }),
      sendMessage: calls.reconnect,
    },
  },
}));
vi.mock("./choice-save", () => ({
  siteCandidates: async () => ({ candidates: [{ connectionId: "connection", itemId: "item" }] }),
}));
vi.mock("./choice", () => ({ clearChoice: () => undefined }));
vi.mock("./session-store", () => ({ forget: calls.forget }));
const { manualOffer, manualStart } = await import("./manual");
const { endManual } = await import("./manual-scope");
const { drive } = await import("./run-steps");
const origin = "https://login.example";
const fixtures: Runtime[] = [];
function harness() {
  const live: LiveDocument = {
    document: { origin, tabId: 1, frameId: 0, documentId: "page" },
    url: origin + "/signin",
    path: "/signin",
    token: "token",
    seenAt: 0,
    timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  const rt = {
    vars: { loaded: Promise.resolve(), sessionLoaded: Promise.resolve() },
    settings: {
      handle: async () => ({ ok: true, snapshot: { settings: createDefaultSettings() } }),
    },
    sites: { admission: async () => "admitted" },
    uris: async () => undefined,
    documents: new Map([[frameKey(live.document), live]]),
    pending: new Map(),
    picked: new Map(),
    manualStarts: new Map(),
    admitting: new Map(),
    switchesRunning: new Set(),
    switchStates: new Map(),
    attempts: new Map(),
    persisted: new Map(),
    effects: new Map(),
    incognitoTabs: new Map(),
    repromptGrants: new Map(),
    repromptWaiting: new Map(),
    repromptAsking: new Map(),
    passwordAsks: new Map(),
    accountPicks: {
      switchFor: async () => undefined,
      switchingHere: () => false,
      switchingElsewhere: () => false,
    },
  } as unknown as Runtime;
  fixtures.push(rt);
  return { rt, live };
}
function settled(tabId: number): Execution {
  const metadata: LoginAttemptMetadata = {
    version: 1,
    id: "settled",
    recipeId: "recipe",
    recipeRevision: 1,
    policyRevision: 1,
    account: { origin, connectionId: "connection", itemId: "item" },
    route: "password",
    variant: 0,
    facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
    handlers: [],
    document: { origin, tabId, frameId: 0, documentId: "old" },
    state: "reconciling",
    settled: true,
    stepIndex: 1,
    stepCount: 1,
    submissions: 1,
    maxSubmissions: 1,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    changedAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
  };
  return { metadata, running: false } as Execution;
}
async function request(rt: Runtime) {
  const offered = await manualOffer(rt, 1);
  if (!offered.ok || !offered.targets[0]) throw new Error("No manual target");
  return {
    version: 1 as const,
    type: "login.manual.start" as const,
    requestId: "request",
    ...offered.targets[0],
    connectionId: "connection",
    itemId: "item",
  };
}
beforeEach(() => {
  calls.reconnect.mockClear();
  calls.forget.mockReset();
  calls.forget.mockImplementation(async (rt, key) => {
    (rt as Runtime).persisted.delete(key);
  });
});
afterEach(() => {
  for (const rt of fixtures.splice(0)) endManual(rt, 1, "closed");
});

describe("manual retry versus a settled scheduler", () => {
  it.each([1, 2])("preserves a settled but running attempt in tab %s", async (tabId) => {
    const { rt } = harness();
    const pick = await request(rt);
    const old = settled(tabId);
    old.running = true;
    rt.attempts.set(tabId, old);
    rt.persisted.set(recordKey(tabId, origin), old.metadata);
    const offered = await manualOffer(rt, 1);
    expect(offered).toMatchObject({ ok: true, targets: [] });
    expect(await manualStart(rt, pick)).toMatchObject({ ok: false });
    expect(rt.attempts.get(tabId)).toBe(old);
    expect(rt.persisted.get(recordKey(tabId, origin))).toBe(old.metadata);
    expect(calls.forget).not.toHaveBeenCalled();
    expect(calls.reconnect).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "allows an idle settled record with a residual operation id in tab %s",
    async (tabId) => {
      const { rt } = harness();
      const pick = await request(rt);
      const old = settled(tabId);
      old.metadata.operationId = "last-operation";
      rt.attempts.set(tabId, old);
      rt.persisted.set(recordKey(tabId, origin), old.metadata);
      expect(await manualStart(rt, pick)).toMatchObject({ ok: true, state: "evaluating" });
      expect(old.metadata.state).toBe("reconciling");
      expect(old.metadata.operationId).toBe("last-operation");
      expect(rt.attempts.get(tabId)).toBe(tabId === 1 ? undefined : old);
      expect(calls.reconnect).toHaveBeenCalledTimes(1);
    },
  );
  it("retires an idle scheduler before awaiting deletion of its old record", async () => {
    const { rt } = harness();
    const old = settled(1);
    rt.attempts.set(1, old);
    rt.persisted.set(recordKey(1, origin), old.metadata);
    const pick = await request(rt);
    const writing = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();
    calls.forget.mockImplementation(async () => {
      arrived.resolve();
      await writing.promise;
    });
    const starting = manualStart(rt, pick);
    await arrived.promise;
    const oldEffect = vi.fn();
    // A page announcement can schedule the old login during the storage await.
    if (rt.attempts.get(1) === old) {
      old.running = true;
      old.metadata.state = "ready";
      oldEffect();
    }
    rt.persisted.delete(recordKey(1, origin));
    writing.resolve();
    await starting;
    expect(oldEffect).not.toHaveBeenCalled();
    expect(old.metadata.state).toBe("reconciling");
    expect(rt.attempts.has(1)).toBe(false);
  });
});

it("does not drive a retained settled observer beside an attached manual attempt", async () => {
  const { rt, live } = harness();
  const old = settled(2);
  old.live = { ...live, document: old.metadata.document };
  const active = settled(1);
  active.metadata.id = "manual-attempt";
  active.metadata.state = "ready";
  delete active.metadata.settled;
  rt.attempts.set(1, active);
  rt.attempts.set(2, old);
  rt.picked.set(1, {
    tabId: 1,
    origin,
    documentId: "page",
    connectionId: "connection",
    itemId: "item",
    makeDefault: false,
    waitedMs: 0,
    manual: true,
    attemptId: "manual-attempt",
  });
  const before = structuredClone(old.metadata);
  await drive(rt, old);
  expect(old.metadata).toEqual(before);
  expect(old.running).toBe(false);
  expect(rt.attempts.get(2)).toBe(old);
  expect(calls.reconnect).not.toHaveBeenCalled();
});
