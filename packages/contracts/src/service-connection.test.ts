import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  normalizeServiceOrigin,
  parseServiceResponse,
  serviceOriginSchema,
  serviceRequestSchema,
} from "./service-connection";

describe("service origin", () => {
  it.each([
    ["https://pateat.example.com", "https://pateat.example.com"],
    ["  https://pateat.example.com/  ", "https://pateat.example.com"],
    ["https://PATEAT.example.com:8443/", "https://pateat.example.com:8443"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeServiceOrigin(input)).toBe(expected);
  });

  it.each([
    "http://pateat.example.com",
    "https://pateat.example.com/api",
    "https://pateat.example.com/?x=1",
    "https://pateat.example.com/#x",
    "https://user:pass@pateat.example.com",
    "pateat.example.com",
    "https://",
    "javascript:alert(1)",
  ])("rejects %j", (input) => {
    expect(normalizeServiceOrigin(input)).toBeUndefined();
  });

  it("accepts only exact HTTPS origins in contracts", () => {
    expect(v.safeParse(serviceOriginSchema, "https://pateat.example.com").success).toBe(true);
    expect(v.safeParse(serviceOriginSchema, "https://pateat.example.com/").success).toBe(false);
    expect(v.safeParse(serviceOriginSchema, "http://pateat.example.com").success).toBe(false);
  });
});

describe("service messages", () => {
  it("never accepts secrets from the options page", () => {
    const start = {
      version: 1,
      type: "service.pair.start",
      origin: "https://pateat.example.com",
      label: "Laptop",
    };
    expect(v.safeParse(serviceRequestSchema, start).success).toBe(true);
    expect(
      v.safeParse(serviceRequestSchema, { ...start, credential: `pateat_device_${"A".repeat(43)}` })
        .success,
    ).toBe(false);
  });

  it("accepts only the service's own approval page", () => {
    const pairing = {
      kind: "pairing",
      origin: "https://pateat.example.com",
      label: "Laptop",
      code: "ABCD-EFGH",
      enrollUrl: "https://pateat.example.com/enroll?challenge=x",
      expiresAt: 1,
    };
    expect(parseServiceResponse({ ok: true, state: pairing }).ok).toBe(true);
    for (const enrollUrl of [
      "https://evil.example.com/enroll?challenge=x",
      "https://pateat.example.com.evil.example/enroll?challenge=x",
      "https://pateat.example.com/manage",
    ])
      expect(() => parseServiceResponse({ ok: true, state: { ...pairing, enrollUrl } })).toThrow();
  });

  it("rejects responses carrying unknown fields", () => {
    expect(() =>
      parseServiceResponse({
        ok: true,
        state: {
          kind: "connected",
          origin: "https://pateat.example.com",
          label: "Laptop",
          deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
          credential: "leak",
        },
      }),
    ).toThrow();
  });
});
