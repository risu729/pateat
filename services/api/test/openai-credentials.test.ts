import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CredentialStorageUnavailable,
  deleteOpenAICredential,
  openAICredentialState,
  resolveOpenAICredential,
  saveOpenAICredential,
} from "../src/openai/credentials";
import { providerUnavailable, resolveModelCredential } from "../src/claude/provider-credentials";

// Synthetic owner keys and encryption material only; these tests make no provider calls.
const SECRET = "synthetic-openai-credential-never-returned";
const configured = { ...env, INFERENCE_CREDENTIAL_KEY: "31".repeat(32) };

async function owner() {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(id, Date.now())
    .run();
  return id;
}

const stored = (ownerId: string) =>
  env.DB.prepare("SELECT * FROM openai_credentials WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ owner_id: string; nonce: string; ciphertext: string; updated_at: number }>();

describe("owner-bound OpenAI credential storage", () => {
  it("stores fresh ciphertext, returns only status and resolves only for its owner", async () => {
    const [alice, bob] = await Promise.all([owner(), owner()]);
    await saveOpenAICredential(configured, alice, `  ${SECRET}  `);
    const first = await stored(alice);
    expect(first).toMatchObject({ owner_id: alice, updated_at: expect.any(Number) });
    expect(Uint8Array.fromBase64(first!.nonce, { alphabet: "base64url" })).toHaveLength(12);
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(await openAICredentialState(configured, alice)).toEqual({
      version: 1,
      configured: true,
      storage: "ready",
      storedInvalid: false,
    });
    expect(await resolveOpenAICredential(configured, alice)).toEqual({
      status: "ready",
      credential: { apiKey: SECRET },
    });
    expect(await resolveOpenAICredential(configured, bob)).toEqual({ status: "not_configured" });
    await saveOpenAICredential(configured, alice, SECRET);
    const next = await stored(alice);
    expect(next!.nonce).not.toBe(first!.nonce);
    expect(next!.ciphertext).not.toBe(first!.ciphertext);
    expect(await resolveOpenAICredential(configured, alice)).toEqual({
      status: "ready",
      credential: { apiKey: SECRET },
    });
  });

  it("authenticates the owner ID even when another owner's entire ciphertext row is copied", async () => {
    const [alice, bob] = await Promise.all([owner(), owner()]);
    await saveOpenAICredential(configured, alice, SECRET);
    const row = await stored(alice);
    await env.DB.prepare(
      "INSERT INTO openai_credentials (owner_id, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(bob, row!.nonce, row!.ciphertext, row!.updated_at)
      .run();
    expect(await resolveOpenAICredential(configured, bob)).toEqual({ status: "unavailable" });
    expect(await openAICredentialState(configured, bob)).toEqual({
      version: 1,
      configured: true,
      storage: "ready",
      storedInvalid: true,
    });
    expect((await resolveOpenAICredential(configured, alice)).status).toBe("ready");
  });

  it.each([undefined, "", "not-hex", "ff".repeat(31), "gg".repeat(32)])(
    "fails closed with missing or invalid operator material %s",
    async (material) => {
      const id = await owner();
      const unavailable = {
        DB: env.DB,
        ...(material === undefined ? {} : { INFERENCE_CREDENTIAL_KEY: material }),
      };
      await expect(saveOpenAICredential(unavailable, id, SECRET)).rejects.toBeInstanceOf(
        CredentialStorageUnavailable,
      );
      expect(await stored(id)).toBeNull();
      await saveOpenAICredential(configured, id, SECRET);
      expect(await resolveOpenAICredential(unavailable, id)).toEqual({ status: "unavailable" });
      expect(await openAICredentialState(unavailable, id)).toEqual({
        version: 1,
        configured: true,
        storage: "unavailable",
        storedInvalid: false,
      });
      await deleteOpenAICredential(unavailable, id);
      expect(await stored(id)).toBeNull();
    },
  );

  it.each(["nonce", "ciphertext"] as const)(
    "refuses damaged %s without returning it",
    async (column) => {
      const id = await owner();
      await saveOpenAICredential(configured, id, SECRET);
      await env.DB.prepare(`UPDATE openai_credentials SET ${column} = ? WHERE owner_id = ?`)
        .bind("AA", id)
        .run();
      expect(await resolveOpenAICredential(configured, id)).toEqual({ status: "unavailable" });
      const state = await openAICredentialState(configured, id);
      expect(state.storedInvalid).toBe(true);
      expect(JSON.stringify(state)).not.toContain(SECRET);
    },
  );

  it("requires replacement after encryption-key rotation and can remove a damaged record", async () => {
    const [alice, bob] = await Promise.all([owner(), owner()]);
    await saveOpenAICredential(configured, alice, SECRET);
    await saveOpenAICredential(configured, bob, "synthetic-bob-key");
    const rotated = { ...env, INFERENCE_CREDENTIAL_KEY: "72".repeat(32) };
    expect(await resolveOpenAICredential(rotated, alice)).toEqual({ status: "unavailable" });
    expect((await openAICredentialState(rotated, alice)).storedInvalid).toBe(true);
    await saveOpenAICredential(rotated, alice, "synthetic-replacement-key");
    expect(await resolveOpenAICredential(rotated, alice)).toEqual({
      status: "ready",
      credential: { apiKey: "synthetic-replacement-key" },
    });
    expect(await resolveOpenAICredential(configured, alice)).toEqual({ status: "unavailable" });
    await deleteOpenAICredential(rotated, bob);
    expect((await resolveOpenAICredential(rotated, bob)).status).toBe("not_configured");
    expect((await resolveOpenAICredential(rotated, alice)).status).toBe("ready");
  });

  it("maps provider readiness independently of Anthropic and fails closed after corruption", async () => {
    const id = await owner();
    expect(await providerUnavailable(configured, id, "openai")).toBe("credentials-not-configured");
    expect(await resolveModelCredential(configured, id, "openai")).toEqual({
      status: "unavailable",
      reason: "credentials-not-configured",
    });
    await saveOpenAICredential(configured, id, SECRET);
    expect(await providerUnavailable(configured, id, "openai")).toBeUndefined();
    expect(await providerUnavailable(configured, id, "anthropic")).toBe(
      "credentials-not-configured",
    );
    expect(await resolveModelCredential(configured, id, "openai")).toEqual({
      status: "ready",
      credential: { apiKey: SECRET },
    });
    const bad = { ...configured, INFERENCE_CREDENTIAL_KEY: "73".repeat(32) };
    expect(await providerUnavailable(bad, id, "openai")).toBe("credentials-unavailable");
    expect(await resolveModelCredential(bad, id, "openai")).toEqual({
      status: "unavailable",
      reason: "credentials-unavailable",
    });
  });
});
