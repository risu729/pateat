import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalFieldSnapshot } from "@pateat/bitwarden";
import type { HostCommand, HostSessionRef } from "./wire";

type CapturedSnapshot = LocalFieldSnapshot & { dispose: ReturnType<typeof vi.fn> };

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(async ({ cipher }: { cipher: unknown }) => ({
    ok: true as const,
    data: cipher as unknown,
  })),
  snapshots: new Map<string, CapturedSnapshot[]>(),
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
const connectionId = "synthetic-worker-fields";
const userId = "30000000-0000-4000-8000-000000000002";
const snapshotId = "30000000-0000-4000-8000-000000000003";
const otherSnapshotId = "30000000-0000-4000-8000-000000000004";
const itemId = (index: number) => `a0000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const loginCount = 129;
// Received but not readable as fields: an unsupported item type and a login without its login.
const unsupportedIndex = 130;
const invalidIndex = 131;
const unknownIndex = 999;
const worker = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage: vi.fn<(message: { result: unknown }) => void>(),
};
let session: HostSessionRef;
/** Snapshots still holding a decrypted item at the moment each reply was posted. */
let undisposedAtReply: number[];

const allSnapshots = () => [...mocks.snapshots.values()].flat();

async function command(operation: HostCommand["operation"]) {
  const result = new Promise<unknown>((receiveResult) => {
    worker.postMessage.mockImplementationOnce((message) => {
      undisposedAtReply.push(
        allSnapshots().filter((snapshot) => snapshot.dispose.mock.calls.length === 0).length,
      );
      receiveResult(message.result);
    });
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

function resolve(
  index: number,
  {
    fieldId = "login.password",
    allowedFieldIds = ["login.password"],
    refSnapshotId = snapshotId,
  }: { fieldId?: string; allowedFieldIds?: string[]; refSnapshotId?: string } = {},
) {
  return command({
    kind: "resolve",
    session,
    ref: { connectionId, userId, snapshotId: refSnapshotId, itemId: itemId(index), fieldId },
    allowedFieldIds,
  });
}

const list = (index: number) => command({ kind: "list", session, itemId: itemId(index) });

const resolved = (index: number) => ({
  ok: true,
  data: { kind: "text", value: `synthetic-password-${index}` },
});

const failed = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });

function captured(index: number, instance = 0) {
  const snapshot = mocks.snapshots.get(itemId(index))?.[instance];
  if (!snapshot) throw new Error("No field snapshot was captured");
  return snapshot;
}

function expectEverySnapshotDisposedOnce() {
  for (const snapshot of allSnapshots()) {
    expect(snapshot.dispose).toHaveBeenCalledOnce();
    expect(snapshot.list()).toEqual([]);
  }
  expect(undisposedAtReply.every((count) => count === 0)).toBe(true);
}

beforeEach(async () => {
  vi.resetModules();
  mocks.decrypt.mockClear();
  mocks.snapshots.clear();
  undisposedAtReply = [];
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
      ciphers: [
        ...Array.from({ length: loginCount }, (_, index) => ({
          id: itemId(index + 1),
          type: 1,
          login: { password: `synthetic-password-${index + 1}` },
        })),
        { id: itemId(unsupportedIndex), type: 5 },
        { id: itemId(invalidIndex), type: 1 },
      ],
    },
  } as HostCommand["operation"]);
  expect(opened).toMatchObject({ ok: true });
  session = (opened as { data: { session: HostSessionRef } }).data.session;
  mocks.decrypt.mockClear();
  undisposedAtReply = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crypto Worker field requests", () => {
  it("decrypts once per resolve and disposes the snapshot before replying", async () => {
    expect(await resolve(1)).toEqual(resolved(1));

    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(mocks.snapshots.get(itemId(1))).toHaveLength(1);
    expect(captured(1).dispose).toHaveBeenCalledOnce();
    expect(captured(1).list()).toEqual([]);
    expect(
      captured(1).resolve(
        { connectionId, userId, snapshotId, itemId: itemId(1), fieldId: "login.password" },
        { allowedFieldIds: ["login.password"] },
      ),
    ).toEqual(failed("crypto-locked"));
    expect(undisposedAtReply).toEqual([0]);
  });

  it("decrypts the same item again for every request instead of keeping a copy", async () => {
    expect(await resolve(1)).toEqual(resolved(1));
    expect(await resolve(1)).toEqual(resolved(1));
    expect(await list(1)).toMatchObject({ ok: true });

    expect(mocks.decrypt).toHaveBeenCalledTimes(3);
    expect(mocks.snapshots.get(itemId(1))).toHaveLength(3);
    expectEverySnapshotDisposedOnce();
  });

  it("resolves every received item with no limit on how many items a session reads", async () => {
    for (let index = 1; index <= loginCount; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await resolve(index)).toEqual(resolved(index));
    }
    // Reading the first item again after all others still answers from a fresh decryption.
    expect(await resolve(1)).toEqual(resolved(1));

    expect(mocks.decrypt).toHaveBeenCalledTimes(loginCount + 1);
    expect(allSnapshots()).toHaveLength(loginCount + 1);
    expectEverySnapshotDisposedOnce();
  });

  it("replies to a list with the field metadata although its snapshot is disposed", async () => {
    // Item identifiers match case-insensitively.
    const listed = await command({ kind: "list", session, itemId: itemId(1).toUpperCase() });

    expect(listed).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          ref: { connectionId, userId, snapshotId, itemId: itemId(1), fieldId: "login.password" },
          kind: "hidden",
        }),
        expect.objectContaining({
          ref: expect.objectContaining({ fieldId: "login.username" }),
          empty: true,
        }),
      ]),
    });
    expect(JSON.stringify(listed)).not.toContain("synthetic-password-1");
    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(captured(1).dispose).toHaveBeenCalledOnce();
    expect(captured(1).list()).toEqual([]);
    expect(undisposedAtReply).toEqual([0]);
  });

  it.each(["list", "resolve"] as const)(
    "returns a decrypt failure from %s as-is without creating a snapshot",
    async (kind) => {
      const failure = { ok: false as const, error: { code: "crypto-failed" as const } };
      mocks.decrypt.mockResolvedValueOnce(failure as never);

      expect(await (kind === "list" ? list(1) : resolve(1))).toEqual(failure);
      expect(mocks.decrypt).toHaveBeenCalledOnce();
      expect(allSnapshots()).toEqual([]);
    },
  );

  it.each([
    ["an unsupported item type", unsupportedIndex, "unsupported-field"],
    ["an invalid item", invalidIndex, "invalid-field-input"],
  ])("returns the snapshot failure for %s", async (_name, index, code) => {
    expect(await list(index)).toEqual(failed(code));
    expect(await resolve(index)).toEqual(failed(code));

    expect(mocks.decrypt).toHaveBeenCalledTimes(2);
    expect(allSnapshots()).toEqual([]);
  });

  it.each([
    ["a field outside the allowlist", { allowedFieldIds: ["login.username"] }, "field-denied"],
    [
      "a reference to another snapshot",
      { refSnapshotId: otherSnapshotId },
      "stale-field-reference",
    ],
    [
      "a custom field the item lacks",
      { fieldId: `custom.${snapshotId}.0`, allowedFieldIds: [`custom.${snapshotId}.0`] },
      "stale-field-reference",
    ],
    [
      "an empty field",
      { fieldId: "login.username", allowedFieldIds: ["login.username"] },
      "field-missing",
    ],
  ])("disposes the snapshot when resolving %s fails", async (_name, options, code) => {
    expect(await resolve(1, options)).toEqual(failed(code));

    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(mocks.snapshots.get(itemId(1))).toHaveLength(1);
    expectEverySnapshotDisposedOnce();
  });

  it.each(["list", "resolve"] as const)(
    "answers %s for an unknown item with field-missing without decrypting",
    async (kind) => {
      expect(await (kind === "list" ? list(unknownIndex) : resolve(unknownIndex))).toEqual(
        failed("field-missing"),
      );
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(allSnapshots()).toEqual([]);
    },
  );
});
