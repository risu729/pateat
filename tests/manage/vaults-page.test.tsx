import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { LocalSettings, SyncSettingsState } from "../../packages/contracts/src/index";
import type { ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

// Synthetic settings only; the client is replaced, so nothing leaves the page.

const USER = "00000000-0000-4000-8000-000000000001";
const SELF_HOSTED_USER = "00000000-0000-4000-8000-000000000002";
const REMOTE_USER = "00000000-0000-4000-8000-000000000003";
const SELF_HOSTED = "https://vault.example";
const EVIDENCE = `bitwarden-v1:sha256:${"a".repeat(64)}`;

function settingsOf(parts: Partial<LocalSettings> = {}): LocalSettings {
  return {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    siteDefaults: [],
    bindings: [],
    ...parts,
  };
}

function mockClient(state: SyncSettingsState) {
  return {
    devices: vi.fn<ManageClient["devices"]>(async () => ({ version: 1, devices: [] })),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(async () => structuredClone(state)),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(async () => ({ version: 1, recipes: [] })),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(),
  } satisfies ManageClient;
}

async function mount(client: ManageClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path="/manage/vaults" />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

test("says when no vault settings are saved", async () => {
  const client = mockClient({ version: 1, revision: 0, settings: null });
  await mount(client);
  await expect
    .element(page.getByRole("link", { name: "Vaults" }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(page.getByText("No vault settings are saved yet.")).toBeVisible();

  // Settings that name no vault account say the same.
  await cleanup();
  await mount(
    mockClient({
      version: 1,
      revision: 2,
      settings: settingsOf({
        excludedSites: [{ hostname: "a.example", includeSubdomains: false }],
      }),
    }),
  );
  await expect.element(page.getByText("No vault settings are saved yet.")).toBeVisible();
});

test("lists each account's selection, item policies and reviews, read only", async () => {
  const personal = { provider: "bitwarden", server: "cloud-us", userId: USER };
  const selfHosted = { provider: "bitwarden", server: SELF_HOSTED, userId: SELF_HOSTED_USER };
  const remote = { provider: "bitwarden", server: "cloud-eu", userId: REMOTE_USER };
  const client = mockClient({
    version: 1,
    revision: 5,
    settings: settingsOf({
      accountPolicies: [
        {
          ...personal,
          accountName: "Personal vault",
          enabled: true,
          selection: {
            mode: "selected",
            groups: [
              { id: "g-1", name: "Banking" },
              { id: "g-2", name: "Work" },
            ],
          },
        },
        {
          ...selfHosted,
          accountName: "Home server",
          enabled: false,
          selection: { mode: "all" },
        },
      ],
      itemPolicies: [
        {
          ...personal,
          itemId: "item-1",
          itemName: "Example Bank",
          selected: false,
          excluded: false,
          excludedFields: [
            "login.totp",
            { custom: "PIN", position: 2, count: 3 },
            { custom: null, position: 1, count: 1 },
          ],
        },
        {
          ...personal,
          itemId: "item-2",
          itemName: "Old card",
          selected: false,
          excluded: true,
          excludedFields: [],
        },
        {
          ...personal,
          itemId: "item-3",
          itemName: "Shared login",
          selected: true,
          excluded: false,
          excludedFields: [],
        },
        // An account with item settings but no account policy is still listed.
        {
          ...remote,
          itemId: "item-9",
          itemName: "Remote login",
          selected: false,
          excluded: true,
          excludedFields: [],
        },
      ],
      customFieldReviews: [
        {
          ...personal,
          itemId: "item-1",
          evidence: EVIDENCE,
          revisionDate: "2026-10-11T07:10:03.1234567Z",
        },
        {
          ...personal,
          itemId: "item-4",
          evidence: EVIDENCE,
          revisionDate: "2026-10-11T07:10:03Z",
        },
      ],
    }),
  });
  await mount(client);
  const rows = page.getByRole("listitem");
  const personalRow = rows.filter({ hasText: "Personal vault" }).first();
  await expect.element(personalRow).toMatchTextContent("Bitwarden cloud (US).");
  await expect.element(personalRow).toMatchTextContent("Selected groups: Banking, Work.");
  await expect.element(personalRow).toMatchTextContent("Custom fields reviewed for 2 items.");
  await expect
    .element(personalRow)
    .toMatchTextContent(
      'Example Bank: login.totp excluded, custom field "PIN" (2 of 3) excluded, an unnamed custom field (1 of 1) excluded',
    );
  await expect.element(personalRow).toMatchTextContent("Old card: excluded");
  await expect.element(personalRow).toMatchTextContent("Shared login: selected");
  await expect.element(personalRow.getByText("Used", { exact: true })).toBeVisible();

  const homeRow = rows.filter({ hasText: "Home server" }).first();
  // A self-hosted server is named by its origin.
  await expect.element(homeRow).toMatchTextContent(`${SELF_HOSTED}.`);
  await expect.element(homeRow).toMatchTextContent("All items except exclusions.");
  await expect.element(homeRow).not.toMatchTextContent("reviewed");
  await expect.element(homeRow.getByText("Not used", { exact: true })).toBeVisible();

  // Without an account policy, the provider account ID names the account, which is not used.
  const remoteRow = rows.filter({ hasText: `bitwarden account ${REMOTE_USER}` }).first();
  await expect.element(remoteRow).toMatchTextContent("Bitwarden cloud (EU).");
  await expect.element(remoteRow).toMatchTextContent("No account settings.");
  await expect.element(remoteRow).toMatchTextContent("Remote login: excluded");
  await expect.element(remoteRow.getByText("Not used", { exact: true })).toBeVisible();

  // The page only lists; devices edit these settings.
  await expect
    .element(page.getByRole("button", { name: /Remove|Exclude|Allow/ }))
    .not.toBeInTheDocument();
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("one review on a selected account without groups is counted once", async () => {
  const account = { provider: "bitwarden", server: "cloud-eu", userId: USER };
  await mount(
    mockClient({
      version: 1,
      revision: 1,
      settings: settingsOf({
        accountPolicies: [
          {
            ...account,
            accountName: "EU vault",
            enabled: true,
            selection: { mode: "selected", groups: [] },
          },
        ],
        customFieldReviews: [
          {
            ...account,
            itemId: "item-1",
            evidence: EVIDENCE,
            revisionDate: "2026-10-11T07:10:03Z",
          },
        ],
      }),
    }),
  );
  const row = page.getByRole("listitem").filter({ hasText: "EU vault" }).first();
  await expect.element(row).toMatchTextContent("Bitwarden cloud (EU).");
  await expect.element(row).toMatchTextContent("Selected items only.");
  await expect.element(row).toMatchTextContent("Custom fields reviewed for 1 item.");
});
