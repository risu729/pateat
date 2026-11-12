import * as v from "valibot";
import { loginDocumentSchema, loginRouteSchema, recipeLayoutKeySchema } from "../login";
import {
  integer,
  MAX_ATTEMPT_STEPS,
  WATCH_PATH_MAX,
  identifier,
  MAX_RECIPE_STEPS,
  MAX_RECIPE_EFFECTS,
  MAX_ATTEMPT_SUBMISSIONS,
} from "./schema-primitives";

export const loginAttemptEventSchema = v.variant("type", [
  v.strictObject({ type: v.literal("RESOLVE") }),
  v.strictObject({ type: v.literal("FILL_EXPIRED") }),
  v.strictObject({ type: v.literal("FILL_CONTINUING"), after: integer(MAX_ATTEMPT_STEPS) }),
  v.strictObject({ type: v.literal("FILL_UNCONTINUED"), after: integer(MAX_ATTEMPT_STEPS) }),
  v.strictObject({ type: v.literal("FILL_PROGRESS"), stepIndex: integer(MAX_ATTEMPT_STEPS) }),
  v.strictObject({
    type: v.literal("FILL_BASELINE"),
    nextStep: integer(MAX_ATTEMPT_STEPS),
    path: v.pipe(v.string(), v.startsWith("/"), v.maxLength(WATCH_PATH_MAX)),
    ready: v.boolean(),
  }),
  v.strictObject({
    type: v.literal("PREPARE"),
    operationId: identifier,
    kind: v.picklist(["fill", "click", "wait", "assert"]),
    effect: v.optional(v.picklist(["prepare", "advance", "submit"])),
    /**
     * The step's fill may make the page submit by itself, as a PIN pad at its last key or
     * a code input at its last digit (the extension's `selfSubmitStep`).
     */
    presses: v.optional(v.literal(true)),
  }),
  v.strictObject({ type: v.literal("MUTATION_INTENT"), operationId: identifier }),
  v.strictObject({ type: v.literal("OPERATION_OK"), operationId: identifier }),
  v.strictObject({ type: v.literal("SUBMIT_INTENT"), operationId: identifier }),
  v.strictObject({ type: v.literal("SUBMITTED"), operationId: identifier }),
  v.pipe(
    v.strictObject({
      type: v.literal("OBSERVED"),
      result: v.picklist([
        "continue",
        "authenticated",
        "credential-rejected",
        "challenge",
        "unknown",
      ]),
      document: v.optional(loginDocumentSchema),
      unconfirmed: v.optional(v.literal(true)),
    }),
    v.check(
      (event) => event.unconfirmed === undefined || event.result === "authenticated",
      "Only an authenticated observation can be unconfirmed",
    ),
  ),
  /**
   * `signedIn`: the runtime confirmed that a top-level move to another origin finished the
   * sign-in, as after a passkey answer for that site (ADR 0022). Only an attempt that may
   * have submitted then completes; any other move to another origin ends it as before.
   */
  v.strictObject({
    type: v.literal("NAVIGATED"),
    document: loginDocumentSchema,
    signedIn: v.optional(v.literal(true)),
  }),
  v.strictObject({ type: v.literal("INTERRUPTED") }),
  /**
   * The tab's top page is no web page Pateat can read, as `about:blank` or a browser page,
   * once the login's wait for the site ran out (ADR 0022, amended 2026-11-04): a top-level
   * attempt ends as a move to another origin would.
   */
  v.strictObject({ type: v.literal("LEFT") }),
  v.strictObject({
    type: v.literal("FAILED"),
    reason: v.picklist(["structural-mismatch", "timeout"]),
    mutation: v.optional(v.picklist(["none", "possible"])),
    operationId: v.optional(identifier),
    document: v.optional(loginDocumentSchema),
  }),
  /**
   * The page shows another account than the selected one, found before any mutation of
   * this fill. It ends the attempt without a retry; `switched` records that the recipe's
   * account switch was clicked.
   */
  v.strictObject({
    type: v.literal("WRONG_ACCOUNT"),
    operationId: identifier,
    document: loginDocumentSchema,
    switched: v.optional(v.literal(true)),
  }),
  /**
   * The page would not accept this fill's values (ADR 0010): `before-fill` when a value
   * does not fit its input and nothing was filled, `after-fill` when the page rejected
   * a preparing fill, `code-refused` when the page kept a character of a TOTP code typed as
   * its own submission out of an input it still shows (ADR 0027 amendment of 2026-10-23),
   * so it never had the whole code. It ends the attempt without a retry, since the same
   * values would be rejected again. `challenge` marks a `detail` handler's value split over
   * several inputs that fits none of them, as when no option of a select matches its part
   * (ADR 0061): nothing was filled and the page is left to the person as a challenge.
   */
  v.strictObject({
    type: v.literal("VALUE_REJECTED"),
    operationId: identifier,
    document: loginDocumentSchema,
    stage: v.picklist(["before-fill", "after-fill", "code-refused"]),
    challenge: v.optional(v.literal(true)),
  }),
  /**
   * The attempt takes over a newer revision of its recipe that only adds handlers or
   * signed-in markers (`extendsRecipe`, ADR 0027); the runtime checks that before sending it.
   */
  v.strictObject({
    type: v.literal("REVISED"),
    recipeRevision: integer(Number.MAX_SAFE_INTEGER - 1),
  }),
  /**
   * A page after the current effect step is about to be sent to be judged. It counts
   * against the step's pages before the request, so a restart cannot resend without
   * bound (ADR 0027). A login watched at its stop (ADR 0036) has no step in flight, so its
   * watch's pages name none.
   */
  v.strictObject({ type: v.literal("JUDGING"), operationId: v.optional(identifier) }),
  /** The page sent under `JUDGING` reached no model, so it is given back. */
  v.strictObject({ type: v.literal("UNJUDGED"), operationId: v.optional(identifier) }),
  /**
   * The watch of a login (ADR 0027) is over: it ends where it stopped, `challenge` or an
   * unknown result, and its later pages are no longer read. `abandoned`: the recipe's first
   * step showed again before the login signed in, so it ends `challenge-abandoned` from a
   * `challenge`, else `watch-abandoned`.
   */
  v.strictObject({ type: v.literal("WATCH_ENDED"), abandoned: v.optional(v.literal(true)) }),
  /**
   * The page after the final `advance` step `operationId` is about to be sent to continue
   * the recipe (ADR 0018). Recorded before the request: one request per effect step.
   */
  v.strictObject({ type: v.literal("CONTINUING"), operationId: identifier }),
  /**
   * The page at plan step `before`, the final `advance` click whose button stayed disabled
   * while a password input opened, is about to be sent to replace that click (ADR 0018
   * amendment of 2026-11-03). Recorded before the request: one request per such step.
   */
  v.strictObject({ type: v.literal("CONTINUING"), before: integer(MAX_ATTEMPT_STEPS) }),
  /** The request sent under `CONTINUING` reached no model, so it is given back. */
  v.strictObject({ type: v.literal("UNCONTINUED"), operationId: identifier }),
  v.strictObject({ type: v.literal("UNCONTINUED"), before: integer(MAX_ATTEMPT_STEPS) }),
  /**
   * The attempt takes over the revision that continues its recipe on the page after its
   * final `advance` step (`continuesRecipe`, ADR 0018): its `steps` follow that step, and
   * its `effects` grow the submission budget. The runtime checks the revision and that it
   * resolves to the attempt's account before sending it. A login whose stop lay just past
   * its plan's last step names its new stop among or just past those steps (`stopAt`, ADR
   * 0036): the step that fills the password, which never runs.
   */
  v.strictObject({
    type: v.literal("CONTINUED"),
    recipeRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    steps: v.pipe(integer(MAX_RECIPE_STEPS), v.minValue(1)),
    effects: v.pipe(integer(MAX_RECIPE_EFFECTS), v.minValue(1)),
    document: loginDocumentSchema,
    stopAt: v.optional(v.pipe(integer(MAX_ATTEMPT_STEPS), v.minValue(1))),
    /**
     * The `steps` replace the plan's final `advance` click the attempt is at, which never
     * ran (`continuation.before`), instead of following it; that click's effect is no
     * longer counted (ADR 0018 amendment of 2026-11-03).
     */
    replacesLast: v.optional(v.literal(true)),
  }),
  /**
   * The login runs another layout of its recipe from here on (ADR 0060): one whose steps
   * before the step at hand are the attempt's own, and whose step there shows on the page
   * while the attempt's own does not. After an effect step that may have advanced, the login
   * goes on to that step, as on `OBSERVED` `continue`; with nothing in flight it stays at its
   * step. `steps` and `maxSubmissions` are the layout's, and `recipeRevision` the revision it
   * was read from. Only a `password` login on its recipe's own steps (variant 0) switches,
   * with no handler entered, no stop, no chooser and not only filling; the runtime checks the
   * layout's earlier steps and the account's plan on it before sending it.
   */
  v.strictObject({
    type: v.literal("LAYOUT"),
    layout: recipeLayoutKeySchema,
    recipeRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    steps: v.pipe(integer(MAX_ATTEMPT_STEPS), v.minValue(1)),
    maxSubmissions: v.pipe(integer(MAX_ATTEMPT_SUBMISSIONS), v.minValue(1)),
    document: loginDocumentSchema,
  }),
  /**
   * After an effect step, the page shows the recipe's handler `handler` (its index in the
   * recipe's handlers): its `steps` follow the effect step, and its `effects` grow the
   * submission budget (ADR 0027). At a login's stop before its item's missing password, with
   * nothing in flight, a `passkey` handler's steps go in before the stop step instead, which
   * moves along (ADR 0036, owner 2026-10-13 05:39 UTC); the runtime checks the kind.
   */
  v.strictObject({
    type: v.literal("HANDLER"),
    handler: integer(15),
    /** A `detail` handler's input that the login fills (ADR 0061). */
    field: v.optional(integer(2)),
    steps: v.pipe(integer(4), v.minValue(1)),
    effects: v.pipe(integer(4), v.minValue(1)),
    document: loginDocumentSchema,
  }),
  /**
   * The page submitted a TOTP code by itself (ADR 0027), as a code input that submits on
   * its last digit does: after the code's fill, before its click found the button. The
   * click step counts as done by the page under `operationId`, a new effect step, so the
   * page is settled and judged as after a click; the code is never filled again.
   * `routeStep` marks a route step's code rather than a `totp` handler's. The runtime checks that the
   * steps are such a code's fill and click.
   */
  v.strictObject({
    type: v.literal("AUTO_SUBMITTED"),
    operationId: identifier,
    routeStep: v.optional(v.literal(true)),
  }),
  /**
   * A login of an item without a password reached its stop (ADR 0036) and its document's
   * passkey request is answered there with its item: the answer counts as a submission
   * under `operationId`, a new click step at the stop, so the page is settled and judged as
   * after a click. Recorded before a waiting request is answered, or once the passkey
   * bridge answered one.
   */
  v.strictObject({ type: v.literal("STOP_ANSWERED"), operationId: identifier }),
  /**
   * Such a login at its stop, with no passkey request in time, sends the page there to be
   * judged so a `passkey` handler can be learned for its button (ADR 0036, owner 2026-10-13
   * 05:39 UTC). Once per attempt, recorded before the request.
   */
  v.strictObject({ type: v.literal("STOP_JUDGING") }),
  /**
   * A chooser's list shows no account that fits the login's own, and no button for another
   * account (ADR 0028): the login ends before its first step, as `account-not-listed`.
   */
  v.strictObject({ type: v.literal("NOT_LISTED") }),
  /**
   * The login changes route (ADR 0034), with `steps`, the new route's step count. Before
   * anything was submitted, a `password` login switches to the `passkey` route when the
   * start page asks for a passkey by itself, or back when that request goes away, once
   * each way. After
   * the `passkey` route's answer, a page that still shows the sign-in form falls back to
   * the `password` route's recorded variant, once. The runtime checks the recipe.
   */
  v.strictObject({
    type: v.literal("ROUTE"),
    route: loginRouteSchema,
    steps: v.pipe(integer(MAX_ATTEMPT_STEPS), v.minValue(1)),
  }),
  /**
   * Tries a step that failed without changing the page again. `final` ends the attempt as
   * a spent budget does: the runtime never retries a `totp` handler's click once its code
   * is in, since a late click could submit an expired code (ADR 0027).
   */
  v.strictObject({ type: v.literal("RETRY"), final: v.optional(v.literal(true)) }),
  /**
   * The login's authorization was withdrawn. `undelivered` names a prepared operation the
   * page never received, whose reserved effect is taken back so the record shows nothing
   * in flight (ADR 0022).
   */
  v.strictObject({ type: v.literal("POLICY_CHANGED"), undelivered: v.optional(identifier) }),
  /**
   * A watched login, which only reads, still has its account under newer settings: it
   * keeps watching under their revision (ADR 0027).
   */
  v.strictObject({
    type: v.literal("POLICY_REVISED"),
    policyRevision: integer(Number.MAX_SAFE_INTEGER - 1),
  }),
  v.strictObject({ type: v.literal("CANCEL") }),
]);
export type LoginAttemptEvent = v.InferOutput<typeof loginAttemptEventSchema>;
