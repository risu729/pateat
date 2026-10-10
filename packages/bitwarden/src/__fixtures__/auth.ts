// Public synthetic answers from the pinned official SDK's GPL test source:
// https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-crypto/src/keys/master_key.rs
// The fixed outputs are independent of the implementation under test.
export const authPassword = "asdfasdf";
export const pbkdf2Auth = {
  salt: "test@bitwarden.com",
  kdf: { pBKDF2: { iterations: 100_000 } },
  expected: "wmyadRMyBZOH7P/a/ucTCbSghKgdzDpPqUnu/DAVtSw=",
};
export const argon2Auth = {
  salt: "test_salt",
  kdf: { argon2id: { iterations: 4, memory: 32, parallelism: 2 } },
  expected: "PR6UjYmjmppTYcdyTiNbAhPJuQQOmynKbdEl1oyi/iQ=",
};

/** Opaque synthetic tokens and encrypted metadata; no actual provider session is represented. */
export const authConnectionId = "synthetic-auth-a";
export const authDeviceId = "12345678-1234-4234-8234-123456789abc";
export function passwordTokenRequest() {
  return {
    connectionId: authConnectionId,
    email: "synthetic-user@example.test",
    masterPasswordHash: pbkdf2Auth.expected,
    device: { identifier: authDeviceId, name: "Pateat synthetic host" },
  };
}
export function tokenResponse() {
  return {
    access_token: "synthetic-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "synthetic-refresh-token",
    Key: "99.synthetic-encrypted-user-key",
    PrivateKey: "99.synthetic-encrypted-private-key",
    Kdf: 0,
    KdfIterations: 100_000,
    UserDecryptionOptions: {
      HasMasterPassword: true,
      MasterPasswordUnlock: {
        Salt: "different-vault-unlock-salt",
        Kdf: { KdfType: 1, Iterations: 6, Memory: 32, Parallelism: 4 },
      },
    },
  };
}
