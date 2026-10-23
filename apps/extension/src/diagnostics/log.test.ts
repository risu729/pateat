import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsLog } from "./background";
import {
  DEBUG_LOGGING_MS,
  DEBUG_UNTIL_TURNED_OFF,
  LOG_EVENTS,
  LOG_RETENTION_MS,
  PAGE_ATTEMPT_EVENTS_PER_MINUTE,
  PAGE_DEBUG_EVENTS_PER_MINUTE,
  PAGE_EVENTS_PER_MINUTE,
  TRUNCATED,
  createLogger,
  formatLogExport,
  recentLog,
  stackPositions,
  type KnownSites,
  type LogEntry,
  type LogEventName,
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
    // The 24-hour window a published build has; one test covers debug that stays on.
    debugStaysOn: false,
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

  it("keeps an invalid request's member and size, and only as a code and a count", async () => {
    const { logger } = setup();
    for (const [invalid, invalidLength] of [
      ["allow-credentials.id", 1024],
      // A member that fails the code check, or a size that is no count, is left out.
      ["Owner's challenge", -1],
    ] as const)
      // oxlint-disable-next-line no-await-in-loop -- entries are written in order
      await logger.log("passkey.request", {
        origin: "https://bank.example",
        outcome: "delegate",
        reason: "invalid-request",
        invalid,
        invalidLength,
      });
    const entries = await logger.entries();
    expect(entries.map((entry) => entry.fields)).toEqual([
      {
        origin: "https://bank.example",
        outcome: "delegate",
        reason: "invalid-request",
        invalid: "allow-credentials.id",
        invalidLength: 1024,
      },
      { origin: "https://bank.example", outcome: "delegate", reason: "invalid-request" },
    ]);
  });

  it("keeps a checked registration's outcome, counts and flags, never a credential (ADR 0007)", async () => {
    const { logger } = setup();
    await logger.log("passkey.create", {
      origin: "https://bank.example",
      rpId: "bank.example",
      outcome: "declined",
      mediation: "conditional",
      excludeCredentials: 2,
      listed: true,
      sinceSignIn: 42,
      // Not in the allowlist.
      ...({
        credentialId: "AQID",
        excludeCredentialIds: ["BAUG"],
        user: "owner@example.com",
      } as object),
    });
    await logger.log("passkey.create", {
      origin: "https://shop.example",
      rpId: "shop.example",
      outcome: "delegate",
      reason: "not-signed-in",
      excludeCredentials: 1,
    });
    // Fields failing their kind's check are left out.
    await logger.log("passkey.create", {
      origin: "https://bank.example",
      outcome: "delegate",
      reason: "Owner's reason",
      mediation: "Owner's text",
      excludeCredentials: 1.5,
      listed: "yes",
      sinceSignIn: -1,
    });
    const entries = await logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ["passkey.create", "info"],
      ["passkey.create", "info"],
      ["passkey.create", "info"],
    ]);
    expect(entries.map((entry) => entry.fields)).toEqual([
      {
        origin: "https://bank.example",
        rpId: "bank.example",
        outcome: "declined",
        mediation: "conditional",
        excludeCredentials: 2,
        listed: true,
        sinceSignIn: 42,
      },
      {
        origin: expect.stringMatching(/^origin:[0-9a-f]{8}$/u),
        rpId: expect.stringMatching(/^rp:[0-9a-f]{8}$/u),
        outcome: "delegate",
        reason: "not-signed-in",
        excludeCredentials: 1,
      },
      { origin: "https://bank.example", outcome: "delegate" },
    ]);
    const serialized = JSON.stringify(entries);
    for (const secret of ["AQID", "BAUG", "owner@example.com", "shop.example", "Owner"])
      expect(serialized).not.toContain(secret);
  });

  it("logs a create report from the background with its tab number (ADR 0007)", async () => {
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
    log.passkeyCreate({
      tabId: 4,
      origin: "https://login.example",
      outcome: "delegate",
      reason: "expired",
      rpId: "login.example",
      mediation: "other",
      excludeCredentials: 3,
      sinceSignIn: 301,
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "passkey.create"),
      ).toHaveLength(1),
    );
    const entry = (await log.logger.entries()).find((value) => value.event === "passkey.create")!;
    expect(entry.level).toBe("info");
    expect(entry.fields).toEqual({
      // No settings or recipe names the site in this test, so it is a pseudonym.
      origin: expect.stringMatching(/^origin:/u),
      rpId: expect.stringMatching(/^rp:/u),
      outcome: "delegate",
      reason: "expired",
      mediation: "other",
      excludeCredentials: 3,
      sinceSignIn: 301,
      tab: 4,
    });
    vi.restoreAllMocks();
  });

  it("logs why an advance on its next step's own path was not confirmed, as codes (ADR 0013)", async () => {
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
    const signs = { s1: true, s2: true, s3: false, s4: false, s5: false };
    log.login({
      type: "state",
      tabId: 4,
      origin: "https://login.example",
      recipeId: "gen-1",
      recipeRevision: 4,
      route: "password",
      decision: "unknown",
      ...signs,
      f1: false,
      f2: false,
      e1: false,
      e2: false,
      e3: false,
      reshownMiss: "not-submit",
      advanceBefore: "unusable.missing",
      advanceAfter: "unusable.ambiguous",
      advanceWhy: "transparent.matches-2",
      advancePath: "same",
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "login.state"),
      ).toHaveLength(1),
    );
    const entry = (await log.logger.entries()).find((value) => value.event === "login.state")!;
    expect(entry.fields).toMatchObject({
      decision: "unknown",
      reshownMiss: "not-submit",
      advanceBefore: "unusable.missing",
      advanceAfter: "unusable.ambiguous",
      advanceWhy: "transparent.matches-2",
      advancePath: "same",
    });
    vi.restoreAllMocks();
  });

  it("logs each first login result sent to the service as codes (ADR 0019)", async () => {
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
    log.loginOutcome({ recipeId: "gen-0123", revision: 3, result: "kept" });
    log.loginOutcome({ recipeId: "gen-0123", revision: 4, result: "failed:unreachable" });
    log.loginOutcome({
      recipeId: "gen-0123",
      revision: 5,
      branch: "other",
      result: "failed:unexpected-response",
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "service.outcome"),
      ).toHaveLength(3),
    );
    const entries = (await log.logger.entries()).filter(
      (entry) => entry.event === "service.outcome",
    );
    expect(entries.map(({ level, fields }) => ({ level, fields }))).toEqual([
      { level: "info", fields: { recipe: "gen-0123", recipeRevision: 3, result: "kept" } },
      {
        level: "info",
        fields: { recipe: "gen-0123", recipeRevision: 4, result: "failed:unreachable" },
      },
      {
        level: "warn",
        fields: {
          recipe: "gen-0123",
          recipeRevision: 5,
          branch: "other",
          result: "failed:unexpected-response",
        },
      },
    ]);
    vi.restoreAllMocks();
  });

  it("logs each login record sent to the service as codes (ADR 0055)", async () => {
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
    log.loginRecord({ recipeId: "gen-0123", revision: 3, result: "kept" });
    log.loginRecord({ recipeId: "gen-0123", revision: 3, branch: "other", result: "refused" });
    log.loginRecord({ recipeId: "gen-0123", revision: 4, result: "failed:invalid-record" });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "service.login"),
      ).toHaveLength(3),
    );
    const entries = (await log.logger.entries()).filter((entry) => entry.event === "service.login");
    expect(entries.map(({ level, fields }) => ({ level, fields }))).toEqual([
      { level: "info", fields: { recipe: "gen-0123", recipeRevision: 3, result: "kept" } },
      // A service without the route refuses it; that is expected, not a problem.
      {
        level: "info",
        fields: { recipe: "gen-0123", recipeRevision: 3, branch: "other", result: "refused" },
      },
      {
        level: "warn",
        fields: { recipe: "gen-0123", recipeRevision: 4, result: "failed:invalid-record" },
      },
    ]);
    vi.restoreAllMocks();
  });

  it("logs each recipe use sent to the service as codes, quietly when kept (ADR 0058)", async () => {
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
    const uses = async () =>
      (await log.logger.entries()).filter((entry) => entry.event === "service.use");
    // Without debug logging a kept or refused use leaves no entry.
    log.recipeUse({ recipeId: "gen-0123", revision: 3, result: "kept" });
    log.recipeUse({ recipeId: "gen-0123", revision: 4, result: "failed:unreachable" });
    await vi.waitFor(async () => expect(await uses()).toHaveLength(1));
    await log.logger.enableDebug();
    log.recipeUse({ recipeId: "gen-0123", revision: 3, result: "kept" });
    // A recipe revoked meanwhile, or a service without the route, refuses it.
    log.recipeUse({ recipeId: "gen-0123", revision: 5, result: "refused" });
    log.recipeUse({ recipeId: "gen-0123", revision: 6, result: "rejected" });
    log.recipeUse({ recipeId: "gen-0123", revision: 7, result: "failed:unexpected-response" });
    log.recipeUse({ recipeId: "gen-0123", revision: 8, result: "failed:threw" });
    await vi.waitFor(async () => expect(await uses()).toHaveLength(6));
    expect((await uses()).map(({ level, fields }) => ({ level, fields }))).toEqual([
      {
        level: "info",
        fields: { recipe: "gen-0123", recipeRevision: 4, result: "failed:unreachable" },
      },
      { level: "debug", fields: { recipe: "gen-0123", recipeRevision: 3, result: "kept" } },
      { level: "debug", fields: { recipe: "gen-0123", recipeRevision: 5, result: "refused" } },
      { level: "warn", fields: { recipe: "gen-0123", recipeRevision: 6, result: "rejected" } },
      {
        level: "warn",
        fields: { recipe: "gen-0123", recipeRevision: 7, result: "failed:unexpected-response" },
      },
      { level: "warn", fields: { recipe: "gen-0123", recipeRevision: 8, result: "failed:threw" } },
    ]);
    // The event allows no other fields, as the origin or a branch.
    expect(Object.keys(LOG_EVENTS["service.use"].fields).toSorted()).toEqual([
      "recipe",
      "recipeRevision",
      "result",
    ]);
    vi.restoreAllMocks();
  });

  it("logs how long service requests and an ended login took (ADR 0019)", async () => {
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
    const timing = { roundTripMs: 2_600, serverMs: 2_400, networkMs: 200, tokenMs: 300 };
    log.recipeSync("synced", {
      scope: "full",
      added: 1,
      updated: 0,
      removed: 0,
      timing: { roundTripMs: 500, serverMs: 100, networkMs: 400 },
    });
    log.login({
      type: "generation",
      tabId: 1,
      origin: "https://bank.example",
      outcome: "recipe",
      timing: { ...timing, modelMs: 2_000 },
    });
    log.login({
      type: "judge",
      tabId: 1,
      origin: "https://bank.example",
      recipeId: "gen-0123",
      recipeRevision: 2,
      route: "password",
      verdict: "unclear",
      timing: { roundTripMs: 90_000 },
    });
    log.login({
      type: "attempt",
      tabId: 1,
      origin: "https://bank.example",
      recipeId: "gen-0123",
      recipeRevision: 2,
      route: "password",
      variant: 0,
      state: "authenticated",
      stepIndex: 2,
      stepCount: 2,
      outcome: "authenticated",
      times: {
        totalMs: 9_000,
        serviceMs: 2_600,
        networkMs: 200,
        personMs: 4_000,
        pageMs: 1_500,
        otherMs: 900,
      },
    });
    const events = ["service.sync", "recipe.generate", "recipe.judge", "login.attempt"];
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => events.includes(entry.event)),
      ).toHaveLength(4),
    );
    const fields = Object.fromEntries(
      (await log.logger.entries())
        .filter((entry) => events.includes(entry.event))
        .map((entry) => [entry.event, entry.fields]),
    );
    expect(fields["service.sync"]).toEqual({
      outcome: "synced",
      scope: "full",
      added: 1,
      roundTripMs: 500,
      serverMs: 100,
      networkMs: 400,
    });
    expect(fields["recipe.generate"]).toMatchObject({ ...timing, modelMs: 2_000 });
    // A request with no service time, such as one that timed out, has its round trip only.
    expect(fields["recipe.judge"]).toMatchObject({ roundTripMs: 90_000 });
    expect(fields["recipe.judge"]).not.toHaveProperty("serverMs");
    expect(fields["login.attempt"]).toMatchObject({
      steps: 2,
      totalMs: 9_000,
      serviceMs: 2_600,
      networkMs: 200,
      personMs: 4_000,
      pageMs: 1_500,
      otherMs: 900,
    });
    vi.restoreAllMocks();
  });

  it("keeps a page URL's path and parameter names only for a site named in full", async () => {
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
      "/signin?next=#",
      undefined,
      undefined,
      undefined,
      "/signin?return=",
      "/signin?next=#",
    ]);
    expect(JSON.stringify(entries)).not.toContain("cart");
    // Hiding sites leaves URLs out of a download, and the bug report never carries them.
    const context = { version: "0.1.0", revision: "1c42ad3", exportedAt: NOW };
    expect(formatLogExport(entries, { ...context, includeSites: true })).toContain(
      "/signin?next=#",
    );
    expect(formatLogExport(entries, { ...context, includeSites: false })).not.toContain("/signin");
    const recent = recentLog(entries, NOW);
    expect(recent.problems).toHaveLength(1);
    expect(JSON.stringify(recent)).not.toContain("/signin");
  });

  it("keeps no query or fragment value in any event's URL", async () => {
    const { logger } = setup();
    const secret = "S3cr3tC0de";
    const shapes: [string, string][] = [
      [`/auth/callback?code=${secret}&state=${secret}`, "/auth/callback?code=&state="],
      [`/cb#access_token=${secret}&token_type=bearer`, "/cb#access_token=&token_type="],
      [`/app#/reset?token=${secret}`, "/app#/reset?token="],
      [`/app#!/signin`, "/app#!/signin"],
      [`/magic?${secret}`, "/magic?"],
      [`/verify#${secret}`, "/verify#"],
      [
        `/signin?login_hint=me%40example.com&${encodeURIComponent("x y")}=${secret}`,
        "/signin?login_hint=",
      ],
      ["/reset?dG9rZW4xMjM0NTY3OA==", "/reset?"],
      ["/cb#YWJjZGVmZ2hpams=", "/cb#"],
      [`/app#/a#${secret}`, "/app#/a"],
      [
        `/long?${Array.from({ length: 200 }, (_, index) => `p${index}=${secret}`).join("&")}`,
        "/long",
      ],
    ];
    const events = Object.entries(LOG_EVENTS).filter(([, definition]) =>
      Object.values(definition.fields).includes("url"),
    );
    expect(events.length).toBeGreaterThan(10);
    for (const [event, definition] of events) {
      for (const [path] of shapes) {
        const fields = Object.fromEntries(
          Object.entries(definition.fields).map(([key, kind]) => [
            key,
            kind === "origin"
              ? "https://bank.example"
              : kind === "url"
                ? `https://bank.example${path}`
                : undefined,
          ]),
        );
        // oxlint-disable-next-line no-await-in-loop -- entries are written in order
        await logger.log(event as LogEventName, fields as never);
      }
    }
    const entries = await logger.entries();
    expect(entries).toHaveLength(events.length * shapes.length);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain("example.com");
    for (const [index, entry] of entries.entries())
      expect(entry.fields["url"]).toBe(shapes[index % shapes.length]![1]);
    const exported = formatLogExport(entries, {
      version: "0.1.0",
      revision: "1c42ad3",
      exportedAt: NOW,
      includeSites: true,
    });
    for (const [, shape] of shapes) expect(exported).toContain(`"url":${JSON.stringify(shape)}`);
    expect(exported).not.toContain(secret);
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

  it("keeps debug logging on until turned off before publishing, across workers", async () => {
    const { logger, deps, advance } = setup({ debugStaysOn: true });
    expect(await logger.enableDebug()).toBe(DEBUG_UNTIL_TURNED_OFF);
    advance(DEBUG_LOGGING_MS * 30);
    const restarted = createLogger(deps);
    await restarted.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect((await restarted.entries()).map((entry) => entry.event)).toEqual([
      "log.debug",
      "service.sync",
    ]);
    expect((await restarted.summary()).debugUntil).toBe(DEBUG_UNTIL_TURNED_OFF);
    await restarted.disableDebug();
    await createLogger(deps).log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect(await createLogger(deps).entries()).toHaveLength(3);
    expect((await createLogger(deps).summary()).debugUntil).toBeUndefined();
  });

  it("keeps a 24-hour window still open on until turned off once debug stays on", async () => {
    const { logger, deps, advance } = setup();
    await logger.enableDebug();
    advance(DEBUG_LOGGING_MS / 2);
    const staying = { ...deps, debugStaysOn: true };
    expect((await createLogger(staying).summary()).debugUntil).toBe(DEBUG_UNTIL_TURNED_OFF);
    advance(DEBUG_LOGGING_MS);
    expect((await createLogger(staying).summary()).debugUntil).toBe(DEBUG_UNTIL_TURNED_OFF);
    // A published build turns it off.
    expect((await createLogger(deps).summary()).debugUntil).toBeUndefined();
    // A window that already ended stays off.
    const ended = setup();
    await ended.logger.enableDebug();
    ended.advance(DEBUG_LOGGING_MS);
    expect(
      (await createLogger({ ...ended.deps, debugStaysOn: true }).summary()).debugUntil,
    ).toBeUndefined();
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
    for (let index = 0; index < PAGE_EVENTS_PER_MINUTE + 3; index += 1)
      void logger.log(
        "login.refused",
        { origin: source.origin, reason: "origin-busy" },
        { source },
      );
    for (let index = 0; index < 2; index += 1)
      void logger.log("recipe.judge", { origin: source.origin, verdict: "not-sent" }, { source });
    // Another tab has its own allowance.
    await logger.log(
      "login.refused",
      { origin: source.origin, reason: "origin-busy" },
      { source: { ...source, tabId: 5 } },
    );
    // The first drop is logged at once, in case the worker stops before the window ends.
    const first = await logger.entries();
    expect(first).toHaveLength(PAGE_EVENTS_PER_MINUTE + 4);
    // Each dropped event is named; another event's first drop also counts the drops so far.
    expect(
      first.filter((entry) => entry.event === "log.dropped").map((entry) => entry.fields),
    ).toEqual([
      { origin: source.origin, dropped: "login.refused", count: 1 },
      { origin: source.origin, dropped: "login.refused", count: 2 },
      { origin: source.origin, dropped: "recipe.judge", count: 1 },
    ]);
    advance(60_000);
    await logger.log("login.refused", { origin: source.origin, reason: "tab-busy" }, { source });
    const entries = await logger.entries();
    expect(entries.slice(-2).map((entry) => [entry.event, entry.fields])).toEqual([
      ["log.dropped", { origin: source.origin, dropped: "recipe.judge", count: 1 }],
      ["login.refused", { origin: source.origin, reason: "tab-busy", tab: 4 }],
    ]);
    // A download keeps the entry's own event name next to the dropped one.
    const context = { version: "0.1.0", revision: "1c42ad3", exportedAt: NOW };
    const exported = formatLogExport(entries, { ...context, includeSites: true })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["dropped"] !== undefined);
    expect(exported.map((line) => [line["event"], line["dropped"]])).toContainEqual([
      "log.dropped",
      "recipe.judge",
    ]);
  });

  it("names no field like an export line's own keys, and every event passes the code check", () => {
    for (const [event, definition] of Object.entries(LOG_EVENTS)) {
      expect(event).toMatch(/^[a-z0-9][a-z0-9.:-]{0,63}$/u);
      for (const reserved of ["time", "level", "event"])
        expect(Object.keys(definition.fields)).not.toContain(reserved);
    }
  });

  it("keeps a caller's own allowance, as unhandled errors share 20 a minute", async () => {
    const { logger } = setup();
    const source = { tabId: -1, origin: "", perMinute: 20 };
    for (let index = 0; index < 25; index += 1)
      void logger.log("error.unhandled", { source: "error", name: "TypeError" }, { source });
    await logger.log("log.debug", { enabled: false });
    const entries = await logger.entries();
    expect(entries.filter((entry) => entry.event === "error.unhandled")).toHaveLength(20);
    // Tab -1 names no tab.
    expect(entries.some((entry) => "tab" in entry.fields)).toBe(false);
  });

  it("keeps a page's debug events from crowding out the rest", async () => {
    const { logger } = setup();
    await logger.enableDebug();
    const source = { tabId: 4, origin: "https://hotel.example" };
    for (let index = 0; index < PAGE_DEBUG_EVENTS_PER_MINUTE + 3; index += 1)
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
      PAGE_DEBUG_EVENTS_PER_MINUTE,
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

  it("keeps a login attempt's state changes apart from the page's other events", async () => {
    const { logger } = setup();
    await logger.enableDebug();
    const source = { tabId: 4, origin: "https://login.example" };
    const attempt = { origin: source.origin, recipe: "recipe-1", route: "password" };
    for (let index = 0; index < 5; index += 1)
      void logger.log("login.attempt", { ...attempt, state: "retryable" }, { source });
    for (let index = 0; index < PAGE_EVENTS_PER_MINUTE + 1; index += 1)
      void logger.log(
        "login.refused",
        { origin: source.origin, reason: "origin-busy" },
        { source },
      );
    // The outcome after the page's allowance is spent, as on a long login.
    void logger.log(
      "login.attempt",
      { ...attempt, state: "blocked", outcome: "timeout" },
      { level: "warn", source },
    );
    void logger.log(
      "login.attempt",
      { ...attempt, state: "authenticated", settled: true },
      { level: "warn", source },
    );
    void logger.log("login.attempt", { ...attempt, state: "authenticated" }, { source });
    // Step-by-step detail still has the debug allowance.
    for (let index = 0; index < PAGE_DEBUG_EVENTS_PER_MINUTE + 1; index += 1)
      void logger.log(
        "login.attempt",
        { ...attempt, state: "filling", step: index },
        { level: "debug", source },
      );
    // A page that keeps starting attempts, as a redirect loop, still meets a limit.
    for (let index = 8; index <= PAGE_ATTEMPT_EVENTS_PER_MINUTE; index += 1)
      void logger.log("login.attempt", { ...attempt, state: "retryable" }, { source });
    await logger.log("log.debug", { enabled: false });
    const entries = await logger.entries();
    const attempts = entries.filter((entry) => entry.event === "login.attempt");
    expect(attempts.filter((entry) => entry.level !== "debug")).toHaveLength(
      PAGE_ATTEMPT_EVENTS_PER_MINUTE,
    );
    expect(attempts.filter((entry) => entry.level === "debug")).toHaveLength(
      PAGE_DEBUG_EVENTS_PER_MINUTE,
    );
    expect(entries.filter((entry) => entry.event === "login.refused")).toHaveLength(
      PAGE_EVENTS_PER_MINUTE,
    );
    expect(
      entries
        .filter((entry) => entry.event === "log.dropped")
        .map((entry) => [entry.level, entry.fields["dropped"], entry.fields["count"]]),
    ).toEqual([
      ["warn", "login.refused", 1],
      ["debug", "login.attempt", 1],
      ["warn", "login.attempt", 1],
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

  it("leaves out a page URL stored with its parameters' values", () => {
    const stored = (url: string): LogEntry => ({
      time: NOW,
      level: "info",
      event: "login.attempt",
      fields: { origin: "https://bank.example", url },
    });
    const text = formatLogExport(
      [
        stored("/callback?code=S3cr3t&state=S3cr3t"),
        stored("/cb#access_token=S3cr3t"),
        stored("/magic?S3cr3t"),
        stored("/callback?code=&state="),
        stored("/app#/reset?token="),
      ],
      { ...context, includeSites: true },
    );
    expect(text).not.toContain("S3cr3t");
    expect(text).toContain('"url":"/callback?code=&state="');
    expect(text).toContain('"url":"/app#/reset?token="');
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

  it("counts pages that looked like a verification but were not sent, by reason (ADR 0035)", () => {
    const skipped = (time: number, reason: string, outcome = "skipped") =>
      entry(time, "info", "recipe.generate", { origin: "https://bank.example", outcome, reason });
    const recent = recentLog(
      [
        skipped(NOW - 10 * 60_000, "frame"),
        skipped(NOW - 20 * 60_000, "frame"),
        skipped(NOW - 30 * 60_000, "text-answer"),
        // Older than 24 hours, another skip, and another outcome are not counted.
        skipped(NOW - 25 * HOUR, "text-answer"),
        skipped(NOW - 40 * 60_000, "sent"),
        skipped(NOW - 50 * 60_000, "frame", "failed"),
      ],
      NOW,
    );
    expect(recent.unsentVerifications).toEqual([
      { reason: "frame", count: 2 },
      { reason: "text-answer", count: 1 },
    ]);
    expect(recent.passkeyDelegations).toEqual([]);
    expect(JSON.stringify(recent)).not.toContain("bank.example");
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
    // A message handler's failure, which the messaging library caught.
    log.rejection(new TypeError("password=hunter2"));
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(3));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => entry.fields)).toEqual([
      { source: "rejection", name: "SyntaxError", stack: "background-abc.js:12:345" },
      // This test page is not an extension page, so its positions are left out.
      { source: "error", name: "Error", message: "storage-failed" },
      { source: "rejection", name: "TypeError" },
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

  it("logs settings-page sign-in steps, an ended one as info and a failure as a warning", async () => {
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
    const flowId = crypto.randomUUID();
    log.vaultSignIn("begin", {
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [1],
      expiresAt: 1,
    });
    log.vaultSignIn("send-email-code", { ok: true, kind: "email-code", flowId, result: "sent" });
    log.vaultSignIn("send-email-code", {
      ok: true,
      kind: "email-code",
      flowId,
      result: "rate-limited",
    });
    log.vaultSignIn("continue", {
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [1],
      expiresAt: 1,
      invalidCode: true,
    });
    log.vaultSignIn("keep-alive", { ok: false, error: { code: "setup-expired" } });
    log.vaultSignIn("continue", { ok: false, error: { code: "authentication-rejected" } });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(6));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      ["vault.sign-in", "info", { step: "begin", outcome: "mfa-required" }],
      ["vault.sign-in", "info", { step: "send-email-code", outcome: "sent" }],
      ["vault.sign-in", "warn", { step: "send-email-code", outcome: "rate-limited" }],
      ["vault.sign-in", "info", { step: "continue", outcome: "code-refused" }],
      ["vault.sign-in", "info", { step: "keep-alive", outcome: "setup-expired" }],
      ["vault.sign-in", "warn", { step: "continue", outcome: "authentication-rejected" }],
    ]);
    expect(JSON.stringify(entries)).not.toContain(flowId);
    vi.restoreAllMocks();
  });

  it("logs the vault timeout's action, a failure as a warning (ADR 0075)", async () => {
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
    log.vaultTimeout({ trigger: "minutes", action: "lock", outcome: "done" });
    log.vaultTimeout({ trigger: "restart", action: "log-out", outcome: "failed" });
    log.vaultTimeout({ trigger: "system-idle", action: "lock", outcome: "done" });
    log.vaultTimeout({ trigger: "system-lock", action: "log-out", outcome: "done" });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(4));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      ["vault.timeout", "info", { trigger: "minutes", action: "lock", outcome: "done" }],
      ["vault.timeout", "warn", { trigger: "restart", action: "log-out", outcome: "failed" }],
      ["vault.timeout", "info", { trigger: "system-idle", action: "lock", outcome: "done" }],
      ["vault.timeout", "info", { trigger: "system-lock", action: "log-out", outcome: "done" }],
    ]);
    expect(LOG_EVENTS["vault.timeout"]).toEqual({
      level: "info",
      fields: { trigger: "code", action: "code", outcome: "code" },
    });
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

  it("logs a signed-in page sample (ADR 0029) as codes, a failure as a warning", async () => {
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
    const page = {
      type: "sample" as const,
      tabId: 3,
      origin: recipeOrigin,
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
      route: "password" as const,
    };
    log.login({ ...page, outcome: "sent" });
    log.login({ ...page, outcome: "kept" });
    log.login({ ...page, outcome: "recent" });
    log.login({ ...page, outcome: "gone" });
    log.login({ ...page, outcome: "refused" });
    log.login({ ...page, outcome: "not-sent", reason: "site-excluded" });
    log.login({ ...page, outcome: "failed", reason: "unreachable" });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "recipe.sample"),
      ).toHaveLength(7),
    );
    const entries = (await log.logger.entries()).filter((entry) => entry.event === "recipe.sample");
    const fields = { origin: recipeOrigin, recipe: expect.any(String), recipeRevision: 1, tab: 3 };
    expect(entries.map((entry) => [entry.level, entry.fields])).toEqual([
      ["debug", { ...fields, route: "password", outcome: "sent" }],
      ["info", { ...fields, route: "password", outcome: "kept" }],
      ["debug", { ...fields, route: "password", outcome: "recent" }],
      ["debug", { ...fields, route: "password", outcome: "gone" }],
      ["info", { ...fields, route: "password", outcome: "refused" }],
      ["debug", { ...fields, route: "password", outcome: "not-sent", reason: "site-excluded" }],
      ["warn", { ...fields, route: "password", outcome: "failed", reason: "unreachable" }],
    ]);
    vi.restoreAllMocks();
  });

  it("logs a recipe revoked for an item that cannot run it (ADR 0058 A) by its outcome", async () => {
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
    const page = {
      type: "revoke" as const,
      tabId: 3,
      origin: recipeOrigin,
      recipeId: "gen-0123456789abcdef0123456789abcdef",
      recipeRevision: 4,
      route: "passkey" as const,
      detail: "password-empty:no-advance",
    };
    const timing = { roundTripMs: 120, serverMs: 80, networkMs: 40 };
    log.login({ ...page, outcome: "revoked", timing });
    log.login({ ...page, outcome: "conflict", timing });
    log.login({ ...page, outcome: "not-due" });
    log.login({ ...page, outcome: "not-due", reason: "sent" });
    log.login({ ...page, outcome: "not-sent", reason: "storage-unavailable" });
    log.login({ ...page, outcome: "failed", reason: "rate-limited", timing });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "recipe.revoke"),
      ).toHaveLength(6),
    );
    const entries = (await log.logger.entries()).filter((entry) => entry.event === "recipe.revoke");
    const fields = {
      origin: recipeOrigin,
      recipe: page.recipeId,
      recipeRevision: 4,
      route: "passkey",
      detail: "password-empty:no-advance",
      tab: 3,
    };
    expect(entries.map((entry) => [entry.level, entry.fields])).toEqual([
      ["info", { ...fields, outcome: "revoked", ...timing }],
      ["info", { ...fields, outcome: "conflict", ...timing }],
      ["debug", { ...fields, outcome: "not-due" }],
      ["debug", { ...fields, outcome: "not-due", reason: "sent" }],
      ["debug", { ...fields, outcome: "not-sent", reason: "storage-unavailable" }],
      ["warn", { ...fields, outcome: "failed", reason: "rate-limited", ...timing }],
    ]);
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
    const page = {
      tabId: 3,
      origin: recipeOrigin,
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
    };
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "sent",
    });
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "unclear",
      reason: "already-judged",
    });
    // An undecided answer that completed the login is a warning (ADR 0029).
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "unclear",
      completed: true,
    });
    // So is one that did not complete it only because a disabled field was left out.
    log.login({
      type: "judge",
      ...page,
      route: "password",
      verdict: "unclear",
      disabledLeftOut: true,
      notCompleted: "disabled-left-out",
    });
    for (const reason of ["unreachable", "not-connected"])
      log.login({
        type: "judge",
        ...page,
        route: "password",
        verdict: "retry",
        reason,
      });
    // A continuation names the revision it continued and whether the login took it over.
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "recipe",
      recipeId: "synthetic-recipe",
      baseRevision: 1,
      takenOver: true,
    });
    // One not taken over says why, as a code (ADR 0027, amended 2026-10-19).
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "recipe",
      recipeId: "synthetic-recipe",
      baseRevision: 1,
      takenOver: false,
      notTakenOver: "binding-slots-mismatch",
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
      // Read on the sign-in form shown again in a new document (ADR 0029).
      reshown: true,
      decision: "rejected",
    });
    // Why the form was not read as shown again, or no alert beside it counted: codes only.
    log.login({
      type: "state",
      ...page,
      route: "password",
      ...{ ...signs, s2: false, f2: false, e1: false, e2: false, e3: false },
      decision: "unknown",
      reshownMiss: "later-document",
    });
    log.login({
      type: "state",
      ...page,
      route: "password",
      ...{ ...signs, s2: false, f2: false, e1: false, e2: false, e3: false },
      reshown: true,
      decision: "unknown",
      alertMiss: "other-form",
    });
    // A result that settled while the sign-in form still showed says so.
    log.login({
      type: "attempt",
      ...page,
      route: "password",
      state: "reconciling",
      stepIndex: 2,
      stepCount: 2,
      outcome: "unknown-submit",
      cause: "sign-in-shown",
      settled: true,
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
    log.login({
      type: "attempt",
      ...page,
      route: "password",
      state: "authenticated",
      stepIndex: 2,
      stepCount: 2,
      outcome: "authenticated",
      unconfirmed: true,
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
    // A page not sent names why its description was incomplete, as a code.
    log.login({
      type: "generation",
      tabId: 3,
      origin: recipeOrigin,
      outcome: "skipped",
      reason: "incomplete-observation",
      detail: "unlocated-button",
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(23));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    // Every entry the page caused names its tab; those the worker caused name none.
    expect(entries.map((entry) => entry.fields["tab"])).toEqual([
      undefined,
      undefined,
      undefined,
      ...Array.from({ length: 19 }, () => 3),
    ]);
    expect(
      entries.map(({ event, level, fields: { tab: _tab, ...fields } }) => [event, level, fields]),
    ).toEqual([
      // An unchanged sync is a debug entry; one that changed a recipe is info.
      ["service.sync", "debug", { outcome: "synced", scope: "full" }],
      ["service.sync", "info", { outcome: "synced", scope: "recipes", updated: 1 }],
      ["settings.changed", "info", { source: "synced", revision: 7 }],
      // A judgement request is info: it is all that is left when no answer comes.
      [
        "recipe.judge",
        "info",
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
        "recipe.judge",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "unclear",
          completed: true,
        },
      ],
      [
        "recipe.judge",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "unclear",
          disabledLeftOut: true,
          notCompleted: "disabled-left-out",
        },
      ],
      // A request that failed is a problem; with no paired service nothing was sent.
      [
        "recipe.judge",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          verdict: "retry",
          reason: "unreachable",
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
          verdict: "retry",
          reason: "not-connected",
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "recipe",
          recipe: expect.any(String),
          baseRevision: 1,
          takenOver: true,
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "recipe",
          recipe: expect.any(String),
          baseRevision: 1,
          takenOver: false,
          notTakenOver: "binding-slots-mismatch",
        },
      ],
      [
        "login.handler",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
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
          recipeRevision: 1,
          route: "password",
          decision: "rejected",
          s1: true,
          s2: true,
          f2: true,
          reshown: true,
        },
      ],
      [
        "login.state",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          decision: "unknown",
          s1: true,
          reshownMiss: "later-document",
        },
      ],
      [
        "login.state",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          decision: "unknown",
          s1: true,
          reshown: true,
          alertMiss: "other-form",
        },
      ],
      [
        "login.attempt",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          state: "reconciling",
          step: 2,
          steps: 2,
          outcome: "unknown-submit",
          cause: "sign-in-shown",
          settled: true,
        },
      ],
      [
        "login.attempt",
        "warn",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
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
        "login.attempt",
        "info",
        {
          origin: recipeOrigin,
          recipe: expect.any(String),
          recipeRevision: 1,
          route: "password",
          state: "authenticated",
          step: 2,
          steps: 2,
          outcome: "authenticated",
          unconfirmed: true,
        },
      ],
      [
        "login.refused",
        "info",
        { origin: recipeOrigin, reason: "no-route", detail: "binding-not-found" },
      ],
      [
        "recipe.generate",
        "warn",
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
        "warn",
        {
          origin: recipeOrigin,
          outcome: "failed",
          reason: "invalid-output",
          check: "plan",
          detail: "incompatible-role",
        },
      ],
      [
        "recipe.generate",
        "info",
        {
          origin: recipeOrigin,
          outcome: "skipped",
          reason: "incomplete-observation",
          detail: "unlocated-button",
        },
      ],
    ]);
    vi.restoreAllMocks();
  });

  it("logs a pressed sign-in entry, refused ones and blocked revisions at ADR 0019's levels", async () => {
    const recipeOrigin = "https://login.example";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({
        revision: 1,
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
    const entry = {
      type: "entry",
      tabId: 3,
      origin: recipeOrigin,
      recipeId: "synthetic-entry",
      recipeRevision: 2,
      url: `${recipeOrigin}/?return_to=%2Fbookmarks`,
    } as const;
    log.login({ ...entry, outcome: "pressed" });
    log.login({ ...entry, outcome: "refused", reason: "no-return-target" });
    log.login({ ...entry, outcome: "refused", reason: "in-progress" });
    log.login({ ...entry, outcome: "refused", reason: "site-held" });
    log.login({ ...entry, outcome: "refused", reason: "site-held", repeat: true });
    log.login({ ...entry, outcome: "blocked", reason: "sign-up" });
    log.login({ ...entry, outcome: "blocked", reason: "left-site", detail: "storage-unavailable" });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((logged) => logged.event === "login.entry"),
      ).toHaveLength(7),
    );
    const entries = (await log.logger.entries()).filter((logged) => logged.event === "login.entry");
    const fields = {
      origin: recipeOrigin,
      recipe: expect.any(String),
      recipeRevision: 2,
      url: "/?return_to=",
      tab: 3,
    };
    expect(entries.map((logged) => [logged.level, logged.fields])).toEqual([
      ["info", { ...fields, outcome: "pressed" }],
      // ADR 0019's levels: a visit while signed in names no page to return to, and a press
      // another document's check holds is routine; both are debug, as is a repeat.
      ["debug", { ...fields, outcome: "refused", reason: "no-return-target" }],
      ["debug", { ...fields, outcome: "refused", reason: "in-progress" }],
      ["info", { ...fields, outcome: "refused", reason: "site-held" }],
      ["debug", { ...fields, outcome: "refused", reason: "site-held" }],
      ["warn", { ...fields, outcome: "blocked", reason: "sign-up" }],
      [
        "warn",
        { ...fields, outcome: "blocked", reason: "left-site", detail: "storage-unavailable" },
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
      recipeRevision: 1,
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
      recipeRevision: 1,
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
      recipeRevision: 1,
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

  it("shows an unanswered login message without debug logging unless no receiver was left", async () => {
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
    for (const reason of ["no-receiver", "port-closed", "send-failed"])
      log.login({
        type: "attempt",
        tabId: 4,
        origin: "https://login.example",
        recipeId: "synthetic-recipe",
        recipeRevision: 1,
        route: "password",
        state: "reconciling",
        stepIndex: 1,
        stepCount: 2,
        outcome: "unknown-submit",
        cause: "document-gone",
        reason,
      });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(4));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(entries.map((entry) => [entry.level, entry.fields["reason"]])).toEqual([
      ["debug", "no-receiver"],
      ["info", "port-closed"],
      ["info", "send-failed"],
    ]);
    vi.restoreAllMocks();
  });

  it("keeps a login's route change at info, naming why (ADR 0034)", async () => {
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
    const ready = {
      type: "attempt" as const,
      ...site,
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
      state: "ready" as const,
      stepIndex: 0,
    };
    // A step of a running login stays at debug.
    log.login({ ...ready, route: "password", variant: 0, stepCount: 2 });
    log.login({
      ...ready,
      route: "passkey",
      variant: 0,
      stepCount: 1,
      routeChange: "page-request",
    });
    log.login({
      ...ready,
      route: "password",
      variant: 0,
      stepCount: 2,
      routeChange: "sign-in-shown",
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(4));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields["routeChange"]])).toEqual(
      [
        ["login.attempt", "debug", undefined],
        ["login.attempt", "info", "page-request"],
        ["login.attempt", "info", "sign-in-shown"],
      ],
    );
    vi.restoreAllMocks();
  });

  it("names a login's stop before a missing password (ADR 0036)", async () => {
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
    log.login({
      type: "attempt",
      tabId: 4,
      origin: "https://login.example",
      recipeId: "synthetic-email-first",
      recipeRevision: 1,
      route: "password",
      variant: 0,
      state: "watching",
      stepIndex: 2,
      stepCount: 4,
      outcome: "challenge",
      reason: "password-empty",
      stop: "password",
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "login.attempt"),
      ).toHaveLength(1),
    );
    const [entry] = (await log.logger.entries()).filter(
      (logged) => logged.event === "login.attempt",
    );
    expect(entry!.fields).toMatchObject({
      outcome: "challenge",
      reason: "password-empty",
      stop: "password",
    });
    vi.restoreAllMocks();
  });

  it("logs why a move to another origin did not complete a login (ADR 0022)", async () => {
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
    const move = {
      type: "move",
      tabId: 4,
      origin: "https://console.elsewhere.example",
      recipeId: "synthetic-recipe",
      recipeRevision: 2,
      route: "password",
    } as const;
    log.login({ ...move, reason: "page-gone", kept: true });
    log.login({ ...move, reason: "no-factor", frame: true });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "login.move"),
      ).toHaveLength(2),
    );
    const entries = (await log.logger.entries()).filter((logged) => logged.event === "login.move");
    expect(entries.map((entry) => [entry.level, entry.fields])).toEqual([
      [
        "info",
        {
          origin: expect.any(String),
          recipe: expect.any(String),
          recipeRevision: 2,
          route: "password",
          reason: "page-gone",
          kept: true,
          tab: 4,
        },
      ],
      [
        "info",
        {
          origin: expect.any(String),
          recipe: expect.any(String),
          recipeRevision: 2,
          route: "password",
          reason: "no-factor",
          frame: true,
          tab: 4,
        },
      ],
    ]);
    vi.restoreAllMocks();
  });

  it("keeps why an item without a password does not go on to a passkey (ADR 0036)", async () => {
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
    const details = [
      "no-passkey",
      "alternatives",
      "no-password-step",
      "no-advance",
      "fills-lacking",
      "password-field",
      "chooser",
      "frame",
    ].map((why) => `password-empty:${why}`);
    for (const detail of details)
      log.login({
        type: "refused",
        tabId: 4,
        origin: "https://login.example",
        reason: "no-route",
        detail,
      });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "login.refused"),
      ).toHaveLength(details.length),
    );
    const entries = (await log.logger.entries()).filter(
      (logged) => logged.event === "login.refused",
    );
    expect(entries.map((entry) => entry.fields["detail"])).toEqual(details);
    // The page judged at such a login's stop names it (owner, 2026-10-13 05:39 UTC).
    log.login({
      type: "judge",
      tabId: 4,
      origin: "https://login.example",
      recipeId: "gen-synthetic",
      recipeRevision: 2,
      route: "password",
      verdict: "challenge",
      takenOver: true,
      stop: "password",
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "recipe.judge"),
      ).toEqual([
        expect.objectContaining({
          level: "info",
          fields: expect.objectContaining({ verdict: "challenge", stop: "password" }),
        }),
      ]),
    );
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
        recipeRevision: 1,
        route: "password",
        state: "reconciling",
        stepIndex: 1,
        name: "Error",
        message,
        // The message line is dropped; only the extension's own positions are kept.
        stack: `Error: ${message}\n    at send (chrome-extension://${EXTENSION}/background.js:12:34)`,
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
      recipeRevision: 1,
      route: "password",
      state: "reconciling",
      step: 1,
      name: "Error",
      stack: "background.js:12:34",
      tab: 4,
    });
    expect(JSON.stringify(entries)).not.toContain("hunter2");
    vi.restoreAllMocks();
  });

  it("logs each automatic vault check and why a refresh was not sent", async () => {
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
    const connectionId = "50000000-0000-4000-8000-000000000001";
    // A repeated result, such as a sign-in that still needs the password, is only detail.
    const outcomes = [
      "unchanged",
      "synced",
      "deferred",
      "deferred",
      "reauthentication-required",
      "reauthentication-required",
    ] as const;
    outcomes.forEach((outcome, index) =>
      log.vaultCheck({ connectionId, outcome, previous: outcomes[index - 1] }),
    );
    log.vaultRefresh({ connectionId, outcome: "not-sent", cause: "no-refresh-token" });
    log.recipeSync("busy", { scope: "full", added: 0, updated: 0, removed: 0 });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(9));
    const entries = (await log.logger.entries()).filter((entry) => entry.event !== "log.debug");
    expect(
      entries.map((entry) => [
        entry.event,
        entry.level,
        entry.fields["outcome"],
        entry.fields["cause"],
      ]),
    ).toEqual([
      ["vault.check", "debug", "unchanged", undefined],
      ["vault.check", "info", "synced", undefined],
      ["vault.check", "info", "deferred", undefined],
      ["vault.check", "debug", "deferred", undefined],
      ["vault.check", "warn", "reauthentication-required", undefined],
      ["vault.check", "debug", "reauthentication-required", undefined],
      ["vault.refresh", "info", "not-sent", "no-refresh-token"],
      ["service.sync", "info", "busy", undefined],
    ]);
    expect(JSON.stringify(entries)).not.toContain(connectionId);
    vi.restoreAllMocks();
  });

  it("logs a closed tab that stops asking after a logout, with each entry's tab (ADR 0021 D)", async () => {
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
    const origin = "https://login.example";
    log.login({ type: "logout", tabId: 4, origin, clicked: true });
    log.login({ type: "ask-ended", tabId: 4, origin, ask: "logout", cause: "tab-closed" });
    log.login({
      type: "ask-ended",
      tabId: 5,
      origin,
      ask: "rejected",
      cause: "tab-closed",
      elsewhere: true,
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(3));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      ["login.logout", "info", { origin: expect.any(String), clicked: true, tab: 4 }],
      [
        "login.ask-ended",
        "info",
        { origin: expect.any(String), ask: "logout", cause: "tab-closed", tab: 4 },
      ],
      [
        "login.ask-ended",
        "info",
        {
          origin: expect.any(String),
          ask: "rejected",
          cause: "tab-closed",
          elsewhere: true,
          tab: 5,
        },
      ],
    ]);
    // A download keeps the tab, with sites hidden too.
    const exported = formatLogExport(entries, {
      version: "0.1.0",
      revision: "1c42ad3",
      exportedAt: NOW,
      includeSites: false,
    })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["event"] !== undefined);
    expect(exported.map((line) => line["tab"])).toEqual([4, 4, 5]);
    vi.restoreAllMocks();
  });

  it("logs what a page Pateat does not fill showed, and how the tab left it (ADR 0035)", async () => {
    const recipeOrigin = "https://login.example";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({
        revision: 1,
        settings: { connections: [], excludedSites: [], siteDefaults: [], bindings: [] },
      }),
      recipeCache: async () => ({ recipes: [{ origin: recipeOrigin }] }),
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const recipe = { recipeId: "gen-confirm", recipeRevision: 2, pageKind: "confirm" } as const;
    log.login({
      type: "refused",
      tabId: 4,
      origin: recipeOrigin,
      reason: "not-started",
      detail: "confirm-unsupported",
      ...recipe,
      amount: true,
      e1: false,
      e2: false,
      previousUrl: `${recipeOrigin}/transfer?to=12345#step=2`,
      url: `${recipeOrigin}/verify?token=abc`,
    });
    log.login({
      type: "confirm-left",
      tabId: 4,
      origin: recipeOrigin,
      ...recipe,
      personSubmitted: true,
      nextE1: false,
      url: `${recipeOrigin}/verify?token=abc`,
    });
    // A previous page of another origin is never kept.
    log.login({
      type: "refused",
      tabId: 5,
      origin: recipeOrigin,
      reason: "not-started",
      detail: "confirm-unsupported",
      ...recipe,
      e1: true,
      previousUrl: "https://other.example/account",
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(3));
    const entries = await log.logger.entries();
    const common = { origin: recipeOrigin, recipe: "gen-confirm", recipeRevision: 2 };
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      [
        "login.refused",
        "info",
        {
          ...common,
          reason: "not-started",
          detail: "confirm-unsupported",
          pageKind: "confirm",
          amount: true,
          e1: false,
          e2: false,
          previousUrl: "/transfer?to=#step=",
          url: "/verify?token=",
          tab: 4,
        },
      ],
      [
        "login.confirm-left",
        "info",
        {
          ...common,
          pageKind: "confirm",
          personSubmitted: true,
          nextE1: false,
          url: "/verify?token=",
          tab: 4,
        },
      ],
      [
        "login.refused",
        "info",
        {
          ...common,
          reason: "not-started",
          detail: "confirm-unsupported",
          pageKind: "confirm",
          e1: true,
          tab: 5,
        },
      ],
    ]);
    // Hiding sites leaves both URLs out of a download.
    const exported = formatLogExport(entries, {
      version: "0.1.0",
      revision: "1c42ad3",
      exportedAt: NOW,
      includeSites: false,
    });
    expect(exported).not.toContain("/transfer");
    expect(exported).not.toContain("/verify");
    vi.restoreAllMocks();
  });

  it("logs what the popup was told about a tab's account choice, and a rejected logout", async () => {
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
    log.login({
      type: "popup",
      ...site,
      choice: "none",
      recordState: "reconciling",
      recordOutcome: "unknown-submit",
      pageReason: "logged-in",
    });
    log.login({
      type: "logout",
      ...site,
      recipeId: "synthetic-recipe",
      recipeRevision: 4,
      rejected: true,
    });
    log.login({
      type: "popup",
      ...site,
      choice: "offered",
      candidates: 3,
      logout: "rejected",
      pageReason: "logged-out",
    });
    // Another tab of the site, whose popup chooses no account after that rejection.
    log.login({
      type: "popup",
      tabId: 5,
      origin: site.origin,
      choice: "offered",
      candidates: 3,
      logout: "other-tab",
      rejectedElsewhere: true,
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(4));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ["login.popup", "info"],
      ["login.logout", "info"],
      ["login.popup", "info"],
      ["login.popup", "info"],
    ]);
    expect(entries[0]?.fields).toMatchObject({
      choice: "none",
      recordState: "reconciling",
      recordOutcome: "unknown-submit",
      pageReason: "logged-in",
    });
    expect(entries[1]?.fields).toMatchObject({ rejected: true });
    expect(entries[2]?.fields).toMatchObject({
      choice: "offered",
      candidates: 3,
      logout: "rejected",
      pageReason: "logged-out",
    });
    expect(entries[3]?.fields).toMatchObject({ logout: "other-tab", rejectedElsewhere: true });
    vi.restoreAllMocks();
  });

  it("logs a login's start, what a chooser's list showed, the account choice and a logout at info", async () => {
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
      recipeRevision: 4,
      route: "password",
      variant: 0,
      account: "match",
      candidates: 1,
      itemId,
    });
    log.login({ type: "choice", ...site, outcome: "saved" });
    log.login({ type: "logout", ...site, recipeId: "synthetic-recipe", recipeRevision: 4 });
    // A chooser's list on which nothing fits logs what it showed, as counts and codes.
    const chooser = {
      type: "start",
      ...site,
      recipeId: "synthetic-recipe",
      recipeRevision: 4,
      route: "password",
      variant: 0,
      account: "default",
      click: "none",
    } as const;
    log.login({
      ...chooser,
      listMiss: {
        username: "email",
        entries: 0,
        masked: 0,
        sameDomain: 0,
        fits: 0,
        entryMiss: "no-entry",
        beside: 1,
        other: "missing",
        continue: "none",
      },
    });
    log.login({
      ...chooser,
      listMiss: {
        username: "name",
        entries: 3,
        beside: 1,
        named: 2,
        other: "one",
        continue: "many",
      },
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(5));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ["login.start", "info"],
      ["login.choice", "info"],
      ["login.logout", "info"],
      ["login.start", "info"],
      ["login.start", "info"],
    ]);
    expect(entries[0]?.fields).toMatchObject({
      recipeRevision: 4,
      route: "password",
      variant: 0,
      account: "match",
      candidates: 1,
      item: expect.stringMatching(/^item:[0-9a-f]{8}$/),
    });
    expect(entries[2]?.fields).toMatchObject({ recipeRevision: 4 });
    expect(Object.keys(entries[0]!.fields).filter((key) => key.startsWith("list"))).toEqual([]);
    expect(entries[3]?.fields).toMatchObject({
      account: "default",
      list: "none",
      listUsername: "email",
      listEntries: 0,
      listMasked: 0,
      listSameDomain: 0,
      listFits: 0,
      listEntryMiss: "no-entry",
      listBeside: 1,
      listOther: "missing",
      listContinue: "none",
    });
    expect(entries[3]?.fields).not.toHaveProperty("listNamed");
    expect(entries[4]?.fields).toMatchObject({
      list: "none",
      listUsername: "name",
      listEntries: 3,
      listBeside: 1,
      listNamed: 2,
      listOther: "one",
      listContinue: "many",
    });
    for (const key of ["listMasked", "listSameDomain", "listFits", "listEntryMiss"])
      expect(entries[4]?.fields).not.toHaveProperty(key);
    expect(JSON.stringify(entries)).not.toContain(itemId);
    vi.restoreAllMocks();
  });

  it("finds positions only inside this extension", () => {
    expect(
      stackPositions(
        `Error\n    at a (chrome-extension://${EXTENSION}/background.js:1:2)\n    at b (https://site.example/app.js:3:4)`,
      ),
    ).toBe("background.js:1:2");
    expect(stackPositions("Error\n    at b (https://site.example/app.js:3:4)")).toBeUndefined();
    // The message line may quote input that looks like a position.
    expect(
      stackPositions(
        `Error: chrome-extension://${EXTENSION}/secret.js:1:2\n    at https://site.example/app.js:3:4`,
      ),
    ).toBeUndefined();
  });
});
