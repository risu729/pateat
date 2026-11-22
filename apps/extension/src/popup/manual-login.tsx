import type { TFunction } from "i18next";
import type { SettingsResponse, SiteAccountsResponse } from "@pateat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { i18n } from "../i18n";
import type { ConfirmFillStatus, ManualClient, ManualOfferResponse } from "../login/manual-wire";
import { Button } from "../options/button";
import { siteAccountOptions } from "../options/site-policy";
import { ssoReason } from "./sso-reasons";

export type { ManualClient } from "../login/manual-wire";

/** Explain blockers without exposing internal refusal codes in the popup. */
export function manualReason(reason: string | undefined, t: TFunction, fill = false): string {
  switch (reason) {
    case "vault-unavailable":
    case "connection-locked":
    case "vault-locked":
      return t("Unlock your vault in settings, then try again.");
    case "no-site-access":
    case "permission-denied":
    case "unauthorized-document":
      return t("Allow Pateat to access this site in Chrome, then reload the page.");
    case "no-account":
    case "not-a-candidate":
    case "item-uri-unevaluated":
      return t(
        "No eligible account matches this page. Check the item's site address and sync the vault.",
      );
    case "origin-busy":
    case "login-running":
    case "tab-busy":
    case "preparing":
      return t("Another login is still running. Finish or stop it, then try again.");
    case "page-changed":
    case "stale-document":
    case "document-gone":
      return t("The page changed or is not ready. Reload it, then try again.");
    // Shown on every web page: one without a sign-in form is not asked to reload.
    case "no-document":
      return t("No sign-in form was found on this page.");
    case "cancelled":
      return t("Cancelled. Nothing will start from this request.");
    case "not-a-login-page":
    case "form-not-ready":
    case "sign-in-page-required":
    case "nothing-offered":
    case "no-input":
    case "no-list":
    case "text-answer":
      return t(
        "No login form could be used on this page. Open the site's sign-in page and try again.",
      );
    case "repair-not-due":
    case "sent":
    case "sending":
    case "recently-tried":
    case "not-connected":
    case "busy":
    case "daily-limit":
    case "monthly-limit":
    case "repair-limit":
    case "recipe-limit":
    case "credentials-not-configured":
    case "credentials-rejected":
    case "issuer-unavailable":
    case "token-exchange-failed":
    case "spending-limit":
    case "rate-limited":
      return fill
        ? t(
            "The page could not be checked, so nothing was filled. Check Diagnostics for availability or limits, then try later.",
          )
        : t(
            "The page cannot be checked again right now. Check Diagnostics for availability or limits, then try later.",
          );
    case "timed-out":
      return fill
        ? t("Filling took too long, so nothing was filled. Press Fill again.")
        : t(
            "Preparing this login took too long. Nothing else will start from this request. Try again.",
          );
    // The sign-in method choice a **Log in now** opened (ADR 0085, amended 2026-11-18).
    case "choice-timed-out":
    case "expired":
      return t(
        "No sign-in method was chosen in time. Nothing will start from this request. Press Log in now again.",
      );
    case "scope-changed":
    case "settings-changed":
    case "vault-changed":
    case "replaced":
    case "sso-choice-withdrawn":
      return t(
        "The page, vault or settings changed before the sign-in method was used. Press Log in now again.",
      );
    case "sso-manual-scope-unavailable":
      return t(
        "Signing in through a provider needs automatic sign-in on this site and the provider, with neither paused. Choose another method, or change Page behavior or resume the site.",
      );
    case "master-password-reprompt":
      return t("Enter the master password in Pateat's window to continue this login.");
    case "closed":
      return t("The master password window was closed. Try again when you are ready.");
    // A **Fill** press on a verification page (ADR 0035).
    case "page-off":
      return t("Verification filling is off for this site. Change it under Page behavior first.");
    case "not-a-verification-page":
    case "no-recipe-on-path":
      return t("This page was not recognized as a verification page, so nothing was filled.");
    case "field-unavailable":
      return t("The chosen field could not be used. Check the account, then try again.");
    case "confirm-fill-stopped":
      return t("Filling stopped. Check the page, vault and settings, then try again.");
    // A press whose page was not sent for generation (`generationSkip`).
    case "not-sent":
    case "no-vault-match":
    case "incomplete-observation":
    case "unreachable":
      return fill
        ? t(
            "The page could not be checked, so nothing was filled. Check Diagnostics for availability or limits, then try later.",
          )
        : t("The login could not start. Check Diagnostics for the reason, then try again.");
    default:
      return fill
        ? t("Nothing was filled. Check Diagnostics for the reason, then try again.")
        : // A sign-in method that stopped the login says what to do about it.
          (ssoReason(t, reason) ??
            t("The login could not start. Check Diagnostics for the reason, then try again."));
  }
}

/** Whether a **Fill** press is still at work: the popup waits and offers nothing else. */
export const fillRunning = (status: ConfirmFillStatus | undefined): boolean =>
  status?.state === "preparing" || status?.state === "generating" || status?.state === "asked";

/** What the popup says of a **Fill** press, while it runs and once it ended. */
export function fillStatusText(status: ConfirmFillStatus, t: TFunction): string {
  switch (status.state) {
    case "preparing":
      return t("Filling this page…");
    case "generating":
      return t("Checking the page before filling it…");
    case "asked":
      return t("Enter the master password in Pateat's window to fill this page.");
    case "filled":
      return t("Filled. Review the page and press its button yourself.");
    case "kept":
      return t(
        "Nothing was filled, as the fields already have values. Press the page's button yourself when ready.",
      );
    case "blocked":
      return manualReason(status.reason, t, true);
  }
}

type Offer = Extract<ManualOfferResponse, { ok: true }>;
const targetKey = (target: Offer["targets"][number]) =>
  JSON.stringify([target.document.frameId, target.document.documentId, target.scope]);

/**
 * The account choice the popup shows for the tab (ADR 0021 B): the document it waits in,
 * the accounts it offers and whether another tab's login holds the site, so its **Log in**
 * cannot be pressed. It is `"checking"` while the popup is still finding out whether the
 * tab waits for one.
 */
export type ShownChoice =
  | {
      documentId: string;
      candidates: readonly { connectionId: string; itemId: string }[];
      held: boolean;
    }
  | "checking";

/**
 * Whether **Log in now** shows beside the account choice (ADR 0088, amended 2026-11-21):
 * only where it does what the choice cannot. That is while the choice's **Log in** waits
 * for another tab's login, when it can target another document of the tab, offers **Fill**
 * or an account the choice does not, and while a request of this tab runs or this popup
 * shows how one went.
 */
export function shownBesideChoice(
  choice: ShownChoice,
  targets: Offer["targets"] | undefined,
  active: boolean,
): boolean {
  if (active) return true;
  if (choice === "checking") return false;
  return (
    choice.held ||
    (targets ?? []).some(
      (entry) =>
        entry.fill === true ||
        entry.document.documentId !== choice.documentId ||
        entry.candidates.some(
          (account) =>
            !choice.candidates.some(
              (offered) =>
                offered.connectionId === account.connectionId && offered.itemId === account.itemId,
            ),
        ),
    )
  );
}

/** The popup's section, shown on a web page once settings are read. */
export function PopupManualLogin({
  client,
  tabId,
  saved,
  accounts,
  host,
  ...rest
}: {
  client: ManualClient | undefined;
  tabId: number | undefined;
  saved: Extract<SettingsResponse, { ok: true }> | undefined;
  accounts: SiteAccountsResponse | undefined;
  host: { close(): void };
  choice?: ShownChoice | undefined;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onReprompt(): void;
}) {
  if (!client || tabId === undefined || !saved) return null;
  return (
    <ManualLogin
      {...rest}
      client={client}
      tabId={tabId}
      saved={saved}
      accounts={accounts?.ok ? accounts : undefined}
      onStarted={() => host.close()}
    />
  );
}

/** An explicit, one-time login stays available independently of the optional page-status section. */
export function ManualLogin({
  client,
  tabId,
  saved,
  accounts,
  choice,
  disabled,
  onBusy,
  onStarted,
  onReprompt,
}: {
  client: ManualClient;
  tabId: number;
  saved: Extract<SettingsResponse, { ok: true }>;
  accounts?: Extract<SiteAccountsResponse, { ok: true }> | undefined;
  /** The account choice the popup shows for the tab, if any. */
  choice?: ShownChoice | undefined;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onStarted(): void;
  onReprompt(): void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [target, setTarget] = useState("");
  const [account, setAccount] = useState("");
  // The field chosen for a verification page's one slot, as its JSON key; "" leaves it to
  // the recipe, and undefined shows the account's saved choice (ADR 0035, 2026-11-22).
  const [field, setField] = useState<string>();
  const [submitted, setSubmitted] = useState<string>();
  const [failure, setFailure] = useState<string>();
  // This popup pressed **Log in now**, **Fill** or **Cancel this login**, or saw a request
  // at work: beside an account choice, the section then stays until the popup closes, so
  // its status and result never disappear.
  const [kept, setKept] = useState(false);
  const running = useRef(false);
  const offer = useQuery({
    queryKey: ["popup", "manual", tabId, saved.snapshot.revision],
    queryFn: () => client.get(tabId),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => {
      const answer = query.state.data;
      return answer?.ok &&
        (answer.status?.state === "evaluating" ||
          answer.status?.state === "generating" ||
          answer.status?.state === "choosing" ||
          fillRunning(answer.fill) ||
          answer.reason === "origin-busy" ||
          answer.reason === "login-running")
        ? 1000
        : false;
    },
  });
  const found = offer.data?.ok ? offer.data : undefined;
  // Until the person chooses, the tab's current first page is used. A choice of page or
  // account keeps that page, so one that went away is reported rather than replaced.
  const selected = target
    ? found?.targets.find((entry) => targetKey(entry) === target)
    : found?.targets[0];
  const frames = found?.targets.filter((entry) => entry.document.frameId !== 0) ?? [];
  const matches: Extract<SiteAccountsResponse, { ok: true }> | undefined = selected && {
    version: 1,
    ok: true,
    origin: selected.document.origin,
    complete: true,
    accounts: selected.candidates.map(
      (entry) =>
        accounts?.accounts.find(
          (listed) => listed.connectionId === entry.connectionId && listed.itemId === entry.itemId,
        ) ?? { ...entry, uri: true, passkey: false },
    ),
  };
  const options = siteAccountOptions(saved.catalog, matches, false, saved.snapshot.settings);
  const picked = account
    ? options.find((entry) => entry.value === account)
    : options.length === 1
      ? options[0]
      : undefined;
  // The fields the picked account offers for a verification page's one slot.
  const offered = selected?.candidates.find(
    (entry) => entry.connectionId === picked?.connectionId && entry.itemId === picked?.itemId,
  );
  const fieldChoices = selected?.fill === true ? offered?.fields : undefined;
  const fieldKey = field ?? (offered?.chosen ? JSON.stringify(offered.chosen) : "");
  const chosenField = fieldChoices?.find((entry) => JSON.stringify(entry.field) === fieldKey);
  // A manual login, or a **Fill** press, that is still at work: nothing else starts. A
  // login that waits for the person's sign-in method choice below is still at work too.
  const manualPreparing =
    found?.status?.state === "evaluating" ||
    found?.status?.state === "generating" ||
    found?.status?.state === "choosing";
  const preparing = manualPreparing || fillRunning(found?.fill);
  const pending = manualPreparing ? found?.status?.requestId : undefined;
  // This popup's own press, or one still at work, shows how it goes.
  const press =
    found?.fill && (fillRunning(found.fill) || found.fill.requestId === submitted)
      ? found.fill
      : undefined;
  // A verification page offers **Fill** in place of **Log in now** (ADR 0035): the chosen
  // account's password goes in, and the person presses the page's button.
  const filling = selected ? selected.fill === true : press !== undefined;
  // A request seen at work keeps the section, as React allows a component to adjust its
  // own state while it renders.
  if (preparing && !kept) setKept(true);
  useEffect(() => {
    if (
      submitted &&
      ((found?.status?.requestId === submitted && found.status.state === "started") ||
        (found?.fill?.requestId === submitted && found.fill.state === "filled"))
    )
      onStarted();
  }, [
    submitted,
    found?.status?.requestId,
    found?.status?.state,
    found?.fill?.requestId,
    found?.fill?.state,
    onStarted,
  ]);

  async function start() {
    if (!selected || !picked || disabled || preparing || running.current) return;
    running.current = true;
    setKept(true);
    onBusy(true);
    const requestId = crypto.randomUUID();
    setSubmitted(requestId);
    setFailure(undefined);
    const request = {
      requestId,
      document: selected.document,
      scope: selected.scope,
      connectionId: picked.connectionId,
      itemId: picked.itemId,
    };
    try {
      if (selected.fill) {
        // Only a field the person changed is sent: a saved one already holds.
        const response = await client.fill({
          ...request,
          ...(field && chosenField ? { field: chosenField.field } : {}),
        });
        if (response.ok && response.state === "filled") onStarted();
        else if (!response.ok) setFailure(response.reason);
        await offer.refetch();
        return;
      }
      const response = await client.start(request);
      if (response.ok && response.state === "started") onStarted();
      else if (!response.ok) setFailure(response.reason);
      await offer.refetch();
    } catch {
      setFailure("unavailable");
    } finally {
      running.current = false;
      onBusy(false);
    }
  }
  async function cancel() {
    if (!pending || running.current) return;
    running.current = true;
    setKept(true);
    onBusy(true);
    try {
      await client.cancel(tabId, pending);
      await offer.refetch();
    } catch {
      setFailure("unavailable");
    } finally {
      running.current = false;
      onBusy(false);
    }
  }
  const reason =
    failure ??
    (found?.status?.state === "blocked"
      ? found.status.reason
      : target && !selected && !preparing
        ? "page-changed"
        : account && !picked && !preparing
          ? "no-account"
          : found?.reason);
  // The account choice is the place to log in while it shows; Log in now stays only for
  // what the choice cannot do (owner, 2026-11-21 11:26 UTC).
  if (choice && !shownBesideChoice(choice, found?.targets, kept || preparing)) return null;
  return (
    <section className="popup-section" aria-labelledby="popup-manual-heading">
      <div className="popup-section-head">
        <h2 id="popup-manual-heading">{filling ? t("Fill") : t("Log in now")}</h2>
        <p className="popup-muted popup-reason">
          {filling
            ? t(
                "This page asks you to verify while signed in. Fill enters the chosen account's password once, or its secret answer when the page asks for one; Pateat presses no button.",
              )
            : t("Try once with a matching account. Automatic login settings stay the same.")}
        </p>
      </div>
      {offer.isPending && <p className="popup-muted">{t("Checking this page…")}</p>}
      {found && (found.targets.length > 1 || (target && !selected && found.targets.length > 0)) && (
        <label className="popup-muted" htmlFor="popup-manual-target">
          {t("Page to log in to")}
          <select
            id="popup-manual-target"
            value={selected ? targetKey(selected) : ""}
            disabled={disabled || preparing}
            onChange={(event) => {
              setTarget(event.target.value);
              setAccount("");
              setFailure(undefined);
            }}
          >
            <option value="" disabled>
              {t("Choose a page")}
            </option>
            {found.targets.map((entry) => (
              <option key={targetKey(entry)} value={targetKey(entry)}>
                {entry.document.frameId === 0
                  ? t("This page ({{hostname}})", {
                      hostname: new URL(entry.document.origin).hostname,
                    })
                  : t("Embedded form {{number}} ({{hostname}})", {
                      number: frames.indexOf(entry) + 1,
                      hostname: new URL(entry.document.origin).hostname,
                    })}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <label className="popup-muted" htmlFor="popup-manual-account">
          {filling ? t("Account to fill") : t("Account to log in with")}
          <select
            id="popup-manual-account"
            value={picked?.value ?? ""}
            disabled={disabled || preparing}
            onChange={(event) => {
              if (!target) setTarget(targetKey(selected));
              setAccount(event.target.value);
              setField(undefined);
              setFailure(undefined);
            }}
          >
            <option value="" disabled>
              {t("Choose an account")}
            </option>
            {options.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label} — {entry.connectionLabel}
              </option>
            ))}
          </select>
        </label>
      )}
      {fieldChoices && (
        <label className="popup-muted" htmlFor="popup-manual-field">
          {t("Field to fill")}
          <select
            id="popup-manual-field"
            value={fieldKey}
            disabled={disabled || preparing}
            aria-describedby="popup-manual-field-note"
            onChange={(event) => {
              setField(event.target.value);
              setFailure(undefined);
            }}
          >
            {!offered?.chosen && <option value="">{t("As the page's recipe decides")}</option>}
            {fieldChoices.map((entry) => (
              <option key={JSON.stringify(entry.field)} value={JSON.stringify(entry.field)}>
                {entry.name ?? t("The account's password")}
              </option>
            ))}
          </select>
          <span id="popup-manual-field-note">
            {t("The chosen field is saved for this account and used on this page from now on.")}
          </span>
        </label>
      )}
      <output id="popup-manual-status" className="popup-muted" aria-live="polite">
        {manualPreparing
          ? found?.status?.reason === "master-password-reprompt"
            ? manualReason("master-password-reprompt", t)
            : found?.status?.state === "generating"
              ? t("Checking the page before starting the login…")
              : found?.status?.state === "choosing"
                ? t("Choose how to sign in under Sign-in method below. The login starts then.")
                : t("Preparing this login…")
          : press && (fillRunning(press) || !failure)
            ? fillStatusText(press, t)
            : reason || offer.isError
              ? manualReason(reason, t, filling)
              : undefined}
      </output>
      {manualPreparing && found?.status?.reason === "master-password-reprompt" && (
        <Button type="button" disabled={disabled} onClick={onReprompt}>
          {t("Enter the master password")}
        </Button>
      )}
      <Button
        id="popup-manual-start"
        type="button"
        className="w-full gap-2"
        disabled={disabled || preparing || !selected || !picked}
        aria-describedby="popup-manual-status"
        onClick={() => void start()}
      >
        {preparing ? (
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
        ) : filling ? (
          <KeyRound size={16} strokeWidth={2} aria-hidden="true" />
        ) : (
          <LogIn size={16} strokeWidth={2} aria-hidden="true" />
        )}
        {filling ? t("Fill") : t("Log in now")}
      </Button>
      {pending && (
        <Button type="button" variant="outline" disabled={disabled} onClick={() => void cancel()}>
          {t("Cancel this login")}
        </Button>
      )}
    </section>
  );
}
