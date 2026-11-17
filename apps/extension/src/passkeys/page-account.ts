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
 * The passkeys of `offered` whose item the page shows instead of the site default's (ADR
 * 0028 amendment of 2026-11-17): those whose item's login username, or the user name stored
 * with the passkey, equals `account`, the one unmasked address the page showed, ignoring
 * case. None when the address is no email address, or when a passkey of the site default
 * fits it too: the page then shows the default's account. Usernames are compared here only,
 * and never kept, logged or sent.
 */
export async function shownAccountFirst<TCandidate extends PasskeyCandidate>(
  account: string,
  offered: readonly TCandidate[],
  usernames?: (candidates: readonly TCandidate[]) => Promise<readonly (string | undefined)[]>,
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
  return fits.some((entry) => entry.preferred === true) ? [] : fits;
}
