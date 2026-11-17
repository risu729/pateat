import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ManualClient } from "../../apps/extension/src/login/manual-wire";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
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

async function mount(settings: LocalSettings, manual: ManualClient) {
  const client = {
    getSettings: vi.fn<SettingsClient["getSettings"]>(async () => saved(settings)),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>(async () => ({
      version: 1,
      ok: true,
      origin,
      accounts: [{ connectionId: "demo-personal", itemId: "primary", uri: true, passkey: false }],
      complete: true,
    })),
  };
  const choices = {
    get: vi.fn<ChoiceClient["get"]>().mockResolvedValue({ ok: false, reason: "no-choice" }),
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
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SiteApp client={client} choices={choices} details={details} manual={manual} host={host} />
    </QueryClientProvider>,
  );
  return { client, choices, host };
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
