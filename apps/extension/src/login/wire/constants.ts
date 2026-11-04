/**
 * How many times a document announces a ready first step before it waits until the form
 * goes, each try about half a second after a refusal that may pass, such as a stale
 * announcement. The worker counts them to log the page giving up (ADR 0019).
 */
export const START_TRIES = 4;
/**
 * How long apart a document's tries of one start may be to count together. The worker
 * cannot see the form go and come back between tries, so the count is an estimate: a
 * short window keeps a form that flickers from counting as one that gave up.
 */
export const START_TRY_WINDOW_MS = 2000;
/** How long a started attempt waits for a fill or click step's elements (owner-approved). */
export const LOGIN_STEP_WAIT_MS = 10000;
/**
 * How long an account switch waits for the page to react to a logout control it found by
 * its words before the page goes to the model (ADR 0063, owner 2026-10-23).
 */
export const LOGOUT_REACTION_MS = 5000;
/**
 * How long a page is left unjudged while a held click's button still shows (ADR 0027): a
 * handler's, such as "Use security key", or the `passkey` route's, such as "Sign in with a
 * passkey", during a WebAuthn exchange; the passkey chooser's limit.
 */
export const HELD_CLICK_WAIT_MS = 120_000;
/** The longest a `login.extract.watch` lasts: a watched login's 10 minutes (`WATCH_MS`, ADR 0027). */
export const DESCRIBED_WATCH_MAX_MS = 10 * 60_000;
