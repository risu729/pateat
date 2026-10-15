import { createDefaultSettings, DEFAULT_PROTECTIONS } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { INITIAL_PASSKEY_POLICY, passkeyPolicyOf } from "./policy";

describe("passkey policy from the protections setting", () => {
  it("keeps the initial policy under the default protections", () => {
    expect(passkeyPolicyOf(createDefaultSettings())).toEqual(INITIAL_PASSKEY_POLICY);
  });

  it("takes presence and verification from the setting", () => {
    expect(
      passkeyPolicyOf({
        protections: {
          ...DEFAULT_PROTECTIONS,
          passkeyPresence: "activation",
          passkeyVerification: "never",
        },
      }),
    ).toEqual({ presence: "activation", verification: "never" });
  });
});
