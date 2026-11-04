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
 * The provider server an account lives on (ADR 0023): a Bitwarden cloud region, or a
 * self-hosted server's normalized origin, HTTPS or plain HTTP on `localhost` or
 * `127.0.0.1` (ADR 0059). A self-hosted server can return any user ID, so an account is
 * named by provider, server and user ID together.
 */
export const vaultServerSchema = v.union([
  v.picklist(["cloud-us", "cloud-eu"]),
  v.pipe(
    v.string(),
    v.maxLength(2048),
    v.check((value) => {
      const url = parseSiteUrl(value);
      return (
        url?.origin === value &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            (url.hostname === "localhost" || url.hostname === "127.0.0.1")))
      );
    }, "Use cloud-us, cloud-eu, an exact HTTPS origin or a loopback HTTP origin"),
  ),
]);
/** One provider account, the same on every device that connects it (ADR 0023). */
const accountReference = { provider: identifier, server: vaultServerSchema, userId: identifier };
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
 * The parts of a birth date or a card's expiry date split over several inputs (ADR 0061):
 * one input or select each for its year, month and day.
 */
export const datePartSchema = v.picklist(["year", "month", "day"]);
/**
 * How one input of a split birth date or card expiry date wants its part written (ADR
 * 0061): a four- or two-digit year, a month or day with or without its leading zero. A
 * select is matched by the number, so only a year's two or four digits matter there.
 */
export const detailPartFormatSchema = v.picklist(["yyyy", "yy", "mm", "m", "dd", "d"]);
/** The formats each part of a split date may have; a birth year is always four digits. */
const partFormats: Partial<
  Record<LoginDetail, Partial<Record<DatePart, readonly DetailPartFormat[]>>>
> = {
  "birth-date": { year: ["yyyy"], month: ["mm", "m"], day: ["dd", "d"] },
  "card-expiry": { month: ["mm", "m"], year: ["yy", "yyyy"] },
};
/**
 * Whether `format` belongs to `part` of a split `detail` (ADR 0061): a birth date's year,
 * month or day, or a card expiry date's month or year, each with one of its own formats.
 */
export function detailPartFormatFits(
  detail: LoginDetail,
  part: DatePart,
  format: DetailPartFormat | undefined,
): boolean {
  return format !== undefined && (partFormats[detail]?.[part]?.includes(format) ?? false);
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
  ...accountReference,
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
  ...accountReference,
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

/** The vault timeout's preset minutes; any other whole number up to a year is custom. */
export const VAULT_TIMEOUT_MINUTES = [1, 5, 15, 30, 60, 240] as const;
export const MAX_CUSTOM_MINUTES = 525_600;
export const VAULT_TIMEOUT_EVENTS = ["never", "restart", "system-idle", "system-lock"] as const;
/** When the vaults lock or log out (ADR 0075). */
export const vaultTimeoutSchema = v.strictObject({
  /** Minutes without use, a system event, a browser restart only, or never. */
  timeout: v.union([
    v.picklist(VAULT_TIMEOUT_EVENTS),
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CUSTOM_MINUTES)),
  ]),
  /** Lock keeps the sync sign-in and unlocks offline; log out needs a sign-in again. */
  action: v.picklist(["lock", "log-out"]),
});

/** The highest spend limit a device's own Anthropic API key takes (ADR 0040). */
export const MAX_DEVICE_LIMIT_USD = 100_000;
const spendLimitUsd = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(MAX_DEVICE_LIMIT_USD),
);
/** The daily and monthly spend limits of a device's own key, in US dollars (ADR 0040). */
export const modelSpendLimitsSchema = v.strictObject({
  dailyUsd: spendLimitUsd,
  monthlyUsd: spendLimitUsd,
});

/** The saved account for one origin, named by provider account and item (ADR 0013). */

export const siteDefaultSchema = v.strictObject({
  origin: originSchema,
  ...accountReference,
  itemId: identifier,
  /** For display only, such as on the service's web UI. */
  itemName: v.optional(vaultNameSchema),
  /** The vault connection's label on the device that named it; for display only. */
  accountName: v.optional(vaultNameSchema),
});

/** A hostname, and optionally its subdomains: an exclusion, an allowed site or a re-prompt site. */
export const siteRuleSchema = v.strictObject({
  hostname: hostnameSchema,
  includeSubdomains: v.boolean(),
});
const siteRulesSchema = v.pipe(
  v.array(siteRuleSchema),
  v.maxLength(1000),
  v.check(
    (sites) => new Set(sites.map((site) => site.hostname)).size === sites.length,
    "Duplicate sites",
  ),
);

/**
 * A vault connection on this device, before its provider account is known: the add form's
 * choice whether to use it, applied when the account first syncs (ADR 0023). Never synced.
 */
export const connectionSettingsSchema = v.strictObject({
  connectionId: identifier,
  enabled: v.boolean(),
});

/**
 * A built-in field by its provider ID (`login.password`, `card.number`, …), or a custom
 * field by its vault name with its `position` (from 1) and `count` among the item's custom
 * fields of that name. Unnamed fields form the group `custom: null` (ADR 0023).
 */
export const excludedFieldSchema = v.union([
  identifier,
  v.pipe(
    v.strictObject({
      custom: v.nullable(vaultNameSchema),
      position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
      count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    }),
    v.check(
      (ref) =>
        (ref.position === undefined) === (ref.count === undefined) &&
        (ref.position === undefined || ref.position <= ref.count!),
      "A custom field reference needs a position within its count",
    ),
  ),
]);

/** Whether and which items of one provider account Pateat uses (ADR 0023). */
export const accountPolicySchema = v.strictObject({
  ...accountReference,
  /** The vault connection's label on the device that wrote it; for display only. */
  accountName: vaultNameSchema,
  enabled: v.boolean(),
  selection: v.variant("mode", [
    v.strictObject({ mode: v.literal("all") }),
    v.strictObject({
      mode: v.literal("selected"),
      groups: v.pipe(
        v.array(v.strictObject({ id: identifier, name: vaultNameSchema })),
        v.maxLength(1000),
        v.check(
          (groups) => new Set(groups.map((group) => group.id)).size === groups.length,
          "Duplicate groups",
        ),
      ),
    }),
  ]),
});

/** One item's selection and exclusions; items without any are not listed (ADR 0023). */
export const itemPolicySchema = v.strictObject({
  ...accountReference,
  itemId: identifier,
  /** For display only. */
  itemName: vaultNameSchema,
  selected: v.boolean(),
  excluded: v.boolean(),
  // As many as a custom field's `position` can name: a review starts with every custom
  // field of an item excluded, however many it has (ADR 0023).
  excludedFields: v.pipe(
    v.array(excludedFieldSchema),
    v.maxLength(1000),
    v.check(
      (refs) => new Set(refs.map((ref) => JSON.stringify(ref))).size === refs.length,
      "Duplicate field references",
    ),
  ),
});

/** `<provider>-v<n>:sha256:<hex>`, naming the provider's evidence serialization. */
const evidenceSchema = v.pipe(
  v.string(),
  v.maxLength(120),
  v.regex(/^[a-z][a-z0-9]*-v[1-9][0-9]*:sha256:[0-9a-f]{64}$/),
);
/**
 * A provider timestamp with up to nine fractional digits and an explicit zone, such as
 * Bitwarden's `2026-10-11T07:10:03.1234567Z`; compared as an instant.
 */
const instantSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.check((value) => parseInstant(value) !== undefined, "Use an ISO 8601 instant"),
);

/** The encrypted custom fields one item had when they were last reviewed (ADR 0023). */
export const customFieldReviewSchema = v.strictObject({
  ...accountReference,
  itemId: identifier,
  evidence: evidenceSchema,
  revisionDate: instantSchema,
});

const accountKey = (entry: { provider: string; server: string; userId: string }) =>
  JSON.stringify([entry.provider, entry.server, entry.userId]);
const itemKey = (entry: { provider: string; server: string; userId: string; itemId: string }) =>
  JSON.stringify([entry.provider, entry.server, entry.userId, entry.itemId]);

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
    accountPolicies: v.pipe(
      v.array(accountPolicySchema),
      v.maxLength(100),
      v.check(
        (entries) => new Set(entries.map(accountKey)).size === entries.length,
        "Duplicate account policies",
      ),
    ),
    itemPolicies: v.pipe(
      v.array(itemPolicySchema),
      v.maxLength(1000),
      v.check(
        (entries) => new Set(entries.map(itemKey)).size === entries.length,
        "Duplicate item policies",
      ),
    ),
    customFieldReviews: v.pipe(
      v.array(customFieldReviewSchema),
      v.maxLength(1000),
      v.check(
        (entries) => new Set(entries.map(itemKey)).size === entries.length,
        "Duplicate custom-field reviews",
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
     * The allowed sites (ADR 0077): while `allowedSitesEnabled` is true, automatic login
     * runs only on a site one of these rules covers, and any other site is paused as an
     * exclusion pauses it (ADR 0062). Turning the list off keeps its rules. Absent is the same as empty and off. A profile part, synced
     * like the exclusions (ADR 0024).
     */
    allowedSites: v.optional(siteRulesSchema),
    allowedSitesEnabled: v.optional(v.boolean()),
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
    /**
     * Whether Pateat logs in by itself in private (incognito) windows; absent means off, the
     * default. While off, every site in a private window is paused as a site is by the
     * popup's pause (ADR 0062): Pateat logs in only with an account picked in the popup.
     * Synced with the sites' rules, as part of the profile (ADR 0024).
     */
    loginInPrivateWindows: v.optional(v.literal(true)),
    /**
     * Whether the profile's devices send login records (ADR 0055) and problem log lines
     * (ADR 0066) to the service, and when the settings page last changed it, in epoch
     * milliseconds; absent means sending, the default. Once on again, problem lines written
     * before `since` are never sent. Synced as part of the profile (ADR 0024).
     */
    serviceReports: v.optional(
      v.strictObject({
        send: v.boolean(),
        since: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ),
    /**
     * The passkey presence and verification flags Pateat claims (ADR 0007); absent means
     * both `always`, the default. Synced as part of the profile (ADR 0024).
     */
    passkeyPolicy: v.optional(
      v.strictObject({
        presence: v.picklist(["always", "activation"]),
        verification: v.picklist(["always", "never"]),
      }),
    ),
    /**
     * When the profile's vaults lock or log out (ADR 0075); absent means `{ timeout:
     * "never", action: "lock" }`, the default. Synced as part of the profile (ADR 0024).
     */
    vaultTimeout: v.optional(vaultTimeoutSchema),
    /**
     * The extension pages' language (ADR 0043); absent follows the browser. Synced as part
     * of the profile (ADR 0024).
     */
    language: v.optional(v.picklist(["en", "ja"])),
    /** The extension pages' color theme; absent follows the browser. Synced (ADR 0024). */
    theme: v.optional(v.picklist(["light", "dark"])),
    /**
     * The daily and monthly spend limits, in US dollars, of a device's own Anthropic API key
     * (ADR 0040); absent means 5 and 100, the defaults. The key itself stays on the device.
     * Synced as part of the profile (ADR 0024).
     */
    modelSpendLimits: v.optional(modelSpendLimitsSchema),
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
                  link.server,
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
                    link.server,
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
                entry.server,
                entry.userId,
                entry.itemId,
              ]),
            ),
          ).size === bindings.length,
        "Duplicate account bindings",
      ),
    ),
    /**
     * Whether the toolbar popup shows its "This page" section (ADR 0038), synced like the
     * other profile parts (ADR 0024). Shown unless this is `false`; read it with
     * `popupPageSectionShown`.
     */
    popupPageSection: v.optional(v.boolean()),
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

export type LocalSettings = v.InferOutput<typeof localSettingsSchema>;
export type ConnectionSettings = v.InferOutput<typeof connectionSettingsSchema>;
export type SiteDefault = v.InferOutput<typeof siteDefaultSchema>;
export type SiteRule = v.InferOutput<typeof siteRuleSchema>;
export type AccountPolicy = v.InferOutput<typeof accountPolicySchema>;
export type ItemPolicy = v.InferOutput<typeof itemPolicySchema>;
export type ExcludedField = v.InferOutput<typeof excludedFieldSchema>;
export type CustomFieldReview = v.InferOutput<typeof customFieldReviewSchema>;
export type VaultServer = v.InferOutput<typeof vaultServerSchema>;
/** One provider account: the key of its account policy (ADR 0023). */
export type VaultAccount = { provider: string; server: string; userId: string };
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
export type DatePart = v.InferOutput<typeof datePartSchema>;
export type DetailPartFormat = v.InferOutput<typeof detailPartFormatSchema>;
export type DetailLink = v.InferOutput<typeof detailLinkSchema>;
export type VaultConnectionMetadata = VaultCatalog["connections"][number];
export type VaultItemMetadata = VaultConnectionMetadata["items"][number];

export function parseSettingsResponse(value: unknown): SettingsResponse {
  return v.parse(settingsResponseSchema, value);
}
export function parseLocalSettings(value: unknown): LocalSettings {
  return v.parse(localSettingsSchema, value);
}

/**
 * A provider timestamp as nanoseconds since the epoch: an ISO 8601 date and time with up
 * to nine fractional digits and `Z` or an offset. Undefined for anything else.
 */
export function parseInstant(value: string): bigint | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) return undefined;
  const milliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(milliseconds)) return undefined;
  // Date.parse rolls a day past the month's end over (February 30 is March 2).
  const [year, month, day] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return undefined;
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "0").padEnd(9, "0"));
}

/** Whether instant `left` is strictly before `right`; false when either does not parse. */
export function instantBefore(left: string, right: string): boolean {
  const [a, b] = [parseInstant(left), parseInstant(right)];
  return a !== undefined && b !== undefined && a < b;
}


/** Whether the popup shows its "This page" section: unless the settings hide it. */
export const popupPageSectionShown = (settings: Pick<LocalSettings, "popupPageSection">) =>
  settings.popupPageSection !== false;
