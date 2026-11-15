import { expect, it } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createBitwardenAccountMapper } from "./account";
import { parsePasswordTokenOutcome } from "./auth-models";
import { createLocalCryptoSession } from "./local-crypto";
import { accountNow, accountProfile } from "./__fixtures__/account";
import { rawCustomAccount } from "./__fixtures__/connection";
import { syntheticSsoItemIds, syntheticSsoOrigins } from "./__fixtures__/sso-account";
import { v1Email, v1Password } from "./__fixtures__/crypto";

it.each(["sso", "sso-exact-uri", "sso-passkey", "sso-sibling-uri"] as const)(
  "%s admits and genuinely decrypts the RP, exact provider and unrelated provider default",
  async (variant) => {
    const raw = rawCustomAccount(variant);
    const authenticated = parsePasswordTokenOutcome(raw.token, 200);
    const mapper = createBitwardenAccountMapper(
      accountProfile,
      { kind: "bootstrap", email: v1Email },
      { nowSeconds: () => accountNow },
    );
    if (!authenticated || authenticated.kind !== "authenticated" || !mapper.ok)
      throw new Error("Synthetic account fixture admission failed");
    const prepared = mapper.data.map({
      connectionId: accountProfile.connectionId,
      authenticated,
      sync: raw.sync,
    });
    if (!prepared.ok) throw new Error("Synthetic SSO DTO mapping failed");
    const context = prepared.data;
    const unlocked = await createLocalCryptoSession(
      {
        connectionId: accountProfile.connectionId,
        userId: context.binding.userId,
        email: context.binding.email,
        kdf: context.kdf,
        accountCryptographicState: context.accountCryptographicState,
        organizationKeys: context.organizationKeys,
        minimumSecurityVersion: context.minimumSecurityVersion,
        unlock: {
          kind: "password",
          password: v1Password,
          masterPasswordUnlock: context.masterPasswordUnlock,
        },
      },
      sdk,
    );
    if (!unlocked.ok) throw new Error("Synthetic SSO SDK initialization failed");
    try {
      const decrypted = await Promise.all(
        context.ciphers.map(async (cipher) => {
          const result = await unlocked.data.decryptCipher({
            connectionId: accountProfile.connectionId,
            cipher,
          });
          if (!result.ok) throw new Error("Synthetic SSO ciphertext failed decryption");
          return result.data;
        }),
      );
      expect(decrypted.map((item) => item.id)).toEqual(Object.values(syntheticSsoItemIds));
      expect(decrypted[0]).toMatchObject({
        name: "Synthetic relying party",
        login: { username: "rp_user" },
        fields: [{ name: "SSO", value: "[Example] test_username", type: 0 }],
      });
      expect(decrypted[0]?.login?.password).toBeFalsy();
      expect(decrypted[1]).toMatchObject({
        name: "Example",
        login: {
          username: "test_username",
          password: "test_password",
          uris: [
            { uri: syntheticSsoOrigins.idp + "/login", match: variant === "sso-exact-uri" ? 3 : 1 },
            ...(variant === "sso-sibling-uri"
              ? [{ uri: "https://submit.idp.synthetic.example.test/session", match: 1 }]
              : []),
          ],
        },
      });
      if (variant === "sso-passkey") {
        const passkeys = await unlocked.data.decryptFido2Credentials({
          connectionId: accountProfile.connectionId,
          cipher: context.ciphers[1],
        });
        expect(passkeys).toMatchObject({
          ok: true,
          data: [
            {
              rpId: "idp.synthetic.example.test",
              credentialId: "12345678-1234-4234-8234-123456789abc",
              discoverable: "true",
            },
          ],
        });
        if (passkeys.ok) expect(passkeys.data[0]).not.toHaveProperty("keyValue");
      }
      expect(decrypted[2]).toMatchObject({
        name: "Other provider account",
        login: { username: "other_user", password: "test_password" },
      });
    } finally {
      unlocked.data.dispose();
    }
  },
);
