import { describe, expect, it } from "vitest";

import { isCoseSign1, verifiedSecurityStateVersion } from "./cose";
import { V2_SECURITY_STATE, V2_SIGNED_PUBLIC_KEY } from "./__fixtures__/crypto";

const decode = (value: string) => Uint8Array.from(atob(value), (part) => part.charCodeAt(0));
const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (h) => parseInt(h, 16));
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

// Minimal definite-length CBOR encoder for synthetic shapes.
type Value = number | string | Uint8Array | null | Value[] | Map<Value, Value>;
function head(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
  if (length < 0x10000) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    length >>> 24,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  );
}
function cbor(value: Value): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === "number") return value < 0 ? head(1, -1 - value) : head(0, value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return join(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return join(head(2, value.length), value);
  if (Array.isArray(value)) return join(head(4, value.length), ...value.map(cbor));
  return join(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

const kid = new Uint8Array(16).fill(7);
const signature = new Uint8Array(64).fill(9);
const protectedMap = (entries: [Value, Value][] = []) =>
  new Map<Value, Value>([[1, -8], [3, 60], [4, kid], [-80000, 2], ...entries]);
function sign1({
  protectedHeader = cbor(protectedMap()) as Uint8Array,
  unprotected = new Map<Value, Value>() as Value,
  payload = cbor(new Map([["version", 2]])) as Value,
  sig = signature as Value,
} = {}): Uint8Array {
  return cbor([protectedHeader, unprotected, payload, sig]);
}

describe("COSE_Sign1 framing before the SDK's async boundary", () => {
  it("accepts the SDK-recorded signed security state and signed public key", () => {
    expect(isCoseSign1(decode(V2_SECURITY_STATE))).toBe(true);
    expect(isCoseSign1(decode(V2_SIGNED_PUBLIC_KEY))).toBe(true);
  });

  it.each([
    ["the synthetic shape", sign1(), true],
    ["an empty protected header", sign1({ protectedHeader: new Uint8Array() }), true],
    ["a null payload", sign1({ payload: null }), true],
    ["ML-DSA-44", sign1({ protectedHeader: cbor(new Map([[1, -48]])) as Uint8Array }), true],
    ["text labels", sign1({ unprotected: new Map([["x", 1]]) }), true],
    ["a private label", sign1({ protectedHeader: join(hex("a1"), hex("20"), hex("00")) }), true],
    [
      "nesting at the depth limit",
      sign1({
        protectedHeader: join(hex("a1"), hex("20"), new Uint8Array(15).fill(0x81), hex("00")),
      }),
      true,
    ],
  ] as const)("accepts %s", (_name, bytes, expected) => {
    expect(isCoseSign1(bytes)).toBe(expected);
  });

  it.each([
    ["empty input", new Uint8Array()],
    ["a lone zero", hex("00")],
    ["a truncated array", hex("80")],
    ["a truncated item", hex("84")],
    ["a COSE_Sign1 tag", join(hex("d2"), sign1())],
    ["trailing data", join(sign1(), hex("00"))],
    ["three items", cbor([new Uint8Array(), new Map(), null])],
    ["five items", cbor([new Uint8Array(), new Map(), null, signature, signature])],
    ["an indefinite-length array", join(hex("9f"), sign1().subarray(1), hex("ff"))],
    ["a text protected header", cbor(["a", new Map(), null, signature])],
    ["a protected header that is not a map", sign1({ protectedHeader: cbor([1]) })],
    [
      "protected header trailing data",
      sign1({ protectedHeader: join(cbor(new Map()), hex("00")) }),
    ],
    ["an unprotected array", sign1({ unprotected: [] })],
    ["a text payload", sign1({ payload: "payload" })],
    ["a missing signature", sign1({ sig: null })],
    [
      "a duplicate label",
      sign1({ protectedHeader: join(hex("a2"), cbor(4), cbor(kid), cbor(4), cbor(kid)) }),
    ],
    [
      "a duplicate protected label",
      sign1({ protectedHeader: join(hex("a2"), cbor(1), cbor(-8), cbor(1), cbor(-8)) }),
    ],
    ["critical headers", sign1({ protectedHeader: cbor(protectedMap([[2, [1]]])) })],
    ["an IV", sign1({ unprotected: new Map([[5, kid]]) })],
    ["a partial IV", sign1({ unprotected: new Map([[6, kid]]) })],
    ["a counter signature", sign1({ unprotected: new Map([[7, [kid, new Map(), kid]]]) })],
    ["an empty key ID", sign1({ unprotected: new Map([[4, new Uint8Array()]]) })],
    ["an unregistered algorithm", sign1({ unprotected: new Map([[1, -65535]]) })],
    ["a text algorithm", sign1({ unprotected: new Map([[1, "EdDSA"]]) })],
    ["a non-CBOR content format", sign1({ unprotected: new Map([[3, 50]]) })],
    ["a byte-string label", sign1({ unprotected: new Map([[kid, 1]]) })],
    [
      "a label beyond i64",
      sign1({ protectedHeader: join(hex("a1"), hex("1bffffffffffffffff01")) }),
    ],
    ["invalid UTF-8", sign1({ protectedHeader: join(hex("a1"), hex("62c328"), hex("01")) })],
    [
      "a reserved additional value",
      sign1({ protectedHeader: join(hex("a1"), hex("01"), hex("1c")) }),
    ],
    [
      "an unassigned simple value",
      sign1({ protectedHeader: join(hex("a1"), hex("20"), hex("f0")) }),
    ],
    ["a length beyond the input", join(hex("845a7fffffff"), new Uint8Array(8))],
    [
      "excessive nesting",
      sign1({
        protectedHeader: join(hex("a1"), hex("20"), new Uint8Array(32).fill(0x81), hex("00")),
      }),
    ],
  ])("rejects %s", (_name, bytes) => {
    expect(isCoseSign1(bytes)).toBe(false);
  });
});

describe("verified security state version", () => {
  it("reads version 2 from the SDK-recorded security state", () => {
    expect(verifiedSecurityStateVersion(decode(V2_SECURITY_STATE))).toBe(2);
  });

  it.each([0, 1, 3, 99])("returns version %s for the caller to judge", (version) => {
    expect(
      verifiedSecurityStateVersion(sign1({ payload: cbor(new Map([["version", version]])) })),
    ).toBe(version);
  });

  it.each([
    ["a null payload", sign1({ payload: null })],
    ["a missing version", sign1({ payload: cbor(new Map([["entityId", kid]])) })],
    [
      "a duplicate version",
      sign1({ payload: join(hex("a2"), cbor("version"), hex("02"), cbor("version"), hex("03")) }),
    ],
    ["a negative version", sign1({ payload: cbor(new Map([["version", -1]])) })],
    ["a text version", sign1({ payload: cbor(new Map([["version", "2"]])) })],
    [
      "a version beyond u32",
      sign1({ payload: join(hex("a1"), cbor("version"), hex("1b0000000200000000")) }),
    ],
    ["an array payload", sign1({ payload: cbor([2]) })],
    ["a non-CBOR payload", sign1({ payload: hex("ff") })],
    ["invalid framing", join(hex("d2"), sign1())],
  ])("returns undefined for %s", (_name, bytes) => {
    expect(verifiedSecurityStateVersion(bytes)).toBeUndefined();
  });
});
