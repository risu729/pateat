import { splitCodeOf } from "../page/code-submission";
import {
  closestAcross,
  composedOrder,
  composedParent,
  containsAcross,
  queryAll,
  shadowRootOf,
  treeOf,
} from "../page/shadow";
import { openModals, renderedText, shown } from "../page/text";
import { landmarks, visible } from "./extract-controls";
import { rawLimit, observedText } from "./extract-text";
import { idList, liveRegions } from "./extract-labels";

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
 * shown element without child elements, or whose child elements are only inline text
 * (`textBlock`, as a sentence with a `<br>` or `<strong>`), within six parents of the
 * field (never the body or above) and below the first parent that holds another shown field to type in, so the
 * texts stay with the code's own part of the page, nearest parent first and then in page
 * order, returned in page order. A text that looks like a key or recovery code
 * ({@link keyLike}, read before redaction), or whose parent up to the area shows one
 * ({@link inKey}), is left out; any other is normalized as
 * `observedText` does but not cut, then passed to `keep`, which hides it, cuts it or
 * drops it; only kept texts count, and each once. Elements matching
 * `notNear`, those inside one and those the field's `aria-errormessage` names are left
 * out, and a field marked `aria-invalid="true"` gets none, as its description does.
 */
export function nearCodeTexts(
  field: HTMLElement,
  keep: (text: string) => string | undefined,
): string[] {
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
export function nearButtonTexts(
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
 * The elements that may sit inside a text block: line breaks, emphasis, `span` and
 * `font` and other inline text, and an icon image. Links, buttons, controls, code-like
 * elements and every other element keep their parent from being one.
 */
const inlineText = new Set([
  "abbr",
  "b",
  "bdi",
  "bdo",
  "br",
  "cite",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "img",
  "ins",
  "mark",
  "q",
  "rb",
  "rp",
  "rt",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "wbr",
]);

/** Child elements a text block may hold, so a large region is never read as one. */
const textBlockElements = 20;

/**
 * Whether `element` holds child elements that are all inline text (`inlineText`), at
 * most `textBlockElements` of them in all, as a sentence written
 * `<p>セキュリティ強化のため…<br>ピースを動かして…</p>` (EPOS Net, 2026-11-11): its
 * rendered text is read whole, as one element without child elements is. A child element
 * with a role, a live region's `aria-live`, editable text, a shadow root, or one that is
 * or holds an `excluded` element (an error message the field names) keeps it from being
 * one, so its parts are read one by one and such a part is left out as before.
 */
function textBlock(element: Element, excluded: readonly Element[]): boolean {
  if (element.childElementCount === 0) return false;
  let count = 0;
  for (const child of element.querySelectorAll("*")) {
    if (
      (count += 1) > textBlockElements ||
      !inlineText.has(child.localName) ||
      child.hasAttribute("role") ||
      child.matches(notNear) ||
      shadowRootOf(child)
    )
      return false;
  }
  return !excluded.some((other) => other !== element && containsAcross(element, other));
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
  // The inline elements of a text block read whole, which give no text of their own.
  const inBlock = new Set<Element>();
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
        const block = textBlock(element, excluded);
        if (
          (element.childElementCount > 0 && !block) ||
          inBlock.has(element) ||
          (shadowRootOf(element)?.childElementCount ?? 0) > 0 ||
          containsAcross(inner, element) ||
          notNearAbove(element) ||
          excluded.some((error) => containsAcross(error, element))
        )
          continue;
        const rendered = renderedText(element, rawLimit);
        if (rendered === undefined) continue;
        // A block read, or left out as a key, gives no text through its parts; one with no
        // text, or whose text `keep` drops, leaves them to be read alone.
        const silence = () => {
          if (block) for (const child of element.querySelectorAll("*")) inBlock.add(child);
        };
        // A text that looks like a key or recovery code may be a secret, and is never
        // sent; it is read before redaction hides its digits. A key printed one group per
        // element shows only in the text of a parent, so each parent up to the area is
        // read too.
        if (keyLike(rendered) || inKey(element, area, keyParents)) {
          silence();
          continue;
        }
        const raw = observedText(rendered, Number.POSITIVE_INFINITY);
        const text = raw && keep(raw);
        if (!text) continue;
        silence();
        if (!found.some((entry) => entry.text === text)) found.push({ element, text });
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
  // The other inputs of a code split into inputs that declare no `maxlength` (ADR 0027
  // amendment of 2026-11-04).
  const digits = field instanceof HTMLInputElement ? splitCodeOf(field, visible) : undefined;
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
    if (digits?.includes(element as HTMLInputElement)) continue;
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
