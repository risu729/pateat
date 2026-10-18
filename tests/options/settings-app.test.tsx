import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { locators, page, userEvent, type Locator } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  createSettingsClient,
  SETTINGS_QUERY_KEY,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
} from "../../packages/contracts/src/index";

function saved(revision = 0, hostname?: string): Extract<SettingsResponse, { ok: true }> {
  const settings = createDefaultSettings();
  if (hostname) settings.excludedSites.push({ hostname, includeSubdomains: false });
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision, settings },
    catalog: structuredClone(DUMMY_VAULT_CATALOG),
  };
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

function mockClient() {
  return {
    findSiteAccounts: vi
      .fn<SettingsClient["findSiteAccounts"]>()
      .mockImplementation(demoSiteAccounts),
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(saved()),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockImplementation(async (request) => ({
      ...saved(request.expectedRevision + 1),
      snapshot: {
        version: 1,
        revision: request.expectedRevision + 1,
        settings: structuredClone(request.settings),
      },
    })),
  };
}

declare module "vitest/browser" {
  interface LocatorSelectors {
    getById(id: string): Locator;
  }
}

// Status/list text changes during a request; preserve the public control ID as its locator.
locators.extend({ getById: (id: string) => `css=#${CSS.escape(id)}` });

function control(id: string) {
  return page.getById(id);
}

async function mount(client: SettingsClient = mockClient()) {
  const queryClient = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsApp client={client} />
    </QueryClientProvider>,
  );
  await expect.element(control("settings-status")).toMatchTextContent("Saved settings loaded");
  return { queryClient, client };
}

async function addSite(hostname: string) {
  await control("site-origin").fill(hostname);
  await control("add-site").click();
  await expect.element(control("site-list")).toMatchTextContent(hostname);
}

/** Vault-wide lists start collapsed; tests open them like the owner would. */
async function expand(connection: string, ...summaries: string[]) {
  const group = page.getByRole("group", { name: connection, exact: true });
  for (const summary of summaries) {
    // Nested disclosures open in order: an item's summary is hidden until its list opens.
    // oxlint-disable-next-line no-await-in-loop
    await group.getByText(new RegExp(`^${summary}`)).click();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await cleanup();
  focusManager.setFocused(undefined);
});

test("each change is saved at once and refreshes never replace a pending draft", async () => {
  const client = mockClient();
  const write = deferred<SettingsResponse>();
  client.saveSettings.mockReturnValueOnce(write.promise);
  const { queryClient } = await mount(client);
  await addSite("draft.example");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.saveSettings.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: 0,
    settings: { excludedSites: [{ hostname: "draft.example", includeSubdomains: false }] },
  });

  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await vi.waitFor(() => expect(client.getSettings).toHaveBeenCalledTimes(1));
  client.getSettings.mockResolvedValue(saved(4, "remote.example"));
  await queryClient.refetchQueries({ queryKey: SETTINGS_QUERY_KEY });
  expect(client.getSettings).toHaveBeenCalledTimes(2);
  queryClient.setQueryData(SETTINGS_QUERY_KEY, saved(5, "cached.example"));
  await expect.element(control("site-list")).toMatchTextContent("draft.example");
  await expect.element(control("site-list")).not.toMatchTextContent("remote.example");
  await expect.element(control("site-list")).not.toMatchTextContent("cached.example");

  write.resolve(saved(1, "draft.example"));
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 1");
  await page.getByLabelText("Demo work vault: Use this vault", { exact: true }).click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 1,
    settings: { excludedSites: [{ hostname: "draft.example" }] },
  });
  await expect
    .element(page.getByLabelText("Demo work vault: Use this vault", { exact: true }))
    .not.toBeChecked();
});

test("an unknown save outcome is never retried and requires a successful explicit reload", async () => {
  const client = mockClient();
  client.saveSettings.mockRejectedValue(new Error("Synthetic transport lost its response"));
  const { queryClient } = await mount(client);
  await addSite("draft.example");
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await expect.element(control("site-list")).toMatchTextContent("draft.example");
  // Further edits stay in the draft without another save.
  await addSite("second.example");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);

  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  client.getSettings.mockRejectedValueOnce(new Error("Synthetic read unavailable"));
  await control("reload-settings").click();
  await expect
    .poll(() => control("settings-status").element().textContent)
    .toMatch(/unable|failed|unavailable/i);
  await expect.element(control("site-list")).toMatchTextContent("draft.example");
  await addSite("third.example");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);

  client.getSettings.mockResolvedValue(saved(1, "committed.example"));
  await control("reload-settings").click();
  await expect.element(control("settings-status")).toMatchTextContent("Saved settings loaded");
  await expect.element(control("site-list")).toMatchTextContent("committed.example");
  await expect.element(control("site-list")).not.toMatchTextContent("draft.example");
  client.saveSettings.mockImplementation(async (request) => ({
    ...saved(request.expectedRevision + 1),
    snapshot: { version: 1, revision: request.expectedRevision + 1, settings: request.settings },
  }));
  await addSite("next-draft.example");
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 1 });
});

test("vault-wide lists start collapsed and summarize their selections", async () => {
  const client = mockClient();
  const response = saved();
  const personal = response.snapshot.settings.connections[0]!;
  personal.selection = { mode: "selected", groupIds: ["everyday"], itemIds: [] };
  personal.excludedItemIds = ["secondary"];
  // A field exclusion on an excluded item is not counted again.
  personal.excludedFields = [
    { itemId: "primary", fieldId: "branch" },
    { itemId: "secondary", fieldId: "password" },
  ];
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  const vault = page.getByRole("group", { name: "Demo personal vault", exact: true });
  // The summaries count what is selected and what is excluded.
  await expect
    .element(vault.getByText(/^Included groups and items/))
    .toHaveTextContent("Included groups and items 1 selected");
  await expect
    .element(vault.getByText(/^Excluded items and fields/))
    .toHaveTextContent("Excluded items and fields 2 excluded");
  // With all items in use, there is no selection to show.
  await expect
    .element(
      page
        .getByRole("group", { name: "Demo work vault", exact: true })
        .getByText(/^Included groups and items/),
    )
    .not.toBeInTheDocument();
  const include = page.getByLabelText("Demo personal vault: Include group Everyday", {
    exact: true,
  });
  await expect.element(include).not.toBeVisible();
  await expand("Demo personal vault", "Included groups and items");
  await expect.element(include).toBeVisible();
  await expect.element(include).toBeChecked();
  await expect
    .element(vault.getByText("1 of 1 group, 0 of 2 items selected", { exact: true }))
    .toBeVisible();

  const branch = page.getByLabelText(
    "Demo personal vault: Exclude Branch number from Demo primary account",
    { exact: true },
  );
  await expand("Demo personal vault", "Excluded items and fields");
  await expect
    .element(vault.getByText("1 item and 1 field excluded", { exact: true }))
    .toBeVisible();
  await expect
    .element(vault.getByText(/^Demo primary account ./))
    .toHaveTextContent("Demo primary account 1 field excluded");
  await expect
    .element(vault.getByText(/^Demo secondary account ./))
    .toHaveTextContent("Demo secondary account Item excluded");
  await expect.element(branch).not.toBeVisible();
  await expand("Demo personal vault", "Demo primary account");
  await expect.element(branch).toBeChecked();
  await branch.click();
  await expect
    .element(vault.getByText(/^Demo primary account ./))
    .toHaveTextContent("Demo primary account Nothing excluded");
  await expect
    .element(vault.getByText(/^Excluded items and fields/))
    .toHaveTextContent("Excluded items and fields 1 excluded");
  await expect.element(vault.getByText("1 item excluded", { exact: true })).toBeVisible();
  // Edits re-render the draft without closing what the owner opened.
  await expect.element(branch).toBeVisible();
});

test("edits during a pending save are saved after it, and reloads cannot overlap it", async () => {
  const client = mockClient();
  const write = deferred<SettingsResponse>();
  client.saveSettings.mockReturnValueOnce(write.promise);
  await mount(client);
  await addSite("pending.example");
  await expect.element(control("reload-settings")).toBeDisabled();
  // Editing stays possible while the save runs; the change waits for it.
  await addSite("later.example");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.getSettings).toHaveBeenCalledTimes(1);
  write.resolve(saved(1, "pending.example"));
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 1,
    settings: {
      excludedSites: [{ hostname: "pending.example" }, { hostname: "later.example" }],
    },
  });
  await expect.element(control("site-list")).toMatchTextContent("later.example");
  await expect.element(control("reload-settings")).toBeEnabled();

  const read = deferred<SettingsResponse>();
  client.getSettings.mockReturnValue(read.promise);
  await control("reload-settings").click();
  await expect.element(control("reload-settings")).toBeDisabled();
  await expect.element(control("site-origin")).toBeDisabled();
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.getSettings).toHaveBeenCalledTimes(2);
  read.resolve(saved(3, "reloaded.example"));
  await expect.element(control("site-list")).toMatchTextContent("reloaded.example");
  await addSite("next-draft.example");
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 4");
});

test("the add form validates locally and keeps focus on the origin after adds and removals", async () => {
  const client = mockClient();
  await mount(client);
  await control("site-origin").fill("https://invalid.example/path");
  await control("add-site").click();
  await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "true");
  await expect.element(control("site-origin")).toHaveFocus();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(client.saveSettings).not.toHaveBeenCalled();

  await control("site-origin").fill("keyboard.example");
  await control("add-site").click();
  await expect.element(control("site-list")).toMatchTextContent("keyboard.example");
  await expect.element(control("site-origin")).toHaveValue("");
  await expect.element(control("site-origin")).toHaveFocus();
  await page.getByRole("button", { name: "Allow keyboard.example", exact: true }).click();
  await expect.element(control("site-origin")).toHaveFocus();
  await expect.element(control("site-list")).not.toMatchTextContent("keyboard.example");

  // Only items matching the entered origin are offered.
  await expect.element(control("default-account")).toBeDisabled();
  await control("site-origin").fill("https://mail.example");
  await expect.element(control("default-account-note")).toMatchTextContent("1 matching item");
  await expect
    .poll(() =>
      [...(control("default-account").element() as HTMLSelectElement).options].map(
        (option) => option.value,
      ),
    )
    .toEqual([JSON.stringify(["demo-personal", "secondary"])]);
  await control("site-origin").fill("https://none.example");
  await expect.element(control("default-account-note")).toMatchTextContent("No vault item matches");
  await expect.element(control("default-account")).toBeDisabled();
  // A rule on a longer path does not match the origin, so every item can still be listed.
  await control("default-account-all").click();
  await expect.element(control("default-account")).toBeEnabled();
  await expect.element(control("default-account")).toMatchTextContent("no match for this origin");
  await control("default-account-all").click();
  await control("site-origin").fill("https://bank.example");
  await control("default-account").selectOptions(JSON.stringify(["demo-personal", "primary"]));
  await control("site-origin").fill("https://bank.example/path");
  await control("site-origin").click();
  await userEvent.keyboard("{Enter}");
  await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "true");
  await expect.element(control("site-origin")).toHaveFocus();
  await control("site-origin").fill("https://bank.example");
  await userEvent.keyboard("{Enter}");
  await expect.element(control("site-list")).toMatchTextContent("https://bank.example");
  // The default names the account, and is shown through this device's connection.
  await expect
    .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
    .toHaveDisplayValue("Demo primary account in Demo personal vault");
  await expect.element(control("site-origin")).toHaveFocus();
  // Each add and removal was saved without moving focus.
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 3");
  await expect.element(control("site-origin")).toHaveFocus();
  expect(client.saveSettings).toHaveBeenCalledTimes(3);
  // The saved default keeps the connection's label and the item's name for display.
  expect(client.saveSettings.mock.calls[2]?.[0].settings.siteDefaults).toEqual([
    {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "demo-personal-account",
      itemId: "primary",
      itemName: "Demo primary account",
      accountName: "Demo personal vault",
    },
  ]);
});

test("an origin row changes its default only on Save, and No default removes it", async () => {
  const client = mockClient();
  const response = saved(1);
  response.snapshot.settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-personal-account",
    itemId: "secondary",
    itemName: "Demo secondary account",
    accountName: "Demo personal vault",
  });
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  const select = page.getByRole("combobox", {
    name: "Default account for https://bank.example",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save default for https://bank.example" });
  // Every account that matches the origin is offered, with the saved one chosen.
  await expect
    .poll(() =>
      [...(select.element() as HTMLSelectElement).options].map((option) => option.textContent),
    )
    .toEqual([
      "Demo primary account in Demo personal vault",
      "Demo secondary account in Demo personal vault",
      "Demo team account in Demo work vault",
      "No default",
    ]);
  await expect.element(select).toHaveValue(JSON.stringify(["demo-personal", "secondary"]));
  await expect.element(save).toBeDisabled();
  await select.selectOptions(JSON.stringify(["demo-work", "primary"]));
  expect(client.saveSettings).not.toHaveBeenCalled();
  await expect.element(save).toBeEnabled();
  await save.click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings.mock.calls[0]?.[0].settings.siteDefaults).toEqual([
    {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    },
  ]);
  await expect.element(save).toBeDisabled();
  await select.selectOptions("No default");
  await save.click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 3");
  expect(client.saveSettings.mock.calls[1]?.[0].settings.siteDefaults).toEqual([]);
  await expect.element(select).not.toBeInTheDocument();
  // The row is gone, so focus moves to the add form.
  await expect.element(control("site-origin")).toHaveFocus();
});

test("excluding an origin keeps its default unused under the rule until it is allowed", async () => {
  const client = mockClient();
  const response = saved(1);
  response.snapshot.settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-personal-account",
    itemId: "primary",
  });
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  await page
    .getByRole("button", { name: "Exclude https://bank.example, all schemes and ports" })
    .click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({
    excludedSites: [{ hostname: "bank.example", includeSubdomains: false }],
    siteDefaults: [{ origin: "https://bank.example" }],
  });
  await expect
    .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
    .not.toBeInTheDocument();
  await expect
    .element(control("site-list"))
    .toMatchTextContent("Default for https://bank.example kept, unused while excluded");
  await page.getByRole("button", { name: "Allow bank.example", exact: true }).click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 3");
  await expect
    .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
    .toBeVisible();
});

test("a default kept under a rule is listed once and can be removed", async () => {
  const client = mockClient();
  const response = saved(1);
  response.snapshot.settings.excludedSites.push(
    { hostname: "example", includeSubdomains: true },
    { hostname: "bank.example", includeSubdomains: false },
  );
  response.snapshot.settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-personal-account",
    itemId: "primary",
  });
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  const remove = page.getByRole("button", { name: "Remove default for https://bank.example" });
  // Both rules exclude the origin; it is listed under the more specific one only.
  await expect.element(remove).toBeVisible();
  expect(
    control("site-list")
      .element()
      .textContent?.match(/Default for https:\/\/bank\.example kept/g),
  ).toHaveLength(1);
  await remove.click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({
    excludedSites: [
      { hostname: "example", includeSubdomains: true },
      { hostname: "bank.example", includeSubdomains: false },
    ],
    siteDefaults: [],
  });
  await expect.element(remove).not.toBeInTheDocument();
  await expect.element(control("site-origin")).toHaveFocus();
});

test("an origin with a trailing dot is excluded by its hostname without the dot", async () => {
  const client = mockClient();
  const response = saved(1);
  response.snapshot.settings.siteDefaults.push({
    origin: "https://bank.example.",
    provider: "dummy",
    userId: "demo-personal-account",
    itemId: "primary",
  });
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  await page
    .getByRole("button", { name: "Exclude https://bank.example., all schemes and ports" })
    .click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings.mock.calls[0]?.[0].settings.excludedSites).toEqual([
    { hostname: "bank.example", includeSubdomains: false },
  ]);
  await expect
    .element(control("site-list"))
    .toMatchTextContent("Default for https://bank.example. kept, unused while excluded");
  await expect
    .element(page.getByRole("button", { name: "Remove default for https://bank.example." }))
    .toBeVisible();
});

test("the add form excludes the entered origin's host, with its subdomains when asked", async () => {
  const client = mockClient();
  await mount(client);
  await expect
    .element(page.getByText("No excluded sites or default accounts", { exact: true }))
    .toBeVisible();
  await control("site-origin").fill("http://localhost:8080");
  await control("add-site").click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 1");
  await control("site-origin").fill("bank.example");
  await control("site-subdomains").click();
  await control("add-site").click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings.mock.calls[1]?.[0].settings.excludedSites).toEqual([
    { hostname: "localhost", includeSubdomains: false },
    { hostname: "bank.example", includeSubdomains: true },
  ]);
  // Rules and origins share one list, by hostname.
  await expect
    .poll(() =>
      [...control("site-list").element().querySelectorAll(":scope > li")].map(
        (row) => row.querySelector("span > span")?.textContent,
      ),
    )
    .toEqual(["bank.example and subdomains", "localhost"]);
  await expect
    .element(page.getByText("No excluded sites or default accounts", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Allow bank.example and subdomains", exact: true }))
    .toBeVisible();
  await expect.element(control("site-subdomains")).not.toBeChecked();
});

test("an origin row names why its default cannot be used", async () => {
  const client = mockClient();
  const response = saved(1);
  const work = response.snapshot.settings.connections[1]!;
  work.selection = { mode: "selected", groupIds: [], itemIds: [] };
  response.snapshot.settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-work-account",
    itemId: "primary",
    itemName: "Demo team account",
    accountName: "Demo work vault",
  });
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  await expect
    .element(control("site-list"))
    .toMatchTextContent("This account is outside the selected groups and items.");
  await expect
    .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
    .toHaveDisplayValue("Demo team account in Demo work vault (unavailable)");
});

test("a rejected draft is not saved again until the next change", async () => {
  const client = mockClient();
  client.saveSettings.mockResolvedValueOnce({
    version: 1,
    ok: false,
    error: { code: "invalid-settings", message: "Synthetic invalid settings." },
  });
  await mount(client);
  await addSite("draft.example");
  await expect.element(control("settings-status")).toMatchTextContent("Synthetic invalid settings");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  await addSite("second.example");
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 1");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 0,
    settings: { excludedSites: [{ hostname: "draft.example" }, { hostname: "second.example" }] },
  });
});

test("a draft that fails local validation is saved by the change that fixes it", async () => {
  const client = mockClient();
  const response = saved(1);
  // The schema allows at most 1000 excluded sites.
  for (let index = 0; index < 1000; index += 1)
    response.snapshot.settings.excludedSites.push({
      hostname: `site${index}.example`,
      includeSubdomains: false,
    });
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  await addSite("extra.example");
  await expect.element(control("settings-status")).toMatchTextContent("Invalid settings");
  expect(client.saveSettings).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Allow site0.example", exact: true }).click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally. Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  const excluded = client.saveSettings.mock.calls[0]?.[0].settings.excludedSites;
  expect(excluded).toHaveLength(1000);
  expect(excluded).toContainEqual({ hostname: "extra.example", includeSubdomains: false });
  expect(excluded).not.toContainEqual({ hostname: "site0.example", includeSubdomains: false });
});

test("an edit made during a save that conflicts stays in the draft unsaved", async () => {
  const client = mockClient();
  const write = deferred<SettingsResponse>();
  client.saveSettings.mockReturnValueOnce(write.promise);
  await mount(client);
  await addSite("pending.example");
  await addSite("later.example");
  write.resolve({
    version: 1,
    ok: false,
    error: { code: "revision-conflict", message: "Synthetic newer revision exists." },
  });
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await expect.element(control("site-list")).toMatchTextContent("later.example");
  // Edits after the conflict, to a site list and to a vault, stay in the draft too.
  await addSite("after.example");
  await expect.element(control("site-list")).toMatchTextContent("after.example");
  const items = page.getByLabelText("Demo personal vault: Items for Pateat", { exact: true });
  await items.selectOptions("selected");
  await expect.element(items).toHaveValue("selected");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
});

test("a default for an account not connected here shows its saved names", async () => {
  const client = mockClient();
  const response = saved(1);
  response.snapshot.settings.siteDefaults.push(
    {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "another-account",
      itemId: "remote-item",
      itemName: "Remote bank login",
    },
    {
      origin: "https://mail.example",
      provider: "dummy",
      userId: "another-account",
      itemId: "remote-mail",
      itemName: "Remote mail login",
      accountName: "Other device vault",
    },
  );
  client.getSettings.mockResolvedValue(response);
  await mount(client);
  await expect
    .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
    .toHaveDisplayValue("Remote bank login in account another-account (not available here)");
  await expect
    .element(page.getByRole("combobox", { name: "Default account for https://mail.example" }))
    .toHaveDisplayValue("Remote mail login in Other device vault (not available here)");
  await expect
    .element(control("site-list"))
    .toMatchTextContent("The vault connection is unavailable.");
});

test("malformed save responses are rejected at the runtime boundary and keep the draft blocked", async () => {
  const send = vi
    .fn<(message: unknown) => Promise<unknown>>()
    .mockImplementation(async (message) => {
      const type = (message as { type: string }).type;
      if (type === "settings.get") return saved();
      if (type === "settings.site-accounts")
        return demoSiteAccounts((message as { origin: string }).origin);
      // A successful-looking object carrying an unexpected property must not replace the draft.
      return { ...saved(1, "malformed.example"), unexpected: true };
    });
  await mount(createSettingsClient(send));
  await addSite("draft.example");
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await addSite("second.example");
  await expect.element(control("site-list")).toMatchTextContent("draft.example");
  await expect.element(control("site-list")).not.toMatchTextContent("malformed.example");
  expect(
    send.mock.calls.filter(([request]) => (request as { type: string }).type === "settings.save"),
  ).toHaveLength(1);
});
