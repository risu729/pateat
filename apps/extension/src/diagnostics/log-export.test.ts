import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { formatLogExport } from "./log-format";
import { logExportCounts, type LogExportScope } from "./log-export";
import type { LogEntry } from "./log-fields";
import { diagnosticsRequestSchema } from "./wire";

const NOW = Date.UTC(2026, 10, 12, 12);
const context = { version: "0.1.0", revision: "synthetic", exportedAt: NOW, includeSites: false };
const entry = (time: number, level: LogEntry["level"] = "warn"): LogEntry => ({
  time,
  level,
  event: "login.start",
  fields: { origin: "https://login.example", recipe: "synthetic-recipe", url: "/signin" },
});
const records = (text: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("scoped log export", () => {
  it.each([
    ["15m", 15 * 60_000],
    ["1h", 60 * 60_000],
    ["24h", 24 * 60 * 60_000],
  ] as const)(
    "exports both %s boundaries, excluding old and future-clock rows",
    (range, window) => {
      const entries = [
        entry(NOW - window - 1),
        entry(NOW - window, "info"),
        entry(NOW - 1, "warn"),
        entry(NOW, "error"),
        entry(NOW + 1),
      ];
      const text = formatLogExport(entries, { ...context, scope: { range, severity: "all" } });
      const [header, ...rows] = records(text);
      expect(header).toEqual({
        pateat: "0.1.0",
        revision: "synthetic",
        exportedAt: new Date(NOW).toISOString(),
        sites: "replaced",
        entries: 3,
        retainedEntries: 5,
        scope: {
          range,
          severity: "all",
          since: new Date(NOW - window).toISOString(),
          through: new Date(NOW).toISOString(),
        },
      });
      expect(rows.map((row) => row["time"])).toEqual(
        [NOW - window, NOW - 1, NOW].map((time) => new Date(time).toISOString()),
      );
      expect(rows.map((row) => row["level"])).toEqual(["info", "warn", "error"]);
      expect(entries).toHaveLength(5);
    },
  );

  it("intersects time and severity without broadening the established site privacy", () => {
    const entries = [
      entry(NOW - 16 * 60_000, "error"),
      entry(NOW - 3, "debug"),
      entry(NOW - 2, "info"),
      entry(NOW - 1, "warn"),
      entry(NOW, "error"),
      entry(NOW + 1, "error"),
    ];
    const scope: LogExportScope = { range: "15m", severity: "problems" };
    const hidden = formatLogExport(entries, { ...context, scope });
    const [header, ...rows] = records(hidden);
    expect(header).toMatchObject({ entries: 2, retainedEntries: 6 });
    expect(rows.map((row) => row["level"])).toEqual(["warn", "error"]);
    expect(rows).toEqual([
      {
        time: new Date(NOW - 1).toISOString(),
        level: "warn",
        event: "login.start",
        origin: "site-1",
        recipe: "recipe-1",
      },
      {
        time: new Date(NOW).toISOString(),
        level: "error",
        event: "login.start",
        origin: "site-1",
        recipe: "recipe-1",
      },
    ]);
    expect(hidden).not.toContain("login.example");
    expect(hidden).not.toContain("synthetic-recipe");
    expect(hidden).not.toContain("/signin");
    const [, included] = records(
      formatLogExport(entries, { ...context, includeSites: true, scope }),
    );
    expect(included).toMatchObject({
      origin: "https://login.example",
      recipe: "synthetic-recipe",
      url: "/signin",
    });
  });

  it("preserves all retained rows and the original header when scope is omitted or all/all", () => {
    const entries = [entry(0, "debug"), entry(NOW, "info"), entry(NOW + 86_400_000, "error")];
    const original = formatLogExport(entries, context);
    const explicit = formatLogExport(entries, {
      ...context,
      scope: { range: "all", severity: "all" },
    });
    expect(explicit).toBe(original);
    const [header, ...rows] = records(original);
    expect(header).toEqual({
      pateat: "0.1.0",
      revision: "synthetic",
      exportedAt: new Date(NOW).toISOString(),
      sites: "replaced",
      entries: 3,
    });
    expect(rows).toHaveLength(3);
    expect(rows[2]?.["time"]).toBe(new Date(NOW + 86_400_000).toISOString());
  });

  it("keeps future-clock problems when only severity is restricted", () => {
    const [header, ...rows] = records(
      formatLogExport([entry(0, "info"), entry(1, "warn"), entry(NOW + 1, "error")], {
        ...context,
        scope: { range: "all", severity: "problems" },
      }),
    );
    expect(header).toMatchObject({
      entries: 2,
      retainedEntries: 3,
      scope: { range: "all", severity: "problems" },
    });
    expect(header?.["scope"]).toEqual({ range: "all", severity: "problems" });
    expect(rows.map((row) => row["level"])).toEqual(["warn", "error"]);
  });

  it("exports a valid header-only selection without changing retained rows", () => {
    const entries = [entry(NOW, "info")];
    const text = formatLogExport(entries, {
      ...context,
      scope: { range: "1h", severity: "problems" },
    });
    expect(records(text)).toHaveLength(1);
    expect(text.endsWith("\n")).toBe(true);
    expect(logExportCounts(text)).toEqual({ selected: 0, retained: 1 });
    expect(entries).toEqual([entry(NOW, "info")]);
    expect(logExportCounts(formatLogExport([], context))).toEqual({ selected: 0, retained: 0 });
  });

  it("reads preview counts from its header and rejects malformed counts", () => {
    expect(logExportCounts('{"entries":2,"retainedEntries":17}\n{}\n{}\n')).toEqual({
      selected: 2,
      retained: 17,
    });
    expect(logExportCounts('{"entries":2}\n{}\n{}\n')).toEqual({ selected: 2, retained: 2 });
    for (const text of [
      "",
      "{",
      "null",
      "[]",
      '{"entries":-1}',
      '{"entries":1.5}',
      '{"entries":"2"}',
      '{"entries":1,"retainedEntries":null}',
    ])
      expect(logExportCounts(text)).toBeUndefined();
  });

  it("accepts only complete, known export scopes at the background message boundary", () => {
    const request = { version: 1, type: "diagnostics.logs.export", includeSites: false };
    expect(v.safeParse(diagnosticsRequestSchema, request).success).toBe(true);
    for (const range of ["all", "15m", "1h", "24h"])
      for (const severity of ["all", "problems"])
        expect(
          v.safeParse(diagnosticsRequestSchema, { ...request, scope: { range, severity } }).success,
        ).toBe(true);
    for (const scope of [
      null,
      {},
      { range: "15m" },
      { severity: "problems" },
      { range: "5m", severity: "all" },
      { range: "all", severity: "error" },
      { range: "all", severity: "all", since: 0 },
      { range: "all", severity: "all", includeSites: true },
    ])
      expect(v.safeParse(diagnosticsRequestSchema, { ...request, scope }).success).toBe(false);
  });
});
