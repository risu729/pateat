import { visible } from "./code-submission";
import { renderedText } from "./text";

// The page signs of ADR 0029, read after an effect step that no check explained. Nothing
// read here, including the username compared with the header, leaves the content script:
// only the flags do.

/** What the page showed when an effect step ran, to compare with afterwards (F1, F2). */
export interface SubmittedPage {
  readonly invalid: ReadonlySet<HTMLInputElement>;
  readonly alerts: ReadonlySet<string>;
}

/** The page signs the content script can read (ADR 0029). */
export interface PageSigns {
  /** S2: a shown password input that is not for a new password. */
  readonly password: boolean;
  /** S3: a shown input a one-time code goes in. */
  readonly code: boolean;
  /** S4: a shown CAPTCHA widget. */
  readonly captcha: boolean;
  /** F1: an input became `aria-invalid="true"` since the effect step, in its document. */
  readonly invalid: boolean;
  /** F2: an alert shows text it did not show at the effect step, in its document. */
  readonly alert: boolean;
  /** E2: the username shows in the page header or navigation; only when one was given. */
  readonly username?: boolean;
}

const alertSelector = '[role="alert"], [aria-live="assertive"]';
const landmarkSelector = 'header, nav, [role="banner"], [role="navigation"]';
/** How much of the header and navigation is read for the username. */
const landmarkReadLimit = 4000;
/** Shorter usernames match too much unrelated text. */
const minUsernameLength = 3;
/**
 * Frames of the CAPTCHA services: reCAPTCHA (`google.com/recaptcha`, `recaptcha.net`),
 * hCaptcha and Cloudflare Turnstile.
 */
const captchaHosts = [
  /^(?:www\.)?google\.com$/u,
  /^(?:www\.)?recaptcha\.net$/u,
  /(?:^|\.)hcaptcha\.com$/u,
  /^challenges\.cloudflare\.com$/u,
];
/** A CAPTCHA frame this small is a badge or an invisible check, not a widget to solve. */
const minCaptchaSide = 30;

function writableInput(element: Element): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    visible(element) &&
    !element.disabled &&
    !element.readOnly
  );
}
const tokens = (input: HTMLInputElement) => input.autocomplete.toLowerCase().split(/\s+/u);
const ariaInvalid = (input: HTMLInputElement) =>
  input.getAttribute("aria-invalid")?.trim().toLowerCase() === "true";

function alertTexts(document: Document): Set<string> {
  const texts = new Set<string>();
  for (const element of document.querySelectorAll(alertSelector)) {
    if (!(element instanceof HTMLElement) || !element.checkVisibility({ visibilityProperty: true }))
      continue;
    const text = element.innerText.replace(/\s+/gu, " ").trim();
    if (text) texts.add(text);
  }
  return texts;
}

/** The marks and alerts the page shows now, taken just before an effect step. */
export function submittedPage(document: Document): SubmittedPage {
  return {
    invalid: new Set([...document.querySelectorAll("input")].filter(ariaInvalid)),
    alerts: alertTexts(document),
  };
}

/**
 * S2: a shown password input, except one for a new password and those of a form with two
 * or more password inputs (a password change or a registration), where the current
 * password must never go.
 */
function showsPassword(document: Document): boolean {
  const passwords = [...document.querySelectorAll("input")].filter(
    (input) => input.type === "password" || tokens(input).includes("current-password"),
  );
  return passwords.some(
    (input) =>
      writableInput(input) &&
      !tokens(input).includes("new-password") &&
      passwords.filter((other) => other.form === input.form && input.form !== null).length < 2,
  );
}

/** S3: a shown input that the executor would type a one-time code into. */
function showsCode(document: Document): boolean {
  return [...document.querySelectorAll("input")].some(
    (input) =>
      writableInput(input) &&
      (tokens(input).includes("one-time-code") ||
        ((input.inputMode === "numeric" || input.type === "tel" || input.type === "number") &&
          input.maxLength >= 1 &&
          input.maxLength <= 10)),
  );
}

/** S4: a shown frame of a CAPTCHA service large enough to be solved. */
function showsCaptcha(document: Document): boolean {
  return [...document.querySelectorAll("iframe")].some((frame) => {
    let url: URL;
    try {
      url = new URL(frame.src);
    } catch {
      return false;
    }
    if (!captchaHosts.some((host) => host.test(url.hostname))) return false;
    if (url.hostname.endsWith("google.com") && !url.pathname.startsWith("/recaptcha/"))
      return false;
    if (url.searchParams.get("size") === "invisible") return false;
    const box = frame.getBoundingClientRect();
    return visible(frame) && box.width >= minCaptchaSide && box.height >= minCaptchaSide;
  });
}

/** E2: the username, ignoring case, as a whole word of the header or navigation text. */
function showsUsername(document: Document, username: string): boolean {
  const name = username.normalize("NFKC").trim().toLowerCase();
  if (name.length < minUsernameLength) return false;
  return [...document.querySelectorAll(landmarkSelector)].some((landmark) => {
    const text = (renderedText(landmark, landmarkReadLimit, { everyElement: true }) ?? "")
      .normalize("NFKC")
      .toLowerCase();
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const before = text.slice(0, at).at(-1) ?? " ";
      const after = text[at + name.length] ?? " ";
      // `risu` is not shown by `risu729` nor by `x.risu@example.com`.
      if (!/[\p{L}\p{N}_.@-]/u.test(before) && !/[\p{L}\p{N}_@-]/u.test(after)) return true;
    }
    return false;
  });
}

/**
 * The page signs of ADR 0029 that the page itself shows. `submitted` is what this
 * document showed at the effect step, when the step ran in it; without it, F1 and F2 are
 * not read.
 */
export function pageSigns(
  document: Document,
  { submitted, username }: { submitted?: SubmittedPage; username?: string } = {},
): PageSigns {
  const invalid =
    submitted !== undefined &&
    [...document.querySelectorAll("input")].some(
      (input) => ariaInvalid(input) && writableInput(input) && !submitted.invalid.has(input),
    );
  const alert =
    submitted !== undefined &&
    [...alertTexts(document)].some((text) => !submitted.alerts.has(text));
  return {
    password: showsPassword(document),
    code: showsCode(document),
    captcha: showsCaptcha(document),
    invalid,
    alert,
    ...(username === undefined ? {} : { username: showsUsername(document, username) }),
  };
}
