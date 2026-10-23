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

/**
 * Only explicit HTTP(S) URLs are policy inputs; no credentials or ambiguous separators.
 * A backslash is ambiguous only before the query or fragment: parsers disagree on it in the
 * authority, and WHATWG rewrites it to `/` in the path, but keeps it in the query and fragment.
 */
export function parseSiteUrl(value: string): URL | undefined {
  if (/\s/.test(value) || (value.split(/[?#]/, 1)[0] ?? "").includes("\\")) return undefined;
  if (!/^https?:\/\/[^/]/i.test(value)) return undefined;
  if (value.split("//")[1]?.split(/[/?#]/)[0]?.includes("@")) return undefined;
  const url = URL.parse(value);
  if (!url) return undefined;
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
  return url;
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
/**
 * A recipe slot ID: a built-in slot (`username`, `password`, `totp`) or a custom-field
 * slot named from the page's text for its field, such as `店番号` (ADR 0027). 1 to 60
 * characters in NFKC, without control, format, default-ignorable (invisible) or line and
 * paragraph separator characters, with words apart by single spaces and none at either end.
 */
export const recipeSlotIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(60),
  v.regex(
    /^[^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+(?: [^\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+)*$/u,
  ),
  v.check((value) => value.normalize("NFKC") === value, "Use NFKC text"),
);
const vaultNameSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
/**
 * The personal details a `detail` handler's input may ask for (ADR 0061), each read from
 * a vault item the owner linked to the login and made into the value the page wants:
 * a birth date in the input's `format`, the last four digits of a phone number or of a
 * card number, a card's security code, its whole number or its expiry date in the input's
 * `format`, a PIN, or, from the login item's own custom fields, the answer to a secret
 * question or a member or customer number.
 */
export const loginDetailSchema = v.picklist([
  "birth-date",
  "phone-last-4",
  "card-last-4",
  "card-code",
  "card-number",
  "card-expiry",
  "pin",
  "secret-answer",
  "member-id",
]);
/** How a `birth-date` input wants the date written (ADR 0061). */
export const birthDateFormatSchema = v.picklist([
  "yyyymmdd",
  "yyyymm",
  "yyyy-mm-dd",
  "yyyy/mm/dd",
  "mmdd",
]);
/** How a `card-expiry` input wants the card's expiry month and year written (ADR 0061). */
export const cardExpiryFormatSchema = v.picklist(["mmyy", "mm/yy", "mmyyyy", "mm/yyyy"]);
/** An input's `format`: a birth date's or a card expiry date's. */
export const detailFormatSchema = v.picklist([
  ...birthDateFormatSchema.options,
  ...cardExpiryFormatSchema.options,
]);
/**
 * Whether `format` belongs to `detail` (ADR 0061): a birth date and a card's expiry date
 * each need one of their own formats, and no other detail has one.
 */
export function detailFormatFits(detail: LoginDetail, format: DetailFormat | undefined): boolean {
  if (detail === "birth-date") return v.is(birthDateFormatSchema, format);
  if (detail === "card-expiry") return v.is(cardExpiryFormatSchema, format);
  return format === undefined;
}

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
  /**
   * The label of the vault connection the account was chosen from, for display only.
   * Bindings made by AI generation on the service have none until a device names them.
   */
  accountName: v.optional(vaultNameSchema),
  slots: v.pipe(
    v.array(v.strictObject({ slot: recipeSlotIdSchema, field: vaultFieldReferenceSchema })),
    v.minLength(1),
    v.maxLength(20),
    v.check(
      (entries) => new Set(entries.map((entry) => entry.slot)).size === entries.length,
      "Duplicate binding slots",
    ),
  ),
});

/**
 * Where a linked detail's value is read (ADR 0061): an identity's phone number, a card's
 * number, security code or expiry month (whose year the same card item gives), or a
 * custom field by name, as binding references name them.
 */
export const detailSourceFieldSchema = v.union([
  v.picklist(["identity.phone", "card.number", "card.code", "card.expMonth"]),
  vaultFieldReferenceSchema.options[1],
]);
/**
 * A secret question or a field name as they are compared (ADR 0061): NFKC, without case,
 * with curly apostrophes (U+2018, U+2019) made straight, white space collapsed, and a
 * trailing `?`, `:` or their full-width forms removed (NFKC already folds those).
 */
export function questionText(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[\u2018\u2019]/gu, "'")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/[?:]+$/u, "")
    .trim();
}
/** The shortest question or field name that may stand for a secret question (ADR 0061). */
export const QUESTION_MIN_LENGTH = 4;
/** The longest one sent to a page or stored with a link (ADR 0061). */
export const QUESTION_MAX_LENGTH = 200;
/**
 * A secret question as the judge copies it from the page (ADR 0061): untrusted page text,
 * bounded as observed text is but up to the stored question's length.
 */
export const shownQuestionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(QUESTION_MAX_LENGTH),
  v.regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
);
/**
 * A secret question as a link stores it (ADR 0061): already in its compared form
 * (`questionText`), so a later login compares it with the page's whole questions.
 */
export const storedQuestionSchema = v.pipe(
  v.string(),
  v.minLength(QUESTION_MIN_LENGTH),
  v.maxLength(QUESTION_MAX_LENGTH),
  v.check((question) => questionText(question) === question, "Store a question normalized"),
);
/**
 * The vault item and field a login item's site reads a personal detail from (ADR 0061),
 * confirmed by the owner in the popup. References only: no item name, which for a card
 * often carries its last digits, and never a value.
 */
export const detailLinkSchema = v.strictObject({
  origin: originSchema,
  provider: identifier,
  userId: identifier,
  /** The login item. */
  itemId: identifier,
  detail: loginDetailSchema,
  source: v.strictObject({ itemId: identifier, field: detailSourceFieldSchema }),
  /**
   * Only for a secret question's answer: the question the page showed when the owner
   * confirmed, in the popup, the AI's pairing of it with this field, whose name differs.
   * A later login answers the question only where the page shows it, compared after
   * normalization, as one whole question; the field's name then no longer counts.
   */
  question: v.optional(storedQuestionSchema),
});

/** The saved account for one origin, named by provider account and item (ADR 0013). */
export const siteDefaultSchema = v.strictObject({
  origin: originSchema,
  provider: identifier,
  userId: identifier,
  itemId: identifier,
  /** For display only, such as on the service's web UI. */
  itemName: v.optional(vaultNameSchema),
  /** The vault connection's label on the device that named it; for display only. */
  accountName: v.optional(vaultNameSchema),
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

/** Site rules by hostname, optionally with its subdomains, as the settings page lists them. */
const siteRulesSchema = v.pipe(
  v.array(v.strictObject({ hostname: hostnameSchema, includeSubdomains: v.boolean() })),
  v.maxLength(1000),
  v.check(
    (sites) => new Set(sites.map((site) => site.hostname)).size === sites.length,
    "Duplicate sites",
  ),
);

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
    excludedSites: siteRulesSchema,
    /**
     * Sites where Pateat honours Bitwarden's master password re-prompt: it asks for the
     * master password before it fills or signs with an item that has it (owner, 2026-10-23
     * 12:46 UTC). Elsewhere such items are used as any other. A document written before
     * the list existed has no sites.
     */
    repromptSites: v.optional(siteRulesSchema, []),
    /**
     * Hostnames whose passkey requests Pateat hands on to the browser unanswered, added by
     * the chooser's "Always for this site" (ADR 0007). Exact hostnames, without subdomains.
     * Settings written before the list existed lack it, and read as an empty list.
     */
    passkeyBrowserSites: v.optional(
      v.pipe(
        v.array(v.strictObject({ hostname: hostnameSchema })),
        v.maxLength(1000),
        v.check(
          (sites) => new Set(sites.map((site) => site.hostname)).size === sites.length,
          "Duplicate sites",
        ),
      ),
      () => [],
    ),
    siteDefaults: v.pipe(
      v.array(siteDefaultSchema),
      v.maxLength(1000),
      v.check(
        (sites) => new Set(sites.map((site) => site.origin)).size === sites.length,
        "Duplicate origins",
      ),
    ),
    /** Synced links to the items that hold a login's personal details (ADR 0061). */
    detailLinks: v.optional(
      v.pipe(
        v.array(detailLinkSchema),
        v.maxLength(1000),
        v.check(
          (links) =>
            new Set(
              // A secret question's answer is linked per field, one per question.
              links.map((link) =>
                JSON.stringify([
                  link.origin,
                  link.provider,
                  link.userId,
                  link.itemId,
                  link.detail,
                  link.detail === "secret-answer" ? link.source.field : null,
                ]),
              ),
            ).size === links.length,
          "Duplicate detail links",
        ),
        v.check(
          (links) => links.every((link) => !link.question || link.detail === "secret-answer"),
          "Only a secret question's answer stores its question",
        ),
        // A stored question belongs to one of the login item's answers, so a page that
        // shows it never matches two of them.
        v.check((links) => {
          const questions = links.flatMap((link) =>
            link.question === undefined
              ? []
              : [
                  JSON.stringify([
                    link.origin,
                    link.provider,
                    link.userId,
                    link.itemId,
                    link.question,
                  ]),
                ],
          );
          return new Set(questions).size === questions.length;
        }, "Duplicate detail questions"),
      ),
    ),
    /** Synced account bindings (ADR 0013). */
    bindings: v.pipe(
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
  }),
);

/**
 * What wrote a settings revision, so a save that meets a revision conflict can say why
 * (ADR 0025). Only the settings page and the toolbar popup send `settings.save`.
 */
export const SETTINGS_CHANGE_CAUSES = [
  /** A save from a settings page or the toolbar popup. */
  "settings-save",
  /** A new vault connection's policy entry. */
  "vault-added",
  /** A vault snapshot adopted after a password sign-in or the **Sync** button. */
  "vault-sync",
  /** A vault snapshot adopted by an automatic check (ADR 0025). */
  "automatic-vault-sync",
  /** A custom-field review (ADR 0023). */
  "field-review",
  /** Settings merged from the Pateat service. */
  "service-sync",
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
      /** The provider account ID that synced references name; absent while unavailable. */
      userId: v.optional(identifier),
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
          /** In the trash or archived; no personal detail is read from it (ADR 0061). */
          inactive: v.optional(v.literal(true)),
          groupIds: identifiers,
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

export type LocalSettings = v.InferOutput<typeof localSettingsSchema>;
export type ConnectionSettings = v.InferOutput<typeof connectionSettingsSchema>;
export type SiteDefault = v.InferOutput<typeof siteDefaultSchema>;
export type SettingsSnapshot = v.InferOutput<typeof settingsSnapshotSchema>;
export type SettingsRequest = v.InferOutput<typeof settingsRequestSchema>;
export type SettingsResponse = v.InferOutput<typeof settingsResponseSchema>;
export type SettingsError = v.InferOutput<typeof settingsErrorSchema>;
export type SettingsChangeCause = v.InferOutput<typeof settingsChangeCauseSchema>;
export type SettingsConflictCause = NonNullable<SettingsError["causes"]>[number];
export type VaultCatalog = v.InferOutput<typeof vaultCatalogSchema>;
export type VaultFieldReference = v.InferOutput<typeof vaultFieldReferenceSchema>;
export type SavedLoginBinding = v.InferOutput<typeof savedLoginBindingSchema>;
export type LoginDetail = v.InferOutput<typeof loginDetailSchema>;
export type BirthDateFormat = v.InferOutput<typeof birthDateFormatSchema>;
export type CardExpiryFormat = v.InferOutput<typeof cardExpiryFormatSchema>;
export type DetailFormat = v.InferOutput<typeof detailFormatSchema>;
export type DetailLink = v.InferOutput<typeof detailLinkSchema>;
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
      userId: "demo-personal-account",
      groups: [{ id: "everyday", label: "Everyday", kind: "folder" }],
      items: [
        {
          id: "primary",
          label: "Demo primary account",
          allowedOrigins: ["https://bank.example"],
          groupIds: ["everyday"],
          fields: [
            { id: "username", label: "Username", name: null, kind: "text" },
            { id: "password", label: "Password", name: null, kind: "hidden" },
            { id: "branch", label: "Branch number", name: "Branch number", kind: "text" },
          ],
        },
        {
          id: "secondary",
          label: "Demo secondary account",
          allowedOrigins: ["https://bank.example", "https://mail.example"],
          groupIds: [],
          fields: [
            { id: "username", label: "Username", name: null, kind: "text" },
            { id: "password", label: "Password", name: null, kind: "hidden" },
          ],
        },
      ],
    },
    {
      id: "demo-work",
      label: "Demo work vault",
      provider: "dummy",
      userId: "demo-work-account",
      groups: [{ id: "team", label: "Team", kind: "collection" }],
      items: [
        {
          id: "primary",
          label: "Demo team account",
          allowedOrigins: ["https://bank.example"],
          groupIds: ["team"],
          fields: [
            { id: "username", label: "Username", name: null, kind: "text" },
            { id: "password", label: "Password", name: null, kind: "hidden" },
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
    repromptSites: [],
    passkeyBrowserSites: [],
    siteDefaults: [],
    bindings: [],
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

function ruleMatches(rules: LocalSettings["excludedSites"], hostname: string): boolean {
  return rules.some(
    (site) =>
      hostname === site.hostname ||
      (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
  );
}

export function isSiteExcluded(settings: LocalSettings, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  // Invalid destinations are blocked, never treated as a permission grant.
  if (!hostname) return true;
  return ruleMatches(settings.excludedSites, hostname);
}

/**
 * Whether Pateat asks for the master password on this page's site before it fills or
 * signs with an item that has Bitwarden's re-prompt. An invalid URL asks, so a doubt
 * never skips the question.
 */
export function asksForMasterPassword(settings: LocalSettings, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return true;
  return ruleMatches(settings.repromptSites, hostname);
}

/** Whether an item has to wait for the master password on this page's site. */
export function itemAsksForMasterPassword(
  settings: LocalSettings,
  item: Pick<VaultItemMetadata, "reprompt"> | undefined,
  value: string,
): boolean {
  return item?.reprompt === true && asksForMasterPassword(settings, value);
}

/**
 * Whether Pateat hands every passkey request of this page's exact hostname on to the
 * browser (ADR 0007). An invalid destination is handed on too.
 */
export function isPasskeyBrowserSite(settings: LocalSettings, value: string): boolean {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return true;
  return settings.passkeyBrowserSites.some((site) => site.hostname === hostname);
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
        | "account-ambiguous"
        | "vault-unavailable"
        | EligibilityReason;
    };

export type SiteDefaultConnection =
  | { ok: true; connectionId: string }
  | { ok: false; reason: "connection-missing" | "account-ambiguous" | "vault-unavailable" };

/**
 * The local connection a saved site default names: the one catalog connection of that
 * provider account. An account connected twice is ambiguous. With no match while a
 * connection of that provider cannot name its account (locked or unavailable), the vault
 * is unavailable rather than the account missing.
 */
export function siteDefaultConnection(
  entry: Pick<SiteDefault, "provider" | "userId">,
  catalog: VaultCatalog,
): SiteDefaultConnection {
  const sameProvider = catalog.connections.filter(
    (connection) => connection.provider === entry.provider,
  );
  const matches = sameProvider.filter((connection) => connection.userId === entry.userId);
  if (matches.length > 1) return { ok: false, reason: "account-ambiguous" };
  if (matches[0]) return { ok: true, connectionId: matches[0].id };
  return sameProvider.some((connection) => connection.userId === undefined)
    ? { ok: false, reason: "vault-unavailable" }
    : { ok: false, reason: "connection-missing" };
}

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
  const connection = siteDefaultConnection(selected, catalog);
  if (!connection.ok) return { ok: false, reason: connection.reason };
  const { connectionId } = connection;
  const eligibility = getItemEligibility(settings, catalog, connectionId, selected.itemId);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  if (!eligibility.item.allowedOrigins.includes(url.origin))
    return { ok: false, reason: "item-origin-mismatch" };
  return {
    ok: true,
    origin: url.origin,
    connectionId,
    itemId: selected.itemId,
    fieldIds: eligibility.fieldIds,
  };
}
