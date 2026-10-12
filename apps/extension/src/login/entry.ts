// A site's sign-in entry on a page without a login form (ADR 0031): which URLs a page or
// a link names, shared by the content script and the worker. Whether a URL is on the
// page's site is decided by the caller: the worker compares registrable domains, and the
// content script asks the worker which hosts are on the site.

/** Whether `url` is on the page's site; the worker compares registrable domains. */
export type OnSite = (url: URL) => boolean;

const parse = (value: string, base?: URL) => {
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
};

/**
 * The URLs the query values of `url` name, parsed against `url` itself: a value counts
 * when, after URL decoding, it is an absolute URL or starts with `/`, as
 * `return_to=%2Fbookmark_new_illust.php` does. Other values, such as `lang=en`, are not
 * read, since any word resolves to a path of the page. The URL parser decides where a
 * value leads, never its characters: `//evil.example/x`, `/\evil.example/x` and a `/`
 * followed by a tab and `/evil.example/x` all lead to `evil.example`.
 */
export function namedUrls(url: URL): URL[] {
  const named: URL[] = [];
  for (const value of url.searchParams.values()) {
    if (!value.startsWith("/") && !parse(value)) continue;
    const parsed = parse(value, url);
    if (parsed) named.push(parsed);
  }
  return named;
}

/**
 * Whether a query value of the page's URL names another path of its own site, which shows
 * the site sent the visitor there to sign in first (ADR 0031, owner 2026-10-12 06:53 UTC):
 * the value leads to an `https:` URL on the site whose path is neither `/` nor the page's
 * own. A manual logout that lands on the bare top page has none.
 */
export function namesReturnPath(page: URL, onSite: OnSite): boolean {
  return namedUrls(page).some(
    (target) =>
      target.protocol === "https:" &&
      onSite(target) &&
      target.pathname !== "/" &&
      target.pathname !== page.pathname,
  );
}

/** Why a link's parsed `href` may not be pressed or shown to the model (ADR 0031). */
export type LinkRefusal = "link-not-https" | "link-off-site" | "link-query-off-site";

/**
 * Why a link may not be pressed: its `href` is not `https:`, not on the page's site, or a
 * query value of it names a URL on another site (parsed as {@link namedUrls} does). A
 * same-site link that redirects to another provider, such as `/auth/google`, passes; the
 * model and the check after the press guard it.
 */
export function linkRefusal(href: URL, onSite: OnSite): LinkRefusal | undefined {
  if (href.protocol !== "https:") return "link-not-https";
  if (!onSite(href)) return "link-off-site";
  if (namedUrls(href).some((target) => !onSite(target))) return "link-query-off-site";
  return undefined;
}

/**
 * The hosts a page's URL and its links name: each link's own host and every host its
 * query values and the page's name. The worker answers which are on the page's site.
 */
export function namedHosts(page: URL, links: readonly URL[], limit: number): string[] {
  const hosts = new Set<string>();
  for (const url of [...namedUrls(page), ...links.flatMap((link) => [link, ...namedUrls(link)])]) {
    if (hosts.size >= limit) break;
    if (url.hostname) hosts.add(url.hostname);
  }
  return [...hosts];
}
