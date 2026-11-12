import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
import { createDefaultSettings } from "../../packages/contracts/src/index";
import type { PopupTestContext } from "./popup.test";

export function registerPopupChoiceCases({
  saved,
  demoSiteAccounts,
  store,
  noChoice,
  mount,
  POLL_MS,
  fakePolls,
  pageOf,
}: Pick<
  PopupTestContext,
  "saved" | "demoSiteAccounts" | "store" | "noChoice" | "mount" | "POLL_MS" | "fakePolls" | "pageOf"
>) {
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
    await userEvent.click(
      offered.getByRole("radio", { name: "Demo team account, Demo work vault" }),
    );
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

  test("a choice that waits in a frame of the page is for the frame's site (ADR 0086)", async () => {
    const { client } = store();
    const choices = noChoice();
    choices.get.mockResolvedValue({
      ok: true,
      origin: "https://login.bank.example",
      documentId: "frame-document",
      frame: true,
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
    });
    const host = await mount(client, "https://bank.example/login", choices);
    await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
    await expect
      .element(page.getByText("The sign-in form is embedded in this page from login.bank.example."))
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Make it the default for login.bank.example" }))
      .toBeChecked();
    // The page's own default list stays beside the frame's choice, named by its host.
    await expect
      .element(page.getByRole("group", { name: "Default account for bank.example" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Log in" }));
    expect(choices.pick).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, documentId: "frame-document", makeDefault: true }),
    );
    expect(host.close).toHaveBeenCalledOnce();
  });

  test("a choice in a frame of the page's own origin is shown as the page's", async () => {
    const { client } = store();
    const choices = noChoice();
    choices.get.mockResolvedValue({
      ok: true,
      origin: "https://bank.example",
      documentId: "frame-document",
      frame: true,
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
    });
    await mount(client, "https://bank.example/login", choices);
    await expect.element(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
    await expect
      .element(page.getByText("The sign-in form is embedded in this page from bank.example."))
      .not.toBeInTheDocument();
    // As for the page's own choice, it is the only list.
    await expect
      .element(page.getByRole("group", { name: "Default account" }))
      .not.toBeInTheDocument();
  });

  test("a choice of another site that does not wait in a frame is not shown", async () => {
    const { client } = store();
    const choices = noChoice();
    choices.get.mockResolvedValue({
      ok: true,
      origin: "https://login.bank.example",
      documentId: "other-document",
      candidates: [
        { connectionId: "demo-personal", itemId: "primary" },
        { connectionId: "demo-work", itemId: "primary" },
      ],
    });
    await mount(client, "https://bank.example/login", choices);
    await expect.element(page.getByRole("group", { name: "Default account" })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Choose an account" }))
      .not.toBeInTheDocument();
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
    await expect
      .element(page.getByText(/^Listing the accounts that match this page/))
      .toBeVisible();
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
      .element(
        page.getByText("The site did not accept the last login in this tab.", { exact: true }),
      )
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
    await userEvent.click(
      offered.getByRole("radio", { name: "Demo team account, Demo work vault" }),
    );
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
}
