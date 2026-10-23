import * as v from "valibot";
import { extensionBuildSchema } from "./sync";

// What one `warn` or `error` line, or `info` line saying why Pateat did nothing, of a
// device's local log may carry to the service (ADR 0066). The extension's log allowlists
// every event's fields by kind (ADR 0019); this is that allowlist less the item and
// connection pseudonyms, with a page URL as a redacted path, so the service checks each
// field by its kind too and the extension's own reduction is not the only boundary.

/** Log lines one problem report carries at most. */
export const MAX_PROBLEM_ENTRIES = 100;
/** The longest string a problem line's field holds: the local log's field limit (ADR 0019). */
export const MAX_PROBLEM_FIELD_LENGTH = 512;
/** Fields one problem line carries at most; the widest log event has fewer. */
export const MAX_PROBLEM_FIELDS = 40;

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const pseudonym = (prefix: string) => new RegExp(`^${prefix}:[0-9a-f]{8}$`, "u");

/**
 * Each kind of field a problem line carries, as the local log's kinds: none holds
 * whitespace but a stack's positions, none `@`, `?` or `#`, and only an origin holds
 * `://`. An origin is a configured site's, or the `origin:` pseudonym the device made of
 * any other; a path is a page's path alone, its token-like and email-like segments
 * already `[id]`.
 */
export const PROBLEM_FIELD_KINDS = {
  code: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9.:-]{0,63}$/u)),
  name: v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u)),
  count,
  time: count,
  flag: v.boolean(),
  revision: v.pipe(v.string(), v.regex(/^[0-9A-Za-z._-]{1,64}$/u)),
  recipe: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_.:-]{1,120}$/u)),
  origin: v.pipe(
    v.string(),
    v.check(
      (value) =>
        /^https?:\/\/(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/u.test(value) ||
        pseudonym("origin").test(value),
    ),
  ),
  rpId: v.pipe(
    v.string(),
    v.check((value) => /^[a-z0-9.-]{1,253}$/u.test(value) || pseudonym("rp").test(value)),
  ),
  stack: v.pipe(v.string(), v.regex(/^[\w.-]+\.js:\d+:\d+(?: [\w.-]+\.js:\d+:\d+){0,4}$/u)),
  path: v.pipe(
    v.string(),
    v.maxLength(MAX_PROBLEM_FIELD_LENGTH),
    v.regex(/^\/[!-~]*$/u),
    // `;` and `=` mark a parameter, and the device redacts any segment holding them.
    v.check((value) => !/[@?#;=]/u.test(value) && !/%(?:25)*40/iu.test(value)),
  ),
} as const satisfies Record<string, v.GenericSchema<unknown, string | number | boolean>>;
export type ProblemFieldKind = keyof typeof PROBLEM_FIELD_KINDS;

/**
 * The fields each local log event may carry to the service, by kind. The extension's test
 * holds it equal to its log's events, less item and connection pseudonyms.
 */
export const PROBLEM_EVENT_FIELDS = {
  "runtime.started": { build: "revision" },
  "runtime.updated": { previousBuild: "revision", build: "revision", version: "revision" },
  "vault.state": { state: "code", previous: "code", providerSession: "code", synced: "flag" },
  "vault.sync": { outcome: "code", check: "code" },
  "vault.sign-in": { step: "code", outcome: "code" },
  "vault.check": { outcome: "code" },
  "vault.timeout": { trigger: "code", action: "code", outcome: "code" },
  "vault.refresh": { outcome: "code", cause: "code", status: "count" },
  "service.sync": {
    outcome: "code",
    scope: "code",
    added: "count",
    updated: "count",
    removed: "count",
    roundTripMs: "count",
    serverMs: "count",
    networkMs: "count",
  },
  "service.outcome": { recipe: "recipe", recipeRevision: "count", branch: "code", result: "code" },
  "service.login": { recipe: "recipe", recipeRevision: "count", branch: "code", result: "code" },
  "service.use": { recipe: "recipe", recipeRevision: "count", layout: "code", result: "code" },
  "service.problems": { lines: "count", result: "code" },
  "settings.changed": { source: "code", revision: "count" },
  "login.attempt": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    variant: "count",
    state: "code",
    step: "count",
    steps: "count",
    operation: "code",
    effect: "code",
    handler: "count",
    outcome: "code",
    cause: "code",
    reason: "code",
    settled: "flag",
    unconfirmed: "flag",
    unsubmitted: "flag",
    routeChange: "code",
    stop: "code",
    totalMs: "count",
    serviceMs: "count",
    networkMs: "count",
    personMs: "count",
    pageMs: "count",
    otherMs: "count",
    url: "path",
  },
  "login.entry": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    outcome: "code",
    reason: "code",
    detail: "code",
    url: "path",
  },
  "login.handler": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    handler: "count",
    kind: "code",
    outcome: "code",
    steps: "count",
    url: "path",
  },
  "login.state": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    decision: "code",
    s1: "flag",
    s2: "flag",
    s3: "flag",
    s4: "flag",
    s5: "flag",
    f1: "flag",
    f2: "flag",
    e1: "flag",
    e2: "flag",
    e3: "flag",
    reshown: "flag",
    reshownMiss: "code",
    alertMiss: "code",
    advanceBefore: "code",
    advanceAfter: "code",
    advanceWhy: "code",
    advancePath: "code",
    settled: "flag",
    url: "path",
  },
  "login.move": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    reason: "code",
    frame: "flag",
    kept: "flag",
    url: "path",
  },
  "login.refused": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    reason: "code",
    detail: "code",
    pageKind: "code",
    amount: "flag",
    e1: "flag",
    e2: "flag",
    candidates: "count",
    frame: "flag",
    url: "path",
  },
  "login.confirm-left": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    pageKind: "code",
    personSubmitted: "flag",
    nextE1: "flag",
    url: "path",
  },
  "login.start": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    layout: "code",
    layouts: "count",
    route: "code",
    variant: "count",
    account: "code",
    candidates: "count",
    fillOnly: "flag",
    startStep: "count",
    list: "code",
    listUsername: "code",
    listEntries: "count",
    listMasked: "count",
    listSameDomain: "count",
    listFits: "count",
    listEntryMiss: "code",
    listBeside: "count",
    listNamed: "count",
    listOther: "code",
    listContinue: "code",
    url: "path",
  },
  "login.logout": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    rejected: "flag",
    clicked: "flag",
    url: "path",
  },
  "login.ask-ended": { origin: "origin", ask: "code", cause: "code", elsewhere: "flag" },
  "login.choice": { origin: "origin", outcome: "code", url: "path" },
  "login.popup": {
    origin: "origin",
    choice: "code",
    candidates: "count",
    logout: "code",
    held: "flag",
    rejectedElsewhere: "flag",
    recordState: "code",
    recordOutcome: "code",
    pageReason: "code",
    url: "path",
  },
  "login.exception": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    state: "code",
    step: "count",
    unsubmitted: "flag",
    name: "name",
    message: "code",
    stack: "stack",
    url: "path",
  },
  "recipe.generate": {
    origin: "origin",
    outcome: "code",
    reason: "code",
    check: "code",
    detail: "code",
    path: "code",
    recipe: "recipe",
    baseRevision: "count",
    takenOver: "flag",
    notTakenOver: "code",
    page: "code",
    pageKind: "code",
    signedIn: "flag",
    roundTripMs: "count",
    serverMs: "count",
    networkMs: "count",
    tokenMs: "count",
    modelMs: "count",
    url: "path",
  },
  "recipe.judge": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    verdict: "code",
    reason: "code",
    takenOver: "flag",
    watched: "flag",
    completed: "flag",
    disabledLeftOut: "flag",
    notCompleted: "code",
    moved: "flag",
    stop: "code",
    beside: "flag",
    roundTripMs: "count",
    serverMs: "count",
    networkMs: "count",
    tokenMs: "count",
    modelMs: "count",
    url: "path",
  },
  "recipe.revoke": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    outcome: "code",
    reason: "code",
    detail: "code",
    roundTripMs: "count",
    serverMs: "count",
    networkMs: "count",
    url: "path",
  },
  "recipe.sample": {
    origin: "origin",
    recipe: "recipe",
    recipeRevision: "count",
    route: "code",
    outcome: "code",
    reason: "code",
    url: "path",
  },
  "passkey.request": {
    origin: "origin",
    rpId: "rpId",
    outcome: "code",
    reason: "code",
    allowCredentials: "count",
    stored: "count",
    accepted: "count",
    siteDefault: "count",
    siteDefaultAccepted: "count",
    siteDefaultItem: "code",
    complete: "flag",
    chooser: "code",
    signedBefore: "flag",
    logoutClicked: "flag",
    mediation: "code",
    uiMode: "code",
    duringLogin: "flag",
    answerFailed: "code",
    cause: "code",
    invalid: "code",
    invalidLength: "count",
  },
  "passkey.create": {
    origin: "origin",
    rpId: "rpId",
    outcome: "code",
    reason: "code",
    mediation: "code",
    excludeCredentials: "count",
    listed: "flag",
    sinceSignIn: "count",
  },
  "error.unhandled": { source: "code", name: "name", message: "code", stack: "stack" },
  "log.dropped": { origin: "origin", dropped: "code", count: "count" },
  "log.debug": { enabled: "flag", until: "time" },
} as const satisfies Record<string, Readonly<Record<string, ProblemFieldKind>>>;
export type ProblemEventName = keyof typeof PROBLEM_EVENT_FIELDS;
/** Fields any event a page caused carries besides its own: the Chrome tab ID (ADR 0019). */
export const PROBLEM_PAGE_FIELDS = { tab: "count" } as const satisfies Record<
  string,
  ProblemFieldKind
>;

/**
 * The `info` lines that say why Pateat did nothing on a page, which leave like `warn` and
 * `error` lines (ADR 0066; owner, 2026-10-23 13:00 UTC): each event with the `outcome`
 * values that count, or `"any"` for every `info` line of it. A refused login or sign-in
 * entry press, and a page generation skipped, abstained from or found unavailable.
 */
export const PROBLEM_INFO_LINES = {
  "login.refused": "any",
  "login.entry": ["refused"],
  "recipe.generate": ["skipped", "abstained", "unavailable"],
} as const satisfies Partial<Record<ProblemEventName, "any" | readonly string[]>>;

/** Whether an `info` line of `event` with these fields says why Pateat did nothing. */
export function problemInfoLine(event: string, fields: Readonly<Record<string, unknown>>): boolean {
  const lines: Readonly<Record<string, "any" | readonly string[]>> = PROBLEM_INFO_LINES;
  const outcomes = Object.hasOwn(lines, event) ? lines[event] : undefined;
  if (outcomes === "any") return true;
  const outcome = fields["outcome"];
  return outcomes !== undefined && typeof outcome === "string" && outcomes.includes(outcome);
}

export const problemLevelSchema = v.picklist(["info", "warn", "error"]);
export const problemLogIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u));
/** A local log event name, such as `login.attempt`. */
export const problemEventSchema = v.picklist(
  Object.keys(PROBLEM_EVENT_FIELDS) as [ProblemEventName, ...ProblemEventName[]],
);
export const problemFieldsSchema = v.pipe(
  v.record(
    v.pipe(v.string(), v.regex(/^[a-z][A-Za-z0-9]{0,39}$/u)),
    v.union([v.pipe(v.string(), v.maxLength(MAX_PROBLEM_FIELD_LENGTH)), count, v.boolean()]),
  ),
  v.check((fields) => Object.keys(fields).length <= MAX_PROBLEM_FIELDS),
);

/** Whether each field is one `event` may carry and holds a value of its kind. */
export function problemFieldsAllowed(
  event: ProblemEventName,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  const kinds: Readonly<Record<string, ProblemFieldKind>> = {
    ...PROBLEM_PAGE_FIELDS,
    ...PROBLEM_EVENT_FIELDS[event],
  };
  return Object.entries(fields).every(([key, value]) => {
    const kind = Object.hasOwn(kinds, key) ? kinds[key] : undefined;
    return kind !== undefined && v.is(PROBLEM_FIELD_KINDS[kind], value);
  });
}

/**
 * One `warn` or `error` line, or `info` line of {@link PROBLEM_INFO_LINES}, of the device's
 * local log as it leaves the device: the event, its level and time, and only the fields
 * that event may carry, each of its kind.
 */
export const problemEntrySchema = v.pipe(
  v.strictObject({
    /** The local log's own key, counting up on the device; a retry repeats it. */
    seq: v.pipe(count, v.minValue(1)),
    /** When the device wrote the line, in epoch milliseconds by its clock. */
    time: count,
    level: problemLevelSchema,
    event: problemEventSchema,
    fields: problemFieldsSchema,
  }),
  v.check((entry) => problemFieldsAllowed(entry.event, entry.fields)),
  v.check((entry) => entry.level !== "info" || problemInfoLine(entry.event, entry.fields)),
);
/**
 * `POST /v1/device/problems`: the device's `warn` and `error` log lines, and `info` lines of
 * {@link PROBLEM_INFO_LINES}, it has not sent yet, oldest first. Never a vault value, page
 * text, query, fragment, email address, or item or connection pseudonym. The service adds
 * the device, from the credential, and its own time.
 */
export const problemReportSchema = v.strictObject({
  version: v.literal(1),
  /** The build that wrote every line of the report, so stack positions read against it. */
  extensionBuild: extensionBuildSchema,
  /**
   * The device log's random ID, made with its database: a log made again restarts its
   * `seq`, and its lines stay apart from the old log's.
   */
  logId: problemLogIdSchema,
  entries: v.pipe(v.array(problemEntrySchema), v.minLength(1), v.maxLength(MAX_PROBLEM_ENTRIES)),
});
/**
 * A problem report as the service reads it: the same envelope, with each entry checked on
 * its own by {@link problemEntrySchema}. The service keeps the entries that pass and leaves
 * out the rest, so a newer extension whose lines an older service does not know yet loses
 * only those lines, not the good ones beside them that it would never send again.
 */
export const problemReportEnvelopeSchema = v.strictObject({
  ...problemReportSchema.entries,
  entries: v.pipe(v.array(v.unknown()), v.minLength(1), v.maxLength(MAX_PROBLEM_ENTRIES)),
});
export type ProblemEntry = v.InferOutput<typeof problemEntrySchema>;
export type ProblemReport = v.InferOutput<typeof problemReportSchema>;
