import { afterEach, describe, expect, it, vi } from "vitest";
import { installPasskeyRelay } from "./relay";
import { PAGE_CHANNEL, RELAY_HEARTBEAT_MS } from "./wire";

const origin = "https://login.example.com";
const id = "00000000-0000-4000-8000-000000000000";

/** Top-level secure window whose posts reach its own listeners, as a page's listeners see them. */
function fakeWindow() {
  const listeners: Array<{ type: string; listener: (event: unknown) => void }> = [];
  const posted: unknown[] = [];
  const scope = {
    isSecureContext: true,
    addEventListener: (
      type: string,
      listener: (event: unknown) => void,
      options?: AddEventListenerOptions,
    ) => {
      if (options?.signal?.aborted) return;
      listeners.push({ type, listener });
      options?.signal?.addEventListener("abort", () => scope.removeEventListener(type, listener), {
        once: true,
      });
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    listenerCount: (type: string) => listeners.filter((entry) => entry.type === type).length,
    dispatch(type: string, event: unknown) {
      for (const entry of [...listeners]) if (entry.type === type) entry.listener(event);
    },
    postMessage(data: unknown) {
      posted.push(data);
      scope.dispatch("message", { source: scope, origin, data });
    },
    top: undefined as unknown,
  };
  scope.top = scope;
  vi.stubGlobal("window", scope);
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("navigator", { userActivation: { isActive: false } });
  vi.stubGlobal("document", {
    featurePolicy: { allowsFeature: () => true },
    visibilityState: "visible",
    hasFocus: () => true,
  });
  return { scope, posted };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isolated passkey relay", () => {
  it("tells the page that Pateat delegated, never why", async () => {
    const { scope, posted } = fakeWindow();
    const send = vi.fn(async () => ({ kind: "delegate", reason: "ambiguous-credential" }));
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(send).toHaveBeenCalledOnce();
    expect(posted.slice(1)).toEqual([
      { channel: PAGE_CHANNEL, type: "ack", id },
      { channel: PAGE_CHANNEL, type: "result", id, result: { kind: "delegate" } },
    ]);
  });

  it("passes on a failure after the chooser window's wait ran out", async () => {
    const { scope, posted } = fakeWindow();
    installPasskeyRelay(vi.fn(async () => ({ kind: "not-allowed" })));
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "not-allowed" },
    });
  });

  it.each(["get", "create"])(
    "delegates a %s request when the runtime is unavailable synchronously",
    async (type) => {
      vi.useFakeTimers();
      const { scope, posted } = fakeWindow();
      const send = vi.fn(() => {
        throw new Error("extension context invalidated");
      });
      const cleanup = installPasskeyRelay(send);
      // runtime-unavailable stays inside the relay; the page only sees delegation.
      expect(() =>
        scope.postMessage({ channel: PAGE_CHANNEL, type, id, request: {} }),
      ).not.toThrow();
      expect(send).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(posted.slice(1)).toEqual([
        { channel: PAGE_CHANNEL, type: "ack", id },
        { channel: PAGE_CHANNEL, type: "result", id, result: { kind: "delegate" } },
      ]);
      await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 2);
      expect(posted).toHaveLength(3);
      cleanup();
    },
  );

  it("drops the reason of delegations the relay decides itself", async () => {
    const { scope, posted } = fakeWindow();
    vi.stubGlobal("document", { featurePolicy: { allowsFeature: () => false } });
    const send = vi.fn();
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: {} });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(send).not.toHaveBeenCalled();
    expect(posted[2]).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("repeats its acknowledgement while the background works, until it answers", async () => {
    vi.useFakeTimers();
    const { scope, posted } = fakeWindow();
    let answer!: (value: unknown) => void;
    const send = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    const acks = () => posted.filter((data) => (data as { type: string }).type === "ack").length;
    expect(acks()).toBe(1);
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(acks()).toBe(4);
    answer({ kind: "delegate", reason: "chooser-closed" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(acks()).toBe(4);
    expect(posted.at(-1)).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("stops vouching once its extension context is gone", async () => {
    vi.useFakeTimers();
    const { scope, posted } = fakeWindow();
    let alive = true;
    installPasskeyRelay(
      () => new Promise(() => {}),
      () => alive,
    );
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS);
    alive = false;
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(posted.filter((data) => (data as { type: string }).type === "ack")).toHaveLength(2);
  });

  it("removes only its listeners and heartbeats on cleanup, leaving pending work to answer", async () => {
    vi.useFakeTimers();
    const { scope, posted } = fakeWindow();
    let answer!: (value: unknown) => void;
    const send = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const stop = installPasskeyRelay(send);
    const pageMessage = vi.fn();
    const pageHide = vi.fn();
    scope.addEventListener("message", pageMessage);
    scope.addEventListener("pagehide", pageHide);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledOnce();
    const acks = () => posted.filter((data) => (data as { type: string }).type === "ack").length;
    expect(acks()).toBe(2);

    stop();
    stop();
    expect(scope.listenerCount("message")).toBe(1);
    expect(scope.listenerCount("pagehide")).toBe(1);
    pageMessage.mockClear();
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    scope.dispatch("pagehide", {});
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(pageMessage).toHaveBeenCalledOnce();
    expect(pageHide).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(acks()).toBe(2);

    answer({ kind: "delegate", reason: "chooser-closed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(posted.at(-1)).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("cancels pending requests when the page is left", async () => {
    const { scope } = fakeWindow();
    const send = vi.fn((message: unknown) =>
      (message as { type: string }).type === "passkey.get"
        ? new Promise(() => {})
        : Promise.resolve({ ok: true }),
    );
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    scope.dispatch("pagehide", {});
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith({
        version: 1,
        type: "passkey.cancel",
        operationId: id,
      }),
    );
    // A second pagehide finds nothing left to cancel.
    scope.dispatch("pagehide", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the background's late answer", { kind: "cancelled" }],
    // Chrome closes the message channel of a document entering the back/forward cache.
    ["its closed message channel", { kind: "delegate" }],
  ])(
    "stops vouching for a request cancelled on entering the back/forward cache, then settles it after %s",
    async (name, outcome) => {
      vi.useFakeTimers();
      const { scope, posted } = fakeWindow();
      let answer!: (value: unknown) => void;
      let fail!: (error: Error) => void;
      const send = vi.fn((message: unknown) =>
        (message as { type: string }).type === "passkey.get"
          ? new Promise((resolve, reject) => {
              answer = resolve;
              fail = reject;
            })
          : Promise.resolve({ ok: true }),
      );
      installPasskeyRelay(send);
      scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
      const acks = () => posted.filter((data) => (data as { type: string }).type === "ack").length;
      await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS);
      expect(acks()).toBe(2);
      scope.dispatch("pagehide", { persisted: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenLastCalledWith({
        version: 1,
        type: "passkey.cancel",
        operationId: id,
      });
      await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
      expect(acks()).toBe(2);

      // A page restored from the cache gets the answer and settles; page.test.ts covers how.
      if (outcome.kind === "cancelled") answer(outcome);
      else fail(new Error(name));
      await vi.advanceTimersByTimeAsync(0);
      expect(posted.at(-1)).toEqual({ channel: PAGE_CHANNEL, type: "result", id, result: outcome });
      expect(acks()).toBe(2);
    },
  );

  it.each([
    ["a focused, visible", "visible", true, true],
    ["a hidden", "hidden", true, false],
    ["an unfocused", "visible", false, false],
  ])(
    "reports %s document as focused only when it is both",
    async (_name, visibility, focus, expected) => {
      const { scope } = fakeWindow();
      vi.stubGlobal("document", {
        featurePolicy: { allowsFeature: () => true },
        visibilityState: visibility,
        hasFocus: () => focus,
      });
      const send = vi.fn(async () => ({ kind: "delegate", reason: "no-credential" }));
      installPasskeyRelay(send);
      scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ focused: expected }));
    },
  );
});

describe("isolated passkey relay for create (ADR 0007)", () => {
  const request = { rpId: "example.com", excludeCredentials: [{ type: "public-key", id: "AQID" }] };
  const result = (posted: unknown[]) =>
    posted.filter((data) => (data as { type: string }).type === "result");

  it("asks the background to check a registration, with nothing the page could forge", async () => {
    const { scope, posted } = fakeWindow();
    const send = vi.fn(async () => ({ kind: "decline" }));
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "create", id, request });
    await vi.waitFor(() => expect(result(posted)).toHaveLength(1));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      version: 1,
      type: "passkey.create",
      operationId: id,
      request,
    });
    expect(posted.slice(1)).toEqual([
      { channel: PAGE_CHANNEL, type: "ack", id },
      { channel: PAGE_CHANNEL, type: "result", id, result: { kind: "decline" } },
    ]);
  });

  it("tells the page that Pateat handed a registration on, never why", async () => {
    const { scope, posted } = fakeWindow();
    installPasskeyRelay(vi.fn(async () => ({ kind: "delegate", reason: "not-signed-in" })));
    scope.postMessage({ channel: PAGE_CHANNEL, type: "create", id, request });
    await vi.waitFor(() => expect(result(posted)).toHaveLength(1));
    expect(result(posted)[0]).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("checks the document's create policy, not its get policy", async () => {
    const { scope, posted } = fakeWindow();
    const allowsFeature = vi.fn((feature: string) => feature === "publickey-credentials-get");
    vi.stubGlobal("document", {
      featurePolicy: { allowsFeature },
      visibilityState: "visible",
      hasFocus: () => true,
    });
    const send = vi.fn(async (message: unknown) =>
      (message as { type: string }).type === "passkey.get"
        ? { kind: "delegate", reason: "no-credential" }
        : { kind: "decline" },
    );
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "create", id, request });
    await vi.waitFor(() => expect(result(posted)).toHaveLength(1));
    expect(allowsFeature).toHaveBeenCalledWith("publickey-credentials-create");
    expect(send).not.toHaveBeenCalled();
    expect(result(posted)[0]).toMatchObject({ result: { kind: "delegate" } });
    // The same document's get request is still relayed.
    const getId = "00000000-0000-4000-8000-000000000001";
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id: getId, request: {} });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "passkey.get" }));
  });

  it.each([
    ["a policy that is not readable", {}],
    ["a subframe", undefined],
  ])("hands a registration on in %s without asking", async (_name, document) => {
    const { scope, posted } = fakeWindow();
    if (document) vi.stubGlobal("document", document);
    else scope.top = {};
    const send = vi.fn();
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "create", id, request });
    await vi.waitFor(() => expect(result(posted)).toHaveLength(1));
    expect(send).not.toHaveBeenCalled();
    expect(result(posted)[0]).toMatchObject({ result: { kind: "delegate" } });
  });

  it.each<[string, () => Promise<unknown>]>([
    // A background answer meant for get never completes a registration.
    [
      "an assertion",
      async () => ({
        kind: "assertion",
        assertion: {
          credentialId: "AQID",
          clientDataJSON: "e30",
          authenticatorData: "AA",
          signature: "AA",
          userHandle: null,
        },
      }),
    ],
    ["not-allowed", async () => ({ kind: "not-allowed" })],
    ["a malformed answer", async () => ({ kind: "decline", extra: true })],
    ["no answer", async () => undefined],
    ["a failed message", async () => Promise.reject(new Error("context invalidated"))],
  ])("hands a registration on after %s", async (_name, answer) => {
    const { scope, posted } = fakeWindow();
    installPasskeyRelay(vi.fn(answer));
    scope.postMessage({ channel: PAGE_CHANNEL, type: "create", id, request });
    await vi.waitFor(() => expect(result(posted)).toHaveLength(1));
    expect(result(posted)[0]).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("hands an oversized registration on without asking", async () => {
    const { scope, posted } = fakeWindow();
    const send = vi.fn();
    installPasskeyRelay(send);
    scope.postMessage({
      channel: PAGE_CHANNEL,
      type: "create",
      id,
      request: { excludeCredentials: [{ type: "public-key", id: "A".repeat(140_000) }] },
    });
    await vi.waitFor(() => expect(result(posted)).toHaveLength(1));
    expect(send).not.toHaveBeenCalled();
  });

  it("repeats its acknowledgement while the background checks", async () => {
    vi.useFakeTimers();
    const { scope, posted } = fakeWindow();
    let answer!: (value: unknown) => void;
    installPasskeyRelay(vi.fn(() => new Promise((resolve) => (answer = resolve))));
    scope.postMessage({ channel: PAGE_CHANNEL, type: "create", id, request });
    const acks = () => posted.filter((data) => (data as { type: string }).type === "ack").length;
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 2);
    expect(acks()).toBe(3);
    answer({ kind: "decline" });
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 2);
    expect(acks()).toBe(3);
    expect(result(posted)).toHaveLength(1);
  });
});
