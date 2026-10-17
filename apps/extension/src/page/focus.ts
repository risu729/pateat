// Focus moves for a fill or a press (owner, 2026-10-17 04:41 UTC). Chrome moves focus
// but sends the page no `focus`, `focusin`, `blur` or `focusout` while the page does not
// have focus, because its window is not the focused one, as when the person works in
// another application while Pateat logs in, or its tab is in the background, so a page
// that reads a field only on blur missed Pateat's value. Then these send them as Chrome
// does for a focused page. They are not trusted.

/** The page's focused element, inside shadow roots too. */
export function focusedElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

type Focusable = HTMLElement | SVGElement;

/**
 * Runs `move`, which moves focus, and, when the page does not have focus, sends the events
 * of the move Chrome did not: `blur` and `focusout` on the element that lost focus, then
 * `focus` and `focusin` on the one that took it, each naming the other as `relatedTarget`.
 * A page that has focus, as a frame does once the move focused an element in it, got
 * Chrome's own.
 */
function moveFocus(move: () => void): void {
  const before = focusedElement();
  move();
  const after = focusedElement();
  if (document.hasFocus() || after === before) return;
  const lost = before instanceof HTMLElement || before instanceof SVGElement ? before : null;
  const took =
    (after instanceof HTMLElement || after instanceof SVGElement) && after !== document.body
      ? after
      : null;
  const init = { view: window, composed: true };
  if (lost?.isConnected && lost !== document.body) {
    lost.dispatchEvent(new FocusEvent("blur", { ...init, relatedTarget: took }));
    lost.dispatchEvent(new FocusEvent("focusout", { ...init, bubbles: true, relatedTarget: took }));
  }
  if (took?.isConnected && focusedElement() === took) {
    took.dispatchEvent(new FocusEvent("focus", { ...init, relatedTarget: lost }));
    took.dispatchEvent(new FocusEvent("focusin", { ...init, bubbles: true, relatedTarget: lost }));
  }
}

/**
 * Focuses `element` without scrolling; returns whether it took focus, itself or, for a
 * shadow host that delegates focus, through an element inside it.
 */
export function focusElement(element: Focusable): boolean {
  moveFocus(() => element.focus({ preventScroll: true }));
  // Its root retargets focus inside a shadow host to the host.
  return (element.getRootNode() as Document | ShadowRoot).activeElement === element;
}

/** Blurs `element`. */
export function blurElement(element: Focusable): void {
  moveFocus(() => element.blur());
}
