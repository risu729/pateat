import {
  getItemEligibility,
  normalizeHostname,
  parseSiteUrl,
  resolveSiteAccount,
  siteDefaultConnection,
  type LocalSettings,
  type SiteAccountsResponse,
  type VaultCatalog,
} from "@pateat/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as v from "valibot";
import { Button } from "./button";

const hostnameSchema = v.pipe(
  v.string(),
  v.check(
    (value) => Boolean(normalizeHostname(value.trim())),
    "Enter a hostname without a scheme, port or path.",
  ),
);
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
    "account-ambiguous": "This vault account is connected more than once.",
    "vault-unavailable": "The vault is locked or unavailable.",
    "connection-disabled": "The vault connection is disabled.",
    "item-missing": "The account is unavailable.",
    "item-excluded": "This account is excluded.",
    "item-not-selected": "This account is outside the selected groups and items.",
    "fields-excluded": "All fields in this account are excluded.",
  };
  return descriptions[reason] ?? "This account is unavailable.";
}

type SiteAccountOption = {
  connectionId: string;
  connectionLabel: string;
  provider: string;
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
  const hostnameInput = useRef<HTMLInputElement>(null);
  const originInput = useRef<HTMLInputElement>(null);
  const [siteError, setSiteError] = useState("");
  const [defaultError, setDefaultError] = useState("");
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const siteForm = useForm({
    defaultValues: { hostname: "", includeSubdomains: false },
    onSubmit: ({ value }) => {
      const validated = v.safeParse(hostnameSchema, value.hostname);
      if (!validated.success) {
        setSiteError(validated.issues[0].message);
        hostnameInput.current?.focus();
        return;
      }
      const hostname = normalizeHostname(validated.output.trim());
      if (!hostname) return;
      const added = edit((settings) => {
        settings.excludedSites = settings.excludedSites.filter(
          (entry) => entry.hostname !== hostname,
        );
        settings.excludedSites.push({ hostname, includeSubdomains: value.includeSubdomains });
      });
      if (!added) return;
      siteForm.reset();
      setSiteError("");
      hostnameInput.current?.focus();
    },
  });
  const defaultForm = useForm({
    defaultValues: { origin: "", account: "" },
    onSubmit: ({ value }) => {
      const validated = v.safeParse(originSchema, value.origin);
      if (!validated.success) {
        setDefaultError(validated.issues[0].message);
        originInput.current?.focus();
        return;
      }
      if (accountsPending) {
        setDefaultError(WAIT_FOR_ACCOUNTS);
        return;
      }
      // Only an item listed for the origin entered can be chosen.
      const selected =
        found?.origin === validated.output.trim()
          ? (accountOptions.find((entry) => entry.value === value.account) ?? accountOptions[0])
          : undefined;
      const userId = selected?.userId;
      if (!selected || !userId) {
        setDefaultError("Choose an available default account.");
        originInput.current?.focus();
        return;
      }
      const origin = validated.output.trim();
      const nextDefault = {
        origin,
        provider: selected.provider,
        userId,
        itemId: selected.itemId,
        itemName: selected.itemName,
        accountName: selected.connectionLabel,
      };
      // A default names the account, so it must lead back to the chosen connection.
      const mapped = siteDefaultConnection(nextDefault, catalog);
      if (!mapped.ok || mapped.connectionId !== selected.connectionId) {
        setDefaultError(unavailableReason(mapped.ok ? "account-ambiguous" : mapped.reason));
        originInput.current?.focus();
        return;
      }
      const added = edit((settings) => {
        settings.siteDefaults = settings.siteDefaults.filter((entry) => entry.origin !== origin);
        settings.siteDefaults.push(nextDefault);
      });
      if (!added) return;
      defaultForm.setFieldValue("origin", "");
      setDefaultError("");
      originInput.current?.focus();
    },
  });

  const enteredOrigin = useStore(defaultForm.store, (state) => state.values.origin.trim());
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
  // Saved defaults on live vaults are matched the same way, to show how and as whom.
  const savedLiveOrigins = draft.siteDefaults
    .filter((selected) => {
      const mapped = siteDefaultConnection(selected, catalog);
      return (
        mapped.ok &&
        Boolean(catalog.connections.find((entry) => entry.id === mapped.connectionId)?.snapshotId)
      );
    })
    .map((selected) => selected.origin);
  const savedMatches = useQueries({
    queries: savedLiveOrigins.map((origin) => ({
      queryKey: ["settings", "site-accounts", origin, scope],
      queryFn: () => findSiteAccounts(origin, draft),
      staleTime: 0,
      gcTime: 0,
    })),
  });
  const savedMatch = (origin: string) => {
    const answer = savedMatches[savedLiveOrigins.indexOf(origin)]?.data;
    return answer?.ok && answer.origin === origin ? answer : undefined;
  };
  const accountsPending =
    accountOrigin !== undefined && (queriedOrigin !== accountOrigin || accounts.isPending);
  // The wait message no longer applies once the accounts are listed.
  const defaultMessage = defaultError === WAIT_FOR_ACCOUNTS && !accountsPending ? "" : defaultError;
  const found =
    !accountsPending && accounts.data?.ok && accounts.data.origin === accountOrigin
      ? accounts.data
      : undefined;
  const accountOptions = siteAccountOptions(catalog, found, showAllAccounts, draft);
  const matchedCount = accountOptions.filter((entry) => entry.uri || entry.passkey).length;
  const selectedAccount = useStore(defaultForm.store, (state) => state.values.account);
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

  return (
    <>
      <section aria-labelledby="sites-heading" className="panel">
        <h2 id="sites-heading">Excluded sites</h2>
        <p>
          Match a hostname exactly, or include its subdomains. Excluded sites are blocked by the
          local policy before any future login work.
        </p>
        <ul id="excluded-sites" className="saved-list">
          {!draft.excludedSites.length && <li>No excluded sites.</li>}
          {draft.excludedSites.map((site) => (
            <li key={site.hostname}>
              <span>
                {site.hostname} ·{" "}
                {site.includeSubdomains ? "Including subdomains" : "Exact hostname only"}
              </span>
              <Button
                type="button"
                variant="outline"
                aria-label={`Remove excluded site ${site.hostname}`}
                onClick={() => {
                  edit((settings) => {
                    settings.excludedSites = settings.excludedSites.filter(
                      (entry) => entry.hostname !== site.hostname,
                    );
                  });
                  hostnameInput.current?.focus();
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="add-row"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void siteForm.handleSubmit();
          }}
        >
          <siteForm.Field name="hostname">
            {(field) => (
              <>
                <label htmlFor="site-hostname">Hostname</label>
                <input
                  ref={hostnameInput}
                  id="site-hostname"
                  type="text"
                  placeholder="bank.example"
                  autoComplete="off"
                  aria-describedby={`site-help${siteError ? " site-error" : ""}`}
                  aria-invalid={Boolean(siteError)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setSiteError("");
                  }}
                />
              </>
            )}
          </siteForm.Field>
          <siteForm.Field name="includeSubdomains">
            {(field) => (
              <label className="checkbox-row">
                <input
                  id="site-subdomains"
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />
                Include subdomains
              </label>
            )}
          </siteForm.Field>
          {siteError && (
            <p id="site-error" className="validation-error" role="alert">
              {siteError}
            </p>
          )}
          <Button id="add-site" type="submit">
            Add excluded site
          </Button>
        </form>
        <p id="site-help" className="note">
          Enter a hostname without a scheme, port or path. Each change is saved at once.
        </p>
      </section>
      <section aria-labelledby="defaults-heading" className="panel">
        <h2 id="defaults-heading">Site default accounts</h2>
        <p>
          Choose an account for an exact origin. A default applies to the next login; it does not
          log out or switch an existing session.
        </p>
        <ul id="site-defaults" className="saved-list">
          {!draft.siteDefaults.length && (
            <li>No site defaults. Account selection requires configuration.</li>
          )}
          {draft.siteDefaults.map((selected) => {
            const mapped = siteDefaultConnection(selected, catalog);
            const connection = mapped.ok
              ? catalog.connections.find((entry) => entry.id === mapped.connectionId)
              : undefined;
            const item = connection?.items.find((entry) => entry.id === selected.itemId);
            const resolved = resolveSiteAccount(draft, catalog, selected.origin);
            // A live vault item has no static origins; its URI rules (or a passkey) are
            // checked against each page, so the draft policy cannot call it a mismatch.
            const liveItem = Boolean(item && connection?.snapshotId);
            const matches = liveItem ? savedMatch(selected.origin) : undefined;
            const match = matches?.accounts.find(
              (entry) => entry.connectionId === connection?.id && entry.itemId === item?.id,
            );
            let status: string;
            if (resolved.ok) status = "Available under this draft policy";
            else if (!liveItem || resolved.reason !== "item-origin-mismatch")
              status = `Unavailable under this draft policy: ${unavailableReason(resolved.reason)}`;
            else if (match)
              status = `Matches this origin by ${matchedBy({ uri: match.uri, passkey: match.passkey })}; checked again on each login`;
            else if (
              matches?.complete &&
              !connection?.quarantinedItemIds?.includes(selected.itemId)
            )
              status =
                "No URI rule or passkey of this item matches this origin; a URI rule on a longer path is checked on each login";
            else
              status =
                "Allowed by this draft policy; whether it matches the page is checked against the vault's URI rules or passkeys on each login";
            return (
              <li key={selected.origin}>
                <span>
                  {selected.origin} →{" "}
                  {connection?.label ??
                    `${selected.accountName ?? `account ${selected.userId}`} (not available here)`}{" "}
                  / {item?.label ?? selected.itemName ?? selected.itemId}
                  {match?.username ? ` · ${match.username}` : ""}
                  <small>{status}</small>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove site default ${selected.origin}`}
                  onClick={() => {
                    edit((settings) => {
                      settings.siteDefaults = settings.siteDefaults.filter(
                        (entry) => entry.origin !== selected.origin,
                      );
                    });
                    originInput.current?.focus();
                  }}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
        <form
          className="add-row"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void defaultForm.handleSubmit();
          }}
        >
          <defaultForm.Field name="origin">
            {(field) => (
              <>
                <label htmlFor="default-origin">Exact origin</label>
                <input
                  ref={originInput}
                  id="default-origin"
                  type="text"
                  placeholder="https://bank.example"
                  autoComplete="off"
                  aria-describedby={`default-help${defaultMessage ? " default-error" : ""}`}
                  aria-invalid={Boolean(defaultMessage)}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    setDefaultError("");
                  }}
                />
              </>
            )}
          </defaultForm.Field>
          <defaultForm.Field name="account">
            {(field) => (
              <>
                <label htmlFor="default-account">Default account</label>
                <select
                  id="default-account"
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
                <p id="default-account-note" className="note" aria-live="polite">
                  {accountNote}
                </p>
                <label className="checkbox-row">
                  <input
                    id="default-account-all"
                    type="checkbox"
                    checked={showAllAccounts}
                    onChange={(event) => setShowAllAccounts(event.target.checked)}
                  />
                  Also list items that do not match this origin (for a URI rule on a longer path)
                </label>
              </>
            )}
          </defaultForm.Field>
          {defaultMessage && (
            <p id="default-error" className="validation-error" role="alert">
              {defaultMessage}
            </p>
          )}
          <Button id="add-default" type="submit">
            Set site default
          </Button>
        </form>
        <p id="default-help" className="note">
          Use an HTTP(S) origin without a path or trailing slash. Only items whose vault URI matches
          the origin, or that hold a passkey for it, are listed; saved settings decide which vaults
          and items are searched. The demo accounts match https://bank.example and, for the
          secondary account, https://mail.example. Setting an existing origin replaces only that
          draft default.
        </p>
      </section>
    </>
  );
}
