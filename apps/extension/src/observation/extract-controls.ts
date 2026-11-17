import type { ObservedCandidate } from "@pateat/contracts";
import { closestAcross } from "../page/shadow";
import { scriptControls } from "../page/text";
import { presence } from "../page/presence";
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

export { presence, presenceMiss } from "../page/presence";

export const visible = (element: HTMLElement) => presence(element) === "visible";

/** Whether a control is enabled, also through a disabled fieldset or an ARIA mark. */
export const enabled = (element: HTMLElement) =>
  !element.matches(":disabled") && closestAcross(element, "[aria-disabled='true' i]") === null;
