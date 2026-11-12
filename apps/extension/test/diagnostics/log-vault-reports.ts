import { expect, it, vi } from "vitest";
import { createDefaultSettings } from "@pateat/contracts";
import { createDiagnosticsLog } from "../../src/diagnostics/background";
import { LOG_EVENTS, problemLine } from "../../src/diagnostics/log";
import type { LogTestContext } from "./log-context";

export function registerVaultReportCases({ EXTENSION }: Pick<LogTestContext, "EXTENSION">) {
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
    const itemId = "00000000-0000-4000-8000-000000000002";
    log.vaultSync("connection-secret-id", {
      ok: false,
      error: {
        code: "crypto-failed",
        check: "attachment",
        item: itemId,
        revised: 1_762_720_517_000,
      },
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(4));
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
      [
        "vault.sync",
        "warn",
        {
          connection: entries[0]?.fields["connection"],
          outcome: "crypto-failed",
          check: "attachment",
          item: expect.stringMatching(/^item:[0-9a-f]{8}$/u),
          revised: 1_762_720_517_000,
        },
      ],
    ]);
    expect(JSON.stringify(entries)).not.toContain("connection-secret-id");
    expect(JSON.stringify(entries)).not.toContain(itemId);
    // The service gets the check, never the item's pseudonym or its revision date.
    expect(problemLine(entries[3]!)?.fields).toEqual({
      outcome: "crypto-failed",
      check: "attachment",
    });
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
    const itemId = "00000000-0000-4000-8000-000000000002";
    log.vaultSignIn("begin", {
      ok: false,
      error: { code: "crypto-failed", check: "sdk-decrypt", item: itemId, revised: 1 },
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(7));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      ["vault.sign-in", "info", { step: "begin", outcome: "mfa-required" }],
      ["vault.sign-in", "info", { step: "send-email-code", outcome: "sent" }],
      ["vault.sign-in", "warn", { step: "send-email-code", outcome: "rate-limited" }],
      ["vault.sign-in", "info", { step: "continue", outcome: "code-refused" }],
      ["vault.sign-in", "info", { step: "keep-alive", outcome: "setup-expired" }],
      ["vault.sign-in", "warn", { step: "continue", outcome: "authentication-rejected" }],
      [
        "vault.sign-in",
        "warn",
        {
          step: "begin",
          outcome: "crypto-failed",
          check: "sdk-decrypt",
          item: expect.stringMatching(/^item:[0-9a-f]{8}$/u),
          revised: 1,
        },
      ],
    ]);
    expect(JSON.stringify(entries)).not.toContain(flowId);
    expect(JSON.stringify(entries)).not.toContain(itemId);
    expect(problemLine(entries[6]!)?.fields).toEqual({
      step: "begin",
      outcome: "crypto-failed",
      check: "sdk-decrypt",
    });
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
        settings: {
          connections: [],
          accountPolicies: [],
          itemPolicies: [],
          customFieldReviews: [],
          excludedSites: [],
          passkeyBrowserSites: [],
          repromptSites: [],
          siteDefaults: [],
          bindings: [],
        },
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
        settings: createDefaultSettings({ connections: [] }),
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
    log.login({ ...page, outcome: "not-sent", reason: "paused" });
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
      ["debug", { ...fields, route: "password", outcome: "not-sent", reason: "paused" }],
      ["warn", { ...fields, route: "password", outcome: "failed", reason: "unreachable" }],
    ]);
    vi.restoreAllMocks();
  });

  it("logs a repair claimed for an item that cannot run its recipe (ADR 0058 A) by its outcome", async () => {
    const recipeOrigin = "https://login.example";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({
        revision: 7,
        settings: createDefaultSettings({ connections: [] }),
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
      type: "unfit" as const,
      tabId: 3,
      origin: recipeOrigin,
      recipeId: "gen-0123456789abcdef0123456789abcdef",
      recipeRevision: 4,
      route: "passkey" as const,
      detail: "password-empty:no-advance",
    };
    log.login({ ...page, outcome: "claimed" });
    log.login({ ...page, outcome: "not-due" });
    log.login({ ...page, outcome: "not-due", reason: "not-connected" });
    log.login({ ...page, outcome: "not-sent", reason: "storage-unavailable" });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "recipe.unfit"),
      ).toHaveLength(4),
    );
    const entries = (await log.logger.entries()).filter((entry) => entry.event === "recipe.unfit");
    const fields = {
      origin: recipeOrigin,
      recipe: page.recipeId,
      recipeRevision: 4,
      route: "passkey",
      detail: "password-empty:no-advance",
      tab: 3,
    };
    expect(entries.map((entry) => [entry.level, entry.fields])).toEqual([
      ["info", { ...fields, outcome: "claimed" }],
      ["debug", { ...fields, outcome: "not-due" }],
      ["debug", { ...fields, outcome: "not-due", reason: "not-connected" }],
      ["warn", { ...fields, outcome: "not-sent", reason: "storage-unavailable" }],
    ]);
    vi.restoreAllMocks();
  });
}
