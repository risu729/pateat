import { expect, it, vi } from "vitest";
import { createDefaultSettings } from "@pateat/contracts";
import { createDiagnosticsLog } from "../../src/diagnostics/background";
import { TRUNCATED } from "../../src/diagnostics/log";
import type { LogTestContext } from "./context";

export function registerFieldCases({ NOW, setup }: Pick<LogTestContext, "NOW" | "setup">) {
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
      reason: "paused",
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
      { origin: "https://login.excluded.example", reason: "paused" },
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

  it("names a site whose passkey requests go to the browser, as it names an excluded one", async () => {
    const settings = createDefaultSettings({ connections: [] });
    settings.passkeyBrowserSites = [{ hostname: "login.example" }];
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({ version: 1, revision: 1, settings }),
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    for (const origin of ["https://login.example", "https://sub.login.example"])
      log.passkeyCreate({
        tabId: 4,
        origin,
        outcome: "delegate",
        reason: "browser-site",
        rpId: "login.example",
        mediation: "other",
        excludeCredentials: 0,
      });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "passkey.create"),
      ).toHaveLength(2),
    );
    const origins = (await log.logger.entries())
      .filter((entry) => entry.event === "passkey.create")
      .map((entry) => entry.fields["origin"]);
    // The exact hostname only, without its subdomains.
    expect(origins).toEqual(["https://login.example", expect.stringMatching(/^origin:/u)]);
    vi.restoreAllMocks();
  });
}
