// Self-check of the Vaultwarden harness: what it seeds, Pateat's own Bitwarden package reads
// back from a real server over `http://localhost`. Synthetic accounts and items only.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  createBitwardenAccountMapper,
  createBitwardenTransport,
  createLocalCryptoSession,
  derivePasswordAuthentication,
  type BitwardenTransport,
} from "../../packages/bitwarden/src/index";
import { nodeSdk } from "../../packages/bitwarden/src/__fixtures__/node-sdk";
import { readTwoStepCode } from "./mailpit";
import {
  addImportedPasskeyLogin,
  addLogin,
  authenticatorCode,
  enableAuthenticator,
  enableEmailTwoStep,
  registerAccount,
  type SeededAccount,
} from "./seed";
import { startVaultwarden, type VaultwardenServer } from "./server";

let server: VaultwardenServer;
beforeAll(async () => {
  server = await startVaultwarden();
}, 200_000);
afterEach(async ({ task }) => {
  if (task.result?.state === "fail" && server) process.stderr.write(await server.logs());
});
afterAll(() => server?.stop());

// A fresh synthetic master password each run.
const password = `synthetic-${randomUUID()}`;
const sitePassword = `synthetic-site-${randomUUID()}`;
const passkeyPassword = `synthetic-passkey-${randomUUID()}`;
const connectionId = "synthetic-vaultwarden";
const device = { identifier: randomUUID(), name: "Pateat Vaultwarden self-check" };

function seedAccount() {
  return registerAccount(server.baseUrl, { email: `${randomUUID()}@example.test`, password });
}

function transportFor() {
  const profile = {
    connectionId,
    environment: { kind: "self-hosted", baseUrl: `http://localhost:${server.port}` },
  };
  const transport = createBitwardenTransport(profile);
  if (!transport.ok) throw new Error(`Transport refused: ${transport.error.code}`);
  return transport.data;
}

/** Setup's order: prelogin, local hash, then the password grant. */
async function passwordToken(
  transport: BitwardenTransport,
  account: SeededAccount,
  twoFactor?: { provider: 0 | 1; token: string },
) {
  const prelogin = await transport.prelogin({
    connectionId,
    email: account.email,
    mode: "password",
  });
  if (!prelogin.ok) throw new Error(`Prelogin failed: ${prelogin.error.code}`);
  const hash = await derivePasswordAuthentication(
    {
      connectionId,
      email: account.email,
      password,
      prelogin: { mode: "password", response: prelogin.data },
    },
    nodeSdk,
  );
  if (!hash.ok) throw new Error(`Hash failed: ${hash.error.code}`);
  expect(hash.data.masterPasswordHash).toBe(account.masterPasswordHash);
  const token = await transport.passwordToken({
    connectionId,
    email: account.email,
    masterPasswordHash: hash.data.masterPasswordHash,
    device,
    ...(twoFactor ? { twoFactor } : {}),
  });
  if (!token.ok) throw new Error(`Password grant failed: ${token.error.code}`);
  return token.data;
}

it("registers, signs in, syncs, maps and decrypts through Pateat's Bitwarden package", async () => {
  const account = await seedAccount();
  const plainId = await addLogin(account, {
    name: "Synthetic loopback site",
    username: "synthetic-user",
    password: sitePassword,
    uris: [{ uri: "http://localhost:3847/login" }],
  });
  const importedId = await addImportedPasskeyLogin(account, {
    name: "Synthetic imported passkey",
    username: "synthetic-passkey-user",
    password: passkeyPassword,
    uri: "https://passkey.example.test/",
    rpId: "passkey.example.test",
  });

  const transport = transportFor();
  const authenticated = await passwordToken(transport, account);
  if (authenticated.kind !== "authenticated") throw new Error(`Got ${authenticated.kind}`);
  const sync = await transport.sync({
    connectionId,
    accessToken: authenticated.tokens.accessToken,
  });
  if (!sync.ok) throw new Error(`Sync failed: ${sync.error.code}`);

  // Vaultwarden returns the stored login JSON verbatim, including the key Pateat does not read.
  const imported = sync.data.ciphers.find((cipher) => cipher["id"] === importedId);
  expect(imported?.["login"]).toMatchObject({ fido2Credentials: [{ response: null }] });

  const mapper = createBitwardenAccountMapper(transport.profile, {
    kind: "bootstrap",
    email: account.email,
  });
  if (!mapper.ok) throw new Error(`Mapper refused: ${mapper.error.code}`);
  const prepared = mapper.data.map({ connectionId, authenticated, sync: sync.data });
  if (!prepared.ok) throw new Error(`Mapping failed: ${prepared.error.code}`);
  expect(prepared.data.binding).toMatchObject({ userId: account.userId, accountVersion: "v1" });

  const session = await createLocalCryptoSession(
    {
      connectionId,
      userId: prepared.data.binding.userId,
      email: prepared.data.binding.email,
      kdf: prepared.data.kdf,
      accountCryptographicState: prepared.data.accountCryptographicState,
      organizationKeys: prepared.data.organizationKeys,
      minimumSecurityVersion: prepared.data.minimumSecurityVersion,
      unlock: {
        kind: "password",
        password,
        masterPasswordUnlock: prepared.data.masterPasswordUnlock,
      },
    },
    nodeSdk,
  );
  if (!session.ok) throw new Error(`Unlock failed: ${session.error.code}`);
  try {
    const cipher = prepared.data.ciphers.find((entry) => String(entry.id) === plainId);
    const decrypted = await session.data.decryptCipher({ connectionId, cipher });
    if (!decrypted.ok) throw new Error(`Decryption failed: ${decrypted.error.code}`);
    expect(decrypted.data.name).toBe("Synthetic loopback site");
    expect(decrypted.data.login).toMatchObject({
      username: "synthetic-user",
      password: sitePassword,
      uris: [{ uri: "http://localhost:3847/login" }],
    });
    // The imported item maps and its passkey decrypts without the key Pateat does not read.
    const passkey = prepared.data.ciphers.find((entry) => String(entry.id) === importedId);
    const credentials = await session.data.decryptFido2Credentials({
      connectionId,
      cipher: passkey,
    });
    if (!credentials.ok) throw new Error(`Passkey failed: ${credentials.error.code}`);
    expect(credentials.data).toHaveLength(1);
    expect(credentials.data[0]).toMatchObject({ rpId: "passkey.example.test" });
  } finally {
    session.data.dispose();
  }
});

it("asks for and accepts an authenticator code", async () => {
  const account = await seedAccount();
  const { secret } = await enableAuthenticator(account);
  const transport = transportFor();
  expect(await passwordToken(transport, account)).toMatchObject({
    kind: "mfa-required",
    providers: [0],
  });
  // Enabling used the current step; Vaultwarden takes the next one as clock drift.
  const token = authenticatorCode(secret, Date.now() + 30_000);
  expect(await passwordToken(transport, account, { provider: 0, token })).toMatchObject({
    kind: "authenticated",
  });
});

it("mails an email two-step code that signs in", async () => {
  const account = await seedAccount();
  await enableEmailTwoStep(account, server.mailpitUrl);
  const transport = transportFor();
  expect(await passwordToken(transport, account)).toMatchObject({
    kind: "mfa-required",
    providers: [1],
  });
  expect(
    await transport.sendEmailLoginCode({
      connectionId,
      email: account.email,
      masterPasswordHash: account.masterPasswordHash,
      deviceIdentifier: device.identifier,
    }),
  ).toEqual({ ok: true, data: { kind: "sent" } });
  const token = await readTwoStepCode(server.mailpitUrl, account.email);
  expect(token).toMatch(/^\d{6}$/);
  expect(await passwordToken(transport, account, { provider: 1, token })).toMatchObject({
    kind: "authenticated",
  });
});
