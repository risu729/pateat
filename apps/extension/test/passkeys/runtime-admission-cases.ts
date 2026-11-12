import { expect, it, type Mock, vi } from "vitest";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "../../src/passkeys/policy";
import {
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeySource,
} from "../../src/passkeys/runtime";
import type { PasskeyCandidates } from "../../src/passkeys/select";
import { snapshotGetOptions } from "../../src/passkeys/page";
import type { RuntimeFixtures } from "./runtime-context";

export function registerSenderBindingCases({
  extensionId,
  origin,
  sender,
  candidate,
  request,
  get,
  source,
}: Pick<
  RuntimeFixtures,
  "extensionId" | "origin" | "sender" | "candidate" | "request" | "get" | "source"
>) {
  it("answers a top-frame document from its browser-supplied origin", async () => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId });
    const result = await runtime.handle(get(), sender());
    expect(result).toMatchObject({ kind: "assertion", assertion: { credentialId: "AQID" } });
    expect(backing.candidates).toHaveBeenCalledWith(origin, "example.com", expect.any(AbortSignal));
    const clientData = JSON.parse(
      atob(
        (result as { assertion: { clientDataJSON: string } }).assertion.clientDataJSON
          .replace(/-/gu, "+")
          .replace(/_/gu, "/"),
      ),
    );
    expect(clientData.origin).toBe(origin);
  });

  it("answers another site's RP ID only when that RP lists the page's origin (ADR 0084)", async () => {
    const chatgpt = "https://chatgpt.com";
    const page = sender({ origin: chatgpt, url: `${chatgpt}/auth/login` });
    const related = { ...get(), request: { ...request, rpId: "openai.com" } };
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: [{ ...candidate, rpId: "openai.com" }],
        complete: true,
      })),
    });
    expect(await createPasskeyRuntime(backing, { extensionId }).handle(related, page)).toEqual({
      kind: "delegate",
      reason: "rp-id-mismatch",
    });
    const allows = vi.fn(async (_origin: string, rpId: string) => rpId === "openai.com");
    const runtime = createPasskeyRuntime(backing, { extensionId, relatedOrigins: { allows } });
    const result = await runtime.handle(related, page);
    expect(result).toMatchObject({ kind: "assertion", assertion: { credentialId: "AQID" } });
    expect(allows).toHaveBeenCalledWith(chatgpt, "openai.com");
    expect(backing.candidates).toHaveBeenCalledWith(chatgpt, "openai.com", expect.any(AbortSignal));
    const clientData = JSON.parse(
      atob(
        (result as { assertion: { clientDataJSON: string } }).assertion.clientDataJSON
          .replace(/-/gu, "+")
          .replace(/_/gu, "/"),
      ),
    );
    expect(clientData).toMatchObject({ origin: chatgpt, crossOrigin: false });
    // The signature covers openai.com's RP ID hash.
    const authenticatorData = Uint8Array.from(
      atob(
        (result as { assertion: { authenticatorData: string } }).assertion.authenticatorData
          .replace(/-/gu, "+")
          .replace(/_/gu, "/"),
      ),
      (character) => character.charCodeAt(0),
    );
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("openai.com")),
    );
    expect(authenticatorData.subarray(0, 32)).toEqual(rpIdHash);
    // An RP that does not list the page, and one the page may use anyway, are not asked again.
    expect(
      await runtime.handle(
        {
          ...related,
          operationId: crypto.randomUUID(),
          request: { ...request, rpId: "example.net" },
        },
        page,
      ),
    ).toEqual({ kind: "delegate", reason: "rp-id-mismatch" });
    allows.mockClear();
    const own = createPasskeyRuntime(source(), { extensionId, relatedOrigins: { allows } });
    expect(await own.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(allows).not.toHaveBeenCalled();
  });

  it("reads an RP's list only for a passkey the vault holds, on a page not left to the browser (ADR 0084)", async () => {
    const chatgpt = "https://chatgpt.com";
    const page = sender({ origin: chatgpt, url: `${chatgpt}/` });
    const related = () => ({
      ...get(),
      request: { ...request, rpId: "openai.com" },
    });
    const allows = vi.fn(async () => true);
    // The vault holds no passkey of openai.com: the page cannot pick a host to fetch.
    const none = createPasskeyRuntime(
      source({ candidates: vi.fn(async () => ({ candidates: [candidate], complete: true })) }),
      { extensionId, relatedOrigins: { allows } },
    );
    expect(await none.handle(related(), page)).toEqual({
      kind: "delegate",
      reason: "rp-id-mismatch",
    });
    expect(allows).not.toHaveBeenCalled();
    const held = () =>
      source({
        candidates: vi.fn(async () => ({
          candidates: [{ ...candidate, rpId: "openai.com" }],
          complete: true,
        })),
      });
    // "Always for this site", and a request refused for another reason, read no list.
    const listed = createPasskeyRuntime(held(), {
      extensionId,
      relatedOrigins: { allows },
      browserSite: () => true,
    });
    expect(await listed.handle(related(), page)).toMatchObject({ kind: "delegate" });
    const runtime = createPasskeyRuntime(held(), { extensionId, relatedOrigins: { allows } });
    expect(
      await runtime.handle(
        { ...related(), request: { ...request, rpId: "openai.com", mediation: "silent" } },
        page,
      ),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    expect(allows).not.toHaveBeenCalled();
    // A list that cannot be read hands the request on.
    allows.mockRejectedValueOnce(new Error("offline"));
    expect(await runtime.handle(related(), page)).toEqual({
      kind: "delegate",
      reason: "rp-id-mismatch",
    });
  });

  it("keeps a page's cancel that arrives while an RP's list is read (ADR 0084)", async () => {
    let listed!: (allowed: boolean) => void;
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: [{ ...candidate, rpId: "openai.com" }],
        complete: true,
      })),
    });
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      relatedOrigins: {
        allows: () =>
          new Promise<boolean>((resolve) => {
            listed = resolve;
          }),
      },
    });
    const operationId = crypto.randomUUID();
    const page = sender({ origin: "https://chatgpt.com", url: "https://chatgpt.com/" });
    const pending = runtime.handle(
      { ...get(operationId), request: { ...request, rpId: "openai.com" } },
      page,
    );
    await vi.waitFor(() => expect(listed).toBeTypeOf("function"));
    // One list at a time for a document: another request of it is handed on meanwhile.
    expect(
      await runtime.handle({ ...get(), request: { ...request, rpId: "openai.com" } }, page),
    ).toEqual({ kind: "delegate", reason: "rp-id-mismatch" });
    expect(await runtime.handle({ version: 1, type: "passkey.cancel", operationId }, page)).toEqual(
      { ok: true },
    );
    listed(true);
    expect(await pending).toEqual({ kind: "cancelled" });
    // Only the check for a held passkey searched; nothing was answered.
    expect(backing.candidates).toHaveBeenCalledTimes(1);
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it.each([
    ["another extension", { id: "other" }],
    ["a subframe", { frameId: 3 }],
    ["no tab", { tab: undefined }],
    ["no document", { documentId: undefined }],
    ["mismatched URL", { url: "https://evil.example.net/" }],
    ["missing origin", { origin: undefined }],
    // A page served with a CSP `sandbox` header on the site's URL has an opaque origin.
    ["an opaque origin on the site's URL", { origin: "null" }],
  ])("delegates requests from %s without a lookup", async (_name, overrides) => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(get(), sender(overrides))).toEqual({
      kind: "delegate",
      reason: "invalid-sender",
    });
    expect(backing.candidates).not.toHaveBeenCalled();
  });

  it("delegates without configuration and never signs", async () => {
    const backing = source({ candidates: vi.fn(async () => undefined) });
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "not-configured",
    });
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("delegates a nonzero counter without signing", async () => {
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: [{ ...candidate, counter: 2 }],
        complete: true,
      })),
    });
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "unsupported-counter",
    });
    expect(backing.sign).not.toHaveBeenCalled();
  });
}

export function registerCancellationCases({
  extensionId,
  sender,
  get,
  source,
  slowSign,
}: Pick<RuntimeFixtures, "extensionId" | "sender" | "get" | "source"> & {
  slowSign: () => PasskeySource;
}) {
  it("cancels only from the same document", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(slowSign(), { extensionId, report });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(get(operationId), sender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancel = { version: 1, type: "passkey.cancel", operationId };
    expect(await runtime.handle(cancel, sender({ documentId: "document-b" }))).toEqual({
      ok: false,
    });
    expect(await runtime.handle(cancel, sender())).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", cause: "page-cancelled" }),
    );
  });

  it("delegates after its deadline and rejects duplicate operation IDs", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId, timeoutMs: () => 20 });
    const operationId = crypto.randomUUID();
    const first = runtime.handle(get(operationId), sender());
    expect(await runtime.handle(get(operationId), sender())).toEqual({
      kind: "delegate",
      reason: "busy",
    });
    expect(await first).toEqual({ kind: "delegate", reason: "timeout" });
  });

  it("limits concurrent operations per document without starving other documents", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId });
    const pending = Array.from({ length: 4 }, () => runtime.handle(get(), sender()));
    expect(await runtime.handle(get(), sender())).toEqual({ kind: "delegate", reason: "busy" });
    const other = runtime.handle(get(), sender({ documentId: "document-b" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.settingsChanged();
    expect(await Promise.all([...pending, other])).toEqual(
      Array.from({ length: 5 }, () => ({ kind: "cancelled" })),
    );
  });

  it("cancels every in-flight operation on a settings change", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(slowSign(), { extensionId, report });
    const pending = [runtime.handle(get(), sender()), runtime.handle(get(), sender())];
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.settingsChanged();
    expect(await Promise.all(pending)).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }]);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", cause: "settings-changed" }),
    );
  });

  it("names the step that threw when it delegates", async () => {
    const report = vi.fn();
    const backing = source({ sign: vi.fn(async () => Promise.reject(new Error("unavailable"))) });
    const runtime = createPasskeyRuntime(backing, { extensionId, report });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "signing" }),
      ),
    );
    vi.mocked(backing.candidates).mockRejectedValueOnce(new Error("vault-unavailable"));
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "passkey-lookup" }),
      ),
    );

    const lookup = vi.fn();
    const passkeys = source();
    const failing = createPasskeyRuntime(passkeys, {
      extensionId,
      report: lookup,
      loginAccount: async () => Promise.reject(new Error("unavailable")),
    });
    expect(await failing.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    // Never the site's default passkey in place of the login's account.
    expect(passkeys.sign).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(lookup).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "account-lookup" }),
      ),
    );
    // A login lookup that fails leaves the flag out; the report is still sent.
    expect(lookup.mock.lastCall![0]).not.toHaveProperty("duringLogin");
  });
}

export function registerDocumentReplacementCases({
  origin,
  sender,
  candidate,
  get,
  source,
  signature,
  cancel,
  tick,
  setup,
}: Pick<RuntimeFixtures, "origin" | "sender" | "candidate" | "get" | "source"> & {
  signature: Uint8Array<ArrayBuffer>;
  cancel: (operationId: string) => { version: number; type: string; operationId: string };
  tick: () => Promise<unknown>;
  setup: (
    backing: PasskeySource,
    choice?: PasskeyChoice,
  ) => {
    runtime: ReturnType<typeof createPasskeyRuntime>;
    chooser: { choose: Mock<PasskeyChooser["choose"]> };
    leave: Mock;
    answered: Mock;
    remember: Mock<() => Promise<void>>;
    report: Mock;
    hold: Mock<() => Promise<Mock>>;
  };
}) {
  it("gets no assertion and records no sign-in when its signing ignores the cancel", async () => {
    // The vault's Worker signs anyway: only the runtime's own abort ends the request.
    let release!: (signature: Uint8Array) => void;
    const backing = source({
      sign: vi
        .fn<PasskeySource["sign"]>(async () => signature)
        .mockImplementationOnce(() => new Promise((resolve) => (release = resolve))),
    });
    const tab = setup(backing);
    const operationId = crypto.randomUUID();
    const pending = tab.runtime.handle(get(operationId), sender());
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledOnce());
    expect(await tab.runtime.handle(cancel(operationId), sender())).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(tab.leave).toHaveBeenCalledOnce();

    // The late signature changes nothing.
    release(signature);
    await tick();
    await tick();
    expect(tab.answered).not.toHaveBeenCalled();
    expect(tab.remember).not.toHaveBeenCalled();
    expect(tab.leave).toHaveBeenCalledOnce();
    expect(tab.report).toHaveBeenCalledOnce();
    expect(tab.report).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, outcome: "cancelled", cause: "page-cancelled" }),
    );

    // The tab's next document is answered as before.
    const next = sender({ documentId: "document-b" });
    expect(await tab.runtime.handle(get(), next)).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "AQID" },
    });
    expect(tab.chooser.choose).not.toHaveBeenCalled();
    expect(tab.answered).toHaveBeenCalledOnce();
    // The person's click started it, so it is no sign-in Pateat made by itself (ADR 0062 C).
    // The answer names the document it went to, not the one the tab had left.
    expect(tab.answered).toHaveBeenCalledWith(7, origin, "example.com", candidate, {
      incognito: false,
      documentId: "document-b",
    });
    expect(tab.leave).toHaveBeenCalledTimes(2);
  });

  it("saves no passkey chosen in the window when the page is left while it signs", async () => {
    const pair = [candidate, { ...candidate, credentialId: "BAUG" }];
    const backing = source({
      candidates: vi.fn(async () => ({ candidates: pair, complete: true })),
      sign: vi.fn<PasskeySource["sign"]>(() => new Promise(() => {})),
    });
    const tab = setup(backing, { kind: "chosen", index: 1, makeDefault: true });
    const operationId = crypto.randomUUID();
    const pending = tab.runtime.handle(get(operationId), sender());
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledOnce());
    expect(tab.chooser.choose).toHaveBeenCalledOnce();
    await tab.runtime.handle(cancel(operationId), sender());
    expect(await pending).toEqual({ kind: "cancelled" });
    await tick();
    await tick();
    expect(tab.remember).not.toHaveBeenCalled();
    expect(tab.answered).not.toHaveBeenCalled();
    expect(tab.leave).toHaveBeenCalledOnce();
    expect(tab.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", cause: "page-cancelled", chooser: "chosen" }),
    );
  });

  it("never signs when the page is left during the vault lookup", async () => {
    let found!: (candidates: PasskeyCandidates) => void;
    const backing = source({
      candidates: vi.fn(() => new Promise<PasskeyCandidates>((resolve) => (found = resolve))),
    });
    const tab = setup(backing);
    const operationId = crypto.randomUUID();
    const pending = tab.runtime.handle(get(operationId), sender());
    await vi.waitFor(() => expect(backing.candidates).toHaveBeenCalledOnce());
    await tab.runtime.handle(cancel(operationId), sender());
    expect(await pending).toEqual({ kind: "cancelled" });
    found({ candidates: [candidate], complete: true });
    await tick();
    expect(backing.sign).not.toHaveBeenCalled();
    expect(tab.answered).not.toHaveBeenCalled();
    expect(tab.leave).toHaveBeenCalledOnce();
    expect(tab.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", cause: "page-cancelled" }),
    );
  });
}

export function registerPageOptionCases() {
  it("copies buffer sources and keeps only supported members", () => {
    const challenge = new Uint8Array(32).fill(7);
    const id = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotGetOptions({
      mediation: "optional",
      signal: new AbortController().signal,
      publicKey: {
        challenge: challenge.buffer,
        rpId: "example.com",
        userVerification: "preferred",
        timeout: 1000,
        extensions: { prf: {} },
        allowCredentials: [
          { type: "public-key", id: new DataView(id.buffer), transports: ["internal"] },
        ],
      },
    });
    challenge.fill(0);
    expect(snapshot).toEqual({
      challenge: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      rpId: "example.com",
      userVerification: "preferred",
      mediation: "optional",
      timeout: 1000,
      allowCredentials: [{ type: "public-key", id: "AQID", transports: ["internal"] }],
    });
  });

  it.each([
    ["no options", undefined],
    ["password credentials", { password: true, publicKey: { challenge: new Uint8Array(16) } }],
    ["missing challenge", { publicKey: {} }],
    ["string challenge", { publicKey: { challenge: "AAAA" } }],
    [
      "non-array allow list",
      { publicKey: { challenge: new Uint8Array(16), allowCredentials: {} } },
    ],
    ["non-string RP ID", { publicKey: { challenge: new Uint8Array(16), rpId: 1 } }],
    ["shared buffer", { publicKey: { challenge: new Uint8Array(new SharedArrayBuffer(16)) } }],
    ["oversized challenge", { publicKey: { challenge: new Uint8Array(5000) } }],
  ])("leaves %s to the browser", (_name, options) => {
    expect(snapshotGetOptions(options)).toBeUndefined();
  });
}

export function registerPolicyCases({
  extensionId,
  origin,
  sender,
  get,
  source,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "get" | "source">) {
  it("claims without a gesture under the initial policy", async () => {
    const runtime = createPasskeyRuntime(source(), { extensionId });
    expect(await runtime.handle(get(undefined, false), sender())).toMatchObject({
      kind: "assertion",
    });
  });

  it("asks the policy for the sender origin and honors a gesture requirement", async () => {
    const policy = vi.fn(() => ({ presence: "activation", verification: "never" }) as const);
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId, policy });
    expect(await runtime.handle(get(undefined, false), sender())).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
    expect(policy).toHaveBeenCalledWith(origin);
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("reads a policy that resolves later, as the device setting does, for each request", async () => {
    let stored: PasskeyPolicy = { presence: "activation", verification: "always" };
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      policy: async () => stored,
    });
    expect(await runtime.handle(get(undefined, false), sender())).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
    // Changed on the settings page: the next request follows it.
    stored = INITIAL_PASSKEY_POLICY;
    expect(await runtime.handle(get(undefined, false), sender())).toMatchObject({
      kind: "assertion",
    });
  });
}

export function registerPolicyCancellationCases({
  extensionId,
  sender,
  get,
  source,
}: Pick<RuntimeFixtures, "extensionId" | "sender" | "get" | "source">) {
  it("is kept, so the request ends cancelled without asking the vault", async () => {
    let release!: (policy: PasskeyPolicy) => void;
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () =>
        new Promise<PasskeyPolicy>((resolve) => {
          release = resolve;
        }),
    });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(get(operationId), sender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancel = { version: 1, type: "passkey.cancel", operationId };
    // Another document's cancel never touches it.
    expect(await runtime.handle(cancel, sender({ documentId: "document-b" }))).toEqual({
      ok: false,
    });
    expect(await runtime.handle(cancel, sender())).toEqual({ ok: true });
    // A second request with the same ID while the first reads is refused as busy.
    expect(await runtime.handle(get(operationId), sender())).toEqual({
      kind: "delegate",
      reason: "busy",
    });
    release(INITIAL_PASSKEY_POLICY);
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });
}

export function registerRequiredMediationCases({
  extensionId,
  origin,
  sender,
  candidate,
  get,
  source,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "candidate" | "get" | "source">) {
  it("answers a page's required-mediation request with Pateat's assertion (ADR 0007)", async () => {
    // As Wise's "Log back in" asks: `navigator.credentials.get({ mediation: "required", ... })`.
    const snapshot = snapshotGetOptions({
      mediation: "required",
      publicKey: {
        challenge: Uint8Array.from({ length: 16 }, (_, index) => index),
        rpId: "example.com",
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: Uint8Array.of(1, 2, 3) }],
      },
    });
    expect(snapshot).toMatchObject({ mediation: "required" });
    const backing = source();
    const report = vi.fn();
    const answered = vi.fn();
    const runtime = createPasskeyRuntime(backing, { extensionId, report, answered });
    const result = await runtime.handle({ ...get(), request: snapshot }, sender());
    expect(result).toMatchObject({ kind: "assertion", assertion: { credentialId: "AQID" } });
    expect(backing.candidates).toHaveBeenCalledWith(origin, "example.com", expect.any(AbortSignal));
    expect(backing.sign).toHaveBeenCalledOnce();
    expect(answered.mock.calls).toEqual([
      [7, origin, "example.com", candidate, { incognito: false, documentId: "document-a" }],
    ]);
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(report.mock.lastCall![0]).toMatchObject({
      outcome: "assertion",
      mediation: "required",
    });
    expect(report.mock.lastCall![0]).not.toHaveProperty("reason");
  });
}
