import { normalizeHostname, parseSiteUrl, type LocalSettings } from "@pateat/contracts";
import { Ban, Check, Info, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Button } from "./button";
import { checkClass, controlClass, fieldClass, Panel, RowList, RowTitle, StatusLines } from "./ui";

type SiteRule = NonNullable<LocalSettings["allowedSites"]>[number];

/** The hostname an entered origin or hostname names, or undefined for anything with a path. */
export function enteredHostname(value: string): string | undefined {
  const entered = value.trim();
  if (!entered.includes("://")) return normalizeHostname(entered);
  const url = parseSiteUrl(entered);
  const rest = entered.slice(entered.indexOf("://") + 3);
  return url && !/[/?#]./u.test(rest) && !/[?#]/u.test(rest)
    ? normalizeHostname(url.hostname)
    : undefined;
}

/**
 * The allowed sites (ADR 0077): while they are on, Pateat runs only on the sites listed
 * here, and the exclusions under Sites still win. Turning them off keeps the list.
 */
export function AllowedSites({
  draft,
  edit,
  idPrefix = "",
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
  /** Keeps ids unique when a second copy edits another profile. */
  idPrefix?: string;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const input = useRef<HTMLInputElement>(null);
  const [site, setSite] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [error, setError] = useState("");
  const rules = draft.allowedSites ?? [];
  const on = draft.allowedSitesEnabled === true;
  const ruleName = (rule: SiteRule) =>
    rule.includeSubdomains
      ? t("{{hostname}} and subdomains", { hostname: rule.hostname })
      : rule.hostname;
  function allow() {
    const hostname = enteredHostname(site);
    if (!hostname) {
      setError("Enter a site such as https://bank.example or bank.example.");
      input.current?.focus();
      return;
    }
    const added = edit((settings) => {
      settings.allowedSites = [
        ...(settings.allowedSites ?? []).filter((entry) => entry.hostname !== hostname),
        { hostname, includeSubdomains },
      ];
    });
    if (!added) return;
    setSite("");
    setIncludeSubdomains(false);
    setError("");
    input.current?.focus();
  }
  return (
    <Panel
      id={`${idPrefix}allowed-sites`}
      headingId={`${idPrefix}allowed-sites-heading`}
      title={t("Allowed sites")}
    >
      <label className={checkClass}>
        <input
          id={`${idPrefix}allowed-sites-on`}
          type="checkbox"
          // A checkbox exposes its own checked state to the switch role.
          // oxlint-disable-next-line jsx-a11y/role-has-required-aria-props
          role="switch"
          checked={on}
          onChange={(event) => {
            const next = event.target.checked;
            edit((settings) => {
              settings.allowedSitesEnabled = next;
            });
          }}
        />
        {t("Run only on allowed sites")}
      </label>
      {rules.length > 0 && (
        <RowList id={`${idPrefix}allowed-site-list`}>
          {rules.map((rule) => (
            <li
              key={rule.hostname}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <RowTitle>
                <span>{ruleName(rule)}</span>
              </RowTitle>
              <Button
                type="button"
                variant="outline"
                aria-label={t("Remove {{name}} from the allowed sites", { name: ruleName(rule) })}
                onClick={() => {
                  edit((settings) => {
                    settings.allowedSites = (settings.allowedSites ?? []).filter(
                      (entry) => entry.hostname !== rule.hostname,
                    );
                  });
                  input.current?.focus();
                }}
              >
                {t("Remove")}
              </Button>
            </li>
          ))}
        </RowList>
      )}
      <StatusLines
        muted={!(on && !rules.length)}
        lines={[
          on
            ? rules.length
              ? {
                  tone: "idle",
                  icon: Info,
                  text: t("Pateat runs only on these sites."),
                }
              : {
                  tone: "warn",
                  icon: TriangleAlert,
                  text: t("No site is allowed, so Pateat logs in nowhere until you allow one."),
                }
            : {
                tone: "idle",
                icon: Info,
                text: t("While this is off, Pateat runs on every site that is not excluded."),
              },
        ]}
      />
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          allow();
        }}
      >
        <label className={fieldClass}>
          {t("Site")}
          <input
            ref={input}
            id={`${idPrefix}allowed-site`}
            className={controlClass}
            type="text"
            placeholder="bank.example"
            autoComplete="off"
            aria-describedby={error ? `${idPrefix}allowed-site-error` : undefined}
            aria-invalid={Boolean(error)}
            value={site}
            onChange={(event) => {
              setSite(event.target.value);
              setError("");
            }}
          />
        </label>
        <label className={checkClass}>
          <input
            id={`${idPrefix}allowed-site-subdomains`}
            type="checkbox"
            checked={includeSubdomains}
            onChange={(event) => setIncludeSubdomains(event.target.checked)}
          />
          {t("Allow subdomains too")}
        </label>
        {error && (
          <p id={`${idPrefix}allowed-site-error`} className="validation-error m-0" role="alert">
            {t(error)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button id={`${idPrefix}add-allowed-site`} type="submit" variant="outline">
            <Check aria-hidden size={16} strokeWidth={2} />
            {t("Allow site")}
          </Button>
        </div>
      </form>
      <StatusLines
        muted
        lines={[
          { tone: "idle", icon: Ban, text: t("Exclusions under Sites win over allowed sites.") },
          {
            tone: "idle",
            icon: Info,
            text: t("Turning this off keeps the list. The Pateat popup can allow the open site."),
          },
        ]}
      />
    </Panel>
  );
}
