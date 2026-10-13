import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import { DiagnosticsApp, type DiagnosticsClient } from "../../apps/extension/src/diagnostics/app";
import type { DiagnosticsStatus } from "../../apps/extension/src/diagnostics/wire";

// The diagnostics page with a synthetic summary: icon-led checks, the panels and debug logging.

const NOW = Date.UTC(2026, 9, 12, 20, 25);

function status(overrides: Partial<DiagnosticsStatus> = {}): DiagnosticsStatus {
  return {
    version: 1,
    collectedAt: NOW,
    build: {
      version: "0.1.0",
      revision: "786d218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mode: "production",
      bitwardenSdk: "0.2.0-main.1100",
      bitwardenProtocol: "client 2026.2.0, Device-Type 2",
    },
    platform: { os: "win", arch: "x86-64" },
    permissions: {
      permissions: ["alarms", "storage", "offscreen"],
      origins: ["https://*/*"],
      otherOrigins: 0,
    },
    actionIcon: "unlocked",
    cryptoHost: { ready: false, sessions: 0 },
    connections: [
      {
        id: "bitwarden:3f9a1c",
        environment: "cloud-us",
        state: "ready",
        autoUnlock: "enabled",
        providerSession: "active",
        acceptedAt: NOW - 4 * 60_000,
        unlockKdf: "PBKDF2-SHA256 600000",
        server: { ok: true, version: "2026.9.1", kind: "bitwarden" },
      },
    ],
    service: { kind: "not-configured" },
    settings: { excludedSites: 2, siteDefaults: 2, bindings: 0 },
    storage: { localBytes: 900 },
    logs: { entries: 1284, bytes: 212 * 1024, recentErrors: 0, recentWarnings: 2 },
    checks: [
      { id: "site-access", level: "ok", detail: "https://*/* site access granted" },
      { id: "logs", level: "info", detail: "0 errors, 2 warnings logged in the last 24 h" },
      { id: "recipe-cache", level: "warn", detail: "recipe cache full" },
      { id: "connections", level: "error", detail: "connections unreadable" },
    ],
    ...overrides,
  };
}

function client(value: DiagnosticsStatus) {
  return {
    load: vi.fn(async () => ({ ok: true as const, status: value })),
    browser: vi.fn(async () => ({
      name: "Chrome",
      version: "154.0.8037.97",
      installType: "development",
    })),
    copy: vi.fn(async () => undefined),
    exportLogs: vi.fn(async () => ({ ok: true as const, text: "{}\n" })),
    clearLogs: vi.fn(async () => ({ ok: true as const })),
    setDebugLogs: vi.fn(async () => ({ ok: true as const })),
    download: vi.fn(),
  } satisfies DiagnosticsClient;
}

async function show(value: DiagnosticsClient) {
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <DiagnosticsApp client={value} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "Checks" })).toBeVisible();
}

afterEach(async () => {
  await cleanup();
});

test("each check is a line led by an icon, with its level read out", async () => {
  await show(client(status()));
  const lines = page.getByRole("list").first().getByRole("listitem");
  await expect.element(lines.nth(0)).toHaveTextContent("OK https://*/* site access granted");
  await expect.element(lines.nth(2)).toHaveTextContent("Warning recipe cache full");
  await expect.element(lines.nth(3)).toHaveTextContent("Error connections unreadable");
  for (const line of lines.all()) {
    const icon = line.element().querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  }
});

test("shows every panel's facts, with the build mode and no separators", async () => {
  await show(client(status()));
  await Promise.all(
    ["Version", "Settings and storage", "Bitwarden connections", "Pateat service", "Logs"].map(
      (name) => expect.element(page.getByRole("heading", { name, exact: true })).toBeVisible(),
    ),
  );
  await expect
    .element(page.getByRole("definition").filter({ hasText: /^0\.1\.0/u }))
    .toHaveTextContent("0.1.0 (786d218) production build");
  await expect
    .element(page.getByRole("definition").filter({ hasText: /^alarms/u }))
    .toHaveTextContent("alarms, storage, offscreen, https://*/*");
  await expect.element(page.getByText("PBKDF2-SHA256 600000")).toBeVisible();
  await expect.element(page.getByText("14 days")).toBeVisible();
  await expect
    .element(
      page.getByText(
        "No passwords, keys, field values, names or emails are shown, copied or saved",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByText(/^With site addresses included, a download names page paths/u))
    .toBeVisible();
  expect(document.querySelector("main")!.textContent).not.toContain("·");
});

test("debug logging shows when it ends and turns off at once", async () => {
  const debugUntil = NOW + 24 * 60 * 60_000;
  const value = client(
    status({
      logs: { entries: 3, bytes: 1024, recentErrors: 0, recentWarnings: 0, debugUntil },
    }),
  );
  await show(value);
  await expect.element(page.getByText(/^on until 2026-10-13T20:25Z/u)).toBeVisible();
  await page.getByRole("button", { name: "Turn off debug logging" }).click();
  expect(value.setDebugLogs).toHaveBeenCalledWith(false);
  await expect.element(page.getByText("Debug logging is off.")).toBeVisible();
});

test("debug logging that is off offers 24 hours", async () => {
  const value = client(status());
  await show(value);
  await expect.element(page.getByText("off", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Turn on debug logging for 24 hours" }).click();
  expect(value.setDebugLogs).toHaveBeenCalledWith(true);
  await expect.element(page.getByText("Debug logging is on for 24 hours.")).toBeVisible();
});
