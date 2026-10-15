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
import { useForm, useStore } from "@tanstack/react-form";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Ban, CircleCheck, Clock, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as v from "valibot";
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
const originSchema = v.pipe(
  v.string(),
  v.check((value) => {
    const origin = value.trim();
    const url = parseSiteUrl(origin);
    return Boolean(url && url.origin === origin && normalizeHostname(url.hostname));
  }, "Enter an exact HTTP(S) origin without a path or trailing slash."),
);

function unavailableReason(reason: string): string {
  const descriptions: Record<string, string> = {
    "invalid-url": "The destination is invalid.",
    "site-excluded": "This site is excluded.",
    "default-not-set": "No default account is configured.",
    "item-origin-mismatch": "This account does not match the exact origin.",
    "connection-missing": "The vault connection is unavailable.",
    "account-ambiguous":
      "This vault account is connected more than once, or its user ID has settings for another server.",
    "vault-unavailable": "The vault is locked or unavailable.",
    "connection-disabled": "The vault connection is disabled.",
    "item-missing": "The account is unavailable.",
    "item-excluded": "This account is excluded.",
    "item-not-selected": "This account is outside the selected groups and items.",
    "review-required": "This account's custom fields need review, or its vault needs a sync.",
    "fields-excluded": "All fields in this account are excluded.",
  };
  return descriptions[reason] ?? "This account is unavailable.";
}

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

const SITE_ACCOUNTS_DELAY_MS = 300;
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
  return rule.includeSubdomains ? `${rule.hostname} and subdomains` : rule.hostname;
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
  origin,
  options,
  current,
  save,
}: {
  origin: string;
  options: { value: string; text: string }[];
  current: string;
  save: (value: string) => string | undefined;
}) {
  const [choice, setChoice] = useState<string>();
  const [error, setError] = useState("");
  // A choice the list no longer offers falls back to the saved value.
  const shown =
    choice !== undefined && options.some((entry) => entry.value === choice) ? choice : current;
  const errorId = `site-default-error-${origin}`;
  return (
    <>
      <label className="contents">
        <span className="visually-hidden">Default account for {origin}</span>
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
        aria-label={`Save default for ${origin}`}
        disabled={shown === current}
        onClick={() => {
          const failure = save(shown);
          setError(failure ?? "");
          if (!failure) setChoice(undefined);
        }}
      >
        Save
      </Button>
      {error && (
        <p id={errorId} className="validation-error m-0 basis-full text-right" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function SitePolicy({
  draft,
  catalog,
  edit,
  findSiteAccounts,
}: {
  draft: LocalSettings;
  catalog: VaultCatalog;
  edit: (update: (value: LocalSettings) => void) => boolean;
  /** Asks the background which saved-settings items match an origin. */
  findSiteAccounts: (origin: string, settings: LocalSettings) => Promise<SiteAccountsResponse>;
}) {
  const originInput = useRef<HTMLInputElement>(null);
  const [siteError, setSiteError] = useState("");
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
        setSiteError(WAIT_FOR_ACCOUNTS);
        return;
      }
      const origin = validated.output.trim();
      // Only an item listed for the origin entered can be chosen.
      const selected =
        found?.origin === origin
          ? (accountOptions.find((entry) => entry.value === value.account) ?? accountOptions[0])
          : undefined;
      const next = defaultFor(origin, selected, catalog);
      if (!next.ok) {
        fail(next.message);
        return;
      }
      if (!edit((settings) => replaceDefault(settings, origin, next.value))) return;
      siteForm.setFieldValue("origin", "");
      setSiteError("");
      originInput.current?.focus();
    },
  });
  function fail(message: string) {
    setSiteError(message);
    originInput.current?.focus();
  }
  function excludeEntered() {
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
      settings.excludedSites = settings.excludedSites.filter(
        (entry) => entry.hostname !== hostname,
      );
      settings.excludedSites.push({ hostname, includeSubdomains });
    });
    if (!added) return;
    siteForm.reset();
    setSiteError("");
    originInput.current?.focus();
  }

  const enteredOrigin = useStore(siteForm.store, (state) => state.values.origin.trim());
  const accountOrigin = v.is(originSchema, enteredOrigin) ? enteredOrigin : undefined;
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
  const siteMessage = siteError === WAIT_FOR_ACCOUNTS && !accountsPending ? "" : siteError;
  const found =
    !accountsPending && accounts.data?.ok && accounts.data.origin === accountOrigin
      ? accounts.data
      : undefined;
  const accountOptions = siteAccountOptions(catalog, found, showAllAccounts, draft);
  const matchedCount = accountOptions.filter((entry) => entry.uri || entry.passkey).length;
  const selectedAccount = useStore(siteForm.store, (state) => state.values.account);
  const shownAccount = accountOptions.some((entry) => entry.value === selectedAccount)
    ? selectedAccount
    : (accountOptions[0]?.value ?? "");
  let accountNote: string;
  if (accountOrigin === undefined)
    accountNote = "Enter an origin to list the accounts that match it.";
  else if (accountsPending) accountNote = "Finding the vault items that match this origin…";
  else if (accounts.isError || (accounts.data && !accounts.data.ok))
    accountNote =
      accounts.data && !accounts.data.ok && accounts.data.reason === "site-excluded"
        ? "This site is excluded."
        : "The matching accounts could not be listed.";
  else if (!matchedCount)
    accountNote =
      "No vault item matches this origin. Add the site's URI or passkey to the item in your vault, then sync.";
  else accountNote = `${matchedCount} matching ${matchedCount === 1 ? "item" : "items"}.`;
  if (found && !found.complete)
    accountNote += " Some vaults or items could not be checked, so this list may be incomplete.";

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
      line = { tone: "warn", icon: TriangleAlert, text: unavailableReason(resolved.reason) };
    else if (match)
      line = {
        tone: "ok",
        icon: CircleCheck,
        text: `Matches this origin by ${matchedBy({ uri: match.uri, passkey: match.passkey })}; checked again on each login`,
      };
    else if (matches?.complete && !connection?.quarantinedItemIds?.includes(selected.itemId))
      line = {
        tone: "warn",
        icon: TriangleAlert,
        text: "No URI rule or passkey of this item matches this origin; a URI rule on a longer path is checked on each login",
      };
    else
      line = {
        tone: "idle",
        icon: Info,
        text: "Whether it matches the page is checked against the vault's URI rules or passkeys on each login",
      };
    const unavailable = !resolved.ok && (!liveItem || resolved.reason !== "item-origin-mismatch");
    const current = connection && item ? JSON.stringify([connection.id, item.id]) : SAVED_ELSEWHERE;
    const offered = siteAccountOptions(catalog, matches, false, draft);
    const currentText = `${item?.label ?? selected.itemName ?? selected.itemId}${match?.username ? ` · ${match.username}` : ""} in ${
      connection?.label ?? selected.accountName ?? `account ${selected.userId}`
    }${!connection ? " (not available here)" : unavailable ? " (unavailable)" : ""}`;
    const options = [
      ...(offered.some((entry) => entry.value === current)
        ? []
        : [{ value: current, text: currentText }]),
      ...offered.map((entry) => ({
        value: entry.value,
        text: entry.value === current ? currentText : `${entry.label} in ${entry.connectionLabel}`,
      })),
      { value: NO_DEFAULT, text: "No default" },
    ];
    const hostname = hostOf(origin);
    return (
      <SiteRow
        key={`origin ${origin}`}
        title={origin}
        lines={line && <StatusLines small lines={[line]} />}
        controls={
          <>
            <DefaultAccountEditor
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
              aria-label={`Exclude ${origin}, all schemes and ports`}
              onClick={() => {
                edit((settings) => {
                  settings.excludedSites = settings.excludedSites.filter(
                    (entry) => entry.hostname !== hostname,
                  );
                  settings.excludedSites.push({ hostname, includeSubdomains: false });
                });
                originInput.current?.focus();
              }}
            >
              <Ban aria-hidden size={16} strokeWidth={2} />
              Exclude
            </Button>
          </>
        }
      />
    );
  }

  /** An exclusion rule, with the defaults it keeps from being used. */
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
          <Badge muted icon={Ban}>
            Excluded
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
                  text: `Default for ${entry.origin} kept, unused while excluded`,
                },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remove default for ${entry.origin}`}
              onClick={() => {
                if (edit((settings) => replaceDefault(settings, entry.origin)))
                  originInput.current?.focus();
              }}
            >
              Remove default
            </Button>
          </div>
        ))}
        controls={
          <Button
            type="button"
            variant="outline"
            aria-label={`Allow ${name}`}
            onClick={() => {
              edit((settings) => {
                settings.excludedSites = settings.excludedSites.filter(
                  (entry) => entry.hostname !== rule.hostname,
                );
              });
              originInput.current?.focus();
            }}
          >
            Allow
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
    <Panel id="sites" headingId="sites-heading" title="Sites">
      <RowList id="site-list">{rows.map((entry) => entry.row())}</RowList>
      {!rows.length && (
        <StatusLines
          muted
          lines={[{ tone: "idle", icon: Info, text: "No excluded sites or default accounts" }]}
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
                Origin
                <input
                  ref={originInput}
                  id="site-origin"
                  className={controlClass}
                  type="text"
                  placeholder="https://bank.example"
                  autoComplete="off"
                  aria-describedby={siteMessage ? "site-error" : undefined}
                  aria-invalid={Boolean(siteMessage)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setSiteError("");
                  }}
                />
              </label>
            )}
          </siteForm.Field>
          <siteForm.Field name="account">
            {(field) => (
              <div className="flex flex-[1_1_220px] flex-col gap-1.5">
                <label className={fieldClass}>
                  Default account
                  <select
                    id="default-account"
                    className={controlClass}
                    aria-describedby="default-account-note"
                    disabled={!accountOptions.length}
                    value={shownAccount}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {catalog.connections.map((connection) => {
                      const options = accountOptions.filter(
                        (entry) => entry.connectionId === connection.id,
                      );
                      return options.length ? (
                        <optgroup key={connection.id} label={connection.label}>
                          {options.map((option) => (
                            <option key={option.itemId} value={option.value}>
                              {option.label} ({matchedBy(option)})
                            </option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </select>
                </label>
                <p
                  id="default-account-note"
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
              id="default-account-all"
              type="checkbox"
              checked={showAllAccounts}
              onChange={(event) => setShowAllAccounts(event.target.checked)}
            />
            Also list items that do not match
          </label>
          <siteForm.Field name="includeSubdomains">
            {(field) => (
              <label className={checkClass}>
                <input
                  id="site-subdomains"
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                Exclude subdomains too
              </label>
            )}
          </siteForm.Field>
        </div>
        {siteMessage && (
          <p id="site-error" className="validation-error m-0" role="alert">
            {siteMessage}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button id="add-default" type="submit">
            Save default
          </Button>
          <Button id="add-site" type="button" variant="outline" onClick={excludeEntered}>
            <Ban aria-hidden size={16} strokeWidth={2} />
            Exclude site
          </Button>
        </div>
      </form>
      <StatusLines
        muted
        lines={[
          { tone: "idle", icon: Ban, text: "Excluding a site covers every scheme and port" },
          { tone: "idle", icon: Clock, text: "A default account takes effect at the next login" },
        ]}
      />
    </Panel>
  );
}
