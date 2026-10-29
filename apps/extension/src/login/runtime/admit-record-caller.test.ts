import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginAttemptMetadata } from "@pateat/contracts";
import type { AdmitContext } from "./admit-context";
import type { Runtime } from "./state";
import type { LiveDocument } from "./types";
import type { PickedAccount } from "./session-schemas";
import * as recordPolicy from "./admit-record-policy";

const calls = vi.hoisted(() => ({
  recordFor: vi.fn<() => LoginAttemptMetadata | undefined>(),
  forget: vi.fn(async () => undefined),
  keep: vi.fn(async () => undefined),
  quietly: vi.fn(),
  saveSession: vi.fn(async () => undefined),
  reportAttempt: vi.fn(),
  addAskFill: vi.fn(),
  confirmRecipeOn: vi.fn<() => Promise<object | undefined>>(async () => undefined),
  startsFor: vi.fn(async () => []),
  confirmPage: vi.fn(() => undefined),
  admitRecipe: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./hold", () => ({ recordFor: calls.recordFor }));
vi.mock("./session-store", () => ({
  forget: calls.forget,
  keep: calls.keep,
  quietly: calls.quietly,
}));
vi.mock("./attempt", () => ({
  saveSession: calls.saveSession,
  reportAttempt: calls.reportAttempt,
}));
vi.mock("./relogin", () => ({ addAskFill: calls.addAskFill }));
vi.mock("./generation-scope", () => ({
  confirmRecipeOn: calls.confirmRecipeOn,
  startsFor: calls.startsFor,
}));
vi.mock("./markers", () => ({ confirmPage: calls.confirmPage }));
vi.mock("./admit-recipe", () => ({ admitRecipe: calls.admitRecipe }));
vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants")>()),
  probeMode: true,
}));

import { admitRecord } from "./admit-record";

const origin = "https://login.example.com";
const now = 4_000_000;

function record(overrides: Partial<LoginAttemptMetadata> = {}): LoginAttemptMetadata {
  return {
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
    document: { origin, tabId: 1, frameId: 0, documentId: "earlier" },
    state: "authenticated",
    outcome: "authenticated",
    stepIndex: 0,
    stepCount: 1,
    submissions: 1,
    maxSubmissions: 1,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    changedAt: now - 300_000,
    timing: { since: now - 600_000, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(entry = record()) {
  const document = { origin, tabId: 1, frameId: 0, documentId: "current" };
  const live = {
    document,
    token: "token",
    url: origin + "/signin",
    path: "/signin",
  } as LiveDocument;
  const documents = new Map([["current-key", live]]);
  const picked = new Map<number, PickedAccount>();
  const rt = {
    documents,
    picked,
    attempts: new Map(),
    rejectedAsks: new Set(),
    stoppedAsks: new Set(),
    askFills: new Set(),
    vars: { origin: "https://probe.example" },
    recipes: { withdrawn: vi.fn(async () => false) },
  };
  const ctx = {
    document,
    live,
    key: "current-key",
    paused: false,
    start: undefined as { path: string } | undefined,
    refuse: vi.fn(async (reason: string) => ({ ok: false, reason })),
    notStarted: vi.fn(),
    recorded: undefined,
    askKey: "",
  };
  calls.recordFor.mockReturnValue(entry);
  const run = () => admitRecord(rt as unknown as Runtime, ctx as unknown as AdmitContext);
  return { rt, ctx, entry, run };
}

beforeEach(() => {
  vi.resetAllMocks();
  calls.forget.mockResolvedValue(undefined);
  calls.keep.mockResolvedValue(undefined);
  calls.saveSession.mockResolvedValue(undefined);
  calls.confirmRecipeOn.mockResolvedValue(undefined);
  calls.startsFor.mockResolvedValue([]);
  calls.confirmPage.mockReturnValue(undefined);
  calls.admitRecipe.mockResolvedValue({ ok: true });
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => vi.restoreAllMocks());

describe("record admission after an awaited confirmation", () => {
  it("does not re-evaluate the finished predicate once its confirmation read began", async () => {
    const h = harness();
    const answer = deferred<object | undefined>();
    calls.confirmRecipeOn.mockReturnValue(answer.promise);
    const result = h.run();
    await vi.waitFor(() => expect(calls.confirmRecipeOn).toHaveBeenCalledTimes(1));
    h.entry.state = "ready";
    h.entry.outcome = undefined;
    answer.resolve(undefined);
    expect(await result).toEqual({ ok: false, reason: "logged-in", starts: [] });
    expect(calls.admitRecipe).not.toHaveBeenCalled();
    expect(calls.forget).not.toHaveBeenCalled();
  });

  it("does not re-evaluate a submitted record's expired hold after confirmation began", async () => {
    const h = harness(record({ state: "blocked", outcome: "timeout" }));
    const answer = deferred<object | undefined>();
    calls.confirmRecipeOn.mockReturnValue(answer.promise);
    const result = h.run();
    await vi.waitFor(() => expect(calls.confirmRecipeOn).toHaveBeenCalledTimes(1));
    h.entry.changedAt = now;
    answer.resolve(undefined);
    expect(await result).toEqual({ ok: false, reason: "login-stopped", starts: [] });
    expect(h.rt.recipes.withdrawn).toHaveBeenCalledOnce();
    expect(calls.admitRecipe).not.toHaveBeenCalled();
  });

  it("keeps rejectedHere latched when the recorded document changes during confirmation", async () => {
    const h = harness(record({ state: "blocked", outcome: "credential-rejected" }));
    const answer = deferred<object | undefined>();
    calls.confirmRecipeOn.mockReturnValue(answer.promise);
    const result = h.run();
    await vi.waitFor(() => expect(calls.confirmRecipeOn).toHaveBeenCalledOnce());
    h.entry.document.documentId = "current";
    answer.resolve(undefined);
    expect(await result).toEqual({ ok: false, reason: "logged-in", starts: [] });
    expect(calls.forget).not.toHaveBeenCalled();
    expect(h.rt.rejectedAsks.size).toBe(0);
  });

  it.each(["finished", "submitted"] as const)(
    "reads the current first-step snapshot after %s confirmation",
    async (kind) => {
      const h = harness(
        kind === "finished" ? record() : record({ state: "blocked", outcome: "timeout" }),
      );
      const answer = deferred<object | undefined>();
      calls.confirmRecipeOn.mockReturnValue(answer.promise);
      const result = h.run();
      await vi.waitFor(() => expect(calls.confirmRecipeOn).toHaveBeenCalledOnce());
      h.ctx.start = { path: "/signin" };
      answer.resolve(undefined);
      expect(await result).toEqual({ ok: true });
      expect(calls.forget).toHaveBeenCalledOnce();
      expect(calls.admitRecipe).toHaveBeenCalledOnce();
      expect(h.rt.recipes.withdrawn).not.toHaveBeenCalled();
      expect(h.rt.stoppedAsks.size).toBe(kind === "submitted" ? 1 : 0);
    },
  );

  it("reads a fresh first-step snapshot after a deferred withdrawal answer", async () => {
    const h = harness(record({ state: "blocked", outcome: "timeout" }));
    const answer = deferred<boolean>();
    h.rt.recipes.withdrawn.mockReturnValue(answer.promise);
    const result = h.run();
    await vi.waitFor(() => expect(h.rt.recipes.withdrawn).toHaveBeenCalledOnce());
    h.ctx.start = { path: "/signin" };
    answer.resolve(false);
    expect(await result).toEqual({ ok: true });
    expect(h.rt.stoppedAsks.size).toBe(1);
    expect(calls.forget).toHaveBeenCalledOnce();
  });

  it("rebuilds the page and picked snapshot after the awaited watch write", async () => {
    const h = harness(
      record({
        state: "watching",
        outcome: "challenge",
        watch: { since: now - 600_000, documentId: "watch-page", pages: 0 },
      }),
    );
    const kept = deferred<undefined>();
    calls.keep.mockReturnValue(kept.promise);
    const seen = vi.spyOn(recordPolicy, "nextRecordStep");
    const result = h.run();
    await vi.waitFor(() => expect(calls.keep).toHaveBeenCalledOnce());
    h.ctx.start = { path: "/signin" };
    h.rt.picked.set(1, {
      tabId: 1,
      origin,
      documentId: "current",
      attemptId: "new-pick",
      connectionId: "connection",
      itemId: "item",
      makeDefault: false,
      waitedMs: 0,
    });
    kept.resolve(undefined);
    expect(await result).toEqual({ ok: true });
    const afterWrite = seen.mock.calls.filter((call) => call[2].phase === "pause");
    expect(afterWrite).toHaveLength(1);
    expect(afterWrite[0]![1]).toMatchObject({ showsFirstStep: true, pickedAttemptId: "new-pick" });
    expect(calls.admitRecipe).toHaveBeenCalledOnce();
  });
});

describe("stale-document guards around skipped reads", () => {
  it.each(["top-url", "rejected-here", "submitted-top-url"] as const)(
    "still checks the document after skipped confirmation: %s",
    async (variant) => {
      const h = harness(
        variant === "submitted-top-url"
          ? record({ state: "blocked", outcome: "timeout" })
          : variant === "rejected-here"
            ? record({
                state: "blocked",
                outcome: "credential-rejected",
                document: { origin, tabId: 1, frameId: 0, documentId: "current" },
              })
            : record(),
      );
      if (variant !== "rejected-here") h.ctx.live.topUrl = origin;
      const decide = recordPolicy.nextRecordStep;
      vi.spyOn(recordPolicy, "nextRecordStep").mockImplementation((...args) => {
        const step = decide(...args);
        if (
          (args[2].phase === "finished" || args[2].phase === "submitted") &&
          step.kind === "read-confirm"
        ) {
          expect(step.read).toBe(false);
          h.rt.documents.delete(h.ctx.key);
        }
        return step;
      });
      expect(await h.run()).toEqual({ ok: false, reason: "stale-document" });
      expect(calls.confirmRecipeOn).not.toHaveBeenCalled();
      expect(calls.forget).not.toHaveBeenCalled();
      expect(calls.saveSession).not.toHaveBeenCalled();
      expect(calls.admitRecipe).not.toHaveBeenCalled();
    },
  );

  it.each(["first-step", "confirmed", "probe"] as const)(
    "still checks the document after skipped withdrawal: %s",
    async (variant) => {
      const h = harness(record({ state: "blocked", outcome: "timeout" }));
      if (variant === "first-step") h.ctx.start = { path: "/signin" };
      if (variant === "confirmed") calls.confirmRecipeOn.mockResolvedValue({});
      if (variant === "probe") h.rt.vars.origin = origin;
      const decide = recordPolicy.nextRecordStep;
      vi.spyOn(recordPolicy, "nextRecordStep").mockImplementation((...args) => {
        const step = decide(...args);
        if (args[2].phase === "submitted-confirmed") {
          expect(step).toMatchObject({ kind: "read-withdrawn", read: false });
          h.rt.documents.delete(h.ctx.key);
        }
        return step;
      });
      expect(await h.run()).toEqual({ ok: false, reason: "stale-document" });
      expect(h.rt.recipes.withdrawn).not.toHaveBeenCalled();
      expect(calls.forget).not.toHaveBeenCalled();
      expect(calls.saveSession).not.toHaveBeenCalled();
      expect(calls.admitRecipe).not.toHaveBeenCalled();
    },
  );

  it("stops after an awaited confirmation when a newer document replaced the caller", async () => {
    const h = harness();
    const answer = deferred<object | undefined>();
    calls.confirmRecipeOn.mockReturnValue(answer.promise);
    const result = h.run();
    await vi.waitFor(() => expect(calls.confirmRecipeOn).toHaveBeenCalledOnce());
    h.rt.documents.delete(h.ctx.key);
    answer.resolve(undefined);
    expect(await result).toEqual({ ok: false, reason: "stale-document" });
    expect(calls.startsFor).not.toHaveBeenCalled();
    expect(calls.forget).not.toHaveBeenCalled();
    expect(calls.admitRecipe).not.toHaveBeenCalled();
  });

  it("stops after an awaited withdrawal when a newer document replaced the caller", async () => {
    const h = harness(record({ state: "blocked", outcome: "timeout" }));
    const answer = deferred<boolean>();
    h.rt.recipes.withdrawn.mockReturnValue(answer.promise);
    const result = h.run();
    await vi.waitFor(() => expect(h.rt.recipes.withdrawn).toHaveBeenCalledOnce());
    h.rt.documents.delete(h.ctx.key);
    answer.resolve(true);
    expect(await result).toEqual({ ok: false, reason: "stale-document" });
    expect(calls.startsFor).not.toHaveBeenCalled();
    expect(calls.forget).not.toHaveBeenCalled();
    expect(calls.saveSession).not.toHaveBeenCalled();
    expect(calls.admitRecipe).not.toHaveBeenCalled();
  });
});
