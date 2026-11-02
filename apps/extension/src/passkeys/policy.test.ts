import { describe, expect, it } from "vitest";
import { INITIAL_PASSKEY_POLICY, parsePasskeyPolicy, readPasskeyPolicy } from "./policy";

const ceremony = { presence: "activation", verification: "never" };

describe("passkey policy setting (ADR 0007)", () => {
  it("claims presence and verification by default, as before the setting existed", async () => {
    expect(parsePasskeyPolicy(undefined)).toEqual(INITIAL_PASSKEY_POLICY);
    expect(parsePasskeyPolicy(null)).toEqual(INITIAL_PASSKEY_POLICY);
    expect(await readPasskeyPolicy(async () => undefined)).toEqual({
      presence: "always",
      verification: "always",
    });
  });

  it("keeps each stored choice", () => {
    for (const presence of ["always", "activation"] as const)
      for (const verification of ["always", "never"] as const)
        expect(parsePasskeyPolicy({ presence, verification })).toEqual({ presence, verification });
  });

  it("follows the ceremony for a damaged or unreadable record", async () => {
    for (const value of [
      { presence: "always" },
      { presence: "sometimes", verification: "always" },
      { presence: "always", verification: "always", extra: true },
      "always",
    ])
      expect(parsePasskeyPolicy(value)).toEqual(ceremony);
    expect(await readPasskeyPolicy(() => Promise.reject(new Error("storage")))).toEqual(ceremony);
  });
});
