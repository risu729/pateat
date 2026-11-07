import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  isSiteExcluded,
  normalizeHostname,
  parseSiteUrl,
  type LocalSettings,
  type SiteAccountsResponse,
  type VaultCatalog,
} from "@pateat/contracts";
import { useForm, useSelector } from "@tanstack/react-form";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Clock, Info, LockKeyhole, Pause } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as v from "valibot";

import { Button } from "./button";
import { checkClass, controlClass, fieldClass, Panel, RowList, StatusLines } from "./ui";

import { createSitePolicyRows, SiteRow } from "./site-policy-rows";
import {
  siteAccountOptions,
  matchedBy,
  defaultFor,
  replaceDefault,
  hostOf,
} from "./site-policy-rules";
export { siteAccountOptions } from "./site-policy-rules";
/**
 * An HTTP(S) origin with nothing after the host and port, as its canonical `URL.origin`:
 * the scheme and host in lowercase, a Unicode host in punycode, and no default port.
 */
const originSchema = v.pipe(
  v.string(),
  v.trim(),
  v.check((value) => {
    const url = parseSiteUrl(value);
    const rest = value.slice(value.indexOf("//") + 2);
    return Boolean(url && !/[/?#]/.test(rest) && normalizeHostname(url.hostname));
  }, "Enter an origin such as https://bank.example, without a path or trailing slash."),
  v.transform((value) => new URL(value).origin),
);

export const SITE_ACCOUNTS_DELAY_MS = 300;
const WAIT_FOR_ACCOUNTS = "Wait until the matching accounts are listed.";

/**
 * The sites whose passkey requests go to the browser, added by the passkey window's "Always
 * for this site" (ADR 0007). They are only removed here; removing one lets Pateat answer the
 * site's next passkey request again.
 */
function PasskeyBrowserSites({
  draft,
  edit,
  idPrefix,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const heading = useRef<HTMLHeadingElement>(null);
  const sites = draft.passkeyBrowserSites.toSorted((left, right) =>
    left.hostname.localeCompare(right.hostname),
  );
  return (
    <section aria-labelledby={`${idPrefix}passkey-browser-heading`} className="flex flex-col gap-3">
      <h3
        id={`${idPrefix}passkey-browser-heading`}
        ref={heading}
        tabIndex={-1}
        className="m-0 text-base leading-6 font-[650] outline-none"
      >
        {t("Sites whose passkey requests go to the browser")}
      </h3>
      <p className="m-0 text-[0.8125rem] leading-5 text-ink-muted">
        {t(
          'Added with "Always for this site" in Pateat\'s passkey window. Pateat answers no passkey request on these sites and logs in there only with a password. Remove a site to let Pateat answer again.',
        )}
      </p>
      <RowList id={`${idPrefix}passkey-browser-sites`}>
        {sites.map((site) => (
          <SiteRow
            key={site.hostname}
            title={site.hostname}
            controls={
              <Button
                type="button"
                variant="outline"
                aria-label={t("Remove {{hostname}} from this list", { hostname: site.hostname })}
                onClick={() => {
                  // The row goes away, so focus moves to the list's heading.
                  if (
                    edit((settings) => {
                      settings.passkeyBrowserSites = settings.passkeyBrowserSites.filter(
                        (entry) => entry.hostname !== site.hostname,
                      );
                    })
                  )
                    heading.current?.focus();
                }}
              >
                {t("Remove")}
              </Button>
            }
          />
        ))}
      </RowList>
      {!sites.length && (
        <StatusLines muted lines={[{ tone: "idle", icon: Info, text: t("No sites listed") }]} />
      )}
    </section>
  );
}

export function SitePolicy({
  idPrefix = "",
  draft,
  catalog,
  edit,
  findSiteAccounts,
}: {
  idPrefix?: string;
  draft: LocalSettings;
  catalog: VaultCatalog;
  edit: (update: (value: LocalSettings) => void) => boolean;
  /** Asks the background which saved-settings items match an origin. */
  findSiteAccounts: (origin: string, settings: LocalSettings) => Promise<SiteAccountsResponse>;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const originInput = useRef<HTMLInputElement>(null);
  const accountSelect = useRef<HTMLSelectElement>(null);
  const [siteError, setSiteError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const siteForm = useForm({
    defaultValues: { origin: "", account: "", includeSubdomains: false },
    onSubmit: ({ value }) => {
      const validated = v.safeParse(originSchema, value.origin);
      if (!validated.success) {
        fail(validated.issues[0].message);
        return;
      }
      if (accountsPending) {
        setSiteError("");
        setAccountError(WAIT_FOR_ACCOUNTS);
        return;
      }
      const origin = validated.output;
      // Only an item listed for the origin entered can be chosen.
      const selected =
        found?.origin === origin
          ? (accountOptions.find((entry) => entry.value === value.account) ?? accountOptions[0])
          : undefined;
      const next = defaultFor(origin, selected, catalog);
      if (!next.ok) {
        // The origin is valid; the error belongs to the account select.
        setSiteError("");
        setAccountError(next.message);
        const select = accountSelect.current;
        if (select && !select.disabled) select.focus();
        else originInput.current?.focus();
        return;
      }
      if (!edit((settings) => replaceDefault(settings, origin, next.value))) return;
      siteForm.setFieldValue("origin", "");
      siteForm.setFieldValue("account", "");
      setSiteError("");
      setAccountError("");
      originInput.current?.focus();
    },
  });
  function fail(message: string) {
    setSiteError(message);
    setAccountError("");
    originInput.current?.focus();
  }
  /** Adds the entered site, with its subdomains if checked, to a site list. */
  function addEntered(list: "excludedSites" | "repromptSites") {
    const entered = siteForm.state.values.origin.trim();
    const hostname = v.is(originSchema, entered)
      ? normalizeHostname(new URL(entered).hostname)
      : normalizeHostname(entered);
    if (!hostname) {
      fail("Enter a site such as https://bank.example or bank.example.");
      return;
    }
    const includeSubdomains = siteForm.state.values.includeSubdomains;
    const added = edit((settings) => {
      settings[list] = settings[list].filter((entry) => entry.hostname !== hostname);
      settings[list].push({ hostname, includeSubdomains });
    });
    if (!added) return;
    siteForm.reset();
    setSiteError("");
    setAccountError("");
    originInput.current?.focus();
  }

  const enteredOrigin = useSelector(siteForm.store, (state) => state.values.origin.trim());
  const parsedOrigin = v.safeParse(originSchema, enteredOrigin);
  const accountOrigin = parsedOrigin.success ? parsedOrigin.output : undefined;
  // Each search queries every live vault, so wait until typing pauses.
  const [queriedOrigin, setQueriedOrigin] = useState<string>();
  useEffect(() => {
    const timer = setTimeout(() => setQueriedOrigin(accountOrigin), SITE_ACCOUNTS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [accountOrigin]);
  // The draft's connections, items and exclusions decide what is searched.
  // A vault sync changes the answer too, so each connection's snapshot is part of the key.
  const scope = JSON.stringify([
    draft.connections,
    draft.excludedSites,
    catalog.connections.map((entry) => entry.snapshotId ?? null),
  ]);
  const accounts = useQuery({
    queryKey: ["settings", "site-accounts", queriedOrigin, scope],
    queryFn: () => findSiteAccounts(queriedOrigin!, draft),
    enabled: queriedOrigin !== undefined && queriedOrigin === accountOrigin,
    // Vault syncs change the answer; ask again for each origin entered.
    staleTime: 0,
    gcTime: 0,
  });
  // Each saved default that is in use is matched the same way: its row offers the matching
  // accounts, and shows how and as whom the saved one matches.
  const savedOrigins = draft.siteDefaults
    .map((selected) => selected.origin)
    .filter((origin) => !isSiteExcluded(draft, origin));
  const savedMatches = useQueries({
    queries: savedOrigins.map((origin) => ({
      queryKey: ["settings", "site-accounts", origin, scope],
      queryFn: () => findSiteAccounts(origin, draft),
      staleTime: 0,
      gcTime: 0,
    })),
  });
  const savedMatch = (origin: string) => {
    const answer = savedMatches[savedOrigins.indexOf(origin)]?.data;
    return answer?.ok && answer.origin === origin ? answer : undefined;
  };
  const accountsPending =
    accountOrigin !== undefined && (queriedOrigin !== accountOrigin || accounts.isPending);
  // The wait message no longer applies once the accounts are listed.
  const accountMessage = accountError === WAIT_FOR_ACCOUNTS && !accountsPending ? "" : accountError;
  const found =
    !accountsPending && accounts.data?.ok && accounts.data.origin === accountOrigin
      ? accounts.data
      : undefined;
  const accountOptions = siteAccountOptions(catalog, found, showAllAccounts, draft);
  const matchedCount = accountOptions.filter((entry) => entry.uri || entry.passkey).length;
  const selectedAccount = useSelector(siteForm.store, (state) => state.values.account);
  const shownAccount = accountOptions.some((entry) => entry.value === selectedAccount)
    ? selectedAccount
    : (accountOptions[0]?.value ?? "");
  let accountNote: string;
  if (accountOrigin === undefined)
    accountNote = t("Enter an origin to list the accounts that match it.");
  else if (accountsPending) accountNote = t("Finding the vault items that match this origin…");
  else if (accounts.isError || (accounts.data && !accounts.data.ok))
    accountNote = t("The matching accounts could not be listed.");
  else if (!matchedCount)
    accountNote = t(
      "No vault item matches this origin. Add the site's URI or passkey to the item in your vault, then sync.",
    );
  else accountNote = t("matchingItems", { count: matchedCount });
  if (found && !found.complete)
    accountNote += t(" Some vaults or items could not be checked, so this list may be incomplete.");

  const { originRow, ruleRow, repromptRow } = createSitePolicyRows({
    t,
    idPrefix,
    draft,
    catalog,
    edit,
    savedMatch,
    originInput,
  });

  // Rules and origins together, by hostname; a rule comes before the origins on its host.
  const rows = [
    ...draft.excludedSites.map((rule) => ({
      hostname: rule.hostname,
      order: `0 ${rule.hostname}`,
      row: () => ruleRow(rule),
    })),
    ...draft.repromptSites.map((rule) => ({
      hostname: rule.hostname,
      order: `2 ${rule.hostname}`,
      row: () => repromptRow(rule),
    })),
    ...draft.siteDefaults
      .filter((entry) => !isSiteExcluded(draft, entry.origin))
      .map((entry) => ({
        hostname: hostOf(entry.origin),
        order: `1 ${entry.origin}`,
        row: () => originRow(entry),
      })),
  ].sort(
    (left, right) =>
      left.hostname.localeCompare(right.hostname) || left.order.localeCompare(right.order),
  );

  return (
    <Panel id={`${idPrefix}sites`} headingId={`${idPrefix}sites-heading`} title={t("Sites")}>
      <RowList id={`${idPrefix}site-list`}>{rows.map((entry) => entry.row())}</RowList>
      {!rows.length && (
        <StatusLines
          muted
          lines={[{ tone: "idle", icon: Info, text: t("No paused sites or default accounts") }]}
        />
      )}
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void siteForm.handleSubmit();
        }}
      >
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <siteForm.Field name="origin">
            {(field) => (
              <label className={`${fieldClass} flex-[1_1_260px]`}>
                {t("Origin")}
                <input
                  ref={originInput}
                  id={`${idPrefix}site-origin`}
                  className={controlClass}
                  type="text"
                  placeholder="https://bank.example"
                  autoComplete="off"
                  aria-describedby={siteError ? `${idPrefix}site-error` : undefined}
                  aria-invalid={Boolean(siteError)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setSiteError("");
                    setAccountError("");
                  }}
                />
              </label>
            )}
          </siteForm.Field>
          <siteForm.Field name="account">
            {(field) => (
              <div className="flex flex-[1_1_220px] flex-col gap-1.5">
                <label className={fieldClass}>
                  {t("Default account")}
                  <select
                    ref={accountSelect}
                    id={`${idPrefix}default-account`}
                    className={controlClass}
                    aria-describedby={
                      accountMessage
                        ? `${idPrefix}default-account-error ${idPrefix}default-account-note`
                        : `${idPrefix}default-account-note`
                    }
                    aria-invalid={Boolean(accountMessage)}
                    disabled={!accountOptions.length}
                    value={shownAccount}
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      setAccountError("");
                    }}
                  >
                    {catalog.connections.map((connection) => {
                      const options = accountOptions.filter(
                        (entry) => entry.connectionId === connection.id,
                      );
                      return options.length ? (
                        <optgroup key={connection.id} label={connection.label}>
                          {options.map((option) => (
                            <option key={option.itemId} value={option.value}>
                              {t("{{item}} ({{method}})", {
                                item: option.label,
                                method: t(matchedBy(option)),
                              })}
                            </option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </select>
                </label>
                <p
                  id={`${idPrefix}default-account-note`}
                  className="m-0 text-[0.8125rem] leading-5 text-ink-muted"
                  aria-live="polite"
                >
                  {accountNote}
                </p>
              </div>
            )}
          </siteForm.Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <label className={checkClass}>
            <input
              id={`${idPrefix}default-account-all`}
              type="checkbox"
              checked={showAllAccounts}
              onChange={(event) => {
                setShowAllAccounts(event.target.checked);
                setAccountError("");
              }}
            />
            {t("Also list items that do not match")}
          </label>
          <siteForm.Field name="includeSubdomains">
            {(field) => (
              <label className={checkClass}>
                <input
                  id={`${idPrefix}site-subdomains`}
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                {t("Include subdomains")}
              </label>
            )}
          </siteForm.Field>
        </div>
        {siteError && (
          <p id={`${idPrefix}site-error`} className="validation-error m-0" role="alert">
            {t(siteError)}
          </p>
        )}
        {accountMessage && (
          <p id={`${idPrefix}default-account-error`} className="validation-error m-0" role="alert">
            {t(accountMessage)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button id={`${idPrefix}add-default`} type="submit">
            {t("Save default")}
          </Button>
          <Button
            id={`${idPrefix}add-site`}
            type="button"
            variant="outline"
            onClick={() => addEntered("excludedSites")}
          >
            <Pause aria-hidden size={16} strokeWidth={2} />
            {t("Pause site")}
          </Button>
          <Button
            id={`${idPrefix}add-reprompt-site`}
            type="button"
            variant="outline"
            onClick={() => addEntered("repromptSites")}
          >
            <LockKeyhole aria-hidden size={16} strokeWidth={2} />
            {t("Ask for the master password")}
          </Button>
        </div>
      </form>
      <StatusLines
        muted
        lines={[
          {
            tone: "idle",
            icon: Pause,
            text: t(
              "A paused site stays paused on every scheme and port, on all your devices, until it is resumed.",
            ),
          },
          {
            tone: "idle",
            icon: Info,
            text: t(
              "On a paused site Pateat logs in only with an account picked in the toolbar popup.",
            ),
          },
          {
            tone: "idle",
            icon: LockKeyhole,
            text: t(
              "On a site that asks for the master password, a vault item with Bitwarden's master password re-prompt is used only after you enter it in Pateat's window. Elsewhere it is used like any other item.",
            ),
          },
          {
            tone: "idle",
            icon: Clock,
            text: t("A default account takes effect at the next login."),
          },
        ]}
      />
      <PasskeyBrowserSites draft={draft} edit={edit} idPrefix={idPrefix} />
    </Panel>
  );
}
