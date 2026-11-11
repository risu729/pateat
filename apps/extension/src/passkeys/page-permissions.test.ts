import { describe, expect, it, vi } from "vitest";
import type { PasskeyRuntimeOptions } from "./runtime-shared";
import { createPasskeyRuntime, type PasskeySource } from "./runtime";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const candidate = {
  credentialId: "AQID",
  rpId: "example.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
};
const sender = {
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "synthetic-document",
  documentLifecycle: "active",
  origin,
  url: `${origin}/signin`,
};
const request = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  type: "passkey.get",
  operationId: crypto.randomUUID(),
  request: { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com", allowCredentials: [] },
  userActivation: true,
  focused: true,
  ...overrides,
});
const source = (overrides: Partial<PasskeySource> = {}): PasskeySource => ({
  candidates: vi.fn(async () => ({ candidates: [candidate], complete: true })),
  sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
  ...overrides,
});
const always = { presence: "always", verification: "always" } as const;
type Permission = NonNullable<PasskeyRuntimeOptions<typeof candidate>["pagePermission"]>;

describe("page permission gates for passkey requests", () => {
  it.each([
    { conditional: false, userActivation: false },
    { conditional: true, userActivation: false },
    { conditional: true, userActivation: true },
  ])(
    "delegates before vault lookup despite always presence: %j",
    async ({ conditional, userActivation }) => {
      const backing = source();
      const pagePermission = vi.fn<Permission>(async (input) =>
        input.conditional || !input.userActivation ? "sign-in-fill" : undefined,
      );
      const runtime = createPasskeyRuntime(backing, {
        extensionId,
        policy: () => always,
        pagePermission,
        conditional: async () => ({ kind: "delegate", reason: "not-selected" }),
      });
      const input = request({
        userActivation,
        ...(conditional ? { request: { ...request().request, mediation: "conditional" } } : {}),
      });
      expect(await runtime.handle(input, sender)).toEqual({
        kind: "delegate",
        reason: "sign-in-fill",
      });
      expect(pagePermission).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: 7,
          origin,
          documentId: "synthetic-document",
          conditional,
          userActivation,
          allowCredentials: false,
        }),
      );
      expect(backing.candidates).not.toHaveBeenCalled();
      expect(backing.sign).not.toHaveBeenCalled();
    },
  );

  it("leaves an activated ordinary request eligible and checks policy at all three boundaries", async () => {
    const backing = source();
    const pagePermission = vi.fn<Permission>(async () => undefined);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => always,
      pagePermission,
      conditional: async () => ({ kind: "delegate", reason: "not-selected" }),
    });
    expect(await runtime.handle(request(), sender)).toMatchObject({ kind: "assertion" });
    expect(backing.sign).toHaveBeenCalledTimes(1);
    expect(pagePermission).toHaveBeenCalledTimes(3);
  });

  it("rechecks after asynchronous lookup before any signature", async () => {
    const backing = source();
    const pagePermission = vi
      .fn<Permission>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue("sign-in-fill");
    const answered = vi.fn();
    const remember = vi.fn();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => always,
      pagePermission,
      answered,
      remember,
    });
    expect(await runtime.handle(request({ userActivation: false }), sender)).toEqual({
      kind: "delegate",
      reason: "sign-in-fill",
    });
    expect(backing.candidates).toHaveBeenCalledTimes(1);
    expect(backing.sign).not.toHaveBeenCalled();
    expect(answered).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it("withholds an in-flight signature when policy changes before it can leave the request", async () => {
    let finish: ((bytes: Uint8Array) => void) | undefined;
    let refused = false;
    const backing = source({
      sign: vi.fn(
        async () =>
          new Promise<Uint8Array>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const pagePermission = vi.fn<Permission>(async () => (refused ? "sign-in-fill" : undefined));
    const answered = vi.fn();
    const remember = vi.fn();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => always,
      pagePermission,
      answered,
      remember,
    });
    const pending = runtime.handle(request({ userActivation: false }), sender);
    await vi.waitFor(() => expect(finish).toBeDefined());
    refused = true;
    finish!(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01));
    expect(await pending).toEqual({ kind: "delegate", reason: "sign-in-fill" });
    expect(answered).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(pagePermission).toHaveBeenCalledTimes(3);
  });

  it("fails closed if page policy becomes unavailable, without retrying a prohibited signature", async () => {
    const backing = source();
    const pagePermission = vi
      .fn<Permission>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("settings unavailable"));
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => always,
      pagePermission,
      conditional: async () => ({ kind: "delegate", reason: "not-selected" }),
    });
    expect(await runtime.handle(request(), sender)).toEqual({
      kind: "delegate",
      reason: "settings-unavailable",
    });
    expect(backing.sign).not.toHaveBeenCalled();
    expect(pagePermission).toHaveBeenCalledTimes(2);
  });
});
describe("passkey admission while page permission reads are pending", () => {
  it("retains an early page cancel throughout the permission read", async () => {
    let finish: ((value: undefined) => void) | undefined;
    const pagePermission = vi.fn<Permission>(
      async () =>
        new Promise<undefined>((resolve) => {
          finish = resolve;
        }),
    );
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId, pagePermission });
    const input = request();
    const pending = runtime.handle(input, sender);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const cancelled = await runtime.handle(
      { version: 1, type: "passkey.cancel", operationId: input.operationId },
      sender,
    );
    finish!(undefined);
    const result = await pending;
    expect(cancelled).toEqual({ ok: true });
    expect(result).toEqual({ kind: "cancelled" });
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("keeps a pending permission read's operation ID reserved", async () => {
    let finish: ((value: undefined) => void) | undefined;
    const pagePermission = vi
      .fn<Permission>()
      .mockImplementationOnce(
        async () =>
          new Promise<undefined>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId, pagePermission });
    const input = request();
    const pending = runtime.handle(input, sender);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const duplicate = await runtime.handle(input, sender);
    finish!(undefined);
    expect(await pending).toMatchObject({ kind: "assertion" });
    expect(duplicate).toEqual({ kind: "delegate", reason: "busy" });
    expect(backing.sign).toHaveBeenCalledTimes(1);
  });

  it("rechecks capacity atomically after concurrent permission reads without starving another document", async () => {
    const finish: ((value: undefined) => void)[] = [];
    const pagePermission = vi.fn<Permission>(
      async () => new Promise<undefined>((resolve) => finish.push(resolve)),
    );
    const backing = source({ candidates: vi.fn(async () => new Promise<never>(() => undefined)) });
    const runtime = createPasskeyRuntime(backing, { extensionId, pagePermission });
    const pending = Array.from({ length: 5 }, () => runtime.handle(request(), sender));
    const other = runtime.handle(request(), { ...sender, documentId: "other-document" });
    await vi.waitFor(() => expect(finish).toHaveLength(6));
    for (const resolve of finish) resolve(undefined);
    try {
      await vi.waitFor(() => expect(backing.candidates).toHaveBeenCalledTimes(5));
    } finally {
      runtime.settingsChanged();
    }
    expect(await Promise.all([...pending, other])).toEqual([
      { kind: "cancelled" },
      { kind: "cancelled" },
      { kind: "cancelled" },
      { kind: "cancelled" },
      { kind: "delegate", reason: "busy" },
      { kind: "cancelled" },
    ]);
    expect(backing.sign).not.toHaveBeenCalled();
  });
});
describe("cancellation during answer-stage passkey permission checks", () => {
  it.each([
    { gateAt: 2, cause: "page-cancelled" },
    { gateAt: 2, cause: "settings-changed" },
    { gateAt: 3, cause: "page-cancelled" },
    { gateAt: 3, cause: "settings-changed" },
    { gateAt: 3, cause: "timeout" },
  ] as const)("withholds the answer at gate $gateAt after $cause", async ({ gateAt, cause }) => {
    let finish: ((value: undefined) => void) | undefined;
    const gate = new Promise<undefined>((resolve) => {
      finish = resolve;
    });
    let checks = 0;
    const pagePermission = vi.fn<Permission>(async () => (++checks === gateAt ? gate : undefined));
    const answered = vi.fn();
    const remember = vi.fn();
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      pagePermission,
      answered,
      remember,
      timeoutMs: () => (cause === "timeout" ? 50 : 10_000),
    });
    const input = request();
    const pending = runtime.handle(input, sender);
    await vi.waitFor(() => expect(pagePermission).toHaveBeenCalledTimes(gateAt));
    expect(backing.sign).toHaveBeenCalledTimes(gateAt === 2 ? 0 : 1);
    if (cause === "page-cancelled")
      expect(
        await runtime.handle(
          { version: 1, type: "passkey.cancel", operationId: input.operationId },
          sender,
        ),
      ).toEqual({ ok: true });
    else if (cause === "settings-changed") runtime.settingsChanged();
    // A cancelled request settles even if the asynchronous policy read never answers.
    expect(await pending).toEqual(
      cause === "timeout" ? { kind: "delegate", reason: "timeout" } : { kind: "cancelled" },
    );
    finish!(undefined);
    expect(answered).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(backing.sign).toHaveBeenCalledTimes(gateAt === 2 ? 0 : 1);
  });
});
