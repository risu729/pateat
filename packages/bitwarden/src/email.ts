import * as v from "valibot";

/**
 * The email rule of the official Bitwarden login page, which uses Angular's
 * `Validators.email` (bitwarden/clients `libs/auth/src/angular/login/login.component.ts`).
 * It is the HTML `type="email"` rule without a leading, trailing or repeated `.` before the
 * `@`, with at most 64 characters before the `@` and 254 in all. Only ASCII is accepted.
 */
const BITWARDEN_EMAIL =
  /^(?=.{1,254}$)(?=.{1,64}@)[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** A Bitwarden account email, accepted exactly when the official login page accepts it. */
export const bitwardenEmail = v.pipe(v.string(), v.regex(BITWARDEN_EMAIL));
