import {
  isCodeField,
  namesPasskey,
  registersPasskey,
  loginAutocompleteTokens,
  loginHostChainSchema,
  loginObservationSchema,
  loginKeypadTargetSchema,
  loginLinkTargetSchema,
  loginTargetSchema,
  namesPasswordControl,
  observedAutocompleteTokens,
  type LoginObservation,
  type LoginKeypadTarget,
  type LoginMarkerTarget,
  type LoginHostChain,
  type LoginTarget,
  type ObservedCandidate,
} from "@pateat/contracts";
import * as v from "valibot";
import { acceptsSecret, shortNumericInput } from "../login/inputs";
import type { observationGaps } from "../login/wire";
import { splitCodeInputs } from "../page/code-submission";
import {
  findLogoutTargets,
  isMenuItem,
  localLogoutControl,
  logoutControlName,
  logoutName,
  menuItemText,
  openMenus,
} from "../page/logout-controls";
import {
  findKeypad,
  findKeypads,
  KEYPAD_MIN_KEYS,
  keypadField,
  keypadKeys,
  keypadPosition,
} from "../page/keypad";
import {
  autocompleteTokens,
  findTargets,
  hostScopes,
  linkPath,
  namedControls,
} from "../page/targets";
import {
  closestAcross,
  composedOrder,
  composedParent,
  containsAcross,
  controlsOf,
  formOf,
  hostOf,
  inputsOf,
  queryAll,
  readingPage,
  shadowRootOf,
  treeOf,
} from "../page/shadow";
import { observedPath, redactsPath, tokenSegment } from "./path";
import {
  attributeHidden,
  buttonText,
  collapseText,
  controlContent,
  controlName,
  fieldName,
  hasNativeButton,
  isButton,
  isFragmentButton,
  isRoleButton,
  isScriptButton,
  isScriptLink,
  linkText,
  openModals,
  readBehindModal,
  readOwnInert,
  renderedText,
  shown,
} from "../page/text";
import {
  accountEntries,
  besideEmails,
  chromeSelector,
  inPageChrome,
  entryLike,
  foldName,
  namedAccounts,
  namePattern,
} from "../page/account-list";
import { entryElementRefusal, linkUrl, renderedControlText } from "../page/entry";
import { linkRefusal, type OnSite } from "../login/entry";

/**
 * Why no observation was produced. A page without one is never sent to inference.
 * `no-locator` is a login page where a control of a login form lacks a locator
 * that names it alone, as when a hidden copy of the form shares the ids and names, and
 * nothing else can be described; a login form with nothing to locate or act on (only
 * fields that cannot be filled) gives `no-candidates`.
 */
export type ObservationRefusal = "unsupported-page" | "no-candidates" | "no-locator";
/**
 * Why an observation is incomplete, for diagnostics only (ADR 0019): the first cause in
 * the extractor's fixed order, never a page text, attribute value or count.
 *
 * - `unfillable-field`: a fillable field that cannot be filled (faint, read-only
 *   or disabled); on a signed-in page, only one that may be a sign-in field.
 * - `unsupported-control`: a control the executor cannot act on in a login form, such as
 *   a select, a radio button or a text area.
 * - `unlocated-field`, `unlocated-checkbox`, `unlocated-button`: a field, required checkbox or
 *   button of a login form without a locator that names it alone; for buttons, also an
 *   icon button in a form with no other button to submit with.
 * - `too-many-fields` (signed-in page), `too-many-candidates` (login page): more than the
 *   48 candidates an observation holds.
 * - For a list of accounts: `too-many-accounts` (more than eight), `unlisted-accounts` (an
 *   account whose text could not be sent), `too-many-elements` (more than the page scan
 *   reads) and `too-many-controls` (more than eight other controls).
 */
export type ObservationGap = (typeof observationGaps)[number];
/** Login-page gaps, the first one present reported (`extractLoginObservation`). */
const loginGaps = [
  "unfillable-field",
  "unsupported-control",
  "unlocated-field",
  "unlocated-checkbox",
  "unlocated-button",
  "too-many-candidates",
] as const satisfies readonly ObservationGap[];
type LoginGap = (typeof loginGaps)[number];
/** A described result marked with why it is incomplete, if it is. */
const withGap = (result: ObservationResult, gap: ObservationGap | undefined): ObservationResult =>
  result.ok && gap ? { ...result, gap } : result;
export type ObservationResult =
  | {
      readonly ok: true;
      readonly observation: LoginObservation;
      readonly gap?: ObservationGap;
      /**
       * A signed-in page's description leaves out a disabled field that may not be a
       * sign-in field. The page is judged, but completes only on `signed-in` (owner,
       * 2026-10-12, ADR 0029). Never sent to the service.
       */
      readonly disabledLeftOut?: true;
      /**
       * A signed-in page shows a radio button, select or text area, or an ARIA widget for
       * one, that is no part of a site search (`leftOutInputs`), which its description
       * has no role for: the page may ask for a choice or an answer, so an `optional`
       * answer does not complete it (ADR 0065). Never sent to the service.
       */
      readonly inputLeftOut?: true;
    }
  | { readonly ok: false; readonly reason: ObservationRefusal };

const maxCandidates = 48;
/** Where account menus usually sit: the page's header and navigation. */
const landmarks = chromeSelector;
/**
 * An account area outside them: an element whose ID, class or `aria-label` names the
 * account, user or profile, as an account menu's container. No site is named.
 */
const accountAreas = ["account", "user", "profile", "avatar"]
  .flatMap((word) => [`[id*='${word}' i]`, `[class*='${word}' i]`, `[aria-label*='${word}' i]`])
  .concat(["[aria-label*='アカウント']"])
  .join(", ");
/**
 * How far above a login form a button outside every form still counts as the form's,
 * such as a passkey button beside the password form (SBI Securities: form, list item,
 * list). The body and the root element never count, so this never takes the whole page.
 */
const besideDepth = 2;
/**
 * How far above the fields outside every form a control the executor cannot act on still
 * counts as theirs (`formlessFieldsArea`); a footer's language picker is farther away.
 */
const formlessDepth = 4;
const maxBeside = 4;
const maxHeadings = 8;
export const maxText = 120;
const rawLimit = maxText * 4;
/** How much of a signed-in page's header and navigation the judge sees (ADR 0029). */
export const maxHeaderText = 1000;
const labelDepth = 3;
const inputModes = ["none", "text", "decimal", "numeric", "tel", "search", "email", "url"] as const;
const fillTypes: Record<string, ObservedCandidate["role"]> = {
  text: "text",
  email: "email",
  tel: "tel",
  number: "number",
  password: "password",
};
const actionTypes = new Set(["submit", "button", "image"]);
const ignoredTypes = new Set(["hidden", "reset"]);
const controls = "input:not([type='hidden']), select, textarea, button";
const fields = "input:not([type='hidden']), select, textarea";
/** Every element `describe` may accept, script buttons included. */
const observed = "input, select, textarea, button, a, [role]";
/**
 * The attributes an element is named by, in order: a test attribute first, as test tools
 * do, since a site keeps it as a stable hook while an `id` may be a render counter
 * (Duolingo's `web-ui1`, `web-ui2`, then `web-ui3` for the same password input on its
 * remembered-account screen, 2026-10-24; ADR 0071 amendment).
 */
const locators = [
  ["test-id", "data-testid"],
  ["data-test", "data-test"],
  ["id", "id"],
  ["name", "name"],
] as const;
/**
 * An ID React's `useId` generated (`:r1:`, `«r1»`, `_r_1_`, a hydrated `:R1aH1:`, also
 * inside a library's prefix such as `radix-:r1:`): its base-32 digits count the
 * components rendered before, so another page of the site gives it to another element.
 */
const generatedId =
  /:[Rr][0-9a-v]+(?:H[0-9a-v]+)?:|«[Rr][0-9a-v]+(?:H[0-9a-v]+)?»|(?:^|[^0-9A-Za-z])_[Rr]_[0-9a-v]+(?:H[0-9a-v]+)?_(?![0-9A-Za-z])/u;
/**
 * A run of eight or more lower-case base-36 characters that no other letter or digit
 * touches, the shape of `Math.random().toString(36)` that Mantine's `useId` appends
 * after mount (`mantine-4p5f7ku4o`, 2026-10-13): every load gives the element another ID.
 */
const base36Run = /(?<![0-9A-Za-z])[0-9a-z]{8,}(?![0-9A-Za-z])/gu;
/**
 * True for an ID holding a random-looking run: a `base36Run` with a digit and a letter
 * that switches between digits and letters at least twice, which a name such as
 * `password1`, `password-field-1` or `email-address-2024` does not. Stable IDs such as
 * `oauth2login`, `step2of3` or `form-3a7bd3e2` match too, so such an ID is only demoted,
 * not dropped.
 */
const randomId = (value: string) =>
  (value.match(base36Run) ?? []).some((run) => run.match(/\d+|[a-z]+/gu)!.length >= 3);
/**
 * An ID a UI library's own `useId` generated, recognized by the prefix it adds: a rule
 * about the library, like `generatedId` for React's, not about a site (ADR 0033).
 * Mantine's is `mantine-` and a random base-36 run, which can lack a digit
 * (`mantine-ypxwydcwg`, 2026-10-13), or React 18's ID without its colons
 * (`mantine-r5`), and its components derive IDs from it, such as Tabs'
 * `mantine-ypxwydcwg-tab-mypage`.
 */
const libraryId = /^mantine-/u;
/** True for an ID another load may change: `randomId`, or a `libraryId` prefix. */
const changingId = (value: string) => libraryId.test(value) || randomId(value);
/**
 * An ID shaped like a render counter: lower-case words joined by `-` or `_`, ending in up
 * to four digits, with at least one `-` or `_`, such as Discord's `uid_7` and `uid_9` on
 * its invite login page that read `uid_13` and `uid_15` on `/login` (2026-11-02, #1161),
 * or Duolingo's `web-ui1` (ADR 0071). A unique `name` or `autocomplete` token names the
 * element first; the ID is still used when nothing else does. `address1`, without a
 * separator, is not one.
 */
const counterId = (value: string) =>
  /^[a-z]+(?:[-_][a-z]+)*[-_]?\d{1,4}$/u.test(value) && /[-_]/u.test(value);

/**
 * Text that can reveal an account or a number is replaced before it is observed
 * (owner decision, 2026-10-11): email-like strings, including masked ones, become
 * `[email]`; runs of three or more mask characters become `[masked]`; runs of four or
 * more digits, ASCII or fullwidth, become `[number]`.
 */
const redactions: readonly (readonly [RegExp, string])[] = [
  // Fullwidth letters, digits and punctuation count too: `ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ`. A
  // local part holds what HTML's valid email address allows, such as `'` and `#`
  // (`o'brien@`, `taro#1@`), except `/`, `=`, `?` and `&`, so `youtube.com/@pateat` and
  // `price=100@shop` stay. A domain's labels may be internationalized (`taro@例え.jp`).
  // An ASCII last label ends the address, so text right after it stays:
  // `taro@example.comでログイン` becomes `[email]でログイン`. A last label that is not ASCII
  // (`taro@例え.日本`, `taro@mail.例え.日本`) cannot be told apart from text glued to it,
  // so the address and that text go together.
  [
    /[A-Za-z0-9.!#$%'*+^_`{|}~\-●•＊Ａ-Ｚａ-ｚ０-９．＿％＋－]+[@＠](?:(?:[\p{L}\p{M}\p{N}\-*●•＊－]+[.．])*[A-Za-z0-9\-*●•＊Ａ-Ｚａ-ｚ０-９－]+(?![A-Za-z0-9\-*●•＊Ａ-Ｚａ-ｚ０-９－]|[.．][\p{L}\p{M}\p{N}\-*●•＊－])|(?:[\p{L}\p{M}\p{N}\-*●•＊－]+[.．])+[\p{L}\p{M}\p{N}\-－]+)/gu,
    "[email]",
  ],
  [/[*●•＊]{3,}/gu, "[masked]"],
  [/[0-9０-９]{4,}/gu, "[number]"],
];

/**
 * Normalizes untrusted page text to the observed-text contract: whitespace collapsed,
 * control/format/separator characters removed, private-looking parts redacted, and at
 * most `limit` (120) UTF-16 code units without splitting a surrogate pair.
 */
export function observedText(raw: string | null | undefined, limit = maxText): string | undefined {
  if (!raw) return undefined;
  // Format characters (zero-width spaces, soft hyphens) vanish before redaction so
  // they cannot split a digit run.
  let text = collapseText(raw);
  for (const [pattern, replacement] of redactions) text = text.replace(pattern, replacement);
  return bounded(text.replace(/\s+/gu, " ").trim(), limit);
}

/** At most `limit` (120) UTF-16 code units, without splitting a surrogate pair. */
export function bounded(text: string, limit = maxText): string | undefined {
  if (text.length > limit) {
    text = text.slice(0, limit);
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}

/**
 * Observed text of a signed-in page with every number replaced by one `[number]`, whatever
 * its length or script, digit groups joined by `.`, `,` or `'` included, and a long run
 * the login-page rule already replaced (owner decision, 2026-10-12): such a page can show
 * balances and points in any form, and judging whether it is signed in needs none of
 * them. Numerals written as letters, such as most kanji, are not numbers to Unicode and stay.
 */
const numberPart = String.raw`(?:\p{Number}+|\[number\])`;
const numbers = new RegExp(`${numberPart}(?:[.,，．'\u2019]${numberPart})*`, "gu");
export const withoutNumbers = (text: string, limit = maxText) =>
  bounded(text.replace(numbers, "[number]"), limit) ?? "[number]";

/**
 * The visible text of a signed-in page's header and navigation for the judge (ADR 0029,
 * owner, 2026-10-12): every outermost `header`, `nav`, banner and navigation landmark in
 * document order, redacted as the rest of that page and cut at 1,000 characters. Every
 * element boundary separates words, as E2 reads them, so a name in its own element is
 * never glued to the word before it; the text is cut once, after every number is hidden,
 * so the end of a cut username stays the end of the text.
 */
function headerText(document: Document): string | undefined {
  const readLimit = maxHeaderText * 4;
  let raw = "";
  for (const root of queryAll(document, landmarks)) {
    if (raw.length > readLimit) break;
    const parent = composedParent(root);
    if (parent && closestAcross(parent, landmarks)) continue;
    const text = renderedText(root, readLimit, { everyElement: true });
    if (text) raw += ` ${text}`;
  }
  const text = observedText(raw, Number.POSITIVE_INFINITY);
  return text && withoutNumbers(text, maxHeaderText);
}

/**
 * Whether a control is on the page: `visible`, `faint` when it is rendered but
 * transparent or tiny (a trap, or a real input under a styled widget), or `absent`
 * when it is hidden or moved before the page's start, where trap inputs usually go.
 * A control transparent only while it or an ancestor fades in from opacity 0 counts as
 * opaque, as `shown` does (2026-10-17), and so does a fillable input transparent only
 * under its own shown label (2026-10-23).
 */
export function presence(element: HTMLElement): "visible" | "faint" | "absent" {
  const miss = presenceMiss(element);
  if (miss === undefined) return "visible";
  return miss === "transparent" || miss === "tiny" ? "faint" : "absent";
}
/**
 * Why {@link presence} does not read a control as `visible`, checked in its order: an
 * attribute hides it (`hidden-attr`: `hidden`, `inert` or `aria-hidden`), it is not
 * rendered otherwise (`not-rendered`), it is moved before the page's start (`off-start`),
 * it is transparent and not fading in or revealed by its label (`transparent`), or it is
 * under 2 pixels wide or high (`tiny`). Undefined when it is visible. For the log only (ADR 0019).
 */
export function presenceMiss(
  element: HTMLElement,
): "hidden-attr" | "not-rendered" | "off-start" | "transparent" | "tiny" | undefined {
  const view = element.ownerDocument.defaultView;
  if (!view) return "not-rendered";
  if (!shown(element, false)) return attributeHidden(element) ? "hidden-attr" : "not-rendered";
  const rect = element.getBoundingClientRect();
  if (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0) return "off-start";
  if (!shown(element)) return "transparent";
  if (rect.width < 2 || rect.height < 2) return "tiny";
  return undefined;
}
const visible = (element: HTMLElement) => presence(element) === "visible";

/**
 * Observed text not yet cut at its 120-character limit: a candidate's label, placeholder
 * and description, the title and the headings are cut once `observe` has hidden what its
 * page hides, so that hiding every number on a signed-in page cannot shorten a cut text
 * and the end of a cut username stays the end of the text (`withoutUsernames`).
 */
const uncutText = (raw: string | null | undefined) => observedText(raw, Number.POSITIVE_INFINITY);

/** Rendered text, normalized and redacted, not yet cut; a little beyond the limit is read so redaction sees whole tokens. */
const visibleText = (root: Element) => uncutText(renderedText(root, rawLimit));

type LocatorIndex = Map<string, Map<string, number>>;

/**
 * Counts every locator value once, as the executor's whole-page lookup sees them, shadow
 * trees included (ADR 0070).
 */
function locatorIndex(document: Document): LocatorIndex {
  const index: LocatorIndex = new Map(
    [
      ...locators.map(([, attribute]) => attribute),
      "autocomplete",
      "text",
      "script-text",
      "role-text",
      "link-text",
      "label",
      "link-path",
      "accessible-name",
    ].map((key) => [key, new Map()]),
  );
  const count = (key: string, value: string) => {
    const counts = index.get(key)!;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };
  for (const element of queryAll(document, "[id], [name], [data-testid], [data-test]"))
    for (const [, attribute] of locators) {
      const value = element.getAttribute(attribute);
      if (value !== null) count(attribute, value);
    }
  for (const input of queryAll(document, "input[autocomplete]"))
    for (const token of new Set(autocompleteTokens(input))) count("autocomplete", token);
  for (const element of queryAll(document, "button, input, a")) {
    const text = buttonText(element);
    if (text !== undefined) count(isScriptLink(element) ? "script-text" : "text", text);
  }
  for (const element of queryAll(document, "[role]")) {
    const text = isRoleButton(element) ? buttonText(element) : undefined;
    if (text !== undefined) count("role-text", text);
  }
  for (const element of queryAll(document, "a[href]")) {
    const text = isScriptLink(element) ? undefined : linkText(element);
    if (text !== undefined) count("link-text", text);
    const path = linkPath(element);
    if (path !== undefined) count("link-path", path);
  }
  for (const input of queryAll<HTMLInputElement>(document, "input")) {
    const name = fieldName(input);
    if (name !== undefined) count("label", name);
  }
  for (const element of queryAll(document, namedControls)) {
    const name = controlName(element);
    if (name !== undefined) count("accessible-name", name);
  }
  return index;
}

/**
 * Whether an attribute or `autocomplete` locator names `element` alone, as the executor
 * finds it (`findTargets`): a value the whole document carries once, or else, without
 * `hidden`, a value only `element` carries among the shown elements (ADR 0037 amendment
 * of 2026-10-22), as a field of a form whose hidden copy shares its names. With `hidden`,
 * which a signed-in page's markers ask for since a marker counts every copy (ADR 0029),
 * only the whole document's count decides.
 */
function namesOnly(
  element: Element,
  target: LoginMarkerTarget,
  count: number | undefined,
  hidden: boolean,
): boolean {
  if (count === 1) return true;
  if (hidden || count === undefined) return false;
  const found = findTargets(element.ownerDocument, target);
  return found.length === 1 && found[0] === element;
}

/**
 * Mirrors the executor's lookup: an attribute value, or else a fillable input's
 * `autocomplete` token, or else a button's text, that matches exactly one element, an
 * attribute value or token counted as `namesOnly` counts it with `hidden`. With
 * `labels`, a fillable input none of those name is located by its visible name
 * (`fieldName`, ADR 0037) when no other shown fillable input has that name, it holds no
 * number other than a split code input's place (`numbersCodeDigit`) and redaction leaves
 * it unchanged, before an ID another load may change. An ID
 * React's `useId` generated is not used, as another page gives it to another element. One
 * that another load may change (`changingId`) is used only when no other locator is
 * unique, as it may as well be stable, and never with `lasting`, which a signed-in
 * marker needs, since it must match on every later visit. One shaped like a render
 * counter (`counterId`) gives way to a unique `name` and `autocomplete` token, and is
 * used otherwise, as it may be stable too. A
 * script link's text must also name no native button, shown or not, which the executor
 * would take first. With `roles`, another `role="button"` element (`isRoleButton`) is
 * located by its text too, when no native button, script link or other such element
 * carries it. Button text is used only when redaction leaves it unchanged, so a
 * locator never carries an email address or a long number. With
 * `redactAttributes` the same holds for attribute values, since a signed-in page's ids
 * and names often carry the account, and a value that may be a token (`tokenSegment`),
 * such as an account ID, is skipped too. With `tokens` only such a value is skipped,
 * which every page whose path had a segment replaced asks for (ADR 0039), so a token its
 * path carries never reaches the service through an ID or a name. With `links`, a link
 * is located by its text too, which only an account switch uses: the text must name no
 * other link and no button. With `paths`, which only a signed-in page's markers use (ADR 0029), a link to the
 * page's own origin is located by its path before its text, when no other link goes there,
 * the path carries no number or token and no segment repeats the link's text or one or
 * two words of the page's header (`paths` holds those words, `shownWords`), so an account
 * link whose text is the person's nickname still has a locator, while a handle or name the
 * page shows (`/taro_y` beside "@taro_y") is not used. A handle the page never shows can still pass,
 * which the judge must refuse. With `names`, a native button none of those name is located
 * by its accessible name (`buttonNameTarget`), before an ID another load may change, as a
 * field's visible name is.
 */
function locate(
  element: Element,
  index: LocatorIndex,
  {
    redactAttributes = false,
    tokens = false,
    links = false,
    lasting = false,
    labels = false,
    roles = false,
    hidden = false,
    names = false,
    paths,
  }: {
    redactAttributes?: boolean;
    tokens?: boolean;
    links?: boolean;
    lasting?: boolean | undefined;
    labels?: boolean | undefined;
    roles?: boolean;
    hidden?: boolean;
    names?: boolean;
    paths?: ReadonlySet<string>;
  } = {},
): LoginMarkerTarget | undefined {
  let demoted: LoginTarget | undefined;
  let counter: LoginTarget | undefined;
  for (const [by, attribute] of locators) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    if (attribute === "id" && generatedId.test(value)) continue;
    if ((redactAttributes || tokens) && tokenSegment(value)) continue;
    if (redactAttributes && observedText(value) !== value) continue;
    const target = { by, value };
    if (!v.is(loginTargetSchema, target)) continue;
    if (!namesOnly(element, target, index.get(attribute)!.get(value), hidden)) continue;
    // A counter-shaped ID gives way to a later attribute and an `autocomplete` token.
    // A library's per-load ID (`mantine-r5`) is demoted further below.
    if (attribute === "id" && counterId(value) && !changingId(value)) {
      counter = target;
      continue;
    }
    if (attribute !== "id" || !changingId(value)) return target;
    if (!lasting) demoted = target;
  }
  if (counter) return autocompleteTarget(element, index, hidden) ?? counter;
  return (
    (paths ? pathTarget(element, index, paths) : undefined) ??
    contentTarget(element, index, links, labels, roles, hidden) ??
    (names ? buttonNameTarget(element, index) : undefined) ??
    chainedTarget(element, { redactAttributes, tokens, labels, hidden }) ??
    demoted
  );
}

/**
 * `locate`'s locator for an element of a shadow tree that no locator names once in the
 * whole page (ADR 0070): an attribute, `autocomplete` token or visible name (with
 * `labels`) that names it once among the elements of a host's shadow tree, `within` the
 * fewest hosts, at most three, that name that host alone (`hostScopes`), the hosts
 * nearest it first. A host is named by its `id`, `name`, `data-testid` or `data-test` under the
 * rules an element's own attribute follows in `locate`, and an ID another load may
 * change names no host.
 */
function chainedTarget(
  element: Element,
  options: {
    redactAttributes: boolean;
    tokens: boolean;
    labels: boolean | undefined;
    hidden: boolean;
  },
): LoginTarget | undefined {
  const inner = innerTargets(element, options);
  if (!inner.length) return undefined;
  const hosts: Element[] = [];
  for (let host = hostOf(element); host; host = hostOf(host)) hosts.unshift(host);
  const document = element.ownerDocument;
  const names = hosts.map((host) => hostNames(host, options));
  // The chains of one more host that name a host no shorter chain named alone, grown from
  // the shorter ones, so each host is named once and a deep page costs a few lookups per
  // host.
  const named = new Set<number>();
  let level: { within: LoginHostChain[number][]; at: number }[] = [{ within: [], at: -1 }];
  for (let depth = 1; depth <= 3 && level.length; depth++) {
    level = level.flatMap(({ within, at }) =>
      hosts.flatMap((host, next) => {
        if (next <= at || named.has(next)) return [];
        for (const name of names[next]!) {
          const chain = [...within, name];
          const scopes = hostScopes(document, chain as LoginHostChain);
          if (scopes.length !== 1 || scopes[0] !== shadowRootOf(host)) continue;
          named.add(next);
          return [{ within: chain, at: next }];
        }
        return [];
      }),
    );
    // The hosts nearest the element first.
    for (const { within } of [...level].sort((left, right) => right.at - left.at))
      for (const target of inner) {
        const chained = { ...target, within };
        if (!v.is(loginTargetSchema, chained)) continue;
        const found = findTargets(document, chained, { hidden: options.hidden });
        if (found.length === 1 && found[0] === element) return chained;
      }
  }
  return undefined;
}

/** The `id`, `name`, `data-testid` and `data-test` a host may be named by in `chainedTarget`. */
function hostNames(
  host: Element,
  { redactAttributes, tokens }: { redactAttributes: boolean; tokens: boolean },
): LoginHostChain[number][] {
  return locators.flatMap(([by, attribute]) => {
    const value = host.getAttribute(attribute);
    if (value === null) return [];
    if (attribute === "id" && (generatedId.test(value) || changingId(value))) return [];
    if ((redactAttributes || tokens) && tokenSegment(value)) return [];
    if (redactAttributes && observedText(value) !== value) return [];
    const name = { by, value };
    return v.is(loginHostChainSchema, [name]) ? [name] : [];
  });
}

/** The locators `chainedTarget` may name `element` by inside its hosts, in `locate`'s order. */
function innerTargets(
  element: Element,
  {
    redactAttributes,
    tokens,
    labels,
  }: {
    redactAttributes: boolean;
    tokens: boolean;
    labels: boolean | undefined;
  },
): LoginTarget[] {
  const targets: LoginTarget[] = [];
  for (const [by, attribute] of locators) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    // An ID another load may change is never looked for inside hosts: the element keeps
    // it as `locate`'s demoted locator instead.
    if (attribute === "id" && (generatedId.test(value) || changingId(value))) continue;
    if ((redactAttributes || tokens) && tokenSegment(value)) continue;
    if (redactAttributes && observedText(value) !== value) continue;
    targets.push({ by, value });
  }
  if (!(element instanceof HTMLInputElement && fillTypes[element.type])) return targets;
  for (const value of autocompleteTokens(element))
    if ((loginAutocompleteTokens as readonly string[]).includes(value))
      targets.push({ by: "autocomplete", value } as LoginTarget);
  const name = labels ? fieldName(element) : undefined;
  if (
    name !== undefined &&
    observedText(name) === name &&
    (!/\p{Number}/u.test(name) || numbersCodeDigit(element, name))
  )
    targets.push({ by: "label", value: name });
  return targets;
}

/**
 * `locate`'s link path, when one link alone goes there, it carries no token and no
 * segment, with or without what may be a file extension, folds to the link's text or one
 * of the `headerWords`.
 */
function pathTarget(
  element: Element,
  index: LocatorIndex,
  headerWords: ReadonlySet<string>,
): LoginMarkerTarget | undefined {
  const path = linkPath(element);
  if (path === undefined || index.get("link-path")!.get(path) !== 1 || tokenPath(path))
    return undefined;
  const own = shownWords(linkText(element));
  if (
    path
      .split("/")
      .flatMap((segment) => [segment, segment.replace(/\.[A-Za-z]+$/u, "")])
      .some((segment) => {
        const word = foldWord(segment);
        return word !== "" && (headerWords.has(word) || own.has(word));
      })
  )
    return undefined;
  const target = { by: "href" as const, value: path };
  return v.is(loginLinkTargetSchema, target) ? target : undefined;
}

/** A word's letters and numbers, lower-cased, so `Taro Y` and `taro_y` compare equal. */
const foldWord = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "");

/**
 * The folded words of a text, each two neighbouring words together (a display name such
 * as "Taro Y"), and the whole text folded, for `pathTarget`.
 */
function shownWords(text: string | undefined): Set<string> {
  const words = new Set<string>();
  if (text === undefined) return words;
  // A word of punctuation alone, such as "·", does not part a name's two words.
  const split = text.split(/\s+/u).map(foldWord).filter(Boolean);
  for (const word of [
    foldWord(text),
    ...split,
    ...split.slice(1).map((next, at) => split[at] + next),
  ])
    if (word) words.add(word);
  return words;
}

/**
 * Whether a field's visible name that holds numbers may still name it (owner, 2026-10-22,
 * #850, amending ADR 0037): the field is one input of a code split into one input per
 * digit (`splitCodeInputs`, counting shown inputs only), and every number in the name is
 * its place among them or their count, as in "digit 1 of 6", which never changes as the
 * person types. A name such as "Sent to ••12" or "••• 4 2 7, digit 1" never qualifies.
 */
function numbersCodeDigit(field: HTMLInputElement, name: string): boolean {
  if (field.maxLength !== 1 || !acceptsSecret(field, "otp")) return false;
  const inputs = inputsOf(formOf(field), field.ownerDocument);
  const digits = inputs.filter(
    (input) => input.maxLength === 1 && acceptsSecret(input, "otp") && visible(input),
  );
  const place = digits.indexOf(field) + 1;
  return (
    place > 0 &&
    (name.match(/\p{Number}+/gu) ?? []).every(
      (number) => number === `${place}` || number === `${digits.length}`,
    ) &&
    splitCodeInputs(digits[0]!, digits.length, visible) !== undefined
  );
}

/** A fillable input's login `autocomplete` token that names it alone, as `locate` takes it. */
function autocompleteTarget(
  element: Element,
  index: LocatorIndex,
  hidden: boolean,
): LoginTarget | undefined {
  if (!(element instanceof HTMLInputElement) || !fillTypes[element.type]) return undefined;
  for (const value of autocompleteTokens(element)) {
    if (!(loginAutocompleteTokens as readonly string[]).includes(value)) continue;
    const target = { by: "autocomplete" as const, value };
    if (!v.is(loginTargetSchema, target)) continue;
    if (namesOnly(element, target, index.get("autocomplete")!.get(value), hidden)) return target;
  }
  return undefined;
}

/**
 * `locate`'s `autocomplete` token, visible name (with `labels`), link text or button text,
 * when one is unique.
 */
function contentTarget(
  element: Element,
  index: LocatorIndex,
  links: boolean,
  labels: boolean,
  roles: boolean,
  hidden: boolean,
): LoginTarget | undefined {
  // Only a field the login fills; a button is named by its own attributes or text.
  if (element instanceof HTMLInputElement && fillTypes[element.type]) {
    const token = autocompleteTarget(element, index, hidden);
    if (token) return token;
    if (!labels) return undefined;
    const name = fieldName(element);
    // A name holding a number may change as the person types, such as a counter "0/20",
    // unless it numbers an input of a split code.
    if (
      name !== undefined &&
      observedText(name) === name &&
      index.get("label")!.get(name) === 1 &&
      (!/\p{Number}/u.test(name) || numbersCodeDigit(element, name))
    ) {
      const target = { by: "label" as const, value: name };
      if (v.is(loginTargetSchema, target)) return target;
    }
    return passwordFormNameTarget(element, hidden);
  }
  if (
    element instanceof HTMLAnchorElement &&
    element.hasAttribute("href") &&
    !isScriptLink(element)
  ) {
    const text = links ? linkText(element) : undefined;
    if (
      text === undefined ||
      index.get("link-text")!.get(text) !== 1 ||
      index.get("text")!.has(text) ||
      index.get("script-text")!.has(text) ||
      (roles && index.get("role-text")!.has(text)) ||
      observedText(text) !== text
    )
      return undefined;
    const target = { by: "text" as const, value: text };
    return v.is(loginTargetSchema, target) ? target : undefined;
  }
  const text = buttonText(element);
  if (text === undefined || observedText(text) !== text) return undefined;
  const unique = isScriptLink(element)
    ? !index.get("text")!.has(text) &&
      !hasNativeButton(element.ownerDocument, text) &&
      index.get("script-text")!.get(text) === 1
    : isRoleButton(element)
      ? roles &&
        !index.get("text")!.has(text) &&
        !hasNativeButton(element.ownerDocument, text) &&
        !index.get("script-text")!.has(text) &&
        index.get("role-text")!.get(text) === 1
      : index.get("text")!.get(text) === 1;
  if (!unique) return undefined;
  const target = { by: "text" as const, value: text };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

/**
 * The `password-form-name` locator of a field that no other locator names alone
 * (ADR 0072): its `name`, when the executor finds it alone by that name among
 * the elements of forms holding a shown password input not marked `new-password`, as
 * Hacker News's account field `acct`, which its create-account form repeats. A name that
 * may be a token, or that redaction would change, is never used.
 */
function passwordFormNameTarget(
  element: HTMLInputElement,
  hidden: boolean,
): LoginTarget | undefined {
  const value = element.getAttribute("name");
  if (value === null || tokenSegment(value) || observedText(value) !== value) return undefined;
  const target = { by: "password-form-name" as const, value };
  if (!v.is(loginTargetSchema, target)) return undefined;
  const found = findTargets(element.ownerDocument, target, { hidden });
  return found.length === 1 && found[0] === element ? target : undefined;
}

/**
 * The accessible-name locator of a control on a signed-in page that may go on to the
 * password (ADR 0048 amendment of 2026-10-19): its {@link controlName}, when exactly one
 * shown control of the page has that name, counted as the executor sees the page, it
 * holds no number and redaction leaves it unchanged, as a field's visible name (ADR
 * 0037), and it and all the text the control holds ({@link controlContent}, hidden text
 * too) pass `namesPasswordControl`, so a phone's "Select Phone - +61 4•• ••• 123", a
 * "Send code" button, one whose "Send code" is `aria-hidden` and one whose text is too long
 * to read in full are never located this way.
 */
function passwordChoiceTarget(element: Element, index: LocatorIndex): LoginTarget | undefined {
  const name = controlName(element);
  if (
    name === undefined ||
    /\p{Number}/u.test(name) ||
    observedText(name) !== name ||
    index.get("accessible-name")!.get(name) !== 1 ||
    !namesPasswordControl(name, controlContent(element))
  )
    return undefined;
  const target = { by: "accessible-name" as const, value: name };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

/**
 * The accessible-name locator of a login form's native button that no other locator names
 * alone (ADR 0048 amendment of 2026-10-23), such as an `<input type="submit">`
 * without a `value` labelled by the text it shows: its {@link controlName}, when exactly
 * one shown control of the page has that name, counted as the executor sees the page, it
 * holds no number and redaction leaves it unchanged, as a field's visible name (ADR 0037).
 * A route step's click may then press it; script, role and fragment-link controls never
 * get it here.
 */
function buttonNameTarget(element: Element, index: LocatorIndex): LoginTarget | undefined {
  if (!isButton(element)) return undefined;
  const name = controlName(element);
  if (
    name === undefined ||
    /\p{Number}/u.test(name) ||
    observedText(name) !== name ||
    index.get("accessible-name")!.get(name) !== 1
  )
    return undefined;
  const target = { by: "accessible-name" as const, value: name };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

const idList = (element: Element, attribute: string) =>
  element.getAttribute(attribute)?.split(/\s+/u).filter(Boolean) ?? [];

/**
 * Visible text of the elements `ids` name. With `skip`, the text of an element matching
 * it, or of one inside such an element, is left out; with `keys`, the keys of a page's
 * software keyboards (ADR 0067), so is their text, as the key labels and their order.
 */
function referencedText(
  element: Element,
  ids: readonly string[],
  skip?: string,
  keys?: ReadonlySet<Element>,
): string | undefined {
  const parts = ids.flatMap((id) => {
    const referenced = treeOf(element).getElementById(id);
    if (!referenced || (skip && closestAcross(referenced, skip))) return [];
    const text = uncutText(renderedText(referenced, rawLimit, { skip, leave: keys }));
    return text ? [text] : [];
  });
  return uncutText(parts.join(" "));
}

/** Regions that announce changes, such as a failed sign-in's message. */
const liveRegions = [
  ...["alert", "status", "log", "marquee", "timer"].map((role) => `[role~='${role}' i]`),
  "[aria-live]:not([aria-live='off'])",
].join(", ");

/**
 * A field's `aria-describedby` text, such as a hint that it takes three digits. Error
 * messages can echo the value the user typed, so a field marked `aria-invalid="true"`
 * gets none, and an element its `aria-errormessage` names or a live region, around the
 * description or inside it, never counts.
 * Text that repeats the label is left out.
 */
function fieldDescription(
  input: HTMLInputElement,
  label: string | undefined,
  keys?: ReadonlySet<Element>,
) {
  if (input.getAttribute("aria-invalid")?.trim().toLowerCase() === "true") return undefined;
  const errors = new Set(idList(input, "aria-errormessage"));
  const text = referencedText(
    input,
    idList(input, "aria-describedby").filter((id) => !errors.has(id)),
    liveRegions,
    keys,
  );
  return text === label ? undefined : text;
}

const nearDepth = 6;
const maxNear = 3;
/** Elements examined for text near a code field or a page's buttons. */
const nearScanLimit = 2000;
/**
 * Elements whose text is never text near a code field: live regions and error messages,
 * which can echo a typed value (ADR 0010), editable text and output boxes, which can
 * show it, controls, labels and links, which the observation describes as candidates,
 * headings, which it already carries, and code-like text (`code`, `pre`, `kbd`,
 * `samp`), which may show a setup key or recovery code. Such an element anywhere above
 * the field, as a page wrapped in a live region, leaves out every text.
 */
const notNearElements = [
  "a, button, label, input, select, textarea, output, h1, h2, h3, code, pre, kbd, samp",
  "[contenteditable]:not([contenteditable='false' i])",
  ...["button", "link", "heading", "textbox", "searchbox", "combobox", "spinbutton"].map(
    (role) => `[role~='${role}' i]`,
  ),
].join(", ");
const notNear = `${liveRegions}, ${notNearElements}`;

/** A live region announcing a page's step politely, without a role of its own. */
const politeStep = `[aria-live='polite' i]:not(${["alert", "status", "log", "marquee", "timer"]
  .map((role) => `[role~='${role}' i]`)
  .join(", ")})`;

/**
 * Up to three short texts a signed-in page shows near its code field, for the judge to
 * tell where the code comes from (ADR 0027, owner decision 2026-10-12 22:04 UTC), such as
 * an authenticator-app sentence outside the code form: each the rendered text of one
 * shown element without child elements, within six parents of the field (never the body
 * or above) and below the first parent that holds another shown field to type in, so the
 * texts stay with the code's own part of the page, nearest parent first and then in page
 * order, returned in page order. A text that looks like a key or recovery code
 * ({@link keyLike}, read before redaction), or whose parent up to the area shows one
 * ({@link inKey}), is left out; any other is normalized as
 * `observedText` does but not cut, then passed to `keep`, which hides it, cuts it or
 * drops it; only kept texts count, and each once. Elements matching
 * `notNear`, those inside one and those the field's `aria-errormessage` names are left
 * out, and a field marked `aria-invalid="true"` gets none, as its description does.
 */
function nearCodeTexts(field: HTMLElement, keep: (text: string) => string | undefined): string[] {
  if (field.getAttribute("aria-invalid")?.trim().toLowerCase() === "true") return [];
  const errors = idList(field, "aria-errormessage").flatMap((id) => {
    const element = treeOf(field).getElementById(id);
    return element ? [element] : [];
  });
  return nearTexts([field], keep, errors);
}

/**
 * Up to three short texts a signed-in page without a code field shows near its buttons,
 * for the judge to tell what a button whose label says little, such as "Verify", starts
 * (ADR 0027, owner decision 2026-10-13 04:22 UTC). They are read as `nearCodeTexts` reads
 * them, around every given button at once, nearest parent first. An open modal dialog
 * that holds one of the buttons, or else the page's first shown main landmark, bounds
 * them: only the buttons inside it count and only texts inside it are read, so a help or
 * account widget beside it does not take the texts. Buttons and texts in the header and
 * navigation, which `headerText` already carries, never count. A polite live region
 * inside the modal or main that holds one of the counted buttons, as the step Oracle
 * Cloud's sign-in swaps in place (2026-10-13), is read as any other parent: its text is
 * the step's own (`politeStep`). Any other live region still leaves out its text: one
 * that holds none of the buttons, an alert, status, log, marquee or timer even with a
 * dismiss button, an assertive one, and one around the modal or main, such as a page
 * wrapped whole.
 */
function nearButtonTexts(
  buttons: readonly HTMLElement[],
  keep: (text: string) => string | undefined,
): string[] {
  const document = buttons[0]?.ownerDocument;
  if (!document) return [];
  const bound =
    openModals(document).find((modal) => buttons.some((button) => containsAcross(modal, button))) ??
    queryAll(document, "main, [role~='main' i]").find((main) => shown(main));
  const anchors = buttons.filter(
    (button) => (!bound || containsAcross(bound, button)) && !closestAcross(button, landmarks),
  );
  const steps = new Set<Element>();
  const regionAbove = (element: Element) => {
    const parent = composedParent(element);
    return parent ? closestAcross(parent, liveRegions) : null;
  };
  const inBound = (region: Element) => bound !== undefined && containsAcross(bound, region);
  for (const anchor of anchors)
    for (let region = regionAbove(anchor); region && inBound(region); region = regionAbove(region))
      if (region.matches(politeStep) && !region.matches(notNearElements)) steps.add(region);
  return nearTexts(anchors, keep, queryAll(document, landmarks), bound, steps);
}

/**
 * The texts near `anchors` that `nearCodeTexts` describes, read around each anchor in page
 * order, one parent further out at a time, until three are kept; `excluded` elements and
 * those inside them are left out, with `within`, no parent outside it is read, and
 * `read` live regions leave out none of their text.
 */
function nearTexts(
  anchors: readonly HTMLElement[],
  keep: (text: string) => string | undefined,
  excluded: readonly Element[],
  within?: Element,
  read: ReadonlySet<Element> = new Set(),
): string[] {
  const notNearAbove = (element: Element) => {
    let at = closestAcross(element, notNear);
    while (at && read.has(at)) {
      const parent = composedParent(at);
      at = parent && closestAcross(parent, notNear);
    }
    return at !== null;
  };
  const found: { element: Element; text: string }[] = [];
  const keyParents = new Map<Element, boolean>();
  let scanned = 0;
  // Each anchor's innermost parent read so far; an anchor whose area may not grow is
  // dropped.
  let reached = anchors.map((anchor) => ({ anchor, inner: anchor as Element }));
  for (let depth = 0; depth < nearDepth && found.length < maxNear; depth += 1) {
    const next: typeof reached = [];
    for (const { anchor, inner } of reached) {
      if (found.length >= maxNear || scanned > nearScanLimit) break;
      const area = composedParent(inner);
      if (
        !area ||
        area === anchor.ownerDocument.body ||
        area === anchor.ownerDocument.documentElement ||
        (within !== undefined && !containsAcross(within, area)) ||
        otherEntryField(area, anchor)
      )
        continue;
      for (const element of queryAll(area, "*")) {
        if (found.length >= maxNear || (scanned += 1) > nearScanLimit) break;
        if (
          element.childElementCount > 0 ||
          (shadowRootOf(element)?.childElementCount ?? 0) > 0 ||
          containsAcross(inner, element) ||
          notNearAbove(element) ||
          excluded.some((error) => containsAcross(error, element))
        )
          continue;
        const rendered = renderedText(element, rawLimit);
        // A text that looks like a key or recovery code may be a secret, and is never
        // sent; it is read before redaction hides its digits. A key printed one group per
        // element shows only in the text of a parent, so each parent up to the area is
        // read too.
        if (rendered === undefined || keyLike(rendered) || inKey(element, area, keyParents))
          continue;
        const raw = observedText(rendered, Number.POSITIVE_INFINITY);
        const text = raw && keep(raw);
        if (text && !found.some((entry) => entry.text === text)) found.push({ element, text });
      }
      next.push({ anchor, inner: area });
    }
    reached = next;
  }
  return found
    .sort((left, right) => composedOrder(left.element, right.element))
    .map(({ text }) => text);
}

/** How much of a parent's text is read to tell whether it shows a key. */
const keyScanLimit = 2000;
/**
 * Whether a parent of `element`, up to and including `area`, shows text that looks like
 * a key or recovery code ({@link keyLike}), as a key printed one group per element does.
 * Answers are kept in `seen`, since leaves share their parents.
 */
function inKey(element: Element, area: Element, seen: Map<Element, boolean>): boolean {
  for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
    const key = seen.getOrInsertComputed(parent, () => {
      const text = renderedText(parent, keyScanLimit);
      return text !== undefined && keyLike(text);
    });
    if (key) return true;
    if (parent === area) break;
  }
  return false;
}

/**
 * Fields a person types in: inputs other than buttons, checkboxes, radios, hidden and
 * other non-text inputs, text areas, and editable text.
 */
const typedFields = [
  "input:not([type='hidden' i], [type='checkbox' i], [type='radio' i], [type='submit' i], [type='button' i], [type='reset' i], [type='image' i], [type='file' i], [type='range' i], [type='color' i])",
  "textarea",
  "[contenteditable]:not([contenteditable='false' i])",
  "[role~='textbox' i]",
  "[role~='searchbox' i]",
].join(", ");
/**
 * Whether `area` holds a shown, enabled and writable field to type in other than the code
 * field `field`, or than another one-character input of a code split into one input per
 * digit. A read-only field, such as the account shown above a code, does not count.
 */
function otherEntryField(area: Element, field: HTMLElement): boolean {
  const split = field instanceof HTMLInputElement && field.maxLength === 1;
  for (const element of queryAll<HTMLElement>(area, typedFields)) {
    if (element === field || containsAcross(field, element) || !shown(element)) continue;
    // A disabled or read-only field, or one kept out of reach as a form's trap for bots is.
    if (
      element.matches(
        ":disabled, [readonly], [aria-readonly='true' i], [aria-disabled='true' i], [tabindex='-1']",
      ) ||
      closestAcross(element, "[aria-hidden='true' i]")
    )
      continue;
    if (split && element instanceof HTMLInputElement && element.maxLength === 1) continue;
    return true;
  }
  return false;
}

/**
 * Whether a text shows what may be a key or recovery code, as one printed whole or in
 * groups is: a word of ten or more letters and digits that holds both, such as an
 * unspaced setup key; two or more groups of four or five letters and digits joined by
 * hyphens, holding a letter and a digit, or three or more such groups holding a letter;
 * two words side by side of four to eight letters and digits that each mix both; four or
 * more words in a row of four letters and digits of which two or more mix both; or three
 * or more words in a row of four or five capitals and digits of which two or more hold a
 * letter. Invisible format characters, such as a zero-width
 * space inside a key, are read as nothing; an email address is not read at all; and
 * digits alone, such as a phone number after a word, never make one.
 */
function keyLike(text: string): boolean {
  // An email address names where a code went, and is no key; digits alone, such as a
  // phone number, are hidden anyway.
  const normalized = text
    .replace(/\p{Cf}/gu, "")
    .normalize("NFKC")
    .replace(/\S+@\S+/gu, " ");
  const groups = normalized.match(
    /(?<![A-Za-z0-9-])[A-Za-z0-9]{4,5}(?:-[A-Za-z0-9]{4,5})+(?![A-Za-z0-9-])/gu,
  );
  if (
    groups?.some(
      (group) => /[A-Za-z]/u.test(group) && (/\d/u.test(group) || group.split("-").length >= 3),
    )
  )
    return true;
  const words = normalized.split(/[^\p{L}\p{N}]+/u);
  if (
    words.some(
      (word) => /^[A-Za-z0-9]{10,}$/u.test(word) && /\d/u.test(word) && /[A-Za-z]/u.test(word),
    )
  )
    return true;
  let mixedBefore = false;
  let fourRun = 0;
  let fourMixed = 0;
  let capitalRun = 0;
  let lettered = 0;
  for (const word of words) {
    const letter = /[A-Za-z]/u.test(word);
    const mixed = letter && /\d/u.test(word);
    // Two mixed words side by side, such as `XK7Q 9PLM` or `JBSWY3DP EHPK3PXP`.
    const mixedNow = mixed && /^[A-Za-z0-9]{4,8}$/u.test(word);
    if (mixedNow && mixedBefore) return true;
    mixedBefore = mixedNow;
    // Four or more groups of four, such as `jbsw y3dp ehpk 3pxp`.
    if (/^[A-Za-z0-9]{4}$/u.test(word)) {
      fourRun += 1;
      if (mixed) fourMixed += 1;
      if (fourRun >= 4 && fourMixed >= 2) return true;
    } else {
      fourRun = 0;
      fourMixed = 0;
    }
    if (/^[A-Z0-9]{4,5}$/u.test(word)) {
      capitalRun += 1;
      if (letter) lettered += 1;
      if (capitalRun >= 3 && lettered >= 2) return true;
    } else {
      capitalRun = 0;
      lettered = 0;
    }
  }
  return false;
}

/** True for an element that belongs to another control: a control or its `<label for>`. */
function otherControl(node: Element, element: Element): boolean {
  const labelsOther = (label: Element) =>
    label instanceof HTMLLabelElement && label.htmlFor !== "" && label.control !== element;
  return (
    node.matches(controls) ||
    labelsOther(node) ||
    queryAll(node, controls).length > 0 ||
    queryAll(node, "label[for]").some(labelsOther)
  );
}

/**
 * Text of a nearby element that labels a field by layout, as table and form rows do:
 * the nearest preceding sibling with rendered text, at most three levels up, never
 * across another control's area, a software keyboard's keys (`keys`, ADR 0067) or out of
 * the field's form.
 */
function adjacentText(element: Element, keys?: ReadonlySet<Element>): string | undefined {
  let node: Element | null = element;
  for (let depth = 0; node && depth <= labelDepth; depth += 1) {
    if (depth > 0 && queryAll(node, fields).length > 1) return undefined;
    if (node instanceof HTMLFormElement || node === node.ownerDocument.body) return undefined;
    for (let sibling = node.previousElementSibling; sibling;) {
      const before: Element = sibling;
      if (
        otherControl(before, element) ||
        (keys?.size && [...keys].some((key) => before.contains(key) || key.contains(before)))
      )
        return undefined;
      const text = visibleText(sibling);
      if (text) return text;
      sibling = sibling.previousElementSibling;
    }
    node = composedParent(node);
  }
  return undefined;
}

/**
 * A field's label. The keys of a page's software keyboards (`keys`, ADR 0067), with their
 * labels and order, are never part of it; the rest of a label around them is.
 */
function fieldLabel(
  input: HTMLInputElement | HTMLSelectElement,
  keys?: ReadonlySet<Element>,
): string | undefined {
  const labels = [...(input.labels ?? [])].flatMap((label) => {
    const text = uncutText(renderedText(label, rawLimit, { leave: keys }));
    return text ? [text] : [];
  });
  return (
    referencedText(input, idList(input, "aria-labelledby"), undefined, keys) ??
    uncutText(input.getAttribute("aria-label")) ??
    uncutText(labels.join(" ")) ??
    adjacentText(input, keys) ??
    uncutText(input.title)
  );
}

function actionLabel(element: HTMLElement): string | undefined {
  const images = queryAll(element, "img[alt]").flatMap((image) =>
    shown(image) ? [image.getAttribute("alt")] : [],
  );
  return (
    referencedText(element, idList(element, "aria-labelledby")) ??
    uncutText(element.getAttribute("aria-label")) ??
    (element instanceof HTMLInputElement
      ? uncutText(element.type === "image" ? element.alt : element.value)
      : visibleText(element)) ??
    uncutText(images.join(" ")) ??
    uncutText(element.title)
  );
}

function autocomplete(
  input: HTMLInputElement | HTMLSelectElement,
): ObservedCandidate["autocomplete"] {
  const tokens = autocompleteTokens(input);
  if (tokens.length === 1 && tokens[0] === "off") return "off";
  return observedAutocompleteTokens.find((token) => tokens.includes(token));
}

function constraints(input: HTMLInputElement, role: ObservedCandidate["role"]) {
  const inRange = (value: number) => value >= 1 && value <= 1024;
  const max = input.maxLength;
  const min = input.minLength;
  const lengths =
    role === "number" || (inRange(max) && inRange(min) && min > max)
      ? {}
      : {
          ...(inRange(max) ? { maxLength: max } : {}),
          ...(inRange(min) ? { minLength: min } : {}),
        };
  const mode = input.getAttribute("inputmode")?.trim().toLowerCase();
  const inputMode = inputModes.find((entry) => entry === mode);
  return { ...lengths, ...(inputMode ? { inputMode } : {}) };
}

type Draft = Omit<ObservedCandidate, "id" | "target" | "group"> & { element: HTMLElement };
type Found =
  | { kind: "candidate"; form: HTMLFormElement | null; draft: Draft }
  /**
   * A visible control the executor cannot act on, such as a select or a radio button.
   * `field` holds a text or password field that cannot be filled: read-only (as with
   * software keyboards), disabled until another step, or transparent or tiny.
   */
  | {
      kind: "unsupported";
      form: HTMLFormElement | null;
      field: HTMLInputElement | undefined;
      element: HTMLElement;
    };

/** A control a click step may press: a button, a submit, button or image input, or a script button. */
const actionControl = (element: HTMLElement) =>
  element instanceof HTMLButtonElement ||
  (element instanceof HTMLInputElement && actionTypes.has(element.type)) ||
  isScriptButton(element);

/**
 * A page's software keyboard (ADR 0067) and the locator that names it for every field,
 * if any; without one, each field names it by its position from that field.
 */
interface Keypad {
  readonly container: Element;
  readonly target: LoginKeypadTarget | undefined;
}

/**
 * The page's software keyboards (ADR 0067): each field's own (`of`), and the keys of
 * every keyboard on the page, whatever field it serves, which are never described and
 * whose text is never read.
 */
interface Keypads {
  readonly of: (field: HTMLInputElement) => Keypad | undefined;
  readonly keys: ReadonlySet<Element>;
}

/**
 * Describes one element. With `keypads`, the page's software keyboards (ADR 0067), a
 * visible, enabled, empty read-only field beside its keypad (`keypadField`) is a fill
 * candidate entered on that keypad instead of a field that cannot be filled, and no
 * label or description holds a key's text.
 */
function describe(element: Element, keypads?: Keypads): Found | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  // An action control the page keeps `inert` itself until its fields are filled stays a
  // candidate, as a disabled one does (`readOwnInert`, #853).
  const present = actionControl(element)
    ? readOwnInert(element, () => presence(element))
    : presence(element);
  let keyed = false;
  let keypadLocator: LoginKeypadTarget | undefined;
  const keypad = element instanceof HTMLInputElement ? keypads?.of(element) : undefined;
  if (element instanceof HTMLInputElement && fillTypes[element.type] && present !== "absent") {
    keyed = keypad !== undefined && present === "visible" && keypadField(element, keypad.container);
    if (keyed && keypad)
      keypadLocator = keypad.target ?? keypadPositionTarget(element, keypad.container);
    if (keyed && !keypadLocator) keyed = false;
    if (!keyed && (present === "faint" || element.readOnly || element.disabled))
      return { kind: "unsupported", form: formOf(element), field: element, element };
  } else if (present !== "visible") return undefined;
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (ignoredTypes.has(type)) return undefined;
    // A disabled submit often enables once fields are filled, so it stays a candidate.
    if (element.disabled && !actionTypes.has(type)) return undefined;
    const fillRole = fillTypes[type];
    if (fillRole) {
      const label = fieldLabel(element, keypads?.keys);
      const placeholder = uncutText(element.placeholder);
      const description = fieldDescription(element, label, keypads?.keys);
      const hint = autocomplete(element);
      return {
        kind: "candidate",
        form: formOf(element),
        draft: {
          element,
          role: fillRole,
          ...(label ? { label } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(description ? { description } : {}),
          ...(hint ? { autocomplete: hint } : {}),
          ...constraints(element, fillRole),
          ...(keyed && keypadLocator ? { keypad: keypadLocator } : {}),
        },
      };
    }
    if (type === "checkbox" || actionTypes.has(type)) {
      const label = type === "checkbox" ? fieldLabel(element, keypads?.keys) : actionLabel(element);
      return {
        kind: "candidate",
        form: formOf(element),
        draft: {
          element,
          role: type === "checkbox" ? "checkbox" : "button",
          ...(label ? { label } : {}),
        },
      };
    }
    // Radio groups and other input types have no executor support yet.
    return { kind: "unsupported", form: formOf(element), field: undefined, element };
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
    return element.disabled
      ? undefined
      : { kind: "unsupported", form: formOf(element), field: undefined, element };
  if (element instanceof HTMLButtonElement) {
    if (element.type === "reset") return undefined;
    const label = actionLabel(element);
    // A disabled button often enables once fields are filled, so it stays a candidate.
    return {
      kind: "candidate",
      form: formOf(element),
      draft: { element, role: "button", ...(label ? { label } : {}) },
    };
  }
  if (
    isScriptButton(element) ||
    (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
  ) {
    const label = actionLabel(element);
    return {
      kind: "candidate",
      form: closestAcross(element, "form") as HTMLFormElement | null,
      draft: {
        element,
        role: isScriptButton(element) ? "button" : "link",
        ...(label ? { label } : {}),
      },
    };
  }
  return undefined;
}

/** Radio buttons, selects, text areas and the ARIA widgets that stand for them. */
const answerControls = [
  "input[type='radio' i]",
  "select",
  "textarea",
  ...["radio", "radiogroup", "combobox", "listbox", "textbox"].map((role) => `[role~='${role}' i]`),
].join(", ");
const searchWords = /\bsearch\b|検索|探す/iu;
/** A search box: a search input, or an input whose name for the person says search. */
const searchBox = (element: Element) =>
  (element instanceof HTMLInputElement &&
    (element.type === "search" || element.inputMode === "search")) ||
  element.matches("[role~='searchbox' i]") ||
  ["aria-label", "placeholder", "title"].some((name) =>
    searchWords.test(element.getAttribute(name) ?? ""),
  );
/**
 * Whether `form` is a small search form: at most four controls in all, as a box, a
 * category select and a button, whose typed inputs are all search boxes, so a whole page
 * wrapped in one form, or a sign-in form with a site search box, is none.
 */
function searchForm(form: HTMLFormElement): boolean {
  const held = controlsOf(form, form.ownerDocument).filter(
    (element) => !(element instanceof HTMLInputElement && element.type === "hidden"),
  );
  const typed = held.filter(
    (element) =>
      element instanceof HTMLInputElement &&
      !["checkbox", "radio", "submit", "button", "reset", "image"].includes(element.type),
  );
  return held.length <= 4 && typed.length > 0 && typed.every(searchBox);
}
/**
 * Whether `element` is in the page's footer: `contentinfo`, or a `footer` that is no
 * part of an article, section, dialog or form, as HTML maps it to that landmark.
 */
function pageFooter(element: HTMLElement): boolean {
  if (closestAcross(element, "[role~='contentinfo' i]")) return true;
  const footer = closestAcross(element, "footer");
  return (
    footer !== null &&
    !closestAcross(
      footer,
      "article, aside, main, nav, section, dialog, form, [role~='dialog' i], [role~='alertdialog' i]",
    )
  );
}
/**
 * Whether the page shows a radio button, select or text area, or an ARIA radio, radio
 * group, combo box, list box or text box, that is no part of a site search: an answer
 * the person may be asked for that the description has no role for (ADR 0065). A
 * disabled one counts, and so does a transparent, tiny or unrendered one under a label
 * or container that shows, as a styled radio under its label "card" is. One in a search
 * landmark, a search box itself, a select or combo box of a small search form, and a
 * select or combo box in the page footer, such as a language picker, do not.
 */
function leftOutInputs(document: Document): boolean {
  // Each form is checked once per scan, however many selects it holds.
  const searchForms = new Map<HTMLFormElement, boolean>();
  for (const element of queryAll<HTMLElement>(document, answerControls)) {
    if (closestAcross(element, "search, [role~='search' i]")) continue;
    if (searchBox(element)) continue;
    const picker = element instanceof HTMLSelectElement || element.matches("[role~='combobox' i]");
    // A page footer's select, as a language or region picker, asks nothing of the sign-in.
    if (picker && pageFooter(element)) continue;
    const choice = picker || element.matches("[role~='listbox' i]");
    const form = closestAcross(element, "form") as HTMLFormElement | null;
    if (choice && form) {
      let search = searchForms.get(form);
      if (search === undefined) searchForms.set(form, (search = searchForm(form)));
      if (search) continue;
    }
    if (presence(element) !== "absent") return true;
    // A styled control hides its input under a label or card that shows.
    const labels =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? [...(element.labels ?? [])]
        : [];
    const container = (closestAcross(element, "label") ??
      composedParent(element)) as HTMLElement | null;
    if ([...labels, ...(container ? [container] : [])].some((shownBy) => visible(shownBy)))
      return true;
  }
  return false;
}

/**
 * Every element the page shows that `describe` accepts, in document order, shadow trees
 * included (ADR 0070).
 */
const describeAll = (document: Document, keypads?: Keypads) =>
  queryAll(document, observed)
    .map((element) => describe(element, keypads))
    .filter((entry) => entry !== undefined);

/**
 * The locator of the page's software keyboard (`findKeypad`, ADR 0067): the `id`,
 * `data-testid` or class of the keypad or its nearest ancestor below the body that names
 * it alone in the document, skipping an ID React generated or another load may change, a
 * class that looks generated the same way, and, with `tokens`, a value that may be a
 * token. Without one, each field names the keypad by its position (`keypadPositionTarget`).
 */
function keypadTarget(
  container: Element,
  index: LocatorIndex,
  tokens: boolean,
): LoginKeypadTarget | undefined {
  const { body } = container.ownerDocument;
  for (let node: Element | null = container; node && node !== body; node = node.parentElement) {
    for (const [by, attribute] of [
      ["id", "id"],
      ["test-id", "data-testid"],
    ] as const) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === "id" && (generatedId.test(value) || changingId(value))) continue;
      if (tokens && tokenSegment(value)) continue;
      const target = { by, value };
      if (v.is(loginKeypadTargetSchema, target) && index.get(attribute)!.get(value) === 1)
        return target;
    }
    for (const value of node.classList) {
      if (generatedId.test(value) || changingId(value) || (tokens && tokenSegment(value))) continue;
      const target = { by: "class" as const, value };
      if (
        v.is(loginKeypadTargetSchema, target) &&
        container.ownerDocument.getElementsByClassName(value).length === 1
      )
        return target;
    }
  }
  return undefined;
}

/**
 * The page's software keyboards (ADR 0067). Each input's own is the keypad beside it
 * (`findKeypad`), described with its locator; the keys of every keypad on the page, those
 * beside a writable field with an optional keyboard and those of the document's key
 * groups (`findKeypads`) included, are left out of the candidates and of every label and
 * description, as no step presses one by name and their labels and order never reach the
 * service.
 */
function pageKeypads(document: Document, index: LocatorIndex, tokens: boolean): Keypads {
  const own = new Map<Element, Keypad>();
  const all = keypadKeys(document);
  if (all.length < KEYPAD_MIN_KEYS) return { of: () => undefined, keys: new Set() };
  const containers = new Set<Element>(findKeypads(document, all));
  const targets = new Map<Element, LoginKeypadTarget | undefined>();
  for (const field of document.querySelectorAll("input")) {
    const container = findKeypad(document, field, all);
    if (!container) continue;
    if (!targets.has(container)) targets.set(container, keypadTarget(container, index, tokens));
    containers.add(container);
    own.set(field, { container, target: targets.get(container) });
  }
  return {
    of: (field) => own.get(field),
    keys: new Set([...containers].flatMap((container) => keypadKeys(container))),
  };
}

/** The keypad's position from `field` (`keypadPosition`), as a locator. */
function keypadPositionTarget(field: Element, container: Element): LoginKeypadTarget | undefined {
  const value = keypadPosition(field, container);
  return value === undefined ? undefined : { by: "position", value };
}

/** How many selects a judged page's description carries at most (ADR 0061). */
const maxSelects = 12;
/**
 * The shown, enabled single-choice selects of a judged page (ADR 0061), each as a `select`
 * with its label and `autocomplete`, never its options: the judge may name one as a split
 * birth date's or card expiry date's part, and the fill matches an option by its number.
 */
function describeSelects(document: Document): { form: HTMLFormElement | null; draft: Draft }[] {
  return queryAll<HTMLSelectElement>(document, "select").flatMap((select) => {
    if (select.multiple || select.matches(":disabled") || presence(select) !== "visible") return [];
    const label = fieldLabel(select);
    const hint = autocomplete(select);
    return [
      {
        form: formOf(select),
        draft: {
          element: select,
          role: "select" as const,
          ...(label ? { label } : {}),
          ...(hint ? { autocomplete: hint } : {}),
        },
      },
    ];
  });
}

/**
 * Why a page's description found no field, as a log code of codes only (ADR 0019): how
 * many inputs other than hidden ones the page holds (`n`), how many fields `describe`
 * accepted (`d`), and the first three such inputs as `type-presence`, the presence being
 * `shown` or {@link presenceMiss}'s reason, with `-out` for one outside every form. Added
 * after x.com's sign-in was described without its field in the owner's Chrome only
 * (2026-10-23).
 */
export function fieldsMissDetail(document: Document): string {
  const inputs = queryAll<HTMLInputElement>(document, "input:not([type='hidden'])");
  const described = describeAll(document).filter(
    (entry) =>
      (entry.kind === "candidate" && fillTypes[entry.draft.role]) ||
      (entry.kind === "unsupported" && entry.field),
  ).length;
  const first = inputs
    .slice(0, 3)
    .map(
      (input) => `${input.type}-${presenceMiss(input) ?? "shown"}${formOf(input) ? "" : "-out"}`,
    );
  return [`n${inputs.length}`, `d${described}`, ...first].join(".");
}

/**
 * An icon button that never submits a form on its own, such as the eye that shows the
 * password: `type="button"` and no text of its own, so no text locator either. One with
 * text, such as an `<input type="button" value="Login">` that submits by script, is not.
 * A textless button of any type outside every form has no form to submit either, but
 * one near the fields outside every form (`nearFields`) may be their script-run submit;
 * one away from them, such as a cookie banner's close button on Bank of America's home
 * page (2026-10-23), counts.
 */
const iconButton = (element: Element, nearFields: (element: Element) => boolean) =>
  isButton(element) &&
  (element.type === "button" || (formOf(element) === null && !nearFields(element))) &&
  buttonText(element) === undefined;

/**
 * Whether a checkbox must be checked before its form submits: `required`, or
 * `aria-required="true"` for a script that checks it.
 */
const mustCheck = (element: Element) =>
  (element instanceof HTMLInputElement && element.required) ||
  element.getAttribute("aria-required")?.trim().toLowerCase() === "true";

/** True for a path with a segment that may carry a token (`tokenSegment`). */
const tokenPath = (pathname: string) => pathname.split("/").some(tokenSegment);

function language(texts: readonly string[]): LoginObservation["language"] {
  const joined = texts.join(" ").replace(/\[(?:email|masked|number)\]/gu, " ");
  const japanese = joined.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
  const latin = joined.match(/[A-Za-zＡ-Ｚａ-ｚ]/gu);
  const ja = japanese?.length ?? 0;
  const en = latin?.length ?? 0;
  const share = ja / Math.max(ja + en, 1);
  // A Japanese page often has "ID" labels and an English page a "日本語" switcher.
  return share >= 0.5 ? "ja" : share <= 0.1 ? "en" : "mixed";
}

/**
 * The forms, among those holding a field (`null` for fields outside any form), whose
 * controls a login needs: those with one password field that is not `new-password` or
 * with a `username` or `one-time-code` field, as ADR 0016 detects a login; failing that,
 * any with a password field; otherwise all of them.
 */
function loginFormsOf(
  found: readonly Found[],
  fieldForms: ReadonlySet<HTMLFormElement | null>,
): ReadonlySet<HTMLFormElement | null> {
  const inputs = new Map<HTMLFormElement | null, HTMLInputElement[]>();
  for (const entry of found) {
    const input =
      entry.kind === "candidate"
        ? entry.draft.element instanceof HTMLInputElement && fillTypes[entry.draft.element.type]
          ? entry.draft.element
          : undefined
        : entry.field;
    if (input) inputs.set(entry.form, [...(inputs.get(entry.form) ?? []), input]);
  }
  const hints = (form: HTMLFormElement | null) =>
    (inputs.get(form) ?? []).map((input) => autocomplete(input));
  const passwords = (form: HTMLFormElement | null) =>
    (inputs.get(form) ?? []).filter((input) => input.type === "password");
  const tiers: ((form: HTMLFormElement | null) => boolean)[] = [
    (form) =>
      !hints(form).includes("new-password") &&
      (passwords(form).length === 1 ||
        (passwords(form).length === 0 &&
          hints(form).some((hint) => hint === "username" || hint === "one-time-code"))),
    (form) => passwords(form).length > 0,
  ];
  for (const tier of tiers) {
    const forms = new Set([...fieldForms].filter(tier));
    if (forms.size > 0) return forms;
  }
  return fieldForms;
}

/**
 * Builds the value-free observation of a top-level page that recipe generation
 * receives. It reads element types, locators, labels, placeholders, descriptions and
 * declared input constraints, plus the title and visible headings; never input values,
 * hidden inputs, query strings, scripts or markup. Label text comes from label elements,
 * ARIA, or the rendered text next to a field, with private-looking parts redacted.
 *
 * Only forms that hold a field matter: their buttons, checkboxes and, as context, their
 * links (or, for fields outside any form, every control outside a form; a control the
 * executor cannot act on counts there only near those fields, `formlessFieldsArea`). Up to four
 * buttons outside every form but near a login form with a password field
 * (`besideDepth`), such as a passkey button, are kept when they can be located and never
 * make the observation incomplete. A field or button that cannot be located (other than
 * a script button, an icon button that never submits in a form with another button, a
 * textless button away from the fields outside every form when another button outside
 * every form is located, or a checkbox the page does not require, which is left out) or
 * a control the executor cannot act on marks the observation
 * incomplete when it is in a login form (`loginFormsOf`); any other form with one is
 * left out entirely. More than 48 candidates mark it incomplete too, and inference rejects an incomplete observation. An incomplete result
 * names its first cause in `loginGaps` order as `gap`, for the log only. A page without a
 * field is refused, and so is one where nothing can be located. As on every observed
 * page, a path segment that may carry a token is sent as `REDACTED_PATH_SEGMENT`
 * (`observedPath`, ADR 0039); on such a page an ID, name or test ID that may be a token
 * locates nothing.
 *
 * `known` names the fields a recipe already fills, on any of its paths, for a page that
 * continues it after an `advance` step (ADR 0018). Such a field shown read-only or disabled, as an
 * email address shown again beside the password, is left out instead: the recipe has
 * filled it, and no step of this page needs it.
 */
export function extractLoginObservation(
  document: Document = globalThis.document,
  known: readonly LoginTarget[] = [],
): ObservationResult {
  return readingPage(() => readLogin(document, known));
}

function readLogin(document: Document, known: readonly LoginTarget[]): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };
  const tokens = redactsPath(location.pathname);

  const index = locatorIndex(document);
  const filled = (field: HTMLInputElement) =>
    (field.readOnly || field.disabled) &&
    known.some((target) => {
      if ("within" in target && target.within) {
        const found = findTargets(document, target, { hidden: true });
        return found.length === 1 && found[0] === field;
      }
      if (target.by === "label")
        return fieldName(field) === target.value && index.get("label")!.get(target.value) === 1;
      if (target.by === "password-form-name") {
        const found = findTargets(document, target);
        return found.length === 1 && found[0] === field;
      }
      const attribute = locators.find(([by]) => by === target.by)?.[1];
      return (
        attribute !== undefined &&
        field.getAttribute(attribute) === target.value &&
        index.get(attribute)!.get(target.value) === 1
      );
    });
  const keypads = pageKeypads(document, index, tokens);
  const { keys } = keypads;
  // A field both faint and disabled takes input from no one, neither the person nor a
  // widget drawn over it, so a login page leaves it out as a decoy; Bitwarden never picks
  // a disabled field as the username or password field either. The signed-in page still
  // sees it, as a code field may wait there for a timer (`describeSignedIn`).
  const found = describeAll(document, keypads).filter(
    (entry) =>
      !(
        entry.kind === "unsupported" &&
        entry.field &&
        (filled(entry.field) || (entry.field.disabled && presence(entry.field) === "faint"))
      ) &&
      !(
        entry.kind === "candidate" &&
        ((entry.draft.keypad &&
          entry.draft.element instanceof HTMLInputElement &&
          filled(entry.draft.element)) ||
          keys.has(entry.draft.element))
      ),
  );
  const fieldForms = new Set(
    found.flatMap((entry) =>
      (entry.kind === "candidate" && fillTypes[entry.draft.role]) ||
      (entry.kind === "unsupported" && entry.field)
        ? [entry.form]
        : [],
    ),
  );
  if (fieldForms.size === 0) return { ok: false, reason: "no-candidates" };
  const loginForms = loginFormsOf(found, fieldForms);
  // Forms with a control the executor cannot act on or locate, and why. In a login form
  // that makes the observation incomplete; any other such form is left out entirely, so
  // every form the observation describes is fully described.
  const flawed = new Map<HTMLFormElement | null, Set<LoginGap>>();
  const flaw = (form: HTMLFormElement | null, gap: LoginGap) =>
    flawed.getOrInsertComputed(form, () => new Set<LoginGap>()).add(gap);
  const gaps = new Set<LoginGap>();

  const required: { form: HTMLFormElement | null; draft: Draft }[] = [];
  // Script buttons are often widgets (menus, toggles), and text locators name only the
  // `<a>` ones and, in a login form or beside a password form, the `role="button"` ones,
  // so one without a locator is left out rather than marking the page incomplete.
  const scripted: typeof required = [];
  // Icon buttons follow the same rule, but only in a form that has another button to
  // submit with: an icon-only button may itself be the form's script submit.
  const icons: typeof required = [];
  const links: typeof required = [];
  // A checkbox is context only, never checked by a recipe, so one the page does not
  // require, as "Remember me", is left out without a locator; a required one, as an
  // agreement the form cannot submit without, still marks the form incomplete.
  const checks: typeof required = [];
  const beside: typeof required = [];
  // Only a form with a password field has such neighbours; a search form does not.
  const passwordForms = new Set(
    found.flatMap((entry) => {
      const input = entry.kind === "candidate" ? entry.draft.element : entry.field;
      return input instanceof HTMLInputElement && input.type === "password" ? [entry.form] : [];
    }),
  );
  // Fields outside every form, and whether a button is near them: one of them within the
  // button's `besideDepth` nearest ancestors, or the button within one of theirs, so a
  // button wrapped deeper beside the fields still counts. Reaching the body or the root
  // counts as near; a mistake that way only marks the page incomplete.
  const formless = found.flatMap((entry) => {
    const input =
      entry.kind === "candidate" ? fillTypes[entry.draft.role] && entry.draft.element : entry.field;
    return input && entry.form === null ? [input] : [];
  });
  const areaOf = (element: Element) => {
    let area: Element | null = element;
    for (let depth = 0; depth < besideDepth && area; depth++) area = composedParent(area);
    return area && area !== document.body && area !== document.documentElement ? area : undefined;
  };
  const nearFields = (element: Element) => {
    const area = areaOf(element);
    return (
      !area ||
      formless.some((field) => {
        const around = areaOf(field);
        return containsAcross(area, field) || !around || containsAcross(around, element);
      })
    );
  };
  const areas = [...loginForms].flatMap((form) => {
    if (!passwordForms.has(form)) return [];
    let area: Element | null = form;
    for (let depth = 0; depth < besideDepth && area; depth++) area = composedParent(area);
    // Never the whole page, as when the form sits directly in the body.
    return area && area !== document.body && area !== document.documentElement ? [area] : [];
  });
  const formlessArea = loginForms.has(null) ? formlessFieldsArea(found, document) : undefined;
  for (const entry of found) {
    if (
      entry.kind === "candidate" &&
      entry.form === null &&
      !loginForms.has(null) &&
      entry.draft.role === "button" &&
      !closestAcross(entry.draft.element, landmarks) &&
      areas.some((area) => containsAcross(area, entry.draft.element))
    ) {
      beside.push(entry);
      continue;
    }
    if (!fieldForms.has(entry.form)) continue;
    if (entry.kind === "unsupported") {
      // Outside every form, a control far from the sign-in fields, such as a language
      // picker in the page's footer, is not one the sign-in needs.
      if (
        !entry.field &&
        entry.form === null &&
        formlessArea !== undefined &&
        !containsAcross(formlessArea, entry.element)
      )
        continue;
      flaw(entry.form, entry.field ? "unfillable-field" : "unsupported-control");
    } else if (entry.draft.role === "link") {
      if (entry.form) links.push(entry);
    } else if (entry.draft.role === "checkbox" && !mustCheck(entry.draft.element))
      checks.push(entry);
    else if (isScriptButton(entry.draft.element)) scripted.push(entry);
    else if (iconButton(entry.draft.element, nearFields)) icons.push(entry);
    else required.push(entry);
  }

  // Links and script buttons without a locator are left out without flawing their form.
  // A `role="button"` element is named by its text only inside a login form or beside a
  // password form, where it is the form's own control rather than a widget elsewhere; a
  // search form beside the login form names none. A link never takes the text of such an
  // element, whatever its form, since one observation's candidates need distinct targets
  // and the login's own control needs that text more.
  let unlocated = false;
  // A login form's native button that nothing else names alone is named by its accessible
  // name, which a route step's click may press (ADR 0048 amendment of 2026-10-23).
  const located = (
    entries: typeof required,
    { optional = false, near = false, names = false } = {},
  ) =>
    entries.flatMap((entry) => {
      const target = locate(entry.draft.element, index, {
        tokens,
        links: true,
        labels: true,
        roles:
          near ||
          entry.draft.role === "link" ||
          (entry.form !== null && loginForms.has(entry.form)),
        names: names && entry.draft.role === "button" && loginForms.has(entry.form),
      });
      if (!target) unlocated = true;
      if (!target && !optional) flaw(entry.form, unlocatedGap(entry.draft.role));
      return target ? [{ ...entry, target }] : [];
    });
  const keep = <Entry extends (typeof required)[number]>(entries: Entry[]) =>
    entries.filter((entry) => !flawed.has(entry.form) || loginForms.has(entry.form));
  const kept = (entries: typeof required, options?: { optional: boolean }) =>
    keep(located(entries, options));
  const requiredFound = located(required, { names: true });
  const iconsFound = located(icons, { optional: true });
  const submitting = new Set(
    requiredFound.filter((entry) => entry.draft.role === "button").map((entry) => entry.form),
  );
  for (const entry of icons)
    if (!submitting.has(entry.form) && !iconsFound.some((icon) => icon.draft === entry.draft))
      flaw(entry.form, "unlocated-button");
  const described = keep(requiredFound);
  for (const [form, causes] of flawed)
    if (loginForms.has(form)) for (const cause of causes) gaps.add(cause);
  if (described.length > maxCandidates) gaps.add("too-many-candidates");
  const gap = loginGaps.find((cause) => gaps.has(cause));
  const buttons = [
    ...described,
    ...kept(checks, { optional: true }),
    ...kept(scripted, { optional: true }),
    ...keep(iconsFound),
    // More than a few is page content around the form, not its alternatives.
    ...(beside.length <= maxBeside ? located(beside, { optional: true, near: true }) : []),
  ].slice(0, maxCandidates);
  const chosen = [
    ...buttons,
    ...kept(links, { optional: true }).slice(0, Math.max(0, maxCandidates - buttons.length)),
  ];
  if (chosen.length === 0) return { ok: false, reason: unlocated ? "no-locator" : "no-candidates" };
  return withGap(observe(document, chosen, gap === undefined), gap);
}

/**
 * Where the fillable fields outside every form sit: their nearest common ancestor (a
 * lone field itself) and up to `formlessDepth` levels above it, or `undefined` when that
 * reaches the body or the root element, so the whole page counts. With no `<form>` to
 * start from, this reaches a little further than `besideDepth` does above a form, so a
 * row of fields beside a row with a select still holds both.
 */
function formlessFieldsArea(found: readonly Found[], document: Document): Element | undefined {
  const inputs = found.flatMap((entry) =>
    entry.kind === "candidate" && entry.form === null && fillTypes[entry.draft.role]
      ? [entry.draft.element]
      : [],
  );
  let area: Element | null = inputs[0] ?? null;
  while (area && !inputs.every((input) => containsAcross(area!, input)))
    area = composedParent(area);
  for (let depth = 0; depth < formlessDepth && area; depth++) area = composedParent(area);
  return area && area !== document.body && area !== document.documentElement ? area : undefined;
}

/** The gap a login form's control without a locator makes, by its role. */
const unlocatedGap = (role: ObservedCandidate["role"]): LoginGap =>
  fillTypes[role]
    ? "unlocated-field"
    : role === "checkbox"
      ? "unlocated-checkbox"
      : "unlocated-button";

type Chosen = { form: HTMLFormElement | null; draft: Draft; target: LoginMarkerTarget };

/**
 * Numbers the chosen elements in document order and adds the page's title and headings;
 * with `near`, also the texts near its first code field (`nearCodeTexts`) or, without one,
 * near its buttons (`nearButtonTexts`). Every text is cut at 120 characters once `hide`
 * has run.
 */
function observe(
  document: Document,
  chosen: Chosen[],
  complete: boolean,
  hideText: (text: string) => string = (text) => text,
  accounts?: readonly string[],
  header?: string,
  path = observedPath(document.location!.pathname),
  near = false,
): ObservationResult {
  const location = document.location!;
  const hide = (text: string) => bounded(hideText(text));
  chosen.sort((left, right) => composedOrder(left.draft.element, right.draft.element));

  const groups = new Map<HTMLFormElement, string>();
  const candidates = chosen.map(
    (
      { form, draft: { element: _element, label, placeholder, description, ...rest }, target },
      at,
    ) => {
      const shownLabel = label && hide(label);
      const shownDescription = description && hide(description);
      const shownPlaceholder = placeholder && hide(placeholder);
      return {
        id: `c${at + 1}`,
        ...rest,
        ...(shownLabel ? { label: shownLabel } : {}),
        ...(shownPlaceholder ? { placeholder: shownPlaceholder } : {}),
        // Still left out when it repeats the label once hidden.
        ...(shownDescription && shownDescription !== shownLabel
          ? { description: shownDescription }
          : {}),
        target,
        ...(form ? { group: groups.getOrInsertComputed(form, () => `f${groups.size + 1}`) } : {}),
      } satisfies ObservedCandidate;
    },
  );

  const pageTitle = uncutText(document.title);
  const title = pageTitle && hide(pageTitle);
  const headings = [
    ...new Set(
      queryAll(document, "h1, h2, h3").flatMap((heading) => {
        const text = visibleText(heading);
        const hidden = text && hide(text);
        return hidden ? [hidden] : [];
      }),
    ),
  ].slice(0, maxHeadings);
  // A split code's first input comes first in page order.
  const codeAt = near ? candidates.findIndex(isCodeField) : -1;
  const code = candidates[codeAt];
  const repeated = new Set([title, ...headings, code?.label, code?.placeholder, code?.description]);
  // A text that repeats one the page already carries, or with fewer than two letters
  // beside its placeholders, such as a timer or one typed character in a box of its own,
  // says nothing about the code or the button.
  const keepNear = (raw: string) => {
    const text = hide(raw);
    return text !== undefined &&
      !repeated.has(text) &&
      (text.replace(/\[(?:email|masked|number)\]/gu, "").match(/\p{L}/gu)?.length ?? 0) >= 2
      ? text
      : undefined;
  };
  const nearCode = code === undefined ? [] : nearCodeTexts(chosen[codeAt]!.draft.element, keepNear);
  // A page without a code field carries the texts near its buttons instead.
  const buttons =
    near && code === undefined ? chosen.filter((_, at) => candidates[at]!.role === "button") : [];
  for (const button of buttons) {
    const candidate = candidates[chosen.indexOf(button)]!;
    if (candidate.label) repeated.add(candidate.label);
  }
  const nearButtons = buttons.length
    ? nearButtonTexts(
        buttons.map((button) => button.draft.element),
        keepNear,
      )
    : [];
  const texts = [
    title ?? "",
    ...headings,
    ...nearCode,
    ...nearButtons,
    ...candidates.flatMap((candidate) => [
      candidate.label ?? "",
      candidate.placeholder ?? "",
      candidate.description ?? "",
    ]),
    ...(accounts ?? []),
  ];
  const parsed = v.safeParse(loginObservationSchema, {
    version: 1,
    origin: location.origin,
    path,
    language: language(texts),
    ...(title ? { title } : {}),
    ...(headings.length ? { headings } : {}),
    ...(header ? { headerText: header } : {}),
    ...(nearCode.length ? { nearCode } : {}),
    ...(nearButtons.length ? { nearButtons } : {}),
    complete,
    candidates,
    ...(accounts?.length ? { accounts } : {}),
  });
  return parsed.success
    ? { ok: true, observation: parsed.output }
    : { ok: false, reason: "unsupported-page" };
}

const maxAccounts = 8;
const atSign = /[@＠]/u;
const maxListControls = 8;
/** Elements examined for list controls; a list page is small. */
const listScanLimit = 4000;

/**
 * The observation of a page without fields that lists accounts to choose from (ADR 0028),
 * such as a saved-profile list: each entry's redacted text (`Taro [email] Last used`) and
 * the other controls outside page chrome, by their text, as context and as the
 * account-independent button the generator may name. An email shown beside at most three
 * separate buttons, as on Wise's "Welcome back" card, counts as a listed account too. A
 * page showing a fillable field, or no email address in an entry or beside buttons, is
 * refused: {@link extractLoginObservation} covers the
 * former, and the latter is no list of accounts. An incomplete result names its first
 * cause as `gap` (`ObservationGap`), for the log only.
 */
export function extractAccountListObservation(
  document: Document = globalThis.document,
  names: readonly string[] = [],
): ObservationResult {
  return readingPage(() => readAccountList(document, names));
}

function readAccountList(document: Document, names: readonly string[]): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };
  const fieldShown = queryAll(document, fields).some((element) => {
    const found = describe(element);
    return found?.kind === "candidate" && fillTypes[found.draft.role] !== undefined;
  });
  if (fieldShown || !document.body) return { ok: false, reason: "no-candidates" };
  const entries = accountEntries(document);
  // An account shown beside separate buttons, as on Wise's "Welcome back" card.
  const listed = [
    ...entries.map((entry) => entry.element),
    // An entry that the beside text holds, or that holds it, is listed once, as the entry.
    ...besideEmails(document)
      .map((account) => account.element)
      .filter(
        (element) =>
          !entries.some(
            (entry) =>
              containsAcross(entry.element, element) || containsAcross(element, entry.element),
          ),
      ),
  ];
  // A shown text that equals a matching item's username that is not an email (ADR 0028),
  // and the other texts beside buttons, which may name accounts not in the vault.
  const beside = names.length ? namedAccounts(document, names) : { named: [], others: [] };
  const named = beside.named.filter(
    (element) =>
      !listed.some((other) => containsAcross(other, element) || containsAcross(element, other)),
  );
  listed.push(...named);
  if (listed.length === 0) return { ok: false, reason: "no-candidates" };
  // A text in which an address survived redaction is left out, never sent; a name is sent
  // only as `[account]`.
  const sent = listed
    .slice(0, maxAccounts)
    .map((element) => ({
      element,
      text: named.includes(element)
        ? "[account]"
        : observedText(renderedText(element, rawLimit, { everyElement: true })),
    }))
    .filter(
      (account): account is { element: HTMLElement; text: string } =>
        account.text !== undefined && !atSign.test(account.text),
    );
  const accounts = sent.map((account) => account.text);
  // Only an entry is clicked for its account; one beside buttons needs a list button.
  const clickable = sent.filter((account) =>
    entries.some((entry) => entry.element === account.element),
  ).length;
  // The first gap is reported, in this order; any gap makes the observation incomplete.
  let gap: ObservationGap | undefined =
    listed.length > maxAccounts
      ? "too-many-accounts"
      : accounts.length !== listed.length
        ? "unlisted-accounts"
        : undefined;

  // The innermost list controls that are not entries, by their whole text, which must
  // survive redaction and name one control only.
  const inEntry = (element: Element) =>
    [...entries.map((entry) => entry.element), ...named].some(
      (entry) => containsAcross(entry, element) || containsAcross(element, entry),
    );
  const scanned = queryAll(document.body, "*");
  if (scanned.length > listScanLimit) gap ??= "too-many-elements";
  const listControls = scanned.slice(0, listScanLimit).filter(
    (element): element is HTMLElement =>
      entryLike(element) &&
      // The page's footer links, as Instagram's 16 on 2026-10-13, are chrome too.
      !inPageChrome(element) &&
      !inEntry(element),
  );
  // A control holding another one is not innermost; marking ancestors keeps this linear.
  const outer = new Set<Element>();
  for (const element of listControls) {
    let parent = composedParent(element);
    while (parent && !outer.has(parent)) {
      outer.add(parent);
      parent = composedParent(parent);
    }
  }
  const innermost = listControls.filter((element) => !outer.has(element));
  const texts = innermost.map((element) => {
    const raw = collapseText(renderedText(element, rawLimit) ?? "");
    return raw && observedText(raw) === raw && !atSign.test(raw) ? raw : undefined;
  });
  const chosen: Chosen[] = innermost.flatMap((element, at) => {
    const text = texts[at];
    if (text === undefined || texts.filter((other) => other === text).length !== 1) return [];
    const target = { by: "text" as const, value: text };
    if (!v.is(loginTargetSchema, target)) return [];
    return [{ form: null, draft: { element, role: "button", label: text }, target }];
  });
  // A passkey button beside the list that no text names, as one showing an icon only, is
  // sent by its own locator, so the answer may name it for the chooser (ADR 0079).
  const passkeys = passkeyButtons(document, describeAll(document)).filter(
    (button) =>
      !inEntry(button.draft.element) &&
      !chosen.some(
        (control) =>
          containsAcross(control.draft.element, button.draft.element) ||
          containsAcross(button.draft.element, control.draft.element),
      ),
  );
  chosen.push(...passkeys);
  if (chosen.length > maxListControls) gap ??= "too-many-controls";
  const described = observe(
    document,
    chosen.slice(0, maxListControls),
    gap === undefined,
    undefined,
    accounts,
  );
  const result = withGap(
    described.ok && described.observation.accounts
      ? { ok: true, observation: { ...described.observation, accountEntries: clickable } }
      : described,
    gap,
  );
  if (!result.ok || !names.length) return result;
  const hidden = beside.others.map((element) =>
    collapseText(renderedText(element, rawLimit) ?? ""),
  );
  return withGap(withoutNames(result.observation, names, hidden, location.pathname), gap);
}

/** The page texts of a candidate, apart from its ID, role and locator kind, one per line. */
function textsOf(value: unknown, key = ""): string {
  if (typeof value === "string") return ["id", "role", "by"].includes(key) ? "" : value;
  if (Array.isArray(value)) return value.map((entry) => textsOf(entry)).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([name, entry]) => textsOf(entry, name))
      .join("\n");
  return "";
}
/**
 * The observation of a list shown by names (ADR 0028) with no name in it: `names`, the
 * texts that name a matching item's username, become `[account]` wherever they show as a
 * whole word, with or without a leading `@` and in any width or case, and a candidate
 * whose text holds one is left out; a text that is wholly one of `hidden`, the other
 * texts beside buttons, which may name accounts not in the vault, becomes `[account]`,
 * and a candidate with such a text is left out. A page whose `path`, read as it is before
 * its token-like segments are replaced (ADR 0039), holds a name is not sent.
 */
function withoutNames(
  observation: LoginObservation,
  names: readonly string[],
  hidden: readonly string[],
  path: string,
): ObservationResult {
  // The texts that name a username show at least one name, so the pattern is never empty.
  const source = namePattern(names) ?? "(?!)";
  const holds = new RegExp(source, "iu");
  const pattern = new RegExp(source, "giu");
  const others = new Set(hidden.map(foldName).filter(Boolean));
  const shows = (text: string) => holds.test(text.normalize("NFKC"));
  const whole = (text: string) => others.has(foldName(text));
  if (shows(decodeURIComponentSafe(path)) || shows(decodeURIComponentSafe(observation.path)))
    return { ok: false, reason: "unsupported-page" };
  const kept = {
    ...observation,
    candidates: observation.candidates.filter((candidate) => {
      const text = textsOf(candidate);
      return !shows(text) && !text.split("\n").some(whole);
    }),
  };
  const hide = (text: string) => {
    if (whole(text)) return "[account]";
    const normal = text.normalize("NFKC");
    return holds.test(normal) ? normal.replace(pattern, "[account]") : text;
  };
  const replaced: unknown = JSON.parse(JSON.stringify(kept), (key, value: unknown) =>
    typeof value === "string" && !["origin", "path", "language", "id", "role", "by"].includes(key)
      ? hide(value)
      : value,
  );
  const parsed = v.safeParse(loginObservationSchema, replaced);
  return parsed.success
    ? { ok: true, observation: parsed.output }
    : { ok: false, reason: "unsupported-page" };
}
/** A path as it reads, or as it is when it does not decode. */
function decodeURIComponentSafe(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Whether a control is enabled, also through a disabled fieldset or an ARIA mark. */
const enabled = (element: HTMLElement) =>
  !element.matches(":disabled") && closestAcross(element, "[aria-disabled='true' i]") === null;

/**
 * The observation of a page without a login form that a site sent the visitor to before
 * signing in (ADR 0031), such as a top page with `?return_to=...`: its shown, enabled
 * buttons and links that render text of their own, outside every form with a field (a
 * search or newsletter form), as candidates the generator may name as the page's sign-in
 * entry. Those in the page header or navigation come first, then the rest in document
 * order, up to the observation's 48 candidates; the rest are left out without making the
 * observation incomplete, since one control is all such a page needs. Fields are never
 * described, so the page is sent without slots.
 *
 * A link is left out unless it could be pressed: its parsed `href` must be `https:` (or
 * `http:` on an `http:` page) on the page's site (`onSite`, the worker's answer for the hosts `entryHosts` lists), no query
 * key or value of it may lead to another site, it must lead to another page than this one
 * (not only another fragment), and it opens in the same tab without downloading. So a
 * sign-in through another site never reaches the model. Labels are redacted as in every
 * observation; neither the page's query nor any `href` is described. The path and the
 * locators follow `extractLoginObservation`'s token rule (ADR 0039).
 */
export function extractEntryObservation(
  document: Document = globalThis.document,
  onSite: OnSite = () => false,
): ObservationResult {
  return readingPage(() => readEntry(document, onSite));
}

function readEntry(document: Document, onSite: OnSite): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };
  const tokens = redactsPath(location.pathname);
  const page = new URL(location.href);
  const index = locatorIndex(document);
  const shownControls = describeAll(document).flatMap((entry) => {
    if (entry.kind !== "candidate") return [];
    const { element, role } = entry.draft;
    if ((role !== "button" && role !== "link") || !enabled(element)) return [];
    if (!renderedControlText(element)) return [];
    // A form with a field holds its own controls, such as a search box's button.
    const form = entry.form ?? closestAcross(element, "form");
    if (form && queryAll(form, fields).length > 0) return [];
    if (role === "link") {
      const href = element instanceof HTMLAnchorElement ? linkUrl(element) : undefined;
      if (!href || linkRefusal(href, onSite, page) || entryElementRefusal(element)) return [];
    }
    // The chosen entry is stored like a marker, so an ID another load may change never names it.
    const target = locate(element, index, { tokens, links: true, lasting: true });
    return target ? [{ form: entry.form, draft: entry.draft, target }] : [];
  });
  const chosen = byLandmark(shownControls).slice(0, maxCandidates);
  if (chosen.length === 0) return { ok: false, reason: "no-candidates" };
  return observe(document, chosen, true);
}

/** Where an opened account menu holds its items, besides a modal dialog; a closed one shows none. */

/**
 * A logout click's locator for a control of a signed-in page (ADR 0063): its lasting
 * `id`, `name` or `test-id`, or its text when that names it alone, as a login step's;
 * else, for a control with no text of its own or a menu item, its `aria-label` or `title`
 * when that names it alone. A text or name that holds a number or an `@` is never one, as
 * it may be the account's.
 */
function logoutLocator(
  element: HTMLElement,
  index: LocatorIndex,
  tokens: boolean,
): LoginMarkerTarget | undefined {
  const document = element.ownerDocument;
  const personal = (value: string) => /[\p{Number}@]/u.test(value);
  const only = (target: LoginMarkerTarget) => {
    const found = findLogoutTargets(document, target);
    return found.length === 1 && found[0] === element;
  };
  if (!isMenuItem(element)) {
    const target = locate(element, index, {
      tokens,
      links: true,
      lasting: true,
      redactAttributes: true,
    });
    if (target && !(target.by === "text" && personal(target.value))) return target;
  } else {
    const text = menuItemText(element);
    const target = text && !personal(text) ? { by: "text" as const, value: text } : undefined;
    if (target && only(target)) return target;
  }
  const name = logoutControlName(element);
  if (!name || personal(name)) return undefined;
  const target = { by: "accessible-name" as const, value: name };
  return only(target) ? target : undefined;
}

/**
 * A signed-in page for an account switch's logout (ADR 0063): its shown, enabled buttons,
 * links and menu items outside a form with a field to fill, never a link that opens a new
 * window or downloads, each by {@link logoutLocator}. Only those that may lead to the
 * logout are described: those of an open dialog first, then those of an open menu, then
 * the page's header, navigation and account areas, and elsewhere only a control whose
 * name says it logs out, so a page with more than 48 still shows them. The page's title
 * and the controls' labels are its only texts: no headings, descriptions or nearby texts,
 * as a signed-in page shows the person's own content. Texts lose their numbers, as a count
 * or an account number, and are redacted as a login page's are.
 */
export function extractLogoutObservation(
  document: Document = globalThis.document,
): ObservationResult {
  return readingPage(() => readLogout(document));
}

function readLogout(document: Document): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };
  const tokens = redactsPath(location.pathname);
  const index = locatorIndex(document);
  const inFieldForm = (element: Element, form?: HTMLFormElement | null) =>
    Boolean((form ?? closestAcross(element, "form"))?.querySelector(fields));
  const described = describeAll(document).flatMap((entry) => {
    if (entry.kind !== "candidate") return [];
    const { element, role } = entry.draft;
    if ((role !== "button" && role !== "link") || !enabled(element)) return [];
    // A form with a field holds its own controls, such as a search box's button.
    if (inFieldForm(element, entry.form)) return [];
    if (role === "link") {
      const refusal = entryElementRefusal(element);
      if (refusal === "new-window" || refusal === "download") return [];
    }
    const target = logoutLocator(element, index, tokens);
    if (!target) return [];
    const label = entry.draft.label ?? logoutControlName(element);
    // A link named only by its aria-label or title is described as the button it is
    // pressed as: an observation names only buttons by accessible name.
    const draft = {
      ...entry.draft,
      ...(target.by === "accessible-name" ? { role: "button" as const } : {}),
      ...(label ? { label } : {}),
    };
    return [{ form: entry.form, draft, target }];
  });
  // A menu item that is no button or link, as `<li role="menuitem">Sign out</li>`.
  const items = queryAll(document, "[role]").flatMap((element) => {
    if (
      !isMenuItem(element) ||
      element.getAttribute("aria-disabled")?.trim().toLowerCase() === "true" ||
      inFieldForm(element)
    )
      return [];
    const label = menuItemText(element) ?? logoutControlName(element);
    const target = label === undefined ? undefined : logoutLocator(element, index, tokens);
    if (!target || !label) return [];
    return [
      {
        form: closestAcross(element, "form") as HTMLFormElement | null,
        draft: { element, role: "button" as const, label },
        target,
      },
    ];
  });
  const shownControls = [
    ...described,
    ...items.filter(
      (item) => !described.some((entry) => entry.draft.element === item.draft.element),
    ),
  ];
  const modals = openModals(document);
  const rank = (element: Element) =>
    modals.some((modal) => containsAcross(modal, element))
      ? 3
      : closestAcross(element, openMenus)
        ? 2
        : closestAcross(element, landmarks) || closestAcross(element, accountAreas)
          ? 1
          : 0;
  // A stable sort keeps document order within each rank.
  const chosen = shownControls
    .map((entry) => ({ entry, rank: rank(entry.draft.element) }))
    .filter(
      ({ entry, rank: at }) =>
        at > 0 || (entry.draft.label !== undefined && logoutName(entry.draft.label) !== undefined),
    )
    .sort((left, right) => right.rank - left.rank)
    .map(({ entry: { draft, ...entry } }): Chosen => {
      // A control's description may quote the page's content; its label names it.
      const { description: _description, placeholder: _placeholder, ...named }: Draft = draft;
      return { ...entry, draft: named };
    })
    .slice(0, maxCandidates);
  if (chosen.length === 0) return { ok: false, reason: "no-candidates" };
  const result = observe(document, chosen, true, (text) => withoutNumbers(text));
  if (!result.ok) return result;
  // The page's headings are its content, never needed to find its logout.
  const { headings: _headings, ...observation } = result.observation;
  return { ...result, observation };
}

/**
 * The one control of a signed-in page that says it logs out of this site
 * ({@link localLogoutControl}), with its {@link logoutLocator}: the account switch clicks
 * it without asking the model (ADR 0063, owner 2026-10-23). `ambiguous` when several say
 * so, and `unlocated` when it has no locator a recipe could keep. A link that opens a new
 * window or downloads, or whose `href` leads off the site (`onSite`, as for an entry link,
 * by scheme, host and query), is `none`: its click would show another site's page, never
 * this site signed out.
 */
export function extractLocalLogout(
  document: Document = globalThis.document,
  onSite: OnSite = () => false,
):
  | { ok: true; target: LoginMarkerTarget }
  | { ok: false; reason: "none" | "ambiguous" | "unlocated" } {
  const location = document.location;
  if (!location) return { ok: false, reason: "none" };
  const control = localLogoutControl(document);
  if (typeof control === "string") return { ok: false, reason: control };
  if (!enabled(control) || closestAcross(control, "form")?.querySelector(fields))
    return { ok: false, reason: "none" };
  const refusal = entryElementRefusal(control);
  if (refusal === "new-window" || refusal === "download") return { ok: false, reason: "none" };
  // A link that follows its `href`; a script link or `href="#"` stays on the page.
  if (refusal !== "not-link" && refusal !== "script-link" && control instanceof HTMLAnchorElement) {
    const href = linkUrl(control);
    const leads = href && linkRefusal(href, onSite, new URL(location.href));
    if (!href || (leads && leads !== "link-same-page")) return { ok: false, reason: "none" };
  }
  const target = logoutLocator(control, locatorIndex(document), redactsPath(location.pathname));
  return target ? { ok: true, target } : { ok: false, reason: "unlocated" };
}

/** A button-only passkey start, using the same bounded, value-free observation as login. */
export function extractPasskeyObservation(
  document: Document = globalThis.document,
): ObservationResult {
  return readingPage(() => readPasskey(document));
}

function readPasskey(document: Document): ObservationResult {
  if (!document.location) return { ok: false, reason: "unsupported-page" };
  const found = describeAll(document);
  // Any fillable or unsupported field, shadow trees' included, prevents a button-only start.
  if (
    found.some((entry) =>
      entry.kind === "unsupported" ? entry.field !== undefined : fillTypes[entry.draft.role],
    )
  )
    return { ok: false, reason: "no-candidates" };
  const buttons = passkeyButtons(document, found);
  if (!buttons.length || buttons.length > maxCandidates)
    return { ok: false, reason: "no-candidates" };
  return observe(document, buttons, true);
}

/**
 * The enabled buttons among `found` whose label or lasting locator names a passkey or
 * security key and not its registration (ADR 0053).
 */
function passkeyButtons(
  document: Document,
  found: readonly ReturnType<typeof describeAll>[number][],
): Chosen[] {
  const tokens = redactsPath(document.location.pathname);
  const index = locatorIndex(document);
  return found.flatMap((entry) => {
    if (
      entry.kind !== "candidate" ||
      entry.draft.role !== "button" ||
      !enabled(entry.draft.element)
    )
      return [];
    const target = locate(entry.draft.element, index, { tokens, lasting: true });
    if (!target) return [];
    const button = { target, label: entry.draft.label };
    if (!namesPasskey(button) || registersPasskey(button)) return [];
    return [{ form: entry.form, draft: entry.draft, target }];
  });
}

/**
 * Controls in a page header or navigation first, then those inside one of `modals`, then
 * the rest of the page, such as carousels, ads and news tabs, each in document order: on
 * a signed-in page they may show the account, and on a page without a login form they
 * hold its sign-in entry (ADR 0031). An open modal's few controls, read on a signed-in
 * page, come before the page behind it, so the judge still sees the modal on a long
 * page. The rank reads only the page's structure, never words of one language. `observe`
 * lists the controls kept in document order again.
 */
function byLandmark<Entry extends { draft: Draft }>(
  entries: readonly Entry[],
  modals: readonly Element[] = [],
): Entry[] {
  const rank = (element: Element) =>
    closestAcross(element, landmarks)
      ? 2
      : modals.some((modal) => containsAcross(modal, element))
        ? 1
        : 0;
  // A stable sort keeps document order within each rank.
  return entries
    .map((entry) => ({ entry, rank: rank(entry.draft.element) }))
    .sort((left, right) => right.rank - left.rank)
    .map(({ entry }) => entry);
}

/**
 * Whether a field the executor cannot fill may still be a sign-in field: a password or an
 * email field, one marked for a username, an email, a password or a one-time code, or a
 * short numeric field as a code goes in (the executor's rule). Read-only password fields
 * are common with software keyboards.
 */
function mayBeSignIn(input: HTMLInputElement): boolean {
  const hint = autocomplete(input);
  return (
    input.type === "password" ||
    input.type === "email" ||
    (hint !== undefined && hint !== "off") ||
    shortNumericInput(input)
  );
}

/**
 * Builds the observation of the page shown after a generated recipe's final submission,
 * which the service judges for a signed-in marker (ADR 0018). It reads the same
 * value-free details as `extractLoginObservation`, but from the whole page: every field,
 * then buttons and links up to the candidate limit, those in the page header or
 * navigation first (`byLandmark`), listed in document order.
 *
 * The judge refuses a page that still shows a sign-in field, so every field that may be
 * one must be described: more fields than the limit mark the observation incomplete,
 * and so does a field that may be a sign-in field
 * (`mayBeSignIn`) but cannot be located or filled. A field that may not, such as a search
 * box with no ID, a password change form's field or a hotel search's read-only date
 * picker, is left out (owner, 2026-10-12, ADR 0029). A disabled one is left out too, but
 * the result says so (`disabledLeftOut`): it may be a code field waiting for a timer or a
 * sent code, so such a page completes only when the judge answers `signed-in`. Up to
 * twelve shown single-choice selects follow the fields as `select`, by their label and
 * `autocomplete` and never their options, located by a lasting attribute or left out, so
 * the judge can name a split birth date's or card expiry date's parts (ADR 0061). A radio
 * button or text area, or an ARIA widget for one, is left out as well, and the result
 * says when the page shows one, or any select, that is no part of a site search
 * (`inputLeftOut`, `leftOutInputs`): an `optional` answer does not complete such a page
 * (ADR 0065). Buttons
 * and links are only possible markers; those past the limit or without a locator are
 * left out, and an ID another load may change (`changingId`) locates no element but a
 * field that may be a sign-in field. A link is located by its text too, as for an
 * account switch, and the executor looks for the completion marker the same way. A button
 * that nothing else names alone, or a link to a fragment of the page, that may go on to
 * the password is located by its accessible name (`passwordChoiceTarget`), such a link as a
 * `button`, so the judge can name it as a `password` handler's button (ADR 0048
 * amendment of 2026-10-19); no other page's description uses that locator. A path
 * segment that may carry a token is sent as `REDACTED_PATH_SEGMENT` (`observedPath`). A
 * page with a code field also carries up to three texts near the first one
 * (`nearCodeTexts`), and a page without one up to three texts near its buttons
 * (`nearButtonTexts`), hidden as the rest of the page. While a modal dialog is open, the
 * page behind it that the modal's script marked `aria-hidden` or `inert` is read as
 * shown (`readBehindModal`), and the modal's controls rank right after the header's.
 */
export function extractSignedInObservation(
  document: Document = globalThis.document,
): ObservationResult {
  return readingPage(() => readBehindModal(document, () => describeSignedIn(document)));
}

function describeSignedIn(document: Document): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };

  const found = describeAll(document);
  // One gap is reported; any gap makes it incomplete.
  let gap: ObservationGap | undefined;
  let disabledLeftOut = false;
  const inputLeftOut = leftOutInputs(document);
  const fieldEntries: { form: HTMLFormElement | null; draft: Draft }[] = [];
  const markers: { form: HTMLFormElement | null; draft: Draft }[] = [];
  for (const entry of found) {
    if (entry.kind === "unsupported") {
      // A disabled field may be a code field waiting for a timer or a sent code: one that
      // may not be a sign-in field is left out, but only `signed-in` completes the page.
      if (entry.field && mayBeSignIn(entry.field)) gap ??= "unfillable-field";
      else if (entry.field?.disabled) disabledLeftOut = true;
    } else if (fillTypes[entry.draft.role]) fieldEntries.push(entry);
    else if (entry.draft.role !== "checkbox") markers.push(entry);
  }
  const index = locatorIndex(document);
  const header = headerText(document);
  const headerWords = shownWords(header);
  // A marker's locator is stored and must match every later sign-in, so text with a
  // number character, such as a balance or an unread count, never names one, nor does
  // an ID another load may change. A field that may be a sign-in field keeps such an
  // ID, as on a login page, rather than leave the page incomplete, and is located by its
  // visible name before it (ADR 0037), as a recipe's fill and a `totp` handler's code
  // field name it; a name with a number, which this page's text never shows, is not used
  // unless it numbers an input of a split code (`numbersCodeDigit`).
  const located = (entries: typeof fieldEntries) =>
    entries.flatMap((entry) => {
      const { element } = entry.draft;
      const signIn =
        element instanceof HTMLInputElement && fillTypes[element.type] && mayBeSignIn(element);
      const target = locate(element, index, {
        redactAttributes: true,
        links: true,
        lasting: !signIn,
        labels: signIn,
        hidden: !signIn,
        paths: headerWords,
      });
      return target && !(target.by === "text" && /\p{Number}/u.test(target.value))
        ? [{ ...entry, target }]
        : [];
    });
  const fieldsFound = located(fieldEntries);
  // A select is no sign-in field: one without a lasting locator, or past the limit, is
  // left out (ADR 0061).
  const selectsFound = located(describeSelects(document)).slice(0, maxSelects);
  if (fieldsFound.length > maxCandidates) gap ??= "too-many-fields";
  // A field nothing can locate is left out unless it may be a sign-in field, as a search
  // box with no ID or a password change form's fields are not (S2 of ADR 0029: a new
  // password, or a form with two or more password fields; fields outside a form count as
  // one form).
  else if (
    fieldEntries.some(
      ({ form, draft: { element } }) =>
        element instanceof HTMLInputElement &&
        mayBeSignIn(element) &&
        !(
          element.type === "password" &&
          (autocompleteTokens(element).includes("new-password") ||
            fieldEntries.filter(
              (other) =>
                other.form === form &&
                other.draft.element instanceof HTMLInputElement &&
                other.draft.element.type === "password",
            ).length >= 2)
        ) &&
        !fieldsFound.some((kept) => kept.draft.element === element),
    )
  )
    gap ??= "unlocated-field";
  // A button or link that may go on to the password is located by its accessible name when
  // nothing else names it alone, and a link to a fragment of the page by that name first,
  // as a button, since only that locator counts it as one (ADR 0048 amendment of
  // 2026-10-19).
  const markersFound = markers.flatMap((entry) => {
    const { element } = entry.draft;
    const named = () => passwordChoiceTarget(element, index);
    const fragment = isFragmentButton(element);
    const target = fragment
      ? (named() ?? located([entry])[0]?.target)
      : (located([entry])[0]?.target ?? named());
    if (!target) return [];
    return [
      {
        ...entry,
        draft:
          target.by === "accessible-name"
            ? { ...entry.draft, role: "button" as const }
            : entry.draft,
        target,
      },
    ];
  });
  const ranked = byLandmark(markersFound, openModals(document));
  const fieldsShown = [...fieldsFound, ...selectsFound].slice(0, maxCandidates);
  const chosen = [
    ...fieldsShown,
    ...ranked.slice(0, Math.max(0, maxCandidates - fieldsShown.length)),
  ];
  if (chosen.length === 0) return { ok: false, reason: "no-candidates" };
  const result = observe(
    document,
    chosen,
    gap === undefined,
    (text) => withoutNumbers(text),
    undefined,
    header,
    observedPath(location.pathname),
    true,
  );
  if (!result.ok) return result;
  return {
    ...result,
    ...(gap ? { gap } : {}),
    ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
    ...(inputLeftOut ? { inputLeftOut: true as const } : {}),
  };
}
