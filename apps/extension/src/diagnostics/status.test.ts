import { describe, expect, it, vi } from "vitest";
import type { SetupReply } from "../connections/types";
import type { VaultEntry, VaultResult } from "../vault/record";
import { createPseudonyms } from "./pseudonym";
import { formatReport, vaultTimeoutText } from "./report";
import {
  DIAGNOSTICS_TIMEOUT_MS,
  collectDiagnostics,
  createDiagnosticsHandler,
  type DiagnosticsDependencies,
} from "./status";
import { diagnosticsStatusSchema, parseDiagnosticsResponse } from "./wire";
import * as v from "valibot";

// Runs in Chromium (vitest browser mode) for IndexedDB and WebCrypto.
const NOW = Date.UTC(2026, 9, 11, 9, 30);
const CONNECTION_ID = "4b0b5a8e-0d7e-4c55-9a43-5b8e3c0f6a11";
const SECRET_EMAIL = "owner@example.test";
const SECRET_LABEL = "Owner private vault";
const SERVICE_ORIGIN = "https://pateat.private.example";

const server = async () =>
  ({ ok: true, data: { version: "2026.9.2", kind: "bitwarden" } }) as const;

const setupStatus = (
  overrides: Partial<Extract<SetupReply, { kind: "status" }>["connections"][number]> = {},
): SetupReply => ({
  ok: true,
  kind: "status",
  connections: [
    {
      connectionId: CONNECTION_ID,
      label: SECRET_LABEL,
      email: SECRET_EMAIL,
      environment: { kind: "self-hosted", baseUrl: "https://vault.private.example" },
      autoUnlock: "enabled",
      state: "ready",
      providerSession: "active",
      snapshotId: "0c7f3a4e-58d5-4d3b-9a7e-3e1d7f9b2c55",
      ...overrides,
    },
  ],
});

function record(): VaultResult<VaultEntry | null> {
  return {
    ok: true,
    data: {
      schemaVersion: 1,
      revision: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      profile: {
        connectionId: CONNECTION_ID,
        environment: { kind: "self-hosted", baseUrl: "https://vault.private.example" },
      },
      state: "active",
      userKey: "c2VjcmV0",
      accepted: {
        recordId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        snapshotId: "0c7f3a4e-58d5-4d3b-9a7e-3e1d7f9b2c55",
        userId: "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        accountVersion: "v2",
        minimumSecurityVersion: 2,
        acceptedAt: NOW - 25 * 60_000,
        coverage: "received-envelope",
        prepared: {
          kdf: { pBKDF2: { iterations: 600_000 } },
          unavailableItems: [{ itemId: "x", reason: "unsupported-cipher-type" }],
          ciphers: [
            { type: 1, name: "2.secret-name", login: { totp: "2.secret-totp" } },
            { type: 1, login: { fido2Credentials: [{ credentialId: "2.secret" }] } },
            { type: 2, notes: "2.secret-note" },
            { type: 1, deletedDate: "2026-10-01T00:00:00Z", login: { totp: "2.secret" } },
          ],
        },
      } as never,
    },
  };
}

function dependencies(overrides: Partial<DiagnosticsDependencies> = {}): DiagnosticsDependencies {
  return {
    build: {
      version: "0.1.0",
      revision: "1c42ad3b9f0e8d7c6b5a4f3e2d1c0b9a8f7e6d5c",
      mode: "production",
      bitwardenSdk: "0.2.0-main.1099",
      bitwardenProtocol: "client 2026.2.0, Device-Type 2",
    },
    now: () => NOW,
    pseudonym: createPseudonyms({ databaseName: `diagnostics-test-${crypto.randomUUID()}` }),
    platform: async () => ({ os: "win", arch: "x86-64" }),
    permissions: async () => ({
      permissions: ["storage", "offscreen"],
      origins: ["https://*/*", "https://vault.private.example/*"],
    }),
    declaredOrigins: ["https://*/*"],
    hasAllSiteAccess: async () => true,
    connections: {
      status: async () => setupStatus(),
      read: async () => record(),
      server,
      check: async () => ({ checkedAt: NOW - 120_000, outcome: "unchanged" as const }),
    },
    cryptoHost: () => ({ ready: true, sessions: 1 }),
    actionIcon: async () => "unlocked",
    serviceState: async () => ({
      kind: "connected",
      origin: SERVICE_ORIGIN,
      label: "Owner laptop",
      deviceId: "dev_secret",
      syncedAt: NOW - 10 * 60_000,
    }),
    serviceOrigin: async () => SERVICE_ORIGIN,
    hasSiteAccess: async () => true,
    serviceDevice: async () => ({
      kind: "state",
      state: {
        version: 1,
        pairedAt: NOW - 3 * 24 * 60 * 60_000,
        recipes: 2,
        settingsRevision: 57,
        generation: "credentials-not-configured",
      },
    }),
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json(
        { status: "ok", service: "pateat-api", revision: "1c42ad3" },
        { headers: { Date: new Date(NOW + 95_000).toUTCString() } },
      ),
    ),
    settings: async () =>
      ({
        connections: [],
        excludedSites: [{ origin: "https://excluded.example" }],
        siteDefaults: [],
        bindings: [],
        passkeyBrowserSites: [{ hostname: "bank.example" }],
      }) as never,
    logs: async () => ({ entries: 120, bytes: 18_000, recentErrors: 2, recentWarnings: 3 }),
    recentLog: async () => ({
      problems: [
        "2026-10-11T09:20Z warn login.attempt site-1 recipe-1 blocked structural-mismatch",
      ],
      updated: { time: NOW - 3 * 60 * 60_000, from: "9cf8356de6a0cf2c82dae5c4e70f15ea3dbc5d4b" },
      passkeyDelegations: [
        { reason: "no-credential", count: 3 },
        { reason: "ambiguous-credential", count: 1 },
      ],
      unsentVerifications: [
        { reason: "frame", count: 2 },
        { reason: "text-answer", count: 1 },
      ],
    }),
    storage: {
      localBytes: async () => 412 * 1024,
      recipeCache: async () => ({ version: 1, recipes: [{ id: "bank-signin" }] }),
      recipeSchedule: async () => ({ version: 1, startedAt: NOW, retryAt: NOW + 300_000 }),
      settingsBase: async () => ({ version: 1, revision: 57 }),
      settingsHold: async () => undefined,
    },
    ...overrides,
  };
}

describe("diagnostics status", () => {
  it("reports states and counts with no names, emails, hosts or IDs", async () => {
    const deps = dependencies();
    const status = await collectDiagnostics(deps);
    expect(v.is(diagnosticsStatusSchema, status)).toBe(true);
    const [connection] = status.connections;
    expect(connection).toMatchObject({
      id: expect.stringMatching(/^bitwarden:[0-9a-f]{6}$/u),
      environment: "self-hosted",
      state: "ready",
      acceptedAt: NOW - 25 * 60_000,
      items: { total: 3, login: 2, totp: 1, passkey: 1, unsupported: 1 },
      unlockKdf: "PBKDF2-SHA256 600000",
    });
    expect(status.permissions).toEqual({
      permissions: ["storage", "offscreen"],
      origins: ["https://*/*"],
      otherOrigins: 1,
    });
    expect(status.service).toMatchObject({
      kind: "connected",
      siteAccess: true,
      settingsRevision: 57,
      recipes: { count: 1 },
      nextSyncAt: NOW + 300_000,
      health: { ok: true, revision: "1c42ad3" },
      device: {
        ok: true,
        pairedAt: NOW - 3 * 24 * 60 * 60_000,
        recipes: 2,
        settingsRevision: 57,
        generation: "credentials-not-configured",
      },
    });
    expect(status.checks).toContainEqual({
      id: "service-copy",
      level: "info",
      detail: "service 2 recipes, cached 1",
    });
    expect(status.checks).toContainEqual({
      id: "generation",
      level: "info",
      detail:
        "recipe generation off, no Claude credentials on the service (credentials-not-configured)",
    });
    expect(status.settings).toEqual({
      excludedSites: 1,
      allowedSites: 0,
      allowedSitesEnabled: false,
      siteDefaults: 0,
      bindings: 0,
      passkeyBrowserSites: 1,
    });
    expect(status.checks).toContainEqual({
      id: "clock",
      level: "warn",
      detail: "clock 95 s behind the service",
    });
    expect(status.logs).toEqual({
      entries: 120,
      bytes: 18_000,
      recentErrors: 2,
      recentWarnings: 3,
    });
    expect(status.checks).toContainEqual({
      id: `vault-age:${connection!.id}`,
      level: "info",
      detail: `${connection!.id} vault synced 25 min ago; checked 2 min ago: unchanged`,
    });
    expect(status.checks).toContainEqual({
      id: "logs",
      level: "warn",
      detail: "2 errors, 3 warnings logged in the last 24 h",
    });
    const [url, init] = vi.mocked(deps.fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe(`${SERVICE_ORIGIN}/health`);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    const serialized = JSON.stringify(status);
    for (const secret of [
      CONNECTION_ID,
      SECRET_EMAIL,
      SECRET_LABEL,
      "private.example",
      "secret",
      "bank-signin",
      "excluded.example",
      "Owner laptop",
      "dev_secret",
      "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "0c7f3a4e-58d5-4d3b-9a7e-3e1d7f9b2c55",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("shows a sync as due now when the clock moved back", async () => {
    // Sync treats a schedule started in the future as due now, so diagnostics agrees.
    const deps = dependencies({
      storage: {
        ...dependencies().storage,
        recipeSchedule: async () => ({
          version: 1,
          startedAt: NOW + 24 * 60 * 60_000,
          retryAt: NOW + 24 * 60 * 60_000 + 300_000,
        }),
      },
    });
    const status = await collectDiagnostics(deps);
    expect(status.service).toMatchObject({ kind: "connected", nextSyncAt: NOW });
  });

  it("keeps a pseudonym stable for one key and copies only the KDF family", async () => {
    const deps = dependencies();
    const first = await collectDiagnostics(deps);
    const second = await collectDiagnostics(deps);
    expect(second.connections[0]?.id).toBe(first.connections[0]?.id);
    const report = formatReport(first, {
      name: "Chrome",
      version: "154.0.7712.45",
      installType: "normal",
    });
    expect(report).toContain(
      "Pateat 0.1.0 (1c42ad3) · production build · Web Store install (normal)",
    );
    expect(report).toContain("· sync sign-in active ·");
    expect(report).toContain("Permissions: storage, offscreen, https://*/* + 1 granted site\n");
    expect(report).toContain("warn clock 95 s behind the service");
    expect(report).toContain("3 items (login 2, TOTP 1, passkey 1) + 1 unsupported");
    // The KDF family is copied; its parameters stay on the page.
    expect(report).toContain("· KDF PBKDF2 ·");
    expect(report).toContain("self-hosted · Bitwarden server 2026.9.2 · ready");
    expect(report).not.toContain("600000");
    expect(report).toContain(
      "Updated 2026-10-11T06:30Z from 9cf8356\nRecent problems (24 h, newest first):\n  2026-10-11T09:20Z warn login.attempt site-1 recipe-1 blocked structural-mismatch\nPasskey delegations (24 h): no-credential 3 · ambiguous-credential 1\nVerification pages not sent (24 h): frame 2 · text-answer 1\n",
    );
  });

  it("explains an expired sync token that the next Sync tries to renew", async () => {
    const collect = (autoUnlock: "enabled" | "disabled", state?: "locked" | "ready") =>
      collectDiagnostics(
        dependencies({
          connections: {
            status: async () =>
              setupStatus({
                providerSession: "refresh-required",
                autoUnlock,
                ...(state ? { state } : {}),
              }),
            read: async () => record(),
            server,
            check: async () => undefined,
          },
        }),
      );
    const status = await collect("enabled");
    const id = status.connections[0]!.id;
    expect(status.checks).toContainEqual({
      id: `sync:${id}`,
      level: "ok",
      detail: `${id} sync sign-in kept, next Sync tries to renew it (refresh-required)`,
    });
    expect(
      formatReport(status, { name: "Chrome", version: "156", installType: "development" }),
    ).toMatch(
      /^Pateat .* · unpacked install \(development\)\n[\s\S]*sync sign-in kept, next Sync tries to renew it \(refresh-required\)/u,
    );
    // Sync needs the vault's key: kept on disk, or in memory while it is unlocked (ADR 0075).
    expect(v.is(diagnosticsStatusSchema, status)).toBe(true);
    const session = await collect("disabled", "ready");
    expect(session.checks).toContainEqual({
      id: `sync:${session.connections[0]!.id}`,
      level: "ok",
      detail: `${session.connections[0]!.id} sync sign-in kept, next Sync tries to renew it (refresh-required)`,
    });
    const manual = await collect("disabled", "locked");
    expect(v.is(diagnosticsStatusSchema, manual)).toBe(true);
    const manualId = manual.connections[0]!.id;
    expect(manual.checks).toContainEqual({
      id: `sync:${manualId}`,
      level: "info",
      detail: `${manualId} sync sign-in kept, next Sync tries to renew it (refresh-required); Sync needs the vault unlocked`,
    });
  });

  it("checks the service only with site access and reports failures by code", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const withheld = await collectDiagnostics(
      dependencies({ hasSiteAccess: async () => false, fetch }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(withheld.service.health).toEqual({ ok: false, error: "no-site-access" });
    const failed = await collectDiagnostics(
      dependencies({ fetch: async () => new Response("down", { status: 503 }) }),
    );
    expect(failed.checks).toContainEqual({ id: "service", level: "error", detail: "health 503" });
    // A revision that is not a commit-like token, such as a host name with a path, is refused.
    const odd = await collectDiagnostics(
      dependencies({
        fetch: async () =>
          Response.json({
            status: "ok",
            service: "pateat-api",
            revision: "https://host.example/x",
          }),
      }),
    );
    expect(odd.service.health).toEqual({ ok: false, error: "invalid-response" });
  });

  it("reads the service record only with site access and an accepted credential", async () => {
    const serviceDevice = vi.fn<DiagnosticsDependencies["serviceDevice"]>(async () => ({
      kind: "state",
      state: {
        version: 1,
        pairedAt: NOW - 60 * 60_000,
        recipes: 1,
        settingsRevision: 57,
        generation: "daily-limit",
      },
    }));
    const status = await collectDiagnostics(dependencies({ serviceDevice }));
    expect(serviceDevice).toHaveBeenCalledWith(SERVICE_ORIGIN);
    expect(status.checks).toContainEqual({
      id: "service-copy",
      level: "ok",
      detail: "recipes and settings match the service",
    });
    expect(status.checks).toContainEqual({
      id: "generation",
      level: "warn",
      detail: "recipe generation stopped for today (daily-limit)",
    });
    const report = formatReport(status, { name: "Chrome", version: "156", installType: "normal" });
    expect(report).toContain(
      "Service record: paired 2026-10-11T08:30Z · 1 recipe · settings revision 57 · recipe generation stopped for today (daily-limit)",
    );
    expect(report).toContain("  warn recipe generation stopped for today (daily-limit)");

    serviceDevice.mockClear();
    const withheld = await collectDiagnostics(
      dependencies({ serviceDevice, hasSiteAccess: async () => false }),
    );
    expect(withheld.service.device).toBeUndefined();
    // A credential the service already refused is not sent again.
    const rejected = await collectDiagnostics(
      dependencies({
        serviceDevice,
        serviceState: async () => ({
          kind: "connected",
          origin: SERVICE_ORIGIN,
          label: "Owner laptop",
          deviceId: "dev_secret",
          rejected: true,
        }),
      }),
    );
    expect(rejected.service.device).toBeUndefined();
    expect(serviceDevice).not.toHaveBeenCalled();

    const behind = await collectDiagnostics(
      dependencies({
        storage: {
          ...dependencies().storage,
          settingsBase: async () => undefined,
        },
      }),
    );
    expect(behind.checks).toContainEqual({
      id: "service-copy",
      level: "info",
      detail: "service 2 recipes, cached 1; settings revision service 57, here 0",
    });

    for (const [result, error] of [
      [{ kind: "rejected" }, "rejected"],
      [{ kind: "failed", error: "unreachable" }, "unreachable"],
      [{ kind: "failed", error: "rate-limited" }, "rate-limited"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const failed = await collectDiagnostics(dependencies({ serviceDevice: async () => result }));
      expect(v.is(diagnosticsStatusSchema, failed)).toBe(true);
      expect(failed.service.device).toEqual({ ok: false, error });
      expect(failed.checks.find((check) => check.id === "service-record")?.level).toBe("warn");
    }
    const thrown = await collectDiagnostics(
      dependencies({
        serviceDevice: async () => {
          throw new Error("storage");
        },
      }),
    );
    expect(thrown.service.device).toEqual({ ok: false, error: "unavailable" });
    expect(
      formatReport(thrown, { name: "Chrome", version: "156", installType: "normal" }),
    ).toContain("Service record: service record not read (unavailable)");
  });

  it("counts the allowed sites and says whether they are on, never naming them (ADR 0077)", async () => {
    const browser = { name: "Chrome", version: "156", installType: "normal" };
    const off = await collectDiagnostics(dependencies());
    expect(formatReport(off, browser)).toContain(
      "\nSettings: excluded sites 1 · allowed sites 0 (off) · site defaults 0 · bindings 0 · passkey browser sites 1\n",
    );
    const on = await collectDiagnostics(
      dependencies({
        settings: async () =>
          ({
            connections: [],
            accountPolicies: [],
            itemPolicies: [],
            customFieldReviews: [],
            excludedSites: [],
            repromptSites: [],
            passkeyBrowserSites: [],
            allowedSites: [
              { hostname: "bank.example", includeSubdomains: false },
              { hostname: "mail.example", includeSubdomains: true },
            ],
            allowedSitesEnabled: true,
            siteDefaults: [],
            bindings: [],
          }) as never,
      }),
    );
    expect(on.settings).toMatchObject({ allowedSites: 2, allowedSitesEnabled: true });
    const report = formatReport(on, browser);
    expect(report).toContain("· allowed sites 2 (on) ·");
    expect(report).not.toContain("bank.example");
    expect(report).not.toContain("mail.example");
  });

  it("reports the vault timeout and a locked vault (ADR 0075)", async () => {
    const browser = { name: "Chrome", version: "156", installType: "normal" };
    const status = await collectDiagnostics(
      dependencies({
        vaultTimeout: async () => ({ timeout: 15, action: "lock" }),
        connections: {
          status: async () => setupStatus({ state: "locked", autoUnlock: "disabled" }),
          read: async () => record(),
          server,
          check: async () => undefined,
        },
      }),
    );
    expect(status.vaultTimeout).toEqual({ timeout: 15, action: "lock" });
    expect(v.is(diagnosticsStatusSchema, status)).toBe(true);
    const id = status.connections[0]?.id ?? "";
    expect(status.connections[0]?.state).toBe("locked");
    expect(status.checks).toContainEqual({
      id: `vault:${id}`,
      level: "info",
      detail: `${id} locked`,
    });
    expect(formatReport(status, browser)).toContain("\nVault timeout: 15 min · lock\n");
    for (const [vaultTimeout, line] of [
      [{ timeout: "system-idle", action: "log-out" }, "Vault timeout: system-idle · log-out"],
      [{ timeout: "never", action: "lock" }, "Vault timeout: never · lock"],
      [{ timeout: 525_600, action: "log-out" }, "Vault timeout: 525600 min · log-out"],
    ] as const)
      expect(formatReport({ ...status, vaultTimeout }, browser)).toContain(line);
    expect(vaultTimeoutText({ timeout: "restart", action: "lock" }, (code) => `<${code}>`)).toBe(
      "<restart> · <lock>",
    );
    expect(vaultTimeoutText({ timeout: 30, action: "log-out" }, (code) => `<${code}>`)).toBe(
      "30 min · <log-out>",
    );
  });

  it("leaves the vault timeout out when it cannot be read", async () => {
    for (const vaultTimeout of [undefined, async () => Promise.reject(new Error("storage"))]) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const status = await collectDiagnostics(dependencies(vaultTimeout ? { vaultTimeout } : {}));
      expect(status).not.toHaveProperty("vaultTimeout");
      expect(v.is(diagnosticsStatusSchema, status)).toBe(true);
      expect(
        formatReport(status, { name: "Chrome", version: "156", installType: "normal" }),
      ).not.toContain("Vault timeout");
    }
  });

  it("refuses a summary with a damaged vault timeout", async () => {
    const status = await collectDiagnostics(dependencies());
    for (const vaultTimeout of [
      { timeout: 0, action: "lock" },
      { timeout: "immediately", action: "lock" },
      { timeout: 15, action: "lock", key: "c2VjcmV0" },
    ])
      expect(v.is(diagnosticsStatusSchema, { ...status, vaultTimeout })).toBe(false);
  });

  it("names a vault storage failure and an expired sign-in", async () => {
    const status = await collectDiagnostics(
      dependencies({
        connections: {
          status: async () =>
            setupStatus({ state: "unavailable", providerSession: "reauthentication-required" }),
          read: async () => ({ ok: false, error: { code: "invalid-cache-record" } }),
          server,
          check: async () => undefined,
        },
      }),
    );
    const id = status.connections[0]?.id ?? "";
    expect(status.checks).toContainEqual({
      id: `vault:${id}`,
      level: "error",
      detail: `${id} invalid-cache-record`,
    });
    expect(status.checks).toContainEqual({
      id: `sync:${id}`,
      level: "warn",
      detail: `${id} sync sign-in needs the password (reauthentication-required)`,
    });
    expect(status.connections[0]?.items).toBeUndefined();
  });

  it.each([
    [24 * 60 * 60_000, "ok", "recipes synced in the last 24 h"],
    [24 * 60 * 60_000 + 1, "warn", "recipe sync overdue by 0 hr"],
    [25 * 60 * 60_000 - 1, "warn", "recipe sync overdue by 0 hr"],
    [25 * 60 * 60_000, "warn", "recipe sync overdue by 1 hr"],
    [72 * 60 * 60_000, "warn", "recipe sync overdue by 48 hr"],
  ])("keeps recipe sync hour boundaries at age %i ms", async (elapsed, level, detail) => {
    const status = await collectDiagnostics(
      dependencies({
        serviceState: async () => ({
          kind: "connected",
          origin: SERVICE_ORIGIN,
          label: "x",
          deviceId: "dev_x",
          syncedAt: NOW - elapsed,
        }),
      }),
    );
    expect(status.checks).toContainEqual({ id: "recipe-sync", level, detail });
  });

  it("flags withheld site access, an overdue sync and an unpaired service", async () => {
    const overdue = await collectDiagnostics(
      dependencies({
        hasAllSiteAccess: async () => false,
        serviceState: async () => ({
          kind: "connected",
          origin: SERVICE_ORIGIN,
          label: "x",
          deviceId: "dev_x",
          syncedAt: NOW - 27 * 60 * 60_000,
        }),
      }),
    );
    expect(overdue.checks).toContainEqual({
      id: "site-access",
      level: "error",
      detail: "https://*/* or http://*/* site access withheld",
    });
    expect(overdue.checks).toContainEqual({
      id: "recipe-sync",
      level: "warn",
      detail: "recipe sync overdue by 3 hr",
    });
    const unpaired = await collectDiagnostics(
      dependencies({ serviceState: async () => ({ kind: "disconnected" }) }),
    );
    expect(unpaired.service).toEqual({ kind: "not-configured" });
    const unreadable = await collectDiagnostics(
      dependencies({
        logs: async () => {
          throw new Error("storage-failed");
        },
      }),
    );
    expect(unreadable.logs).toBeUndefined();
    expect(unreadable.checks).toContainEqual({
      id: "logs",
      level: "error",
      detail: "logs unreadable",
    });
    // A login that did not finish is a warning, so the summary does not read as all clear.
    const warned = await collectDiagnostics(
      dependencies({
        logs: async () => ({ entries: 9, bytes: 900, recentErrors: 0, recentWarnings: 1 }),
      }),
    );
    expect(warned.checks).toContainEqual({
      id: "logs",
      level: "info",
      detail: "0 errors, 1 warning logged in the last 24 h",
    });
    expect(unpaired.checks).toContainEqual({
      id: "service",
      level: "info",
      detail: "Pateat service not paired",
    });
  });

  it("shows item counts only while unlocked and formats an Argon2id KDF", async () => {
    const argon = record();
    if (argon.ok && argon.data?.accepted)
      (argon.data.accepted.prepared as unknown as { kdf: unknown }).kdf = {
        argon2id: { iterations: 3, memory: 64, parallelism: 4 },
      };
    const status = await collectDiagnostics(
      dependencies({
        connections: {
          status: async () => setupStatus({ state: "configured" }),
          read: async () => argon,
          server,
          check: async () => undefined,
        },
      }),
    );
    expect(status.connections[0]?.items).toBeUndefined();
    expect(status.connections[0]?.unlockKdf).toBe("Argon2id m=64 MiB t=3 p=4");
    expect(status.connections[0]?.kdfType).toBe("Argon2id");
  });

  it("reads the Bitwarden server config only for enabled connections", async () => {
    const reads = vi.fn(server);
    const enabled = await collectDiagnostics(
      dependencies({
        connections: {
          status: async () => setupStatus(),
          read: async () => record(),
          server: reads,
          check: async () => undefined,
        },
      }),
    );
    const id = enabled.connections[0]!.id;
    expect(enabled.connections[0]?.server).toEqual({
      ok: true,
      version: "2026.9.2",
      kind: "bitwarden",
    });
    expect(enabled.checks).toContainEqual({
      id: `server:${id}`,
      level: "ok",
      detail: `${id} Bitwarden server 2026.9.2`,
    });
    expect(reads).toHaveBeenCalledWith(CONNECTION_ID);
    reads.mockClear();
    const disabled = await collectDiagnostics(
      dependencies({
        connections: {
          status: async () => setupStatus({ state: "disabled" }),
          read: async () => record(),
          server: reads,
          check: async () => undefined,
        },
      }),
    );
    expect(reads).not.toHaveBeenCalled();
    expect(disabled.connections[0]?.server).toBeUndefined();
  });

  it("names a compatible server and reports config failures by code", async () => {
    const collect = (
      result: Awaited<ReturnType<DiagnosticsDependencies["connections"]["server"]>>,
    ) =>
      collectDiagnostics(
        dependencies({
          connections: {
            status: async () => setupStatus(),
            read: async () => record(),
            server: async () => result,
            check: async () => undefined,
          },
        }),
      );
    const vaultwarden = await collect({
      ok: true,
      data: { version: "2025.12.0", kind: "vaultwarden" },
    });
    expect(
      formatReport(vaultwarden, { name: "Chrome", version: "156", installType: "normal" }),
    ).toContain("self-hosted · Vaultwarden, compatible with Bitwarden 2025.12.0 · ready");
    for (const [result, detail] of [
      [{ ok: false, error: { code: "timeout" } }, "server config failed (timeout)"],
      [
        { ok: false, error: { code: "http-error", status: 404 } },
        "server config failed (http-error 404)",
      ],
      [
        { ok: false, error: { code: "provider-permission-required" } },
        "server not checked (no-site-access)",
      ],
      [{ ok: false, error: { code: "Not A Code" } }, "server config failed (unavailable)"],
      [undefined, "server config failed (unavailable)"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const status = await collect(result);
      const id = status.connections[0]!.id;
      expect(v.is(diagnosticsStatusSchema, status)).toBe(true);
      expect(status.checks).toContainEqual({
        id: `server:${id}`,
        level: "warn",
        detail: `${id} ${detail}`,
      });
    }
  });

  it("rejects a summary with any field the page must not receive", () => {
    const valid = {
      version: 1,
      collectedAt: NOW,
      build: {
        version: "0.1.0",
        revision: "development",
        mode: "production",
        bitwardenSdk: "0.2.0-main.1099",
        bitwardenProtocol: "client 2026.2.0, Device-Type 2",
      },
      platform: { os: "linux", arch: "x86-64" },
      permissions: { permissions: [], origins: [], otherOrigins: 0 },
      actionIcon: "locked",
      cryptoHost: { ready: false, sessions: 0 },
      connections: [
        {
          id: "bitwarden:5c1e9a",
          environment: "cloud-us",
          state: "ready",
          autoUnlock: "enabled",
          providerSession: "active",
        },
      ],
      service: { kind: "not-configured" },
      storage: {},
      checks: [],
    };
    const response = (status: unknown) => ({ ok: true, status });
    expect(parseDiagnosticsResponse(response(valid)).ok).toBe(true);
    const [entry] = valid.connections;
    for (const status of [
      { ...valid, email: SECRET_EMAIL },
      { ...valid, connections: [{ ...entry, label: SECRET_LABEL }] },
      { ...valid, connections: [{ ...entry, id: CONNECTION_ID }] },
      { ...valid, service: { kind: "connected", origin: SERVICE_ORIGIN } },
      {
        ...valid,
        service: {
          kind: "connected",
          device: {
            ok: true,
            pairedAt: NOW,
            recipes: 1,
            settingsRevision: 1,
            generation: "ok",
            deviceId: "dev_secret",
          },
        },
      },
      { ...valid, platform: { os: "linux", arch: "x86-64", nacl_arch: "x86-64" } },
    ])
      expect(() => parseDiagnosticsResponse(response(status))).toThrow();
  });

  it("answers unavailable when collection stalls", async () => {
    vi.useFakeTimers();
    try {
      const pending = createDiagnosticsHandler(
        dependencies({ settings: () => new Promise(() => undefined) }),
      )();
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ ok: false, error: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers unavailable instead of rejecting", async () => {
    const handler = createDiagnosticsHandler(
      dependencies({
        cryptoHost: () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(handler()).resolves.toEqual({ ok: false, error: "unavailable" });
  });
});
