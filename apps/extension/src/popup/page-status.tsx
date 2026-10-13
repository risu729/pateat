import { Bug, CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { StatusResponse } from "../login/choice-wire";

type Status = Extract<StatusResponse, { ok: true }>;
export type StatusTone = "idle" | "busy" | "ok" | "warn" | "err";
export type StatusLine = { id: string; tone: StatusTone; text: string };

/** Why a login ended, in plain words; an outcome missing here shows as the log names it. */
const OUTCOMES: Record<string, string> = {
  "credential-rejected": "the site did not accept the password",
  "retry-limit": "the steps kept failing, and the retry limit was reached",
  "submission-limit": "the sign-in was already submitted as often as allowed",
  "unknown-submit": "the result after submitting could not be judged",
  "structural-mismatch": "the page did not match the recipe",
  timeout: "the page did not respond in time",
  "left-origin": "the tab moved to another site during the login",
  interrupted: "the page moved before submitting, or the extension restarted",
  "value-mismatch": "a value did not fit its input, so nothing was filled",
  "fill-rejected": "the page marked a filled input as invalid, so nothing was pressed",
  "wrong-account": "the page shows another account than the chosen one",
  "account-switched": "the page showed another account, so the login switched accounts",
  "account-not-listed": "the list of accounts does not show this account",
  challenge: "the site asks for another step, such as a code",
  "challenge-abandoned": "the site's other step was not finished",
  "watch-abandoned": "no later page showed that the sign-in finished",
  cancelled: "the login was cancelled",
  "policy-changed": "the settings or the vault changed during the login",
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
  "logged-out": "you logged out here; choose an account to log in again",
  "account-ambiguous": "several accounts match; choose one to log in",
  "origin-busy": "another tab's login to this site is running or did not succeed",
  "tab-busy": "another login runs in this tab",
  "attempt-limit": "this page already started as many logins as allowed",
  "storage-unavailable": "Pateat could not save the login's state",
  "no-route": "the recipe has no way to log in with this account",
  "entry-blocked": "the site's sign-in link was not pressed",
  "account-changed": "the chosen account changed",
  "field-unavailable": "the account lacks a value the recipe needs",
};

/** Why a page was not sent to the AI, in plain words. */
const NOT_SENT: Record<string, string> = {
  sending: "a request for this page is being sent to the AI",
  sent: "the AI was asked about this page within the last 10 minutes, so it is not asked again yet",
  "not-connected": "Pateat is not connected to its service",
  "no-vault-match": "no vault item matches this site",
  "vault-unavailable": "the vault could not be read",
  "connection-disabled": "the vault connection is turned off",
  "after-sign-in": "this page came right after a sign-in",
  "nothing-offered": "the page showed no sign-in form",
};

const plain = (table: Record<string, string>, code: string) => table[code] ?? code;

function recipeLines(status: Status): StatusLine[] {
  const generation = status.generation;
  const what =
    generation?.page === "entry"
      ? "the site's sign-in link"
      : generation?.page === "accounts"
        ? "the site's list of accounts"
        : generation?.page === "continuation"
          ? "the rest of the site's sign-in"
          : "the site's sign-in page";
  const lines: StatusLine[] = [];
  if (status.recipe === "page")
    lines.push({ id: "recipe", tone: "idle", text: "This site has a recipe for this page." });
  else if (status.recipe === "other-paths")
    lines.push({
      id: "recipe",
      tone: "idle",
      text: "This site has a recipe, but none starts on this page.",
    });
  else lines.push({ id: "recipe", tone: "idle", text: "This site has no recipe yet." });
  // The page stays `generating` after the answer, until it announces again.
  const generating = status.page?.state === "generating";
  if (generating && (!generation || generation.outcome === "sent"))
    lines.push({ id: "generation", tone: "busy", text: `The AI is making a recipe for ${what}…` });
  else if (generation?.outcome === "sent")
    // The worker stopped, or the page went away, before the answer came back.
    lines.push({
      id: "generation",
      tone: "warn",
      text: `A page was sent to the AI for ${what}, and no answer was recorded.`,
    });
  else if (generation?.outcome === "recipe")
    lines.push({ id: "generation", tone: "ok", text: `The AI made a recipe for ${what}.` });
  else if (generation?.outcome === "abstained")
    lines.push({
      id: "generation",
      tone: "warn",
      text: `The AI chose not to make a recipe for ${what} (${generation.reason ?? "abstained"}).`,
    });
  else if (generation)
    lines.push({
      id: "generation",
      tone: "err",
      text: `The AI could not make a recipe for ${what} (${[generation.outcome, generation.reason].filter(Boolean).join(": ")}).`,
    });
  else if (status.recipe === "none" && status.page?.generationSkip)
    lines.push({
      id: "generation",
      tone: "idle",
      text: `Not sent to the AI: ${plain(NOT_SENT, status.page.generationSkip)}.`,
    });
  return lines;
}

function loginLines(status: Status): StatusLine[] {
  const login = status.login;
  if (!login) {
    const why = status.page?.notStarted ?? status.page?.reason;
    // A page of a site with no recipe is ordinary browsing: the recipe line says enough.
    if (!why || why === "recipe-not-found") return [];
    return [{ id: "login", tone: "idle", text: `No login started: ${plain(NOT_STARTED, why)}.` }];
  }
  if (login.state === "authenticated") return [{ id: "login", tone: "ok", text: "Logged in." }];
  const outcome = login.outcome ?? "";
  if (login.state === "watching")
    return [
      {
        id: "login",
        tone: "warn",
        text:
          outcome === "challenge"
            ? "Waiting for you to finish the site's other step, such as a code."
            : "The result is not known yet; the next pages are checked for it.",
      },
    ];
  if (login.state !== "blocked") return [{ id: "login", tone: "busy", text: "Logging in…" }];
  const why = outcome ? plain(OUTCOMES, outcome) : "no reason was recorded";
  const lines: StatusLine[] = [
    QUIET.has(outcome)
      ? { id: "login", tone: "idle", text: `The login stopped: ${why}.` }
      : {
          id: "login",
          tone: UNSETTLED.has(outcome) ? "warn" : "err",
          text: `The login did not succeed: ${why}.`,
        },
  ];
  if (RECIPE_FAILURES.has(outcome))
    lines.push({
      id: "login-recipe",
      tone: "idle",
      text: "This recipe is not made again automatically.",
    });
  return lines;
}

/**
 * The popup's page section as lines (ADR 0038): the site's recipe and the AI's last answer
 * for it, then the tab's last login on the page. Codes without a plain sentence show as the
 * log names them; no value, recipe step or query ever shows.
 */
export function pageStatusLines(status: Status): StatusLine[] {
  return [...recipeLines(status), ...loginLines(status)];
}

const ICONS = {
  idle: Info,
  busy: LoaderCircle,
  ok: CircleCheck,
  warn: TriangleAlert,
  err: CircleX,
} as const;

export function PageStatusSection({
  status,
  onOpenDiagnostics,
}: {
  status: Status;
  onOpenDiagnostics: () => void;
}) {
  return (
    <section className="popup-section" aria-labelledby="popup-page-heading">
      <h2 id="popup-page-heading">This page</h2>
      <ul id="popup-page-status" className="popup-lines" aria-live="polite">
        {pageStatusLines(status).map((line) => {
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
          Open the detailed log
        </a>
      </div>
    </section>
  );
}
