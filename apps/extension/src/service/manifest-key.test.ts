import { describe, expect, it } from "vitest";
import { PATEAT_EXTENSION_ID } from "@pateat/contracts";
import { MANIFEST_KEY } from "../../manifest-key";

describe("manifest key", () => {
  const bytes = Uint8Array.from(atob(MANIFEST_KEY), (character) => character.charCodeAt(0));

  it("is an RSA public key", async () => {
    const key = await crypto.subtle.importKey(
      "spki",
      bytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"],
    );
    expect(key.type).toBe("public");
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
  });

  it("derives the committed extension ID as Chrome does", async () => {
    // Chrome takes the first 128 bits of the key's SHA-256 and writes each hex digit as
    // a letter from a to p.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const id = [...digest.subarray(0, 16)]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join("");
    expect(id).toBe(PATEAT_EXTENSION_ID);
  });
});
