import type { LoginTarget } from "@pateat/contracts";
import { fits, shownAccounts } from "./accounts";
import { findTargets } from "./targets";
import { collapseText, isButton, isScriptButton, renderedText, shown } from "./text";

/** Roles that make an element a list entry (ADR 0028). */
const entryRoles = new Set(["button", "link", "option", "menuitem", "radio"]);
/** Page chrome: an account menu there is a signed-in page's, not a list of accounts. */
export const chromeSelector = "header, nav, [role='banner' i], [role='navigation' i]";
/** What scopes a `footer` to its section, so it is no page footer (HTML-AAM), or a dialog. */
const footerScope =
  "article, aside, main, nav, section, dialog, [role='main' i], [role='article' i], " +
  "[role='region' i], [role='complementary' i], [role='navigation' i], [role='dialog' i]";

/**
 * Whether `element` is in page chrome: the header, navigation or page footer. The page
 * footer is a `contentinfo` landmark, or a `footer` without a role outside article,
 * aside, main, nav, section, their roles or a dialog, which HTML maps to one. A card's
 * own footer inside a section, or a main region inside a footer, is not chrome.
 */
export function inPageChrome(element: Element): boolean {
  if (element.closest(chromeSelector)) return true;
  const main = element.closest("main, [role='main' i]");
  const holds = (footer: Element | null): footer is Element =>
    footer !== null && !(main && footer.contains(main));
  if (holds(element.closest("[role='contentinfo' i]"))) return true;
  const footer = element.closest("footer");
  return (
    holds(footer) &&
    !footer.getAttribute("role")?.trim() &&
    !footer.parentElement?.closest(footerScope)
  );
}
const entryTextLimit = 300;
/** At most this many email-bearing texts are examined; a list holds a handful. */
const textNodeLimit = 200;

function disabled(element: HTMLElement): boolean {
  // `:disabled` also covers a button inside a disabled `<fieldset>`.
  return (
    element.matches(":disabled") || element.closest("[aria-disabled='true' i], [inert]") !== null
  );
}

function entryRole(element: Element): boolean {
  const role = element.getAttribute("role")?.trim().toLowerCase();
  return role !== undefined && entryRoles.has(role);
}

/** A link, button or entry role: a control whose own click is what clicking inside it does. */
function control(element: HTMLElement): boolean {
  return element instanceof HTMLAnchorElement || isButton(element) || entryRole(element);
}

/** Whether `element` is the one that sets `cursor: pointer`, not one that inherits it. */
export function setsPointer(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view || view.getComputedStyle(element).cursor !== "pointer") return false;
  // `cursor` is inherited: only the element that sets it counts, not its descendants.
  const parent = element.parentElement;
  return !parent || view.getComputedStyle(parent).cursor !== "pointer";
}

/**
 * Whether `element` can be clicked as an entry of an account list, whatever its element
 * type (ADR 0028): a native button, an `<a>` whose `href` (if any) stays on the page's
 * origin or runs a script, an element with an entry role or `tabindex` 0 or more, or the
 * element that sets `cursor: pointer`. The executor's own click steps stay narrower.
 */
export function entryLike(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !shown(element) || disabled(element)) return false;
  if (isButton(element)) return true;
  if (element instanceof HTMLAnchorElement) {
    if (!element.hasAttribute("href") || isScriptButton(element)) return true;
    return element.origin === element.ownerDocument.location.origin;
  }
  if (entryRole(element)) return true;
  if (element.hasAttribute("tabindex") && element.tabIndex >= 0) return true;
  return setsPointer(element);
}

const isEntry = (element: Element): boolean => entryLike(element);

/**
 * The innermost {@link entryLike} element around `element`, or `null` when a link, button
 * or entry role anywhere around the text is rejected: a click inside it would land on
 * that control, such as a link to another origin or a disabled button.
 */
function entryAround(element: HTMLElement | null): HTMLElement | null {
  let entry: HTMLElement | null = null;
  for (let current = element; current; current = current.parentElement) {
    // Not the type guard: it would narrow `current` to `never` after it.
    if (isEntry(current)) entry ??= current;
    else if (control(current)) return null;
  }
  return entry;
}

export interface AccountEntry {
  readonly element: HTMLElement;
  /** Email addresses, masked or not, in the entry's rendered text. */
  readonly accounts: readonly string[];
}

/**
 * The entries of `root` that show an email address: for every shown text holding an
 * `@`, the innermost {@link entryLike} element around it. Entries inside page chrome
 * (`<header>`, `<nav>` and their roles) are left out, and an entry holding another entry
 * counts as the inner one (ADR 0028).
 */
export function accountEntries(root: Document | Element): AccountEntry[] {
  const document = root instanceof Document ? root : root.ownerDocument;
  const start = root instanceof Document ? root.body : root;
  if (!start) return [];
  const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.nodeValue ?? "").includes("@") || (node.nodeValue ?? "").includes("＠")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  const found = new Map<HTMLElement, AccountEntry>();
  for (let index = 0; index < textNodeLimit; index += 1) {
    const node = walker.nextNode();
    if (!node) break;
    const element = entryAround(node.parentElement);
    if (!element || found.has(element) || element.closest(chromeSelector)) continue;
    const text = renderedText(element, entryTextLimit, { everyElement: true }) ?? "";
    const accounts = shownAccounts(text).filter((account) => account.includes("@"));
    if (accounts.length) found.set(element, { element, accounts });
  }
  const entries = [...found.values()];
  return entries.filter(
    (entry) => !entries.some((inner) => inner !== entry && entry.element.contains(inner.element)),
  );
}

/** Why a text with an `@` is not an entry of a list, for the log only (ADR 0028). */
export const entryMisses = [
  "aria-hidden",
  "inert",
  "hidden",
  "not-rendered",
  "page-chrome",
  "inside-control",
  "no-entry",
  "unread-text",
  "split-address",
] as const;
export type EntryMiss = (typeof entryMisses)[number];

/**
 * For a page on which {@link accountEntries} finds no entry: why its first shown text
 * holding an email address is not one; else why a hidden one is not; else
 * `split-address` when texts hold an `@` but no whole address, as when one is split
 * across elements. `undefined` when no text holds an `@`. Only the reason leaves the
 * page, never the text.
 */
export function accountEntryMiss(root: Document): EntryMiss | undefined {
  if (!root.body) return undefined;
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      /[@＠]/u.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  let split = false;
  let hidden: EntryMiss | undefined;
  for (let index = 0; index < textNodeLimit; index += 1) {
    const node = walker.nextNode();
    if (!node) break;
    const parent = node.parentElement;
    if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName)) continue;
    const accounts = shownAccounts(collapseText(node.nodeValue ?? ""));
    if (!accounts.some((account) => account.includes("@"))) {
      split = true;
      continue;
    }
    // A hidden address counts only when no shown one tells more.
    const unshown = parent.closest("[aria-hidden='true']")
      ? "aria-hidden"
      : parent.closest("[inert]")
        ? "inert"
        : parent.closest("[hidden]")
          ? "hidden"
          : !shown(parent)
            ? "not-rendered"
            : undefined;
    if (unshown) {
      hidden ??= unshown;
      continue;
    }
    if (parent.closest(chromeSelector)) return "page-chrome";
    let entry = false;
    for (let current: HTMLElement | null = parent; current; current = current.parentElement) {
      if (isEntry(current)) entry = true;
      else if (control(current)) return "inside-control";
    }
    // An entry whose rendered text did not show the address.
    return entry ? "unread-text" : "no-entry";
  }
  return hidden ?? (split ? "split-address" : undefined);
}

/** Splits an address at its last `@`, lowercased; `undefined` when it has none. */
function parts(address: string): { local: string; domain: string } | undefined {
  const folded = address.normalize("NFKC").trim().toLowerCase();
  const at = folded.lastIndexOf("@");
  if (at <= 0 || at === folded.length - 1) return undefined;
  return { local: folded.slice(0, at), domain: folded.slice(at + 1) };
}

/**
 * Whether the shown address may be chosen as `username`'s account (ADR 0028). Stricter
 * than the check before a password fill, which accepts any consistent masked address:
 * the domain must be unmasked and equal, and a masked local part needs at least 3 visible
 * characters and at least half of the username's local part, at matching positions.
 * Only email usernames are compared.
 */
export function chooses(shownAddress: string, username: string): boolean {
  const name = parts(username);
  const seen = parts(shownAddress.replace(/[●•]/gu, "*"));
  if (!name || !seen || name.local.includes("*") || seen.domain.includes("*")) return false;
  if (seen.domain !== name.domain) return false;
  if (!seen.local.includes("*")) return seen.local === name.local;
  const visible = seen.local.replace(/\*/gu, "").length;
  return visible >= 3 && visible * 2 >= name.local.length && fits(seen.local, name.local);
}

/**
 * The one entry that shows `username`'s account. A masked address that `others` (the
 * other matching vault items' usernames) would also choose is not used, and none is used
 * when `others` is not known to be complete (`masked: false`). `none` when no entry fits,
 * `ambiguous` when several do.
 */
export function pickEntry(
  entries: readonly AccountEntry[],
  username: string,
  others: readonly string[] = [],
  { masked = true }: { masked?: boolean } = {},
): { entry: AccountEntry } | { reason: "none" | "ambiguous" } {
  const fitting = entries.filter((entry) =>
    entry.accounts.some(
      (account) =>
        chooses(account, username) &&
        (!/[*●•]/u.test(account) || (masked && !others.some((other) => chooses(account, other)))),
    ),
  );
  if (fitting.length === 1) return { entry: fitting[0]! };
  return { reason: fitting.length ? "ambiguous" : "none" };
}

/** Page parts whose addresses are contact details, not a shown account (ADR 0028). */
const contactSelector = "footer, [role='contentinfo' i], a[href^='mailto:' i]";
const besideTextLimit = 64;
/** A container with more entry-like elements than this is page content, not one account. */
const maxBesideButtons = 3;
/** Elements examined for entry-like controls; a sign-in page is small. */
const scanLimit = 4000;

/** Whether `element` is in a link, button or entry-like element, accepted or not. */
function insideControl(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement)
    if (control(current) || isEntry(current)) return true;
  return false;
}

export interface BesideAccount {
  /** The element whose whole text is the shown account, such as Wise's masked email. */
  readonly element: HTMLElement;
  /** Its rendered text, at most 64 characters. */
  readonly text: string;
  /**
   * The entry-like elements beside it, none holding the text: at most 3 with text (see
   * {@link besideAccounts}) and any number without.
   */
  readonly buttons: readonly HTMLElement[];
}

/**
 * The innermost entry-like elements of `root`, outside page chrome ({@link inPageChrome})
 * unless `chrome` is set, at most a scan of 4000 elements.
 */
export function entryControls(
  root: Document | Element,
  { chrome = false }: { chrome?: boolean } = {},
): HTMLElement[] {
  const start = root instanceof Document ? root.body : root;
  if (!start) return [];
  const controls = [...start.querySelectorAll("*")]
    .slice(0, scanLimit)
    .filter(
      (element): element is HTMLElement =>
        entryLike(element) &&
        entryAround(element) === element &&
        (chrome || !inPageChrome(element)),
    );
  // A control holding another one is not innermost; marking ancestors keeps this linear.
  const outer = new Set<Element>();
  for (const item of controls) {
    let parent = item.parentElement;
    while (parent && !outer.has(parent)) {
      outer.add(parent);
      parent = parent.parentElement;
    }
  }
  return controls.filter((item) => !outer.has(item));
}

/** Elements whose text is never shown. */
const unshownText = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
/** Shown short texts examined, and text nodes walked, for {@link besideAccounts}. */
const besideScan = { shown: 400, walked: 5000 };

/**
 * The short texts shown beside separate buttons rather than inside them, as Wise's
 * "Welcome back" card shows the account above "Log back in" (ADR 0028, owner
 * 2026-10-12 08:36 UTC): each shown element of at most 64 characters, outside page
 * chrome and contact details and outside every entry-like element, whose nearest
 * ancestor holding an entry-like element with text holds at most 3 of those, page
 * chrome's included. A control without text, such as a settings gear beside Instagram's
 * saved profile (2026-10-13), is neither counted nor sought. The buttons returned are
 * every entry-like element in that ancestor outside page chrome.
 */
export function besideAccounts(root: Document | Element): BesideAccount[] {
  const document = root instanceof Document ? root : root.ownerDocument;
  const start = root instanceof Document ? root.body : root;
  if (!start) return [];
  const controls = entryControls(root, { chrome: true });
  if (controls.length === 0) return [];
  // How many controls with text each ancestor holds, counted up to one past the limit.
  const held = new Map<Element, number>();
  const worded = controls.filter(namedByText);
  for (const item of worded)
    for (let parent = item.parentElement; parent; parent = parent.parentElement)
      held.set(parent, Math.min((held.get(parent) ?? 0) + 1, maxBesideButtons + 1));
  const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.nodeValue ?? "").trim() && !unshownText.has(node.parentElement?.tagName ?? "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  const found = new Map<HTMLElement, BesideAccount>();
  let examined = 0;
  for (let walked = 0; walked < besideScan.walked; walked += 1) {
    const node = walker.nextNode();
    if (!node || examined >= besideScan.shown) break;
    const element = node.parentElement;
    if (!element || found.has(element) || !shown(element)) continue;
    examined += 1;
    if (element.closest(`${chromeSelector}, ${contactSelector}`)) continue;
    // The text must be the element's own, not a control's or a contact link's inside it.
    if (insideControl(element) || element.querySelector(`a, button, [role], ${contactSelector}`))
      continue;
    const text = renderedText(element, besideTextLimit + 1)
      ?.replace(/\s+/gu, " ")
      .trim();
    if (!text || text.length > besideTextLimit) continue;
    let container = element.parentElement;
    while (container && container !== start.parentElement && !held.get(container))
      container = container.parentElement;
    const holder = container;
    if (!holder || !held.has(holder) || held.get(holder)! > maxBesideButtons) continue;
    const buttons = controls.filter((item) => holder.contains(item) && !inPageChrome(item));
    if (buttons.length) found.set(element, { element, text, buttons });
  }
  return [...found.values()];
}

/**
 * Whether a shown text is the account of a username that is not an email (ADR 0028):
 * the whole text equals it, ignoring case and a leading `@`. Masked text never is.
 */
export function namesUsername(text: string, username: string): boolean {
  const fold = (value: string) =>
    value
      .normalize("NFKC")
      .trim()
      .replace(/^[@＠]/u, "")
      .toLowerCase();
  const shownName = fold(text);
  const name = fold(username);
  return name.length > 0 && !/[*●•]/u.test(shownName) && !name.includes("@") && shownName === name;
}

/** The {@link besideAccounts} that show an email address, masked or not. */
export function besideEmails(root: Document | Element): BesideAccount[] {
  return besideAccounts(root).filter((account) =>
    shownAccounts(account.text).some((shownAccount) => shownAccount.includes("@")),
  );
}

/**
 * Whether a control shows words: rendered text, an input button's value or alt text, or
 * an image's alt text. An `aria-label` alone does not count, as an icon's does not.
 */
function namedByText(element: HTMLElement): boolean {
  if (listControlText(element) !== "") return true;
  if (element instanceof HTMLInputElement) return (element.value || element.alt).trim() !== "";
  return [...element.querySelectorAll("img")].some((image) => image.alt.trim() !== "");
}

/** Rendered text read from a list control, as the observation names it (ADR 0028). */
const controlTextLimit = 480;
/** The whitespace-collapsed rendered text of a list control, as its text locator names it. */
export function listControlText(element: HTMLElement): string {
  return collapseText(renderedText(element, controlTextLimit) ?? "");
}

/** A field a person fills, as opposed to a hidden input or a button. */
const filledFields =
  "input:not([type='hidden' i], [type='submit' i], [type='button' i], [type='image' i], [type='reset' i]), textarea, select";

/**
 * Whether a list's `other` or `continue` control may be clicked (ADR 0028): not when its
 * text holds an email address, a masked text or a run of four or more digits, which may
 * name an account, nor when it is inside a form with a shown field.
 */
function clickableListControl(element: HTMLElement): boolean {
  const text = listControlText(element);
  if (shownAccounts(text).some((shownAccount) => shownAccount.includes("@"))) return false;
  if (/[*●•]|\p{N}{4}/u.test(text)) return false;
  const form = element.closest("form");
  return (
    !form || ![...form.querySelectorAll<HTMLElement>(filledFields)].some((field) => shown(field))
  );
}

/**
 * The elements a chooser's `other` or `continue` locator names (ADR 0028): for a `text`
 * locator, the innermost entry-like elements outside page chrome whose whole text is its
 * value, as the observation named them; otherwise the locator's own elements that are
 * entry-like. A control that {@link clickableListControl} refuses is left out.
 */
export function listControls(document: Document, target: LoginTarget): HTMLElement[] {
  const found =
    target.by === "text"
      ? entryControls(document).filter((element) => listControlText(element) === target.value)
      : findTargets(document, target).filter((element) => entryLike(element));
  return found.filter(clickableListControl);
}

/**
 * Words of a control that signs in with another account than the one a list shows, as
 * "Use another profile" or "Switch accounts" (ADR 0028, owner 2026-10-12 19:11 UTC): one
 * word of each set, matched as whole words; Japanese parts match anywhere.
 */
const otherWords = new Set(["another", "other", "different", "switch"]);
const accountWords = new Set(["account", "accounts", "profile", "profiles", "user", "users"]);
const otherParts = ["別の", "他の", "ほかの", "切り替え", "切替"];
const accountParts = ["アカウント", "プロフィール", "ユーザー"];
/** A control naming another account is a short label, not a paragraph. */
const otherTextLimit = 64;

/** Why a shown control for another account does not count, for the log (ADR 0028). */
export const otherMisses = [
  "other-holds-name",
  "other-not-clickable",
  "other-text-long",
  "other-label-only",
  "other-in-chrome",
  "other-not-entry",
  "other-not-control",
] as const;
export type OtherMiss = (typeof otherMisses)[number];

/** Words for another account in a control's text, as {@link otherAccountMiss} reads them. */
function namesOtherAccount(text: string): boolean {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const other =
    words.some((word) => otherWords.has(word)) || otherParts.some((part) => text.includes(part));
  const account =
    words.some((word) => accountWords.has(word)) ||
    accountParts.some((part) => text.includes(part));
  return other && account;
}

/** Whether an element's short `aria-label` names another account. */
function labelNamesOtherAccount(element: Element): boolean {
  const label = (element.getAttribute("aria-label") ?? "").normalize("NFKC").trim();
  return label.length > 0 && label.length <= otherTextLimit && namesOtherAccount(label);
}

/**
 * Why the page shows no control, outside page chrome, that signs in with another account
 * (ADR 0028), for the log, or undefined when it shows one. Such a control's whole text,
 * at most 64 characters, holds a word for another (another, other, different, switch,
 * 別の, 他の, ほかの, 切り替え, 切替) and one for an account (account, profile, user and their
 * plurals, アカウント, プロフィール, ユーザー), and {@link listControls} could click it. Only words of
 * the control's own text count, never a site name. A control whose text holds one of
 * `names`, which are hidden from the page sent, would be left out of it, so it does not
 * count; nor, as a precaution, does one whose `aria-label` holds one. For an entry-like
 * control with the words: it holds one of `names` in its text or label
 * (`other-holds-name`), {@link listControls} could not click it (`other-not-clickable`),
 * its text is over 64 characters (`other-text-long`), or only its `aria-label` has them
 * (`other-label-only`). For words outside every such control: in page chrome
 * (`other-in-chrome`), with nothing shown, enabled and clickable around them
 * (`other-not-entry`), or in a clickable element that is not an innermost list control,
 * such as one holding another control (`other-not-control`); `other-label-only` again
 * when only an element's `aria-label` has them; or nowhere (`no-other`). Only these
 * codes leave the page, never its text.
 */
export function otherAccountMiss(
  document: Document,
  names: readonly string[] = [],
): OtherMiss | "no-other" | undefined {
  const source = namePattern(names);
  const holds = source ? new RegExp(source, "iu") : undefined;
  let miss: OtherMiss | undefined;
  for (const element of entryControls(document)) {
    const text = listControlText(element).normalize("NFKC");
    if (!text || !namesOtherAccount(text)) {
      if (labelNamesOtherAccount(element)) miss ??= "other-label-only";
      continue;
    }
    if (text.length > otherTextLimit) {
      miss ??= "other-text-long";
      continue;
    }
    const label = (element.getAttribute("aria-label") ?? "").normalize("NFKC");
    if (holds && (holds.test(text) || holds.test(label))) miss = "other-holds-name";
    else if (!clickableListControl(element)) {
      if (miss !== "other-holds-name") miss = "other-not-clickable";
    } else return undefined;
  }
  if (miss) return miss;
  // The words elsewhere on the page: an element whose whole short text, or whose label,
  // names another account.
  const start = document.body;
  if (!start) return "no-other";
  let labelled = false;
  for (const element of [...start.querySelectorAll("*")].slice(0, scanLimit)) {
    if (!(element instanceof HTMLElement) || unshownText.has(element.tagName)) continue;
    if (!labelled && labelNamesOtherAccount(element)) labelled = true;
    if (element.childElementCount > 0) continue;
    const raw = element.textContent ?? "";
    // A long text cannot collapse to a short label; this bounds the work per element.
    if (raw.length > controlTextLimit) continue;
    const text = collapseText(raw).normalize("NFKC");
    if (!text || text.length > otherTextLimit || !namesOtherAccount(text)) continue;
    if (inPageChrome(element)) return "other-in-chrome";
    let entry = false;
    for (
      let current: HTMLElement | null = element;
      current && !entry;
      current = current.parentElement
    )
      entry = isEntry(current);
    return entry ? "other-not-control" : "other-not-entry";
  }
  return labelled ? "other-label-only" : "no-other";
}

/** At most this many short texts are handed over as possible account names. */
const maxNames = 32;

/**
 * The short texts that may name a listed account by a username that is not an email (ADR
 * 0028, owner 2026-10-12 08:36 UTC): those shown beside at most three buttons, as
 * Instagram shows a saved profile's username beside "Continue", each at most 64
 * characters and without an `@`. A control's own text is not one, so a page of buttons
 * alone offers none. The background compares them with the matching items' usernames;
 * no username reaches the page.
 */
export function accountNames(root: Document | Element): string[] {
  const texts = besideAccounts(root)
    .map((account) => account.text)
    .filter((text) => text.length > 0 && text.length <= besideTextLimit && !/[@＠]/u.test(text));
  return [...new Set(texts)].slice(0, maxNames);
}

/** Folds a shown text or username for comparison: NFKC, lowercase, no leading `@`. */
export const foldName = (text: string) =>
  text.normalize("NFKC").trim().replace(/^@/u, "").toLowerCase();

/** Letters and digits a Latin name may not touch (ADR 0028). */
export const latinWord = /[\p{Script=Latin}\p{N}]/u;
/** {@link latinWord} as a pattern source, for a lookbehind or lookahead. */
export const latinEdge = "[\\p{Script=Latin}\\p{N}]";

/**
 * Where `names` show in a text normalized with NFKC, as ADR 0028 hides them: each folded
 * by {@link foldName}, with or without a leading `@`, in any case, and longest first, so a
 * name inside a longer one never leaves part of the longer one. A name is a word of its
 * own script: one starting or ending with a Latin letter or digit may touch kana or kanji,
 * as in `taro.yamadaさん`, but not another Latin letter or digit, as `an` in `another`.
 * `undefined` without a name.
 */
export function namePattern(names: readonly string[]): string | undefined {
  const folded = [...new Set(names.map(foldName).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  if (!folded.length) return undefined;
  return folded
    .map(
      (name) =>
        `${latinWord.test(name[0]!) ? `(?<!${latinEdge})` : ""}@?${RegExp.escape(name)}${
          latinWord.test(name.at(-1)!) ? `(?!${latinEdge})` : ""
        }`,
    )
    .join("|");
}

/**
 * The texts beside separate buttons that name one of `names` (ADR 0028), compared as
 * {@link foldName} folds them, and the other texts beside buttons, which may name
 * accounts that are not in the vault.
 */
export function namedAccounts(
  root: Document | Element,
  names: readonly string[],
): { named: HTMLElement[]; others: HTMLElement[] } {
  const wanted = new Set(names.map(foldName));
  const beside = besideAccounts(root);
  return {
    named: beside
      .filter((account) => wanted.has(foldName(account.text)))
      .map((account) => account.element),
    others: beside
      .filter((account) => !wanted.has(foldName(account.text)))
      .map((account) => account.element),
  };
}

/**
 * What a list showed when nothing on it fits (ADR 0028), for the log only: the chosen
 * username's kind, counts of what the page shows, and how the chooser's buttons were found.
 * Never a name, address or other text.
 */
export interface ListMiss {
  /** `email` for an address, `name` for another username, `empty` for none. */
  readonly username: "email" | "name" | "empty";
  /** Entries showing an address, or for a name, innermost entry-like controls. */
  readonly entries: number;
  /** For an address: entries whose shown address is masked. */
  readonly masked?: number;
  /** For an address: entries showing an address of the username's domain. */
  readonly sameDomain?: number;
  /**
   * For an address: entries whose shown address fits the username ({@link chooses}),
   * before masked ones are weighed against the other items' usernames.
   */
  readonly fits?: number;
  /** For an address without entries: why a text with an `@` is not one. */
  readonly entryMiss?: EntryMiss;
  /** Short texts shown beside buttons ({@link besideAccounts}). */
  readonly beside: number;
  /** For a name: entry controls whose whole text names it. */
  readonly named?: number;
  /** The chooser's `other` and `continue` buttons: none in the recipe, or elements found. */
  readonly other: ButtonFound;
  readonly continue: ButtonFound;
}
type ButtonFound = "none" | "missing" | "one" | "many";

/** What a chooser login clicks on a list (ADR 0028), and the element; `none` clicks nothing. */
export type ListChoice =
  | { click: "entry" | "continue" | "other"; element: HTMLElement }
  | { click: "none"; miss: ListMiss };

/** Whether `username` is an email: an `@` after its first character; `@name` is a handle. */
export const emailUsername = (username: string) =>
  username.normalize("NFKC").trim().indexOf("@") > 0;

/**
 * What a chooser's login clicks on the list `document` shows (ADR 0028), for the chosen
 * item's `username` and the other matching items' usernames (`others`, complete only
 * when `othersComplete`):
 *
 * - With an email username, the one entry whose address fits it ({@link pickEntry}).
 *   Otherwise, when the page shows exactly one account and it is a text beside its
 *   buttons, the chooser's `continue` button if it is one of those buttons and the text
 *   fits the username the same way. A masked address fits only when `others` is complete.
 * - With another username, the one entry-like control whose whole text names it
 *   ({@link namesUsername}), or, when the page shows exactly one text beside buttons and
 *   it names the username, the `continue` button if it is one of them.
 * - Otherwise the `other` button, or nothing.
 *
 * A button is clicked only when its locator names one element.
 */
export function listChoice(
  document: Document,
  input: {
    username: string;
    others: readonly string[];
    othersComplete: boolean;
    other?: LoginTarget | undefined;
    continue?: LoginTarget | undefined;
  },
): ListChoice {
  const only = (target: LoginTarget | undefined) => {
    const found = target ? listControls(document, target) : [];
    return found.length === 1 ? found[0] : undefined;
  };
  const proceed = only(input.continue);
  const masked = { masked: input.othersComplete };
  if (emailUsername(input.username)) {
    const entries = accountEntries(document);
    const picked = pickEntry(entries, input.username, input.others, masked);
    if ("entry" in picked) return { click: "entry", element: picked.entry.element };
    const beside = besideEmails(document);
    if (
      proceed &&
      entries.length === 0 &&
      beside.length === 1 &&
      beside[0]!.buttons.includes(proceed)
    ) {
      const shownAccount = {
        element: beside[0]!.element,
        accounts: shownAccounts(beside[0]!.text),
      };
      if ("entry" in pickEntry([shownAccount], input.username, input.others, masked))
        return { click: "continue", element: proceed };
    }
  } else if (input.username.trim()) {
    const controls = entryControls(document).filter((element) =>
      namesUsername(listControlText(element), input.username),
    );
    const beside = besideAccounts(document);
    const named = beside.filter((account) => namesUsername(account.text, input.username));
    if (controls.length === 1 && named.length === 0)
      return { click: "entry", element: controls[0]! };
    if (
      proceed &&
      controls.length === 0 &&
      beside.length === 1 &&
      named.length === 1 &&
      beside[0]!.buttons.includes(proceed)
    )
      return { click: "continue", element: proceed };
  }
  const other = only(input.other);
  return other
    ? { click: "other", element: other }
    : { click: "none", miss: listMiss(document, input) };
}

/** {@link ListMiss} for a list on which nothing fits the chosen `username`. */
function listMiss(
  document: Document,
  input: { username: string; other?: LoginTarget | undefined; continue?: LoginTarget | undefined },
): ListMiss {
  const found = (target: LoginTarget | undefined): ButtonFound => {
    if (!target) return "none";
    const count = listControls(document, target).length;
    return count === 0 ? "missing" : count === 1 ? "one" : "many";
  };
  const buttons = { other: found(input.other), continue: found(input.continue) };
  if (emailUsername(input.username)) {
    const entries = accountEntries(document);
    const domain = parts(input.username)?.domain;
    const miss = entries.length ? undefined : accountEntryMiss(document);
    return {
      username: "email",
      entries: entries.length,
      masked: entries.filter((entry) => entry.accounts.some((account) => /[*●•]/u.test(account)))
        .length,
      sameDomain: entries.filter((entry) =>
        entry.accounts.some((account) => domain !== undefined && parts(account)?.domain === domain),
      ).length,
      fits: entries.filter((entry) =>
        entry.accounts.some((account) => chooses(account, input.username)),
      ).length,
      ...(miss ? { entryMiss: miss } : {}),
      beside: besideEmails(document).length,
      ...buttons,
    };
  }
  if (!input.username.trim())
    return { username: "empty", entries: 0, beside: besideAccounts(document).length, ...buttons };
  const controls = entryControls(document);
  return {
    username: "name",
    entries: controls.length,
    beside: besideAccounts(document).length,
    named: controls.filter((element) => namesUsername(listControlText(element), input.username))
      .length,
    ...buttons,
  };
}
