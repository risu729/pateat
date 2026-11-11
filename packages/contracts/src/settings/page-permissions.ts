import * as v from "valibot";
import {
  hostnameSchema,
  normalizeHostname,
  parseSiteUrl,
  siteRuleCovers,
} from "./schema-primitives";

/** How far Pateat may go on a page, per settings profile (ADR 0035). */
export const pagePermissionDefaultsSchema = v.strictObject({
  "sign-in": v.picklist(["auto", "fill"]),
  confirm: v.picklist(["fill", "off"]),
  "personal-details": v.picklist(["fill", "off"]),
});
export type PagePermissionDefaults = v.InferOutput<typeof pagePermissionDefaultsSchema>;
export type PagePermissionKind = keyof PagePermissionDefaults;

export const sitePagePermissionsSchema = v.strictObject({
  hostname: hostnameSchema,
  includeSubdomains: v.boolean(),
  permissions: v.pipe(
    v.partial(pagePermissionDefaultsSchema),
    v.check(
      (permissions) => Object.values(permissions).some((value) => value !== undefined),
      "Choose at least one page permission",
    ),
  ),
});
export type SitePagePermissions = v.InferOutput<typeof sitePagePermissionsSchema>;
export const sitePagePermissionRulesSchema = v.pipe(
  v.array(sitePagePermissionsSchema),
  v.maxLength(1000),
  v.check(
    (sites) => new Set(sites.map((site) => site.hostname)).size === sites.length,
    "Duplicate sites",
  ),
);

export const DEFAULT_PAGE_PERMISSIONS: Readonly<PagePermissionDefaults> = Object.freeze({
  "sign-in": "auto",
  confirm: "fill",
  "personal-details": "fill",
});

type PagePermissionSettings = {
  pagePermissionDefaults?: PagePermissionDefaults | undefined;
  sitePagePermissions?: SitePagePermissions[] | undefined;
};

/** Absent defaults are the decided defaults; a present object always has every kind. */
export function getPagePermissionDefaults(
  settings: PagePermissionSettings,
): PagePermissionDefaults {
  const defaults = settings.pagePermissionDefaults ?? DEFAULT_PAGE_PERMISSIONS;
  return {
    "sign-in": defaults["sign-in"],
    confirm: defaults.confirm,
    "personal-details": defaults["personal-details"],
  };
}

/** Canonical profile fields: defaults and an empty list are represented by absence. */
export function pagePermissionDocument(settings: PagePermissionSettings): {
  pagePermissionDefaults?: PagePermissionDefaults;
  sitePagePermissions?: SitePagePermissions[];
} {
  const defaults = getPagePermissionDefaults(settings);
  return {
    ...(defaults["sign-in"] !== DEFAULT_PAGE_PERMISSIONS["sign-in"] ||
    defaults.confirm !== DEFAULT_PAGE_PERMISSIONS.confirm ||
    defaults["personal-details"] !== DEFAULT_PAGE_PERMISSIONS["personal-details"]
      ? { pagePermissionDefaults: defaults }
      : {}),
    ...(settings.sitePagePermissions?.length
      ? { sitePagePermissions: settings.sitePagePermissions }
      : {}),
  };
}

export type PagePermissionResolution<K extends PagePermissionKind = PagePermissionKind> = {
  permission: PagePermissionDefaults[K];
  source: "site" | "default";
  /** The rule that decided this kind, absent when the profile default decided it. */
  hostname?: string;
};

/**
 * The longest covering hostname wins separately for each kind. An unrelated kind on a
 * more specific row never hides a parent's rule. Invalid policy URLs have no decision.
 */
export function resolvePagePermission<K extends PagePermissionKind>(
  settings: PagePermissionSettings,
  value: string,
  kind: K,
): PagePermissionResolution<K> | undefined {
  const url = parseSiteUrl(value);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return undefined;
  let selected: SitePagePermissions | undefined;
  for (const rule of settings.sitePagePermissions ?? []) {
    if (
      rule.permissions[kind] !== undefined &&
      siteRuleCovers(rule, hostname) &&
      (!selected || rule.hostname.length > selected.hostname.length)
    )
      selected = rule;
  }
  return selected
    ? {
        permission: selected.permissions[kind] as PagePermissionDefaults[K],
        source: "site",
        hostname: selected.hostname,
      }
    : { permission: getPagePermissionDefaults(settings)[kind], source: "default" };
}
