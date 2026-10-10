// Browser-safe synthetic setup/catalog fixtures. Fixed custom ciphertexts are
// independent Node AES-CBC/HMAC vectors already exercised against the real SDK.
// Variants change valid ciphertext DTOs, not decryption mocks or real accounts.
import { accountNow, rawV1Account, syntheticJwt } from "./account";
import { customFieldCiphertexts, legacyUsername } from "./crypto";

export type CustomAccountVariant =
  | "unchanged"
  | "reordered"
  | "changed"
  | "removed"
  | "builtin-changed";
export function rawCustomAccount(
  variant: CustomAccountVariant = "unchanged",
  nowSeconds = accountNow,
) {
  const raw = rawV1Account();
  const fields = [
    {
      name: customFieldCiphertexts.duplicateName,
      value: customFieldCiphertexts.branch,
      type: 0,
      linkedId: null,
    },
    {
      name: customFieldCiphertexts.duplicateName,
      value: customFieldCiphertexts.account,
      type: 1,
      linkedId: null,
    },
    {
      name: customFieldCiphertexts.duplicateName,
      value: customFieldCiphertexts.boolean,
      type: 2,
      linkedId: null,
    },
    { name: customFieldCiphertexts.linkedName, value: null, type: 3, linkedId: 101 },
  ];
  if (variant === "reordered") [fields[0], fields[1]] = [fields[1]!, fields[0]!];
  if (variant === "changed") fields[0]!.value = customFieldCiphertexts.account;
  if (variant === "removed") fields.splice(0, 1);
  const cipher = raw.sync.ciphers[0]!;
  const login =
    variant === "builtin-changed" ? { ...cipher.login, password: legacyUsername } : cipher.login;
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
          data: JSON.stringify({ ...data, fields, password: login.password }),
        },
      ],
    },
  };
}
