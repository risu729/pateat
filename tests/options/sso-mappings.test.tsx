import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  type LocalSettings,
  type SettingsResponse,
  type SsoMapping,
} from "../../packages/contracts/src/index";

// Synthetic accounts only.
const account = { provider: "bitwarden", server: "cloud-us", userId: "synthetic-user" };
const mapping = (method: number): SsoMapping => ({
  ...account,
  itemId: "a0000000-0000-4000-8000-000000000001",
  method,
  idp: {
    ...account,
    itemId: "a0000000-0000-4000-8000-000000000002",
    origin: "https://idp.example",
  },
});
function accepted(value: LocalSettings, revision: number): Extract<SettingsResponse, { ok: true }> {
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision, settings: structuredClone(value) },
    catalog: { connections: [] },
  };
}
const signIn = () =>
  page
    .getByRole("region", { name: "Page behavior", exact: true })
    .getByRole("group", { name: "Profile defaults", exact: true })
    .getByRole("combobox", { name: "Sign-in pages", exact: true });
afterEach(async () => cleanup());

test("a save that an SSO mapping overtook keeps the mapping the popup saved (ADR 0085)", async () => {
  const before = { ...createDefaultSettings(), connections: [], ssoMappings: [mapping(1)] };
  let answer!: (value: SettingsResponse) => void;
  const local = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(accepted(before, 3)),
    saveSettings: vi
      .fn<SettingsClient["saveSettings"]>()
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
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
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SettingsApp client={local} />
    </QueryClientProvider>,
  );
  await expect.element(signIn()).toHaveValue("auto");
  await signIn().selectOptions("fill");
  // The popup saved another method's mapping while this page saved.
  const background = accepted({ ...before, ssoMappings: [mapping(1), mapping(2)] }, 4);
  background.snapshot.changes = [{ revision: 4, cause: "sso-mapping" }];
  local.getSettings.mockResolvedValue(background);
  answer({
    version: 1,
    ok: false,
    error: { code: "revision-conflict", message: "Synthetic mapping", causes: ["sso-mapping"] },
  });
  await vi.waitFor(() => expect(local.saveSettings).toHaveBeenCalledTimes(2));
  expect(local.saveSettings.mock.calls[1]?.[0]).toMatchObject({
    expectedRevision: 4,
    settings: {
      ssoMappings: [mapping(1), mapping(2)],
      pagePermissionDefaults: { "sign-in": "fill" },
    },
  });
});
