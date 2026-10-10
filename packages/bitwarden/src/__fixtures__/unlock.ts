// Synthetic-only composition of the pinned public/account-generated fixtures.
// Browser safe: this module imports no native SDK and performs no provider I/O.
import { createBitwardenAccountMapper } from "../account";
import { parsePasswordTokenOutcome } from "../auth-models";
import {
  accountNow,
  accountProfile,
  rawOrganizationAccount,
  rawV1Account,
  rawV2Account,
} from "./account";
import { v1Email } from "./crypto";

export type VaultFixtureKind = "v1" | "v2" | "organization";
export function preparedVault(kind: VaultFixtureKind = "v1") {
  const raw =
    kind === "v2"
      ? rawV2Account()
      : kind === "organization"
        ? rawOrganizationAccount()
        : rawV1Account();
  const authenticated = parsePasswordTokenOutcome(raw.token, 200);
  const mapper = createBitwardenAccountMapper(
    accountProfile,
    { kind: "bootstrap", email: v1Email },
    { nowSeconds: () => accountNow },
  );
  if (!mapper.ok || authenticated?.kind !== "authenticated")
    throw new Error("Invalid synthetic vault fixture");
  const prepared = mapper.data.map({
    connectionId: accountProfile.connectionId,
    authenticated,
    sync: raw.sync,
  });
  if (!prepared.ok) throw new Error("Synthetic vault mapping failed");
  return prepared.data;
}
