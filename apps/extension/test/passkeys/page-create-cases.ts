import { expect, it, vi } from "vitest";
import {
  PAGE_CHANNEL,
  PAGE_CREATE_MAX_WAIT_MS,
  PAGE_TIMEOUT_MS,
  type PageResult,
} from "../../src/passkeys/wire";
import type { PageFixtures, PageMessage as Message } from "../../src/passkeys/page.test";

export function registerPageCreateCases({
  fakePage,
  publicKey,
  answer,
  registration,
  answerCreate,
  types,
}: Pick<
  PageFixtures,
  "fakePage" | "publicKey" | "answer" | "registration" | "answerCreate" | "types"
>) {
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
}
