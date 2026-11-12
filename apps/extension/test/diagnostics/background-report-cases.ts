import { expect, it, vi } from "vitest";
import { createDiagnosticsLog } from "../../src/diagnostics/background";
import { LOG_EVENTS } from "../../src/diagnostics/log";

export function registerBackgroundReportCases() {
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
    log.loginOutcome({ recipeId: "gen-0123", revision: 3, branch: "1000", result: "kept" });
    log.loginOutcome({
      recipeId: "gen-0123",
      revision: 4,
      branch: "1000",
      result: "failed:unreachable",
    });
    log.loginOutcome({
      recipeId: "gen-0123",
      revision: 5,
      branch: "1000:other",
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
      {
        level: "info",
        fields: { recipe: "gen-0123", recipeRevision: 3, branch: "1000", result: "kept" },
      },
      {
        level: "info",
        fields: {
          recipe: "gen-0123",
          recipeRevision: 4,
          branch: "1000",
          result: "failed:unreachable",
        },
      },
      {
        level: "warn",
        fields: {
          recipe: "gen-0123",
          recipeRevision: 5,
          branch: "1000:other",
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
    log.loginRecord({ recipeId: "gen-0123", revision: 3, branch: "1000", result: "kept" });
    log.loginRecord({
      recipeId: "gen-0123",
      revision: 3,
      branch: "1000:other",
      result: "refused",
    });
    log.loginRecord({
      recipeId: "gen-0123",
      revision: 4,
      branch: "1000",
      result: "failed:invalid-record",
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "service.login"),
      ).toHaveLength(3),
    );
    const entries = (await log.logger.entries()).filter((entry) => entry.event === "service.login");
    expect(entries.map(({ level, fields }) => ({ level, fields }))).toEqual([
      {
        level: "info",
        fields: { recipe: "gen-0123", recipeRevision: 3, branch: "1000", result: "kept" },
      },
      // A service without the route refuses it; that is expected, not a problem.
      {
        level: "info",
        fields: { recipe: "gen-0123", recipeRevision: 3, branch: "1000:other", result: "refused" },
      },
      {
        level: "warn",
        fields: {
          recipe: "gen-0123",
          recipeRevision: 4,
          branch: "1000",
          result: "failed:invalid-record",
        },
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
    log.recipeUse({ recipeId: "gen-0123", layout: "1000", revision: 3, result: "kept" });
    log.recipeUse({
      recipeId: "gen-0123",
      layout: "1000",
      revision: 4,
      result: "failed:unreachable",
    });
    await vi.waitFor(async () => expect(await uses()).toHaveLength(1));
    await log.logger.enableDebug();
    log.recipeUse({ recipeId: "gen-0123", layout: "1000", revision: 3, result: "kept" });
    // A recipe revoked meanwhile, or a service without the route, refuses it.
    log.recipeUse({ recipeId: "gen-0123", layout: "1000", revision: 5, result: "refused" });
    log.recipeUse({ recipeId: "gen-0123", layout: "1000", revision: 6, result: "rejected" });
    log.recipeUse({
      recipeId: "gen-0123",
      layout: "1000",
      revision: 7,
      result: "failed:unexpected-response",
    });
    log.recipeUse({ recipeId: "gen-0123", layout: "1000", revision: 8, result: "failed:threw" });
    await vi.waitFor(async () => expect(await uses()).toHaveLength(6));
    expect((await uses()).map(({ level, fields }) => ({ level, fields }))).toEqual([
      {
        level: "info",
        fields: {
          recipe: "gen-0123",
          recipeRevision: 4,
          layout: "1000",
          result: "failed:unreachable",
        },
      },
      {
        level: "debug",
        fields: { recipe: "gen-0123", recipeRevision: 3, layout: "1000", result: "kept" },
      },
      {
        level: "debug",
        fields: { recipe: "gen-0123", recipeRevision: 5, layout: "1000", result: "refused" },
      },
      {
        level: "warn",
        fields: { recipe: "gen-0123", recipeRevision: 6, layout: "1000", result: "rejected" },
      },
      {
        level: "warn",
        fields: {
          recipe: "gen-0123",
          recipeRevision: 7,
          layout: "1000",
          result: "failed:unexpected-response",
        },
      },
      {
        level: "warn",
        fields: { recipe: "gen-0123", recipeRevision: 8, layout: "1000", result: "failed:threw" },
      },
    ]);
    // The event allows no other fields, as the origin or a branch.
    expect(Object.keys(LOG_EVENTS["service.use"].fields).toSorted()).toEqual([
      "layout",
      "recipe",
      "recipeRevision",
      "result",
    ]);
    vi.restoreAllMocks();
  });

  it("warns of recipe changes a sync left out as unreadable (#959)", async () => {
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
    log.recipeSync("synced", { scope: "full", added: 1, updated: 0, removed: 0, unreadable: 2 });
    // Warn even for an outcome logged at info otherwise.
    log.recipeSync("unreachable", {
      scope: "full",
      added: 0,
      updated: 0,
      removed: 0,
      unreadable: 1,
    });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries()).filter((entry) => entry.event === "service.sync"),
      ).toHaveLength(2),
    );
    const entries = (await log.logger.entries()).filter(
      (logged) => logged.event === "service.sync",
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          fields: { outcome: "synced", scope: "full", added: 1, unreadable: 2 },
        }),
        expect.objectContaining({
          level: "warn",
          fields: { outcome: "unreachable", scope: "full", unreadable: 1 },
        }),
      ]),
    );
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
}
