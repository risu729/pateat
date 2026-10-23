import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  deviceLabelSchema,
  devicePairRequestSchema,
  devicePairResultSchema,
  extensionIdSchema,
  pairErrorSchema,
} from "./pairing";

// Synthetic identifiers only.
const credential = `pateat_device_${"A".repeat(43)}`;

describe("device labels", () => {
  it("trims labels and rejects control characters", () => {
    expect(v.parse(deviceLabelSchema, "  Work laptop ")).toBe("Work laptop");
    expect(v.safeParse(deviceLabelSchema, "   ").success).toBe(false);
    expect(v.safeParse(deviceLabelSchema, "line\nbreak").success).toBe(false);
    expect(v.safeParse(deviceLabelSchema, "x".repeat(65)).success).toBe(false);
  });

  it("accepts emoji names joined or tagged by format characters", () => {
    // Zero-width joiner, variation selector, and tag characters of a subdivision flag.
    for (const label of [
      "👩‍💻 MacBook",
      "🏳️‍🌈 laptop",
      "🏴󠁧󠁢󠁳󠁣󠁴󠁿 PC",
      "仕事用ノート",
      "soft\u00adhyphen",
      "zero\u200bwidth",
      "private\ue000use",
    ])
      expect(v.safeParse(deviceLabelSchema, label).success).toBe(true);
  });

  it("rejects characters that hide or reorder what the name shows", () => {
    for (const label of [
      "tab\there",
      "nul\u0000",
      "del\u007f",
      "line\u2028separator",
      "para\u2029separator",
      "right-to-left\u202eoverride",
      "isolate\u2066text\u2069",
      "mark\u200f",
      "arabic\u061cmark",
      "lone\ud800surrogate",
      // Invisible characters alone would show as a blank name.
      "\u200b",
      "\u2060\u00ad",
      "\u3164",
      "\u2800",
      "\u0301",
    ])
      expect(v.safeParse(deviceLabelSchema, label).success).toBe(false);
  });
});

describe("pairing bodies", () => {
  it("keeps the request strict", () => {
    expect(v.parse(devicePairRequestSchema, { version: 1, label: " Laptop " })).toEqual({
      version: 1,
      label: "Laptop",
    });
    for (const body of [
      { version: 2, label: "Laptop" },
      { version: 1, label: "" },
      { version: 1, label: "Laptop", ownerId: "x" },
      { version: 1 },
      { label: "Laptop" },
    ])
      expect(v.safeParse(devicePairRequestSchema, body).success).toBe(false);
  });

  it("keeps the result strict", () => {
    const result = { version: 1, deviceId: crypto.randomUUID(), credential };
    expect(v.safeParse(devicePairResultSchema, result).success).toBe(true);
    for (const body of [
      { ...result, credential: "A".repeat(43) },
      { ...result, credential: `pateat_device_${"A".repeat(42)}` },
      { ...result, deviceId: "device-1" },
      { ...result, ownerId: crypto.randomUUID() },
      { ...result, version: 2 },
    ])
      expect(v.safeParse(devicePairResultSchema, body).success).toBe(false);
  });

  it("names only known error codes", () => {
    expect(v.safeParse(pairErrorSchema, { error: "extension_not_allowed" }).success).toBe(true);
    expect(v.safeParse(pairErrorSchema, { error: "not_found" }).success).toBe(false);
    expect(v.safeParse(pairErrorSchema, { error: "rate_limited", detail: "x" }).success).toBe(
      false,
    );
  });
});

describe("extension IDs", () => {
  it("accepts 32 letters a to p only", () => {
    expect(v.safeParse(extensionIdSchema, "abcdefghijklmnopabcdefghijklmnop").success).toBe(true);
    for (const id of [
      "abcdefghijklmnopabcdefghijklmno",
      "abcdefghijklmnopabcdefghijklmnopa",
      "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
      "qbcdefghijklmnopabcdefghijklmnop",
      "abcdefghijklmnopabcdefghijklmno/",
      "",
    ])
      expect(v.safeParse(extensionIdSchema, id).success).toBe(false);
  });
});
