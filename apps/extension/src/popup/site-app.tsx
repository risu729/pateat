import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  normalizeHostname,
  parseSiteUrl,
  popupPageSectionShown,
  siteDefaultConnection,
  type LocalSettings,
  type LoginDetail,
  type SettingsResponse,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  CircleCheck,
  CircleX,
  Clock,
  CreditCard,
  IdCard,
  Info,
  KeyRound,
  LoaderCircle,
  Lock,
  LockKeyhole,
  LogIn,
  LogOut,
  MessageCircleQuestionMark,
  Settings2,
  Smartphone,
  Star,
  TextCursorInput,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../options/button";
import { SETTINGS_QUERY_KEY, type SettingsClient } from "../options/client";
import { siteAccountOptions } from "../options/site-policy";
import { Logo } from "../logo";
import {
  choiceReason,
  pickFailure,
  switchRefusal,
  switchStatus,
  type ChoiceClient,
  type PauseLength,
} from "../login/choice-wire";
import {
  detailFillFailure,
  detailName,
  type DetailClient,
  type DetailResponse,
} from "../login/detail-wire";
import { PageStatusSection } from "./page-status";
import {
  PAUSE_CHOICES,
  PauseControl,
  pauseShown,
  privatePaused,
  siteRules,
  type SitePause,
} from "./pause";

/**
 * How long the popup waits for the site's matches. Each vault lookup of the search is
 * bounded at 30 seconds, but one after another they can take minutes while the vault is
 * busy, such as right after the extension restarted; the popup then stops waiting, above
 * one lookup's bound so a slow but working lookup still answers.
 */
export const SITE_ACCOUNTS_WAIT_MS = 45_000;
class ListingTimeout extends Error {}

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

type Saved = Extract<SettingsResponse, { ok: true }>;
type Tone = "progress" | "success" | "error";
type NoticeText = (translate: TFunction) => string;
type ExcludedSite = LocalSettings["excludedSites"][number];

/** The tab's origin when Pateat can run there: an HTTP(S) page with a valid hostname. */
export function popupOrigin(url: string | undefined): string | undefined {
  const parsed = url === undefined ? undefined : parseSiteUrl(url);
  return (parsed?.protocol === "https:" || parsed?.protocol === "http:") &&
    normalizeHostname(parsed.hostname)
    ? parsed.origin
    : undefined;
}

function hostnameOf(origin: string): string {
  return normalizeHostname(new URL(origin).hostname) ?? new URL(origin).hostname;
}

/** Which rules of a site list cover a hostname, and how the popup changes its own. */
function hostRules(rules: ExcludedSite[], hostname: string) {
  const covering = rules.filter(
    (site) =>
      hostname === site.hostname ||
      (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
  );
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
function RepromptSwitch({
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

const NOTICE_ICON = { progress: LoaderCircle, success: CircleCheck, error: CircleX } as const;

/** One account as a card: the username as the title, the item and its vault below. */
type AccountCard = {
  value: string;
  title: string;
  sub: string;
  isDefault: boolean;
  /** The account of the tab's last login on the site (ADR 0063). */
  isUsed?: boolean;
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
  usedValue?: string,
): AccountCard[] {
  const t = i18n.t.bind(i18n);
  const cards = options.map((option) => {
    const username = usernameOf(option, accounts);
    return {
      option,
      value: option.value,
      title: username || option.itemName,
      sub: username
        ? t("{{item}} in {{account}}", { item: option.itemName, account: option.connectionLabel })
        : option.connectionLabel,
      isDefault: option.value === currentValue,
      ...(option.value === usedValue ? { isUsed: true } : {}),
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
      ? {
          ...card,
          sub: t("{{item}}, ID {{id}}", { item: card.sub, id: option.itemId.slice(0, 8) }),
        }
      : card,
  );
}

function DefaultBadge() {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <span className="popup-badge">
      <Star size={12} strokeWidth={2} aria-hidden="true" />
      {t("Default")}
    </span>
  );
}

function CardBody({ card }: { card: Omit<AccountCard, "value"> }) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <>
      <span className="popup-avatar">
        <UserRound size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="popup-choice-main">
        <span className="popup-choice-title">{card.title}</span>
        <span className="popup-choice-sub">{card.sub}</span>
      </span>
      {card.isUsed && <span className="popup-badge">{t("Used in this tab")}</span>}
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
  const { t } = useTranslation(undefined, { i18n });
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
            aria-label={t(
              card.isUsed
                ? card.isDefault
                  ? "{{title}}, {{sub}}, used in this tab, default"
                  : "{{title}}, {{sub}}, used in this tab"
                : card.isDefault
                  ? "{{title}}, {{sub}}, default"
                  : "{{title}}, {{sub}}",
              { title: card.title, sub: card.sub },
            )}
            onChange={() => onChange(card.value)}
          />
          <CardBody card={card} />
        </label>
      ))}
    </div>
  );
}

type DetailOffer = NonNullable<Extract<DetailResponse, { ok: true }>["offer"]>;
type DetailSource = DetailOffer["details"][number]["candidates"][number];
type DetailLink = Extract<DetailResponse, { ok: true }>["links"][number];

const DETAIL_ICON = {
  "birth-date": CalendarDays,
  "phone-last-4": Smartphone,
  "card-last-4": CreditCard,
  "card-code": CreditCard,
  "card-number": CreditCard,
  "card-expiry": CreditCard,
  pin: KeyRound,
  "secret-answer": MessageCircleQuestionMark,
  "member-id": IdCard,
} as const satisfies Record<LoginDetail, unknown>;

const sourceValue = (source: DetailSource) =>
  JSON.stringify([source.connectionId, source.itemId, source.fieldId]);
/** How the popup names a vault field: only its item's and its own labels, never its value. */
const sourceLabel = (source: { itemLabel: string; fieldLabel: string }) =>
  `${source.itemLabel} › ${source.fieldLabel}`;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The vault fields that could give a detail, as native radios styled as cards. */
function DetailChoices({
  detail,
  candidates,
  checked,
  disabled,
  onChange,
}: {
  detail: LoginDetail;
  candidates: DetailSource[];
  checked: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const Icon = DETAIL_ICON[detail];
  const seen = new Map<string, number>();
  for (const source of candidates)
    seen.set(sourceLabel(source), (seen.get(sourceLabel(source)) ?? 0) + 1);
  return (
    <div className="popup-choices">
      {candidates.map((source) => {
        const title = sourceLabel(source);
        // Fields that would read the same add their item ID's first 8 characters.
        const sub =
          (seen.get(title) ?? 0) > 1
            ? t("ID {{id}}", { id: source.itemId.slice(0, 8) })
            : undefined;
        return (
          <label key={sourceValue(source)} className="popup-choice">
            <input
              type="radio"
              name={`popup-detail-${detail}`}
              value={sourceValue(source)}
              checked={checked === sourceValue(source)}
              disabled={disabled}
              aria-label={sub ? t("{{title}}, {{sub}}", { title, sub }) : title}
              onChange={() => onChange(sourceValue(source))}
            />
            <span className="popup-avatar">
              <Icon size={16} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="popup-choice-main">
              <span className="popup-choice-title">{title}</span>
              {sub && <span className="popup-choice-sub">{sub}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The page's personal details (ADR 0061): what the page asks for with the vault fields
 * that could give it, the best guess selected, and the site's links, each removable.
 */
function DetailSection({
  t,
  offer,
  links,
  picks,
  busy,
  onPick,
  onFill,
  onRemove,
}: {
  t: TFunction;
  offer: DetailOffer | undefined;
  links: DetailLink[];
  picks: Partial<Record<LoginDetail, string>>;
  busy: boolean;
  onPick: (detail: LoginDetail, value: string) => void;
  onFill: (detail: LoginDetail, source: DetailSource) => void;
  onRemove: (detail: LoginDetail) => void;
}) {
  return (
    <>
      {offer?.details.map(({ detail, format, candidates, preselect, question }) => {
        const picked = picks[detail];
        // A detail whose candidates are no guess starts with none selected.
        const shown =
          candidates.find((source) => sourceValue(source) === picked) ??
          (preselect === false ? undefined : candidates[0]);
        return (
          <fieldset key={detail} className="popup-fieldset popup-detail">
            <legend id={`popup-detail-${detail}`} className="popup-detail-ask">
              {question
                ? t("This page asks \u201C{{question}}\u201D.", { question })
                : t("This page asks for {{detail}}.", { detail: detailName(detail, t, format) })}
            </legend>
            {question && (
              // The AI's pairing of the question with a field named otherwise is only a
              // proposal: Fill confirms it (ADR 0061).
              <p id={`popup-detail-paired-${detail}`} className="popup-choice-sub">
                {t(
                  "Pateat\u2019s AI thinks this field holds the answer. Fill only if it does; Pateat then fills it whenever this question shows.",
                )}
              </p>
            )}
            <DetailChoices
              detail={detail}
              candidates={candidates}
              checked={shown ? sourceValue(shown) : ""}
              disabled={busy}
              onChange={(value) => onPick(detail, value)}
            />
            <Button
              id={`popup-detail-fill-${detail}`}
              type="button"
              className="w-full gap-2"
              // Kept focusable while a fill runs, since Chrome moves focus away from a
              // focused control that becomes disabled.
              disabled={busy || !shown}
              focusableWhenDisabled
              aria-describedby={
                question
                  ? `popup-detail-${detail} popup-detail-paired-${detail}`
                  : `popup-detail-${detail}`
              }
              onClick={() => shown && onFill(detail, shown)}
            >
              <TextCursorInput size={16} strokeWidth={2} aria-hidden="true" />
              {t("Fill")}
            </Button>
          </fieldset>
        );
      })}
      {links.length > 0 && (
        <ul
          id="popup-detail-links"
          className="popup-rules"
          aria-label={t("Personal details Pateat fills on this site")}
        >
          {links.map((link) => {
            const Icon = DETAIL_ICON[link.detail];
            return (
              <li key={link.detail} id={`popup-detail-link-${link.detail}`}>
                <Icon className="popup-detail-icon" size={16} strokeWidth={2} aria-hidden="true" />
                <span className="popup-choice-main">
                  <span className="popup-choice-title">
                    {capitalized(detailName(link.detail, t))}
                  </span>
                  <span className="popup-choice-sub">
                    {link.pending
                      ? t("Filled from {{field}} (not saved yet)", { field: sourceLabel(link) })
                      : t("Filled from {{field}}", { field: sourceLabel(link) })}
                  </span>
                </span>
                <Button
                  id={`popup-detail-remove-${link.detail}`}
                  type="button"
                  variant="outline"
                  disabled={busy}
                  focusableWhenDisabled
                  aria-label={t("Remove the link for {{detail}}", {
                    detail: detailName(link.detail, t),
                  })}
                  onClick={() => onRemove(link.detail)}
                >
                  {t("Remove")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
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
 * its exclusion rule, which pauses automatic login until turned back on (ADR 0062), through
 * the same worker-owned store as the settings page (ADR 0021).
 */
export function SiteApp({
  client,
  choices,
  details,
  host,
  listingWaitMs = SITE_ACCOUNTS_WAIT_MS,
}: {
  client: SettingsClient;
  choices: ChoiceClient;
  details: DetailClient;
  host: PopupHost;
  listingWaitMs?: number;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // The vault field picked for each detail the page asks for; the best guess otherwise.
  const [detailPicks, setDetailPicks] = useState<Partial<Record<LoginDetail, string>>>({});
  const [notice, setNotice] = useState<{ text?: NoticeText; tone: Tone }>({ tone: "success" });
  const [chosen, setChosen] = useState("");
  const [picked, setPicked] = useState("");
  const [makeDefault, setMakeDefault] = useState<boolean>();
  // An account switch's pick is kept for this browser session unless made the default.
  const [switchDefault, setSwitchDefault] = useState(false);
  const [reprompting, setReprompting] = useState<boolean>();
  const say = (text: NoticeText, tone: Tone) => setNotice({ text, tone });
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
  const tab = useQuery({
    queryKey: ["popup", "tab"],
    queryFn: async () => (await host.currentTab()) ?? null,
  });
  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: () => client.getSettings() });
  // Settings saved elsewhere while the popup is open, such as the default a picked login
  // saves once it succeeds, show without reopening the popup.
  useEffect(
    () =>
      host.watchSettings(() => {
        void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY, exact: true });
      }),
    [host, queryClient],
  );
  const origin = tab.data === undefined ? undefined : popupOrigin(tab.data?.url);
  const tabId = tab.data?.id;
  const saved = settings.data?.ok ? settings.data : undefined;
  // In a private window automatic login is off unless turned on in the settings (ADR 0062).
  const inPrivate =
    saved !== undefined && privatePaused(saved.snapshot.settings, tab.data?.incognito);
  // A login refused because several accounts match, or on a paused site, waits for a pick
  // (ADR 0021, ADR 0062).
  const choice = useQuery({
    queryKey: ["popup", "choice", tabId],
    queryFn: () => choices.get(tabId!),
    enabled: tabId !== undefined && origin !== undefined && saved !== undefined,
    // The page may be refused only after the popup opened, or announce again after a
    // restarted worker; asking again while open shows the choice once it waits, and
    // once another tab's login no longer holds the site.
    refetchInterval: (query) => (query.state.data?.ok && !query.state.data.held ? false : 1000),
    staleTime: 0,
    gcTime: 0,
  });
  // The settings may hide the section; it waits for them so a hidden one never flashes.
  const pageSectionShown = saved !== undefined && popupPageSectionShown(saved.snapshot.settings);
  // What Pateat did on the page (ADR 0038), read again while the popup is open and shown.
  // While the settings hide the section it is not asked for, so the account switch (ADR
  // 0063), part of the section, is not offered either.
  const pageStatus = useQuery({
    // Keyed by the choice, so a status read before the section was hidden never shows when
    // it is shown again.
    queryKey: ["popup", "page-status", tabId, pageSectionShown],
    queryFn: () => choices.status(tabId!),
    enabled: pageSectionShown && tabId !== undefined && origin !== undefined,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  // The site's timed pause (ADR 0062) while the page section is hidden: the pause row needs
  // only the tab's site and its pause, never the page's status.
  const pauseState = useQuery({
    queryKey: ["popup", "pause-state", tabId],
    queryFn: () => choices.pauseState(tabId!),
    enabled: saved !== undefined && !pageSectionShown && tabId !== undefined && !!origin,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  /** Reads the pause again from where the popup shows it: the page status, or the pause alone. */
  const refreshPause = () => (pageSectionShown ? pageStatus.refetch() : pauseState.refetch());
  const timedPause = pageSectionShown
    ? pageStatus.data?.ok && pageStatus.data.origin === origin
      ? pageStatus.data.pause?.until
      : undefined
    : pauseState.data?.ok
      ? pauseState.data.until
      : undefined;
  // The personal details the page asks for and the site's links (ADR 0061), read again
  // while the popup is open, since the login may stop at the page after it opened.
  const pageDetails = useQuery({
    queryKey: ["popup", "details", tabId],
    queryFn: () => details.get(tabId!),
    enabled: tabId !== undefined && origin !== undefined,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
  // Only the vault policies and each vault's sync, state and quarantine decide the matches,
  // so saving a default or a pause keeps the listed accounts instead of listing them again.
  const accounts = useQuery({
    queryKey: [
      "popup",
      "site-accounts",
      origin,
      saved &&
        JSON.stringify([
          saved.snapshot.settings.accountPolicies,
          saved.snapshot.settings.itemPolicies,
          saved.snapshot.settings.customFieldReviews,
        ]),
      saved?.catalog.settingsSyncPending ?? false,
      saved?.catalog.connections.map((entry) => [
        entry.snapshotId ?? null,
        entry.state ?? null,
        entry.quarantinedItemIds ?? [],
      ]),
    ],
    queryFn: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const over = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ListingTimeout()), listingWaitMs);
      });
      try {
        return await Promise.race([
          client.findSiteAccounts(origin!, saved!.snapshot.settings),
          over,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    enabled: Boolean(origin && saved),
    staleTime: 0,
    gcTime: 0,
  });

  /** Saves a change to the settings; false when it was not saved. */
  async function change(
    update: (value: LocalSettings) => void,
    done: NoticeText,
  ): Promise<boolean> {
    if (!saved || busy) {
      setReprompting(undefined);
      return false;
    }
    const next = structuredClone(saved.snapshot.settings);
    update(next);
    setBusy(true);
    say((translate) => translate("Saving…"), "progress");
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
        return true;
      }
      if (response.error.code === "revision-conflict") {
        await settings.refetch();
        say(
          (translate) =>
            translate(
              "The settings changed elsewhere, so this change was not saved. The popup now shows them.",
            ),
          "error",
        );
      } else
        say(
          (translate) =>
            translate("The change could not be saved. Reopen this popup and try again."),
          "error",
        );
    } catch {
      // The store may still have saved it; reopening shows the saved settings.
      say(
        (translate) =>
          translate(
            "The change may not have been saved. Reopen this popup to see the saved settings.",
          ),
        "error",
      );
    } finally {
      setBusy(false);
      setReprompting(undefined);
    }
    return false;
  }

  async function pick(
    offered: Extract<Awaited<ReturnType<ChoiceClient["get"]>>, { ok: true }>,
    selected: { connectionId: string; itemId: string; name: string },
    asDefault: boolean,
    isDefault: boolean,
  ) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Starting the login…"), "progress");
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
          (translate) =>
            asDefault
              ? translate(
                  "Logging in with {{name}}. It becomes the default once the login succeeds.",
                  {
                    name: selected.name,
                  },
                )
              : translate("Logging in with {{name}}.", { name: selected.name }),
          "success",
        );
        // The login runs in the page from here; the popup has nothing left to show.
        host.close();
        return;
      }
      // The saved default stays when its own pick fails, so only another account is said
      // not to have become the default.
      say(
        (translate) =>
          pickFailure(
            response.reason,
            selected.name,
            asDefault && !isDefault,
            translate,
            inPrivate,
          ),
        "error",
      );
      await choice.refetch();
    } catch {
      say(
        (translate) =>
          translate("The login could not be started. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(
    selected: { connectionId: string; itemId: string; name: string },
    asDefault: boolean,
  ) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say(
      (translate) => translate("Logging out to switch to {{name}}…", { name: selected.name }),
      "progress",
    );
    try {
      const response = await choices.switchTo({
        tabId,
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        makeDefault: asDefault,
      });
      // The page section follows the switch from here.
      if (response.ok) setNotice({ tone: "success" });
      else say((translate) => switchRefusal(response.reason, selected.name, translate), "error");
      await refreshPause();
    } catch {
      say(
        (translate) =>
          translate("The switch could not be started. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pauses automatic login of the tab's site for `length`, until turned back on with an
   * exclusion rule, or resumes it, also removing the site's own rules (ADR 0062).
   */
  async function setPause(length: PauseLength | "rule" | undefined) {
    if (tabId === undefined || busy || !origin) return;
    const rules = saved && siteRules(saved.snapshot.settings, origin);
    if (length === "rule") {
      if (
        rules &&
        (await change(
          (value) => rules.pause(value),
          (translate) => translate("Automatic login on this site is paused until turned back on."),
        ))
      )
        void refreshPause();
      return;
    }
    // Resume removes the site's own rule first; a pause of a length then ends too.
    if (length === undefined && rules?.rules.length) {
      const removed = await change(
        (value) => rules.resume(value),
        (translate) => translate("Automatic login on this site resumed."),
      );
      if (!removed || timedPause === undefined) {
        void refreshPause();
        return;
      }
    }
    setBusy(true);
    say((translate) => translate(length ? "Pausing…" : "Resuming…"), "progress");
    try {
      const response = await choices.pause(
        tabId,
        length ? { paused: true, length } : { paused: false },
      );
      if (response.ok) {
        const lengthChosen = PAUSE_CHOICES.find((entry) => entry.length === length);
        say(
          (translate) =>
            lengthChosen
              ? lengthChosen.done(translate)
              : translate("Automatic login on this site resumed."),
          "success",
        );
        await refreshPause();
        if (choice.isEnabled) void choice.refetch();
      } else
        say(
          (translate) =>
            translate(
              response.reason === "no-site"
                ? "This tab has no site to pause."
                : "The pause could not be saved. Try again.",
            ),
          "error",
        );
    } catch {
      say(
        (translate) =>
          translate("The pause could not be changed. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function fillDetail(documentId: string, detail: LoginDetail, source: DetailSource) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Filling…"), "progress");
    try {
      const response = await details.fill({
        tabId,
        documentId,
        detail,
        connectionId: source.connectionId,
        itemId: source.itemId,
        fieldId: source.fieldId,
      });
      say(
        (translate) =>
          response.ok
            ? translate(
                "Filled. Check it and submit the form; Pateat saves this choice once you are signed in.",
              )
            : detailFillFailure(response.reason, translate),
        response.ok ? "success" : "error",
      );
      await pageDetails.refetch();
    } catch {
      say(
        (translate) => translate("Nothing was filled. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeDetail(detail: LoginDetail) {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Removing…"), "progress");
    try {
      const response = await details.remove(tabId, detail);
      if (response.ok)
        say(
          (translate) =>
            translate("Removed. Pateat no longer fills {{detail}} on this site.", {
              detail: detailName(detail, translate),
            }),
          "success",
        );
      else if (response.reason === "no-link")
        say((translate) => translate("This link was already removed."), "success");
      else
        say(
          (translate) =>
            translate("The link could not be removed. Reopen this popup and try again."),
          "error",
        );
      await pageDetails.refetch();
    } catch {
      say(
        (translate) =>
          translate("The link may not have been removed. Reopen this popup to see the links."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function askAgain() {
    if (tabId === undefined || busy) return;
    setBusy(true);
    say((translate) => translate("Opening the master password window…"), "progress");
    try {
      // Answered once the window is done; the popup closes on its own as the window opens.
      const response = await choices.reprompt(tabId);
      if (response.ok) {
        // The window asks from here; the popup would stay over it.
        host.close();
        return;
      }
      say(
        (translate) =>
          response.reason === "unavailable"
            ? translate(
                "The master password window could not open. It opens only for the active tab outside incognito, one window at a time.",
              )
            : response.reason === "closed"
              ? translate("The master password window was closed before the vault item was used.")
              : translate("This page no longer waits for the master password. Reload it."),
        "error",
      );
    } catch {
      say(
        (translate) =>
          translate("The master password window could not open. Reopen this popup and try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

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
    // While the tab asks, the saved default is listed first (ADR 0021 D).
    const pickOptions = siteAccountOptions(catalog, matches, false, saved.snapshot.settings).sort(
      (a, b) => Number(b.value === currentValue) - Number(a.value === currentValue),
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
    const savedDefault: Omit<AccountCard, "value"> | undefined = current && {
      title:
        currentConnection?.items.find((item) => item.id === current.itemId)?.label ??
        current.itemName ??
        current.itemId,
      sub:
        currentConnection?.label ??
        t("{{account}}, not available here", {
          account: current.accountName ?? t("Vault account"),
        }),
      isDefault: true,
    };
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
      void change(
        (value) => {
          value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
          value.siteDefaults.push(entry);
        },
        (translate) =>
          translate("{{name}} is now the default for this site.", {
            name: accountName(selected, found?.accounts),
          }),
      );
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
    // the site until turned back on, and wins over a pause of a length.
    const pause: SitePause = inPrivate
      ? { kind: "private" }
      : rules.shared.length
        ? { kind: "shared", rules: rules.shared }
        : rules.rules.length
          ? { kind: "rule" }
          : timedPause !== undefined
            ? { kind: "until", until: timedPause }
            : { kind: "running" };
    // With the page section hidden, any tab with a site to pause shows the row.
    const ruled = inPrivate || rules.rules.length > 0;
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
                cards={accountCards(pickOptions, found?.accounts, currentValue, usedValue)}
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
              {t("Make it the default for {{hostname}}", { hostname })}
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
                    shownPick === currentValue,
                  );
              }}
            >
              <LogIn size={16} strokeWidth={2} aria-hidden="true" />
              {t("Log in")}
            </Button>
          </section>
        )}
        {offered && (showChoice || !labelled) ? (
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
                {t("Default account")}
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
                  <span>{t("A default takes effect at the next login.")}</span>
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
      {body}
    </main>
  );
}
