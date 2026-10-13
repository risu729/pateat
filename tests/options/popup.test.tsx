import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
import { popupOrigin, SiteApp, type PopupHost } from "../../apps/extension/src/popup/site-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type LocalSettings,
  type SettingsResponse,
} from "../../packages/contracts/src/index";

function saved(revision: number, settings: LocalSettings = createDefaultSettings()) {
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision, settings: structuredClone(settings) },
    catalog: structuredClone(DUMMY_VAULT_CATALOG),
  } satisfies Extract<SettingsResponse, { ok: true }>;
}

/** The demo catalog's static origins stand in for the background's vault matching. */
async function demoSiteAccounts(origin: string) {
  return {
    version: 1 as const,
    ok: true as const,
    origin,
    accounts: DUMMY_VAULT_CATALOG.connections.flatMap((connection) =>
      connection.items
        .filter((item) => item.allowedOrigins.includes(origin))
        .map((item) => ({
          connectionId: connection.id,
          itemId: item.id,
          uri: true,
          passkey: false,
        })),
    ),
    complete: true,
  };
}

/** A worker-owned store: each save must name the current revision. */
function store(initial = saved(0)) {
  let current = initial;
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>(async () => structuredClone(current)),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(async (request) => {
      if (request.expectedRevision !== current.snapshot.revision)
        return {
          version: 1,
          ok: false,
          error: { code: "revision-conflict", message: "Settings changed." },
        };
      current = saved(current.snapshot.revision + 1, request.settings);
      return structuredClone(current);
    }),
    findSiteAccounts: vi
      .fn<SettingsClient["findSiteAccounts"]>()
      .mockImplementation(demoSiteAccounts),
  };
  return {
    client,
    current: () => current,
    replace(next: ReturnType<typeof saved>) {
      current = next;
    },
  };
}

function noChoice() {
  return {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({ ok: false, reason: "no-choice" }),
    pick: vi.fn<ChoiceClient["pick"]>().mockResolvedValue({ ok: true }),
  };
}

async function mount(
  client: SettingsClient,
  url: string | undefined,
  choices: ChoiceClient = noChoice(),
  incognito = false,
) {
  const host = {
    currentTab: vi.fn<PopupHost["currentTab"]>().mockResolvedValue({ id: 7, url, incognito }),
    openSettings: vi.fn<PopupHost["openSettings"]>(),
    close: vi.fn<PopupHost["close"]>(),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp client={client} choices={choices} host={host} />
    </QueryClientProvider>,
  );
  return host;
}

afterEach(() => cleanup());

test("only HTTPS pages with a valid hostname are a site the popup edits", () => {
  expect(popupOrigin("https://bank.example/login?next=1")).toBe("https://bank.example");
  expect(popupOrigin("https://bank.example:8443/")).toBe("https://bank.example:8443");
  expect(popupOrigin("http://bank.example/")).toBeUndefined();
  expect(popupOrigin("chrome://extensions/")).toBeUndefined();
  expect(popupOrigin(undefined)).toBeUndefined();
});

test("a tab Pateat cannot run on offers only the settings page", async () => {
  const { client } = store();
  const host = await mount(client, "chrome://newtab/");
  await expect
    .element(page.getByText("Pateat works on HTTPS websites.", { exact: false }))
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
  await mount(client, "https://bank.example/login");
  await expect.element(page.getByRole("heading", { name: "bank.example" })).toBeVisible();
  const accounts = page.getByRole("group", { name: "Default account" }).getByRole("radio");
  await expect.element(accounts).toHaveLength(3);
  // No account is the default yet: none carries the badge or is selected, and nothing
  // can be saved before one is picked.
  expect(page.getByText("Default", { exact: true }).query()).toBeNull();
  for (const radio of accounts.elements()) expect((radio as HTMLInputElement).checked).toBe(false);
  await expect
    .element(
      page.getByText("No default account. With exactly one matching item, Pateat uses that item"),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();
  await expect.element(page.getByText("Takes effect at the next login")).toBeVisible();
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
    .element(page.getByText("Demo team account is now the default for this site"))
    .toBeVisible();
  expect(page.getByText("No default account.", { exact: false }).query()).toBeNull();
  expect(client.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "settings.save", expectedRevision: 0 }),
  );
  expect(current().snapshot.settings.siteDefaults).toEqual([
    {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "demo-work-account",
      itemId: "primary",
      itemName: "Demo team account",
      accountName: "Demo work vault",
    },
  ]);
  // Only the site default changed.
  expect({ ...current().snapshot.settings, siteDefaults: [] }).toEqual(createDefaultSettings());
  await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();

  await userEvent.click(page.getByRole("button", { name: "Remove default" }));
  await expect
    .element(page.getByText("The default account for this site was removed"))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Remove default" }))
    .not.toBeInTheDocument();
  expect(current().snapshot).toMatchObject({ revision: 2, settings: createDefaultSettings() });
});

test("the switch excludes the site by its exact hostname, and turns it back on", async () => {
  const { client, current } = store();
  await mount(client, "https://login.bank.example/");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).toBeChecked();
  await expect.element(toggle).toBeEnabled();
  await userEvent.click(toggle);
  await expect.element(page.getByText("login.bank.example is now excluded")).toBeVisible();
  await expect.element(toggle).not.toBeChecked();
  // Saving does not disable the switch, so it keeps keyboard focus.
  expect(document.activeElement).toBe(toggle.element());
  await expect.element(page.getByText("No logins or passkey answers on this site")).toBeVisible();
  expect(current().snapshot.settings.excludedSites).toEqual([
    { hostname: "login.bank.example", includeSubdomains: false },
  ]);
  // An excluded site is not searched and offers no default.
  await expect
    .element(page.getByRole("group", { name: "Default account" }))
    .not.toBeInTheDocument();
  await expect.element(toggle).toBeEnabled();
  await expect.element(toggle).not.toHaveAttribute("aria-describedby");
  await userEvent.click(toggle);
  await expect.element(page.getByText("login.bank.example is no longer excluded")).toBeVisible();
  await expect.element(toggle).toBeChecked();
  expect(current().snapshot.settings.excludedSites).toEqual([]);
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
});

test("a parent rule that includes subdomains is shown but changed only in settings", async () => {
  const settings = createDefaultSettings();
  settings.excludedSites.push(
    { hostname: "bank.example", includeSubdomains: true },
    { hostname: "login.bank.example", includeSubdomains: false },
    { hostname: "mail.example", includeSubdomains: false },
  );
  const { client } = store(saved(4, settings));
  const host = await mount(client, "https://login.bank.example/");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).not.toBeChecked();
  // The site's own exact rule is not removed here either: the parent rule would still
  // exclude the site.
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(toggle)
    .toHaveAccessibleDescription("Excluded by a rule for other sites too");
  await expect.element(page.getByText("bank.example", { exact: true })).toBeVisible();
  await expect.element(page.getByText("and its subdomains")).toBeVisible();
  await expect.element(page.getByText("mail.example", { exact: false })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("link", { name: "Change in settings for bank.example" }));
  expect(host.openSettings).toHaveBeenCalledOnce();
  expect(client.saveSettings).not.toHaveBeenCalled();
  // The site is excluded, so no account is searched.
  expect(client.findSiteAccounts).not.toHaveBeenCalled();
});

test("an exact rule that includes subdomains is changed only in settings", async () => {
  const settings = createDefaultSettings();
  settings.excludedSites.push({ hostname: "bank.example", includeSubdomains: true });
  const { client } = store(saved(2, settings));
  await mount(client, "https://bank.example/");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).not.toBeChecked();
  await expect.element(toggle).toBeDisabled();
  await expect
    .element(toggle)
    .toHaveAccessibleDescription("Excluded by a rule for other sites too");
  await expect
    .element(page.getByRole("link", { name: "Change in settings for bank.example" }))
    .toBeVisible();
});

test("a switch change that is not saved returns to the saved state", async () => {
  const { client, current } = store();
  client.saveSettings.mockResolvedValueOnce({
    version: 1,
    ok: false,
    error: { code: "storage-unavailable", message: "Unavailable." },
  });
  await mount(client, "https://bank.example/");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).toBeEnabled();
  await userEvent.click(toggle);
  await expect.element(page.getByText("The change could not be saved")).toBeVisible();
  await expect.element(toggle).toBeChecked();
  expect(current().snapshot.settings.excludedSites).toEqual([]);
  // A save lost in transit may still have been saved.
  client.saveSettings.mockRejectedValueOnce(new Error("Port closed"));
  await userEvent.click(toggle);
  await expect
    .element(page.getByText("The change may not have been saved.", { exact: false }))
    .toBeVisible();
  await expect.element(toggle).toBeChecked();
});

test("a tab whose address Pateat cannot read says so", async () => {
  const { client } = store();
  await mount(client, undefined);
  await expect
    .element(page.getByText("Pateat cannot read this tab's address.", { exact: false }))
    .toBeVisible();
  expect(client.findSiteAccounts).not.toHaveBeenCalled();
});

test("an HTTP page is not a site Pateat runs on", async () => {
  const { client } = store();
  await mount(client, "http://bank.example/");
  await expect
    .element(page.getByText("Pateat works on HTTPS websites.", { exact: false }))
    .toBeVisible();
  expect(client.findSiteAccounts).not.toHaveBeenCalled();
});

test("the saved default is selected and marked, and an incomplete search is flagged", async () => {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
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
    .toHaveTextContent("Demo team account is now the default for this site");
  await expect.element(use).toBeDisabled();
});

test("a saved default missing from the site's matches keeps its vault labels", async () => {
  const settings = createDefaultSettings();
  // Saved elsewhere without display names; the site's matches are reported empty.
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
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

test("a change saved elsewhere first is reloaded instead of overwritten", async () => {
  const state = store();
  await mount(state.client, "https://bank.example/");
  const toggle = page.getByRole("switch", { name: "Pateat on this site" });
  await expect.element(toggle).toBeEnabled();
  const elsewhere = createDefaultSettings();
  elsewhere.excludedSites.push({ hostname: "mail.example", includeSubdomains: false });
  state.replace(saved(7, elsewhere));
  await userEvent.click(toggle);
  await expect
    .element(page.getByText("Changed elsewhere and reloaded. Nothing was changed."))
    .toBeVisible();
  // The switch returns to the reloaded state.
  await expect.element(toggle).toBeChecked();
  expect(state.current().snapshot).toMatchObject({ revision: 7, settings: elsewhere });
  await userEvent.click(toggle);
  await expect.element(page.getByText("bank.example is now excluded")).toBeVisible();
  await expect.element(toggle).not.toBeChecked();
  expect(state.current().snapshot.settings.excludedSites).toEqual([
    { hostname: "mail.example", includeSubdomains: false },
    { hostname: "bank.example", includeSubdomains: false },
  ]);
});

test("settings that cannot be loaded change nothing", async () => {
  const { client } = store();
  client.getSettings.mockResolvedValue({
    version: 1,
    ok: false,
    error: { code: "storage-unavailable", message: "Unavailable." },
  });
  await mount(client, "https://bank.example/");
  await expect.element(page.getByText("Pateat settings could not be loaded")).toBeVisible();
  expect(page.getByRole("switch").query()).toBeNull();
  await expect.element(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("a login refused for several matches is restarted with the account picked here", async () => {
  const { client, current } = store();
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
  const host = await mount(client, "https://bank.example/login", choices);
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  expect(choices.get).toHaveBeenCalledWith(7);
  // Only the refused login's candidates are offered, not every matching item.
  await expect
    .element(page.getByRole("group", { name: "Account to log in with" }).getByRole("radio"))
    .toHaveLength(2);
  await expect.element(page.getByText("2 accounts match this page")).toBeVisible();
  const asDefault = page.getByRole("checkbox", { name: "Make it the default for bank.example" });
  await expect.element(asDefault).toBeChecked();
  const offered = page.getByRole("group", { name: "Account to log in with" });
  await userEvent.click(offered.getByRole("radio", { name: "Demo team account, Demo work vault" }));
  await userEvent.click(asDefault);
  choices.get.mockResolvedValue({ ok: false, reason: "no-choice" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  await expect
    .element(page.getByText("Logging in with Demo team account", { exact: true }))
    .toBeVisible();
  expect(choices.pick).toHaveBeenCalledWith({
    tabId: 7,
    documentId: "refused-document",
    connectionId: "demo-work",
    itemId: "primary",
    makeDefault: false,
  });
  // The login runs in the page from here, so the popup closes.
  expect(host.close).toHaveBeenCalledOnce();
  // The pick itself saves no settings; a default is saved only after the login succeeds.
  expect(client.saveSettings).not.toHaveBeenCalled();
  expect(current().snapshot.revision).toBe(0);
});

test("a choice that starts waiting after the popup opened is shown while it stays open", async () => {
  const { client } = store();
  const choices = noChoice();
  let answer: (value: Awaited<ReturnType<ChoiceClient["get"]>>) => void = () => undefined;
  choices.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  await mount(client, "https://bank.example/login", choices);
  await expect
    .element(page.getByText("Checking whether this page waits for an account choice…"))
    .toBeVisible();
  answer({ ok: false, reason: "no-choice" });
  await expect
    .element(page.getByText("Checking whether this page waits for an account choice…"))
    .not.toBeInTheDocument();
  expect(page.getByRole("heading", { name: "Choose an account" }).elements()).toHaveLength(0);
  // A restarted worker re-asks the page, which is refused for several matches again.
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "refused-document",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-work", itemId: "primary" },
    ],
  });
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  const calls = choices.get.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Once a choice is shown it is not asked for again.
  expect(choices.get.mock.calls.length).toBe(calls);
});

test("a waiting choice shows once the site's matches name its accounts", async () => {
  const { client } = store();
  let list!: () => void;
  client.findSiteAccounts.mockImplementation(
    (origin) =>
      new Promise((resolve) => {
        list = () => void demoSiteAccounts(origin).then(resolve);
      }),
  );
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
  await mount(client, "https://bank.example/login", choices);
  // The page waits for a choice, but its accounts are not named yet.
  await vi.waitFor(() => expect(choices.get).toHaveBeenCalled());
  await vi.waitFor(() => expect(list).toBeDefined());
  await expect.element(page.getByText(/^Listing the accounts that match this page/)).toBeVisible();
  expect(page.getByRole("heading", { name: "Choose an account" }).query()).toBeNull();
  list();
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  expect(page.getByText(/^Listing the accounts that match this page/).query()).toBeNull();
});

test("a site another tab's login holds says so until that tab lets it go", async () => {
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
  choices.get.mockResolvedValue({ ...offer, held: true });
  await mount(client, "https://bank.example/login", choices);
  await expect
    .element(page.getByText(/^Another tab's login to this site is running or did not succeed\./))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Log in" }))
    .toHaveAccessibleDescription(
      "Another tab's login to this site is running or did not succeed. Close that tab or wait up to 5 minutes.",
    );
  // Closing that tab lets the site go; the open popup asks again and enables the pick.
  choices.get.mockResolvedValue(offer);
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeEnabled();
  expect(page.getByText(/^Another tab's login to this site/).query()).toBeNull();
  // The hold may start again before the pick reaches the page.
  choices.pick.mockResolvedValue({ ok: false, reason: "origin-busy" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  await expect
    .element(
      page.getByText(
        /so Pateat did not log in here\. Close that tab or wait up to 5 minutes, then choose again\.$/,
      ),
    )
    .toBeVisible();
});

test("a pick in a private window is not made the default unless asked", async () => {
  const { client } = store();
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "refused-document",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-personal", itemId: "secondary" },
    ],
  });
  choices.pick.mockResolvedValue({ ok: false, reason: "document-gone" });
  await mount(client, "https://bank.example/", choices, true);
  const asDefault = page.getByRole("checkbox", { name: "Make it the default for bank.example" });
  await expect.element(asDefault).not.toBeChecked();
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  expect(choices.pick).toHaveBeenCalledWith(
    expect.objectContaining({ itemId: "primary", makeDefault: false }),
  );
  await expect
    .element(page.getByText("The page changed, so nothing was started.", { exact: false }))
    .toBeVisible();
  // Asked, the pick becomes the default.
  await userEvent.click(asDefault);
  await expect.element(asDefault).toBeChecked();
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  expect(choices.pick).toHaveBeenLastCalledWith(expect.objectContaining({ makeDefault: true }));
});

test("a pick that starts nothing says so, and the default list returns once the choice ends", async () => {
  const { client } = store();
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
  choices.pick.mockResolvedValue({ ok: false, reason: "not-started" });
  await mount(client, "https://bank.example/", choices);
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  // While the page waits, the account choice is the popup's only list.
  await expect
    .element(page.getByRole("group", { name: "Default account" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("radio")).toHaveLength(2);
  // The failed pick asks the background again, and the page no longer waits.
  choices.get.mockResolvedValue({ ok: false, reason: "no-choice" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  await expect
    .element(
      page.getByText(
        "Pateat could not log in with Demo primary account on this page. Reload the page to choose again.",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Choose an account" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("group", { name: "Default account" }).getByRole("radio"))
    .toHaveLength(3);
});

test("after a logout, the popup lists the saved default first", async () => {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-work-account",
    itemId: "primary",
  });
  const { client } = store(saved(3, settings));
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "signed-out",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-work", itemId: "primary" },
    ],
    logout: "this-tab",
  });
  await mount(client, "https://bank.example/", choices);
  await expect
    .element(page.getByText("You logged out of this site in this tab", { exact: true }))
    .toBeVisible();
  const radios = page.getByRole("group", { name: "Account to log in with" }).getByRole("radio");
  await expect
    .element(radios.first())
    .toHaveAccessibleName("Demo team account, Demo work vault, default");
  await expect.element(radios.first()).toBeChecked();
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  expect(choices.pick).toHaveBeenCalledWith(
    expect.objectContaining({ documentId: "signed-out", connectionId: "demo-work" }),
  );
});

test("while a choice waits, the saved default can still be removed, and one missing from the choice is named", async () => {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-personal-account",
    itemId: "secondary",
    itemName: "Demo secondary account",
  });
  const { client, current } = store(saved(3, settings));
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "signed-out",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-work", itemId: "primary" },
    ],
    logout: "this-tab",
  });
  await mount(client, "https://bank.example/", choices);
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect
    .element(page.getByRole("group", { name: "Default account" }))
    .not.toBeInTheDocument();
  await expect
    .element(
      page.getByText(
        "The saved default, Demo secondary account (Demo personal vault), is not one of these accounts",
      ),
    )
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Remove default" }));
  await expect
    .element(page.getByText("The default account for this site was removed"))
    .toBeVisible();
  expect(current().snapshot.settings.siteDefaults).toEqual([]);
  // The choice stays for a pick.
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeEnabled();
});

test("after a logout, the popup asks even with one account", async () => {
  const { client } = store();
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "signed-out",
    candidates: [{ connectionId: "demo-work", itemId: "primary" }],
    logout: "this-tab",
  });
  await mount(client, "https://bank.example/", choices);
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect
    .poll(
      () =>
        page.getByRole("group", { name: "Account to log in with" }).getByRole("radio").elements()
          .length,
    )
    .toBe(1);
});
