import type { SettingsAppTestContext } from "../settings-app.test";
import type { SettingsResponse } from "../../../packages/contracts/src/index";

export function registerSitePolicy({
  expect,
  test,
  vi,
  page,
  userEvent,
  SITE_ACCOUNTS_DELAY_MS,
  saved,
  demoSiteAccounts,
  mockClient,
  control,
  mount,
  addSite,
  deferred,
}: Pick<
  SettingsAppTestContext,
  | "expect"
  | "test"
  | "vi"
  | "page"
  | "userEvent"
  | "SITE_ACCOUNTS_DELAY_MS"
  | "saved"
  | "demoSiteAccounts"
  | "mockClient"
  | "control"
  | "mount"
  | "addSite"
  | "deferred"
>) {
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
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings).toHaveBeenCalledTimes(2);
    expect(client.saveSettings.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 1,
      settings: {
        excludedSites: [{ hostname: "pending.example" }, { hostname: "later.example" }],
      },
    });
    await expect.element(control("site-list")).toMatchTextContent("later.example");
    await expect.element(control("reload-settings")).toBeEnabled();

    const read = deferred<SettingsResponse>();
    client.getSettings.mockReturnValue(read.promise);
    await control("reload-settings").click();
    await expect.element(control("reload-settings")).toBeDisabled();
    await expect.element(control("site-origin")).toBeDisabled();
    expect(client.saveSettings).toHaveBeenCalledTimes(2);
    expect(client.getSettings).toHaveBeenCalledTimes(2);
    read.resolve(saved(3, "reloaded.example"));
    await expect.element(control("site-list")).toMatchTextContent("reloaded.example");
    await addSite("next-draft.example");
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 4).");
  });

  test("the add form validates locally and keeps focus on the origin after adds and removals", async () => {
    // The search for an entered origin's matches waits until typing pauses; advance that
    // pause on a fake clock that otherwise follows real time, since the query cache
    // delivers its results on zero-delay timeouts.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const client = mockClient();
    await mount(client);
    await control("site-origin").fill("https://invalid.example/path");
    await control("add-site").click();
    await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "true");
    await expect.element(control("site-origin")).toHaveFocus();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(client.saveSettings).not.toHaveBeenCalled();

    await control("site-origin").fill("keyboard.example");
    await control("add-site").click();
    await expect.element(control("site-list")).toMatchTextContent("keyboard.example");
    await expect.element(control("site-origin")).toHaveValue("");
    await expect.element(control("site-origin")).toHaveFocus();
    await page.getByRole("button", { name: "Resume keyboard.example", exact: true }).click();
    await expect.element(control("site-origin")).toHaveFocus();
    await expect.element(control("site-list")).not.toMatchTextContent("keyboard.example");

    // Only items matching the entered origin are offered.
    await expect.element(control("default-account")).toBeDisabled();
    await control("site-origin").fill("https://mail.example");
    await vi.advanceTimersByTimeAsync(SITE_ACCOUNTS_DELAY_MS);
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("1 item matches this origin.");
    await expect
      .poll(() =>
        [...(control("default-account").element() as HTMLSelectElement).options].map(
          (option) => option.value,
        ),
      )
      .toEqual([JSON.stringify(["demo-personal", "secondary"])]);
    await control("site-origin").fill("https://none.example");
    await vi.advanceTimersByTimeAsync(SITE_ACCOUNTS_DELAY_MS);
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("No vault item matches");
    await expect.element(control("default-account")).toBeDisabled();
    // A rule on a longer path does not match the origin, so every item can still be listed.
    await control("default-account-all").click();
    await expect.element(control("default-account")).toBeEnabled();
    await expect.element(control("default-account")).toMatchTextContent("no match for this origin");
    await control("default-account-all").click();
    await control("site-origin").fill("https://bank.example");
    await vi.advanceTimersByTimeAsync(SITE_ACCOUNTS_DELAY_MS);
    await control("default-account").selectOptions(JSON.stringify(["demo-personal", "primary"]));
    await control("site-origin").fill("https://bank.example/path");
    await control("site-origin").click();
    await userEvent.keyboard("{Enter}");
    await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "true");
    await expect.element(control("site-origin")).toHaveFocus();
    await control("site-origin").fill("https://bank.example");
    await userEvent.keyboard("{Enter}");
    await expect.element(control("site-list")).toMatchTextContent("https://bank.example");
    // The default names the account, and is shown through this device's connection.
    await expect
      .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
      .toHaveDisplayValue("Demo primary account in Demo personal vault");
    await expect.element(control("site-origin")).toHaveFocus();
    // Each add and removal was saved without moving focus.
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    await expect.element(control("site-origin")).toHaveFocus();
    expect(client.saveSettings).toHaveBeenCalledTimes(3);
    // The saved default keeps the connection's label and the item's name for display.
    expect(client.saveSettings.mock.calls[2]?.[0].settings.siteDefaults).toEqual([
      {
        origin: "https://bank.example",
        provider: "dummy",
        server: "cloud-us",
        userId: "demo-personal-account",
        itemId: "primary",
        itemName: "Demo primary account",
        accountName: "Demo personal vault",
      },
    ]);
  });

  test("an account that cannot be saved marks the account select, not the origin", async () => {
    const client = mockClient();
    // The same account connected twice cannot be told apart.
    const response = saved();
    response.catalog.connections[1]!.userId = "demo-personal-account";
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    // With no matching item the select is disabled, so focus stays on the valid origin.
    await control("site-origin").fill("https://none.example");
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("No vault item matches");
    await control("add-default").click();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent("Choose an available default account.");
    await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "false");
    await expect.element(control("site-origin")).not.toHaveAttribute("aria-describedby");
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(control("default-account"))
      .toHaveAccessibleDescription(/Choose an available default account\./);
    await expect.element(control("site-origin")).toHaveFocus();
    // Listing every item enables the select, so its stale error goes.
    await control("default-account-all").click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "false");
    await control("default-account-all").click();

    // An enabled select that names an ambiguous account takes focus.
    await control("site-origin").fill("https://mail.example");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "false");
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("1 item matches this origin.");
    await control("add-default").click();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent(
        "This vault account is connected more than once, or its user ID has settings for another server.",
      );
    await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "false");
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "true");
    await expect.element(control("default-account")).toHaveFocus();
    // Choosing another account clears the error.
    await control("default-account-all").click();
    await control("default-account").selectOptions(JSON.stringify(["demo-personal", "primary"]));
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "false");
    expect(client.saveSettings).not.toHaveBeenCalled();
  });

  test("saving while accounts load marks the account select until they are listed", async () => {
    const client = mockClient();
    const listed = deferred<Awaited<ReturnType<typeof demoSiteAccounts>>>();
    client.findSiteAccounts.mockReturnValue(listed.promise);
    await mount(client);
    await control("site-origin").fill("https://bank.example");
    await control("add-default").click();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent("Wait until the matching accounts are listed.");
    await expect.element(control("site-origin")).toHaveAttribute("aria-invalid", "false");
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(control("default-account"))
      .toHaveAccessibleDescription(/Wait until the matching accounts are listed\./);
    listed.resolve(await demoSiteAccounts("https://bank.example"));
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("3 items match this origin.");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(control("default-account")).toHaveAttribute("aria-invalid", "false");
    expect(client.saveSettings).not.toHaveBeenCalled();
  });

  test("after a default is saved the next origin starts from its best match", async () => {
    const client = mockClient();
    await mount(client);
    await control("site-origin").fill("https://bank.example");
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("3 items match this origin.");
    await control("default-account").selectOptions(JSON.stringify(["demo-work", "primary"]));
    await control("add-default").click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    // The work account is offered for mail.example too, but does not match it.
    await control("default-account-all").click();
    await control("site-origin").fill("https://mail.example");
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("1 item matches this origin.");
    await expect
      .element(control("default-account"))
      .toHaveValue(JSON.stringify(["demo-personal", "secondary"]));
  });

  test("an origin in another spelling is saved in its canonical form", async () => {
    const client = mockClient();
    await mount(client);
    for (const spelling of [
      "https://bank.example/",
      "https://bank.example/path",
      "https://bank.example?query",
      "https://bank.example#hash",
      "https://user@bank.example",
      "https://bank_example",
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await control("site-origin").fill(spelling);
      // oxlint-disable-next-line no-await-in-loop
      await control("add-default").click();
      // oxlint-disable-next-line no-await-in-loop
      await expect
        .element(page.getByRole("alert"))
        .toMatchTextContent(
          "Enter an origin such as https://bank.example, without a path or trailing slash.",
        );
    }
    // A Unicode hostname is searched and saved as punycode.
    await control("site-origin").fill("https://bücher.example");
    await expect
      .element(control("default-account-note"))
      .toMatchTextContent("No vault item matches");
    expect(client.findSiteAccounts).toHaveBeenLastCalledWith(
      "https://xn--bcher-kva.example",
      expect.anything(),
    );
    for (const [revision, spelling] of [
      "HTTPS://Bank.Example",
      "https://bank.example:443",
    ].entries()) {
      // oxlint-disable-next-line no-await-in-loop
      await control("site-origin").fill(spelling);
      // oxlint-disable-next-line no-await-in-loop
      await expect
        .element(control("default-account-note"))
        .toMatchTextContent("3 items match this origin.");
      // oxlint-disable-next-line no-await-in-loop
      await control("add-default").click();
      // oxlint-disable-next-line no-await-in-loop
      await expect
        .element(control("settings-status"))
        .toMatchTextContent(`saved (revision ${revision + 1}).`);
      expect(client.findSiteAccounts).toHaveBeenLastCalledWith(
        "https://bank.example",
        expect.anything(),
      );
      expect(client.saveSettings.mock.calls[revision]?.[0].settings.siteDefaults).toEqual([
        expect.objectContaining({ origin: "https://bank.example", itemId: "primary" }),
      ]);
    }
  });

  test("an origin row changes its default only on Save, and No default removes it", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "secondary",
      itemName: "Demo secondary account",
      accountName: "Demo personal vault",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    const select = page.getByRole("combobox", {
      name: "Default account for https://bank.example",
      exact: true,
    });
    const save = page.getByRole("button", { name: "Save default for https://bank.example" });
    // Every account that matches the origin is offered, with the saved one chosen.
    await expect
      .poll(() =>
        [...(select.element() as HTMLSelectElement).options].map((option) => option.textContent),
      )
      .toEqual([
        "Demo primary account in Demo personal vault",
        "Demo secondary account in Demo personal vault",
        "Demo team account in Demo work vault",
        "No default",
      ]);
    await expect.element(select).toHaveValue(JSON.stringify(["demo-personal", "secondary"]));
    await expect.element(save).toBeDisabled();
    await select.selectOptions(JSON.stringify(["demo-work", "primary"]));
    expect(client.saveSettings).not.toHaveBeenCalled();
    await expect.element(save).toBeEnabled();
    await save.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings.siteDefaults).toEqual([
      {
        origin: "https://bank.example",
        provider: "dummy",
        server: "cloud-us",
        userId: "demo-work-account",
        itemId: "primary",
        itemName: "Demo team account",
        accountName: "Demo work vault",
      },
    ]);
    await expect.element(save).toBeDisabled();
    await select.selectOptions("No default");
    await save.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.siteDefaults).toEqual([]);
    await expect.element(select).not.toBeInTheDocument();
    // The row is gone, so focus moves to the add form.
    await expect.element(control("site-origin")).toHaveFocus();
  });

  test("pausing an origin keeps its default unused by itself under the rule until it is resumed", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.siteDefaults.push({
      origin: "https://www.bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    await page
      .getByRole("button", {
        name: "Pause automatic login on bank.example and its subdomains, which includes https://www.bank.example",
      })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    // As the popup pauses it: the registrable site with its subdomains (ADR 0062).
    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({
      excludedSites: [{ hostname: "bank.example", includeSubdomains: true }],
      siteDefaults: [{ origin: "https://www.bank.example" }],
    });
    await expect
      .element(page.getByRole("combobox", { name: "Default account for https://www.bank.example" }))
      .not.toBeInTheDocument();
    await expect
      .element(control("site-list"))
      .toMatchTextContent(
        "The default for https://www.bank.example is kept; while the site is paused it is only listed first in the popup.",
      );
    await page
      .getByRole("button", { name: "Resume bank.example and subdomains", exact: true })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    await expect
      .element(page.getByRole("combobox", { name: "Default account for https://www.bank.example" }))
      .toBeVisible();
  });

  test("a default kept under a rule is listed once and can be removed", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.excludedSites.push(
      { hostname: "example", includeSubdomains: true },
      { hostname: "bank.example", includeSubdomains: false },
    );
    response.snapshot.settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    const remove = page.getByRole("button", { name: "Remove default for https://bank.example" });
    // Both rules exclude the origin; it is listed under the more specific one only.
    await expect.element(remove).toBeVisible();
    expect(
      control("site-list")
        .element()
        .textContent?.match(/The default for https:\/\/bank\.example is kept/g),
    ).toHaveLength(1);
    await remove.click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings).toHaveBeenCalledTimes(1);
    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({
      excludedSites: [
        { hostname: "example", includeSubdomains: true },
        { hostname: "bank.example", includeSubdomains: false },
      ],
      siteDefaults: [],
    });
    await expect.element(remove).not.toBeInTheDocument();
    await expect.element(control("site-origin")).toHaveFocus();
  });

  test("a site whose passkey requests go to the browser can only be removed", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.passkeyBrowserSites.push(
      { hostname: "shop.example" },
      { hostname: "bank.example" },
    );
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    const list = control("passkey-browser-sites");
    // Listed by hostname, each with only a Remove button; nothing on the page adds one.
    await expect.element(list.getByRole("listitem").nth(0)).toHaveTextContent("bank.exampleRemove");
    await expect.element(list.getByRole("listitem").nth(1)).toHaveTextContent("shop.exampleRemove");
    expect(list.getByRole("button").elements()).toHaveLength(2);
    const region = page.getByRole("region", {
      name: "Sites whose passkey requests go to the browser",
    });
    expect(region.getByRole("textbox").elements()).toHaveLength(0);
    await page.getByRole("button", { name: "Remove bank.example from this list" }).click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings).toHaveBeenCalledTimes(1);
    expect(client.saveSettings.mock.calls[0]?.[0].settings).toMatchObject({
      passkeyBrowserSites: [{ hostname: "shop.example" }],
    });
    await expect.element(list).not.toHaveTextContent("bank.example");
    await expect
      .element(
        page.getByRole("heading", { name: "Sites whose passkey requests go to the browser" }),
      )
      .toHaveFocus();
    await page.getByRole("button", { name: "Remove shop.example from this list" }).click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 3).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings).toMatchObject({
      passkeyBrowserSites: [],
    });
    await expect.element(region.getByText("No sites listed")).toBeVisible();
  });

  test("an origin with a trailing dot is excluded by its hostname without the dot", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.siteDefaults.push({
      origin: "https://bank.example.",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    await page
      .getByRole("button", {
        name: "Pause automatic login on bank.example and its subdomains, which includes https://bank.example.",
      })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings.excludedSites).toEqual([
      { hostname: "bank.example", includeSubdomains: true },
    ]);
    await expect
      .element(control("site-list"))
      .toMatchTextContent(
        "The default for https://bank.example. is kept; while the site is paused it is only listed first in the popup.",
      );
    await expect
      .element(page.getByRole("button", { name: "Remove default for https://bank.example." }))
      .toBeVisible();
  });

  test("pausing replaces the site's own rule as the popup does and keeps other sites' rules", async () => {
    const client = mockClient();
    const response = saved(1);
    // Each name under the private suffix github.io is its own site (ADR 0062).
    response.snapshot.settings.excludedSites.push(
      { hostname: "alice.github.io", includeSubdomains: false },
      { hostname: "bob.github.io", includeSubdomains: true },
    );
    response.snapshot.settings.siteDefaults.push({
      origin: "https://auth.alice.github.io",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    await page
      .getByRole("button", {
        name: "Pause automatic login on alice.github.io and its subdomains, which includes https://auth.alice.github.io",
      })
      .click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[0]?.[0].settings.excludedSites).toEqual([
      { hostname: "bob.github.io", includeSubdomains: true },
      { hostname: "alice.github.io", includeSubdomains: true },
    ]);
  });

  test("the add form makes the entered site ask for the master password, then stops", async () => {
    const client = mockClient();
    await mount(client);
    await control("site-origin").fill("https://bank.example");
    await control("site-subdomains").click();
    await control("add-reprompt-site").click();
    await expect
      .element(control("settings-status"))
      .toMatchTextContent("Settings saved (revision 1).");
    const settings = client.saveSettings.mock.calls[0]?.[0].settings;
    expect(settings?.repromptSites).toEqual([
      { hostname: "bank.example", includeSubdomains: true },
    ]);
    expect(settings?.excludedSites).toEqual([]);
    await expect.element(control("site-list")).toMatchTextContent("Asks for the master password");
    await expect.element(control("site-origin")).toHaveValue("");
    await expect.element(control("site-origin")).toHaveFocus();
    await page
      .getByRole("button", {
        name: "Stop asking for the master password on bank.example and subdomains",
        exact: true,
      })
      .click();
    await expect
      .element(control("settings-status"))
      .toMatchTextContent("Settings saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.repromptSites).toEqual([]);
    await expect.element(control("site-origin")).toHaveFocus();
  });

  test("the add form pauses the entered origin's host, with its subdomains when asked", async () => {
    const client = mockClient();
    await mount(client);
    await expect
      .element(page.getByText("No paused sites or default accounts", { exact: true }))
      .toBeVisible();
    await control("site-origin").fill("http://localhost:8080");
    await control("add-site").click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 1).");
    await control("site-origin").fill("bank.example");
    await control("site-subdomains").click();
    await control("add-site").click();
    await expect.element(control("settings-status")).toMatchTextContent("saved (revision 2).");
    expect(client.saveSettings.mock.calls[1]?.[0].settings.excludedSites).toEqual([
      { hostname: "localhost", includeSubdomains: false },
      { hostname: "bank.example", includeSubdomains: true },
    ]);
    // Rules and origins share one list, by hostname.
    await expect
      .poll(() =>
        [...control("site-list").element().querySelectorAll(":scope > li")].map(
          (row) => row.querySelector("span > span")?.textContent,
        ),
      )
      .toEqual(["bank.example and subdomains", "localhost"]);
    await expect
      .element(page.getByText("No paused sites or default accounts", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Resume bank.example and subdomains", exact: true }),
      )
      .toBeVisible();
    await expect.element(control("site-subdomains")).not.toBeChecked();
  });

  test("an origin row names why its default cannot be used", async () => {
    const client = mockClient();
    const response = saved(1);
    response.snapshot.settings.accountPolicies[1]!.selection = { mode: "selected", groups: [] };
    response.snapshot.settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    });
    client.getSettings.mockResolvedValue(response);
    await mount(client);
    await expect
      .element(control("site-list"))
      .toMatchTextContent("This account is outside the selected groups and items.");
    await expect
      .element(page.getByRole("combobox", { name: "Default account for https://bank.example" }))
      .toHaveDisplayValue("Demo team account in Demo work vault (unavailable)");
  });
}
