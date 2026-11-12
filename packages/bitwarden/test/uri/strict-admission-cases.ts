import { expect, it } from "vitest";
import {
  createBitwardenUriMatcher,
  matchBitwardenLoginUris,
  maxTargetUrlLength,
} from "../../src/uri";
import type { StrictAdmissionContext } from "./context";

export function registerStrictAdmission({
  emptyResult,
  saved,
  target,
  userDomains,
}: StrictAdmissionContext) {
  it.each(["ssh:123/path.with.dot", "ssh:123?x=path.with.dot"])(
    "does not reinterpret a nonweb scheme as a bare host because its path/query contains a dot: %s",
    (uri) => {
      const targetUrl = `http://${uri}`;
      for (const match of [0, 1, 2, 3]) {
        expect(matchBitwardenLoginUris(saved(uri, match), targetUrl)).toEqual({
          ok: true,
          data: {
            matched: false,
            targetOrigin: "http://ssh:123",
            matches: [],
            unavailableUris: [{ uriIndex: 0, reason: "unsupported-uri-scheme" }],
          },
        });
      }
    },
  );

  it.each(["example.com:123/path.with.dot", "example.com:123?x=path.with.dot"])(
    "recognizes a bare host/port when the hostname itself contains a dot: %s",
    (uri) => {
      for (const match of [0, 1]) {
        expect(matchBitwardenLoginUris(saved(uri, match), `http://${uri}`)).toEqual({
          ok: true,
          data: {
            matched: true,
            targetOrigin: "http://example.com:123",
            matches: [{ uriIndex: 0, match }],
            unavailableUris: [],
          },
        });
      }
    },
  );

  // extractHostname:false assumes already valid hostnames. Empty labels must
  // be rejected before suffix splitting, which can collapse unrelated hosts.
  it.each(["foo..com", "foo.com..", ".example.com", "foo..com."])(
    "rejects malformed actual hostname %s before every match mode",
    (hostname) => {
      for (const match of [0, 1, 2, 3, 4, 5]) {
        expect(matchBitwardenLoginUris(saved(target, match), `https://${hostname}/login`)).toEqual({
          ok: false,
          error: { code: "invalid-uri-input" },
        });
      }
    },
  );

  it.each(["foo..com", "foo.com..", ".example.com", "foo..com."])(
    "keeps malformed saved hostname %s unavailable for every ordinary mode",
    (hostname) => {
      for (const match of [0, 1, 2, 3]) {
        expect(
          matchBitwardenLoginUris(
            [
              { uri: `https://${hostname}/login`, match },
              { uri: target, match: 3 },
            ],
            target,
          ),
        ).toEqual({
          ok: true,
          data: {
            matched: true,
            targetOrigin: "https://example.com",
            matches: [{ uriIndex: 1, match: 3 }],
            unavailableUris: [{ uriIndex: 0, reason: "invalid-uri" }],
          },
        });
      }
    },
  );

  it.each([
    "foo..com",
    "foo.com..",
    ".example.com",
    "foo..com.",
    "https://example.org",
    "example.com:8080",
    "a.com b.com",
    "",
    `${"x".repeat(254)}.com`,
    `${Array.from({ length: 4 }, () => "ä".repeat(60)).join(".")}.com`,
  ])("ignores malformed equivalent-group entry %s and keeps the rest of its group", (entry) => {
    const domains = userDomains([["example.com", "example.net", entry]]);
    for (const uri of ["https://example.com", "https://example.net"])
      expect(matchBitwardenLoginUris(saved(uri), target, { domains })).toEqual({
        ok: true,
        data: {
          matched: true,
          targetOrigin: "https://example.com",
          matches: [{ uriIndex: 0, match: 0 }],
          unavailableUris: [],
        },
      });
    expect(matchBitwardenLoginUris(saved("https://example.org"), target, { domains })).toEqual(
      emptyResult(),
    );
  });

  it.each([
    "example.com",
    "https:example.com",
    "https:///example.com",
    " https://example.com/",
    "https://example.com/\n",
    "https://exa\tmple.com/",
    "https://user:secret@example.com/",
    "https://@example.com/",
    "https://example.com\\@evil.test/",
    "https://example.com:99999/",
    "file:///example.com",
    "javascript:alert(1)",
    "data:text/html,secret",
    "androidapp://example.com",
  ])("rejects invalid/nonweb actual target case %# without echoing it", (targetUrl) => {
    expect(matchBitwardenLoginUris(saved(), targetUrl)).toEqual({
      ok: false,
      error: { code: "invalid-uri-input" },
    });
  });

  // The URL parser keeps a backslash in the query and fragment, so tab URLs can hold one.
  it.each(["https://example.com/?q=a\\b", "https://example.com/#/x\\y"])(
    "matches a target with a backslash in its query or fragment, %s",
    (targetUrl) => {
      expect(new URL(targetUrl).href).toBe(targetUrl);
      const uris = [
        { uri: "https://example.com", match: 0 },
        { uri: "https://example.com", match: 1 },
        { uri: "https://example.com/", match: 2 },
        { uri: targetUrl, match: 3 },
        { uri: targetUrl.slice(0, -1), match: 2 },
      ];
      const expected = {
        ok: true,
        data: {
          matched: true,
          targetOrigin: "https://example.com",
          matches: uris.map(({ match }, uriIndex) => ({ uriIndex, match })),
          unavailableUris: [],
        },
      };
      expect(matchBitwardenLoginUris(uris, targetUrl)).toEqual(expected);
      const matcher = createBitwardenUriMatcher(targetUrl, {
        equivalentDomains: [],
        defaultMatch: 0,
      });
      expect(matcher.ok && matcher.data.evaluate(uris)).toEqual(expected);
    },
  );

  // The pinned client compares Exact and StartsWith as raw strings and accepts these.
  it.each([
    { match: 0, uri: "https://example.com/?q=a\\b", target },
    { match: 1, uri: "https://example.com/#a\\b", target },
    { match: 2, uri: "https://example.com/?q=a\\", target: "https://example.com/?q=a\\b" },
    { match: 3, uri: "https://example.com/?q=a\\b", target: "https://example.com/?q=a\\b" },
    { match: 3, uri: "https://example.com/#a\\b", target: "https://example.com/#a\\b" },
  ])(
    "matches saved URI $uri (mode $match) with a backslash only in its query or fragment",
    ({ uri, match, target: targetUrl }) => {
      expect(matchBitwardenLoginUris([{ uri, match }], targetUrl)).toEqual({
        ok: true,
        data: {
          matched: true,
          targetOrigin: "https://example.com",
          matches: [{ uriIndex: 0, match }],
          unavailableUris: [],
        },
      });
    },
  );

  it.each([
    "https://example.com\\@evil.test/?q=a\\b",
    "https://example.com\\@evil.test/#a\\b",
    "https://example.com/a\\b#a\\b",
  ])("still rejects a backslash in the target authority or path, %s", (targetUrl) => {
    expect(matchBitwardenLoginUris(saved(), targetUrl)).toEqual({
      ok: false,
      error: { code: "invalid-uri-input" },
    });
    expect(
      createBitwardenUriMatcher(targetUrl, { equivalentDomains: [], defaultMatch: 0 }),
    ).toEqual({ ok: false, error: { code: "invalid-uri-input" } });
  });

  // The pinned client reads these with WHATWG URL (Host) and tldts (Domain), which agree.
  it.each([
    "https://example.com\\@evil.test",
    "https://example.com\\@evil.test/?q=a\\b",
    "https://example.com/a\\b/?q=a\\b",
    "https://example.com\\evil.test",
    "example.com/a\\b",
    "example.com/\\@evil.test",
  ])("matches saved URI %s with a backslash before its query as the pinned client", (uri) => {
    expect(
      matchBitwardenLoginUris(
        [0, 1, 2, 3].map((match) => ({ uri, match })),
        target,
      ),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [
          { uriIndex: 0, match: 0 },
          { uriIndex: 1, match: 1 },
        ],
        unavailableUris: [],
      },
    });
  });

  it("keeps a saved URI's backslash after the query out of its host", () => {
    expect(matchBitwardenLoginUris(saved("https://evil.test?\\@example.com", 1), target)).toEqual({
      ok: true,
      data: {
        matched: false,
        targetOrigin: "https://example.com",
        matches: [],
        unavailableUris: [],
      },
    });
    expect(
      matchBitwardenLoginUris(saved("example.com/?q=a\\b", 1), "https://example.com/?q=a\\b"),
    ).toMatchObject({ ok: true, data: { matches: [{ uriIndex: 0, match: 1 }] } });
  });

  it("reads a target's backslash after the query as part of the query", () => {
    expect(
      matchBitwardenLoginUris(saved("https://evil.test", 1), "https://evil.test?\\@example.com"),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://evil.test",
        matches: [{ uriIndex: 0, match: 1 }],
        unavailableUris: [],
      },
    });
  });

  it.each([
    { uri: "https://example.com/\n", reason: "invalid-uri" },
    { uri: "https://exa\tmple.com/", reason: "invalid-uri" },
    { uri: "https://user:secret@example.com/", reason: "invalid-uri" },
    { uri: "https://@example.com/", reason: "invalid-uri" },
    { uri: "example.com\\@evil.test", reason: "invalid-uri" },
    { uri: "example.com\\@evil.test?q=a\\b", reason: "invalid-uri" },
    { uri: "https:/\\evil.test", reason: "invalid-uri" },
    { uri: "https://example.com:99999", reason: "invalid-uri" },
    { uri: "androidapp://com.synthetic.app", reason: "unsupported-uri-scheme" },
    { uri: "file:///synthetic", reason: "unsupported-uri-scheme" },
    { uri: "javascript:synthetic", reason: "unsupported-uri-scheme" },
  ])("keeps unsupported/invalid saved URI unavailable case %#", ({ uri, reason }) => {
    expect(
      matchBitwardenLoginUris(
        [
          { uri, match: 0 },
          { uri: target, match: 3 },
        ],
        target,
      ),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [{ uriIndex: 1, match: 3 }],
        unavailableUris: [{ uriIndex: 0, reason }],
      },
    });
  });

  it.each(["^https://example\\.com/", "(a+)+$", "[invalid"])(
    "reports regex case %# unevaluated without interpreting it when no answer is given",
    (uri) => {
      expect(matchBitwardenLoginUris([{ uri, match: 4 }], target)).toEqual({
        ok: true,
        data: {
          matched: false,
          targetOrigin: "https://example.com",
          matches: [],
          unavailableUris: [{ uriIndex: 0, reason: "regex-unevaluated" }],
        },
      });
    },
  );

  it("a regex rule cannot block an unrelated ordinary matching URI", () => {
    expect(
      matchBitwardenLoginUris(
        [
          { uri: "(a+)+$", match: 4 },
          { uri: target, match: 3 },
        ],
        target,
      ),
    ).toMatchObject({
      ok: true,
      data: {
        matched: true,
        matches: [{ uriIndex: 1, match: 3 }],
        unavailableUris: [{ uriIndex: 0, reason: "regex-unevaluated" }],
      },
    });
  });

  it("unknown match modes cannot silently default to Domain", () => {
    expect(matchBitwardenLoginUris([{ uri: target, match: 99 }], target)).toMatchObject({
      ok: true,
      data: { matched: false, unavailableUris: [{ uriIndex: 0, reason: "unsupported-uri-match" }] },
    });
  });

  it.each([null, undefined, {}, "https://example.com", 123])(
    "rejects malformed URI collection case %#",
    (uris) => {
      expect(matchBitwardenLoginUris(uris, target)).toEqual({
        ok: false,
        error: { code: "invalid-uri-input" },
      });
    },
  );

  it.each([
    { defaultMatch: 99 },
    { defaultMatch: "0" },
    { overrideNeverMatchStrategy: true },
    { domains: [] },
    { domains: { equivalentDomains: "secret" } },
    // Missing globalEquivalentDomains key.
    { domains: { equivalentDomains: [["example.com"]] } },
    { domains: { equivalentDomains: ["example.com"], globalEquivalentDomains: null } },
    { domains: { equivalentDomains: [["example.com", 1]], globalEquivalentDomains: null } },
    {
      domains: {
        globalEquivalentDomains: [{ type: 1, domains: ["example.com"], excluded: "false" }],
      },
    },
  ])("rejects malformed trusted options case %# without echoing context", (options) => {
    expect(matchBitwardenLoginUris(saved(), target, options as never)).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
  });

  it("accepts the maximum URI count without deduplicating their snapshot indices", () => {
    const result = matchBitwardenLoginUris(
      Array.from({ length: 1000 }, () => ({ uri: target, match: 3 })),
      target,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.matches).toHaveLength(1000);
      expect(result.data.matches[999]).toEqual({ uriIndex: 999, match: 3 });
    }
  });

  it("matches a page URL longer than a saved URI may be, as Bitwarden clients do", () => {
    const long = `https://example.com/${"x".repeat(8192)}`;
    expect(matchBitwardenLoginUris([{ uri: "https://example.com/", match: 2 }], long)).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [{ uriIndex: 0, match: 2 }],
        unavailableUris: [],
      },
    });
  });

  it("rejects a target longer than Chromium allows before returning a canonical origin", () => {
    const base = "https://example.com/";
    const longest = `${base}${"x".repeat(maxTargetUrlLength - base.length)}`;
    expect(matchBitwardenLoginUris(saved(), longest).ok).toBe(true);
    expect(matchBitwardenLoginUris(saved(), `${longest}x`)).toEqual({
      ok: false,
      error: { code: "invalid-uri-input" },
    });
  });

  it.each([
    userDomains(Array.from({ length: 1001 }, () => ["example.com", "example.net"])),
    userDomains([Array.from({ length: 10_001 }, () => "example.com")]),
  ])("bounds same-account domain context before matching case %#", (domains) => {
    expect(matchBitwardenLoginUris(saved(), target, { domains })).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
  });

  it.each([null, [], { uri: null }, { uri: target, match: "0" }, { uri: target, match: -1 }])(
    "malformed individual URI cannot default-match case %#",
    (entry) => {
      expect(matchBitwardenLoginUris([entry, { uri: target, match: 3 }], target)).toEqual({
        ok: true,
        data: {
          matched: true,
          targetOrigin: "https://example.com",
          matches: [{ uriIndex: 1, match: 3 }],
          unavailableUris: [{ uriIndex: 0, reason: "invalid-uri" }],
        },
      });
    },
  );

  it("bounds a saved URI individually without blocking another ordinary URI", () => {
    const result = matchBitwardenLoginUris(
      [
        { uri: `https://example.com/${"x".repeat(8192)}`, match: 3 },
        { uri: target, match: 3 },
      ],
      target,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        matched: true,
        matches: [{ uriIndex: 1, match: 3 }],
        unavailableUris: [{ uriIndex: 0, reason: "invalid-uri" }],
      },
    });
  });

  it("does not include URI query secrets or userinfo in candidate metadata", () => {
    const uri = "https://example.com/login?token=synthetic-query-secret";
    const result = matchBitwardenLoginUris(
      [
        { uri, match: 3 },
        { uri: "https://synthetic-user:synthetic-password@example.com", match: 0 },
      ],
      uri,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { matched: true, targetOrigin: "https://example.com" },
    });
    const json = JSON.stringify(result);
    for (const secret of ["synthetic-query-secret", "synthetic-user", "synthetic-password"])
      expect(json).not.toContain(secret);
  });
}
