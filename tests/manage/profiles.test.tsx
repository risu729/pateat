import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { SyncSettingsState } from "../../packages/contracts/src/index";
import { ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

const LOCAL = "00000000-0000-4000-8000-000000000010";
const AGENT = "00000000-0000-4000-8000-000000000011";
const state = (profileId: string, hostname: string): SyncSettingsState => ({
  version: 1,
  profileId,
  revision: 3,
  settings: {
    connections: [],
    excludedSites: [{ hostname, includeSubdomains: false }],
    siteDefaults: [],
    bindings: [],
  },
});

afterEach(async () => {
  await cleanup();
  sessionStorage.clear();
});

test("selecting another profile clears the old policy view and writes only to the selected profile", async () => {
  let selected: string | undefined;
  const states = new Map([
    [LOCAL, state(LOCAL, "local-only.example")],
    [AGENT, state(AGENT, "agent-only.example")],
  ]);
  const client: ManageClient = {
    get profileId() {
      return selected;
    },
    selectProfile: vi.fn((id) => {
      selected = id;
    }),
    profiles: vi.fn(async () => ({
      version: 1 as const,
      profiles: [
        { id: LOCAL, name: "Local" },
        { id: AGENT, name: "Agent" },
      ],
    })),
    copyProfile: vi.fn(),
    renameProfile: vi.fn(),
    deleteProfile: vi.fn(),
    assignProfile: vi.fn(),
    devices: vi.fn(),
    dashboard: vi.fn(),
    models: vi.fn(),
    saveModels: vi.fn(),
    requestLog: vi.fn(),
    deleteRequestLog: vi.fn(),
    revokeDevice: vi.fn(),
    settings: vi.fn(async (id = selected) => {
      const value = id ? states.get(id) : undefined;
      if (!value) throw new Error("Choose a profile first");
      return structuredClone(value);
    }),
    saveSettings: vi.fn(async (revision, settings, id = selected) => {
      if (!id) throw new Error("Choose a profile first");
      const next = { version: 1 as const, profileId: id, revision: revision + 1, settings };
      states.set(id, structuredClone(next));
      return next;
    }),
    recipes: vi.fn(async () => ({ version: 1 as const, recipes: [], unreadable: [] })),
    revokeRecipe: vi.fn(),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path="/manage/sites" />
    </QueryClientProvider>,
  );
  const selector = page.getByRole("combobox", { name: "Settings profile" });
  await expect.element(selector).toHaveValue("");
  expect(client.settings).not.toHaveBeenCalled();
  await selector.selectOptions(LOCAL);
  await expect.element(page.getByText("local-only.example", { exact: true })).toBeVisible();
  await selector.selectOptions(AGENT);
  await expect.element(page.getByText("agent-only.example", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("local-only.example", { exact: true }))
    .not.toBeInTheDocument();
  await page.getByLabelText("Hostname").fill("new-agent.example");
  await page.getByRole("button", { name: "Exclude site" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("new-agent.example excluded");
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    3,
    expect.objectContaining({
      excludedSites: [
        { hostname: "agent-only.example", includeSubdomains: false },
        { hostname: "new-agent.example", includeSubdomains: false },
      ],
    }),
    AGENT,
  );
  expect(states.get(LOCAL)).toEqual(state(LOCAL, "local-only.example"));
  // The choice lasts for this tab, so a site's page edits the same profile.
  await cleanup();
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <ManageApp client={client} path="/manage/sites" />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("combobox", { name: "Settings profile" })).toHaveValue(AGENT);
});

function profilesClient() {
  let profiles = [
    { id: LOCAL, name: "Local" },
    { id: AGENT, name: "Agent" },
  ];
  const device = (id: string, label: string, profileId: string) => ({
    id,
    profileId,
    label,
    createdAt: 0,
    lastUsedAt: Date.now(),
    revokedAt: null,
  });
  return {
    selectProfile: vi.fn(),
    profiles: vi.fn(async () => ({ version: 1 as const, profiles: structuredClone(profiles) })),
    devices: vi.fn(async () => ({
      version: 1 as const,
      devices: [device("00000000-0000-4000-8000-0000000000a1", "Work laptop", LOCAL)],
    })),
    renameProfile: vi.fn(async (id: string, name: string) => {
      profiles = profiles.map((profile) => (profile.id === id ? { id, name } : profile));
      return { id, name };
    }),
    deleteProfile: vi.fn(async (id: string) => {
      profiles = profiles.filter((profile) => profile.id !== id);
    }),
    copyProfile: vi.fn(async (name: string) => {
      const created = { id: "00000000-0000-4000-8000-000000000012", name };
      profiles = [...profiles, created];
      return created;
    }),
  } as unknown as ManageClient;
}

async function profilesPage(client: ManageClient) {
  await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ManageApp client={client} path="/manage/profiles" />
    </QueryClientProvider>,
  );
}

test("lists profiles with the devices that use them and deletes only an unused one", async () => {
  const client = profilesClient();
  await profilesPage(client);
  const local = page.getByRole("button", { name: "Delete Local", exact: true });
  await expect.element(local).toBeDisabled();
  await expect.element(local).toHaveAccessibleDescription("Used by Work laptop");
  await expect.element(page.getByText("No device uses this profile")).toBeVisible();
  await page.getByRole("button", { name: "Delete Agent", exact: true }).click();
  await expect.element(page.getByText("Delete Agent?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  expect(client.deleteProfile).toHaveBeenCalledWith(AGENT);
  await expect.element(page.getByRole("status")).toHaveTextContent("Agent deleted");
  // The last profile stays.
  await expect
    .element(page.getByRole("button", { name: "Delete Local", exact: true }))
    .toBeDisabled();
});

test("names the devices when the service refuses to delete a profile in use", async () => {
  const client = profilesClient();
  vi.mocked(client.deleteProfile).mockRejectedValueOnce(
    new ManageApiError("profile_in_use", ["Phone", ""]),
  );
  await profilesPage(client);
  await page.getByRole("button", { name: "Delete Agent", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "Devices still use this profile: Phone and Unnamed device. Move them to another profile on the Devices page first.",
    );
});

test("renames a profile and creates one copied from another", async () => {
  const client = profilesClient();
  await profilesPage(client);
  await page.getByRole("button", { name: "Rename Agent", exact: true }).click();
  const field = page.getByRole("textbox", { name: "New name for Agent", exact: true });
  await expect.element(field).toHaveValue("Agent");
  await field.fill("Agent browser");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(client.renameProfile).toHaveBeenCalledWith(AGENT, "Agent browser");
  await expect.element(page.getByRole("status")).toHaveTextContent("Renamed to Agent browser");
  await page.getByLabelText("Name", { exact: true }).fill("Grok");
  await page
    .getByRole("combobox", { name: "Copy settings from", exact: true })
    .selectOptions(AGENT);
  await page.getByRole("button", { name: "Create profile", exact: true }).click();
  expect(client.copyProfile).toHaveBeenCalledWith("Grok", AGENT);
  await expect.element(page.getByRole("status")).toHaveTextContent("Grok created");
  await expect
    .element(page.getByRole("button", { name: "Rename Grok", exact: true }))
    .toBeVisible();
});
