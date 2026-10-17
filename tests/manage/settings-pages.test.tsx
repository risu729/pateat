import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type {
  LocalSettings,
  ManageRecipes,
  SyncSettingsState,
} from "../../packages/contracts/src/index";
import { ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

// Synthetic settings only; the client is replaced, so nothing leaves the page.

const USER = "00000000-0000-4000-8000-000000000001";
const BANK_PAGE = "/manage/sites/https/bank.example";

function settingsOf(parts: Partial<LocalSettings> = {}): LocalSettings {
  return { connections: [], excludedSites: [], siteDefaults: [], bindings: [], ...parts };
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

const bankDefault = {
  origin: "https://bank.example",
  provider: "bitwarden",
  userId: USER,
  itemId: "item-1",
  itemName: "Example Bank",
  accountName: "Personal vault",
};

function mockClient(initial: SyncSettingsState, recipes: ManageRecipes["recipes"] = []) {
  let state = initial;
  return {
    profileId: "00000000-0000-4000-8000-000000000001",
    selectProfile: vi.fn<ManageClient["selectProfile"]>(),
    profiles: vi.fn<ManageClient["profiles"]>(async () => ({
      version: 1,
      profiles: [{ id: "00000000-0000-4000-8000-000000000001", name: "Default" }],
    })),
    copyProfile: vi.fn<ManageClient["copyProfile"]>(),
    assignProfile: vi.fn<ManageClient["assignProfile"]>(),
    devices: vi.fn<ManageClient["devices"]>(async () => ({ version: 1, devices: [] })),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(async () => structuredClone(state)),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(async (expectedRevision, settings) => {
      if (expectedRevision !== state.revision) throw new ManageApiError("settings_conflict");
      state = {
        version: 1,
        profileId: "00000000-0000-4000-8000-000000000001",
        revision: state.revision + 1,
        settings: structuredClone(settings),
      };
      return structuredClone(state);
    }),
    recipes: vi.fn<ManageClient["recipes"]>(async () => ({ version: 1, recipes })),
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

test("excludes a site on a service that has no settings yet, then allows it", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    settings: null,
  });
  await mount(client, "/manage/sites");
  await expect
    .element(page.getByRole("link", { name: "Sites" }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(page.getByText("No sites yet")).toBeVisible();

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
  const row = page.getByRole("listitem").filter({ hasText: "intranet.example and subdomains" });
  await expect.element(row).toMatchTextContent("Excluded");
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    0,
    settingsOf({ excludedSites: [{ hostname: "intranet.example", includeSubdomains: true }] }),
    "00000000-0000-4000-8000-000000000001",
  );
  await expect.element(page.getByLabelText("Hostname")).toHaveValue("");
  await expect.element(page.getByRole("status")).toHaveTextContent("intranet.example excluded");

  // The same entry again is not written a second time.
  await page.getByLabelText("Hostname").fill("intranet.example");
  await page.getByLabelText("Include subdomains").click();
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("intranet.example is already excluded.");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);

  await page.getByRole("button", { name: "Allow intranet.example and subdomains" }).click();
  await expect.element(page.getByText("No sites yet")).toBeVisible();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    1,
    settingsOf(),
    "00000000-0000-4000-8000-000000000001",
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("intranet.example and subdomains allowed");
});

test("asks for a paired device before settings can be edited", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    settings: null,
  });
  client.settings.mockRejectedValue(new ManageApiError("not_paired"));
  client.recipes.mockRejectedValue(new ManageApiError("not_paired"));
  await mount(client, "/manage/sites");
  // Both reads fail alike; the page says it once and claims no empty list.
  await expect.element(page.getByRole("alert")).toMatchTextContent(/Pair a device first/);
  await expect.element(page.getByLabelText("Hostname")).not.toBeInTheDocument();
  await expect.element(page.getByText("No sites yet")).not.toBeInTheDocument();

  await cleanup();
  await mount(client, BANK_PAGE);
  await expect.element(page.getByRole("alert")).toMatchTextContent(/Pair a device first/);
  await expect.element(page.getByRole("switch")).not.toBeInTheDocument();
});

test("refuses an edit that would make the document larger than devices sync", async () => {
  const long = ["a", "b", "c"].map((letter) => letter.repeat(60)).join(".");
  const excludedSites = Array.from({ length: 600 }, (_, index) => ({
    hostname: `${long}.x${index}.example`,
    includeSubdomains: false,
  }));
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    settings: settingsOf({ excludedSites }),
  });
  await mount(client, "/manage/sites");
  await page.getByLabelText("Hostname").fill("one-more.example");
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent(/would be too large/);
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("lists each site with its recipes, default account and bindings", async () => {
  const recipe = {
    change: {
      recipeId: "bank-signin",
      revision: 1,
      state: "active" as const,
      recipe: {
        version: 1 as const,
        id: "bank-signin",
        revision: 1,
        origin: "https://bank.example",
        entry: { path: "/", target: { by: "text" as const, value: "Login" } },
      },
    },
    updatedAt: Date.UTC(2026, 9, 11),
  };
  const client = mockClient(
    {
      version: 1,
      profileId: "00000000-0000-4000-8000-000000000001",
      revision: 4,
      settings: settingsOf({
        excludedSites: [{ hostname: "shop.example", includeSubdomains: false }],
        siteDefaults: [
          bankDefault,
          { origin: "https://shop.example", provider: "bitwarden", userId: USER, itemId: "item-2" },
        ],
        bindings: [binding, { ...binding, itemId: "item-3", itemName: "Second account" }],
      }),
    },
    [recipe],
  );
  await mount(client, "/manage/sites");
  const bank = page.getByRole("listitem").filter({ hasText: "https://bank.example" });
  // The connection's label names the account.
  await expect.element(bank).toMatchTextContent("1 recipe");
  await expect.element(bank).toMatchTextContent("Example Bank in Personal vault");
  await expect.element(bank).toMatchTextContent("2 bindings");
  await expect.element(bank).not.toMatchTextContent("Excluded");
  await expect
    .element(page.getByRole("link", { name: "https://bank.example" }))
    .toHaveAttribute("href", BANK_PAGE);
  // Without saved names, the item ID and the provider account ID stand in.
  const shop = page.getByRole("listitem").filter({ hasText: "https://shop.example" });
  await expect.element(shop).toMatchTextContent(`item-2 in bitwarden account ${USER}`);
  await expect.element(shop).toMatchTextContent("Excluded");
  await expect.element(shop).not.toMatchTextContent("recipe");
  await expect.element(page.getByRole("button", { name: "Allow shop.example" })).toBeVisible();
});

test("removes a site's default account on its page, keeping the rest", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 4,
    settings: settingsOf({
      siteDefaults: [
        bankDefault,
        { origin: "https://shop.example", provider: "bitwarden", userId: USER, itemId: "item-2" },
      ],
      bindings: [binding],
    }),
  });
  await mount(client, BANK_PAGE);
  const panel = page.getByRole("region", { name: "Default account" });
  await expect.element(panel).toMatchTextContent("Example Bank in Personal vault");
  await expect
    .element(panel)
    .toMatchTextContent("Choose another account from the Pateat popup on bank.example");

  await page
    .getByRole("button", { name: "Remove default account for https://bank.example" })
    .click();
  await expect.element(panel).toMatchTextContent("No default account");
  await expect
    .element(panel)
    .toMatchTextContent("Choose an account from the Pateat popup on bank.example");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Default account for https://bank.example removed");
  const saved = client.saveSettings.mock.lastCall!;
  expect(saved[0]).toBe(4);
  expect(saved[1].siteDefaults.map((entry) => entry.origin)).toEqual(["https://shop.example"]);
  // Other parts of the document are written back unchanged.
  expect(saved[1].bindings).toEqual([binding]);
});

test("a write that lost to another writer shows the current settings and changes nothing", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
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
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 2,
    settings: settingsOf({
      excludedSites: [{ hostname: "new.example", includeSubdomains: false }],
    }),
  });
  await page.getByRole("button", { name: "Allow old.example" }).click();
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
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    settings: settingsOf({ excludedSites }),
  });
  await mount(client, "/manage/sites");
  await page.getByLabelText("Hostname").fill("one-more.example");
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent(/over a list limit/);
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("lists a site's account bindings with their fields and removes one", async () => {
  const other = {
    ...binding,
    itemId: "item-3",
    itemName: "Second account",
    accountName: "Work vault",
  };
  const elsewhere = { ...binding, origin: "https://card.example", itemName: "Card" };
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 2,
    settings: settingsOf({ bindings: [binding, other, elsewhere] }),
  });
  await mount(client, BANK_PAGE);
  const panel = page.getByRole("region", { name: "Account bindings" });
  await expect.element(panel).toMatchTextContent('branch from custom field "Branch number"');
  await expect.element(panel).toMatchTextContent('pin from custom field "PIN" (1 of 2)');
  await expect.element(panel).toMatchTextContent("password from the password");
  await expect.element(panel).toMatchTextContent("recipe bank-signin");
  // Only this site's bindings are listed.
  await expect.element(panel).not.toMatchTextContent("Card");
  // A binding made by AI generation has no account name until a device names it.
  const rows = panel.getByRole("listitem");
  await expect
    .element(rows.filter({ hasText: "Example Bank" }).first())
    .toMatchTextContent(`bitwarden account ${USER}`);
  await expect
    .element(rows.filter({ hasText: "Second account" }).first())
    .toMatchTextContent("Work vault");
  await expect
    .element(rows.filter({ hasText: "Second account" }).first())
    .not.toMatchTextContent("bitwarden account");

  await page
    .getByRole("button", {
      name: "Remove binding of Example Bank for bank-signin on https://bank.example",
    })
    .click();
  await expect.element(page.getByText("Example Bank")).not.toBeInTheDocument();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    2,
    settingsOf({ bindings: [other, elsewhere] }),
    "00000000-0000-4000-8000-000000000001",
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Binding of Example Bank for bank-signin removed");
});

test("says when a site has no binding or default account", async () => {
  await mount(
    mockClient({
      version: 1,
      profileId: "00000000-0000-4000-8000-000000000001",
      revision: 0,
      settings: null,
    }),
    BANK_PAGE,
  );
  await expect.element(page.getByText("No account bindings")).toBeVisible();
  await expect.element(page.getByText("No default account")).toBeVisible();
  await expect.element(page.getByText("No recipes", { exact: true })).toBeVisible();
});

test("turns Pateat off and on for the site's exact hostname", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    settings: null,
  });
  await mount(client, BANK_PAGE);
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).toBeChecked();
  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    0,
    settingsOf({ excludedSites: [{ hostname: "bank.example", includeSubdomains: false }] }),
    "00000000-0000-4000-8000-000000000001",
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("bank.example excluded");

  await toggle.click();
  await expect.element(toggle).toBeChecked();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    1,
    settingsOf(),
    "00000000-0000-4000-8000-000000000001",
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("bank.example allowed");
});

test("leaves a rule that also covers other sites to the Sites list", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    settings: settingsOf({
      excludedSites: [{ hostname: "example", includeSubdomains: true }],
    }),
  });
  await mount(client, "/manage/sites/https/bank.example");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).not.toBeChecked();
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(toggle)
    .toHaveAccessibleDescription(
      "Excluded with example and subdomains; allow it on the Sites list",
    );
});

test("has no page for a path that names no exact HTTP(S) origin", async () => {
  for (const path of [
    "/manage/sites/ftp/bank.example",
    "/manage/sites/https/Bank.example",
    "/manage/sites/https/bank.example:443",
    "/manage/sites/https/bank.example/login",
    "/manage/bindings",
    "/manage/recipes",
    "/manage/unknown",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    await mount(
      mockClient({
        version: 1,
        profileId: "00000000-0000-4000-8000-000000000001",
        revision: 0,
        settings: null,
      }),
      path,
    );
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    await expect.element(page.getByText("No such page.")).toBeVisible();
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    await cleanup();
  }
  await mount(
    mockClient({
      version: 1,
      profileId: "00000000-0000-4000-8000-000000000001",
      revision: 0,
      settings: null,
    }),
    "/manage/sites/http/localhost:8080",
  );
  await expect
    .element(page.getByRole("heading", { level: 1, name: "http://localhost:8080" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Default account" }))
    .toMatchTextContent("Choose an account from the Pateat popup on localhost:8080");
});

test("matches and writes a trailing-dot origin's hostname without the dot", async () => {
  const client = mockClient({
    version: 1,
    profileId: "00000000-0000-4000-8000-000000000001",
    revision: 0,
    settings: settingsOf({
      siteDefaults: [{ ...bankDefault, origin: "https://bank.example." }],
    }),
  });
  await mount(client, "/manage/sites/https/bank.example.");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await toggle.click();
  await expect.element(toggle).not.toBeChecked();
  expect(client.saveSettings.mock.lastCall![1].excludedSites).toEqual([
    { hostname: "bank.example", includeSubdomains: false },
  ]);

  await cleanup();
  await mount(client, "/manage/sites");
  await expect
    .element(page.getByRole("listitem").filter({ hasText: "https://bank.example." }))
    .toMatchTextContent("Excluded");
});
