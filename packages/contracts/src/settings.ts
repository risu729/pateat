import * as v from "valibot";

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const identifiers = v.pipe(
  v.array(identifier),
  v.maxLength(1000),
  v.check((ids) => new Set(ids).size === ids.length, "Duplicate identifiers"),
);
const revision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);

/** Only explicit HTTP(S) URLs are policy inputs; no credentials or ambiguous separators. */
export function parseSiteUrl(value: string): URL | undefined {
  if (/\s|\\/.test(value) || !/^https?:\/\/[^/]/i.test(value)) return undefined;
  if (value.split("//")[1]?.split(/[/?#]/)[0]?.includes("@")) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function normalizeHostname(value: string): string | undefined {
  // URL parsing supplies canonical bracketed IPv6 hostnames.
  if (/^\[[0-9a-f:.]+\]$/i.test(value)) return parseSiteUrl(`https://${value}`)?.hostname;
  if (!value || /[\s\\/:@?#%*]/.test(value)) return undefined;
  const url = parseSiteUrl(`https://${value}`);
  const hostname = url?.hostname.replace(/\.$/, "");
  if (
    !hostname ||
    hostname.length > 253 ||
    !hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    return undefined;
  return hostname;
}

const hostnameSchema = v.pipe(
  v.string(),
  v.check(
    (value) => normalizeHostname(value) === value,
    "Use a canonical hostname without a scheme, port or path",
  ),
);
const originSchema = v.pipe(
  v.string(),
  v.check((value) => {
    const url = parseSiteUrl(value);
    return url?.origin === value && normalizeHostname(url.hostname) !== undefined;
  }, "Use an exact HTTP(S) origin"),
);

/** Recipe IDs share the login identifier alphabet. */
const recipeIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
const vaultNameSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
/**
 * A vault field named the same way on every device (ADR 0013). Custom fields are named;
 * when several share a name, `position` (1-based) and `count` pin one of them.
 */
export const vaultFieldReferenceSchema = v.union([
  v.picklist(["username", "password", "totp"]),
  v.pipe(
    v.strictObject({
      custom: vaultNameSchema,
      position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
      count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(1000))),
    }),
    v.check(
      (ref) =>
        (ref.position === undefined) === (ref.count === undefined) &&
        (ref.position === undefined || ref.position <= ref.count!),
      "A duplicate-name reference needs a position within its count",
    ),
  ),
]);
/** Which vault field fills each recipe slot for one item. References only, never values. */
export const savedLoginBindingSchema = v.strictObject({
  recipeId: recipeIdSchema,
  origin: originSchema,
  provider: identifier,
  userId: identifier,
  itemId: identifier,
  itemName: vaultNameSchema,
  slots: v.pipe(
    v.array(v.strictObject({ slot: recipeIdSchema, field: vaultFieldReferenceSchema })),
    v.minLength(1),
    v.maxLength(20),
    v.check(
      (entries) => new Set(entries.map((entry) => entry.slot)).size === entries.length,
      "Duplicate binding slots",
    ),
  ),
});

export const connectionSettingsSchema = v.strictObject({
  connectionId: identifier,
  enabled: v.boolean(),
  selection: v.strictObject({
    mode: v.picklist(["all", "selected"]),
    groupIds: identifiers,
    itemIds: identifiers,
  }),
  excludedItemIds: identifiers,
  excludedFields: v.pipe(
    v.array(v.strictObject({ itemId: identifier, fieldId: identifier })),
    v.maxLength(1000),
    v.check(
      (refs) =>
        new Set(refs.map((ref) => JSON.stringify([ref.itemId, ref.fieldId]))).size === refs.length,
      "Duplicate field references",
    ),
  ),
});

export const localSettingsSchema = v.pipe(
  v.strictObject({
    connections: v.pipe(
      v.array(connectionSettingsSchema),
      v.maxLength(100),
      v.check(
        (connections) =>
          new Set(connections.map((entry) => entry.connectionId)).size === connections.length,
        "Duplicate connections",
      ),
    ),
    excludedSites: v.pipe(
      v.array(v.strictObject({ hostname: hostnameSchema, includeSubdomains: v.boolean() })),
      v.maxLength(1000),
      v.check(
        (sites) => new Set(sites.map((site) => site.hostname)).size === sites.length,
        "Duplicate sites",
      ),
    ),
    siteDefaults: v.pipe(
      v.array(
        v.strictObject({ origin: originSchema, connectionId: identifier, itemId: identifier }),
      ),
      v.maxLength(1000),
      v.check(
        (sites) => new Set(sites.map((site) => site.origin)).size === sites.length,
        "Duplicate origins",
      ),
    ),
    /** Synced account bindings (ADR 0013); absent in settings saved before they existed. */
    bindings: v.optional(
      v.pipe(
        v.array(savedLoginBindingSchema),
        v.maxLength(1000),
        v.check(
          (bindings) =>
            new Set(
              bindings.map((entry) =>
                JSON.stringify([
                  entry.recipeId,
                  entry.origin,
                  entry.provider,
                  entry.userId,
                  entry.itemId,
                ]),
              ),
            ).size === bindings.length,
          "Duplicate account bindings",
        ),
      ),
    ),
  }),
);

export const settingsSnapshotSchema = v.strictObject({
  version: v.literal(1),
  revision,
  settings: localSettingsSchema,
  fieldPolicies: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          connectionId: identifier,
          snapshotId: v.pipe(v.string(), v.uuid()),
          quarantinedItemIds: identifiers,
          protectedItemIds: v.optional(identifiers),
        }),
      ),
      v.maxLength(100),
      v.check(
        (entries) => new Set(entries.map((entry) => entry.connectionId)).size === entries.length,
      ),
    ),
  ),
});
export const settingsRequestSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("settings.get") }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("settings.save"),
    expectedRevision: revision,
    settings: localSettingsSchema,
  }),
]);

export const vaultCatalogSchema = v.strictObject({
  connections: v.array(
    v.strictObject({
      id: identifier,
      label: identifier,
      provider: identifier,
      snapshotId: v.optional(v.pipe(v.string(), v.uuid())),
      quarantinedItemIds: v.optional(identifiers),
      state: v.optional(v.picklist(["ready", "locked", "unavailable", "review-required"])),
      groups: v.array(
        v.strictObject({
          id: identifier,
          label: identifier,
          kind: v.picklist(["folder", "collection"]),
        }),
      ),
      items: v.array(
        v.strictObject({
          id: identifier,
          label: identifier,
          allowedOrigins: v.array(originSchema),
          groupIds: identifiers,
          fields: v.array(v.strictObject({ id: identifier, label: identifier })),
        }),
      ),
    }),
  ),
});

export const settingsErrorSchema = v.strictObject({
  code: v.picklist([
    "invalid-request",
    "invalid-settings",
    "storage-corrupt",
    "storage-unavailable",
    "revision-conflict",
  ]),
  message: v.string(),
});
export const settingsResponseSchema = v.variant("ok", [
  v.strictObject({
    version: v.literal(1),
    ok: v.literal(true),
    snapshot: settingsSnapshotSchema,
    catalog: vaultCatalogSchema,
  }),
  v.strictObject({ version: v.literal(1), ok: v.literal(false), error: settingsErrorSchema }),
]);

export type LocalSettings = v.InferOutput<typeof localSettingsSchema>;
export type ConnectionSettings = v.InferOutput<typeof connectionSettingsSchema>;
export type SettingsSnapshot = v.InferOutput<typeof settingsSnapshotSchema>;
export type SettingsRequest = v.InferOutput<typeof settingsRequestSchema>;
export type SettingsResponse = v.InferOutput<typeof settingsResponseSchema>;
export type SettingsError = v.InferOutput<typeof settingsErrorSchema>;
export type VaultCatalog = v.InferOutput<typeof vaultCatalogSchema>;
export type VaultFieldReference = v.InferOutput<typeof vaultFieldReferenceSchema>;
export type SavedLoginBinding = v.InferOutput<typeof savedLoginBindingSchema>;
export type VaultConnectionMetadata = VaultCatalog["connections"][number];
export type VaultItemMetadata = VaultConnectionMetadata["items"][number];

export function parseSettingsResponse(value: unknown): SettingsResponse {
  return v.parse(settingsResponseSchema, value);
}
export function parseLocalSettings(value: unknown): LocalSettings {
  return v.parse(localSettingsSchema, value);
}

/** Synthetic display metadata only. No field values, credentials or provider sessions. */
export const DUMMY_VAULT_CATALOG: VaultCatalog = {
  connections: [
    {
      id: "demo-personal",
      label: "Demo personal vault",
      provider: "dummy",
      groups: [{ id: "everyday", label: "Everyday", kind: "folder" }],
      items: [
        {
          id: "primary",
          label: "Demo primary account",
          allowedOrigins: ["https://bank.example"],
          groupIds: ["everyday"],
          fields: [
            { id: "username", label: "Username" },
            { id: "password", label: "Password" },
            { id: "branch", label: "Branch number" },
          ],
        },
        {
          id: "secondary",
          label: "Demo secondary account",
          allowedOrigins: ["https://bank.example", "https://mail.example"],
          groupIds: [],
          fields: [
            { id: "username", label: "Username" },
            { id: "password", label: "Password" },
          ],
        },
      ],
    },
    {
      id: "demo-work",
      label: "Demo work vault",
      provider: "dummy",
      groups: [{ id: "team", label: "Team", kind: "collection" }],
      items: [
        {
          id: "primary",
          label: "Demo team account",
          allowedOrigins: ["https://bank.example"],
          groupIds: ["team"],
          fields: [
            { id: "username", label: "Username" },
            { id: "password", label: "Password" },
          ],
        },
      ],
    },
  ],
};

export function createDefaultSettings(catalog: VaultCatalog = DUMMY_VAULT_CATALOG): LocalSettings {
  return {
    connections: catalog.connections.map((entry) => ({
      connectionId: entry.id,
      // Demo metadata is safe to preview. New real connections require an explicit grant.
      enabled: entry.provider === "dummy",
      selection: { mode: "all", groupIds: [], itemIds: [] },
      excludedItemIds: [],
      excludedFields: [],
    })),
    excludedSites: [],
    siteDefaults: [],
  };
}

export type EligibilityReason =
  | "connection-missing"
  | "connection-disabled"
  | "item-missing"
  | "item-excluded"
  | "item-not-selected"
  | "fields-excluded";
export type ItemEligibility =
  | { eligible: true; item: VaultItemMetadata; fieldIds: string[] }
  | { eligible: false; reason: EligibilityReason };

export function getItemEligibility(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connectionId: string,
  itemId: string,
): ItemEligibility {
  const connection = settings.connections.find((entry) => entry.connectionId === connectionId);
  const metadata = catalog.connections.find((entry) => entry.id === connectionId);
  if (!connection || !metadata) return { eligible: false, reason: "connection-missing" };
  if (!connection.enabled) return { eligible: false, reason: "connection-disabled" };
  const item = metadata.items.find((entry) => entry.id === itemId);
  if (!item) return { eligible: false, reason: "item-missing" };
  if (connection.excludedItemIds.includes(itemId))
    return { eligible: false, reason: "item-excluded" };
  if (
    connection.selection.mode === "selected" &&
    !connection.selection.itemIds.includes(itemId) &&
    !item.groupIds.some((id) => connection.selection.groupIds.includes(id))
  )
    return { eligible: false, reason: "item-not-selected" };
  const fieldIds = item.fields
    .filter(
      (field) =>
        !connection.excludedFields.some((ref) => ref.itemId === itemId && ref.fieldId === field.id),
    )
    .map((field) => field.id);
  if (!fieldIds.length) return { eligible: false, reason: "fields-excluded" };
  return { eligible: true, item, fieldIds };
}

export function isSiteExcluded(settings: LocalSettings, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  // Invalid destinations are blocked, never treated as a permission grant.
  if (!hostname) return true;
  return settings.excludedSites.some(
    (site) =>
      hostname === site.hostname ||
      (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
  );
}

export type SiteAccountResolution =
  | { ok: true; origin: string; connectionId: string; itemId: string; fieldIds: string[] }
  | {
      ok: false;
      reason:
        | "invalid-url"
        | "site-excluded"
        | "default-not-set"
        | "item-origin-mismatch"
        | EligibilityReason;
    };

/** Pure next-login selection. This never switches a current browser session. */
export function resolveSiteAccount(
  settings: LocalSettings,
  catalog: VaultCatalog,
  value: string,
): SiteAccountResolution {
  const url = parseSiteUrl(value);
  if (!url || !normalizeHostname(url.hostname)) return { ok: false, reason: "invalid-url" };
  if (isSiteExcluded(settings, value)) return { ok: false, reason: "site-excluded" };
  const selected = settings.siteDefaults.find((entry) => entry.origin === url.origin);
  if (!selected) return { ok: false, reason: "default-not-set" };
  const eligibility = getItemEligibility(settings, catalog, selected.connectionId, selected.itemId);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  if (!eligibility.item.allowedOrigins.includes(url.origin))
    return { ok: false, reason: "item-origin-mismatch" };
  return {
    ok: true,
    origin: url.origin,
    connectionId: selected.connectionId,
    itemId: selected.itemId,
    fieldIds: eligibility.fieldIds,
  };
}
