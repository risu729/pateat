import { describe, expect, it } from "vitest";
import { decodeBase64, decodeBase64Url } from "./base64";

describe("canonical base64", () => {
  it("decodes padded standard base64 and rejects any other spelling of it", () => {
    expect(decodeBase64("+/8=")).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(decodeBase64("")).toEqual(new Uint8Array());
    for (const value of ["+/8", "+/9=", "-_8=", "+/8==", "+/ 8=", "+/8=\n", "A==="])
      expect(decodeBase64(value), value).toBeUndefined();
  });

  it("decodes unpadded base64url and rejects padding, whitespace and non-zero trailing bits", () => {
    expect(decodeBase64Url("-_8")).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(decodeBase64Url("")).toEqual(new Uint8Array());
    for (const value of ["-_8=", "-_9", "+/8", "A", "-_ 8"])
      expect(decodeBase64Url(value), value).toBeUndefined();
  });
});
