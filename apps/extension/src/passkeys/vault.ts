import {
  getItemEligibility,
  isSiteExcluded,
  siteDefaultConnection,
  type SettingsResponse,
  type VaultCatalog,
  type LocalSettings,
} from "@pateat/contracts";
import type { ConnectionRuntime } from "../connections/runtime";
import type { PasskeyMatches } from "../crypto/passkey";
import type { VaultResult } from "../vault/record";
import { fromBase64Url, toBase64Url } from "./encoding";
import type { PasskeySource } from "./runtime";
import type { PasskeyCandidate, PasskeyCandidates } from "./select";

/** A stored vault passkey, bound to the snapshot and settings revision it was found in. */
export interface VaultPasskeyCandidate extends PasskeyCandidate {
  readonly connectionId: string;
  readonly userId: string;
  readonly snapshotId: string;
  readonly itemId: string;
  readonly settingsRevision: number;
}

type Settings = Extract<SettingsResponse, { ok: true }>;
export type PasskeyFinder = (
  connectionId: string,
  rpId: string,
) => Promise<VaultResult<PasskeyMatches> | undefined>;

/**
 * Passkeys an item's settings allow. An item with no fields at all, such as a passkey-only login,
 * is not refused for lacking fields; an item whose fields the owner excluded still is.
 */
function passkeyEligible(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connectionId: string,
  itemId: string,
) {
  const eligibility = getItemEligibility(settings, catalog, connectionId, itemId);
  if (eligibility.eligible) return true;
  // Reported only after the connection, item, exclusion and selection checks pass.
  if (eligibility.reason !== "fields-excluded") return false;
  const item = catalog.connections
    .find((entry) => entry.id === connectionId)
    ?.items.find((entry) => entry.id === itemId);
  return item?.fields.length === 0;
}

/**
 * ADR 0007 item selection input: every eligible stored passkey with this RP ID across enabled
 * connections, marked `preferred` when it is the origin's site default. Excluded sites get none.
 * Callers must not pass a per-request signal to the finder: host cancellation retires the whole
 * session.
 */
export async function findVaultPasskeys(input: {
  saved: Settings;
  origin: string;
  rpId: string;
  find: PasskeyFinder;
}): Promise<PasskeyCandidates<VaultPasskeyCandidate> | undefined> {
  const { settings, revision } = input.saved.snapshot;
  const { catalog } = input.saved;
  if (isSiteExcluded(settings, input.origin)) return undefined;
  const siteDefault = settings.siteDefaults.find((entry) => entry.origin === input.origin);
  // A default naming a provider account resolves to its one local connection, as for logins.
  const preferredConnection = siteDefault ? siteDefaultConnection(siteDefault, catalog) : undefined;
  const preferred =
    siteDefault && preferredConnection?.ok
      ? { connectionId: preferredConnection.connectionId, itemId: siteDefault.itemId }
      : undefined;
  const candidates: VaultPasskeyCandidate[] = [];
  let complete = true;
  for (const connection of catalog.connections) {
    const configured = settings.connections.find((entry) => entry.connectionId === connection.id);
    if (!configured?.enabled) continue;
    if (
      !connection.snapshotId ||
      (connection.state !== "ready" && connection.state !== "review-required")
    ) {
      complete = false;
      continue;
    }
    let result: VaultResult<PasskeyMatches> | undefined;
    try {
      // Sequential: each connection shares the bounded native host.
      // eslint-disable-next-line no-await-in-loop
      result = await input.find(connection.id, input.rpId);
    } catch {
      result = undefined;
    }
    // Settings and catalog describe one accepted snapshot; a different one needs reconciliation.
    if (
      !result?.ok ||
      result.data.connectionId !== connection.id ||
      (connection.userId !== undefined && result.data.userId !== connection.userId) ||
      result.data.snapshotId !== connection.snapshotId ||
      result.data.rpId !== input.rpId
    ) {
      complete = false;
      continue;
    }
    const eligible = (itemId: string) =>
      !connection.quarantinedItemIds?.includes(itemId) &&
      passkeyEligible(settings, catalog, connection.id, itemId);
    if (result.data.unavailableItemIds.some(eligible)) complete = false;
    for (const entry of result.data.candidates) {
      if (!eligible(entry.itemId)) continue;
      candidates.push({
        connectionId: connection.id,
        userId: entry.userId,
        snapshotId: entry.snapshotId,
        itemId: entry.itemId,
        settingsRevision: revision,
        credentialId: entry.credentialId,
        rpId: entry.rpId,
        userHandle: entry.userHandle,
        discoverable: entry.discoverable,
        counter: entry.counter,
        preferred: preferred?.connectionId === connection.id && preferred.itemId === entry.itemId,
      });
    }
  }
  return { candidates, complete };
}

/**
 * Vault-backed passkey source. Signing happens in the crypto Worker and only while the settings
 * revision, snapshot and item eligibility that produced the candidate still hold.
 */
export function createVaultPasskeySource(
  connections: Pick<ConnectionRuntime, "settings" | "registry" | "vaultFor">,
): PasskeySource<VaultPasskeyCandidate> {
  const read = async () => {
    const saved = await connections.settings.handle({ version: 1, type: "settings.get" });
    return saved.ok ? saved : undefined;
  };
  const managerFor = async (connectionId: string) => {
    const configuration = await connections.registry.get(connectionId);
    if (!configuration) return undefined;
    const { manager } = connections.vaultFor(configuration.profile);
    const handle = manager.status().handle;
    return handle ? { manager, handle } : undefined;
  };
  const current = (saved: Settings | undefined, candidate: VaultPasskeyCandidate) => {
    const connection = saved?.catalog.connections.find(
      (entry) => entry.id === candidate.connectionId,
    );
    return (
      saved !== undefined &&
      saved.snapshot.revision === candidate.settingsRevision &&
      connection?.snapshotId === candidate.snapshotId &&
      !connection.quarantinedItemIds?.includes(candidate.itemId) &&
      passkeyEligible(
        saved.snapshot.settings,
        saved.catalog,
        candidate.connectionId,
        candidate.itemId,
      )
    );
  };
  return {
    async candidates(origin, rpId) {
      // Every HTTPS page can ask. Reading the catalog restores each registered vault, so an
      // excluded site, or settings with no enabled connection, stop at the metadata read.
      const metadata = await connections.settings.read().catch(() => undefined);
      if (!metadata || isSiteExcluded(metadata.settings, origin)) return undefined;
      if (!metadata.settings.connections.some((entry) => entry.enabled))
        return { candidates: [], complete: true };
      const saved = await read();
      if (!saved) return undefined;
      return findVaultPasskeys({
        saved,
        origin,
        rpId,
        async find(connectionId, query) {
          const vault = await managerFor(connectionId);
          return vault?.manager.findPasskeys(vault.handle, query);
        },
      });
    },
    async sign(candidate, authenticatorData, clientDataHash) {
      if (!current(await read(), candidate)) throw new Error("passkey-stale");
      const vault = await managerFor(candidate.connectionId);
      if (!vault) throw new Error("passkey-unavailable");
      const signed = await vault.manager.signPasskey(vault.handle, {
        itemId: candidate.itemId,
        credentialId: candidate.credentialId,
        rpId: candidate.rpId,
        authenticatorData: toBase64Url(authenticatorData),
        clientDataHash: toBase64Url(clientDataHash),
      });
      if (
        !signed.ok ||
        signed.data.connectionId !== candidate.connectionId ||
        signed.data.userId !== candidate.userId ||
        signed.data.snapshotId !== candidate.snapshotId ||
        signed.data.itemId !== candidate.itemId ||
        !current(await read(), candidate)
      )
        throw new Error("passkey-unavailable");
      const signature = fromBase64Url(signed.data.signature);
      if (!signature) throw new Error("passkey-unavailable");
      return signature;
    },
  };
}
