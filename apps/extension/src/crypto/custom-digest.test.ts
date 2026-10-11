import { describe, expect, it } from "vitest";
import { toBase64Url } from "../passkeys/encoding";
import { customFieldsDigest, importDigestKey, withDigestKey } from "./custom-digest";

const keyOf = async (fill: number) =>
  (await importDigestKey(toBase64Url(new Uint8Array(32).fill(fill))))!;
const field = { name: "PIN", value: "1234", type: 1, linkedId: null };

describe("custom-field digests", () => {
  it("are equal only for the same fields in the same order under the same key", async () => {
    const key = await keyOf(1);
    const digest = (fields: Parameters<typeof customFieldsDigest>[0]) =>
      customFieldsDigest(fields, key);
    const base = await digest([field, { ...field, name: "Code" }]);
    expect(await digest([field, { ...field, name: "Code" }])).toBe(base);
    const variants = await Promise.all([
      digest([{ ...field, name: "Code" }, field]),
      digest([field]),
      digest([field, { ...field, name: "Code", value: "" }]),
      digest([field, { ...field, name: "Code", value: null }]),
      digest([field, { ...field, name: "Code", type: 0 }]),
      digest([field, { ...field, name: "Code", type: 3, linkedId: 101 }]),
      digest([field, { ...field, name: "Code", value: "12345" }]),
    ]);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
    expect(await digest(null)).toBe(await digest([]));
    expect(await customFieldsDigest([field], await keyOf(2))).not.toBe(await digest([field]));
  });
  it("refuse a key that is missing or not 32 bytes", async () => {
    expect(await importDigestKey(undefined)).toBeUndefined();
    expect(await importDigestKey(toBase64Url(new Uint8Array(16)))).toBeUndefined();
    expect(await importDigestKey("not base64url!")).toBeUndefined();
  });
  it("get the relay's key in place of any key the background sent", () => {
    const command = {
      requestId: "r",
      operation: { kind: "custom-digest", itemIds: [], key: "background" },
    };
    expect(withDigestKey(command, "relay").operation).toEqual({
      kind: "custom-digest",
      itemIds: [],
      key: "relay",
    });
    const other = { operation: { kind: "catalog" } };
    expect(withDigestKey(other, "relay")).toBe(other);
  });
});
