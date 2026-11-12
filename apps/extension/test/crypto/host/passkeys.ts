import { expect, it } from "vitest";
import { accountUserId } from "../../../../../packages/bitwarden/src/__fixtures__/account";
import type { CryptoHostTestContext } from "./context";

export function registerPasskeysCases({
  harness,
  snapshotId,
  itemId,
  connectionId,
  storedPasskey,
  signInput,
  passkeySignature,
  passkeyMatches,
}: Pick<
  CryptoHostTestContext,
  | "harness"
  | "snapshotId"
  | "itemId"
  | "connectionId"
  | "storedPasskey"
  | "signInput"
  | "passkeySignature"
  | "passkeyMatches"
>) {
  it("finds snapshot-bound passkey metadata by RP ID and signs by item ID inside the Worker", async () => {
    const h = harness();
    const session = await h.open();
    const found = h.host.findPasskeys(session, "example.com");
    const finding = await h.command(1);
    expect(finding.operation).toEqual({ kind: "passkey-find", session, rpId: "example.com" });
    h.reply(finding, { ok: true, data: passkeyMatches });
    expect(await found).toEqual({ ok: true, data: passkeyMatches });
    const signed = h.host.signPasskey(session, signInput);
    const signing = await h.command(2);
    expect(signing.operation).toEqual({ kind: "passkey-sign", session, ...signInput });
    h.reply(signing, { ok: true, data: passkeySignature });
    expect(await signed).toEqual({ ok: true, data: passkeySignature });
  });

  it("lists one item's passkey RP IDs inside the Worker and checks the reply's scope (ADR 0084)", async () => {
    const h = harness();
    const session = await h.open();
    const rpIds = {
      connectionId,
      userId: accountUserId,
      snapshotId,
      itemId,
      rpIds: ["openai.com"],
    };
    const listing = h.host.passkeyRpIds(session, itemId.toUpperCase());
    const command = await h.command(1);
    expect(command.operation).toEqual({
      kind: "passkey-rp-ids",
      session,
      itemId: itemId.toUpperCase(),
    });
    h.reply(command, { ok: true, data: rpIds });
    expect(await listing).toEqual({ ok: true, data: rpIds });
    expect(h.commands).toHaveLength(2);
  });

  it.each([
    { itemId: crypto.randomUUID() },
    { snapshotId: crypto.randomUUID() },
    { rpIds: ["openai.com", "openai.com"] },
    { rpIds: ["x".repeat(254)] },
    { keyValue: "synthetic-key" },
  ])(
    "locks the session on a passkey RP ID reply for another scope or shape case %#",
    async (change) => {
      const h = harness();
      const session = await h.open();
      const pending = h.host.passkeyRpIds(session, itemId);
      h.reply(await h.command(1), {
        ok: true,
        data: { connectionId, userId: accountUserId, snapshotId, itemId, rpIds: [], ...change },
      });
      expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    },
  );

  it("sends a master password check to the session's Worker and returns its answer", async () => {
    const h = harness();
    const session = await h.open();
    const checked = h.host.verifyMasterPassword(session, "synthetic-guess");
    const checking = await h.command(1);
    expect(checking.operation).toEqual({
      kind: "verify-password",
      session,
      password: "synthetic-guess",
    });
    h.reply(checking, { ok: true, data: { matches: false } });
    expect(await checked).toEqual({ ok: true, data: { matches: false } });
  });

  it.each([{ matches: "yes" }, { matches: true, userKey: "synthetic-key" }, null])(
    "locks the session on a master password check reply of another shape case %#",
    async (data) => {
      const h = harness();
      const session = await h.open();
      const pending = h.host.verifyMasterPassword(session, "synthetic-guess");
      h.reply(await h.command(1), { ok: true, data });
      expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
      expect(await h.host.catalog(session)).toEqual({
        ok: false,
        error: { code: "crypto-locked" },
      });
    },
  );

  it("forwards a per-item passkey failure without locking the session", async () => {
    const h = harness();
    const session = await h.open();
    const signed = h.host.signPasskey(session, signInput);
    h.reply(await h.command(1), { ok: false, error: { code: "unsupported-crypto" } });
    expect(await signed).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    const empty = { ...passkeyMatches, candidates: [], unavailableItemIds: [] };
    const found = h.host.findPasskeys(session, "example.com");
    h.reply(await h.command(2), { ok: true, data: empty });
    expect(await found).toEqual({ ok: true, data: empty });
  });

  it.each([
    { kind: "find", data: { ...passkeyMatches, snapshotId: crypto.randomUUID() } },
    { kind: "find", data: { ...passkeyMatches, rpId: "example.net" } },
    {
      kind: "find",
      data: { ...passkeyMatches, candidates: [{ ...storedPasskey, userId: crypto.randomUUID() }] },
    },
    {
      kind: "find",
      data: { ...passkeyMatches, candidates: [{ ...storedPasskey, rpId: "example.net" }] },
    },
    { kind: "find", data: { ...passkeyMatches, candidates: [storedPasskey, storedPasskey] } },
    {
      kind: "find",
      data: { ...passkeyMatches, unavailableItemIds: [storedPasskey.itemId.toUpperCase()] },
    },
    {
      kind: "find",
      data: { ...passkeyMatches, unavailableItemIds: [itemId, itemId.toUpperCase()] },
    },
    {
      kind: "find",
      data: { ...passkeyMatches, candidates: [{ ...storedPasskey, keyValue: "synthetic-key" }] },
    },
    { kind: "sign", data: { ...passkeySignature, userId: crypto.randomUUID() } },
    { kind: "sign", data: { ...passkeySignature, snapshotId: crypto.randomUUID() } },
    { kind: "sign", data: { ...passkeySignature, itemId: crypto.randomUUID() } },
    { kind: "sign", data: { ...passkeySignature, credentialId: "AQID" } },
    { kind: "sign", data: { ...passkeySignature, signature: "MAYC" } },
    { kind: "sign", data: { ...passkeySignature, privateKey: "synthetic-key" } },
  ])("locks the session on a passkey reply for another scope or shape case %#", async (reply) => {
    const h = harness();
    const session = await h.open();
    const pending =
      reply.kind === "find"
        ? h.host.findPasskeys(session, "example.com")
        : h.host.signPasskey(session, signInput);
    h.reply(await h.command(1), { ok: true, data: reply.data });
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
    expect(await h.host.catalog(session)).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });

  it.each([
    { ...signInput, authenticatorData: "A".repeat(49) },
    { ...signInput, clientDataHash: "B".repeat(42) + "=" },
    { ...signInput, credentialId: "" },
    { ...signInput, rpId: "x".repeat(254) },
  ])("rejects a malformed signing request before dispatch case %#", async (input) => {
    const h = harness();
    const session = await h.open();
    expect(await h.host.signPasskey(session, input)).toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(h.commands).toHaveLength(1);
  });

  it("lock immediately invalidates access and withholds a pending plaintext reply", async () => {
    const h = harness({ timeoutMs: 200 });
    const session = await h.open();
    const decrypting = h.host.decryptCipher(session, itemId);
    const decrypt = await h.command(1);
    const locking = h.host.lock(session);
    const lock = await h.command(2);
    expect(await h.host.listFields(session, itemId)).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    h.reply(decrypt, { ok: true, data: { login: { password: "late-synthetic-secret" } } });
    expect(await decrypting).toEqual({ ok: false, error: { code: "crypto-locked" } });
    h.reply(lock, { ok: true, data: null });
    expect(await locking).toMatchObject({ ok: true });
  });
}
