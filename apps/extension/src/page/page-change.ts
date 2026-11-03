// Waits on the page's own signals instead of a timer (ADR 0082): the content script never
// pauses for a set time to let the page react, and a wait for something to show re-checks
// it when the page signals a change, with a timeout only as the bound.

import { askDefinitions, ELEMENT_DEFINED } from "./element-definitions";
import { nextFrame } from "./frames";
import { shadowRoots } from "./shadow";

/**
 * Events after which what a check reads may differ without a DOM change: a stylesheet,
 * image or frame loading (`load` and `error` do not bubble, so they are heard while
 * capturing), a CSS animation or transition ending, a popover or `<details>` toggling,
 * and a value typed or chosen. Heard in the document and in each shadow tree, as these
 * events do not all leave one.
 */
const treeEvents = [
  "load",
  "error",
  "animationend",
  "animationcancel",
  "transitionend",
  "transitioncancel",
  "toggle",
  "input",
  "change",
] as const;

/** Events of the window that can change what shows: the layout, the URL, a definition. */
const windowEvents = ["load", "resize", "popstate", "hashchange", "pageshow", ELEMENT_DEFINED];

/**
 * Resolves on the page's first sign of a change after the call, then its next frame
 * ({@link nextFrame}), or at `until` (a time in ms since the epoch), or once `stop` is
 * aborted, whichever comes first. A sign is a DOM change in the document or in any of its
 * shadow trees (any node, text or attribute), one of {@link treeEvents} or
 * {@link windowEvents}, a same-document navigation, the document's ready state or
 * visibility changing, or one of the page's custom elements becoming defined
 * ({@link askDefinitions}), as an element defined late may attach its shadow tree and
 * render into it, which no observer reports. The caller checks again after it resolves,
 * whatever resolved it, so a wait for something to show is a loop around this call.
 */
export function pageChange(document: Document, until: number, stop?: AbortSignal): Promise<void> {
  const view = document.defaultView;
  if (!view || stop?.aborted || Date.now() >= until) return Promise.resolve();
  return new Promise((resolve) => {
    const listening = new AbortController();
    let bound: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => changed());
    function end(): void {
      observer.disconnect();
      listening.abort();
      clearTimeout(bound);
    }
    function changed(): void {
      if (listening.signal.aborted) return;
      end();
      void nextFrame(view!).then(resolve, resolve);
    }
    const settle = () => {
      end();
      resolve();
    };
    const roots = shadowRoots(document);
    const options = { capture: true, passive: true, signal: listening.signal };
    for (const tree of [document, ...roots]) {
      observer.observe(tree, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      for (const type of treeEvents) tree.addEventListener(type, changed, options);
    }
    for (const type of windowEvents) view.addEventListener(type, changed, options);
    for (const type of ["readystatechange", "visibilitychange"])
      document.addEventListener(type, changed, options);
    (view as unknown as { navigation?: EventTarget }).navigation?.addEventListener(
      "currententrychange",
      changed,
      options,
    );
    stop?.addEventListener("abort", settle, { signal: listening.signal });
    bound = setTimeout(settle, until - Date.now());
    askDefinitions(document, roots);
  });
}
