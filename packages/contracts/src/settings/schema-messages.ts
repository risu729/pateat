import * as v from "valibot";
import {
  identifier,
  identifiers,
  revision,
  originSchema,
  vaultServerSchema,
  evidenceSchema,
  instantSchema,
} from "./schema-primitives";
import { localSettingsSchema } from "./schema-value";

/**
 * What wrote a settings revision, so a save that meets a revision conflict can say why
 * (ADR 0025). Only the settings page and the toolbar popup send `settings.save`.
 */
export const SETTINGS_CHANGE_CAUSES = [
  /** A save from a settings page or the toolbar popup. */
  "settings-save",
  /** A new vault connection's policy entry. */
  "vault-added",
  /** A vault connection deleted before its account was known (ADR 0023). */
  "vault-removed",
  /** A vault snapshot adopted after a password sign-in or the **Sync** button. */
  "vault-sync",
  /** A vault snapshot adopted by an automatic check (ADR 0025). */
  "automatic-vault-sync",
  /** A custom-field review (ADR 0023). */
  "field-review",
  /** Settings merged from the Pateat service. */
  "service-sync",
  /** Settings merged from a file exported on another device (ADR 0040). */
  "settings-import",
  /** An account used on a site, from a login or a passkey request, saved for it (ADR 0021). */
  "account-choice",
  /** A vault field linked to a personal detail on a site, or that link removed (ADR 0061). */
  "detail-link",
  /** A site whose passkey requests go to the browser, from the chooser (ADR 0007). */
  "passkey-browser-site",
] as const;
export const settingsChangeCauseSchema = v.picklist(SETTINGS_CHANGE_CAUSES);
/** The most recent revisions whose cause the snapshot keeps. */
export const SETTINGS_CHANGE_HISTORY = 16;
export const settingsSnapshotSchema = v.strictObject({
  version: v.literal(1),
  revision,
  settings: localSettingsSchema,
  /** The cause of each of the last revisions, oldest first; it holds no setting value. */
  changes: v.optional(
    v.pipe(
      v.array(v.strictObject({ revision, cause: settingsChangeCauseSchema })),
      v.maxLength(SETTINGS_CHANGE_HISTORY),
    ),
  ),
  /**
   * Items a vault sync found still older than their custom-field review record, per
   * accepted snapshot: their review is offered instead of another vault sync (ADR 0023).
   * Device-local; never synced.
   */
  olderAfterSync: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          connectionId: identifier,
          snapshotId: v.pipe(v.string(), v.uuid()),
          itemIds: identifiers,
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
    /**
     * The vault snapshot of each connection the draft was edited against. An item's first
     * custom-field exclusion is recorded as reviewed only for the snapshot shown (ADR 0023).
     */
    shownSnapshots: v.optional(
      v.pipe(
        v.array(
          v.strictObject({ connectionId: identifier, snapshotId: v.pipe(v.string(), v.uuid()) }),
        ),
        v.maxLength(100),
      ),
    ),
  }),
]);

export const vaultCatalogSchema = v.strictObject({
  /**
   * This device is paired and has not completed a settings sync since: no vault item is
   * used for logins or passkeys until one has (ADR 0023).
   */
  settingsSyncPending: v.optional(v.literal(true)),
  connections: v.array(
    v.strictObject({
      id: identifier,
      label: identifier,
      provider: identifier,
      /** The provider server, known from the connection's setup even while unavailable. */
      server: vaultServerSchema,
      /** The provider account ID that synced references name; absent while unavailable. */
      userId: v.optional(identifier),
      /**
       * While the connection is locked or unavailable, the account ID of its last accepted
       * snapshot, if any: it only tells whether the account's synced policy uses it.
       */
      lockedUserId: v.optional(identifier),
      snapshotId: v.optional(v.pipe(v.string(), v.uuid())),
      /** Items blocked until their custom fields are reviewed, or the vault is synced. */
      quarantinedItemIds: v.optional(identifiers),
      /**
       * The blocked items whose local copy is older than their review record: the vault
       * needs a sync before they can be reviewed (ADR 0023).
       */
      staleItemIds: v.optional(identifiers),
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
          /** In the trash or archived; no personal detail is read from it (ADR 0061). */
          inactive: v.optional(v.literal(true)),
          groupIds: identifiers,
          /**
           * A hash of the item's encrypted custom fields, which every device computes the
           * same for one item revision (ADR 0023); absent for providers without one.
           */
          evidence: v.optional(evidenceSchema),
          /** The provider's revision date of the item, with `evidence`. */
          revisionDate: v.optional(instantSchema),
          /**
           * Bitwarden asks for the master password again before the item is used. Pateat
           * asks only on sites listed in `repromptSites` (owner, 2026-10-23 12:46 UTC).
           */
          reprompt: v.optional(v.literal(true)),
          fields: v.array(
            v.strictObject({
              id: identifier,
              label: identifier,
              /** A custom field's own vault name; `null` for built-in and unnamed fields. */
              name: v.nullable(identifier),
              kind: v.picklist(["text", "hidden", "boolean", "linked", "otp", "unsupported"]),
              /** The built-in field a Linked field reads, when the provider defines it. */
              linkedFieldId: v.optional(identifier),
              /**
               * Set on the built-in username, password or TOTP field when the item holds no
               * value for it (ADR 0016, ADR 0027); the catalog never carries the value itself.
               */
              empty: v.optional(v.literal(true)),
              /**
               * Set on a Text or Hidden custom field whose value is shaped like a TOTP key
               * (`isTotpSeed` in `@pateat/bitwarden`): such a field gives only `totp` codes,
               * is never offered to generation and is never filled as text (ADR 0027, owner
               * 2026-10-23). A flag only, never the value.
               */
              totpSeed: v.optional(v.literal(true)),
            }),
          ),
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
  /**
   * With `revision-conflict`: the distinct causes of the revisions written since the
   * expected one, oldest first, and `unknown` when the snapshot no longer records one.
   */
  causes: v.optional(
    v.pipe(
      v.array(v.picklist([...SETTINGS_CHANGE_CAUSES, "unknown"])),
      v.maxLength(SETTINGS_CHANGE_CAUSES.length + 1),
    ),
  ),
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

