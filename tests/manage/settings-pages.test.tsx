import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { LocalSettings, SyncSettingsState } from "../../packages/contracts/src/index";
import { ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

// Synthetic settings only; the client is replaced, so nothing leaves the page.

const USER = "00000000-0000-4000-8000-000000000001";

function settingsOf(parts: Partial<LocalSettings> = {}): LocalSettings {
  return { connections: [], excludedSites: [], siteDefaults: [], ...parts };
}

const binding = {
  recipeId: "bank-signin",
  origin: "https://bank.example",
  provider: "bitwarden",
  userId: USER,
  itemId: "item-1",
  itemName: "Example Bank",
  slots: [
    { slot: "branch", field: { custom: "Branch number" } },
    { slot: "pin", field: { custom: "PIN", position: 1, count: 2 } },
    { slot: "password", field: "password" as const },
  ],
};

function mockClient(initial: SyncSettingsState) {
  let state = initial;
  return {
    devices: vi.fn<ManageClient["devices"]>(async () => ({ version: 1, devices: [] })),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(async () => structuredClone(state)),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(async (expectedRevision, settings) => {
      if (expectedRevision !== state.revision) throw new ManageApiError("settings_conflict");
      state = { version: 1, revision: state.revision + 1, settings: structuredClone(settings) };
      return structuredClone(state);
    }),
    recipes: vi.fn<ManageClient["recipes"]>(),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(),
    replace(next: SyncSettingsState) {
      state = next;
    },
  } satisfies ManageClient & { replace(next: SyncSettingsState): void };
}

async function mount(client: ManageClient, path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path={path} />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

test("excludes a site on a service that has no settings yet, then removes it", async () => {
  const client = mockClient({ version: 1, revision: 0, settings: null });
  await mount(client, "/manage/sites");
  await expect.element(page.getByText("No sites are excluded.")).toBeVisible();

  await page.getByLabelText("Hostname").fill("https://intranet.example/");
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Enter a hostname without a scheme, port or path.");
  await expect.element(page.getByLabelText("Hostname")).toHaveFocus();
  expect(client.saveSettings).not.toHaveBeenCalled();

  await page.getByLabelText("Hostname").fill("Intranet.Example");
  await page.getByLabelText("Include subdomains").click();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("and its subdomains")).toBeVisible();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    0,
    settingsOf({ excludedSites: [{ hostname: "intranet.example", includeSubdomains: true }] }),
  );
  await expect.element(page.getByLabelText("Hostname")).toHaveValue("");
  await expect.element(page.getByRole("status")).toHaveTextContent("Excluded intranet.example.");

  // The same entry again is not written a second time.
  await page.getByLabelText("Hostname").fill("intranet.example");
  await page.getByLabelText("Include subdomains").click();
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("intranet.example is already excluded.");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);

  await page.getByRole("button", { name: "Remove excluded site intranet.example" }).click();
  await expect.element(page.getByText("No sites are excluded.")).toBeVisible();
  expect(client.saveSettings).toHaveBeenLastCalledWith(1, settingsOf());
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Removed intranet.example from the excluded sites.");
});

test("asks for a paired device before settings can be edited", async () => {
  const client = mockClient({ version: 1, revision: 0, settings: null });
  client.settings.mockRejectedValue(new ManageApiError("not_paired"));
  await mount(client, "/manage/sites");
  await expect.element(page.getByRole("alert")).toMatchTextContent(/Pair a device first/);
  await expect.element(page.getByLabelText("Hostname")).not.toBeInTheDocument();
});

test("refuses an edit that would make the document larger than devices sync", async () => {
  const long = ["a", "b", "c"].map((letter) => letter.repeat(60)).join(".");
  const excludedSites = Array.from({ length: 600 }, (_, index) => ({
    hostname: `${long}.x${index}.example`,
    includeSubdomains: false,
  }));
  const client = mockClient({ version: 1, revision: 1, settings: settingsOf({ excludedSites }) });
  await mount(client, "/manage/sites");
  await page.getByLabelText("Hostname").fill("one-more.example");
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent(/would be too large/);
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("lists site defaults by item name and removes one, keeping the rest", async () => {
  const client = mockClient({
    version: 1,
    revision: 4,
    settings: settingsOf({
      siteDefaults: [
        {
          origin: "https://bank.example",
          provider: "bitwarden",
          userId: USER,
          itemId: "item-1",
          itemName: "Example Bank",
        },
        { origin: "https://shop.example", provider: "bitwarden", userId: USER, itemId: "item-2" },
      ],
      bindings: [binding],
    }),
  });
  await mount(client, "/manage/sites");
  const list = page.getByRole("list").filter({ hasText: "https://bank.example" });
  await expect.element(list).toMatchTextContent(`https://bank.example: Example Bank`);
  // Without a saved name, the item ID stands in.
  await expect.element(list).toMatchTextContent(`https://shop.example: item-2`);

  await page
    .getByRole("button", { name: "Remove default account for https://bank.example" })
    .click();
  await expect
    .element(page.getByText("https://bank.example: Example Bank"))
    .not.toBeInTheDocument();
  const saved = client.saveSettings.mock.lastCall!;
  expect(saved[0]).toBe(4);
  expect(saved[1].siteDefaults.map((entry) => entry.origin)).toEqual(["https://shop.example"]);
  // Other parts of the document are written back unchanged.
  expect(saved[1].bindings).toEqual([binding]);
});

test("a write that lost to another writer shows the current settings and changes nothing", async () => {
  const client = mockClient({
    version: 1,
    revision: 1,
    settings: settingsOf({
      excludedSites: [{ hostname: "old.example", includeSubdomains: false }],
    }),
  });
  await mount(client, "/manage/sites");
  await expect.element(page.getByText("old.example")).toBeVisible();
  // A device sync writes while the page is open.
  client.replace({
    version: 1,
    revision: 2,
    settings: settingsOf({
      excludedSites: [{ hostname: "new.example", includeSubdomains: false }],
    }),
  });
  await page.getByRole("button", { name: "Remove excluded site old.example" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(/The settings changed elsewhere/);
  await expect.element(page.getByText("new.example")).toBeVisible();
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
});

test("refuses an edit that would exceed a list limit before writing", async () => {
  const excludedSites = Array.from({ length: 1000 }, (_, index) => ({
    hostname: `site-${index}.example`,
    includeSubdomains: false,
  }));
  const client = mockClient({ version: 1, revision: 1, settings: settingsOf({ excludedSites }) });
  await mount(client, "/manage/sites");
  await page.getByLabelText("Hostname").fill("one-more.example");
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent(/over a list limit/);
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("lists account bindings with their fields and removes one", async () => {
  const other = { ...binding, itemId: "item-3", itemName: "Second account" };
  const client = mockClient({
    version: 1,
    revision: 2,
    settings: settingsOf({ bindings: [binding, other] }),
  });
  await mount(client, "/manage/bindings");
  const table = page.getByRole("table");
  await expect.element(table).toMatchTextContent('branch: Custom field "Branch number"');
  await expect.element(table).toMatchTextContent('pin: Custom field "PIN" (1 of 2)');
  await expect.element(table).toMatchTextContent("password: Password");

  await page
    .getByRole("button", {
      name: "Remove binding of Example Bank for bank-signin on https://bank.example",
    })
    .click();
  await expect.element(page.getByText("Example Bank")).not.toBeInTheDocument();
  expect(client.saveSettings).toHaveBeenLastCalledWith(2, settingsOf({ bindings: [other] }));
});

test("says when no binding is saved", async () => {
  await mount(mockClient({ version: 1, revision: 0, settings: null }), "/manage/bindings");
  await expect.element(page.getByText("No account bindings are saved.")).toBeVisible();
});
