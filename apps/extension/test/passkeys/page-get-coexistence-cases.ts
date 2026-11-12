import { expect, it, vi } from "vitest";
import type { PageFixtures } from "../../src/passkeys/page.test";

export function registerPageGetCoexistenceCases({
  fakePage,
  publicKey,
  answer,
  laterProvider,
}: Pick<PageFixtures, "fakePage" | "publicKey" | "answer" | "laterProvider">) {
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
}
