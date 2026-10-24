import type { LocalFieldReference } from "@pateat/bitwarden";
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
  /**
   * Resolve the field as a TOTP code (the `totp` slot): the provider generates it from the
   * login TOTP or a custom field's seed, and a source answers only with a generated code.
   */
  code?: true;
};
/** Resolve one bound field for an immediate fill. Values are never cached or persisted. */
export type LoginFieldSource = (request: LoginFieldRequest) => Promise<string | undefined>;

/**
 * Live connections resolve through the connection runtime, which rechecks the saved
 * snapshot, eligibility, quarantine and field exclusions. Only text-like values fill inputs,
 * and a `code` request fills only a generated code, never a field's raw value.
 */
export function createVaultFieldSource(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor" | "resolveField">,
): LoginFieldSource {
  return async ({ account, connection, fieldId, code }) => {
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
    const ref = {
      connectionId: account.connectionId,
      userId: handle.userId,
      itemId: account.itemId,
      snapshotId: connection.snapshotId,
      fieldId,
    };
    const resolved = await (code
      ? connections.resolveField(account.connectionId, ref, { code })
      : connections.resolveField(account.connectionId, ref));
    if (!resolved.ok) return undefined;
    if (code) return resolved.data.kind === "otp" ? resolved.data.value : undefined;
    return resolved.data.kind === "text" || resolved.data.kind === "otp"
      ? resolved.data.value
      : undefined;
  };
}

/** Resolve several bound text fields at once; each answer is what `LoginFieldSource` would give. */
export type LoginFieldBatch = (
  requests: readonly Omit<LoginFieldRequest, "code">[],
) => Promise<(string | undefined)[]>;

/**
 * Text values of several live fields through one call to the connection runtime, with the
 * checks of `createVaultFieldSource` for each; never a generated code.
 */
export function createVaultFieldBatch(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor" | "resolveFields">,
): LoginFieldBatch {
  return async (requests) => {
    const handles = new Map<string, Promise<{ userId: string; snapshotId: string } | undefined>>();
    const openHandle = (connectionId: string) =>
      handles.getOrInsertComputed(connectionId, async () => {
        const configuration = await connections.registry.get(connectionId);
        return configuration
          ? connections.vaultFor(configuration.profile).manager.status().handle
          : undefined;
      });
    const refs: { index: number; connectionId: string; ref: LocalFieldReference }[] = [];
    for (const [index, { account, connection, fieldId }] of requests.entries()) {
      if (
        connection.provider !== "bitwarden" ||
        connection.id !== account.connectionId ||
        !connection.snapshotId
      )
        continue;
      // oxlint-disable-next-line no-await-in-loop -- each connection is looked up once
      const handle = await openHandle(account.connectionId);
      // The authorizing catalog must describe the snapshot that is currently open.
      if (!handle || handle.snapshotId !== connection.snapshotId) continue;
      refs.push({
        index,
        connectionId: account.connectionId,
        ref: {
          connectionId: account.connectionId,
          userId: handle.userId,
          itemId: account.itemId,
          snapshotId: connection.snapshotId,
          fieldId,
        },
      });
    }
    const values: (string | undefined)[] = requests.map(() => undefined);
    if (!refs.length) return values;
    const resolved = await connections.resolveFields(
      refs.map(({ connectionId, ref }) => ({ connectionId, ref })),
    );
    for (const [at, { index }] of refs.entries()) {
      const result = resolved[at];
      if (result?.ok && (result.data.kind === "text" || result.data.kind === "otp"))
        values[index] = result.data.value;
    }
    return values;
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
  if (connection.provider === "dummy")
    return fieldId === "password" ? "password" : fieldId === "totp" ? "otp" : undefined;
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

/** The item's login username field, which a fill of a secret but no username compares with the page. */
export function loginUsernameFieldId(
  connection: Pick<VaultConnectionMetadata, "provider" | "items">,
  itemId: string,
): string | undefined {
  if (connection.provider === "dummy") return "username";
  if (connection.provider !== "bitwarden") return undefined;
  const item = connection.items.find((entry) => entry.id === itemId);
  return item?.fields.some((field) => field.id === "login.username") ? "login.username" : undefined;
}

/** Whether filling `fieldId` writes the item's login username, directly or through a Linked field. */
export function loginFillsUsername(
  connection: Pick<VaultConnectionMetadata, "provider" | "items">,
  itemId: string,
  fieldId: string,
): boolean {
  if (connection.provider === "dummy") return fieldId === "username";
  if (connection.provider !== "bitwarden") return false;
  const field = connection.items
    .find((item) => item.id === itemId)
    ?.fields.find((entry) => entry.id === fieldId);
  return (field?.kind === "linked" ? field.linkedFieldId : fieldId) === "login.username";
}

/** Bundled synthetic values; the probe build is the only caller. */
export const dummyFieldSource: LoginFieldSource = async ({ connection, fieldId, code }) =>
  connection.provider === "dummy" ? resolveDummyField(fieldId, code ? { code } : {}) : undefined;

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
