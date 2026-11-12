import { expect, it } from "vitest";
import {
  DEBUG_LOGGING_MS,
  DEBUG_UNTIL_TURNED_OFF,
  LOG_EVENTS,
  LOG_RETENTION_MS,
  PAGE_ATTEMPT_EVENTS_PER_MINUTE,
  PAGE_DEBUG_EVENTS_PER_MINUTE,
  PAGE_EVENTS_PER_MINUTE,
  createLogger,
  formatLogExport,
  recentLog,
  type LogEventName,
} from "../../src/diagnostics/log";
import type { LogTestContext } from "./context";

export function registerRetentionCases({
  NOW,
  setup,
  readSummary,
}: Pick<LogTestContext, "NOW" | "setup" | "readSummary">) {
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
    expect((await readSummary(restarted)).debugUntil).toBe(NOW + DEBUG_LOGGING_MS);
    advance(DEBUG_LOGGING_MS);
    await restarted.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect(await restarted.entries()).toHaveLength(2);
    expect((await readSummary(restarted)).debugUntil).toBeUndefined();
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
    expect((await readSummary(restarted)).debugUntil).toBe(DEBUG_UNTIL_TURNED_OFF);
    await restarted.disableDebug();
    await createLogger(deps).log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect(await createLogger(deps).entries()).toHaveLength(3);
    expect((await readSummary(createLogger(deps))).debugUntil).toBeUndefined();
  });

  it("keeps a 24-hour window still open on until turned off once debug stays on", async () => {
    const { logger, deps, advance } = setup();
    await logger.enableDebug();
    advance(DEBUG_LOGGING_MS / 2);
    const staying = { ...deps, debugStaysOn: true };
    expect((await readSummary(createLogger(staying))).debugUntil).toBe(DEBUG_UNTIL_TURNED_OFF);
    advance(DEBUG_LOGGING_MS);
    expect((await readSummary(createLogger(staying))).debugUntil).toBe(DEBUG_UNTIL_TURNED_OFF);
    // A published build turns it off.
    expect((await readSummary(createLogger(deps))).debugUntil).toBeUndefined();
    // A window that already ended stays off.
    const ended = setup();
    await ended.logger.enableDebug();
    ended.advance(DEBUG_LOGGING_MS);
    expect(
      (await readSummary(createLogger({ ...ended.deps, debugStaysOn: true }))).debugUntil,
    ).toBeUndefined();
  });

  it("turns debug logging off before the 24 hours end, across workers", async () => {
    const { logger, deps } = setup();
    await logger.enableDebug();
    await logger.disableDebug();
    await logger.log("service.sync", { outcome: "synced" }, { level: "debug" });
    const restarted = createLogger(deps);
    await restarted.log("service.sync", { outcome: "synced" }, { level: "debug" });
    expect((await readSummary(restarted)).debugUntil).toBeUndefined();
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
      { origin: source.origin, dropped: "login.refused", count: 1, tab: 4 },
      { origin: source.origin, dropped: "login.refused", count: 2, tab: 4 },
      { origin: source.origin, dropped: "recipe.judge", count: 1, tab: 4 },
    ]);
    advance(60_000);
    await logger.log("login.refused", { origin: source.origin, reason: "tab-busy" }, { source });
    const entries = await logger.entries();
    expect(entries.slice(-2).map((entry) => [entry.event, entry.fields])).toEqual([
      ["log.dropped", { origin: source.origin, dropped: "recipe.judge", count: 1, tab: 4 }],
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
    const summary = await readSummary(logger);
    expect(summary).toMatchObject({ entries: 3, recentErrors: 1, recentWarnings: 1 });
    expect(summary.bytes).toBeGreaterThan(0);
  });
}
