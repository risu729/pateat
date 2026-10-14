import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalFieldSnapshot } from "@pateat/bitwarden";
import type { HostCommand, HostSessionRef } from "./wire";

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(async ({ cipher }: { cipher: unknown }) => ({ ok: true as const, data: cipher })),
  snapshots: new Map<string, LocalFieldSnapshot[]>(),
}));

vi.mock("@pateat/bitwarden", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pateat/bitwarden")>();
  return {
    ...actual,
    createLocalCryptoSession: vi.fn(async () => ({
      ok: true,
      data: { metadata: { accountVersion: 1 }, decryptCipher: mocks.decrypt },
    })),
    createLocalFieldSnapshot: (input: unknown) => {
      const created = actual.createLocalFieldSnapshot(input);
      if (!created.ok) return created;
      const snapshot = { ...created.data, dispose: vi.fn(() => created.data.dispose()) };
      const itemId = (input as { item: { id: string } }).item.id;
      const instances = mocks.snapshots.get(itemId) ?? [];
      instances.push(snapshot);
      mocks.snapshots.set(itemId, instances);
      return { ok: true, data: snapshot };
    },
  };
});
vi.mock("@pateat/bitwarden/browser-sdk", () => ({
  loadBrowserCryptoSdk: async () => ({ init_sdk: vi.fn(), LogLevel: { Error: 1 } }),
}));

const generation = "30000000-0000-4000-8000-000000000001";
const connectionId = "synthetic-worker-cache";
const userId = "30000000-0000-4000-8000-000000000002";
const snapshotId = "30000000-0000-4000-8000-000000000003";
const itemId = (index: number) => `a0000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const worker = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage: vi.fn<(message: { result: unknown }) => void>(),
};
let session: HostSessionRef;

async function command(operation: HostCommand["operation"]) {
  const result = new Promise<unknown>((resolve) => {
    worker.postMessage.mockImplementationOnce((message) => resolve(message.result));
  });
  worker.onmessage?.({
    data: {
      version: 1,
      type: "crypto.command",
      generation,
      requestId: crypto.randomUUID(),
      connectionId,
      operation,
    },
  } as MessageEvent<unknown>);
  const received = await result;
  // The result arrives before the Worker's finally handler releases its busy flag.
  await Promise.resolve();
  await Promise.resolve();
  return received;
}

function resolve(index: number) {
  return command({
    kind: "resolve",
    session,
    ref: { connectionId, userId, snapshotId, itemId: itemId(index), fieldId: "login.password" },
    allowedFieldIds: ["login.password"],
  });
}

const resolved = (index: number) => ({
  ok: true,
  data: { kind: "text", value: `synthetic-password-${index}` },
});

function captured(index: number, instance = 0) {
  const snapshot = mocks.snapshots.get(itemId(index))?.[instance];
  if (!snapshot) throw new Error("No field snapshot was captured");
  return snapshot;
}

async function fillCache() {
  for (let index = 1; index <= 128; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    expect(await resolve(index)).toEqual(resolved(index));
  }
}

beforeEach(async () => {
  vi.resetModules();
  mocks.decrypt.mockClear();
  mocks.snapshots.clear();
  worker.postMessage.mockReset();
  worker.onmessage = null;
  vi.stubGlobal("self", worker);
  // The production Worker replaces logging and fetch; keep those changes in this test's globals.
  vi.stubGlobal("console", { ...console });
  vi.stubGlobal("fetch", globalThis.fetch);
  await import("./worker");
  const opened = await command({
    kind: "open",
    snapshotId,
    unlock: { kind: "decrypted-key", userKey: "synthetic-user-key" },
    prepared: {
      binding: { profile: { connectionId }, userId, accountVersion: 1 },
      coverage: "received-envelope",
      ciphers: Array.from({ length: 129 }, (_, index) => ({
        id: itemId(index + 1),
        type: 1,
        login: { password: `synthetic-password-${index + 1}` },
      })),
    },
  });
  expect(opened).toMatchObject({ ok: true });
  session = (opened as { data: { session: HostSessionRef } }).data.session;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crypto Worker decrypted field cache", () => {
  it("resolves a 129th item and disposes only the least recently used snapshot", async () => {
    await fillCache();
    expect(mocks.decrypt).toHaveBeenCalledTimes(128);
    for (const snapshots of mocks.snapshots.values())
      expect(snapshots[0]!.dispose).not.toHaveBeenCalled();

    expect(await resolve(129)).toEqual(resolved(129));
    expect(mocks.decrypt).toHaveBeenCalledTimes(129);
    expect(captured(1).dispose).toHaveBeenCalledOnce();
    expect(captured(1).list()).toEqual([]);
    for (let index = 2; index <= 129; index += 1)
      expect(captured(index).dispose).not.toHaveBeenCalled();
  });

  it.each(["list", "resolve"] as const)(
    "keeps a cached item accessed through %s and evicts the next oldest item",
    async (kind) => {
      await fillCache();
      if (kind === "list") {
        const listed = await command({ kind, session, itemId: itemId(1).toUpperCase() });
        expect(listed).toMatchObject({ ok: true, data: [{ ref: { itemId: itemId(1) } }] });
      } else expect(await resolve(1)).toEqual(resolved(1));
      expect(mocks.decrypt).toHaveBeenCalledTimes(128);

      expect(await resolve(129)).toEqual(resolved(129));
      expect(captured(1).dispose).not.toHaveBeenCalled();
      expect(captured(2).dispose).toHaveBeenCalledOnce();
      expect(await resolve(1)).toEqual(resolved(1));
      expect(mocks.decrypt).toHaveBeenCalledTimes(129);
    },
  );

  it("decrypts an evicted item again and keeps the cache bounded on the next eviction", async () => {
    await fillCache();
    expect(await resolve(129)).toEqual(resolved(129));
    expect(await resolve(1)).toEqual(resolved(1));

    expect(mocks.decrypt).toHaveBeenCalledTimes(130);
    expect(mocks.snapshots.get(itemId(1))).toHaveLength(2);
    expect(captured(1).dispose).toHaveBeenCalledOnce();
    expect(captured(2).dispose).toHaveBeenCalledOnce();
    expect(captured(1, 1).dispose).not.toHaveBeenCalled();
    expect(await resolve(1)).toEqual(resolved(1));
    expect(mocks.decrypt).toHaveBeenCalledTimes(130);
  });
});
