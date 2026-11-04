import * as v from "valibot";
import { entryMisses, otherMisses } from "../../page/account-list";
import { id, path } from "./primitives";
import { loginReadinessSchema, shownLaterSchema, startMissSchema } from "./readiness";

/**
 * Why a page offered for generation sent nothing by the end of the step wait: it showed no
 * list of accounts, sign-in entry or identifier input when its offer wait ended (ADR 0057)
 * and no sign-in input since (`no-list`), it is the page right after a submitted password
 * form (`after-sign-in`), a sign-in input showed only at the end of the wait
 * (`sign-in-shown`), or it shows a `type="text"` input named as a secret answer, which
 * looks like a verification but is never sent (`text-answer`, ADR 0035). `frame`: a frame,
 * which is never sent, showed a sign-in input or such an answer within the step wait after
 * the worker asked it to report one (ADR 0035).
 */
export const unofferedReasons = [
  "no-list",
  "after-sign-in",
  "sign-in-shown",
  "text-answer",
  "frame",
] as const;

export const helloSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.ready"),
  token: id,
  /** The first step's elements are ready on this path; a new attempt may start. */
  start: v.optional(v.strictObject({ path })),
  /**
   * The document changed in place after Pateat clicked an account switch in it, and is
   * announced as a new page (ADR 0078).
   */
  switched: v.optional(v.literal(true)),
  /**
   * A visible password, username or one-time-code input shows on this path, so a page
   * without a recipe may be sent for generation (ADR 0016); `identifier` when the page,
   * after the offer wait (ADR 0057), asks for an account identifier alone instead, or
   * `passkey` when it shows a button that signs in with a passkey and no identifier input
   * (ADR 0053). A passkey page also carries the `list` and `entry` it would otherwise be
   * announced with, used when no matching item holds a discoverable passkey.
   */
  signIn: v.optional(
    v.pipe(
      v.strictObject({
        path,
        identifier: v.optional(v.literal(true)),
        passkey: v.optional(v.literal(true)),
      }),
      v.check(
        (signIn) => !(signIn.identifier && signIn.passkey),
        "A page asks for an identifier or shows a passkey button, not both",
      ),
    ),
  ),
  /**
   * Such an input shows on this path but no first step is ready; sent once per path, for
   * the log of a login that did not start. On a page the worker named a verification
   * Pateat does not fill (`confirm` in its answer), it is sent as soon as that page's first
   * step shows, with `amount`: whether an amount (`¥`, `円` or `$` with digits) shows in the
   * form of that step's elements, never the amount, and absent when they are in no form
   * (ADR 0035). On a path where a first step is watched, the page may instead ask for an
   * identifier alone (ADR 0016), and `miss` says what the first steps there missed, for a
   * stale recipe's repair (ADR 0041). There, `accounts` says the page lists accounts by
   * email instead (ADR 0028), as a start page that became a list of accounts.
   */
  shown: v.optional(
    v.strictObject({
      path,
      amount: v.optional(v.boolean()),
      miss: v.optional(startMissSchema),
      /** The later steps on this path, for the log (`ShownLater`, ADR 0049). */
      later: v.optional(shownLaterSchema),
      accounts: v.optional(v.literal(true)),
    }),
  ),
  /**
   * After the offer wait (ADR 0057), this path shows no sign-in input but lists accounts (ADR
   * 0028): an entry or a text beside at most three buttons with an email, masked or not.
   * Without one, `names` are the short texts that may name an account by a username that
   * is not an email, for the background to compare with the matching items' usernames.
   * `other` says that the page also shows a control to sign in with another account, so
   * the list is sent even when no text names an item, or, for a list by email, when no
   * matching item's username is an email. Without one, `otherMiss` says why words for another
   * account showed but no such control counts, and `missed` why a text with an email
   * address is not an entry, both for the log only.
   */
  list: v.optional(
    v.strictObject({
      path,
      names: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(64))), v.maxLength(32)),
      ),
      other: v.optional(v.literal(true)),
      otherMiss: v.optional(v.picklist(otherMisses)),
      missed: v.optional(v.picklist(entryMisses)),
    }),
  ),
  /**
   * No sign-in input and no ready first step showed on this path within the offer wait
   * (ADR 0057), so the page may be sent as a site's sign-in entry (ADR 0031).
   */
  entry: v.optional(v.strictObject({ path })),
  /**
   * The page was offered for generation, but nothing was sent by the end of the step wait:
   * why, for the log only (ADR 0019).
   */
  unoffered: v.optional(v.strictObject({ path, why: v.picklist(unofferedReasons) })),
});
/**
 * A form with a password input was submitted in this document by anyone, Pateat or the
 * person: the tab's next page of the origin is never sent as a list of accounts (ADR 0028)
 * or as a sign-in entry (ADR 0031).
 */
export const submittedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.submitted"),
  token: id,
});
/**
 * The path of this document changed in place (history.pushState or replaceState, or a back
 * or forward move) while the last status the worker sent it names no ended login: for a
 * login watched in it after its submission, a single-page site's route is the tab's next
 * page (ADR 0027 amendment of 2026-10-25). No URL is sent; the worker asks the document.
 */
export const movedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.moved"),
  token: id,
});
/**
 * The page a `login.extract.watch` waits for shows something to describe (ADR 0027
 * amendment of 2026-11-04). Nothing of the page is sent; the worker reads it as it reads a
 * new page.
 */
export const describedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.described"),
  token: id,
});
/**
 * The person submitted the form of a page the worker named a verification Pateat does not
 * fill (ADR 0035): a trusted `submit` event of the form that holds the page's first step,
 * reported before the page leaves. No button text or value is sent.
 */
export const personSubmittedSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.document.person-submitted"),
  token: id,
});
/**
 * The answer to a hello. `starts` lists the first steps of the origin's recipes; the
 * document announces again with `start` once one of them is ready on the current path. A
 * refused hello carries them, and so does an accepted one of a watched login (ADR 0027).
 */
export const readySchema = v.strictObject({
  ok: v.boolean(),
  reason: v.optional(v.string()),
  starts: v.optional(v.pipe(v.array(loginReadinessSchema), v.maxLength(32))),
  /** The page may be sent for generation; announce again with `signIn` once it applies. */
  generate: v.optional(v.literal(true)),
  /**
   * With `generate`: the page's URL names another path of its site, so it may be sent as a
   * sign-in entry; announce again with `entry` when no sign-in input showed (ADR 0031).
   */
  entry: v.optional(v.literal(true)),
  /**
   * A recipe generated as `confirm` or `unclear` starts on this path, so Pateat only watches
   * (ADR 0035): its first step, whose showing the document reports with `shown`, and whose
   * form's trusted submission it reports with `login.document.person-submitted`.
   */
  confirm: v.optional(loginReadinessSchema),
  /**
   * The document is a frame, which is never sent for generation: it announces once with
   * `unoffered` `frame` if a sign-in input or a secret answer shows within the step wait,
   * so such pages are counted (ADR 0035).
   */
  frame: v.optional(v.literal(true)),
});
export const reconnectSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.reconnect"),
  /**
   * The person chose the site's default account for this tab in the popup (ADR 0021,
   * amended 2026-11-04): the document announces as a new page, so its login starts now,
   * and a sign-in form it shows may be offered for generation once more, also one shown
   * after its window to be sent closed.
   */
  fresh: v.optional(v.literal(true)),
});
export const authorizeSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.operation.authorize"),
  token: id,
  attemptId: id,
  operationId: id,
});
/**
 * Tells the background, just before the first key press of a fill on a page's software
 * keyboard, that keys are pressed from now on (ADR 0067). The background answers `true`
 * while the operation is still the attempt's own and still authorized, and only then is a
 * key pressed; only then may a document that replaces the page count as the page's own
 * submission of the fill.
 */
export const keypadPressSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.keypad.press"),
  token: id,
  attemptId: id,
  operationId: id,
});
/**
 * Asks whether a step's form may submit to `destination`, an HTTP(S) URL off the document's
 * origin (ADR 0051). The background answers with {@link destinationAnswerSchema}.
 */
export const destinationCheckSchema = v.strictObject({
  version: v.literal(1),
  type: v.literal("login.destination.check"),
  token: id,
  attemptId: id,
  operationId: id,
  destination: v.pipe(v.string(), v.maxLength(8192)),
});
