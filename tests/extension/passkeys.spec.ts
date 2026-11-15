import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { PROBE_PASSKEY } from "../../apps/extension/src/passkeys/probe";
import { sendToBackground } from "./background-message";
import type { Serialized, Spec } from "./passkey-cases/context";
import { registerPasskeyRequestCases } from "./passkey-cases/request-cases";
import { registerPasskeyChooserCases } from "./passkey-cases/chooser-cases";
import { registerPasskeyProviderCases } from "./passkey-cases/provider-cases";
import { registerPasskeyVaultCases } from "./passkey-cases/vault-cases";

const virtualCredentialId = Buffer.from("synthetic-native-credential");
const pateatCredentialId = Buffer.from(PROBE_PASSKEY.credentialId, "hex").toString("base64url");

/** CDP virtual authenticator: the browser's own path, distinguishable by credential ID. */
async function addVirtualAuthenticator(context: BrowserContext, page: Page, rpId = "localhost") {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await session.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: virtualCredentialId.toString("base64"),
      isResidentCredential: true,
      rpId,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      userHandle: Buffer.from("native-user").toString("base64"),
      signCount: 0,
    },
  });
  return { session, authenticatorId };
}

async function openRelyingParty(context: BrowserContext, origin: string, path = "/") {
  const page = await context.newPage();
  await addVirtualAuthenticator(context, page, new URL(origin).hostname);
  await page.goto(`${origin}${path}`);
  expect(
    await page.evaluate(() => (window as unknown as { wrappedAtStart: boolean }).wrappedAtStart),
  ).toBe(true);
  return page;
}

const challengeHex = () => createHash("sha256").update(crypto.randomUUID()).digest("hex");

async function clickRequest(page: Page, spec: Spec): Promise<Serialized> {
  await page.evaluate((value) => {
    (window as unknown as { nextSpec: Spec }).nextSpec = value;
  }, spec);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  return page.evaluate(() => (window as unknown as { pending: Promise<Serialized> }).pending);
}

/** UP, UV, BE and BS under the initial policy; a ceremony policy clears UV (0x19). */
function expectPateatAssertion(
  result: Serialized,
  origin: string,
  challenge: string,
  flags = 0x1d,
) {
  if ("error" in result) throw new Error(`Expected an assertion, got ${result.error}`);
  expect(result).toMatchObject({
    instance: true,
    responseInstance: true,
    id: pateatCredentialId,
    rawId: pateatCredentialId,
    type: "public-key",
    attachment: "platform",
    userHandle: PROBE_PASSKEY.userHandle,
    extensions: {},
  });
  const clientData = Buffer.from(result.clientDataJSON, "base64url");
  expect(JSON.parse(clientData.toString("utf8"))).toEqual({
    type: "webauthn.get",
    challenge: Buffer.from(challenge, "hex").toString("base64url"),
    origin,
    crossOrigin: false,
  });
  const authenticatorData = Buffer.from(result.authenticatorData, "base64url");
  expect(authenticatorData.length).toBe(37);
  expect(authenticatorData.subarray(0, 32)).toEqual(
    createHash("sha256").update("localhost").digest(),
  );
  expect(authenticatorData[32]).toBe(flags);
  expect(authenticatorData.readUInt32BE(33)).toBe(0);
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(PROBE_PASSKEY.publicKeyX, "hex").toString("base64url"),
      y: Buffer.from(PROBE_PASSKEY.publicKeyY, "hex").toString("base64url"),
    },
    format: "jwk",
  });
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest(),
  ]);
  expect(
    verify(
      "sha256",
      signed,
      { key, dsaEncoding: "der" },
      Buffer.from(result.signature, "base64url"),
    ),
  ).toBe(true);
  expect(result.json).toEqual({
    id: pateatCredentialId,
    rawId: pateatCredentialId,
    response: {
      clientDataJSON: result.clientDataJSON,
      authenticatorData: result.authenticatorData,
      signature: result.signature,
      userHandle: PROBE_PASSKEY.userHandle,
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    type: "public-key",
  });
}

/** The virtual authenticator answered the caller's own challenge for the page's origin. */
function expectNativeAssertion(result: Serialized, origin: string, challenge: string) {
  if ("error" in result) throw new Error(`Expected a native assertion, got ${result.error}`);
  expect(result.id).toBe(virtualCredentialId.toString("base64url"));
  expect(
    JSON.parse(Buffer.from(result.clientDataJSON, "base64url").toString("utf8")),
  ).toMatchObject({
    type: "webauthn.get",
    challenge: Buffer.from(challenge, "hex").toString("base64url"),
    origin,
  });
}

type ProbeControl = {
  ok: boolean;
  signatures: number;
  delayed: number;
  stopped: number;
  remembered: string[];
};
/** Probe controls are accepted only from the extension's own options page. */
async function probeControls(context: BrowserContext, extensionId: string) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const send = async (message: Record<string, unknown> & { type: string }) =>
    (await sendToBackground(options, message)) as ProbeControl;
  return {
    configure: async (settings: Record<string, unknown> = {}) =>
      expect(
        await send({ version: 1, type: "passkey.probe.configure", ...settings }),
      ).toMatchObject({ ok: true }),
    signatures: async () => (await send({ version: 1, type: "passkey.probe.status" })).signatures,
    /** Delayed signatures that started. */
    delayed: async () => (await send({ version: 1, type: "passkey.probe.status" })).delayed,
    /** Delayed signatures that cancellation or the deadline stopped; they never sign. */
    stopped: async () => (await send({ version: 1, type: "passkey.probe.status" })).stopped,
    remembered: async () => (await send({ version: 1, type: "passkey.probe.status" })).remembered,
  };
}

registerPasskeyRequestCases({
  test,
  expect,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  clickRequest,
  expectNativeAssertion,
  requestWithChooser,
});

/** Starts a request and returns the chooser window it opens; `settle` reads the page's result. */
async function requestWithChooser(context: BrowserContext, page: Page, spec: Spec) {
  await page.evaluate((value) => {
    (window as unknown as { nextSpec: Spec }).nextSpec = value;
  }, spec);
  const opened = context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("/passkey-picker.html"),
  });
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const chooser = await opened;
  await expect(chooser.getByRole("heading", { name: /^Log in to /u })).toBeVisible();
  return {
    chooser,
    settle: () =>
      page.evaluate(() => (window as unknown as { pending: Promise<Serialized> }).pending),
  };
}

/** Clicks a chooser button; the background closes the window as it receives the answer. */
async function choose(button: Locator) {
  const closed = button.page().waitForEvent("close");
  await button.click({ noWaitAfter: true }).catch((error: unknown) => {
    if (!button.page().isClosed()) throw error;
  });
  await closed;
}

const secondCredentialId = Buffer.from(`${PROBE_PASSKEY.credentialId}01`, "hex").toString(
  "base64url",
);

registerPasskeyChooserCases({
  test,
  expect,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  expectNativeAssertion,
  clickRequest,
  requestWithChooser,
  choose,
  secondCredentialId,
});

registerPasskeyProviderCases({
  test,
  expect,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  clickRequest,
  expectNativeAssertion,
  addVirtualAuthenticator,
  virtualCredentialId,
});

// The synthetic Bitwarden login stores one FIDO2 credential for this RP ID. Tests serve the
// page through request interception, so no certificate or DNS entry is involved.
const vaultOrigin = "https://synthetic.example.test";
const vaultCredentialId = "EjRWeBI0QjSCNBI0VniavA";

registerPasskeyVaultCases({
  test,
  expect,
  vaultOrigin,
  openRelyingParty,
  challengeHex,
  clickRequest,
  vaultCredentialId,
  expectNativeAssertion,
});

export type PasskeySpecHelpers = {
  probeControls: typeof probeControls;
  openRelyingParty: typeof openRelyingParty;
  challengeHex: typeof challengeHex;
  expectPateatAssertion: typeof expectPateatAssertion;
  expectNativeAssertion: typeof expectNativeAssertion;
  clickRequest: typeof clickRequest;
  requestWithChooser: typeof requestWithChooser;
  choose: typeof choose;
  secondCredentialId: typeof secondCredentialId;
  addVirtualAuthenticator: typeof addVirtualAuthenticator;
  virtualCredentialId: typeof virtualCredentialId;
  vaultOrigin: typeof vaultOrigin;
  vaultCredentialId: typeof vaultCredentialId;
};
