/**
 * The URI matches that may stand for a page (ADR 0050). On an `http:` page only a URI
 * saved with an explicit `http://` scheme counts, so an item saved for `https://` is never
 * filled over plain HTTP; a bare host such as `example.com` names no scheme and does not
 * count either. Matches for any other page are kept as they are.
 */
export function pageMatches<T extends { uriIndex: number }>(
  targetOrigin: string,
  matches: readonly T[],
  uris: readonly { uri: string | null }[],
): T[] {
  if (!targetOrigin.startsWith("http://")) return [...matches];
  return matches.filter((entry) => /^http:\/\//iu.test(uris[entry.uriIndex]?.uri?.trim() ?? ""));
}
