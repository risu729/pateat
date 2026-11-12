import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ManualClient } from "../../apps/extension/src/login/manual-wire";
import type { ChoiceClient } from "../../apps/extension/src/login/choice-wire";
import type { DetailClient, DetailResponse } from "../../apps/extension/src/login/detail-wire";
import { SiteApp, type PopupHost } from "../../apps/extension/src/popup/site-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type LocalSettings,
  type SettingsResponse,
} from "../../packages/contracts/src/index";

import {
  registerPopupOpeningCases,
  registerPopupPolicyCases,
  registerPopupSettingsCases,
} from "./popup-settings-cases";
import { registerPopupChoiceCases } from "./popup-choice-cases";
import { registerPopupPageCases } from "./popup-page-cases";
import { registerPopupDetailCases, registerPopupAvailabilityCases } from "./popup-detail-cases";

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
    defaultChosen: vi.fn<ChoiceClient["defaultChosen"]>().mockResolvedValue({ ok: true }),
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
  manual?: ManualClient,
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
        {...(manual ? { manual } : {})}
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

registerPopupOpeningCases({ saved, demoSiteAccounts, store, noChoice, mount });

/** A status for a page of `origin`, where a pause is offered. */
function pageOf(origin: string, fields: Parameters<typeof onPage>[0] = {}) {
  return onPage({ origin, recipe: "page", ...fields });
}

registerPopupPolicyCases({ saved, store, noChoice, mount, pageOf });

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

registerPopupSettingsCases({
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
  get lineText() {
    return lineText;
  },
});

registerPopupChoiceCases({
  saved,
  demoSiteAccounts,
  store,
  noChoice,
  mount,
  POLL_MS,
  fakePolls,
  pageOf,
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

registerPopupPageCases({
  saved,
  store,
  noChoice,
  mount,
  POLL_MS,
  fakePolls,
  onPage,
  lineText,
  pageLines,
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

registerPopupDetailCases({
  saved,
  store,
  noChoice,
  noDetails,
  mount,
  resultMessage,
  onPage,
  withDetails,
  birthOffer,
});

/** The demo catalog with its first `count` vaults locked (ADR 0075). */
function withLocked(count: number) {
  const value = saved(0);
  value.catalog.connections = value.catalog.connections.map((connection, index) =>
    index < count ? { ...connection, state: "locked" as const, groups: [], items: [] } : connection,
  );
  return value;
}

registerPopupAvailabilityCases({ saved, store, noChoice, noDetails, mount, withLocked });

export type PopupTestContext = {
  saved: typeof saved;
  demoSiteAccounts: typeof demoSiteAccounts;
  store: typeof store;
  noChoice: typeof noChoice;
  noDetails: typeof noDetails;
  mount: typeof mount;
  POLL_MS: typeof POLL_MS;
  fakePolls: typeof fakePolls;
  fakeDeadline: typeof fakeDeadline;
  pageOf: typeof pageOf;
  pressWithKeyboard: typeof pressWithKeyboard;
  holdNextSave: typeof holdNextSave;
  resultMessage: typeof resultMessage;
  onPage: typeof onPage;
  lineText: typeof lineText;
  pageLines: typeof pageLines;
  withDetails: typeof withDetails;
  birthOffer: typeof birthOffer;
  withLocked: typeof withLocked;
};
