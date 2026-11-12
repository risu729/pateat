import { describe, expect } from "vitest";
import { createLogger, type KnownSites, type LogEntry, type LoggerDependencies } from "./log";
import { createPseudonyms } from "./pseudonym";
import { registerFieldCases } from "../../test/diagnostics/fields-cases";
import { registerBackgroundReportCases } from "../../test/diagnostics/background-report-cases";
import { registerRetentionCases } from "../../test/diagnostics/retention-cases";
import { registerExportCases } from "../../test/diagnostics/export-cases";
import { registerRecentCases } from "../../test/diagnostics/recent-cases";
import { registerVaultReportCases } from "../../test/diagnostics/vault-report-cases";
import { registerEventReportCases } from "../../test/diagnostics/event-report-cases";
import { registerLoginReportCases } from "../../test/diagnostics/login-report-cases";
import { registerPageReportCases } from "../../test/diagnostics/page-report-cases";
import { registerProblemCases } from "../../test/diagnostics/problem-cases";

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

/** Existing summary assertions still require an available summary in the combined read. */
async function readSummary(logger: ReturnType<typeof createLogger>) {
  const { summary } = await logger.snapshot();
  expect(summary).toBeDefined();
  return summary!;
}

describe("diagnostics log", () => {
  registerFieldCases({ NOW, setup });

  registerBackgroundReportCases();

  registerRetentionCases({ NOW, setup, readSummary });
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

  registerExportCases({ NOW, entries, context });
});

describe("recent log for a bug report", () => {
  const HOUR = 60 * 60_000;
  const entry = (
    time: number,
    level: LogEntry["level"],
    event: LogEntry["event"],
    fields: LogEntry["fields"],
  ): LogEntry => ({ time, level, event, fields });

  registerRecentCases({ NOW, HOUR, entry });
});

describe("unhandled errors", () => {
  registerVaultReportCases({ EXTENSION });

  registerEventReportCases();

  registerLoginReportCases({ readSummary });

  registerPageReportCases({ NOW, EXTENSION });
});

describe("problem lines (ADR 0066)", () => {
  registerProblemCases({ setup });
});
