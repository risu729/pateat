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

/** Base32 characters with optional `=` padding, in either case. */
const base32Key = /^[a-z2-7]+=*$/iu;
/**
 * The fewest Base32 characters a bare or `steam://` key must have: 80 bits, RFC 4226's
 * minimum.
 */
const minimumKeyLength = 16;

/**
 * Whether a bare key looks like a Base32 TOTP secret: Base32 letters and digits 2-7, the
 * letters all upper or all lower case, with at least one letter and at least one digit;
 * either unbroken or in groups of four separated by single spaces (the last group may be
 * shorter); up to six `=` of padding at the end; and at least 16 Base32 characters.
 *
 * The digit keeps words and passphrases (`correcthorsebatterystaple`, `this goes very
 * fast`) out. It also leaves out a random key that happens to have no digit: 3.6% of
 * 16-character keys and 0.13% of 32-character ones. Such a key still makes codes from the
 * built-in TOTP field or as an `otpauth://` URI.
 */
function isBareBase32Key(key: string): boolean {
  const body = key.replace(/=+$/u, "");
  if (key.length - body.length > 6) return false;
  const groups = body.split(" ");
  if (
    groups.some((group) => !/^[a-z2-7]+$/iu.test(group)) ||
    (groups.length > 1 &&
      (groups.slice(0, -1).some((group) => group.length !== 4) || groups.at(-1)!.length > 4))
  )
    return false;
  const characters = groups.join("");
  return (
    characters.length >= minimumKeyLength &&
    /[a-z]/iu.test(characters) &&
    /[2-7]/u.test(characters) &&
    (characters === characters.toUpperCase() || characters === characters.toLowerCase())
  );
}

/**
 * Whether a stored value is shaped like a TOTP key, so a custom field holding it is used
 * only for codes (ADR 0027, owner 2026-10-23). `generateLocalTotp` reads almost any string
 * as the official SDK does, so this check is stricter. After surrounding whitespace is
 * trimmed, the value must be at most 8192 characters and one of:
 *
 * - an `otpauth://totp/` or `otpauth://hotp/` URI (any case) that parses as a URL and whose
 *   last `secret` parameter holds at least one Base32 character and only Base32
 *   characters, spaces and trailing `=`;
 * - `steam://` (any case) followed by at least 16 Base32 characters and optional trailing
 *   `=`;
 * - a bare Base32 key as `isBareBase32Key` describes it, with at least one digit 2-7.
 *
 * So words and passphrases, sentences, PINs, digits alone and short codes are not keys.
 */
export function isTotpSeed(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!key.length || key.length > 8192) return false;
  const lower = key.toLowerCase();
  if (lower.startsWith("otpauth://totp/") || lower.startsWith("otpauth://hotp/")) {
    const secret = URL.parse(key)?.searchParams.getAll("secret").at(-1);
    return secret !== undefined && base32Key.test(secret.replaceAll(" ", ""));
  }
  if (lower.startsWith("steam://")) {
    const steam = key.slice(8);
    return base32Key.test(steam) && steam.replace(/=+$/u, "").length >= minimumKeyLength;
  }
  return isBareBase32Key(key);
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
