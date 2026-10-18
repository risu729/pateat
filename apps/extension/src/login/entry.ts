// A site's sign-in entry on a page without a login form (ADR 0031): which URLs a page or
// a link names, shared by the content script and the worker. Whether a URL is on the
// page's site is decided by the caller: the worker compares registrable domains, and the
// content script asks the worker which hosts are on the site.

/** Whether `url` is on the page's site; the worker compares registrable domains. */
export type OnSite = (url: URL) => boolean;

const parse = (value: string, base?: URL) => URL.parse(value, base) ?? undefined;

/**
 * Every URL a query key or value could lead to, as the URL parser reads it: on its own as
 * an absolute URL, and resolved against `base`. The two differ for a value such as
 * `https:evil.example/x`, which is another host on its own but a path of an `https:` page
 * resolved against it. A plain word resolves to a path of the page.
 */
function readings(value: string, base: URL): URL[] {
  return [parse(value), parse(value, base)].filter((url) => url !== undefined);
}

/** Every query key and value of `url`, after URL decoding. */
const queryParts = (url: URL) => [...url.searchParams].flat();

/**
 * The URLs the query keys and values of `url` lead to, by every reading of
 * {@link readings}, that name a host: an opaque URL such as `mailto:` names none.
 */
function queryUrls(url: URL): URL[] {
  return queryParts(url).flatMap((part) => readings(part, url).filter((read) => read.hostname));
}

/**
 * Whether a link or return URL may lead from `page` by its scheme: `https:` always, `http:`
 * only from an `http:` page, so a sign-in on an HTTPS site never moves to plain HTTP
 * (ADR 0050).
 */
const webScheme = (target: URL, page: URL | undefined) =>
  target.protocol === "https:" || (target.protocol === "http:" && page?.protocol === "http:");

/**
 * The query values of `url` that may name a URL: a value counts when, after URL decoding,
 * it is an absolute URL or starts with `/`, as `return_to=%2Fbookmarks` does. Other values,
 * such as `lang=en`, are not read, since any word resolves to a path of the page. Where a
 * value leads is left to the URL parser, never its characters: `//evil.example/x`,
 * `/\evil.example/x` and a `/` followed by a tab and `/evil.example/x` are all read, and
 * all lead to `evil.example`.
 */
const namedValues = (url: URL) =>
  [...url.searchParams.values()].filter((value) => value.startsWith("/") || parse(value));

/**
 * Whether a query value of the page's URL names another path of its own site, which shows
 * the site sent the visitor there to sign in first (ADR 0031, owner 2026-10-12 06:53 UTC):
 * a value that {@link namedValues} reads and that leads to an `https:` URL (or `http:` from
 * an `http:` page) on the site whose path is neither `/` nor the page's own. A value counts only when every reading of it, on
 * its own and resolved against the page, is such a URL: `https:evil.example/x` is a
 * path of the page resolved against it, but another host on its own. A manual logout that
 * lands on the bare top page has none.
 */
export function namesReturnPath(page: URL, onSite: OnSite): boolean {
  return namedValues(page).some((value) => {
    const targets = readings(value, page);
    return (
      targets.length > 0 &&
      targets.every(
        (target) =>
          webScheme(target, page) &&
          onSite(target) &&
          target.pathname !== "/" &&
          target.pathname !== page.pathname,
      )
    );
  });
}

/** Why a link's parsed `href` may not be pressed or shown to the model (ADR 0031). */
export type LinkRefusal =
  | "link-not-https"
  | "link-off-site"
  | "link-query-off-site"
  | "link-same-page";

/** A URL without its fragment. */
const withoutFragment = (url: URL) => url.href.slice(0, url.href.length - url.hash.length);

/**
 * Why a link may not be pressed: its `href` is not `https:` (or `http:` from an `http:`
 * `page`), not on the page's site, a
 * query key or value of it leads to another site, or it differs from `page`, when given,
 * only by its fragment, so pressing it shows no other page. Every query key and value is
 * read by the URL parser, both on its own and resolved against the `href`, and any reading
 * that names a host off the site refuses the link; a plain word resolves to a path of the
 * `href` and never does. A same-site link that redirects to another provider, such as
 * `/auth/google`, passes; the model and the check after the press guard it.
 */
export function linkRefusal(href: URL, onSite: OnSite, page?: URL): LinkRefusal | undefined {
  if (!webScheme(href, page)) return "link-not-https";
  if (!onSite(href)) return "link-off-site";
  if (queryUrls(href).some((target) => !onSite(target))) return "link-query-off-site";
  if (page && withoutFragment(href) === withoutFragment(page)) return "link-same-page";
  return undefined;
}

/**
 * The hosts a page's URL and its links name: each link's own host and every host a query
 * key or value of a link or of the page leads to, by every reading of it. The worker
 * answers which are on the page's site.
 */
export function namedHosts(page: URL, links: readonly URL[], limit: number): string[] {
  const hosts = new Set<string>();
  for (const url of [...queryUrls(page), ...links.flatMap((link) => [link, ...queryUrls(link)])]) {
    if (hosts.size >= limit) break;
    if (url.hostname) hosts.add(url.hostname);
  }
  return [...hosts];
}
