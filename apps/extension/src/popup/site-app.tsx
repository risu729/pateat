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
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Info,
  LoaderCircle,
  LogIn,
  Settings2,
  Star,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../options/button";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "../options/client";
import { siteAccountOptions } from "../options/site-policy";
import { Logo } from "../logo";
import { choiceReason, type ChoiceClient } from "../login/choice-wire";

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
type ExcludedSite = LocalSettings["excludedSites"][number];
type Tone = "progress" | "success" | "error";

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
 * The "Pateat on this site" switch. It is on unless an exclusion rule covers the
 * hostname, and the popup changes only the hostname's own exact rule: a rule for a parent
 * domain, or one that includes subdomains, also covers other sites, so only the settings
 * page changes it.
 */
export function siteSwitch(settings: LocalSettings, hostname: string) {
  const rules = settings.excludedSites.filter(
    (site) =>
      hostname === site.hostname ||
      (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
  );
  const own = (site: ExcludedSite) => site.hostname === hostname && !site.includeSubdomains;
  return {
    on: rules.length === 0,
    editable: rules.every(own),
    /** The covering rules the popup cannot change; each includes subdomains. */
    shared: rules.filter((site) => !own(site)),
    /** Turns Pateat on or off for the hostname in a copy of the settings. */
    set(value: LocalSettings, on: boolean) {
      if (on) value.excludedSites = value.excludedSites.filter((site) => !own(site));
      else value.excludedSites.push({ hostname, includeSubdomains: false });
    },
  };
}

/**
 * The header switch; a rule it cannot change disables it and names the reason. While a
 * change is saved it is only marked disabled, since Chrome moves focus away from a
 * focused control that becomes disabled.
 */
function SiteSwitch({
  site,
  pending,
  busy,
  onChange,
}: {
  site: ReturnType<typeof siteSwitch>;
  /** The position being saved, shown until the save ends. */
  pending: boolean | undefined;
  busy: boolean;
  onChange: (on: boolean) => void;
}) {
  const checked = pending ?? site.on;
  return (
    <label className="popup-switch">
      <span>Pateat on this site</span>
      <input
        id="popup-site-switch"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        disabled={!site.editable}
        aria-disabled={busy || undefined}
        aria-describedby={site.editable ? undefined : "popup-site-shared"}
        onChange={(event) => {
          if (!busy) onChange(event.target.checked);
        }}
      />
    </label>
  );
}

const NOTICE_ICON = { progress: LoaderCircle, success: CircleCheck, error: CircleX } as const;

/** One account as a card: the username as the title, the item and its vault below. */
type AccountCard = {
  value: string;
  title: string;
  sub: string;
  isDefault: boolean;
};

type AccountOption = ReturnType<typeof siteAccountOptions>[number];
type MatchedAccounts = Extract<SiteAccountsResponse, { ok: true }>["accounts"] | undefined;

function usernameOf(option: AccountOption, accounts: MatchedAccounts): string | undefined {
  return accounts?.find(
    (account) => account.connectionId === option.connectionId && account.itemId === option.itemId,
  )?.username;
}

/** How a result message names an account: its username, else its item name. */
function accountName(option: AccountOption, accounts: MatchedAccounts): string {
  return usernameOf(option, accounts) || option.itemName;
}

function accountCards(
  options: AccountOption[],
  accounts: MatchedAccounts,
  currentValue: string | undefined,
): AccountCard[] {
  const cards = options.map((option) => {
    const username = usernameOf(option, accounts);
    return {
      option,
      value: option.value,
      title: username || option.itemName,
      sub: username ? `${option.itemName} in ${option.connectionLabel}` : option.connectionLabel,
      isDefault: option.value === currentValue,
    };
  });
  const seen = new Map<string, number>();
  for (const card of cards) {
    const key = JSON.stringify([card.title, card.sub]);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // Cards that would read the same add the item ID's first 8 characters.
  return cards.map(({ option, ...card }) =>
    (seen.get(JSON.stringify([card.title, card.sub])) ?? 0) > 1
      ? { ...card, sub: `${card.sub}, ID ${option.itemId.slice(0, 8)}` }
      : card,
  );
}

function DefaultBadge() {
  return (
    <span className="popup-badge">
      <Star size={12} strokeWidth={2} aria-hidden="true" />
      Default
    </span>
  );
}

function CardBody({ card }: { card: Omit<AccountCard, "value"> }) {
  return (
    <>
      <span className="popup-avatar">
        <UserRound size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="popup-choice-main">
        <span className="popup-choice-title">{card.title}</span>
        <span className="popup-choice-sub">{card.sub}</span>
      </span>
      {card.isDefault && <DefaultBadge />}
    </>
  );
}

/** Native radios styled as cards. */
function AccountChoices({
  name,
  cards,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  cards: AccountCard[];
  checked: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="popup-choices">
      {cards.map((card) => (
        <label key={card.value} className="popup-choice">
          <input
            type="radio"
            name={name}
            value={card.value}
            checked={checked === card.value}
            disabled={disabled}
            aria-label={`${card.title}, ${card.sub}${card.isDefault ? ", default" : ""}`}
            onChange={() => onChange(card.value)}
          />
          <CardBody card={card} />
        </label>
      ))}
    </div>
  );
}

/** An icon-led status line. */
function Line({
  tone,
  id,
  children,
}: {
  tone: "idle" | "warn" | "err";
  id?: string;
  children: ReactNode;
}) {
  const Icon = { idle: Info, warn: TriangleAlert, err: CircleX }[tone];
  return (
    <li id={id} className={`popup-line popup-line--${tone}`}>
      <Icon size={16} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
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
  const [notice, setNotice] = useState<{ text: string; tone: Tone }>({ text: "", tone: "success" });
  const [chosen, setChosen] = useState("");
  const [picked, setPicked] = useState("");
  const [makeDefault, setMakeDefault] = useState<boolean>();
  // The switch shows its new position while that change is saved.
  const [switching, setSwitching] = useState<boolean>();
  const say = (text: string, tone: Tone) => setNotice({ text, tone });
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
  // Only the connections, exclusions and each vault's sync, state and quarantine decide the
  // matches, so saving a default keeps the listed accounts instead of listing them again.
  const accounts = useQuery({
    queryKey: [
      "popup",
      "site-accounts",
      origin,
      saved &&
        JSON.stringify([
          saved.snapshot.settings.connections,
          saved.snapshot.settings.excludedSites,
        ]),
      saved?.catalog.connections.map((entry) => [
        entry.snapshotId ?? null,
        entry.state ?? null,
        entry.quarantinedItemIds ?? [],
      ]),
    ],
    queryFn: () => client.findSiteAccounts(origin!, saved!.snapshot.settings),
    enabled: Boolean(origin && saved && !excluded),
    staleTime: 0,
    gcTime: 0,
  });

  async function change(update: (value: LocalSettings) => void, done: string) {
    if (!saved || busy) {
      setSwitching(undefined);
      return;
    }
    const next = structuredClone(saved.snapshot.settings);
    update(next);
    setBusy(true);
    say("Saving…", "progress");
    try {
      const response = await client.saveSettings({
        version: 1,
        type: "settings.save",
        expectedRevision: saved.snapshot.revision,
        settings: next,
      });
      if (response.ok) {
        queryClient.setQueryData<Saved>(SETTINGS_QUERY_KEY, response);
        say(done, "success");
        // A default saved for the site can end a waiting choice; the background clears it.
        if (choice.isEnabled) void choice.refetch();
      } else if (response.error.code === "revision-conflict") {
        await settings.refetch();
        say("Changed elsewhere and reloaded. Nothing was changed.", "error");
      } else say("The change could not be saved", "error");
    } catch {
      // The store may still have saved it; reopening shows the saved settings.
      say(
        "The change may not have been saved. Reopen this popup to see the saved settings.",
        "error",
      );
    } finally {
      setBusy(false);
      setSwitching(undefined);
    }
  }

  async function pick(
    offered: Extract<Awaited<ReturnType<ChoiceClient["get"]>>, { ok: true }>,
    selected: { connectionId: string; itemId: string; name: string },
    asDefault: boolean,
  ) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say("Starting the login…", "progress");
    try {
      const response = await choices.pick({
        tabId,
        documentId: offered.documentId,
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        makeDefault: asDefault,
      });
      if (response.ok) {
        say(
          asDefault
            ? `Logging in with ${selected.name}. It becomes the default once the login succeeds.`
            : `Logging in with ${selected.name}`,
          "success",
        );
        // The login runs in the page from here; the popup has nothing left to show.
        host.close();
        return;
      } else if (response.reason === "document-gone")
        say("The page changed, so nothing was started. Reload it to choose again.", "error");
      else if (response.reason === "origin-busy")
        say(
          "Another tab's login to this site is running or did not succeed, so Pateat did not log in here. Close that tab or wait up to 5 minutes, then choose again.",
          "error",
        );
      else if (response.reason === "not-started")
        say(
          `Pateat could not log in with ${selected.name} on this page. Reload the page to choose again.`,
          "error",
        );
      else say("This page is no longer waiting for a choice", "error");
      await choice.refetch();
    } catch {
      say("The login could not be started. Reopen this popup and try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  const openSettings = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    host.openSettings();
  };
  let switchControl;
  let body;
  if (tab.isPending || settings.isPending) body = <p className="popup-muted">Loading…</p>;
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
      <p id="popup-error" className="popup-notice popup-notice--error" role="alert">
        <CircleX size={16} strokeWidth={2} aria-hidden="true" />
        <span>Pateat settings could not be loaded</span>
      </p>
    );
  else {
    const hostname = hostnameOf(origin);
    const site = siteSwitch(saved.snapshot.settings, hostname);
    switchControl = (
      <SiteSwitch
        site={site}
        pending={switching}
        busy={busy}
        onChange={(on) => {
          setSwitching(on);
          void change(
            (value) => site.set(value, on),
            on ? `${hostname} is no longer excluded` : `${hostname} is now excluded`,
          );
        }}
      />
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
      : (currentOption?.value ?? "");
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
    // After the site rejected a login of this tab or another tab of the site, nothing is
    // chosen until the user picks, so Log in never sends the rejected account again by
    // itself (ADR 0021).
    const shownPick = pickOptions.some((entry) => entry.value === picked)
      ? picked
      : offered?.logout === "rejected" || offered?.rejectedElsewhere
        ? ""
        : (pickOptions[0]?.value ?? "");
    const showChoice = Boolean(
      offered && labelled && pickOptions.length > (offered.logout ? 0 : 1),
    );
    // A pick in a private window is used for this login only unless the user says otherwise.
    const asDefault = makeDefault ?? !tab.data?.incognito;
    // A saved default missing from a list is shown with its saved labels.
    const savedDefault: Omit<AccountCard, "value"> | undefined = current && {
      title:
        currentConnection?.items.find((item) => item.id === current.itemId)?.label ??
        current.itemName ??
        current.itemId,
      sub:
        currentConnection?.label ?? `${current.accountName ?? "Vault account"}, not available here`,
      isDefault: true,
    };
    const missingDefault = currentOption ? undefined : savedDefault;
    const missingFromChoice = pickOptions.some((entry) => entry.value === currentValue)
      ? undefined
      : savedDefault;
    let accountsNote: { tone: "idle" | "warn" | "err"; text: string } | undefined;
    if (accounts.isPending)
      accountsNote = { tone: "idle", text: "Finding the vault items that match this site…" };
    else if (!found)
      accountsNote = { tone: "err", text: "The matching accounts could not be listed" };
    else if (!options.length)
      accountsNote = {
        tone: "idle",
        text: "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync",
      };

    const setDefault = () => {
      const selected = options.find((entry) => entry.value === shown);
      if (!selected?.userId) {
        say("This account is unavailable. Choose another one or use the settings page.", "error");
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
        say(
          "This vault account is connected more than once. Choose the default in the settings page.",
          "error",
        );
        return;
      }
      void change(
        (value) => {
          value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
          value.siteDefaults.push(entry);
        },
        `${accountName(selected, found?.accounts)} is now the default for this site`,
      );
    };

    const removeDefault = () =>
      void change((value) => {
        value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
      }, "The default account for this site was removed");
    const removeDefaultButton = current && (
      <Button
        id="popup-remove-default"
        type="button"
        variant="outline"
        disabled={busy}
        onClick={removeDefault}
      >
        Remove default
      </Button>
    );

    body = (
      <>
        {choice.isPending && choice.isEnabled && (
          <p id="popup-choice-checking" className="popup-muted">
            Checking whether this page waits for an account choice…
          </p>
        )}
        {offered && !labelled && (
          <p id="popup-choice-checking" className="popup-muted">
            Listing the accounts that match this page…
          </p>
        )}
        {offered && showChoice && (
          <section className="popup-section" aria-labelledby="popup-choice-heading">
            <div className="popup-section-head">
              <h2 id="popup-choice-heading">Choose an account</h2>
              <p id="popup-choice-reason" className="popup-muted popup-reason">
                {choiceReason(offered.logout, pickOptions.length)}
              </p>
            </div>
            {offered.held && (
              <p id="popup-pick-held" className="popup-notice popup-notice--warning">
                <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
                <span>
                  {
                    "Another tab's login to this site is running or did not succeed. Close that tab or wait up to 5 minutes."
                  }
                </span>
              </p>
            )}
            <fieldset className="popup-fieldset">
              <legend className="visually-hidden">Account to log in with</legend>
              <AccountChoices
                name="popup-pick"
                cards={accountCards(pickOptions, found?.accounts, currentValue)}
                checked={shownPick}
                disabled={busy}
                onChange={setPicked}
              />
            </fieldset>
            <label className="checkbox-row popup-check">
              <input
                id="popup-pick-default"
                type="checkbox"
                checked={asDefault}
                disabled={busy}
                onChange={(event) => setMakeDefault(event.target.checked)}
              />
              Make it the default for {hostname}
            </label>
            <Button
              id="popup-pick"
              type="button"
              className="w-full gap-2"
              disabled={busy || offered.held || !shownPick}
              aria-describedby={offered.held ? "popup-pick-held" : undefined}
              onClick={() => {
                const selected = pickOptions.find((entry) => entry.value === shownPick);
                if (selected)
                  void pick(
                    offered,
                    { ...selected, name: accountName(selected, found?.accounts) },
                    asDefault,
                  );
              }}
            >
              <LogIn size={16} strokeWidth={2} aria-hidden="true" />
              Log in
            </Button>
          </section>
        )}
        {offered && site.on && (showChoice || !labelled) ? (
          // The account choice is the only list while the page waits for it: its cards
          // mark the saved default, and a saved default can still be removed here.
          showChoice && (
            <div className="popup-section">
              {(accountsNote?.tone === "err" ||
                missingFromChoice ||
                (found && !found.complete)) && (
                <ul className="popup-lines">
                  {accountsNote?.tone === "err" && (
                    <Line tone="err" id="popup-accounts-note">
                      {accountsNote.text}
                    </Line>
                  )}
                  {missingFromChoice && (
                    <Line tone="warn" id="popup-default">
                      {`The saved default, ${missingFromChoice.title} (${missingFromChoice.sub}), is not one of these accounts`}
                    </Line>
                  )}
                  {found && !found.complete && (
                    <Line tone="warn" id="popup-accounts-incomplete">
                      Some vaults or items could not be checked, so the site's matches may be
                      incomplete
                    </Line>
                  )}
                </ul>
              )}
              {removeDefaultButton && <div className="popup-actions">{removeDefaultButton}</div>}
            </div>
          )
        ) : site.on ? (
          <fieldset className="popup-fieldset popup-section">
            <legend id="popup-default-heading" className="popup-legend">
              Default account
            </legend>
            {missingDefault && (
              <div id="popup-default" className="popup-choice popup-choice--static">
                <CardBody card={missingDefault} />
              </div>
            )}
            {options.length > 0 && (
              <AccountChoices
                name="popup-default"
                cards={accountCards(options, found?.accounts, currentValue)}
                checked={shown}
                disabled={busy}
                onChange={setChosen}
              />
            )}
            <ul className="popup-lines" aria-live="polite">
              {accountsNote && (
                <Line tone={accountsNote.tone} id="popup-accounts-note">
                  {accountsNote.text}
                </Line>
              )}
              {!current && (
                <Line tone="idle" id="popup-no-default">
                  No default account. With exactly one matching item, Pateat uses that item
                </Line>
              )}
              {found && !found.complete && (
                <Line tone="warn" id="popup-accounts-incomplete">
                  Some vaults or items could not be checked, so this list may be incomplete
                </Line>
              )}
              <li className="popup-line popup-line--idle">
                <Clock size={16} strokeWidth={2} aria-hidden="true" />
                <span>Takes effect at the next login</span>
              </li>
            </ul>
            {(options.length > 0 || current) && (
              <div className="popup-actions">
                {options.length > 0 && (
                  <Button
                    id="popup-set-default"
                    type="button"
                    disabled={busy || !shown || shown === currentValue}
                    onClick={setDefault}
                  >
                    Use as default
                  </Button>
                )}
                {removeDefaultButton}
              </div>
            )}
          </fieldset>
        ) : (
          <div className="popup-section">
            {!site.editable && (
              <>
                <p id="popup-site-shared">Excluded by a rule for other sites too</p>
                <ul className="popup-rules">
                  {site.shared.map((rule) => (
                    <li key={`${rule.hostname} ${rule.includeSubdomains}`}>
                      <span className="popup-choice-main">
                        <span className="popup-choice-title">{rule.hostname}</span>
                        <span className="popup-choice-sub">and its subdomains</span>
                      </span>
                      <a
                        href="options.html"
                        className="popup-link"
                        aria-label={`Change in settings for ${rule.hostname}`}
                        onClick={openSettings}
                      >
                        Change in settings
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p id="popup-site-status" className="popup-muted popup-status">
              <Ban size={16} strokeWidth={2} aria-hidden="true" />
              No logins or passkey answers on this site
            </p>
          </div>
        )}
      </>
    );
  }

  const NoticeIcon = NOTICE_ICON[notice.tone];
  return (
    <main className="popup">
      <header className="popup-header">
        <div className="popup-title">
          <Logo className="popup-logo" />
          <h1 id="popup-origin">{origin ? hostnameOf(origin) : "This tab"}</h1>
          <button
            id="popup-open-settings"
            type="button"
            className="popup-icon-button"
            aria-label="Open settings"
            onClick={() => openSettings()}
          >
            <Settings2 size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {switchControl}
      </header>
      <output id="popup-message" className="popup-message" aria-live="polite">
        {notice.text && (
          <span className={`popup-notice popup-notice--${notice.tone}`}>
            <NoticeIcon size={16} strokeWidth={2} aria-hidden="true" />
            <span>{notice.text}</span>
          </span>
        )}
      </output>
      {body}
    </main>
  );
}
