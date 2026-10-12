import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsLog } from "./background";
import {
  DEBUG_LOGGING_MS,
  LOG_RETENTION_MS,
  PAGE_EVENTS_PER_MINUTE,
  TRUNCATED,
  createLogger,
  formatLogExport,
  recentLog,
  stackPositions,
  type KnownSites,
  type LogEntry,
  type LoggerDependencies,
} from "./log";
import { createPseudonyms } from "./pseudonym";
import { recentLogSchema } from "./wire";
import * as v from "valibot";

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

  it("keeps a page URL's path, query and fragment only for a site named in full", async () => {
    const { logger } = setup();
    const long = `https://bank.example/signin?return=${"a".repeat(600)}`;
    for (const [origin, url] of [
      ["https://bank.example", "https://bank.example/signin?next=%2Fhome#top"],
      // A pseudonymized origin gets no URL, and a URL of another origin is left out.
      ["https://shop.example", "https://shop.example/signin?next=%2Fcart"],
      ["https://bank.example", "https://other.example/signin"],
      // A blob URL names its inner origin but has no path of its own.
      ["https://bank.example", "blob:https://bank.example/1234"],
      ["https://bank.example", long],
    ])
      // oxlint-disable-next-line no-await-in-loop -- entries are written in order
      await logger.log("login.refused", { origin, reason: "default-not-set", url });
    await logger.log("login.exception", {
      origin: "https://bank.example",
      name: "Error",
      url: "https://bank.example/signin?next=%2Fhome#top",
    });
    const entries = await logger.entries();
    expect(entries.map((entry) => entry.fields["url"])).toEqual([
      "/signin?next=%2Fhome#top",
      undefined,
      undefined,
      undefined,
      `/signin?return=${"a".repeat(600)}`.slice(0, 512),
      "/signin?next=%2Fhome#top",
    ]);
    expect(JSON.stringify(entries)).not.toContain("cart");
    // Hiding sites leaves URLs out of a download, and the bug report never carries them.
    const context = { version: "0.1.0", revision: "1c42ad3", exportedAt: NOW };
    expect(formatLogExport(entries, { ...context, includeSites: true })).toContain(
      "/signin?next=%2Fhome#top",
    );
    expect(formatLogExport(entries, { ...context, includeSites: false })).not.toContain("/signin");
    const recent = recentLog(entries, NOW);
    expect(recent.problems).toHaveLength(1);
    expect(JSON.stringify(recent)).not.toContain("/signin");
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

  it("turns debug logging off before the 24 hours end, across workers", async () => {
    const { logger, deps } = setup();
    await logger.enableDebug();
    await logger.disableDebug();
    await logger.log("service.sync", { outcome: "synced" }, { level: "debug" });
    const restarted = createLogger(deps);
    await restarted.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect((await restarted.summary()).debugUntil).toBeUndefined();
    expect((await restarted.entries()).map((entry) => [entry.event, entry.fields])).toEqual([
      ["log.debug", { enabled: true, until: NOW + DEBUG_LOGGING_MS }],
      ["log.debug", { enabled: false }],
    ]);
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

  it("keeps a page's debug events from crowding out the rest", async () => {
    const { logger } = setup();
    await logger.enableDebug();
    const source = { tabId: 4, origin: "https://hotel.example" };
    for (let index = 0; index < PAGE_EVENTS_PER_MINUTE + 3; index += 1)
      void logger.log(
        "login.refused",
        { origin: source.origin, reason: "tab-busy", frame: true },
        { level: "debug", source },
      );
    await logger.log(
      "recipe.judge",
      { origin: source.origin, verdict: "not-sent", reason: "sign-in-shown" },
      { source },
    );
    const entries = (await logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(entries.filter((entry) => entry.event === "login.refused")).toHaveLength(
      PAGE_EVENTS_PER_MINUTE,
    );
    // Only debug detail was lost, so the drop is debug detail too.
    expect(
      entries
        .filter((entry) => entry.event !== "login.refused")
        .map((entry) => [entry.event, entry.level]),
    ).toEqual([
      ["log.dropped", "debug"],
      ["recipe.judge", "info"],
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

  it("summarizes the size and the errors and warnings of the last 24 hours", async () => {
    const { logger, advance } = setup();
    await logger.log("error.unhandled", { name: "TypeError" });
    advance(25 * 60 * 60 * 1000);
    await logger.log("error.unhandled", { name: "TypeError" });
    await logger.log("service.sync", { outcome: "rejected" }, { level: "warn" });
    const summary = await logger.summary();
    expect(summary).toMatchObject({ entries: 3, recentErrors: 1, recentWarnings: 1 });
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

describe("recent log for a bug report", () => {
  const HOUR = 60 * 60_000;
  const entry = (
    time: number,
    level: LogEntry["level"],
    event: LogEntry["event"],
    fields: LogEntry["fields"],
  ): LogEntry => ({ time, level, event, fields });

  it("lists the newest warnings and errors of 24 hours with sites numbered", () => {
    const entries = [
      entry(NOW - 25 * HOUR, "warn", "service.sync", { outcome: "rejected" }),
      entry(NOW - 3 * HOUR, "info", "runtime.updated", {
        previousBuild: "9cf8356",
        build: "1c42ad3",
        version: "0.1.0",
      }),
      entry(NOW - 2 * HOUR, "warn", "vault.sync", {
        connection: "bitwarden:5c1e9a",
        outcome: "account-mismatch",
        check: "token-email",
      }),
      entry(NOW - HOUR, "warn", "login.attempt", {
        origin: "https://bank.example",
        recipe: "bank-signin",
        state: "blocked",
        outcome: "structural-mismatch",
        // Not allowlisted for this event.
        email: "owner@example.com",
      }),
      entry(NOW - 30 * 60_000, "info", "passkey.request", {
        origin: "https://bank.example",
        outcome: "delegate",
        reason: "no-credential",
      }),
      entry(NOW - 20 * 60_000, "info", "passkey.request", {
        origin: "origin:7d2b91aa",
        outcome: "delegate",
        reason: "no-credential",
      }),
      entry(NOW - 10 * 60_000, "info", "passkey.request", {
        origin: "origin:7d2b91aa",
        outcome: "delegate",
        reason: "Owner's Secret",
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        entry(NOW - 5 * 60_000 + index, "error", "error.unhandled", {
          source: "rejection",
          name: "TypeError",
        }),
      ),
    ];
    const recent = recentLog(entries, NOW);
    expect(recent.problems).toHaveLength(10);
    expect(recent.problems[0]).toBe(
      `${new Date(NOW - 5 * 60_000).toISOString().slice(0, 16)}Z error error.unhandled rejection TypeError`,
    );
    const all = recentLog(entries.slice(0, 7), NOW);
    expect(all.problems).toEqual([
      `${new Date(NOW - HOUR).toISOString().slice(0, 16)}Z warn login.attempt site-1 recipe-1 blocked structural-mismatch`,
      `${new Date(NOW - 2 * HOUR).toISOString().slice(0, 16)}Z warn vault.sync bitwarden:5c1e9a account-mismatch token-email`,
    ]);
    expect(all.updated).toEqual({ time: NOW - 3 * HOUR, from: "9cf8356" });
    expect(all.passkeyDelegations).toEqual([{ reason: "no-credential", count: 2 }]);
    const text = JSON.stringify(all);
    for (const secret of ["bank.example", "bank-signin", "owner@example.com", "Secret"])
      expect(text).not.toContain(secret);
    expect(v.is(recentLogSchema, recent)).toBe(true);
    expect(v.is(recentLogSchema, all)).toBe(true);
  });

  it("stays within what the page accepts at every limit", () => {
    const long = `https://${"a".repeat(500)}.example`;
    const entries = [
      ...Array.from({ length: 12 }, (_, index) =>
        entry(NOW - index, "warn", "log.dropped", { origin: TRUNCATED, count: index }),
      ),
      entry(NOW, "warn", "login.attempt", {
        origin: long,
        recipe: "r".repeat(120),
        state: TRUNCATED,
        outcome: TRUNCATED,
      }),
      ...Array.from({ length: 40 }, (_, index) =>
        entry(NOW - 1_000, "info", "passkey.request", {
          outcome: "delegate",
          reason: `reason-${index}`,
        }),
      ),
      entry(NOW - 1_000, "info", "passkey.request", { outcome: "delegate", reason: TRUNCATED }),
      // A wrong clock far in the future is left out.
      entry(8.64e15 + 1, "error", "error.unhandled", { source: "error", name: "Error" }),
    ];
    const recent = recentLog(entries, NOW);
    expect(recent.problems).toHaveLength(10);
    expect(recent.passkeyDelegations).toHaveLength(32);
    expect(recent.passkeyDelegations.map((item) => item.reason)).not.toContain(TRUNCATED);
    expect(v.is(recentLogSchema, recent)).toBe(true);
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

  it("logs a settings-page Sync by outcome, and a failure as a warning", async () => {
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    log.vaultSync("connection-secret-id", {
      ok: true,
      kind: "ready",
      connectionId: "connection-secret-id",
      snapshotId: "snapshot-1",
      policyReviewItemIds: [],
    });
    log.vaultSync("connection-secret-id", {
      ok: false,
      error: { code: "account-mismatch", check: "token-email" },
    });
    log.vaultSync("connection-secret-id", { ok: false, error: { code: "cancelled" } });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(3));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      [
        "vault.sync",
        "info",
        { connection: expect.stringMatching(/^bitwarden:[0-9a-f]{6}$/u), outcome: "ready" },
      ],
      [
        "vault.sync",
        "warn",
        {
          connection: entries[0]?.fields["connection"],
          outcome: "account-mismatch",
          check: "token-email",
        },
      ],
      [
        "vault.sync",
        "info",
        { connection: entries[0]?.fields["connection"], outcome: "cancelled" },
      ],
    ]);
    expect(JSON.stringify(entries)).not.toContain("connection-secret-id");
    vi.restoreAllMocks();
  });

  it("logs a failed Bitwarden refresh as a warning with its cause and status", async () => {
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({
        revision: 1,
        settings: { connections: [], excludedSites: [], siteDefaults: [], bindings: [] },
      }),
      recipeCache: async () => ({ recipes: [] }),
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    await log.logger.enableDebug();
    log.vaultRefresh({ connectionId: "connection-secret-id", outcome: "refreshed" });
    log.vaultRefresh({
      connectionId: "connection-secret-id",
      outcome: "failed",
      cause: "http-error",
      status: 401,
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "vault.refresh"),
      ).toHaveLength(2),
    );
    const entries = (await log.logger.entries()).filter((entry) => entry.event === "vault.refresh");
    expect(entries.map((entry) => [entry.level, entry.fields])).toEqual([
      [
        "debug",
        { connection: expect.stringMatching(/^bitwarden:[0-9a-f]{6}$/u), outcome: "refreshed" },
      ],
      [
        "warn",
        {
          connection: entries[0]?.fields["connection"],
          outcome: "failed",
          cause: "http-error",
          status: 401,
        },
      ],
    ]);
    expect(JSON.stringify(entries)).not.toContain("connection-secret-id");
    vi.restoreAllMocks();
  });

  it("logs what a sync changed, a judged page, a handler, what stopped a login and refused output", async () => {
    const recipeOrigin = "https://login.example";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({
        revision: 7,
        settings: { connections: [], excludedSites: [], siteDefaults: [], bindings: [] },
      }),
      recipeCache: async () => ({ recipes: [{ origin: recipeOrigin }] }),
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    await log.logger.enableDebug();
    const unchanged = { scope: "full", added: 0, updated: 0, removed: 0 } as const;
    log.recipeSync("synced", unchanged);
    log.recipeSync("synced", { scope: "recipes", added: 0, updated: 1, removed: 0 });
    log.settingsChanged("synced");
    // The revision is read first, so the entry is awaited to keep the order.
    await vi.waitFor(async () =>
      expect((await log.logger.entries()).map((entry) => entry.event)).toContain(
        "settings.changed",
      ),
    );
    const page = { tabId: 3, origin: recipeOrigin, recipeId: "synthetic-recipe" };
    log.login({
      type: "judge",
      ...page,
      recipeRevision: 1,
      route: "password",
      verdict: "sent",
    });
    log.login({
      type: "judge",
      ...page,
      recipeRevision: 1,
      route: "password",
      verdict: "unclear",
      reason: "already-judged",
    });
    log.login({
      type: "handler",
      ...page,
      handler: 0,
      kind: "passkey",
      outcome: "entered",
      steps: 1,
    });
    // ADR 0029's sign-in state: only the signs that show are written.
    const signs = { s1: true, s2: true, s3: false, s4: false, s5: false, f1: false, f2: true };
    log.login({
      type: "state",
      ...page,
      route: "password",
      ...signs,
      ...{ e1: false, e2: false, e3: false },
      decision: "rejected",
    });
    log.login({
      type: "attempt",
      ...page,
      route: "password",
      variant: 1,
      state: "blocked",
      stepIndex: 2,
      stepCount: 3,
      operation: "click",
      effect: "submit",
      handler: 0,
      outcome: "policy-changed",
      cause: "settings-synced",
    });
    // A recipe with several password variants names its first variant's refusal (ADR 0027).
    log.login({
      type: "refused",
      tabId: 3,
      origin: recipeOrigin,
      reason: "no-route",
      detail: "binding-not-found",
    });
    // Model output the service refused names the check, without the output.
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "failed",
      reason: "invalid-output",
      check: "schema",
      detail: "max-length",
      path: "result.alternatives",
    });
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "failed",
      reason: "invalid-output",
      check: "plan",
      detail: "incompatible-role",
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(12));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      // An unchanged sync is a debug entry; one that changed a recipe is info.
      ["service.sync", "debug", { outcome: "synced", scope: "full" }],
      ["service.sync", "info", { outcome: "synced", scope: "recipes", updated: 1 }],
      ["settings.changed", "info", { source: "synced", revision: 7 }],
      [
        "recipe.judge",
        "debug",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "sent",
        },
      ],
      [
        "recipe.judge",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "unclear",
          reason: "already-judged",
        },
      ],
      [
        "login.handler",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          handler: 0,
          kind: "passkey",
          outcome: "entered",
          steps: 1,
        },
      ],
      [
        "login.state",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          route: "password",
          decision: "rejected",
          s1: true,
          s2: true,
          f2: true,
        },
      ],
      [
        "login.attempt",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          route: "password",
          variant: 1,
          state: "blocked",
          step: 2,
          steps: 3,
          operation: "click",
          effect: "submit",
          handler: 0,
          outcome: "policy-changed",
          cause: "settings-synced",
        },
      ],
      [
        "login.refused",
        "info",
        { origin: recipeOrigin, reason: "no-route", detail: "binding-not-found" },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "failed",
          reason: "invalid-output",
          check: "schema",
          detail: "max-length",
          path: "result.alternatives",
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "failed",
          reason: "invalid-output",
          check: "plan",
          detail: "incompatible-role",
        },
      ],
    ]);
    vi.restoreAllMocks();
  });

  it("warns once for a login that did not finish and keeps a held tab's frames quiet", async () => {
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    await log.logger.enableDebug();
    const site = { tabId: 4, origin: "https://login.example" };
    log.login({
      type: "attempt",
      ...site,
      recipeId: "synthetic-recipe",
      route: "password",
      state: "reconciling",
      stepIndex: 1,
      stepCount: 2,
      outcome: "unknown-submit",
      settled: true,
    });
    // The tab's next page resumes a stopped login without changing it.
    log.login({
      type: "attempt",
      ...site,
      recipeId: "synthetic-recipe",
      route: "password",
      state: "blocked",
      stepIndex: 2,
      stepCount: 2,
      outcome: "challenge",
      repeat: true,
    });
    log.login({ type: "refused", ...site, reason: "tab-busy", frame: true });
    log.login({ type: "refused", ...site, reason: "tab-busy" });
    // Filling the form after a logout ends without pressing anything by design.
    log.login({
      type: "attempt",
      ...site,
      recipeId: "synthetic-recipe",
      route: "password",
      state: "blocked",
      stepIndex: 1,
      stepCount: 2,
      outcome: "cancelled",
      reason: "fill-only",
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(6));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields["settled"]])).toEqual([
      ["login.attempt", "warn", true],
      ["login.attempt", "debug", undefined],
      ["login.refused", "debug", undefined],
      ["login.refused", "info", undefined],
      ["login.attempt", "info", undefined],
    ]);
    expect(entries[2]?.fields).toMatchObject({ reason: "tab-busy", frame: true });
    expect((await log.logger.summary()).recentWarnings).toBe(1);
    vi.restoreAllMocks();
  });

  it("logs a reason once per login-related page and warns for an exception", async () => {
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    await log.logger.enableDebug();
    const site = { tabId: 4, origin: "https://login.example" };
    log.login({ type: "refused", ...site, reason: "site-excluded" });
    log.login({ type: "refused", ...site, reason: "site-excluded", repeat: true });
    log.login({ type: "refused", ...site, reason: "recipe-not-found", unrelated: true });
    log.login({ type: "refused", ...site, reason: "stale-document" });
    log.login({ type: "refused", ...site, reason: "stale-document", detail: "gave-up" });
    log.login({ type: "refused", ...site, reason: "duplicate-document" });
    // A framed login's refusal is logged like the page's.
    log.login({ type: "refused", ...site, reason: "default-not-set", frame: true });
    for (const message of ["storage-failed", "password=hunter2"])
      log.login({
        type: "exception",
        ...site,
        recipeId: "synthetic-recipe",
        route: "password",
        state: "reconciling",
        stepIndex: 1,
        name: "Error",
        message,
      });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(10));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(
      entries.map((entry) => [
        entry.event,
        entry.level,
        entry.fields["reason"] ?? entry.fields["message"],
      ]),
    ).toEqual([
      ["login.refused", "info", "site-excluded"],
      ["login.refused", "debug", "site-excluded"],
      ["login.refused", "debug", "recipe-not-found"],
      ["login.refused", "debug", "stale-document"],
      ["login.refused", "info", "stale-document"],
      ["login.refused", "debug", "duplicate-document"],
      ["login.refused", "info", "default-not-set"],
      ["login.exception", "warn", "storage-failed"],
      ["login.exception", "warn", undefined],
    ]);
    expect(entries.at(-1)?.fields).toEqual({
      // No settings or recipe names the site in this test, so it is a pseudonym.
      origin: expect.stringMatching(/^origin:/),
      recipe: "synthetic-recipe",
      route: "password",
      state: "reconciling",
      step: 1,
      name: "Error",
    });
    expect(JSON.stringify(entries)).not.toContain("hunter2");
    vi.restoreAllMocks();
  });

  it("logs a login's start, the account choice and a logout at info", async () => {
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const site = { tabId: 4, origin: "https://login.example" };
    const itemId = "80000000-0000-4000-8000-000000000001";
    log.login({
      type: "start",
      ...site,
      recipeId: "synthetic-recipe",
      route: "password",
      variant: 0,
      account: "match",
      candidates: 1,
      itemId,
    });
    log.login({ type: "choice", ...site, outcome: "saved" });
    log.login({ type: "logout", ...site, recipeId: "synthetic-recipe" });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(3));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ["login.start", "info"],
      ["login.choice", "info"],
      ["login.logout", "info"],
    ]);
    expect(entries[0]?.fields).toMatchObject({
      route: "password",
      variant: 0,
      account: "match",
      candidates: 1,
      item: expect.stringMatching(/^item:[0-9a-f]{8}$/),
    });
    expect(JSON.stringify(entries)).not.toContain(itemId);
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
