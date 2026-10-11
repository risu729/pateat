import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsLog } from "./background";
import {
  DEBUG_LOGGING_MS,
  LOG_RETENTION_MS,
  PAGE_EVENTS_PER_MINUTE,
  TRUNCATED,
  createLogger,
  formatLogExport,
  stackPositions,
  type KnownSites,
  type LogEntry,
  type LoggerDependencies,
} from "./log";
import { createPseudonyms } from "./pseudonym";

// Runs in Chromium (vitest browser mode) for IndexedDB and WebCrypto.
const NOW = Date.UTC(2026, 9, 11, 10, 35);
const EXTENSION = "abcdefghijklmnopabcdefghijklmnop";
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function setup(overrides: Partial<LoggerDependencies> = {}) {
  const databaseName = `log-test-${crypto.randomUUID()}`;
  let now = NOW;
  const pseudonym = createPseudonyms({ databaseName });
  const known: KnownSites = {
    origins: new Set(["https://bank.example"]),
    hosts: [{ hostname: "excluded.example", includeSubdomains: true }],
  };
  const deps: LoggerDependencies = {
    databaseName,
    pseudonym,
    knownSites: async () => known,
    build: { version: "0.1.0", revision: "1c42ad3" },
    now: () => now,
    console: quiet,
    ...overrides,
  };
  return {
    deps,
    logger: createLogger(deps),
    pseudonym,
    advance: (ms: number) => (now += ms),
  };
}

describe("diagnostics log", () => {
  it("keeps only allowlisted fields and names only configured sites", async () => {
    const { logger } = setup();
    await logger.log("passkey.request", {
      origin: "https://bank.example",
      rpId: "bank.example",
      outcome: "delegate",
      reason: "ambiguous-credential",
      stored: 3,
      complete: true,
      // Not in the allowlist.
      ...({ credentialId: "AQID", email: "owner@example.com" } as object),
    });
    await logger.log("passkey.request", {
      origin: "https://shop.example",
      rpId: "shop.example",
      outcome: "assertion",
    });
    await logger.log("login.refused", {
      origin: "https://login.excluded.example",
      reason: "site-excluded",
    });
    await logger.log("vault.state", {
      connection: "c0a3f8e2-raw-connection-id",
      state: "ready",
      // A field failing its kind's check is left out.
      providerSession: "Owner's session token",
    });
    await logger.log("login.refused", { origin: "https://bank.example", reason: "x".repeat(600) });
    const entries = await logger.entries();
    expect(entries.map((entry) => entry.fields)).toEqual([
      {
        origin: "https://bank.example",
        rpId: "bank.example",
        outcome: "delegate",
        reason: "ambiguous-credential",
        stored: 3,
        complete: true,
      },
      {
        origin: expect.stringMatching(/^origin:[0-9a-f]{8}$/u),
        rpId: expect.stringMatching(/^rp:[0-9a-f]{8}$/u),
        outcome: "assertion",
      },
      { origin: "https://login.excluded.example", reason: "site-excluded" },
      { connection: expect.stringMatching(/^bitwarden:[0-9a-f]{6}$/u), state: "ready" },
      { origin: "https://bank.example", reason: TRUNCATED },
    ]);
    const serialized = JSON.stringify(entries);
    for (const secret of [
      "AQID",
      "owner@example.com",
      "shop.example",
      "c0a3f8e2-raw-connection-id",
      "session token",
    ])
      expect(serialized).not.toContain(secret);
    expect(entries[0]).toMatchObject({ time: NOW, level: "info", event: "passkey.request" });
  });

  it("records debug entries only while debug logging is on, across workers", async () => {
    const { logger, deps, advance } = setup();
    await logger.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect(await logger.entries()).toEqual([]);
    expect(await logger.enableDebug()).toBe(NOW + DEBUG_LOGGING_MS);
    const restarted = createLogger(deps);
    await restarted.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect((await restarted.entries()).map((entry) => entry.event)).toEqual([
      "log.debug",
      "service.sync",
    ]);
    expect((await restarted.summary()).debugUntil).toBe(NOW + DEBUG_LOGGING_MS);
    advance(DEBUG_LOGGING_MS);
    await restarted.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect(await restarted.entries()).toHaveLength(2);
    expect((await restarted.summary()).debugUntil).toBeUndefined();
  });

  it("limits page-caused events per tab and origin and counts the rest", async () => {
    const { logger, advance } = setup();
    const source = { tabId: 4, origin: "https://bank.example" };
    for (let index = 0; index < PAGE_EVENTS_PER_MINUTE + 5; index += 1)
      void logger.log(
        "login.refused",
        { origin: source.origin, reason: "origin-busy" },
        { source },
      );
    // Another tab has its own allowance.
    await logger.log(
      "login.refused",
      { origin: source.origin, reason: "origin-busy" },
      { source: { ...source, tabId: 5 } },
    );
    // The first drop is logged at once, in case the worker stops before the window ends.
    const first = await logger.entries();
    expect(first).toHaveLength(PAGE_EVENTS_PER_MINUTE + 2);
    expect(
      first.filter((entry) => entry.event === "log.dropped").map((entry) => entry.fields),
    ).toEqual([{ origin: source.origin, count: 1 }]);
    advance(60_000);
    await logger.log("login.refused", { origin: source.origin, reason: "tab-busy" }, { source });
    const entries = await logger.entries();
    expect(entries.slice(-2).map((entry) => [entry.event, entry.fields])).toEqual([
      ["log.dropped", { origin: source.origin, count: 4 }],
      ["login.refused", { origin: source.origin, reason: "tab-busy" }],
    ]);
  });

  it("prunes by age, then debug and info before warnings, each within its allowance", async () => {
    const { logger, advance } = setup({
      limits: { entries: 3, problems: 2, pruneEvery: 1_000 },
    });
    await logger.enableDebug();
    await logger.log("service.sync", { outcome: "rejected" }, { level: "warn" });
    advance(LOG_RETENTION_MS);
    await logger.enableDebug();
    for (const level of ["debug", "debug", "info", "info", "warn", "error", "warn"] as const) {
      advance(1_000);
      // oxlint-disable-next-line no-await-in-loop -- entries keep their order
      await logger.log("service.sync", { outcome: "synced" }, { level });
    }
    await logger.prune();
    const levels = (await logger.entries()).map((entry) => `${entry.event}:${entry.level}`);
    // The 14-day-old entries are gone; two debug entries went before any info entry, and
    // the oldest warning made room within its own allowance.
    expect(levels).toEqual([
      "log.debug:info",
      "service.sync:info",
      "service.sync:info",
      "service.sync:error",
      "service.sync:warn",
    ]);
    advance(DEBUG_LOGGING_MS + 1);
    await logger.log("service.sync", { outcome: "synced" }, { level: "info" });
    await logger.prune();
    expect((await logger.entries()).map((entry) => entry.event)).not.toContain("log.debug");
    expect(await logger.entries()).toHaveLength(5);
  });

  it("expires debug entries after 24 hours", async () => {
    const { logger, advance } = setup();
    await logger.enableDebug();
    await logger.log("service.sync", { outcome: "synced" }, { level: "debug" });
    await logger.log("service.sync", { outcome: "rejected" }, { level: "warn" });
    advance(DEBUG_LOGGING_MS + 1);
    await logger.prune();
    expect((await logger.entries()).map((entry) => entry.level)).toEqual(["info", "warn"]);
  });

  it("keeps the pseudonym key of a version 1 database and adds the log store", async () => {
    const databaseName = `log-test-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(databaseName, 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("meta");
      opening.onsuccess = () => {
        opening.result.close();
        resolve();
      };
      opening.onerror = () => reject(new Error("open failed"));
    });
    // Stores the key in the version 1 layout, as the diagnostics page did before logs.
    const before = await createPseudonyms({ databaseName })("connection", "one", 6);
    const { logger } = setup({ databaseName, pseudonym: createPseudonyms({ databaseName }) });
    await logger.log("vault.state", { connection: "one", state: "ready" });
    expect((await logger.entries())[0]?.fields["connection"]).toBe(`bitwarden:${before}`);
  });

  it("logs an update when the build revision changes", async () => {
    const { deps } = setup();
    await createLogger(deps).started();
    const updated = createLogger({ ...deps, build: { version: "0.1.0", revision: "9f8e7d6" } });
    await updated.started();
    expect((await updated.entries()).map((entry) => [entry.event, entry.fields])).toEqual([
      ["runtime.updated", { previousBuild: "1c42ad3", build: "9f8e7d6", version: "0.1.0" }],
    ]);
  });

  it("clearing deletes every entry and starts a new pseudonym key", async () => {
    const { logger } = setup();
    await logger.log("vault.state", { connection: "one", state: "ready" });
    const before = (await logger.entries())[0]?.fields["connection"];
    await logger.clear();
    expect(await logger.entries()).toEqual([]);
    await logger.log("vault.state", { connection: "one", state: "ready" });
    const after = (await logger.entries())[0]?.fields["connection"];
    expect(after).toMatch(/^bitwarden:[0-9a-f]{6}$/u);
    expect(after).not.toBe(before);
  });

  it("summarizes the size and the errors of the last 24 hours", async () => {
    const { logger, advance } = setup();
    await logger.log("error.unhandled", { name: "TypeError" });
    advance(25 * 60 * 60 * 1000);
    await logger.log("error.unhandled", { name: "TypeError" });
    await logger.log("service.sync", { outcome: "rejected" }, { level: "warn" });
    const summary = await logger.summary();
    expect(summary).toMatchObject({ entries: 3, recentErrors: 1 });
    expect(summary.bytes).toBeGreaterThan(0);
  });
});

describe("log export", () => {
  const entries: LogEntry[] = [
    {
      time: NOW,
      level: "info",
      event: "login.attempt",
      fields: { origin: "https://bank.example", recipe: "bank-signin", state: "authenticated" },
    },
    {
      time: NOW + 1_000,
      level: "info",
      event: "passkey.request",
      fields: { origin: "origin:7d2b91aa", rpId: "bank.example", outcome: "assertion" },
    },
    {
      time: NOW + 2_000,
      level: "info",
      event: "login.attempt",
      fields: { origin: "https://bank.example", recipe: "bank-signin", state: "blocked" },
    },
  ];
  const context = { version: "0.1.0", revision: "1c42ad3", exportedAt: NOW + 60_000 };

  it("numbers sites and recipes within one export unless they are included", () => {
    const lines = formatLogExport(entries, { ...context, includeSites: false })
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({
      pateat: "0.1.0",
      revision: "1c42ad3",
      exportedAt: "2026-10-11T10:36:00.000Z",
      sites: "replaced",
      entries: 3,
    });
    expect(lines.slice(1)).toEqual([
      {
        time: "2026-10-11T10:35:00.000Z",
        level: "info",
        event: "login.attempt",
        origin: "site-1",
        recipe: "recipe-1",
        state: "authenticated",
      },
      {
        time: "2026-10-11T10:35:01.000Z",
        level: "info",
        event: "passkey.request",
        origin: "site-2",
        rpId: "site-1",
        outcome: "assertion",
      },
      {
        time: "2026-10-11T10:35:02.000Z",
        level: "info",
        event: "login.attempt",
        origin: "site-1",
        recipe: "recipe-1",
        state: "blocked",
      },
    ]);
    const included = formatLogExport(entries, { ...context, includeSites: true });
    expect(included).toContain('"origin":"https://bank.example"');
    expect(included).toContain('"recipe":"bank-signin"');
  });

  it("leaves out a stored field that is not allowlisted or fails its check", () => {
    const text = formatLogExport(
      [
        {
          time: NOW,
          level: "info",
          event: "login.refused",
          fields: { origin: "https://bank.example/path?token=x", reason: "x", email: "a@b" },
        },
      ],
      { ...context, includeSites: true },
    );
    expect(text).not.toContain("token");
    expect(text).not.toContain("a@b");
    expect(text).toContain('"reason":"x"');
  });
});

describe("unhandled errors", () => {
  it("keep the class name, extension positions and only Pateat's own codes", async () => {
    const listeners = new Map<string, (event: Event) => void>();
    const databaseName = `log-test-${crypto.randomUUID()}`;
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName,
      scope: {
        addEventListener: (type: string, listener: unknown) =>
          listeners.set(type, listener as never),
      } as never,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const quoted = new SyntaxError("Unexpected token 'p', \"password=hunter2\" is not valid JSON");
    quoted.stack = `SyntaxError: x\n    at parse (chrome-extension://${EXTENSION}/chunks/background-abc.js:12:345)\n    at https://evil.example/x.js:1:2`;
    listeners.get("unhandledrejection")?.({ reason: quoted } as unknown as Event);
    listeners.get("error")?.({ error: new Error("storage-failed") } as unknown as Event);
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(2));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => entry.fields)).toEqual([
      { source: "rejection", name: "SyntaxError", stack: "background-abc.js:12:345" },
      // This test page is not an extension page, so its positions are left out.
      { source: "error", name: "Error", message: "storage-failed" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("hunter2");
    vi.restoreAllMocks();
  });

  it("logs a warning state the first time a worker sees a connection", async () => {
    let state: "ready" | "unavailable" = "unavailable";
    let snapshotId = "snapshot-1";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({
        ok: true,
        kind: "status",
        connections: [
          {
            connectionId: "connection-secret-id",
            label: "Personal vault",
            email: "owner@example.com",
            environment: { kind: "cloud", region: "us" },
            autoUnlock: "enabled",
            state,
            providerSession: "active",
            snapshotId,
          },
        ],
      }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    log.vaultStateMayChange();
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(1));
    state = "ready";
    snapshotId = "snapshot-2";
    log.vaultStateMayChange();
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(2));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.level, entry.fields])).toEqual([
      [
        "warn",
        {
          connection: expect.stringMatching(/^bitwarden:[0-9a-f]{6}$/u),
          state: "unavailable",
          providerSession: "active",
        },
      ],
      [
        "info",
        {
          connection: entries[0]?.fields["connection"],
          state: "ready",
          previous: "unavailable",
          providerSession: "active",
          synced: true,
        },
      ],
    ]);
    const serialized = JSON.stringify(entries);
    for (const secret of ["connection-secret-id", "Personal vault", "owner@example.com"])
      expect(serialized).not.toContain(secret);
    vi.restoreAllMocks();
  });

  it("finds positions only inside this extension", () => {
    expect(
      stackPositions(
        `Error\n    at a (chrome-extension://${EXTENSION}/background.js:1:2)\n    at b (https://site.example/app.js:3:4)`,
      ),
    ).toBe("background.js:1:2");
    expect(stackPositions("at b (https://site.example/app.js:3:4)")).toBeUndefined();
    // The message line may quote input that looks like a position.
    expect(
      stackPositions(
        `Error: chrome-extension://${EXTENSION}/secret.js:1:2\n    at https://site.example/app.js:3:4`,
      ),
    ).toBeUndefined();
  });
});
