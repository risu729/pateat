import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { SitePolicy } from "../../apps/extension/src/options/site-policy";
import { ProfileEditor } from "../../apps/extension/src/options/profile-editor";
import {
  ProfileEditorError,
  type ProfileEditorClient,
} from "../../apps/extension/src/options/service-client";
import type { SettingsClient } from "../../apps/extension/src/options/client";
import { createDefaultSettings, type SyncSettingsState } from "../../packages/contracts/src/index";
import type { LocalSettings, SiteAccountsResponse } from "../../packages/contracts/src/index";

// Synthetic local and remote policy panels share one document, as on the options page.
afterEach(async () => cleanup());

test("composition limit keeps a remote profile draft for a successful retry", async () => {
  const profileId = "00000000-0000-4000-8000-000000000010";
  const origin = "https://service.example";
  const settings = { ...createDefaultSettings(), connections: [] };
  const initial: SyncSettingsState = { version: 1, profileId, revision: 4, settings };
  const service: ProfileEditorClient = {
    list: vi.fn<ProfileEditorClient["list"]>(async () => ({
      version: 1,
      profiles: [{ id: profileId, name: "Other browser" }],
    })),
    read: vi.fn(async () => structuredClone(initial)),
    save: vi
      .fn<ProfileEditorClient["save"]>()
      .mockRejectedValueOnce(new ProfileEditorError("settings-limit"))
      .mockImplementation(async (_origin, _id, revision, draft) => ({
        version: 1,
        profileId,
        revision: revision + 1,
        settings: structuredClone(draft),
      })),
    openSignIn: vi.fn(async () => undefined),
  };
  const local: SettingsClient = {
    getSettings: vi.fn<SettingsClient["getSettings"]>(async () => ({
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 2, settings },
      catalog: { connections: [] },
    })),
    saveSettings: vi.fn(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>(async (url: string) => ({
      version: 1,
      ok: true,
      origin: url,
      accounts: [],
      complete: true,
    })),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ProfileEditor origin={origin} service={service} local={local} />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Load profiles", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Profile to edit", exact: true })
    .selectOptions(profileId);
  await page.getByRole("textbox", { name: "Origin", exact: true }).fill("draft.example");
  await page.getByRole("button", { name: "Pause site", exact: true }).click();
  const save = page.getByRole("button", { name: "Save profile", exact: true });
  await save.click();
  await expect
    .element(page.getByRole("status"))
    .toMatchTextContent("Your changes have not been saved");
  await expect
    .element(page.getByRole("button", { name: "Resume draft.example", exact: true }))
    .toBeVisible();
  expect(service.read).toHaveBeenCalledTimes(1);
  expect(local.saveSettings).not.toHaveBeenCalled();
  await save.click();
  await expect.element(page.getByRole("status")).toMatchTextContent("Profile saved");
  expect(service.save).toHaveBeenLastCalledWith(origin, profileId, 4, {
    ...settings,
    excludedSites: [{ hostname: "draft.example", includeSubdomains: false }],
  });
});

test("local and remote profile site controls have unique IDs and their own descriptions", async () => {
  const draft: LocalSettings = {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    repromptSites: [],
    passkeyBrowserSites: [],
    siteDefaults: [],
    bindings: [],
  };
  const findSiteAccounts = vi.fn(async (origin: string): Promise<SiteAccountsResponse> => ({
    version: 1,
    ok: true,
    origin,
    accounts: [],
    complete: true,
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { draft, catalog: { connections: [] }, edit: vi.fn(() => true), findSiteAccounts };
  await render(
    <QueryClientProvider client={queryClient}>
      <section aria-label="Local policy">
        <SitePolicy {...props} />
      </section>
      <section aria-label="Remote profile policy">
        <SitePolicy {...props} idPrefix="profile-" />
      </section>
    </QueryClientProvider>,
  );
  const local = page.getByRole("region", { name: "Local policy", exact: true });
  const remote = page.getByRole("region", { name: "Remote profile policy", exact: true });
  const localOrigin = local.getByRole("textbox", { name: "Origin", exact: true });
  const remoteOrigin = remote.getByRole("textbox", { name: "Origin", exact: true });
  await expect.element(localOrigin).toHaveAttribute("id", "site-origin");
  await expect.element(remoteOrigin).toHaveAttribute("id", "profile-site-origin");
  await expect
    .element(local.getByRole("combobox", { name: "Default account", exact: true }))
    .toHaveAttribute("aria-describedby", "default-account-note");
  await expect
    .element(remote.getByRole("combobox", { name: "Default account", exact: true }))
    .toHaveAttribute("aria-describedby", "profile-default-account-note");

  await localOrigin.fill("invalid");
  await local.getByRole("button", { name: "Save default", exact: true }).click();
  await expect.element(localOrigin).toHaveAttribute("aria-describedby", "site-error");
  await expect.element(remoteOrigin).not.toHaveAttribute("aria-describedby");
  await remoteOrigin.fill("also invalid");
  await remote.getByRole("button", { name: "Save default", exact: true }).click();
  await expect.element(remoteOrigin).toHaveAttribute("aria-describedby", "profile-site-error");
  expect(local.element().querySelector("#site-error")).not.toBeNull();
  expect(remote.element().querySelector("#profile-site-error")).not.toBeNull();
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(props.edit).not.toHaveBeenCalled();
});
