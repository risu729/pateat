import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { i18n, saveLanguagePreference } from "../../apps/extension/src/i18n";
import { ServiceConnection } from "../../apps/extension/src/options/service-connection";
import type { ServiceClient } from "../../apps/extension/src/options/service-client";
import { DiagnosticsApp, type DiagnosticsClient } from "../../apps/extension/src/diagnostics/app";
import type { DiagnosticsStatus } from "../../apps/extension/src/diagnostics/wire";
import type { ServiceResponse } from "../../packages/contracts/src/index";

const ORIGIN = "https://synthetic-service.example";
function japanese(key: string) {
  const translated = i18n.t(key);
  expect(translated).not.toBe(key);
  return translated;
}
function service() {
  return {
    get: vi
      .fn<ServiceClient["get"]>()
      .mockResolvedValue({ ok: true, state: { kind: "disconnected" } }),
    requestSiteAccess: vi.fn<ServiceClient["requestSiteAccess"]>().mockResolvedValue(true),
    pair: vi.fn<ServiceClient["pair"]>(),
    forget: vi.fn<ServiceClient["forget"]>(),
    disconnect: vi.fn<ServiceClient["disconnect"]>(),
    openSignIn: vi.fn<ServiceClient["openSignIn"]>(),
  };
}
const status: DiagnosticsStatus = {
  version: 1,
  collectedAt: Date.UTC(2026, 9, 17),
  build: {
    version: "0.1.0",
    revision: "a".repeat(40),
    mode: "production",
    bitwardenSdk: "synthetic-sdk-version",
    bitwardenProtocol: "synthetic-protocol",
  },
  platform: { os: "linux", arch: "x86-64" },
  permissions: { permissions: ["storage"], origins: ["https://*/*"], otherOrigins: 0 },
  actionIcon: "unlocked",
  cryptoHost: { ready: false, sessions: 0 },
  connections: [],
  service: { kind: "not-configured" },
  settings: { excludedSites: 0, siteDefaults: 0, bindings: 0 },
  storage: { localBytes: 100 },
  logs: { entries: 2, bytes: 100, recentErrors: 0, recentWarnings: 0 },
  checks: [
    { id: "synthetic-unknown-check", level: "warn", detail: "<img src=x onerror=alert(1)>" },
  ],
};
function diagnostics() {
  return {
    load: vi
      .fn<DiagnosticsClient["load"]>()
      .mockResolvedValue({ ok: true, status: structuredClone(status) }),
    browser: vi
      .fn<DiagnosticsClient["browser"]>()
      .mockResolvedValue({ name: "Chrome", version: "154.0", installType: "development" }),
    copy: vi.fn<DiagnosticsClient["copy"]>().mockResolvedValue(undefined),
    exportLogs: vi.fn<DiagnosticsClient["exportLogs"]>().mockResolvedValue({
      ok: true,
      text: '{"type":"synthetic-code","detail":"literal-value"}\n',
    }),
    clearLogs: vi.fn<DiagnosticsClient["clearLogs"]>(),
    setDebugLogs: vi.fn<DiagnosticsClient["setDebugLogs"]>(),
    download: vi.fn<DiagnosticsClient["download"]>(),
  };
}
beforeEach(() => {
  localStorage.clear();
  saveLanguagePreference("en");
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

test("service language changes retain pairing inputs and localize an asynchronous failure without retrying", async () => {
  const value = service();
  let finish!: (response: ServiceResponse) => void;
  value.pair.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render(<ServiceConnection client={value} pollMs={60_000} />);
  await page.getByLabelText("Service address", { exact: true }).fill(ORIGIN);
  const label = page.getByLabelText("Device name", { exact: true });
  await label.fill("Synthetic device");
  const element = label.element();
  await i18n.changeLanguage("ja");
  const translated = page.getByLabelText(japanese("Device name"), { exact: true });
  await expect.element(translated).toHaveValue("Synthetic device");
  await expect.element(translated).toHaveFocus();
  expect(translated.element()).toBe(element);
  await expect
    .element(page.getByLabelText(japanese("Service address"), { exact: true }))
    .toHaveValue(ORIGIN);
  await page.getByRole("button", { name: japanese("Pair this device"), exact: true }).click();
  await vi.waitFor(() => expect(value.pair).toHaveBeenCalledOnce());
  finish({ ok: false, error: "unreachable", state: { kind: "disconnected" } });
  const message = "The service could not be reached. Check the address, then try again.";
  await expect.element(page.getByText(japanese(message), { exact: true })).toBeVisible();
  await i18n.changeLanguage("en");
  await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  expect(value.pair).toHaveBeenCalledExactlyOnceWith(ORIGIN, "Synthetic device", undefined);
  expect(value.openSignIn).not.toHaveBeenCalled();
});

test("service address validation changes language without requesting access or losing its input", async () => {
  const value = service();
  await render(<ServiceConnection client={value} pollMs={60_000} />);
  await page.getByLabelText("Service address", { exact: true }).fill("http://invalid.example");
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  const error = document.getElementById("sync-service-error")?.textContent;
  expect(error).toContain("HTTPS");
  await i18n.changeLanguage("ja");
  await expect
    .poll(() => document.getElementById("sync-service-error")?.textContent)
    .not.toBe(error);
  await expect
    .element(page.getByLabelText(japanese("Service address"), { exact: true }))
    .toHaveValue("http://invalid.example");
  expect(value.requestSiteAccess).not.toHaveBeenCalled();
  expect(value.pair).not.toHaveBeenCalled();
});

test("diagnostics UI relocalizes while the copied report and raw codes remain stable", async () => {
  const value = diagnostics();
  let finish!: () => void;
  value.copy.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <DiagnosticsApp client={value} />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Copy for bug report", exact: true }).click();
  const preview = document.getElementById("report-preview");
  expect(preview?.textContent).toContain("synthetic-sdk-version");
  const english = preview?.textContent;
  await i18n.changeLanguage("ja");
  await expect
    .element(page.getByRole("heading", { name: japanese("Bug report text"), exact: true }))
    .toBeVisible();
  expect(document.getElementById("report-preview")?.textContent).toBe(english);
  // The translated note keeps its markup around the button's name and the site number.
  const codes = [...document.querySelectorAll("main code")].map((code) => code.textContent);
  expect(codes).toContain("site-1");
  const strong = [...document.querySelectorAll("main strong")].map((bold) => bold.textContent);
  expect(strong).toContain(japanese("Download logs"));
  expect(document.getElementById("report-preview")).toBe(preview);
  expect(preview?.textContent).toContain("synthetic-sdk-version");
  expect(preview?.textContent).toContain("synthetic-protocol");
  expect(document.querySelector("main")?.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(document.querySelector("main img")).toBeNull();
  await page.getByRole("button", { name: japanese("Copy"), exact: true }).click();
  expect(value.copy).toHaveBeenCalledExactlyOnceWith(preview?.textContent);
  await i18n.changeLanguage("en");
  finish();
  const message = "Copied. Paste it into the bug report.";
  await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  await i18n.changeLanguage("ja");
  await expect.element(page.getByText(japanese(message), { exact: true })).toBeVisible();
  expect(value.load).toHaveBeenCalledOnce();
});

test("changing diagnostics language leaves exported JSONL bytes and download contents unchanged", async () => {
  const value = diagnostics();
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <DiagnosticsApp client={value} />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Download logs", exact: true }).click();
  const raw = '{"type":"synthetic-code","detail":"literal-value"}\n';
  await expect.poll(() => document.getElementById("logs-preview")?.textContent).toBe(raw);
  await i18n.changeLanguage("ja");
  expect(document.getElementById("logs-preview")?.textContent).toBe(raw);
  await page.getByRole("button", { name: japanese("Save file"), exact: true }).click();
  expect(value.download).toHaveBeenCalledExactlyOnceWith(raw, expect.stringMatching(/\.jsonl$/u));
  expect(value.exportLogs).toHaveBeenCalledExactlyOnceWith(true);
});

test.each([1, 2])(
  "diagnostics counts keep English singular/plural and localize %s in Japanese",
  async (count) => {
    const value = diagnostics();
    value.load.mockResolvedValue({
      ok: true,
      status: {
        ...structuredClone(status),
        permissions: { ...status.permissions, otherOrigins: count },
        service: {
          kind: "connected",
          settingsRevision: 0,
          recipes: { count: 0, bytes: 0 },
          device: {
            ok: true,
            pairedAt: status.collectedAt,
            recipes: count,
            settingsRevision: 0,
            generation: "ok",
          },
        },
        checks: [{ id: "service-copy", level: "warn", detail: "Synthetic recipe mismatch" }],
      },
    });
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <DiagnosticsApp client={value} />
      </QueryClientProvider>,
    );
    const suffix = count === 1 ? "" : "s";
    await expect
      .element(page.getByText(new RegExp(` \\+ ${count} granted site${suffix}$`, "u")))
      .toBeVisible();
    await expect
      .element(page.getByText(`service ${count} recipe${suffix}, cached 0`, { exact: false }))
      .toBeVisible();
    await i18n.changeLanguage("ja");
    const translated = i18n.t("service {{recipes}}, cached {{local}}", {
      recipes: i18n.t("diagnostics.count.recipe", { count }),
      local: 0,
    });
    expect(translated).not.toContain("recipe");
    await expect.element(page.getByText(translated, { exact: false })).toBeVisible();
    expect(value.load).toHaveBeenCalledOnce();
  },
);
