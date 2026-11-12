import type { ObservedCandidate } from "@pateat/contracts";
import { closestAcross } from "../page/shadow";
import { attributeHidden, scriptControls, shown } from "../page/text";
import { chromeSelector } from "../page/account-list";

export const maxCandidates = 48;

/** Where account menus usually sit: the page's header and navigation. */
export const landmarks = chromeSelector;

/**
 * An account area outside them: an element whose ID, class or `aria-label` names the
 * account, user or profile, as an account menu's container. No site is named.
 */
export const accountAreas = ["account", "user", "profile", "avatar"]
  .flatMap((word) => [`[id*='${word}' i]`, `[class*='${word}' i]`, `[aria-label*='${word}' i]`])
  .concat(["[aria-label*='アカウント']"])
  .join(", ");

export const fillTypes: Record<string, ObservedCandidate["role"]> = {
  text: "text",
  email: "email",
  tel: "tel",
  number: "number",
  password: "password",
};

export const actionTypes = new Set(["submit", "button", "image"]);

export const ignoredTypes = new Set(["hidden", "reset"]);

export const controls = "input:not([type='hidden']), select, textarea, button";

export const fields = "input:not([type='hidden']), select, textarea";

/**
 * Whether `form` holds a field: through `Element`, as the form's named controls hide its
 * own `querySelector` (`form-native.ts`).
 */
export const holdsField = (form: Element | null) =>
  form !== null && Element.prototype.querySelector.call(form, fields) !== null;

/** Every element `describe` may accept, script buttons included. */
export const observed = `input, select, textarea, button, a, ${scriptControls}`;

/**
 * Whether a control is on the page: `visible`, `faint` when it is rendered but
 * transparent or tiny (a trap, or a real input under a styled widget), or `absent`
 * when it is hidden or moved before the page's start, where trap inputs usually go.
 * A control transparent only while it or an ancestor fades in from opacity 0 counts as
 * opaque, as `shown` does (2026-10-17), and so does a fillable input transparent only
 * under its own shown label (2026-10-23).
 */
export function presence(element: HTMLElement): "visible" | "faint" | "absent" {
  const miss = presenceMiss(element);
  if (miss === undefined) return "visible";
  return miss === "transparent" || miss === "tiny" ? "faint" : "absent";
}

/**
 * Why {@link presence} does not read a control as `visible`, checked in its order: an
 * attribute hides it (`hidden-attr`: `hidden`, `inert` or `aria-hidden`), it is not
 * rendered otherwise (`not-rendered`), it is moved before the page's start (`off-start`),
 * it is transparent and not fading in or revealed by its label (`transparent`), or it is
 * under 2 pixels wide or high (`tiny`). Undefined when it is visible. For the log only (ADR 0019).
 */
export function presenceMiss(
  element: HTMLElement,
): "hidden-attr" | "not-rendered" | "off-start" | "transparent" | "tiny" | undefined {
  const view = element.ownerDocument.defaultView;
  if (!view) return "not-rendered";
  if (!shown(element, false)) return attributeHidden(element) ? "hidden-attr" : "not-rendered";
  const rect = element.getBoundingClientRect();
  if (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0) return "off-start";
  if (!shown(element)) return "transparent";
  if (rect.width < 2 || rect.height < 2) return "tiny";
  return undefined;
}

export const visible = (element: HTMLElement) => presence(element) === "visible";

/** Whether a control is enabled, also through a disabled fieldset or an ARIA mark. */
export const enabled = (element: HTMLElement) =>
  !element.matches(":disabled") && closestAcross(element, "[aria-disabled='true' i]") === null;
