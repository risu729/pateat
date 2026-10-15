import type { BitwardenProfile } from "@pateat/bitwarden";
import {
  customFieldReviewFor,
  customFieldReviewState,
  excludedFieldReference,
  instantBefore,
  isCustomFieldId,
  itemPolicyFor,
  parseInstant,
  type createSettingsStore,
  type LocalSettings,
  type SettingsSnapshot,
  type VaultAccount,
  type VaultCatalog,
  type VaultServer,
} from "@pateat/contracts";
import type { VaultEntry } from "../vault/record";
import type { ConnectionPolicy } from "./types";

type CatalogConnection = VaultCatalog["connections"][number];

/** The synced name of a Bitwarden connection's server (ADR 0023). */
export function profileServer(profile: BitwardenProfile): VaultServer {
  return profile.environment.kind === "cloud"
    ? `cloud-${profile.environment.region}`
    : profile.environment.baseUrl;
}

/** Prefixes evidence with the provider and its serialization, so a later format differs. */
const EVIDENCE_PREFIX = "bitwarden-v1:sha256:";

/**
 * The encrypted representation of one item's custom fields: the sealed `data` when the
 * cipher has one (it contains the custom fields), else its encrypted `fields`, with the key
 * and organization that decide how they decrypt.
 */
function cipherEvidence(
  cipher: NonNullable<VaultEntry["accepted"]>["prepared"]["ciphers"][number],
): unknown {
  let sealed = false;
  if (cipher.data) {
    try {
      sealed = Object.hasOwn(JSON.parse(cipher.data), "format_version");
    } catch {
      return undefined;
    }
  }
  return {
    ...(sealed ? { data: cipher.data } : { fields: cipher.fields ?? [] }),
    key: cipher.key ?? null,
    organizationId: cipher.organizationId ?? null,
  };
}

/**
 * JSON with every object's keys in code-unit order, so every device serializes the same
 * server ciphertext the same way whatever order it was received in.
 */
function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}

export type ItemEvidence = { evidence: string; revisionDate?: string };
const evidenceCache = new Map<string, Promise<Map<string, ItemEvidence>>>();

/**
 * Each item's custom-field evidence in an accepted snapshot (ADR 0023): the SHA-256 of its
 * encrypted custom fields, which only a vault sync changes, with the cipher's raw revision
 * date. Only this hash ever reaches the service, never names or values.
 */
export function itemEvidence(entry: VaultEntry | null): Promise<Map<string, ItemEvidence>> {
  const accepted = entry?.accepted;
  if (!accepted) return Promise.resolve(new Map());
  const cached = evidenceCache.get(accepted.snapshotId);
  if (cached) return cached;
  const computed = (async () => {
    const result = new Map<string, ItemEvidence>();
    for (const cipher of accepted.prepared.ciphers) {
      const material = cipherEvidence(cipher);
      if (material === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- small inputs, one snapshot at a time
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalJson(material)),
      );
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
      const revisionDate =
        typeof cipher.revisionDate === "string" &&
        cipher.revisionDate.length <= 64 &&
        parseInstant(cipher.revisionDate) !== undefined
          ? cipher.revisionDate
          : undefined;
      result.set(String(cipher.id), {
        evidence: `${EVIDENCE_PREFIX}${hex.join("")}`,
        ...(revisionDate === undefined ? {} : { revisionDate }),
      });
    }
    return result;
  })();
  evidenceCache.set(accepted.snapshotId, computed);
  computed.catch(() => evidenceCache.delete(accepted.snapshotId));
  // A few snapshots per connection are enough; older ones are not read again.
  if (evidenceCache.size > 16) evidenceCache.delete(evidenceCache.keys().next().value!);
  return computed;
}

/** A catalog connection's items with their evidence attached. */
export function withEvidence(
  connection: CatalogConnection,
  evidence: Map<string, ItemEvidence>,
): CatalogConnection {
  return {
    ...connection,
    items: connection.items.map((item) => {
      const found = evidence.get(item.id);
      return found ? { ...item, ...found } : item;
    }),
  };
}

const accountOf = (connection: CatalogConnection): VaultAccount | undefined =>
  connection.userId === undefined
    ? undefined
    : { provider: connection.provider, server: connection.server, userId: connection.userId };
const sameAccount = (left: VaultAccount, right: VaultAccount) =>
  left.provider === right.provider && left.server === right.server && left.userId === right.userId;

/**
 * One connection's items that custom-field review blocks (ADR 0023), and of those the ones
 * whose local copy is older than their review record. A vault sync that found an item
 * still older offers its review instead, until the next accepted snapshot.
 */
export function reviewBlockedItems(
  snapshot: SettingsSnapshot,
  connection: CatalogConnection,
): { blocked: string[]; stale: string[] } {
  const account = accountOf(connection);
  if (!account) return { blocked: [], stale: [] };
  const checked = snapshot.olderAfterSync?.find(
    (entry) => entry.connectionId === connection.id && entry.snapshotId === connection.snapshotId,
  );
  const blocked: string[] = [];
  const stale: string[] = [];
  for (const item of connection.items) {
    const state = customFieldReviewState(snapshot.settings, account, item);
    if (state === "review-required" || state === "vault-stale") blocked.push(item.id);
    if (state === "vault-stale" && !checked?.itemIds.includes(item.id)) stale.push(item.id);
  }
  return { blocked, stale };
}

/** An item policy that selects, excludes and names nothing is not listed (ADR 0023). */
export function pruneItemPolicies(settings: LocalSettings) {
  settings.itemPolicies = settings.itemPolicies.filter(
    (entry) => entry.selected || entry.excluded || entry.excludedFields.length,
  );
}

type SettingsStore = ReturnType<typeof createSettingsStore>;
/** This background-only policy protects custom denies across independent cache/settings commits. */
export function createConnectionPolicy(options: {
  settings: SettingsStore;
  current(connectionId: string): Promise<{ entry: VaultEntry; catalog: CatalogConnection }>;
  /** The provider account of a connection's accepted snapshot, without unlocking it. */
  account?(connectionId: string): Promise<VaultAccount | undefined>;
}): ConnectionPolicy {
  async function current(connectionId: string) {
    const value = await options.current(connectionId);
    return {
      entry: value.entry,
      catalog: withEvidence(value.catalog, await itemEvidence(value.entry)),
    };
  }
  return {
    async quarantined(connectionId, snapshotId) {
      try {
        const value = await current(connectionId);
        if (value.entry.accepted?.snapshotId !== snapshotId) return [];
        return reviewBlockedItems(await options.settings.read(), value.catalog).blocked;
      } catch {
        return [];
      }
    },
    async protectedItems(connectionId) {
      const account = await options.account?.(connectionId);
      if (!account) return [];
      const { settings } = await options.settings.read();
      return [
        ...new Set([
          ...settings.customFieldReviews
            .filter((entry) => sameAccount(entry, account))
            .map((entry) => entry.itemId),
          ...settings.itemPolicies
            .filter(
              (entry) =>
                sameAccount(entry, account) &&
                entry.excludedFields.some((ref) => typeof ref !== "string"),
            )
            .map((entry) => entry.itemId),
        ]),
      ];
    },
    async register(connectionId, enabled) {
      await options.settings.update(undefined, (snapshot) => {
        if (!snapshot.settings.connections.some((entry) => entry.connectionId === connectionId))
          snapshot.settings.connections.push({ connectionId, enabled });
        return snapshot;
      });
    },
    async forget(connectionId) {
      const current = await options.settings.read();
      if (!current.settings.connections.some((entry) => entry.connectionId === connectionId))
        return;
      await options.settings.update(undefined, (snapshot) => {
        snapshot.settings.connections = snapshot.settings.connections.filter(
          (entry) => entry.connectionId !== connectionId,
        );
        return snapshot;
      });
    },
    async adopt(input) {
      const captured = structuredClone(input);
      const accepted = captured.next.accepted;
      if (!accepted || captured.catalog.userId !== accepted.userId)
        throw new Error("invalid-request");
      const id = captured.next.profile.connectionId;
      const account = {
        provider: captured.catalog.provider,
        server: captured.catalog.server,
        userId: accepted.userId,
      };
      const [before, after] = await Promise.all([
        itemEvidence(captured.previous),
        itemEvidence(captured.next),
      ]);
      // Equal decrypted custom fields count as unchanged evidence: Bitwarden re-encrypts
      // the whole item on every save, so other edits change the ciphertext too.
      const sameFields = new Set(captured.sameCustomFields ?? []);
      const catalog = { ...withEvidence(captured.catalog, after), snapshotId: accepted.snapshotId };
      let review: string[] = [];
      await options.settings.update(undefined, (snapshot) => {
        const settings = snapshot.settings;
        // The add form's choice applies once the account is known; a synced policy wins.
        const pending = settings.connections.find((entry) => entry.connectionId === id);
        if (pending) {
          if (
            pending.enabled &&
            !settings.accountPolicies.some((entry) => sameAccount(entry, account))
          )
            settings.accountPolicies.push({
              ...account,
              accountName: captured.catalog.label,
              enabled: true,
              selection: { mode: "all" },
            });
          settings.connections = settings.connections.filter((entry) => entry !== pending);
        }
        const older: string[] = [];
        for (const record of settings.customFieldReviews) {
          if (!sameAccount(record, account)) continue;
          const now = after.get(record.itemId);
          if (!now || record.evidence === now.evidence) continue;
          const old = before.get(record.itemId);
          if (
            old &&
            old.evidence === record.evidence &&
            sameFields.has(record.itemId) &&
            now.revisionDate !== undefined
          ) {
            record.evidence = now.evidence;
            record.revisionDate = now.revisionDate;
          } else if (
            now.revisionDate !== undefined &&
            instantBefore(now.revisionDate, record.revisionDate)
          )
            older.push(record.itemId);
        }
        snapshot.olderAfterSync = [
          ...(snapshot.olderAfterSync ?? []).filter((entry) => entry.connectionId !== id),
          ...(older.length
            ? [{ connectionId: id, snapshotId: accepted.snapshotId, itemIds: older }]
            : []),
        ];
        if (!snapshot.olderAfterSync.length) delete snapshot.olderAfterSync;
        review = reviewBlockedItems(snapshot, catalog).blocked;
        return snapshot;
      });
      return { policyReviewItemIds: review };
    },
    async review(input) {
      const captured = structuredClone(input);
      const value = await current(captured.connectionId);
      if (value.entry.accepted?.snapshotId !== captured.snapshotId)
        throw new Error("revision-conflict");
      const catalog = { ...value.catalog, snapshotId: captured.snapshotId };
      const account = accountOf(catalog);
      const item = catalog.items.find((entry) => entry.id === captured.itemId);
      if (
        !account ||
        !item ||
        item.evidence === undefined ||
        item.revisionDate === undefined ||
        new Set(captured.excludedFieldIds).size !== captured.excludedFieldIds.length ||
        captured.excludedFieldIds.some(
          (id) =>
            !id.startsWith(`custom.${captured.snapshotId}.`) ||
            !isCustomFieldId(id) ||
            !item.fields.some((field) => field.id === id),
        )
      )
        throw new Error("invalid-request");
      const { evidence, revisionDate } = item;
      const references = captured.excludedFieldIds.map((fieldId) =>
        excludedFieldReference(item.fields, fieldId)!,
      );
      let review: string[] = [];
      await options.settings.update(captured.expectedRevision, (snapshot) => {
        const before = reviewBlockedItems(snapshot, catalog);
        // A stale copy asks for a vault sync first; reviewing it would record old fields.
        if (!before.blocked.includes(item.id) || before.stale.includes(item.id))
          throw new Error("revision-conflict");
        const settings = snapshot.settings;
        const policy = itemPolicyFor(settings, account, item.id);
        if (policy)
          policy.excludedFields = [
            ...policy.excludedFields.filter((ref) => typeof ref === "string"),
            ...references,
          ];
        else
          settings.itemPolicies.push({
            ...account,
            itemId: item.id,
            itemName: item.label,
            selected: false,
            excluded: false,
            excludedFields: references,
          });
        pruneItemPolicies(settings);
        const record = customFieldReviewFor(settings, account, item.id);
        if (record) Object.assign(record, { evidence, revisionDate });
        else
          settings.customFieldReviews.push({ ...account, itemId: item.id, evidence, revisionDate });
        review = reviewBlockedItems(snapshot, catalog).blocked;
        return snapshot;
      });
      // Recheck after the independent settings write; a concurrent newer vault never
      // makes this review authorize another snapshot.
      if (
        (await options.current(captured.connectionId)).entry.accepted?.snapshotId !==
        captured.snapshotId
      )
        throw new Error("revision-conflict");
      return { policyReviewItemIds: review };
    },
  };
}
