import { visible } from "./code-submission";
import { collapseText, readBehindModal, renderedText } from "./text";

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
  /**
   * F1: a sign-in input of the effect step became `aria-invalid="true"`, in its document;
   * in a new document that shows the sign-in form again, one of its sign-in inputs is.
   */
  readonly invalid: boolean;
  /**
   * F2: an alert shows text it did not show at the effect step, in its document; in a new
   * document that shows the sign-in form again, an alert next to the form shows any text.
   */
  readonly alert: boolean;
  /**
   * Why F2 does not hold on a sign-in form shown again in a new document, for the log; only
   * then.
   */
  readonly alertMiss?: AlertMiss;
  /** E2: the username shows in the page header or navigation; only when one was given. */
  readonly username?: boolean;
}

// As the fill check reads them: alerts anywhere, status and polite live regions only
// inside a sign-in input's form or when one names them. A region around a sign-in input
// changes with any text of the form, and a button's own text, such as "Signing in…" or a
// close button's "×", is not a message.
const alertSelector = '[role="alert"], [aria-live="assertive"]';
const statusSelector = '[role="status"], [aria-live="polite"]';
const landmarkSelector = 'header, nav, [role="banner"], [role="navigation"]';
/**
 * Page chrome a region beside a re-shown sign-in form must not share a container with: a
 * banner, navigation, footer or dialog there makes the container the page, not the form's.
 */
const chromeSelector =
  'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"], dialog, [role="dialog"]';
/** The page's main content area, which a container beside the form must not hold. */
const mainSelector = 'main, [role="main"]';
/** How much of an alert is read. */
const alertReadLimit = 1000;
/** How much of the header and navigation is read for the username. */
const landmarkReadLimit = 4000;
/** Shorter usernames match too much unrelated text; the observation's hiding uses it too. */
export const minUsernameLength = 3;
/**
 * Frames of the CAPTCHA services, by host and path: reCAPTCHA (`google.com/recaptcha/`,
 * `recaptcha.net/recaptcha/`), hCaptcha and Cloudflare Turnstile.
 */
const captchaFrames: readonly { host: RegExp; path: string }[] = [
  { host: /^(?:www\.)?google\.com$/u, path: "/recaptcha/" },
  { host: /^(?:www\.)?recaptcha\.net$/u, path: "/recaptcha/" },
  { host: /(?:^|\.)hcaptcha\.com$/u, path: "/" },
  { host: /^challenges\.cloudflare\.com$/u, path: "/" },
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

/**
 * Input types a person types into. An input with no type, or one the browser does not
 * know, is a text input (`type` reads `text`).
 */
const typedInputs = new Set(["text", "email", "tel", "number", "password", "search", "url"]);

/**
 * Whether `form` asks the person for something: it shows and holds a shown, enabled
 * control they type into or pick from (a text-like input, a text area or a select). A form
 * of buttons, hidden inputs or check boxes, as a passkey, social sign-in, language or
 * sign-out form, does not.
 */
function asksForInput(form: HTMLFormElement): boolean {
  return (
    visible(form) &&
    [...form.elements].some(
      (control) =>
        ((control instanceof HTMLInputElement &&
          typedInputs.has(control.type) &&
          !control.readOnly) ||
          (control instanceof HTMLTextAreaElement && !control.readOnly) ||
          control instanceof HTMLSelectElement) &&
        !control.disabled &&
        visible(control),
    )
  );
}

/**
 * Why no alert next to a sign-in form shown again counted, for the log (ADR 0019): no alert
 * or status region outside the sign-in inputs shows text (`no-alert`), none of the named
 * sign-in elements is a single shown writable input (`no-input`), or the first rule of
 * {@link besideForm} that the region closest to counting failed: their nearest common
 * container is the body or the root (`body`), or holds page chrome (`chrome`), another
 * form that asks for input (`other-form`) or the main area (`main`).
 */
export const alertMisses = [
  "no-alert",
  "no-input",
  "body",
  "chrome",
  "other-form",
  "main",
] as const;
export type AlertMiss = (typeof alertMisses)[number];
/** The rules of {@link besideForm}, in the order they are checked. */
const besideRules = ["body", "chrome", "other-form", "main"] as const;
type BesideRule = (typeof besideRules)[number];

/**
 * Whether `region` sits beside a sign-in input's form (or the input, outside any form):
 * their nearest common container is neither the body nor the root, holds no page chrome
 * and no main content area (`main`, as a single-page site's root wrapper holds), and no
 * other form that asks for input, as a flash message above a sign-in form in its own box
 * beside a passkey or social sign-in button form. Returns `undefined` when it does, else
 * the first rule failed, of the input that came closest.
 */
function besideForm(
  region: Element,
  fields: readonly HTMLInputElement[],
  forms: ReadonlySet<HTMLFormElement>,
): BesideRule | undefined {
  const { body, documentElement } = region.ownerDocument;
  let closest = -1;
  for (const input of fields) {
    let common: Element | null = input.form ?? input;
    while (common && !common.contains(region)) common = common.parentElement;
    const miss: BesideRule | undefined =
      !common || common === body || common === documentElement
        ? "body"
        : // A sign-in dialog of its own still counts; one inside the container does not.
          common.querySelector(chromeSelector)
          ? "chrome"
          : [...common.querySelectorAll("form")].some(
                (form) => !forms.has(form) && asksForInput(form),
              )
            ? "other-form"
            : common.querySelector(mainSelector)
              ? "main"
              : undefined;
    if (miss === undefined) return undefined;
    closest = Math.max(closest, besideRules.indexOf(miss));
  }
  return besideRules[closest] ?? "body";
}

/** The forms of the sign-in inputs `fields`. */
const formsOf = (fields: readonly HTMLInputElement[]) =>
  new Set(fields.flatMap((input) => (input.form ? [input.form] : [])));

/** The text of an alert or status region, without the text of its buttons. */
const regionText = (element: Element) =>
  collapseText(renderedText(element, alertReadLimit, { skip: 'button, [role="button"]' }) ?? "");

/**
 * The texts of the alerts next to the sign-in inputs `fields`. In the submitted document
 * (`beside` unset): alerts anywhere, and status regions inside a sign-in input's form or
 * named by one, as the fill check reads them. In a new document that shows the sign-in
 * form again (`beside`), which has nothing to compare with: alerts and status regions
 * inside a sign-in input's form, named by one, or {@link besideForm}, so a site-wide
 * banner never counts.
 */
function alertTexts(
  document: Document,
  fields: readonly HTMLInputElement[],
  beside = false,
): Set<string> {
  const named = new Set(
    fields.flatMap((input) =>
      ["aria-describedby", "aria-errormessage"].flatMap((name) =>
        (input.getAttribute(name) ?? "").split(/\s+/u).filter(Boolean),
      ),
    ),
  );
  const forms = formsOf(fields);
  const near = (element: Element) =>
    [...forms].some((form) => form.contains(element)) || named.has(element.id);
  const regions = beside
    ? [...document.querySelectorAll(`${alertSelector}, ${statusSelector}`)].filter(
        (element) => near(element) || besideForm(element, fields, forms) === undefined,
      )
    : [
        ...document.querySelectorAll(alertSelector),
        ...[...document.querySelectorAll(statusSelector)].filter(near),
      ];
  const texts = new Set<string>();
  for (const element of regions) {
    if (fields.some((input) => element.contains(input))) continue;
    const text = regionText(element);
    if (text) texts.add(text);
  }
  return texts;
}

/**
 * Why no alert counted next to the sign-in inputs `fields` of a form shown again, which
 * {@link alertTexts} found none beside: of the alerts and status regions with text outside
 * the sign-in inputs, the rule of {@link besideForm} that the one closest to counting
 * failed first ({@link alertMisses}).
 */
function alertMiss(document: Document, fields: readonly HTMLInputElement[]): AlertMiss {
  if (fields.length === 0) return "no-input";
  const forms = formsOf(fields);
  let closest = -1;
  for (const element of document.querySelectorAll(`${alertSelector}, ${statusSelector}`)) {
    if (fields.some((input) => element.contains(input)) || !regionText(element)) continue;
    const miss = besideForm(element, fields, forms);
    if (miss !== undefined) closest = Math.max(closest, besideRules.indexOf(miss));
  }
  return besideRules[closest] ?? "no-alert";
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

/** The fields the CAPTCHA services fill with their token once the challenge is passed. */
const captchaTokens = ["g-recaptcha-response", "h-captcha-response", "cf-turnstile-response"];

/** Whether a CAPTCHA service's token field of the page holds a token. */
export function passedCaptcha(document: Document): boolean {
  return captchaTokens.some((name) =>
    [...document.getElementsByName(name)].some(
      (field) =>
        (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
        field.value !== "",
    ),
  );
}

/** S4: a shown frame of a CAPTCHA service large enough to be solved. */
export function showsCaptcha(document: Document): boolean {
  return [...document.querySelectorAll("iframe")].some((frame) => {
    let url: URL;
    try {
      url = new URL(frame.src);
    } catch {
      return false;
    }
    if (
      !captchaFrames.some(
        ({ host, path }) => host.test(url.hostname) && url.pathname.startsWith(path),
      )
    )
      return false;
    if (url.searchParams.get("size") === "invisible") return false;
    const box = frame.getBoundingClientRect();
    return visible(frame) && box.width >= minCaptchaSide && box.height >= minCaptchaSide;
  });
}

/**
 * E2: the username, ignoring case, as a whole word of the header or navigation text,
 * read behind an open modal dialog too, as the signed-in page's description is.
 */
function showsUsername(document: Document, username: string): boolean {
  const name = username.normalize("NFKC").trim().toLowerCase();
  if (name.length < minUsernameLength) return false;
  const texts = readBehindModal(document, () =>
    [...document.querySelectorAll(landmarkSelector)].map(
      (landmark) => renderedText(landmark, landmarkReadLimit, { everyElement: true }) ?? "",
    ),
  );
  return texts.some((raw) => {
    const text = raw.normalize("NFKC").toLowerCase();
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
 * document showed at the effect step, when the step ran in it. `reshown` are the recipe's
 * sign-in inputs a new document after the submission shows, when the sign-in form came
 * back in one: with no earlier reading to compare with, any mark on them and any text of
 * an alert next to them count (owner, 2026-10-12 22:03 UTC). Without either, F1 and F2
 * are not read.
 */
export function pageSigns(
  document: Document,
  {
    submitted,
    reshown,
    username,
  }: { submitted?: SubmittedPage; reshown?: readonly HTMLInputElement[]; username?: string } = {},
): PageSigns {
  // A sign-in input of the step newly marked invalid, or of the re-shown form marked so.
  const invalid =
    reshown !== undefined
      ? reshown.some((input) => ariaInvalid(input) && writableInput(input))
      : submitted !== undefined &&
        submitted.fields.some(
          (input) => ariaInvalid(input) && !submitted.invalid.has(input) && writableInput(input),
        );
  const alert =
    reshown !== undefined
      ? reshown.length > 0 && alertTexts(document, reshown, true).size > 0
      : submitted !== undefined &&
        [...alertTexts(document, submitted.fields)].some((text) => !submitted.alerts.has(text));
  return {
    password: showsPassword(document),
    code: showsCode(document),
    captcha: showsCaptcha(document),
    invalid,
    alert,
    ...(reshown !== undefined && !alert ? { alertMiss: alertMiss(document, reshown) } : {}),
    ...(username === undefined ? {} : { username: showsUsername(document, username) }),
  };
}
