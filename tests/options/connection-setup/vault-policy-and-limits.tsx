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
  type SettingsResponse,
} from "../../../packages/contracts/src/index";
import type { ConnectionSetupTestContext } from "./context";

export function registerVaultPolicyAndLimits({
  ready,
  status,
  mockClient,
  held,
  mount,
  fillNew,
  registered,
}: Pick<
  ConnectionSetupTestContext,
  "ready" | "status" | "mockClient" | "held" | "mount" | "fillNew" | "registered"
>) {
  test("each connection's row holds its vault access, which waits for saved settings", async () => {
    const connection = mockClient();
    connection.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          connectionId: "synthetic",
          label: "Synthetic vault",
          email: "saved@example.test",
          environment: { kind: "cloud" as const, region: "us" as const },
          state: "ready" as const,
          autoUnlock: "enabled" as const,
          providerSession: "active" as const,
        },
      ],
    });
    const catalog = {
      connections: [
        {
          id: "synthetic",
          label: "Synthetic vault",
          provider: "bitwarden",
          server: "cloud-us",
          userId: "synthetic-user",
          groups: [],
          items: [
            {
              id: "login",
              label: "Synthetic login",
              allowedOrigins: [],
              groupIds: [],
              fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" }],
            },
          ],
        },
      ],
    } satisfies Extract<SettingsResponse, { ok: true }>["catalog"];
    function saved(revision: number): Extract<SettingsResponse, { ok: true }> {
      const settings = createDefaultSettings(catalog);
      // Another account's synced policy has no row here: rows come from this device's vaults.
      settings.accountPolicies.push({
        provider: "bitwarden",
        server: "cloud-us",
        userId: "other-user",
        accountName: "Other device vault",
        enabled: true,
        selection: { mode: "all" },
      });
      return { version: 1, ok: true, snapshot: { version: 1, revision, settings }, catalog };
    }
    const settings = {
      getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(saved(0)),
      saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockImplementation(async (request) => ({
        ...saved(request.expectedRevision + 1),
        snapshot: {
          version: 1,
          revision: request.expectedRevision + 1,
          settings: structuredClone(request.settings),
        },
      })),
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
    const use = page.getByRole("switch", { name: "Synthetic vault: Use this vault", exact: true });
    await expect.element(use).not.toBeChecked();
    expect(document.getElementById("bitwarden-connections")?.contains(use.element())).toBe(true);
    await expect
      .element(page.getByText("Unavailable connection", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Other device vault")).not.toBeInTheDocument();
    // There is no separate vault access section.
    await expect
      .element(page.getByRole("heading", { name: "Vault access" }))
      .not.toBeInTheDocument();

    await use.click();
    await expect.element(page.getByText("Settings saved (revision 1).")).toBeVisible();
    // The switch writes the account's synced policy, keyed by provider, server and user ID.
    const written = settings.saveSettings.mock.calls[0]?.[0].settings;
    expect(written?.accountPolicies).toEqual([
      {
        provider: "bitwarden",
        server: "cloud-us",
        userId: "other-user",
        accountName: "Other device vault",
        enabled: true,
        selection: { mode: "all" },
      },
      {
        provider: "bitwarden",
        server: "cloud-us",
        userId: "synthetic-user",
        accountName: "Synthetic vault",
        enabled: true,
        selection: { mode: "all" },
      },
    ]);
    expect(written?.connections).toEqual([]);
    const read = held<SettingsResponse>();
    settings.getSettings.mockReturnValue(read.promise);
    await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
    await expect.element(use).toBeDisabled();
    await expect
      .element(page.getByRole("combobox", { name: "Synthetic vault: Items for Pateat" }))
      .toBeDisabled();
    read.resolve(saved(4));
    await expect.element(page.getByText("Saved settings loaded (revision 4).")).toBeVisible();
    await expect.element(use).toBeEnabled();
    await expect.element(use).not.toBeChecked();
  });

  test("past Bitwarden's 5 accounts, adding and listing connections warns without refusing", async () => {
    const warning =
      "More than 5 connections. The official Bitwarden extension allows up to 5 accounts, and each unlocked vault uses more memory.";
    const listed = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...registered,
        connectionId: `listed-${index + 1}`,
        label: `Vault ${index + 1}`,
        state: "ready" as const,
        providerSession: "active" as const,
      }));
    const client = mockClient();
    client.list
      .mockResolvedValueOnce({ ...status(), connections: listed(5) })
      .mockResolvedValue({ ...status(), connections: listed(6) });
    client.begin.mockImplementation(async () => ({ ...ready(), connectionId: "listed-6" }));
    await mount(client);
    // Five are within the official limit; the closed form holds the warning hidden.
    await expect.element(page.getByText(warning)).not.toBeVisible();
    await page.getByText("Add a connection", { exact: true }).first().click();
    // The sixth connection is warned about in the form, and Connect stays available.
    await expect.element(page.getByText(warning)).toBeVisible();
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Vault 6: Sync", exact: true }))
      .toBeVisible();
    // With six listed, the warning stays under the list.
    await expect.element(page.getByText(warning)).toBeVisible();
    expect(
      document.getElementById("bitwarden-connections")?.nextElementSibling?.textContent,
    ).toContain(warning);
  });
}
