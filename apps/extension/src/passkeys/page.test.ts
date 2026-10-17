import { afterEach, describe, expect, it, vi } from "vitest";
import { installPasskeyPage, snapshotGetOptions } from "./page";
import {
  PAGE_CHANNEL,
  PAGE_CREATE_MAX_WAIT_MS,
  PAGE_MAX_WAIT_MS,
  PAGE_TIMEOUT_MS,
  type PageResult,
} from "./wire";

const origin = "https://login.example.com";
type Message = { channel: string; type: string; id: string };

/** Minimal top-level window: same-origin postMessage plus a scripted isolated relay. */
function fakePage(
  relay: (message: Message) => Array<Record<string, unknown>> = () => [],
  /** `locked`: a provider defined `create` before Pateat, without letting it be redefined. */
  { create = true }: { create?: boolean | "locked" } = {},
) {
  const listeners: Array<(event: unknown) => void> = [];
  const posted: Message[] = [];
  const nativeGet = vi.fn(async function (this: unknown, _options?: unknown) {
    return "native" as unknown;
  });
  const nativeCreate = vi.fn(async function (this: unknown, _options?: unknown) {
    return "created" as unknown;
  });
  const container: {
    get: (options?: unknown) => Promise<unknown>;
    create: (options?: unknown) => Promise<unknown>;
  } = create ? { get: nativeGet, create: nativeCreate } : ({ get: nativeGet } as never);
  if (create === "locked")
    Object.defineProperty(container, "create", { value: nativeCreate, configurable: false });
  // The wrapper reads only each class's prototype.
  const PublicKeyCredential = { prototype: { kind: "credential" } };
  const AuthenticatorAssertionResponse = { prototype: { kind: "response" } };
  const scope: Record<string, unknown> & { postMessage(data: unknown): void } = {
    navigator: { credentials: container },
    PublicKeyCredential,
    AuthenticatorAssertionResponse,
    AbortSignal,
    DOMException,
    location: { origin },
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.push(listener),
    postMessage(data: unknown) {
      const copy = structuredClone(data) as Message;
      queueMicrotask(() => {
        for (const listener of listeners) listener({ source: scope, origin, data: copy });
        if (copy.channel !== PAGE_CHANNEL) return;
        if (copy.type === "get" || copy.type === "create" || copy.type === "cancel") {
          posted.push(copy);
          for (const reply of relay(copy)) scope.postMessage({ channel: PAGE_CHANNEL, ...reply });
        }
      });
    },
  };
  scope["top"] = scope;
  installPasskeyPage(scope as unknown as Parameters<typeof installPasskeyPage>[0]);
  return {
    container,
    nativeGet,
    nativeCreate,
    posted,
    prototypes: { credential: PublicKeyCredential.prototype },
    post: (data: unknown) => scope.postMessage(data),
    /** Listens to the page's messages after the wrapper's own listener. */
    listen: (listener: (event: { data: Message }) => void) =>
      listeners.push(listener as (event: unknown) => void),
  };
}

const publicKey = { challenge: new Uint8Array(16), allowCredentials: [] };
const answer = (result: PageResult) => (message: Message) =>
  message.type === "get"
    ? [
        { type: "ack", id: message.id },
        { type: "result", id: message.id, result },
      ]
    : [];

afterEach(() => {
  vi.useRealTimers();
});

describe("MAIN-world passkey wrapper", () => {
  it("delegates with the caller's exact arguments, signal included", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const options = { publicKey, signal: new AbortController().signal };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]).toEqual([options]);
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
    expect(page.nativeGet.mock.contexts[0]).toBe(page.container);
  });

  it("preserves Immediate UI uiMode and delegates the caller's exact call", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const options = { publicKey, uiMode: "immediate" };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.posted[0]).toMatchObject({
      type: "get",
      request: { uiMode: "immediate" },
    });
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
  });

  it("preserves supported mediation and delegates unsupported Immediate UI combinations", () => {
    for (const extra of [
      { uiMode: 1 },
      { uiMode: "other" },
      { uiMode: "immediate", signal: new AbortController().signal },
    ])
      expect(snapshotGetOptions({ publicKey, ...extra })).toBeUndefined();
    expect(
      snapshotGetOptions({ publicKey, uiMode: "immediate", mediation: "optional" }),
    ).toMatchObject({
      uiMode: "immediate",
      mediation: "optional",
    });
  });

  it("hands mixed credentials and Immediate UI signals directly to the original provider", async () => {
    for (const extra of [
      { password: true },
      { identity: { providers: [] } },
      { signal: new AbortController().signal },
    ]) {
      const page = fakePage();
      const options = { publicKey, uiMode: "immediate", ...extra };
      await expect(page.container.get(options)).resolves.toBe("native");
      expect(page.posted).toHaveLength(0);
      expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
      expect(page.nativeGet.mock.contexts[0]).toBe(page.container);
    }
  });

  it("delegates promptly when no relay acknowledges", async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const result = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(999);
    expect(page.nativeGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("native");
    expect(page.posted.map((message) => message.type)).toEqual(["get", "cancel"]);
  });

  it("delegates once the relay falls silent, and keeps waiting while it repeats its ack", async () => {
    vi.useFakeTimers();
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const silent = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS - 1);
    expect(page.nativeGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(silent).resolves.toBe("native");

    const held = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(0);
    const id = page.posted.at(-1)!.id;
    const heartbeat = setInterval(
      () => page.post({ channel: PAGE_CHANNEL, type: "ack", id }),
      PAGE_TIMEOUT_MS / 3,
    );
    await vi.advanceTimersByTimeAsync(PAGE_MAX_WAIT_MS - 1);
    expect(page.nativeGet).toHaveBeenCalledOnce();
    // The absolute limit holds even while the relay keeps answering.
    await vi.advanceTimersByTimeAsync(1);
    await expect(held).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledTimes(2);
    clearInterval(heartbeat);
  });

  it("rejects with the caller's abort reason and cancels the operation", async () => {
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const controller = new AbortController();
    const result = page.container.get({ publicKey, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reason = { synthetic: "abort" };
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.posted.map((message) => message.type)).toEqual(["get", "cancel"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("fails like the browser's prompt when the chooser window's wait runs out", async () => {
    const page = fakePage(answer({ kind: "not-allowed" }));
    const result = page.container.get({ publicKey });
    await expect(result).rejects.toBeInstanceOf(DOMException);
    await expect(result).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(page.nativeGet).not.toHaveBeenCalled();
    // The background already ended the request; nothing is left to cancel.
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
  });

  it("keeps a withheld conditional request pending until the page aborts it (ADR 0034)", async () => {
    const page = fakePage(answer({ kind: "withheld" }));
    const controller = new AbortController();
    let settled = false;
    const result = page.container.get({
      publicKey,
      mediation: "conditional",
      signal: controller.signal,
    });
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(page.posted).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(page.nativeGet).not.toHaveBeenCalled();
    const reason = { synthetic: "abort" };
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    // The background already ended the request, so nothing is cancelled or handed on.
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("rejects a withheld conditional request at once when the page aborted as it arrived", async () => {
    const page = fakePage(answer({ kind: "withheld" }));
    const controller = new AbortController();
    const reason = { synthetic: "abort" };
    // The page aborts right after the wrapper took the relay's answer.
    page.listen((event) => {
      if (event.data.type === "result") controller.abort(reason);
    });
    const result = page.container.get({
      publicKey,
      mediation: "conditional",
      signal: controller.signal,
    });
    await expect(result).rejects.toBe(reason);
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("hands a withheld request on when it was not conditional", async () => {
    const page = fakePage(answer({ kind: "withheld" }));
    const options = { publicKey, signal: new AbortController().signal };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
  });

  it("lets a conditional request wait past the absolute limit while the relay answers", async () => {
    vi.useFakeTimers();
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const held = page.container.get({ publicKey, mediation: "conditional" });
    await vi.advanceTimersByTimeAsync(0);
    const id = page.posted.at(-1)!.id;
    const heartbeat = setInterval(
      () => page.post({ channel: PAGE_CHANNEL, type: "ack", id }),
      PAGE_TIMEOUT_MS / 3,
    );
    await vi.advanceTimersByTimeAsync(PAGE_MAX_WAIT_MS * 3);
    expect(page.nativeGet).not.toHaveBeenCalled();
    expect(page.posted.map((message) => message.type)).toEqual(["get"]);
    // The login's decision still arrives, here to hand the request on.
    page.post({ channel: PAGE_CHANNEL, type: "result", id, result: { kind: "delegate" } });
    await vi.advanceTimersByTimeAsync(0);
    await expect(held).resolves.toBe("native");
    clearInterval(heartbeat);
    // Without the relay's answers it is handed on as any request is.
    const silent = page.container.get({ publicKey: { ...publicKey }, mediation: "conditional" });
    await vi.advanceTimersByTimeAsync(0);
    const silentId = page.posted.at(-1)!.id;
    page.post({ channel: PAGE_CHANNEL, type: "ack", id: silentId });
    await vi.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS);
    await expect(silent).resolves.toBe("native");
    expect(page.posted.at(-1)).toMatchObject({ type: "cancel", id: silentId });
  });

  it("leaves a non-AbortSignal signal to the browser without relaying", async () => {
    const page = fakePage(answer({ kind: "cancelled" }));
    const options = { publicKey, signal: { aborted: false, addEventListener() {} } };
    await expect(page.container.get(options as never)).resolves.toBe("native");
    expect(page.posted).toEqual([]);
  });

  it("returns a credential with native prototypes for a valid assertion", async () => {
    const assertion = {
      credentialId: "AQID",
      clientDataJSON: "e30",
      authenticatorData: "AA",
      signature: "MAA",
      userHandle: null,
    };
    const page = fakePage(answer({ kind: "assertion", assertion }));
    const credential = (await page.container.get({ publicKey })) as unknown as {
      id: string;
      toJSON(): unknown;
    };
    expect(page.nativeGet).not.toHaveBeenCalled();
    expect(credential.id).toBe("AQID");
    expect(Object.getPrototypeOf(credential)).toBe(page.prototypes.credential);
    expect(credential.toJSON()).toMatchObject({ id: "AQID", type: "public-key" });
  });
});

/** Shaped like the official Bitwarden page script: it saves a bound `get`, assigns its own, falls
 * back to the saved one only when its provider asks, and restores the saved one on teardown. */
function laterProvider(
  container: { get: (options?: unknown) => Promise<unknown> },
  outcome: "fallback" | "reject",
) {
  const saved = container.get.bind(container);
  const provider = vi.fn(async (options?: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (outcome === "reject") throw new Error("Something went wrong.");
    return saved(options);
  });
  container.get = provider;
  return { provider, destroy: () => (container.get = saved) };
}

describe("coexistence with a later passkey provider", () => {
  const assertion = {
    credentialId: "AQID",
    clientDataJSON: "e30",
    authenticatorData: "AA",
    signature: "AA",
    userHandle: null,
  };

  it("keeps answering first after another provider assigns its wrapper", async () => {
    const page = fakePage(answer({ kind: "assertion", assertion }));
    const wrapper = page.container.get;
    const later = laterProvider(page.container, "reject");
    expect(page.container.get).toBe(wrapper);
    const credential = (await page.container.get({ publicKey })) as { id: string };
    expect(credential.id).toBe("AQID");
    expect(later.provider).not.toHaveBeenCalled();
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("delegates an unclaimed request to that provider, whose fallback reaches the browser once", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const later = laterProvider(page.container, "fallback");
    const options = { publicKey };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(later.provider).toHaveBeenCalledOnce();
    expect(later.provider.mock.calls[0]![0]).toBe(options);
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
    expect(page.posted.filter((message) => message.type === "get")).toHaveLength(1);
  });

  it("stays outermost when the provider restores its saved function", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const wrapper = page.container.get;
    laterProvider(page.container, "reject").destroy();
    expect(page.container.get).toBe(wrapper);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
  });

  it("keeps claiming new requests while the provider holds an unclaimed one", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(claim ? { kind: "assertion", assertion } : { kind: "delegate" })(message),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const provider = vi.fn(async () => {
      await held;
      throw new Error("Something went wrong.");
    });
    page.container.get = provider;
    const unclaimed = page.container.get({ publicKey: { ...publicKey } });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    claim = true;
    // Same challenge, new objects: a page's second attempt, not the provider falling back.
    const credential = (await page.container.get({ publicKey: { ...publicKey } })) as {
      id: string;
    };
    expect(credential.id).toBe("AQID");
    release();
    await expect(unclaimed).rejects.toThrow("Something went wrong.");
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("routes a provider's shallow copy, as Bitwarden's conditional path makes, to the browser", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const saved = page.container.get.bind(page.container);
    // The copy is passed on after an await, so only its publicKey can route it.
    const provider = vi.fn(async (options?: unknown) => {
      await Promise.resolve();
      return saved({ ...(options as object), signal: new AbortController().signal });
    });
    page.container.get = provider;
    await expect(page.container.get({ publicKey, mediation: "conditional" })).resolves.toBe(
      "native",
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.posted.filter((message) => message.type === "get")).toHaveLength(1);
  });

  it("sends a wrapper's synchronous call with rebuilt options straight to the browser", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const saved = page.container.get.bind(page.container);
    // A page shim that converts the options, here with a fresh challenge, before calling `get`.
    const provider = vi.fn((options?: unknown) => {
      const { publicKey: inner } = options as { publicKey: typeof publicKey };
      return saved({
        publicKey: { ...inner, challenge: crypto.getRandomValues(new Uint8Array(16)) },
      });
    });
    page.container.get = provider;
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(provider).toHaveBeenCalledOnce();
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.posted.filter((message) => message.type === "get")).toHaveLength(1);
  });

  it("stops a wrapper that rebuilds the options asynchronously from looping", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const saved = page.container.get.bind(page.container);
    const provider = vi.fn(async (options?: unknown) => {
      await Promise.resolve();
      const { publicKey: inner } = options as { publicKey: typeof publicKey };
      return saved({
        publicKey: { ...inner, challenge: crypto.getRandomValues(new Uint8Array(16)) },
      });
    });
    page.container.get = provider;
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(provider).toHaveBeenCalledTimes(4);
    expect(page.nativeGet).toHaveBeenCalledOnce();
  });

  it("still claims a call beyond the delegation limit", async () => {
    let claims = 0;
    const page = fakePage((message) =>
      answer(
        page.posted.filter((entry) => entry.type === "get").length === 5
          ? (claims++, { kind: "assertion", assertion })
          : { kind: "delegate" },
      )(message),
    );
    const saved = page.container.get.bind(page.container);
    const provider = vi.fn(async (options?: unknown) => {
      await Promise.resolve();
      const { publicKey: inner } = options as { publicKey: typeof publicKey };
      return saved({
        publicKey: { ...inner, challenge: crypto.getRandomValues(new Uint8Array(16)) },
      });
    });
    page.container.get = provider;
    const credential = (await page.container.get({ publicKey })) as { id: string };
    expect(credential.id).toBe("AQID");
    expect(claims).toBe(1);
    expect(provider).toHaveBeenCalledTimes(4);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("claims a modal request that reuses the publicKey of a held conditional one", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(claim ? { kind: "assertion", assertion } : { kind: "delegate" })(message),
    );
    const provider = vi.fn(() => new Promise<never>(() => {}));
    page.container.get = provider;
    void page.container.get({ publicKey, mediation: "conditional" });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    claim = true;
    const credential = (await page.container.get({ publicKey })) as { id: string };
    expect(credential.id).toBe("AQID");
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("claims a modal request after the page aborts its conditional one", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(claim ? { kind: "assertion", assertion } : { kind: "delegate" })(message),
    );
    const provider = vi.fn(
      (options?: unknown) =>
        new Promise<never>((_, reject) =>
          (options as { signal: AbortSignal }).signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    );
    page.container.get = provider;
    const controller = new AbortController();
    const conditional = page.container.get({
      publicKey,
      mediation: "conditional",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    claim = true;
    controller.abort();
    const credential = (await page.container.get({ publicKey })) as { id: string };
    expect(credential.id).toBe("AQID");
    await expect(conditional).rejects.toThrow("Aborted");
    // The settled conditional request no longer routes one with its publicKey.
    const again = (await page.container.get({ publicKey, mediation: "conditional" })) as {
      id: string;
    };
    expect(again.id).toBe("AQID");
  });

  it("sends a page call reusing a delegated publicKey with the same mediation to the browser", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(claim ? { kind: "assertion", assertion } : { kind: "delegate" })(message),
    );
    page.container.get = vi.fn(() => new Promise<never>(() => {}));
    const shared = { ...publicKey };
    void page.container.get({ publicKey: shared });
    await vi.waitFor(() => expect(page.posted).toHaveLength(1));
    claim = true;
    await expect(page.container.get({ publicKey: shared })).resolves.toBe("native");
  });

  it("still claims a fresh request while many unrelated ones are held", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(claim ? { kind: "assertion", assertion } : { kind: "delegate" })(message),
    );
    const provider = vi.fn(() => new Promise<never>(() => {}));
    page.container.get = provider;
    for (let index = 0; index < 6; index++)
      void page.container.get({
        publicKey: { ...publicKey, challenge: crypto.getRandomValues(new Uint8Array(16)) },
      });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(6));
    claim = true;
    const credential = (await page.container.get({ publicKey })) as { id: string };
    expect(credential.id).toBe("AQID");
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("sends an unclaimed call to the browser once four delegations are held", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const provider = vi.fn(() => new Promise<never>(() => {}));
    page.container.get = provider;
    // Each request is held before the next starts, so earlier delegations are in flight.
    const hold = async (count: number) => {
      void page.container.get({
        publicKey: { ...publicKey, challenge: crypto.getRandomValues(new Uint8Array(16)) },
      });
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(count));
    };
    await hold(1);
    await hold(2);
    await hold(3);
    await hold(4);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(provider).toHaveBeenCalledTimes(4);
    // Another mediation has its own limit.
    void page.container.get({ publicKey, mediation: "conditional" });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(5));
  });

  it("recovers after the delegated function throws synchronously", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const provider = vi.fn(() => {
      throw new Error("synchronous");
    });
    page.container.get = provider;
    await expect(page.container.get({ publicKey })).rejects.toThrow("synchronous");
    await expect(page.container.get({ publicKey: { ...publicKey } })).rejects.toThrow(
      "synchronous",
    );
    expect(provider).toHaveBeenCalledTimes(2);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("ignores assigning a non-function or itself", async () => {
    const page = fakePage(answer({ kind: "delegate" }));
    const wrapper = page.container.get;
    (page.container as { get: unknown }).get = "not a function";
    page.container.get = wrapper;
    expect(page.container.get).toBe(wrapper);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
  });
});

/** A registration excluding one passkey, whose ID AQID is the bytes 1, 2, 3. */
const registration = () => ({
  rp: { id: "example.com", name: "Example" },
  user: { id: new Uint8Array(8), name: "owner@example.com", displayName: "Owner" },
  challenge: new Uint8Array(16),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [
    { type: "public-key", id: Uint8Array.of(1, 2, 3), transports: ["internal"] },
  ],
});
const answerCreate = (result: PageResult) => (message: Message) =>
  message.type === "create"
    ? [
        { type: "ack", id: message.id },
        { type: "result", id: message.id, result },
      ]
    : [];
const types = (posted: Message[]) => posted.map((message) => message.type);

describe("MAIN-world passkey create wrapper (ADR 0007)", () => {
  it("rejects a declined registration as Chrome does a dismissed prompt, never calling the browser", async () => {
    const page = fakePage(answerCreate({ kind: "decline" }));
    const result = page.container.create({ publicKey: registration() });
    await expect(result).rejects.toBeInstanceOf(DOMException);
    await expect(result).rejects.toMatchObject({
      name: "NotAllowedError",
      message: expect.stringContaining("timed out or was not allowed"),
    });
    expect(page.nativeCreate).not.toHaveBeenCalled();
    // The background already answered; nothing is left to cancel.
    expect(types(page.posted)).toEqual(["create"]);
  });

  it("relays only what the check reads, never the user, challenge or other members", async () => {
    const page = fakePage(answerCreate({ kind: "delegate" }));
    await page.container.create({ publicKey: registration(), mediation: "conditional" });
    expect((page.posted[0] as Message & { request: unknown }).request).toEqual({
      excludeCredentials: [{ type: "public-key", id: "AQID", transports: ["internal"] }],
      rpId: "example.com",
      mediation: "conditional",
    });
    // Without an RP ID in `rp`, none is sent; the background uses the origin's host.
    const { rp: _rp, ...rest } = registration();
    await page.container.create({ publicKey: { ...rest, rp: { name: "Example" } } });
    expect((page.posted.at(-1) as Message & { request: unknown }).request).toEqual({
      excludeCredentials: [{ type: "public-key", id: "AQID", transports: ["internal"] }],
    });
  });

  it("hands a delegated registration on with the caller's exact options and this", async () => {
    const page = fakePage(answerCreate({ kind: "delegate" }));
    const options = { publicKey: registration(), signal: new AbortController().signal };
    await expect(page.container.create(options)).resolves.toBe("created");
    expect(page.nativeCreate).toHaveBeenCalledOnce();
    expect(page.nativeCreate.mock.calls[0]).toEqual([options]);
    expect(page.nativeCreate.mock.calls[0]![0]).toBe(options);
    expect(page.nativeCreate.mock.contexts[0]).toBe(page.container);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it.each<[string, PageResult]>([
    [
      "an assertion",
      {
        kind: "assertion",
        assertion: {
          credentialId: "AQID",
          clientDataJSON: "e30",
          authenticatorData: "AA",
          signature: "AA",
          userHandle: null,
        },
      },
    ],
    ["not-allowed", { kind: "not-allowed" }],
    ["withheld", { kind: "withheld" }],
    ["cancelled", { kind: "cancelled" }],
  ])("hands a registration on when the relay answers %s", async (_name, result) => {
    const page = fakePage(answerCreate(result));
    const options = { publicKey: registration() };
    await expect(page.container.create(options)).resolves.toBe("created");
    expect(page.nativeCreate.mock.calls[0]![0]).toBe(options);
  });

  const withRegistration = (change: (members: Record<string, unknown>) => void) => {
    const members: Record<string, unknown> = registration();
    change(members);
    return { publicKey: members };
  };
  it.each<[string, () => unknown]>([
    ["no options", () => undefined],
    ["no publicKey", () => ({})],
    ["another credential type too", () => ({ publicKey: registration(), password: true })],
    ["no excludeCredentials", () => withRegistration((pk) => delete pk["excludeCredentials"])],
    [
      "an empty excludeCredentials",
      () => withRegistration((pk) => (pk["excludeCredentials"] = [])),
    ],
    [
      "a non-list excludeCredentials",
      () => withRegistration((pk) => (pk["excludeCredentials"] = {})),
    ],
    ["a null descriptor", () => withRegistration((pk) => (pk["excludeCredentials"] = [null]))],
    [
      "a string ID",
      () =>
        withRegistration((pk) => (pk["excludeCredentials"] = [{ type: "public-key", id: "AQID" }])),
    ],
    [
      "a descriptor without a type",
      () => withRegistration((pk) => (pk["excludeCredentials"] = [{ id: Uint8Array.of(1) }])),
    ],
    [
      "transports that are not a list of strings",
      () =>
        withRegistration(
          (pk) =>
            (pk["excludeCredentials"] = [
              { type: "public-key", id: Uint8Array.of(1), transports: "usb" },
            ]),
        ),
    ],
    [
      "an ID over 4096 bytes",
      () =>
        withRegistration(
          (pk) => (pk["excludeCredentials"] = [{ type: "public-key", id: new Uint8Array(4097) }]),
        ),
    ],
    [
      "an ID in shared memory",
      () =>
        withRegistration(
          (pk) =>
            (pk["excludeCredentials"] = [
              { type: "public-key", id: new Uint8Array(new SharedArrayBuffer(3)) },
            ]),
        ),
    ],
    [
      "more than 64 descriptors",
      () =>
        withRegistration(
          (pk) =>
            (pk["excludeCredentials"] = Array.from({ length: 65 }, () => ({
              type: "public-key",
              id: Uint8Array.of(1),
            }))),
        ),
    ],
    ["no rp", () => withRegistration((pk) => delete pk["rp"])],
    ["no challenge", () => withRegistration((pk) => delete pk["challenge"])],
    ["a string challenge", () => withRegistration((pk) => (pk["challenge"] = "AAAA"))],
    ["no user", () => withRegistration((pk) => delete pk["user"])],
    [
      "a user without an ID",
      () => withRegistration((pk) => (pk["user"] = { name: "owner", displayName: "Owner" })),
    ],
    [
      "a user without a display name",
      () => withRegistration((pk) => (pk["user"] = { id: new Uint8Array(8), name: "owner" })),
    ],
    [
      "a user without a name",
      () =>
        withRegistration((pk) => (pk["user"] = { id: new Uint8Array(8), displayName: "Owner" })),
    ],
    ["no pubKeyCredParams", () => withRegistration((pk) => delete pk["pubKeyCredParams"])],
    ["an rp without a name", () => withRegistration((pk) => (pk["rp"] = { id: "example.com" }))],
    ["an unknown mediation", () => ({ publicKey: registration(), mediation: "Owner's text" })],
    ["a non-string RP ID", () => withRegistration((pk) => (pk["rp"] = { id: 7, name: "Example" }))],
    ["a non-string mediation", () => ({ publicKey: registration(), mediation: 1 })],
    [
      "a throwing publicKey getter",
      () =>
        Object.defineProperty({}, "publicKey", {
          get() {
            throw new Error("getter");
          },
        }),
    ],
    [
      "a non-AbortSignal signal",
      () => ({ publicKey: registration(), signal: { aborted: false, addEventListener() {} } }),
    ],
    [
      "an already aborted signal",
      () => ({ publicKey: registration(), signal: AbortSignal.abort() }),
    ],
  ])("leaves a registration with %s to the browser without relaying", async (_name, make) => {
    const page = fakePage(answerCreate({ kind: "decline" }));
    const options = make();
    await expect(page.container.create(options)).resolves.toBe("created");
    expect(page.nativeCreate).toHaveBeenCalledOnce();
    expect(page.nativeCreate.mock.calls[0]![0]).toBe(options);
    expect(page.posted).toEqual([]);
  });

  it.each(["get", "create"] as const)(
    "hands %s on unchanged when called on another object",
    async (name) => {
      const page = fakePage((message) =>
        name === "get"
          ? answer({ kind: "not-allowed" })(message)
          : answerCreate({ kind: "decline" })(message),
      );
      const other = {};
      const options = name === "get" ? { publicKey } : { publicKey: registration() };
      const result = await Reflect.apply(page.container[name], other, [options]);
      const native = name === "get" ? page.nativeGet : page.nativeCreate;
      expect(result).toBe(name === "get" ? "native" : "created");
      expect(native.mock.contexts[0]).toBe(other);
      expect(native.mock.calls[0]![0]).toBe(options);
      expect(page.posted).toEqual([]);
    },
  );

  it("rejects with the caller's abort reason and cancels the check", async () => {
    const page = fakePage((message) =>
      message.type === "create" ? [{ type: "ack", id: message.id }] : [],
    );
    const later = vi.fn(async () => "provider");
    page.container.create = later;
    const controller = new AbortController();
    const result = page.container.create({ publicKey: registration(), signal: controller.signal });
    await vi.waitFor(() => expect(page.posted).toHaveLength(1));
    const reason = { synthetic: "abort" };
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    // Neither a later provider nor the browser is asked.
    expect(later).not.toHaveBeenCalled();
    expect(page.nativeCreate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(types(page.posted)).toEqual(["create", "cancel"]));
  });

  it("hands a registration on promptly when no relay acknowledges", async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const result = page.container.create({ publicKey: registration() });
    await vi.advanceTimersByTimeAsync(999);
    expect(page.nativeCreate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("created");
    expect(types(page.posted)).toEqual(["create", "cancel"]);
  });

  it("hands a registration on at its absolute limit even while the relay answers", async () => {
    vi.useFakeTimers();
    const page = fakePage((message) =>
      message.type === "create" ? [{ type: "ack", id: message.id }] : [],
    );
    const held = page.container.create({ publicKey: registration() });
    await vi.advanceTimersByTimeAsync(0);
    const id = page.posted.at(-1)!.id;
    const heartbeat = setInterval(
      () => page.post({ channel: PAGE_CHANNEL, type: "ack", id }),
      PAGE_TIMEOUT_MS / 3,
    );
    await vi.advanceTimersByTimeAsync(PAGE_CREATE_MAX_WAIT_MS - 1);
    expect(page.nativeCreate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(held).resolves.toBe("created");
    expect(types(page.posted)).toEqual(["create", "cancel"]);
    clearInterval(heartbeat);
  });

  it("keeps the browser's name and an accessor that stays Pateat's", async () => {
    const page = fakePage(answerCreate({ kind: "decline" }));
    const wrapper = page.container.create;
    expect(wrapper.name).toBe("create");
    const descriptor = Object.getOwnPropertyDescriptor(page.container, "create")!;
    expect(descriptor).toMatchObject({ enumerable: true, configurable: true });
    expect(descriptor.get).toBeTypeOf("function");
    (page.container as { create: unknown }).create = "not a function";
    page.container.create = wrapper;
    expect(page.container.create).toBe(wrapper);
    await expect(page.container.create({ publicKey: registration() })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
  });

  it("leaves a create a provider locked to it, and still wraps get", async () => {
    const page = fakePage(
      (message) =>
        message.type === "get"
          ? answer({ kind: "delegate" })(message)
          : answerCreate({ kind: "decline" })(message),
      { create: "locked" },
    );
    expect(page.container.create).toBe(page.nativeCreate);
    const options = { publicKey: registration() };
    await expect(page.container.create(options)).resolves.toBe("created");
    expect(page.posted).toEqual([]);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(types(page.posted)).toEqual(["get"]);
  });

  it("wraps only get on a container without create", async () => {
    const page = fakePage(answer({ kind: "delegate" }), { create: false });
    expect("create" in page.container).toBe(false);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
  });
});

describe("create coexistence with a later passkey provider", () => {
  /** Saves a bound `create`, assigns its own, and falls back to the saved one. */
  const laterCreate = (page: ReturnType<typeof fakePage>) => {
    const saved = page.container.create.bind(page.container);
    const provider = vi.fn(async (options?: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return saved(options);
    });
    page.container.create = provider;
    return { provider, saved };
  };

  it("declines before the provider is asked", async () => {
    const page = fakePage(answerCreate({ kind: "decline" }));
    const wrapper = page.container.create;
    const later = laterCreate(page);
    expect(page.container.create).toBe(wrapper);
    await expect(page.container.create({ publicKey: registration() })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(later.provider).not.toHaveBeenCalled();
    expect(page.nativeCreate).not.toHaveBeenCalled();
  });

  it("delegates to the provider, whose fallback reaches the browser once", async () => {
    const page = fakePage(answerCreate({ kind: "delegate" }));
    const later = laterCreate(page);
    const options = { publicKey: registration() };
    await expect(page.container.create(options)).resolves.toBe("created");
    expect(later.provider).toHaveBeenCalledOnce();
    expect(later.provider.mock.calls[0]![0]).toBe(options);
    expect(page.nativeCreate).toHaveBeenCalledOnce();
    expect(page.nativeCreate.mock.calls[0]![0]).toBe(options);
    expect(types(page.posted)).toEqual(["create"]);
  });

  it("sends the provider's shallow copy to the browser", async () => {
    const page = fakePage(answerCreate({ kind: "delegate" }));
    const saved = page.container.create.bind(page.container);
    // The copy is passed on after an await, so only its publicKey can route it.
    const provider = vi.fn(async (options?: unknown) => {
      await Promise.resolve();
      return saved({ ...(options as object) });
    });
    page.container.create = provider;
    await expect(page.container.create({ publicKey: registration() })).resolves.toBe("created");
    expect(page.nativeCreate).toHaveBeenCalledOnce();
    expect(types(page.posted)).toEqual(["create"]);
  });

  it("sends a wrapper's synchronous call with rebuilt options straight to the browser", async () => {
    const page = fakePage(answerCreate({ kind: "delegate" }));
    const saved = page.container.create.bind(page.container);
    const provider = vi.fn((_options?: unknown) => saved({ publicKey: registration() }));
    page.container.create = provider;
    await expect(page.container.create({ publicKey: registration() })).resolves.toBe("created");
    expect(provider).toHaveBeenCalledOnce();
    expect(page.nativeCreate).toHaveBeenCalledOnce();
    expect(types(page.posted)).toEqual(["create"]);
  });

  it("stops a wrapper that rebuilds the options asynchronously from looping", async () => {
    const page = fakePage(answerCreate({ kind: "delegate" }));
    const saved = page.container.create.bind(page.container);
    const provider = vi.fn(async (_options?: unknown) => {
      await Promise.resolve();
      return saved({ publicKey: registration() });
    });
    page.container.create = provider;
    await expect(page.container.create({ publicKey: registration() })).resolves.toBe("created");
    expect(provider).toHaveBeenCalledTimes(4);
    expect(page.nativeCreate).toHaveBeenCalledOnce();
  });

  it("keeps get's delegations apart from create's", async () => {
    const page = fakePage((message) =>
      message.type === "get"
        ? answer({ kind: "delegate" })(message)
        : answerCreate({ kind: "decline" })(message),
    );
    // A provider holds the get request it was handed.
    page.container.get = vi.fn(() => new Promise<never>(() => {}));
    const options = { publicKey: registration() };
    void page.container.get(options);
    await vi.waitFor(() => expect(types(page.posted)).toEqual(["get"]));
    // The same options object in create is still checked, not taken for get's fallback.
    await expect(page.container.create(options)).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(types(page.posted)).toEqual(["get", "create"]);
    expect(page.nativeCreate).not.toHaveBeenCalled();
  });
});
