import { expect, it, vi } from "vitest";
import {
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeySource,
} from "../../src/passkeys/runtime";
import type { PasskeyCandidates } from "../../src/passkeys/select";
import type { Mock } from "vitest";
import type { RuntimeFixtures, RuntimeGet } from "./runtime-context";

export function registerPausedCases({
  extensionId,
  origin,
  sender,
  get,
  work,
  home,
  vault,
  answering,
  immediate,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "get"> & {
  work: RuntimeFixtures["candidate"] & { display: { item: string; userName: string } };
  home: RuntimeFixtures["candidate"] & { display: { item: string; userName: string } };
  vault: (
    candidates: PasskeyCandidates["candidates"],
    options?: { complete?: boolean; siteDefault?: "searched" },
  ) => PasskeySource;
  answering: (choice?: PasskeyChoice) => Mock<PasskeyChooser["choose"]>;
  immediate: () => Omit<RuntimeGet, "request"> & {
    request: RuntimeFixtures["request"] & { uiMode: string };
  };
}) {
  it("opens the chooser for a single match and signs only with the chosen passkey", async () => {
    const backing = vault([home]);
    const choose = answering();
    const paused = vi.fn(async () => "paused" as const);
    const remember = vi.fn(async () => {});
    const report = vi.fn();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: paused,
      remember,
      report,
    });
    expect(await runtime.handle(get(), sender({ tab: { id: 7, incognito: false } }))).toMatchObject(
      { kind: "assertion", assertion: { credentialId: "AQID" } },
    );
    expect(paused).toHaveBeenCalledWith(origin, false);
    expect(choose).toHaveBeenCalledWith({
      tabId: 7,
      origin,
      rpId: "example.com",
      entries: [{ item: "Home", userName: "alice" }],
      replacesDefault: false,
      paused: true,
      signal: expect.any(AbortSignal),
    });
    expect(backing.sign).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A one-off pick saves nothing.
    expect(remember).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "assertion", paused: true, chooser: "chosen" }),
    );
  });

  it("treats the site default as unset: listed in place, not marked, and kept", async () => {
    const backing = vault([work, { ...home, preferred: true }], { siteDefault: "searched" });
    const choose = answering({ kind: "chosen", index: 0, makeDefault: false });
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: () => "paused",
      remember,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "BAUG" },
    });
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({
        // Not moved first and not `preferred`; ticking the box would replace the default.
        entries: [
          { item: "Work", userName: "bob" },
          { item: "Home", userName: "alice" },
        ],
        replacesDefault: true,
        paused: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
  });

  it("opens the chooser for a lone site default and signs nothing when it is closed", async () => {
    const backing = vault([{ ...home, preferred: true }], { siteDefault: "searched" });
    const choose = answering({ kind: "closed" });
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: async () => "paused" as const,
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-closed",
    });
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ item: "Home", userName: "alice" }] }),
    );
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("saves a choice as the default only when the box was ticked", async () => {
    const backing = vault([work, { ...home, preferred: true }], { siteDefault: "searched" });
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose: answering({ kind: "chosen", index: 0, makeDefault: true }) },
      defaultUnset: () => "paused",
      remember,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).toHaveBeenCalledWith(origin, work);
  });

  it("hands the request on where the chooser cannot open, and never signs", async () => {
    const backing = vault([{ ...home, preferred: true }]);
    const choose = answering();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: () => "paused",
      report,
    });
    const handed = { kind: "delegate", reason: "paused" };
    expect(await runtime.handle(get(), sender({ tab: { id: 7, incognito: true } }))).toEqual(
      handed,
    );
    expect(await runtime.handle(get(undefined, true, false), sender())).toEqual(handed);
    expect(await runtime.handle(get(), sender({ documentLifecycle: "prerender" }))).toEqual(handed);
    const windowless = createPasskeyRuntime(backing, { extensionId, defaultUnset: () => "paused" });
    expect(await windowless.handle(get(), sender())).toEqual(handed);
    expect(choose).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "delegate", reason: "paused", paused: true }),
      ),
    );
  });

  it("hands on a site default while another vault could not be searched", async () => {
    const backing = vault([{ ...home, preferred: true }], { complete: false });
    const choose = answering();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: () => "paused",
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it("opens the chooser for an Immediate UI request, and hands it on in incognito", async () => {
    const backing = vault([home]);
    const choose = answering();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: () => "paused",
    });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
    expect(await runtime.handle(immediate(), sender({ tab: { id: 7, incognito: true } }))).toEqual({
      kind: "delegate",
      reason: "immediate-incognito",
    });
    expect(choose).toHaveBeenCalledOnce();
    expect(backing.sign).toHaveBeenCalledOnce();
  });

  it("answers with the item of a login a popup pick started (ADR 0027)", async () => {
    const backing = vault([home]);
    const choose = answering();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose },
      defaultUnset: () => "paused",
      loginAccount: () => ({ connectionId: "personal", itemId: "login-item" }),
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose).not.toHaveBeenCalled();
  });

  it("answers as before when the site is not paused or its pause cannot be read", async () => {
    const choose = answering();
    for (const defaultUnset of [() => false, () => Promise.reject(new Error("unreadable"))]) {
      const backing = vault([home]);
      const runtime = createPasskeyRuntime(backing, {
        extensionId,
        chooser: { choose },
        defaultUnset,
      });
      // oxlint-disable-next-line no-await-in-loop -- each case runs alone
      expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    }
    expect(choose).not.toHaveBeenCalled();
  });
}
