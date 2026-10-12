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
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        host={{
          currentTab: async () => ({ id: 7, url: `${ORIGIN}/login`, incognito: false }),
          openSettings: vi.fn(),
          close: vi.fn(),
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
  // The switch keeps its size beside its label.
  const toggle = page.getByRole("switch", { name: "Pateat on this site" }).element();
  expect(toggle.getBoundingClientRect()).toMatchObject({ width: 36, height: 20 });
});
