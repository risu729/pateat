import { expect, it } from "vitest";
import { formatLogExport, type LogEntry } from "../../src/diagnostics/log";
import type { LogTestContext } from "./log-context";

export function registerExportCases({
  NOW,
  entries,
  context,
}: Pick<LogTestContext, "NOW" | "entries" | "context">) {
  it("numbers sites and recipes within one export unless they are included", () => {
    const lines = formatLogExport(entries, { ...context, includeSites: false })
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({
      pateat: "0.1.0",
      revision: "1c42ad3",
      exportedAt: "2026-10-11T10:36:00.000Z",
      sites: "replaced",
      entries: 3,
    });
    expect(lines.slice(1)).toEqual([
      {
        time: "2026-10-11T10:35:00.000Z",
        level: "info",
        event: "login.attempt",
        origin: "site-1",
        recipe: "recipe-1",
        state: "authenticated",
      },
      {
        time: "2026-10-11T10:35:01.000Z",
        level: "info",
        event: "passkey.request",
        origin: "site-2",
        rpId: "site-1",
        outcome: "assertion",
      },
      {
        time: "2026-10-11T10:35:02.000Z",
        level: "info",
        event: "login.attempt",
        origin: "site-1",
        recipe: "recipe-1",
        state: "blocked",
      },
    ]);
    const included = formatLogExport(entries, { ...context, includeSites: true });
    expect(included).toContain('"origin":"https://bank.example"');
    expect(included).toContain('"recipe":"bank-signin"');
  });

  it("leaves out a stored field that is not allowlisted or fails its check", () => {
    const text = formatLogExport(
      [
        {
          time: NOW,
          level: "info",
          event: "login.refused",
          fields: { origin: "https://bank.example/path?token=x", reason: "x", email: "a@b" },
        },
      ],
      { ...context, includeSites: true },
    );
    expect(text).not.toContain("token");
    expect(text).not.toContain("a@b");
    expect(text).toContain('"reason":"x"');
  });

  it("leaves out a page URL stored with its parameters' values", () => {
    const stored = (url: string): LogEntry => ({
      time: NOW,
      level: "info",
      event: "login.attempt",
      fields: { origin: "https://bank.example", url },
    });
    const text = formatLogExport(
      [
        stored("/callback?code=S3cr3t&state=S3cr3t"),
        stored("/cb#access_token=S3cr3t"),
        stored("/magic?S3cr3t"),
        stored("/callback?code=&state="),
        stored("/app#/reset?token="),
      ],
      { ...context, includeSites: true },
    );
    expect(text).not.toContain("S3cr3t");
    expect(text).toContain('"url":"/callback?code=&state="');
    expect(text).toContain('"url":"/app#/reset?token="');
  });
}
