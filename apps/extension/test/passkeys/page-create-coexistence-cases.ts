import { expect, it, vi } from "vitest";
import type { PageFixtures } from "../../src/passkeys/page.test";

export function registerPageCreateCoexistenceCases({
  fakePage,
  answer,
  registration,
  answerCreate,
  types,
}: Pick<PageFixtures, "fakePage" | "answer" | "registration" | "answerCreate" | "types">) {
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
}
