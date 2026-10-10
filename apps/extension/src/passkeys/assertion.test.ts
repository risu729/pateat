import { describe, expect, it } from "vitest";
import { createPasskeyAssertion } from "./assertion";
import { buildAssertionAuthenticatorData } from "./authenticator-data";
import { serializeGetClientData } from "./client-data";
import { fromBase64Url, sha256, toBase64Url } from "./encoding";
import { derToP1363, importAssertionKey, p1363ToDer, signAssertion } from "./signature";
import { es256Vector as vector, hex, toHex } from "./__fixtures__/webauthn";

const jwkBase = {
  kty: "EC",
  crv: "P-256",
  x: toBase64Url(hex(vector.publicKeyX)),
  y: toBase64Url(hex(vector.publicKeyY)),
};
const publicKey = () =>
  crypto.subtle.importKey("jwk", jwkBase, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
async function privatePkcs8() {
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwkBase, d: toBase64Url(hex(vector.credentialPrivateKey)) },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
}
async function verify(
  signature: Uint8Array,
  authenticatorData: Uint8Array,
  clientData: Uint8Array,
) {
  const raw = derToP1363(signature);
  if (!raw) return false;
  const hash = await sha256(clientData);
  const signed = new Uint8Array([...authenticatorData, ...hash]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(), raw, signed);
}

describe("WebAuthn L3 ES256 authentication vector", () => {
  const challenge = hex(vector.authentication.challenge);

  it("serializes byte-identical clientDataJSON", () => {
    expect(toHex(serializeGetClientData(challenge, vector.origin))).toBe(
      vector.authentication.clientDataJSON,
    );
  });

  it("builds byte-identical authenticator data for UP, BE and BS with counter zero", async () => {
    const data = await buildAssertionAuthenticatorData(
      vector.rpId,
      { userPresent: true, userVerified: false, backupEligible: true, backupState: true },
      0,
    );
    expect(toHex(data)).toBe(vector.authentication.authenticatorData);
  });

  it("verifies the published DER signature through the strict DER decoder", async () => {
    expect(
      await verify(
        hex(vector.authentication.signature),
        hex(vector.authentication.authenticatorData),
        hex(vector.authentication.clientDataJSON),
      ),
    ).toBe(true);
  });

  it("produces an assertion an independent verifier accepts", async () => {
    const key = await importAssertionKey(await privatePkcs8());
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(["sign"]);
    const assertion = await createPasskeyAssertion(
      {
        origin: vector.origin,
        rpId: vector.rpId,
        challenge,
        allowCredentialIds: [toBase64Url(hex(vector.credentialId))],
      },
      {
        credentialId: toBase64Url(hex(vector.credentialId)),
        rpId: vector.rpId,
        userHandle: null,
        discoverable: false,
        counter: 0,
      },
      (authenticatorData, clientDataHash) => signAssertion(key, authenticatorData, clientDataHash),
    );
    expect(toHex(fromBase64Url(assertion.clientDataJSON)!)).toBe(
      vector.authentication.clientDataJSON,
    );
    expect(toHex(fromBase64Url(assertion.authenticatorData)!)).toBe(
      vector.authentication.authenticatorData,
    );
    expect(toHex(fromBase64Url(assertion.credentialId)!)).toBe(vector.credentialId);
    expect(assertion.userHandle).toBeNull();
    expect(
      await verify(
        fromBase64Url(assertion.signature)!,
        hex(vector.authentication.authenticatorData),
        hex(vector.authentication.clientDataJSON),
      ),
    ).toBe(true);
  });

  it("refuses ineligible credentials before signing", async () => {
    let signed = false;
    const sign = async () => {
      signed = true;
      return new Uint8Array();
    };
    const request = { origin: vector.origin, rpId: vector.rpId, challenge, allowCredentialIds: [] };
    const credential = {
      credentialId: "AA",
      rpId: vector.rpId,
      userHandle: "AA",
      discoverable: true,
      counter: 0,
    };
    await expect(
      createPasskeyAssertion(request, { ...credential, counter: 1 }, sign),
    ).rejects.toThrow();
    await expect(
      createPasskeyAssertion(request, { ...credential, rpId: "other.example.org" }, sign),
    ).rejects.toThrow();
    // Without an allow list the credential must be discoverable with a user handle.
    await expect(
      createPasskeyAssertion(request, { ...credential, discoverable: false }, sign),
    ).rejects.toThrow();
    await expect(
      createPasskeyAssertion(request, { ...credential, userHandle: null }, sign),
    ).rejects.toThrow();
    await expect(
      createPasskeyAssertion({ ...request, allowCredentialIds: ["AQ"] }, credential, sign),
    ).rejects.toThrow();
    expect(signed).toBe(false);
  });
});

describe("client data escaping", () => {
  it("applies CCDToString escapes to origins", () => {
    const text = new TextDecoder().decode(
      serializeGetClientData(new Uint8Array(16), 'https://a"\\\u0001'),
    );
    expect(text).toBe(
      '{"type":"webauthn.get","challenge":"AAAAAAAAAAAAAAAAAAAAAA","origin":"https://a\\"\\\\\\u0001","crossOrigin":false}',
    );
    expect(JSON.parse(text)).toMatchObject({ origin: 'https://a"\\\u0001' });
  });
});

describe("authenticator data flags and counter", () => {
  it("encodes every flag bit and a big-endian counter", async () => {
    const data = await buildAssertionAuthenticatorData(
      "example.org",
      { userPresent: true, userVerified: true, backupEligible: true, backupState: true },
      0x01020304,
    );
    expect(toHex(data.subarray(32))).toBe("1d01020304");
    const none = await buildAssertionAuthenticatorData(
      "example.org",
      { userPresent: false, userVerified: false, backupEligible: false, backupState: false },
      0,
    );
    expect(toHex(none.subarray(32))).toBe("0000000000");
  });

  it("rejects BS without BE and out-of-range counters", async () => {
    const flags = {
      userPresent: true,
      userVerified: false,
      backupEligible: false,
      backupState: true,
    };
    await expect(buildAssertionAuthenticatorData("example.org", flags, 0)).rejects.toThrow();
    const valid = { ...flags, backupState: false };
    await Promise.all(
      [-1, 0.5, 2 ** 32].map((counter) =>
        expect(buildAssertionAuthenticatorData("example.org", valid, counter)).rejects.toThrow(),
      ),
    );
  });
});

describe("DER signature encoding", () => {
  it("round-trips leading zeros and high-bit scalars", () => {
    const raw = new Uint8Array(64);
    raw[31] = 1; // r = 1
    raw[32] = 0x80; // s has its high bit set
    raw[63] = 2;
    const der = p1363ToDer(raw);
    expect(toHex(der)).toBe(`3026020101022100${"80"}${"00".repeat(30)}02`);
    expect(derToP1363(der)).toEqual(raw);
  });

  it("round-trips random signatures and rejects malformed DER", () => {
    for (let index = 0; index < 200; index++) {
      const raw = crypto.getRandomValues(new Uint8Array(64));
      expect(derToP1363(p1363ToDer(raw))).toEqual(raw);
    }
    const valid = hex(vector.authentication.signature);
    for (const invalid of [
      valid.subarray(0, valid.length - 1),
      Uint8Array.of(...valid, 0),
      Uint8Array.of(0x31, ...valid.subarray(1)),
      hex("30060201"), // truncated sequence
      hex("300802020001020101"), // non-minimal r
      hex("3006020180020101"), // negative r
    ])
      expect(derToP1363(invalid)).toBeUndefined();
    expect(() => p1363ToDer(new Uint8Array(63))).toThrow();
  });
});
