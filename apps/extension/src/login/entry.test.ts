import { describe, expect, it } from "vitest";
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
