import type { UriTestBindings } from "../../src/uri.test";

export function registerOrdinarySemantics({
  expect,
  it,
  uriMatchCases,
  matchBitwardenLoginUris,
  emptyResult,
  saved,
  target,
}: UriTestBindings) {
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
}

export function registerEquivalentDomains({
  expect,
  it,
  matchBitwardenLoginUris,
  emptyResult,
  saved,
  target,
  userDomains,
}: UriTestBindings) {
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
}
