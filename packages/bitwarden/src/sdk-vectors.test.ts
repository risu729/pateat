import { describe, expect, it } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { argon2Expected, kdfPassword, kdfSalt, pbkdf2Expected } from "./__fixtures__/crypto";

const encode = (value: string) => new TextEncoder().encode(value);

sdk.init_sdk(sdk.LogLevel.Error, sdk.LogLevel.Error, 0);

describe("published SDK independent known answers", () => {
  it("derives the pinned PBKDF2 SHA256 vector", () => {
    const derived = sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), {
      pBKDF2: { iterations: 10_000 },
    });
    expect(Array.from(derived)).toEqual(pbkdf2Expected);
  });

  it("derives the pinned Argon2id vector with SHA256 salt preprocessing", () => {
    const derived = sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), {
      argon2id: { iterations: 4, memory: 32, parallelism: 2 },
    });
    expect(Array.from(derived)).toEqual(argon2Expected);
  });

  it.each([
    { pBKDF2: { iterations: 4_999 } },
    { argon2id: { iterations: 1, memory: 16, parallelism: 1 } },
    { argon2id: { iterations: 2, memory: 15, parallelism: 1 } },
  ])("rejects the upstream unsafe KDF minimum %j", (kdf) => {
    expect(() =>
      sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), kdf),
    ).toThrow();
  });
});
