import { expect, it } from "vitest";
import { matchBitwardenLoginUris } from "../../src/uri";
import { uriMatchCases } from "../../src/__fixtures__/uri";
import type { OrdinarySemanticsContext } from "./context";

export function registerOrdinarySemantics({
  emptyResult,
  saved,
  target,
}: OrdinarySemanticsContext) {
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
