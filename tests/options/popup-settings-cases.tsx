import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup } from "vitest-browser-react";
import { popupOrigin } from "../../apps/extension/src/popup/site-app";
import { createDefaultSettings } from "../../packages/contracts/src/index";
import type { PopupTestContext } from "./popup.test";

export function registerPopupOpeningCases({
  saved,
  demoSiteAccounts,
  store,
  noChoice,
  mount,
}: Pick<PopupTestContext, "saved" | "demoSiteAccounts" | "store" | "noChoice" | "mount">) {
  test("only HTTP(S) pages with a valid hostname are a site the popup edits", () => {
    expect(popupOrigin("https://bank.example/login?next=1")).toBe("https://bank.example");
    expect(popupOrigin("https://bank.example:8443/")).toBe("https://bank.example:8443");
    expect(popupOrigin("http://bank.example/")).toBe("http://bank.example");
    expect(popupOrigin("chrome://extensions/")).toBeUndefined();
    expect(popupOrigin(undefined)).toBeUndefined();
  });

  test("a tab Pateat cannot run on offers only the settings page", async () => {
    const { client } = store();
    const host = await mount(client, "chrome://newtab/");
    await expect
      .element(page.getByText("Pateat works on websites", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Use as default" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Open settings" }));
    expect(host.openSettings).toHaveBeenCalledOnce();
    expect(client.saveSettings).not.toHaveBeenCalled();
  });

  test("the site default is chosen from the items that match the tab's origin, then removed", async () => {
    const { client, current } = store();
    const choices = noChoice();
    await mount(client, "https://bank.example/login", choices);
    await expect.element(page.getByRole("heading", { name: "bank.example" })).toBeVisible();
    const accounts = page.getByRole("group", { name: "Default account" }).getByRole("radio");
    await expect.element(accounts).toHaveLength(3);
    // No account is the default yet: none carries the badge or is selected, and nothing
    // can be saved before one is picked.
    expect(page.getByText("Default", { exact: true }).query()).toBeNull();
    for (const radio of accounts.elements())
      expect((radio as HTMLInputElement).checked).toBe(false);
    await expect
      .element(
        page.getByText(
          "No default account. With exactly one matching item, Pateat uses that item.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();
    await expect
      .element(
        page.getByText("Choosing a default logs in with it on this page when it shows a sign-in."),
      )
      .toBeVisible();
    expect(client.findSiteAccounts).toHaveBeenCalledWith(
      "https://bank.example",
      current().snapshot.settings,
    );
    const team = page.getByRole("radio", { name: "Demo team account, Demo work vault" });
    await userEvent.click(page.getByText("Demo work vault"));
    await expect.element(team).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Use as default" }));
    await expect
      .element(page.getByRole("radio", { name: "Demo team account, Demo work vault, default" }))
      .toBeChecked();
    await expect
      .element(page.getByText("Demo team account is now the default for this site."))
      .toBeVisible();
    expect(page.getByText("No default account.", { exact: false }).query()).toBeNull();
    expect(client.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "settings.save", expectedRevision: 0 }),
    );
    expect(current().snapshot.settings.siteDefaults).toEqual([
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
    // Only the site default changed.
    expect({ ...current().snapshot.settings, siteDefaults: [] }).toEqual(createDefaultSettings());
    // The tab's page logs in with it now (ADR 0021, amended 2026-11-04).
    await expect.poll(() => choices.defaultChosen).toHaveBeenCalledExactlyOnceWith(7);
    await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();

    await userEvent.click(page.getByRole("button", { name: "Remove default" }));
    await expect
      .element(page.getByText("The default account for this site was removed."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Remove default" }))
      .not.toBeInTheDocument();
    expect(current().snapshot).toMatchObject({ revision: 2, settings: createDefaultSettings() });
    // Removing the default starts no login.
    expect(choices.defaultChosen).toHaveBeenCalledOnce();
  });

  test("setting and removing the default keeps the listed accounts", async () => {
    const { client } = store();
    // A second search would never answer, so a list that searches again would disappear.
    client.findSiteAccounts
      .mockImplementationOnce(async (origin) => {
        const found = await demoSiteAccounts(origin);
        return {
          ...found,
          accounts: found.accounts.map((account) => ({
            ...account,
            username: `${account.itemId}@bank.example`,
          })),
        };
      })
      .mockImplementation(() => new Promise(() => {}));
    await mount(client, "https://bank.example/login");
    const accounts = page.getByRole("group", { name: "Default account" }).getByRole("radio");
    await expect.element(accounts).toHaveLength(3);
    await userEvent.click(page.getByText("Demo team account in Demo work vault"));
    await userEvent.click(page.getByRole("button", { name: "Use as default" }));
    await expect
      .element(page.getByText("primary@bank.example is now the default for this site."))
      .toBeVisible();
    await expect.element(accounts).toHaveLength(3);
    // The new default stays a row of the list, named by its username, not a card with the
    // item's saved labels.
    await expect
      .element(
        page.getByRole("radio", {
          name: "primary@bank.example, Demo team account in Demo work vault, default",
        }),
      )
      .toBeChecked();
    expect(document.querySelector("#popup-default")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Remove default" }));
    await expect
      .element(page.getByText("The default account for this site was removed."))
      .toBeVisible();
    await expect.element(accounts).toHaveLength(3);
    expect(page.getByText("Finding the vault items", { exact: false }).query()).toBeNull();
    expect(client.findSiteAccounts).toHaveBeenCalledOnce();
  });

  test("a default saved while the popup is open shows without reopening it", async () => {
    const { client, current, replace } = store();
    const host = await mount(client, "https://bank.example/login");
    const accounts = page.getByRole("group", { name: "Default account" }).getByRole("radio");
    await expect.element(accounts).toHaveLength(3);
    await expect.element(page.getByText("No default account.", { exact: false })).toBeVisible();
    // A login picked with "Make it the default" saves its account once it succeeds.
    const settings = structuredClone(current().snapshot.settings);
    settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    });
    replace(saved(1, settings));
    host.settingsChanged();
    await expect
      .element(page.getByRole("radio", { name: "Demo team account, Demo work vault, default" }))
      .toBeChecked();
    expect(page.getByText("No default account.", { exact: false }).query()).toBeNull();
    await expect.element(accounts).toHaveLength(3);
    expect(client.findSiteAccounts).toHaveBeenCalledOnce();
    cleanup();
    expect(host.unwatched).toHaveBeenCalledOnce();
  });
}

export function registerPopupPolicyCases({
  saved,
  store,
  noChoice,
  mount,
  pageOf,
}: Pick<PopupTestContext, "saved" | "store" | "noChoice" | "mount" | "pageOf">) {
  test("Until turned back on pauses the whole site with a rule, and Resume removes it (ADR 0062)", async () => {
    const { client, current } = store();
    const choices = pageOf("https://login.bank.example");
    await mount(client, "https://login.bank.example/", choices);
    const row = page.getByRole("group", { name: "Pause automatic login" });
    await userEvent.click(row.getByRole("button", { name: "Until turned back on" }));
    await expect
      .element(page.getByText("Automatic login on this site is paused until turned back on."))
      .toBeVisible();
    // One rule for the registrable site and its subdomains, as the pause covers the site.
    expect(current().snapshot.settings.excludedSites).toEqual([
      { hostname: "bank.example", includeSubdomains: true },
    ]);
    expect(choices.pause).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("Paused until turned back on", { exact: true }))
      .toBeVisible();
    // A paused site still lists its accounts: a pick logs in.
    await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    await expect.element(page.getByText("Automatic login on this site resumed.")).toBeVisible();
    expect(current().snapshot.settings.excludedSites).toEqual([]);
    // No pause of a length ran, so the worker is not asked to end one.
    expect(choices.pause).not.toHaveBeenCalled();
    await expect.element(row).toBeVisible();
  });

  test("Resume removes the site's own covering rules and ends a pause of a length too", async () => {
    const settings = createDefaultSettings();
    settings.excludedSites.push(
      { hostname: "bank.example", includeSubdomains: true },
      { hostname: "login.bank.example", includeSubdomains: false },
      { hostname: "mail.bank.example", includeSubdomains: false },
    );
    const { client, current } = store(saved(3, settings));
    const choices = pageOf("https://login.bank.example", { pause: { until: Date.now() + 60_000 } });
    await mount(client, "https://login.bank.example/", choices);
    // A rule wins over the pause of a length: it has no end.
    await expect
      .element(page.getByText("Paused until turned back on", { exact: true }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    await expect.poll(() => choices.pause.mock.calls.length).toBe(1);
    expect(choices.pause).toHaveBeenCalledWith(7, { paused: false });
    // A rule for another host of the site that does not cover this one stays.
    expect(current().snapshot.settings.excludedSites).toEqual([
      { hostname: "mail.bank.example", includeSubdomains: false },
    ]);
  });

  test("a rule for other sites too is shown but changed only in settings", async () => {
    const settings = createDefaultSettings();
    settings.excludedSites.push(
      { hostname: "example", includeSubdomains: true },
      { hostname: "login.bank.example", includeSubdomains: false },
      { hostname: "mail.example", includeSubdomains: false },
    );
    const { client } = store(saved(4, settings));
    const host = await mount(client, "https://login.bank.example/");
    await expect
      .element(page.getByText("Paused until turned back on", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Paused by a rule that also covers other sites."))
      .toBeVisible();
    await expect.element(page.getByText("example", { exact: true })).toBeVisible();
    await expect.element(page.getByText("and its subdomains")).toBeVisible();
    await expect.element(page.getByText("mail.example", { exact: false })).not.toBeInTheDocument();
    // Resume would leave the site paused by the shared rule, so none is offered.
    await expect.element(page.getByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("link", { name: "Change in settings for example" }));
    expect(host.openSettings).toHaveBeenCalledOnce();
    expect(client.saveSettings).not.toHaveBeenCalled();
    // A paused site still lists its matching accounts.
    await expect.poll(() => client.findSiteAccounts.mock.calls.length).toBeGreaterThan(0);
  });

  test("the master password switch asks on the site by its exact hostname, and stops", async () => {
    const { client, current } = store();
    await mount(client, "https://login.bank.example/");
    const toggle = page.getByRole("switch", { name: "Ask for the master password" });
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(toggle)
      .toHaveAccessibleDescription("For vault items with Bitwarden's master password re-prompt.");
    await userEvent.click(toggle);
    await expect
      .element(page.getByText("login.bank.example now asks for the master password."))
      .toBeVisible();
    await expect.element(toggle).toBeChecked();
    expect(current().snapshot.settings.repromptSites).toEqual([
      { hostname: "login.bank.example", includeSubdomains: false },
    ]);
    await userEvent.click(toggle);
    await expect
      .element(page.getByText("login.bank.example no longer asks for the master password."))
      .toBeVisible();
    expect(current().snapshot.settings.repromptSites).toEqual([]);
  });

  test("a paused site keeps its master password switch, as a pick still logs in there (ADR 0062)", async () => {
    const settings = createDefaultSettings();
    settings.excludedSites.push({ hostname: "bank.example", includeSubdomains: true });
    const { client } = store(saved(2, settings));
    await mount(client, "https://login.bank.example/");
    await expect
      .element(page.getByText("Paused until turned back on", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Ask for the master password" }))
      .toBeEnabled();
  });

  test("a master password rule for a parent site is changed only in settings", async () => {
    const settings = createDefaultSettings();
    settings.repromptSites.push({ hostname: "bank.example", includeSubdomains: true });
    const { client } = store(saved(2, settings));
    const host = await mount(client, "https://login.bank.example/");
    const toggle = page.getByRole("switch", { name: "Ask for the master password" });
    await expect.element(toggle).toBeChecked();
    await expect.element(toggle).toBeDisabled();
    await expect
      .element(toggle)
      .toHaveAccessibleDescription("Set by a rule for bank.example and its subdomains.");
    await userEvent.click(page.getByRole("link", { name: "Change in settings for bank.example" }));
    expect(host.openSettings).toHaveBeenCalledOnce();
    expect(client.saveSettings).not.toHaveBeenCalled();
  });

  test("a page waiting for the master password offers to open its window again", async () => {
    const { client } = store();
    const choices = noChoice();
    choices.status.mockResolvedValue({
      ok: true,
      origin: "https://login.bank.example",
      recipe: "page",
      page: { state: "denied", reason: "master-password-reprompt" },
    });
    choices.reprompt.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    choices.reprompt.mockResolvedValueOnce({ ok: true });
    const host = await mount(client, "https://login.bank.example/signin", choices);
    await expect
      .element(
        page.getByText(
          "No login started: this vault item asks for the master password first; enter it in the window Pateat opens.",
        ),
      )
      .toBeVisible();
    const button = page.getByRole("button", { name: "Enter the master password" });
    await userEvent.click(button);
    await expect
      .element(
        page.getByText(
          "The master password window could not open. It opens only for the active tab outside incognito, one window at a time.",
        ),
      )
      .toBeVisible();
    expect(host.close).not.toHaveBeenCalled();
    await userEvent.click(button);
    await vi.waitFor(() => expect(host.close).toHaveBeenCalledOnce());
    expect(choices.reprompt).toHaveBeenCalledWith(7);
  });

  test("a site the allowed sites leave out is paused, lists its accounts and offers to allow its whole site (ADR 0077)", async () => {
    const settings = createDefaultSettings();
    settings.allowedSitesEnabled = true;
    settings.allowedSites = [{ hostname: "shop.example", includeSubdomains: false }];
    const { client, current } = store(saved(0, settings));
    await mount(client, "https://login.bank.example/", pageOf("https://login.bank.example"));
    await expect
      .element(page.getByText("Paused, as this is not an allowed site", { exact: true }))
      .toBeVisible();
    // As on a paused site, the accounts are listed: a pick logs in.
    await expect.poll(() => client.findSiteAccounts.mock.calls.length).toBeGreaterThan(0);
    await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Allow bank.example" }));
    await expect
      .element(page.getByText("bank.example and its subdomains are now allowed sites."))
      .toBeVisible();
    expect(current().snapshot.settings.allowedSites).toEqual([
      { hostname: "shop.example", includeSubdomains: false },
      { hostname: "bank.example", includeSubdomains: true },
    ]);
    expect(current().snapshot.settings.allowedSitesEnabled).toBe(true);
    await expect.element(page.getByRole("group", { name: "Pause automatic login" })).toBeVisible();
  });

  test("an exclusion of a site the allowed sites leave out is resumed first", async () => {
    const settings = createDefaultSettings();
    settings.allowedSitesEnabled = true;
    settings.excludedSites = [{ hostname: "bank.example", includeSubdomains: true }];
    const { client, current } = store(saved(0, settings));
    await mount(client, "https://login.bank.example/", pageOf("https://login.bank.example"));
    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    expect(current().snapshot.settings.excludedSites).toEqual([]);
    await expect.element(page.getByRole("button", { name: "Allow bank.example" })).toBeVisible();
  });

  test("allowed sites that are off, or that cover the site, leave the popup as it is", async () => {
    const settings = createDefaultSettings();
    settings.allowedSites = [{ hostname: "shop.example", includeSubdomains: false }];
    const { client } = store(saved(0, settings));
    await mount(client, "https://login.bank.example/");
    await expect.poll(() => client.findSiteAccounts.mock.calls.length).toBeGreaterThan(0);
    await expect.element(page.getByRole("button", { name: /^Allow / })).not.toBeInTheDocument();
    await cleanup();
    settings.allowedSitesEnabled = true;
    settings.allowedSites = [{ hostname: "bank.example", includeSubdomains: true }];
    const covered = store(saved(0, settings));
    await mount(covered.client, "https://login.bank.example/");
    await expect.poll(() => covered.client.findSiteAccounts.mock.calls.length).toBeGreaterThan(0);
    await expect
      .element(page.getByText("Paused, as this is not an allowed site", { exact: true }))
      .not.toBeInTheDocument();
  });

  test("a pause that is not saved changes nothing", async () => {
    const { client, current } = store();
    client.saveSettings.mockResolvedValueOnce({
      version: 1,
      ok: false,
      error: { code: "storage-unavailable", message: "Unavailable." },
    });
    await mount(client, "https://bank.example/", pageOf("https://bank.example"));
    const until = page.getByRole("button", { name: "Until turned back on" });
    await userEvent.click(until);
    await expect
      .element(page.getByText("The change could not be saved. Reopen this popup and try again."))
      .toBeVisible();
    await expect.element(until).toBeVisible();
    expect(current().snapshot.settings.excludedSites).toEqual([]);
    // A save lost in transit may still have been saved.
    client.saveSettings.mockRejectedValueOnce(new Error("Port closed"));
    await userEvent.click(until);
    await expect
      .element(page.getByText("The change may not have been saved.", { exact: false }))
      .toBeVisible();
    await expect.element(until).toBeVisible();
  });
}

export function registerPopupSettingsCases(
  context: Pick<
    PopupTestContext,
    | "saved"
    | "demoSiteAccounts"
    | "store"
    | "noChoice"
    | "mount"
    | "fakeDeadline"
    | "pageOf"
    | "pressWithKeyboard"
    | "holdNextSave"
    | "resultMessage"
    | "onPage"
    | "lineText"
  >,
) {
  const {
    saved,
    demoSiteAccounts,
    store,
    noChoice,
    mount,
    fakeDeadline,
    pageOf,
    pressWithKeyboard,
    holdNextSave,
    resultMessage,
    onPage,
  } = context;
  test("saving or removing the default with the keyboard keeps focus in the popup", async () => {
    const { client } = store();
    await mount(client, "https://bank.example/login");
    await userEvent.click(page.getByText("Demo work vault"));
    const release = holdNextSave(client);
    const useDefault = await pressWithKeyboard("Use as default");
    await expect.element(page.getByText("Saving…")).toBeVisible();
    // The button is only marked disabled while the save runs, so it keeps focus.
    expect(document.activeElement).toBe(useDefault.element());
    await expect.element(useDefault).toHaveAttribute("aria-disabled", "true");
    release();
    await expect
      .element(page.getByText("Demo team account is now the default for this site."))
      .toBeVisible();
    // The saved default leaves the button disabled, so the result message takes focus.
    await expect.element(useDefault).toBeDisabled();
    await expect.poll(() => document.activeElement).toBe(resultMessage());

    client.saveSettings.mockResolvedValueOnce({
      version: 1,
      ok: false,
      error: { code: "storage-unavailable", message: "Unavailable." },
    });
    const remove = await pressWithKeyboard("Remove default");
    await expect
      .element(page.getByText("The change could not be saved. Reopen this popup and try again."))
      .toBeVisible();
    await expect.element(remove).toBeEnabled();
    expect(document.activeElement).toBe(remove.element());
    await pressWithKeyboard("Remove default");
    await expect
      .element(page.getByText("The default account for this site was removed."))
      .toBeVisible();
    // The button is gone with the default, so the result message takes focus.
    await expect.element(remove).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(resultMessage());
  });

  test("a pick that fails with the keyboard keeps focus in the popup", async () => {
    const { client } = store();
    const choices = noChoice();
    const offer = {
      ok: true as const,
      origin: "https://bank.example",
      documentId: "refused-document",
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
    };
    choices.get.mockResolvedValue(offer);
    await mount(client, "https://bank.example/", choices);
    const logIn = page.getByRole("button", { name: "Log in" });
    await expect.element(logIn).toBeEnabled();
    // A pick that leaves the choice waiting keeps focus on Log in.
    choices.pick.mockResolvedValueOnce({ ok: false, reason: "document-gone" });
    await pressWithKeyboard("Log in");
    await expect
      .element(page.getByText("The page changed, so nothing was started.", { exact: false }))
      .toBeVisible();
    await expect.element(logIn).toBeEnabled();
    expect(document.activeElement).toBe(logIn.element());
    // Another tab's login now holds the site, which disables Log in.
    choices.pick.mockResolvedValueOnce({ ok: false, reason: "origin-busy" });
    choices.get.mockResolvedValue({ ...offer, held: true });
    await pressWithKeyboard("Log in");
    await expect.element(page.getByText(/so Pateat did not log in here\./)).toBeVisible();
    await expect.element(logIn).toBeDisabled();
    await expect.poll(() => document.activeElement).toBe(resultMessage());
    // Once the page no longer waits, the choice and its Log in button are gone.
    choices.get.mockResolvedValue(offer);
    await expect.element(logIn).toBeEnabled();
    choices.pick.mockResolvedValueOnce({ ok: false, reason: "not-started" });
    choices.get.mockResolvedValue({ ok: false, reason: "no-choice" });
    await pressWithKeyboard("Log in");
    await expect
      .element(page.getByText("Pateat could not log in with", { exact: false }))
      .toBeVisible();
    await expect.element(logIn).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(resultMessage());
  });

  test("a tab whose address Pateat cannot read says so", async () => {
    const { client } = store();
    await mount(client, undefined);
    await expect
      .element(page.getByText("Pateat cannot read this tab's address.", { exact: false }))
      .toBeVisible();
    expect(client.findSiteAccounts).not.toHaveBeenCalled();
  });

  test("an HTTP page lists the accounts for its own origin (ADR 0050)", async () => {
    const { client, current } = store();
    await mount(client, "http://bank.example/");
    await expect.poll(() => client.findSiteAccounts.mock.calls.length).toBeGreaterThan(0);
    expect(client.findSiteAccounts).toHaveBeenCalledWith(
      "http://bank.example",
      current().snapshot.settings,
    );
  });

  test("the saved default is selected and marked, and an incomplete search is flagged", async () => {
    const settings = createDefaultSettings();
    settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "secondary",
    });
    const { client } = store(saved(1, settings));
    client.findSiteAccounts.mockImplementation(async (origin) => ({
      ...(await demoSiteAccounts(origin)),
      complete: false,
    }));
    await mount(client, "https://bank.example/");
    const current = page.getByRole("radio", {
      name: "Demo secondary account, Demo personal vault, default",
    });
    await expect.element(current).toBeChecked();
    await expect
      .element(page.getByText("Some vaults or items could not be checked", { exact: false }))
      .toBeVisible();
    const use = page.getByRole("button", { name: "Use as default" });
    // The saved default is already the default.
    await expect.element(use).toBeDisabled();
    await userEvent.click(page.getByText("Demo work vault"));
    await expect.element(use).toBeEnabled();
    await userEvent.click(use);
    // The result is announced in the popup's live region.
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Demo team account is now the default for this site.");
    await expect.element(use).toBeDisabled();
  });

  test("a saved default missing from the site's matches keeps its vault labels", async () => {
    const settings = createDefaultSettings();
    // Saved elsewhere without display names; the site's matches are reported empty.
    settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "secondary",
    });
    const { client } = store(saved(1, settings));
    client.findSiteAccounts.mockImplementation(async (origin) => ({
      ...(await demoSiteAccounts(origin)),
      accounts: [],
    }));
    await mount(client, "https://bank.example/");
    await expect.element(page.getByText("Demo secondary account")).toBeVisible();
    await expect.element(page.getByText("Demo personal vault")).toBeVisible();
    await expect.element(page.getByText("Default", { exact: true })).toBeVisible();
    // Nothing matches, so there is no account to choose.
    expect(page.getByRole("radio").elements()).toHaveLength(0);
    await expect
      .element(page.getByText("No vault item matches this site.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove default" })).toBeVisible();
  });

  test("a saved default waits for the site's matches instead of showing its saved labels", async () => {
    const settings = createDefaultSettings();
    settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    });
    const { client } = store(saved(1, settings));
    let answer!: () => void;
    client.findSiteAccounts.mockImplementation(
      (origin) =>
        new Promise((resolve) => {
          answer = () =>
            void demoSiteAccounts(origin).then((found) =>
              resolve({
                ...found,
                accounts: found.accounts.map((account) => ({
                  ...account,
                  username: `${account.itemId}@bank.example`,
                })),
              }),
            );
        }),
    );
    await mount(client, "https://bank.example/");
    await expect.element(page.getByText("Finding the vault items", { exact: false })).toBeVisible();
    // The default is not shown by its item name while its username is still being read.
    expect(document.querySelector("#popup-default")).toBeNull();
    expect(page.getByText("Demo team account", { exact: false }).query()).toBeNull();
    // Nothing shows which account it would remove yet.
    await expect.element(page.getByRole("button", { name: "Remove default" })).toBeDisabled();
    answer();
    await expect
      .element(
        page.getByRole("radio", {
          name: "primary@bank.example, Demo team account in Demo work vault, default",
        }),
      )
      .toBeChecked();
    expect(document.querySelector("#popup-default")).toBeNull();
    await expect.element(page.getByRole("button", { name: "Remove default" })).toBeEnabled();
  });

  test("a search for the site's matches that does not finish ends with the saved default", async () => {
    const settings = createDefaultSettings();
    settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    });
    const { client } = store(saved(1, settings));
    client.findSiteAccounts.mockImplementation(() => new Promise(() => {}));
    fakeDeadline();
    await mount(client, "https://bank.example/", noChoice(), false, 300);
    await expect
      .element(page.getByText("Finding the vault items that match this site…", { exact: true }))
      .toBeVisible();
    await vi.advanceTimersByTimeAsync(300);
    await expect
      .element(
        page.getByText(
          "Finding the vault items that match this site took too long. Wait a moment, then reopen this popup.",
        ),
      )
      .toBeVisible();
    // The saved default shows by its saved labels and can still be removed.
    await expect
      .element(page.getByText("Demo team account", { exact: false }).first())
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove default" })).toBeEnabled();
    expect(page.getByText("Finding the vault items that match this site…").query()).toBeNull();
  });

  test("a waiting account choice shows its candidates when the site's matches do not finish", async () => {
    const { client } = store();
    client.findSiteAccounts.mockImplementation(() => new Promise(() => {}));
    const choices = noChoice();
    choices.get.mockResolvedValue({
      ok: true,
      origin: "https://bank.example",
      documentId: "refused-document",
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
    });
    fakeDeadline();
    await mount(client, "https://bank.example/login", choices, false, 300);
    await expect
      .element(page.getByText("Listing the accounts that match this page…", { exact: true }))
      .toBeVisible();
    await vi.advanceTimersByTimeAsync(300);
    await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
    await expect
      .element(page.getByRole("group", { name: "Account to log in with" }).getByRole("radio"))
      .toHaveLength(2);
    await expect
      .element(
        page.getByText("took too long. Wait a moment, then reopen this popup", { exact: false }),
      )
      .toBeVisible();
  });

  test("a change saved elsewhere first is reloaded instead of overwritten", async () => {
    const state = store();
    await mount(state.client, "https://bank.example/", pageOf("https://bank.example"));
    const until = page.getByRole("button", { name: "Until turned back on" });
    await expect.element(until).toBeVisible();
    const elsewhere = createDefaultSettings();
    elsewhere.excludedSites.push({ hostname: "mail.example", includeSubdomains: false });
    state.replace(saved(7, elsewhere));
    await userEvent.click(until);
    await expect
      .element(
        page.getByText(
          "The settings changed elsewhere, so this change was not saved. The popup now shows them.",
        ),
      )
      .toBeVisible();
    expect(state.current().snapshot).toMatchObject({ revision: 7, settings: elsewhere });
    await userEvent.click(until);
    await expect
      .element(page.getByText("Automatic login on this site is paused until turned back on."))
      .toBeVisible();
    expect(state.current().snapshot.settings.excludedSites).toEqual([
      { hostname: "mail.example", includeSubdomains: false },
      { hostname: "bank.example", includeSubdomains: true },
    ]);
  });

  test("a private window says automatic login is off there and links to the setting (ADR 0062)", async () => {
    const { client } = store();
    const choices = onPage({ recipe: "page" });
    const host = await mount(client, "https://bank.example/login", choices, true);
    await expect
      .element(page.getByText("Automatic login is off in private windows."))
      .toBeVisible();
    // Neither a pause nor Resume is offered; the setting changes it.
    expect(page.getByRole("group", { name: "Pause automatic login" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Resume" }).query()).toBeNull();
    await userEvent.click(
      page.getByRole("link", { name: "Change automatic login in private windows in settings" }),
    );
    expect(host.openSettings).toHaveBeenCalledWith("private-windows");
    expect(choices.pause).not.toHaveBeenCalled();
  });

  test("a private window offers the pause once automatic login is on there (ADR 0062)", async () => {
    const settings = createDefaultSettings();
    settings.loginInPrivateWindows = true;
    const { client } = store(saved(0, settings));
    await mount(client, "https://bank.example/login", onPage({ recipe: "page" }), true);
    const row = page.getByRole("group", { name: "Pause automatic login" });
    await expect.element(row).toBeVisible();
    expect(page.getByText("Automatic login is off in private windows.").query()).toBeNull();
    // A pause until turned back on is a synced rule that would pause normal windows too.
    await expect.element(row.getByRole("button", { name: "10 minutes" })).toBeVisible();
    await expect.element(row.getByRole("button", { name: "1 hour" })).toBeVisible();
    expect(row.getByRole("button", { name: "Until turned back on" }).query()).toBeNull();
  });

  test("a private window's choice says automatic login is off there, and a passkey-only pick points to the page (ADR 0062)", async () => {
    const { client } = store();
    const choices = onPage({ recipe: "page", page: { state: "denied", reason: "paused" } });
    choices.get.mockResolvedValue({
      ok: true,
      origin: "https://bank.example",
      documentId: "paused",
      candidates: [{ connectionId: "demo-work", itemId: "primary" }],
      paused: true,
    });
    await mount(client, "https://bank.example/", choices, true);
    await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
    expect(document.querySelector("#popup-choice-reason")?.textContent).toBe(
      "Automatic login is off in private windows.",
    );
    await expect
      .poll(() => context.lineText("login"))
      .toBe(
        "No login started: automatic login is off in private windows; choose an account to log in.",
      );
    choices.pick.mockResolvedValueOnce({ ok: false, reason: "paused-no-password" });
    await userEvent.click(page.getByRole("button", { name: "Log in" }));
    const said = page.getByText(
      /^Automatic login is off in private windows, and .+ has no password/,
    );
    await expect.element(said).toBeVisible();
    expect(said.element().textContent).not.toContain("Pateat's window");
  });

  test("settings that cannot be loaded change nothing", async () => {
    const { client } = store();
    client.getSettings.mockResolvedValue({
      version: 1,
      ok: false,
      error: { code: "storage-unavailable", message: "Unavailable." },
    });
    await mount(client, "https://bank.example/");
    await expect.element(page.getByText("Pateat's settings could not be loaded.")).toBeVisible();
    expect(page.getByRole("group", { name: "Pause automatic login" }).query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Open settings" })).toBeVisible();
    expect(client.saveSettings).not.toHaveBeenCalled();
  });
}
