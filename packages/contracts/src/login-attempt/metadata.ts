import * as v from "valibot";
import {
  chooserClickSchema,
  loginAccountSchema,
  loginDocumentSchema,
  loginItemFactsSchema,
  loginOriginSchema,
  loginOutcomeSchema,
  MAX_PASSWORD_ALTERNATIVES,
  recipeLayoutKeySchema,
} from "../login";
import {
  identifier,
  integer,
  MAX_ATTEMPT_STEPS,
  MAX_ENTERED_HANDLERS,
  loginAttemptStateSchema,
  MAX_ATTEMPT_SUBMISSIONS,
  MAX_JUDGED_PAGES,
  WATCH_PATH_MAX,
  attemptTimingSchema,
  watched,
} from "./schema-primitives";

/** Allowlisted metadata only. Never persist an XState snapshot or resolved field values. */
export const attemptMetadataSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    recipeId: identifier,
    recipeRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    /**
     * The layout of the recipe the login runs, chosen when it started (ADR 0060); a resumed
     * login and a later revision it takes over keep it.
     */
    layout: v.optional(recipeLayoutKeySchema),
    policyRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    account: loginAccountSchema,
    /** The route chosen when the login started (ADR 0027). */
    route: v.picklist(["password", "passkey", "sso"]),
    /** Explicit parent metadata never enters the native transition engine. */
    ssoParent: v.optional(v.literal(true)),
    /** Durable exclusion only: an IdP child never restores parent authority. */
    ssoChild: v.optional(
      v.strictObject({
        parentId: identifier,
        attemptId: identifier,
        released: v.optional(v.literal(true)),
      }),
    ),
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
    /**
     * The fill of the operation in flight may make the page submit by itself, as a PIN
     * pad at its last key; read only while `operationId` is set.
     */
    operationPresses: v.optional(v.literal(true)),
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
     * A `password` login, in the tab's page or in a frame (ADR 0086), watched after its
     * result stopped at `challenge` (`watching`) or settled as unknown (ADR 0027): since
     * when, in epoch milliseconds, the document it began in, and the pages sent to be
     * judged since, apart from the effect step's own (`judged`). Kept by
     * `transitionLoginAttempt`. `path` is the path of that document the login was last read
     * on, as the runtime observes it, so a route the document takes in place, as a
     * single-page site's, is read once as the tab's next page, also after a worker restart
     * (ADR 0027 amendment of 2026-10-25).
     */
    watch: v.optional(
      v.strictObject({
        since: v.pipe(v.number(), v.integer(), v.minValue(0)),
        documentId: identifier,
        pages: integer(MAX_JUDGED_PAGES),
        path: v.optional(v.pipe(v.string(), v.startsWith("/"), v.maxLength(WATCH_PATH_MAX))),
      }),
    ),
    /**
     * The page after the final `advance` step `operationId` was sent to continue the
     * recipe (ADR 0018): at most one request per effect step, recorded before the request
     * so a restart never sends it again. `before` instead names the plan step of a final
     * `advance` click whose button stayed disabled while a password input opened, whose
     * page was sent to replace that click (ADR 0018 amendment of 2026-11-03): at most one
     * request per such step, recorded the same way.
     */
    continuation: v.optional(
      v.union([
        v.strictObject({ operationId: identifier }),
        v.strictObject({ before: integer(MAX_ATTEMPT_STEPS) }),
        // The person/page advanced a passive attempt; no Pateat operation submitted.
        v.strictObject({ after: integer(MAX_ATTEMPT_STEPS) }),
      ]),
    ),
    /** This attempt follows an account switch in its tab; it never clicks another one. */
    accountSwitched: v.optional(v.literal(true)),
    /**
     * When the stored record last changed, in epoch milliseconds; another tab's login
     * that has not succeeded holds its origin for a limited time after it (ADR 0022).
     */
    changedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    /**
     * While its tab asks for an account (ADR 0021 D): the attempt fills the page's leading
     * fields and stops before the first step with an effect, so it never clicks or submits.
     */
    fillOnly: v.optional(v.literal(true)),
    /** Profile/site autofill across pages (ADR 0035), distinct from logout autofill. */
    signInFill: v.optional(v.literal(true)),
    fillExpired: v.optional(v.literal(true)),
    fillSince: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    fillPermissionSource: v.optional(v.picklist(["site", "default"])),
    /** Structural state before a fill, retained across document/worker replacement. */
    fillBaseline: v.optional(
      v.strictObject({
        stepIndex: integer(MAX_ATTEMPT_STEPS),
        nextStep: integer(MAX_ATTEMPT_STEPS),
        documentId: identifier,
        path: v.pipe(v.string(), v.startsWith("/"), v.maxLength(WATCH_PATH_MAX)),
        ready: v.boolean(),
      }),
    ),
    /**
     * The login went back to the `password` route (ADR 0034): it never takes the `passkey`
     * route again, so before a submission it changes route at most once each way.
     */
    passkeyLeft: v.optional(v.literal(true)),
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
    startStep: v.optional(integer(MAX_ATTEMPT_STEPS)),
    /**
     * The login started at `startStep` with that step's password fields alone, as the page
     * showed its password input without the account identifier, as for an account the
     * site remembers (ADR 0049).
     */
    startPartial: v.optional(v.literal(true)),
    /** How long the login has taken so far (`attemptTimes`), never with any value. */
    timing: attemptTimingSchema,
  }),
  v.check(
    (metadata) =>
      metadata.route === "sso"
        ? metadata.ssoParent === true &&
          metadata.ssoChild === undefined &&
          metadata.variant === undefined &&
          metadata.handlers.length === 0 &&
          metadata.chooser === undefined &&
          metadata.watch === undefined &&
          metadata.operationId === undefined &&
          metadata.operationKind === undefined &&
          metadata.operationEffect === undefined &&
          metadata.mutationIntent === undefined &&
          metadata.signInFill === undefined &&
          metadata.fillOnly === undefined &&
          metadata.document.frameId === 0 &&
          metadata.stepCount === 1 &&
          metadata.stepIndex === 0 &&
          metadata.usedOperationIds.length === 0 &&
          ["awaiting-result", "reconciling", "authenticated", "blocked"].includes(metadata.state)
        : metadata.ssoParent === undefined,
    "An SSO parent has no native execution state",
  ),
  v.check(
    (metadata) =>
      metadata.ssoChild === undefined ||
      (metadata.route !== "sso" &&
        metadata.ssoChild.attemptId === metadata.id &&
        metadata.document.frameId === 0),
    "An SSO child exclusion names its exact native attempt",
  ),
  v.check(
    (metadata) =>
      metadata.startStep === undefined ||
      ((metadata.startStep > 0 || metadata.startPartial === true) &&
        metadata.variant !== undefined &&
        metadata.chooser === undefined &&
        (metadata.route !== "password" || metadata.startStep < metadata.stepCount) &&
        (metadata.stopAt === undefined || metadata.startStep < metadata.stopAt)),
    "A later start needs a password variant, inside its plan and before any stop",
  ),
  v.check(
    (metadata) => metadata.startPartial === undefined || metadata.startStep !== undefined,
    "A start with the password alone needs its step",
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
    "Only a password login is watched",
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
      !("operationId" in metadata.continuation) ||
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
