import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";
import type { LocalCryptoSdk } from "./local-crypto";
import { parsePreloginResponse } from "./models";

// UTF-8 strings accepted by Rust cannot contain lone UTF-16 surrogates. The Unicode
// regex treats valid surrogate pairs as a single scalar outside this range.
const wellFormed = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
const requestSchema = v.strictObject({
  connectionId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  email: v.pipe(v.string(), v.minLength(1), v.maxLength(320), v.check(wellFormed)),
  password: v.pipe(v.string(), v.minLength(1), v.check(wellFormed)),
  prelogin: v.strictObject({
    mode: v.picklist(["legacy", "password"]),
    response: v.unknown(),
  }),
});

/** SDK MasterKey::derive uses Rust Unicode White_Space trim and contextual lowercase. */
function normalizeSalt(value: string) {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").toLowerCase();
}

/** Local server-authorization hash only. Authentication KDF/salt is independent of unlock. */
export async function derivePasswordAuthentication(
  input: unknown,
  sdk: Pick<LocalCryptoSdk, "PureCrypto">,
  signal?: AbortSignal,
): Promise<BitwardenResult<{ connectionId: string; masterPasswordHash: string }>> {
  const parsed = v.safeParse(requestSchema, input);
  if (!parsed.success || (signal !== undefined && !(signal instanceof AbortSignal)))
    return failure("invalid-crypto-input");
  if (signal?.aborted) return failure("cancelled");
  const { connectionId, email, password, prelogin } = parsed.output;
  const response = parsePreloginResponse(prelogin.response, prelogin.mode);
  if (!response) return failure("invalid-crypto-input");
  if (response.salt != null && !wellFormed(response.salt)) return failure("invalid-crypto-input");
  const settings = prelogin.mode === "password" ? response.kdfSettings : undefined;
  const type = settings?.kdfType ?? response.kdf;
  const iterations = settings?.iterations ?? response.kdfIterations;
  const memory = settings?.memory ?? response.kdfMemory;
  const parallelism = settings?.parallelism ?? response.kdfParallelism;
  if (type !== 0 && type !== 1) return failure("unsupported-crypto");
  if (iterations == null) return failure("invalid-crypto-input");
  if (type === 0 && iterations < 5000) return failure("invalid-crypto-input");
  if (type === 1 && (memory == null || parallelism == null || memory < 16 || iterations < 2))
    return failure("invalid-crypto-input");
  if (
    (type === 0 && iterations > 2_000_000) ||
    (type === 1 && (iterations > 20 || memory! > 256 || parallelism! > 16))
  )
    return failure("resource-limit");
  // PM-28143: modern prelogin currently permits absent/null salt, but never an empty salt.
  const salt = normalizeSalt(prelogin.mode === "password" ? (response.salt ?? email) : email);
  if (!salt) return failure("invalid-crypto-input");
  const passwordBytes = new TextEncoder().encode(password);
  const saltBytes = new TextEncoder().encode(salt);
  let masterBytes: Uint8Array | undefined;
  let importBytes: Uint8Array<ArrayBuffer> | undefined;
  let hashBytes: Uint8Array | undefined;
  try {
    const kdf =
      type === 0
        ? { pBKDF2: { iterations } }
        : { argon2id: { iterations, memory: memory!, parallelism: parallelism! } };
    masterBytes = sdk.PureCrypto.derive_kdf_material(passwordBytes, saltBytes, kdf);
    if (!(masterBytes instanceof Uint8Array) || masterBytes.byteLength !== 32)
      return failure("crypto-failed");
    if (signal?.aborted) return failure("cancelled");
    // SDK's public raw KDF enforces >=5000 PBKDF2 rounds. This protocol step is exactly one.
    importBytes = new Uint8Array(masterBytes);
    const key = await crypto.subtle.importKey("raw", importBytes, "PBKDF2", false, ["deriveBits"]);
    if (signal?.aborted) return failure("cancelled");
    hashBytes = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", iterations: 1, salt: passwordBytes },
        key,
        256,
      ),
    );
    if (signal?.aborted) return failure("cancelled");
    if (hashBytes.byteLength !== 32) return failure("crypto-failed");
    return {
      ok: true,
      data: { connectionId, masterPasswordHash: btoa(String.fromCharCode(...hashBytes)) },
    };
  } catch {
    return failure(signal?.aborted ? "cancelled" : "crypto-failed");
  } finally {
    passwordBytes.fill(0);
    saltBytes.fill(0);
    masterBytes?.fill(0);
    importBytes?.fill(0);
    hashBytes?.fill(0);
    // CryptoKey, strings and native copies are not synchronously zeroizable. Host Worker
    // termination supplies the hard cancellation/lifetime boundary for this operation.
  }
}
