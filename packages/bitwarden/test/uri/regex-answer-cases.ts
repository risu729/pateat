import { expect, it, vi } from "vitest";
import {
  createBitwardenUriMatcher,
  matchBitwardenLoginUris,
  type BitwardenUriMatchContext,
} from "../../src/uri";
import type { RegexAnswerContext } from "./context";

export function registerRegex({ target }: RegexAnswerContext) {
  const context: BitwardenUriMatchContext = { equivalentDomains: [], defaultMatch: 0 };
  const evaluator = (answer: (pattern: string) => boolean | undefined, options = context) => {
    const regex = vi.fn(answer);
    const matcher = createBitwardenUriMatcher(target, options, regex);
    if (!matcher.ok) throw new Error("The synthetic matcher was not admitted");
    return { evaluate: matcher.data.evaluate, regex };
  };

  it.each([
    [true, { matched: true, matches: [{ uriIndex: 0, match: 4 }], unavailableUris: [] }],
    [false, { matched: false, matches: [], unavailableUris: [] }],
    [
      undefined,
      {
        matched: false,
        matches: [],
        unavailableUris: [{ uriIndex: 0, reason: "regex-unevaluated" }],
      },
    ],
  ])("takes the caller's answer %s for a Regex URI", (answer, data) => {
    const { evaluate, regex } = evaluator(() => answer);
    expect(evaluate([{ uri: "^https://example\\.com/", match: 4 }])).toEqual({
      ok: true,
      data: { targetOrigin: "https://example.com", ...data },
    });
    expect(regex).toHaveBeenCalledExactlyOnceWith("^https://example\\.com/");
  });

  it.each([
    "^https://(www\\.)?example\\.com/",
    "  (a+)+$ ",
    "[invalid",
    "ssh:123/path.with.dot",
    "login",
  ])("passes the stored pattern %j verbatim, with no URL or scheme check", (pattern) => {
    const { evaluate, regex } = evaluator(() => true);
    expect(evaluate([{ uri: pattern, match: 4 }])).toMatchObject({
      ok: true,
      data: { matched: true, matches: [{ uriIndex: 0, match: 4 }], unavailableUris: [] },
    });
    expect(regex).toHaveBeenCalledExactlyOnceWith(pattern);
  });

  it("keeps Regex and ordinary results in their URI order", () => {
    const { evaluate, regex } = evaluator((pattern) =>
      pattern === "matches" ? true : pattern === "misses" ? false : undefined,
    );
    expect(
      evaluate([
        { uri: "pending", match: 4 },
        { uri: "matches", match: 4 },
        { uri: target, match: 3 },
        { uri: "misses", match: 4 },
        { uri: "https://example.org", match: 0 },
      ]),
    ).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [
          { uriIndex: 1, match: 4 },
          { uriIndex: 2, match: 3 },
        ],
        unavailableUris: [{ uriIndex: 0, reason: "regex-unevaluated" }],
      },
    });
    expect(regex.mock.calls).toEqual([["pending"], ["matches"], ["misses"]]);
  });

  it("asks again on every evaluation, so a later answer replaces an unevaluated one", () => {
    const answers = new Map<string, boolean>();
    const { evaluate, regex } = evaluator((pattern) => answers.get(pattern));
    const uris = [{ uri: "^https://", match: 4 }];
    expect(evaluate(uris)).toMatchObject({
      data: { matched: false, unavailableUris: [{ uriIndex: 0, reason: "regex-unevaluated" }] },
    });
    answers.set("^https://", true);
    expect(evaluate(uris)).toMatchObject({
      data: { matched: true, matches: [{ uriIndex: 0, match: 4 }], unavailableUris: [] },
    });
    expect(regex).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined])("uses a retained Regex default for a URI with match %s", (match) => {
    const { evaluate, regex } = evaluator(() => true, { equivalentDomains: [], defaultMatch: 4 });
    expect(evaluate([{ uri: "example", match }])).toEqual({
      ok: true,
      data: {
        matched: true,
        targetOrigin: "https://example.com",
        matches: [{ uriIndex: 0, match: 4 }],
        unavailableUris: [],
      },
    });
    expect(regex).toHaveBeenCalledExactlyOnceWith("example");
  });

  it("reports a Regex default unevaluated where no answer can be given", () => {
    expect(
      matchBitwardenLoginUris([{ uri: "example", match: null }], target, { defaultMatch: 4 }),
    ).toEqual({
      ok: true,
      data: {
        matched: false,
        targetOrigin: "https://example.com",
        matches: [],
        unavailableUris: [{ uriIndex: 0, reason: "regex-unevaluated" }],
      },
    });
  });

  it.each([
    ["", 4, "invalid-uri"],
    [null, 4, "invalid-uri"],
    ["^https://", 6, "unsupported-uri-match"],
    ["^https://", 99, "unsupported-uri-match"],
  ] as const)("does not ask about %j with match %s", (uri, match, reason) => {
    const { evaluate, regex } = evaluator(() => true);
    expect(evaluate([{ uri, match }])).toEqual({
      ok: true,
      data: {
        matched: false,
        targetOrigin: "https://example.com",
        matches: [],
        unavailableUris: [{ uriIndex: 0, reason }],
      },
    });
    expect(regex).not.toHaveBeenCalled();
  });

  it("does not ask about a Never URI or a non-Regex URI", () => {
    const { evaluate, regex } = evaluator(() => true);
    expect(
      evaluate([
        { uri: "^https://", match: 5 },
        { uri: target, match: 3 },
        { uri: "https://example.org", match: 0 },
      ]),
    ).toMatchObject({ ok: true, data: { matches: [{ uriIndex: 1, match: 3 }] } });
    expect(regex).not.toHaveBeenCalled();
  });
}
