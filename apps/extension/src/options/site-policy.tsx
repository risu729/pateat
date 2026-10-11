import {
  normalizeHostname,
  parseSiteUrl,
  resolveSiteAccount,
  siteDefaultConnection,
  type LocalSettings,
  type SiteAccountsResponse,
  type VaultCatalog,
} from "@pateat/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
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
};

/** Matched items that are still in the catalog, grouped in catalog order. */
function siteAccountOptions(
  catalog: VaultCatalog,
  found: Extract<SiteAccountsResponse, { ok: true }> | undefined,
): SiteAccountOption[] {
  if (!found) return [];
  return catalog.connections.flatMap((connection) =>
    connection.items.flatMap((item) => {
      const match = found.accounts.find(
        (entry) => entry.connectionId === connection.id && entry.itemId === item.id,
      );
      return match
        ? [
            {
              connectionId: connection.id,
              connectionLabel: connection.label,
              provider: connection.provider,
              userId: connection.userId,
              itemId: item.id,
              itemName: item.label,
              uri: match.uri,
              passkey: match.passkey,
              value: JSON.stringify([connection.id, item.id]),
            },
          ]
        : [];
    }),
  );
}

function matchedBy(option: SiteAccountOption): string {
  if (option.uri && option.passkey) return "URI and passkey";
  return option.uri ? "URI" : "passkey";
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
  findSiteAccounts: (origin: string) => Promise<SiteAccountsResponse>;
}) {
  const hostnameInput = useRef<HTMLInputElement>(null);
  const originInput = useRef<HTMLInputElement>(null);
  const [siteError, setSiteError] = useState("");
  const [defaultError, setDefaultError] = useState("");
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
      // Only an item that matches the origin entered can be chosen.
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
  const accounts = useQuery({
    queryKey: ["settings", "site-accounts", accountOrigin],
    queryFn: () => findSiteAccounts(accountOrigin!),
    enabled: accountOrigin !== undefined,
    // Vault syncs and saved settings change the answer; ask again for each origin entered.
    staleTime: 0,
    gcTime: 0,
  });
  const found =
    accountOrigin !== undefined && accounts.data?.ok && accounts.data.origin === accountOrigin
      ? accounts.data
      : undefined;
  const accountOptions = siteAccountOptions(catalog, found);
  const selectedAccount = useStore(defaultForm.store, (state) => state.values.account);
  const shownAccount = accountOptions.some((entry) => entry.value === selectedAccount)
    ? selectedAccount
    : (accountOptions[0]?.value ?? "");
  let accountNote: string;
  if (accountOrigin === undefined)
    accountNote = "Enter an origin to list the accounts that match it.";
  else if (accounts.isPending) accountNote = "Finding the vault items that match this origin…";
  else if (accounts.isError || (accounts.data && !accounts.data.ok))
    accountNote =
      accounts.data && !accounts.data.ok && accounts.data.reason === "site-excluded"
        ? "This site is excluded."
        : "The matching accounts could not be listed.";
  else if (!accountOptions.length)
    accountNote =
      "No vault item matches this origin. Add the site's URI or passkey to the item in your vault, then sync.";
  else
    accountNote = `${accountOptions.length} matching ${
      accountOptions.length === 1 ? "item" : "items"
    }.`;
  if (found && !found.complete)
    accountNote += " Some vaults could not be searched because they are locked or unavailable.";

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
          Enter a hostname without a scheme, port or path. Add it to the draft, then save settings.
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
            const status = resolved.ok
              ? "Available under this draft policy"
              : liveItem && resolved.reason === "item-origin-mismatch"
                ? "Available under this draft policy; the vault's URI rules or passkey are checked on each page"
                : `Unavailable under this draft policy: ${unavailableReason(resolved.reason)}`;
            return (
              <li key={selected.origin}>
                <span>
                  {selected.origin} →{" "}
                  {connection?.label ??
                    ("connectionId" in selected
                      ? selected.connectionId
                      : `account ${selected.userId} (not available here)`)}{" "}
                  /{" "}
                  {item?.label ??
                    ("itemName" in selected ? selected.itemName : undefined) ??
                    selected.itemId}
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
                  aria-describedby={`default-help${defaultError ? " default-error" : ""}`}
                  aria-invalid={Boolean(defaultError)}
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
                            {option.itemName} ({matchedBy(option)})
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
                <p id="default-account-note" className="note" aria-live="polite">
                  {accountNote}
                </p>
              </>
            )}
          </defaultForm.Field>
          {defaultError && (
            <p id="default-error" className="validation-error" role="alert">
              {defaultError}
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
