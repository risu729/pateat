import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import {
  isSiteExcluded,
  normalizeHostname,
  parseSiteUrl,
  siteDefaultConnection,
  type LocalSettings,
  type LoginDetail,
  type SettingsResponse,
  type SiteAccountsResponse,
} from "@pateat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CalendarDays,
  CircleCheck,
  CircleX,
  Clock,
  CreditCard,
  Info,
  LoaderCircle,
  LogIn,
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
import { choiceReason, pickFailure, type ChoiceClient } from "../login/choice-wire";
import {
  detailFillFailure,
  detailName,
  type DetailClient,
  type DetailResponse,
} from "../login/detail-wire";
import { PageStatusSection } from "./page-status";

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
  openSettings(): void;
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
type ExcludedSite = LocalSettings["excludedSites"][number];
type Tone = "progress" | "success" | "error";
type NoticeText = (translate: TFunction) => string;

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
  const { t } = useTranslation(undefined, { i18n });
  const checked = pending ?? site.on;
  return (
    <label className="popup-switch">
      <span>{t("Pateat on this site")}</span>
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
            aria-label={t(card.isDefault ? "{{title}}, {{sub}}, default" : "{{title}}, {{sub}}", {
              title: card.title,
              sub: card.sub,
            })}
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
  const Icon = DETAIL_ICON[detail];
  const seen = new Map<string, number>();
  for (const source of candidates)
    seen.set(sourceLabel(source), (seen.get(sourceLabel(source)) ?? 0) + 1);
  return (
    <div className="popup-choices">
      {candidates.map((source) => {
        const title = sourceLabel(source);
        // Fields that would read the same add their item ID's first 8 characters.
        const sub = (seen.get(title) ?? 0) > 1 ? `ID ${source.itemId.slice(0, 8)}` : undefined;
        return (
          <label key={sourceValue(source)} className="popup-choice">
            <input
              type="radio"
              name={`popup-detail-${detail}`}
              value={sourceValue(source)}
              checked={checked === sourceValue(source)}
              disabled={disabled}
              aria-label={sub ? `${title}, ${sub}` : title}
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
      {offer?.details.map(({ detail, format, candidates }) => {
        const picked = picks[detail];
        const shown = candidates.find((source) => sourceValue(source) === picked) ?? candidates[0]!;
        return (
          <fieldset key={detail} className="popup-fieldset popup-detail">
            <legend id={`popup-detail-${detail}`} className="popup-detail-ask">
              {t("This page asks for {{detail}}.", { detail: detailName(detail, t, format) })}
            </legend>
            <DetailChoices
              detail={detail}
              candidates={candidates}
              checked={sourceValue(shown)}
              disabled={busy}
              onChange={(value) => onPick(detail, value)}
            />
            <Button
              id={`popup-detail-fill-${detail}`}
              type="button"
              className="w-full gap-2"
              // Kept focusable while a fill runs, since Chrome moves focus away from a
              // focused control that becomes disabled.
              disabled={busy}
              focusableWhenDisabled
              aria-describedby={`popup-detail-${detail}`}
              onClick={() => onFill(detail, shown)}
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
 * its exclusion, through the same worker-owned store as the settings page (ADR 0021).
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
  // The switch shows its new position while that change is saved.
  const [switching, setSwitching] = useState<boolean>();
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
  const excluded = Boolean(origin && saved && isSiteExcluded(saved.snapshot.settings, origin));
  // A login refused because several accounts match waits for a pick (ADR 0021). An excluded
  // site runs no login, so a choice the worker still keeps from before is not offered.
  const choice = useQuery({
    queryKey: ["popup", "choice", tabId],
    queryFn: () => choices.get(tabId!),
    enabled: tabId !== undefined && origin !== undefined && saved !== undefined && !excluded,
    // The page may be refused only after the popup opened, or announce again after a
    // restarted worker; asking again while open shows the choice once it waits, and
    // once another tab's login no longer holds the site.
    refetchInterval: (query) => (query.state.data?.ok && !query.state.data.held ? false : 1000),
    staleTime: 0,
    gcTime: 0,
  });
  // What Pateat did on the page (ADR 0038), read again while the popup is open.
  const pageStatus = useQuery({
    queryKey: ["popup", "page-status", tabId],
    queryFn: () => choices.status(tabId!),
    enabled: tabId !== undefined && origin !== undefined,
    refetchInterval: 1000,
    staleTime: 0,
    gcTime: 0,
  });
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
    enabled: Boolean(origin && saved && !excluded),
    staleTime: 0,
    gcTime: 0,
  });

  async function change(update: (value: LocalSettings) => void, done: NoticeText) {
    if (!saved || busy) {
      setSwitching(undefined);
      return;
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
      } else if (response.error.code === "revision-conflict") {
        await settings.refetch();
        say(
          (translate) => translate("Changed elsewhere and reloaded. Nothing was changed."),
          "error",
        );
      } else say((translate) => translate("The change could not be saved"), "error");
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
      setSwitching(undefined);
    }
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
              : translate("Logging in with {{name}}", { name: selected.name }),
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
          pickFailure(response.reason, selected.name, asDefault && !isDefault, translate),
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

  const openSettings = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    host.openSettings();
  };
  let switchControl;
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
        <span>{t("Pateat settings could not be loaded")}</span>
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
            (translate) =>
              on
                ? translate("{{hostname}} is no longer excluded", { hostname })
                : translate("{{hostname}} is now excluded", { hostname }),
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
    // A disabled query keeps its last answer, so the exclusion is checked here too.
    const offered =
      !excluded && choice.data?.ok && choice.data.origin === origin ? choice.data : undefined;
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
          "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup",
        ),
      };
    else if (!found)
      accountsNote = { tone: "err", text: t("The matching accounts could not be listed") };
    else if (!options.length)
      accountsNote = {
        tone: "idle",
        text: t(
          "No vault item matches this site. Add the site's URI or passkey to the item in your vault, then sync",
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
          translate("{{name}} is now the default for this site", {
            name: accountName(selected, found?.accounts),
          }),
      );
    };

    const removeDefault = () =>
      void change(
        (value) => {
          value.siteDefaults = value.siteDefaults.filter((item) => item.origin !== origin);
        },
        (translate) => translate("The default account for this site was removed"),
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
      pageStatus.data?.ok && pageStatus.data.origin === origin ? pageStatus.data : undefined;
    const detailState =
      pageDetails.data?.ok && pageDetails.data.origin === origin ? pageDetails.data : undefined;
    // An excluded site runs no login, so an offer the worker still keeps is not filled.
    const detailOffer = excluded ? undefined : detailState?.offer;
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
          <PageStatusSection status={status} onOpenDiagnostics={() => host.openDiagnostics()}>
            {detailSection}
          </PageStatusSection>
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
                {choiceReason(offered.logout, pickOptions.length, t)}
              </p>
            </div>
            {offered.held && (
              <p id="popup-pick-held" className="popup-notice popup-notice--warning">
                <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
                <span>
                  {t(
                    "Another tab's login to this site is running or did not succeed. Close that tab or wait up to 5 minutes.",
                  )}
                </span>
              </p>
            )}
            <fieldset className="popup-fieldset">
              <legend className="visually-hidden">{t("Account to log in with")}</legend>
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
                      {t("The saved default, {{title}} ({{sub}}), is not one of these accounts", {
                        title: missingFromChoice.title,
                        sub: missingFromChoice.sub,
                      })}
                    </Line>
                  )}
                  {found && !found.complete && (
                    <Line tone="warn" id="popup-accounts-incomplete">
                      {t(
                        "Some vaults or items could not be checked, so the site's matches may be incomplete",
                      )}
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
                  {t("No default account. With exactly one matching item, Pateat uses that item")}
                </Line>
              )}
              {found && !found.complete && (
                <Line tone="warn" id="popup-accounts-incomplete">
                  {t("Some vaults or items could not be checked, so this list may be incomplete")}
                </Line>
              )}
              <li className="popup-line popup-line--idle">
                <Clock size={16} strokeWidth={2} aria-hidden="true" />
                <span>{t("Takes effect at the next login")}</span>
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
        ) : (
          <div className="popup-section">
            {!site.editable && (
              <>
                <p id="popup-site-shared">{t("Excluded by a rule for other sites too")}</p>
                <ul className="popup-rules">
                  {site.shared.map((rule) => (
                    <li key={`${rule.hostname} ${rule.includeSubdomains}`}>
                      <span className="popup-choice-main">
                        <span className="popup-choice-title">{rule.hostname}</span>
                        <span className="popup-choice-sub">{t("and its subdomains")}</span>
                      </span>
                      <a
                        href="options.html"
                        className="popup-link"
                        aria-label={t("Change in settings for {{hostname}}", {
                          hostname: rule.hostname,
                        })}
                        onClick={openSettings}
                      >
                        {t("Change in settings")}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p id="popup-site-status" className="popup-muted popup-status">
              <Ban size={16} strokeWidth={2} aria-hidden="true" />
              {t("No logins or passkey answers on this site")}
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
        {switchControl}
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
      {body}
    </main>
  );
}
