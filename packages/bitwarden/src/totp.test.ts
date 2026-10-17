import { afterAll, describe, expect, it } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { generateLocalTotp } from "./totp";
import {
  bitwardenTotpSecret,
  bitwardenTotpTime,
  rfcTotpAnswers,
  rfcTotpSecrets,
  steamTotpSecret,
} from "./__fixtures__/totp";

const clock = (now: number) => ({ nowMs: () => now });
const ok = (value: string, now: number, period = 30) => ({
  ok: true,
  data: {
    kind: "otp",
    value,
    period,
    validUntilMs: (Math.floor(now / (period * 1000)) + 1) * period * 1000,
  },
});
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Deterministic synthetic secrets of every unpadded length from 2 to 40 characters, each also
// with its last character replaced by "7" (all five bits set), so every length whose final
// character carries unused bits has a variant where those bits are non-zero.
const syntheticSecrets = [
  ...new Set(
    Array.from({ length: 39 }, (_, index) => {
      const secret = (base32Alphabet + base32Alphabet).slice(index % 32, (index % 32) + index + 2);
      return [secret, `${secret.slice(0, -1)}7`];
    }).flat(),
  ),
];
// RFC 4648 decoding that drops leftover bits, then canonical unpadded re-encoding.
const canonicalBase32 = (secret: string) => {
  let bits = "";
  for (const character of secret) {
    bits += base32Alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  bits = bits.slice(0, bits.length - (bits.length % 8));
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    output += base32Alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return output;
};
const uri = (algorithm: keyof typeof rfcTotpSecrets) =>
  `otpauth://totp/Synthetic?secret=${rfcTotpSecrets[algorithm]}&algorithm=${algorithm}&digits=8&period=30`;

describe("local TOTP independent known answers", () => {
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

  // Pinned from the Bitwarden SDK at bitwardenTotpTime; Bitwarden drops leftover Base32 bits.
  it.each([
    ["JBSWY3DPEHPK3PX", "306060"],
    ["jbsw y3dp ehpk 3px", "306060"],
    ["JBSWY3DPEHPK3PX=", "306060"],
    ["MZ", "468286"],
    ["MZ======", "468286"],
    ["ABCDEFGHIJKLMNOPQ", "470218"],
    ["ABCDEFGHIJKLMNOPQRS", "268561"],
    ["ABCDEFGHIJKLMNOPQRSTUV", "815389"],
    ["otpauth://totp/Test?secret=JBSWY3DPEHPK3PX", "306060"],
    ["otpauth://totp/Test?secret=MZ%3D%3D%3D%3D%3D%3D", "468286"],
    ["steam://JBSWY3DPEHPK3PX", "G6254"],
    ["steam://ABCDEFGHIJKLMNOPQ", "VJXW9"],
    ["steam://ABC", "M8HDH"],
  ])("matches pinned Bitwarden answer for non-canonical Base32 %s", (seed, value) => {
    expect(generateLocalTotp(seed, clock(bitwardenTotpTime))).toEqual(ok(value, bitwardenTotpTime));
  });

  it.each([
    "image=https%3A%2F%2Fexample.com%2Flogo.png",
    "icon=https%3A%2F%2Fexample.com%2Ficon.svg",
    "color=%23175DDC",
    "IMAGE=logo.png",
    "Icon=icon.png&CoLoR=red",
    "image=&icon=&color=",
    "image=logo.png&icon=icon.png&color=blue",
  ])("ignores display-only otpauth parameters %s", (display) => {
    expect(
      generateLocalTotp(
        `otpauth://totp/Test?secret=${bitwardenTotpSecret}&${display}`,
        clock(bitwardenTotpTime),
      ),
    ).toEqual(ok("194506", bitwardenTotpTime));
    expect(
      generateLocalTotp(
        `otpauth://totp/Test?${display}&secret=${bitwardenTotpSecret}&period=60&algorithm=SHA256&digits=8`,
        clock(bitwardenTotpTime),
      ),
    ).toEqual(
      generateLocalTotp(
        `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=60&algorithm=SHA256&digits=8`,
        clock(bitwardenTotpTime),
      ),
    );
  });

  it.each(syntheticSecrets)("decodes %s as its canonical Base32 form", (secret) => {
    const canonical = canonicalBase32(secret);
    const expected = generateLocalTotp(canonical, clock(bitwardenTotpTime));
    expect(expected.ok).toBe(true);
    expect(generateLocalTotp(secret, clock(bitwardenTotpTime))).toEqual(expected);
    expect(generateLocalTotp(`steam://${secret}`, clock(bitwardenTotpTime))).toEqual(
      generateLocalTotp(`steam://${canonical}`, clock(bitwardenTotpTime)),
    );
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
    "MZ=",
    "MZ=======",
    "JBSWY3DPEHPK3PX==",
    "A",
    "7",
    " 7 ",
    "PIUDISEQYA=====",
    "PIUDISEQYA=======",
    "otpauth://totp/Test",
    "otpauth://totp/Test?secret=",
    "otpauth://totp/Test?secret=ABCD1!",
    "otpauth://totp/Test?secret=7",
    "otpauth://totp/Test?secret=MZ%3D",
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&secret=${bitwardenTotpSecret}`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=0`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=-1`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&period=1.5`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&digits=0`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&digits=6&digits=8`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&image=a.png&image=b.png`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&image=a.png&IMAGE=a.png`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&icon=a&icon=a`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&color=red&Color=blue`,
    `otpauth://user:pass@totp/Test?secret=${bitwardenTotpSecret}`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}#secret`,
    "steam://",
    "steam://ABCD123",
    "steam://7",
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
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&encoder=steam`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&foo=bar`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&image=logo.png&foo=bar`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&images=logo.png`,
    `otpauth://totp/Test?secret=${bitwardenTotpSecret}&colour=red`,
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

describe("local TOTP agrees with the published Bitwarden SDK", () => {
  sdk.init_sdk(sdk.LogLevel.Error, sdk.LogLevel.Error, 0);
  const client = new sdk.PasswordManagerClient(
    { get_access_token: async () => undefined },
    undefined,
    new sdk.ManagedSettingsClient(),
  );
  const totp = client.vault().totp();
  afterAll(() => client.free());
  const times = [59_000, bitwardenTotpTime];

  const expectSdkParity = (seed: string) => {
    for (const now of times) {
      const { code, period } = totp.generate_totp(seed, now);
      expect(generateLocalTotp(seed, clock(now))).toEqual(ok(code, now, period));
    }
  };

  it.each(syntheticSecrets)("generates the SDK code for raw secret %s", (secret) => {
    expectSdkParity(secret);
    expectSdkParity(secret.toLowerCase().replace(/(.{4})/gu, "$1 "));
  });

  it.each(syntheticSecrets)("generates the SDK code for otpauth secret %s", (secret) => {
    expectSdkParity(`otpauth://totp/Synthetic?secret=${secret}`);
    expectSdkParity(
      `otpauth://totp/Synthetic?secret=${secret}&algorithm=SHA512&digits=8&period=45&image=https%3A%2F%2Fexample.com%2Flogo.png`,
    );
  });

  it.each(syntheticSecrets)("generates the SDK code for steam secret %s", (secret) => {
    expectSdkParity(`steam://${secret}`);
  });

  it.each([
    "image=https%3A%2F%2Fexample.com%2Flogo.png",
    "icon=https%3A%2F%2Fexample.com%2Ficon.svg",
    "color=%23175DDC",
    "ImAgE=logo.png&ICON=icon.png&Color=red",
  ])("generates the SDK code with display-only parameters %s", (display) => {
    expectSdkParity(`otpauth://totp/Test?secret=${bitwardenTotpSecret}&${display}`);
    expectSdkParity(`otpauth://totp/Test?${display}&secret=JBSWY3DPEHPK3PX&algorithm=SHA256`);
  });
});
