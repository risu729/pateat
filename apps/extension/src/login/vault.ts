import type { LoginAccount, VaultConnectionMetadata } from "@pateat/contracts";
import type { ConnectionRuntime } from "../connections/runtime";
import { resolveDummyField } from "./dummy";

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
