/**
 * Automatic logins of a site that may end `authenticated` within `RELOGIN_WINDOW_MS`; the
 * next one asks for an account instead (`relogin-limit`, ADR 0062).
 */
export const RELOGIN_LIMIT = 2;

export const RELOGIN_WINDOW_MS = 10 * 60_000;

/**
 * How long another tab's login that has not succeeded holds its origin after its record
 * last changed (ADR 0022, owner's choice on 2026-10-12).
 */
export const HOLD_MS = 5 * 60_000;

/**
 * How often a login page offered for generation is read before it counts as one that
 * cannot be described, and how long apart: a form rendered in steps or fading in settles
 * meanwhile, for about nine seconds after the page offers itself (ADR 0016).
 */
export const EXTRACT_READS = 10;

/**
 * At most this many matching items' usernames are looked for in a page's header or
 * navigation for its generation request's `signedIn` hint (ADR 0035), one page read each.
 */
export const MAX_HINT_USERNAMES = 8;

export const EXTRACT_RETRY_MS = 1000;

/** How soon after a password submission the tab's next page counts as right after it (ADR 0028). */
export const AFTER_SIGN_IN_MS = 60_000;

/**
 * How long after another tab's login of an origin authenticated a list of accounts showing
 * on it is not sent for generation (ADR 0028, owner 2026-10-17).
 */
export const SIGNED_IN_ELSEWHERE_MS = 60 * 60_000;

/**
 * How long after evidence of a sign-in the page is read again before the login completes
 * on it (ADR 0029), so a page that is still redirecting or about to ask for a second
 * factor does not settle the login, and how many times it is read again at most while
 * the document is still loading.
 */
export const SIGN_IN_RECHECK_MS = 1000;

export const SIGN_IN_RECHECKS = 10;

/**
 * How soon after a passkey answer, or after a password login's last effect step, a move to
 * another origin of that site may complete (ADR 0022), and a new document may be the site's
 * answer to the step, read for a sign-in form shown again (ADR 0029).
 */
export const SITE_MOVE_MS = 30_000;

/**
 * How long after the passkey bridge answered a tab's top document outside a login no new
 * automatic login starts on that page: the assertion is the page's sign-in, and the site
 * moves on by itself. A form still showing after it is read as the site's refusal, as for
 * a login's own answer (ADR 0034 rule 6).
 */
export const PASSKEY_SIGN_IN_MS = 15_000;

export const PASSKEY_SIGNED_IN = "passkey-signed-in";

/** How long a master password typed for a re-prompt item lets its document's login start. */
export const REPROMPT_GRANT_MS = 60_000;

/** Readings of that move's new page, a second apart, before it must have loaded quietly. */
export const SITE_MOVE_READINGS = 5;

/**
 * How long a login stays watched after its result stopped at `challenge` or settled as
 * unknown (ADR 0027, owner's choice on 2026-10-12), and how long each new page of its tab
 * is checked for a signed-in marker before its sign-in state is read, as after a click.
 */
export const WATCH_MS = 10 * 60_000;

export const WATCH_SETTLE_MS = 3000;

/** A tab presses a sign-in entry at most once in this time (ADR 0031). */
export const ENTRY_PRESS_MS = 10 * 60_000;

/** How soon after a press the next page must show: a new document or a URL change. */
export const ENTRY_NEXT_PAGE_MS = 10_000;

/** Blocks kept at most; the oldest go first. */
export const MAX_ENTRY_BLOCKS = 100;

/**
 * An account switch's waits (ADR 0063): how often the tab is looked at after a click, how
 * long a page that stays the same must be quiet before it counts as settled, as when a menu
 * opened, how long the tab may take to settle at all, and how long its sign-in input is
 * waited for once it did.
 */
export const SWITCH_POLL_MS = 250;

export const SWITCH_QUIET_MS = 1500;

export const SWITCH_SETTLE_MS = 15_000;

export const SWITCH_CHECK_MS = 1500;

/**
 * How long a page's own conditional passkey request waits for a login of its document to
 * start before it is handed on (ADR 0034).
 */
export const REQUEST_START_WAIT_MS = 3000;

/**
 * Longest a conditional request waits for its login to end, or for a pick while its tab
 * asks for an account (ADR 0021 D); it is then withheld, so a login that runs that long never meets another provider's prompt
 * (ADR 0034). One that waits this long for a pick in an ordinary popup choice is handed on.
 */
export const REQUEST_PARK_MS = 4 * 60_000;

/**
 * How long the `passkey` route waits for its page's own request before it falls back, and
 * a login of an item without a password waits at its stop (ADR 0036).
 */
export const REQUEST_WAIT_MS = 3000;

/**
 * How long the start page's sign-in form may still show in the document after the
 * `passkey` route answered its request, before the login falls back (ADR 0034), and the
 * form after an answer at a login's stop, before it ends (ADR 0036).
 */
export const REQUEST_HOLD_MS = 15_000;

/** Internal: admit again, because an account choice was saved while admitting (ADR 0022). */
export const CHOICE_SAVED = "choice-saved";

export const probeMode = import.meta.env.MODE === "probe";

/** How many of an unconfirmed in-place advance's next targets the log names (ADR 0019). */
export const ADVANCE_LOG_TARGETS = 4;

/**
 * How long the page after a recipe's final `advance` step must keep showing a sign-in input,
 * on one path, before it is sent to continue the recipe (ADR 0018).
 */
export const CONTINUATION_STABLE_MS = 1000;

/**
 * How long a later document of the login waits for the continuation its earlier document
 * asked for (ADR 0018); the request itself gives up after 90 seconds.
 */
export const CONTINUATION_WAIT_MS = 100_000;

/** Custom-field values read for their shapes per generation request (ADR 0027). */
export const MAX_CUSTOM_SHAPE_READS = 32;
