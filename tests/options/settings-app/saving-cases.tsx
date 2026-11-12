import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { createSettingsClient } from "../../../apps/extension/src/options/client";
import type { SettingsResponse } from "../../../packages/contracts/src/index";
import type { ReloadAndDraftContext, SaveConflictContext } from "./context";

export function registerReloadAndDraft({
  saved,
  mockClient,
  control,
  mount,
  addSite,
  deferred,
}: ReloadAndDraftContext) {
  test("a reload of clean settings that is refused claims no unsaved changes", async () => {
    const client = mockClient();
    await mount(client);
    client.getSettings.mockResolvedValueOnce({
      version: 1,
      ok: false,
      error: { code: "storage-unavailable", message: "Synthetic unreadable settings." },
    });
    await control("reload-settings").click();
    await expect
      .element(control("settings-status"))
      .toMatchTextContent(/^Synthetic unreadable settings\. Reload saved settings to try again\.$/);
  });

  test("a reload of clean settings that fails claims no unsaved changes", async () => {
    const client = mockClient();
    await mount(client);
    client.getSettings.mockRejectedValueOnce(new Error("Synthetic read unavailable"));
    await control("reload-settings").click();
    await expect
      .element(control("settings-status"))
      .toMatchTextContent(
        /^Pateat could not read the saved settings\. Reload saved settings to try again\.$/,
      );
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
    await expect
      .element(control("settings-status"))
      .toMatchTextContent("Synthetic invalid settings");
    expect(client.saveSettings).toHaveBeenCalledTimes(1);
    await addSite("second.example");
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
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
    await expect
      .element(control("settings-status"))
      .toMatchTextContent("These settings are not valid");
    expect(client.saveSettings).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Resume site0.example", exact: true }).click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
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
}

export function registerSaveConflicts({
  saved,
  demoSiteAccounts,
  mockClient,
  control,
  mount,
  addSite,
  deferred,
  conflict,
  written,
}: SaveConflictContext) {
  test("a save conflict after an automatic vault sync saves the edits again on the newer revision (ADR 0025)", async () => {
    const client = mockClient();
    const write = deferred<SettingsResponse>();
    client.saveSettings.mockReturnValueOnce(write.promise);
    await mount(client);
    await addSite("pending.example");
    // An edit made while the conflicting save runs is applied again too.
    await addSite("later.example");
    client.getSettings.mockResolvedValue(
      written(["automatic-vault-sync", "account-choice"], "background.example"),
    );
    write.resolve(conflict("automatic-vault-sync"));
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    expect(client.saveSettings).toHaveBeenCalledTimes(2);
    expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 2,
      settings: {
        excludedSites: [
          { hostname: "background.example" },
          { hostname: "pending.example" },
          { hostname: "later.example" },
        ],
      },
    });
    await expect.element(control("site-list")).toMatchTextContent("background.example");
  });

  test("a save names the vault snapshots its draft was edited against, also after the retry (ADR 0023)", async () => {
    const shown = "11111111-1111-4111-8111-111111111111";
    const synced = "22222222-2222-4222-8222-222222222222";
    const withSnapshot = (
      response: Extract<SettingsResponse, { ok: true }>,
      snapshotId: string,
    ) => {
      response.catalog.connections[0]!.snapshotId = snapshotId;
      return response;
    };
    const client = mockClient();
    client.getSettings.mockResolvedValue(withSnapshot(saved(), shown));
    const write = deferred<SettingsResponse>();
    client.saveSettings.mockReturnValueOnce(write.promise);
    await mount(client);
    await addSite("pending.example");
    expect(client.saveSettings.mock.calls[0]?.[0].shownSnapshots).toEqual([
      { connectionId: "demo-personal", snapshotId: shown },
    ]);
    // An automatic vault sync accepted another snapshot; the retried edits were still made
    // against the one the page showed.
    client.getSettings.mockResolvedValue(withSnapshot(written(["automatic-vault-sync"]), synced));
    write.resolve(conflict("automatic-vault-sync"));
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 1,
      shownSnapshots: [{ connectionId: "demo-personal", snapshotId: shown }],
    });
    // The next draft starts from the catalog that save answered with, which names none.
    await addSite("next.example");
    await vi.waitFor(() => expect(client.saveSettings).toHaveBeenCalledTimes(3));
    expect(client.saveSettings.mock.calls[2]?.[0].shownSnapshots).toEqual([]);
  });

  test("a save that conflicts again after the retry names the cause and keeps the draft", async () => {
    const client = mockClient();
    client.saveSettings
      .mockResolvedValueOnce(conflict("account-choice"))
      .mockResolvedValueOnce(conflict("automatic-vault-sync"));
    await mount(client);
    client.getSettings.mockResolvedValue(written(["account-choice", "account-choice"]));
    await addSite("draft.example");
    await expect
      .element(control("settings-status"))
      .toMatchTextContent(
        "The saved settings changed before this save: a Bitwarden vault was synced automatically. Your unsaved changes are kept.",
      );
    await expect.element(control("site-list")).toMatchTextContent("draft.example");
    expect(client.saveSettings).toHaveBeenCalledTimes(2);
    expect(client.saveSettings.mock.calls[1]?.[0].expectedRevision).toBe(2);
  });

  test("a page that saved before the retry read the newer revision stops the retry", async () => {
    const client = mockClient();
    const write = deferred<SettingsResponse>();
    client.saveSettings.mockReturnValueOnce(write.promise);
    await mount(client);
    await addSite("draft.example");
    // The toolbar popup saves after the conflict was answered.
    client.getSettings.mockResolvedValue(written(["automatic-vault-sync", "settings-save"]));
    write.resolve(conflict("automatic-vault-sync"));
    await expect
      .element(control("settings-status"))
      .toMatchTextContent(
        "The saved settings changed before this save: a Bitwarden vault was synced automatically and settings were saved in another window or the toolbar popup.",
      );
    await expect.element(control("site-list")).toMatchTextContent("draft.example");
    expect(client.saveSettings).toHaveBeenCalledTimes(1);
  });

  test("a save conflict after another page saved names the causes without retrying", async () => {
    const client = mockClient();
    client.saveSettings.mockResolvedValueOnce(conflict("settings-save", "automatic-vault-sync"));
    await mount(client);
    await addSite("draft.example");
    await expect
      .element(control("settings-status"))
      .toMatchTextContent(
        "The saved settings changed before this save: settings were saved in another window or the toolbar popup and a Bitwarden vault was synced automatically. Your unsaved changes are kept.",
      );
    await expect.element(control("site-list")).toMatchTextContent("draft.example");
    expect(client.saveSettings).toHaveBeenCalledTimes(1);
    expect(client.getSettings).toHaveBeenCalledTimes(1);
  });

  test("a save conflict with an unrecorded cause names each cause in one sentence", async () => {
    const client = mockClient();
    client.saveSettings.mockResolvedValueOnce(
      conflict("unknown", "automatic-vault-sync", "service-sync"),
    );
    await mount(client);
    await addSite("draft.example");
    await expect
      .element(control("settings-status"))
      .toMatchTextContent(
        /The saved settings changed before this save: settings changed for a reason no longer recorded, a Bitwarden vault was synced automatically,? and settings were merged with the Pateat sync service\./,
      );
    await expect.element(control("site-list")).toMatchTextContent("draft.example");
    expect(client.saveSettings).toHaveBeenCalledTimes(1);
  });

  test("a default for an account not connected here shows its saved names", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.siteDefaults.push(
      {
        origin: "https://bank.example",
        provider: "dummy",
        server: "cloud-us",
        userId: "another-account",
        itemId: "remote-item",
        itemName: "Remote bank login",
      },
      {
        origin: "https://mail.example",
        provider: "dummy",
        server: "cloud-us",
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
}
