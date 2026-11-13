import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import * as v from "valibot";
import {
  createMetadataQueryClient,
  SETTINGS_QUERY_KEY,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { ProfileEditor } from "../../apps/extension/src/options/profile-editor";
import {
  ProfileEditorError,
  type ProfileEditorClient,
} from "../../apps/extension/src/options/service-client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  sitePagePermissionsSchema,
  type LocalSettings,
  type SettingsResponse,
  type SyncSettingsState,
} from "../../packages/contracts/src/index";

const PROFILE = "00000000-0000-4000-8000-000000000010";
const ORIGIN = "https://pateat.example";
function settings(): LocalSettings {
  return { ...createDefaultSettings(), connections: [] };
}
function accepted(value = settings(), revision = 0): Extract<SettingsResponse, { ok: true }> {
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision, settings: structuredClone(value) },
    catalog: { connections: [] },
  };
}
function client() {
  return {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(accepted()),
    saveSettings: vi
      .fn<SettingsClient["saveSettings"]>()
      .mockImplementation(async (request) =>
        accepted(request.settings, request.expectedRevision + 1),
      ),
    findSiteAccounts: vi
      .fn<SettingsClient["findSiteAccounts"]>()
      .mockImplementation(async (origin) => ({
        version: 1,
        ok: true,
        origin,
        accounts: [],
        complete: true,
      })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const behavior = () => page.getByRole("region", { name: "Page behavior", exact: true });
const defaultSignIn = () =>
  behavior()
    .getByRole("group", { name: "Profile defaults", exact: true })
    .getByRole("combobox", { name: "Sign-in pages", exact: true });
async function mountLocal(local = client()) {
  const queryClient = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsApp client={local} />
    </QueryClientProvider>,
  );
  await expect.element(defaultSignIn()).toHaveValue("auto");
  return { local, queryClient };
}
afterEach(async () => cleanup());

test("page policy edits stay in a pending draft and save the later edit at the next revision", async () => {
  const local = client();
  const write = deferred<SettingsResponse>();
  local.saveSettings.mockReturnValueOnce(write.promise);
  const { queryClient } = await mountLocal(local);
  await defaultSignIn().selectOptions("fill");
  await behavior().getByRole("textbox", { name: "Site", exact: true }).fill("bank.example");
  await behavior().getByRole("button", { name: "Add site rule", exact: true }).click();
  expect(local.saveSettings).toHaveBeenCalledOnce();
  expect(local.saveSettings.mock.calls[0]?.[0]).toMatchObject({
    expectedRevision: 0,
    settings: { pagePermissionDefaults: { "sign-in": "fill" } },
  });
  const remote = settings();
  remote.sitePagePermissions = [
    { hostname: "remote.example", includeSubdomains: true, permissions: { "sign-in": "auto" } },
  ];
  queryClient.setQueryData(SETTINGS_QUERY_KEY, accepted(remote, 4));
  await expect.element(defaultSignIn()).toHaveValue("fill");
  await expect
    .element(behavior().getByRole("group", { name: "bank.example", exact: true }))
    .toBeVisible();
  await expect
    .element(behavior().getByRole("group", { name: "remote.example", exact: true }))
    .not.toBeInTheDocument();
  const first = local.saveSettings.mock.calls[0]?.[0].settings;
  expect(first).toBeDefined();
  write.resolve(accepted(first, 1));
  await vi.waitFor(() => expect(local.saveSettings).toHaveBeenCalledTimes(2));
  expect(local.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 1,
    settings: {
      pagePermissionDefaults: { "sign-in": "fill" },
      sitePagePermissions: [
        { hostname: "bank.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
      ],
    },
  });
});

test("a page-policy revision conflict keeps further edits until explicit reload", async () => {
  const local = client();
  local.saveSettings.mockResolvedValueOnce({
    version: 1,
    ok: false,
    error: { code: "revision-conflict", message: "Synthetic conflict", causes: ["settings-save"] },
  });
  await mountLocal(local);
  await defaultSignIn().selectOptions("fill");
  await expect.element(page.getByText(/Your unsaved changes are kept\./)).toBeVisible();
  await behavior()
    .getByRole("group", { name: "Profile defaults", exact: true })
    .getByRole("combobox", { name: "Verification while signed in", exact: true })
    .selectOptions("off");
  await expect.element(defaultSignIn()).toHaveValue("fill");
  expect(local.saveSettings).toHaveBeenCalledOnce();
  local.getSettings.mockResolvedValue(accepted(settings(), 8));
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect.element(defaultSignIn()).toHaveValue("auto");
  await defaultSignIn().selectOptions("fill");
  await vi.waitFor(() => expect(local.saveSettings).toHaveBeenCalledTimes(2));
  expect(local.saveSettings.mock.calls[1]?.[0].expectedRevision).toBe(8);
});

function remoteClient(value: LocalSettings) {
  const state = (settingsValue = value, revision = 5): SyncSettingsState => ({
    version: 1,
    profileId: PROFILE,
    revision,
    settings: structuredClone(settingsValue),
  });
  return {
    list: vi
      .fn<ProfileEditorClient["list"]>()
      .mockResolvedValue({ version: 1, profiles: [{ id: PROFILE, name: "Remote browser" }] }),
    read: vi.fn<ProfileEditorClient["read"]>().mockResolvedValue(state()),
    save: vi
      .fn<ProfileEditorClient["save"]>()
      .mockImplementation(async (_origin, _profile, revision, next) => state(next, revision + 1)),
    openSignIn: vi.fn<ProfileEditorClient["openSignIn"]>(),
  };
}
async function mountRemote(remote: ProfileEditorClient, local = client()) {
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <ProfileEditor origin={ORIGIN} service={remote} local={local} />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Load profiles", exact: true }).click();
  await page.getByRole("combobox", { name: "Profile to edit", exact: true }).selectOptions(PROFILE);
  await expect.element(defaultSignIn()).toBeVisible();
  return local;
}

test("editing another profile reads its policy and saves all its unrelated fields", async () => {
  const initial = settings();
  initial.pagePermissionDefaults = {
    "sign-in": "fill",
    confirm: "off",
    "personal-details": "fill",
  };
  initial.sitePagePermissions = [
    { hostname: "bank.example", includeSubdomains: true, permissions: { confirm: "off" } },
  ];
  initial.excludedSites = [{ hostname: "paused.example", includeSubdomains: false }];
  initial.allowedSitesEnabled = true;
  initial.allowedSites = [{ hostname: "allowed.example", includeSubdomains: true }];
  initial.language = "ja";
  initial.theme = "dark";
  initial.popupPageSection = false;
  const remote = remoteClient(initial);
  const local = await mountRemote(remote);
  expect(remote.read).toHaveBeenCalledExactlyOnceWith(ORIGIN, PROFILE);
  await expect.element(defaultSignIn()).toHaveValue("fill");
  await expect
    .element(behavior().getByRole("group", { name: "bank.example", exact: true }))
    .toBeVisible();
  await defaultSignIn().selectOptions("auto");
  expect(remote.save).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect
    .element(
      page.getByText("Profile saved. Devices use it after their next settings sync.", {
        exact: true,
      }),
    )
    .toBeVisible();
  expect(remote.save).toHaveBeenCalledExactlyOnceWith(ORIGIN, PROFILE, 5, {
    ...initial,
    pagePermissionDefaults: { ...initial.pagePermissionDefaults, "sign-in": "auto" },
    connections: [],
  });
  expect(local.saveSettings).not.toHaveBeenCalled();
  await behavior()
    .getByRole("group", { name: "bank.example", exact: true })
    .getByRole("combobox", { name: "Verification while signed in", exact: true })
    .selectOptions("fill");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await vi.waitFor(() => expect(remote.save).toHaveBeenCalledTimes(2));
  expect(remote.save.mock.calls[1]?.[2]).toBe(6);
});

test("remote profile conflict keeps the displayed policy draft for explicit reload", async () => {
  const remote = remoteClient(settings());
  remote.save.mockRejectedValueOnce(new ProfileEditorError("conflict"));
  await mountRemote(remote);
  await defaultSignIn().selectOptions("fill");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect
    .element(
      page.getByText("Settings changed elsewhere. Reload this profile before saving again.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect.element(defaultSignIn()).toHaveValue("fill");
  expect(remote.save).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Reload profile", exact: true }).click();
  await expect.element(defaultSignIn()).toHaveValue("auto");
});

test("a background-only conflict reapplies both page policy fields before saving", async () => {
  const local = client();
  const write = deferred<SettingsResponse>();
  local.saveSettings.mockReturnValueOnce(write.promise);
  await mountLocal(local);
  await defaultSignIn().selectOptions("fill");
  await behavior().getByRole("textbox", { name: "Site", exact: true }).fill("bank.example");
  await behavior().getByRole("button", { name: "Add site rule", exact: true }).click();
  const background = accepted(settings(), 1);
  background.snapshot.changes = [{ revision: 1, cause: "automatic-vault-sync" }];
  local.getSettings.mockResolvedValue(background);
  write.resolve({
    version: 1,
    ok: false,
    error: {
      code: "revision-conflict",
      message: "Synthetic background update",
      causes: ["automatic-vault-sync"],
    },
  });
  await vi.waitFor(() => expect(local.saveSettings).toHaveBeenCalledTimes(2));
  expect(local.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 1,
    settings: {
      pagePermissionDefaults: { "sign-in": "fill", confirm: "fill", "personal-details": "fill" },
      sitePagePermissions: [
        { hostname: "bank.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
      ],
    },
  });
  await expect.element(defaultSignIn()).toHaveValue("fill");
  await expect
    .element(behavior().getByRole("group", { name: "bank.example", exact: true }))
    .toBeVisible();
});

test("an added rule replaces a rule that sync saved for the same host meanwhile", async () => {
  const local = client();
  const write = deferred<SettingsResponse>();
  local.saveSettings.mockReturnValueOnce(write.promise);
  await mountLocal(local);
  await behavior().getByRole("textbox", { name: "Site", exact: true }).fill("bank.example");
  await behavior().getByRole("button", { name: "Add site rule", exact: true }).click();
  const synced = settings();
  synced.sitePagePermissions = [
    { hostname: "bank.example", includeSubdomains: true, permissions: { confirm: "off" } },
    { hostname: "other.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
  ];
  const background = accepted(synced, 1);
  background.snapshot.changes = [{ revision: 1, cause: "service-sync" }];
  local.getSettings.mockResolvedValue(background);
  write.resolve({
    version: 1,
    ok: false,
    error: {
      code: "revision-conflict",
      message: "Synthetic sync update",
      causes: ["service-sync"],
    },
  });
  await vi.waitFor(() => expect(local.saveSettings).toHaveBeenCalledTimes(2));
  const rebased = local.saveSettings.mock.calls[1]?.[0];
  expect(rebased?.expectedRevision).toBe(1);
  expect(rebased?.settings.sitePagePermissions).toEqual([
    { hostname: "other.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
    { hostname: "bank.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
  ]);
  expect(v.is(sitePagePermissionsSchema, rebased?.settings.sitePagePermissions)).toBe(true);
});
