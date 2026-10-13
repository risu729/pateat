import { deleteDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountProfile,
  accountUserId,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import {
  createVaultDatabase,
  PROVIDER_SESSIONS_STORE,
  RECORDS_STORE,
  runVaultTransaction,
  type VaultStoreName,
} from "../vault/database";
import type { ProviderSessionEntry } from "./session-record";
import { createIndexedDbProviderSessionStore } from "./session-store";

// Runs in Chromium (vitest browser mode): the compare-and-swap reads the session and the
// vault record, writes and reads back inside one native transaction.
const open: { close(): void; databaseName: string }[] = [];
afterEach(async () => {
  const finished = open.splice(0);
  for (const entry of finished) entry.close();
  await Promise.all(finished.map((entry) => deleteDB(entry.databaseName)));
});

function setup() {
  const databaseName = `session-store-test-${crypto.randomUUID()}`;
  const database = createVaultDatabase({ databaseName });
  const store = createIndexedDbProviderSessionStore({ profile: accountProfile, databaseName });
  open.push({
    close() {
      store.close();
      database.close();
    },
    databaseName,
  });
  const raw = async (name: VaultStoreName, value: unknown) =>
    runVaultTransaction(
      await database.open(),
      name,
      "readwrite",
      database.timeout,
      async (stores, set) => {
        await stores(name).put(value, accountProfile.connectionId);
        set({ ok: true, data: true });
      },
    );
  return { store, raw };
}

const entry = (): ProviderSessionEntry => ({
  schemaVersion: 1,
  revision: crypto.randomUUID(),
  profile: accountProfile,
  binding: { userId: accountUserId, email: v1Email },
  encryptedAccount: {},
  state: "active",
  accessToken: "a.b.c",
  refreshToken: "synthetic-refresh",
  receivedAt: 1,
  expiresIn: 60,
});

describe("provider session store on native IndexedDB", () => {
  it("reads nothing, then writes, reads back and deletes the session", async () => {
    const { store } = setup();
    expect(await store.read()).toEqual({ ok: true, data: null });
    const first = entry();
    expect(await store.compareAndSwap(null, first)).toEqual({
      ok: true,
      data: { revision: first.revision },
    });
    expect(await store.read()).toEqual({ ok: true, data: first });
    expect(await store.compareAndSwap(first.revision, null)).toEqual({
      ok: true,
      data: { revision: null },
    });
    expect(await store.read()).toEqual({ ok: true, data: null });
  });

  it("replaces a session only from its current revision", async () => {
    const { store } = setup();
    const first = entry();
    const second = entry();
    await store.compareAndSwap(null, first);
    expect(await store.compareAndSwap(crypto.randomUUID(), second)).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(await store.read()).toEqual({ ok: true, data: first });
    expect(await store.compareAndSwap(first.revision, second)).toEqual({
      ok: true,
      data: { revision: second.revision },
    });
  });

  it("writes under a guard only while the vault record is active at that revision", async () => {
    const { store, raw } = setup();
    const cache = crypto.randomUUID();
    const guard = { cacheRevision: cache };
    const first = entry();
    const second = entry();
    await raw(RECORDS_STORE, { state: "active", revision: cache });
    expect(await store.compareAndSwap(null, first, guard)).toEqual({
      ok: true,
      data: { revision: first.revision },
    });
    expect(
      await store.compareAndSwap(first.revision, second, { cacheRevision: crypto.randomUUID() }),
    ).toEqual({ ok: false, error: { code: "storage-conflict" } });
    await raw(RECORDS_STORE, { state: "disabled", revision: cache });
    expect(await store.compareAndSwap(first.revision, second, guard)).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(await store.read()).toEqual({ ok: true, data: first });
    await raw(RECORDS_STORE, { state: "active", revision: cache });
    expect(await store.compareAndSwap(first.revision, second, guard)).toEqual({
      ok: true,
      data: { revision: second.revision },
    });
  });

  it("overwrites a corrupt session only when none is expected", async () => {
    const { store, raw } = setup();
    await raw(PROVIDER_SESSIONS_STORE, { schemaVersion: 1, state: "active", accessToken: "x" });
    expect(await store.read()).toEqual({ ok: false, error: { code: "invalid-cache-record" } });
    expect(await store.compareAndSwap(crypto.randomUUID(), entry())).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    expect(await store.compareAndSwap(crypto.randomUUID(), null)).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    expect(await store.read()).toEqual({ ok: false, error: { code: "invalid-cache-record" } });
    const replacement = entry();
    expect(await store.compareAndSwap(null, replacement)).toEqual({
      ok: true,
      data: { revision: replacement.revision },
    });
    expect(await store.read()).toEqual({ ok: true, data: replacement });
  });

  it("refuses a session stored for another connection", async () => {
    const { store, raw } = setup();
    await raw(PROVIDER_SESSIONS_STORE, {
      ...entry(),
      profile: { ...accountProfile, connectionId: crypto.randomUUID() },
    });
    expect(await store.read()).toEqual({ ok: false, error: { code: "account-mismatch" } });
  });
});
