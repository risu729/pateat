import { createHash } from "node:crypto";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  createEnrollmentChallenge,
  createEnrollmentVerifier,
  deviceLabelSchema,
  enrollmentCode,
  enrollmentRedeemResultSchema,
  enrollmentRedeemSchema,
  normalizeEnrollmentCode,
} from "./enrollment";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Independent reference: the first 40 bits of the tagged digest as Crockford base32. */
function referenceCode(verifier: string): string {
  const bytes = createHash("sha256")
    .update(`pateat-enrollment-code:${verifier}`)
    .digest()
    .subarray(0, 5);
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const digits = Array.from(
    { length: 8 },
    (_, index) => CROCKFORD[Number.parseInt(bits.slice(index * 5, index * 5 + 5), 2)],
  ).join("");
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

describe("enrollment verifier and challenge", () => {
  it("creates 256-bit base64url verifiers", () => {
    const verifier = createEnrollmentVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(verifier, "base64url")).toHaveLength(32);
    expect(createEnrollmentVerifier()).not.toBe(verifier);
  });

  it("derives the challenge as base64url SHA-256 of the verifier", async () => {
    const verifiers = [createEnrollmentVerifier(), "A".repeat(43), "_".repeat(43)];
    const challenges = await Promise.all(verifiers.map(createEnrollmentChallenge));
    expect(challenges).toEqual(
      verifiers.map((verifier) => createHash("sha256").update(verifier).digest("base64url")),
    );
  });
});

describe("enrollment code", () => {
  it("matches an independent bit-level encoding", async () => {
    const verifiers = ["A".repeat(43), ...Array.from({ length: 50 }, createEnrollmentVerifier)];
    const codes = await Promise.all(verifiers.map(enrollmentCode));
    expect(codes).toEqual(verifiers.map(referenceCode));
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("differs from a code computed from the public challenge", async () => {
    const verifier = createEnrollmentVerifier();
    const challenge = await createEnrollmentChallenge(verifier);
    expect(await enrollmentCode(verifier)).not.toBe(await enrollmentCode(challenge));
  });

  it("rejects malformed verifiers", async () => {
    await expect(enrollmentCode("short")).rejects.toThrow();
    await expect(enrollmentCode(`${"A".repeat(42)}=`)).rejects.toThrow();
  });

  it("normalizes typed codes", () => {
    expect(normalizeEnrollmentCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizeEnrollmentCode(" ab cd ef gh ")).toBe("ABCD-EFGH");
    expect(normalizeEnrollmentCode("oil0-1234")).toBe("0110-1234");
    expect(normalizeEnrollmentCode("ABCD-EFG")).toBeNull();
    expect(normalizeEnrollmentCode("ABCD-EFGU")).toBeNull();
    expect(normalizeEnrollmentCode("ABCD_EFGH")).toBeNull();
  });
});

describe("enrollment schemas", () => {
  it("trims labels and rejects control characters", () => {
    expect(v.parse(deviceLabelSchema, "  Work laptop ")).toBe("Work laptop");
    expect(v.safeParse(deviceLabelSchema, "   ").success).toBe(false);
    expect(v.safeParse(deviceLabelSchema, "line\nbreak").success).toBe(false);
    expect(v.safeParse(deviceLabelSchema, "x".repeat(65)).success).toBe(false);
  });

  it("keeps redemption bodies strict", () => {
    const verifier = createEnrollmentVerifier();
    expect(v.safeParse(enrollmentRedeemSchema, { version: 1, verifier }).success).toBe(true);
    expect(
      v.safeParse(enrollmentRedeemSchema, { version: 1, verifier, ownerId: "x" }).success,
    ).toBe(false);
    expect(
      v.safeParse(enrollmentRedeemResultSchema, {
        version: 1,
        deviceId: crypto.randomUUID(),
        credential: `pateat_device_${"A".repeat(43)}`,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(enrollmentRedeemResultSchema, {
        version: 1,
        deviceId: crypto.randomUUID(),
        credential: "A".repeat(43),
      }).success,
    ).toBe(false);
  });
});
