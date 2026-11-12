import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
// oxlint-disable-next-line import/no-unassigned-import -- Exercise real modal positioning and transitions.
import "../../apps/extension/entrypoints/options/style.css";
import { cleanup, render } from "vitest-browser-react";
import { BitwardenSetup } from "../../apps/extension/src/options/bitwarden-setup";
import { type ConnectionClient } from "../../apps/extension/src/options/connection-client";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import type { SetupReply } from "../../apps/extension/src/connections/types";
import { registerAddAndVerification } from "./connection-setup/add-and-verification";
import { registerChallengeLifetime } from "./connection-setup/challenge-lifetime";
import { registerSettingsCatalogSave } from "./connection-setup/settings-catalog-save";
import { registerSettingsCatalogReload } from "./connection-setup/settings-catalog-reload";
import { registerConnectionManagement } from "./connection-setup/connection-management";
import { registerConnectionRecovery } from "./connection-setup/connection-recovery";
import { registerVaultPolicyAndLimits } from "./connection-setup/vault-policy-and-limits";
import { registerKeyboardChallengeFocus } from "./connection-setup/keyboard-challenge-focus";
import { registerKeyboardActionFocus } from "./connection-setup/keyboard-action-focus";
import { registerVaultLockAndStatus } from "./connection-setup/vault-lock-and-status";

const password = "synthetic-component-password-only";
const flowId = "50000000-0000-4000-8000-000000000001";
/** When a waiting sign-in ends: far off, so only a test that sets its own end sees it pass. */
const expiresAt = Date.now() + 3_600_000;
function ready(): SetupReply {
  return {
    ok: true,
    kind: "ready",
    connectionId: "synthetic",
    snapshotId: crypto.randomUUID(),
    policyReviewItemIds: [],
  };
}
function status(): Extract<SetupReply, { kind: "status" }> {
  return { ok: true, kind: "status", connections: [] };
}
function mockClient() {
  return {
    requestProviderPermission: vi
      .fn<ConnectionClient["requestProviderPermission"]>()
      .mockResolvedValue(true),
    list: vi.fn<ConnectionClient["list"]>().mockResolvedValue(status()),
    begin: vi.fn<ConnectionClient["begin"]>().mockImplementation(async () => ready()),
    continue: vi.fn<ConnectionClient["continue"]>().mockImplementation(async () => ready()),
    cancel: vi.fn<ConnectionClient["cancel"]>().mockResolvedValue({ ok: true, kind: "cancelled" }),
    sendEmailCode: vi.fn<ConnectionClient["sendEmailCode"]>().mockImplementation(async (id) => ({
      ok: true,
      kind: "email-code",
      flowId: id,
      result: "sent",
    })),
    sync: vi.fn<ConnectionClient["sync"]>().mockImplementation(async () => ready()),
    disableAutoUnlock: vi
      .fn<ConnectionClient["disableAutoUnlock"]>()
      .mockResolvedValue({ ok: true, kind: "cancelled" }),
    lock: vi
      .fn<ConnectionClient["lock"]>()
      .mockImplementation(async (connectionId) => ({ ok: true, kind: "locked", connectionId })),
    unlock: vi
      .fn<ConnectionClient["unlock"]>()
      .mockImplementation(async (connectionId) => ({ ok: true, kind: "unlocked", connectionId })),
    forgetProviderSession: vi
      .fn<ConnectionClient["forgetProviderSession"]>()
      .mockImplementation(async (connectionId) => ({ ok: true, kind: "forgotten", connectionId })),
    deleteConnection: vi
      .fn<ConnectionClient["deleteConnection"]>()
      .mockImplementation(async (connectionId) => ({ ok: true, kind: "deleted", connectionId })),
    keepAlive: vi
      .fn<ConnectionClient["keepAlive"]>()
      .mockImplementation(async (id) => ({ ok: true, kind: "waiting", flowId: id })),
    review: vi.fn<ConnectionClient["review"]>().mockImplementation(async () => ready()),
    close: vi.fn<ConnectionClient["close"]>(),
  };
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
/** Lets a reply's render and the effects after it run. */
function painted() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
async function mount(client = mockClient()) {
  const queryClient = createMetadataQueryClient();
  const changed = vi.fn();
  await render(
    <QueryClientProvider client={queryClient}>
      <BitwardenSetup client={client} onCatalogChanged={changed} />
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByText("Connections loaded. Add a vault or sign in again below."))
    .toBeVisible();
  return { client, queryClient, changed };
}
async function fillNew() {
  await page.getByLabelText("Name", { exact: true }).fill("Synthetic vault");
  await page.getByLabelText("Email", { exact: true }).fill("test@example.test");
  await page.getByLabelText("Master password", { exact: true }).fill(password);
}
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

registerAddAndVerification({
  password,
  flowId,
  expiresAt,
  ready,
  mockClient,
  held,
  mount,
  fillNew,
});

/** Runs `run` with only the heartbeat's interval faked; locators keep their real timeouts. */
async function withFakeInterval(run: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}
// Before its 5 minutes, as when Chrome restarted the worker.
const expiredText = "The sign-in ended before the code was entered.";
const endedLine = () => document.querySelector("#bitwarden-sign-in-ended")?.textContent ?? null;

registerChallengeLifetime(
  {
    password,
    flowId,
    expiresAt,
    ready,
    status,
    mockClient,
    held,
    painted,
    mount,
    fillNew,
    withFakeInterval,
    expiredText,
    endedLine,
    addForm,
  },
  {
    get registered() {
      return registered;
    },
  },
);

registerSettingsCatalogSave({ mockClient, fillNew });

/**
 * Starts a reload of clean settings, then changes the vault metadata while it runs, as a
 * setup outcome that may have written the catalog does.
 */
async function catalogChangeDuringCleanReload() {
  const connection = mockClient();
  connection.begin.mockResolvedValue({ ok: false, error: { code: "storage-uncertain" } });
  function saved(revision: number): Extract<SettingsResponse, { ok: true }> {
    return {
      version: 1,
      ok: true,
      snapshot: { version: 1, revision, settings: createDefaultSettings() },
      catalog: structuredClone(DUMMY_VAULT_CATALOG),
    };
  }
  const settings = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(saved(0)),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>(),
    findSiteAccounts: vi.fn<SettingsClient["findSiteAccounts"]>().mockResolvedValue({
      version: 1,
      ok: false,
      reason: "unavailable",
    }),
  };
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <SettingsApp client={settings} connectionClient={connection} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("Saved settings loaded (revision 0).")).toBeVisible();
  const reading = held<SettingsResponse>();
  settings.getSettings.mockReturnValueOnce(reading.promise);
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect.element(page.getByText("Loading saved settings…")).toBeVisible();
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await vi.waitFor(() => expect(connection.begin).toHaveBeenCalledTimes(1));
  return { settings, finish: () => reading.resolve(saved(1)) };
}

registerSettingsCatalogReload({
  flowId,
  expiresAt,
  mockClient,
  fillNew,
  catalogChangeDuringCleanReload,
});

registerConnectionManagement({ ready, status, mockClient, held, mount });

// The background keeps a new connection registered when its first sign-in fails.
const registered = {
  connectionId: "registered",
  label: "Synthetic vault",
  email: "test@example.test",
  environment: { kind: "cloud" as const, region: "us" as const },
  state: "configured" as const,
  autoUnlock: "unknown" as const,
  providerSession: "none" as const,
};
function addForm() {
  return document.querySelector("#bitwarden details > summary")?.textContent;
}

registerConnectionRecovery({
  password,
  flowId,
  expiresAt,
  ready,
  status,
  mockClient,
  held,
  mount,
  fillNew,
  registered,
  addForm,
});

registerVaultPolicyAndLimits({ ready, status, mockClient, held, mount, fillNew, registered });

const statusOutput = () => page.elementLocator(document.getElementById("bitwarden-setup-status")!);

registerKeyboardChallengeFocus({
  flowId,
  expiresAt,
  status,
  mockClient,
  mount,
  fillNew,
  statusOutput,
});

/** Focuses a button and presses Enter, as a keyboard or screen reader user does. */
async function pressWithKeyboard(name: string) {
  const button = page.getByRole("button", { name, exact: true });
  (button.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  return button;
}

registerKeyboardActionFocus({
  flowId,
  expiresAt,
  status,
  mockClient,
  held,
  painted,
  mount,
  fillNew,
  statusOutput,
  pressWithKeyboard,
});

// A vault the vault timeout locked (ADR 0075): it keeps its sync sign-in.
const lockedVault = {
  connectionId: "saved-l",
  label: "Locked vault",
  email: "locked@example.test",
  environment: { kind: "cloud" as const, region: "us" as const },
  state: "locked" as const,
  autoUnlock: "disabled" as const,
  providerSession: "active" as const,
};
/** The row's unlock form comes before the add form's own master password field. */
const unlockField = () => page.getByLabelText("Master password", { exact: true }).first();
const unlockRow = () => page.getByRole("button", { name: "Locked vault: Unlock", exact: true });
const submitUnlock = () => page.getByRole("button", { name: "Unlock", exact: true });

registerVaultLockAndStatus({
  password,
  status,
  mockClient,
  mount,
  registered,
  lockedVault,
  unlockField,
  unlockRow,
  submitUnlock,
});
