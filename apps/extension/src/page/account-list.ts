import { fits, shownAccounts } from "./accounts";
import { isButton, isScriptButton, renderedText, shown } from "./text";

/** Roles that make an element a list entry (ADR 0028). */
const entryRoles = new Set(["button", "link", "option", "menuitem", "radio"]);
/** Page chrome: an account menu there is a signed-in page's, not a list of accounts. */
const chromeSelector = "header, nav, [role='banner' i], [role='navigation' i]";
const entryTextLimit = 300;
/** At most this many email-bearing texts are examined; a list holds a handful. */
const textNodeLimit = 200;

function disabled(element: HTMLElement): boolean {
  return (
    (isButton(element) && element.disabled) ||
    element.closest("[aria-disabled='true' i], [inert]") !== null
  );
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
  const role = element.getAttribute("role")?.trim().toLowerCase();
  if (role && entryRoles.has(role)) return true;
  if (element.hasAttribute("tabindex") && element.tabIndex >= 0) return true;
  return pointer(element);
}

export interface AccountEntry {
  readonly element: HTMLElement;
  /** Email addresses, masked or not, in the entry's rendered text. */
  readonly accounts: readonly string[];
}

/**
 * The entries of `root` that show an email address: for every shown text holding an
 * `@`, the innermost {@link entryLike} element around it. Entries inside page chrome
 * (`<header>`, `<nav>` and their roles) are left out.
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
    let element = node.parentElement;
    while (element && !entryLike(element)) element = element.parentElement;
    if (!element || found.has(element) || element.closest(chromeSelector)) continue;
    const text = renderedText(element, entryTextLimit, { everyElement: true }) ?? "";
    const accounts = shownAccounts(text).filter((account) => account.includes("@"));
    if (accounts.length) found.set(element, { element, accounts });
  }
  return [...found.values()];
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
