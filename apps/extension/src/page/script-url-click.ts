/**
 * Clicks on links whose `href` is a `javascript:` URL. Chrome runs such a URL under the
 * content security policy of the world that clicked, so a click from the login content
 * script's isolated world is refused with the extension's own `script-src 'self'` policy,
 * and a link whose action is its URL alone, such as SMBC Trust Bank's
 * `href="javascript:submitProc();..."`, never submits. The page's main world clicks such a
 * link instead, under the page's own policy, as a person's click would run it.
 *
 * The isolated world dispatches {@link MAIN_WORLD_CLICK} on the link; the main-world
 * listener ({@link installMainWorldClicks}) clicks it and cancels the event. The event
 * carries nothing, and the main world, which the page controls, can only click a link the
 * page could click itself. Nothing is read back from it but whether the event was
 * cancelled: when no listener cancels it (the script did not load, or the page stopped the
 * event), the isolated world clicks as before. A page that cancels the event without
 * clicking only refuses its own login, which the attempt's checks of the page report.
 */

/** The event's fixed name; it neither bubbles nor carries a detail. */
export const MAIN_WORLD_CLICK = "pateat-main-world-click";

/** Whether `element` is an `<a href>` whose URL, as the browser parses it, is `javascript:`. */
export function runsScriptUrl(element: unknown): element is HTMLAnchorElement {
  // `protocol` reads the parsed URL: case, surrounding spaces and tabs inside do not matter.
  return (
    element instanceof HTMLAnchorElement &&
    element.hasAttribute("href") &&
    element.protocol === "javascript:"
  );
}

/**
 * The login executor's click. A `javascript:` link is clicked by the main world when its
 * listener answers, and otherwise here; every other element is clicked here, as before.
 * Only one world clicks, so `onclick` handlers run once.
 */
export function pressElement(element: HTMLElement): void {
  if (
    runsScriptUrl(element) &&
    // Synchronous: a cancelled event means the main world has already clicked.
    !element.dispatchEvent(new CustomEvent(MAIN_WORLD_CLICK, { cancelable: true, composed: true }))
  )
    return;
  element.click();
}

/**
 * Installs the main-world listener: it clicks a `javascript:` link the event names, once,
 * and cancels the event so the isolated world does not click it again. Any other target,
 * such as one a page script names, is left alone. Returns the removal.
 */
export function installMainWorldClicks(): () => void {
  // Taken at document start, before page scripts can replace it.
  const click = HTMLElement.prototype.click;
  const listener = (event: Event) => {
    // The link itself, also inside an open shadow root.
    const [target] = event.composedPath();
    if (!runsScriptUrl(target)) return;
    // Cancelled before the click, so a throwing handler never leads to a second click.
    event.preventDefault();
    click.call(target);
  };
  addEventListener(MAIN_WORLD_CLICK, listener, true);
  return () => removeEventListener(MAIN_WORLD_CLICK, listener, true);
}
