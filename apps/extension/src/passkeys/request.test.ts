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

  it("claims a conditional request only for a caller that answers it through a login", () => {
    const conditional = { ...base, mediation: "conditional" };
    const through = (request: unknown, flag: boolean | undefined, policy?: PasskeyPolicy) =>
      admitGetRequest({
        origin: "https://login.example.com",
        request,
        userActivation: false,
        policy: policy ?? INITIAL_PASSKEY_POLICY,
        ...(flag === undefined ? {} : { conditional: flag }),
      });
    // ADR 0034: a page's own request is admitted, marked, without a gesture.
    expect(through(conditional, true)).toEqual({
      kind: "claim",
      request: {
        origin: "https://login.example.com",
        rpId: "login.example.com",
        challenge: Uint8Array.from({ length: 16 }, (_, index) => index),
        allowCredentialIds: [],
        userVerified: true,
        conditional: true,
      },
    });
    // Without the caller's flag it is handed on, as before (ADR 0007).
    for (const flag of [undefined, false])
      expect(through(conditional, flag)).toEqual({
        kind: "delegate",
        reason: "unsupported-mediation",
      });
    // The flag admits no other mediation, and marks no other request.
    for (const mediation of ["silent", "immediate", "made-up"])
      expect(through({ ...base, mediation }, true)).toEqual({
        kind: "delegate",
        reason: "unsupported-mediation",
      });
    for (const request of [
      base,
      { ...base, mediation: "optional" },
      { ...base, mediation: "required" },
    ]) {
      const admitted = through(request, true);
      expect(admitted.kind).toBe("claim");
      expect(admitted.kind === "claim" && admitted.request).not.toHaveProperty("conditional");
    }
    // The rest of admission still applies to it.
    expect(through({ ...conditional, rpId: "example.net" }, true)).toEqual({
      kind: "delegate",
      reason: "rp-id-mismatch",
    });
    expect(through(conditional, true, ceremony)).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
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
    // An unknown stored value fails closed instead of asserting more.
    const unknown = { presence: "maybe", verification: "maybe" } as unknown as PasskeyPolicy;
    expect(admit(base, false, undefined, unknown)).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
    expect(admit(base, true, undefined, unknown)).toMatchObject({
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
    ["immediate mediation", { ...base, mediation: "immediate" }, true, "unsupported-mediation"],
    ["an unknown mediation", { ...base, mediation: "made-up" }, true, "unsupported-mediation"],
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

describe("required mediation (ADR 0007)", () => {
  const through = (
    request: unknown,
    options: { policy?: PasskeyPolicy; userActivation?: boolean; conditional?: boolean } = {},
  ) =>
    admitGetRequest({
      origin: "https://login.example.com",
      request,
      userActivation: options.userActivation ?? true,
      policy: options.policy ?? INITIAL_PASSKEY_POLICY,
      ...(options.conditional === undefined ? {} : { conditional: options.conditional }),
    });

  it("claims a required request exactly as it claims an optional one", () => {
    // Wise's "Log back in" asks with `mediation: "required"`.
    const asked = {
      ...base,
      rpId: "example.com",
      timeout: 60_000,
      allowCredentials: [
        { type: "public-key", id: "AQID", transports: ["internal"] },
        { type: "public-key", id: "BAUG" },
      ],
    };
    const required = through({ ...asked, mediation: "required" });
    expect(required).toEqual({
      kind: "claim",
      request: {
        origin: "https://login.example.com",
        rpId: "example.com",
        challenge: Uint8Array.from({ length: 16 }, (_, index) => index),
        allowCredentialIds: ["AQID", "BAUG"],
        userVerified: true,
        timeoutMs: 60_000,
      },
    });
    expect(required).toEqual(through({ ...asked, mediation: "optional" }));
    expect(required).toEqual(through(asked));
    // A ceremony policy leaves UV clear for it as for an optional request.
    const ceremonyRequired = through({ ...asked, mediation: "required" }, { policy: ceremony });
    expect(ceremonyRequired).toMatchObject({ kind: "claim", request: { userVerified: false } });
    expect(ceremonyRequired).toEqual(
      through({ ...asked, mediation: "optional" }, { policy: ceremony }),
    );
    // A discoverable request without an RP ID or timeout keeps the same shape too.
    expect(through({ ...base, mediation: "required" })).toEqual(
      through({ ...base, mediation: "optional" }),
    );
    // It is never marked conditional, even for a caller that answers conditional requests.
    for (const conditional of [undefined, false, true]) {
      const admitted = through(
        { ...asked, mediation: "required" },
        conditional === undefined ? {} : { conditional },
      );
      expect(admitted).toEqual(required);
      expect(admitted.kind === "claim" && admitted.request).not.toHaveProperty("conditional");
    }
  });

  it("keeps every other admission gate for a required request", () => {
    const required = { ...base, mediation: "required" };
    expect(through({ ...required, userVerification: "required" }, { policy: ceremony })).toEqual({
      kind: "delegate",
      reason: "user-verification-required",
    });
    expect(through({ ...required, rpId: "example.net" })).toEqual({
      kind: "delegate",
      reason: "rp-id-mismatch",
    });
    expect(through(required, { policy: ceremony, userActivation: false })).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
    expect(
      through({
        ...required,
        allowCredentials: [{ type: "public-key", id: "AQID", transports: ["usb"] }],
      }),
    ).toEqual({ kind: "delegate", reason: "external-transports-only" });
    expect(through({ ...required, challenge: "AAECAwQFBgcICQoLDA0O" })).toEqual({
      kind: "delegate",
      reason: "invalid-request",
    });
    expect(
      admitGetRequest({
        origin: "http://login.example.com",
        request: required,
        userActivation: true,
        policy: INITIAL_PASSKEY_POLICY,
      }),
    ).toEqual({ kind: "delegate", reason: "invalid-origin" });
    // The same requests pass once the gate they failed is lifted.
    expect(through({ ...required, userVerification: "required" }).kind).toBe("claim");
    expect(through(required, { policy: ceremony, userActivation: true }).kind).toBe("claim");
  });

  it.each(["silent", "immediate", "made-up", "Required", ""])(
    "still delegates %j mediation with or without the conditional flag",
    (mediation) => {
      for (const conditional of [undefined, false, true])
        expect(
          through({ ...base, mediation }, conditional === undefined ? {} : { conditional }),
        ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    },
  );
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
    expect(selectPasskey(request, { candidates: [candidate], complete: true })).toEqual({
      kind: "credential",
      credential: candidate,
    });
  });

  it("matches allow lists by exact credential ID, including non-discoverable keys", () => {
    const stored = { ...candidate, discoverable: false, userHandle: null };
    expect(
      selectPasskey(
        { ...request, allowCredentialIds: ["AQID"] },
        { candidates: [stored], complete: true },
      ).kind,
    ).toBe("credential");
    expect(
      selectPasskey(
        { ...request, allowCredentialIds: ["AQIE"] },
        { candidates: [stored], complete: true },
      ),
    ).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
    expect(selectPasskey(request, { candidates: [stored], complete: true })).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
  });

  it("never chooses among several matches", () => {
    expect(
      selectPasskey(request, {
        candidates: [candidate, { ...candidate, credentialId: "BAUG" }],
        complete: true,
      }),
    ).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
  });

  it("uses the site default's item among several matches", () => {
    const other = { ...candidate, credentialId: "BAUG" };
    const preferred = { ...candidate, preferred: true };
    expect(selectPasskey(request, { candidates: [other, preferred], complete: true })).toEqual({
      kind: "credential",
      credential: preferred,
    });
    // A default the request does not accept is no tie-break.
    expect(
      selectPasskey(
        { ...request, allowCredentialIds: ["BAUG", "BwgJ"] },
        { candidates: [other, { ...other, credentialId: "BwgJ" }, preferred], complete: true },
      ),
    ).toEqual({ kind: "delegate", reason: "ambiguous-credential" });
  });

  it("uses a single match only when every eligible item was searched", () => {
    expect(selectPasskey(request, { candidates: [candidate], complete: false })).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    const preferred = { ...candidate, preferred: true };
    expect(selectPasskey(request, { candidates: [preferred], complete: false })).toEqual({
      kind: "credential",
      credential: preferred,
    });
  });

  it("refuses a nonzero counter and ignores other RP IDs", () => {
    expect(
      selectPasskey(request, { candidates: [{ ...candidate, counter: 7 }], complete: true }),
    ).toEqual({
      kind: "delegate",
      reason: "unsupported-counter",
    });
    expect(
      selectPasskey(request, {
        candidates: [{ ...candidate, rpId: "login.example.com" }],
        complete: true,
      }),
    ).toEqual({
      kind: "delegate",
      reason: "no-credential",
    });
  });
});
