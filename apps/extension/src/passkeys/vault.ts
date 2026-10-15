import {
  connectionUse,
  getItemEligibility,
  isSiteExcluded,
  siteDefaultConnection,
  type SettingsResponse,
  type SettingsSnapshot,
  type VaultCatalog,
  type LocalSettings,
} from "@pateat/contracts";
import type { ConnectionRuntime } from "../connections/runtime";
import type { PasskeyMatches } from "../crypto/passkey";
import type { VaultResult } from "../vault/record";
import { fromBase64Url, toBase64Url } from "./encoding";
import { rpIdsFor } from "./rp-id";
import type { PasskeyItem, PasskeySource } from "./runtime";
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
 * With `only`, just that item's passkeys, none preferred, complete when its connection answered
 * and the item was searched (ADR 0027). Callers must not pass a per-request signal to the finder:
 * host cancellation retires the whole session.
 */
export async function findVaultPasskeys(input: {
  saved: Settings;
  origin: string;
  rpId: string;
  find: PasskeyFinder;
  only?: PasskeyItem;
}): Promise<PasskeyCandidates<VaultPasskeyCandidate> | undefined> {
  const { settings, revision } = input.saved.snapshot;
  const { catalog } = input.saved;
  const { only } = input;
  if (isSiteExcluded(settings, input.origin)) return undefined;
  const siteDefault = only
    ? undefined
    : settings.siteDefaults.find((entry) => entry.origin === input.origin);
  // A default naming a provider account resolves to its one local connection, as for logins.
  const preferredConnection = siteDefault ? siteDefaultConnection(siteDefault, catalog) : undefined;
  const preferred =
    siteDefault && preferredConnection?.ok
      ? { connectionId: preferredConnection.connectionId, itemId: siteDefault.itemId }
      : undefined;
  const candidates: VaultPasskeyCandidate[] = [];
  let complete = true;
  let defaultState: PasskeyCandidates["siteDefault"] = !siteDefault
    ? "unset"
    : preferred
      ? "not-searched"
      : "unresolved";
  // The item's own connection must answer; an unanswered one leaves the search incomplete.
  let answered = !only;
  for (const connection of catalog.connections) {
    if (only && connection.id !== only.connectionId) continue;
    const use = connectionUse(settings, catalog, connection.id);
    if (use === "disabled") continue;
    // Its synced exclusions may be meant for this account, or its account is unknown.
    if (use === "account-ambiguous" || use === "vault-unavailable") {
      complete = false;
      continue;
    }
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
    answered = true;
    if (
      result.data.unavailableItemIds.some(
        (itemId) => (!only || itemId === only.itemId) && eligible(itemId),
      )
    )
      complete = false;
    if (preferred?.connectionId === connection.id && eligible(preferred.itemId))
      defaultState = "searched";
    for (const entry of result.data.candidates) {
      if (!eligible(entry.itemId) || (only && entry.itemId !== only.itemId)) continue;
      const item = connection.items.find((candidate) => candidate.id === entry.itemId);
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
        display: {
          item: item?.label ?? "Unnamed item",
          ...(entry.userName ? { userName: entry.userName } : {}),
          account: connection.label,
        },
      });
    }
  }
  return only
    ? { candidates, complete: complete && answered }
    : { candidates, complete, siteDefault: defaultState };
}

/**
 * The passkey facts of a login's item (ADR 0027): any usable passkey (a zero counter) for an
 * RP ID the origin may use, and whether one of them is discoverable. A search that could not
 * finish counts as no passkey for its RP ID.
 */
export async function itemPasskeyFacts(
  source: Pick<PasskeySource, "candidates">,
  account: { origin: string } & PasskeyItem,
): Promise<{ passkey: boolean; discoverable: boolean }> {
  const facts = { passkey: false, discoverable: false };
  const item = { connectionId: account.connectionId, itemId: account.itemId };
  for (const rpId of rpIdsFor(account.origin)) {
    // Sequential: each query shares the bounded native host. Never aborted: the vault source
    // does not cancel host queries.
    // eslint-disable-next-line no-await-in-loop
    const found = await source.candidates(account.origin, rpId, new AbortController().signal, item);
    if (!found?.complete) continue;
    for (const candidate of found.candidates) {
      if (candidate.counter !== 0) continue;
      facts.passkey = true;
      if (candidate.discoverable && candidate.userHandle !== null) facts.discoverable = true;
    }
  }
  return facts;
}

/**
 * The items that hold a discoverable, usable passkey (a zero counter) for an RP ID the
 * origin may use, by the criterion of `itemPasskeyFacts`, from one search per RP ID across
 * every enabled connection (ADR 0034). An item a search could not reach, as in a locked
 * vault, counts as holding none. No secret value is read.
 */
export async function originPasskeyItems(
  source: Pick<PasskeySource<VaultPasskeyCandidate>, "candidates">,
  origin: string,
): Promise<PasskeyItem[]> {
  const items: PasskeyItem[] = [];
  for (const rpId of rpIdsFor(origin)) {
    // Sequential: each query shares the bounded native host. Never aborted: the vault source
    // does not cancel host queries.
    // eslint-disable-next-line no-await-in-loop
    const found = await source.candidates(origin, rpId, new AbortController().signal);
    // Passkeys found count even when another connection or item could not be searched; those
    // it could not count as holding none.
    if (!found) continue;
    for (const candidate of found.candidates) {
      if (candidate.counter !== 0 || !candidate.discoverable || candidate.userHandle === null)
        continue;
      if (
        !items.some(
          (item) =>
            item.connectionId === candidate.connectionId && item.itemId === candidate.itemId,
        )
      )
        items.push({ connectionId: candidate.connectionId, itemId: candidate.itemId });
    }
  }
  return items;
}

/** The unlocked vault of one registered connection, if it has a live handle. */
function vaultManagerFor(connections: Pick<ConnectionRuntime, "registry" | "vaultFor">) {
  return async (connectionId: string) => {
    const configuration = await connections.registry.get(connectionId);
    if (!configuration) return undefined;
    const { manager } = connections.vaultFor(configuration.profile);
    const handle = manager.status().handle;
    return handle ? { manager, handle } : undefined;
  };
}

/** Stored passkeys for one RP ID in one connection's unlocked vault; never unlocks it. */
export function createVaultPasskeyFinder(
  connections: Pick<ConnectionRuntime, "registry" | "vaultFor">,
): PasskeyFinder {
  const managerFor = vaultManagerFor(connections);
  return async (connectionId, rpId) => {
    const vault = await managerFor(connectionId);
    return vault?.manager.findPasskeys(vault.handle, rpId);
  };
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
  const managerFor = vaultManagerFor(connections);
  const find = createVaultPasskeyFinder(connections);
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
    async candidates(origin, rpId, _signal, only) {
      // Every HTTPS page can ask. Reading the catalog restores each registered vault, so an
      // excluded site, or settings with no enabled connection, stop at the metadata read.
      const metadata = await connections.settings.read().catch(() => undefined);
      if (!metadata || isSiteExcluded(metadata.settings, origin)) return undefined;
      if (!metadata.settings.accountPolicies.some((entry) => entry.enabled))
        return { candidates: [], complete: true };
      const saved = await read();
      if (!saved) return undefined;
      return findVaultPasskeys({
        saved,
        origin,
        rpId,
        find,
        ...(only ? { only } : {}),
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

/**
 * Saves a passkey chosen in the chooser window as the origin's site default (ADR 0021), replacing
 * any default the origin had. Nothing is saved once the settings, snapshot or item eligibility
 * that produced the candidate have changed, or when the default would not lead back to the
 * candidate's connection.
 */
export async function rememberVaultPasskey(input: {
  settings: {
    handle(request: { version: 1; type: "settings.get" }): Promise<SettingsResponse>;
    update(
      expectedRevision: number | undefined,
      mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
    ): Promise<SettingsSnapshot>;
  };
  origin: string;
  candidate: VaultPasskeyCandidate;
}): Promise<boolean> {
  const { origin, candidate } = input;
  const saved = await input.settings.handle({ version: 1, type: "settings.get" });
  if (!saved.ok || saved.snapshot.revision !== candidate.settingsRevision) return false;
  const { settings } = saved.snapshot;
  const connection = saved.catalog.connections.find((entry) => entry.id === candidate.connectionId);
  if (
    !connection?.userId ||
    connection.snapshotId !== candidate.snapshotId ||
    connection.quarantinedItemIds?.includes(candidate.itemId) ||
    isSiteExcluded(settings, origin) ||
    !passkeyEligible(settings, saved.catalog, candidate.connectionId, candidate.itemId)
  )
    return false;
  const item = connection.items.find((entry) => entry.id === candidate.itemId);
  const entry = {
    origin,
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
    itemId: candidate.itemId,
    ...(item ? { itemName: item.label.slice(0, 200) } : {}),
    accountName: connection.label.slice(0, 200),
  };
  // A default names the account, so it must lead back to the chosen connection.
  const mapped = siteDefaultConnection(entry, saved.catalog);
  if (!mapped.ok || mapped.connectionId !== candidate.connectionId) return false;
  const current = settings.siteDefaults.find((site) => site.origin === origin);
  if (
    current?.provider === entry.provider &&
    current.server === entry.server &&
    current.userId === entry.userId &&
    current.itemId === entry.itemId
  )
    return true;
  const others = settings.siteDefaults.filter((site) => site.origin !== origin);
  // The settings schema bounds the list; a full list keeps its entries.
  if (others.length >= 1000) return false;
  await input.settings.update(saved.snapshot.revision, (snapshot) => ({
    ...snapshot,
    settings: {
      ...snapshot.settings,
      siteDefaults: [
        ...snapshot.settings.siteDefaults.filter((site) => site.origin !== origin),
        entry,
      ],
    },
  }));
  return true;
}
