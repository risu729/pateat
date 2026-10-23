import * as v from "valibot";
import { assign, setup, transition } from "xstate";
import {
  chooserClickSchema,
  handlerSteps,
  loginAccountSchema,
  loginDocumentSchema,
  loginItemFactsSchema,
  loginOperationSchema,
  loginOriginSchema,
  loginOutcomeSchema,
  loginRouteSchema,
  loginStepEffect,
  MAX_PASSWORD_ALTERNATIVES,
  parseLoginRecipe,
  passwordVariants,
  routeSlots,
  routeSteps,
  sameLoginDocument,
  TOTP_HANDLER_SLOT,
  type ChooserClick,
  type LoginAccount,
  type LoginDocument,
  type LoginItemFacts,
  type LoginOperation,
  type LoginRecipe,
  type LoginRouteChoice,
  type LoginStep,
} from "./login";

const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
const integer = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));
const milliseconds = v.pipe(v.number(), v.integer(), v.minValue(0));
/**
 * How long a login has taken so far, for the local log (ADR 0019, amended 2026-10-18) and
 * the login record (ADR 0055): `since` when, in epoch milliseconds, the extension saw the
 * page that started it; the milliseconds it waited for the service (`serviceMs`), of that
 * for the network (`networkMs`), for the person (`personMs`) and for the site's answer to
 * its own steps (`pageMs`); and `personSince` and `pageSince` while it waits for the person
 * or the site now, never both. Epoch stamps rather than timers, so the time stored with the
 * record outlives a worker restart; time not yet stored when the worker stops is lost.
 * Never how long a value took to type, which would tell its length.
 */
export const attemptTimingSchema = v.strictObject({
  since: milliseconds,
  serviceMs: milliseconds,
  networkMs: milliseconds,
  personMs: milliseconds,
  pageMs: milliseconds,
  personSince: v.optional(milliseconds),
  pageSince: v.optional(milliseconds),
});
export type AttemptTiming = v.InferOutput<typeof attemptTimingSchema>;
/** Steps and effects an attempt may hold: its route's, plus those of handlers it entered. */
const MAX_ATTEMPT_STEPS = 40;
const MAX_ATTEMPT_SUBMISSIONS = 12;
const MAX_ENTERED_HANDLERS = 4;
/** Pages the model may judge after one effect step (ADR 0027). */
export const MAX_JUDGED_PAGES = 2;
/** Steps and effects a continuation may add: one page of a recipe (ADR 0018). */
const MAX_RECIPE_STEPS = 32;
const MAX_RECIPE_EFFECTS = 8;
/** Pages already sent to be judged after effect step `operationId`. */
export const judgedPages = (
  metadata: Pick<LoginAttemptMetadata, "judged">,
  operationId: string,
): number => (metadata.judged?.operationId === operationId ? metadata.judged.pages : 0);
/**
 * Pages the model may still judge for the attempt's current effect step: while the login
 * is watched (ADR 0027), the watch's own pages, else those after the step.
 */
export const pagesLeft = (
  metadata: Pick<LoginAttemptMetadata, "judged" | "watch">,
  operationId: string,
): number =>
  MAX_JUDGED_PAGES - (metadata.watch ? metadata.watch.pages : judgedPages(metadata, operationId));
export const loginAttemptStateSchema = v.picklist([
  "detected",
  "ready",
  "executing",
  "submit-intent",
  "awaiting-result",
  "reconciling",
  "retryable",
  /**
   * The page after the login's submission showed a step Pateat leaves to the person, such
   * as a code or an app approval (`challenge`): later pages of the tab are only read, until
   * one proves the sign-in or the watch ends (ADR 0027).
   */
  "watching",
  "authenticated",
  "blocked",
]);
/**
 * Whether a login is watched (ADR 0027): a top-level `password` login whose result stopped
 * at `challenge` or settled as unknown. Later pages of its tab are read for its result.
 */
const watched = (metadata: {
  route: string;
  document: { frameId: number };
  state: string;
  settled?: true | undefined;
}) =>
  metadata.route === "password" &&
  metadata.document.frameId === 0 &&
  (metadata.state === "watching" ||
    (metadata.state === "reconciling" && metadata.settled === true));
/** Allowlisted metadata only. Never persist an XState snapshot or resolved field values. */
export const attemptMetadataSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    recipeId: identifier,
    recipeRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    policyRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    account: loginAccountSchema,
    /** The route chosen when the login started (ADR 0027). */
    route: loginRouteSchema,
    /**
     * The password route's variant chosen with it: 0 for the recipe's own steps. A
     * `passkey` route that answers the start page's own request keeps the variant it falls
     * back to, or that it was switched from, when one fits (ADR 0034).
     */
    variant: v.optional(integer(MAX_PASSWORD_ALTERNATIVES)),
    /** The item's facts read when the login started; never sent anywhere. */
    facts: loginItemFactsSchema,
    /**
     * For a chooser recipe's login (ADR 0028): what it clicks on the list, or
     * `other-shown` when the list's path showed the `other` branch's form instead; this
     * decides the branch whose steps follow (`chooserRoute`).
     */
    chooser: v.optional(v.strictObject({ click: chooserClickSchema })),
    /**
     * Handlers this login entered, in order: `index` in the recipe's handlers, `start`,
     * where its steps begin in the attempt's plan (`attemptPlan`), and for a `detail`
     * handler the input it fills (`field`, ADR 0061).
     */
    handlers: v.pipe(
      v.array(
        v.strictObject({
          index: integer(15),
          start: integer(MAX_ATTEMPT_STEPS),
          field: v.optional(integer(2)),
        }),
      ),
      v.maxLength(MAX_ENTERED_HANDLERS),
      v.check(
        (entries) => new Set(entries.map((entry) => entry.index)).size === entries.length,
        "Duplicate entered handlers",
      ),
    ),
    document: loginDocumentSchema,
    /**
     * For a frame's login, the origin of the tab's page around it when the login started:
     * the site the login belongs to (ADR 0022).
     */
    pageOrigin: v.optional(loginOriginSchema),
    state: loginAttemptStateSchema,
    stepIndex: integer(MAX_ATTEMPT_STEPS),
    stepCount: v.pipe(integer(MAX_ATTEMPT_STEPS), v.minValue(1)),
    submissions: integer(MAX_ATTEMPT_SUBMISSIONS),
    maxSubmissions: v.pipe(integer(MAX_ATTEMPT_SUBMISSIONS), v.minValue(1)),
    retries: integer(2),
    maxRetries: v.literal(2),
    retryRequired: v.optional(v.literal(true)),
    usedOperationIds: v.pipe(
      v.array(identifier),
      v.maxLength(96),
      v.check((ids) => new Set(ids).size === ids.length, "Duplicate operation IDs"),
    ),
    operationId: v.optional(identifier),
    operationKind: v.optional(v.picklist(["fill", "click", "wait", "assert"])),
    operationEffect: v.optional(v.picklist(["prepare", "advance", "submit"])),
    mutationIntent: v.optional(v.literal(true)),
    outcome: v.optional(loginOutcomeSchema),
    /** The login ended on an undecided page without a confirmed sign-in (ADR 0029). */
    unconfirmed: v.optional(v.literal(true)),
    /**
     * The result of the current effect step settled as unknown; cleared once the attempt
     * moves on. A settled login no longer scopes the passkey bridge (ADR 0027).
     */
    settled: v.optional(v.literal(true)),
    /**
     * Pages sent to be judged after the effect step `operationId`, including one whose
     * answer is pending; at most `MAX_JUDGED_PAGES` per effect step (ADR 0027).
     */
    judged: v.optional(
      v.strictObject({ operationId: identifier, pages: integer(MAX_JUDGED_PAGES) }),
    ),
    /**
     * A top-level `password` login watched after its result stopped at `challenge`
     * (`watching`) or settled as unknown (ADR 0027): since when, in epoch milliseconds, the
     * document it began in, and the pages sent to be judged since, apart from the effect
     * step's own (`judged`). Kept by `transitionLoginAttempt`.
     */
    watch: v.optional(
      v.strictObject({
        since: v.pipe(v.number(), v.integer(), v.minValue(0)),
        documentId: identifier,
        pages: integer(MAX_JUDGED_PAGES),
      }),
    ),
    /**
     * The page after the final `advance` step `operationId` was sent to continue the
     * recipe (ADR 0018): at most one request per effect step, recorded before the request
     * so a restart never sends it again.
     */
    continuation: v.optional(v.strictObject({ operationId: identifier })),
    /** This attempt follows an account switch in its tab; it never clicks another one. */
    accountSwitched: v.optional(v.literal(true)),
    /**
     * When the stored record last changed, in epoch milliseconds; another tab's login
     * that has not succeeded holds its origin for a limited time after it (ADR 0022).
     */
    changedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    /**
     * After a logout (ADR 0021 D): the attempt fills the page's leading fields and stops
     * before the first step with an effect, so it never clicks or submits.
     */
    fillOnly: v.optional(v.literal(true)),
    /**
     * For an item without a password (ADR 0036): where in the attempt's plan the step that
     * fills the password is, recorded when the login starts (`passwordStopOrMiss`), or the
     * plan's step count for a route that fills none and ends with an `advance`, so the stop
     * lies just past its last step. On the `password` route no step there or after it is
     * ever prepared, whatever the item holds later; a handler entered before it moves it
     * along with the plan. A `passkey` route the login switched to keeps it, and never
     * falls back to the password. A chooser login's plan starts with its click on the list
     * (ADR 0028), unless it started on the shown `other` branch, so its stop lies in or
     * just past the branch it runs.
     */
    stopAt: v.optional(v.pipe(integer(MAX_ATTEMPT_STEPS), v.minValue(1))),
    /**
     * Such a login sent the page at its stop to be judged (`STOP_JUDGING`, ADR 0036): at
     * most once per attempt, recorded before the request so a restart never sends it again.
     */
    stopJudged: v.optional(v.literal(true)),
    /**
     * A `password` login that started at a later step of its variant, because its page
     * showed that step and none of the recipe's first steps (ADR 0049): that step's index,
     * where the route starts again after an answered passkey request falls back to it.
     */
    startStep: v.optional(v.pipe(integer(MAX_ATTEMPT_STEPS), v.minValue(1))),
    /** How long the login has taken so far (`attemptTimes`), never with any value. */
    timing: attemptTimingSchema,
  }),
  v.check(
    (metadata) =>
      metadata.startStep === undefined ||
      (metadata.variant !== undefined &&
        metadata.chooser === undefined &&
        (metadata.route !== "password" || metadata.startStep < metadata.stepCount) &&
        (metadata.stopAt === undefined || metadata.startStep < metadata.stopAt)),
    "A later start needs a password variant, inside its plan and before any stop",
  ),
  v.check(
    (metadata) =>
      metadata.unconfirmed === undefined ||
      (metadata.state === "authenticated" && metadata.outcome === "authenticated"),
    "Only an authenticated completion can be unconfirmed",
  ),
  v.check(
    (metadata) =>
      metadata.stopAt === undefined ||
      (metadata.variant !== undefined &&
        metadata.document.frameId === 0 &&
        (metadata.route !== "password" || metadata.stopAt <= metadata.stepCount)),
    "A stop needs a top-level password variant, inside its plan or just past it",
  ),
  v.check(
    (metadata) => metadata.stopJudged === undefined || metadata.stopAt !== undefined,
    "Only a login with a stop judges its stop's page",
  ),
  v.check(
    (metadata) =>
      metadata.document.origin === metadata.account.origin &&
      (metadata.pageOrigin === undefined || metadata.document.frameId !== 0) &&
      metadata.stepIndex <= metadata.stepCount &&
      metadata.submissions <= metadata.maxSubmissions,
    "Inconsistent attempt scope or budget",
  ),
  v.check(
    (metadata) => metadata.route !== "password" || metadata.variant !== undefined,
    "A password route needs its variant",
  ),
  v.check(
    (metadata) => (metadata.watch !== undefined) === watched(metadata),
    "Only a watched login has a watch, and it always has one",
  ),
  v.check(
    (metadata) => metadata.state !== "watching" || watched(metadata),
    "Only a top-level password login is watched",
  ),
  v.check(
    (metadata) => (metadata.operationId === undefined) === (metadata.operationKind === undefined),
    "Incomplete operation identity",
  ),
  v.check(
    (metadata) =>
      metadata.operationId === undefined ||
      metadata.usedOperationIds.includes(metadata.operationId),
    "Operation ID is not recorded",
  ),
  v.check(
    (metadata) =>
      metadata.judged === undefined ||
      metadata.usedOperationIds.includes(metadata.judged.operationId),
    "Judged operation ID is not recorded",
  ),
  v.check(
    (metadata) =>
      metadata.continuation === undefined ||
      metadata.usedOperationIds.includes(metadata.continuation.operationId),
    "Continued operation ID is not recorded",
  ),
  v.check(
    (metadata) =>
      !["executing", "submit-intent", "awaiting-result"].includes(metadata.state) ||
      metadata.operationId !== undefined,
    "Missing in-flight operation",
  ),
  v.check(
    (metadata) =>
      !["submit-intent", "awaiting-result"].includes(metadata.state) ||
      metadata.operationKind === "click" ||
      (metadata.operationKind === "fill" &&
        ["advance", "submit"].includes(metadata.operationEffect ?? "prepare")),
    "Submission state requires an effectful operation",
  ),
  v.check(
    (metadata) =>
      (metadata.operationEffect === undefined && metadata.mutationIntent === undefined) ||
      metadata.operationKind === "fill" ||
      metadata.operationKind === "click",
    "Mutation metadata requires a fill or click operation",
  ),
);
export type LoginAttemptMetadata = v.InferOutput<typeof attemptMetadataSchema>;
export const parseAttemptMetadata = (value: unknown): LoginAttemptMetadata =>
  v.parse(attemptMetadataSchema, value);

export const loginAttemptEventSchema = v.variant("type", [
  v.strictObject({ type: v.literal("RESOLVE") }),
  v.strictObject({
    type: v.literal("PREPARE"),
    operationId: identifier,
    kind: v.picklist(["fill", "click", "wait", "assert"]),
    effect: v.optional(v.picklist(["prepare", "advance", "submit"])),
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
   * a preparing fill. It ends the attempt without a retry, since the same values would
   * be rejected again.
   */
  v.strictObject({
    type: v.literal("VALUE_REJECTED"),
    operationId: identifier,
    document: loginDocumentSchema,
    stage: v.picklist(["before-fill", "after-fill"]),
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
   * bound (ADR 0027).
   */
  v.strictObject({ type: v.literal("JUDGING"), operationId: identifier }),
  /** The page sent under `JUDGING` reached no model, so it is given back. */
  v.strictObject({ type: v.literal("UNJUDGED"), operationId: identifier }),
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
  /** The request sent under `CONTINUING` reached no model, so it is given back. */
  v.strictObject({ type: v.literal("UNCONTINUED"), operationId: identifier }),
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
   * start page asks for a passkey by itself, or back when that request goes away. After
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
const sameScope = (left: LoginDocument, right: LoginDocument) =>
  left.origin === right.origin && left.tabId === right.tabId && left.frameId === right.frameId;
/** A top-level page of the same tab on another origin replaced the attempt's page. */
const leftOrigin = (left: LoginDocument, right: LoginDocument) =>
  left.frameId === 0 &&
  right.frameId === 0 &&
  left.tabId === right.tabId &&
  left.origin !== right.origin;
/** The current operation may have submitted or changed the page. */
const maySubmit = (context: LoginAttemptMetadata) =>
  context.mutationIntent === true ||
  context.operationKind === "fill" ||
  (context.operationKind === "click" && context.submissions > 0);
const operationMatches = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  "operationId" in event && event.operationId === context.operationId;
/**
 * Whether the plan step at `index` comes before the login's stop (ADR 0036): always, but
 * on the `password` route of a login with a stop.
 */
const beforeStop = (
  context: Pick<LoginAttemptMetadata, "route" | "stopAt">,
  index: number,
): boolean =>
  context.route !== "password" || context.stopAt === undefined || index < context.stopAt;
/**
 * Whether a login of an item without a password stands at its stop (ADR 0036) with nothing
 * in flight, after it submitted the steps before it, and may still act there: answer the
 * page's passkey request, judge the page or enter a `passkey` handler before the stop.
 */
const atStop = (context: LoginAttemptMetadata) =>
  context.route === "password" &&
  context.stopAt !== undefined &&
  context.stepIndex === context.stopAt &&
  context.operationId === undefined &&
  context.retryRequired !== true &&
  context.fillOnly !== true &&
  context.submissions > 0;
/**
 * Whether a move to another origin may complete the login (ADR 0022): its current
 * operation may have submitted, or it stands at its stop after a submission (ADR 0036).
 */
const maySignIn = (context: LoginAttemptMetadata) => maySubmit(context) || atStop(context);
/**
 * Whether the login's stop lies just past its plan's last step (ADR 0036): its route fills
 * no password and ends with an `advance`, so no step is there.
 */
const stopsPastPlan = (context: Pick<LoginAttemptMetadata, "route" | "stopAt" | "stepCount">) =>
  context.route === "password" && context.stopAt === context.stepCount;
/**
 * The submissions the attempt's steps may spend. A stop just past the plan's last step
 * keeps one of `maxSubmissions` for its passkey answer (`STOP_ANSWERED`, ADR 0036), which
 * a recipe's budget never counts: no step, handler or page's own submission spends it.
 */
const stepBudget = (
  context: Pick<LoginAttemptMetadata, "route" | "stopAt" | "stepCount" | "maxSubmissions">,
) => context.maxSubmissions - (stopsPastPlan(context) ? 1 : 0);
/** The current operation is a click or a fill that advances or submits. */
const effectfulOperation = (context: LoginAttemptMetadata) =>
  context.operationKind === "click" ||
  context.operationEffect === "advance" ||
  context.operationEffect === "submit";
const confirmedNoMutation = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  event.type === "FAILED" &&
  event.mutation === "none" &&
  operationMatches(context, event) &&
  event.document !== undefined &&
  sameLoginDocument(context.document, event.document);

function record(
  context: LoginAttemptMetadata,
  event: LoginAttemptEvent,
): Partial<LoginAttemptMetadata> {
  switch (event.type) {
    case "PREPARE":
      return {
        operationId: event.operationId,
        operationKind: event.kind,
        operationEffect:
          event.effect ??
          (event.kind === "fill" ? "prepare" : event.kind === "click" ? "submit" : undefined),
        mutationIntent: undefined,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
      };
    case "SUBMIT_INTENT":
      return { submissions: context.submissions + 1, mutationIntent: true };
    case "MUTATION_INTENT":
      return {
        mutationIntent: true,
        submissions: context.submissions + (context.operationEffect === "prepare" ? 0 : 1),
      };
    case "OPERATION_OK":
      return {
        stepIndex: context.stepIndex + 1,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
      };
    case "OBSERVED":
      if (event.result === "continue")
        return {
          stepIndex:
            context.operationKind === "click" || context.operationEffect === "advance"
              ? context.stepIndex + 1
              : context.stepIndex,
          document: event.document ?? context.document,
          operationId: undefined,
          operationKind: undefined,
          operationEffect: undefined,
          mutationIntent: undefined,
          outcome: undefined,
          settled: undefined,
        };
      return {
        document: event.document ?? context.document,
        outcome: event.result === "unknown" ? "unknown-submit" : event.result,
        ...(event.unconfirmed ? { unconfirmed: true } : {}),
        settled: event.result === "unknown" ? true : undefined,
      };
    case "NAVIGATED":
      if (leftOrigin(context.document, event.document))
        // The result of a submission on the previous origin cannot be observed here, unless
        // the runtime confirmed the sign-in. A watched login ends where it stopped, as when
        // its watch ends: it never signed in, so its first step showing again is no logout
        // (ADR 0027, 2026-10-13).
        return {
          outcome:
            event.signedIn && maySignIn(context)
              ? "authenticated"
              : watched(context)
                ? context.outcome
                : !maySubmit(context)
                  ? "interrupted"
                  : "left-origin",
        };
      return {
        document: sameScope(context.document, event.document) ? event.document : context.document,
        outcome: maySubmit(context) ? "unknown-submit" : "interrupted",
      };
    case "INTERRUPTED":
      return { outcome: maySubmit(context) ? "unknown-submit" : "interrupted" };
    case "FAILED":
      return {
        outcome: event.reason,
        // A trusted preflight failure proves that this fill never initiated its
        // reserved effect. Keep its used ID and the independent retry budget.
        submissions:
          confirmedNoMutation(context, event) &&
          context.mutationIntent === true &&
          context.operationKind === "fill" &&
          ["advance", "submit"].includes(context.operationEffect ?? "prepare")
            ? context.submissions - 1
            : context.submissions,
        mutationIntent: confirmedNoMutation(context, event) ? undefined : context.mutationIntent,
        retryRequired:
          context.operationKind !== "click" &&
          (!context.mutationIntent || confirmedNoMutation(context, event))
            ? true
            : context.retryRequired,
      };
    case "WRONG_ACCOUNT": {
      // Like a confirmed preflight failure, the reserved fill effect never started.
      const submissions =
        context.mutationIntent === true && (context.operationEffect ?? "prepare") !== "prepare"
          ? context.submissions - 1
          : context.submissions;
      return {
        // A switch starts a fresh attempt with a full budget, so it is recorded only once
        // per sign-in and only before anything was submitted.
        outcome:
          event.switched && !context.accountSwitched && submissions === 0
            ? "account-switched"
            : "wrong-account",
        submissions,
        mutationIntent: undefined,
      };
    }
    case "VALUE_REJECTED":
      if (event.stage === "after-fill") return { outcome: "fill-rejected" };
      return {
        outcome: "value-mismatch",
        // As with a wrong account, the reserved fill effect never started.
        submissions:
          context.mutationIntent === true && (context.operationEffect ?? "prepare") !== "prepare"
            ? context.submissions - 1
            : context.submissions,
        mutationIntent: undefined,
      };
    case "REVISED":
      return { recipeRevision: event.recipeRevision };
    case "POLICY_REVISED":
      return { policyRevision: event.policyRevision };
    case "JUDGING":
      if (context.watch) return { watch: { ...context.watch, pages: context.watch.pages + 1 } };
      return {
        judged: {
          operationId: event.operationId,
          pages: judgedPages(context, event.operationId) + 1,
        },
      };
    case "UNJUDGED":
      if (context.watch) return { watch: { ...context.watch, pages: context.watch.pages - 1 } };
      return {
        judged: {
          operationId: event.operationId,
          pages: judgedPages(context, event.operationId) - 1,
        },
      };
    case "CONTINUING":
      return { continuation: { operationId: event.operationId } };
    case "UNCONTINUED":
      return { continuation: undefined };
    case "CONTINUED":
      return {
        recipeRevision: event.recipeRevision,
        stepIndex: context.stepIndex + 1,
        stepCount: context.stepCount + event.steps,
        // A stop past the plan moves to the continued steps; the submission kept for its
        // answer is kept only while the stop still lies past the plan's last step (ADR 0036).
        ...(event.stopAt === undefined ? {} : { stopAt: event.stopAt }),
        maxSubmissions:
          context.maxSubmissions +
          event.effects -
          (event.stopAt !== undefined && event.stopAt < context.stepCount + event.steps ? 1 : 0),
        document: event.document,
        continuation: undefined,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "HANDLER": {
      // After an effect step the handler's steps follow it; at a stop, with nothing in
      // flight, they go in at the stop step itself (ADR 0036).
      const start = context.operationId === undefined ? context.stepIndex : context.stepIndex + 1;
      return {
        handlers: [
          ...context.handlers,
          {
            index: event.handler,
            start,
            ...(event.field === undefined ? {} : { field: event.field }),
          },
        ],
        // The handler's steps go in before the stop, which moves along with the plan.
        ...(context.route === "password" && context.stopAt !== undefined
          ? { stopAt: context.stopAt + event.steps }
          : {}),
        stepIndex: start,
        stepCount: context.stepCount + event.steps,
        maxSubmissions: context.maxSubmissions + event.effects,
        document: event.document,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    }
    case "STOP_JUDGING":
      return { stopJudged: true };
    case "AUTO_SUBMITTED":
      return {
        // A fill still in flight is done, so the step is its handler's click.
        stepIndex: context.operationKind === "fill" ? context.stepIndex + 1 : context.stepIndex,
        operationId: event.operationId,
        operationKind: "click",
        operationEffect: "submit",
        mutationIntent: true,
        submissions: context.submissions + 1,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "STOP_ANSWERED":
      return {
        // The step stays the stop: nothing after it runs.
        operationId: event.operationId,
        operationKind: "click",
        operationEffect: "submit",
        mutationIntent: true,
        submissions: context.submissions + 1,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "ROUTE":
      return {
        route: event.route,
        // A login that started at a later step goes back to it (ADR 0049).
        stepIndex: event.route === "password" ? (context.startStep ?? 0) : 0,
        stepCount: event.steps,
        // The passkey answer does not spend the password route's budget. The submission a
        // stop past the plan's last step keeps for its answer stays with the password route.
        maxSubmissions: Math.min(
          MAX_ATTEMPT_SUBMISSIONS,
          context.maxSubmissions +
            (event.route === "password" ? context.submissions : 0) -
            (stopsPastPlan(context) ? 1 : 0),
        ),
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "RETRY":
      return {
        retries: context.retries + 1,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
      };
    case "POLICY_CHANGED":
      if (event.undelivered === undefined || event.undelivered !== context.operationId)
        return { outcome: "policy-changed" };
      return {
        outcome: "policy-changed",
        // As with a wrong account, the reserved effect never started; a click reserves a
        // submission whatever its purpose.
        submissions:
          context.mutationIntent === true &&
          (context.operationKind === "click" ||
            (context.operationEffect ?? "prepare") !== "prepare")
            ? context.submissions - 1
            : context.submissions,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
      };
    case "CANCEL":
      return { outcome: "cancelled" };
    default:
      return {};
  }
}

const observedTransitions = [
  { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
  { guard: "observedWatched", target: "watching", actions: "record" },
  { guard: "observedRejected", target: "blocked", actions: "record" },
  { guard: "observedRetryRequired", target: "retryable", actions: "record" },
  { guard: "observedContinue", target: "ready", actions: "record" },
  { guard: "observedUnknown", target: "reconciling", actions: "record" },
] as const;

/** XState owns legal transitions; packaged coordinator owns storage and DOM side effects. */
function createLoginAttemptMachine() {
  return setup({
    types: {
      context: {} as LoginAttemptMetadata,
      events: {} as LoginAttemptEvent,
      input: {} as LoginAttemptMetadata,
    },
    actions: {
      record: assign(({ context, event }) => record(context, event)),
      submissionLimit: assign({ outcome: "submission-limit" }),
      retryLimit: assign({ outcome: "retry-limit" }),
      invalidNavigation: assign({ outcome: "cancelled" }),
      // A watched login's later page of its origin and tab: only the document changes.
      watchedNavigation: assign(({ context, event }) => ({
        document: event.type === "NAVIGATED" ? event.document : context.document,
      })),
      notListed: assign({ outcome: "account-not-listed" }),
      watchEnded: assign(({ context, event }) => ({
        outcome:
          event.type !== "WATCH_ENDED" || !event.abandoned
            ? context.outcome
            : context.outcome === "challenge"
              ? ("challenge-abandoned" as const)
              : ("watch-abandoned" as const),
      })),
    },
    guards: {
      canPrepare: ({ context, event }) =>
        event.type === "PREPARE" &&
        context.stepIndex < context.stepCount &&
        // Nothing at or after the stop of an item without a password runs (ADR 0036).
        beforeStop(context, context.stepIndex) &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96,
      operationMatches: ({ context, event }) => operationMatches(context, event),
      completedNonClick: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind !== "click" &&
        (context.operationKind !== "fill" ||
          (context.operationEffect === "prepare" && context.mutationIntent === true)),
      preparationFill: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect === "prepare",
      effectfulFillAvailable: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect !== "prepare" &&
        context.submissions < stepBudget(context),
      effectfulFill: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect !== "prepare",
      canSubmit: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "click" &&
        context.submissions < stepBudget(context),
      clickMatches: ({ context, event }) =>
        operationMatches(context, event) && context.operationKind === "click",
      wrongAccount: ({ context, event }) =>
        event.type === "WRONG_ACCOUNT" &&
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        sameLoginDocument(context.document, event.document),
      valueRejected: ({ context, event }) =>
        event.type === "VALUE_REJECTED" &&
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        sameLoginDocument(context.document, event.document) &&
        // Only a preparing fill is checked after filling; an effectful one has submitted.
        (event.stage === "before-fill" || context.operationEffect === "prepare"),
      retryAvailable: ({ context, event }) =>
        context.retries < context.maxRetries && !(event.type === "RETRY" && event.final),
      failedPossibleMutation: ({ context, event }) =>
        context.operationKind === "click" ||
        (context.mutationIntent === true && !confirmedNoMutation(context, event)),
      staleFailure: ({ context, event }) =>
        event.type === "FAILED" &&
        ((event.operationId !== undefined && event.operationId !== context.operationId) ||
          (event.document !== undefined && !sameLoginDocument(context.document, event.document))),
      sameScope: ({ context, event }) =>
        event.type === "NAVIGATED" && sameScope(context.document, event.document),
      leftOrigin: ({ context, event }) =>
        event.type === "NAVIGATED" && leftOrigin(context.document, event.document),
      leftSignedIn: ({ context, event }) =>
        event.type === "NAVIGATED" &&
        event.signedIn === true &&
        leftOrigin(context.document, event.document) &&
        maySignIn(context),
      observedAuthenticated: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "authenticated" &&
        (!event.document || sameScope(context.document, event.document)),
      observedRejected: ({ context, event }) =>
        event.type === "OBSERVED" &&
        ["credential-rejected", "challenge"].includes(event.result) &&
        (!event.document || sameScope(context.document, event.document)),
      // A login of an item without a password that ends at its stop, with nothing in
      // flight, is watched as one stopped at a step left to the person (ADR 0036).
      observedStop: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "challenge" &&
        context.route === "password" &&
        context.stopAt !== undefined &&
        context.stepIndex === context.stopAt &&
        context.operationId === undefined &&
        context.document.frameId === 0 &&
        (!event.document || sameScope(context.document, event.document)),
      // A top-level password login that stops at a step left to the person is watched.
      observedWatched: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "challenge" &&
        context.route === "password" &&
        context.document.frameId === 0 &&
        (!event.document || sameScope(context.document, event.document)),
      observedCredentialRejected: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "credential-rejected" &&
        (!event.document || sameScope(context.document, event.document)),
      observedContinue: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "continue" &&
        // A stop past the plan's last step is a place to go on to, though no step is there.
        (context.stepIndex < context.stepCount ||
          (stopsPastPlan(context) && context.stepIndex === context.stopAt)) &&
        !(
          context.operationKind === "fill" &&
          (context.operationEffect === "submit" ||
            ((context.operationEffect ?? "prepare") === "prepare" &&
              context.retryRequired !== true))
        ) &&
        (!(context.operationKind === "click" || context.operationEffect === "advance") ||
          (context.operationId !== undefined &&
            context.mutationIntent === true &&
            context.submissions > 0 &&
            (context.stepIndex + 1 < context.stepCount ||
              // The final advance goes on to a stop just past it (ADR 0036).
              (context.operationEffect === "advance" &&
                stopsPastPlan(context) &&
                context.stepIndex + 1 === context.stopAt)))) &&
        // A login with a stop goes on at most to it (ADR 0036).
        (beforeStop(context, context.stepIndex) ||
          (context.stepIndex === context.stopAt && !effectfulOperation(context))) &&
        (!event.document || sameScope(context.document, event.document)),
      observedRetryRequired: ({ context, event }) =>
        context.retryRequired === true &&
        event.type === "OBSERVED" &&
        event.result === "continue" &&
        context.operationKind !== "click" &&
        context.stepIndex < context.stepCount &&
        (!event.document || sameScope(context.document, event.document)),
      observedUnknown: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "unknown" &&
        (!event.document || sameScope(context.document, event.document)),
      // Only an effect step's result is judged, and only a bounded number of pages: after
      // the step, then again while the login is watched (ADR 0027).
      canJudge: ({ context, event }) =>
        event.type === "JUDGING" &&
        operationMatches(context, event) &&
        (context.operationKind === "click" ||
          context.operationEffect === "advance" ||
          context.operationEffect === "submit") &&
        pagesLeft(context, event.operationId) > 0,
      canUnjudge: ({ context, event }) =>
        event.type === "UNJUDGED" &&
        (context.watch ? context.watch.pages : judgedPages(context, event.operationId)) > 0,
      watchEnds: ({ context }) => context.watch !== undefined,
      // One request per final advance, recorded before it is sent (ADR 0018). A login with
      // a stop asks only when the stop lies just past that advance (ADR 0036).
      canContinue: ({ context, event }) =>
        event.type === "CONTINUING" &&
        operationMatches(context, event) &&
        (context.stopAt === undefined || stopsPastPlan(context)) &&
        context.operationEffect === "advance" &&
        context.mutationIntent === true &&
        context.submissions > 0 &&
        context.stepIndex + 1 === context.stepCount &&
        context.continuation?.operationId !== event.operationId,
      canUncontinue: ({ context, event }) =>
        event.type === "UNCONTINUED" && context.continuation?.operationId === event.operationId,
      // The continued steps follow the final advance whose page was sent, and stay within
      // the attempt's step and submission caps.
      // A login with a stop just past its plan names its new stop, at or after the first
      // continued step (ADR 0036); one without a stop names none. Only the range is checked
      // here: that the stop is the first continued step filling a password is the
      // runtime's `continuedStop` to get right, since bindings are not visible here.
      continued: ({ context, event }) =>
        event.type === "CONTINUED" &&
        event.recipeRevision > context.recipeRevision &&
        (context.stopAt === undefined
          ? event.stopAt === undefined
          : stopsPastPlan(context) &&
            event.stopAt !== undefined &&
            event.stopAt >= context.stepCount &&
            event.stopAt <= context.stepCount + event.steps) &&
        context.operationId !== undefined &&
        context.continuation?.operationId === context.operationId &&
        context.operationEffect === "advance" &&
        context.mutationIntent === true &&
        context.submissions > 0 &&
        context.stepIndex + 1 === context.stepCount &&
        context.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // Before anything was submitted, between steps, on the first route a login took.
      canSwitchRoute: ({ context, event }) =>
        event.type === "ROUTE" &&
        event.route !== context.route &&
        context.variant !== undefined &&
        context.operationId === undefined &&
        context.submissions === 0 &&
        context.handlers.length === 0 &&
        context.fillOnly !== true &&
        // A login with a stop never goes back to the password it lacks (ADR 0036).
        !(event.route === "password" && context.stopAt !== undefined),
      // After the passkey answer, once, to the variant the login recorded.
      canFallBack: ({ context, event }) =>
        event.type === "ROUTE" &&
        event.route === "password" &&
        context.route === "passkey" &&
        context.variant !== undefined &&
        context.operationKind === "click" &&
        context.submissions > 0 &&
        context.handlers.length === 0 &&
        context.stopAt === undefined,
      newerRevision: ({ context, event }) =>
        event.type === "REVISED" && event.recipeRevision > context.recipeRevision,
      newerPolicy: ({ context, event }) =>
        event.type === "POLICY_REVISED" &&
        watched(context) &&
        event.policyRevision > context.policyRevision,
      // A handler follows only an effect step that may have submitted, runs once per
      // login, and stays within the attempt's step and submission caps.
      canEnterHandler: ({ context, event }) =>
        event.type === "HANDLER" &&
        context.operationId !== undefined &&
        context.mutationIntent === true &&
        context.submissions > 0 &&
        (context.operationKind === "click" ||
          context.operationEffect === "advance" ||
          context.operationEffect === "submit") &&
        !context.handlers.some((entry) => entry.index === event.handler) &&
        context.handlers.length < MAX_ENTERED_HANDLERS &&
        // A handler shown after the stop is left to the person (ADR 0036).
        beforeStop(context, context.stepIndex) &&
        context.stepIndex < context.stepCount &&
        context.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // Between a code's fill and the click after it, or with the fill still unanswered:
      // an entered handler's first step, or a route step's (`routeStep`); the page's own
      // submission takes the click's place in the budget. The runtime checks that the
      // steps are a `totp` handler's or a route's fill of the `totp` slot and its click.
      canAutoSubmit: ({ context, event }) =>
        event.type === "AUTO_SUBMITTED" &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96 &&
        context.submissions < stepBudget(context) &&
        (context.operationId === undefined
          ? context.stepIndex > 0 &&
            context.stepIndex < context.stepCount &&
            beforeStop(context, context.stepIndex) &&
            context.retryRequired !== true &&
            (event.routeStep === true ||
              context.handlers.some((entry) => entry.start === context.stepIndex - 1))
          : context.operationKind === "fill" &&
            context.operationEffect === "prepare" &&
            context.mutationIntent === true &&
            context.stepIndex + 1 < context.stepCount &&
            beforeStop(context, context.stepIndex + 1) &&
            (event.routeStep === true ||
              context.handlers.some((entry) => entry.start === context.stepIndex))),
      // At the stop, with nothing in flight: a `passkey` handler shown beside the stop
      // step's password field goes in before it, as after an effect step (ADR 0036).
      canEnterHandlerAtStop: ({ context, event }) =>
        event.type === "HANDLER" &&
        atStop(context) &&
        !context.handlers.some((entry) => entry.index === event.handler) &&
        context.handlers.length < MAX_ENTERED_HANDLERS &&
        context.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // Once per attempt, at a stop step that is in the plan (ADR 0036).
      canJudgeAtStop: ({ context, event }) =>
        event.type === "STOP_JUDGING" &&
        atStop(context) &&
        context.stopAt! < context.stepCount &&
        context.stopJudged !== true,
      // At the stop, with nothing in flight, once the login submitted (ADR 0036).
      canAnswerAtStop: ({ context, event }) =>
        event.type === "STOP_ANSWERED" &&
        atStop(context) &&
        context.submissions < context.maxSubmissions &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96,
    },
  }).createMachine({
    id: "login-attempt",
    initial: "detected",
    context: ({ input }) => parseAttemptMetadata(input),
    on: {
      REVISED: { guard: "newerRevision", actions: "record" },
      POLICY_REVISED: { guard: "newerPolicy", actions: "record" },
      POLICY_CHANGED: { target: ".blocked", actions: "record" },
      CANCEL: { target: ".blocked", actions: "record" },
      NAVIGATED: [
        { guard: "sameScope", target: ".reconciling", actions: "record" },
        // A top-level attempt ends when its tab leaves the origin; it is never resubmitted.
        { guard: "leftSignedIn", target: ".authenticated", actions: "record" },
        { guard: "leftOrigin", target: ".blocked", actions: "record" },
        { target: ".blocked", actions: "invalidNavigation" },
      ],
      INTERRUPTED: { target: ".reconciling", actions: "record" },
    },
    states: {
      detected: { on: { RESOLVE: "ready" } },
      ready: {
        on: {
          PREPARE: { guard: "canPrepare", target: "executing", actions: "record" },
          AUTO_SUBMITTED: { guard: "canAutoSubmit", target: "reconciling", actions: "record" },
          FAILED: [{ guard: "staleFailure" }, { target: "retryable", actions: "record" }],
          OBSERVED: [
            { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
            { guard: "observedStop", target: "watching", actions: "record" },
            { guard: "observedRejected", target: "blocked", actions: "record" },
          ],
          STOP_ANSWERED: { guard: "canAnswerAtStop", target: "reconciling", actions: "record" },
          STOP_JUDGING: { guard: "canJudgeAtStop", actions: "record" },
          HANDLER: { guard: "canEnterHandlerAtStop", target: "ready", actions: "record" },
          ROUTE: { guard: "canSwitchRoute", target: "ready", actions: "record" },
          NOT_LISTED: {
            guard: ({ context }) =>
              context.chooser !== undefined &&
              context.stepIndex === 0 &&
              context.operationId === undefined &&
              context.submissions === 0,
            target: "blocked",
            actions: "notListed",
          },
        },
      },
      executing: {
        on: {
          OPERATION_OK: { guard: "completedNonClick", target: "ready", actions: "record" },
          MUTATION_INTENT: [
            { guard: "preparationFill", actions: "record" },
            { guard: "effectfulFillAvailable", target: "submit-intent", actions: "record" },
            { guard: "effectfulFill", target: "blocked", actions: "submissionLimit" },
          ],
          SUBMIT_INTENT: [
            { guard: "canSubmit", target: "submit-intent", actions: "record" },
            { guard: "clickMatches", target: "blocked", actions: "submissionLimit" },
          ],
          FAILED: [
            { guard: "staleFailure" },
            { guard: "failedPossibleMutation", target: "reconciling", actions: "record" },
            { target: "retryable", actions: "record" },
          ],
          WRONG_ACCOUNT: { guard: "wrongAccount", target: "blocked", actions: "record" },
          VALUE_REJECTED: { guard: "valueRejected", target: "blocked", actions: "record" },
          AUTO_SUBMITTED: { guard: "canAutoSubmit", target: "reconciling", actions: "record" },
        },
      },
      "submit-intent": {
        on: {
          SUBMITTED: { guard: "operationMatches", target: "awaiting-result" },
          FAILED: [
            { guard: "staleFailure" },
            {
              guard: ({ context, event }) =>
                context.operationKind === "fill" && confirmedNoMutation(context, event),
              target: "retryable",
              actions: "record",
            },
            { target: "reconciling", actions: "record" },
          ],
          WRONG_ACCOUNT: { guard: "wrongAccount", target: "blocked", actions: "record" },
          VALUE_REJECTED: { guard: "valueRejected", target: "blocked", actions: "record" },
        },
      },
      "awaiting-result": {
        on: {
          OBSERVED: observedTransitions,
          JUDGING: { guard: "canJudge", actions: "record" },
          UNJUDGED: { guard: "canUnjudge", actions: "record" },
          CONTINUING: { guard: "canContinue", actions: "record" },
          UNCONTINUED: { guard: "canUncontinue", actions: "record" },
          CONTINUED: { guard: "continued", target: "ready", actions: "record" },
          HANDLER: { guard: "canEnterHandler", target: "ready", actions: "record" },
          ROUTE: { guard: "canFallBack", target: "ready", actions: "record" },
          FAILED: [{ guard: "staleFailure" }, { target: "reconciling", actions: "record" }],
        },
      },
      reconciling: {
        on: {
          AUTO_SUBMITTED: { guard: "canAutoSubmit", target: "reconciling", actions: "record" },
          OBSERVED: observedTransitions,
          JUDGING: { guard: "canJudge", actions: "record" },
          UNJUDGED: { guard: "canUnjudge", actions: "record" },
          WATCH_ENDED: { guard: "watchEnds", target: "blocked", actions: "watchEnded" },
          CONTINUING: { guard: "canContinue", actions: "record" },
          UNCONTINUED: { guard: "canUncontinue", actions: "record" },
          CONTINUED: { guard: "continued", target: "ready", actions: "record" },
          HANDLER: { guard: "canEnterHandler", target: "ready", actions: "record" },
          ROUTE: { guard: "canFallBack", target: "ready", actions: "record" },
        },
      },
      retryable: {
        on: {
          RETRY: [
            { guard: "retryAvailable", target: "ready", actions: "record" },
            { target: "blocked", actions: "retryLimit" },
          ],
        },
      },
      // Reads only: no step runs. A later page proves the sign-in or a refused password;
      // anything else leaves the login watched until the watch ends (ADR 0027).
      watching: {
        on: {
          OBSERVED: [
            { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
            { guard: "observedCredentialRejected", target: "blocked", actions: "record" },
          ],
          JUDGING: { guard: "canJudge", actions: "record" },
          UNJUDGED: { guard: "canUnjudge", actions: "record" },
          WATCH_ENDED: { target: "blocked", actions: "watchEnded" },
          // A restart or a new page of the tab keeps the watch; it has nothing in flight.
          INTERRUPTED: { actions: [] },
          NAVIGATED: [
            { guard: "sameScope", actions: "watchedNavigation" },
            { guard: "leftSignedIn", target: "authenticated", actions: "record" },
            { guard: "leftOrigin", target: "blocked", actions: "record" },
            { target: "blocked", actions: "invalidNavigation" },
          ],
        },
      },
      authenticated: { type: "final" },
      blocked: { type: "final" },
    },
  });
}

// The engine has no startup side effects. Schema-only consumers omit XState.
export const loginAttemptMachine = /* @__PURE__ */ createLoginAttemptMachine();

export function createAttemptMetadata(input: {
  id: string;
  recipe: LoginRecipe;
  policyRevision: number;
  account: LoginAccount;
  /** The route and variant chosen when the login starts. */
  choice: LoginRouteChoice;
  /**
   * For a `passkey` route that answers the start page's request: the password variant it
   * falls back to (ADR 0034).
   */
  fallback?: number;
  facts: LoginItemFacts;
  document: LoginDocument;
  /** The origin of the tab's page, for a frame's login. */
  pageOrigin?: string;
  accountSwitched?: boolean;
  fillOnly?: boolean;
  /** For a chooser recipe's login (ADR 0028): what it clicks on the list, or `other-shown`. */
  chooser?: ChooserClick;
  /** For an item without a password: where its `password` route stops (ADR 0036). */
  stopAt?: number;
  /**
   * The later step of the chosen `password` variant the login starts at, when its page
   * shows that step and none of the recipe's first steps (ADR 0049).
   */
  startAt?: number;
  /** The time the login took before it started, from when its first page was seen. */
  timing: Omit<AttemptTiming, "personSince" | "pageSince">;
}): LoginAttemptMetadata {
  const recipe = parseLoginRecipe(input.recipe);
  if (input.account.origin !== recipe.origin)
    throw new Error("Attempt origin does not match recipe");
  return parseAttemptMetadata({
    version: 1,
    id: input.id,
    recipeId: recipe.id,
    recipeRevision: recipe.revision,
    policyRevision: input.policyRevision,
    account: input.account,
    route: input.choice.route,
    ...(input.choice.route === "password"
      ? { variant: input.choice.variant }
      : input.fallback === undefined
        ? {}
        : { variant: input.fallback }),
    facts: input.facts,
    handlers: [],
    document: input.document,
    ...(input.pageOrigin === undefined ? {} : { pageOrigin: input.pageOrigin }),
    state: "detected",
    stepIndex: input.choice.route === "password" ? (input.startAt ?? 0) : 0,
    stepCount: routeSteps(recipe, input.choice).length,
    submissions: 0,
    // A stop just past the route's last step keeps one more submission for its passkey
    // answer, which the recipe's budget does not count (ADR 0036).
    maxSubmissions: Math.min(
      MAX_ATTEMPT_SUBMISSIONS,
      recipe.maxSubmissions +
        (input.choice.route === "password" &&
        input.stopAt !== undefined &&
        input.stopAt === routeSteps(recipe, input.choice).length
          ? 1
          : 0),
    ),
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    ...(input.accountSwitched ? { accountSwitched: true } : {}),
    ...(input.fillOnly ? { fillOnly: true } : {}),
    ...(input.chooser ? { chooser: { click: input.chooser } } : {}),
    ...(input.stopAt === undefined ? {} : { stopAt: input.stopAt }),
    ...(input.startAt === undefined ? {} : { startStep: input.startAt }),
    timing: input.timing,
  });
}

/** A duration in whole, non-negative milliseconds. */
const duration = (value: number) => Math.max(0, Math.round(value));
type Timed = { timing: AttemptTiming };

/**
 * Adds time a login waited for the service, and of that for the network, or for the person
 * (ADR 0019). Service time while the login waits for the person or the site moves that
 * wait's start on, so no time counts twice.
 */
export function addAttemptTime<T extends Timed>(
  metadata: T,
  add: { serviceMs?: number; networkMs?: number; personMs?: number },
  now = Date.now(),
): T {
  const { timing } = metadata;
  const service = duration(add.serviceMs ?? 0);
  const moved = (since: number | undefined) =>
    since === undefined ? undefined : Math.max(since, Math.min(duration(now), since + service));
  const personSince = moved(timing.personSince);
  const pageSince = moved(timing.pageSince);
  return {
    ...metadata,
    timing: {
      ...timing,
      serviceMs: timing.serviceMs + service,
      networkMs: timing.networkMs + duration(add.networkMs ?? 0),
      personMs: timing.personMs + duration(add.personMs ?? 0),
      ...(personSince === undefined ? {} : { personSince }),
      ...(pageSince === undefined ? {} : { pageSince }),
    },
  };
}

/** Ends a running wait for the site and adds its time (ADR 0019). */
function pageShown<T extends Timed>(metadata: T, now: number): T {
  const { timing } = metadata;
  if (timing.pageSince === undefined) return metadata;
  const { pageSince, ...rest } = timing;
  return { ...metadata, timing: { ...rest, pageMs: rest.pageMs + duration(now - pageSince) } };
}

/**
 * Starts a wait for the person, unless one is running (ADR 0019). A running wait for the
 * site ends: what the person does next is their time.
 */
export function awaitPerson<T extends Timed>(metadata: T, now = Date.now()): T {
  if (metadata.timing.personSince !== undefined) return metadata;
  const { timing } = pageShown(metadata, now);
  return { ...metadata, timing: { ...timing, personSince: duration(now) } };
}

/** Ends a running wait for the person and adds its time (ADR 0019). */
export function personAnswered<T extends Timed>(metadata: T, now = Date.now()): T {
  const { timing } = metadata;
  if (timing.personSince === undefined) return metadata;
  const { personSince, ...rest } = timing;
  return {
    ...metadata,
    timing: { ...rest, personMs: rest.personMs + duration(now - personSince) },
  };
}

/**
 * Starts or ends the login's wait for the site (ADR 0019): it runs while the login waits
 * for the result of a step that may have changed the page (`awaiting-result` and
 * `reconciling`), a page load or a new page included, until it reads that result. It never
 * runs while the login waits for the person or after its result settled as unknown, as a
 * watched one or a frame's or `passkey` login's that only waits for a later page.
 */
export function followPage<T extends Timed & Parameters<typeof watched>[0]>(
  metadata: T,
  now = Date.now(),
): T {
  const waits =
    (metadata.state === "awaiting-result" || metadata.state === "reconciling") &&
    metadata.settled !== true &&
    metadata.timing.personSince === undefined;
  if (!waits) return pageShown(metadata, now);
  if (metadata.timing.pageSince !== undefined) return metadata;
  return { ...metadata, timing: { ...metadata.timing, pageSince: duration(now) } };
}

/** A login's times for the local log and its login record, each in whole milliseconds. */
export type AttemptTimes = {
  /** From when the extension saw the page that started the login until now. */
  totalMs: number;
  /** Waiting for the service: recipe generation, judging and the recipe sync after them. */
  serviceMs: number;
  /**
   * Of `serviceMs`, the network part: each request's round trip less the service's own
   * time from its `Server-Timing` header. A request whose answer did not name that time,
   * or that got no answer, adds nothing, so this is a lower bound.
   */
  networkMs: number;
  /** Waiting for the person: a watched login, a click left to them, an account pick. */
  personMs: number;
  /**
   * Waiting for the site: from a step of the login that may change the page, or the
   * sign-in entry press before it, until the login read the page's answer, a page load
   * included.
   */
  pageMs: number;
  /** The rest: Pateat's own work and waits, reading pages, filling and clicking. */
  otherMs: number;
};

/**
 * A login's times until `now`, running waits for the person and the site included. The
 * parts other than `networkMs` add up to `totalMs`, unless the service and person time
 * alone are more, as after overlapping requests or a clock that moved back; `pageMs` is
 * cut so that it never makes them more.
 */
export function attemptTimes(metadata: Timed, now = Date.now()): AttemptTimes {
  const { timing } = pageShown(personAnswered(metadata, now), now);
  const totalMs = duration(now - timing.since);
  const pageMs = Math.min(timing.pageMs, duration(totalMs - timing.serviceMs - timing.personMs));
  return {
    totalMs,
    serviceMs: timing.serviceMs,
    networkMs: timing.networkMs,
    personMs: timing.personMs,
    pageMs,
    otherMs: duration(totalMs - timing.serviceMs - timing.personMs - pageMs),
  };
}
/** A step that may advance or submit the page: a click, or a fill whose event may. */
export const effectfulStep = (step: LoginStep): boolean => {
  const effect = loginStepEffect(step);
  return effect !== undefined && effect !== "prepare";
};

/**
 * Applies one event. `now` starts the watch of a login that becomes watched (ADR 0027); a
 * login that stays watched keeps its watch, and one that no longer is drops it.
 */
export function transitionLoginAttempt(
  value: unknown,
  eventValue: unknown,
  now = Date.now(),
): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  const event = v.parse(loginAttemptEventSchema, eventValue);
  if (metadata.state === "authenticated" || metadata.state === "blocked") return metadata;
  const snapshot = loginAttemptMachine.resolveState({ value: metadata.state, context: metadata });
  const [next] = transition(loginAttemptMachine, snapshot, event);
  const { watch, ...moved } = {
    ...next.context,
    state: next.value as LoginAttemptMetadata["state"],
  };
  // A watched login waits for the person: for a code or an approval, and for the site's
  // answer to it (ADR 0019), also when its result settled as unknown. An ended login waits
  // for no one. Any other login waiting for a step's result waits for the site.
  const result = followPage(
    watched(moved)
      ? awaitPerson(moved, now)
      : watched(metadata) || moved.state === "authenticated" || moved.state === "blocked"
        ? personAnswered(moved, now)
        : moved,
    now,
  );
  if (!watched(result)) return parseAttemptMetadata(result);
  return parseAttemptMetadata({
    ...result,
    watch: watch ?? {
      since: Math.max(0, Math.trunc(now)),
      documentId: result.document.documentId,
      pages: 0,
    },
  });
}

/**
 * Records that the account switch was not clicked after all: the attempt ends as
 * `wrong-account`, which keeps holding its tab like any other ended attempt.
 */
export function withdrawAccountSwitch(value: unknown): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  if (metadata.state !== "blocked" || metadata.outcome !== "account-switched") return metadata;
  return parseAttemptMetadata({ ...metadata, outcome: "wrong-account" });
}

/** Restart always observes; it never restores an actor snapshot with pending actions. */
export function recoverLoginAttempt(value: unknown): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  return transitionLoginAttempt(metadata, { type: "INTERRUPTED" });
}

/** The route and variant an attempt recorded when it started. */
export function attemptRouteChoice(
  metadata: Pick<LoginAttemptMetadata, "route" | "variant">,
): LoginRouteChoice {
  if (metadata.route === "passkey") return { route: "passkey" };
  // The schema requires a variant for the password route.
  return { route: metadata.route, variant: metadata.variant ?? 0 };
}

/**
 * The slots the attempt's entered handlers fill beside its route's (ADR 0027): `totp` once
 * it entered a `totp` handler. A login's binding covers them too; they are never saved.
 */
export function handlerSlots(
  recipe: LoginRecipe,
  metadata: Pick<LoginAttemptMetadata, "handlers">,
): string[] {
  return metadata.handlers.some((entry) => recipe.handlers?.[entry.index]?.kind === "totp")
    ? [TOTP_HANDLER_SLOT]
    : [];
}
/**
 * Whether the login types a TOTP code already: its route fills the `totp` slot, or it
 * entered a `totp` handler. A login types one code at most, so a wrong code is never
 * retried into a lockout (ADR 0027).
 */
export function attemptUsesCode(
  recipe: LoginRecipe,
  metadata: Pick<LoginAttemptMetadata, "route" | "variant" | "handlers">,
): boolean {
  return (
    routeSlots(recipe, attemptRouteChoice(metadata)).includes(TOTP_HANDLER_SLOT) ||
    handlerSlots(recipe, metadata).length > 0
  );
}

/**
 * The attempt's steps: its route's steps, with each entered handler's steps inserted at
 * its `start`, in the order they were entered. `handler` is the recipe handler index of a
 * handler's step. Undefined when an entered handler is missing from the recipe.
 */
export function attemptPlan(
  recipe: LoginRecipe,
  metadata: Pick<LoginAttemptMetadata, "route" | "variant" | "handlers" | "startStep">,
): { step: LoginStep; handler?: number }[] | undefined {
  // A page's own passkey request answered on a later start stands on that step (ADR 0049).
  const from =
    metadata.route === "passkey" && metadata.startStep !== undefined
      ? passwordVariants(recipe)[metadata.variant ?? 0]?.steps[metadata.startStep]
      : undefined;
  const plan: { step: LoginStep; handler?: number }[] = routeSteps(
    recipe,
    attemptRouteChoice(metadata),
    from,
  ).map((step) => ({ step }));
  for (const entry of metadata.handlers) {
    const handler = recipe.handlers?.[entry.index];
    if (!handler || entry.start > plan.length) return undefined;
    plan.splice(
      entry.start,
      0,
      ...handlerSteps(handler, entry.field).map((step) => ({ step, handler: entry.index })),
    );
  }
  return plan;
}

export function nextLoginOperation(
  value: unknown,
  recipeValue: unknown,
  document: LoginDocument,
  operationId: string,
  now = Date.now(),
): LoginOperation | undefined {
  const metadata = parseAttemptMetadata(value);
  const recipe = parseLoginRecipe(recipeValue);
  if (
    metadata.state !== "ready" ||
    metadata.retryRequired === true ||
    !sameLoginDocument(metadata.document, document) ||
    metadata.recipeId !== recipe.id ||
    metadata.recipeRevision !== recipe.revision ||
    metadata.account.origin !== recipe.origin ||
    metadata.usedOperationIds.includes(operationId)
  )
    return undefined;
  // The machine cannot see the recipe, so the plan's length checks the recorded handlers.
  const plan = attemptPlan(recipe, metadata);
  const step = plan?.length === metadata.stepCount ? plan[metadata.stepIndex]?.step : undefined;
  if (
    !step ||
    // The step that fills the password of an item without one, and every later step, never
    // runs (ADR 0036).
    !beforeStop(metadata, metadata.stepIndex) ||
    (effectfulStep(step) &&
      // A fill-only attempt never takes a step with an effect (ADR 0021 D).
      (metadata.fillOnly === true || metadata.submissions >= stepBudget(metadata)))
  )
    return undefined;
  return v.parse(loginOperationSchema, {
    version: 1,
    attemptId: metadata.id,
    operationId,
    policyRevision: metadata.policyRevision,
    document,
    stepIndex: metadata.stepIndex,
    step,
    expiresAt: now + 15000,
  });
}

/** Browser identity and current policy must be rechecked immediately before execution. */
export function validateLoginOperation(
  operation: LoginOperation,
  metadata: LoginAttemptMetadata,
  document: LoginDocument,
  policyRevision: number,
  now = Date.now(),
): boolean {
  const parsedOperation = v.safeParse(loginOperationSchema, operation);
  const parsedMetadata = v.safeParse(attemptMetadataSchema, metadata);
  const parsedDocument = v.safeParse(loginDocumentSchema, document);
  if (!parsedOperation.success || !parsedMetadata.success || !parsedDocument.success) return false;
  const readyToExecute =
    loginStepEffect(operation.step) !== undefined && loginStepEffect(operation.step) !== "prepare"
      ? metadata.state === "submit-intent"
      : metadata.state === "executing";
  return (
    readyToExecute &&
    !(metadata.fillOnly === true && effectfulStep(operation.step)) &&
    beforeStop(metadata, operation.stepIndex) &&
    (!(operation.step.kind === "fill" || operation.step.kind === "click") ||
      metadata.mutationIntent === true) &&
    operation.attemptId === metadata.id &&
    operation.operationId === metadata.operationId &&
    operation.stepIndex === metadata.stepIndex &&
    operation.step.kind === metadata.operationKind &&
    loginStepEffect(operation.step) === metadata.operationEffect &&
    operation.policyRevision === policyRevision &&
    metadata.policyRevision === policyRevision &&
    sameLoginDocument(operation.document, document) &&
    sameLoginDocument(metadata.document, document) &&
    now < operation.expiresAt &&
    operation.expiresAt <= now + 15000
  );
}
