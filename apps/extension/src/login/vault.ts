import type { LoginAccount, VaultConnectionMetadata } from "@pateat/contracts";
import type { ConnectionRuntime } from "../connections/runtime";
import type { LiveUriMatcher } from "../vault/site-candidates";
import { vaultFailure } from "../vault/record";
import { resolveDummyField } from "./dummy";
import type { LoginSecretKind } from "./wire";

export type LoginFieldRequest = {
  account: LoginAccount;
  /** Catalog entry from the same settings read that authorized this operation. */
  connection: VaultConnectionMetadata;
  fieldId: string;
};
/** Resolve one bound field for an immediate fill. Values are never cached or persisted. */
export type LoginFieldSource = (request: LoginFieldRequest) => Promise<string | undefined>;

/**
 * Live connections resolve through the connection runtime, which rechecks the saved
 * snapshot, eligibility, quarantine and field exclusions. Only text-like values fill inputs.
 */
export function createVaultFieldSource(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor" | "resolveField">,
): LoginFieldSource {
  return async ({ account, connection, fieldId }) => {
    if (
      connection.provider !== "bitwarden" ||
      connection.id !== account.connectionId ||
      !connection.snapshotId
    )
      return undefined;
    const configuration = await connections.registry.get(account.connectionId);
    if (!configuration) return undefined;
    const handle = connections.vaultFor(configuration.profile).manager.status().handle;
    // The authorizing catalog must describe the snapshot that is currently open.
    if (!handle || handle.snapshotId !== connection.snapshotId) return undefined;
    const resolved = await connections.resolveField(account.connectionId, {
      connectionId: account.connectionId,
      userId: handle.userId,
      itemId: account.itemId,
      snapshotId: connection.snapshotId,
      fieldId,
    });
    if (!resolved.ok) return undefined;
    return resolved.data.kind === "text" || resolved.data.kind === "otp"
      ? resolved.data.value
      : undefined;
  };
}

/**
 * Provider URI candidates from the connection's currently open snapshot. A locked or
 * unconfigured connection answers as unavailable, never as "no match".
 */
export function createVaultUriMatcher(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor">,
): LiveUriMatcher {
  return async (connectionId, targetUrl) => {
    const configuration = await connections.registry.get(connectionId);
    if (!configuration) return vaultFailure("invalid-request");
    const { manager } = connections.vaultFor(configuration.profile);
    const handle = manager.status().handle;
    return handle ? manager.matchUris(handle, targetUrl) : vaultFailure("crypto-locked");
  };
}

/**
 * Which inputs a value may fill (`acceptsSecret`). A Bitwarden Linked custom field follows
 * the field it reads, and a Hidden custom field fills only password or short numeric
 * inputs; other values fill any writable input.
 */
export function loginSecretKind(
  connection: Pick<VaultConnectionMetadata, "provider" | "items">,
  itemId: string,
  fieldId: string,
): LoginSecretKind | undefined {
  if (connection.provider === "dummy") return fieldId === "password" ? "password" : undefined;
  if (connection.provider !== "bitwarden") return undefined;
  const field = connection.items
    .find((item) => item.id === itemId)
    ?.fields.find((entry) => entry.id === fieldId);
  const source = field?.kind === "linked" ? field.linkedFieldId : fieldId;
  if (source === "login.password") return "password";
  if (source === "login.totp-code") return "otp";
  if (field?.kind === "hidden") return "hidden";
  return undefined;
}

/** Bundled synthetic values; the probe build is the only caller. */
export const dummyFieldSource: LoginFieldSource = async ({ connection, fieldId }) =>
  connection.provider === "dummy" ? resolveDummyField(fieldId) : undefined;

/** Dispatch by catalog provider. A provider without a source never receives a fallback. */
export function combineFieldSources(
  sources: Partial<Record<string, LoginFieldSource>>,
): LoginFieldSource {
  return async (request) => {
    const source = Object.hasOwn(sources, request.connection.provider)
      ? sources[request.connection.provider]
      : undefined;
    return source ? source(request) : undefined;
  };
}
