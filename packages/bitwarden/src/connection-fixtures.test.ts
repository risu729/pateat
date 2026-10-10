import { afterEach, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createBitwardenAccountMapper } from "./account";
import { parsePasswordTokenOutcome } from "./auth-models";
import { createLocalCryptoSession, type LocalCryptoSession } from "./local-crypto";
import { accountNow, accountProfile } from "./__fixtures__/account";
import { rawCustomAccount, type CustomAccountVariant } from "./__fixtures__/connection";
import { v1Email, v1Password } from "./__fixtures__/crypto";

const sessions: LocalCryptoSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllGlobals();
});

it.each([
  "unchanged",
  "reordered",
  "changed",
  "removed",
  "builtin-changed",
] satisfies CustomAccountVariant[])(
  "setup custom-field %s fixture remains a genuinely decryptable provider DTO",
  async (variant) => {
    const network = vi.fn(() => {
      throw new Error("Unexpected synthetic network access");
    });
    vi.stubGlobal("fetch", network);
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
    if (!prepared.ok) throw new Error(`Synthetic account mapping failed: ${prepared.error.code}`);
    const context = prepared.data;
    const session = await createLocalCryptoSession(
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
    if (!session.ok) throw new Error(`Synthetic SDK initialization failed: ${session.error.code}`);
    sessions.push(session.data);
    const decrypted = await session.data.decryptCipher({
      connectionId: accountProfile.connectionId,
      cipher: context.ciphers[0],
    });
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) throw new Error("Synthetic custom cipher decryption failed");
    const values = decrypted.data.fields?.map((field) => field.value);
    const expected =
      variant === "reordered"
        ? ["00001234", "007", "true", undefined]
        : variant === "changed"
          ? ["00001234", "00001234", "true", undefined]
          : variant === "removed"
            ? ["00001234", "true", undefined]
            : ["007", "00001234", "true", undefined];
    expect(values).toEqual(expected);
    expect(decrypted.data.login?.password).toBe(
      variant === "builtin-changed" ? "test_username" : "test_password",
    );
    expect(network).not.toHaveBeenCalled();
  },
);
