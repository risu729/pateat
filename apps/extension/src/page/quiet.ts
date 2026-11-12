// When the page counts as changed for a wait for its quiet (ADR 0057): every DOM change is
// watched, but an attribute animation alone leaves the page quiet.

import { shadowRoots } from "./shadow";

/**
 * What the login page watch observes, in the document and in each shadow tree: every
 * node, text and attribute change. Any attribute can change a target's name, as
 * `aria-label` or a label's `for` do, or, through the page's CSS selectors, whether it
 * shows; the watch's checks keep their throttle (`checkGapMs` in `login/content.ts`).
 */
export const pageWatch: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
};
/**
 * The attributes whose change breaks the page's quiet, for the offer's wait (ADR 0057)
 * and `settled`: those that most often change whether a target matches, shows or accepts
 * input. Button text locators also depend on text, `value`, `alt` and hidden subtrees.
 * Other attributes are still checked by the page watch, but a page whose only movement
 * is an attribute animation, as an SVG's `transform` or a progress bar's `aria-valuenow`
 * every frame, counts as quiet, so it is decided after a second rather than at the
 * five-second cap.
 */
export const quietAttributes: ReadonlySet<string> = new Set([
  "id",
  "name",
  "data-testid",
  "data-test",
  "type",
  "autocomplete",
  "hidden",
  "style",
  "class",
  "open",
  "disabled",
  "readonly",
  "value",
  "alt",
  "aria-hidden",
  "aria-disabled",
  "inert",
  "role",
  "onclick",
  "href",
]);
/**
 * Whether a DOM change restarts a wait for the page's quiet: see `quietAttributes`. As the
 * attribute filter this list was, it leaves out namespaced attributes, as an SVG
 * `xlink:href`.
 */
export const breaksQuiet = (record: MutationRecord): boolean =>
  record.type !== "attributes" ||
  (record.attributeNamespace === null && quietAttributes.has(record.attributeName ?? ""));
/**
 * Resolves once `document` has loaded and its DOM, shadow trees included, has had no
 * change for `quietMs`, or at `until` (a time in ms since the epoch), whichever comes
 * first. Attributes count as for the offer's quiet wait (`breaksQuiet`), so a page whose
 * only movement is an attribute animation is quiet.
 */
export function settled(document: Document, quietMs: number, until: number): Promise<void> {
  return new Promise((resolve) => {
    const view = document.defaultView;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(quiet);
      if (document.readyState === "complete") quiet = setTimeout(done, quietMs);
    };
    const observer = new MutationObserver((records) => {
      if (records.some(breaksQuiet)) restart();
    });
    const cap = setTimeout(done, Math.max(0, until - Date.now()));
    function done(): void {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(cap);
      view?.removeEventListener("load", restart);
      resolve();
    }
    // The shadow trees the page holds now change the page too (ADR 0070).
    for (const tree of [document, ...shadowRoots(document)]) observer.observe(tree, pageWatch);
    view?.addEventListener("load", restart);
    restart();
  });
}
