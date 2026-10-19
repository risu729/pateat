import { describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  resolveSiteAccount,
} from "../../contracts/src/settings";
import {
  admitBitwardenUriMatchContext,
  createBitwardenUriMatchContext,
  createBitwardenUriMatcher,
  matchBitwardenLoginUris,
  maxTargetUrlLength,
} from "./uri";
import { createLocalCryptoSession } from "./local-crypto";
import { uriMatchCases } from "./__fixtures__/uri";
import {
  legacyCipher,
  uriCiphertexts,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "./__fixtures__/crypto";

const target = "https://example.com/login";
const saved = (uri = target, match: number | null = 0) => [{ uri, match }];
const emptyResult = (targetUrl = target) => ({
  ok: true,
  data: {
    matched: false,
    targetOrigin: new URL(targetUrl).origin,
    matches: [],
    unavailableUris: [],
  },
});
const userDomains = (equivalentDomains: string[][]) => ({
  equivalentDomains,
  globalEquivalentDomains: [],
});

describe("pinned ordinary Bitwarden URI semantics", () => {
  it.each(uriMatchCases)("$label", ({ uri, match, target: targetUrl, matched }) => {
    expect(matchBitwardenLoginUris([{ uri, match }], targetUrl)).toEqual({
      ok: true,
      data: {
        matched,
        targetOrigin: new URL(targetUrl).origin,
        matches: matched ? [{ uriIndex: 0, match }] : [],
        unavailableUris: [],
      },
    });
  });

  it.each([undefined, null])(
    "missing/null URI mode %s uses the trusted account default",
    (match) => {
      expect(
        matchBitwardenLoginUris(
          [{ uri: "https://example.com/login", match }],
          "https://auth.example.com/login",
          { defaultMatch: 1 },
        ),
      ).toEqual(emptyResult("https://auth.example.com/login"));
      expect(
        matchBitwardenLoginUris(
          [{ uri: "https://example.com/login", match }],
          "https://auth.example.com/login",
          { defaultMatch: 0 },
        ),
      ).toMatchObject({ ok: true, data: { matched: true, matches: [{ uriIndex: 0, match: 0 }] } });
    },
  );

  it("an explicit Domain mode overrides a stricter trusted default", () => {
    expect(
      matchBitwardenLoginUris(saved(), "https://auth.example.com/", { defaultMatch: 3 }),
    ).toMatchObject({ ok: true, data: { matched: true } });
  });

  it("Never excludes only its URI and cannot be overridden by the default", () => {
    expect(matchBitwardenLoginUris(saved(target, 5), target, { defaultMatch: 0 })).toEqual(
      emptyResult(),
    );
    expect(
      matchBitwardenLoginUris(
        [
          { uri: target, match: 5 },
          { uri: target, match: 3 },
        ],
        target,
      ),
    ).toMatchObject({ ok: true, data: { matched: true, matches: [{ uriIndex: 1, match: 3 }] } });
  });

  it("preserves matching URI indices and effective modes without returning raw URIs", () => {
    const result = matchBitwardenLoginUris(
      [
        { uri: "https://other.com", match: 0 },
        { uri: target, match: 3 },
        { uri: target, match: 1 },
      ],
      target,
    );
    expect(result).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [
          { uriIndex: 1, match: 3 },
          { uriIndex: 2, match: 1 },
        ],
        unavailableUris: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain("/login");
  });

  it("an empty URI list has no candidates", () => {
    expect(matchBitwardenLoginUris([], target)).toEqual(emptyResult());
  });
});

describe("same-account supplied equivalent domains", () => {
  it("allows user groups for Domain only", () => {
    const options = { domains: userDomains([["example.com", "example.net"]]) };
    expect(
      matchBitwardenLoginUris(saved("https://example.net/login", 0), target, options),
    ).toMatchObject({ ok: true, data: { matched: true } });
    for (const match of [1, 2, 3, 5])
      expect(
        matchBitwardenLoginUris(saved("https://example.net/login", match), target, options),
      ).toEqual(emptyResult());
  });

  it.each([false, true])("uses only nonexcluded global group excluded=%s", (excluded) => {
    const domains = {
      equivalentDomains: null,
      globalEquivalentDomains: [{ type: 1, domains: ["example.com", "example.net"], excluded }],
    };
    expect(
      matchBitwardenLoginUris(saved("https://example.net/login"), target, { domains }),
    ).toMatchObject({ ok: true, data: { matched: !excluded } });
  });

  it("a user group still applies when an equivalent global group is excluded", () => {
    const domains = {
      equivalentDomains: [["example.com", "example.net"]],
      globalEquivalentDomains: [
        { type: 1, domains: ["example.com", "example.net"], excluded: true },
      ],
    };
    expect(
      matchBitwardenLoginUris(saved("https://example.net"), target, { domains }),
    ).toMatchObject({ ok: true, data: { matched: true } });
  });

  it("unions groups containing the target without transitive closure", () => {
    const domains = userDomains([
      ["example.com", "example.net"],
      ["example.net", "example.org"],
    ]);
    expect(matchBitwardenLoginUris(saved("https://example.org"), target, { domains })).toEqual(
      emptyResult(),
    );
    expect(
      matchBitwardenLoginUris(saved("https://example.org"), "https://example.net/", { domains }),
    ).toMatchObject({ ok: true, data: { matched: true } });
    expect(
      matchBitwardenLoginUris(saved("https://example.com"), "https://example.net/", { domains }),
    ).toMatchObject({ ok: true, data: { matched: true } });
  });

  it.each([undefined, null, { equivalentDomains: null, globalEquivalentDomains: null }])(
    "never invents omitted equivalent domains case %#",
    (domains) => {
      expect(matchBitwardenLoginUris(saved("https://example.net"), target, { domains })).toEqual(
        emptyResult(),
      );
    },
  );

  it("does not mutate caller-owned URI arrays or equivalent domain groups", () => {
    const uris = saved("https://example.net");
    const domains = userDomains([["example.com", "example.net"]]);
    const before = structuredClone({ uris, domains });
    expect(matchBitwardenLoginUris(uris, target, { domains })).toMatchObject({
      ok: true,
      data: { matched: true },
    });
    expect({ uris, domains }).toEqual(before);
  });
});

describe("retained account URI context", () => {
  const groups = [["example.com", "example.net"]];
  it("normalizes received sync domains once and matches with the retained groups", () => {
    const context = createBitwardenUriMatchContext(
      {
        object: "domains",
        equivalentDomains: [["EXAMPLE.COM", "bücher.de"]],
        globalEquivalentDomains: [
          { type: 1, domains: ["example.org", "example.net"], excluded: false },
          { type: 2, domains: ["example.com", "example.edu"], excluded: true },
        ],
      },
      0,
    );
    expect(context).toEqual({
      equivalentDomains: [
        ["example.com", "xn--bcher-kva.de"],
        ["example.org", "example.net"],
      ],
      defaultMatch: 0,
    });
    expect(admitBitwardenUriMatchContext(context)).toEqual(context);
    expect(
      matchBitwardenLoginUris(saved("https://xn--bcher-kva.de"), target, { context }),
    ).toMatchObject({ ok: true, data: { matched: true, matches: [{ uriIndex: 0, match: 0 }] } });
    expect(matchBitwardenLoginUris(saved("https://example.edu"), target, { context })).toEqual(
      emptyResult(),
    );
  });

  it("ignores an entry whose IDNA normalization exceeds the retained bound", () => {
    // Distinct CJK code points: about 240 raw characters become several hundred ASCII ones.
    const long = `${Array.from({ length: 240 }, (_, i) => String.fromCodePoint(0x4e00 + i * 37)).join("")}.jp`;
    expect(long.length).toBeLessThanOrEqual(253);
    expect(createBitwardenUriMatchContext(userDomains([["example.com", long]]), 2)).toEqual({
      equivalentDomains: [["example.com"]],
      defaultMatch: 2,
    });
  });

  it("evaluates many items against one admitted target and context", () => {
    const matcher = createBitwardenUriMatcher(target, {
      equivalentDomains: [["example.com", "example.net"]],
      defaultMatch: 0,
    });
    expect(matcher.ok).toBe(true);
    if (!matcher.ok) return;
    expect(matcher.data.targetOrigin).toBe("https://example.com");
    expect(matcher.data.evaluate(saved("https://example.net"))).toMatchObject({
      ok: true,
      data: { matched: true },
    });
    expect(matcher.data.evaluate(saved("https://example.org"))).toEqual(emptyResult());
    expect(matcher.data.evaluate(Array.from({ length: 1001 }, () => ({ uri: target })))).toEqual({
      ok: false,
      error: { code: "invalid-uri-input" },
    });
    expect(
      createBitwardenUriMatcher("ftp://example.com/", { equivalentDomains: [], defaultMatch: 0 }),
    ).toEqual({
      ok: false,
      error: { code: "invalid-uri-input" },
    });
    expect(createBitwardenUriMatcher(target, { equivalentDomains: [] })).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
  });

  it("treats absent sync domains as no equivalent groups, as the pinned client does", () => {
    expect(createBitwardenUriMatchContext(null, 0)).toEqual({
      equivalentDomains: [],
      defaultMatch: 0,
    });
  });

  it.each([
    { equivalentDomains: ["example.com"], globalEquivalentDomains: null },
    { equivalentDomains: [[123]], globalEquivalentDomains: null },
    { equivalentDomains: null, globalEquivalentDomains: [{ type: 1, domains: "example.com" }] },
    { equivalentDomains: "secret" },
    [],
    userDomains(Array.from({ length: 1001 }, () => ["example.com", "example.net"])),
    userDomains([Array.from({ length: 10_001 }, () => "example.com")]),
  ])("marks malformed sync domains unavailable instead of guessing case %#", (domains) => {
    const context = createBitwardenUriMatchContext(domains, 0);
    expect(context).toEqual({ equivalentDomains: "unavailable", defaultMatch: 0 });
    expect(
      matchBitwardenLoginUris(
        [
          { uri: "https://example.com", match: null },
          { uri: "https://example.com", match: 1 },
        ],
        target,
        { context },
      ),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [{ uriIndex: 1, match: 1 }],
        unavailableUris: [{ uriIndex: 0, reason: "equivalent-domains-unavailable" }],
      },
    });
  });

  // Pinned clients compare each group entry as a raw string with the tldts domain, so an
  // entry that is not a hostname never matches and the rest of the groups still apply.
  it.each([
    "https://example.net",
    "example.com:8080",
    "a.com b.com",
    "foo..com",
    "user@example.net",
    "example.net/login",
    "",
    `${"x".repeat(254)}.com`,
    // 247 characters raw, 271 after IDNA.
    `${Array.from({ length: 4 }, () => "ä".repeat(60)).join(".")}.com`,
  ])("keeps the groups available when an entry %s is not a hostname", (entry) => {
    const context = createBitwardenUriMatchContext(
      {
        equivalentDomains: [["example.com", "example.org", entry]],
        globalEquivalentDomains: [
          { type: 1, domains: ["example.com", "example.edu", entry], excluded: false },
        ],
      },
      0,
    );
    expect(context.equivalentDomains).not.toBe("unavailable");
    expect(admitBitwardenUriMatchContext(context)).toEqual(context);
    for (const uri of ["https://example.com", "https://example.org", "https://example.edu"])
      expect(matchBitwardenLoginUris(saved(uri), target, { context })).toEqual({
        ok: true,
        data: {
          matched: true,
          targetOrigin: "https://example.com",
          matches: [{ uriIndex: 0, match: 0 }],
          unavailableUris: [],
        },
      });
  });

  it("does not turn a URL entry into its hostname", () => {
    const context = createBitwardenUriMatchContext(
      {
        equivalentDomains: [["example.com", "https://example.net"]],
        globalEquivalentDomains: null,
      },
      0,
    );
    expect(context.equivalentDomains).not.toBe("unavailable");
    expect(
      matchBitwardenLoginUris(saved("https://example.com"), "https://example.com/", { context }),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [{ uriIndex: 0, match: 0 }],
        unavailableUris: [],
      },
    });
    // The group containing only the URL form of the target does not apply to it.
    const urlOnly = createBitwardenUriMatchContext(
      userDomains([["https://example.com", "example.net"]]),
      0,
    );
    expect(urlOnly.equivalentDomains).not.toBe("unavailable");
    expect(
      matchBitwardenLoginUris(saved("https://example.net"), target, { context: urlOnly }),
    ).toEqual(emptyResult());
    expect(
      matchBitwardenLoginUris(saved("https://example.com"), target, { context: urlOnly }),
    ).toMatchObject({ ok: true, data: { matched: true, unavailableUris: [] } });
  });

  it("uses the retained default and never falls back from an unavailable one", () => {
    expect(
      matchBitwardenLoginUris(saved("https://example.com", null), "https://auth.example.com/", {
        context: { equivalentDomains: groups, defaultMatch: 1 },
      }),
    ).toEqual(emptyResult("https://auth.example.com/"));
    expect(
      matchBitwardenLoginUris(
        [
          { uri: target, match: null },
          { uri: "https://example.net", match: 0 },
          { uri: target, match: 5 },
        ],
        target,
        { context: { equivalentDomains: groups, defaultMatch: "unavailable" } },
      ),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [{ uriIndex: 1, match: 0 }],
        unavailableUris: [{ uriIndex: 0, reason: "default-match-unavailable" }],
      },
    });
  });

  it.each([
    { context: { equivalentDomains: [["EXAMPLE.COM"]], defaultMatch: 0 } },
    { context: { equivalentDomains: [["example.com:443"]], defaultMatch: 0 } },
    { context: { equivalentDomains: groups, defaultMatch: 6 } },
    { context: { equivalentDomains: groups } },
    { context: { equivalentDomains: groups, defaultMatch: 0, extra: true } },
    {
      context: {
        equivalentDomains: [Array.from({ length: 10_001 }, () => "example.com")],
        defaultMatch: 0,
      },
    },
    { context: { equivalentDomains: groups, defaultMatch: 0 }, defaultMatch: 0 },
    { context: null },
  ])("rejects malformed or mixed retained context case %#", (options) => {
    expect(matchBitwardenLoginUris(saved(), target, options as never)).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
  });
});

describe("strict destination and unsupported rule admission", () => {
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
    "reports regex case %# unsupported without interpreting it",
    (uri) => {
      expect(matchBitwardenLoginUris([{ uri, match: 4 }], target)).toEqual({
        ok: true,
        data: {
          matched: false,
          targetOrigin: "https://example.com",
          matches: [],
          unavailableUris: [{ uriIndex: 0, reason: "unsupported-uri-match" }],
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
        unavailableUris: [{ uriIndex: 0, reason: "unsupported-uri-match" }],
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
});

describe("URI candidate matching is separate from the existing destination grant", () => {
  it.each([
    { uri: "https://bank.example", match: 2, target: "https://bank.example.evil.test/login" },
    { uri: "https://bank.example", match: 0, target: "http://bank.example/login" },
    { uri: "https://bank.example", match: 0, target: "https://bank.example:8443/login" },
  ])(
    "a permissive provider match cannot change the allowed origin case %#",
    ({ uri, match, target: targetUrl }) => {
      expect(matchBitwardenLoginUris([{ uri, match }], targetUrl)).toMatchObject({
        ok: true,
        data: { matched: true },
      });
      const settings = createDefaultSettings();
      // Even an explicit site selection cannot expand this item's allowed origin.
      settings.siteDefaults.push({
        origin: new URL(targetUrl).origin,
        provider: "dummy",
        userId: "demo-personal-account",
        itemId: "primary",
      });
      expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, targetUrl)).toEqual({
        ok: false,
        reason: "item-origin-mismatch",
      });
    },
  );
});

describe("real SDK authenticated URI to local matching", () => {
  it("uses the actual decrypted URI and mode without network discovery", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Synthetic URI test prohibits network"));
    try {
      const initialized = await createLocalCryptoSession(
        {
          connectionId: "synthetic-uri",
          userId: "00000000-0000-0000-0000-000000000001",
          email: v1Email,
          kdf: v1Kdf,
          accountCryptographicState: { V1: { private_key: v1PrivateKey } },
          unlock: {
            kind: "password",
            password: v1Password,
            masterPasswordUnlock: {
              kdf: v1Kdf,
              masterKeyWrappedUserKey: v1WrappedUserKey,
              salt: v1Email,
            },
          },
        },
        sdk,
      );
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      try {
        const original = legacyCipher();
        const decrypted = await initialized.data.decryptCipher({
          connectionId: "synthetic-uri",
          cipher: {
            ...original,
            login: {
              ...original.login,
              uris: [{ uri: uriCiphertexts.uri, match: 3, uriChecksum: uriCiphertexts.checksum }],
            },
          },
        });
        expect(decrypted.ok).toBe(true);
        if (!decrypted.ok) return;
        expect(
          matchBitwardenLoginUris(
            decrypted.data.login?.uris,
            "https://synthetic.example.test/login",
          ),
        ).toMatchObject({
          ok: true,
          data: {
            matched: true,
            targetOrigin: "https://synthetic.example.test",
            matches: [{ uriIndex: 0, match: 3 }],
          },
        });
        expect(
          matchBitwardenLoginUris(
            decrypted.data.login?.uris,
            "https://synthetic.example.test/login?other=1",
          ),
        ).toMatchObject({ ok: true, data: { matched: false } });
      } finally {
        initialized.data.dispose();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
