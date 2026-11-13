import * as v from "valibot";
import { detailLinkKey, detailQuestionKey } from "./detail-link-identity";
import {
  hostnameSchema,
  savedLoginBindingSchema,
  detailLinkSchema,
  vaultTimeoutSchema,
  modelSpendLimitsSchema,
  siteDefaultSchema,
  siteRulesSchema,
  connectionSettingsSchema,
  accountPolicySchema,
  itemPolicySchema,
  customFieldReviewSchema,
  accountKey,
  itemKey,
} from "./schema-primitives";
import { pagePermissionDefaultsSchema, sitePagePermissionsSchema } from "./page-permissions";

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
    /** Per-kind profile defaults (ADR 0035), absent at the decided defaults. */
    pagePermissionDefaults: v.optional(pagePermissionDefaultsSchema),
    /** Partial per-host overrides, absent while empty; not a grant of site access. */
    sitePagePermissions: v.optional(sitePagePermissionsSchema),
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
          (links) => new Set(links.map(detailLinkKey)).size === links.length,
          "Duplicate detail links",
        ),
        v.check(
          (links) => links.every((link) => !link.question || link.detail === "secret-answer"),
          "Only a secret question's answer stores its question",
        ),
        // A stored question belongs to one of the login item's answers, so a page that
        // shows it never matches two of them.
        v.check((links) => {
          const questions = links.flatMap((link) => {
            const key = detailQuestionKey(link);
            return key === undefined ? [] : [key];
          });
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
