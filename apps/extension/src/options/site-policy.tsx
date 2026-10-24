import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  getItemEligibility,
  isSiteExcluded,
  normalizeHostname,
  parseSiteUrl,
  resolveSiteAccount,
  siteDefaultConnection,
  type LocalSettings,
  type SiteAccountsResponse,
  type SiteDefault,
  type VaultCatalog,
} from "@pateat/contracts";
import { useForm, useSelector } from "@tanstack/react-form";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  Clock,
  Info,
  LockKeyhole,
  Pause,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as v from "valibot";
import { pauseSite } from "../login/pause";
import { unavailableReason } from "./unavailable-reason";
import { Button } from "./button";
import {
  Badge,
  checkClass,
  controlClass,
  fieldClass,
  Panel,
  RowList,
  RowTitle,
  StatusLines,
  type Tone,
} from "./ui";

type ExcludedSite = LocalSettings["excludedSites"][number];
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

type SiteAccountOption = {
  connectionId: string;
  connectionLabel: string;
  provider: string;
  server: string;
  userId: string | undefined;
  itemId: string;
  itemName: string;
  uri: boolean;
  passkey: boolean;
  value: string;
  /** The item name, then the login username when it matched, then an ID prefix if still ambiguous. */
  label: string;
};

/** Whether the draft lets an item be used at all; a passkey-only item has no fields. */
function draftAllows(
  draft: LocalSettings,
  catalog: VaultCatalog,
  connectionId: string,
  itemId: string,
) {
  const connection = catalog.connections.find((entry) => entry.id === connectionId);
  if (connection?.quarantinedItemIds?.includes(itemId)) return false;
  const eligibility = getItemEligibility(draft, catalog, connectionId, itemId);
  return (
    eligibility.eligible ||
    (eligibility.reason === "fields-excluded" &&
      connection?.items.find((entry) => entry.id === itemId)?.fields.length === 0)
  );
}

/**
 * Matched items that are still in the catalog, matched ones first, each group in catalog
 * order. With `all`, every other item the draft allows is listed too, for a URI rule on a
 * deeper path that `origin/` does not match.
 */
export function siteAccountOptions(
  catalog: VaultCatalog,
  found: Extract<SiteAccountsResponse, { ok: true }> | undefined,
  all: boolean,
  draft: LocalSettings,
): SiteAccountOption[] {
  if (!found) return [];
  const options = catalog.connections.flatMap((connection) =>
    connection.items.flatMap((item) => {
      const match = found.accounts.find(
        (entry) => entry.connectionId === connection.id && entry.itemId === item.id,
      );
      return match || (all && draftAllows(draft, catalog, connection.id, item.id))
        ? [
            {
              connectionId: connection.id,
              connectionLabel: connection.label,
              provider: connection.provider,
              server: connection.server,
              userId: connection.userId,
              itemId: item.id,
              itemName: item.label,
              uri: match?.uri ?? false,
              passkey: match?.passkey ?? false,
              value: JSON.stringify([connection.id, item.id]),
              label: match?.username ? `${item.label} · ${match.username}` : item.label,
            },
          ]
        : [];
    }),
  );
  options.sort(
    (left, right) => Number(right.uri || right.passkey) - Number(left.uri || left.passkey),
  );
  const seen = new Map<string, number>();
  for (const option of options) {
    const key = JSON.stringify([option.connectionId, option.label]);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return options.map((option) =>
    (seen.get(JSON.stringify([option.connectionId, option.label])) ?? 0) > 1
      ? { ...option, label: `${option.label} · ID ${option.itemId.slice(0, 8)}` }
      : option,
  );
}

function matchedBy(option: Pick<SiteAccountOption, "uri" | "passkey">): string {
  if (option.uri && option.passkey) return "URI and passkey";
  if (option.uri) return "URI";
  return option.passkey ? "passkey" : "no match for this origin";
}

export const SITE_ACCOUNTS_DELAY_MS = 300;
const WAIT_FOR_ACCOUNTS = "Wait until the matching accounts are listed.";
/** The select value that removes an origin's default. */
const NO_DEFAULT = "";
/** The select value of a saved default that no connection here names. */
const SAVED_ELSEWHERE = "saved";

/**
 * The default an option makes for an origin, or why it cannot be saved. A default names the
 * account, so it must lead back to the chosen connection.
 */
function defaultFor(
  origin: string,
  option: SiteAccountOption | undefined,
  catalog: VaultCatalog,
): { ok: true; value: SiteDefault } | { ok: false; message: string } {
  const userId = option?.userId;
  if (!option || !userId) return { ok: false, message: "Choose an available default account." };
  const value = {
    origin,
    provider: option.provider,
    server: option.server,
    userId,
    itemId: option.itemId,
    itemName: option.itemName,
    accountName: option.connectionLabel,
  };
  const mapped = siteDefaultConnection(value, catalog);
  if (!mapped.ok || mapped.connectionId !== option.connectionId)
    return {
      ok: false,
      message: unavailableReason(mapped.ok ? "account-ambiguous" : mapped.reason),
    };
  return { ok: true, value };
}

function replaceDefault(settings: LocalSettings, origin: string, value?: SiteDefault) {
  settings.siteDefaults = settings.siteDefaults.filter((entry) => entry.origin !== origin);
  if (value) settings.siteDefaults.push(value);
}

function ruleName(rule: ExcludedSite): string {
  return rule.includeSubdomains
    ? i18n.t("{{hostname}} and subdomains", { hostname: rule.hostname })
    : rule.hostname;
}

/** The hostname an exclusion rule names for an origin, without a trailing dot. */
function hostOf(origin: string): string {
  const hostname = new URL(origin).hostname;
  return normalizeHostname(hostname) ?? hostname;
}

function ruleMatches(rule: ExcludedSite, origin: string): boolean {
  const hostname = hostOf(origin);
  return (
    hostname === rule.hostname || (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`))
  );
}

/** The rule a default is listed under: the most specific of the rules that exclude it. */
function ruleFor(rules: ExcludedSite[], origin: string): ExcludedSite | undefined {
  return rules
    .filter((rule) => ruleMatches(rule, origin))
    .sort(
      (left, right) =>
        right.hostname.length - left.hostname.length ||
        Number(left.includeSubdomains) - Number(right.includeSubdomains),
    )[0];
}

/**
 * One site in the list: what it is, its state lines, and the controls that act on it. Each
 * kind of row passes its own controls, so another per-site setting adds controls here.
 */
function SiteRow({
  title,
  badges,
  lines,
  controls,
}: {
  title: string;
  badges?: ReactNode;
  lines?: ReactNode;
  controls: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
        <RowTitle>
          <span>{title}</span>
          {badges}
        </RowTitle>
        {lines}
      </div>
      <div className="flex flex-[2_1_380px] flex-wrap items-center justify-end gap-2">
        {controls}
      </div>
    </li>
  );
}

/** The default account control of an origin row: its select and an explicit Save. */
function DefaultAccountEditor({
  idPrefix,
  origin,
  options,
  current,
  save,
}: {
  idPrefix: string;
  origin: string;
  options: { value: string; text: string }[];
  current: string;
  save: (value: string) => string | undefined;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [choice, setChoice] = useState<string>();
  const [error, setError] = useState("");
  // A choice the list no longer offers falls back to the saved value.
  const shown =
    choice !== undefined && options.some((entry) => entry.value === choice) ? choice : current;
  const errorId = `${idPrefix}site-default-error-${origin}`;
  return (
    <>
      <label className="contents">
        <span className="visually-hidden">{t("Default account for {{origin}}", { origin })}</span>
        <select
          className={`${controlClass} max-w-[18.75rem] flex-[1_1_220px]`}
          value={shown}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setChoice(event.target.value);
            setError("");
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="outline"
        aria-label={t("Save default for {{origin}}", { origin })}
        disabled={shown === current}
        onClick={() => {
          const failure = save(shown);
          setError(failure ?? "");
          if (!failure) setChoice(undefined);
        }}
      >
        {t("Save")}
      </Button>
      {error && (
        <p id={errorId} className="validation-error m-0 basis-full text-right" role="alert">
          {t(error)}
        </p>
      )}
    </>
  );
}

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
    accountNote =
      accounts.data?.ok === false && accounts.data.reason === "site-not-allowed"
        ? t("This site is not an allowed site.")
        : t("The matching accounts could not be listed.");
  else if (!matchedCount)
    accountNote = t(
      "No vault item matches this origin. Add the site's URI or passkey to the item in your vault, then sync.",
    );
  else accountNote = t("matchingItems", { count: matchedCount });
  if (found && !found.complete)
    accountNote += t(" Some vaults or items could not be checked, so this list may be incomplete.");

  /** An origin row: its default account, editable in place, and a way to exclude its host. */
  function originRow(selected: SiteDefault) {
    const { origin } = selected;
    const mapped = siteDefaultConnection(selected, catalog);
    const connection = mapped.ok
      ? catalog.connections.find((entry) => entry.id === mapped.connectionId)
      : undefined;
    const item = connection?.items.find((entry) => entry.id === selected.itemId);
    const resolved = resolveSiteAccount(draft, catalog, origin);
    // A live vault item has no static origins; its URI rules (or a passkey) are
    // checked against each page, so the draft policy cannot call it a mismatch.
    const liveItem = Boolean(item && connection?.snapshotId);
    const matches = savedMatch(origin);
    const match = liveItem
      ? matches?.accounts.find(
          (entry) => entry.connectionId === connection?.id && entry.itemId === item?.id,
        )
      : undefined;
    let line: { tone: Tone; icon: LucideIcon; text: string } | undefined;
    if (resolved.ok) line = undefined;
    else if (!liveItem || resolved.reason !== "item-origin-mismatch")
      line = { tone: "warn", icon: TriangleAlert, text: t(unavailableReason(resolved.reason)) };
    else if (match)
      line = {
        tone: "ok",
        icon: CircleCheck,
        text: t("Matches this origin by {{method}}. It is checked again at each login.", {
          method: t(matchedBy({ uri: match.uri, passkey: match.passkey })),
        }),
      };
    else if (matches?.complete && !connection?.quarantinedItemIds?.includes(selected.itemId))
      line = {
        tone: "warn",
        icon: TriangleAlert,
        text: t(
          "No URI rule or passkey of this item matches this origin. A URI rule on a longer path is checked at each login.",
        ),
      };
    else
      line = {
        tone: "idle",
        icon: Info,
        text: t(
          "Whether it matches a page is checked against its URI rules or passkeys at each login.",
        ),
      };
    const unavailable = !resolved.ok && (!liveItem || resolved.reason !== "item-origin-mismatch");
    const current = connection && item ? JSON.stringify([connection.id, item.id]) : SAVED_ELSEWHERE;
    const offered = siteAccountOptions(catalog, matches, false, draft);
    const currentText = t("{{item}} in {{account}}{{availability}}", {
      item: `${item?.label ?? selected.itemName ?? selected.itemId}${match?.username ? ` · ${match.username}` : ""}`,
      account:
        connection?.label ?? selected.accountName ?? t("account {{id}}", { id: selected.userId }),
      availability: !connection
        ? t(" (not available here)")
        : unavailable
          ? t(" (unavailable)")
          : "",
    });
    const options = [
      ...(offered.some((entry) => entry.value === current)
        ? []
        : [{ value: current, text: currentText }]),
      ...offered.map((entry) => ({
        value: entry.value,
        text:
          entry.value === current
            ? currentText
            : t("{{item}} in {{account}}", { item: entry.label, account: entry.connectionLabel }),
      })),
      { value: NO_DEFAULT, text: t("No default") },
    ];
    const site = pauseSite(origin) ?? hostOf(origin);
    return (
      <SiteRow
        key={`origin ${origin}`}
        title={origin}
        lines={line && <StatusLines small lines={[line]} />}
        controls={
          <>
            <DefaultAccountEditor
              idPrefix={idPrefix}
              origin={origin}
              options={options}
              current={current}
              save={(value) => {
                if (value === NO_DEFAULT) {
                  // The row goes away with its default, so focus moves to the add form.
                  if (edit((settings) => replaceDefault(settings, origin)))
                    originInput.current?.focus();
                  return undefined;
                }
                const next = defaultFor(
                  origin,
                  offered.find((entry) => entry.value === value),
                  catalog,
                );
                if (!next.ok) return next.message;
                edit((settings) => replaceDefault(settings, origin, next.value));
                return undefined;
              }}
            />
            <Button
              type="button"
              variant="outline"
              aria-label={t(
                "Pause automatic login on {{site}} and its subdomains, which includes {{origin}}",
                { site, origin },
              )}
              onClick={() => {
                // As the popup pauses it: the registrable site with its subdomains (ADR 0062).
                edit((settings) => {
                  settings.excludedSites = settings.excludedSites.filter(
                    (entry) => entry.hostname !== site,
                  );
                  settings.excludedSites.push({ hostname: site, includeSubdomains: true });
                });
                originInput.current?.focus();
              }}
            >
              <Pause aria-hidden size={16} strokeWidth={2} />
              {t("Pause")}
            </Button>
          </>
        }
      />
    );
  }

  /**
   * An exclusion rule, which pauses automatic login of its hosts until it is removed
   * (ADR 0062), with the defaults it keeps from being used by themselves.
   */
  function ruleRow(rule: ExcludedSite) {
    const name = ruleName(rule);
    const kept = draft.siteDefaults.filter(
      (entry) => ruleFor(draft.excludedSites, entry.origin) === rule,
    );
    return (
      <SiteRow
        key={`rule ${rule.hostname}`}
        title={name}
        badges={
          <Badge muted icon={Pause}>
            {t("Paused")}
          </Badge>
        }
        lines={kept.map((entry) => (
          <div key={entry.origin} className="flex flex-wrap items-center gap-x-2">
            <StatusLines
              small
              lines={[
                {
                  tone: "idle",
                  icon: Info,
                  text: t(
                    "The default for {{origin}} is kept; while the site is paused it is only listed first in the popup.",
                    { origin: entry.origin },
                  ),
                },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              aria-label={t("Remove default for {{origin}}", { origin: entry.origin })}
              onClick={() => {
                if (edit((settings) => replaceDefault(settings, entry.origin)))
                  originInput.current?.focus();
              }}
            >
              {t("Remove default")}
            </Button>
          </div>
        ))}
        controls={
          <Button
            type="button"
            variant="outline"
            aria-label={t("Resume {{name}}", { name })}
            onClick={() => {
              edit((settings) => {
                settings.excludedSites = settings.excludedSites.filter(
                  (entry) => entry.hostname !== rule.hostname,
                );
              });
              originInput.current?.focus();
            }}
          >
            {t("Resume")}
          </Button>
        }
      />
    );
  }

  /** A site that asks for the master password before a re-prompt item is used. */
  function repromptRow(rule: ExcludedSite) {
    const name = ruleName(rule);
    return (
      <SiteRow
        key={`reprompt ${rule.hostname}`}
        title={name}
        badges={
          <Badge muted icon={LockKeyhole}>
            {t("Asks for the master password")}
          </Badge>
        }
        controls={
          <Button
            type="button"
            variant="outline"
            aria-label={t("Stop asking for the master password on {{name}}", { name })}
            onClick={() => {
              edit((settings) => {
                settings.repromptSites = settings.repromptSites.filter(
                  (entry) => entry.hostname !== rule.hostname,
                );
              });
              originInput.current?.focus();
            }}
          >
            {t("Stop asking")}
          </Button>
        }
      />
    );
  }

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
    // A default on a site the allowed sites leave out is listed, and says it is not used.
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
