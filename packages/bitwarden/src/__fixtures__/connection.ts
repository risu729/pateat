// Browser-safe synthetic setup/catalog fixtures. Fixed custom ciphertexts are
// independent Node AES-CBC/HMAC vectors already exercised against the real SDK.
// Variants change valid ciphertext DTOs, not decryption mocks or real accounts.
import { accountNow, rawV1Account, syntheticJwt } from "./account";
import {
  customFieldCiphertexts,
  fidoCredential,
  legacyUsername,
  reencryptedCustomFieldCiphertexts,
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
  /** As `passkey`, with Bitwarden's master password re-prompt set on the item. */
  | "reprompt-passkey"
  /** The login also stores the URI `https://synthetic.example.test/login` (default match). */
  | "uri";
export function rawCustomAccount(
  variant: CustomAccountVariant = "unchanged",
  nowSeconds = accountNow,
) {
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
      : variant === "passkey" || variant === "reprompt-passkey"
        ? { ...cipher.login, fido2Credentials: [fidoCredential] }
        : variant === "uri"
          ? {
              ...cipher.login,
              uris: [
                { uri: uriCiphertexts.uri, uriChecksum: uriCiphertexts.checksum, match: null },
              ],
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
          ...(variant === "reprompt-passkey" ? { reprompt: 1 } : {}),
          login,
          fields,
          data: JSON.stringify({
            ...data,
            fields,
            password: login.password,
            fido2Credentials: login.fido2Credentials,
            uris: login.uris,
          }),
        },
      ],
    },
  };
}
