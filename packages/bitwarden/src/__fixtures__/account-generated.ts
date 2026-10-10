// Public synthetic compatibility fixture generated once using official SDK
// 0.2.0-main.1034 / 7de8f13a14b56068167160f88d55231f916cf16a.
// This is SDK-generated compatibility data, not an independent known-answer vector.
// Reproduction: PureCrypto.encrypt_user_key_with_master_password(base64Decode(
// V2_DECRYPTED_USER_KEY from crypto.ts), "asdfasdfasdf", v2UnlockSalt,
// {argon2id:{iterations:6,memory:32,parallelism:4}}). Encryption uses a random IV.
// The contained key ID is recorded by the official v2-fixtures.ts for that COSE key.
export const v2UnlockSalt = "synthetic-v2-unlock-salt";
export const v2MasterWrappedUserKey =
  "2.tsz6ir4JD4yVTTi0J5MoTA==|JZY6izYp3p6X/4pk/s1TKoTeYhCsm1Ip9soGSMkMva+VL+EwRNcNlG03JxDKxYq5oiCtoi5XR3sjFS/WeZVv0ydBySHYs8NadhbmPlaHFk4=|8itBDxFUoB/81IsCTLSDqkt8Ia6PuSiO/jRBQlz4FtI=";
export const v2ContainedKeyId = "b16642850e9a7bd0fe6658f98e8dfdf1";
// Public keys derived once from the recorded synthetic private/signing-key fixtures
// using PureCrypto.unwrap_decapsulation_key/rsa_extract_public_key and
// PureCrypto.verifying_key_for_signing_key. The V1/V2 RSA public keys are identical.
export const accountPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz/+1jPJ1HqcaCdKrTPms8XJcvnmd9alI42U2XF/4GMNTM5KF1gI6snhR/23ZLatZRFMHoK8ZCMSpGNkjLadArz52ldceTvBOhQUiWylkZQ4NfNa3xIYJubXOmkeDyfNuyLxVZvcZOko9PdT+Qx2QxDrFi2XNo2I7aVFd19/COIEkex4mJ0eA3MHFpKCdxYbcTAsGID8+kVR9L84S1JptZoG8x+iB/D3/Q4y02UsQYpFTu0vbPY84YmW03ngJdxWzS8X4/UJI/jaEn5rO4xlU5QcL0l4IybP5LRpE9XEeUHATKVOG7eNfpe9zDfKV2qQoofQMH9VvkWO4psaWDjBSdwIDAQAB";
export const accountVerifyingKey =
  "pgEBAlAmkP0QgfdMVbIujX55W/yNAycEgQIgBiFYIEM6JxBmjWQTruAm3s6BTaJy1q6BzQetMBacNeRJ0kxR";
