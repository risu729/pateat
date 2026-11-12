import * as v from "valibot";
import { parseSiteUrl, recipeSlotIdSchema } from "../settings";

export const loginIdentifierSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
export const identifier = loginIdentifierSchema;
export const revision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);
export const loginOriginSchema = v.pipe(
  v.string(),
  v.maxLength(300),
  v.check((value) => parseSiteUrl(value)?.origin === value, "Use an exact HTTP(S) origin"),
);
export const path = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(300),
  v.regex(/^\/(?!\/)[^?#\\\s]*$/),
  v.check(
    (value) => new URL(value, "https://example.test").pathname === value,
    "Use an exact canonical path",
  ),
);
/** An exact canonical URL path, as recipe steps and observations carry it. */
export const loginPathSchema = path;
export const unique = (values: string[]) => new Set(values).size === values.length;
/**
 * `autocomplete` tokens an input can be located by. `new-password` is left out: a
 * recipe never names a field for a new password. `webauthn` marks the field a passkey
 * fills, which tells it from another field with the same first token, such as a hidden
 * copy of the password field.
 */
export const loginAutocompleteTokens = [
  "username",
  "email",
  "current-password",
  "one-time-code",
  "webauthn",
] as const;
/**
 * An attribute locator: the element whose `id`, `name`, `data-testid` or `data-test` equals the
 * value, or the `<input>` whose `autocomplete` attribute holds the token among its
 * whitespace-separated tokens, ignoring case (for fields with no `id` or `name`, such as
 * `autocomplete="username webauthn"`). `id` and `name` take any ASCII except whitespace
 * and control characters, as ASP.NET (`ctl00$Main$txtUserId`) and Rails (`user[login]`)
 * names need; the executor compares attribute strings, so the value never becomes a
 * selector.
 */
const attributeValue = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[\x21-\x7e]+$/u),
);
const testIdValue = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
/**
 * The shadow hosts a locator looks inside (ADR 0070), outermost first: each the one
 * element whose `id`, `name`, `data-testid` or `data-test` equals its value, the first among the
 * page's elements and each later one among those of the shadow tree of the host before
 * it, nested trees included. The locator then names the one element among those of the
 * last host's shadow tree. Only for an element of a shadow tree that no locator names
 * once in the whole page, as an input every component of a page reuses its inner ID for.
 */
export const loginHostChainSchema = v.pipe(
  v.array(
    v.variant("by", [
      v.strictObject({ by: v.picklist(["id", "name"]), value: attributeValue }),
      v.strictObject({ by: v.picklist(["test-id", "data-test"]), value: testIdValue }),
    ]),
  ),
  v.minLength(1),
  v.maxLength(3),
);
const within = v.optional(loginHostChainSchema);
export const loginAttributeTargetSchema = v.variant("by", [
  v.strictObject({ by: v.picklist(["id", "name"]), value: attributeValue, within }),
  // `data-test` is the test attribute some pages use instead (Duolingo's sign-in
  // submit, 2026-10-23; ADR 0071).
  v.strictObject({ by: v.picklist(["test-id", "data-test"]), value: testIdValue, within }),
  v.strictObject({
    by: v.literal("autocomplete"),
    value: v.picklist(loginAutocompleteTokens),
    within,
  }),
]);
/**
 * A button locator: the one button whose text equals the value. The text is a
 * `<button>`'s rendered text, an `<input type="submit|button">`'s value, an
 * `<input type="image">`'s alt, or the rendered text of an `<a>` that runs a script
 * instead of following a link (no `href` but an `onclick` or `role="button"`, a
 * `javascript:` URL, or an empty or fragment-only `href` with either), with whitespace
 * collapsed to single spaces and format characters removed. Native buttons are matched
 * first; such links only when no native button shows the text. It matches buttons only,
 * so fills never use it; a recipe's `accountSwitch` and completion markers alone also
 * match another `<a href>` link by its rendered text (or an image-only link's `alt`)
 * when no button shows it.
 */
export const loginTextTargetSchema = v.strictObject({
  by: v.literal("text"),
  value: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(120),
    v.regex(/^[^\s\p{Cc}\p{Cf}]+(?: [^\s\p{Cc}\p{Cf}]+)*$/u),
  ),
});
/**
 * A field locator by its visible name (ADR 0037): the one shown fillable `<input>` (text,
 * email, tel, number or password) whose name equals the value. The name is the rendered
 * text of the elements its `aria-labelledby` names, else of its `<label>` elements, else
 * its `aria-label`, else its `placeholder`, the first that is not empty, with whitespace
 * collapsed to single spaces and format characters removed, and at most 120 characters.
 * It names fields only, for a field with no unique `id`, `name`, `data-testid` or
 * `autocomplete` locator but a stable one; hidden inputs never match. A control is named
 * by its accessible name with {@link loginAccessibleNameTargetSchema} instead, which is
 * counted apart, so a button and a field with the same name never make either ambiguous.
 */
export const loginLabelTargetSchema = v.strictObject({
  by: v.literal("label"),
  value: loginTextTargetSchema.entries.value,
  within,
});
/**
 * A control locator by its accessible name (ADR 0048 amendment of 2026-10-19): the one
 * shown control whose name equals the value. The name is the rendered text of the
 * elements its `aria-labelledby` names, else its `aria-label`, the first that is not
 * empty, with whitespace collapsed to single spaces and format characters removed, and
 * at most 120 characters. A control is a button or a script button, as a text locator
 * matches them, or a link to a fragment of its own document that opens in the same tab
 * and downloads nothing (`<a href="#">`); fields never match. It names a `password`
 * handler's button, such as `<a href="#" aria-label="Select Password.">Select</a>` beside
 * another "Select" for a phone, or a route step's click on a login form's button (ADR 0048
 * amendment of 2026-10-23), such as an `<input type="submit">` without a `value` labelled
 * by the text beside it, when no `id`, `name`, `data-testid` or unique text names it; a
 * route step's click never presses a fragment link by it. Wait and assert steps, the
 * `passkey` route, other handlers, signed-in markers, the rejection and the account
 * switch never use it.
 */
export const loginAccessibleNameTargetSchema = v.strictObject({
  by: v.literal("accessible-name"),
  value: loginTextTargetSchema.entries.value,
});
/**
 * A field locator by its `name` within the sign-in form (ADR 0072): the one shown
 * element whose `name` equals the value and whose form also holds a shown password input
 * not marked `new-password`, as the account field beside Hacker News's password, whose
 * create-account form below shares the names `acct` and `pw`. It names fields only, for a
 * field that no other locator names alone.
 */
export const loginPasswordFormNameTargetSchema = v.strictObject({
  by: v.literal("password-form-name"),
  value: loginAttributeTargetSchema.options[0].entries.value,
});
/**
 * A locator a fill names its field by: an attribute one, the field's visible name, or its
 * name within the sign-in form.
 */
export const loginFieldTargetSchema = v.variant("by", [
  ...loginAttributeTargetSchema.options,
  loginLabelTargetSchema,
  loginPasswordFormNameTargetSchema,
]);
/**
 * An allowlisted element locator; recipes cannot supply CSS, code, URLs or values. A recipe
 * uses an accessible-name locator only for a `password` handler's button or a route step's
 * click.
 */
export const loginTargetSchema = v.variant("by", [
  ...loginAttributeTargetSchema.options,
  loginTextTargetSchema,
  loginLabelTargetSchema,
  loginAccessibleNameTargetSchema,
  loginPasswordFormNameTargetSchema,
]);
/**
 * A signed-in marker's link locator (ADR 0029): the one `<a href>` link to the page's own
 * origin whose path equals the value, such as an account link to `/my` whose text is the
 * person's nickname (owner's choice, 2026-10-13). Letters, `-`, `.`, `_`, `~` and `/`
 * only, so the path never carries a number, an ID or a percent-encoded name; the link's
 * query and fragment are not compared. Only completion markers use it.
 */
export const loginLinkTargetSchema = v.strictObject({
  by: v.literal("href"),
  value: v.pipe(v.string(), v.maxLength(120), v.regex(/^(?:\/[A-Za-z._~-]+)+\/?$/u)),
});
/** A signed-in marker's locator: any element locator, or a link by its path. */
export const loginMarkerTargetSchema = v.variant("by", [
  ...loginTargetSchema.options,
  loginLinkTargetSchema,
]);
/**
 * The element that holds a page's software keyboard (ADR 0067): an `id`, `data-testid`
 * or class locator of the keypad's container or an ancestor of it, or its position from
 * the field (owner's choice, 2026-10-23 13:01 UTC). A class names the one element of the
 * document whose class list holds the value. A position is `<up>:<path>`: from the field
 * up that many parents, then down the child elements at each index of the dot-separated
 * path, as `3:1.0`. A class or a position names the keypad only while the element it
 * finds holds the page's one keypad. A fill field that names one takes its characters
 * only from the keypad's keys, one press per character, and may be read-only. The recipe
 * carries no key, label or layout: the executor reads the keys on the page.
 */
export const loginKeypadTargetSchema = v.variant("by", [
  v.strictObject({
    by: v.literal("id"),
    value: loginAttributeTargetSchema.options[0].entries.value,
  }),
  loginAttributeTargetSchema.options[1],
  v.strictObject({
    by: v.literal("class"),
    value: v.pipe(v.string(), v.maxLength(120), v.regex(/^-?[A-Za-z_][A-Za-z0-9_-]*$/u)),
  }),
  v.strictObject({
    by: v.literal("position"),
    value: v.pipe(
      v.string(),
      v.regex(/^(?:[1-9]|1\d|20):(?:0|[1-9]\d?)(?:\.(?:0|[1-9]\d?)){0,11}$/u),
    ),
  }),
]);
const fields = v.pipe(
  v.array(
    v.strictObject({
      slot: recipeSlotIdSchema,
      target: loginFieldTargetSchema,
      keypad: v.optional(loginKeypadTargetSchema),
    }),
  ),
  v.minLength(1),
  v.maxLength(20),
  v.check((entries) => unique(entries.map((entry) => entry.slot)), "Duplicate fill slots"),
  v.check(
    (entries) => unique(entries.map((entry) => JSON.stringify(entry.target))),
    "Duplicate fill targets",
  ),
);
export const loginStepSchema = v.variant("kind", [
  v.pipe(
    v.strictObject({
      kind: v.literal("fill"),
      path,
      fields,
      effect: v.optional(v.picklist(["prepare", "advance", "submit"]), "prepare"),
      event: v.optional(v.picklist(["input", "change"])),
    }),
    v.check(
      (step) =>
        step.effect === "prepare"
          ? step.event === undefined
          : step.fields.length === 1 && step.event !== undefined,
      "Effectful fill requires one field and one trigger event",
    ),
    v.check(
      (step) => step.effect === "prepare" || step.fields.every((field) => !field.keypad),
      "A keypad field is entered by a preparing fill",
    ),
  ),
  v.pipe(
    v.strictObject({
      kind: v.literal("click"),
      path,
      target: loginTargetSchema,
      purpose: v.picklist(["advance", "submit"]),
      /**
       * For a form that shows no button to press (ADR 0064): the target is the field the
       * fill just before typed last, and the step submits that field's form as pressing
       * Enter there does instead of clicking anything.
       */
      press: v.optional(v.literal("enter")),
    }),
    v.check(
      (step) =>
        step.press === undefined ||
        (step.target.by !== "text" && step.target.by !== "accessible-name"),
      "Enter is pressed in a field",
    ),
  ),
  v.strictObject({
    kind: v.literal("wait"),
    path,
    target: loginTargetSchema,
    present: v.boolean(),
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(15000)),
  }),
  v.strictObject({
    kind: v.literal("assert"),
    path,
    target: loginTargetSchema,
    present: v.boolean(),
  }),
]);
export const stepTargetCount = (step: v.InferOutput<typeof loginStepSchema>) =>
  step.kind === "fill" ? step.fields.length : 1;
/**
 * Ways a start page offers to sign in (ADR 0027); one is chosen from the item's facts
 * when a login starts. `password` runs the recipe's steps; `passkey` clicks the start
 * page's passkey sign-in button.
 */
export const loginRouteSchema = v.picklist(["password", "passkey"]);
export type LoginTarget = v.InferOutput<typeof loginTargetSchema>;
export type LoginMarkerTarget = v.InferOutput<typeof loginMarkerTargetSchema>;
/** Whether a locator may name a step's or a handler's element: any but a link's path. */
export const isLoginTarget = (target: LoginMarkerTarget): target is LoginTarget =>
  target.by !== "href";
/**
 * Whether a locator may name any route step's element, or a handler's other than a
 * `password` handler's button: neither a link's path (ADR 0029) nor an accessible name
 * (ADR 0048 amendment of 2026-10-19), which a route step's click alone may also use
 * (ADR 0048 amendment of 2026-10-23).
 */
export const isStepTarget = (
  target: LoginMarkerTarget,
): target is Exclude<LoginTarget, { by: "accessible-name" }> =>
  target.by !== "href" && target.by !== "accessible-name";
/** Whether two locators name the same element: the same kind and value, in the same hosts. */
export const sameLoginTarget = (left: LoginMarkerTarget, right: LoginMarkerTarget) =>
  left.by === right.by &&
  left.value === right.value &&
  sameHosts(
    "within" in left ? left.within : undefined,
    "within" in right ? right.within : undefined,
  );
const sameHosts = (left?: LoginHostChain, right?: LoginHostChain) =>
  (left?.length ?? 0) === (right?.length ?? 0) &&
  (left ?? []).every(
    (host, index) => host.by === right![index]!.by && host.value === right![index]!.value,
  );
export type LoginHostChain = v.InferOutput<typeof loginHostChainSchema>;
/** A locator's value and the values of the hosts it looks inside (ADR 0070). */
export const targetValues = (target: LoginMarkerTarget): string[] => [
  target.value,
  ...("within" in target ? (target.within ?? []) : []).map((host) => host.value),
];
export type LoginAttributeTarget = v.InferOutput<typeof loginAttributeTargetSchema>;
export type LoginFieldTarget = v.InferOutput<typeof loginFieldTargetSchema>;
export type LoginKeypadTarget = v.InferOutput<typeof loginKeypadTargetSchema>;
export type LoginStep = v.InferOutput<typeof loginStepSchema>;
export type LoginEffect = "prepare" | "advance" | "submit";
export function loginStepEffect(step: LoginStep): LoginEffect | undefined {
  return step.kind === "fill" ? step.effect : step.kind === "click" ? step.purpose : undefined;
}
/**
 * Whether a fill presses keys on a page's software keyboard (ADR 0067). Its fill prepares,
 * but the page may act on a press, as a PIN pad that submits at its last digit does.
 */
export const keypadStep = (step: LoginStep): boolean =>
  step.kind === "fill" && step.fields.some((field) => field.keypad !== undefined);
