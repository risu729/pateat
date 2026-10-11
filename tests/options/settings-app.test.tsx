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
  getFoundationStatus,
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
    getStatus: vi.fn<SettingsClient["getStatus"]>().mockResolvedValue(getFoundationStatus()),
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
  await control("site-hostname").fill(hostname);
  await control("add-site").click();
  await expect.element(control("excluded-sites")).toMatchTextContent(hostname);
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
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("remote.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("cached.example");

  write.resolve(saved(1, "draft.example"));
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 1");
  await page.getByLabelText("Demo work vault: Enabled", { exact: true }).click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 1,
    settings: { excludedSites: [{ hostname: "draft.example" }] },
  });
  await expect
    .element(page.getByLabelText("Demo work vault: Enabled", { exact: true }))
    .not.toBeChecked();
});

test("an unknown save outcome is never retried and requires a successful explicit reload", async () => {
  const client = mockClient();
  client.saveSettings.mockRejectedValue(new Error("Synthetic transport lost its response"));
  const { queryClient } = await mount(client);
  await addSite("draft.example");
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
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
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
  await addSite("third.example");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);

  client.getSettings.mockResolvedValue(saved(1, "committed.example"));
  await control("reload-settings").click();
  await expect.element(control("settings-status")).toMatchTextContent("Saved settings loaded");
  await expect.element(control("excluded-sites")).toMatchTextContent("committed.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("draft.example");
  client.saveSettings.mockImplementation(async (request) => ({
    ...saved(request.expectedRevision + 1),
    snapshot: { version: 1, revision: request.expectedRevision + 1, settings: request.settings },
  }));
  await addSite("next-draft.example");
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 2");
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
  await expect
    .element(vault.getByText(/^Included groups and items/))
    .toHaveTextContent("Included groups and items 1 of 1 group, 0 of 2 items selected");
  await expect
    .element(vault.getByText(/^Item and field exclusions/))
    .toHaveTextContent("Item and field exclusions 1 item and 1 field excluded");
  await expect
    .element(
      page
        .getByRole("group", { name: "Demo work vault", exact: true })
        .getByText(/^Included groups and items/),
    )
    .toHaveTextContent("Included groups and items Not used: all items except exclusions");
  const include = page.getByLabelText("Demo personal vault: Include group Everyday", {
    exact: true,
  });
  await expect.element(include).not.toBeVisible();
  await expand("Demo personal vault", "Included groups and items");
  await expect.element(include).toBeVisible();
  await expect.element(include).toBeChecked();

  const branch = page.getByLabelText(
    "Demo personal vault: Exclude Branch number from Demo primary account",
    { exact: true },
  );
  await expand("Demo personal vault", "Item and field exclusions");
  await expect
    .element(vault.getByText(/^Demo primary account/))
    .toHaveTextContent("Demo primary account 1 field excluded");
  await expect
    .element(vault.getByText(/^Demo secondary account/))
    .toHaveTextContent("Demo secondary account Item excluded");
  await expect.element(branch).not.toBeVisible();
  await expand("Demo personal vault", "Demo primary account");
  await expect.element(branch).toBeChecked();
  await branch.click();
  await expect
    .element(vault.getByText(/^Demo primary account/))
    .toHaveTextContent("Demo primary account Nothing excluded");
  await expect
    .element(vault.getByText(/^Item and field exclusions/))
    .toHaveTextContent("Item and field exclusions 1 item excluded");
  // Edits re-render the draft without closing what the owner opened.
  await expect.element(branch).toBeVisible();
});

test("revision conflicts preserve all draft edits until the owner reloads", async () => {
  const client = mockClient();
  client.saveSettings.mockResolvedValue({
    version: 1,
    ok: false,
    error: { code: "revision-conflict", message: "Synthetic newer revision exists. Reload first." },
  });
  await mount(client);
  await addSite("draft.example");
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await page
    .getByLabelText("Demo personal vault: Item access", { exact: true })
    .selectOptions("selected");
  await expand("Demo personal vault", "Included groups and items");
  await page.getByLabelText("Demo personal vault: Include group Everyday", { exact: true }).click();
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
  await expect
    .element(page.getByLabelText("Demo personal vault: Item access", { exact: true }))
    .toHaveValue("selected");
  await expect
    .element(page.getByLabelText("Demo personal vault: Include group Everyday", { exact: true }))
    .toBeChecked();
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.getSettings).toHaveBeenCalledTimes(1);
  client.getSettings.mockResolvedValue(saved(2, "protected.example"));
  await control("reload-settings").click();
  await expect.element(control("excluded-sites")).toMatchTextContent("protected.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("draft.example");
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
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 2");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 1,
    settings: {
      excludedSites: [{ hostname: "pending.example" }, { hostname: "later.example" }],
    },
  });
  await expect.element(control("excluded-sites")).toMatchTextContent("later.example");
  await expect.element(control("reload-settings")).toBeEnabled();

  const read = deferred<SettingsResponse>();
  client.getSettings.mockReturnValue(read.promise);
  await control("reload-settings").click();
  await expect.element(control("reload-settings")).toBeDisabled();
  await expect.element(control("site-hostname")).toBeDisabled();
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.getSettings).toHaveBeenCalledTimes(2);
  read.resolve(saved(3, "reloaded.example"));
  await expect.element(control("excluded-sites")).toMatchTextContent("reloaded.example");
  await addSite("next-draft.example");
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 4");
});

test("keyboard add forms validate locally and recover input focus after add and removal", async () => {
  const client = mockClient();
  await mount(client);
  await control("site-hostname").fill("https://invalid.example/path");
  await control("site-hostname").click();
  await userEvent.keyboard("{Enter}");
  await expect.element(control("site-hostname")).toHaveAttribute("aria-invalid", "true");
  await expect.element(control("site-hostname")).toHaveFocus();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(client.saveSettings).not.toHaveBeenCalled();

  await control("site-hostname").fill("keyboard.example");
  await userEvent.keyboard("{Enter}");
  await expect.element(control("excluded-sites")).toMatchTextContent("keyboard.example");
  await expect.element(control("site-hostname")).toHaveValue("");
  await expect.element(control("site-hostname")).toHaveFocus();
  await page.getByRole("button", { name: /Remove.*keyboard.example/i }).click();
  await expect.element(control("site-hostname")).toHaveFocus();
  await expect.element(control("excluded-sites")).not.toMatchTextContent("keyboard.example");

  // Only items matching the entered origin are offered.
  await expect.element(control("default-account")).toBeDisabled();
  await control("default-origin").fill("https://mail.example");
  await expect.element(control("default-account-note")).toMatchTextContent("1 matching item");
  await expect
    .poll(() =>
      [...(control("default-account").element() as HTMLSelectElement).options].map(
        (option) => option.value,
      ),
    )
    .toEqual([JSON.stringify(["demo-personal", "secondary"])]);
  await control("default-origin").fill("https://none.example");
  await expect.element(control("default-account-note")).toMatchTextContent("No vault item matches");
  await expect.element(control("default-account")).toBeDisabled();
  // A rule on a longer path does not match the origin, so every item can still be listed.
  await control("default-account-all").click();
  await expect.element(control("default-account")).toBeEnabled();
  await expect.element(control("default-account")).toMatchTextContent("no match for this origin");
  await control("default-account-all").click();
  await control("default-origin").fill("https://bank.example");
  await control("default-account").selectOptions(JSON.stringify(["demo-personal", "primary"]));
  await control("default-origin").fill("https://bank.example/path");
  await control("default-origin").click();
  await userEvent.keyboard("{Enter}");
  await expect.element(control("default-origin")).toHaveAttribute("aria-invalid", "true");
  await expect.element(control("default-origin")).toHaveFocus();
  await control("default-origin").fill("https://bank.example");
  await userEvent.keyboard("{Enter}");
  await expect.element(control("site-defaults")).toMatchTextContent("https://bank.example");
  // The default names the account, and is shown through this device's connection.
  await expect.element(control("site-defaults")).toMatchTextContent("Demo personal vault");
  await expect.element(control("default-origin")).toHaveFocus();
  // Each add and removal was saved without moving focus.
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 3");
  await expect.element(control("default-origin")).toHaveFocus();
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
  await expect.element(control("settings-status")).toMatchTextContent("saved locally · Revision 1");
  expect(client.saveSettings).toHaveBeenCalledTimes(2);
  expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 0,
    settings: { excludedSites: [{ hostname: "draft.example" }, { hostname: "second.example" }] },
  });
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
  await expect.element(control("excluded-sites")).toMatchTextContent("later.example");
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
    .element(control("site-defaults"))
    .toMatchTextContent("account another-account (not available here) / Remote bank login");
  await expect
    .element(control("site-defaults"))
    .toMatchTextContent("Other device vault (not available here) / Remote mail login");
});

test("malformed save responses are rejected at the runtime boundary and keep the draft blocked", async () => {
  const send = vi
    .fn<(message: unknown) => Promise<unknown>>()
    .mockImplementation(async (message) => {
      const type = (message as { type: string }).type;
      if (type === "runtime.status.get") return getFoundationStatus();
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
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("malformed.example");
  expect(
    send.mock.calls.filter(([request]) => (request as { type: string }).type === "settings.save"),
  ).toHaveLength(1);
});
