import { getPagePermissionDefaults, type LocalSettings } from "@pateat/contracts";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { enteredHostname } from "./allowed-sites";
import { Button } from "./button";
import {
  PAGE_PERMISSION_KINDS,
  PAGE_PERMISSIONS_SECTION,
  PagePermissionNotes,
  PagePermissionSelect,
  pagePermissionSource,
  setSitePagePermission,
  normalizePagePermissionSettings,
} from "./page-permission-controls";
import { checkClass, controlClass, fieldClass, Panel, RowList } from "./ui";

/** The same draft editor serves this device and the separately selected remote profile. */
export function PagePermissions({
  draft,
  edit,
  idPrefix = "",
}: {
  draft: LocalSettings;
  edit: (update: (settings: LocalSettings) => void) => boolean;
  idPrefix?: string;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const input = useRef<HTMLInputElement>(null);
  const [site, setSite] = useState("");
  const [subdomains, setSubdomains] = useState(false);
  const [behavior, setBehavior] = useState<"auto" | "fill">("fill");
  const [error, setError] = useState("");
  const defaults = getPagePermissionDefaults(draft);
  const rows = draft.sitePagePermissions ?? [];
  const prefix = `${idPrefix}page-permissions`;
  function add() {
    const hostname = enteredHostname(site);
    if (!hostname) setError("Enter a site such as https://bank.example or bank.example.");
    else if (rows.some((row) => row.hostname === hostname))
      setError("This site already has a rule. Edit it in the list.");
    else if (rows.length >= 1000)
      setError("There are already 1,000 site rules. Remove one before adding another.");
    else if (
      edit((settings) => {
        settings.sitePagePermissions = [
          ...(settings.sitePagePermissions ?? []),
          { hostname, includeSubdomains: subdomains, permissions: { "sign-in": behavior } },
        ];
        normalizePagePermissionSettings(settings);
      })
    ) {
      setSite("");
      setSubdomains(false);
      setError("");
    }
    input.current?.focus();
  }
  return (
    <Panel
      id={`${idPrefix}${PAGE_PERMISSIONS_SECTION}`}
      headingId={`${prefix}-heading`}
      title={t("Page behavior")}
    >
      <p className="m-0 text-sm text-ink-muted">
        {t(
          "These defaults and site rules are shared by devices using this settings profile. Pauses and allowed sites still decide where automatic login runs.",
        )}
      </p>
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-3 text-base font-semibold">{t("Profile defaults")}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {PAGE_PERMISSION_KINDS.map((kind) => (
            <PagePermissionSelect
              key={kind}
              id={`${prefix}-default-${kind}`}
              kind={kind}
              value={defaults[kind]}
              onChange={(selected) =>
                edit((settings) => {
                  const next = { ...getPagePermissionDefaults(settings) };
                  if (kind === "sign-in" && (selected === "auto" || selected === "fill"))
                    next[kind] = selected;
                  else if (kind !== "sign-in" && (selected === "fill" || selected === "off"))
                    next[kind] = selected;
                  settings.pagePermissionDefaults = next;
                  normalizePagePermissionSettings(settings);
                })
              }
            />
          ))}
        </div>
      </fieldset>
      <PagePermissionNotes />
      <section aria-labelledby={`${prefix}-sites-heading`} className="flex flex-col gap-3">
        <h3 id={`${prefix}-sites-heading`} className="m-0 text-base font-semibold">
          {t("Site rules")}
        </h3>
        <p className="m-0 text-sm text-ink-muted">
          {t(
            "Each page kind uses the most specific matching site's choice. A choice left at its default can still inherit a broader site's rule. Removing the last choice removes that site's rule.",
          )}
        </p>
        {!rows.length && (
          <p className="m-0 text-sm text-ink-muted">
            {t("No site rules. Every site uses the profile defaults.")}
          </p>
        )}
        <RowList id={`${prefix}-sites`}>
          {rows
            .toSorted((left, right) => left.hostname.localeCompare(right.hostname))
            .map((row) => (
              <li key={row.hostname} className="flex flex-col gap-3 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4
                    id={`${prefix}-${row.hostname}-heading`}
                    className="m-0 text-base font-semibold"
                  >
                    {row.hostname}
                  </h4>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={t("Remove page behavior for {{hostname}}", {
                      hostname: row.hostname,
                    })}
                    onClick={() => {
                      edit((settings) => {
                        settings.sitePagePermissions = (settings.sitePagePermissions ?? []).filter(
                          (entry) => entry.hostname !== row.hostname,
                        );
                        normalizePagePermissionSettings(settings);
                      });
                      input.current?.focus();
                    }}
                  >
                    {t("Remove")}
                  </Button>
                </div>
                <label className={checkClass}>
                  <input
                    type="checkbox"
                    checked={row.includeSubdomains}
                    onChange={(event) => {
                      const included = event.target.checked;
                      edit((settings) => {
                        const current = settings.sitePagePermissions?.find(
                          (entry) => entry.hostname === row.hostname,
                        );
                        if (current) current.includeSubdomains = included;
                        normalizePagePermissionSettings(settings);
                      });
                    }}
                  />
                  {t("Apply to subdomains too")}
                </label>
                <fieldset
                  aria-labelledby={`${prefix}-${row.hostname}-heading`}
                  className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3"
                >
                  {PAGE_PERMISSION_KINDS.map((kind) => (
                    <PagePermissionSelect
                      key={kind}
                      id={`${prefix}-${row.hostname}-${kind}`}
                      kind={kind}
                      value={row.permissions[kind] ?? "inherit"}
                      inherited={pagePermissionSource(draft, row.hostname, kind, t)}
                      onChange={(selected) =>
                        edit((settings) =>
                          setSitePagePermission(settings, row.hostname, kind, selected),
                        )
                      }
                    />
                  ))}
                </fieldset>
              </li>
            ))}
        </RowList>
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={fieldClass}>
              {t("Site")}
              <input
                ref={input}
                id={`${prefix}-site`}
                className={controlClass}
                value={site}
                autoComplete="off"
                placeholder="bank.example"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${prefix}-error` : undefined}
                onChange={(event) => {
                  setSite(event.target.value);
                  setError("");
                }}
              />
            </label>
            <PagePermissionSelect
              kind="sign-in"
              id={`${prefix}-new-sign-in`}
              value={behavior}
              onChange={(value) => {
                if (value === "auto" || value === "fill") setBehavior(value);
              }}
            />
          </div>
          <label className={checkClass}>
            <input
              type="checkbox"
              checked={subdomains}
              onChange={(event) => setSubdomains(event.target.checked)}
            />
            {t("Apply to subdomains too")}
          </label>
          {error && (
            <p id={`${prefix}-error`} role="alert" className="validation-error m-0">
              {t(error)}
            </p>
          )}
          <div>
            <Button id={`${prefix}-add`} type="submit" variant="outline">
              {t("Add site rule")}
            </Button>
          </div>
        </form>
      </section>
    </Panel>
  );
}
