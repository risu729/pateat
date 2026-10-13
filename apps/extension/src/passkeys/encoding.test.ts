import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "./encoding";

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0x00);
    expect(toBase64Url(bytes)).toBe("-_8A");
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    expect(fromBase64Url("-_8A")).toEqual(bytes);
  });

  it("rejects padding, the standard alphabet, whitespace and non-canonical trailing bits", () => {
    for (const value of ["-_8=", "+/8", "-_ 8", "-_9", "A"])
      expect(fromBase64Url(value), value).toBeUndefined();
  });
});
