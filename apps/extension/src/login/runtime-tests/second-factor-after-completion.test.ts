import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESULT_CORRECTION_MS } from "../runtime/constants";
import { createPasskeyRuntime, type PasskeySource } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, harness } = createRuntimeTestHarness(fake);

// dash.cloudflare.com, 2026-11-17 13:55 UTC: the recipe's signed-in marker showed on
// `/two-factor`, so the login completed at once, and the security-key request of that page
// 0.6 s later was handed to Bitwarden as a re-verification (`confirm-fill`).
describe("a passkey request of the document a login just completed in (ADR 0029, amended 2026-11-17)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    // Nothing shows after the click, so the login completes on its marker at once.
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.cardHints = undefined;
    fake.state.question = undefined;
  });
  const withPasskey = vi.fn(async () => ({ passkey: true, discoverable: false }));
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const signedIn = async () => {
    const h = harness({}, { passkeys: withPasskey });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    return h;
  };
  const page = "synthetic-document";

  it("is the login's second factor: answered with its item, not handed on", async () => {
    const h = await signedIn();
    expect(await h.login.passkeyReverification(1, origin, page)).toBe(false);
    expect(await h.login.loginAccount(1, origin, page)).toEqual({ connectionId, itemId });
  });
  it("is a re-verification from another document of the tab", async () => {
    const h = await signedIn();
    expect(await h.login.passkeyReverification(1, origin, "next-document")).toBe(true);
    expect(await h.login.loginAccount(1, origin, "next-document")).toBeUndefined();
  });
  it("is a re-verification when no document is named", async () => {
    const h = await signedIn();
    expect(await h.login.passkeyReverification(1, origin)).toBe(true);
    expect(await h.login.loginAccount(1, origin)).toBeUndefined();
  });
  it("is a re-verification once the correction's time has passed", async () => {
    const h = await signedIn();
    const now = Date.now();
    vi.useFakeTimers({ now, toFake: ["Date"] });
    vi.setSystemTime(now + RESULT_CORRECTION_MS);
    expect(await h.login.passkeyReverification(1, origin, page)).toBe(true);
    expect(await h.login.loginAccount(1, origin, page)).toBeUndefined();
  });
  it("belongs to no login in another tab or origin", async () => {
    const h = await signedIn();
    expect(await h.login.loginAccount(2, origin, page)).toBeUndefined();
    expect(await h.login.loginAccount(1, "https://other.example", page)).toBeUndefined();
    expect(await h.login.passkeyReverification(2, origin, page)).toBe(false);
  });
  it("is answered with the login's item through the passkey bridge", async () => {
    const h = await signedIn();
    // Signing awaits Web Crypto, which the harness's auto-advancing timers would outrun.
    vi.useRealTimers();
    const source: PasskeySource = {
      candidates: vi.fn(async () => ({
        candidates: [
          {
            credentialId: "AQID",
            rpId: "login.example",
            userHandle: "dXNlcg",
            discoverable: false,
            counter: 0,
          },
        ],
        complete: true,
      })),
      sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
    };
    // Wired as the background wires them, so the arguments line up as they do there.
    const runtime = createPasskeyRuntime(source, {
      extensionId: "synthetic-extension",
      loginAccount: h.login.loginAccount,
      reverification: h.login.passkeyReverification,
    });
    const request = (documentId: string) =>
      runtime.handle(
        {
          version: 1,
          type: "passkey.get",
          operationId: crypto.randomUUID(),
          userActivation: false,
          focused: true,
          request: {
            challenge: "AAECAwQFBgcICQoLDA0ODw",
            rpId: "login.example",
            allowCredentials: [{ type: "public-key", id: "AQID" }],
          },
        },
        {
          id: "synthetic-extension",
          tab: { id: 1 },
          frameId: 0,
          documentId,
          documentLifecycle: "active",
          origin,
          url: `${origin}/two-factor`,
        } as never,
      );
    expect(await request(page)).toMatchObject({ kind: "assertion" });
    expect(source.candidates).toHaveBeenCalledWith(
      origin,
      "login.example",
      expect.any(AbortSignal),
      { connectionId, itemId },
    );
    expect(await request("next-document")).toEqual({ kind: "delegate", reason: "confirm-fill" });
  });
});
