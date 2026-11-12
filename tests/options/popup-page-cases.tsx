import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createDefaultSettings } from "../../packages/contracts/src/index";
import type { PopupTestContext } from "./popup.test";

export function registerPopupPageCases({
  saved,
  store,
  noChoice,
  mount,
  POLL_MS,
  fakePolls,
  onPage,
  lineText,
  pageLines,
}: Pick<
  PopupTestContext,
  | "saved"
  | "store"
  | "noChoice"
  | "mount"
  | "POLL_MS"
  | "fakePolls"
  | "onPage"
  | "lineText"
  | "pageLines"
>) {
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
    expect(
      section.compareDocumentPosition(accounts) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    await expect
      .element(page.getByText("Pateat works on websites", { exact: false }))
      .toBeVisible();
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
    await expect
      .element(page.getByText("Logging out to switch to Demo team account…"))
      .toBeVisible();
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
      await expect
        .element(page.getByText(`Paused until ${clock()}`, { exact: true }))
        .toBeVisible();
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
    const clock = new Date(until).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
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
}
