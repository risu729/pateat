// Independent RFC 6238 Appendix B answers. The three algorithms use distinct
// ASCII secrets of 20, 32 and 64 bytes, as in the RFC reference implementation.
// https://www.rfc-editor.org/rfc/rfc6238.html#appendix-B
export const rfcTotpSecrets = {
  SHA1: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  SHA256: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA",
  SHA512:
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA",
} as const;

export const rfcTotpAnswers = [
  { seconds: 59, SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" },
  { seconds: 1_111_111_109, SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" },
  { seconds: 1_111_111_111, SHA1: "14050471", SHA256: "67062674", SHA512: "99943326" },
  { seconds: 1_234_567_890, SHA1: "89005924", SHA256: "91819424", SHA512: "93441116" },
  { seconds: 2_000_000_000, SHA1: "69279037", SHA256: "90698825", SHA512: "38618901" },
  { seconds: 20_000_000_000, SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" },
] as const;

// Public Bitwarden SDK answers at 2023-01-01T00:00:00Z; canonical Base32 only.
// https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-vault/src/totp.rs
export const bitwardenTotpTime = 1_672_531_200_000;
export const bitwardenTotpSecret = "WQIQ25BRKZYCJVYP";
export const steamTotpSecret = "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ";
