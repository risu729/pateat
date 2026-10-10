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

function mockClient() {
  return {
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

test("focus and metadata cache refreshes preserve a dirty draft and its revision", async () => {
  const client = mockClient();
  const { queryClient } = await mount(client);
  await addSite("draft.example");
  await page.getByLabelText("Demo work vault: Enabled", { exact: true }).click();

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
  await expect
    .element(page.getByLabelText("Demo work vault: Enabled", { exact: true }))
    .not.toBeChecked();
  await control("save-settings").click();
  await expect.element(control("settings-status")).toMatchTextContent("saved locally");
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.saveSettings.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: 0,
    settings: { excludedSites: [{ hostname: "draft.example", includeSubdomains: false }] },
  });
});

test("an unknown save outcome is never retried and requires a successful explicit reload", async () => {
  const client = mockClient();
  client.saveSettings.mockRejectedValue(new Error("Synthetic transport lost its response"));
  const { queryClient } = await mount(client);
  await addSite("draft.example");
  await control("save-settings").click();
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await expect.element(control("save-settings")).toBeDisabled();
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");

  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
  await expect.element(control("save-settings")).toBeDisabled();
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  client.getSettings.mockRejectedValueOnce(new Error("Synthetic read unavailable"));
  await control("reload-settings").click();
  await expect
    .poll(() => control("settings-status").element().textContent)
    .toMatch(/unable|failed|unavailable/i);
  await expect.element(control("save-settings")).toBeDisabled();
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");

  client.getSettings.mockResolvedValue(saved(1, "committed.example"));
  await control("reload-settings").click();
  await expect.element(control("settings-status")).toMatchTextContent("Saved settings loaded");
  await expect.element(control("excluded-sites")).toMatchTextContent("committed.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("draft.example");
  await expect.element(control("save-settings")).toBeDisabled();
  await addSite("next-draft.example");
  await expect.element(control("save-settings")).toBeEnabled();
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
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
  await page
    .getByLabelText("Demo personal vault: Item access", { exact: true })
    .selectOptions("selected");
  await page.getByLabelText("Demo personal vault: Include group Everyday", { exact: true }).click();
  await control("save-settings").click();
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
  await expect
    .element(page.getByLabelText("Demo personal vault: Item access", { exact: true }))
    .toHaveValue("selected");
  await expect
    .element(page.getByLabelText("Demo personal vault: Include group Everyday", { exact: true }))
    .toBeChecked();
  expect(client.getSettings).toHaveBeenCalledTimes(1);
  client.getSettings.mockResolvedValue(saved(2, "protected.example"));
  await control("reload-settings").click();
  await expect.element(control("excluded-sites")).toMatchTextContent("protected.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("draft.example");
});

test("pending writes and reloads cannot overlap or discard the draft", async () => {
  const client = mockClient();
  const write = deferred<SettingsResponse>();
  client.saveSettings.mockReturnValue(write.promise);
  await mount(client);
  await addSite("pending.example");
  await control("save-settings").click();
  await expect.element(control("save-settings")).toBeDisabled();
  await expect.element(control("reload-settings")).toBeDisabled();
  // A second submission can arrive from keyboard/form code even when its button is disabled.
  const form = document.getElementById("settings-form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing settings form");
  form.requestSubmit();
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.getSettings).toHaveBeenCalledTimes(1);
  await expect.element(control("excluded-sites")).toMatchTextContent("pending.example");
  write.resolve(saved(1, "pending.example"));
  await expect.element(control("settings-status")).toMatchTextContent("saved locally");

  const read = deferred<SettingsResponse>();
  client.getSettings.mockReturnValue(read.promise);
  await control("reload-settings").click();
  await expect.element(control("save-settings")).toBeDisabled();
  await expect.element(control("reload-settings")).toBeDisabled();
  form.requestSubmit();
  expect(client.saveSettings).toHaveBeenCalledTimes(1);
  expect(client.getSettings).toHaveBeenCalledTimes(2);
  read.resolve(saved(2, "reloaded.example"));
  await expect.element(control("excluded-sites")).toMatchTextContent("reloaded.example");
  await expect.element(control("save-settings")).toBeDisabled();
  await addSite("next-draft.example");
  await expect.element(control("save-settings")).toBeEnabled();
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

  await control("default-origin").fill("https://bank.example/path");
  await control("default-account").selectOptions(JSON.stringify(["demo-personal", "primary"]));
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
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("malformed save responses are rejected at the runtime boundary and keep the draft blocked", async () => {
  const send = vi
    .fn<(message: unknown) => Promise<unknown>>()
    .mockImplementation(async (message) => {
      const type = (message as { type: string }).type;
      if (type === "runtime.status.get") return getFoundationStatus();
      if (type === "settings.get") return saved();
      // A successful-looking object carrying an unexpected property must not replace the draft.
      return { ...saved(1, "malformed.example"), unexpected: true };
    });
  await mount(createSettingsClient(send));
  await addSite("draft.example");
  await control("save-settings").click();
  await expect.poll(() => control("settings-status").element().textContent).toMatch(/Reload/i);
  await expect.element(control("save-settings")).toBeDisabled();
  await expect.element(control("excluded-sites")).toMatchTextContent("draft.example");
  await expect.element(control("excluded-sites")).not.toMatchTextContent("malformed.example");
  expect(
    send.mock.calls.filter(([request]) => (request as { type: string }).type === "settings.save"),
  ).toHaveLength(1);
});
