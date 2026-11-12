import type { LoginMarkerTarget } from "@pateat/contracts";
import {
  findLogoutTargets,
  isMenuItem,
  localLogoutControl,
  logoutControlName,
  logoutName,
  menuItemText,
  openMenus,
} from "../page/logout-controls";
import { closestAcross, containsAcross, queryAll, readingPage } from "../page/shadow";
import { redactsPath } from "./path";
import { openModals } from "../page/text";
import { entryElementRefusal, linkUrl } from "../page/entry";
import { linkRefusal, type OnSite } from "../login/entry";
import type { ObservationResult, Draft, Chosen } from "./extract-types";
import { maxCandidates, landmarks, accountAreas, holdsField, enabled } from "./extract-controls";
import { withoutNumbers } from "./extract-text";
import { type LocatorIndex, locatorIndex, locate } from "./extract-locators";
import { describeAll } from "./extract-candidates";
import { observe } from "./extract-observe";

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
    holdsField(form ?? closestAcross(element, "form"));
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
  if (!enabled(control) || holdsField(closestAcross(control, "form")))
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
