import type { BrowserContext } from "@playwright/test";
import type { PasskeyTestContext } from "./passkeys.spec";

export function registerPasskeyVaultTests({
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
}: Pick<
  PasskeyTestContext,
  | "test"
  | "expect"
  | "withVaultProfile"
  | "setupProbe"
  | "setupRequest"
  | "beginInput"
  | "vaultOrigin"
  | "passkeyPageHtml"
  | "settingsRequest"
  | "useOnly"
  | "openRelyingParty"
  | "challengeHex"
  | "clickRequest"
  | "vaultCredentialId"
  | "createHash"
  | "createPublicKey"
  | "createPrivateKey"
  | "fidoPrivateKey"
  | "verify"
  | "catalogAccount"
  | "expectNativeAssertion"
  | "fileURLToPath"
  | "mkdtemp"
  | "resolve"
  | "tmpdir"
  | "chromium"
  | "rm"
>) {
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
      const enabled = useOnly(initial.snapshot.settings, initial.catalog, accepted.connectionId);
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
      const item = saved.catalog.connections.find((entry) => entry.id === accepted.connectionId)!
        .items[0]!;
      settings.itemPolicies.push({
        ...catalogAccount(saved.catalog, accepted.connectionId),
        itemId: item.id,
        itemName: item.label,
        selected: false,
        excluded: true,
        excludedFields: [],
      });
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
        // Content-script posts to the page carry the page's own origin.
        window.addEventListener("message", (event) => {
          if (event.origin === location.origin) scope.pageMessages.push(event.data);
        });
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
      // The page sees that Pateat delegated, never why.
      expect(messages).toContainEqual(
        expect.objectContaining({ type: "result", result: { kind: "delegate" } }),
      );
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
