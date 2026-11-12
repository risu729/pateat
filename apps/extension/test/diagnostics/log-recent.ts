import { expect, it } from "vitest";
import { TRUNCATED, recentLog } from "../../src/diagnostics/log";
import { recentLogSchema } from "../../src/diagnostics/wire";
import * as v from "valibot";
import type { LogTestContext } from "./log-context";

export function registerRecentCases({
  NOW,
  HOUR,
  entry,
}: Pick<LogTestContext, "NOW" | "HOUR" | "entry">) {
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

  it.each([
    ["before the oldest accepted time", NOW - 24 * HOUR - 1, false],
    ["the oldest accepted time", NOW - 24 * HOUR, true],
    ["the current time", NOW, true],
    ["the latest accepted time", NOW + 24 * HOUR, true],
    ["after the latest accepted time", NOW + 24 * HOUR + 1, false],
  ] as const)("bounds recent counters at %s", (_label, time, included) => {
    const recent = recentLog(
      [
        entry(time, "info", "passkey.request", { outcome: "delegate", reason: "no-credential" }),
        entry(time, "info", "recipe.generate", { outcome: "skipped", reason: "frame" }),
        entry(time, "info", "recipe.generate", { outcome: "skipped", reason: "text-answer" }),
      ],
      NOW,
    );
    const delegation = { reason: "no-credential", count: 1 };
    const unsent = [
      { reason: "frame", count: 1 },
      { reason: "text-answer", count: 1 },
    ];
    expect(recent.passkeyDelegations).toEqual(included ? [delegation] : []);
    expect(recent.unsentVerifications).toEqual(included ? unsent : []);
    expect(v.is(recentLogSchema, recent)).toBe(true);
  });
}
