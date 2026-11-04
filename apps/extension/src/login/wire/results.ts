import * as v from "valibot";
import { listClickSchema, logoutTargetSchema } from "@pateat/contracts";
import { entryMisses, type ListMiss, otherMisses } from "../../page/account-list";
import { alertMisses } from "../../page/sign-in-state";
import { hostList, href, id, path, targetCheckSchema, targetStateSchema } from "./primitives";
import { LATER_MISSES } from "./readiness";

/**
 * The background's answer to a destination check: allowed only on the document's site,
 * through HTTPS unless the document is HTTP, at a site Pateat may act on, and matched by
 * the login's vault item; `unchecked` when that could not be decided now (ADR 0051).
 */
export const destinationAnswerSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true) }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist([
      "not-authorized",
      "insecure",
      "cross-site",
      "no-site-access",
      "item-mismatch",
      "unchecked",
    ]),
  }),
]);
export type DestinationAnswer = v.InferOutput<typeof destinationAnswerSchema>;

const listCount = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5000));
const buttonFound = v.picklist(["none", "missing", "one", "many"]);
/** What a list showed when nothing on it fits (`ListMiss`), for the log only. */
export const listMissSchema = v.strictObject({
  username: v.picklist(["email", "name", "empty"]),
  entries: listCount,
  masked: v.optional(listCount),
  sameDomain: v.optional(listCount),
  fits: v.optional(listCount),
  entryMiss: v.optional(v.picklist(entryMisses)),
  beside: listCount,
  named: v.optional(listCount),
  other: buttonFound,
  continue: buttonFound,
});
export type ListMissReport = v.InferOutput<typeof listMissSchema>;
// The page's summary and the schema name the same fields, so a field added to only one
// fails here rather than turning every list without a fit into a refused answer.
const listMissFields: [
  Exclude<keyof ListMiss, keyof ListMissReport>,
  Exclude<keyof ListMissReport, keyof ListMiss>,
] extends [never, never]
  ? (miss: ListMiss) => ListMissReport
  : never = (miss) => miss;
void listMissFields;
/**
 * What the list showed a chooser's login would click; `none` when nothing fits, with what
 * the list showed (`miss`).
 */
export const chooseResultSchema = v.variant("ok", [
  v.pipe(
    v.strictObject({
      ok: v.literal(true),
      click: v.picklist([...listClickSchema.options, "none"]),
      miss: v.optional(listMissSchema),
    }),
    v.check((result) => (result.click === "none") === (result.miss !== undefined)),
  ),
  v.strictObject({ ok: v.literal(false) }),
]);
/**
 * Which of the usernames `login.site.account` compared equals the value the page itself
 * set in the recipe's account input, when exactly one does (ADR 0028 amendment of
 * 2026-10-23); `ok: false` otherwise.
 */
export const siteAccountResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    index: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(31)),
  }),
  v.strictObject({
    ok: v.literal(false),
    /** The document compared its inputs' value and answers no more. */
    spent: v.optional(v.literal(true)),
  }),
]);

export type ExecutionDetail = NonNullable<v.InferOutput<typeof executionResultSchema>["detail"]>;
export const executionResultSchema = v.strictObject({
  ok: v.boolean(),
  operationId: id,
  documentId: id,
  mutation: v.picklist(["none", "possible"]),
  /**
   * `value-mismatch`: a value does not fit its input, or a keypad that already shows its
   * keys has no single key for a character of its value; nothing was filled or pressed
   * (`mutation` `none`). A keypad that shows its keys only once its field is pressed, and
   * then lacks one, ends as `structural-mismatch` with `keypad-key-missing`, as that press
   * may have changed the page.
   * `keypad-missing`: a keypad field's keypad is not on the page or not beside the field;
   * `keypad-key-missing`: it showed no key, or a character of the value had no key or
   * several, so no further key was pressed; `keypad-pressed`: the step stopped for any
   * reason but `submitted` after a key press, so the field holds characters the person
   * clears by reloading the page (ADR 0067).
   * `fill-rejected`: after a preparing fill the page marked a filled input invalid or
   * showed a new alert (ADR 0010), or while typing it kept a character out so the input
   * does not hold the value.
   * `submitted`: after a `totp` handler's code fill the page showed that it submits the
   * code by itself (ADR 0027), or after a key press on a keypad the page moved to another
   * path or took the field out of the document, perhaps submitting the characters so far
   * (ADR 0067); nothing was clicked.
   * `captcha`: the page showed a CAPTCHA before a click, so the click was left to the
   * person (ADR 0029, S4); nothing was clicked.
   */
  reason: v.optional(
    v.picklist([
      "structural-mismatch",
      "timeout",
      "cancelled",
      "wrong-account",
      "value-mismatch",
      "fill-rejected",
      "submitted",
      "captcha",
    ]),
  ),
  /**
   * Why a step was `cancelled` or failed, for the local log only (ADR 0019): the worker did
   * not authorize it, this document was cancelled, the operation was used or expired, the
   * page moved to another path, a field changed under the fill, the step threw; or, for a
   * failure, the form was replaced, the target is missing or not writable (or, for a
   * `password` handler's click, its text no longer names the password, ADR 0048), the form
   * changed before a click, an `assert` did not hold, the step was sent values it does not
   * fill, two of its fields name the same input, its fields are in different forms, an
   * input refused its secret, the page's inputs have no value setter, a code field's
   * submission watch could not start, the form or the clicked button would send the form
   * off the document's origin to a destination the background did not allow, or the
   * background could not decide that now (ADR 0051).
   */
  detail: v.optional(
    v.picklist([
      "not-authorized",
      "document-cancelled",
      "operation-used",
      "operation-expired",
      "page-changed",
      "field-changed",
      "threw",
      "form-replaced",
      "target-missing",
      "form-changed",
      "assert-failed",
      "unexpected-values",
      "fields-shared",
      "fields-split",
      "secret-refused",
      "unsupported-input",
      "code-watch-failed",
      "form-off-origin",
      "form-destination-unchecked",
      "keypad-missing",
      "keypad-key-missing",
      "keypad-pressed",
    ]),
  ),
  /**
   * With `wrong-account`: the command's account switch is on the page and can be clicked
   * with `login.switch`. Nothing was filled or clicked.
   */
  switchable: v.optional(v.literal(true)),
  /**
   * With the command's `next`: each of its targets just before the click or the fill's
   * first input, in the same task.
   */
  before: v.optional(v.pipe(v.array(targetStateSchema), v.maxLength(20))),
  /** With the command's `siblings`: each one's targets as `before` measures `next`'s. */
  siblingsBefore: v.optional(
    v.pipe(v.array(v.pipe(v.array(targetStateSchema), v.maxLength(20))), v.maxLength(2)),
  ),
});
/**
 * Why a step's elements were still not ready when its wait ran out, for the log only (ADR
 * 0019): `path` on another path, else the first target's {@link TargetCheck} other than
 * `ok`, else the {@link LaterMiss} of a later step or a password started alone. Never a
 * text or value of the page.
 */
export const AWAIT_MISSES = [
  "path",
  ...targetCheckSchema.options.filter((check) => check !== "ok"),
  ...LATER_MISSES.filter((miss) => miss !== "target"),
] as const;
export type AwaitMiss = (typeof AWAIT_MISSES)[number];
export const awaitResultSchema = v.strictObject({
  ok: v.boolean(),
  /** `revealed`: a password input opened beside the disabled button (`revealed` readiness). */
  reason: v.optional(v.picklist(["timeout", "cancelled", "revealed"])),
  /** With `timeout`, why the step was not ready at the last check. */
  miss: v.optional(v.picklist(AWAIT_MISSES)),
});
/** Why an observation is incomplete; see `ObservationGap`. Value-free codes only. */
export const observationGaps = [
  "unfillable-field",
  "unsupported-control",
  "unlocated-field",
  "unlocated-checkbox",
  "unlocated-button",
  "too-many-fields",
  "too-many-candidates",
  "too-many-accounts",
  "unlisted-accounts",
  "too-many-elements",
  "too-many-controls",
] as const;
/** The page description; validated again against `loginObservationSchema` by the caller. */
export const extractResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    observation: v.unknown(),
    /** Why the observation is incomplete; for diagnostics only. */
    gap: v.optional(v.picklist(observationGaps)),
    /**
     * A signed-in page's description left out a disabled field that may not be a sign-in
     * field: only `signed-in` completes the page (ADR 0029).
     */
    disabledLeftOut: v.optional(v.literal(true)),
    /**
     * The page shows a radio button, select or text area, or an ARIA widget for one, that
     * is no part of a site search: an `optional` answer does not complete it (ADR 0065).
     */
    inputLeftOut: v.optional(v.literal(true)),
  }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.string(),
    /** For `no-candidates`, why no field was described, as codes only; for the log. */
    detail: v.optional(v.pipe(v.string(), v.maxLength(64))),
  }),
]);
/** The answer to `login.entry.hosts`. */
export const entryHostsResultSchema = v.strictObject({ ok: v.literal(true), hosts: hostList });
/**
 * The answer to `login.entry.inspect`: how many elements the target names, and for exactly
 * one, why it may not be pressed apart from where it leads (`refusal`), its `href` and the
 * page's URL, each as the browser resolved it (ADR 0031). For a missing link, what the page
 * shows instead, a sign-in input or a list of accounts by email, and the HTTP status of its
 * load, for the entry's repair (ADR 0041).
 */
export const entryInspectResultSchema = v.strictObject({
  ok: v.literal(true),
  state: v.picklist(["missing", "unique", "ambiguous"]),
  shows: v.optional(v.picklist(["sign-in", "accounts"])),
  status: v.optional(v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599))),
  refusal: v.optional(
    v.picklist(["not-link", "script-link", "hidden", "no-text", "new-window", "download"]),
  ),
  href: v.optional(href),
  url: href,
});
/** The answer to `login.entry.press`: whether the link was clicked, and why not. */
export const entryPressResultSchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.picklist(["page-changed", "target-changed", "cancelled"])),
});
/**
 * The answer to `login.logout.click` (ADR 0063): whether the control was pressed, and why
 * not: it named no shown element or several, its names say it logs out elsewhere or ends
 * the account (`unsafe`), or the page changed or the command was cancelled first.
 */
export const logoutClickResultSchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.picklist(["missing", "ambiguous", "unsafe", "page-changed", "cancelled"])),
  /** With `watchMs`, how the page reacted within it: `none` when it did not. */
  reacted: v.optional(v.picklist(["navigated", "dialog", "changed", "none"])),
});
/** The answer to `login.logout.local` (ADR 0063). */
export const localLogoutResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), target: logoutTargetSchema }),
  v.strictObject({
    ok: v.literal(false),
    reason: v.picklist(["none", "ambiguous", "unlocated"]),
  }),
]);
/**
 * The answer to `login.entry.check`, for the page after an entry press (ADR 0031). `signIn`
 * also holds for an input that asks for an account identifier alone (ADR 0016).
 */
export const entryCheckResultSchema = v.strictObject({
  ok: v.literal(true),
  signIn: v.boolean(),
  start: v.boolean(),
  signUp: v.boolean(),
  /**
   * Without a sign-in input, a list of accounts the page shows (ADR 0028), as it would be
   * announced: `names` without an email listed, and `other` for a control for another
   * account. A passkey-only recipe's page is repaired as such a list (ADR 0079).
   */
  list: v.optional(
    v.strictObject({
      names: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))), v.maxLength(32)),
      ),
      other: v.optional(v.literal(true)),
    }),
  ),
});
/** The answer to `login.state`: the page signs as flags only (ADR 0029). */
export const stateResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    signs: v.strictObject({
      password: v.boolean(),
      code: v.boolean(),
      captcha: v.boolean(),
      invalid: v.boolean(),
      alert: v.boolean(),
      /** Why `alert` does not hold on a sign-in form shown again, for the log only. */
      alertMiss: v.optional(v.picklist(alertMisses)),
      username: v.optional(v.boolean()),
    }),
    /** Whether the document has finished loading; the login completes only then. */
    loaded: v.boolean(),
  }),
  v.strictObject({ ok: v.literal(false) }),
]);
export const observationSchema = v.strictObject({
  path: v.string(),
  targets: v.pipe(v.array(targetStateSchema), v.maxLength(24)),
  /**
   * With `signIn` asked: whether the page has finished loading, and whether it shows a
   * visible writable password input (`password`) or an email input or one marked for a
   * username or an email address (`identifier`) that is none of the asked targets, outside
   * any form with a `new-password` or `one-time-code` input.
   */
  signIn: v.optional(
    v.strictObject({ loaded: v.boolean(), password: v.boolean(), identifier: v.boolean() }),
  ),
  /** With `explain` asked: per target, the check that decided its state. */
  checks: v.optional(v.pipe(v.array(targetCheckSchema), v.maxLength(24))),
});
