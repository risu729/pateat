import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTRIES_STORE, META_STORE, TIME_INDEX, openDiagnosticsDatabase } from "./database";
import { createLogger, type LogEntry } from "./log";
import { entrySchema } from "./log-fields";
import { createPseudonyms } from "./pseudonym";

// Keep the real validator; count how often each stored row is admitted for a snapshot.
vi.mock("valibot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("valibot")>();
  return { ...actual, safeParse: vi.fn(actual.safeParse) };
});
afterEach(() => vi.restoreAllMocks());
const AT = Date.UTC(2026, 9, 11, 10, 35);
const HOUR = 60 * 60_000;
const valid: LogEntry[] = [
  {
    time: AT - 24 * HOUR - 1,
    level: "error",
    event: "error.unhandled",
    fields: { source: "rejection", name: "TypeError" },
  },
  {
    time: AT - 24 * HOUR,
    level: "warn",
    event: "login.attempt",
    fields: {
      origin: "https://private.example",
      recipe: "private-recipe",
      state: "blocked",
      outcome: "structural-mismatch",
      email: "synthetic@example.test",
      ignored: "診断用",
    },
  },
  {
    time: AT - 2 * HOUR,
    level: "info",
    event: "runtime.updated",
    fields: { previousBuild: "9cf8356", build: "1c42ad3", version: "0.1.0" },
  },
  {
    time: AT - HOUR,
    level: "info",
    event: "recipe.generate",
    fields: { outcome: "skipped", reason: "text-answer" },
  },
  {
    time: AT - 30 * 60_000,
    level: "info",
    event: "passkey.request",
    fields: { origin: "https://private.example", outcome: "delegate", reason: "no-credential" },
  },
  {
    time: AT - 1,
    level: "error",
    event: "error.unhandled",
    fields: { source: "rejection", name: "TypeError" },
  },
];
const expectedRecent = {
  problems: [
    "2026-10-11T10:34Z error error.unhandled rejection TypeError",
    "2026-10-10T10:35Z warn login.attempt site-1 recipe-1 blocked structural-mismatch",
  ],
  updated: { time: AT - 2 * HOUR, from: "9cf8356" },
  passkeyDelegations: [{ reason: "no-credential", count: 1 }],
  unsentVerifications: [{ reason: "text-answer", count: 1 }],
};
async function seeded(deadline: unknown = AT + 1_000) {
  const databaseName = `snapshot-test-${crypto.randomUUID()}`;
  const db = await openDiagnosticsDatabase(databaseName);
  const write = db.transaction([ENTRIES_STORE, META_STORE], "readwrite");
  // Deliberately out of order: the time index determines the admitted order.
  for (const entry of [...valid].reverse()) void write.objectStore(ENTRIES_STORE).add(entry);
  void write
    .objectStore(ENTRIES_STORE)
    .add({ time: AT - 2, level: "fatal", event: "error.unhandled", fields: {} });
  void write
    .objectStore(ENTRIES_STORE)
    .add({ time: AT - 3, level: "error", event: "error.unhandled", fields: { name: null } });
  void write.objectStore(META_STORE).put(deadline, "debug-until");
  await write.done;
  db.close();
  return {
    databaseName,
    pseudonym: createPseudonyms({ databaseName }),
    knownSites: async () => ({ origins: new Set<string>(), hosts: [] }),
    build: { version: "0.1.0", revision: "1c42ad3" },
    debugStaysOn: false,
  };
}

describe("the diagnostics logger's single snapshot", () => {
  it("reads and validates rows once for exact summary and redacted recent output at the same 24-hour boundary", async () => {
    const deps = await seeded();
    const now = vi
      .fn()
      .mockReturnValueOnce(AT)
      .mockReturnValue(AT + 1);
    const native = IDBIndex.prototype.getAll;
    const reads = vi.fn();
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (
      this: IDBIndex,
      ...args: Parameters<typeof native>
    ) {
      if (this.name === TIME_INDEX && this.objectStore.name === ENTRIES_STORE) reads();
      return native.apply(this, args);
    });
    vi.mocked(v.safeParse).mockClear();
    const snapshot = await createLogger({ ...deps, now }).snapshot();
    expect(reads).toHaveBeenCalledOnce();
    expect(
      vi.mocked(v.safeParse).mock.calls.filter(([schema]) => schema === entrySchema),
    ).toHaveLength(8);
    expect(now).toHaveBeenCalledOnce();
    expect(snapshot.summary).toEqual({
      entries: 6,
      bytes: 876,
      recentErrors: 1,
      recentWarnings: 1,
      debugUntil: AT + 1_000,
    });
    expect(snapshot.recent).toEqual(expectedRecent);
    for (const hidden of ["private.example", "private-recipe", "synthetic@example.test", "診断用"])
      expect(JSON.stringify(snapshot.recent)).not.toContain(hidden);
  });

  it.each([AT, AT - 1, "corrupt-deadline"])(
    "keeps both projections while debug metadata is expired or malformed: %s",
    async (deadline) => {
      const snapshot = await createLogger({
        ...(await seeded(deadline)),
        now: () => AT,
      }).snapshot();
      expect(snapshot.summary).toMatchObject({ entries: 6, recentErrors: 1, recentWarnings: 1 });
      expect(snapshot.summary).not.toHaveProperty("debugUntil");
      expect(snapshot.recent).toEqual(expectedRecent);
    },
  );

  it("keeps admitted rows and recent lines when the debug metadata read fails", async () => {
    const deps = await seeded();
    const native = IDBObjectStore.prototype.get;
    const failed = vi.fn();
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      if (this.name === META_STORE && key === "debug-until") {
        failed();
        throw new DOMException("Synthetic metadata read failure", "UnknownError");
      }
      return native.call(this, key);
    });
    const snapshot = await createLogger({ ...deps, now: () => AT }).snapshot();
    expect(failed).toHaveBeenCalledOnce();
    // debugDeadline treats failed metadata as off; it does not discard the entry snapshot.
    expect(snapshot.summary).toMatchObject({ entries: 6, recentErrors: 1, recentWarnings: 1 });
    expect(snapshot.summary).not.toHaveProperty("debugUntil");
    expect(snapshot.recent).toEqual(expectedRecent);
  });

  it("rejects the snapshot if its entries cannot be read", async () => {
    const deps = await seeded();
    const native = IDBIndex.prototype.getAll;
    vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (
      this: IDBIndex,
      ...args: Parameters<typeof native>
    ) {
      if (this.name === TIME_INDEX && this.objectStore.name === ENTRIES_STORE)
        throw new DOMException("Synthetic entry read failure", "UnknownError");
      return native.apply(this, args);
    });
    await expect(createLogger({ ...deps, now: () => AT }).snapshot()).rejects.toThrow(
      "Synthetic entry read failure",
    );
  });
});
