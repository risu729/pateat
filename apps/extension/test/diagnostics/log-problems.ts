import { expect, it, vi } from "vitest";
import {
  LOCAL_ONLY_EVENTS,
  LOCAL_ONLY_FIELDS,
  LOCAL_ONLY_FLAG,
  PROBLEM_EVENT_FIELDS,
  problemEntrySchema,
} from "@pateat/contracts";
import { createDiagnosticsLog } from "../../src/diagnostics/background";
import {
  LOG_EVENTS,
  problemLine,
  sentToService,
  type LogEventName,
} from "../../src/diagnostics/log";
import * as v from "valibot";
import type { LogTestContext } from "./log-context";

export function registerProblemCases({ setup }: Pick<LogTestContext, "setup">) {
  it("tells of each stored entry that goes to the service only", async () => {
    const onProblem = vi.fn(() => {
      throw new Error("listener");
    });
    const { logger } = setup({ onProblem, debugStaysOn: true });
    await logger.enableDebug();
    await logger.log("login.start", { origin: "https://bank.example", route: "password" });
    await logger.log("login.entry", { origin: "https://bank.example", outcome: "pressed" });
    await logger.log("recipe.generate", { origin: "https://bank.example", outcome: "sent" });
    await logger.log(
      "login.refused",
      { origin: "https://bank.example", reason: "no-account" },
      { level: "debug" },
    );
    await logger.log("runtime.started", { build: "1c42ad3" });
    expect(onProblem).not.toHaveBeenCalled();
    await logger.log("login.exception", { origin: "https://bank.example", name: "TypeError" });
    await logger.log("error.unhandled", { source: "error", name: "Error" });
    // `info` lines that say why Pateat did nothing go too.
    await logger.log("login.refused", { origin: "https://bank.example", reason: "no-account" });
    await logger.log("login.entry", { origin: "https://bank.example", outcome: "refused" });
    await logger.log("recipe.generate", { origin: "https://bank.example", outcome: "abstained" });
    // A listener that throws changes nothing.
    expect(onProblem).toHaveBeenCalledTimes(5);
    expect((await logger.entries()).map((entry) => entry.event)).toContain("error.unhandled");
  });

  it("reads the entries that go after a key, oldest first, and keeps its cursor across a clear", async () => {
    const { logger } = setup();
    expect(await logger.lastKey()).toBe(0);
    expect(await logger.problemsAfter(0, 10)).toEqual({ entries: [], scanned: 0, more: false });
    await logger.log("login.exception", { origin: "https://bank.example", name: "TypeError" });
    await logger.log("login.refused", { origin: "https://bank.example", reason: "no-account" });
    await logger.log(
      "vault.sync",
      { connection: "raw-connection", outcome: "unreachable" },
      { level: "warn" },
    );
    await logger.log("error.unhandled", { source: "error", name: "Error" });
    await logger.log("login.start", { origin: "https://bank.example", route: "password" });
    const all = await logger.problemsAfter(0, 10);
    expect(all.entries.map(({ entry }) => entry.event)).toEqual([
      "login.exception",
      "login.refused",
      "vault.sync",
      "error.unhandled",
    ]);
    const keys = all.entries.map(({ key }) => key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    // The read looked at the `info` entry that does not go after the last one too.
    expect(all.scanned).toBe(await logger.lastKey());
    expect(all.scanned).toBeGreaterThan(keys[3]!);
    // A read that stops at its limit looked no further than its last entry.
    expect(await logger.problemsAfter(keys[0]!, 1)).toMatchObject({
      entries: [{ key: keys[1] }],
      scanned: keys[1],
    });
    expect(await logger.problemsAfter(all.scanned, 10)).toEqual({
      entries: [],
      scanned: all.scanned,
      more: false,
    });
    // Each entry carries the build that wrote it.
    expect(all.entries.map(({ entry }) => entry.build)).toEqual([
      "1c42ad3",
      "1c42ad3",
      "1c42ad3",
      "1c42ad3",
    ]);

    await logger.setProblemCursor({ service: "https://pateat.example", deviceId: "d", after: 4 });
    await logger.clear();
    expect(await logger.problemCursor()).toEqual({
      service: "https://pateat.example",
      deviceId: "d",
      after: 4,
    });
    // Keys keep counting up after a clear, so the cursor never skips a new entry.
    await logger.log("error.unhandled", { source: "error", name: "Error" });
    const [after] = (await logger.problemsAfter(keys[2]!, 10)).entries;
    expect(after?.key).toBeGreaterThan(keys[2]!);
  });

  it("keeps one random log ID per database, also across a clear", async () => {
    const { logger } = setup();
    const id = await logger.logId();
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    await logger.clear();
    expect(await logger.logId()).toBe(id);
    // Another database, as a log made again, has another.
    expect(await setup().logger.logId()).not.toBe(id);
  });

  it("stops a read at 2,000 entries looked at, and the next read goes on past them", async () => {
    const { logger } = setup();
    for (let at = 0; at < 2_000; at += 1)
      // oxlint-disable-next-line no-await-in-loop -- entries are written one at a time
      await logger.log("login.start", { origin: "https://bank.example", route: "password" });
    await logger.log("error.unhandled", { source: "error", name: "Error" });
    const first = await logger.problemsAfter(0, 10);
    expect(first.entries).toEqual([]);
    expect(first.more).toBe(true);
    const next = await logger.problemsAfter(first.scanned, 10);
    expect(next.entries.map(({ entry }) => entry.event)).toEqual(["error.unhandled"]);
    expect(next).toMatchObject({ scanned: await logger.lastKey(), more: false });
  });

  it("lets only codes, counts, recipe IDs, known origins and redacted paths leave", async () => {
    const { logger, pseudonym } = setup();
    await logger.log(
      "login.attempt",
      {
        origin: "https://bank.example",
        recipe: "gen-0123456789abcdef0123456789abcdef",
        recipeRevision: 2,
        state: "blocked",
        outcome: "wrong-account",
        unsubmitted: true,
        url: "https://bank.example/u/aus1a2b3c4d5e6f7g8h9/alice@example.com/b%2540c.example/login?user=alice@example.com#/step?code=1",
      },
      { level: "warn", source: { tabId: 9, origin: "https://bank.example" } },
    );
    await logger.log("login.start", {
      origin: "https://shop.example",
      item: "raw-item-id",
      url: "https://shop.example/login",
    });
    await logger.log(
      "vault.state",
      { connection: "raw-connection-id", state: "unavailable" },
      { level: "warn" },
    );
    await logger.log(
      "login.popup",
      { origin: "https://shop.example", choice: "none", url: "https://shop.example/signin" },
      { level: "warn" },
    );
    const entries = await logger.entries();
    const lines = entries.map(problemLine);
    expect(lines[0]).toEqual({
      level: "warn",
      event: "login.attempt",
      time: entries[0]!.time,
      fields: {
        origin: "https://bank.example",
        recipe: "gen-0123456789abcdef0123456789abcdef",
        recipeRevision: 2,
        state: "blocked",
        outcome: "wrong-account",
        unsubmitted: true,
        // The token, the email address and the doubly encoded one become `[id]`.
        url: "/u/[id]/[id]/[id]/login",
        tab: 9,
      },
    });
    // An `info` entry that does not say why Pateat did nothing never leaves.
    expect(lines[1]).toBeUndefined();
    // No vault pseudonym leaves.
    expect(lines[2]?.fields).toEqual({ state: "unavailable" });
    // A site not set up stays a pseudonym, and gets no path.
    expect(lines[3]?.fields).toEqual({
      origin: `origin:${await pseudonym("origin", "https://shop.example", 8)}`,
      choice: "none",
    });
    expect(JSON.stringify(lines)).not.toMatch(/alice|code=|user=|raw-|b%25/u);
  });

  it("sends a path only for lines known to come before a submit, and no cut value", async () => {
    const { logger } = setup();
    const page = { origin: "https://bank.example", url: "https://bank.example/users/alice/home" };
    const blocked = { ...page, state: "blocked" };
    // Nothing submitted yet, in the document the login began in.
    const fresh = { ...blocked, unsubmitted: true };
    // Lines known to come before a submit keep their path.
    const before: [LogEventName, Record<string, unknown>][] = [
      ["login.start", { ...page, route: "password" }],
      ["login.attempt", { ...fresh, outcome: "wrong-account", step: 0, steps: 4 }],
      ["login.attempt", { ...fresh, outcome: "value-mismatch", step: 0, steps: 4 }],
      ["login.attempt", { ...fresh, outcome: "fill-rejected", step: 0, steps: 4 }],
      ["login.attempt", { ...fresh, outcome: "account-not-listed", step: 0, steps: 2 }],
      ["login.attempt", { ...fresh, outcome: "account-switched", step: 0, steps: 2 }],
      ["login.exception", { ...page, state: "detected", unsubmitted: true, name: "TypeError" }],
      [
        "login.exception",
        { ...page, state: "executing", step: 0, unsubmitted: true, name: "TypeError" },
      ],
      ["login.entry", { ...page, outcome: "refused", reason: "target-missing" }],
      ["login.entry", { ...page, outcome: "refused", reason: "paused" }],
      [
        "login.refused",
        {
          ...page,
          reason: "not-started",
          detail: "first-step-missing",
          previousUrl: "https://bank.example/users/alice/settings",
        },
      ],
      ["recipe.generate", { ...page, outcome: "failed", reason: "error" }],
      ["recipe.generate", { ...page, outcome: "abstained", reason: "not-login" }],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "sent" }],
      ["recipe.unfit", { ...page, outcome: "not-sent", reason: "vault-unavailable" }],
    ];
    // Every other line sends none: (A) a login whose result was watched, that ended its
    // watch, was cancelled, left the origin, stopped in a handler such as a code page, or
    // awaited or reconciled a result; (B) a refusal not known to come before a submit; (C)
    // generation skipped on a signed-in page or one whose path may hold a username; and
    // every other event, including any added to the log later.
    const after: [LogEventName, Record<string, unknown>][] = [
      ["login.attempt", { ...page, state: "watching", outcome: "challenge" }],
      ["login.attempt", { ...page, state: "awaiting-result", step: 2, steps: 3 }],
      ["login.attempt", { ...page, state: "reconciling", step: 2, steps: 3, settled: true }],
      ["login.attempt", { ...blocked, outcome: "challenge" }],
      ["login.attempt", { ...blocked, outcome: "challenge-abandoned", cause: "watch-ended" }],
      ["login.attempt", { ...blocked, outcome: "watch-abandoned" }],
      ["login.attempt", { ...blocked, outcome: "cancelled" }],
      ["login.attempt", { ...blocked, outcome: "left-origin" }],
      ["login.attempt", { ...blocked, outcome: "credential-rejected", step: 2, steps: 3 }],
      ["login.attempt", { ...blocked, outcome: "unknown-submit", step: 2, steps: 3 }],
      ["login.attempt", { ...blocked, outcome: "structural-mismatch", step: 2, steps: 3 }],
      ["login.attempt", { ...blocked, outcome: "timeout", step: 2, steps: 3 }],
      ["login.attempt", { ...fresh, outcome: "value-mismatch", handler: 0, step: 3 }],
      ["login.attempt", { ...fresh, outcome: "wrong-account", settled: true }],
      // The same outcomes after an earlier submit, as a wrong account on the password page
      // after Next, or in a resumed login's later document: not `unsubmitted`.
      ["login.attempt", { ...blocked, outcome: "wrong-account", step: 2, steps: 4 }],
      ["login.attempt", { ...blocked, outcome: "value-mismatch", step: 2, steps: 4 }],
      ["login.attempt", { ...blocked, outcome: "fill-rejected", step: 2, steps: 4 }],
      ["login.attempt", { ...blocked, outcome: "account-not-listed", step: 0, steps: 2 }],
      ["login.attempt", { ...fresh, outcome: "challenge" }],
      ["login.attempt", { ...blocked }],
      ["login.exception", { ...page, state: "reconciling", step: 3, name: "TypeError" }],
      ["login.exception", { ...page, state: "awaiting-result", step: 3, name: "TypeError" }],
      ["login.exception", { ...page, state: "watching", step: 3, name: "TypeError" }],
      ["login.exception", { ...page, state: "executing", step: 2, name: "TypeError" }],
      ["login.exception", { ...page, state: "ready", step: 1, name: "TypeError" }],
      // A passkey answer that fell back to the password route is back at step 0.
      ["login.exception", { ...page, state: "ready", step: 0, name: "TypeError" }],
      ["login.exception", { ...page, state: "detected", name: "TypeError" }],
      ["login.exception", { ...page, name: "TypeError" }],
      ["login.refused", { ...page, reason: "not-started", detail: "logged-in" }],
      ["login.refused", { ...page, reason: "not-started", detail: "stopped-login" }],
      ["login.refused", { ...page, reason: "not-started", detail: "confirm-unsupported" }],
      ["login.refused", { ...page, reason: "not-started", detail: "no-recipe-on-path" }],
      ["login.refused", { ...page, reason: "account-asked", detail: "rejected" }],
      ["login.refused", { ...page, reason: "tab-busy" }],
      ["login.refused", { ...page, reason: "account-ambiguous", candidates: 2 }],
      ["login.refused", { ...page, reason: "no-route", detail: "password-empty" }],
      ["login.refused", { ...page, reason: "entry-blocked" }],
      ["login.refused", { ...page, reason: "paused" }],
      ["login.entry", { ...page, outcome: "blocked", reason: "no-sign-in" }],
      ["login.entry", { ...page, outcome: "refused", reason: "unconfirmed" }],
      ["login.entry", { ...page, outcome: "refused", reason: "exception" }],
      ["login.entry", { ...page, outcome: "refused", reason: "page-changed" }],
      ["recipe.generate", { ...page, outcome: "failed", reason: "error", signedIn: true }],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "signed-in-elsewhere" }],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "after-sign-in" }],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "username-shown" }],
      [
        "recipe.generate",
        { ...page, outcome: "skipped", reason: "no-listed-account", detail: "username-in-path" },
      ],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "vault-unavailable" }],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "text-answer" }],
      ["recipe.generate", { ...page, outcome: "skipped", reason: "frame" }],
      ["login.confirm-left", { ...page, personSubmitted: true }],
      ["recipe.judge", { ...page, verdict: "unclear", watched: true }],
      ["recipe.sample", { ...page, outcome: "failed" }],
      ["login.state", { ...page, decision: "signed-in" }],
      ["login.move", { ...page, reason: "left" }],
      ["login.switch", { ...page, stage: "click", clicks: 1 }],
      ["login.popup", { ...page, choice: "offered" }],
      ["login.handler", { ...page, kind: "totp", outcome: "entered" }],
      // A code page left to the person (#1381): why, but not where.
      ["login.handler", { ...page, kind: "totp", outcome: "not-shown", why: "ok.missing" }],
    ];
    for (const [event, fields] of [...before, ...after])
      // eslint-disable-next-line no-await-in-loop
      await logger.log(event, fields as never, { level: "warn" });
    await logger.log(
      "login.attempt",
      {
        origin: "https://bank.example",
        state: "blocked",
        outcome: "value-mismatch",
        unsubmitted: true,
        reason: "x".repeat(600),
        url: `https://bank.example/${"a/".repeat(300)}partial`,
      },
      { level: "warn" },
    );
    const lines = (await logger.entries()).map(problemLine);
    expect(lines).toHaveLength(before.length + after.length + 1);
    for (const line of lines.slice(0, before.length))
      expect(line?.fields["url"], line?.event).toBe("/users/alice/home");
    for (const [index, line] of lines.slice(before.length, -1).entries())
      expect(line?.fields, JSON.stringify(after[index])).not.toHaveProperty("url");
    // Nor does another page's path, such as the tab's previous page.
    for (const line of lines) expect(line?.fields).not.toHaveProperty("previousUrl");
    expect(JSON.stringify(lines)).not.toMatch(/settings/u);
    // A path cut at the field limit loses its last, maybe partial, segment.
    const cut = lines.at(-1)?.fields["url"];
    expect(cut).toMatch(/^\/(?:a\/)+\[id\]$/u);
    expect(lines.at(-1)?.fields).not.toHaveProperty("reason");
  });

  it("leaves where a login's own time went out of its problem line (ADR 0019)", async () => {
    const { logger } = setup();
    await logger.log(
      "login.attempt",
      {
        origin: "https://bank.example",
        state: "blocked",
        outcome: "retry-limit",
        totalMs: 9_000,
        otherMs: 6_000,
        startMs: 300,
        awaitMs: 1_200,
        saveMs: 100,
        commandMs: 200,
      },
      { level: "warn" },
    );
    const [entry] = await logger.entries();
    expect(entry?.fields).toMatchObject({ startMs: 300, awaitMs: 1_200, commandMs: 200 });
    const line = problemLine(entry!);
    expect(line?.fields).toMatchObject({ totalMs: 9_000, otherMs: 6_000 });
    for (const field of LOCAL_ONLY_FIELDS["login.attempt"])
      expect(line?.fields).not.toHaveProperty(field);
  });

  it("lets the info lines that say why Pateat did nothing leave, under the same rules", async () => {
    const { logger } = setup();
    const page = { origin: "https://bank.example", url: "https://bank.example/u/alice/login?x=1" };
    await logger.log("login.refused", {
      ...page,
      reason: "not-started",
      detail: "first-step-missing",
    });
    await logger.log("login.entry", { ...page, outcome: "refused", reason: "target-missing" });
    await logger.log("login.entry", { ...page, outcome: "pressed" });
    await logger.log("recipe.generate", { ...page, outcome: "skipped", reason: "sending" });
    await logger.log("recipe.generate", { ...page, outcome: "abstained", reason: "not-login" });
    await logger.log("recipe.generate", { ...page, outcome: "sent", page: "page" });
    // Lines not known to come before a submit send no path.
    await logger.log("login.refused", { ...page, reason: "account-ambiguous", candidates: 2 });
    await logger.log("login.refused", { ...page, reason: "not-started", detail: "logged-in" });
    await logger.log("recipe.generate", { ...page, outcome: "skipped", reason: "after-sign-in" });
    await logger.log("recipe.generate", { ...page, outcome: "skipped", reason: "username-shown" });
    const entries = await logger.entries();
    const lines = entries.map(problemLine);
    expect(lines[0]).toEqual({
      level: "info",
      event: "login.refused",
      time: entries[0]!.time,
      fields: {
        origin: "https://bank.example",
        reason: "not-started",
        detail: "first-step-missing",
        url: "/u/alice/login",
      },
    });
    expect(lines[1]?.fields).toMatchObject({ outcome: "refused", url: "/u/alice/login" });
    expect(lines[2]).toBeUndefined();
    expect(lines[3]?.fields).toMatchObject({ outcome: "skipped", url: "/u/alice/login" });
    expect(lines[4]?.fields).toMatchObject({ outcome: "abstained" });
    expect(lines[5]).toBeUndefined();
    for (const line of lines.slice(6)) {
      expect(line?.level).toBe("info");
      expect(line?.fields).not.toHaveProperty("url");
    }
    // Each line that leaves is one the contract takes.
    for (const [index, line] of lines.entries())
      if (line)
        expect(v.is(problemEntrySchema, { seq: index + 1, ...line }), line.event).toBe(true);
  });

  it("carries only what the contract lets each event carry", () => {
    // Each log event and its fields, less vault pseudonyms and any other page than the
    // line's own (`previousUrl`), with that URL as a path, is what `PROBLEM_EVENT_FIELDS`
    // lists, so the contract refuses nothing that leaves and accepts nothing more.
    const fromLog = Object.fromEntries(
      Object.entries(LOG_EVENTS).map(([event, definition]) => [
        event,
        Object.fromEntries(
          Object.entries(definition.fields as Record<string, string>)
            .filter(([, kind]) => kind !== "item" && kind !== "connection")
            .filter(([field, kind]) => kind !== "url" || field === "url")
            // The flag of a fill-only login, whose lines stay on the device.
            .filter(([field]) => field !== LOCAL_ONLY_FLAG)
            // Where a login's own time went, which stays on the device (ADR 0019).
            .filter(
              ([field]) =>
                !((LOCAL_ONLY_FIELDS as Record<string, readonly string[]>)[event] ?? []).includes(
                  field,
                ),
            )
            .map(([field, kind]) => [field, kind === "url" ? "path" : kind]),
        ),
      ]),
    );
    // Passkey reports never leave, so the contract does not list them.
    for (const event of LOCAL_ONLY_EVENTS) {
      expect(fromLog).toHaveProperty([event]);
      delete fromLog[event];
    }
    expect(fromLog).toEqual(PROBLEM_EVENT_FIELDS);
  });

  it("keeps passkey reports and a fill-only login's lines on the device", async () => {
    const onProblem = vi.fn();
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      onProblem,
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    const { logger } = log;
    const site = { origin: "https://bank.example", url: "https://bank.example/login" };
    await logger.log(
      "passkey.request",
      { origin: site.origin, rpId: "bank.example", outcome: "failed" },
      { level: "warn" },
    );
    await logger.log(
      "passkey.create",
      { origin: site.origin, rpId: "bank.example", outcome: "failed" },
      { level: "error" },
    );
    const attempt = {
      type: "attempt",
      tabId: 3,
      origin: site.origin,
      url: site.url,
      recipeId: "gen-0123",
      recipeRevision: 2,
      route: "password",
      state: "blocked",
      stepIndex: 0,
      stepCount: 2,
      outcome: "timeout",
      cause: "elements-timeout",
    } as const;
    // A fill-only login's warning, also one whose stop named another reason.
    log.login({ ...attempt, fillOnly: true, reason: "fill-only" });
    log.login({ ...attempt, fillOnly: true, reason: "password-empty" });
    log.login({
      type: "exception",
      tabId: 3,
      origin: site.origin,
      recipeId: "gen-0123",
      recipeRevision: 2,
      route: "password",
      state: "blocked",
      stepIndex: 0,
      fillOnly: true,
      name: "TypeError",
    });
    // The same warning of a login that is not fill-only leaves.
    log.login(attempt);
    await vi.waitFor(async () => expect(await logger.entries()).toHaveLength(6));
    const entries = await logger.entries();
    expect(entries.map(({ level, event }) => `${level} ${event}`)).toEqual([
      "warn passkey.request",
      "error passkey.create",
      "warn login.attempt",
      "warn login.attempt",
      "warn login.exception",
      "warn login.attempt",
    ]);
    // The local log keeps the mark that keeps them local.
    for (const entry of entries.slice(2, 5)) expect(entry.fields["fillOnly"]).toBe(true);
    expect(entries.map((entry) => sentToService(entry))).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(entries.map(problemLine).map((line) => line?.event)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "login.attempt",
    ]);
    expect(onProblem).toHaveBeenCalledTimes(1);
    const { entries: found } = await logger.problemsAfter(0, 10);
    expect(found.map(({ entry }) => entry.fields["fillOnly"] ?? entry.event)).toEqual([
      "login.attempt",
    ]);
    vi.restoreAllMocks();
  });

  it("logs a send at debug when kept and at info otherwise, never as a problem", async () => {
    const onProblem = vi.fn();
    const log = createDiagnosticsLog({
      build: { version: "0.1.0", revision: "1c42ad3" },
      settings: async () => {
        throw new Error("not needed");
      },
      recipeCache: async () => undefined,
      connections: async () => ({ ok: true, kind: "status", connections: [] }),
      onProblem,
      databaseName: `log-test-${crypto.randomUUID()}`,
      scope: { addEventListener: () => undefined } as never,
    });
    for (const level of ["debug", "info", "warn"] as const)
      vi.spyOn(console, level).mockImplementation(() => undefined);
    await log.logger.enableDebug();
    log.problemsSent({ lines: 3, result: "kept" });
    log.problemsSent({ lines: 2, result: "failed:unreachable" });
    log.problemsSent({ lines: 1, result: "refused" });
    await vi.waitFor(async () =>
      expect(
        (await log.logger.entries())
          .filter((entry) => entry.event === "service.problems")
          .map(({ level, fields }) => [level, fields["result"]]),
      ).toEqual([
        ["debug", "kept"],
        ["info", "failed:unreachable"],
        ["info", "refused"],
      ]),
    );
    expect(onProblem).not.toHaveBeenCalled();
  });
}
