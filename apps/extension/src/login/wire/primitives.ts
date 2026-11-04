import * as v from "valibot";
import { loginTargetSchema } from "@pateat/contracts";

export const id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
/** Which inputs a secret value may fill; see `acceptsSecret` in `inputs.ts`. */
export const loginSecretKinds = [
  "password",
  "otp",
  "hidden",
  "card-code",
  "card-number",
  "pin",
  "detail",
  "date-part",
  "answer",
] as const;
/**
 * What a secret question's answer is filled under (ADR 0061): its custom field's `name`,
 * which the page's text beside the input must contain, or, for a field named otherwise,
 * the `question` the owner confirmed, which must be one whole question shown there.
 */
export const questionSchema = v.union([
  v.strictObject({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
  v.strictObject({ question: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
]);
export type AskedQuestion = v.InferOutput<typeof questionSchema>;
export type LoginSecretKind = (typeof loginSecretKinds)[number];
export const path = v.pipe(v.string(), v.minLength(1), v.maxLength(300));
/** One target's state: no element, exactly one usable element, several, or one unusable. */
export const targetStateSchema = v.picklist(["missing", "unique", "ambiguous", "unusable"]);
export type TargetState = v.InferOutput<typeof targetStateSchema>;
/**
 * What a target's one element must be to count as `unique`: a shown writable input, a
 * shown enabled button, any shown element, an input of a kind Pateat fills (`input`, shown
 * or not) or such an input shown (`shown-input`), so another page's element with the same
 * locator is never taken for a sign-in field; `present` takes any element. With
 * `described-writable` and `described-clickable`, the writable input or the clickable button
 * must also be visible as the page's description reads it: not hidden from assistive
 * technology, transparent unless it fades in, tiny or moved before the page's start
 * (ADR 0018), as an advance's next step on its own path is measured (ADR 0013).
 * `password-choice` takes a shown button that names the password as the way to confirm the
 * sign-in, enabled or not: by its rendered text (`namesPasswordChoice`, ADR 0048), or with
 * an accessible name by that name and all the text it holds, hidden text too
 * (`namesPasswordControl`, its 2026-10-19 amendment). `authenticator-choice` takes a shown
 * button whose text names an authenticator app's code as the way to confirm the sign-in,
 * enabled or not, and none of whose text, hidden text and accessible name included, names
 * another way (`namesAuthenticatorChoice`, ADR 0081). `settable` takes a writable input or
 * a shown enabled single-choice select, as a `detail` handler's fill of a split date's
 * part may choose an option (ADR 0061).
 */
export const targetRequirementSchema = v.picklist([
  "writable",
  "settable",
  "clickable",
  "described-writable",
  "described-clickable",
  "shown",
  "present",
  "input",
  "shown-input",
  "password-choice",
  "authenticator-choice",
]);
export type TargetRequirement = v.InferOutput<typeof targetRequirementSchema>;
/**
 * The check that decided a target's state, for the log only (ADR 0019): `ok` for `unique`,
 * `missing`, `matches-2` to `matches-9` for several elements (9 or more), or why the one
 * element failed `require`: for an input or button requirement, not seen by the content
 * script's visibility check, under a `hidden` attribute (`hidden-attr`) or not rendered
 * otherwise (`not-rendered`), or seen but disabled, read-only or no such control
 * (`not-writable`, `not-clickable`); or, with `described-writable` or
 * `described-clickable`, the first reason the page's description would not see it
 * (`presenceMiss`: `hidden-attr`, `not-rendered`, `off-start`, `transparent`, `tiny`);
 * `unusable` for another requirement.
 */
export const targetCheckSchema = v.picklist([
  "ok",
  "missing",
  "matches-2",
  "matches-3",
  "matches-4",
  "matches-5",
  "matches-6",
  "matches-7",
  "matches-8",
  "matches-9",
  "not-writable",
  "not-clickable",
  "hidden-attr",
  "not-rendered",
  "off-start",
  "transparent",
  "tiny",
  "unusable",
]);
export type TargetCheck = v.InferOutput<typeof targetCheckSchema>;
/**
 * What confirms an advance whose next step is on its own path (ADR 0013): that step's
 * elements, each measured with `require` just before the advance and after it.
 */
export const inPlaceNextSchema = v.strictObject({
  require: targetRequirementSchema,
  targets: v.pipe(v.array(loginTargetSchema), v.maxLength(20)),
});
export type InPlaceNext = v.InferOutput<typeof inPlaceNextSchema>;

/** Hosts the content script asks the worker about at most (ADR 0031). */
export const hostList = v.pipe(v.array(v.pipe(v.string(), v.maxLength(253))), v.maxLength(256));
export const href = v.pipe(v.string(), v.maxLength(8192));
