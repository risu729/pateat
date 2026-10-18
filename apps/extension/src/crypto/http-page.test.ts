import { describe, expect, it } from "vitest";
import { pageMatches } from "./http-page";

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

  it("keeps only URIs saved with an explicit http:// scheme for an HTTP page", () => {
    expect(pageMatches("http://router.example", matches, uris)).toEqual([
      { uriIndex: 1, match: 0 },
    ]);
  });
});
