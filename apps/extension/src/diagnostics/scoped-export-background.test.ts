import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "@pateat/contracts";
import { createDiagnosticsLog } from "./background";
import { logExportCounts } from "./log-export";
import type { LogEntry } from "./log-fields";

const NOW = Date.UTC(2026, 10, 12, 12);
const request = {
  version: 1,
  type: "diagnostics.logs.export",
  includeSites: false,
  scope: { range: "15m", severity: "problems" },
} as const;

function setup() {
  return createDiagnosticsLog({
    build: { version: "0.1.0", revision: "synthetic" },
    settings: async () => ({
      revision: 1,
      settings: createDefaultSettings({ connections: [] }),
    }),
    recipeCache: async () => undefined,
    connections: async () => ({ ok: true, kind: "status", connections: [] }),
    databaseName: `scoped-export-${crypto.randomUUID()}`,
    scope: new EventTarget(),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("scoped export in the diagnostics background", () => {
  it("filters actual retained entries without clearing them or changing debug logging", async () => {
    const log = setup();
    await log.logger.started();
    await log.logger.clear();
    await log.logger.log("login.start", {
      origin: "https://private.example",
      recipe: "private-recipe",
    });
    await log.logger.log(
      "login.refused",
      {
        origin: "https://private.example",
        reason: "paused",
      },
      { level: "warn" },
    );
    const before = await log.logger.entries();
    const warnings = before.filter((entry) => entry.level === "warn" || entry.level === "error");
    expect(warnings).toHaveLength(1);
    const now = Math.max(...before.map((entry) => entry.time)) + 1;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const exported = await log.handle(request);
    expect(exported.ok).toBe(true);
    if (!exported.ok || !("text" in exported)) throw new Error("Expected a log export");
    expect(logExportCounts(exported.text)).toEqual({
      selected: warnings.length,
      retained: before.length,
    });
    expect(exported.text).not.toContain("private.example");
    expect(exported.text).not.toContain("private-recipe");
    expect(exported.text).toContain('"reason":"paused"');
    expect(await log.logger.entries()).toEqual(before);

    expect(await log.handle({ version: 1, type: "diagnostics.logs.clear" })).toEqual({ ok: true });
    expect(await log.logger.entries()).toEqual([]);
    const empty = await log.handle(request);
    if (!empty.ok || !("text" in empty)) throw new Error("Expected an empty log export");
    expect(logExportCounts(empty.text)).toEqual({ selected: 0, retained: 0 });
  });

  it("anchors the range after the asynchronous snapshot finishes", async () => {
    const log = setup();
    await log.logger.started();
    const entries: LogEntry[] = [
      { time: NOW, level: "warn", event: "login.refused", fields: { reason: "paused" } },
    ];
    let finish: (entries: LogEntry[]) => void = () => undefined;
    vi.spyOn(log.logger, "entries").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW - 1);
    const pending = log.handle(request);
    clock.mockReturnValue(NOW);
    finish(entries);
    const exported = await pending;
    if (!exported.ok || !("text" in exported)) throw new Error("Expected a log export");
    const header = JSON.parse(exported.text.split("\n")[0]!) as Record<string, unknown>;
    expect(header).toMatchObject({
      exportedAt: new Date(NOW).toISOString(),
      entries: 1,
      scope: { through: new Date(NOW).toISOString() },
    });
    expect(exported.text).toContain('"reason":"paused"');
  });

  it("fails closed on a failed snapshot instead of producing a misleading empty export", async () => {
    const log = setup();
    await log.logger.started();
    vi.spyOn(log.logger, "entries").mockRejectedValueOnce(new Error("storage-failed"));
    expect(await log.handle(request)).toEqual({ ok: false, error: "unavailable" });
  });
});
