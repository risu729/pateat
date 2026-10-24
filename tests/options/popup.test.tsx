import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
import type { DetailClient, DetailResponse } from "../../apps/extension/src/login/detail-wire";
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
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({ ok: false, reason: "no-page" }),
    switchTo: vi.fn<ChoiceClient["switchTo"]>().mockResolvedValue({ ok: true }),
    pause: vi.fn<ChoiceClient["pause"]>().mockResolvedValue({ ok: true }),
    pauseState: vi.fn<ChoiceClient["pauseState"]>().mockResolvedValue({ ok: true }),
    reprompt: vi.fn<ChoiceClient["reprompt"]>(),
  };
}

/** A page that asks for no personal detail, on a site without links. */
function noDetails(origin = "https://bank.example") {
  return {
    get: vi.fn<DetailClient["get"]>().mockResolvedValue({ ok: true, origin, links: [] }),
    fill: vi.fn<DetailClient["fill"]>().mockResolvedValue({ ok: true }),
    remove: vi.fn<DetailClient["remove"]>().mockResolvedValue({ ok: true }),
  };
}

async function mount(
  client: SettingsClient,
  url: string | undefined,
  choices: ChoiceClient = noChoice(),
  incognito = false,
  listingWaitMs?: number,
  details: DetailClient = noDetails(),
) {
  const unwatched = vi.fn<() => void>();
  let onSettings = () => {};
  const host = {
    currentTab: vi.fn<PopupHost["currentTab"]>().mockResolvedValue({ id: 7, url, incognito }),
    openSettings: vi.fn<PopupHost["openSettings"]>(),
    openDiagnostics: vi.fn<PopupHost["openDiagnostics"]>(),
    close: vi.fn<PopupHost["close"]>(),
    watchSettings: vi.fn<PopupHost["watchSettings"]>((onChange) => {
      onSettings = onChange;
      return unwatched;
    }),
    unwatched,
    /** Stands in for a change to the stored settings, as the worker writes them. */
    settingsChanged: () => onSettings(),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp
        client={client}
        choices={choices}
        details={details}
        host={host}
        {...(listingWaitMs === undefined ? {} : { listingWaitMs })}
      />
    </QueryClientProvider>,
  );
  return host;
}

/** The popup asks the worker for the tab's choice and page status again each second. */
const POLL_MS = 1000;

/** Runs that poll on a fake clock, so a test advances it instead of waiting it out. */
function fakePolls() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

/**
 * Runs the listing deadline on a fake clock that also follows real time, since the
 * query cache delivers its results on zero-delay timeouts.
 */
function fakeDeadline() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
}

afterEach(async () => {
  // Real timers first, so a failing cleanup cannot leave fake ones to later tests.
  vi.useRealTimers();
  await cleanup();
});

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
  await expect.element(page.getByText("Pateat works on websites", { exact: false })).toBeVisible();
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
      page.getByText("No default account. With exactly one matching item, Pateat uses that item."),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();
  await expect.element(page.getByText("A default takes effect at the next login.")).toBeVisible();
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
  await expect.element(page.getByRole("button", { name: "Use as default" })).toBeDisabled();

  await userEvent.click(page.getByRole("button", { name: "Remove default" }));
  await expect
    .element(page.getByText("The default account for this site was removed."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Remove default" }))
    .not.toBeInTheDocument();
  expect(current().snapshot).toMatchObject({ revision: 2, settings: createDefaultSettings() });
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

/** A status for a page of `origin`, where a pause is offered. */
function pageOf(origin: string, fields: Parameters<typeof onPage>[0] = {}) {
  return onPage({ origin, recipe: "page", ...fields });
}

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

/** Focuses a button and presses Enter, as a keyboard or screen reader user does. */
async function pressWithKeyboard(name: string) {
  const button = page.getByRole("button", { name });
  (button.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  return button;
}

/** Holds the next save until the returned function is called. */
function holdNextSave(client: ReturnType<typeof store>["client"]) {
  const save = client.saveSettings.getMockImplementation()!;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  client.saveSettings.mockImplementationOnce(async (request) => {
    await held;
    return save(request);
  });
  return () => release();
}

const resultMessage = () => document.querySelector("#popup-message");

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
  await expect.element(page.getByText("Demo team account", { exact: false }).first()).toBeVisible();
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
  await expect.element(page.getByText("Automatic login is off in private windows.")).toBeVisible();
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
    .poll(() => lineText("login"))
    .toBe(
      "No login started: automatic login is off in private windows; choose an account to log in.",
    );
  choices.pick.mockResolvedValueOnce({ ok: false, reason: "paused-no-password" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  const said = page.getByText(/^Automatic login is off in private windows, and .+ has no password/);
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
  await expect.element(page.getByText("2 accounts match this page.")).toBeVisible();
  const asDefault = page.getByRole("checkbox", { name: "Make it the default for bank.example" });
  await expect.element(asDefault).toBeChecked();
  const offered = page.getByRole("group", { name: "Account to log in with" });
  await userEvent.click(offered.getByRole("radio", { name: "Demo team account, Demo work vault" }));
  await userEvent.click(asDefault);
  choices.get.mockResolvedValue({ ok: false, reason: "no-choice" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  await expect
    .element(page.getByText("Logging in with Demo team account.", { exact: true }))
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

test("a site an exclusion rule covers is paused until turned back on and still offers its choice", async () => {
  const settings = createDefaultSettings();
  settings.excludedSites.push({ hostname: "bank.example", includeSubdomains: false });
  const { client } = store(saved(0, settings));
  const choices = pageOf("https://bank.example");
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "refused-document",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-work", itemId: "primary" },
    ],
  });
  fakePolls();
  await mount(client, "https://bank.example/login", choices);
  await expect.element(page.getByText("Paused until turned back on")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Resume" })).toBeVisible();
  // The pause offers no shorter lengths while it runs.
  expect(page.getByRole("button", { name: "10 minutes" }).query()).toBeNull();
  // A pick still logs in on a paused site, so the waiting choice is offered.
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeVisible();
});

test("pausing the site until turned back on keeps a waiting account choice (ADR 0062)", async () => {
  const { client } = store();
  const choices = pageOf("https://bank.example");
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
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Until turned back on" }));
  await expect
    .element(page.getByText("Automatic login on this site is paused until turned back on."))
    .toBeVisible();
  // A pick still logs in on a paused site.
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeVisible();
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
  fakePolls();
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
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  const calls = choices.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3 * POLL_MS);
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
  fakePolls();
  await mount(client, "https://bank.example/login", choices);
  await expect
    .element(page.getByText(/^Another tab's login to this site is running or did not succeed\./))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Log in" }))
    .toHaveAccessibleDescription(
      "Another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes.",
    );
  // Closing that tab lets the site go; the open popup asks again and enables the pick.
  choices.get.mockResolvedValue(offer);
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeEnabled();
  expect(page.getByText(/^Another tab's login to this site/).query()).toBeNull();
  // The hold may start again before the pick reaches the page.
  choices.pick.mockResolvedValue({ ok: false, reason: "origin-busy" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  await expect
    .element(
      page.getByText(
        /so Pateat did not log in here\. Demo primary account was not made the default\. Close that tab, or wait up to 10 minutes, then choose again\.$/,
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
        "Pateat could not log in with Demo primary account on this page. Demo primary account was not made the default. Reload the page to choose again.",
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

test("after two logins in 10 minutes, the popup lists the saved default first", async () => {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    server: "cloud-us",
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
    ask: "relogin-limit",
  });
  await mount(client, "https://bank.example/", choices);
  await expect
    .element(
      page.getByText(
        "Pateat logged in to this site twice in the last 10 minutes, so it waits for you to choose.",
        { exact: true },
      ),
    )
    .toBeVisible();
  const radios = page.getByRole("group", { name: "Account to log in with" }).getByRole("radio");
  await expect
    .element(radios.first())
    .toHaveAccessibleName("Demo team account, Demo work vault, default");
  await expect.element(radios.first()).toBeChecked();
  // The saved default stays when its own pick starts nothing, so the popup does not say it
  // was not made the default.
  choices.pick.mockResolvedValue({ ok: false, reason: "not-started" });
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  expect(choices.pick).toHaveBeenCalledWith(
    expect.objectContaining({
      documentId: "signed-out",
      connectionId: "demo-work",
      makeDefault: true,
    }),
  );
  await expect
    .element(
      page.getByText(
        "Pateat could not log in with Demo team account on this page. Reload the page to choose again.",
      ),
    )
    .toBeVisible();
});

test("while a choice waits, the saved default can still be removed, and one missing from the choice is named", async () => {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    server: "cloud-us",
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
    ask: "stopped-login",
  });
  await mount(client, "https://bank.example/", choices);
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect
    .element(page.getByRole("group", { name: "Default account" }))
    .not.toBeInTheDocument();
  await expect
    .element(
      page.getByText(
        "The saved default, Demo secondary account (Demo personal vault), is not one of these accounts.",
      ),
    )
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Remove default" }));
  await expect
    .element(page.getByText("The default account for this site was removed."))
    .toBeVisible();
  expect(current().snapshot.settings.siteDefaults).toEqual([]);
  // The choice stays for a pick.
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeEnabled();
});

test("after the site rejects a login, the popup says so and offers the accounts", async () => {
  const { client } = store();
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "rejected-page",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-work", itemId: "primary" },
    ],
    ask: "rejected",
  });
  await mount(client, "https://bank.example/", choices);
  await expect
    .element(page.getByText("The site did not accept the last login in this tab.", { exact: true }))
    .toBeVisible();
  // Nothing is chosen, so Log in cannot send the rejected account again by itself.
  const offered = page.getByRole("group", { name: "Account to log in with" });
  await expect.element(offered.getByRole("radio").first()).not.toBeChecked();
  await expect.element(offered.getByRole("radio").last()).not.toBeChecked();
  const logIn = page.getByRole("button", { name: "Log in" });
  await expect.element(logIn).toBeDisabled();
  // The default box keeps its usual state; it saves only after a login succeeds.
  await expect
    .element(page.getByRole("checkbox", { name: "Make it the default for bank.example" }))
    .toBeChecked();
  expect(choices.pick).not.toHaveBeenCalled();
  await userEvent.click(offered.getByRole("radio", { name: "Demo team account, Demo work vault" }));
  await expect.element(logIn).toBeEnabled();
  await userEvent.click(logIn);
  expect(choices.pick).toHaveBeenCalledWith(
    expect.objectContaining({ documentId: "rejected-page", connectionId: "demo-work" }),
  );
});

test("after the site rejects a login in another tab, the popup chooses no account", async () => {
  const { client } = store();
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "other-tab",
    candidates: [
      { connectionId: "demo-personal", itemId: "primary" },
      { connectionId: "demo-work", itemId: "primary" },
    ],
    ask: "rejected-elsewhere",
    rejectedElsewhere: true,
  });
  await mount(client, "https://bank.example/", choices);
  await expect
    .element(page.getByText("The site did not accept a login in another tab.", { exact: true }))
    .toBeVisible();
  const offered = page.getByRole("group", { name: "Account to log in with" });
  await expect.element(offered.getByRole("radio").first()).not.toBeChecked();
  await expect.element(offered.getByRole("radio").last()).not.toBeChecked();
  await expect.element(page.getByRole("button", { name: "Log in" })).toBeDisabled();
});

test("after a stopped login, the popup asks even with one account", async () => {
  const { client } = store();
  const choices = noChoice();
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "signed-out",
    candidates: [{ connectionId: "demo-work", itemId: "primary" }],
    ask: "stopped-login",
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

/** The worker's answer about the tab's page, on bank.example. */
function onPage(
  fields: Partial<Extract<Awaited<ReturnType<ChoiceClient["status"]>>, { ok: true }>>,
) {
  const choices = noChoice();
  choices.status.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    recipe: "none",
    ...fields,
  });
  return choices;
}
/** A line of the page section by its id, as the popup shows it. */
const lineText = (id: string) => document.querySelector(`#popup-page-${id}`)?.textContent;
const pageLines = () =>
  [...document.querySelectorAll("#popup-page-status > li")].map((item) => [
    item.id,
    item.textContent,
  ]);

test("the page section shows a recipe on the page and a login that signed in", async () => {
  const { client } = store();
  const choices = onPage({ recipe: "page", login: { state: "authenticated" } });
  await mount(client, "https://bank.example/login", choices);
  await expect.element(page.getByRole("heading", { name: "This page" })).toBeVisible();
  await expect.poll(() => lineText("login")).toBe("Logged in.");
  expect(pageLines()).toEqual([
    ["popup-page-recipe", "This site has a recipe for this page."],
    ["popup-page-login", "Logged in."],
  ]);
  expect(choices.status).toHaveBeenCalledWith(7);
  // The section comes first, before the site's accounts.
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
  const section = document.querySelector("#popup-page-status")!;
  const accounts = page.getByRole("group", { name: "Default account" }).element();
  expect(section.compareDocumentPosition(accounts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the page section says why a page without a recipe was not sent to the AI", async () => {
  const { client } = store();
  await mount(client, "https://bank.example/login", onPage({ page: { generationSkip: "sent" } }));
  await expect
    .poll(() => lineText("generation-skip"))
    .toBe(
      "Not sent to the AI: the AI was asked about this page within the last 10 minutes, so it is not asked again yet.",
    );
  expect(pageLines()).toEqual([
    ["popup-page-recipe", "This site has no recipe yet."],
    ["popup-page-generation-skip", expect.stringContaining("Not sent to the AI")],
  ]);
});

test("the page section follows a request to the AI while the popup stays open", async () => {
  const { client } = store();
  const choices = onPage({
    asking: true,
    page: { state: "generating" },
    generation: { outcome: "sent" },
  });
  fakePolls();
  await mount(client, "https://bank.example/login", choices);
  await expect
    .poll(() => lineText("generation"))
    .toBe("The AI is making a recipe for the site's sign-in page…");
  choices.status.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    recipe: "page",
    page: { state: "generating" },
    generation: { outcome: "recipe" },
  });
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await expect
    .poll(() => lineText("generation"))
    .toBe("The AI made a recipe for the site's sign-in page.");
  await expect.poll(() => lineText("recipe")).toBe("This site has a recipe for this page.");
});

test("the page section shows a failed request to the AI", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/login",
    onPage({ generation: { outcome: "failed", reason: "invalid-output", page: "accounts" } }),
  );
  await expect
    .poll(() => lineText("generation"))
    .toBe(
      "The AI could not make a recipe for the site's list of accounts (failed: invalid-output).",
    );
});

test("the page section says a recipe that did not match the page is not made again", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/login",
    onPage({ recipe: "page", login: { state: "blocked", outcome: "structural-mismatch" } }),
  );
  await expect
    .poll(() => lineText("login"))
    .toBe("The login did not succeed: the page did not match the recipe.");
  await expect
    .poll(() => lineText("login-recipe"))
    .toBe("This recipe is not made again automatically.");
});

test("the page section reads a cancelled login as stopped", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/login",
    onPage({ recipe: "page", login: { state: "blocked", outcome: "cancelled" } }),
  );
  await expect.poll(() => lineText("login")).toBe("The login stopped: the login was cancelled.");
  expect(document.querySelector("#popup-page-login-recipe")).toBeNull();
});

// Netflix in the owner's Chrome: the AI made a recipe, but the only item has neither a
// password nor a passkey.
test("the page section says a vault item without a password or passkey stopped the login", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/login",
    onPage({
      recipe: "page",
      generation: { outcome: "recipe" },
      refused: { reason: "no-route", detail: "password-empty:no-passkey" },
    }),
  );
  await expect
    .poll(() => lineText("refused"))
    .toBe("Pateat did not log in: the vault item has neither a password nor a passkey.");
  expect(pageLines()).toEqual([
    ["popup-page-recipe", "This site has a recipe for this page."],
    ["popup-page-generation", "The AI made a recipe for the site's sign-in page."],
    [
      "popup-page-refused",
      "Pateat did not log in: the vault item has neither a password nor a passkey.",
    ],
  ]);
});

test("the page section is hidden for a page the worker does not describe", async () => {
  const { client } = store();
  const choices = noChoice();
  fakePolls();
  await mount(client, "https://bank.example/login", choices);
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
  // The second read follows the first answer, so that answer has been rendered.
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await expect.poll(() => choices.status.mock.calls.length).toBeGreaterThan(1);
  expect(page.getByRole("heading", { name: "This page" }).query()).toBeNull();
  expect(document.querySelector("#popup-page-status")).toBeNull();
});

test("the page section is hidden for another origin than the popup's", async () => {
  const { client } = store();
  // The tab moved on to another site after the popup read its address.
  const other = noChoice();
  other.status.mockResolvedValue({
    ok: true,
    origin: "https://other.example",
    recipe: "page",
    login: { state: "authenticated" },
  });
  fakePolls();
  await mount(client, "https://bank.example/login", other);
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
  // The second read follows the first answer, so that answer has been rendered.
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await expect.poll(() => other.status.mock.calls.length).toBeGreaterThan(1);
  expect(page.getByRole("heading", { name: "This page" }).query()).toBeNull();
  expect(document.querySelector("#popup-page-status")).toBeNull();
});

test("a tab Pateat cannot run on asks nothing about its page", async () => {
  const { client } = store();
  const choices = noChoice();
  await mount(client, "chrome://newtab/", choices);
  await expect.element(page.getByText("Pateat works on websites", { exact: false })).toBeVisible();
  expect(choices.status).not.toHaveBeenCalled();
});

test("the page section opens the detailed log", async () => {
  const { client } = store();
  const host = await mount(
    client,
    "https://bank.example/login",
    onPage({ recipe: "page", login: { state: "authenticated" } }),
  );
  const link = page.getByRole("link", { name: "Open the detailed log" });
  await expect.element(link).toBeVisible();
  await userEvent.click(link);
  expect(host.openDiagnostics).toHaveBeenCalledOnce();
  expect(host.openSettings).not.toHaveBeenCalled();
  expect(host.close).not.toHaveBeenCalled();
});

test("settings that hide the page section hide it and its log link, and stop asking", async () => {
  const hidden = { ...createDefaultSettings(), popupPageSection: false };
  const { client, replace } = store(saved(0, hidden));
  const choices = onPage({ recipe: "page", login: { state: "authenticated" } });
  fakePolls();
  const host = await mount(client, "https://bank.example/login", choices);
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
  await vi.advanceTimersByTimeAsync(POLL_MS * 2);
  expect(choices.status).not.toHaveBeenCalled();
  expect(page.getByRole("heading", { name: "This page" }).query()).toBeNull();
  expect(page.getByRole("link", { name: "Open the detailed log" }).query()).toBeNull();
  // Shown again from the settings page, or by another device's sync, while the popup is open.
  replace(saved(1, createDefaultSettings()));
  host.settingsChanged();
  await expect.element(page.getByRole("heading", { name: "This page" })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Open the detailed log" })).toBeVisible();
  expect(choices.status).toHaveBeenCalledWith(7);
  // Hidden again: the polling stops.
  replace(saved(2, hidden));
  host.settingsChanged();
  await expect.poll(() => document.querySelector("#popup-page-status")).toBeNull();
  const asked = choices.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(choices.status).toHaveBeenCalledTimes(asked);
});

test("the page section says when a request sent to the AI has no answer and none is in flight", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/login",
    // The page still says generating, but the badge no longer spins.
    onPage({ page: { state: "generating" }, generation: { outcome: "sent", page: "entry" } }),
  );
  await expect
    .poll(() => lineText("generation"))
    .toBe("A page was sent to the AI for the site's sign-in link, and no answer was recorded.");
  expect(document.querySelector("#popup-page-asking")).toBeNull();
});

test("the page section shows another request to the AI in flight", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/account",
    onPage({ recipe: "page", asking: true, login: { state: "awaiting-result" } }),
  );
  await expect.poll(() => lineText("asking")).toBe("Waiting for an answer from the AI…");
  expect(pageLines()).toEqual([
    ["popup-page-recipe", "This site has a recipe for this page."],
    ["popup-page-asking", "Waiting for an answer from the AI…"],
    ["popup-page-login", "Logging in…"],
  ]);
});

test("the page section says why a page of a site whose recipe starts elsewhere was not sent", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/help",
    onPage({ recipe: "other-paths", page: { generationSkip: "nothing-offered" } }),
  );
  await expect
    .poll(() => lineText("generation-skip"))
    .toBe("Not sent to the AI: the page showed no sign-in form.");
  expect(pageLines()).toEqual([
    ["popup-page-recipe", "This site has a recipe, but none starts on this page."],
    ["popup-page-generation-skip", "Not sent to the AI: the page showed no sign-in form."],
  ]);
});

test("the page section says why the tab waits for a choice", async () => {
  const { client } = store();
  const choices = onPage({ recipe: "page", page: { state: "denied", reason: "relogin-limit" } });
  fakePolls();
  await mount(client, "https://bank.example/login", choices);
  await expect
    .poll(() => lineText("login"))
    .toBe(
      "No login started: Pateat logged in to this site twice in the last 10 minutes; choose an account to log in again.",
    );
  choices.status.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    recipe: "page",
    page: { state: "denied", reason: "account-asked" },
  });
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await expect
    .poll(() => lineText("login"))
    .toBe("No login started: Pateat waits for you to choose an account.");
});

test("the page section names the page's refusal over an older not-started reason", async () => {
  const { client } = store();
  await mount(
    client,
    "https://bank.example/login",
    onPage({
      recipe: "page",
      page: { state: "denied", reason: "origin-busy", notStarted: "logged-in" },
    }),
  );
  await expect
    .poll(() => lineText("login"))
    .toBe("No login started: another tab's login to this site is running or did not succeed.");
});

test("each matching account can be switched to, the tab's account is marked, and a refusal is said (ADR 0063)", async () => {
  const { client } = store();
  const choices = onPage({
    recipe: "page",
    used: { connectionId: "demo-personal", itemId: "primary" },
  });
  choices.switchTo.mockResolvedValueOnce({ ok: false, reason: "site-held" });
  await mount(client, "https://bank.example/home", choices);
  await expect.element(page.getByRole("heading", { name: "Switch account" })).toBeVisible();
  const buttons = page.getByRole("button", { name: /^Switch to this account/ });
  await expect.poll(() => buttons.elements().length).toBe(3);
  // The account of the tab's last login is marked in the default list too.
  await expect
    .element(
      page.getByRole("radio", {
        name: "Demo primary account, Demo personal vault, used in this tab",
      }),
    )
    .toBeVisible();
  const secondary = page.getByRole("button", {
    name: "Switch to this account: Demo secondary account, Demo personal vault",
  });
  await userEvent.click(secondary);
  await expect
    .element(
      page.getByText(
        "Another tab's login or account switch on this site is running or waits for a code. Finish or close it, then try again.",
      ),
    )
    .toBeVisible();
  expect(choices.switchTo).toHaveBeenCalledWith({
    tabId: 7,
    connectionId: "demo-personal",
    itemId: "secondary",
    makeDefault: false,
  });
  // Made the default only when asked; the popup itself saves nothing.
  await userEvent.click(
    page.getByRole("checkbox", { name: "Make it the default for bank.example" }),
  );
  await userEvent.click(secondary);
  expect(choices.switchTo).toHaveBeenLastCalledWith({
    tabId: 7,
    connectionId: "demo-personal",
    itemId: "secondary",
    makeDefault: true,
  });
  expect(client.saveSettings).not.toHaveBeenCalled();
  await expect
    .element(page.getByText("may log you out of that account too", { exact: false }))
    .toBeVisible();
});

test("the switch's line follows the worker, and a running switch takes no second press (ADR 0063)", async () => {
  const { client } = store();
  const choices = onPage({
    switch: {
      state: "failed",
      reason: "no-logout-control",
      connectionId: "demo-personal",
      itemId: "secondary",
    },
  });
  await mount(client, "https://bank.example/home", choices);
  await expect
    .element(
      page.getByText(
        "Pateat found no way to log out on this page, so it did not switch to Demo secondary account. Log out yourself, then choose the account.",
      ),
    )
    .toBeVisible();
  choices.status.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    recipe: "none",
    switch: { state: "running", connectionId: "demo-work", itemId: "primary" },
  });
  await expect.element(page.getByText("Logging out to switch to Demo team account…")).toBeVisible();
  for (const button of page.getByRole("button", { name: /^Switch to this account/ }).elements())
    expect((button as HTMLButtonElement).disabled).toBe(true);
});

test("a page that waits for an account choice offers no switch (ADR 0063)", async () => {
  const { client } = store();
  const choices = onPage({ recipe: "page" });
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
  await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Switch account" }))
    .not.toBeInTheDocument();
});

test("a site Pateat logs in to by itself can be paused for 10 minutes or an hour, then resumed (ADR 0062)", async () => {
  const { client } = store();
  const choices = onPage({ recipe: "page" });
  await mount(client, "https://bank.example/login", choices);
  // The row sits in the header and offers each length.
  const row = page.getByRole("group", { name: "Pause automatic login" });
  await expect.element(row).toBeVisible();
  let until = 0;
  choices.pause.mockImplementation(async (_tabId, change) => {
    until = Date.now() + (change.paused && change.length === "10m" ? 10 : 60) * 60_000;
    choices.status.mockResolvedValue({
      ok: true,
      origin: "https://bank.example",
      recipe: "page",
      ...(change.paused ? { pause: { until } } : {}),
    });
    return change.paused ? { ok: true, until } : { ok: true };
  });
  const clock = () =>
    new Date(until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const pauseFor = async (label: string, length: "10m" | "1h", done: string) => {
    await userEvent.click(row.getByRole("button", { name: label }));
    expect(choices.pause).toHaveBeenLastCalledWith(7, { paused: true, length });
    await expect.element(page.getByText(`Paused until ${clock()}`, { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(`Automatic login on this site is paused ${done}.`))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Resume" }));
    expect(choices.pause).toHaveBeenLastCalledWith(7, { paused: false });
    await expect.element(row).toBeVisible();
    await expect.element(page.getByText("Automatic login on this site resumed.")).toBeVisible();
  };
  await pauseFor("10 minutes", "10m", "for 10 minutes");
  await pauseFor("1 hour", "1h", "for an hour");
});

test("settings that hide the page section keep the pause row, read from the pause alone (ADR 0062)", async () => {
  const hidden = { ...createDefaultSettings(), popupPageSection: false };
  const { client, current } = store(saved(0, hidden));
  const choices = onPage({
    recipe: "page",
    used: { connectionId: "demo-personal", itemId: "primary" },
  });
  let until = 0;
  choices.pause.mockImplementation(async (_tabId, change) => {
    until = change.paused ? Date.now() + 10 * 60_000 : 0;
    choices.pauseState.mockResolvedValue(change.paused ? { ok: true, until } : { ok: true });
    return change.paused ? { ok: true, until } : { ok: true };
  });
  await mount(client, "https://bank.example/home", choices);
  const row = page.getByRole("group", { name: "Pause automatic login" });
  await expect.element(row).toBeVisible();
  await Promise.all(
    ["10 minutes", "1 hour", "Until turned back on"].map((length) =>
      expect.element(row.getByRole("button", { name: length })).toBeVisible(),
    ),
  );
  // Switch account belongs to the hidden section, which reads the page status.
  expect(page.getByRole("heading", { name: "Switch account" }).query()).toBeNull();
  await userEvent.click(row.getByRole("button", { name: "10 minutes" }));
  expect(choices.pause).toHaveBeenLastCalledWith(7, { paused: true, length: "10m" });
  const clock = new Date(until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  await expect.element(page.getByText(`Paused until ${clock}`, { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Resume" }));
  expect(choices.pause).toHaveBeenLastCalledWith(7, { paused: false });
  await expect.element(page.getByText("Automatic login on this site resumed.")).toBeVisible();
  await userEvent.click(row.getByRole("button", { name: "Until turned back on" }));
  await expect
    .element(page.getByText("Paused until turned back on", { exact: true }))
    .toBeVisible();
  expect(current().snapshot.settings.excludedSites).toEqual([
    { hostname: "bank.example", includeSubdomains: true },
  ]);
  expect(choices.pauseState).toHaveBeenCalledWith(7);
  expect(choices.status).not.toHaveBeenCalled();
});

test("no pause is offered where nothing matches and the site has no recipe", async () => {
  const { client } = store();
  const choices = onPage({ origin: "https://nothing.example", recipe: "none" });
  await mount(client, "https://nothing.example/", choices);
  await expect
    .element(page.getByText("No vault item matches this site", { exact: false }))
    .toBeVisible();
  expect(page.getByRole("group", { name: "Pause automatic login" }).query()).toBeNull();
});

test("a paused page offers even its only matching account (ADR 0062)", async () => {
  const { client } = store();
  const choices = onPage({ recipe: "page", pause: { until: Date.now() + 60_000 } });
  choices.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    documentId: "paused",
    candidates: [{ connectionId: "demo-work", itemId: "primary" }],
    paused: true,
  });
  await mount(client, "https://bank.example/", choices);
  await expect
    .element(page.getByText("Automatic login is paused on this site.", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("group", { name: "Account to log in with" }).getByRole("radio"))
    .toHaveLength(1);
  await expect.element(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Log in" }));
  expect(choices.pick).toHaveBeenCalledWith(
    expect.objectContaining({ documentId: "paused", connectionId: "demo-work" }),
  );
});

// Personal details during a login (ADR 0061). Synthetic vault labels only; no value is
// ever in an answer.
const personal = {
  connectionId: "demo-personal",
  itemId: "identity-1",
  fieldId: "birth",
  itemLabel: "本人",
  fieldLabel: "生年月日",
};
const family = {
  connectionId: "demo-personal",
  itemId: "identity-2",
  fieldId: "dob",
  itemLabel: "Family",
  fieldLabel: "Date of birth",
};

function withDetails(answer: Partial<Extract<DetailResponse, { ok: true }>>) {
  const details = noDetails();
  details.get.mockResolvedValue({ ok: true, origin: "https://bank.example", links: [], ...answer });
  return details;
}
const birthOffer = {
  documentId: "detail-document",
  details: [
    { detail: "birth-date" as const, format: "yyyymm" as const, candidates: [personal, family] },
  ],
};

test("a page that asks for a detail offers the vault fields, the best guess selected", async () => {
  const { client } = store();
  const details = withDetails({ offer: birthOffer });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  const asks = page.getByRole("group", { name: "This page asks for your birth year and month." });
  await expect.element(asks).toBeVisible();
  expect(details.get).toHaveBeenCalledWith(7);
  // The section is part of "This page", even when the worker describes nothing else.
  await expect.element(page.getByRole("heading", { name: "This page" })).toBeVisible();
  await expect.element(asks.getByRole("radio")).toHaveLength(2);
  await expect.element(asks.getByRole("radio", { name: "本人 › 生年月日" })).toBeChecked();
  await expect
    .element(asks.getByRole("radio", { name: "Family › Date of birth" }))
    .not.toBeChecked();
  // The answer refetched every second keeps the person's pick.
  await userEvent.click(page.getByText("Family › Date of birth"));
  const calls = details.get.mock.calls.length;
  await expect.poll(() => details.get.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(calls);
  await expect.element(asks.getByRole("radio", { name: "Family › Date of birth" })).toBeChecked();
});

test("settings that hide the page's status still offer the details a page asks for", async () => {
  const hidden = { ...createDefaultSettings(), popupPageSection: false };
  const { client } = store(saved(0, hidden));
  const choices = onPage({ recipe: "page", login: { state: "authenticated" } });
  const details = withDetails({ offer: birthOffer });
  await mount(client, "https://bank.example/login", choices, false, undefined, details);
  // The offer is something to do on the page, not its status, so it stays.
  await expect
    .element(page.getByRole("group", { name: "This page asks for your birth year and month." }))
    .toBeVisible();
  expect(choices.status).not.toHaveBeenCalled();
  expect(document.querySelector("#popup-page-status")).toBeNull();
  expect(page.getByRole("link", { name: "Open the detailed log" }).query()).toBeNull();
});

test("Fill fills the picked field in the offer's document and says to check and submit", async () => {
  const { client } = store();
  const details = withDetails({ offer: birthOffer });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  const fill = page.getByRole("button", { name: "Fill" });
  await expect.element(fill).toBeVisible();
  await userEvent.click(page.getByText("Family › Date of birth"));
  // The link is kept for the tab, not saved yet, once the fill is done.
  details.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    offer: birthOffer,
    links: [
      { detail: "birth-date", itemLabel: "Family", fieldLabel: "Date of birth", pending: true },
    ],
  });
  await userEvent.click(fill);
  await expect
    .element(
      page.getByText(
        "Filled. Check it and submit the form; Pateat saves this choice once you are signed in.",
      ),
    )
    .toBeVisible();
  expect(details.fill).toHaveBeenCalledExactlyOnceWith({
    tabId: 7,
    documentId: "detail-document",
    detail: "birth-date",
    connectionId: "demo-personal",
    itemId: "identity-2",
    fieldId: "dob",
  });
  await expect
    .element(page.getByText("Filled from Family › Date of birth (not saved yet)"))
    .toBeVisible();
  // Fill keeps focus, since it stays on the page.
  expect(document.activeElement).toBe(fill.element());
  // The popup fills nothing by itself and saves no settings.
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("a Fill that filled nothing says why", async () => {
  const { client } = store();
  const details = withDetails({ offer: birthOffer });
  details.fill.mockResolvedValue({ ok: false, reason: "unavailable" });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  await userEvent.click(page.getByRole("button", { name: "Fill" }));
  await expect
    .element(page.getByText("Pateat cannot read that field now. Unlock the vault and try again."))
    .toBeVisible();
  expect(details.fill).toHaveBeenCalledWith(
    expect.objectContaining({ detail: "birth-date", itemId: "identity-1", fieldId: "birth" }),
  );
  expect(page.getByText("Filled.", { exact: false }).query()).toBeNull();
});

test("a secret question the AI paired with a field named otherwise is proposed for the owner to confirm", async () => {
  const { client } = store();
  const answerField = {
    connectionId: "demo-personal",
    itemId: "login-1",
    fieldId: "custom.1",
    itemLabel: "Bank",
    fieldLabel: "お母さんの旧姓",
  };
  const details = withDetails({
    offer: {
      documentId: "detail-document",
      details: [{ detail: "secret-answer", candidates: [answerField], question: "母親の旧姓は" }],
    },
  });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  const asks = page.getByRole("group", { name: "This page asks \u201C母親の旧姓は\u201D." });
  await expect.element(asks).toBeVisible();
  await expect.element(asks.getByRole("radio", { name: "Bank › お母さんの旧姓" })).toBeChecked();
  const fill = page.getByRole("button", { name: "Fill" });
  // The Fill button says what it confirms.
  await expect
    .element(fill)
    .toHaveAccessibleDescription(
      "This page asks \u201C母親の旧姓は\u201D. Pateat\u2019s AI thinks this field holds the answer. Fill only if it does; Pateat then fills it whenever this question shows.",
    );
  // Nothing is filled or saved before the owner presses Fill.
  expect(details.fill).not.toHaveBeenCalled();
  await userEvent.click(fill);
  expect(details.fill).toHaveBeenCalledExactlyOnceWith({
    tabId: 7,
    documentId: "detail-document",
    detail: "secret-answer",
    connectionId: "demo-personal",
    itemId: "login-1",
    fieldId: "custom.1",
  });
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("a paused site still offers a fill, as only a login picked in the popup stops there (ADR 0062)", async () => {
  const settings = createDefaultSettings();
  settings.excludedSites.push({ hostname: "bank.example", includeSubdomains: true });
  const { client } = store(saved(0, settings));
  const details = withDetails({ offer: birthOffer });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  await expect
    .element(page.getByText("Paused until turned back on", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Fill" })).toBeVisible();
});

test("the site's links are listed with their vault labels and removed", async () => {
  const { client } = store();
  const details = withDetails({
    links: [
      { detail: "birth-date", itemLabel: "本人", fieldLabel: "生年月日" },
      { detail: "card-code", itemLabel: "Visa", fieldLabel: "Security code", pending: true },
    ],
  });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  const links = page.getByRole("list", { name: "Personal details Pateat fills on this site" });
  await expect.element(links).toBeVisible();
  expect(
    [...document.querySelectorAll("#popup-detail-links > li")].map((item) => item.textContent),
  ).toEqual([
    "Your birth dateFilled from 本人 › 生年月日Remove",
    "Your card's security codeFilled from Visa › Security code (not saved yet)Remove",
  ]);
  // No offer, so nothing to fill.
  expect(page.getByRole("button", { name: "Fill" }).query()).toBeNull();
  const remove = page.getByRole("button", { name: "Remove the link for your birth date" });
  details.get.mockResolvedValue({
    ok: true,
    origin: "https://bank.example",
    links: [{ detail: "card-code", itemLabel: "Visa", fieldLabel: "Security code", pending: true }],
  });
  await userEvent.click(remove);
  await expect
    .element(page.getByText("Removed. Pateat no longer fills your birth date on this site."))
    .toBeVisible();
  expect(details.remove).toHaveBeenCalledExactlyOnceWith(7, "birth-date");
  await expect.element(remove).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Remove the link for your card's security code" }))
    .toBeVisible();
  // The removed row's button is gone, so the result message takes focus.
  await expect.poll(() => document.activeElement).toBe(resultMessage());
});

test("a Remove that saves nothing says so", async () => {
  const { client } = store();
  const details = withDetails({
    links: [{ detail: "phone-last-4", itemLabel: "本人", fieldLabel: "Phone" }],
  });
  details.remove.mockResolvedValue({ ok: false, reason: "not-saved" });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  await userEvent.click(
    page.getByRole("button", {
      name: "Remove the link for the last 4 digits of your phone number",
    }),
  );
  await expect
    .element(page.getByText("The link could not be removed. Reopen this popup and try again."))
    .toBeVisible();
});

test("a page without a detail to fill or a link shows no detail section", async () => {
  const { client } = store();
  const details = noDetails();
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
  // The second read follows the first answer, so that answer has been rendered.
  await expect.poll(() => details.get.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(1);
  expect(page.getByRole("heading", { name: "This page" }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Fill" }).query()).toBeNull();
  expect(document.querySelector("#popup-detail-links")).toBeNull();
});

test("details for another origin than the popup's are not shown", async () => {
  const { client } = store();
  const details = withDetails({ offer: birthOffer });
  details.get.mockResolvedValue({
    ok: true,
    origin: "https://other.example",
    offer: birthOffer,
    links: [{ detail: "birth-date", itemLabel: "本人", fieldLabel: "生年月日" }],
  });
  await mount(client, "https://bank.example/login", noChoice(), false, undefined, details);
  await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
  await expect.poll(() => details.get.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(1);
  expect(page.getByRole("heading", { name: "This page" }).query()).toBeNull();
});

test("a tab Pateat cannot run on asks nothing about its details", async () => {
  const { client } = store();
  const details = noDetails();
  await mount(client, "chrome://newtab/", noChoice(), false, undefined, details);
  await expect.element(page.getByText("Pateat works on websites", { exact: false })).toBeVisible();
  expect(details.get).not.toHaveBeenCalled();
});

/** The demo catalog with its first `count` vaults locked (ADR 0075). */
function withLocked(count: number) {
  const value = saved(0);
  value.catalog.connections = value.catalog.connections.map((connection, index) =>
    index < count ? { ...connection, state: "locked" as const, groups: [], items: [] } : connection,
  );
  return value;
}

test("a locked vault is named with a link to unlock it in settings", async () => {
  expect(DUMMY_VAULT_CATALOG.connections.length).toBeGreaterThanOrEqual(2);
  const { client } = store(withLocked(1));
  const host = await mount(client, "https://bank.example/login");
  const notice = page.getByText("1 vault is locked, so its logins and passkeys wait.", {
    exact: false,
  });
  await expect.element(notice).toBeVisible();
  expect(document.querySelector("#popup-vault-locked")?.textContent).toContain(
    "Unlock in settings",
  );
  await userEvent.click(page.getByRole("link", { name: "Unlock in settings", exact: true }));
  expect(host.openSettings).toHaveBeenCalledOnce();
  expect(client.saveSettings).not.toHaveBeenCalled();
});

test("the locked notice counts every locked vault", async () => {
  const { client } = store(withLocked(2));
  await mount(client, "https://bank.example/login");
  await expect
    .element(
      page.getByText("2 vaults are locked, so their logins and passkeys wait.", { exact: false }),
    )
    .toBeVisible();
});

test("no locked notice shows while every vault is open", async () => {
  const { client } = store();
  await mount(client, "https://bank.example/login");
  await expect.poll(() => client.findSiteAccounts.mock.calls.length).toBeGreaterThan(0);
  expect(document.querySelector("#popup-vault-locked")).toBeNull();
});
