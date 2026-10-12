import { describe, expect, it } from "vitest";
import { domainKey } from "@pateat/bitwarden";
import { linkRefusal, namedHosts, namedUrls, namesReturnPath, type OnSite } from "./entry";

// Synthetic sites only. The worker compares registrable domains; here the site is every
// host under `pixiv.example`.
const onSite: OnSite = (url) =>
  url.hostname === "pixiv.example" || url.hostname.endsWith(".pixiv.example");
const page = (query: string, path = "/en/") => new URL(`https://www.pixiv.example${path}${query}`);

describe("the URLs a page's query values name (ADR 0031)", () => {
  it("reads a value that starts with `/` or is an absolute URL, parsed against the page", () => {
    expect(
      namedUrls(page("?return_to=%2Fbookmark_new_illust.php&lang=en&ref=https://a.example/x")).map(
        String,
      ),
    ).toEqual(["https://www.pixiv.example/bookmark_new_illust.php", "https://a.example/x"]);
  });

  it("does not read a word, which resolves to a path of the page", () => {
    expect(namedUrls(page("?lang=en&next=bookmarks"))).toEqual([]);
  });

  it.each([
    ["a scheme-relative URL", "//evil.example/bookmarks"],
    ["a backslash after the slash", "/\\evil.example/bookmarks"],
    ["a tab between the slashes", "/\t/evil.example/bookmarks"],
    ["an absolute URL on another site", "https://evil.example/bookmarks"],
    ["an absolute URL whose host only ends with the site's name", "https://evilpixiv.example/x"],
  ])("lets the URL parser decide where %s leads", (_label, value) => {
    const url = page(`?return_to=${encodeURIComponent(value)}`);
    expect(namedUrls(url).map((named) => named.hostname)).toEqual([
      value.includes("evilpixiv") ? "evilpixiv.example" : "evil.example",
    ]);
    expect(namesReturnPath(url, onSite)).toBe(false);
  });
});

describe("whether a page names a path to return to (ADR 0031)", () => {
  it.each([
    ["a relative path on the site", "?return_to=%2Fbookmark_new_illust.php", true],
    [
      "an absolute URL on another host of the site",
      "?return_to=https://accounts.pixiv.example/settings",
      true,
    ],
    ["several values, one of them a return path", "?lang=en&return_to=%2Fbookmarks", true],
    ["no query value", "", false],
    ["the bare top page", "?return_to=%2F", false],
    ["the page's own path", "?return_to=%2Fen%2F", false],
    ["an `http:` URL on the site", "?return_to=http://www.pixiv.example/bookmarks", false],
    ["a `javascript:` URL", "?return_to=javascript:alert(1)", false],
    ["an unparsable absolute value", "?return_to=https://", false],
  ])("%s: %s", (_label, query, expected) => {
    expect(namesReturnPath(page(query), onSite)).toBe(expected);
  });
});

describe("whether a link may be pressed as an entry (ADR 0031)", () => {
  it.each([
    ["a link on the page's host", "https://www.pixiv.example/login", undefined],
    [
      "a link on another host of the site",
      "https://accounts.pixiv.example/login?lang=en",
      undefined,
    ],
    [
      "a link naming a return path",
      "https://accounts.pixiv.example/login?return_to=%2Fx",
      undefined,
    ],
    ["an `http:` link", "http://www.pixiv.example/login", "link-not-https"],
    ["a link to another site", "https://evil.example/login", "link-off-site"],
    [
      "a link whose query names another site",
      "https://www.pixiv.example/login?next=https://evil.example/",
      "link-query-off-site",
    ],
    [
      "a link whose query names another site scheme-relative",
      "https://www.pixiv.example/login?next=%2F%2Fevil.example%2F",
      "link-query-off-site",
    ],
    [
      "a link whose query names another site after a backslash",
      "https://www.pixiv.example/login?next=%2F%5Cevil.example%2F",
      "link-query-off-site",
    ],
  ])("%s", (_label, href, refusal) => {
    expect(linkRefusal(new URL(href), onSite)).toBe(refusal);
  });
});

describe("the hosts a page names", () => {
  it("lists the page's query hosts and each link's host and query hosts once, up to the limit", () => {
    const links = [
      new URL("https://accounts.pixiv.example/login?next=https://evil.example/"),
      new URL("https://www.pixiv.example/about"),
      new URL("https://other.example/"),
    ];
    expect(namedHosts(page("?return_to=%2Fbookmarks"), links, 10)).toEqual([
      "www.pixiv.example",
      "accounts.pixiv.example",
      "evil.example",
      "other.example",
    ]);
    expect(namedHosts(page(""), links, 2)).toEqual(["accounts.pixiv.example", "evil.example"]);
  });
});

describe("query values and links compared by registrable domain (ADR 0031)", () => {
  // As the worker compares them: Bitwarden's Domain match key of the page and of each URL.
  const sameSiteAs =
    (url: URL): OnSite =>
    (other) => {
      const site = domainKey(url);
      return site !== undefined && domainKey(other) === site;
    };
  const names = (url: string) => namesReturnPath(new URL(url), sameSiteAs(new URL(url)));
  const top = "https://www.pixiv.example/en/";
  const refusal = (href: string, at = top) => linkRefusal(new URL(href), sameSiteAs(new URL(at)));

  it.each([
    ["a scheme in capitals", "?return_to=HTTPS%3A%2F%2Faccounts.pixiv.example%2Fsettings", true],
    ["a host in capitals", "?return_to=https%3A%2F%2FACCOUNTS.PIXIV.EXAMPLE%2Fsettings", true],
    [
      "a port on another host of the site",
      "?return_to=https://accounts.pixiv.example:8443/x",
      true,
    ],
    [
      "a full-width host the parser folds to the site",
      "?return_to=https://www.ｐｉｘｉｖ.example/x",
      true,
    ],
    ["an `http:` scheme in capitals", "?return_to=HTTP%3A%2F%2Fwww.pixiv.example%2Fx", false],
    ["userinfo that names the site", "?return_to=https://www.pixiv.example@evil.example/x", false],
    [
      "userinfo after a backslash",
      "?return_to=https%3A%2F%2Fevil.example%5C%40www.pixiv.example%2Fx",
      false,
    ],
    ["a look-alike host with an accent", "?return_to=https://www.pixív.example/x", false],
    ["a look-alike host in punycode", "?return_to=https://www.xn--pixv-xpa.example/x", false],
    ["the site's name as a subdomain", "?return_to=https://pixiv.example.evil.example/x", false],
    [
      "the site's name in another site's path",
      "?return_to=https://evil.example/pixiv.example",
      false,
    ],
    ["a doubly encoded scheme-relative URL", "?return_to=%252F%252Fevil.example%252Fx", false],
    ["two slashes and nothing else", "?return_to=%2F%2F", false],
    ["the top page with a query", "?return_to=%2F%3Fnext%3Dbookmarks", false],
    ["the top page after a dot segment", "?return_to=%2F.", false],
    ["the page's own path after a dot segment", "?return_to=%2F.%2Fen%2F", false],
    ["the page's own path with a fragment", "?return_to=%2Fen%2F%23top", false],
    ["another site first, then a return path", "?return_to=%2F%2Fevil.example%2Fx&next=%2Fx", true],
    ["the same parameter twice, the second a return path", "?return_to=%2F&return_to=%2Fx", true],
    ["only the top page and the page's own path", "?return_to=%2F&next=%2Fen%2F", false],
  ])("a page naming %s: %s", (_label, query, expected) => {
    expect(names(`${top}${query}`)).toBe(expected);
  });

  it("compares hosts under a private suffix and IP addresses as separate sites", () => {
    expect(names("https://alice.github.io/en/?return_to=https://bob.github.io/x")).toBe(false);
    expect(names("https://alice.github.io/en/?return_to=%2Fx")).toBe(true);
    expect(names("https://192.0.2.1/en/?return_to=https://192.0.2.2/x")).toBe(false);
    expect(names("https://192.0.2.1/en/?return_to=%2Fx")).toBe(true);
  });

  it.each([
    ["a host and scheme in capitals", "HTTPS://ACCOUNTS.PIXIV.EXAMPLE/login", undefined],
    ["a port on the site", "https://accounts.pixiv.example:8443/login", undefined],
    [
      "userinfo that names the site",
      "https://www.pixiv.example@evil.example/login",
      "link-off-site",
    ],
    ["a look-alike host", "https://accounts.pixív.example/login", "link-off-site"],
    [
      "a query naming another site in capitals",
      "https://www.pixiv.example/login?next=HTTPS%3A%2F%2Fevil.example%2F",
      "link-query-off-site",
    ],
    [
      "a query naming another site through userinfo",
      "https://www.pixiv.example/login?next=https%3A%2F%2Fwww.pixiv.example%40evil.example%2F",
      "link-query-off-site",
    ],
    [
      "a query naming another site after a tab",
      "https://www.pixiv.example/login?next=%2F%09%2Fevil.example%2F",
      "link-query-off-site",
    ],
    [
      "a second value of the same parameter naming another site",
      "https://www.pixiv.example/login?next=%2Fbookmarks&next=%2F%2Fevil.example%2F",
      "link-query-off-site",
    ],
    [
      "a query naming a private-suffix neighbour",
      "https://alice.github.io/login?next=https%3A%2F%2Fbob.github.io%2F",
      "link-query-off-site",
    ],
  ])("a link with %s", (_label, href, expected) => {
    expect(refusal(href, href.includes("github.io") ? "https://alice.github.io/en/" : top)).toBe(
      expected,
    );
  });
});
