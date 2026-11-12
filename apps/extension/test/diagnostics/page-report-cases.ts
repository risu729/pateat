import { expect, it, vi } from "vitest";
import { createDefaultSettings } from "@pateat/contracts";
import { createDiagnosticsLog } from "../../src/diagnostics/background";
import {
  formatLogExport,
  problemLine,
  sentToService,
  stackPositions,
} from "../../src/diagnostics/log";
import type { LogTestContext } from "./context";

export function registerPageReportCases({
  NOW,
  EXTENSION,
}: Pick<LogTestContext, "NOW" | "EXTENSION">) {
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
    log.login({ type: "refused", ...site, reason: "paused" });
    log.login({ type: "refused", ...site, reason: "paused", repeat: true });
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
      ["login.refused", "info", "paused"],
      ["login.refused", "debug", "paused"],
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
    log.vaultCheck({ connectionId, outcome: "failed", cause: "network" });
    // The same failure again is only detail; a new cause or status warns again.
    log.vaultCheck({
      connectionId,
      outcome: "failed",
      cause: "network",
      previous: "failed",
      previousFailure: { cause: "network" },
    });
    log.vaultCheck({
      connectionId,
      outcome: "failed",
      cause: "http-error",
      status: 503,
      previous: "failed",
      previousFailure: { cause: "network" },
    });
    log.vaultCheck({
      connectionId,
      outcome: "failed",
      cause: "http-error",
      status: 429,
      previous: "failed",
      previousFailure: { cause: "http-error", status: 503 },
    });
    // A decryption failure warns again when another check refused the item.
    const itemId = "00000000-0000-4000-8000-000000000002";
    const otherItem = "00000000-0000-4000-8000-000000000003";
    for (const [check, previous, previousItem] of [
      ["attachment", undefined, undefined],
      ["attachment", "attachment", itemId],
      ["attachment", "attachment", otherItem],
      ["sdk-decrypt", "attachment", itemId],
    ] as const)
      log.vaultCheck({
        connectionId,
        outcome: "failed",
        cause: "crypto-failed",
        check,
        item: itemId,
        revised: 1_762_720_517_000,
        previous: "failed",
        previousFailure: { cause: "crypto-failed", check: previous, item: previousItem },
      });
    log.vaultRefresh({ connectionId, outcome: "not-sent", cause: "no-refresh-token" });
    log.recipeSync("busy", { scope: "full", added: 0, updated: 0, removed: 0 });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(17));
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
      ["vault.check", "warn", "failed", "network"],
      ["vault.check", "debug", "failed", "network"],
      ["vault.check", "warn", "failed", "http-error"],
      ["vault.check", "warn", "failed", "http-error"],
      ["vault.check", "warn", "failed", "crypto-failed"],
      ["vault.check", "debug", "failed", "crypto-failed"],
      ["vault.check", "warn", "failed", "crypto-failed"],
      ["vault.check", "warn", "failed", "crypto-failed"],
      ["vault.refresh", "info", "not-sent", "no-refresh-token"],
      ["service.sync", "info", "busy", undefined],
    ]);
    expect(JSON.stringify(entries)).not.toContain(connectionId);
    expect(JSON.stringify(entries)).not.toContain(itemId);
    const failures = entries.filter(
      (entry) => entry.event === "vault.check" && entry.fields["outcome"] === "failed",
    );
    expect(failures[3]?.fields["status"]).toBe(429);
    expect(failures.at(-1)?.fields).toEqual({
      connection: expect.stringMatching(/^bitwarden:[0-9a-f]{6}$/u),
      outcome: "failed",
      cause: "crypto-failed",
      check: "sdk-decrypt",
      item: expect.stringMatching(/^item:[0-9a-f]{8}$/u),
      revised: 1_762_720_517_000,
    });
    expect(failures.map(problemLine).map((line) => line?.fields)).toEqual([
      { outcome: "failed", cause: "network" },
      undefined,
      { outcome: "failed", cause: "http-error", status: 503 },
      { outcome: "failed", cause: "http-error", status: 429 },
      { outcome: "failed", cause: "crypto-failed", check: "attachment" },
      undefined,
      { outcome: "failed", cause: "crypto-failed", check: "attachment" },
      { outcome: "failed", cause: "crypto-failed", check: "sdk-decrypt" },
    ]);
    vi.restoreAllMocks();
  });

  it("logs a closed tab that stops asking, with each entry's tab (ADR 0021 D)", async () => {
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
    log.login({ type: "ask-ended", tabId: 4, origin, ask: "stopped-login", cause: "tab-closed" });
    log.login({
      type: "ask-ended",
      tabId: 5,
      origin,
      ask: "rejected",
      cause: "tab-closed",
      elsewhere: true,
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(2));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level, entry.fields])).toEqual([
      [
        "login.ask-ended",
        "info",
        { origin: expect.any(String), ask: "stopped-login", cause: "tab-closed", tab: 4 },
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
    expect(exported.map((line) => line["tab"])).toEqual([4, 5]);
    vi.restoreAllMocks();
  });

  it.each(
    (["reconciling", "watching"] as const).flatMap((state) =>
      (["authenticated", "blocked", "closed"] as const).map((end) => ({ state, end })),
    ),
  )("sends only the final problem for $state ending $end", async ({ state, end }) => {
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
    const attempt = {
      tabId: 4,
      origin: "https://login.example",
      recipeId: "synthetic-recipe",
      recipeRevision: 1,
      route: "password",
      stepIndex: 1,
      stepCount: 2,
    } as const;
    const outcome = state === "watching" ? "challenge" : "unknown-submit";
    const settled = state === "reconciling" ? { settled: true as const } : {};
    log.login({
      ...attempt,
      type: "attempt",
      state,
      outcome,
      ...settled,
      watched: true,
    });
    if (end === "closed")
      log.login({
        ...attempt,
        type: "attempt-closed",
        state,
        outcome,
        ...settled,
        watched: true,
        cause: "tab-closed",
      });
    else
      log.login({
        ...attempt,
        type: "attempt",
        state: end,
        outcome: end === "authenticated" ? "authenticated" : outcome,
      });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(2));
    const entries = await log.logger.entries();
    expect(entries[0]!.level).toBe("info");
    expect(entries.filter(sentToService)).toHaveLength(end === "authenticated" ? 0 : 1);
    expect(entries[1]!.level).toBe(end === "authenticated" ? "info" : "warn");
    vi.restoreAllMocks();
  });

  it("logs an ordinary running login whose tab closed as info (ADR 0019)", async () => {
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
    const closed = {
      type: "attempt-closed",
      tabId: 4,
      origin,
      recipeId: "recipe-1",
      recipeRevision: 2,
      route: "password",
      stepIndex: 3,
      stepCount: 4,
      cause: "tab-closed",
    } as const;
    log.login({ ...closed, state: "awaiting-result" });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(1));
    expect(
      (await log.logger.entries()).map((entry) => [entry.event, entry.level, entry.fields]),
    ).toEqual([
      [
        "login.attempt",
        "info",
        {
          origin: expect.any(String),
          recipe: "recipe-1",
          recipeRevision: 2,
          route: "password",
          state: "awaiting-result",
          step: 3,
          steps: 4,
          cause: "tab-closed",
          tab: 4,
        },
      ],
    ]);
    vi.restoreAllMocks();
  });

  it("logs what a page Pateat does not fill showed, and how the tab left it (ADR 0035)", async () => {
    const recipeOrigin = "https://login.example";
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => ({ revision: 1, settings: createDefaultSettings({ connections: [] }) }),
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

  it("logs what the popup was told about a tab's account choice and why the tab asks", async () => {
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
      type: "popup",
      ...site,
      choice: "offered",
      candidates: 3,
      ask: "rejected",
      pageReason: "account-asked",
    });
    // Another tab of the site, whose popup chooses no account after that rejection.
    log.login({
      type: "popup",
      tabId: 5,
      origin: site.origin,
      choice: "offered",
      candidates: 3,
      ask: "rejected-elsewhere",
      rejectedElsewhere: true,
    });
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(3));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ["login.popup", "info"],
      ["login.popup", "info"],
      ["login.popup", "info"],
    ]);
    expect(entries[0]?.fields).toMatchObject({
      choice: "none",
      recordState: "reconciling",
      recordOutcome: "unknown-submit",
      pageReason: "logged-in",
    });
    expect(entries[1]?.fields).toMatchObject({
      choice: "offered",
      candidates: 3,
      ask: "rejected",
      pageReason: "account-asked",
    });
    expect(entries[2]?.fields).toMatchObject({
      ask: "rejected-elsewhere",
      rejectedElsewhere: true,
    });
    vi.restoreAllMocks();
  });

  it("logs a login's start, what a chooser's list showed and the account choice at info", async () => {
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
    await vi.waitFor(async () => expect(await log.logger.entries()).toHaveLength(4));
    const entries = await log.logger.entries();
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ["login.start", "info"],
      ["login.choice", "info"],
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
    expect(Object.keys(entries[0]!.fields).filter((key) => key.startsWith("list"))).toEqual([]);
    expect(entries[2]?.fields).toMatchObject({
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
    expect(entries[2]?.fields).not.toHaveProperty("listNamed");
    expect(entries[3]?.fields).toMatchObject({
      list: "none",
      listUsername: "name",
      listEntries: 3,
      listBeside: 1,
      listNamed: 2,
      listOther: "one",
      listContinue: "many",
    });
    for (const key of ["listMasked", "listSameDomain", "listFits", "listEntryMiss"])
      expect(entries[3]?.fields).not.toHaveProperty(key);
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
}
