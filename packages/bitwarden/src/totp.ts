import { HOTP, Secret } from "otpauth";

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
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const algorithms = new Map([
  ["sha1", "SHA1"],
  ["sha256", "SHA256"],
  ["sha512", "SHA512"],
]);

/** Rust's `str::parse::<u32>`: an optional `+`, then decimal digits, at most 2^32 - 1. */
function parseU32(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\+?[0-9]+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return value <= 0xffff_ffff ? value : undefined;
}

/**
 * The SDK's `decode_b32`: upper-case, skip every character outside the Base32 alphabet
 * (including `=`), and drop the bits left over after the last whole byte.
 */
function decodeBase32(text: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text.toUpperCase()) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) continue;
    buffer = ((buffer << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Generates the code the official Bitwarden SDK generates for the same stored key
 * (`Totp::from_str` and `decode_b32` in sdk-internal `crates/bitwarden-vault/src/totp.rs`).
 */
export function generateLocalTotp(
  input: unknown,
  options: LocalTotpOptions = {},
): BitwardenResult<LocalOtpValue> {
  let secret: Secret | undefined;
  let bytes: Uint8Array | undefined;
  try {
    // Bitwarden shows no code for an empty key; the length bound only guards memory.
    if (typeof input !== "string" || !input.length || input.length > 8192) {
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
    // Like the SDK, the whole key is lower-cased first, so prefixes and parameter names match in
    // any case. The host of an otpauth URI (`totp`, `hotp`, …) is ignored: every key is TOTP.
    const key = input.toLowerCase();
    let base32 = key;
    let algorithm = "SHA1";
    let digits = 6;
    let period = 30;
    let steam = false;
    if (key.startsWith("otpauth://")) {
      const uri = URL.parse(key);
      if (!uri) return failure("invalid-totp");
      // The last of repeated parameters wins; unknown parameters are ignored.
      const parameters = new Map(uri.searchParams);
      const secretParameter = parameters.get("secret");
      if (secretParameter === undefined) return failure("invalid-totp");
      base32 = secretParameter;
      algorithm = algorithms.get(parameters.get("algorithm") ?? "") ?? "SHA1";
      digits = Math.min(parseU32(parameters.get("digits")) ?? 6, 10);
      period = Math.max(parseU32(parameters.get("period")) ?? 30, 1);
    } else if (key.startsWith("steam://")) {
      steam = true;
      base32 = key.slice(8);
    }
    bytes = decodeBase32(base32);
    secret = new Secret({ buffer: bytes.buffer as ArrayBuffer });
    // Ten decimal digits preserve the whole 31-bit HOTP value; only rendering differs below.
    let binary = Number(
      HOTP.generate({
        secret,
        algorithm: steam ? "SHA1" : algorithm,
        digits: 10,
        counter: Math.floor(Math.floor(now / 1000) / period),
      }),
    );
    if (!Number.isSafeInteger(binary) || binary < 0 || binary > 2_147_483_647) {
      return failure("invalid-totp");
    }
    let value: string;
    if (steam) {
      value = "";
      for (let index = 0; index < 5; index += 1) {
        value += steamAlphabet[binary % steamAlphabet.length];
        binary = Math.floor(binary / steamAlphabet.length);
      }
    } else {
      // The SDK computes `10_u32.pow(digits)` in u32, which wraps for 10 digits.
      const modulus = Number(10n ** BigInt(digits) % 2n ** 32n);
      value = String(binary % modulus).padStart(digits, "0");
    }
    const validUntilMs = (Math.floor(now / (period * 1000)) + 1) * period * 1000;
    if (!Number.isSafeInteger(validUntilMs)) return failure("invalid-options");
    return { ok: true, data: { kind: "otp", value, validUntilMs, period } };
  } catch {
    return failure("invalid-totp");
  } finally {
    secret?.bytes.fill(0);
    bytes?.fill(0);
  }
}
