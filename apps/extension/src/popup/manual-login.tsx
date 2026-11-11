import type { TFunction } from "i18next";
import type { SettingsResponse, SiteAccountsResponse } from "@pateat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, LogIn } from "lucide-react";
import { i18n } from "../i18n";
import type { ManualClient, ManualOfferResponse } from "../login/manual-wire";
import { Button } from "../options/button";
import { siteAccountOptions } from "../options/site-policy";

/** Explain blockers without exposing internal refusal codes in the popup. */
export function manualReason(reason: string | undefined, t: TFunction): string {
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
    case "already-signed-in":
      return t("This tab is already signed in. Use Switch account to change accounts.");
    case "page-changed":
    case "stale-document":
    case "document-gone":
    case "no-document":
      return t("The page changed or is not ready. Reload it, then try again.");
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
      return t(
        "The page cannot be checked again right now. Check Diagnostics for availability or limits, then try later.",
      );
    case "timed-out":
      return t(
        "Preparing this login took too long. Nothing else will start from this request. Try again.",
      );
    case "master-password-reprompt":
      return t("Enter the master password in Pateat's window to continue this login.");
    case "closed":
      return t("The master password window was closed. Try again when you are ready.");
    default:
      return t("The login could not start. Check Diagnostics for the reason, then try again.");
  }
}

type Offer = Extract<ManualOfferResponse, { ok: true }>;
const targetKey = (target: Offer["targets"][number]) =>
  JSON.stringify([target.document.frameId, target.document.documentId, target.scope]);

/** An explicit, one-time login stays available independently of the optional page-status section. */
export function ManualLogin({
  client,
  tabId,
  saved,
  accounts,
  disabled,
  onBusy,
  onStarted,
  onReprompt,
}: {
  client: ManualClient;
  tabId: number;
  saved: Extract<SettingsResponse, { ok: true }>;
  accounts?: Extract<SiteAccountsResponse, { ok: true }> | undefined;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onStarted(): void;
  onReprompt(): void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [target, setTarget] = useState("");
  const [account, setAccount] = useState("");
  const [submitted, setSubmitted] = useState<string>();
  const [failure, setFailure] = useState<string>();
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
          answer.reason === "origin-busy" ||
          answer.reason === "login-running")
        ? 1000
        : false;
    },
  });
  const found = offer.data?.ok ? offer.data : undefined;
  if (!target && found?.targets[0]) setTarget(targetKey(found.targets[0]));
  const selected = target
    ? found?.targets.find((entry) => targetKey(entry) === target)
    : found?.targets[0];
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
  const preparing = found?.status?.state === "evaluating" || found?.status?.state === "generating";
  useEffect(() => {
    if (submitted && found?.status?.requestId === submitted && found.status.state === "started")
      onStarted();
  }, [submitted, found?.status?.requestId, found?.status?.state, onStarted]);

  async function start() {
    if (!selected || !picked || disabled || preparing || running.current) return;
    running.current = true;
    onBusy(true);
    const requestId = crypto.randomUUID();
    setSubmitted(requestId);
    setFailure(undefined);
    try {
      const response = await client.start({
        requestId,
        document: selected.document,
        scope: selected.scope,
        connectionId: picked.connectionId,
        itemId: picked.itemId,
      });
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
  const reason =
    failure ??
    (found?.status?.state === "blocked"
      ? found.status.reason
      : target && !selected && !preparing
        ? "page-changed"
        : account && !picked && !preparing
          ? "no-account"
          : found?.reason);
  return (
    <section className="popup-section" aria-labelledby="popup-manual-heading">
      <div className="popup-section-head">
        <h2 id="popup-manual-heading">{t("Log in now")}</h2>
        <p className="popup-muted popup-reason">
          {t("Try once with a matching account. Automatic login settings stay the same.")}
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
            {found.targets.map((entry, index) => (
              <option key={targetKey(entry)} value={targetKey(entry)}>
                {entry.document.frameId === 0
                  ? t("This page ({{hostname}})", {
                      hostname: new URL(entry.document.origin).hostname,
                    })
                  : t("Embedded form {{number}} ({{hostname}})", {
                      number: index + 1,
                      hostname: new URL(entry.document.origin).hostname,
                    })}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <label className="popup-muted" htmlFor="popup-manual-account">
          {t("Account to log in with")}
          <select
            id="popup-manual-account"
            value={picked?.value ?? ""}
            disabled={disabled || preparing}
            onChange={(event) => {
              setAccount(event.target.value);
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
      <output id="popup-manual-status" className="popup-muted" aria-live="polite">
        {preparing
          ? found?.status?.reason === "master-password-reprompt"
            ? manualReason("master-password-reprompt", t)
            : found?.status?.state === "generating"
              ? t("Checking the page before starting the login…")
              : t("Preparing this login…")
          : reason || offer.isError
            ? manualReason(reason, t)
            : undefined}
      </output>
      {preparing && found?.status?.reason === "master-password-reprompt" && (
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
        ) : (
          <LogIn size={16} strokeWidth={2} aria-hidden="true" />
        )}
        {t("Log in now")}
      </Button>
    </section>
  );
}
