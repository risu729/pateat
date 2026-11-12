import { PopupSsoChoice } from "./sso-choice";
import type { SsoClient } from "../login/sso-wire";
import { PopupPagePermissions } from "./page-permissions";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  isSiteAllowed,
  siteDefaultConnection,
  type LoginDetail,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import {
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  Lock,
  LockKeyhole,
  LogIn,
  LogOut,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../options/button";
import type { SettingsClient } from "../options/client";
import { siteAccountOptions } from "../options/site-policy";
import { Logo } from "../logo";
import { choiceReason, switchStatus, type ChoiceClient } from "../login/choice-wire";
import type { DetailClient } from "../login/detail-wire";
import { pauseSite } from "../login/pause";
import type { ManualClient } from "../login/manual-wire";
import { ManualLogin } from "./manual-login";
import { hostnameOf, PageStatusSection } from "./page-status";
import { PopupBindingReview, type BindingReviewClient } from "./binding-review";
import { PauseControl, pauseShown, siteRules, type SitePause } from "./pause";
import {
  AccountChoices,
  CardBody,
  accountCards,
  accountName,
  type AccountCard,
} from "./site-accounts";
import { DetailSection } from "./site-details";
import { Line } from "./site-line";
import { RepromptSwitch, repromptSwitch } from "./site-reprompt";
import { SITE_ACCOUNTS_WAIT_MS, ListingTimeout, useSiteQueries } from "./site-queries";
import { createSiteActions, type NoticeText, type SiteNotice } from "./site-actions";

export { popupOrigin, SITE_ACCOUNTS_WAIT_MS } from "./site-queries";
export { repromptSwitch } from "./site-reprompt";

/** What the toolbar popup needs from the browser besides the settings messages. */
export interface PopupHost {
  /** The active tab in the popup's window; `url` is absent without site access. */
  currentTab(): Promise<
    { id: number | undefined; url: string | undefined; incognito: boolean } | undefined
  >;
  /** Opens the settings page, at the section of that ID when given. */
  openSettings(section?: string): void;
  /** Opens the diagnostics page with the detailed log. */
  openDiagnostics(): void;
  /** Closes the popup, as once a picked login has started. */
  close(): void;
  /**
   * Calls back whenever the stored settings change, as when a login saves its picked
   * account as the default while the popup is open; returns the unsubscribe function.
   */
  watchSettings(onChange: () => void): () => void;
}

const NOTICE_ICON = { progress: LoaderCircle, success: CircleCheck, error: CircleX } as const;

/**
 * The toolbar popup edits two settings of the active tab's site, its default account and
 * its exclusion rule, which pauses automatic login until turned back on (ADR 0062), through
 * the same worker-owned store as the settings page (ADR 0021).
 */
export function SiteApp({
  client,
  choices,
  manual,
  details,
  bindingReviews,
  sso,
  host,
  listingWaitMs = SITE_ACCOUNTS_WAIT_MS,
}: {
  client: SettingsClient;
  choices: ChoiceClient;
  manual?: ManualClient;
  details: DetailClient;
  bindingReviews?: BindingReviewClient;
  sso?: SsoClient;
  host: PopupHost;
  listingWaitMs?: number;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // The vault field picked for each detail the page asks for; the best guess otherwise.
  const [detailPicks, setDetailPicks] = useState<Partial<Record<LoginDetail, string>>>({});
  const [notice, setNotice] = useState<SiteNotice>({ tone: "success" });
  const [chosen, setChosen] = useState("");
  const [picked, setPicked] = useState("");
  const [makeDefault, setMakeDefault] = useState<boolean>();
  // An account switch's pick is kept for this browser session unless made the default.
  const [switchDefault, setSwitchDefault] = useState(false);
  const [reprompting, setReprompting] = useState<boolean>();
  const say = (text: NoticeText, tone: SiteNotice["tone"]) => setNotice({ text, tone });
  // Buttons that start a change are only marked disabled while it runs, since Chrome moves
  // focus away from a focused control that becomes disabled. A control the result
  // removes or disables, such as Remove default once the default is gone, leaves focus on
  // the result message, so a keyboard user is not sent back to the top of the popup. A
  // mouse click also focuses the button, so the move does not scroll.
  const message = useRef<HTMLOutputElement>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    const focused = document.activeElement;
    if (
      wasBusy.current &&
      !busy &&
      (!focused || focused === document.body || (focused as HTMLButtonElement).disabled)
    )
      message.current?.focus({ preventScroll: true });
    wasBusy.current = busy;
  }, [busy]);
  const {
    tab,
    settings,
    origin,
    tabId,
    saved,
    inPrivate,
    choice,
    pageSectionShown,
    pageStatus,
    pauseState,
    refreshPause,
    timedPause,
    pageDetails,
    accounts,
  } = useSiteQueries({ host, client, choices, details, listingWaitMs, queryClient });

  const { change, pick, switchTo, allowSite, setPause, fillDetail, removeDetail, askAgain } =
    createSiteActions({
      saved,
      busy,
      setReprompting,
      setBusy,
      say,
      client,
      queryClient,
      choice,
      settings,
      tabId,
      choices,
      host,
      inPrivate,
      refreshPause,
      origin,
      timedPause,
      details,
      pageDetails,
      setNotice,
    });

  const openSettings = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    host.openSettings();
  };
  let pauseControl;
  let body;
  if (tab.isPending || settings.isPending) body = <p className="popup-muted">{t("Loading…")}</p>;
  else if (!origin)
    body = (
      <p id="popup-unsupported">
        {tab.data?.url
          ? t(
              "Pateat works on websites (HTTP and HTTPS). Open a website, then click the Pateat icon again.",
            )
          : t(
              "Pateat cannot read this tab's address. It works on websites it has site access to; a page that is still loading shows this too.",
            )}
      </p>
    );
  else if (!saved)
    body = (
      <p id="popup-error" className="popup-notice popup-notice--error" role="alert">
        <CircleX size={16} strokeWidth={2} aria-hidden="true" />
        <span>{t("Pateat's settings could not be loaded.")}</span>
      </p>
    );
  else {
    const hostname = hostnameOf(origin);
    const rules = siteRules(saved.snapshot.settings, origin);
    const reprompt = repromptSwitch(saved.snapshot.settings, hostname);
    const { catalog } = saved;
    const current = saved.snapshot.settings.siteDefaults.find((entry) => entry.origin === origin);
    const found = accounts.data?.ok && accounts.data.origin === origin ? accounts.data : undefined;
    const options = siteAccountOptions(catalog, found, false, saved.snapshot.settings);
    const mapped = current ? siteDefaultConnection(current, catalog) : undefined;
    const currentValue =
      current && mapped?.ok ? JSON.stringify([mapped.connectionId, current.itemId]) : undefined;
    const currentOption = options.find((entry) => entry.value === currentValue);
    const shown = options.some((entry) => entry.value === chosen)
      ? chosen
      : (currentOption?.value ?? "");
    // A choice that waits in a frame of the page is for the frame's origin (ADR 0086): the
    // default it lists first and the one a pick may become are that origin's, as every
    // login there is (ADR 0017).
    const offered =
      choice.data?.ok && (choice.data.origin === origin || choice.data.frame)
        ? choice.data
        : undefined;
    const choiceOrigin = offered?.origin ?? origin;
    // A frame of the page's own origin waits as the page does.
    const embedded = offered !== undefined && choiceOrigin !== origin;
    const choiceDefault =
      choiceOrigin === origin
        ? current
        : saved.snapshot.settings.siteDefaults.find((entry) => entry.origin === choiceOrigin);
    const choiceMapped = choiceDefault ? siteDefaultConnection(choiceDefault, catalog) : undefined;
    const choiceValue =
      choiceDefault && choiceMapped?.ok
        ? JSON.stringify([choiceMapped.connectionId, choiceDefault.itemId])
        : undefined;
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
    // While the tab asks, the saved default is listed first (ADR 0021 D).
    const pickOptions = siteAccountOptions(catalog, matches, false, saved.snapshot.settings).sort(
      (a, b) => Number(b.value === choiceValue) - Number(a.value === choiceValue),
    );
    // After the site rejected a login of this tab or another tab of the site, nothing is
    // chosen until the user picks, so Log in never sends the rejected account again by
    // itself (ADR 0021).
    const shownPick = pickOptions.some((entry) => entry.value === picked)
      ? picked
      : offered?.ask === "rejected" || offered?.rejectedElsewhere
        ? ""
        : (pickOptions[0]?.value ?? "");
    // A tab that asks, and a paused site (ADR 0062), offer a single account too.
    const showChoice = Boolean(
      offered && labelled && pickOptions.length > (offered.ask || offered.paused ? 0 : 1),
    );
    // A pick in a private window is used for this login only unless the user says otherwise.
    const asDefault = makeDefault ?? !tab.data?.incognito;
    // A saved default missing from a list is shown with its saved labels.
    const savedCard = (
      entry: NonNullable<typeof current>,
      mapping: typeof mapped,
    ): Omit<AccountCard, "value"> => {
      const connection = mapping?.ok
        ? catalog.connections.find((item) => item.id === mapping.connectionId)
        : undefined;
      return {
        title:
          connection?.items.find((item) => item.id === entry.itemId)?.label ??
          entry.itemName ??
          entry.itemId,
        sub:
          connection?.label ??
          t("{{account}}, not available here", {
            account: entry.accountName ?? t("Vault account"),
          }),
        isDefault: true,
      };
    };
    const savedDefault = current && savedCard(current, mapped);
    // The frame origin's saved default, named when the frame's choice leaves it out.
    const embeddedMissing =
      embedded && choiceDefault && !pickOptions.some((entry) => entry.value === choiceValue)
        ? savedCard(choiceDefault, choiceMapped)
        : undefined;
    // While the site's matches are still listed, the saved default is not missing yet: its
    // row then shows with its username rather than briefly as the item's saved labels.
    const listing = accounts.isEnabled && accounts.isPending;
    const missingDefault = currentOption || listing ? undefined : savedDefault;
    const missingFromChoice = pickOptions.some((entry) => entry.value === currentValue)
      ? undefined
      : savedDefault;
    let accountsNote: { tone: "idle" | "warn" | "err"; text: string } | undefined;
    if (accounts.isPending)
      accountsNote = { tone: "idle", text: t("Finding the vault items that match this site…") };
    else if (accounts.error instanceof ListingTimeout)
      accountsNote = {
        tone: "err",
        text: t(
          "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup.",
        ),
      };
    else if (!found)
      accountsNote = {
        tone: "err",
        text: t("The matching accounts could not be listed. Reopen this popup to try again."),
      };
    else if (!options.length)
      accountsNote = {
        tone: "idle",
        text: t(
          "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync.",
        ),
      };

    const setDefault = () => {
      const selected = options.find((entry) => entry.value === shown);
      if (!selected?.userId) {
        say(
          (translate) =>
            translate("This account is unavailable. Choose another one or use the settings page."),
          "error",
        );
        return;
      }
      const entry = {
        origin,
        provider: selected.provider,
        server: selected.server,
        userId: selected.userId,
        itemId: selected.itemId,
        itemName: selected.itemName,
        accountName: selected.connectionLabel,
      };
      // A default names the vault account, so it must lead back to the chosen connection.
      const target = siteDefaultConnection(entry, catalog);
      if (!target.ok || target.connectionId !== selected.connectionId) {
        say(
          (translate) =>
            translate(
              "This vault account is connected more than once. Choose the default in the settings page.",
            ),
          "error",
        );
        return;
      }
      void (async () => {
        const done = await change(
          (value) => {
            value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
            value.siteDefaults.push(entry);
          },
          (translate) =>
            translate("{{name}} is now the default for this site.", {
              name: accountName(selected, found?.accounts),
            }),
        );
        // The tab's page logs in with it now, not at its next load (ADR 0021, amended
        // 2026-11-04).
        if (done && tabId !== undefined) await choices.defaultChosen(tabId).catch(() => undefined);
      })();
    };

    const removeDefault = () =>
      void change(
        (value) => {
          value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
        },
        (translate) => translate("The default account for this site was removed."),
      );
    const removeDefaultButton = current && (
      <Button
        id="popup-remove-default"
        type="button"
        variant="outline"
        disabled={busy || listing}
        focusableWhenDisabled={busy}
        onClick={removeDefault}
      >
        {t("Remove default")}
      </Button>
    );

    const status =
      pageSectionShown && pageStatus.data?.ok && pageStatus.data.origin === origin
        ? pageStatus.data
        : undefined;
    const usedValue = status?.used
      ? JSON.stringify([status.used.connectionId, status.used.itemId])
      : undefined;
    const accountSwitch = status?.switch;
    const switchName = (() => {
      if (!accountSwitch) return undefined;
      const option = options.find(
        (entry) =>
          entry.connectionId === accountSwitch.connectionId &&
          entry.itemId === accountSwitch.itemId,
      );
      return option ? accountName(option, found?.accounts) : t("the account");
    })();
    // An account switch (ADR 0063): each matching account on a page that waits for no choice.
    const switchSection = status && options.length > 0 && (
      <section className="popup-section" aria-labelledby="popup-switch-heading">
        <div className="popup-section-head">
          <h2 id="popup-switch-heading">{t("Switch account")}</h2>
          <p className="popup-muted popup-reason">
            {t("Logs this tab out of {{hostname}}, then logs in with the account you choose.", {
              hostname,
            })}
          </p>
        </div>
        <ul className="popup-choices popup-switch-list">
          {accountCards(options, found?.accounts, currentValue, usedValue).map((card) => {
            const option = options.find((entry) => entry.value === card.value)!;
            return (
              <li key={card.value} className="popup-choice popup-choice--static popup-switch-row">
                <CardBody card={card} />
                <Button
                  type="button"
                  variant="outline"
                  className="popup-switch-button"
                  disabled={busy || accountSwitch?.state === "running"}
                  aria-label={t("Switch to this account: {{title}}, {{sub}}", {
                    title: card.title,
                    sub: card.sub,
                  })}
                  onClick={() =>
                    void switchTo(
                      { ...option, name: accountName(option, found?.accounts) },
                      switchDefault,
                    )
                  }
                >
                  <LogOut size={16} strokeWidth={2} aria-hidden="true" />
                  {t("Switch to this account")}
                </Button>
              </li>
            );
          })}
        </ul>
        <label className="checkbox-row popup-check">
          <input
            id="popup-switch-default"
            type="checkbox"
            checked={switchDefault}
            disabled={busy}
            onChange={(event) => setSwitchDefault(event.target.checked)}
          />
          {t("Make it the default for {{hostname}}", { hostname })}
        </label>
        <ul className="popup-lines" aria-live="polite">
          {accountSwitch && switchName && (
            <Line tone={accountSwitch.state === "failed" ? "err" : "idle"} id="popup-switch-status">
              {switchStatus(accountSwitch.state, accountSwitch.reason, switchName, t)}
            </Line>
          )}
          <Line tone="idle" id="popup-switch-provider">
            {t(
              "A site you log in to through another account, such as a company or Google sign-in, may log you out of that account too.",
            )}
          </Line>
        </ul>
      </section>
    );
    // Only a site Pateat runs on can be paused (ADR 0062). In a private window automatic
    // login is off until turned on in the settings, which wins over the rest; a rule pauses
    // the site until turned back on, and wins over a pause of a length. A site the allowed
    // sites leave out is paused until allowed, after its exclusions (ADR 0077).
    const notAllowed = !isSiteAllowed(saved.snapshot.settings, origin);
    const pause: SitePause = inPrivate
      ? { kind: "private" }
      : rules.shared.length
        ? { kind: "shared", rules: rules.shared }
        : rules.rules.length
          ? { kind: "rule" }
          : notAllowed
            ? { kind: "not-allowed", site: pauseSite(new URL(origin)) ?? hostname }
            : timedPause !== undefined
              ? { kind: "until", until: timedPause }
              : { kind: "running" };
    // With the page section hidden, any tab with a site to pause shows the row.
    const ruled = inPrivate || rules.rules.length > 0 || notAllowed;
    if (
      pageSectionShown
        ? pauseShown(status, Boolean(found?.accounts.length), ruled)
        : ruled || pauseState.data?.ok === true
    )
      pauseControl = (
        <PauseControl
          pause={pause}
          incognito={tab.data?.incognito === true}
          busy={busy}
          onPause={(length) => void setPause(length)}
          onResume={() => void setPause(undefined)}
          onAllow={() => {
            if (pause.kind === "not-allowed") void allowSite(pause.site);
          }}
          onOpenSettings={(section) => host.openSettings(section)}
        />
      );
    const detailState =
      pageDetails.data?.ok && pageDetails.data.origin === origin ? pageDetails.data : undefined;
    const detailOffer = detailState?.offer;
    const detailLinks = detailState?.links ?? [];
    const detailSection = (detailOffer || detailLinks.length > 0) && (
      <DetailSection
        t={t}
        offer={detailOffer}
        links={detailLinks}
        picks={detailPicks}
        busy={busy}
        onPick={(detail, value) => setDetailPicks((picks) => ({ ...picks, [detail]: value }))}
        onFill={(detail, source) => void fillDetail(detailOffer!.documentId, detail, source)}
        onRemove={(detail) => void removeDetail(detail)}
      />
    );
    body = (
      <>
        {(status || detailSection) && (
          <PageStatusSection
            status={status}
            inPrivate={inPrivate}
            onOpenDiagnostics={pageSectionShown ? () => host.openDiagnostics() : undefined}
          >
            {detailSection}
          </PageStatusSection>
        )}
        {status?.page?.state === "denied" &&
          status.page.reason === "master-password-reprompt" &&
          !status.login && (
            <Button
              id="popup-reprompt"
              type="button"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => void askAgain()}
            >
              <LockKeyhole size={16} strokeWidth={2} aria-hidden="true" />
              {t("Enter the master password")}
            </Button>
          )}
        {choice.isPending && choice.isEnabled && (
          <p id="popup-choice-checking" className="popup-muted">
            {t("Checking whether this page waits for an account choice…")}
          </p>
        )}
        {offered && !labelled && (
          <p id="popup-choice-checking" className="popup-muted">
            {t("Listing the accounts that match this page…")}
          </p>
        )}
        {offered && showChoice && (
          <section className="popup-section" aria-labelledby="popup-choice-heading">
            <div className="popup-section-head">
              <h2 id="popup-choice-heading">{t("Choose an account")}</h2>
              <p id="popup-choice-reason" className="popup-muted popup-reason">
                {choiceReason(
                  offered.ask,
                  pickOptions.length,
                  t,
                  offered.paused === true && (inPrivate ? "private" : true),
                )}
              </p>
            </div>
            {embedded && (
              <p id="popup-choice-frame" className="popup-muted">
                {t("The sign-in form is embedded in this page from {{hostname}}.", {
                  hostname: hostnameOf(choiceOrigin),
                })}
              </p>
            )}
            {embeddedMissing && (
              <p id="popup-choice-default" className="popup-notice popup-notice--warning">
                <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
                <span>
                  {t("The saved default, {{title}} ({{sub}}), is not one of these accounts.", {
                    title: embeddedMissing.title,
                    sub: embeddedMissing.sub,
                  })}
                </span>
              </p>
            )}
            {offered.held && (
              <p id="popup-pick-held" className="popup-notice popup-notice--warning">
                <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
                <span>
                  {t(
                    "Another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes.",
                  )}
                </span>
              </p>
            )}
            <fieldset className="popup-fieldset">
              <legend className="visually-hidden">{t("Account to log in with")}</legend>
              <AccountChoices
                name="popup-pick"
                cards={accountCards(pickOptions, found?.accounts, choiceValue, usedValue)}
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
              {t("Make it the default for {{hostname}}", { hostname: hostnameOf(choiceOrigin) })}
            </label>
            <Button
              id="popup-pick"
              type="button"
              className="w-full gap-2"
              disabled={busy || offered.held || !shownPick}
              focusableWhenDisabled={busy}
              aria-describedby={offered.held ? "popup-pick-held" : undefined}
              onClick={() => {
                const selected = pickOptions.find((entry) => entry.value === shownPick);
                if (selected)
                  void pick(
                    offered,
                    { ...selected, name: accountName(selected, found?.accounts) },
                    asDefault,
                    shownPick === choiceValue,
                  );
              }}
            >
              <LogIn size={16} strokeWidth={2} aria-hidden="true" />
              {t("Log in")}
            </Button>
          </section>
        )}
        {offered && !embedded && (showChoice || !labelled) ? (
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
                      {t("The saved default, {{title}} ({{sub}}), is not one of these accounts.", {
                        title: missingFromChoice.title,
                        sub: missingFromChoice.sub,
                      })}
                    </Line>
                  )}
                  {found && !found.complete && (
                    <Line tone="warn" id="popup-accounts-incomplete">
                      {t(
                        "Some vaults or items could not be checked, so the site's matches may be incomplete.",
                      )}
                    </Line>
                  )}
                </ul>
              )}
              {removeDefaultButton && <div className="popup-actions">{removeDefaultButton}</div>}
            </div>
          )
        ) : (
          <>
            <fieldset className="popup-fieldset popup-section">
              <legend id="popup-default-heading" className="popup-legend">
                {/* Beside a frame's choice, the list names whose default it is (ADR 0086). */}
                {embedded
                  ? t("Default account for {{hostname}}", { hostname })
                  : t("Default account")}
              </legend>
              {missingDefault && (
                <div id="popup-default" className="popup-choice popup-choice--static">
                  <CardBody card={missingDefault} />
                </div>
              )}
              {options.length > 0 && (
                <AccountChoices
                  name="popup-default"
                  cards={accountCards(options, found?.accounts, currentValue, usedValue)}
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
                    {t(
                      "No default account. With exactly one matching item, Pateat uses that item.",
                    )}
                  </Line>
                )}
                {found && !found.complete && (
                  <Line tone="warn" id="popup-accounts-incomplete">
                    {t(
                      "Some vaults or items could not be checked, so this list may be incomplete.",
                    )}
                  </Line>
                )}
                <li className="popup-line popup-line--idle">
                  <Clock size={16} strokeWidth={2} aria-hidden="true" />
                  <span>
                    {t("Choosing a default logs in with it on this page when it shows a sign-in.")}
                  </span>
                </li>
              </ul>
              {(options.length > 0 || current) && (
                <div className="popup-actions">
                  {options.length > 0 && (
                    <Button
                      id="popup-set-default"
                      type="button"
                      disabled={busy || !shown || shown === currentValue}
                      focusableWhenDisabled={busy}
                      onClick={setDefault}
                    >
                      {t("Use as default")}
                    </Button>
                  )}
                  {removeDefaultButton}
                </div>
              )}
            </fieldset>
            {switchSection}
          </>
        )}
        <PopupPagePermissions
          settings={saved.snapshot.settings}
          origin={origin}
          disabled={busy}
          onChange={(update) =>
            void change(update, (translate) => translate("Page behavior saved."))
          }
          onOpenSettings={(section) => host.openSettings(section)}
        />
        <RepromptSwitch
          site={reprompt}
          pending={reprompting}
          busy={busy}
          onOpenSettings={openSettings}
          onChange={(on) => {
            setReprompting(on);
            void change(
              (value) => reprompt.set(value, on),
              (translate) =>
                on
                  ? translate("{{hostname}} now asks for the master password.", { hostname })
                  : translate("{{hostname}} no longer asks for the master password.", {
                      hostname,
                    }),
            );
          }}
        />
      </>
    );
  }

  const NoticeIcon = NOTICE_ICON[notice.tone];
  // A locked vault neither fills nor signs passkeys until it is unlocked (ADR 0075).
  const lockedVaults =
    saved?.catalog.connections.filter((entry) => entry.state === "locked").length ?? 0;
  return (
    <main className="popup">
      <header className="popup-header">
        <div className="popup-title">
          <Logo className="popup-logo" />
          <h1 id="popup-origin">{origin ? hostnameOf(origin) : t("This tab")}</h1>
          <button
            id="popup-open-settings"
            type="button"
            className="popup-icon-button"
            aria-label={t("Open settings")}
            onClick={() => openSettings()}
          >
            <Settings2 size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {pauseControl}
      </header>
      <output
        id="popup-message"
        ref={message}
        className="popup-message"
        aria-live="polite"
        tabIndex={-1}
      >
        {notice.text && (
          <span className={`popup-notice popup-notice--${notice.tone}`}>
            <NoticeIcon size={16} strokeWidth={2} aria-hidden="true" />
            <span>{notice.text(t)}</span>
          </span>
        )}
      </output>
      {lockedVaults > 0 && (
        <p id="popup-vault-locked" className="popup-notice popup-notice--warning">
          <Lock size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            {t("vaultsLocked", {
              count: lockedVaults,
            })}{" "}
            <a href="options.html" className="popup-link" onClick={openSettings}>
              {t("Unlock in settings")}
            </a>
          </span>
        </p>
      )}
      {manual && tabId !== undefined && origin && saved && (
        <ManualLogin
          client={manual}
          tabId={tabId}
          saved={saved}
          accounts={accounts.data?.ok ? accounts.data : undefined}
          disabled={busy}
          onBusy={setBusy}
          onStarted={() => host.close()}
          onReprompt={() => void askAgain()}
        />
      )}
      {body}
      <PopupSsoChoice client={sso} tabId={tabId} origin={origin} />
      <PopupBindingReview client={bindingReviews} tabId={tabId} origin={origin} host={host} />
    </main>
  );
}
