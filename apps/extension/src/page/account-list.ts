import { fits, shownAccounts } from "./accounts";
import { isButton, isScriptButton, renderedText, shown } from "./text";

/** Roles that make an element a list entry (ADR 0028). */
const entryRoles = new Set(["button", "link", "option", "menuitem", "radio"]);
/** Page chrome: an account menu there is a signed-in page's, not a list of accounts. */
export const chromeSelector = "header, nav, [role='banner' i], [role='navigation' i]";
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

function pointer(element: HTMLElement): boolean {
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
  return pointer(element);
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
 * other matching vault items' usernames) would also choose is not used. `none` when no
 * entry fits, `ambiguous` when several do.
 */
export function pickEntry(
  entries: readonly AccountEntry[],
  username: string,
  others: readonly string[] = [],
): { entry: AccountEntry } | { reason: "none" | "ambiguous" } {
  const fitting = entries.filter((entry) =>
    entry.accounts.some(
      (account) =>
        chooses(account, username) &&
        (!/[*●•]/u.test(account) || !others.some((other) => chooses(account, other))),
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
  /** The entry-like elements beside it: at most 3, none holding the text. */
  readonly buttons: readonly HTMLElement[];
}

/**
 * The innermost entry-like elements of `root` outside page chrome, at most a scan of
 * 4000 elements.
 */
export function entryControls(root: Document | Element): HTMLElement[] {
  const start = root instanceof Document ? root.body : root;
  if (!start) return [];
  const controls = [...start.querySelectorAll("*")]
    .slice(0, scanLimit)
    .filter(
      (element): element is HTMLElement =>
        entryLike(element) && entryAround(element) === element && !element.closest(chromeSelector),
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

/**
 * The short texts shown beside separate buttons rather than inside them, as Wise's
 * "Welcome back" card shows the account above "Log back in" (ADR 0028, owner
 * 2026-10-12 08:36 UTC): each shown element of at most 64 characters, outside page
 * chrome and contact details and outside every entry-like element, whose nearest
 * ancestor holding an entry-like element holds at most 3 of them.
 */
export function besideAccounts(root: Document | Element): BesideAccount[] {
  const document = root instanceof Document ? root : root.ownerDocument;
  const start = root instanceof Document ? root.body : root;
  if (!start) return [];
  const controls = entryControls(root);
  if (controls.length === 0) return [];
  const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.nodeValue ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const found = new Map<HTMLElement, BesideAccount>();
  for (let index = 0; index < textNodeLimit; index += 1) {
    const node = walker.nextNode();
    if (!node) break;
    const element = node.parentElement;
    if (!element || found.has(element) || !shown(element)) continue;
    if (element.closest(`${chromeSelector}, ${contactSelector}`)) continue;
    // The text must be the element's own, not a control's or a contact link's inside it.
    if (insideControl(element) || element.querySelector(`a, button, [role], ${contactSelector}`))
      continue;
    const text = renderedText(element, besideTextLimit + 1)
      ?.replace(/\s+/gu, " ")
      .trim();
    if (!text || text.length > besideTextLimit) continue;
    let container = element.parentElement;
    let buttons: HTMLElement[] = [];
    for (; container && container !== start.parentElement; container = container.parentElement) {
      buttons = controls.filter((item) => container!.contains(item));
      if (buttons.length) break;
    }
    if (buttons.length === 0 || buttons.length > maxBesideButtons) continue;
    found.set(element, { element, text, buttons });
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
