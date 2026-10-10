import { afterEach, describe, expect, it, vi } from "vitest";
import { installPasskeyPage } from "./page";
import { PAGE_CHANNEL, type RuntimeResult } from "./wire";

const origin = "https://login.example.com";
type Message = { channel: string; type: string; id: string };

/** Minimal top-level window: same-origin postMessage plus a scripted isolated relay. */
function fakePage(relay: (message: Message) => Array<Record<string, unknown>> = () => []) {
  const listeners: Array<(event: unknown) => void> = [];
  const posted: Message[] = [];
  const nativeGet = vi.fn(async function (this: unknown, _options?: unknown) {
    return "native" as unknown;
  });
  const container: { get: (options?: unknown) => Promise<unknown> } = { get: nativeGet };
  // The wrapper reads only each class's prototype.
  const PublicKeyCredential = { prototype: { kind: "credential" } };
  const AuthenticatorAssertionResponse = { prototype: { kind: "response" } };
  const scope: Record<string, unknown> & { postMessage(data: unknown): void } = {
    navigator: { credentials: container },
    PublicKeyCredential,
    AuthenticatorAssertionResponse,
    AbortSignal,
    location: { origin },
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.push(listener),
    postMessage(data: unknown) {
      const copy = structuredClone(data) as Message;
      queueMicrotask(() => {
        for (const listener of listeners) listener({ source: scope, origin, data: copy });
        if (copy.channel !== PAGE_CHANNEL) return;
        if (copy.type === "get" || copy.type === "cancel") {
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
    posted,
    prototypes: { credential: PublicKeyCredential.prototype },
  };
}

const publicKey = { challenge: new Uint8Array(16), allowCredentials: [] };
const answer = (result: RuntimeResult) => (message: Message) =>
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
    const page = fakePage(answer({ kind: "delegate", reason: "not-configured" }));
    const options = { publicKey, signal: new AbortController().signal };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]).toEqual([options]);
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
    expect(page.nativeGet.mock.contexts[0]).toBe(page.container);
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
    const page = fakePage(answer({ kind: "delegate", reason: "not-configured" }));
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
    const page = fakePage(answer({ kind: "delegate", reason: "not-configured" }));
    const wrapper = page.container.get;
    laterProvider(page.container, "reject").destroy();
    expect(page.container.get).toBe(wrapper);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
  });

  it("keeps claiming new requests while the provider holds an unclaimed one", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(
        claim ? { kind: "assertion", assertion } : { kind: "delegate", reason: "not-configured" },
      )(message),
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
    const page = fakePage(answer({ kind: "delegate", reason: "unsupported-mediation" }));
    const saved = page.container.get.bind(page.container);
    const provider = vi.fn(async (options?: unknown) =>
      saved({ ...(options as object), signal: new AbortController().signal }),
    );
    page.container.get = provider;
    await expect(page.container.get({ publicKey, mediation: "conditional" })).resolves.toBe(
      "native",
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.posted.filter((message) => message.type === "get")).toHaveLength(1);
  });

  it("stops a provider that copies deeper from looping back through Pateat", async () => {
    const page = fakePage(answer({ kind: "delegate", reason: "not-configured" }));
    const saved = page.container.get.bind(page.container);
    const provider = vi.fn(async (options?: unknown) => {
      const { publicKey: inner } = options as { publicKey: typeof publicKey };
      return saved({ publicKey: { ...inner, challenge: inner.challenge.slice() } });
    });
    page.container.get = provider;
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
    expect(provider).toHaveBeenCalledTimes(4);
    expect(page.nativeGet).toHaveBeenCalledOnce();
  });

  it("claims a modal request that reuses the publicKey of a held conditional one", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(
        claim
          ? { kind: "assertion", assertion }
          : { kind: "delegate", reason: "unsupported-mediation" },
      )(message),
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
      answer(
        claim
          ? { kind: "assertion", assertion }
          : { kind: "delegate", reason: "unsupported-mediation" },
      )(message),
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
  });

  it("sends a page call reusing a delegated publicKey with the same mediation to the browser", async () => {
    let claim = false;
    const page = fakePage((message) =>
      answer(
        claim ? { kind: "assertion", assertion } : { kind: "delegate", reason: "not-configured" },
      )(message),
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
      answer(
        claim ? { kind: "assertion", assertion } : { kind: "delegate", reason: "not-configured" },
      )(message),
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

  it("ignores assigning a non-function or itself", async () => {
    const page = fakePage(answer({ kind: "delegate", reason: "not-configured" }));
    const wrapper = page.container.get;
    (page.container as { get: unknown }).get = "not a function";
    page.container.get = wrapper;
    expect(page.container.get).toBe(wrapper);
    await expect(page.container.get({ publicKey })).resolves.toBe("native");
  });
});
