import {
  isSiteExcluded,
  normalizeHostname,
  parseSiteUrl,
  siteDefaultConnection,
  type LocalSettings,
  type SettingsResponse,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../options/button";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "../options/client";
import { siteAccountOptions } from "../options/site-policy";
import type { ChoiceClient } from "../login/choice-wire";

/** What the toolbar popup needs from the browser besides the settings messages. */
export interface PopupHost {
  /** The active tab in the popup's window; `url` is absent without site access. */
  currentTab(): Promise<
    { id: number | undefined; url: string | undefined; incognito: boolean } | undefined
  >;
  openSettings(): void;
  /** Closes the popup, as once a picked login has started. */
  close(): void;
}

type Saved = Extract<SettingsResponse, { ok: true }>;

/** The tab's origin when Pateat can run there: an HTTPS page with a valid hostname. */
export function popupOrigin(url: string | undefined): string | undefined {
  const parsed = url === undefined ? undefined : parseSiteUrl(url);
  return parsed?.protocol === "https:" && normalizeHostname(parsed.hostname)
    ? parsed.origin
    : undefined;
}

function hostnameOf(origin: string): string {
  return normalizeHostname(new URL(origin).hostname) ?? new URL(origin).hostname;
}

/**
 * The toolbar popup edits two settings of the active tab's site, its default account and
 * its exclusion, through the same worker-owned store as the settings page (ADR 0021).
 */
export function SiteApp({
  client,
  choices,
  host,
}: {
  client: SettingsClient;
  choices: ChoiceClient;
  host: PopupHost;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [chosen, setChosen] = useState("");
  const [picked, setPicked] = useState("");
  const [makeDefault, setMakeDefault] = useState<boolean>();
  const tab = useQuery({
    queryKey: ["popup", "tab"],
    queryFn: async () => (await host.currentTab()) ?? null,
  });
  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: () => client.getSettings() });
  const origin = tab.data === undefined ? undefined : popupOrigin(tab.data?.url);
  const tabId = tab.data?.id;
  // A login refused because several accounts match waits for a pick (ADR 0021).
  const choice = useQuery({
    queryKey: ["popup", "choice", tabId],
    queryFn: () => choices.get(tabId!),
    enabled: tabId !== undefined && origin !== undefined,
    // The page may be refused only after the popup opened, or announce again after a
    // restarted worker; asking again while open shows the choice once it waits, and
    // once another tab's login no longer holds the site.
    refetchInterval: (query) => (query.state.data?.ok && !query.state.data.held ? false : 1000),
    staleTime: 0,
    gcTime: 0,
  });
  const saved = settings.data?.ok ? settings.data : undefined;
  const excluded = Boolean(origin && saved && isSiteExcluded(saved.snapshot.settings, origin));
  const accounts = useQuery({
    queryKey: [
      "popup",
      "site-accounts",
      origin,
      saved?.snapshot.revision,
      saved?.catalog.connections.map((entry) => entry.snapshotId ?? null),
    ],
    queryFn: () => client.findSiteAccounts(origin!, saved!.snapshot.settings),
    enabled: Boolean(origin && saved && !excluded),
    staleTime: 0,
    gcTime: 0,
  });

  async function change(update: (value: LocalSettings) => void, done: string) {
    if (!saved || busy) return;
    const next = structuredClone(saved.snapshot.settings);
    update(next);
    setBusy(true);
    setMessage("Saving…");
    try {
      const response = await client.saveSettings({
        version: 1,
        type: "settings.save",
        expectedRevision: saved.snapshot.revision,
        settings: next,
      });
      if (response.ok) {
        queryClient.setQueryData<Saved>(SETTINGS_QUERY_KEY, response);
        setMessage(done);
        // A default saved for the site ends a waiting choice; the background clears it.
        if (choice.isEnabled) void choice.refetch();
      } else if (response.error.code === "revision-conflict") {
        await settings.refetch();
        setMessage("Settings changed elsewhere and were reloaded. Nothing was changed; try again.");
      } else setMessage("The change could not be saved.");
    } catch {
      // The store may still have saved it; reopening shows the saved settings.
      setMessage(
        "The change may not have been saved. Reopen this popup to see the saved settings.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function pick(
    offered: Extract<Awaited<ReturnType<ChoiceClient["get"]>>, { ok: true }>,
    selected: { connectionId: string; itemId: string; label: string },
    asDefault: boolean,
  ) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    setMessage("Starting the login…");
    try {
      const response = await choices.pick({
        tabId,
        documentId: offered.documentId,
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        makeDefault: asDefault,
      });
      if (response.ok) {
        setMessage(
          `Logging in with ${selected.label}.${asDefault ? " It becomes the default once the login succeeds." : ""}`,
        );
        // The login runs in the page from here; the popup has nothing left to show.
        host.close();
        return;
      } else if (response.reason === "document-gone")
        setMessage("The page changed, so nothing was started. Reload it to choose again.");
      else if (response.reason === "origin-busy")
        setMessage(
          "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab, then choose again.",
        );
      else if (response.reason === "not-started")
        setMessage(
          `Pateat could not log in with ${selected.label} on this page. Reload the page to choose again.`,
        );
      else setMessage("This page is no longer waiting for a choice.");
      await choice.refetch();
    } catch {
      setMessage("The login could not be started. Reopen this popup and try again.");
    } finally {
      setBusy(false);
    }
  }

  const settingsButton = (
    <Button id="popup-open-settings" type="button" variant="outline" onClick={host.openSettings}>
      Open settings
    </Button>
  );
  let body;
  if (tab.isPending || settings.isPending) body = <p>Loading…</p>;
  else if (!origin)
    body = (
      <p id="popup-unsupported">
        {tab.data?.url
          ? "Pateat works on HTTPS websites. Open a website, then click the Pateat icon again."
          : "Pateat cannot read this tab's address. It works on HTTPS websites it has site access to; a page that is still loading shows this too."}
      </p>
    );
  else if (!saved)
    body = (
      <p id="popup-error" role="alert">
        Pateat settings could not be loaded.
      </p>
    );
  else {
    const hostname = hostnameOf(origin);
    const rules = saved.snapshot.settings.excludedSites.filter(
      (site) =>
        hostname === site.hostname ||
        (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
    );
    const { catalog } = saved;
    const current = saved.snapshot.settings.siteDefaults.find((entry) => entry.origin === origin);
    const found = accounts.data?.ok && accounts.data.origin === origin ? accounts.data : undefined;
    const options = siteAccountOptions(catalog, found, false, saved.snapshot.settings);
    const mapped = current ? siteDefaultConnection(current, catalog) : undefined;
    const currentValue =
      current && mapped?.ok ? JSON.stringify([mapped.connectionId, current.itemId]) : undefined;
    const currentOption = options.find((entry) => entry.value === currentValue);
    const currentConnection = mapped?.ok
      ? catalog.connections.find((entry) => entry.id === mapped.connectionId)
      : undefined;
    const shown = options.some((entry) => entry.value === chosen)
      ? chosen
      : (currentOption?.value ?? options[0]?.value ?? "");
    const offered = choice.data?.ok && choice.data.origin === origin ? choice.data : undefined;
    // The choice shows once the site's matches are listed, so each account is named by its
    // username from the first frame rather than by a shortened item ID.
    const labelled = !accounts.isEnabled || !accounts.isPending;
    // The refused login's candidates, labelled like the default list; usernames come from
    // the site's matches when they include the item.
    const matches: Extract<SiteAccountsResponse, { ok: true }> | undefined = offered && {
      version: 1,
      ok: true,
      origin,
      complete: true,
      accounts: offered.candidates.map(
        (entry) =>
          found?.accounts.find(
            (account) =>
              account.connectionId === entry.connectionId && account.itemId === entry.itemId,
          ) ?? { ...entry, uri: true, passkey: false },
      ),
    };
    // After a logout the saved default is listed first (ADR 0021 D).
    const pickOptions = siteAccountOptions(catalog, matches, false, saved.snapshot.settings).sort(
      (a, b) => Number(b.value === currentValue) - Number(a.value === currentValue),
    );
    const shownPick = pickOptions.some((entry) => entry.value === picked)
      ? picked
      : (pickOptions[0]?.value ?? "");
    // A pick in a private window is used for this login only unless the user says otherwise.
    const asDefault = makeDefault ?? !tab.data?.incognito;
    let currentLabel = "No default account. With exactly one matching item, Pateat uses that item.";
    if (current)
      currentLabel = `Default: ${
        currentOption
          ? `${currentOption.label} (${currentOption.connectionLabel})`
          : `${
              currentConnection?.items.find((item) => item.id === current.itemId)?.label ??
              current.itemName ??
              current.itemId
            } (${currentConnection?.label ?? `${current.accountName ?? "vault account"}, not available here`})`
      }`;
    let accountsNote = "";
    if (accounts.isPending) accountsNote = "Finding the vault items that match this site…";
    else if (!found) accountsNote = "The matching accounts could not be listed.";
    else if (!options.length)
      accountsNote =
        "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync.";
    if (found && !found.complete)
      accountsNote += `${accountsNote ? " " : ""}Some vaults or items could not be checked, so this list may be incomplete.`;

    const setDefault = () => {
      const selected = options.find((entry) => entry.value === shown);
      if (!selected?.userId) {
        setMessage("This account is unavailable. Choose another one or use the settings page.");
        return;
      }
      const entry = {
        origin,
        provider: selected.provider,
        userId: selected.userId,
        itemId: selected.itemId,
        itemName: selected.itemName,
        accountName: selected.connectionLabel,
      };
      // A default names the vault account, so it must lead back to the chosen connection.
      const target = siteDefaultConnection(entry, catalog);
      if (!target.ok || target.connectionId !== selected.connectionId) {
        setMessage(
          "This vault account is connected more than once. Choose the default in the settings page.",
        );
        return;
      }
      void change((value) => {
        value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
        value.siteDefaults.push(entry);
      }, `${selected.label} is now the default for this site.`);
    };

    body = (
      <>
        {choice.isPending && choice.isEnabled && (
          <p id="popup-choice-checking">Checking whether this page waits for an account choice…</p>
        )}
        {offered && !labelled && (
          <p id="popup-choice-checking">Listing the accounts that match this page…</p>
        )}
        {offered && labelled && pickOptions.length > (offered.logout ? 0 : 1) && (
          <section aria-labelledby="popup-choice-heading">
            <h2 id="popup-choice-heading">Choose an account</h2>
            <p>
              {offered.logout
                ? "You logged out of this site in this tab, so Pateat did not log in again."
                : `${pickOptions.length} vault items match this page, so Pateat did not log in.`}{" "}
              It logs in with the one you choose, starting again from the first step on this page.
            </p>
            <fieldset className="popup-pick-list">
              <legend className="visually-hidden">Account to log in with</legend>
              {pickOptions.map((option) => (
                <label key={option.value} className="checkbox-row">
                  <input
                    type="radio"
                    name="popup-pick"
                    value={option.value}
                    checked={shownPick === option.value}
                    disabled={busy}
                    onChange={() => setPicked(option.value)}
                  />
                  {option.label} ({option.connectionLabel})
                  {option.value === currentValue ? " · default" : ""}
                </label>
              ))}
            </fieldset>
            <label className="checkbox-row">
              <input
                id="popup-pick-default"
                type="checkbox"
                checked={asDefault}
                disabled={busy}
                onChange={(event) => setMakeDefault(event.target.checked)}
              />
              Make it the default for this site
            </label>
            {offered.held && (
              <p id="popup-pick-held">
                {
                  "Another tab's login to this site is running or did not succeed. Close that tab to log in here."
                }
              </p>
            )}
            <Button
              id="popup-pick"
              type="button"
              disabled={busy || offered.held}
              onClick={() => {
                const selected = pickOptions.find((entry) => entry.value === shownPick);
                if (selected) void pick(offered, selected, asDefault);
              }}
            >
              Log in
            </Button>
          </section>
        )}
        <section aria-labelledby="popup-site-heading">
          <h2 id="popup-site-heading">Pateat on this site</h2>
          {rules.length ? (
            <>
              <p id="popup-site-status">
                Excluded: Pateat does not log in or answer passkeys here.
              </p>
              <ul className="saved-list">
                {rules.map((rule) => (
                  <li key={rule.hostname}>
                    <span>
                      {rule.hostname} ·{" "}
                      {rule.includeSubdomains ? "Including subdomains" : "Exact hostname only"}
                    </span>
                    {/* A rule that includes subdomains also covers other sites; settings change it. */}
                    {rule.hostname === hostname && !rule.includeSubdomains ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Remove excluded site ${rule.hostname}`}
                        onClick={() =>
                          void change((value) => {
                            value.excludedSites = value.excludedSites.filter(
                              (site) => site.hostname !== rule.hostname,
                            );
                          }, `${rule.hostname} is no longer excluded.`)
                        }
                      >
                        Remove
                      </Button>
                    ) : (
                      <small>Covers other sites too; change it in settings.</small>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p id="popup-site-status">
                Allowed: Pateat logs in and answers passkey sign-ins here.
              </p>
              <Button
                id="popup-exclude"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void change((value) => {
                    value.excludedSites.push({ hostname, includeSubdomains: false });
                  }, `${hostname} is now excluded.`)
                }
              >
                Exclude {hostname}
              </Button>
            </>
          )}
        </section>
        {!rules.length && (
          <section aria-labelledby="popup-default-heading">
            <h2 id="popup-default-heading">Default account</h2>
            <p id="popup-default">{currentLabel}</p>
            {options.length > 0 && (
              <label>
                Account for {origin}
                <select
                  id="popup-account"
                  value={shown}
                  disabled={busy}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.connectionLabel})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {accountsNote && (
              <p id="popup-accounts-note" className="note" aria-live="polite">
                {accountsNote}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {options.length > 0 && (
                <Button
                  id="popup-set-default"
                  type="button"
                  disabled={busy || shown === currentValue}
                  onClick={setDefault}
                >
                  Use as default
                </Button>
              )}
              {current && (
                <Button
                  id="popup-remove-default"
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void change((value) => {
                      value.siteDefaults = value.siteDefaults.filter(
                        (item) => item.origin !== origin,
                      );
                    }, "The default account for this site was removed.")
                  }
                >
                  Remove default
                </Button>
              )}
            </div>
            <p className="note">
              A default applies to the next login; it does not log out or switch the current
              session.
            </p>
          </section>
        )}
      </>
    );
  }

  return (
    <main className="popup">
      <p className="eyebrow">Pateat</p>
      <h1 id="popup-origin">{origin ? hostnameOf(origin) : "This tab"}</h1>
      {body}
      <output id="popup-message" className="my-2 block" aria-live="polite">
        {message}
      </output>
      <div className="popup-footer">{settingsButton}</div>
    </main>
  );
}
