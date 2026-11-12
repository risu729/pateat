import type { AccountTestContext } from "../../src/account.test";

export function registerAccountAdmissionCases({
  expect,
  it,
  createBitwardenAccountMapper,
  accountNow,
  accountProfile,
  rawV1Account,
  rawV2Account,
  syntheticJwt,
  v1Email,
  bootstrap,
  known,
  setAt,
  authenticated,
  mapper,
  mapRaw,
}: Pick<
  AccountTestContext,
  | "expect"
  | "it"
  | "createBitwardenAccountMapper"
  | "accountNow"
  | "accountProfile"
  | "rawV1Account"
  | "rawV2Account"
  | "syntheticJwt"
  | "v1Email"
  | "bootstrap"
  | "known"
  | "setAt"
  | "authenticated"
  | "mapper"
  | "mapRaw"
>) {
  it.each([
    ["tokenType", "MAC"],
    ["expiresIn", 0],
    ["expiresIn", "3600"],
    ["expiresIn", 1.5],
  ])("rejects malformed authenticated-token metadata %s", (name, value) => {
    const raw = rawV1Account();
    const outcome = authenticated(raw);
    setAt(outcome, ["tokens", name as string], value);
    expect(
      mapper().map({
        connectionId: accountProfile.connectionId,
        authenticated: outcome,
        sync: raw.sync,
      }).ok,
    ).toBe(false);
  });

  it.each([
    { sub: "10000000-0000-4000-8000-000000000002" },
    { sub: "not-a-uuid" },
    { email: "other@example.test" },
    { exp: accountNow },
    { exp: accountNow - 1 },
    { exp: "future" },
    { exp: 1.5 },
    { nbf: "future" },
    { nbf: 1.5 },
    { nbf: -1 },
    { iat: "past" },
    { sstamp: "other-stamp" },
    { iss: 5 },
    { aud: { secret: "synthetic-secret" } },
  ])("rejects inconsistent or malformed JWT claims %j", (claims) => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt(claims);
    expect(mapRaw(raw).ok).toBe(false);
  });

  // Bitwarden (Duende) and Vaultwarden set nbf to the server's issue second. Like the official
  // clients' TokenService, only exp decides expiry, so any clock behind the server still works.
  it.each([1, 300, 3600, 365 * 24 * 3600])(
    "accepts a token whose nbf is %i s ahead of the local clock",
    (ahead) => {
      const raw = rawV1Account();
      raw.token.access_token = syntheticJwt({ nbf: accountNow + ahead, iat: accountNow + ahead });
      expect(mapRaw(raw).ok).toBe(true);
    },
  );

  it.each([{ exp: accountNow }, { exp: accountNow - 1 }])(
    "reports a token whose exp is not in the future as expired %j",
    (claims) => {
      const raw = rawV1Account();
      raw.token.access_token = syntheticJwt(claims);
      expect(mapRaw(raw)).toEqual({ ok: false, error: { code: "authentication-expired" } });
    },
  );

  it.each(["opaque-token", "a.b.c", "e30.e30.c3ludGhldGlj", "x".repeat(200_000)])(
    "rejects malformed bounded JWT without echoing it",
    (accessToken) => {
      const raw = rawV1Account();
      raw.token.access_token = accessToken;
      const result = mapRaw(raw);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(accessToken);
    },
  );

  it("does not infer public provider identity from an opaque internal JWT issuer", () => {
    const raw = rawV1Account();
    raw.token.access_token = syntheticJwt({ iss: "http://internal-identity", aud: ["api"] });
    expect(mapRaw(raw).ok).toBe(true);
  });

  it("normalizes matching account email and security-stamp spelling", () => {
    const raw = rawV1Account();
    raw.sync.profile.email = v1Email.toUpperCase();
    raw.token.access_token = syntheticJwt({
      email: v1Email.toUpperCase(),
      sstamp: raw.sync.profile.securityStamp.toUpperCase(),
    });
    const result = mapRaw(raw, { ...bootstrap, email: v1Email.toUpperCase() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.binding.email).toBe(v1Email);
  });

  it.each([NaN, Infinity, -1, accountNow + 0.5])(
    "rejects an invalid trusted clock value %s",
    (now) => {
      const raw = rawV1Account();
      const created = createBitwardenAccountMapper(accountProfile, bootstrap, {
        nowSeconds: () => now,
      });
      expect(created.ok).toBe(true);
      if (created.ok)
        expect(
          created.data.map({
            connectionId: accountProfile.connectionId,
            authenticated: authenticated(raw),
            sync: raw.sync,
          }),
        ).toEqual({ ok: false, error: { code: "invalid-options" } });
    },
  );

  it("rejects a different request connection", () => {
    const raw = rawV1Account();
    expect(
      mapper().map({
        connectionId: "other-connection",
        authenticated: authenticated(raw),
        sync: raw.sync,
      }).ok,
    ).toBe(false);
  });

  it.each([
    { ...known, userId: "10000000-0000-4000-8000-000000000002" },
    { ...known, email: "other@example.test" },
  ])("rejects an account outside the known binding %j", (binding) => {
    expect(mapRaw(rawV2Account(), binding).ok).toBe(false);
  });

  it.each([
    { ...accountProfile, connectionId: "other-connection" },
    { ...accountProfile, environment: { kind: "cloud", region: "eu" } },
    {
      ...accountProfile,
      environment: { kind: "self-hosted", baseUrl: "https://vault.example.test" },
    },
  ])("rejects reusing a prior binding on another provider %j", (profile) => {
    expect(createBitwardenAccountMapper(profile, known, { nowSeconds: () => accountNow }).ok).toBe(
      false,
    );
  });

  it("rejects a known V2 account returning V1 even with security floor1", () => {
    expect(mapRaw(rawV1Account(), { ...known, minimumSecurityVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: "security-downgrade" },
    });
  });
}
