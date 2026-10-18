import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { SyncSettingsState } from "../../packages/contracts/src/index";
import type { ManageClient } from "../../services/api/web/api";
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

afterEach(async () => cleanup());

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
    assignProfile: vi.fn(),
    devices: vi.fn(),
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
  const selector = page.getByRole("combobox", { name: "Editing profile" });
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
});
