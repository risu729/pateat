import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { expect, test } from "@playwright/test";
import { fidoPrivateKey } from "../../packages/bitwarden/src/__fixtures__/crypto";
import {
  chooseExample,
  configureSso,
  confirmationProofs,
  items,
  openSsoPopup,
  origins,
  ssoStatus,
  unchangedIdpDefault,
} from "./sso-fixture";
import { withVaultProfile } from "./vault-fixture";

test("the SSO parent uses the exact provider item's real encrypted passkey and completes only on RP return", async () => {
  await withVaultProfile(async (open) => {
    const browser = await open();
    const { options, evidence, passkeyResults } = await configureSso(browser, "passkey");
    const page = await browser.context.newPage();
    await page.goto(origins.rp + "/login");
    await chooseExample(await openSsoPopup(browser, options, page));
    try {
      await expect(page.locator("#authenticated")).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      throw new Error(
        "Synthetic SSO passkey failed: " +
          JSON.stringify({ url: page.url(), evidence, status: await ssoStatus(options) }),
        { cause: error },
      );
    }
    await expect
      .poll(
        async () =>
          (await ssoStatus(options)).attempts.find((attempt) => attempt.route === "sso")?.state,
      )
      .toBe("authenticated");
    expect(evidence).toEqual({ entries: 1, posts: 1, matched: true, returns: 1, unsafeClicks: 0 });
    expect(passkeyResults).toHaveLength(1);
    const result = passkeyResults[0] as {
      id: string;
      rawId: string;
      userHandle: string;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    };
    expect(result).toMatchObject({
      id: "EjRWeBI0QjSCNBI0VniavA",
      rawId: "EjRWeBI0QjSCNBI0VniavA",
      userHandle: Buffer.from("synthetic-user-id").toString("base64url"),
    });
    const clientData = Buffer.from(result.clientDataJSON, "base64url");
    expect(JSON.parse(clientData.toString("utf8"))).toMatchObject({
      type: "webauthn.get",
      challenge: Buffer.alloc(32).toString("base64url"),
      origin: origins.idp,
      crossOrigin: false,
    });
    const authenticator = Buffer.from(result.authenticatorData, "base64url");
    expect(authenticator.subarray(0, 32)).toEqual(
      createHash("sha256").update(new URL(origins.idp).hostname).digest(),
    );
    expect(authenticator[32]).toBe(0x1d);
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.from(fidoPrivateKey, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    );
    expect(
      verify(
        "sha256",
        Buffer.concat([authenticator, createHash("sha256").update(clientData).digest()]),
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(result.signature, "base64url"),
      ),
    ).toBe(true);
    const child = (await ssoStatus(options)).attempts.find(
      (attempt) => attempt.account.origin === origins.idp,
    );
    expect(child).toMatchObject({ route: "passkey", account: { itemId: items.idp } });
    expect(
      (await confirmationProofs(browser))?.proofs?.some((proof) => proof.origin === origins.idp) ??
        false,
    ).toBe(false);
    await unchangedIdpDefault(options);
  });
});
