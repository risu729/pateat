import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Bug, CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { StatusResponse } from "../login/choice-wire";

type Status = Extract<StatusResponse, { ok: true }>;
export type StatusTone = "idle" | "busy" | "ok" | "warn" | "err";
export type StatusLine = { id: string; tone: StatusTone; text: string };

/** Why a login ended, in plain words; an outcome missing here shows as the log names it. */
const OUTCOMES: Record<string, string> = {
  "credential-rejected": "the site did not accept the password",
  "retry-limit": "the steps kept failing, and the retry limit was reached",
  "submission-limit": "the login was already submitted as often as allowed",
  "unknown-submit": "the page after submitting did not show whether it worked",
  "structural-mismatch": "the page did not match the recipe",
  timeout: "the page did not respond in time",
  "left-origin": "the tab moved to another site during the login",
  interrupted: "the page moved on before submitting, or Pateat restarted",
  "value-mismatch": "a value did not fit its input, so nothing was filled",
  "fill-rejected": "the page marked a filled input as invalid, so nothing was pressed",
  "wrong-account": "the page shows a different account from the one chosen",
  "account-switched": "the page showed another account, so the login switched accounts",
  "account-not-listed": "the list of accounts does not show this account",
  challenge: "the site asks for another step, such as a code",
  "challenge-abandoned": "the site's other step was not finished",
  "watch-abandoned": "no later page showed that the login finished",
  cancelled: "the login was cancelled",
  "policy-changed": "the settings or the vault changed during the login",
};
/**
 * Why a login ended after Pateat pressed keys on the page's software keyboard
 * (`keypad-pressed`, ADR 0067), where it differs from {@link OUTCOMES}.
 */
const KEYPAD_OUTCOMES: Record<string, string> = {
  "fill-rejected":
    "the page's software keyboard did not show a key Pateat pressed, so nothing more was pressed",
};
/** Outcomes that end a login without a failure (ADR 0038 item 4). */
const QUIET = new Set(["cancelled", "account-switched", "interrupted", "policy-changed"]);
/** Outcomes that are known but not a failure: the badge shows a yellow `!` for them. */
const UNSETTLED = new Set([
  "challenge",
  "unknown-submit",
  "challenge-abandoned",
  "watch-abandoned",
  "left-origin",
]);
/** Failures of the recipe itself, which Pateat does not make again on its own. */
const RECIPE_FAILURES = new Set(["structural-mismatch", "timeout", "retry-limit"]);

/** Why the page's sign-in did not start a login, in plain words. */
const NOT_STARTED: Record<string, string> = {
  "logged-in": "this site is already logged in",
  "stopped-login": "the last login on this site stopped in this tab",
  "first-step-missing": "the sign-in form shows, but the recipe's first step was not found",
  "no-recipe-on-path": "no recipe of this site starts on this page",
  "confirm-unsupported":
    "the AI classified this page as a verification while signed in, or could not tell, so Pateat does not fill it; if that is wrong, revoke its recipe on the service's Sites page (/manage/sites) so the page is sent again",
  "logged-out": "Pateat waits for you to choose an account",
  "account-ambiguous": "several accounts match; choose one to log in",
  "origin-busy": "another tab's login to this site is running or did not succeed",
  "tab-busy": "another login runs in this tab",
  "attempt-limit": "Pateat already holds as many login records as it can",
  "storage-unavailable": "Pateat could not save the login's state",
  "no-route": "the recipe has no way to log in with this vault item",
  "entry-blocked": "the site's sign-in link was not pressed",
  "account-changed": "the chosen account changed",
  "field-unavailable":
    "the vault item's username could not be read, so its account cannot be found on the list",
};

/** Why a page was not sent to the AI, in plain words. */
const NOT_SENT: Record<string, string> = {
  sending: "another request for this page is already being sent to the AI",
  sent: "the AI was asked about this page within the last 10 minutes, so it is not asked again yet",
  "not-connected": "Pateat cannot use the sync service on this device",
  "no-vault-match": "no vault item matches this site",
  "vault-unavailable": "the vault could not be read",
  "connection-disabled": "the vault connection is turned off",
  "after-sign-in": "this page came right after a sign-in",
  "nothing-offered": "the page showed no sign-in form",
};

const plain = (table: Record<string, string>, code: string, t: TFunction) =>
  Object.hasOwn(table, code) ? t(table[code] ?? code) : code;

/**
 * Why a login of a vault item without a password did not go on to its passkey (ADR 0036,
 * ADR 0049), in plain words, by the `password-empty:<why>` detail.
 */
const NO_PASSWORD: Record<string, string> = {
  "no-passkey": "the vault item has neither a password nor a passkey",
  "no-advance": "the vault item has no password, and the recipe has no way on without one",
  alternatives:
    "the vault item has no password, and Pateat goes on to a passkey only on a recipe with one way to sign in",
  "no-password-step":
    "the vault item has no password, and the recipe neither asks for one nor goes on to another page",
  "fills-lacking":
    "the vault item has no password, and the recipe needs another value the item lacks before it",
  "password-field":
    "the vault item has no password, and the account fills its password from another field",
  "later-start": "the vault item has no password, and this page asks for it",
  frame:
    "the vault item has no password, and Pateat goes on without one only in the page itself, not in a frame",
};
/**
 * Details whose item holds a usable passkey: only a discoverable one signs in, and only when
 * the page asks for a passkey by itself or the recipe has a passkey button (ADR 0027,
 * ADR 0034).
 */
const HELD_PASSKEY = new Set([
  "no-advance",
  "alternatives",
  "no-password-step",
  "fills-lacking",
  "password-field",
  "later-start",
]);

/** A refusal the badge shows as a failure, in plain words. */
function refusalText(refused: NonNullable<Status["refused"]>, t: TFunction): string {
  const { reason, detail } = refused;
  if (reason === "no-route" && detail?.startsWith("password-empty")) {
    const why = detail.slice("password-empty:".length);
    const text = t(
      Object.hasOwn(NO_PASSWORD, why)
        ? (NO_PASSWORD[why] ?? "the vault item has no password")
        : "the vault item has no password",
    );
    return HELD_PASSKEY.has(why)
      ? t(
          "{{text}}. Pateat logs in with its passkey only when the passkey needs no username, and the page asks for a passkey or the recipe presses a passkey button",
          { text },
        )
      : text;
  }
  if (reason === "no-route")
    return `${t("the recipe has no way to log in with this vault item")}${detail ? ` (${detail})` : ""}`;
  return plain(NOT_STARTED, reason, t);
}

function recipeLines(status: Status, t: TFunction): StatusLine[] {
  const generation = status.generation;
  const what =
    generation?.page === "entry"
      ? t("the site's sign-in link")
      : generation?.page === "accounts"
        ? t("the site's list of accounts")
        : generation?.page === "continuation"
          ? t("the rest of the site's sign-in")
          : t("the site's sign-in page");
  const lines: StatusLine[] = [];
  if (status.recipe === "page")
    lines.push({ id: "recipe", tone: "idle", text: t("This site has a recipe for this page.") });
  else if (status.recipe === "other-paths")
    lines.push({
      id: "recipe",
      tone: "idle",
      text: t("This site has a recipe, but none starts on this page."),
    });
  else lines.push({ id: "recipe", tone: "idle", text: t("This site has no recipe yet.") });
  // Whether the request is still in flight comes from the badge's spin, which a stopped
  // worker does not leave behind.
  if (generation?.outcome === "sent" && status.asking)
    lines.push({
      id: "generation",
      tone: "busy",
      text: t("The AI is making a recipe for {{what}}…", { what }),
    });
  else if (generation?.outcome === "sent")
    lines.push({
      id: "generation",
      tone: "warn",
      text: t("A page was sent to the AI for {{what}}, and no answer was recorded.", { what }),
    });
  else if (generation?.outcome === "recipe")
    lines.push({
      id: "generation",
      tone: "ok",
      text: t("The AI made a recipe for {{what}}.", { what }),
    });
  else if (generation?.outcome === "abstained")
    lines.push({
      id: "generation",
      tone: "warn",
      text: t("The AI chose not to make a recipe for {{what}} ({{reason}}).", {
        what,
        reason: generation.reason ?? "abstained",
      }),
    });
  else if (generation)
    lines.push({
      id: "generation",
      tone: "err",
      text: t("The AI could not make a recipe for {{what}} ({{reason}}).", {
        what,
        reason: [generation.outcome, generation.reason].filter(Boolean).join(": "),
      }),
    });
  // Another request, such as the judge's on a login's next page.
  if (status.asking && generation?.outcome !== "sent")
    lines.push({ id: "asking", tone: "busy", text: t("Waiting for an answer from the AI…") });
  // A site whose recipe starts elsewhere may still send this page. An older skip of this
  // page does not show beside its request in flight.
  if (
    status.recipe !== "page" &&
    status.page?.generationSkip &&
    !status.asking &&
    generation?.outcome !== "sent"
  )
    lines.push({
      id: "generation-skip",
      tone: "idle",
      text: t("Not sent to the AI: {{why}}.", {
        why: plain(NOT_SENT, status.page.generationSkip, t),
      }),
    });
  return lines;
}

function loginLines(status: Status, t: TFunction): StatusLine[] {
  // A refusal is kept only until a login of the tab moves on, so it came after any shown.
  const refusal: StatusLine[] = status.refused
    ? [
        {
          id: "refused",
          tone: "err",
          text: t("Pateat did not log in: {{why}}.", { why: refusalText(status.refused, t) }),
        },
      ]
    : [];
  return [...attemptLines(status, t), ...refusal];
}

function attemptLines(status: Status, t: TFunction): StatusLine[] {
  const login = status.login;
  if (!login) {
    if (status.refused) return [];
    // A refusal is the page's latest word; a sign-in input that did not start is logged
    // while the page only watches.
    const why = status.page?.state === "denied" ? status.page.reason : status.page?.notStarted;
    // A page of a site with no recipe is ordinary browsing: the recipe line says enough.
    if (!why || why === "recipe-not-found") return [];
    return [
      {
        id: "login",
        tone: "idle",
        text: t("No login started: {{why}}.", { why: plain(NOT_STARTED, why, t) }),
      },
    ];
  }
  if (login.state === "authenticated")
    return [
      login.unconfirmed
        ? { id: "login", tone: "warn", text: t("The login could not be confirmed.") }
        : { id: "login", tone: "ok", text: t("Logged in.") },
    ];
  if (login.state === "logged-out")
    return [
      {
        id: "login",
        tone: "idle",
        text:
          login.outcome === "rejected"
            ? t("The site did not accept the last login; choose an account to try again.")
            : t("You were logged out of this site in this tab."),
      },
    ];
  const outcome = login.outcome ?? "";
  // A result that settled as unknown is watched as after a `challenge` (ADR 0027).
  if (login.state === "watching" || (login.state === "reconciling" && login.settled))
    return [
      {
        id: "login",
        tone: "warn",
        text:
          outcome === "challenge"
            ? t("Waiting for you to finish the site's other step, such as a code.")
            : t("The result is not known yet; the next pages are checked for it."),
      },
    ];
  if (login.state !== "blocked") return [{ id: "login", tone: "busy", text: t("Logging in…") }];
  // A login that only fills the form after a logout ends by design before anything that
  // would press a button (ADR 0021 D); a page or person that cancelled it first ends the
  // same way, so the line names the mode rather than claiming a filled form.
  if (login.fillOnly && outcome === "cancelled" && !login.cause)
    return [
      {
        id: "login",
        tone: "idle",
        text: t(
          "After a logout, Pateat only fills the sign-in form and presses nothing; sign in when you are ready.",
        ),
      },
    ];
  const why = outcome
    ? plain(
        login.cause === "keypad-pressed" && outcome in KEYPAD_OUTCOMES ? KEYPAD_OUTCOMES : OUTCOMES,
        outcome,
        t,
      )
    : t("no reason was recorded");
  const lines: StatusLine[] = [
    QUIET.has(outcome)
      ? { id: "login", tone: "idle", text: t("The login stopped: {{why}}.", { why }) }
      : UNSETTLED.has(outcome)
        ? // As the icon's title says for these (ADR 0038): not a failure, only unknown.
          {
            id: "login",
            tone: "warn",
            text: t("The result of the login is not known: {{why}}.", { why }),
          }
        : { id: "login", tone: "err", text: t("The login did not succeed: {{why}}.", { why }) },
  ];
  if (RECIPE_FAILURES.has(outcome))
    lines.push({
      id: "login-recipe",
      tone: "idle",
      text: t("This recipe is not made again automatically."),
    });
  // The field holds the characters of the keys pressed before the stop, which no step
  // clears (ADR 0067).
  if (login.cause === "keypad-pressed")
    lines.push({
      id: "login-keypad",
      tone: "warn",
      text: t(
        "Pateat pressed keys on the page's software keyboard before it stopped. Reload the page before you enter the value.",
      ),
    });
  return lines;
}

/**
 * The popup's page section as lines (ADR 0038): the site's recipe and the AI's last answer
 * for it, then the tab's last login on the page. Codes without a plain sentence show as the
 * log names them; no value, recipe step or query ever shows.
 */
export function pageStatusLines(status: Status, t: TFunction = i18n.t.bind(i18n)): StatusLine[] {
  return [...recipeLines(status, t), ...loginLines(status, t)];
}

const ICONS = {
  idle: Info,
  busy: LoaderCircle,
  ok: CircleCheck,
  warn: TriangleAlert,
  err: CircleX,
} as const;

/**
 * The popup's "This page" section: the page's status when the worker describes the page,
 * then what else the popup offers for it, such as its personal details (ADR 0061).
 */
export function PageStatusSection({
  status,
  children,
  onOpenDiagnostics,
}: {
  status: Status | undefined;
  children?: ReactNode;
  onOpenDiagnostics: () => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <section className="popup-section" aria-labelledby="popup-page-heading">
      <h2 id="popup-page-heading">{t("This page")}</h2>
      {status && (
        <ul id="popup-page-status" className="popup-lines" aria-live="polite">
          {pageStatusLines(status, t).map((line) => {
            const Icon = ICONS[line.tone];
            return (
              <li
                key={line.id}
                id={`popup-page-${line.id}`}
                className={`popup-line popup-line--${line.tone}`}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span>{line.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {children}
      <div>
        <a
          id="popup-open-diagnostics"
          href="diagnostics.html"
          className="popup-link popup-link--icon"
          onClick={(event) => {
            event.preventDefault();
            onOpenDiagnostics();
          }}
        >
          <Bug size={16} strokeWidth={2} aria-hidden="true" />
          {t("Open the detailed log")}
        </a>
      </div>
    </section>
  );
}
