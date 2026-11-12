import { QueryClientProvider } from "@tanstack/react-query";
import { expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../../apps/extension/src/options/client";
import { SettingsApp } from "../../../apps/extension/src/options/settings-app";
import type { NavigationPreferenceContext } from "./context";

export function registerNavigationAndPreferences({
  saved,
  mockClient,
  control,
  mount,
  navLink,
  disconnectedService,
}: NavigationPreferenceContext) {
  test("the section nav marks the section scrolled into view after settings load", async () => {
    await page.viewport(400, 300);
    try {
      await mount();
      await expect.element(navLink("Demo vaults")).toHaveAttribute("aria-current", "location");
      // Loading replaced the placeholder Sites section; the nav must follow the new one.
      document.getElementById("sites")?.scrollIntoView({ block: "start" });
      await expect.element(navLink("Sites")).toHaveAttribute("aria-current", "location");
      await expect.element(navLink("Demo vaults")).not.toHaveAttribute("aria-current");
      document.getElementById("demo-vaults")?.scrollIntoView({ block: "start" });
      await expect.element(navLink("Demo vaults")).toHaveAttribute("aria-current", "location");
    } finally {
      await page.viewport(414, 896);
    }
  });

  test("at the bottom of the page the section nav marks the last section shown", async () => {
    await page.viewport(800, 600);
    try {
      await mount(mockClient(), disconnectedService());
      await expect.element(control("sync")).toBeInTheDocument();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.element(navLink("Sync service")).toHaveAttribute("aria-current", "location");
    } finally {
      await page.viewport(414, 896);
    }
  });

  test("a clicked section link stays current until the user scrolls", async () => {
    await page.viewport(800, 600);
    try {
      await mount(mockClient(), disconnectedService());
      await expect.element(control("sync")).toBeInTheDocument();
      for (const name of ["Sites", "Sync service"]) {
        window.scrollTo(0, 0);
        // oxlint-disable-next-line no-await-in-loop
        await navLink(name).click();
        // The page cannot scroll the section to the top; the jump must not move the mark.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
        // oxlint-disable-next-line no-await-in-loop
        await expect.element(navLink(name)).toHaveAttribute("aria-current", "location");
      }
      document.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      window.scrollTo(0, 0);
      await expect.element(navLink("Demo vaults")).toHaveAttribute("aria-current", "location");
    } finally {
      await page.viewport(414, 896);
    }
  });

  test("the vault timeout has its own section only with Bitwarden, as a synced setting", async () => {
    await mount();
    const nav = page.getByRole("navigation", { name: "Sections" });
    await expect.element(nav).toBeVisible();
    expect(nav.getByText("Vault timeout").query()).toBeNull();
    expect(document.querySelector("#vault-timeout")).toBeNull();
    await cleanup();
    const client = mockClient();
    const stored = saved();
    stored.snapshot.settings.vaultTimeout = { timeout: 15, action: "lock" };
    client.getSettings.mockResolvedValue(stored);
    await render(
      <QueryClientProvider client={createMetadataQueryClient()}>
        <SettingsApp client={client} vaultTimeout />
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole("navigation", { name: "Sections" }).getByText("Vault timeout"))
      .toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Vault timeout", exact: true }))
      .toBeVisible();
    const select = page.getById("vault-timeout-select");
    await expect.element(select).toHaveValue("15");
    expect(client.saveSettings).not.toHaveBeenCalled();
    await select.selectOptions("restart");
    await vi.waitFor(() => expect(client.saveSettings).toHaveBeenCalledOnce());
    expect(client.saveSettings.mock.calls[0]?.[0].settings.vaultTimeout).toEqual({
      timeout: "restart",
      action: "lock",
    });
  });

  test("the theme and language are saved with the profile's other settings", async () => {
    onTestFinished(() => {
      localStorage.clear();
      document.documentElement.removeAttribute("data-theme");
    });
    const client = mockClient();
    await mount(client);
    const theme = page.getByRole("combobox", { name: "Theme", exact: true });
    await expect.element(theme).toBeEnabled();
    await theme.selectOptions("dark");
    await vi.waitFor(() => expect(client.saveSettings).toHaveBeenCalledOnce());
    expect(client.saveSettings.mock.calls[0]?.[0].settings.theme).toBe("dark");
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOptions("en");
    await vi.waitFor(() => expect(client.saveSettings).toHaveBeenCalledTimes(2));
    expect(client.saveSettings.mock.calls[1]?.[0].settings).toMatchObject({
      theme: "dark",
      language: "en",
    });
    await page.getByRole("combobox", { name: "Theme", exact: true }).selectOptions("system");
    await vi.waitFor(() => expect(client.saveSettings).toHaveBeenCalledTimes(3));
    expect(client.saveSettings.mock.calls[2]?.[0].settings.theme).toBeUndefined();
  });

  test("the allowed sites turn on, list sites and stay listed when turned off (ADR 0077)", async () => {
    const client = mockClient();
    await mount(client);
    const allowlist = page.getByRole("switch", {
      name: "Log in automatically only on allowed sites",
    });
    await expect.element(allowlist).not.toBeChecked();
    await expect
      .element(page.getByText("While this is off, the list pauses nothing."))
      .toBeVisible();
    await userEvent.click(allowlist);
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({
      allowedSitesEnabled: true,
    });
    await expect
      .element(
        page.getByText(
          "No site is allowed, so automatic login is paused everywhere until you allow one.",
        ),
      )
      .toBeVisible();
    await control("allowed-site").fill("not a site");
    await control("add-allowed-site").click();
    await expect
      .element(page.getByText("Enter a site such as https://bank.example or bank.example."))
      .toBeVisible();
    await expect.element(control("allowed-site")).toHaveFocus();
    await control("allowed-site").fill("https://Bank.Example");
    await control("allowed-site-subdomains").click();
    await control("add-allowed-site").click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.allowedSites).toEqual([
      { hostname: "bank.example", includeSubdomains: true },
    ]);
    await expect
      .element(
        page.getByText(
          "Pateat logs in by itself only on these sites, and pauses automatic login on every other site.",
        ),
      )
      .toBeVisible();
    await expect.element(control("allowed-site")).toHaveValue("");
    await userEvent.click(allowlist);
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    expect(client.saveSettings.mock.calls[2]?.[0].settings).toMatchObject({
      allowedSitesEnabled: false,
      allowedSites: [{ hostname: "bank.example", includeSubdomains: true }],
    });
    await page
      .getByRole("button", { name: "Remove bank.example and subdomains from the allowed sites" })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 4).");
    expect(client.saveSettings.mock.calls[3]?.[0].settings.allowedSites).toEqual([]);
  });

  test("a default on a site the allowed sites leave out stays usable, as on a paused site", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.allowedSitesEnabled = true;
    response.snapshot.settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    const select = page.getByRole("combobox", { name: "Default account for https://bank.example" });
    await expect.element(select).toBeVisible();
    // A pick in the popup still uses it there (ADR 0077).
    await expect.element(select).not.toHaveDisplayValue(/unavailable/u);
  });

  test("the popup's This page checkbox sits under the theme and saves to the synced settings", async () => {
    const client = mockClient();
    await mount(client);
    const checkbox = page.getByRole("checkbox", { name: 'Show "This page" in the popup' });
    await expect.element(checkbox).toBeChecked();
    // Under the Theme select, in the section list.
    const theme = document.querySelector("#theme-preference")!;
    expect(
      theme.compareDocumentPosition(checkbox.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(checkbox.element().closest("nav")).not.toBeNull();
    await checkbox.click();
    await expect.poll(() => client.saveSettings.mock.calls.length).toBe(1);
    expect(client.saveSettings.mock.calls[0]![0].settings.popupPageSection).toBe(false);
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    await expect.element(checkbox).not.toBeChecked();
    await checkbox.click();
    await expect.poll(() => client.saveSettings.mock.calls.length).toBe(2);
    expect(client.saveSettings.mock.calls[1]![0].settings.popupPageSection).toBeUndefined();
  });
}
