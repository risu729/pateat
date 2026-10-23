import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the shared extension stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the popup stylesheet.
import "../../apps/extension/entrypoints/popup/style.css";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
import { SiteApp } from "../../apps/extension/src/popup/site-app";
import { createDefaultSettings, DUMMY_VAULT_CATALOG } from "../../packages/contracts/src/index";

// Layout checks with the real stylesheets at the popup's 360px width. Synthetic settings
// and vault matches only.

const HOSTNAME =
  "a-rather-long-subdomain-name.accounts.an-unusually-long-bank-name-for-a-test.example";
const ORIGIN = `https://${HOSTNAME}`;

afterEach(() => cleanup());

test("long hostnames and usernames wrap inside the 360px popup", async () => {
  await page.viewport(360, 800);
  const settings = createDefaultSettings();
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings },
      catalog: DUMMY_VAULT_CATALOG,
    }),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: true,
      origin: ORIGIN,
      complete: false,
      accounts: [
        {
          connectionId: "demo-personal",
          itemId: "primary",
          uri: true,
          passkey: false,
          username: "a.very.long.username.without.spaces@an-unusually-long-mail-domain.example",
        },
        { connectionId: "demo-work", itemId: "primary", uri: true, passkey: false },
      ],
    }),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({
      ok: true,
      origin: ORIGIN,
      documentId: "refused-document",
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
      held: true,
    }),
    pick: vi.fn<ChoiceClient["pick"]>(),
    pause: vi.fn<ChoiceClient["pause"]>(),
    status: vi
      .fn<ChoiceClient["status"]>()
      .mockResolvedValue({ ok: true, origin: ORIGIN, recipe: "page" }),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          openDiagnostics: vi.fn(),
          close: vi.fn(),
          watchSettings: () => () => {},
        }}
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect
    .element(page.getByText("Some vaults or items could not be checked", { exact: false }))
    .toBeVisible();
  const main = document.querySelector("main")!;
  expect(main.getBoundingClientRect().width).toBe(360);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  // The empty live region stays rendered, so its first message is announced.
  const message = document.querySelector("#popup-message")!;
  expect(message.textContent).toBe("");
  expect(getComputedStyle(message).display).not.toBe("none");
  // The pause row's three lengths fit inside the popup.
  const row = page.getByRole("group", { name: "Pause automatic login" }).element();
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(360);
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
});

test("the page section's long log codes wrap inside the 360px popup", async () => {
  await page.viewport(360, 800);
  const settings = createDefaultSettings();
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings },
      catalog: DUMMY_VAULT_CATALOG,
    }),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: true,
      origin: ORIGIN,
      complete: true,
      accounts: [{ connectionId: "demo-work", itemId: "primary", uri: true, passkey: false }],
    }),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({ ok: false, reason: "no-choice" }),
    pick: vi.fn<ChoiceClient["pick"]>(),
    pause: vi.fn<ChoiceClient["pause"]>(),
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({
      ok: true,
      origin: ORIGIN,
      // Every line kind that carries a log code; the request in flight has none.
      recipe: "other-paths",
      page: { generationSkip: `incomplete-observation-${"unfillable-field-".repeat(6)}gap` },
      login: {
        state: "blocked",
        outcome: "structural-mismatch",
        cause: "elements-timeout",
      },
      refused: { reason: "no-route", detail: "password-not-allowed:no-passkey" },
      generation: {
        outcome: "failed",
        reason: `invalid-output:${"schema-check-refused-".repeat(5)}end`,
        page: "continuation",
      },
    }),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          openDiagnostics: vi.fn(),
          close: vi.fn(),
          watchSettings: () => () => {},
        }}
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("heading", { name: "This page" })).toBeVisible();
  await expect.element(page.getByText("Pateat did not log in", { exact: false })).toBeVisible();
  const lines = [...document.querySelectorAll("#popup-page-status > li")];
  expect(lines.map((line) => line.id)).toEqual([
    "popup-page-recipe",
    "popup-page-generation",
    "popup-page-generation-skip",
    "popup-page-login",
    "popup-page-login-recipe",
    "popup-page-refused",
  ]);
  const main = document.querySelector("main")!;
  expect(main.getBoundingClientRect().width).toBe(360);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  const section = document.querySelector("#popup-page-status")!;
  expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  const right = main.getBoundingClientRect().right;
  for (const line of lines) {
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(right);
    // Each line's icon keeps its size beside the wrapped text.
    expect(line.querySelector("svg")!.getBoundingClientRect()).toMatchObject({
      width: 16,
      height: 16,
    });
  }
  const link = document.querySelector("#popup-open-diagnostics")!;
  expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(right);
});
