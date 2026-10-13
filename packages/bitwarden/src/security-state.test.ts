import { encode } from "cbor2";
import { describe, expect, it } from "vitest";

import { verifiedSecurityStateVersion } from "./security-state";
import { V2_SECURITY_STATE } from "./__fixtures__/crypto";

const decode = (value: string) => Uint8Array.from(atob(value), (part) => part.charCodeAt(0));
const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (h) => parseInt(h, 16));
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

const signature = new Uint8Array(64).fill(9);
/** A synthetic COSE_Sign1 array around the given payload; nothing here is signed. */
const sign1 = (payload: unknown) =>
  encode([encode(new Map([[1, -8]])), new Map(), payload, signature]);
const state = (version: unknown) => encode(new Map([["version", version]]));

describe("verified security state version", () => {
  it("reads version 2 from the SDK-recorded security state", () => {
    expect(verifiedSecurityStateVersion(decode(V2_SECURITY_STATE))).toBe(2);
  });

  it.each([0, 1, 3, 99])("returns version %s for the caller to judge", (version) => {
    expect(verifiedSecurityStateVersion(sign1(state(version)))).toBe(version);
  });

  it("ignores other payload fields", () => {
    const payload = encode(
      new Map<string, unknown>([
        ["entityId", signature],
        ["version", 2],
      ]),
    );
    expect(verifiedSecurityStateVersion(sign1(payload))).toBe(2);
  });

  it.each([
    ["a null payload", sign1(null)],
    ["a missing version", sign1(encode(new Map([["entityId", signature]])))],
    [
      "a duplicate version",
      sign1(join(hex("a2"), encode("version"), hex("02"), encode("version"), hex("03"))),
    ],
    [
      "a long-form duplicate version",
      sign1(
        join(
          hex("a2"),
          encode("version"),
          hex("02"),
          hex("7807"),
          encode("version").slice(1),
          hex("02"),
        ),
      ),
    ],
    ["a half-float version", sign1(join(hex("a1"), encode("version"), hex("f94000")))],
    ["a negative version", sign1(state(-1))],
    ["a fractional version", sign1(state(1.5))],
    ["a text version", sign1(state("2"))],
    ["a version beyond u32", sign1(join(hex("a1"), encode("version"), hex("1b0000000100000000")))],
    ["an array payload", sign1(encode([2]))],
    ["a non-CBOR payload", sign1(hex("ff"))],
    ["a text payload", sign1("payload")],
    ["three items", encode([new Uint8Array(), new Map(), state(2)])],
    ["a map", encode(new Map([["version", 2]]))],
    ["empty input", new Uint8Array()],
    ["truncated input", hex("84")],
  ])("returns undefined for %s", (_name, bytes) => {
    expect(verifiedSecurityStateVersion(bytes)).toBeUndefined();
  });
});
