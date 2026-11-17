import type { PasskeyCandidate } from "./select";

/** A name as the page's address is compared with it: format characters removed, NFKC, case. */
function accountKey(name: string): string {
  return name
    .replace(/\p{Cf}+/gu, "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

/**
 * The passkeys of `offered` whose item the page shows instead of the one Pateat would sign
 * with, the site default's or a moved login's (`anchor`; ADR 0028 amendment of 2026-11-17):
 * those whose item's login username, or the user name stored with the passkey, equals
 * `account`, the one unmasked address the page showed, ignoring case. None when the address
 * is no email address, or when a passkey of the anchor fits it too: the page then shows
 * that account. Usernames are compared here only, and never kept, logged or sent.
 */
export async function shownAccountFirst<TCandidate extends PasskeyCandidate>(
  account: string,
  offered: readonly TCandidate[],
  usernames?: (candidates: readonly TCandidate[]) => Promise<readonly (string | undefined)[]>,
  anchor: (entry: TCandidate) => boolean = (entry) => entry.preferred === true,
): Promise<TCandidate[]> {
  const key = accountKey(account);
  if (!/^[^@\s]+@[^@\s]+$/u.test(key) || offered.length === 0) return [];
  // A username that cannot be read compares nothing.
  const names = usernames ? await usernames(offered).catch(() => undefined) : undefined;
  const fits = offered.filter((entry, index) =>
    [entry.display?.userName, names?.[index]].some(
      (name) => name !== undefined && accountKey(name) === key,
    ),
  );
  return fits.some(anchor) ? [] : fits;
}
