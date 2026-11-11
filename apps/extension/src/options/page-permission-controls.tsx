import {
  resolvePagePermission,
  pagePermissionDocument,
  type LocalSettings,
  type PagePermissionKind,
  type PagePermissionDefaults,
  type SitePagePermissions,
} from "@pateat/contracts";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { controlClass, fieldClass } from "./ui";

export const PAGE_PERMISSION_KINDS: PagePermissionKind[] = [
  "sign-in",
  "confirm",
  "personal-details",
];
export const PAGE_PERMISSIONS_SECTION = "page-permissions";
type Permission = PagePermissionDefaults[PagePermissionKind];

export function pagePermissionName(kind: PagePermissionKind, t: TFunction): string {
  return t(
    {
      "sign-in": "Sign-in pages",
      confirm: "Verification while signed in",
      "personal-details": "Other personal-detail forms",
    }[kind],
  );
}

export function pagePermissionLabel(permission: Permission, t: TFunction): string {
  return t({ auto: "Auto", fill: "Fill only", off: "Off" }[permission]);
}

/** The source after removing this host's override for this kind, keeping every other rule. */
export function inheritedPagePermission(
  settings: LocalSettings,
  hostname: string,
  kind: PagePermissionKind,
) {
  const inherited = {
    ...settings,
    sitePagePermissions: (settings.sitePagePermissions ?? []).flatMap((row) => {
      if (row.hostname !== hostname) return [row];
      const permissions = { ...row.permissions };
      delete permissions[kind];
      return Object.keys(permissions).length ? [{ ...row, permissions }] : [];
    }),
  };
  return resolvePagePermission(inherited, `https://${hostname}`, kind);
}

export function pagePermissionSource(
  settings: LocalSettings,
  hostname: string,
  kind: PagePermissionKind,
  t: TFunction,
): string {
  const selected = inheritedPagePermission(settings, hostname, kind);
  if (!selected) return t("Use profile default");
  return selected.source === "site"
    ? t("Use {{hostname}}'s rule ({{behavior}})", {
        hostname: selected.hostname,
        behavior: pagePermissionLabel(selected.permission, t),
      })
    : t("Use profile default ({{behavior}})", {
        behavior: pagePermissionLabel(selected.permission, t),
      });
}

/** The default choices and an empty rule list use the same absent representation as sync. */
export function normalizePagePermissionSettings(settings: LocalSettings): void {
  const document = pagePermissionDocument(settings);
  delete settings.pagePermissionDefaults;
  delete settings.sitePagePermissions;
  Object.assign(settings, document);
}

/** Changes one kind without widening scope or dropping the row's other kinds. */
export function setSitePagePermission(
  settings: LocalSettings,
  hostname: string,
  kind: PagePermissionKind,
  value: string,
): void {
  const rows = settings.sitePagePermissions ?? [];
  const previous = rows.find((entry) => entry.hostname === hostname);
  const permissions: SitePagePermissions["permissions"] = { ...previous?.permissions };
  if (value === "inherit") delete permissions[kind];
  else if (kind === "sign-in" && (value === "auto" || value === "fill")) permissions[kind] = value;
  else if (kind !== "sign-in" && (value === "fill" || value === "off")) permissions[kind] = value;
  else return;
  settings.sitePagePermissions = rows.filter((entry) => entry.hostname !== hostname);
  if (Object.keys(permissions).length)
    settings.sitePagePermissions.push({
      hostname,
      includeSubdomains: previous?.includeSubdomains ?? false,
      permissions,
    });
  normalizePagePermissionSettings(settings);
}

export function PagePermissionSelect({
  kind,
  value,
  inherited,
  disabled,
  id,
  onChange,
}: {
  kind: PagePermissionKind;
  value: string;
  inherited?: string;
  disabled?: boolean;
  id: string;
  onChange(value: string): void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <label className={fieldClass} htmlFor={id}>
      {pagePermissionName(kind, t)}
      <select
        id={id}
        className={controlClass}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {inherited && <option value="inherit">{inherited}</option>}
        {kind === "sign-in" ? (
          <option value="auto">{t("Auto")}</option>
        ) : (
          <option value="off">{t("Off")}</option>
        )}
        <option value="fill">{t("Fill only")}</option>
      </select>
    </label>
  );
}

export function PagePermissionNotes() {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <div className="flex flex-col gap-2 text-sm text-ink-muted">
      <p className="m-0">
        {t(
          "Auto fills and submits sign-in pages. Fill only leaves buttons, verification codes and software keyboards to you. Fields that advance or submit the page stay empty. Choosing an account in the popup logs in with presses.",
        )}
      </p>
      <p className="m-0">
        {t(
          "Verification pages are not filled yet. Off leaves them alone; Fill only keeps that choice for when filling is available. Passkey verification after a Pateat login is left to the browser in either mode.",
        )}
      </p>
      <p className="m-0">
        {t(
          "Filling personal details outside a login is not available yet. Its choices are saved for that feature. Personal details asked during a login follow the sign-in setting.",
        )}
      </p>
    </div>
  );
}
