import {
  normalizeHostname,
  parseSiteUrl,
  resolvePagePermission,
  type LocalSettings,
} from "@pateat/contracts";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Button } from "../options/button";
import {
  PAGE_PERMISSION_KINDS,
  PAGE_PERMISSIONS_SECTION,
  PagePermissionSelect,
  pagePermissionLabel,
  pagePermissionName,
  pagePermissionSource,
  setSitePagePermission,
} from "../options/page-permission-controls";

/** Popup writes an exact-host rule; broader rules are edited with their scope in Settings. */
export function PopupPagePermissions({
  settings,
  origin,
  disabled,
  onChange,
  onOpenSettings,
}: {
  settings: LocalSettings;
  origin: string;
  disabled: boolean;
  onChange(update: (settings: LocalSettings) => void): void;
  onOpenSettings(section: string): void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const url = parseSiteUrl(origin);
  const hostname = url && normalizeHostname(url.hostname);
  if (!hostname) return null;
  const row = settings.sitePagePermissions?.find((entry) => entry.hostname === hostname);
  const broad = row?.includeSubdomains === true;
  const full = !row && (settings.sitePagePermissions?.length ?? 0) >= 1000;
  return (
    <section className="popup-section" aria-labelledby="popup-page-permissions-heading">
      <h2 id="popup-page-permissions-heading">{t("Page behavior")}</h2>
      {!broad && (
        <p className="popup-muted">
          {t("Changes here apply to {{hostname}} only and sync with this settings profile.", {
            hostname,
          })}
        </p>
      )}
      {broad ? (
        <>
          <p className="popup-muted">
            {t(
              "This host's saved rule also covers its subdomains. Edit it in Settings to keep its scope clear.",
            )}
          </p>
          <ul className="m-0 list-none p-0">
            {PAGE_PERMISSION_KINDS.map((kind) => {
              const selected = resolvePagePermission(settings, origin, kind);
              return (
                selected && (
                  <li key={kind}>
                    {pagePermissionName(kind, t)}: {pagePermissionLabel(selected.permission, t)} —{" "}
                    {selected.source === "site"
                      ? t("Rule for {{hostname}}", { hostname: selected.hostname })
                      : t("Profile default")}
                  </li>
                )
              );
            })}
          </ul>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {PAGE_PERMISSION_KINDS.map((kind) => (
            <PagePermissionSelect
              key={kind}
              kind={kind}
              id={`popup-page-permission-${kind}`}
              value={row?.permissions[kind] ?? "inherit"}
              inherited={pagePermissionSource(settings, hostname, kind, t)}
              disabled={disabled || full}
              onChange={(value) =>
                onChange((draft) => setSitePagePermission(draft, hostname, kind, value))
              }
            />
          ))}
        </div>
      )}
      {full && (
        <p className="popup-muted">
          {t("There are already 1,000 site rules. Remove one before adding another.")}
        </p>
      )}
      <p className="popup-muted">
        {t(
          "Fill only leaves buttons, verification codes and software keyboards to you. A popup account choice still logs in with presses. Verification pages are not filled yet; Off leaves them alone. Other personal-detail forms are not filled yet.",
        )}
      </p>
      <Button
        type="button"
        variant="ghost"
        onClick={() => onOpenSettings(PAGE_PERMISSIONS_SECTION)}
      >
        {t("Edit profile defaults and site rules")}
      </Button>
    </section>
  );
}
