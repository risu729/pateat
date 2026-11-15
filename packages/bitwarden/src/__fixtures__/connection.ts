// Browser-safe synthetic setup/catalog fixtures. Fixed custom ciphertexts are
// independent Node AES-CBC/HMAC vectors already exercised against the real SDK.
// Variants change valid ciphertext DTOs, not decryption mocks or real accounts.
import { accountNow, rawV1Account, syntheticJwt } from "./account";
import { rawSsoAccount } from "./sso-account";
import {
  customFieldCiphertexts,
  fidoCredential,
  legacyUsername,
  reencryptedCustomFieldCiphertexts,
  totpCiphertext,
  uriCiphertexts,
} from "./crypto";

export type CustomAccountVariant =
  | "unchanged"
  | "reordered"
  | "changed"
  | "removed"
  | "builtin-changed"
  /** The password changed and every unchanged custom field was re-encrypted, as on a save. */
  | "reencrypted"
  /** The login also stores the synthetic FIDO2 credential for `synthetic.example.test`. */
  | "passkey"
  /** The login also stores the URI `https://synthetic.example.test/login` (default match). */
  | "uri"
  /** As `uri`, and the login also stores the TOTP key `bitwardenTotpSecret` (./totp). */
  | "uri-totp"
  /** A relying party and exact provider account, plus an unrelated saved default. */
  | "sso"
  /** The same provider uses exact URI matching for the login path. */
  | "sso-exact-uri"
  /** The exact provider item also holds the existing synthetic FIDO2 key. */
  | "sso-passkey"
  /** The provider owns two origins; one mapping must never grant both. */
  | "sso-sibling-uri";
export function rawCustomAccount(
  variant: CustomAccountVariant = "unchanged",
  nowSeconds = accountNow,
) {
  if (
    variant === "sso" ||
    variant === "sso-exact-uri" ||
    variant === "sso-passkey" ||
    variant === "sso-sibling-uri"
  )
    return rawSsoAccount(
      variant === "sso-exact-uri",
      nowSeconds,
      variant === "sso-passkey",
      variant === "sso-sibling-uri",
    );
  const raw = rawV1Account();
  const text =
    variant === "reencrypted" ? reencryptedCustomFieldCiphertexts : customFieldCiphertexts;
  const fields = [
    { name: text.duplicateName, value: text.branch, type: 0, linkedId: null },
    { name: text.duplicateName, value: text.account, type: 1, linkedId: null },
    { name: text.duplicateName, value: text.boolean, type: 2, linkedId: null },
    { name: text.linkedName, value: null, type: 3, linkedId: 101 },
  ];
  if (variant === "reordered") [fields[0], fields[1]] = [fields[1]!, fields[0]!];
  if (variant === "changed") fields[0]!.value = customFieldCiphertexts.account;
  if (variant === "removed") fields.splice(0, 1);
  const cipher = raw.sync.ciphers[0]!;
  const login =
    variant === "builtin-changed" || variant === "reencrypted"
      ? { ...cipher.login, password: legacyUsername }
      : variant === "passkey"
        ? { ...cipher.login, fido2Credentials: [fidoCredential] }
        : variant === "uri" || variant === "uri-totp"
          ? {
              ...cipher.login,
              uris: [
                { uri: uriCiphertexts.uri, uriChecksum: uriCiphertexts.checksum, match: null },
              ],
              ...(variant === "uri-totp" ? { totp: totpCiphertext } : {}),
            }
          : cipher.login;
  const data = JSON.parse(cipher.data) as Record<string, unknown>;
  return {
    token: {
      ...raw.token,
      access_token: syntheticJwt({
        iat: nowSeconds - 1,
        nbf: nowSeconds - 1,
        exp: nowSeconds + 3600,
      }),
    },
    sync: {
      ...raw.sync,
      ciphers: [
        {
          ...cipher,
          login,
          fields,
          data: JSON.stringify({
            ...data,
            fields,
            password: login.password,
            fido2Credentials: login.fido2Credentials,
            uris: login.uris,
            totp: login.totp,
          }),
        },
      ],
    },
  };
}
