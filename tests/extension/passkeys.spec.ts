import { chromium, test, expect, type BrowserContext, type Page } from "@playwright/test";
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
import { beginInput, settingsRequest, setupProbe, setupRequest } from "./connection-fixture";
import { withLoginExtension } from "./login-fixture";
import { passkeyPageHtml, startPasskeyRelyingParty as startRelyingParty } from "./passkey-server";
import { withVaultProfile } from "./vault-fixture";

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

type Spec = {
  challenge: string;
  rpId?: string;
  userVerification?: string;
  allow?: string[];
  mediation?: string;
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

test("Pateat answers first when another provider wraps get later or restores it", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure();
      const page = await openRelyingParty(context, origin, "/provider");
      const providerCalls = (target: Page) =>
        target.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls);
      const plain = challengeHex();
      expectPateatAssertion(await clickRequest(page, { challenge: plain }), origin, plain);
      const required = challengeHex();
      expectPateatAssertion(
        await clickRequest(page, { challenge: required, userVerification: "required" }),
        origin,
        required,
      );
      expect(await providerCalls(page)).toBe(0);

      // An unclaimed request goes to the provider, which rejects it as Bitwarden does.
      await probe.configure({ enabled: false });
      expect(await clickRequest(page, { challenge: challengeHex() })).toEqual({ error: "Error" });
      expect(await providerCalls(page)).toBe(1);

      // Restoring the provider's saved function leaves Pateat outermost.
      await probe.configure();
      await page.evaluate(() =>
        (window as unknown as { restoreProvider(): void }).restoreProvider(),
      );
      const restored = challengeHex();
      expectPateatAssertion(
        await clickRequest(page, { challenge: restored, userVerification: "required" }),
        origin,
        restored,
      );

      // A provider fallback reaches the browser's own authenticator exactly once.
      const fallback = await openRelyingParty(context, origin, "/provider?fallback");
      await probe.configure({ enabled: false });
      const delegated = challengeHex();
      expectNativeAssertion(
        await clickRequest(fallback, { challenge: delegated }),
        origin,
        delegated,
      );
      expect(await providerCalls(fallback)).toBe(1);
      expect(await probe.signatures()).toBe(3);
    });
  } finally {
    server.close();
  }
});

test("a locked provider holding an unclaimed request does not divert later requests", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure();
      const page = await openRelyingParty(context, origin, "/provider?locked");
      const claimed = challengeHex();
      expectPateatAssertion(
        await clickRequest(page, { challenge: claimed, userVerification: "required" }),
        origin,
        claimed,
      );

      // The provider holds an unclaimed request, as Bitwarden's locked-vault window does.
      await probe.configure({ enabled: false });
      await page.evaluate(
        (spec) => {
          (window as unknown as { nextSpec: Spec }).nextSpec = spec;
        },
        { challenge: challengeHex() },
      );
      await page.getByRole("button", { name: "Sign in with a passkey" }).click();
      await page.evaluate(() => {
        const scope = window as unknown as { pending: unknown; held: unknown };
        scope.held = scope.pending;
      });
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls),
        )
        .toBe(1);

      await probe.configure();
      const meanwhile = challengeHex();
      expectPateatAssertion(await clickRequest(page, { challenge: meanwhile }), origin, meanwhile);

      // Unlocking ends the held request with the provider's own rejection, never Pateat's.
      await page.evaluate(() => (window as unknown as { unlockProvider(): void }).unlockProvider());
      expect(
        await page.evaluate(() => (window as unknown as { held: Promise<Serialized> }).held),
      ).toEqual({ error: "Error" });
      expect(await probe.signatures()).toBe(2);
    });
  } finally {
    server.close();
  }
});

test("a provider's conditional request reaches the browser once and leaves sign-in to Pateat", async () => {
  const { server, origin } = await startRelyingParty();
  try {
    await withLoginExtension(async (context, _worker, extensionId) => {
      const probe = await probeControls(context, extensionId);
      await probe.configure();
      const page = await openRelyingParty(context, origin, "/provider");
      // Autofill-style requests start without a gesture and stay pending.
      await page.evaluate((challenge) => {
        const scope = window as unknown as {
          request(spec: Spec): Promise<unknown>;
          conditional: Promise<unknown>;
        };
        scope.conditional = scope.request({ challenge, mediation: "conditional" });
      }, challengeHex());
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls),
        )
        .toBe(1);
      const modal = challengeHex();
      expectPateatAssertion(await clickRequest(page, { challenge: modal }), origin, modal);
      expect(
        await page.evaluate(() => (window as unknown as { providerCalls: number }).providerCalls),
      ).toBe(1);
      expect(await probe.signatures()).toBe(1);
    });
  } finally {
    server.close();
  }
});

// The synthetic Bitwarden login stores one FIDO2 credential for this RP ID. Tests serve the
// page through request interception, so no certificate or DNS entry is involved.
const vaultOrigin = "https://synthetic.example.test";
const vaultCredentialId = "EjRWeBI0QjSCNBI0VniavA";

test("a passkey stored in the synthetic Bitwarden vault signs inside the crypto Worker", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    await setupProbe(browser.page, { action: "configure", variant: "passkey" });
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const accepted = await setupRequest(options, {
      type: "connection.begin",
      input: beginInput(),
    });
    if (!accepted.ok || accepted.kind !== "ready") throw new Error("Synthetic setup failed");
    await browser.context.route(`${vaultOrigin}/**`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: passkeyPageHtml }),
    );
    // The probe build's demo connections hold no snapshot, so they would count as unsearched
    // and block a single match. The owner turning them off leaves only the synthetic account.
    const initial = await settingsRequest(options);
    const enabled = initial.snapshot.settings;
    for (const entry of enabled.connections)
      entry.enabled = entry.connectionId === accepted.connectionId;
    await settingsRequest(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: initial.snapshot.revision,
      settings: enabled,
    });
    const page = await openRelyingParty(browser.context, vaultOrigin);
    const challenge = challengeHex();
    const result = await clickRequest(page, { challenge });
    if ("error" in result) throw new Error(`Expected an assertion, got ${result.error}`);
    expect(result).toMatchObject({
      instance: true,
      id: vaultCredentialId,
      rawId: vaultCredentialId,
      userHandle: Buffer.from("synthetic-user-id").toString("base64url"),
    });
    const clientData = Buffer.from(result.clientDataJSON, "base64url");
    expect(JSON.parse(clientData.toString("utf8"))).toEqual({
      type: "webauthn.get",
      challenge: Buffer.from(challenge, "hex").toString("base64url"),
      origin: vaultOrigin,
      crossOrigin: false,
    });
    const authenticatorData = Buffer.from(result.authenticatorData, "base64url");
    expect(authenticatorData.subarray(0, 32)).toEqual(
      createHash("sha256").update("synthetic.example.test").digest(),
    );
    expect(authenticatorData[32]).toBe(0x1d);
    expect(authenticatorData.readUInt32BE(33)).toBe(0);
    const key = createPublicKey(
      createPrivateKey({
        key: Buffer.from(fidoPrivateKey, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    );
    expect(
      verify(
        "sha256",
        Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]),
        { key, dsaEncoding: "der" },
        Buffer.from(result.signature, "base64url"),
      ),
    ).toBe(true);

    // Excluding the item in Pateat's settings leaves the request to the browser.
    const saved = await settingsRequest(options);
    const settings = saved.snapshot.settings;
    const connection = settings.connections.find(
      (entry) => entry.connectionId === accepted.connectionId,
    )!;
    const itemId = saved.catalog.connections.find((entry) => entry.id === accepted.connectionId)!
      .items[0]!.id;
    connection.excludedItemIds = [itemId];
    await settingsRequest(options, {
      version: 1,
      type: "settings.save",
      expectedRevision: saved.snapshot.revision,
      settings,
    });
    // The browser's virtual authenticator then answers with its own credential.
    const nativeChallenge = challengeHex();
    expectNativeAssertion(
      await clickRequest(page, { challenge: nativeChallenge }),
      vaultOrigin,
      nativeChallenge,
    );
  });
});

test("the production build installs the bridge on HTTPS pages and leaves unclaimed requests to the browser", async () => {
  const directory = fileURLToPath(
    new URL("../../apps/extension/.output/chrome-mv3", import.meta.url),
  );
  const profile = await mkdtemp(resolve(tmpdir(), "pateat-passkey-production-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`],
    });
    if (context.serviceWorkers().length === 0) await context.waitForEvent("serviceworker");
    await context.route(`${vaultOrigin}/**`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: passkeyPageHtml }),
    );
    await context.addInitScript(() => {
      const scope = window as unknown as { pageMessages: unknown[] };
      scope.pageMessages = [];
      window.addEventListener("message", (event) => scope.pageMessages.push(event.data));
    });
    // No vault is connected, so the background claims nothing and the browser answers.
    const page = await openRelyingParty(context, vaultOrigin);
    const challenge = challengeHex();
    expectNativeAssertion(await clickRequest(page, { challenge }), vaultOrigin, challenge);
    // No content script announces itself, or the extension ID, to the page.
    const messages = await page.evaluate(
      () => (window as unknown as { pageMessages: unknown[] }).pageMessages,
    );
    expect(JSON.stringify(messages)).not.toMatch(/content-script-started|contentScriptName/u);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
