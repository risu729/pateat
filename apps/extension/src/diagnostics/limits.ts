/** A clock further off than one TOTP step makes generated codes fail. */
export const CLOCK_SKEW_WARNING_MS = 30_000;
/** Recipe sync normally runs every few minutes while the browser is in use. */
export const RECIPE_SYNC_OVERDUE_MS = 24 * 60 * 60 * 1000;
