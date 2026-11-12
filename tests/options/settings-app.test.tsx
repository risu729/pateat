import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, expect, vi } from "vitest";
import { locators, page, type Locator } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import type { ServiceClient } from "../../apps/extension/src/options/service-client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import { registerSettingsChanges } from "./settings-app/settings-change-cases";
import { registerVaultPolicy } from "./settings-app/vault-policy-cases";
import { registerSitePolicy } from "./settings-app/site-policy-cases";
import { registerReloadAndDraft, registerSaveConflicts } from "./settings-app/saving-cases";
import { registerNavigationAndPreferences } from "./settings-app/navigation-preference-cases";

function saved(revision = 0, hostname?: string): Extract<SettingsResponse, { ok: true }> {
  const settings = createDefaultSettings();
  if (hostname) settings.excludedSites.push({ hostname, includeSubdomains: false });
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision, settings },
    catalog: structuredClone(DUMMY_VAULT_CATALOG),
  };
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

function mockClient() {
  return {
    findSiteAccounts: vi
      .fn<SettingsClient["findSiteAccounts"]>()
      .mockImplementation(demoSiteAccounts),
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(saved()),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockImplementation(async (request) => ({
      ...saved(request.expectedRevision + 1),
      snapshot: {
        version: 1,
        revision: request.expectedRevision + 1,
        settings: structuredClone(request.settings),
      },
    })),
  };
}

declare module "vitest/browser" {
  interface LocatorSelectors {
    getById(id: string): Locator;
  }
}

// Status/list text changes during a request; preserve the public control ID as its locator.
locators.extend({ getById: (id: string) => `css=#${CSS.escape(id)}` });

function control(id: string) {
  return page.getById(id);
}

async function mount(client: SettingsClient = mockClient(), serviceClient?: ServiceClient) {
  const queryClient = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsApp client={client} {...(serviceClient && { serviceClient })} />
    </QueryClientProvider>,
  );
  await expect.element(control("settings-status")).toMatchTextContent("Saved settings loaded");
  return { queryClient, client };
}

async function addSite(hostname: string) {
  await control("site-origin").fill(hostname);
  await control("add-site").click();
  await expect.element(control("site-list")).toMatchTextContent(hostname);
}

/** Vault-wide lists start collapsed; tests open them like the owner would. */
async function expand(connection: string, ...summaries: string[]) {
  const group = page.getByRole("group", { name: connection, exact: true });
  for (const summary of summaries) {
    // Nested disclosures open in order: an item's summary is hidden until its list opens.
    // oxlint-disable-next-line no-await-in-loop
    await group.getByText(new RegExp(`^${summary}`)).click();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  // Real timers first, so a failing cleanup cannot leave fake ones to later tests.
  vi.useRealTimers();
  await cleanup();
  focusManager.setFocused(undefined);
});

export type SettingsAppTestFixtures = {
  saved: typeof saved;
  demoSiteAccounts: typeof demoSiteAccounts;
  mockClient: typeof mockClient;
  control: typeof control;
  mount: typeof mount;
  addSite: typeof addSite;
  expand: typeof expand;
  deferred: typeof deferred;
  conflict: typeof conflict;
  written: typeof written;
  navLink: typeof navLink;
  disconnectedService: typeof disconnectedService;
};

registerSettingsChanges({ saved, mockClient, control, mount, addSite, deferred });

registerVaultPolicy({ saved, mockClient, control, mount, expand });

registerSitePolicy({ saved, demoSiteAccounts, mockClient, control, mount, addSite, deferred });

registerReloadAndDraft({ saved, mockClient, control, mount, addSite, deferred });

function conflict(
  ...causes: NonNullable<Extract<SettingsResponse, { ok: false }>["error"]["causes"]>
) {
  return {
    version: 1 as const,
    ok: false as const,
    error: {
      code: "revision-conflict" as const,
      message: "Synthetic newer revision exists.",
      causes,
    },
  };
}

/** A newer revision whose recorded causes start at revision 1. */
function written(
  causes: NonNullable<
    Extract<SettingsResponse, { ok: true }>["snapshot"]["changes"]
  >[number]["cause"][],
  hostname?: string,
) {
  const response = saved(causes.length, hostname);
  response.snapshot.changes = causes.map((cause, index) => ({ revision: index + 1, cause }));
  return response;
}

registerSaveConflicts({
  saved,
  demoSiteAccounts,
  mockClient,
  control,
  mount,
  addSite,
  deferred,
  conflict,
  written,
});

function navLink(name: string) {
  return page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name, exact: true });
}

/** A disconnected sync service adds the page's last, short section. */
function disconnectedService(): ServiceClient {
  const disconnected = { ok: true as const, state: { kind: "disconnected" as const } };
  return {
    get: vi.fn<ServiceClient["get"]>().mockResolvedValue(disconnected),
    requestSiteAccess: vi.fn<ServiceClient["requestSiteAccess"]>().mockResolvedValue(true),
    forget: vi.fn<ServiceClient["forget"]>().mockResolvedValue(disconnected),
    pair: vi.fn<ServiceClient["pair"]>(),
    disconnect: vi.fn<ServiceClient["disconnect"]>().mockResolvedValue(disconnected),
    deleteRecipes: vi.fn<ServiceClient["deleteRecipes"]>().mockResolvedValue(disconnected),
    openSignIn: vi.fn<ServiceClient["openSignIn"]>().mockResolvedValue(undefined),
  };
}

registerNavigationAndPreferences({
  saved,
  mockClient,
  control,
  mount,
  navLink,
  disconnectedService,
});
