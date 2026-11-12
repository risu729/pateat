import type { createLogger, LogEntry, LoggerDependencies } from "../../src/diagnostics/log";
import type { createPseudonyms } from "../../src/diagnostics/pseudonym";

export type LogTestContext = {
  NOW: number;
  EXTENSION: string;
  setup: (overrides?: Partial<LoggerDependencies>) => {
    deps: LoggerDependencies;
    logger: ReturnType<typeof createLogger>;
    pseudonym: ReturnType<typeof createPseudonyms>;
    advance: (ms: number) => number;
  };
  readSummary: (
    logger: ReturnType<typeof createLogger>,
  ) => Promise<
    NonNullable<Awaited<ReturnType<ReturnType<typeof createLogger>["snapshot"]>>["summary"]>
  >;
  entries: LogEntry[];
  context: { version: string; revision: string; exportedAt: number };
  HOUR: number;
  entry: (
    time: number,
    level: LogEntry["level"],
    event: LogEntry["event"],
    fields: LogEntry["fields"],
  ) => LogEntry;
};
