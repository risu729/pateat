import { describe, expect, it } from "vitest";
import { INITIAL_PASSKEY_POLICY, readPasskeyPolicy } from "./policy";

describe("passkey policy setting (ADR 0007)", () => {
  it("claims presence and verification by default, as before the setting existed", async () => {
    expect(await readPasskeyPolicy(async () => ({}))).toEqual(INITIAL_PASSKEY_POLICY);
    expect(INITIAL_PASSKEY_POLICY).toEqual({ presence: "always", verification: "always" });
  });

  it("keeps the synced choice", async () => {
    const passkeyPolicy = { presence: "activation", verification: "always" } as const;
    expect(await readPasskeyPolicy(async () => ({ passkeyPolicy }))).toEqual(passkeyPolicy);
  });

  it("follows the ceremony when the settings cannot be read", async () => {
    expect(await readPasskeyPolicy(() => Promise.reject(new Error("storage")))).toEqual({
      presence: "activation",
      verification: "never",
    });
  });
});
