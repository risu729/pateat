import { afterEach, describe, expect, it } from "vitest";
import { createCipheriv, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import {
  createLocalCryptoSession,
  type LocalCryptoSession,
  type LocalCryptoSdk,
} from "@pateat/bitwarden";
import {
  legacyCipher,
  legacyItemKey,
} from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { preparedVault } from "../../../../packages/bitwarden/src/__fixtures__/unlock";
import { describeSsoMethods, findSsoCandidates, type SsoWorkerState } from "./sso";
import { importDigestKey } from "./custom-digest";
import { toBase64Url } from "../passkeys/encoding";

const requireSdk = createRequire(
  new URL("../../../../packages/bitwarden/package.json", import.meta.url),
);
const sdk = requireSdk("@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js") as LocalCryptoSdk;

const sourceId = "a0000000-0000-4000-8000-000000000001";
const targetId = "a0000000-0000-4000-8000-000000000002";
const wrongId = "a0000000-0000-4000-8000-000000000003";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const fieldId = `custom.${snapshotId}.0`;
const sessions: LocalCryptoSession[] = [];
// Independent encryption of fictional plaintexts under the public upstream fixture key.
function encrypted(value: string, ivByte = 1) {
  const bytes = Buffer.from(legacyItemKey, "base64");
  const iv = Buffer.alloc(16, ivByte);
  const encryptor = createCipheriv("aes-256-cbc", bytes.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([encryptor.update(value, "utf8"), encryptor.final()]);
  const mac = createHmac("sha256", bytes.subarray(32))
    .update(Buffer.concat([iv, ciphertext]))
    .digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}
function cipher(
  id: string,
  username: string,
  fields: { name: string; value: string; type: number }[] = [],
  ivByte = 1,
) {
  return {
    ...legacyCipher(),
    id,
    name: encrypted("Synthetic SSO item", ivByte),
    login: {
      ...legacyCipher().login,
      username: encrypted(username, ivByte),
      password: encrypted("native-password", ivByte),
      uris: [{ uri: encrypted("https://idp.example.test/login", ivByte), match: 0 }],
    },
    fields: fields.map((field) => ({
      name: encrypted(field.name, ivByte),
      value: encrypted(field.value, ivByte),
      type: field.type,
      linkedId: null,
    })),
  };
}
async function nativeState(
  connectionId: string,
  ciphers: ReturnType<typeof cipher>[],
): Promise<SsoWorkerState> {
  const prepared = preparedVault();
  const opened = await createLocalCryptoSession(
    {
      connectionId,
      userId: prepared.binding.userId,
      email: prepared.binding.email,
      kdf: prepared.kdf,
      accountCryptographicState: prepared.accountCryptographicState,
      organizationKeys: prepared.organizationKeys,
      minimumSecurityVersion: prepared.minimumSecurityVersion,
      unlock: { kind: "decrypted-key", userKey: legacyItemKey },
    },
    sdk,
  );
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("Synthetic native SDK unlock refused");
  sessions.push(opened.data);
  const state: SsoWorkerState = {
    ref: {
      connectionId,
      userId: prepared.binding.userId,
      brokerGeneration: snapshotId,
      snapshotId,
      sessionId: crypto.randomUUID(),
    },
    session: opened.data,
    ciphers: new Map(ciphers.map((item) => [item.id, item])),
    loginUsernames: new Map(),
    loginUris: new Map(),
    unreadableFields: new Map(),
    uriContext: { defaultMatch: 0 },
  };
  for (const item of ciphers) {
    // oxlint-disable-next-line no-await-in-loop -- reproduce the Worker's sequential encrypted snapshot verification
    const decrypted = await opened.data.decryptCipher({ connectionId, cipher: item });
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) throw new Error("Synthetic native cipher refused");
    const login = decrypted.data.login;
    if (login?.username) state.loginUsernames.set(item.id, login.username.slice(0, 1024));
    state.loginUris.set(
      item.id,
      login?.uris?.map((entry) => ({ uri: entry.uri ?? null, match: entry.match ?? null })) ?? [],
    );
  }
  return state;
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

describe("SSO discovery with actual native encrypted synthetic items", () => {
  it("decrypts source methods and confirms only the exact username on another connection", async () => {
    const source = await nativeState("source", [
      cipher(sourceId, "site-user", [
        { name: "SSO", value: "[Arbitrary Label] PERSON@EXAMPLE.TEST", type: 1 },
      ]),
    ]);
    const target = await nativeState("idp", [
      cipher(targetId, " person@example.test "),
      cipher(wrongId, "site-user"),
    ]);
    const key = (await importDigestKey(toBase64Url(new Uint8Array(32).fill(7))))!;
    const described = await describeSsoMethods(
      source,
      { itemId: sourceId, allowedFieldIds: [fieldId] },
      key,
    );
    expect(described.result).toMatchObject({
      status: "ready",
      methods: [{ label: "Arbitrary Label", form: "bracket" }],
    });
    if (described.result.status !== "ready") throw new Error("Synthetic SSO method refused");
    const method = described.result.methods[0]!;
    const inputs = [targetId, wrongId].map((itemId) => ({
      itemId,
      allowedFieldIds: ["login.username"],
    }));
    expect(
      await findSsoCandidates(
        target,
        { usernameProof: method.usernameProof, candidates: inputs },
        key,
      ),
    ).toEqual({
      snapshotId,
      candidates: [{ itemId: targetId, origins: ["https://idp.example.test"] }],
    });
    const replacementKey = (await importDigestKey(toBase64Url(new Uint8Array(32).fill(8))))!;
    expect(
      await findSsoCandidates(
        target,
        { usernameProof: method.usernameProof, candidates: inputs },
        replacementKey,
      ),
    ).toEqual({ snapshotId, candidates: [] });
    const oldEvidence = described.sourceEvidence;
    source.ciphers.set(
      sourceId,
      cipher(
        sourceId,
        "site-user",
        [{ name: "SSO", value: "[Arbitrary Label] PERSON@EXAMPLE.TEST", type: 1 }],
        2,
      ),
    );
    const reencrypted = await describeSsoMethods(
      source,
      { itemId: sourceId, allowedFieldIds: [fieldId] },
      key,
    );
    expect(reencrypted.sourceEvidence).not.toBe(oldEvidence);
    expect(reencrypted.result).toEqual(described.result);
    expect(JSON.stringify([...source.ciphers.values()])).not.toContain("PERSON@EXAMPLE.TEST");
    expect(source.loginUsernames.get(sourceId)).toBe("site-user");
  });
  it("confirms the full native username after matching a truncated cache prefix", async () => {
    const prefix = "u".repeat(1024);
    const source = await nativeState("source", [
      cipher(sourceId, "site-user", [{ name: "SSO", value: `[Provider] ${prefix}`, type: 0 }]),
    ]);
    const target = await nativeState("idp", [cipher(targetId, `${prefix}different-account`)]);
    const key = (await importDigestKey(toBase64Url(new Uint8Array(32).fill(9))))!;
    const described = await describeSsoMethods(
      source,
      { itemId: sourceId, allowedFieldIds: [fieldId] },
      key,
    );
    if (described.result.status !== "ready") throw new Error("Synthetic source refused");
    expect(target.loginUsernames.get(targetId)).toBe(prefix);
    expect(
      await findSsoCandidates(
        target,
        {
          usernameProof: described.result.methods[0]!.usernameProof,
          candidates: [{ itemId: targetId, allowedFieldIds: ["login.username"] }],
        },
        key,
      ),
    ).toEqual({
      snapshotId,
      candidates: [{ itemId: targetId, origins: [], unavailable: "username-missing" }],
    });
  });
});
