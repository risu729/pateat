import { problemInfoLine } from "@pateat/contracts";
import * as v from "valibot";
import type { LogEntry } from "./log-fields";

/** Explicit export choices only; omitted scope keeps the complete retained log. */
export const logExportScopeSchema = v.strictObject({
  range: v.picklist(["all", "15m", "1h", "24h"]),
  severity: v.picklist(["all", "problems"]),
});
export type LogExportScope = v.InferOutput<typeof logExportScopeSchema>;
export const ALL_LOG_ENTRIES: LogExportScope = { range: "all", severity: "all" };
const WINDOWS = { "15m": 15 * 60_000, "1h": 60 * 60_000, "24h": 24 * 60 * 60_000 };

/**
 * Whether an entry is a problem line (ADR 0066): every `warn` and `error` entry, and an
 * `info` entry that says why Pateat did nothing on a page (`PROBLEM_INFO_LINES`). The
 * `problems` export keeps these; `sentToService` sends those not kept local.
 */
export function problemEntry(entry: Pick<LogEntry, "level" | "event" | "fields">): boolean {
  if (entry.level === "warn" || entry.level === "error") return true;
  return entry.level === "info" && problemInfoLine(entry.event, entry.fields);
}

/** Time windows include both endpoints; an unbounded export preserves future-clock entries. */
export function selectLogEntries(
  entries: readonly LogEntry[],
  scope: LogExportScope | undefined,
  exportedAt: number,
): { entries: readonly LogEntry[]; since?: number; through?: number } {
  if (!scope || (scope.range === "all" && scope.severity === "all")) return { entries };
  const since = scope.range === "all" ? undefined : Math.max(0, exportedAt - WINDOWS[scope.range]);
  return {
    entries: entries.filter(
      (entry) =>
        (since === undefined || (entry.time >= since && entry.time <= exportedAt)) &&
        (scope.severity === "all" || problemEntry(entry)),
    ),
    ...(since === undefined ? {} : { since, through: exportedAt }),
  };
}

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const headerSchema = v.looseObject({ entries: count, retainedEntries: v.optional(count) });

/** Counts from the exact preview header, rather than the page's earlier status read. */
export function logExportCounts(text: string): { selected: number; retained: number } | undefined {
  try {
    const parsed = v.safeParse(headerSchema, JSON.parse(text.split("\n", 1)[0]!));
    if (!parsed.success) return undefined;
    return {
      selected: parsed.output.entries,
      retained: parsed.output.retainedEntries ?? parsed.output.entries,
    };
  } catch {
    return undefined;
  }
}
