export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const LOG_RETENTION_MS = 14 * 24 * HOUR_MS;
export const DEBUG_RETENTION_MS = 24 * HOUR_MS;
export const DEBUG_LOGGING_MS = 24 * HOUR_MS;
/**
 * In development and testing builds, debug logging once turned on stays on until it is
 * turned off rather than for {@link DEBUG_LOGGING_MS}, so the detail of a login that goes
 * wrong is there (owner, 2026-10-18). A release build (`PATEAT_RELEASE=true` at build
 * time) leaves it off, and reads a stored {@link DEBUG_UNTIL_TURNED_OFF} as off.
 */
export const DEBUG_STAYS_ON = PATEAT_DEBUG_STAYS_ON;
/** The stored deadline of debug logging that stays on until it is turned off. */
export const DEBUG_UNTIL_TURNED_OFF = 8_640_000_000_000_000;
/**
 * `debug` and `info` entries kept at most; the oldest `debug` entries go first. About 14
 * days at an estimated 1,000 a day on a testing day (ADR 0019).
 */
export const LOG_ENTRY_LIMIT = 14_000;
/** `warn` and `error` entries have their own allowance, so routine entries cannot evict them. */
export const LOG_PROBLEM_LIMIT = 1_000;
export const PRUNE_EVERY_WRITES = 500;
/**
 * Events other than `debug` and a login attempt's state changes caused by a web page, per
 * tab and origin; a login writes 6 to 8.
 */
export const PAGE_EVENTS_PER_MINUTE = 30;
/**
 * A login attempt's state changes (`login.attempt` other than `debug`) per tab and origin,
 * counted on their own so a long login still logs how it ended; one attempt writes a few.
 */
export const PAGE_ATTEMPT_EVENTS_PER_MINUTE = 60;
/**
 * `debug` events caused by a web page, per tab and origin, counted on their own. One
 * login with a second factor writes over 20 step lines in its first 15 seconds
 * (app.notion.com, 2026-11-04), so debug logging keeps a few logins' detail a minute.
 */
export const PAGE_DEBUG_EVENTS_PER_MINUTE = 120;
export const MAX_FIELD_LENGTH = 512;
export const TRUNCATED = "[truncated]";

/**
 * How a field is checked and recorded:
 * - `code`: a Pateat state or reason code.
 * - `name`: an `Error` class name.
 * - `count`, `time`: non-negative integers.
 * - `flag`: a boolean.
 * - `revision`: a build revision or version.
 * - `recipe`: a recipe ID from the service.
 * - `origin`, `rpId`: recorded in full only for sites the settings or recipes name.
 * - `connection`, `item`: always pseudonyms.
 * - `stack`: extension script positions such as `background.js:12:345`.
 * - `url`: a page URL's path with its query's and fragment's parameter names but no values,
 *   kept only when the entry's `origin` is the URL's own and is recorded in full
 *   (ADR 0019); cut at the field length.
 */
export type FieldKind =
  | "code"
  | "name"
  | "count"
  | "time"
  | "flag"
  | "revision"
  | "recipe"
  | "origin"
  | "rpId"
  | "connection"
  | "item"
  | "stack"
  | "url";

export type EventDefinition = { level: LogLevel; fields: Readonly<Record<string, FieldKind>> };

/**
 * Fields every event a page caused records besides its own: the Chrome tab ID, so two tabs
 * of one site can be told apart (ADR 0019, amended 2026-10-19). Chrome numbers tabs within
 * a browser session; the number says nothing about the page.
 */
export const PAGE_FIELDS: Readonly<Record<string, FieldKind>> = { tab: "count" };

export const LOG_EVENTS = {
  "runtime.started": { level: "debug", fields: { build: "revision" } },
  "runtime.updated": {
    level: "info",
    fields: { previousBuild: "revision", build: "revision", version: "revision" },
  },
  "vault.state": {
    level: "info",
    fields: {
      connection: "connection",
      state: "code",
      previous: "code",
      providerSession: "code",
      synced: "flag",
    },
  },
  "vault.sync": {
    level: "info",
    fields: { connection: "connection", outcome: "code", check: "code" },
  },
  "vault.sign-in": { level: "info", fields: { step: "code", outcome: "code" } },
  "vault.check": {
    level: "info",
    fields: { connection: "connection", outcome: "code", cause: "code", status: "count" },
  },
  // The vault timeout locked or logged out the vaults (ADR 0075).
  "vault.timeout": { level: "info", fields: { trigger: "code", action: "code", outcome: "code" } },
  "vault.refresh": {
    level: "info",
    fields: { connection: "connection", outcome: "code", cause: "code", status: "count" },
  },
  "service.sync": {
    level: "info",
    fields: {
      outcome: "code",
      scope: "code",
      added: "count",
      updated: "count",
      removed: "count",
      // Changes left out because this build cannot read their recipe (#959).
      unreadable: "count",
      // The run's requests added up (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
    },
  },
  // A first login's result code sent to the service (ADR 0019, amended 2026-10-18).
  "service.outcome": {
    level: "info",
    fields: { recipe: "recipe", recipeRevision: "count", branch: "code", result: "code" },
  },
  // A login's result and times sent to the service (ADR 0055).
  "service.login": {
    level: "info",
    fields: { recipe: "recipe", recipeRevision: "count", branch: "code", result: "code" },
  },
  // A login that started on a recipe revision, sent so the recipe is kept (ADR 0058).
  "service.use": {
    level: "info",
    fields: { recipe: "recipe", recipeRevision: "count", layout: "code", result: "code" },
  },
  // Warning and error lines sent to the service (ADR 0066). Never `warn`, so a
  // failed send is not itself a line to send.
  "service.problems": { level: "info", fields: { lines: "count", result: "code" } },
  "settings.changed": { level: "info", fields: { source: "code", revision: "count" } },
  "login.attempt": {
    level: "info",
    fields: {
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
      fieldIndex: "count",
      reason: "code",
      settled: "flag",
      unconfirmed: "flag",
      // A completion its document's sign-in form corrected (ADR 0029, amended 2026-11-03).
      corrected: "flag",
      // Nothing submitted yet, in the document the login began in (ADR 0066).
      unsubmitted: "flag",
      // A fill-only login of a tab that asks (ADR 0062 B), whose lines stay local (ADR 0066).
      fillOnly: "flag",
      routeChange: "code",
      layout: "code",
      layoutFrom: "code",
      stop: "code",
      // How long a login that ended took (ADR 0019, amended 2026-10-18).
      totalMs: "count",
      serviceMs: "count",
      networkMs: "count",
      personMs: "count",
      pageMs: "count",
      otherMs: "count",
      // Where the login's own time went, kept on the device (ADR 0019, amended 2026-11-03).
      beforeShownMs: "count",
      startMs: "count",
      awaitMs: "count",
      saveMs: "count",
      statusMs: "count",
      checkMs: "count",
      vaultMs: "count",
      commandMs: "count",
      url: "url",
    },
  },
  "login.entry": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      outcome: "code",
      reason: "code",
      detail: "code",
      url: "url",
    },
  },
  // An account switch from the popup (ADR 0063): its start, each logout click, and its end.
  "login.switch": {
    level: "info",
    fields: {
      origin: "origin",
      stage: "code",
      outcome: "code",
      reason: "code",
      detail: "code",
      purpose: "code",
      source: "code",
      learned: "flag",
      clicks: "count",
      recipe: "recipe",
      recipeRevision: "count",
      makeDefault: "flag",
      url: "url",
    },
  },
  "login.handler": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      handler: "count",
      kind: "code",
      outcome: "code",
      steps: "count",
      why: "code",
      url: "url",
    },
  },
  "login.state": {
    level: "info",
    fields: {
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
      url: "url",
    },
  },
  "login.move": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      reason: "code",
      frame: "flag",
      kept: "flag",
      url: "url",
    },
  },
  "login.refused": {
    level: "info",
    fields: {
      origin: "origin",
      reason: "code",
      detail: "code",
      candidates: "count",
      // For `not-started` with `confirm-unsupported`: the recipe generated as a
      // verification that starts on the page, and its kind (ADR 0035); with
      // `first-step-missing`, the recipe whose first step missed.
      recipe: "recipe",
      recipeRevision: "count",
      pageKind: "code",
      // Also for `confirm-unsupported`, for the evaluation of page kinds: whether an amount
      // shows in the form, ADR 0029's E1 and E2, and the tab's previous page (ADR 0035).
      amount: "flag",
      e1: "flag",
      e2: "flag",
      previousUrl: "url",
      // For `not-started`: the later steps watched on the page's path, how many start with
      // their password alone, and the furthest check they reached (ADR 0049).
      laterSteps: "count",
      laterPartial: "count",
      laterMiss: "code",
      frame: "flag",
      url: "url",
    },
  },
  // The tab left a page logged `confirm-unsupported`: whether the person submitted its
  // form, and for a page without E1 or E2 whether the next page shows E1 (ADR 0035).
  "login.confirm-left": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      pageKind: "code",
      personSubmitted: "flag",
      nextE1: "flag",
      url: "url",
    },
  },
  "login.start": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      // The layout the login runs, and how many it chose among (ADR 0060).
      layout: "code",
      layouts: "count",
      route: "code",
      variant: "count",
      account: "code",
      candidates: "count",
      item: "item",
      fillOnly: "flag",
      startStep: "count",
      startPartial: "flag",
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
      url: "url",
    },
  },
  // A tab that asked for an account closed; other tabs that asked only because the site
  // rejected its login stop asking (ADR 0021 D).
  "login.ask-ended": {
    level: "info",
    fields: { origin: "origin", ask: "code", cause: "code", elsewhere: "flag" },
  },
  "login.choice": { level: "info", fields: { origin: "origin", outcome: "code", url: "url" } },
  // Automatic login of a site paused or resumed in the popup, or ended by a picked login
  // that authenticated (ADR 0062).
  "login.pause": {
    level: "info",
    fields: { origin: "origin", action: "code", length: "code", incognito: "flag", url: "url" },
  },
  "login.popup": {
    level: "info",
    fields: {
      origin: "origin",
      choice: "code",
      candidates: "count",
      ask: "code",
      paused: "flag",
      held: "flag",
      rejectedElsewhere: "flag",
      recordState: "code",
      recordOutcome: "code",
      pageReason: "code",
      url: "url",
    },
  },
  "login.exception": {
    level: "warn",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      state: "code",
      step: "count",
      unsubmitted: "flag",
      fillOnly: "flag",
      name: "name",
      message: "code",
      stack: "stack",
      url: "url",
    },
  },
  "recipe.generate": {
    level: "info",
    fields: {
      origin: "origin",
      outcome: "code",
      reason: "code",
      check: "code",
      detail: "code",
      path: "code",
      recipe: "recipe",
      baseRevision: "count",
      takenOver: "flag",
      // Why a returned recipe was not taken over (ADR 0027, amended 2026-10-19).
      notTakenOver: "code",
      // `accounts` for a list of accounts (ADR 0028), `entry` for a sign-in entry (ADR 0031),
      // `other` for a form on a chooser's path sent as its `other` branch (ADR 0028),
      // `repair` for a stale recipe's start page (ADR 0041).
      page: "code",
      // A returned route recipe's page kind, and the `signedIn` hint a recipe's first page
      // was sent with (ADR 0035).
      pageKind: "code",
      signedIn: "flag",
      // How long the request took (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
      tokenMs: "count",
      modelMs: "count",
      url: "url",
    },
  },
  "recipe.judge": {
    level: "info",
    fields: {
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
      // `password` for the page of a login's stop before its item's missing password (ADR 0036).
      stop: "code",
      // A page that still shows the sign-in form beside another form (ADR 0061).
      beside: "flag",
      // How long the request took (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
      tokenMs: "count",
      modelMs: "count",
      url: "url",
    },
  },
  // A generated recipe's start page that missed its first steps (ADR 0041).
  "recipe.repair": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      outcome: "code",
      reason: "code",
      url: "url",
    },
  },
  // A recipe the chosen item cannot run, whose start page is sent for repair (ADR 0058 A,
  // amended by ADR 0041).
  "recipe.unfit": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      outcome: "code",
      reason: "code",
      detail: "code",
      url: "url",
    },
  },
  // A repeat login's signed-in page sample (ADR 0029): codes only, never the page.
  "recipe.sample": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      outcome: "code",
      reason: "code",
      url: "url",
    },
  },
  "passkey.request": {
    level: "info",
    fields: {
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
      defaultUnset: "flag",
      mediation: "code",
      uiMode: "code",
      duringLogin: "flag",
      paused: "flag",
      answerFailed: "code",
      cause: "code",
      invalid: "code",
      invalidLength: "count",
    },
  },
  // A checked `navigator.credentials.create` request (ADR 0007): never a credential ID.
  "passkey.create": {
    level: "info",
    fields: {
      origin: "origin",
      rpId: "rpId",
      outcome: "code",
      reason: "code",
      mediation: "code",
      excludeCredentials: "count",
      listed: "flag",
      sinceSignIn: "count",
    },
  },
  "error.unhandled": {
    level: "error",
    fields: { source: "code", name: "name", message: "code", stack: "stack" },
  },
  "log.dropped": {
    level: "warn",
    fields: { origin: "origin", dropped: "code", count: "count" },
  },
  "log.debug": { level: "info", fields: { enabled: "flag", until: "time" } },
} as const satisfies Record<string, EventDefinition>;
export type LogEventName = keyof typeof LOG_EVENTS;
export type FieldValue = string | number | boolean;
export type LogFields<E extends LogEventName> = {
  [K in keyof (typeof LOG_EVENTS)[E]["fields"]]?: FieldValue | undefined;
};

/**
 * Error messages kept in `error.unhandled`. Any other message may quote input, such as
 * a page's text in a parse error, so only these codes thrown by Pateat itself are kept.
 */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "immutable-configuration",
  "invalid-configuration",
  "invalid-request",
  "passkey-stale",
  "passkey-unavailable",
  "revision-conflict",
  "storage-corrupt",
  "storage-failed",
  "vault-unavailable",
]);
