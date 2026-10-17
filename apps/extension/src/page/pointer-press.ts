// The mouse events before the login executor's click (owner, 2026-10-17 03:58 UTC).
// `HTMLElement.click()` sends a page only `click`, so a control that acts on `pointerdown`
// or `mousedown`, or that expects them before its `click`, never reacted to Pateat's click.
// A person's mouse sends them first, in the order and with the properties Chrome gives
// them for a mouse moved onto the control and pressed. The events are not trusted
// (`isTrusted` is false) and carry no user activation, as the click itself does not.

import { nextTask } from "./enter-value";

/** The pointer a mouse is, as Chrome reports it. */
const mouse = { pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1 };

/** The elements a person's click can focus, as Chrome focuses one on `mousedown`. */
const clickFocusable =
  "a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable='false' i])";

/** The element the last press of this document left the mouse over. */
let hovered: WeakRef<Element> | undefined;

/** The element's parent, or a shadow root's host. */
function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.parentNode;
  return root instanceof ShadowRoot ? root.host : null;
}

/** `element` and its ancestors, across shadow roots, innermost first. */
function ancestry(element: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node; node = composedParent(node)) chain.push(node);
  return chain;
}

/** The page's focused element, inside shadow roots too. */
function focusedElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * What a `mousedown` Chrome does not cancel does to focus: the nearest element of
 * `element`'s ancestry a click can focus takes it, without scrolling; with none, the
 * focused element is blurred, as a click on plain text moves focus to the body.
 */
function focusOnPress(element: Element): void {
  for (const node of ancestry(element)) {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue;
    if (!node.matches(clickFocusable)) continue;
    node.focus({ preventScroll: true });
    if (node.matches(":focus")) return;
  }
  const active = focusedElement();
  if (active instanceof HTMLElement || active instanceof SVGElement) active.blur();
}

/**
 * Sends `element` the events a person's mouse sends before its click, at the centre of
 * its first box. Resolves `pressed` when the click should follow, `stopped` when the press
 * stopped after `pointerdown`, and `missed` when it stopped before it, after only the
 * moving events.
 *
 * - Moving onto it, when the last press of this document left the mouse elsewhere:
 *   `pointerout` and `pointerleave` on that element and its ancestors that do not hold
 *   `element`, `pointerover`, `pointerenter` on `element` and its ancestors that do not
 *   hold that element (outermost first), then the same as `mouseout`, `mouseleave`,
 *   `mouseover` and `mouseenter`; then `pointermove` and `mousemove`.
 * - One task later: `pointerdown`, `mousedown` and focus (see {@link focusOnPress}).
 * - One task later: `pointerup` and `mouseup`.
 *
 * Each event is followed by the page's microtasks, as Chrome runs them between the events
 * of one input, so a framework that renders in a microtask, such as one that disables a
 * button once its `mousedown` submitted, renders before the next event. As in a browser,
 * a page that cancels `pointerdown` gets no `mousedown` or `mouseup`, and one that cancels
 * `mousedown` keeps focus where it was. After each task the press stops, without the
 * click, when `between` says so or the page's handlers removed `element` from the
 * document, as a control that acts on `mousedown` and replaces its form does, since a
 * browser then sends the click to no button.
 */
export async function pressPointer(
  element: HTMLElement,
  between: () => boolean = () => true,
): Promise<"pressed" | "stopped" | "missed"> {
  const box = element.getClientRects()[0] ?? element.getBoundingClientRect();
  const at = {
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    view: window,
  };
  const send = async (target: Element, event: Event) => {
    const sent = target.dispatchEvent(event);
    await Promise.resolve();
    return sent;
  };
  const boundary = { ...at, bubbles: true, cancelable: true, composed: true };
  const local = { ...at, bubbles: false, cancelable: false, composed: false };
  const previous = hovered?.deref();
  if (previous !== element) {
    const from = previous?.isConnected ? previous : undefined;
    // Compared as sets, since `contains` stops at a shadow root.
    const into = ancestry(element);
    const out = from ? ancestry(from) : [];
    const entering = into.filter((node) => !out.includes(node));
    const leaving = out.filter((node) => !into.includes(node));
    for (const [Type, extra] of [
      [PointerEvent, { ...mouse, button: -1 }],
      [MouseEvent, {}],
    ] as const) {
      const kind = Type === PointerEvent ? "pointer" : "mouse";
      const toward = { relatedTarget: element, ...extra };
      if (from) {
        // eslint-disable-next-line no-await-in-loop
        await send(from, new Type(`${kind}out`, { ...boundary, ...toward }));
        for (const node of leaving)
          // eslint-disable-next-line no-await-in-loop
          await send(node, new Type(`${kind}leave`, { ...local, ...toward }));
      }
      const away = { relatedTarget: from ?? null, ...extra };
      // eslint-disable-next-line no-await-in-loop
      await send(element, new Type(`${kind}over`, { ...boundary, ...away }));
      for (const node of entering.toReversed())
        // eslint-disable-next-line no-await-in-loop
        await send(node, new Type(`${kind}enter`, { ...local, ...away }));
    }
    hovered = new WeakRef(element);
  }
  await send(element, new PointerEvent("pointermove", { ...boundary, ...mouse, button: -1 }));
  await send(element, new MouseEvent("mousemove", boundary));
  const pressing = () => element.isConnected && between();
  await nextTask();
  if (!pressing()) return "missed";
  const down = { ...boundary, button: 0, buttons: 1 };
  const compatible = await send(
    element,
    new PointerEvent("pointerdown", { ...down, ...mouse, pressure: 0.5 }),
  );
  if (compatible && (await send(element, new MouseEvent("mousedown", { ...down, detail: 1 }))))
    focusOnPress(element);
  await nextTask();
  if (!pressing()) return "stopped";
  const up = { ...boundary, button: 0, buttons: 0 };
  await send(element, new PointerEvent("pointerup", { ...up, ...mouse }));
  if (compatible) await send(element, new MouseEvent("mouseup", { ...up, detail: 1 }));
  return pressing() ? "pressed" : "stopped";
}
