import { describe, expect, it } from "vitest";
import { Secret } from "otpauth";
import { generateLocalTotp } from "./totp";
import {
  bitwardenTotpSecret,
  bitwardenTotpTime,
  rfcTotpAnswers,
  rfcTotpSecrets,
  steamTotpSecret,
} from "./__fixtures__/totp";

const clock = (now: number) => ({ nowMs: () => now });
const uri = (algorithm: keyof typeof rfcTotpSecrets) =>
  `otpauth://totp/Synthetic?secret=${rfcTotpSecrets[algorithm]}&algorithm=${algorithm}&digits=8&period=30`;

describe("local TOTP independent known answers", () => {
  it.each([
    ["SHA1", "12345678901234567890"],
    ["SHA256", "12345678901234567890123456789012"],
    ["SHA512", "1234567890123456789012345678901234567890123456789012345678901234"],
  ] as const)("encodes the exact RFC %s ASCII secret", (algorithm, ascii) => {
    expect(new TextDecoder().decode(Secret.fromBase32(rfcTotpSecrets[algorithm]).bytes)).toBe(
      ascii,
    );
  });
  for (const algorithm of ["SHA1", "SHA256", "SHA512"] as const) {
    it.each(rfcTotpAnswers)(`${algorithm} RFC answer at $seconds seconds`, (answer) => {
      expect(generateLocalTotp(uri(algorithm), clock(answer.seconds * 1000))).toEqual({
        ok: true,
        data: {
          kind: "otp",
          value: answer[algorithm],
          period: 30,
          validUntilMs: (Math.floor(answer.seconds / 30) + 1) * 30_000,
        },
      });
    });
  }

  // RFC 4226 Appendix D counters 0/1/2, interpreted as TOTP steps of 30 seconds.
  it.each([
    [0, "755224", 30_000],
    [29_999, "755224", 30_000],
    [30_000, "287082", 60_000],
    [59_999, "287082", 60_000],
    [60_000, "359152", 90_000],
  ])("changes at the exact boundary %dms", (now, value, validUntilMs) => {
    expect(generateLocalTotp(rfcTotpSecrets.SHA1, clock(now as number))).toEqual({
      ok: true,
      data: { kind: "otp", value, period: 30, validUntilMs },
    });
  });

  it.each([
    [bitwardenTotpSecret, "194506", 30],
    [bitwardenTotpSecret.toLowerCase(), "194506", 30],
    ["WQIQ 25BR KZYC JVYP", "194506", 30],
    ["PIUDISEQYA", "829846", 30],
    ["PIUDISEQYA======", "829846", 30],
    [`otpauth://totp/Test?secret=${bitwardenTotpSecret}`, "194506", 30],
    [`otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=60`, "730364", 60],
    [`otpauth://totp/Test?secret=${bitwardenTotpSecret}&algorithm=SHA256`, "842615", 30],
    [`steam://${steamTotpSecret}`, "7W6CJ", 30],
    [`StEaM://${steamTotpSecret.toLowerCase()}`, "7W6CJ", 30],
  ])("matches pinned Bitwarden answer for case %#", (seed, value, period) => {
    expect(generateLocalTotp(seed, clock(bitwardenTotpTime))).toEqual({
      ok: true,
      data: { kind: "otp", value, period, validUntilMs: bitwardenTotpTime + Number(period) * 1000 },
    });
  });

  it("preserves supported digits rather than silently clamping them", () => {
    for (const [digits, value] of [
      [1, "4"],
      [10, "1284755224"],
    ] as const) {
      expect(
        generateLocalTotp(
          `otpauth://totp/Test?secret=${rfcTotpSecrets.SHA1}&digits=${digits}`,
          clock(0),
        ),
      ).toEqual({
        ok: true,
        data: { kind: "otp", value, period: 30, validUntilMs: 30_000 },
      });
    }
  });

  it("samples the injected clock once for both code and validity", () => {
    let calls = 0;
    expect(
      generateLocalTotp(rfcTotpSecrets.SHA1, {
        nowMs: () => {
          calls++;
          return calls === 1 ? 29_999 : 30_000;
        },
      }),
    ).toEqual({
      ok: true,
      data: { kind: "otp", value: "755224", period: 30, validUntilMs: 30_000 },
    });
    expect(calls).toBe(1);
  });
});

describe("local TOTP admission", () => {
  it.each([
    "",
    " ",
    "ABCD1!",
    "MY=",
    "MZ======",
    "PIUDISEQYA=====",
    "PIUDISEQYA=======",
    "otpauth://totp/Test",
    "otpauth://totp/Test?secret=",
    "otpauth://totp/Test?secret=ABCD1!",
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&secret=${bitwardenTotpSecret}`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=0`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=-1`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=1.5`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&digits=0`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&digits=6&digits=8`,
    `otpauth://user:pass@totp/Test?secret=${bitwardenTotpSecret}`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}#secret`,
    "steam://",
    "steam://ABCD123",
  ])("rejects malformed seed case %# without reflecting it", (seed) => {
    expect(generateLocalTotp(seed, clock(59_000))).toEqual({
      ok: false,
      error: { code: "invalid-totp" },
    });
  });

  it.each([
    `otpauth://hotp/Test?secret=${bitwardenTotpSecret}&counter=0`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&algorithm=SHA3-256`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&algorithm=unknown`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&digits=11`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=2147483648`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&counter=1`,
    "https://example.test/otp",
  ])("reports unsupported formats explicitly for case %#", (seed) => {
    expect(generateLocalTotp(seed, clock(59_000))).toEqual({
      ok: false,
      error: { code: "unsupported-totp" },
    });
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid clock %s", (now) => {
    expect(generateLocalTotp(rfcTotpSecrets.SHA1, clock(now))).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
  });

  it("sanitizes a throwing clock without exposing the seed or exception", () => {
    expect(
      generateLocalTotp(bitwardenTotpSecret, {
        nowMs: () => {
          throw new Error("private clock detail");
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid-options" },
    });
  });

  it.each([undefined, null, "59000"])(
    "does not substitute wall time for invalid injected time %s",
    (now) => {
      expect(
        generateLocalTotp(rfcTotpSecrets.SHA1, { nowMs: (() => now) as unknown as () => number }),
      ).toEqual({
        ok: false,
        error: { code: "invalid-options" },
      });
    },
  );

  // WHATWG URL strips literal TAB/CR/LF before parsing; reject before that
  // normalization can turn an invalid stored seed/algorithm into a valid one.
  it.each([
    `otpauth://totp/Test?secret=WQIQ\t25BRKZYCJVYP`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&algorithm=SHA\n1`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}\r`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&issuer=Invalid\u007fIssuer`,
  ])("rejects literal control characters before URL normalization case %#", (seed) => {
    expect(generateLocalTotp(seed, clock(59_000))).toEqual({
      ok: false,
      error: { code: "invalid-totp" },
    });
  });

  it.each([null, undefined, 123, {}, [bitwardenTotpSecret]])(
    "rejects non-string input case %#",
    (seed) => {
      expect(generateLocalTotp(seed, clock(59_000))).toEqual({
        ok: false,
        error: { code: "invalid-totp" },
      });
    },
  );
});
