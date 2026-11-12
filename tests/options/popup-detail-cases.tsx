import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ManualClient } from "../../apps/extension/src/login/manual-wire";
import { createDefaultSettings, DUMMY_VAULT_CATALOG } from "../../packages/contracts/src/index";
import type { PopupTestContext } from "./popup.test";

export function registerPopupDetailCases({
  saved,
  store,
  noChoice,
  noDetails,
  mount,
  resultMessage,
  onPage,
  withDetails,
  birthOffer,
}: Pick<
  PopupTestContext,
  | "saved"
  | "store"
  | "noChoice"
  | "noDetails"
  | "mount"
  | "resultMessage"
  | "onPage"
  | "withDetails"
  | "birthOffer"
>) {
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
    await expect
      .poll(() => details.get.mock.calls.length, { timeout: 3000 })
      .toBeGreaterThan(calls);
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
      links: [
        { detail: "card-code", itemLabel: "Visa", fieldLabel: "Security code", pending: true },
      ],
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
    await expect
      .element(page.getByText("Pateat works on websites", { exact: false }))
      .toBeVisible();
    expect(details.get).not.toHaveBeenCalled();
  });
}

export function registerPopupAvailabilityCases({
  saved,
  store,
  noChoice,
  noDetails,
  mount,
  withLocked,
}: Pick<PopupTestContext, "saved" | "store" | "noChoice" | "noDetails" | "mount" | "withLocked">) {
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

  test("hiding This page keeps the one-time login available and its pending status visible", async () => {
    const hidden = { ...createDefaultSettings(), popupPageSection: false };
    const { client } = store(saved(0, hidden));
    const choices = noChoice();
    const document = {
      origin: "https://bank.example",
      tabId: 7,
      frameId: 0,
      documentId: "manual-page",
    };
    let requestId = "";
    const manual = {
      get: vi.fn<ManualClient["get"]>().mockImplementation(async () =>
        requestId
          ? { ok: true, targets: [], status: { requestId, state: "generating" } }
          : {
              ok: true,
              targets: [
                {
                  document,
                  scope: "scope",
                  candidates: [{ connectionId: "demo-personal", itemId: "primary" }],
                },
              ],
            },
      ),
      start: vi.fn<ManualClient["start"]>().mockImplementation(async (request) => {
        requestId = request.requestId;
        return { ok: true, state: "generating" };
      }),
    };
    await mount(
      client,
      "https://bank.example/login",
      choices,
      false,
      undefined,
      noDetails(),
      manual,
    );
    await expect
      .element(page.getByRole("heading", { name: "Log in now", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "This page", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Log in now", exact: true }));
    expect(manual.get).toHaveBeenCalledWith(7);
    expect(manual.start).toHaveBeenCalledTimes(1);
    await expect
      .element(page.getByText("Checking the page before starting the login…"))
      .toBeVisible();
    expect(choices.status).not.toHaveBeenCalled();
    expect(client.saveSettings).not.toHaveBeenCalled();
  });
}
