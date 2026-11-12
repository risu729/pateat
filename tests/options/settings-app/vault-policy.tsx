import type { SettingsAppTestContext } from "../settings-app.test";

export function registerVaultPolicy({
  expect,
  test,
  page,
  saved,
  mockClient,
  control,
  mount,
  expand,
}: Pick<
  SettingsAppTestContext,
  "expect" | "test" | "page" | "saved" | "mockClient" | "control" | "mount" | "expand"
>) {
  test("vault-wide lists start collapsed and summarize their selections", async () => {
    const client = mockClient();
    const response = saved();
    const account = { provider: "dummy", server: "cloud-us", userId: "demo-personal-account" };
    response.snapshot.settings.accountPolicies[0]!.selection = {
      mode: "selected",
      groups: [{ id: "everyday", name: "Everyday" }],
    };
    // A field exclusion on an excluded item is not counted again.
    response.snapshot.settings.itemPolicies.push(
      {
        ...account,
        itemId: "primary",
        itemName: "Demo primary account",
        selected: false,
        excluded: false,
        excludedFields: ["branch"],
      },
      {
        ...account,
        itemId: "secondary",
        itemName: "Demo secondary account",
        selected: false,
        excluded: true,
        excludedFields: ["password"],
      },
    );
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
    // An item policy that no longer selects, excludes or names anything is removed.
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings.itemPolicies).toEqual([
      {
        ...account,
        itemId: "secondary",
        itemName: "Demo secondary account",
        selected: false,
        excluded: true,
        excludedFields: ["password"],
      },
    ]);
  });

  test("selection and exclusions are written to the account's and items' synced policies", async () => {
    const client = mockClient();
    await mount(client);
    const account = { provider: "dummy", server: "cloud-us", userId: "demo-personal-account" };
    const items = page.getByLabelText("Demo personal vault: Items for Pateat", { exact: true });
    await items.selectOptions("selected");
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings.accountPolicies).toEqual([
      {
        ...account,
        accountName: "Demo personal vault",
        enabled: true,
        selection: { mode: "selected", groups: [] },
      },
      {
        provider: "dummy",
        server: "cloud-us",
        userId: "demo-work-account",
        accountName: "Demo work vault",
        enabled: true,
        selection: { mode: "all" },
      },
    ]);
    await expand("Demo personal vault", "Included groups and items");
    await page
      .getByLabelText("Demo personal vault: Include group Everyday", { exact: true })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    await page
      .getByLabelText("Demo personal vault: Include item Demo secondary account", { exact: true })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    await expand("Demo personal vault", "Excluded items and fields", "Demo primary account");
    await page
      .getByLabelText("Demo personal vault: Exclude item Demo primary account", { exact: true })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 4).");
    const request = client.saveSettings.mock.calls[3]?.[0].settings;
    expect(request?.accountPolicies[0]).toEqual({
      ...account,
      accountName: "Demo personal vault",
      enabled: true,
      selection: { mode: "selected", groups: [{ id: "everyday", name: "Everyday" }] },
    });
    expect(request?.itemPolicies).toEqual([
      {
        ...account,
        itemId: "secondary",
        itemName: "Demo secondary account",
        selected: true,
        excluded: false,
        excludedFields: [],
      },
      {
        ...account,
        itemId: "primary",
        itemName: "Demo primary account",
        selected: false,
        excluded: true,
        excludedFields: [],
      },
    ]);
    // The device-local connection list is not where account settings live.
    expect(request?.connections).toEqual([]);
  });

  test("excluding a custom field names it by vault name, position and count", async () => {
    const client = mockClient();
    const snapshot = crypto.randomUUID();
    function withCustomFields(revision: number) {
      const response = saved(revision);
      const primary = response.catalog.connections[0]!.items[0]!;
      response.catalog.connections[0]!.snapshotId = snapshot;
      primary.fields.push(
        { id: `custom.${snapshot}.0`, label: "PIN", name: "PIN", kind: "hidden" },
        { id: `custom.${snapshot}.1`, label: "Note", name: null, kind: "text" },
        { id: `custom.${snapshot}.2`, label: "PIN", name: "PIN", kind: "hidden" },
      );
      return response;
    }
    client.getSettings.mockResolvedValue(withCustomFields(0));
    client.saveSettings.mockImplementation(async (request) => ({
      ...withCustomFields(request.expectedRevision + 1),
      snapshot: {
        version: 1,
        revision: request.expectedRevision + 1,
        settings: structuredClone(request.settings),
      },
    }));
    await mount(client);
    await expand("Demo personal vault", "Excluded items and fields", "Demo primary account");
    // The two fields named PIN share a label; the second one in vault order is the third field.
    const pins = page.getByLabelText("Demo personal vault: Exclude PIN from Demo primary account", {
      exact: true,
    });
    await expect.poll(() => pins.elements().length).toBe(2);
    await pins.nth(1).click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    await page
      .getByLabelText("Demo personal vault: Exclude Note from Demo primary account", {
        exact: true,
      })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    await page
      .getByLabelText("Demo personal vault: Exclude Password from Demo primary account", {
        exact: true,
      })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    expect(client.saveSettings.mock.calls[2]?.[0].settings.itemPolicies).toEqual([
      {
        provider: "dummy",
        server: "cloud-us",
        userId: "demo-personal-account",
        itemId: "primary",
        itemName: "Demo primary account",
        selected: false,
        excluded: false,
        // Never the snapshot-scoped field IDs, which change with every vault sync.
        excludedFields: [
          { custom: "PIN", position: 2, count: 2 },
          { custom: null, position: 1, count: 1 },
          "password",
        ],
      },
    ]);
    await expect.element(pins.nth(0)).not.toBeChecked();
    await expect.element(pins.nth(1)).toBeChecked();
    // Clearing the exclusion removes exactly its reference.
    await pins.nth(1).click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 4).");
    expect(client.saveSettings.mock.calls[3]?.[0].settings.itemPolicies[0]?.excludedFields).toEqual(
      [{ custom: null, position: 1, count: 1 }, "password"],
    );
  });
}
