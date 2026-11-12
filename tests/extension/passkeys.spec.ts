import {
  chromium,
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { PROBE_PASSKEY } from "../../apps/extension/src/passkeys/probe";
import { fidoPrivateKey } from "../../packages/bitwarden/src/__fixtures__/crypto";
import { sendToBackground } from "./background-message";
import {
  beginInput,
  catalogAccount,
  settingsRequest,
  setupProbe,
  setupRequest,
  useOnly,
} from "./connection-fixture";
import { withLoginExtension } from "./login-fixture";
import { passkeyPageHtml, startPasskeyRelyingParty as startRelyingParty } from "./passkey-server";
import { withVaultProfile } from "./vault-fixture";

import { registerPasskeyRequestTests } from "./passkey-requests-tests";
import { registerPasskeyChooserTests } from "./passkey-chooser-tests";
import { registerPasskeyProviderTests } from "./passkey-providers-tests";
import { registerPasskeyVaultTests } from "./passkey-vault-tests";

export type Serialized =
  | { error: string }
  | {
      instance: boolean;
      responseInstance: boolean;
      id: string;
      rawId: string;
      type: string;
      attachment: string | null;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle: string | null;
      extensions: unknown;
      json: unknown;
    };

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

export type Spec = {
  challenge: string;
  rpId?: string;
  userVerification?: string;
  allow?: string[];
  mediation?: string;
  uiMode?: string;
  timeout?: number;
};
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

registerPasskeyRequestTests({
  test,
  expect,
  startRelyingParty,
  withLoginExtension,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  clickRequest,
  PROBE_PASSKEY,
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

registerPasskeyChooserTests({
  test,
  expect,
  startRelyingParty,
  withLoginExtension,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  expectNativeAssertion,
  clickRequest,
  PROBE_PASSKEY,
  requestWithChooser,
  choose,
  secondCredentialId,
  settingsRequest,
});

registerPasskeyProviderTests({
  test,
  expect,
  startRelyingParty,
  withLoginExtension,
  probeControls,
  openRelyingParty,
  challengeHex,
  expectPateatAssertion,
  clickRequest,
  PROBE_PASSKEY,
  expectNativeAssertion,
  addVirtualAuthenticator,
  virtualCredentialId,
});

// The synthetic Bitwarden login stores one FIDO2 credential for this RP ID. Tests serve the
// page through request interception, so no certificate or DNS entry is involved.
const vaultOrigin = "https://synthetic.example.test";
const vaultCredentialId = "EjRWeBI0QjSCNBI0VniavA";

registerPasskeyVaultTests({
  test,
  expect,
  withVaultProfile,
  setupProbe,
  setupRequest,
  beginInput,
  vaultOrigin,
  passkeyPageHtml,
  settingsRequest,
  useOnly,
  openRelyingParty,
  challengeHex,
  clickRequest,
  vaultCredentialId,
  createHash,
  createPublicKey,
  createPrivateKey,
  fidoPrivateKey,
  verify,
  catalogAccount,
  expectNativeAssertion,
  fileURLToPath,
  mkdtemp,
  resolve,
  tmpdir,
  chromium,
  rm,
});

export type PasskeyTestContext = {
  test: typeof test;
  expect: typeof expect;
  startRelyingParty: typeof startRelyingParty;
  withLoginExtension: typeof withLoginExtension;
  probeControls: typeof probeControls;
  openRelyingParty: typeof openRelyingParty;
  challengeHex: typeof challengeHex;
  expectPateatAssertion: typeof expectPateatAssertion;
  clickRequest: typeof clickRequest;
  PROBE_PASSKEY: typeof PROBE_PASSKEY;
  expectNativeAssertion: typeof expectNativeAssertion;
  requestWithChooser: typeof requestWithChooser;
  choose: typeof choose;
  secondCredentialId: typeof secondCredentialId;
  settingsRequest: typeof settingsRequest;
  addVirtualAuthenticator: typeof addVirtualAuthenticator;
  virtualCredentialId: typeof virtualCredentialId;
  withVaultProfile: typeof withVaultProfile;
  setupProbe: typeof setupProbe;
  setupRequest: typeof setupRequest;
  beginInput: typeof beginInput;
  vaultOrigin: typeof vaultOrigin;
  passkeyPageHtml: typeof passkeyPageHtml;
  useOnly: typeof useOnly;
  vaultCredentialId: typeof vaultCredentialId;
  createHash: typeof createHash;
  createPublicKey: typeof createPublicKey;
  createPrivateKey: typeof createPrivateKey;
  fidoPrivateKey: typeof fidoPrivateKey;
  verify: typeof verify;
  catalogAccount: typeof catalogAccount;
  fileURLToPath: typeof fileURLToPath;
  mkdtemp: typeof mkdtemp;
  resolve: typeof resolve;
  tmpdir: typeof tmpdir;
  chromium: typeof chromium;
  rm: typeof rm;
};
