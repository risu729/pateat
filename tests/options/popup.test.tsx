import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { popupOrigin, SiteApp, type PopupHost } from "../../apps/extension/src/popup/site-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type LocalSettings,
  type SettingsResponse,
} from "../../packages/contracts/src/index";

function saved(revision: number, settings: LocalSettings = createDefaultSettings()) {
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision, settings: structuredClone(settings) },
    catalog: structuredClone(DUMMY_VAULT_CATALOG),
  } satisfies Extract<SettingsResponse, { ok: true }>;
}

/** The demo catalog's static origins stand in for the background's vault matching. */
async function demoSiteAccounts(origin: string) {
  return {
    version: 1 as const,
    ok: true as const,
    origin,
    accounts: DUMMY_VAULT_CATALOG.connections.flatMap((connection) =>
      connection.items
        .filter((item) => item.allowedOrigins.includes(origin))
        .map((item) => ({
          connectionId: connection.id,
          itemId: item.id,
          uri: true,
          passkey: false,
        })),
    ),
    complete: true,
  };
}

/** A worker-owned store: each save must name the current revision. */
function store(initial = saved(0)) {
  let current = initial;
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>(async () => structuredClone(current)),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(async (request) => {
      if (request.expectedRevision !== current.snapshot.revision)
        return {
          version: 1,
          ok: false,
          error: { code: "revision-conflict", message: "Settings changed." },
        };
      current = saved(current.snapshot.revision + 1, request.settings);
      return structuredClone(current);
    }),
    findSiteAccounts: vi
      .fn<SettingsClient["findSiteAccounts"]>()
      .mockImplementation(demoSiteAccounts),
  };
  return {
    client,
    current: () => current,
    replace(next: ReturnType<typeof saved>) {
      current = next;
    },
  };
}

async function mount(client: SettingsClient, url: string | undefined) {
  const host = {
    currentTabUrl: vi.fn<PopupHost["currentTabUrl"]>().mockResolvedValue(url),
    openSettings: vi.fn<PopupHost["openSettings"]>(),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp client={client} host={host} />
    </QueryClientProvider>,
  );
  return host;
}

afterEach(() => cleanup());

test("only HTTPS pages with a valid hostname are a site the popup edits", () => {
  expect(popupOrigin("https://bank.example/login?next=1")).toBe("https://bank.example");
  expect(popupOrigin("https://bank.example:8443/")).toBe("https://bank.example:8443");
  expect(popupOrigin("http://bank.example/")).toBeUndefined();
  expect(popupOrigin("chrome://extensions/")).toBeUndefined();
  expect(popupOrigin(undefined)).toBeUndefined();
});

test("a tab Pateat cannot run on offers only the settings page", async () => {
  const { client } = store();
  const host = await mount(client, "chrome://newtab/");
  await expect
    .element(page.getByText("Pateat works on HTTPS websites.", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Use as default" }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Open settings" }));
  expect(host.openSettings).toHaveBeenCalledOnce();
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("the site default is chosen from the items that match the tab's origin, then removed", async () => {
  const { client, current } = store();
  await mount(client, "https://bank.example/login");
  await expect.element(page.getByRole("heading", { name: "bank.example" })).toBeVisible();
  await expect.element(page.getByText("No default account.", { exact: false })).toBeVisible();
  const select = page.getByRole("combobox", { name: "Account for https://bank.example" });
  await expect.element(select).toBeVisible();
  expect(client.findSiteAccounts).toHaveBeenCalledWith(
    "https://bank.example",
    current().snapshot.settings,
  );
  await userEvent.selectOptions(select, JSON.stringify(["demo-work", "primary"]));
  await userEvent.click(page.getByRole("button", { name: "Use as default" }));
  await expect
    .element(page.getByText("Default: Demo team account (Demo work vault)"))
    .toBeVisible();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "settings.save", expectedRevision: 0 }),
  );
  expect(current().snapshot.settings.siteDefaults).toEqual([
    {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    },
  ]);
  // Only the site default changed.
  expect({ ...current().snapshot.settings, siteDefaults: [] }).toEqual(createDefaultSettings());
  await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();

  await userEvent.click(page.getByRole("button", { name: "Remove default" }));
  await expect.element(page.getByText("No default account.", { exact: false })).toBeVisible();
  expect(current().snapshot).toMatchObject({ revision: 2, settings: createDefaultSettings() });
});

test("the site is excluded by its exact hostname, and a covering rule can be removed", async () => {
  const { client, current } = store();
  await mount(client, "https://login.bank.example/");
  await expect.element(page.getByText("Allowed:", { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Exclude login.bank.example" }));
  await expect.element(page.getByText("Excluded:", { exact: false })).toBeVisible();
  expect(current().snapshot.settings.excludedSites).toEqual([
    { hostname: "login.bank.example", includeSubdomains: false },
  ]);
  // An excluded site is not searched and offers no default.
  await expect
    .element(page.getByRole("heading", { name: "Default account" }))
    .not.toBeInTheDocument();
  await userEvent.click(
    page.getByRole("button", { name: "Remove excluded site login.bank.example" }),
  );
  await expect.element(page.getByText("Allowed:", { exact: false })).toBeVisible();
  expect(current().snapshot.settings.excludedSites).toEqual([]);
});

test("a parent rule that includes subdomains is shown as the reason", async () => {
  const settings = createDefaultSettings();
  settings.excludedSites.push(
    { hostname: "bank.example", includeSubdomains: true },
    { hostname: "mail.example", includeSubdomains: false },
  );
  const { client, current } = store(saved(4, settings));
  await mount(client, "https://login.bank.example/");
  await expect.element(page.getByText("bank.example · Including subdomains")).toBeVisible();
  await expect.element(page.getByText("mail.example", { exact: false })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Remove excluded site bank.example" }));
  await expect.element(page.getByText("Allowed:", { exact: false })).toBeVisible();
  expect(current().snapshot.settings.excludedSites).toEqual([
    { hostname: "mail.example", includeSubdomains: false },
  ]);
  await vi.waitFor(() => expect(client.findSiteAccounts).toHaveBeenCalledOnce());
});

test("a change saved elsewhere first is reloaded instead of overwritten", async () => {
  const state = store();
  await mount(state.client, "https://bank.example/");
  await expect.element(page.getByRole("button", { name: "Exclude bank.example" })).toBeVisible();
  const elsewhere = createDefaultSettings();
  elsewhere.excludedSites.push({ hostname: "mail.example", includeSubdomains: false });
  state.replace(saved(7, elsewhere));
  await userEvent.click(page.getByRole("button", { name: "Exclude bank.example" }));
  await expect
    .element(page.getByText("Settings changed elsewhere and were reloaded.", { exact: false }))
    .toBeVisible();
  expect(state.current().snapshot).toMatchObject({ revision: 7, settings: elsewhere });
  await userEvent.click(page.getByRole("button", { name: "Exclude bank.example" }));
  await expect.element(page.getByText("Excluded:", { exact: false })).toBeVisible();
  expect(state.current().snapshot.settings.excludedSites).toEqual([
    { hostname: "mail.example", includeSubdomains: false },
    { hostname: "bank.example", includeSubdomains: false },
  ]);
});

test("settings that cannot be loaded change nothing", async () => {
  const { client } = store();
  client.getSettings.mockResolvedValue({
    version: 1,
    ok: false,
    error: { code: "storage-unavailable", message: "Unavailable." },
  });
  await mount(client, "https://bank.example/");
  await expect.element(page.getByText("Pateat settings could not be loaded.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  expect(client.saveSettings).not.toHaveBeenCalled();
});
