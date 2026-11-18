import * as v from "valibot";

// Which sign-in method a login used, beside the methods its vault item holds (ADR 0055,
// amendment of 2026-11-18): the login record carries them, and a login that passed over a
// better method without the person's choice logs a `login.route` warning (ADR 0066,
// amendment of 2026-11-18). Codes only: never a value, RP ID, username or label.

/**
 * The sign-in methods in the automatic order (ADR 0085): a passkey first, then the item's
 * preferred SSO method, then its own password.
 */
export const LOGIN_METHODS = ["passkey", "sso", "password"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

/**
 * Why a login did not use the best method its item holds, as the device saw it. Each is
 * `true` when it may be a bug to fix, `false` when it is the person's choice or a setting.
 *
 * - `no-passkey-route`: the recipe has no passkey button and the page asked for no passkey
 *   by itself.
 * - `request-missing`, `answer-failed`, `sign-in-rejected`, `sign-in-shown`: the login
 *   went back from the passkey to the password (ADR 0034): the page's request went away
 *   before the answer, the item could not answer it, the site showed its rejection after
 *   the answer, or the sign-in form still showed after it.
 * - `passkey-refused`: the site refused the passkey, and the chooser picked again without
 *   it (ADR 0085).
 * - `later-start`: the login started at a later step (ADR 0049), past the first page's
 *   passkey button.
 * - `unknown`: none of these, which the device cannot tell.
 * - `picked`: the person picked the method in the popup.
 * - `fill-only`: a fill-only login of a tab that asks (ADR 0021 D), whose lines stay local.
 * - `sign-in-fill`: the page's sign-in setting fills and leaves the submit to the person
 *   (ADR 0035).
 * - `sso-not-automatic`: none of the item's SSO methods is chosen automatically, so the
 *   chooser takes the password (ADR 0085).
 * - `not-answered`: the login took the passkey's own route and ended before it answered,
 *   without going back to the password; its own line says how it ended.
 */
export const LOGIN_METHOD_WHYS = {
  "no-passkey-route": true,
  "request-missing": true,
  "answer-failed": true,
  "sign-in-rejected": true,
  "sign-in-shown": true,
  "passkey-refused": true,
  "later-start": true,
  unknown: true,
  picked: false,
  "fill-only": false,
  "sign-in-fill": false,
  "sso-not-automatic": false,
  "not-answered": false,
} as const satisfies Record<string, boolean>;
export type LoginMethodWhy = keyof typeof LOGIN_METHOD_WHYS;
export const loginMethodWhySchema = v.picklist(
  Object.keys(LOGIN_METHOD_WHYS) as [LoginMethodWhy, ...LoginMethodWhy[]],
);

/** The methods in the automatic order, joined with dots, as `passkey.password`; `none` for none. */
export function loginMethodList(methods: Iterable<LoginMethod>): string {
  const set = new Set(methods);
  const listed = LOGIN_METHODS.filter((method) => set.has(method));
  return listed.length ? listed.join(".") : "none";
}

/** The methods a {@link loginMethodList} names, or undefined for anything else. */
export function parseLoginMethodList(value: string): LoginMethod[] | undefined {
  if (value === "none") return [];
  const parts = value.split(".");
  const listed = LOGIN_METHODS.filter((method) => parts.includes(method));
  return listed.length === parts.length && listed.join(".") === value ? listed : undefined;
}

/** What a login used (`none` when nothing: a code alone, or no sign-in step it took). */
export const loginUsedMethodsSchema = v.pipe(
  v.string(),
  v.check((value) => parseLoginMethodList(value) !== undefined, "Unknown sign-in methods."),
);
/** What the item holds: at least one method. */
export const loginHeldMethodsSchema = v.pipe(
  v.string(),
  v.check((value) => !!parseLoginMethodList(value)?.length, "Unknown sign-in methods."),
);

/**
 * The method better than its own password that the item holds and the login did not use:
 * the best one the item holds, when it is a passkey or an SSO method and ranks above every
 * method the login used. Undefined when the login used it, or the item holds nothing
 * better than its password.
 */
export function missedLoginMethod(
  held: readonly LoginMethod[],
  used: readonly LoginMethod[],
): Exclude<LoginMethod, "password"> | undefined {
  const rank = (method: LoginMethod) => LOGIN_METHODS.indexOf(method);
  const best = [...held].sort((a, b) => rank(a) - rank(b))[0];
  if (best === undefined || best === "password" || used.includes(best)) return undefined;
  return used.some((method) => rank(method) < rank(best)) ? undefined : best;
}

/**
 * Whether a login that missed a better method may hide a bug: the device named a reason
 * that may be one, or none at all. The person's choice and settings are not.
 */
export function loginMethodSuspect(why: LoginMethodWhy | undefined): boolean {
  return why === undefined || LOGIN_METHOD_WHYS[why];
}
