import { describe, expect, it } from "vitest";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "./policy";
import { admitGetRequest } from "./request";
import { effectiveDomain, resolveRpId } from "./rp-id";
import { selectPasskey } from "./select";

describe("RP ID admission", () => {
  // HTML "is a registrable domain suffix of or is equal to" examples, with WebAuthn's extra
  // requirement that the effective domain is a valid domain rather than an IP address.
  it.each([
    ["https://example.com", "example.com", true],
    ["https://www.example.com", "example.com", true],
    ["https://example.com", "com", false],
    ["https://example.compute.amazonaws.com", "compute.amazonaws.com", false],
    ["https://www.example.compute.amazonaws.com", "example.compute.amazonaws.com", false],
    ["https://www.example.compute.amazonaws.com", "amazonaws.com", false],
    ["https://test.amazonaws.com", "amazonaws.com", true],
    ["https://login.example.co.uk", "example.co.uk", true],
    ["https://login.example.co.uk", "co.uk", false],
    // Private Public Suffix List entries are suffixes too.
    ["https://user.github.io", "user.github.io", true],
    ["https://app.user.github.io", "github.io", false],
    ["https://example.com", "www.example.com", false],
    ["https://badexample.com", "example.com", false],
    ["https://example.com:8443", "example.com", true],
    ["http://localhost:3000", "localhost", true],
  ])("%s with RP ID %s -> %s", (origin, rpId, expected) => {
    expect(resolveRpId(origin, rpId).ok).toBe(expected);
  });

  it("defaults to the effective domain", () => {
    expect(resolveRpId("https://login.example.com", undefined)).toEqual({
      ok: true,
      rpId: "login.example.com",
    });
  });

  it.each([
    "http://example.com",
    "http://sub.localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://example.com.",
    "https://example.com/path",
    "null",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "https://xn--nxasmq6b.example",
  ])("rejects origin %s unless canonical, secure and a domain", (origin) => {
    const host = effectiveDomain(origin);
    if (origin === "https://xn--nxasmq6b.example") expect(host).toBe("xn--nxasmq6b.example");
    else expect(host).toBeUndefined();
  });

  it.each(["Example.com", "example.com.", "例え.テスト", "example.com:443", "", " example.com", 1])(
    "delegates non-canonical RP ID %s",
    (rpId) => {
      expect(resolveRpId("https://example.com", rpId)).toEqual({
        ok: false,
        reason: "invalid-rp-id",
      });
    },
  );
});

const challenge = "AAECAwQFBgcICQoLDA0ODw";
const base = { challenge, allowCredentials: [] };
// A future per-site policy that follows the ceremony; the initial policy asserts both flags.
const ceremony: PasskeyPolicy = { presence: "activation", verification: "never" };
const admit = (
  request: unknown,
  userActivation = true,
  origin = "https://login.example.com",
  policy: PasskeyPolicy = INITIAL_PASSKEY_POLICY,
) => admitGetRequest({ origin, request, userActivation, policy });

describe("request admission", () => {
  it("claims an activated, optional, discoverable request", () => {
    expect(admit({ ...base, rpId: "example.com", mediation: "optional" })).toEqual({
      kind: "claim",
      request: {
        origin: "https://login.example.com",
        rpId: "example.com",
        challenge: Uint8Array.from({ length: 16 }, (_, index) => index),
        allowCredentialIds: [],
        userVerified: true,
      },
    });
    expect(admit({ ...base, userVerification: "preferred" }).kind).toBe("claim");
    expect(admit({ ...base, userVerification: "discouraged" }).kind).toBe("claim");
  });

  it("asserts UP and UV without a gesture under the initial policy", () => {
    expect(admit({ ...base, userVerification: "required" }, false)).toMatchObject({
      kind: "claim",
      request: { userVerified: true },
    });
  });

  it("lets a ceremony policy require a gesture and leave UV clear", () => {
    expect(admit(base, false, undefined, ceremony)).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
    expect(admit({ ...base, userVerification: "required" }, true, undefined, ceremony)).toEqual({
      kind: "delegate",
      reason: "user-verification-required",
    });
    expect(admit(base, true, undefined, ceremony)).toMatchObject({
      kind: "claim",
      request: { userVerified: false },
    });
  });

  it("keeps only public-key allow-list IDs in canonical base64url", () => {
    const result = admit({
      ...base,
      allowCredentials: [
        { type: "public-key", id: "AQID", transports: ["internal", "usb"] },
        { type: "future-type", id: "BAUG" },
      ],
    });
    expect(result).toMatchObject({ kind: "claim", request: { allowCredentialIds: ["AQID"] } });
  });

  it("claims at the WebAuthn size limits and with any internal-capable descriptor", () => {
    const encode = (length: number) => btoa("x".repeat(length)).replace(/=+$/u, "");
    expect(admit({ ...base, challenge: encode(1024) }).kind).toBe("claim");
    expect(
      admit({ ...base, allowCredentials: [{ type: "public-key", id: encode(1023) }] }).kind,
    ).toBe("claim");
    expect(
      admit({
        ...base,
        allowCredentials: [{ type: "public-key", id: "AQID", transports: ["hybrid"] }],
      }).kind,
    ).toBe("claim");
    // A descriptor without transports may name a vault credential.
    expect(
      admit({
        ...base,
        allowCredentials: [
          { type: "public-key", id: "AQID", transports: ["usb"] },
          { type: "public-key", id: "AQIE" },
        ],
      }),
    ).toMatchObject({ kind: "claim", request: { allowCredentialIds: ["AQID", "AQIE"] } });
  });

  it.each([
    ["conditional mediation", { ...base, mediation: "conditional" }, true, "unsupported-mediation"],
    ["silent mediation", { ...base, mediation: "silent" }, true, "unsupported-mediation"],
    ["required mediation", { ...base, mediation: "required" }, true, "unsupported-mediation"],
    ["foreign RP ID", { ...base, rpId: "example.net" }, true, "rp-id-mismatch"],
    ["public-suffix RP ID", { ...base, rpId: "com" }, true, "rp-id-mismatch"],
    ["short challenge", { ...base, challenge: "AAECAwQFBgcICQoLDA0O" }, true, "invalid-request"],
    ["padded challenge", { ...base, challenge: `${challenge}==` }, true, "invalid-request"],
    ["oversized challenge", { ...base, challenge: "A".repeat(1400) }, true, "invalid-request"],
    [
      "a challenge just over 1024 bytes",
      { ...base, challenge: btoa("x".repeat(1025)).replace(/=+$/u, "") },
      true,
      "invalid-request",
    ],
    [
      "non-canonical trailing bits",
      { ...base, challenge: `${challenge.slice(0, -1)}x` },
      true,
      "invalid-request",
    ],
    // The bridge drops timeout, hints and extensions; any other member is a malformed snapshot.
    ["a member outside the snapshot", { ...base, extensions: {} }, true, "invalid-request"],
    [
      "external transports only",
      {
        ...base,
        allowCredentials: [{ type: "public-key", id: "AQID", transports: ["usb", "nfc"] }],
      },
      true,
      "external-transports-only",
    ],
    [
      "only unknown descriptor types",
      { ...base, allowCredentials: [{ type: "future-type", id: "AQID" }] },
      true,
      "invalid-request",
    ],
    [
      "oversized allow list",
      {
        ...base,
        allowCredentials: Array.from({ length: 65 }, () => ({ type: "public-key", id: "AQ" })),
      },
      true,
      "invalid-request",
    ],
  ] as const)("delegates %s", (_name, request, activation, reason) => {
    expect(admit(request, activation)).toEqual({ kind: "delegate", reason });
  });

  it("delegates insecure or IP origins regardless of page data", () => {
    expect(admit(base, true, "http://login.example.com")).toEqual({
      kind: "delegate",
      reason: "invalid-origin",
    });
    expect(admit(base, true, "https://192.0.2.1")).toEqual({
      kind: "delegate",
      reason: "invalid-origin",
    });
  });
});

describe("credential selection", () => {
  const candidate = {
    credentialId: "AQID",
    rpId: "example.com",
    userHandle: "dXNlcg",
    discoverable: true,
    counter: 0,
  };
  const request = { rpId: "example.com", allowCredentialIds: [] as string[] };

  it("selects the single discoverable credential for the RP ID", () => {
    expect(selectPasskey(request, [candidate])).toEqual({
      kind: "credential",
      credential: candidate,
    });
  });

  it("matches allow lists by exact credential ID, including non-discoverable keys", () => {
    const stored = { ...candidate, discoverable: false, userHandle: null };
    expect(selectPasskey({ ...request, allowCredentialIds: ["AQID"] }, [stored]).kind).toBe(
      "credential",
    );
    expect(selectPasskey({ ...request, allowCredentialIds: ["AQIE"] }, [stored])).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
    expect(selectPasskey(request, [stored])).toEqual({ kind: "delegate", reason: "no-credential" });
  });

  it("never chooses among several matches", () => {
    expect(selectPasskey(request, [candidate, { ...candidate, credentialId: "BAUG" }])).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
  });

  it("refuses a nonzero counter and ignores other RP IDs", () => {
    expect(selectPasskey(request, [{ ...candidate, counter: 7 }])).toEqual({
      kind: "delegate",
      reason: "unsupported-counter",
    });
    expect(selectPasskey(request, [{ ...candidate, rpId: "login.example.com" }])).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
  });
});
