import type { UriTestBindings } from "../../src/uri.test";

export function registerRetainedContext({
  expect,
  it,
  createBitwardenUriMatchContext,
  admitBitwardenUriMatchContext,
  createBitwardenUriMatcher,
  matchBitwardenLoginUris,
  emptyResult,
  saved,
  target,
  userDomains,
}: UriTestBindings) {
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
}
