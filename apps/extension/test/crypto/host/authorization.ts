import { expect, it, vi } from "vitest";
import { CRYPTO_PORT } from "../../../src/crypto/wire";
import type { CryptoHostTestContext } from "./context";

export function registerAuthorizationCases({
  harness,
  auth,
  extensionId,
  offscreenUrl,
  oldOffscreenUrl,
  documentId,
  connectionId,
}: Pick<
  CryptoHostTestContext,
  | "harness"
  | "auth"
  | "extensionId"
  | "offscreenUrl"
  | "oldOffscreenUrl"
  | "documentId"
  | "connectionId"
>) {
  it("leaves another subsystem's named Port untouched while still rejecting an owned crypto name from a spoofed sender", async () => {
    const h = harness();
    const unrelated = {
      ...h.port,
      name: "pateat.bitwarden-setup.v1",
      sender: { id: extensionId, url: `chrome-extension://${extensionId}/options.html` },
      disconnect: vi.fn(),
      postMessage: vi.fn(),
    };
    h.onConnect.emit(unrelated);
    await Promise.resolve();
    expect(unrelated.disconnect).not.toHaveBeenCalled();
    expect(unrelated.postMessage).not.toHaveBeenCalled();
    expect(h.getContexts).not.toHaveBeenCalled();
    expect(h.host.status()).toMatchObject({ ready: false, offscreenDocumentBound: false });
    const spoofed = { ...unrelated, name: CRYPTO_PORT, disconnect: vi.fn() };
    h.onConnect.emit(spoofed);
    await vi.waitFor(() => expect(spoofed.disconnect).toHaveBeenCalledOnce());
    expect(spoofed.postMessage).not.toHaveBeenCalled();
    expect(h.getContexts).not.toHaveBeenCalled();
  });
  it("closes a prior offscreen document and binds only the fresh browser document before sending secrets", async () => {
    const h = harness({ existing: true, automaticReady: false });
    const pending = h.host.deriveAuthentication(auth());
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalled());
    expect(h.closeDocument).toHaveBeenCalledOnce();
    expect(h.createDocument).toHaveBeenCalledOnce();
    expect(h.closeDocument.mock.invocationCallOrder[0]).toBeLessThan(
      h.createDocument.mock.invocationCallOrder[0]!,
    );
    expect(h.commands).toEqual([]);
    expect(h.posted).toEqual([{ version: 1, type: "crypto.reset", generation: h.host.generation }]);
    h.onMessage.emit({ version: 1, type: "crypto.ready", generation: crypto.randomUUID() });
    expect(h.commands).toEqual([]);
    h.onMessage.emit({ version: 1, type: "crypto.ready", generation: h.host.generation });
    const command = await h.command();
    expect(command.operation).toEqual({ kind: "derive-auth", input: auth() });
    h.reply(command, { ok: true, data: { connectionId, masterPasswordHash: "synthetic-hash" } });
    expect(await pending).toMatchObject({ ok: true });
  });

  it.each([
    { id: "other-extension", url: offscreenUrl, documentId },
    { id: extensionId, url: `chrome-extension://${extensionId}/options.html`, documentId },
    { id: extensionId, url: oldOffscreenUrl },
    { id: extensionId, url: `chrome-extension://${extensionId}/crypto-offscreen.html` },
    { id: extensionId, url: offscreenUrl, documentId: "" },
    { id: extensionId, url: offscreenUrl, documentId: "not-current-document" },
    { id: extensionId, url: offscreenUrl, documentId, tab: { id: 1 } },
    { id: extensionId, url: offscreenUrl, documentId, frameId: 0 },
    { id: extensionId, url: offscreenUrl, documentId, nativeApplication: "synthetic-native" },
  ])("rejects spoofed port identity case %# even if its name is correct", async (sender) => {
    const h = harness({ automaticReady: false, timeoutMs: 20 });
    h.port.sender = sender;
    const pending = h.host.deriveAuthentication(auth());
    await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
    expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
    expect(h.createDocument).toHaveBeenCalledOnce();
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
  });

  it("rejects unsolicited ports before document creation", async () => {
    const h = harness();
    h.onConnect.emit(h.port);
    await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
    expect(h.createDocument).not.toHaveBeenCalled();
    expect(h.port.postMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, documentId])(
    "uses the singleton native context when sender documentId is %s",
    async (suppliedId) => {
      const h = harness();
      if (suppliedId !== undefined) h.port.sender!.documentId = suppliedId;
      const pending = h.host.deriveAuthentication(auth());
      const command = await h.command();
      expect(h.host.status()).toMatchObject({ ready: true, offscreenDocumentBound: true });
      expect(h.port.disconnect).not.toHaveBeenCalled();
      h.reply(command, { ok: false, error: { code: "unsupported-crypto" } });
      expect(await pending).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    },
  );

  it.each(
    [
      [],
      [{ documentId, documentUrl: oldOffscreenUrl }],
      [{ documentId }],
      [{ documentUrl: offscreenUrl }],
      [{ documentId: "", documentUrl: offscreenUrl }],
      [{ documentId: "x".repeat(257), documentUrl: offscreenUrl }],
      [
        { documentId, documentUrl: offscreenUrl },
        { documentId, documentUrl: offscreenUrl },
      ],
      [
        { documentId, documentUrl: offscreenUrl },
        { documentId: "old-document", documentUrl: oldOffscreenUrl },
      ],
    ].map((contexts) => ({ contexts })),
  )(
    "rejects nonauthoritative native contexts case %# without secret dispatch",
    async ({ contexts: nativeContexts }) => {
      const h = harness({ timeoutMs: 20, creationContexts: nativeContexts });
      const pending = h.host.deriveAuthentication(auth());
      await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
      expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
      expect(h.port.postMessage).not.toHaveBeenCalled();
      expect(h.commands).toEqual([]);
      expect(h.host.status()).toMatchObject({ ready: false, offscreenDocumentBound: false });
    },
  );

  it("rejects a delayed native context lookup after its bootstrap has expired", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi.fn(() => held);
    const h = harness({ timeoutMs: 20, contextLookup: lookup });
    const pending = h.host.deriveAuthentication(auth());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    expect(await pending).toEqual({ ok: false, error: { code: "timeout" } });
    // The lookup still returns the previously valid browser context. Its old
    // creation identity must not bind the Port after cleanup changed lifecycle.
    release();
    await vi.waitFor(() => expect(h.port.disconnect).toHaveBeenCalledOnce());
    expect(h.port.postMessage).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    expect(h.host.status()).toMatchObject({ ready: false, offscreenDocumentBound: false });
  });
}
