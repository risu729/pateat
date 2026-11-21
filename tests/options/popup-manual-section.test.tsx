import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ManualClient } from "../../apps/extension/src/login/manual-wire";
import type { ChoiceClient, ChoiceResponse } from "../../apps/extension/src/login/choice-wire";
import type { DetailClient } from "../../apps/extension/src/login/detail-wire";
import { SiteApp, type PopupHost } from "../../apps/extension/src/popup/site-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type LocalSettings,
  type SettingsResponse,
} from "../../packages/contracts/src/index";

// The popup's Log in now section inside the whole popup (ADR 0088), with synthetic clients.

const origin = "https://bank.example";
const saved = (settings: LocalSettings) =>
  ({
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 0, settings: structuredClone(settings) },
    catalog: structuredClone(DUMMY_VAULT_CATALOG),
  }) satisfies Extract<SettingsResponse, { ok: true }>;

async function mount(
  settings: LocalSettings,
  manual: ManualClient,
  choice: ChoiceResponse = { ok: false, reason: "no-choice" },
  listing?: SettingsClient["findSiteAccounts"],
) {
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>(async () => saved(settings)),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>(
      listing ??
        (async () => ({
          version: 1,
          ok: true,
          origin,
          accounts: [
            { connectionId: "demo-personal", itemId: "primary", uri: true, passkey: false },
          ],
          complete: true,
        })),
    ),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue(choice),
    pick: vi.fn<ChoiceClient["pick"]>().mockResolvedValue({ ok: true }),
    status: vi.fn<ChoiceClient["status"]>().mockResolvedValue({ ok: false, reason: "no-page" }),
    switchTo: vi.fn<ChoiceClient["switchTo"]>().mockResolvedValue({ ok: true }),
    pause: vi.fn<ChoiceClient["pause"]>().mockResolvedValue({ ok: true }),
    pauseState: vi.fn<ChoiceClient["pauseState"]>().mockResolvedValue({ ok: true }),
    reprompt: vi.fn<ChoiceClient["reprompt"]>(),
    defaultChosen: vi.fn<ChoiceClient["defaultChosen"]>().mockResolvedValue({ ok: true }),
  };
  const details = {
    get: vi.fn<DetailClient["get"]>().mockResolvedValue({ ok: true, origin, links: [] }),
    fill: vi.fn<DetailClient["fill"]>().mockResolvedValue({ ok: true }),
    remove: vi.fn<DetailClient["remove"]>().mockResolvedValue({ ok: true }),
  };
  const host = {
    currentTab: vi
      .fn<PopupHost["currentTab"]>()
      .mockResolvedValue({ id: 7, url: `${origin}/login`, incognito: false }),
    openSettings: vi.fn<PopupHost["openSettings"]>(),
    openDiagnostics: vi.fn<PopupHost["openDiagnostics"]>(),
    close: vi.fn<PopupHost["close"]>(),
    watchSettings: vi.fn<PopupHost["watchSettings"]>(() => () => undefined),
  };
  const query = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={query}>
      <SiteApp client={client} choices={choices} details={details} manual={manual} host={host} />
    </QueryClientProvider>,
  );
  return { client, choices, host, query };
}
afterEach(cleanup);

test("hiding This page keeps the one-time login available and its pending status visible", async () => {
  const document = { origin, tabId: 7, frameId: 0, documentId: "manual-page" };
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
    cancel: vi.fn<ManualClient["cancel"]>().mockResolvedValue({ ok: true }),
    fill: vi.fn<ManualClient["fill"]>(),
  };
  const h = await mount({ ...createDefaultSettings(), popupPageSection: false }, manual);
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
  expect(h.choices.status).not.toHaveBeenCalled();
  expect(h.client.saveSettings).not.toHaveBeenCalled();
  expect(h.host.close).not.toHaveBeenCalled();
});

test("a web page without a sign-in form is not asked to reload", async () => {
  const manual = {
    get: vi.fn<ManualClient["get"]>().mockResolvedValue({
      ok: true,
      targets: [],
      reason: "no-document",
    }),
    start: vi.fn<ManualClient["start"]>(),
    cancel: vi.fn<ManualClient["cancel"]>(),
    fill: vi.fn<ManualClient["fill"]>(),
  };
  await mount(createDefaultSettings(), manual);
  await expect.element(page.getByText("No sign-in form was found on this page.")).toBeVisible();
  await expect
    .element(page.getByText("The page changed or is not ready. Reload it, then try again."))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Log in now", exact: true }))
    .toBeDisabled();
});

// While the account choice shows, Log in now stays only for what the choice cannot do, after
// it (ADR 0088, amended 2026-11-21).
const primary = { connectionId: "demo-personal", itemId: "primary" };
const work = { connectionId: "demo-work", itemId: "primary" };
const choiceDocument = { origin, tabId: 7, frameId: 0, documentId: "refused-document" };
const offer = (extra: Partial<Extract<ChoiceResponse, { ok: true }>> = {}): ChoiceResponse => ({
  ok: true,
  origin,
  documentId: choiceDocument.documentId,
  candidates: [primary, work],
  ...extra,
});
const manualClient = (get: ManualClient["get"]) => ({
  get: vi.fn<ManualClient["get"]>().mockImplementation(get),
  start: vi.fn<ManualClient["start"]>(),
  cancel: vi.fn<ManualClient["cancel"]>().mockResolvedValue({ ok: true }),
  fill: vi.fn<ManualClient["fill"]>(),
});
const target = (document: typeof choiceDocument, scope = "scope") => ({
  document,
  scope,
  candidates: [primary, work],
});
const choiceHeading = () => page.getByRole("heading", { name: "Choose an account", exact: true });
const manualHeading = () => page.getByRole("heading", { name: "Log in now", exact: true });
/** Whether `later` comes after `first` in the popup. */
const follows = (first: Element, later: Element) =>
  Boolean(first.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

test("the account choice hides Log in now for the same document", async () => {
  const manual = manualClient(async () => ({ ok: true, targets: [target(choiceDocument)] }));
  const h = await mount(createDefaultSettings(), manual, offer());
  await expect.element(choiceHeading()).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in", exact: true })).toBeEnabled();
  // The offer was read, so the section is hidden by its answer, not only before it.
  await expect.poll(() => h.query.getQueryState(["popup", "manual", 7, 0])?.status).toBe("success");
  await expect.element(manualHeading()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Log in now", exact: true }))
    .not.toBeInTheDocument();
});

test("Log in now shows after the choice while another tab's login holds its Log in", async () => {
  const manual = manualClient(async () => ({ ok: true, targets: [target(choiceDocument)] }));
  await mount(createDefaultSettings(), manual, offer({ held: true }));
  await expect.element(choiceHeading()).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Log in", exact: true })).toBeDisabled();
  await expect.element(manualHeading()).toBeVisible();
  expect(follows(choiceHeading().element(), manualHeading().element())).toBe(true);
  await expect
    .element(page.getByRole("combobox", { name: "Account to log in with" }))
    .toBeVisible();
});

test("Log in now stays while a held choice's accounts are still being listed", async () => {
  const manual = manualClient(async () => ({ ok: true, targets: [target(choiceDocument)] }));
  // The listing never answers: the choice cannot show, and its Log in is held anyway.
  await mount(createDefaultSettings(), manual, offer({ held: true }), () => new Promise(() => {}));
  await expect.element(page.getByText("Listing the accounts that match this page…")).toBeVisible();
  await expect.element(manualHeading()).toBeVisible();
  await expect.element(choiceHeading()).not.toBeInTheDocument();
});

test("Log in now shows after the choice when it can log in to another document", async () => {
  const frame = { origin, tabId: 7, frameId: 3, documentId: "frame-document" };
  const manual = manualClient(async () => ({
    ok: true,
    targets: [target(choiceDocument), target(frame, "frame-scope")],
  }));
  await mount(createDefaultSettings(), manual, offer());
  await expect.element(choiceHeading()).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Page to log in to" })).toBeVisible();
  expect(follows(choiceHeading().element(), manualHeading().element())).toBe(true);
});

test("Log in now shows after the choice when it offers an account the choice does not", async () => {
  const secondary = { connectionId: "demo-personal", itemId: "secondary" };
  const manual = manualClient(async () => ({
    ok: true,
    targets: [{ ...target(choiceDocument), candidates: [primary, work, secondary] }],
  }));
  await mount(createDefaultSettings(), manual, offer());
  await expect.element(choiceHeading()).toBeVisible();
  await expect.element(manualHeading()).toBeVisible();
  expect(follows(choiceHeading().element(), manualHeading().element())).toBe(true);
});

test("a Log in now request at work stays visible after the choice with its Cancel", async () => {
  const manual = manualClient(async () => ({
    ok: true,
    targets: [],
    status: { requestId: "request", state: "generating" },
  }));
  await mount(createDefaultSettings(), manual, offer());
  await expect.element(choiceHeading()).toBeVisible();
  await expect
    .element(page.getByText("Checking the page before starting the login…"))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Cancel this login", exact: true }))
    .toBeEnabled();
  expect(follows(choiceHeading().element(), manualHeading().element())).toBe(true);
});

test("a request pressed here keeps its result when the choice shows, moved after it", async () => {
  let requestId = "";
  const manual = manualClient(async () => ({
    ok: true,
    targets: [target(choiceDocument)],
    ...(requestId
      ? { status: { requestId, state: "blocked" as const, reason: "page-changed" } }
      : {}),
  }));
  manual.start.mockImplementation(async (request) => {
    requestId = request.requestId;
    return { ok: false, reason: "page-changed" };
  });
  const h = await mount(createDefaultSettings(), manual);
  // Without a choice, Log in now comes first, before the default account list.
  await expect.element(manualHeading()).toBeVisible();
  await expect.element(page.getByText("Default account", { exact: true })).toBeVisible();
  expect(
    follows(
      manualHeading().element(),
      page.getByText("Default account", { exact: true }).element(),
    ),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: "Account to log in with" })
    .selectOptions(JSON.stringify([primary.connectionId, primary.itemId]));
  await userEvent.click(page.getByRole("button", { name: "Log in now", exact: true }));
  const result = "The page changed or is not ready. Reload it, then try again.";
  await expect.element(page.getByText(result)).toBeVisible();
  h.choices.get.mockResolvedValue(offer());
  await h.query.invalidateQueries({ queryKey: ["popup", "choice", 7] });
  await expect.element(choiceHeading()).toBeVisible();
  // The section moved rather than remounting, so this popup's result is still shown.
  await expect.element(page.getByText(result)).toBeVisible();
  expect(follows(choiceHeading().element(), manualHeading().element())).toBe(true);
});
