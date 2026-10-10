import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { PROBE_PASSKEY } from "../../apps/extension/src/passkeys/probe";
import { withLoginExtension } from "./login-fixture";
import { startPasskeyRelyingParty as startRelyingParty } from "./passkey-server";

type Serialized =
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
async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
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
      rpId: "localhost",
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      userHandle: Buffer.from("native-user").toString("base64"),
      signCount: 0,
    },
  });
}

async function openRelyingParty(context: BrowserContext, origin: string, path = "/") {
  const page = await context.newPage();
  await addVirtualAuthenticator(context, page);
  await page.goto(`${origin}${path}`);
  expect(
    await page.evaluate(() => (window as unknown as { wrappedAtStart: boolean }).wrappedAtStart),
  ).toBe(true);
  return page;
}

type Spec = { challenge: string; rpId?: string; userVerification?: string; allow?: string[] };
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

type ProbeControl = { ok: boolean; signatures: number };
/** Probe controls are accepted only from the extension's own options page. */
async function probeControls(context: BrowserContext, extensionId: string) {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const send = (message: Record<string, unknown>) =>
    options.evaluate(async (request) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
        }
      ).chrome;
      return (await chrome.runtime.sendMessage(request)) as ProbeControl;
    }, message);
  return {
    configure: async (settings: Record<string, unknown> = {}) =>
      expect(
        await send({ version: 1, type: "passkey.probe.configure", ...settings }),
      ).toMatchObject({ ok: true }),
    signatures: async () => (await send({ version: 1, type: "passkey.probe.status" })).signatures,
  };
}

test("discoverable, allow-listed, unattended and UV-required requests get UP and UV assertions", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure();
      const page = await openRelyingParty(context, origin);
      const discoverable = challengeHex();
      expectPateatAssertion(
        await clickRequest(page, { challenge: discoverable }),
        origin,
        discoverable,
      );
      // The manual-run status agrees with the independent verifier.
      await expect(page.locator("#result")).toHaveText("Pateat, flags 0x1d, signature verified");
      const allowListed = challengeHex();
      expectPateatAssertion(
        await clickRequest(page, {
          challenge: allowListed,
          rpId: "localhost",
          userVerification: "required",
          allow: [PROBE_PASSKEY.credentialId],
        }),
        origin,
        allowListed,
      );
      // No transient activation: the page starts this request on load, because Playwright's
      // evaluate would itself grant a user gesture.
      const unattended = await openRelyingParty(context, origin, "/?unattended");
      expectPateatAssertion(
        await unattended.evaluate(
          () => (window as unknown as { pending: Promise<Serialized> }).pending,
        ),
        origin,
        "00".repeat(32),
      );
      expect(await probe.signatures()).toBe(3);
    });
  } finally {
    server.close();
  }
});

test("unclaimed requests reach the browser's own authenticator unchanged", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure({ counter: 3 });
      const page = await openRelyingParty(context, origin);
      const counted = challengeHex();
      expectNativeAssertion(await clickRequest(page, { challenge: counted }), origin, counted);
      await probe.configure({ enabled: false });
      const unconfigured = challengeHex();
      expectNativeAssertion(
        await clickRequest(page, { challenge: unconfigured }),
        origin,
        unconfigured,
      );
      await probe.configure();
      // Neither authenticator holds this credential, so the browser's own rejection surfaces.
      expect(await clickRequest(page, { challenge: challengeHex(), allow: ["00112233"] })).toEqual({
        error: "NotAllowedError",
      });
      await expect(page.locator("#result")).toHaveText("error NotAllowedError");
      expect(await probe.signatures()).toBe(0);
    });
  } finally {
    server.close();
  }
});

test("a ceremony policy delegates unattended and UV-required requests and clears UV", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure({ presence: "activation", verification: "never" });
      const unattended = await openRelyingParty(context, origin, "/?unattended");
      expectNativeAssertion(
        await unattended.evaluate(
          () => (window as unknown as { pending: Promise<Serialized> }).pending,
        ),
        origin,
        "00".repeat(32),
      );
      const page = await openRelyingParty(context, origin);
      const required = challengeHex();
      expectNativeAssertion(
        await clickRequest(page, { challenge: required, userVerification: "required" }),
        origin,
        required,
      );
      const activated = challengeHex();
      expectPateatAssertion(
        await clickRequest(page, { challenge: activated }),
        origin,
        activated,
        0x19,
      );
      expect(await probe.signatures()).toBe(1);
    });
  } finally {
    server.close();
  }
});

test("a denied permissions policy keeps the browser's rejection", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure();
      const page = await openRelyingParty(context, origin, "/denied");
      expect(await clickRequest(page, { challenge: challengeHex() })).toEqual({
        error: "NotAllowedError",
      });
      expect(await probe.signatures()).toBe(0);
    });
  } finally {
    server.close();
  }
});

test("abort rejects with the caller's reason and a slow bridge delegates", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure({ signDelayMs: 3000 });
      const page = await openRelyingParty(context, origin);
      await page.evaluate(
        (value) => {
          (window as unknown as { nextSpec: Spec }).nextSpec = value;
        },
        { challenge: challengeHex() },
      );
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await page.evaluate(() => {
        const scope = window as unknown as { controller: AbortController; abortReason: unknown };
        scope.abortReason = { synthetic: "abort" };
        scope.controller.abort(scope.abortReason);
      });
      expect(
        await page.evaluate(() => (window as unknown as { pending: Promise<Serialized> }).pending),
      ).toEqual({ error: "caller-reason" });

      await probe.configure({ signDelayMs: 3000, timeoutMs: 300 });
      const slow = challengeHex();
      expectNativeAssertion(await clickRequest(page, { challenge: slow }), origin, slow);
      // Outlast both delayed signatures: cancellation and the deadline must have stopped them.
      await page.waitForTimeout(3500);
      expect(await probe.signatures()).toBe(0);
    });
  } finally {
    server.close();
  }
});
