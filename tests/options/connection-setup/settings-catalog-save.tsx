import { QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../../apps/extension/src/options/client";
import { SettingsApp } from "../../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
} from "../../../packages/contracts/src/index";
import type { ConnectionSetupTestContext } from "./context";

export function registerSettingsCatalogSave({
  mockClient,
  fillNew,
}: Pick<ConnectionSetupTestContext, "mockClient" | "fillNew">) {
  test.each(["storage-uncertain", "setup-unavailable"] as const)(
    "a resolved %s setup outcome preserves a dirty policy draft and fences saving until explicit reload",
    async (code) => {
      const connection = mockClient();
      connection.begin.mockResolvedValue({ ok: false, error: { code } });
      function saved(revision: number): Extract<SettingsResponse, { ok: true }> {
        return {
          version: 1,
          ok: true,
          snapshot: { version: 1, revision, settings: createDefaultSettings() },
          catalog: structuredClone(DUMMY_VAULT_CATALOG),
        };
      }
      const settings = {
        getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(saved(0)),
        saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockResolvedValue(saved(1)),
        findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
          version: 1,
          ok: false,
          reason: "unavailable",
        }),
      };
      await render(
        <QueryClientProvider client={createMetadataQueryClient()}>
          <SettingsApp client={settings} connectionClient={connection} />
        </QueryClientProvider>,
      );
      await expect.element(page.getByText("Saved settings loaded (revision 0).")).toBeVisible();
      // The draft's save is still pending when setup replaces the vault metadata.
      let resolveSave!: (value: SettingsResponse) => void;
      settings.saveSettings.mockReturnValueOnce(
        new Promise<SettingsResponse>((resolve) => {
          resolveSave = resolve;
        }),
      );
      await page.getByLabelText("Origin", { exact: true }).fill("draft.example");
      await page.getByRole("button", { name: "Pause site", exact: true }).click();
      await fillNew();
      await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
      await vi.waitFor(() => expect(connection.begin).toHaveBeenCalledTimes(1));
      await expect
        .element(page.getByText(/Your vaults changed\. Your unsaved changes are kept/))
        .toBeVisible();
      resolveSave(saved(1));
      // The save went through, so nothing is said to be unsaved.
      await expect
        .element(
          page.getByText(
            "Your vaults changed while the settings were being saved. The change was saved; reload saved settings before you change anything else.",
            { exact: true },
          ),
        )
        .toBeVisible();
      expect(document.getElementById("site-list")?.textContent).toContain("draft.example");
      expect(settings.getSettings).toHaveBeenCalledTimes(1);
      // Editing further cannot unblock a draft based on potentially replaced vault metadata.
      await page.getByLabelText("Origin", { exact: true }).fill("next-draft.example");
      await page.getByRole("button", { name: "Pause site", exact: true }).click();
      expect(settings.saveSettings).toHaveBeenCalledTimes(1);
      settings.getSettings.mockResolvedValue(saved(7));
      await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
      await expect.element(page.getByText("Saved settings loaded (revision 7).")).toBeVisible();
      expect(document.getElementById("site-list")?.textContent).not.toContain("draft.example");
      await page.getByLabelText("Origin", { exact: true }).fill("reviewed.example");
      await page.getByRole("button", { name: "Pause site", exact: true }).click();
      await vi.waitFor(() => expect(settings.saveSettings).toHaveBeenCalledTimes(2));
      expect(settings.saveSettings.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 7 });
    },
  );
}
