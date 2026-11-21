/**
 * Clicks and submits that run a `javascript:` URL. Chrome runs such a URL under the
 * content security policy of the world whose call started the navigation, so a click from
 * the login content script's isolated world that follows a `javascript:` link, or submits
 * a form whose action is one, is refused with the extension's own `script-src 'self'`
 * policy and reported as an extension error. The page's `click` and `submit` handlers
 * still run first, but the URL never does: a link whose action is its URL alone, such as
 * SMBC Trust Bank's `href="javascript:submitProc();..."`, never submits. The page's main
 * world clicks or submits such an element instead, under the page's own policy, as a
 * person's click or Enter would run it.
 *
 * The isolated world dispatches {@link MAIN_WORLD_CLICK} on the element, or
 * {@link MAIN_WORLD_SUBMIT} on a form it submits without a button; the main-world
 * listener ({@link installMainWorldClicks}) clicks or submits it and cancels the event.
 * The event carries nothing, and the main world, which the page controls, can only click
 * or submit what the page could itself. Nothing is read back from it but whether the
 * event was cancelled: when no listener cancels it (the script did not load, the page
 * stopped the event, or the element sits in a closed shadow root, where the listener sees
 * only the host), the isolated world clicks or submits as before. A page can patch what
 * the listener calls, or cancel the event without acting, but only to refuse or repeat its
 * own login, which the attempt's checks of the page report; it gains nothing it could not
 * do itself. The event does tell a page, in any HTTPS frame, that Pateat is installed.
 * Either world's click is the same untrusted event to the page; only the policy a
 * `javascript:` URL meets differs.
 */

import { elementProperty, nodeProperty } from "./form-native";
import { pressPointer } from "./pointer-press";

/** The events' fixed names; neither bubbles nor carries a detail. */
export const MAIN_WORLD_CLICK = "pateat-main-world-click";
export const MAIN_WORLD_SUBMIT = "pateat-main-world-submit";

/**
 * The schemes of a script URL, as `scriptHref` in `text.ts` reads a script link. Only a
 * `javascript:` URL runs; Chrome blocks top-level `data:` navigations and has no
 * `vbscript:`, so such a link or form does the same from either world.
 */
const scriptSchemes: readonly string[] = ["javascript:", "data:", "vbscript:"];

/**
 * Whether a submission of `form` goes to a script URL, as the browser resolves it: the
 * `submitter`'s `formaction` when it has one, else the form's `action`, against the base
 * URL; an empty or missing value is the document's URL, which is no script URL
 * (`form-destination.ts` reads a destination the same way). The attributes are read
 * through `Element.prototype`, since a form's controls hide its own properties.
 */
function submitsToScriptUrl(form: HTMLFormElement, submitter?: Element): boolean {
  const value =
    submitter && Element.prototype.hasAttribute.call(submitter, "formaction")
      ? Element.prototype.getAttribute.call(submitter, "formaction")
      : Element.prototype.getAttribute.call(form, "action");
  if (!value) return false;
  const url = URL.parse(value, Reflect.get(Node.prototype, "baseURI", form) as string);
  return url !== null && scriptSchemes.includes(url.protocol);
}

/**
 * The control whose activation a click on `element` runs: the nearest link, area, button
 * or input from `element` up through slots and shadow hosts, as the click's path goes,
 * or, when a `<label>` comes first, that label's control: a click on a control inside a
 * label runs only that control's activation. A `<form>` on the way hides members behind
 * its named controls, so they are read through the prototypes (`form-native.ts`).
 */
function activated(element: Element): Element | null | undefined {
  for (let node: Element | null = element; node;) {
    if (Element.prototype.matches.call(node, "a[href], area[href], button, input")) return node;
    if (node instanceof HTMLLabelElement) return node.control;
    const parent: ParentNode | null = nodeProperty(node, "parentNode");
    node =
      elementProperty(node, "assignedSlot") ??
      nodeProperty(node, "parentElement") ??
      (parent instanceof ShadowRoot ? parent.host : null);
  }
  return undefined;
}

/**
 * Whether a click on `element` runs a script URL: the control it activates
 * ({@link activated}) is a link whose URL, as the browser parses it, is a script URL, or a
 * submit button or image input whose form submits to one ({@link submitsToScriptUrl}),
 * such as Azure AD B2C's Sign in button in `<form action="JavaScript:void(0);">`.
 */
export function runsScriptUrl(element: unknown): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const control = activated(element);
  // `protocol` reads the parsed URL: case, surrounding spaces and tabs inside do not matter.
  if (control instanceof HTMLAnchorElement || control instanceof HTMLAreaElement)
    return control.hasAttribute("href") && scriptSchemes.includes(control.protocol);
  return (
    (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) &&
    (control.type === "submit" || control.type === "image") &&
    control.form !== null &&
    submitsToScriptUrl(control.form, control)
  );
}

/** Whether the main world answered `type` on `target` by cancelling it. */
const mainWorldDid = (target: Element, type: string) =>
  // Synchronous: a cancelled event means the main world has already acted.
  !target.dispatchEvent(new CustomEvent(type, { cancelable: true, composed: true }));

/**
 * Clicks `element`: from the main world when the click runs a script URL
 * ({@link runsScriptUrl}) and its listener answers, and otherwise here. Only one world
 * clicks, so `onclick` handlers run once.
 */
export function clickElement(element: HTMLElement): void {
  if (runsScriptUrl(element) && mainWorldDid(element, MAIN_WORLD_CLICK)) return;
  HTMLElement.prototype.click.call(element);
}

/**
 * Submits `form` with `requestSubmit()` and no submitter: from the main world when its
 * `action` is a script URL and the listener answers, and otherwise here.
 */
export function submitForm(form: HTMLFormElement): void {
  if (submitsToScriptUrl(form) && mainWorldDid(form, MAIN_WORLD_SUBMIT)) return;
  HTMLFormElement.prototype.requestSubmit.call(form);
}

/**
 * The login executor's click, after the mouse events a person's click sends first
 * ({@link pressPointer}, which stops when `between` says so or the element left the
 * document), made by {@link clickElement}. Resolves `clicked`, or how the press stopped
 * before the click.
 */
export async function pressElement(
  element: HTMLElement,
  between?: () => boolean,
): Promise<"clicked" | "stopped" | "missed"> {
  const pressed = await pressPointer(element, between);
  if (pressed !== "pressed") return pressed;
  clickElement(element);
  return "clicked";
}

/**
 * Installs the main-world listeners: one clicks an element whose click runs a script URL
 * ({@link runsScriptUrl}), once, and one submits a form whose `action` is a script URL;
 * each cancels its event so the isolated world does not act again. Any other target, such
 * as one a page script names, is left alone. Returns the removal.
 */
export function installMainWorldClicks(): () => void {
  // Taken at document start, before page scripts can replace them. The other calls below
  // are looked up when the event comes, so a page can patch them, but only to break its
  // own login.
  const click = HTMLElement.prototype.click;
  const requestSubmit = HTMLFormElement.prototype.requestSubmit;
  const clicks = (event: Event) => {
    // The element itself, also inside an open shadow root.
    const [target] = event.composedPath();
    if (!runsScriptUrl(target)) return;
    // Cancelled before the click, so a throwing handler never leads to a second click.
    event.preventDefault();
    click.call(target);
  };
  const submits = (event: Event) => {
    const [target] = event.composedPath();
    if (!(target instanceof HTMLFormElement) || !submitsToScriptUrl(target)) return;
    event.preventDefault();
    requestSubmit.call(target);
  };
  addEventListener(MAIN_WORLD_CLICK, clicks, true);
  addEventListener(MAIN_WORLD_SUBMIT, submits, true);
  return () => {
    removeEventListener(MAIN_WORLD_CLICK, clicks, true);
    removeEventListener(MAIN_WORLD_SUBMIT, submits, true);
  };
}
