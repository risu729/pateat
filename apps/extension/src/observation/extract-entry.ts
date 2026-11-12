import { closestAcross, queryAll, readingPage } from "../page/shadow";
import { redactsPath } from "./path";
import { entryElementRefusal, linkUrl, renderedControlText } from "../page/entry";
import { linkRefusal, type OnSite } from "../login/entry";
import type { ObservationResult } from "./extract-types";
import { maxCandidates, fields, enabled } from "./extract-controls";
import { locatorIndex, locate } from "./extract-locators";
import { describeAll } from "./extract-candidates";
import { observe, byLandmark } from "./extract-observe";

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
