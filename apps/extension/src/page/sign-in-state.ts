import { visible } from "./code-submission";
import { renderedText } from "./text";

// The page signs of ADR 0029, read after an effect step that no check explained. Nothing
// read here, including the username compared with the header, leaves the content script:
// only the flags do.

/** What the page showed when an effect step ran, to compare with afterwards (F1, F2). */
export interface SubmittedPage {
  /** The step's sign-in inputs: the ones it filled, or those of the form it clicked in. */
  readonly fields: readonly HTMLInputElement[];
  /** Those of `fields` already marked invalid. */
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
  /** F1: a sign-in input of the effect step became `aria-invalid="true"`, in its document. */
  readonly invalid: boolean;
  /** F2: an alert shows text it did not show at the effect step, in its document. */
  readonly alert: boolean;
  /** E2: the username shows in the page header or navigation; only when one was given. */
  readonly username?: boolean;
}

// As the fill check reads them: alerts anywhere, status and polite live regions only
// inside a form or when a sign-in input names them. A region around an input or button
// changes with any text of the form, such as a button that reads "Signing in…".
const alertSelector = '[role="alert"], [aria-live="assertive"]';
const statusSelector = '[role="status"], [aria-live="polite"]';
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

function alertTexts(document: Document, fields: readonly HTMLInputElement[]): Set<string> {
  const named = new Set(
    fields.flatMap((input) =>
      ["aria-describedby", "aria-errormessage"].flatMap((name) =>
        (input.getAttribute(name) ?? "").split(/\s+/u).filter(Boolean),
      ),
    ),
  );
  const regions = [
    ...document.querySelectorAll(alertSelector),
    ...[...document.querySelectorAll(statusSelector)].filter(
      (element) => element.closest("form") !== null || named.has(element.id),
    ),
  ];
  const texts = new Set<string>();
  for (const element of regions) {
    if (
      !(element instanceof HTMLElement) ||
      element.querySelector("input, button, select, textarea") !== null ||
      !element.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const text = element.innerText.replace(/\s+/gu, " ").trim();
    if (text) texts.add(text);
  }
  return texts;
}

/**
 * The marks and alerts the page shows now, taken just before an effect step with its
 * sign-in inputs.
 */
export function submittedPage(
  document: Document,
  fields: readonly HTMLInputElement[],
): SubmittedPage {
  return {
    fields,
    invalid: new Set(fields.filter(ariaInvalid)),
    alerts: alertTexts(document, fields),
  };
}

/**
 * S2: a shown password input, except one for a new password and those of a form with two
 * or more shown password inputs (a password change or a registration), where the current
 * password must never go. Inputs outside any form count as one form.
 */
function showsPassword(document: Document): boolean {
  const passwords = [...document.querySelectorAll("input")].filter(
    (input) =>
      (input.type === "password" || tokens(input).includes("current-password")) &&
      writableInput(input),
  );
  return passwords.some(
    (input) =>
      !tokens(input).includes("new-password") &&
      passwords.filter((other) => other.form === input.form).length < 2,
  );
}

/** S3: a shown input that the executor would type a one-time code into. */
function showsCode(document: Document): boolean {
  // As the executor's `acceptsSecret` for a code; the attributes first, as they cost less.
  return [...document.querySelectorAll("input")].some(
    (input) =>
      (tokens(input).includes("one-time-code") ||
        ((input.inputMode === "numeric" || input.type === "tel" || input.type === "number") &&
          input.maxLength >= 1 &&
          input.maxLength <= 10)) &&
      writableInput(input),
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
  // A sign-in input of the step newly marked invalid.
  const invalid =
    submitted !== undefined &&
    submitted.fields.some(
      (input) => ariaInvalid(input) && !submitted.invalid.has(input) && writableInput(input),
    );
  const alert =
    submitted !== undefined &&
    [...alertTexts(document, submitted.fields)].some((text) => !submitted.alerts.has(text));
  return {
    password: showsPassword(document),
    code: showsCode(document),
    captcha: showsCaptcha(document),
    invalid,
    alert,
    ...(username === undefined ? {} : { username: showsUsername(document, username) }),
  };
}
