import { siteRuleCovers, type LocalSettings } from "@pateat/contracts";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";

type ExcludedSite = LocalSettings["excludedSites"][number];

/** Which rules of a site list cover a hostname, and how the popup changes its own. */
function hostRules(rules: ExcludedSite[], hostname: string) {
  const covering = rules.filter((site) => siteRuleCovers(site, hostname));
  const own = (site: ExcludedSite) => site.hostname === hostname && !site.includeSubdomains;
  return {
    listed: covering.length > 0,
    editable: covering.every(own),
    /** The covering rules the popup cannot change; each includes subdomains. */
    shared: covering.filter((site) => !own(site)),
    /** The list with or without the hostname's own rule. */
    with: (list: ExcludedSite[], listed: boolean) =>
      listed
        ? [...list.filter((site) => !own(site)), { hostname, includeSubdomains: false }]
        : list.filter((site) => !own(site)),
  };
}

/** Whether the site asks for the master password before a re-prompt item is used. */
export function repromptSwitch(settings: LocalSettings, hostname: string) {
  const rules = hostRules(settings.repromptSites, hostname);
  return {
    on: rules.listed,
    editable: rules.editable,
    shared: rules.shared,
    set(value: LocalSettings, on: boolean) {
      value.repromptSites = rules.with(value.repromptSites, on);
    },
  };
}

/**
 * The site's switch for Bitwarden's master password re-prompt: on, a vault item with it
 * waits for the master password in Pateat's window before it fills or signs.
 */
export function RepromptSwitch({
  site,
  pending,
  busy,
  onChange,
  onOpenSettings,
}: {
  site: ReturnType<typeof repromptSwitch>;
  pending: boolean | undefined;
  busy: boolean;
  onChange: (on: boolean) => void;
  onOpenSettings: (event: { preventDefault(): void }) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const checked = pending ?? site.on;
  return (
    <div className="popup-section">
      <label className="popup-switch">
        <span>{t("Ask for the master password")}</span>
        <input
          id="popup-reprompt-switch"
          type="checkbox"
          role="switch"
          checked={checked}
          aria-checked={checked}
          disabled={!site.editable}
          aria-disabled={busy || undefined}
          aria-describedby="popup-reprompt-note"
          onChange={(event) => {
            if (!busy) onChange(event.target.checked);
          }}
        />
      </label>
      <p id="popup-reprompt-note" className="popup-muted">
        {site.editable
          ? t("For vault items with Bitwarden's master password re-prompt.")
          : t("Set by a rule for {{hostname}} and its subdomains.", {
              hostname: site.shared[0]?.hostname ?? "",
            })}
      </p>
      {!site.editable && (
        <a
          href="options.html"
          className="popup-link"
          aria-label={t("Change in settings for {{hostname}}", {
            hostname: site.shared[0]?.hostname ?? "",
          })}
          onClick={onOpenSettings}
        >
          {t("Change in settings")}
        </a>
      )}
    </div>
  );
}
