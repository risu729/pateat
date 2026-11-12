import { focusManager } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { SETTINGS_QUERY_KEY } from "../../../apps/extension/src/options/client";
import type { SettingsResponse } from "../../../packages/contracts/src/index";
import type { SettingsChangeContext } from "./context";

export function registerSettingsChanges({
  saved,
  mockClient,
  control,
  mount,
  addSite,
  deferred,
}: SettingsChangeContext) {
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
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    await page.getByLabelText("Demo work vault: Use this vault", { exact: true }).click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings).toHaveBeenCalledTimes(2);
    expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 1,
      settings: { excludedSites: [{ hostname: "draft.example" }] },
    });
    await expect
      .element(page.getByLabelText("Demo work vault: Use this vault", { exact: true }))
      .not.toBeChecked();
    expect(client.saveSettings.mock.calls[1]?.[0].settings.accountPolicies[1]).toEqual({
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-work-account",
      accountName: "Demo work vault",
      enabled: false,
      selection: { mode: "all" },
    });
  });

  test("automatic login in private windows starts off and is saved at once when turned on or off (ADR 0062)", async () => {
    const client = mockClient();
    await mount(client);
    const toggle = page.getByRole("checkbox", { name: "Log in automatically in private windows" });
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(page.getByText(/^Off: every site in a private window is paused/))
      .toBeVisible();
    await expect
      .element(page.getByRole("navigation", { name: "Sections" }).getByText("Private windows"))
      .toBeVisible();
    await toggle.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    expect(client.saveSettings.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 0,
      settings: { loginInPrivateWindows: true },
    });
    await expect.element(toggle).toBeChecked();
    await toggle.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.loginInPrivateWindows).toBeUndefined();
    await expect.element(toggle).not.toBeChecked();
  });

  test("the passkey flags start on and are saved, synced, only while one is off (ADR 0007)", async () => {
    const client = mockClient();
    await mount(client);
    const presence = page.getByRole("checkbox", {
      name: "Answer passkey requests without a click on the page",
    });
    const verification = page.getByRole("checkbox", { name: "Tell sites that you were verified" });
    await expect.element(presence).toBeChecked();
    await expect.element(verification).toBeChecked();
    await expect
      .element(page.getByRole("navigation", { name: "Sections" }).getByText("Passkeys"))
      .toBeVisible();
    await presence.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings.passkeyPolicy).toEqual({
      presence: "activation",
      verification: "always",
    });
    await verification.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.passkeyPolicy).toEqual({
      presence: "activation",
      verification: "never",
    });
    await presence.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    await verification.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 4).");
    // Back at the default, the field is absent again.
    expect(client.saveSettings.mock.calls[3]?.[0].settings.passkeyPolicy).toBeUndefined();
    await expect.element(presence).toBeChecked();
    await expect.element(verification).toBeChecked();
  });

  test("reports to the service start on and each change saves when it was made (ADR 0055)", async () => {
    const client = mockClient();
    await mount(client);
    const toggle = page.getByRole("checkbox", {
      name: "Send login records and problem reports to the service",
    });
    await expect.element(toggle).toBeChecked();
    await expect
      .element(
        page.getByRole("navigation", { name: "Sections" }).getByText("Reports to the service"),
      )
      .toBeVisible();
    const before = Date.now();
    await toggle.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    const off = client.saveSettings.mock.calls[0]?.[0].settings.serviceReports;
    expect(off?.send).toBe(false);
    expect(off?.since).toBeGreaterThanOrEqual(before);
    await expect.element(toggle).not.toBeChecked();
    await toggle.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.serviceReports?.send).toBe(true);
    await expect.element(toggle).toBeChecked();
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
      .toMatch(/^Pateat could not read the saved settings\. Your unsaved changes are kept\./);
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
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings).toHaveBeenCalledTimes(2);
    expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 1 });
  });
}
