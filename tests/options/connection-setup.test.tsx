import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { BitwardenSetup } from "../../apps/extension/src/options/bitwarden-setup";
import {
  createConnectionClient,
  type ConnectionClient,
} from "../../apps/extension/src/options/connection-client";
import {
  createMetadataQueryClient,
  type SettingsClient,
} from "../../apps/extension/src/options/client";
import { SettingsApp } from "../../apps/extension/src/options/settings-app";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  getFoundationStatus,
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import type { SetupReply } from "../../apps/extension/src/connections/types";

const password = "synthetic-component-password-only";
const flowId = "50000000-0000-4000-8000-000000000001";
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
    sync: vi.fn<ConnectionClient["sync"]>().mockImplementation(async () => ready()),
    disableAutoUnlock: vi
      .fn<ConnectionClient["disableAutoUnlock"]>()
      .mockResolvedValue({ ok: true, kind: "cancelled" }),
    forgetProviderSession: vi
      .fn<ConnectionClient["forgetProviderSession"]>()
      .mockImplementation(async (connectionId) => ({ ok: true, kind: "forgotten", connectionId })),
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
  await page.getByLabelText("Connection name", { exact: true }).fill("Synthetic vault");
  await page.getByLabelText("Email", { exact: true }).fill("test@example.test");
  await page.getByLabelText("Master password", { exact: true }).fill(password);
}
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("permission denial clears the password and sends no sign-in request", async () => {
  const client = mockClient();
  client.requestProviderPermission.mockResolvedValue(false);
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await expect
    .element(page.getByText("Provider access was not granted. No sign-in request was sent."))
    .toBeVisible();
  await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveValue("");
  expect(client.requestProviderPermission).toHaveBeenCalledWith({ kind: "cloud", region: "us" });
  expect(client.begin).not.toHaveBeenCalled();
});

test("a held sign-in clears UI secrets immediately and never puts them in query or mutation caches", async () => {
  const client = mockClient();
  const pending = held<SetupReply>();
  client.begin.mockReturnValue(pending.promise);
  const { queryClient } = await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
  await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveValue("");
  await expect
    .element(page.getByRole("button", { name: "Connect Bitwarden", exact: true }))
    .toBeDisabled();
  const cached = JSON.stringify({
    queries: queryClient.getQueryCache().getAll(),
    mutations: queryClient.getMutationCache().getAll(),
  });
  expect(cached).not.toContain(password);
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  expect(client.begin.mock.calls[0]![0]).toMatchObject({ password, kind: "new", enabled: true });
  pending.resolve(ready());
  await expect
    .element(
      page.getByText(
        "Vault verified and local cache accepted. Check automatic-unlock status below.",
      ),
    )
    .toBeVisible();
});

test.each(["http://vault.example", "https://vault.example/path", "https://user@vault.example"])(
  "invalid self-hosted address %s never starts a permission prompt",
  async (address) => {
    const { client } = await mount();
    await fillNew();
    await page.getByRole("combobox", { name: "Server", exact: true }).selectOptions("self-hosted");
    await page.getByLabelText("Server address", { exact: true }).fill(address);
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(page.getByText(/Self-hosted addresses must be ordinary HTTPS roots/))
      .toBeVisible();
    expect(client.requestProviderPermission).not.toHaveBeenCalled();
    expect(client.begin).not.toHaveBeenCalled();
  },
);

test("manual MFA clears the code on submission and never resends without another user action", async () => {
  const client = mockClient();
  client.begin.mockResolvedValue({ ok: true, kind: "mfa-required", flowId, providers: [0, 1] });
  const pending = held<SetupReply>();
  client.continue.mockReturnValue(pending.promise);
  const { queryClient } = await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
  expect(client.continue).not.toHaveBeenCalled();
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
  await page.getByLabelText("Verification code", { exact: true }).fill("000123");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(1));
  await expect.element(page.getByLabelText("Verification code", { exact: true })).toHaveValue("");
  expect(client.continue).toHaveBeenCalledWith({
    flowId,
    twoFactor: { provider: 1, code: "000123" },
  });
  expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain("000123");
  pending.resolve({ ok: true, kind: "mfa-required", flowId, providers: [1] });
  await expect
    .element(page.getByRole("button", { name: "Verify code", exact: true }))
    .toBeDisabled();
  expect(client.continue).toHaveBeenCalledTimes(1);
});

test("new-device verification is a distinct manual continuation and clears its code", async () => {
  const client = mockClient();
  client.begin.mockResolvedValue({
    ok: true,
    kind: "new-device-verification-required",
    flowId,
    invalidOtp: false,
  });
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await page.getByLabelText("New-device verification code", { exact: true }).fill("000987");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect
    .element(
      page.getByText(
        "Vault verified and local cache accepted. Check automatic-unlock status below.",
      ),
    )
    .toBeVisible();
  expect(client.continue).toHaveBeenCalledWith({ flowId, newDeviceOtp: "000987" });
  await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveValue("");
});

test("cancel closes the private lifetime and ignores a late successful begin", async () => {
  const client = mockClient();
  const pending = held<SetupReply>();
  client.begin.mockReturnValue(pending.promise);
  const { changed } = await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
  await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
  expect(client.close).toHaveBeenCalledTimes(1);
  const changes = changed.mock.calls.length;
  pending.resolve(ready());
  await expect
    .element(page.getByText("Setup stopped. Refresh connections to confirm the latest state."))
    .toBeVisible();
  expect(changed).toHaveBeenCalledTimes(changes);
  expect(client.list).toHaveBeenCalledTimes(1);
});

test("unmount closes credential work and ignores its late response", async () => {
  const client = mockClient();
  const pending = held<SetupReply>();
  client.begin.mockReturnValue(pending.promise);
  const { changed } = await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
  await cleanup();
  expect(client.close).toHaveBeenCalledTimes(1);
  pending.resolve(ready());
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
});

test("existing disabled connections remain preserve-only unless enable is explicitly checked", async () => {
  const client = mockClient();
  const saved = {
    connectionId: "saved-a",
    label: "Saved vault",
    email: "saved@example.test",
    environment: { kind: "cloud" as const, region: "eu" as const },
    state: "disabled" as const,
    autoUnlock: "disabled" as const,
    providerSession: "none" as const,
  };
  client.list.mockResolvedValue({ ...status(), connections: [saved] });
  await mount(client);
  await page.getByRole("button", { name: "Saved vault: Sign in again", exact: true }).click();
  await expect
    .element(page.getByLabelText("Enable automatic unlock on this device", { exact: true }))
    .not.toBeChecked();
  await page.getByLabelText("Master password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in and sync", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
  expect(client.begin.mock.calls[0]![0]).toEqual({
    kind: "existing",
    connectionId: "saved-a",
    password,
    autoUnlock: "preserve",
  });
  await expect
    .element(
      page.getByText(
        "Vault verified and local cache accepted. Check automatic-unlock status below.",
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Saved vault: Sign in again", exact: true }).click();
  await page.getByLabelText("Enable automatic unlock on this device", { exact: true }).click();
  await page.getByLabelText("Master password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in and sync", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(2));
  expect(client.begin.mock.calls[1]![0]).toEqual({
    kind: "existing",
    connectionId: "saved-a",
    password,
    autoUnlock: "enable",
  });
  expect(client.requestProviderPermission).toHaveBeenCalledWith(saved.environment);
});

test("affected custom-field policy quarantine is visible without exposing vault values", async () => {
  const client = mockClient();
  client.begin.mockResolvedValue({
    ...ready(),
    policyReviewItemIds: ["affected-item"],
  } as SetupReply);
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await expect
    .element(
      page.getByText("Vault accepted. 1 item(s) need their field settings reviewed before use."),
    )
    .toBeVisible();
  await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveValue("");
});

test.each(["storage-uncertain", "setup-unavailable"] as const)(
  "a resolved %s setup outcome preserves a dirty policy draft and fences saving until explicit reload",
  async (code) => {
    const connection = mockClient();
    connection.begin.mockResolvedValue({ ok: false, error: { code } });
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
      saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockResolvedValue(saved(1)),
      getStatus: vi.fn<SettingsClient["getStatus"]>().mockResolvedValue(getFoundationStatus()),
    };
    await render(
      <QueryClientProvider client={createMetadataQueryClient()}>
        <SettingsApp client={settings} connectionClient={connection} />
      </QueryClientProvider>,
    );
    await expect.element(page.getByText("Saved settings loaded · Revision 0")).toBeVisible();
    await page.getByLabelText("Hostname", { exact: true }).fill("draft.example");
    await page.getByRole("button", { name: "Add excluded site", exact: true }).click();
    const save = page.getByRole("button", { name: "Save settings", exact: true });
    await expect.element(save).toBeEnabled();
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(connection.begin).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByText(/Vault metadata changed\. Your unsaved draft has been preserved/))
      .toBeVisible();
    await expect.element(save).toBeDisabled();
    expect(document.getElementById("excluded-sites")?.textContent).toContain("draft.example");
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
    expect(settings.saveSettings).not.toHaveBeenCalled();
    // Editing further cannot unblock a draft based on potentially replaced vault metadata.
    await page.getByLabelText("Hostname", { exact: true }).fill("next-draft.example");
    await page.getByRole("button", { name: "Add excluded site", exact: true }).click();
    await expect.element(save).toBeDisabled();
    settings.getSettings.mockResolvedValue(saved(7));
    await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
    await expect.element(page.getByText("Saved settings loaded · Revision 7")).toBeVisible();
    expect(document.getElementById("excluded-sites")?.textContent).not.toContain("draft.example");
    await page.getByLabelText("Hostname", { exact: true }).fill("reviewed.example");
    await page.getByRole("button", { name: "Add excluded site", exact: true }).click();
    await expect.element(save).toBeEnabled();
    await save.click();
    expect(settings.saveSettings.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 7 });
  },
);

test.each([false, true])(
  "field review uses current snapshot IDs and starts every custom field excluded (blocked=%s)",
  async (blocked) => {
    const client = mockClient();
    const snapshot = crypto.randomUUID();
    const accepted: Extract<SettingsResponse, { ok: true }> = {
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 12, settings: createDefaultSettings() },
      catalog: {
        connections: [
          {
            id: "synthetic",
            label: "Synthetic vault",
            provider: "bitwarden",
            groups: [],
            snapshotId: snapshot,
            quarantinedItemIds: ["affected"],
            items: [
              {
                id: "affected",
                label: "Changed login",
                allowedOrigins: [],
                groupIds: [],
                fields: [
                  { id: "login.password", label: "Password" },
                  { id: `custom.${snapshot}.0`, label: "Duplicate" },
                  { id: `custom.${snapshot}.1`, label: "Duplicate" },
                ],
              },
            ],
          },
        ],
      },
    };
    const changed = vi.fn();
    await render(
      <QueryClientProvider client={createMetadataQueryClient()}>
        <BitwardenSetup
          client={client}
          onCatalogChanged={changed}
          acceptedSettings={accepted}
          reviewBlocked={blocked}
        />
      </QueryClientProvider>,
    );
    const first = page.getByRole("checkbox", {
      name: "Changed login: Review exclude Duplicate (field 1)",
      exact: true,
    });
    const second = page.getByRole("checkbox", {
      name: "Changed login: Review exclude Duplicate (field 2)",
      exact: true,
    });
    const review = page.getByRole("button", {
      name: "Changed login: Save reviewed field exclusions",
      exact: true,
    });
    await expect.element(first).toBeChecked();
    await expect.element(second).toBeChecked();
    if (blocked) {
      await expect.element(first).toBeDisabled();
      await expect.element(review).toBeDisabled();
      expect(client.review).not.toHaveBeenCalled();
    } else {
      await first.click();
      await review.click();
      await vi.waitFor(() => expect(client.review).toHaveBeenCalledTimes(1));
      expect(client.review).toHaveBeenCalledWith({
        connectionId: "synthetic",
        itemId: "affected",
        snapshotId: snapshot,
        expectedRevision: 12,
        excludedFieldIds: [`custom.${snapshot}.1`],
      });
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    }
  },
);

test("sync sign-in is shown separately from automatic unlock and forgetting it is local", async () => {
  const client = mockClient();
  const saved = {
    connectionId: "saved-b",
    label: "Saved vault",
    email: "saved@example.test",
    environment: { kind: "cloud" as const, region: "us" as const },
    state: "ready" as const,
    autoUnlock: "enabled" as const,
    providerSession: "active" as const,
  };
  client.list
    .mockResolvedValueOnce({ ...status(), connections: [saved] })
    .mockResolvedValue({ ...status(), connections: [{ ...saved, providerSession: "none" }] });
  await mount(client);
  await expect.element(page.getByText("Automatic unlock: enabled.")).toBeVisible();
  await expect.element(page.getByText("Sync sign-in saved on this device.")).toBeVisible();
  await page.getByRole("button", { name: "Saved vault: Forget sync sign-in", exact: true }).click();
  expect(client.forgetProviderSession).toHaveBeenCalledWith("saved-b");
  expect(client.requestProviderPermission).not.toHaveBeenCalled();
  await expect
    .element(page.getByText(/Sync sign-in removed from this device\. This does not sign out/))
    .toBeVisible();
  await expect.element(page.getByText("Not signed in for sync.")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Saved vault: Forget sync sign-in", exact: true }))
    .toBeDisabled();
  await expect.element(page.getByText("Automatic unlock: enabled.")).toBeVisible();
});

test("a provider HTTP failure on sync shows an error instead of a lost connection", async () => {
  const saved = {
    connectionId: "saved-http",
    label: "Saved vault",
    email: "saved@example.test",
    environment: { kind: "cloud" as const, region: "us" as const },
    state: "ready" as const,
    autoUnlock: "enabled" as const,
    providerSession: "active" as const,
  };
  let deliver: (message: unknown) => void = () => {};
  const port = {
    // Replies take the real options wire path, as the background setup service sends them.
    postMessage: vi.fn((message: { requestId: string; type: string }) => {
      const result =
        message.type === "connection.sync"
          ? { ok: false, error: { code: "http-error" } }
          : { ok: true, kind: "status", connections: [saved] };
      queueMicrotask(() => deliver({ requestId: message.requestId, result }));
    }),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (listener: (message: unknown) => void) => {
        deliver = listener;
      },
    },
    onDisconnect: { addListener: () => {} },
  };
  const client = createConnectionClient({
    connect: () => port,
    requestPermission: async () => true,
  });
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <BitwardenSetup client={client} onCatalogChanged={vi.fn()} />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Saved vault: Sync", exact: true }).click();
  await expect
    .element(page.getByText(/Connection operation unavailable \(http-error\)/))
    .toBeVisible();
  expect(port.postMessage.mock.calls.map(([message]) => message.type)).toContain("connection.sync");
  expect(port.disconnect).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("The operation could not be confirmed.");
});
