import { expect, it, vi } from "vitest";
import {
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeySource,
} from "../../src/passkeys/runtime";
import { RUNTIME_TIMEOUT_MS } from "../../src/passkeys/wire";
import type { RuntimeFixtures, RuntimeGet } from "./runtime-context";

export function registerImmediateCases({
  extensionId,
  origin,
  sender,
  candidate,
  request,
  source,
  immediate,
  pair,
  several,
}: Pick<
  RuntimeFixtures,
  "extensionId" | "origin" | "sender" | "candidate" | "request" | "source"
> & {
  immediate: (
    overrides?: Record<string, unknown>,
  ) => Omit<RuntimeGet, "request"> & { request: RuntimeFixtures["request"] & { uiMode: string } };
  pair: RuntimeFixtures["candidate"][];
  several: (complete?: boolean) => PasskeySource;
}) {
  it("answers a single stored passkey without showing a chooser", async () => {
    const backing = source();
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(backing, { extensionId, chooser: { choose }, report });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({ kind: "assertion" });
    expect(backing.sign).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ uiMode: "immediate" })),
    );
  });

  it("answers a site default even while another vault could not be searched", async () => {
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: [{ ...candidate, preferred: true }, pair[1]!],
        complete: false,
      })),
    });
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const runtime = createPasskeyRuntime(backing, { extensionId, chooser: { choose } });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "AQID" },
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it.each([
    ["without activation", { userActivation: false }, {}, "no-user-activation"],
    ["in incognito", {}, { tab: { id: 7, incognito: true } }, "immediate-incognito"],
  ])("delegates %s before reading the vault", async (_, message, context, reason) => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(immediate(message), sender(context))).toEqual({
      kind: "delegate",
      reason,
    });
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("delegates an allow list and reports the request's uiMode", async () => {
    const backing = source();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(backing, { extensionId, report });
    const message = immediate({
      request: {
        ...request,
        uiMode: "immediate",
        allowCredentials: [{ type: "public-key", id: "AQID" }],
      },
    });
    expect(await runtime.handle(message, sender())).toEqual({
      kind: "delegate",
      reason: "immediate-allow-credentials",
    });
    expect(backing.candidates).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "immediate-allow-credentials", uiMode: "immediate" }),
      ),
    );
  });

  it.each([
    ["without focus", { focused: false }, {}],
    ["in an inactive document", {}, { documentLifecycle: "cached" }],
  ])("answers a single match %s, as a normal request does", async (_, message, context) => {
    const runtime = createPasskeyRuntime(source(), { extensionId });
    expect(await runtime.handle(immediate(message), sender(context))).toMatchObject({
      kind: "assertion",
    });
  });

  it("delegates when no stored passkey matches, so the browser rejects at once", async () => {
    const backing = source({ candidates: vi.fn(async () => ({ candidates: [], complete: true })) });
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(immediate(), sender())).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
  });

  it("opens the chooser for several passkeys and signs with the chosen one", async () => {
    const backing = several();
    const choose = vi.fn<PasskeyChooser["choose"]>(async () => ({
      kind: "chosen",
      index: 1,
      makeDefault: false,
    }));
    const runtime = createPasskeyRuntime(backing, { extensionId, chooser: { choose } });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "BAUG" },
    });
    expect(choose).toHaveBeenCalledOnce();
  });

  it("delegates several passkeys while another vault could not be searched", async () => {
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const runtime = createPasskeyRuntime(several(false), { extensionId, chooser: { choose } });
    expect(await runtime.handle(immediate(), sender())).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it("signs again in a tab that already signed in, as a normal request does (ADR 0062)", async () => {
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const runtime = createPasskeyRuntime(source(), { extensionId, chooser: { choose } });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({ kind: "assertion" });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps the normal lookup budget", async () => {
    vi.useFakeTimers();
    const backing = source({ sign: vi.fn(() => new Promise<Uint8Array>(() => undefined)) });
    const runtime = createPasskeyRuntime(backing, { extensionId });
    const pending = runtime.handle(immediate(), sender());
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(RUNTIME_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: "delegate", reason: "timeout" });
  });

  it("does not count time in the chooser toward the lookup budget", async () => {
    vi.useFakeTimers();
    let choose!: (choice: PasskeyChoice) => void;
    const runtime = createPasskeyRuntime(several(), {
      extensionId,
      chooser: {
        choose: () => new Promise<PasskeyChoice>((resolve) => (choose = resolve)),
      },
    });
    const pending = runtime.handle(immediate(), sender());
    await vi.waitUntil(() => choose !== undefined);
    await vi.advanceTimersByTimeAsync(RUNTIME_TIMEOUT_MS * 3);
    choose({ kind: "chosen", index: 0, makeDefault: false });
    expect(await pending).toMatchObject({ kind: "assertion" });
  });

  it("scopes the search to the running login's item", async () => {
    const item = { connectionId: "synthetic-connection", itemId: "login-item" };
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId, loginAccount: () => item });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({ kind: "assertion" });
    expect(backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
      item,
    );
  });
}
