import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { i18n, saveLanguagePreference } from "../../apps/extension/src/i18n";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  type LocalSettings,
  type SettingsResponse,
} from "../../packages/contracts/src/index";

const empty = (): LocalSettings => ({ ...createDefaultSettings(), connections: [] });
function accepted(settings = empty()): Extract<SettingsResponse, { ok: true }> {
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 0, settings },
    catalog: { connections: [] },
  };
}
function client() {
  return {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(accepted()),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockImplementation(async (request) => ({
      ...accepted(request.settings),
      snapshot: { version: 1, revision: request.expectedRevision + 1, settings: request.settings },
    })),
    findSiteAccounts: vi
      .fn<SettingsClient["findSiteAccounts"]>()
      .mockImplementation(async (origin) => ({
        version: 1,
        ok: true,
        origin,
        accounts: [],
        complete: true,
      })),
  };
}
function japanese(key: string) {
  const translated = i18n.t(key);
  expect(translated).not.toBe(key);
  return translated;
}
async function mount(value = client()) {
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SettingsApp client={value} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("textbox", { name: "Origin", exact: true })).toBeVisible();
  return value;
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

test("changing language preserves a typed site origin, focus and the theme selection", async () => {
  const value = await mount();
  const origin = page.getByRole("textbox", { name: "Origin", exact: true });
  await page.getByRole("combobox", { name: "Theme", exact: true }).selectOptions("dark");
  await origin.fill("https://draft.example");
  const element = origin.element();
  await i18n.changeLanguage("ja");
  const translated = page.getByRole("textbox", { name: japanese("Origin"), exact: true });
  await expect.element(translated).toHaveValue("https://draft.example");
  await expect.element(translated).toHaveFocus();
  expect(translated.element()).toBe(element);
  await expect
    .element(page.getByRole("combobox", { name: japanese("Theme"), exact: true }))
    .toHaveValue("dark");
  expect(value.saveSettings).not.toHaveBeenCalled();
  await i18n.changeLanguage("en");
  await expect.element(origin).toHaveValue("https://draft.example");
  await expect.element(origin).toHaveFocus();
});

test("a visible origin validation error translates live without submitting the rejected draft", async () => {
  const value = await mount();
  await page.getByRole("textbox", { name: "Origin", exact: true }).fill("invalid origin");
  await page.getByRole("button", { name: "Save default", exact: true }).click();
  const message = "Enter an origin such as https://bank.example, without a path or trailing slash.";
  await expect.element(page.getByRole("alert")).toHaveTextContent(message);
  await i18n.changeLanguage("ja");
  await expect.element(page.getByRole("alert")).toHaveTextContent(japanese(message));
  await expect
    .element(page.getByRole("textbox", { name: japanese("Origin"), exact: true }))
    .toHaveValue("invalid origin");
  expect(value.saveSettings).not.toHaveBeenCalled();
  await i18n.changeLanguage("en");
  await expect.element(page.getByRole("alert")).toHaveTextContent(message);
});

test("a save conflict arriving after a language change keeps the draft and translates again live", async () => {
  const value = client();
  let finish!: (response: SettingsResponse) => void;
  value.saveSettings.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount(value);
  await page.getByRole("textbox", { name: "Origin", exact: true }).fill("draft.example");
  await page.getByRole("button", { name: "Exclude site", exact: true }).click();
  await vi.waitFor(() => expect(value.saveSettings).toHaveBeenCalledOnce());
  await i18n.changeLanguage("ja");
  finish({
    version: 1,
    ok: false,
    error: { code: "revision-conflict", message: "Synthetic stale revision" },
  });
  // With no recorded cause the line names an unrecorded change (ADR 0025).
  const message =
    "The saved settings changed before this save: settings changed for a reason no longer recorded. Your unsaved changes are kept. Reload saved settings to see the latest ones before you change anything else; reloading drops them.";
  await expect
    .poll(() => document.getElementById("settings-status")?.textContent)
    .toContain(
      "この保存の前に保存済みの設定が変更されました（理由の記録が残っていない変更）。未保存の変更は保持されています。",
    );
  expect(document.getElementById("site-list")?.textContent).toContain("draft.example");
  expect(value.saveSettings).toHaveBeenCalledOnce();
  await i18n.changeLanguage("en");
  await expect
    .poll(() => document.getElementById("settings-status")?.textContent)
    .toContain(message);
  expect(document.getElementById("site-list")?.textContent).toContain("draft.example");
});
