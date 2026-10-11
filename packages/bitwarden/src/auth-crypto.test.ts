import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { derivePasswordAuthentication } from "./auth-crypto";
import { argon2Auth, authPassword, pbkdf2Auth } from "./__fixtures__/auth";

const connectionId = "synthetic-auth-a";
function input() {
  return {
    connectionId,
    email: pbkdf2Auth.salt,
    password: authPassword,
    prelogin: {
      mode: "legacy",
      response: { kdf: 0, kdfIterations: 100_000, kdfMemory: null, kdfParallelism: null },
    },
  };
}
function modern(response: unknown) {
  return { ...input(), prelogin: { mode: "password", response } };
}

afterEach(() => vi.restoreAllMocks());

describe("local password authentication known answers", () => {
  it.each(["test@bitwarden.com", "TEST@bitwarden.com", " test@bitwarden.com "])(
    "matches the official PBKDF2 server authorization answer for %s",
    async (email) => {
      expect(await derivePasswordAuthentication({ ...input(), email }, sdk)).toEqual({
        ok: true,
        data: { connectionId, masterPasswordHash: pbkdf2Auth.expected },
      });
    },
  );

  it("matches the official Argon2id server authorization answer using returned salt", async () => {
    expect(
      await derivePasswordAuthentication(
        modern({
          kdfSettings: { kdfType: 1, iterations: 4, memory: 32, parallelism: 2 },
          salt: argon2Auth.salt,
        }),
        sdk,
      ),
    ).toEqual({ ok: true, data: { connectionId, masterPasswordHash: argon2Auth.expected } });
  });

  it("derives from flat KDF fields and the email salt when password prelogin omits kdfSettings", async () => {
    expect(
      await derivePasswordAuthentication(
        modern({ kdf: 0, kdfIterations: 100_000, kdfMemory: null, kdfParallelism: null }),
        sdk,
      ),
    ).toEqual({ ok: true, data: { connectionId, masterPasswordHash: pbkdf2Auth.expected } });
    expect(
      await derivePasswordAuthentication(
        {
          ...modern({ kdf: 1, kdfIterations: 4, kdfMemory: 32, kdfParallelism: 2, salt: null }),
          email: argon2Auth.salt,
        },
        sdk,
      ),
    ).toEqual({ ok: true, data: { connectionId, masterPasswordHash: argon2Auth.expected } });
  });

  it("normalizes the explicit modern authentication salt independently of email", async () => {
    expect(
      await derivePasswordAuthentication(
        {
          ...modern({
            kdfSettings: { kdfType: 0, iterations: 100_000 },
            salt: "  TEST@bitwarden.com\t",
          }),
          email: "unrelated-vault-email@example.test",
        },
        sdk,
      ),
    ).toEqual({ ok: true, data: { connectionId, masterPasswordHash: pbkdf2Auth.expected } });
  });

  it("matches Rust whitespace trimming for U+0085 without removing U+FEFF", async () => {
    expect(
      await derivePasswordAuthentication(
        { ...input(), email: "\u0085TEST@bitwarden.com\u0085" },
        sdk,
      ),
    ).toEqual({
      ok: true,
      data: { connectionId, masterPasswordHash: pbkdf2Auth.expected },
    });
    const untrimmed = await derivePasswordAuthentication(
      { ...input(), email: "\uFEFFtest@bitwarden.com" },
      sdk,
    );
    expect(untrimmed.ok).toBe(true);
    if (untrimmed.ok) expect(untrimmed.data.masterPasswordHash).not.toBe(pbkdf2Auth.expected);
  });

  it.each([
    ["ΟΣ", "ος"],
    ["İ", "i\u0307"],
  ])("matches whole-string Unicode lowercase %s to %s", async (source, canonical) => {
    // Differential normalization checks with actual SDK KDF; these are not independent known answers.
    const response = (salt: string) =>
      modern({ kdfSettings: { kdfType: 0, iterations: 100_000 }, salt });
    const actual = await derivePasswordAuthentication(response(source), sdk);
    const equivalent = await derivePasswordAuthentication(response(canonical), sdk);
    expect(actual.ok).toBe(true);
    expect(actual).toEqual(equivalent);
  });

  it.each([{}, { salt: null }])(
    "uses the explicit modern missing-salt compatibility behavior %#",
    async (salt) => {
      expect(
        await derivePasswordAuthentication(
          modern({ kdfSettings: { kdfType: 0, iterations: 100_000 }, ...salt }),
          sdk,
        ),
      ).toEqual({ ok: true, data: { connectionId, masterPasswordHash: pbkdf2Auth.expected } });
    },
  );

  it("uses email for legacy prelogin even when an opaque salt field is returned", async () => {
    const original = input();
    expect(
      await derivePasswordAuthentication(
        {
          ...original,
          prelogin: {
            ...original.prelogin,
            response: { ...original.prelogin.response, salt: "different-auth-salt" },
          },
        },
        sdk,
      ),
    ).toEqual({ ok: true, data: { connectionId, masterPasswordHash: pbkdf2Auth.expected } });
  });

  it.each([" asdfasdf ", "ASDFASDF"])("preserves password bytes for %j", async (password) => {
    const result = await derivePasswordAuthentication({ ...input(), password }, sdk);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.masterPasswordHash).not.toBe(pbkdf2Auth.expected);
  });

  it("uses authentication KDF/salt and does not treat the hash as a V2 vault unlock", async () => {
    const result = await derivePasswordAuthentication(
      modern({
        kdfSettings: { kdfType: 1, iterations: 4, memory: 32, parallelism: 2 },
        salt: argon2Auth.salt,
      }),
      { PureCrypto: sdk.PureCrypto },
    );
    expect(result).toEqual({
      ok: true,
      data: { connectionId, masterPasswordHash: argon2Auth.expected },
    });
    if (result.ok)
      expect(Object.keys(result.data).sort()).toEqual(["connectionId", "masterPasswordHash"]);
    // V2 vault fixtures use a different unlock KDF (6/32/4). Authentication uses only prelogin.
    const unlockParameters = await derivePasswordAuthentication(
      modern({
        kdfSettings: { kdfType: 1, iterations: 6, memory: 32, parallelism: 4 },
        salt: argon2Auth.salt,
      }),
      sdk,
    );
    expect(unlockParameters.ok).toBe(true);
    if (unlockParameters.ok)
      expect(unlockParameters.data.masterPasswordHash).not.toBe(argon2Auth.expected);
  });
});

describe("local authentication admission and cancellation", () => {
  it.each([
    null,
    {},
    { ...input(), password: "" },
    { ...input(), connectionId: "" },
    { ...input(), unlockSalt: "must-not-be-used" },
    modern({ kdfSettings: { kdfType: 0, iterations: 100_000 }, salt: "" }),
    modern({ kdfSettings: { kdfType: 0, iterations: 100_000 }, salt: "   " }),
    modern({ kdfSettings: { kdfType: 1, iterations: 4, memory: 32 } }),
    modern({ kdfSettings: { kdfType: 0, iterations: 4999 } }),
    modern({ kdfSettings: { kdfType: 1, iterations: 1, memory: 32, parallelism: 2 } }),
    modern({ kdfSettings: { kdfType: 1, iterations: 4, memory: 15, parallelism: 2 } }),
    { ...input(), password: "\uD800" },
    { ...input(), password: "\uDC00" },
    { ...input(), email: "\uD800" },
    modern({ kdfSettings: { kdfType: 0, iterations: 100_000 }, salt: "\uD800" }),
    modern({ kdf: 0, kdfIterations: 4999 }),
    modern({ kdf: 1, kdfIterations: 4, kdfMemory: 32 }),
    modern({ salt: "synthetic" }),
  ])("rejects malformed authentication input before SDK derivation %#", async (request) => {
    const derive = vi.spyOn(sdk.PureCrypto, "derive_kdf_material");
    expect(await derivePasswordAuthentication(request, sdk)).toEqual({
      ok: false,
      error: { code: "invalid-crypto-input" },
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it.each([
    { kdfSettings: { kdfType: 0, iterations: 2_000_001 } },
    { kdfSettings: { kdfType: 1, iterations: 21, memory: 32, parallelism: 4 } },
    { kdfSettings: { kdfType: 1, iterations: 6, memory: 257, parallelism: 4 } },
    { kdfSettings: { kdfType: 1, iterations: 6, memory: 32, parallelism: 17 } },
  ])(
    "rejects excessive valid KDF resource parameters before SDK derivation %#",
    async (response) => {
      const derive = vi.spyOn(sdk.PureCrypto, "derive_kdf_material");
      expect(await derivePasswordAuthentication(modern(response), sdk)).toEqual({
        ok: false,
        error: { code: "resource-limit" },
      });
      expect(derive).not.toHaveBeenCalled();
    },
  );

  it("rejects opaque future KDF metadata without choosing a fallback", async () => {
    const derive = vi.spyOn(sdk.PureCrypto, "derive_kdf_material");
    expect(
      await derivePasswordAuthentication(
        modern({ kdfSettings: { kdfType: 99, iterations: 1 }, salt: "synthetic" }),
        sdk,
      ),
    ).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    expect(derive).not.toHaveBeenCalled();
  });

  it("honors an already cancelled request without entering native KDF", async () => {
    const controller = new AbortController();
    controller.abort("synthetic-secret-abort-reason");
    const derive = vi.spyOn(sdk.PureCrypto, "derive_kdf_material");
    expect(await derivePasswordAuthentication(input(), sdk, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(derive).not.toHaveBeenCalled();
  });

  it("withholds a native KDF result if cancellation occurs before it returns", async () => {
    const controller = new AbortController();
    const material = new Uint8Array(32).fill(42);
    const derive = vi.spyOn(sdk.PureCrypto, "derive_kdf_material").mockImplementation(() => {
      controller.abort("synthetic-secret-abort-reason");
      return material;
    });
    const webCrypto = vi.spyOn(globalThis.crypto.subtle, "deriveBits");
    expect(await derivePasswordAuthentication(input(), sdk, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(derive).toHaveBeenCalledTimes(1);
    expect(webCrypto).not.toHaveBeenCalled();
    expect(Array.from(material)).toEqual(Array(32).fill(0));
  });

  it("sanitizes a native failure and does not expose the supplied password or salt", async () => {
    vi.spyOn(sdk.PureCrypto, "derive_kdf_material").mockImplementation(() => {
      throw new Error("asdfasdf test@bitwarden.com synthetic-native-secret");
    });
    expect(await derivePasswordAuthentication(input(), sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it("withholds and wipes an asynchronous auth-hash result after cancellation", async () => {
    const controller = new AbortController();
    let entered = () => {};
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let complete = (_value: ArrayBuffer) => {};
    vi.spyOn(globalThis.crypto.subtle, "deriveBits").mockImplementation(() => {
      entered();
      return new Promise<ArrayBuffer>((resolve) => {
        complete = resolve;
      });
    });
    const pending = derivePasswordAuthentication(input(), sdk, controller.signal);
    await called;
    controller.abort("synthetic-secret-abort-reason");
    const hash = new Uint8Array(32).fill(42);
    complete(hash.buffer);
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(Array.from(hash)).toEqual(Array(32).fill(0));
  });

  it("withholds cancellation during importKey and wipes the retained input copy", async () => {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "PBKDF2", false, [
      "deriveBits",
    ]);
    const controller = new AbortController();
    let entered = () => {};
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let complete = (_value: CryptoKey) => {};
    let retained: Uint8Array | undefined;
    vi.spyOn(crypto.subtle, "importKey").mockImplementation((_format, keyData) => {
      if (keyData instanceof Uint8Array) retained = keyData;
      entered();
      return new Promise<CryptoKey>((resolve) => {
        complete = resolve;
      });
    });
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const pending = derivePasswordAuthentication(input(), sdk, controller.signal);
    await called;
    expect(retained?.byteLength).toBe(32);
    expect(retained?.some((byte) => byte !== 0)).toBe(true);
    controller.abort("synthetic-secret-cancel-reason");
    complete(key);
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(derive).not.toHaveBeenCalled();
    expect(Array.from(retained ?? [])).toEqual(Array(32).fill(0));
  });
});
