import { describe, expect, it } from "vitest";
import { countsOnHttpPage, pageMatches } from "./http-page";

const uris = [
  { uri: "https://router.example" },
  { uri: " HTTP://router.example/login" },
  { uri: "router.example" },
  { uri: "router.example:8080" },
  { uri: null },
];
const matches = uris.map((_uri, uriIndex) => ({ uriIndex, match: 0 as const }));

describe("pageMatches", () => {
  it("keeps every match for an HTTPS page", () => {
    expect(pageMatches("https://router.example", matches, uris)).toEqual(matches);
  });

  it("keeps only URIs saved with an explicit http:// scheme for an HTTP page (ADR 0050)", () => {
    expect(pageMatches("http://router.example", matches, uris)).toEqual([
      { uriIndex: 1, match: 0 },
    ]);
  });
});

describe("countsOnHttpPage", () => {
  it.each([
    ["http://router.example", true],
    [" HTTP://router.example/login", true],
    ["https://router.example", false],
    ["router.example", false],
    // A Regex pattern counts only when its text itself starts with http:// (ADR 0056).
    ["^http://router\\.example", false],
    ["http://router\\.example/.*", true],
    ["", false],
  ])("%j counts on an http: page: %s", (uri, counts) => {
    expect(countsOnHttpPage(uri)).toBe(counts);
  });
});
