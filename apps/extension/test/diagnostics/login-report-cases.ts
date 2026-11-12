import { expect, it, vi } from "vitest";
import { createDiagnosticsLog } from "../../src/diagnostics/background";
import { problemLine } from "../../src/diagnostics/log";
import type { LogTestContext } from "./context";

export function registerLoginReportCases({ readSummary }: Pick<LogTestContext, "readSummary">) {
  it("logs a pressed sign-in entry, refused ones and blocked revisions at ADR 0019's levels", async () => {
    const recipeOrigin = "https://login.example";
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
    // Filling the form while the tab asks for an account ends without pressing anything by
    // design.
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
    expect((await readSummary(log.logger)).recentWarnings).toBe(1);
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

  it("keeps only a fixed fill cause and field position in uploaded problem lines", async () => {
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
    log.login({
      type: "attempt",
      tabId: 4,
      origin: "https://login.example",
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
      route: "password",
      state: "blocked",
      stepIndex: 0,
      stepCount: 2,
      operation: "fill",
      effect: "prepare",
      outcome: "fill-rejected",
      cause: "input-pattern-mismatch",
      fieldIndex: 1,
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(1));
    const [entry] = await log.logger.entries();
    expect(entry!.fields).toMatchObject({ cause: "input-pattern-mismatch", fieldIndex: 1 });
    expect(problemLine(entry!)?.fields).toMatchObject({
      cause: "input-pattern-mismatch",
      fieldIndex: 1,
    });
    expect(problemLine(entry!)?.fields).not.toHaveProperty("value");
    expect(problemLine(entry!)?.fields).not.toHaveProperty("label");
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
}
