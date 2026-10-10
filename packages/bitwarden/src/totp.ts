import { HOTP, Secret, TOTP } from "otpauth";

import { failure, type BitwardenResult } from "./errors";

export interface LocalOtpValue {
  readonly kind: "otp";
  readonly value: string;
  readonly validUntilMs: number;
  readonly period: number;
}

export interface LocalTotpOptions {
  readonly nowMs?: () => number;
}

const steamAlphabet = "23456789BCDFGHJKMNPQRTVWXY";
const algorithms = new Set(["SHA1", "SHA256", "SHA512"]);

/** Strict framing around the maintained OTP library; no clock or network discovery. */
export function generateLocalTotp(
  input: unknown,
  options: LocalTotpOptions = {},
): BitwardenResult<LocalOtpValue> {
  let secret: Secret | undefined;
  try {
    if (
      typeof input !== "string" ||
      !input.length ||
      input.length > 8192 ||
      /\p{Cc}/u.test(input)
    ) {
      return failure("invalid-totp");
    }
    if (
      options === null ||
      typeof options !== "object" ||
      (options.nowMs !== undefined && typeof options.nowMs !== "function")
    ) {
      return failure("invalid-options");
    }
    let now: number;
    try {
      now = options.nowMs === undefined ? Date.now() : options.nowMs();
    } catch {
      return failure("invalid-options");
    }
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
      return failure("invalid-options");
    }
    let base32 = input;
    let algorithm = "SHA1";
    let digits = 6;
    let period = 30;
    let steam = false;
    if (/^steam:\/\//iu.test(input)) {
      steam = true;
      base32 = input.slice(8);
    } else if (/^otpauth:\/\//iu.test(input)) {
      const uri = new URL(input);
      if (uri.hostname.toLowerCase() !== "totp") return failure("unsupported-totp");
      if (uri.username || uri.password || uri.port || uri.hash) return failure("invalid-totp");
      const parameters = new Map<string, string>();
      for (const [key, value] of uri.searchParams) {
        const normalized = key.toLowerCase();
        if (parameters.has(normalized)) return failure("invalid-totp");
        if (!["secret", "issuer", "algorithm", "digits", "period"].includes(normalized)) {
          return failure("unsupported-totp");
        }
        parameters.set(normalized, value);
      }
      base32 = parameters.get("secret") ?? "";
      algorithm = (parameters.get("algorithm") ?? "SHA1").toUpperCase();
      if (!algorithms.has(algorithm)) return failure("unsupported-totp");
      for (const key of ["digits", "period"] as const) {
        const raw = parameters.get(key);
        if (raw === undefined) continue;
        if (!/^[0-9]+$/u.test(raw)) return failure("invalid-totp");
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1) return failure("invalid-totp");
        if (value > (key === "digits" ? 10 : 2_147_483_647)) {
          return failure("unsupported-totp");
        }
        if (key === "digits") digits = value;
        else period = value;
      }
    } else if (input.includes(":")) {
      return failure("unsupported-totp");
    }
    const normalized = base32.replaceAll(" ", "").toUpperCase();
    if (!/^[A-Z2-7]+={0,6}$/u.test(normalized)) return failure("invalid-totp");
    const unpadded = normalized.replace(/=+$/u, "");
    const remainder = unpadded.length % 8;
    if (![0, 2, 4, 5, 7].includes(remainder)) return failure("invalid-totp");
    const expectedPadding = remainder === 0 ? 0 : 8 - remainder;
    if (normalized.includes("=") && normalized.length - unpadded.length !== expectedPadding) {
      return failure("invalid-totp");
    }
    secret = Secret.fromBase32(unpadded);
    // The library decoder is permissive about unused bits; a canonical round trip closes that gap.
    if (!secret.bytes.length || secret.base32.replace(/=+$/u, "") !== unpadded) {
      return failure("invalid-totp");
    }
    let value: string;
    if (steam) {
      // Ten decimal digits preserve the library's entire 31-bit HOTP result. Only rendering differs.
      let binary = Number(
        HOTP.generate({ secret, algorithm: "SHA1", digits: 10, counter: Math.floor(now / 30_000) }),
      );
      if (!Number.isSafeInteger(binary) || binary < 0 || binary > 2_147_483_647) {
        return failure("invalid-totp");
      }
      value = "";
      for (let index = 0; index < 5; index += 1) {
        value += steamAlphabet[binary % steamAlphabet.length];
        binary = Math.floor(binary / steamAlphabet.length);
      }
    } else {
      value = TOTP.generate({ secret, algorithm, digits, period, timestamp: now });
    }
    const validUntilMs = (Math.floor(now / (period * 1000)) + 1) * period * 1000;
    if (!Number.isSafeInteger(validUntilMs)) return failure("invalid-options");
    return { ok: true, data: { kind: "otp", value, validUntilMs, period } };
  } catch {
    return failure("invalid-totp");
  } finally {
    secret?.bytes.fill(0);
  }
}
