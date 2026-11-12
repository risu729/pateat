import { QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BitwardenSetup } from "../../../apps/extension/src/options/bitwarden-setup";
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

export function registerSettingsCatalogReload({
  flowId,
  expiresAt,
  mockClient,
  fillNew,
  catalogChangeDuringCleanReload,
}: Pick<
  ConnectionSetupTestContext,
  "flowId" | "expiresAt" | "mockClient" | "fillNew" | "catalogChangeDuringCleanReload"
>) {
  test("vault metadata that changes while clean settings reload claims no unsaved changes", async () => {
    await catalogChangeDuringCleanReload();
    await expect
      .element(
        page.getByText(
          "Your vaults changed. Reload saved settings to see the current vaults before you change anything else.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("unsaved changes");
  });

  test("a reload of clean settings that the vault metadata overtook asks for another without claiming unsaved changes", async () => {
    const { settings, finish } = await catalogChangeDuringCleanReload();
    finish();
    await expect
      .element(
        page.getByText(
          "Your vaults changed while the settings were loading. Reload saved settings again.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("unsaved changes");
    expect(settings.getSettings).toHaveBeenCalledTimes(2);
  });

  test("a challenge while adding a connection reloads a clean draft to the revision the new policy entry wrote", async () => {
    const connection = mockClient();
    connection.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0],
      expiresAt,
    });
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
      saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
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
    settings.getSettings.mockResolvedValue(saved(1));
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByText("Enter a two-step verification code.")).toBeVisible();
    await expect.element(page.getByText("Saved settings loaded (revision 1).")).toBeVisible();
    expect(settings.getSettings).toHaveBeenCalledTimes(2);
  });

  test.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "field review uses current snapshot IDs and starts every custom field excluded (blocked=%s, unsaved=%s)",
    async (blocked, unsaved) => {
      const client = mockClient();
      const snapshot = crypto.randomUUID();
      const accepted: Extract<SettingsResponse, { ok: true }> = {
        version: 1,
        ok: true,
        snapshot: { version: 1, revision: 12, settings: createDefaultSettings() },
        catalog: {
          connections: [
            {
              id: "synthetic",
              label: "Synthetic vault",
              provider: "bitwarden",
              server: "cloud-us",
              userId: "synthetic-user",
              groups: [],
              snapshotId: snapshot,
              quarantinedItemIds: ["affected"],
              items: [
                {
                  id: "affected",
                  label: "Changed login",
                  allowedOrigins: [],
                  groupIds: [],
                  fields: [
                    { id: "login.password", label: "Password", name: null, kind: "hidden" },
                    {
                      id: `custom.${snapshot}.0`,
                      label: "Duplicate",
                      name: "Duplicate",
                      kind: "text",
                    },
                    {
                      id: `custom.${snapshot}.1`,
                      label: "Duplicate",
                      name: "Duplicate",
                      kind: "text",
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
      const changed = vi.fn();
      await render(
        <QueryClientProvider client={createMetadataQueryClient()}>
          <BitwardenSetup
            client={client}
            onCatalogChanged={changed}
            acceptedSettings={accepted}
            reviewBlocked={blocked}
            unsavedChanges={unsaved}
          />
        </QueryClientProvider>,
      );
      const first = page.getByRole("checkbox", {
        name: "Changed login: Review exclude Duplicate (field 1)",
        exact: true,
      });
      const second = page.getByRole("checkbox", {
        name: "Changed login: Review exclude Duplicate (field 2)",
        exact: true,
      });
      const review = page.getByRole("button", {
        name: "Changed login: Save reviewed field exclusions",
        exact: true,
      });
      await expect.element(first).toBeChecked();
      await expect.element(second).toBeChecked();
      if (blocked) {
        // Only unsaved changes are said to be kept, as reloading would drop them.
        await expect
          .element(
            page.getByText(
              unsaved
                ? "Reload saved settings to review the current fields. Your unsaved settings changes are kept until you reload."
                : "Reload saved settings to review the current fields.",
              { exact: true },
            ),
          )
          .toBeVisible();
        await expect.element(first).toBeDisabled();
        await expect.element(review).toBeDisabled();
        expect(client.review).not.toHaveBeenCalled();
      } else {
        await first.click();
        await review.click();
        await vi.waitFor(() => expect(client.review).toHaveBeenCalledTimes(1));
        expect(client.review).toHaveBeenCalledWith({
          connectionId: "synthetic",
          itemId: "affected",
          snapshotId: snapshot,
          expectedRevision: 12,
          excludedFieldIds: [`custom.${snapshot}.1`],
        });
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      }
    },
  );

  test("an item older here than its review record asks for a vault sync instead of a review", async () => {
    const client = mockClient();
    const snapshot = crypto.randomUUID();
    const custom = (index: number) => ({
      id: `custom.${snapshot}.${index}`,
      label: "Recovery code",
      name: "Recovery code",
      kind: "hidden" as const,
    });
    const accepted: Extract<SettingsResponse, { ok: true }> = {
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 3, settings: createDefaultSettings() },
      catalog: {
        connections: [
          {
            id: "synthetic",
            label: "Synthetic vault",
            provider: "bitwarden",
            server: "cloud-us",
            userId: "synthetic-user",
            groups: [],
            snapshotId: snapshot,
            quarantinedItemIds: ["stale", "changed"],
            staleItemIds: ["stale"],
            items: [
              {
                id: "stale",
                label: "Stale login",
                allowedOrigins: [],
                groupIds: [],
                fields: [custom(0)],
              },
              {
                id: "changed",
                label: "Changed login",
                allowedOrigins: [],
                groupIds: [],
                fields: [custom(1)],
              },
            ],
          },
        ],
      },
    };
    await render(
      <QueryClientProvider client={createMetadataQueryClient()}>
        <BitwardenSetup
          client={client}
          onCatalogChanged={vi.fn()}
          acceptedSettings={accepted}
          reviewBlocked={false}
        />
      </QueryClientProvider>,
    );
    await expect
      .element(
        page.getByText(
          "Stale login was reviewed on another device against a newer copy of this vault. Sync this vault; if it is still older afterwards, review it here.",
          { exact: true },
        ),
      )
      .toBeVisible();
    // The stale item offers no review form: approving an older copy could undo the newer review.
    await expect
      .element(page.getByRole("button", { name: "Stale login: Save reviewed field exclusions" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("checkbox", { name: /^Stale login: Review exclude/ }))
      .not.toBeInTheDocument();
    // An item that only changed is still reviewed here.
    await expect
      .element(page.getByRole("button", { name: "Changed login: Save reviewed field exclusions" }))
      .toBeVisible();
    await expect
      .element(page.getByText(/^Changed login was reviewed on another device/))
      .not.toBeInTheDocument();
  });

  test("a paired device that has not synced settings yet says no vault item is used", async () => {
    const connection = mockClient();
    const response = (pending: boolean): Extract<SettingsResponse, { ok: true }> => ({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 0, settings: createDefaultSettings() },
      catalog: {
        ...structuredClone(DUMMY_VAULT_CATALOG),
        ...(pending ? { settingsSyncPending: true as const } : {}),
      },
    });
    const settings = {
      getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(response(true)),
      saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
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
    const warning = page.getByText(
      "Pateat uses no vault item until this device completes its first settings sync with the sync service.",
      { exact: true },
    );
    await expect.element(page.getByText("Saved settings loaded (revision 0).")).toBeVisible();
    await expect.element(warning).toBeVisible();
    // Once the first settings sync completed, the catalog no longer carries the flag.
    settings.getSettings.mockResolvedValue(response(false));
    await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
    await expect.element(page.getByText("Saved settings loaded (revision 0).")).toBeVisible();
    await expect.element(warning).not.toBeInTheDocument();
  });
}
