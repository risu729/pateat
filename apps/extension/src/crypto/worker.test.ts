import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalFieldSnapshot } from "@pateat/bitwarden";
import type { HostCommand, HostSessionRef } from "./wire";

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(async ({ cipher }: { cipher: unknown }) => ({ ok: true as const, data: cipher })),
  snapshots: new Map<string, LocalFieldSnapshot[]>(),
  // Unless a test answers, every Regex URI stays unevaluated, as when no Worker can start.
  regexRun: vi.fn(async (_patterns: readonly string[], _url: string) => new Map<string, boolean>()),
}));

vi.mock("./regex", () => ({ createRegexRunner: () => ({ run: mocks.regexRun }) }));

vi.mock("@pateat/bitwarden", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pateat/bitwarden")>();
  return {
    ...actual,
    createLocalCryptoSession: vi.fn(async () => ({
      ok: true,
      data: {
        metadata: { accountVersion: 1 },
        decryptCipher: mocks.decrypt,
        decryptCatalogGroups: async () => ({ ok: true, data: [] }),
      },
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
/** The first items' saved URIs: Domain, Host and StartsWith rules, then unevaluable ones. */
const savedUris = [
  [{ uri: "https://router.example", match: 0 }],
  [{ uri: "http://router.example", match: 0 }],
  [{ uri: "router.example", match: 1 }],
  [{ uri: "HTTP://router.example", match: 1 }],
  [
    { uri: "https://router.example/login", match: 2 },
    { uri: "http://router.example/login", match: 2 },
  ],
  [{ uri: "https://router.example", match: 4 }],
  [{ uri: "http://router.example", match: 4 }],
];

async function command(operation: HostCommand["operation"]) {
  const result = new Promise<unknown>((receiveResult) => {
    worker.postMessage.mockImplementationOnce((message) => receiveResult(message.result));
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

/** Loads a fresh Worker module and opens 129 items, the first with `uris`' rules. */
async function openWorker(
  uris: readonly (readonly { uri: string | null; match: number | null }[])[] = savedUris,
  defaultMatch = 0,
) {
  vi.resetModules();
  mocks.snapshots.clear();
  worker.onmessage = null;
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
        name: `Synthetic item ${index + 1}`,
        collectionIds: [],
        login: { password: `synthetic-password-${index + 1}`, uris: uris[index] ?? [] },
      })),
      uriMatchContext: { equivalentDomains: [], defaultMatch },
    },
  });
  expect(opened).toMatchObject({ ok: true });
  session = (opened as { data: { session: HostSessionRef } }).data.session;
}

beforeEach(async () => {
  mocks.decrypt.mockClear();
  mocks.regexRun.mockReset();
  mocks.regexRun.mockImplementation(async () => new Map());
  worker.postMessage.mockReset();
  vi.stubGlobal("self", worker);
  // The production Worker replaces logging and fetch; keep those changes in this test's globals.
  vi.stubGlobal("console", { ...console });
  vi.stubGlobal("fetch", globalThis.fetch);
  await openWorker();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("crypto Worker URI matching on plain HTTP pages (ADR 0050)", () => {
  const candidates = async (targetUrl: string) => {
    const verified = await command({ kind: "verify-received-ciphers", session });
    expect(verified).toMatchObject({ ok: true });
    const result = (await command({ kind: "match-uris", session, targetUrl })) as {
      data: { candidates: { itemId: string }[]; unavailableUris: { itemId: string }[] };
    };
    return {
      items: result.data.candidates.map((entry) => entry.itemId),
      unavailable: result.data.unavailableUris.map((entry) => entry.itemId),
    };
  };

  it("matches every saved scheme on an HTTPS page", async () => {
    expect(await candidates("https://router.example/login")).toEqual({
      items: [itemId(1), itemId(2), itemId(3), itemId(4), itemId(5)],
      unavailable: [itemId(6), itemId(7)],
    });
  });

  it("matches only URIs saved with http:// on an HTTP page, in every mode", async () => {
    expect(await candidates("http://router.example/login")).toEqual({
      items: [itemId(2), itemId(4), itemId(5)],
      unavailable: [itemId(7)],
    });
  });

  it("matches a page URL longer than a saved URI may be", async () => {
    const long = `https://router.example/login?SAMLRequest=${"a".repeat(8200)}`;
    expect((await candidates(long)).items).toEqual([
      itemId(1),
      itemId(2),
      itemId(3),
      itemId(4),
      itemId(5),
    ]);
  });
});

describe("crypto Worker Regex URIs (ADR 0056)", () => {
  type Candidates = {
    candidates: { itemId: string; matches: { uriIndex: number; match: number }[] }[];
    unavailableUris: { itemId: string; uriIndex: number; reason: string }[];
    unavailableItemIds: string[];
  };
  const match = async (targetUrl: string) => {
    expect(await command({ kind: "verify-received-ciphers", session })).toMatchObject({ ok: true });
    const result = (await command({ kind: "match-uris", session, targetUrl })) as {
      ok: boolean;
      data: Candidates;
    };
    expect(result.ok).toBe(true);
    const { candidates, unavailableUris, unavailableItemIds } = result.data;
    return { candidates, unavailableUris, unavailableItemIds };
  };
  /** Answers as the Regex Worker would, with the pinned clients' RegExp. */
  const answerAll = () =>
    mocks.regexRun.mockImplementation(
      async (patterns, url) =>
        new Map(patterns.map((pattern) => [pattern, new RegExp(pattern, "i").test(url)])),
    );

  it("reports every Regex URI unevaluated when the Regex Worker gives no answer", async () => {
    expect(await match("https://router.example/login")).toMatchObject({
      unavailableUris: [
        { itemId: itemId(6), uriIndex: 0, reason: "regex-unevaluated" },
        { itemId: itemId(7), uriIndex: 0, reason: "regex-unevaluated" },
      ],
    });
    expect(mocks.regexRun).toHaveBeenCalledExactlyOnceWith(
      ["https://router.example", "http://router.example"],
      "https://router.example/login",
    );
  });

  it("makes an item whose Regex URI matches a candidate with match 4", async () => {
    answerAll();
    expect(await match("https://router.example/login")).toEqual({
      candidates: [1, 2, 3, 4, 5]
        .map((index) => expect.objectContaining({ itemId: itemId(index) }))
        .concat([{ itemId: itemId(6), matches: [{ uriIndex: 0, match: 4 }] }]),
      // `http://router.example` does not match an https: URL: a result, not unavailable.
      unavailableUris: [],
      unavailableItemIds: [],
    });
    expect(mocks.regexRun).toHaveBeenCalledOnce();
  });

  it("on an http: page sends only patterns saved with http:// (ADR 0050)", async () => {
    answerAll();
    const result = await match("http://router.example/login");
    expect(result.candidates.map((entry) => entry.itemId)).toEqual([
      itemId(2),
      itemId(4),
      itemId(5),
      itemId(7),
    ]);
    expect(result.candidates.at(-1)).toEqual({
      itemId: itemId(7),
      matches: [{ uriIndex: 0, match: 4 }],
    });
    expect(result.unavailableUris).toEqual([]);
    expect(mocks.regexRun).toHaveBeenCalledExactlyOnceWith(
      ["http://router.example"],
      "http://router.example/login",
    );
  });

  it("on an http: page neither sends nor waits for a Regex URI without http://", async () => {
    await openWorker([
      [{ uri: "https://router.example", match: 4 }],
      [{ uri: "^http://router\\.example", match: 4 }],
      [{ uri: "router.example", match: 4 }],
    ]);
    answerAll();
    expect(await match("http://router.example/login")).toEqual({
      candidates: [],
      unavailableUris: [],
      unavailableItemIds: [],
    });
    expect(mocks.regexRun).not.toHaveBeenCalled();
  });

  it("runs each pattern once for all items and keeps the URI order", async () => {
    await openWorker([
      [
        { uri: "^https://router\\.example/", match: 4 },
        { uri: "https://other.example", match: 0 },
        { uri: "^https://router\\.example/", match: 4 },
      ],
      [
        { uri: "login$", match: 4 },
        { uri: "^https://router\\.example/", match: 4 },
      ],
      [{ uri: "login$", match: 4 }],
      [{ uri: "^https://elsewhere\\.example/", match: 4 }],
    ]);
    answerAll();
    expect(await match("https://router.example/login")).toEqual({
      candidates: [
        {
          itemId: itemId(1),
          matches: [
            { uriIndex: 0, match: 4 },
            { uriIndex: 2, match: 4 },
          ],
        },
        {
          itemId: itemId(2),
          matches: [
            { uriIndex: 0, match: 4 },
            { uriIndex: 1, match: 4 },
          ],
        },
        { itemId: itemId(3), matches: [{ uriIndex: 0, match: 4 }] },
      ],
      unavailableUris: [],
      unavailableItemIds: [],
    });
    expect(mocks.regexRun).toHaveBeenCalledExactlyOnceWith(
      ["^https://router\\.example/", "login$", "^https://elsewhere\\.example/"],
      "https://router.example/login",
    );
  });

  it("keeps a pattern the Regex Worker did not answer unevaluated", async () => {
    await openWorker([
      [{ uri: "login$", match: 4 }],
      [
        { uri: "(a+)+$", match: 4 },
        { uri: "https://router.example", match: 0 },
      ],
    ]);
    mocks.regexRun.mockImplementation(async () => new Map([["login$", true]]));
    expect(await match("https://router.example/login")).toEqual({
      candidates: [
        { itemId: itemId(1), matches: [{ uriIndex: 0, match: 4 }] },
        { itemId: itemId(2), matches: [{ uriIndex: 1, match: 0 }] },
      ],
      unavailableUris: [{ itemId: itemId(2), uriIndex: 0, reason: "regex-unevaluated" }],
      unavailableItemIds: [],
    });
  });

  it("uses a retained Regex default for a URI saved without a mode", async () => {
    await openWorker([[{ uri: "^https://router\\.example/login$", match: null }]], 4);
    answerAll();
    expect((await match("https://router.example/login")).candidates).toEqual([
      { itemId: itemId(1), matches: [{ uriIndex: 0, match: 4 }] },
    ]);
    expect((await match("https://router.example/other")).candidates).toEqual([]);
    // Each command asks again; the Regex runner alone remembers slow patterns.
    expect(mocks.regexRun).toHaveBeenCalledTimes(2);
  });

  it("does not start the Regex runner without a Regex URI", async () => {
    await openWorker(savedUris.slice(0, 5));
    expect((await match("https://router.example/login")).candidates).toHaveLength(5);
    expect(mocks.regexRun).not.toHaveBeenCalled();
  });
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
        expect(listed).toMatchObject({
          ok: true,
          data: expect.arrayContaining([
            expect.objectContaining({
              ref: {
                connectionId,
                userId,
                snapshotId,
                itemId: itemId(1),
                fieldId: "login.password",
              },
            }),
          ]),
        });
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
