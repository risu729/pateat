import { QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BitwardenSetup } from "../../../apps/extension/src/options/bitwarden-setup";
import { createConnectionClient } from "../../../apps/extension/src/options/connection-client";
import { createMetadataQueryClient } from "../../../apps/extension/src/options/client";
import type { SetupReply } from "../../../apps/extension/src/connections/types";
import type { ConnectionSetupTestContext } from "./context";

export function registerConnectionRecovery({
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
}: Pick<
  ConnectionSetupTestContext,
  | "password"
  | "flowId"
  | "expiresAt"
  | "ready"
  | "status"
  | "mockClient"
  | "held"
  | "mount"
  | "fillNew"
  | "registered"
  | "addForm"
>) {
  test("a failed first sign-in switches the form to finishing its connection", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [registered] });
    client.begin
      .mockResolvedValueOnce({ ok: false, error: { code: "authentication-rejected" } })
      .mockImplementation(async () => ready());
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    // Connect cannot register a second connection: the form now finishes the listed one.
    await vi.waitFor(() => expect(addForm()).toBe("Sign in to Synthetic vault again"));
    await expect.element(page.getByText(/Bitwarden did not accept this sign-in/)).toBeVisible();
    await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveFocus();
    await page.getByLabelText("Master password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in and sync", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(2));
    expect(client.begin.mock.calls[1]![0]).toEqual({
      kind: "existing",
      connectionId: "registered",
      password,
    });
  });

  test("cancelling a first sign-in's verification lists its connection", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [registered] });
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0],
      expiresAt,
    });
    const { changed } = await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
    const changes = changed.mock.calls.length;
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(changes + 1);
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("");
    await expect.element(page.getByLabelText("Email", { exact: true })).toHaveValue("");
  });

  test("a connection added from the opened form leaves the form empty", async () => {
    const client = mockClient();
    const other = {
      ...registered,
      connectionId: "other",
      label: "Other vault",
      state: "ready" as const,
    };
    client.list.mockResolvedValueOnce({ ...status(), connections: [other] }).mockResolvedValue({
      ...status(),
      connections: [other, { ...registered, state: "ready", providerSession: "active" }],
    });
    await mount(client);
    await page.getByText("Add a connection", { exact: true }).first().click();
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sync", exact: true }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("");
    await expect.element(page.getByLabelText("Email", { exact: true })).toHaveValue("");
  });

  test("a later refresh keeps the draft after an add refused before registering", async () => {
    const client = mockClient();
    const other = { ...registered, connectionId: "other", label: "Other vault" };
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [other] });
    client.begin.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByText(/reached a resource limit/)).toBeVisible();
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await page.getByLabelText("Name", { exact: true }).fill("Edited vault");
    // Another page adds a connection; only the re-read after this page's own add may clear.
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Other vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("Edited vault");
    await expect
      .element(page.getByLabelText("Email", { exact: true }))
      .toHaveValue("test@example.test");
  });

  test("a refused add keeps the draft when its re-read lists another page's connection", async () => {
    const client = mockClient();
    const other = { ...registered, connectionId: "other", label: "Other vault" };
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [other] });
    client.begin.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Other vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByLabelText("Name", { exact: true }))
      .toHaveValue("Synthetic vault");
    await expect
      .element(page.getByLabelText("Email", { exact: true }))
      .toHaveValue("test@example.test");
  });

  test("a code rejected after a challenge switches the form to finishing its connection", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [registered] });
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0],
      expiresAt,
    });
    client.continue.mockResolvedValue({ ok: false, error: { code: "authentication-rejected" } });
    await mount(client);
    await fillNew();
    await page.getByLabelText("Email", { exact: true }).fill("Test@Example.test");
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await page.getByLabelText("Verification code", { exact: true }).fill("000123");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    // The background stores the email lower-cased; the typed form still matches it.
    await vi.waitFor(() => expect(addForm()).toBe("Sign in to Synthetic vault again"));
    // The removed Verify code hands focus to the password the sign-in now needs.
    await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveFocus();
  });

  test("an unsupported interaction on a first sign-in switches the form to finishing its connection", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [registered] });
    client.begin.mockResolvedValue({ ok: true, kind: "interaction-required", reason: "sso" });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(addForm()).toBe("Sign in to Synthetic vault again"));
    await expect
      .element(
        page.getByText(
          /^Setup is incomplete: Bitwarden asks for a step Pateat does not support \(sso\)\./,
        ),
      )
      .toBeVisible();
  });

  test("Sign in again on a connection that never unlocked asks to finish setting it up", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [registered] });
    await mount(client);
    await page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }).click();
    await expect
      .element(page.getByText("Enter the master password to finish setting up this connection."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveFocus();
  });

  test("a connection registered after a stopped first sign-in clears the draft on refresh", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status())
      .mockResolvedValue({ ...status(), connections: [registered] });
    client.begin.mockReturnValue(held<SetupReply>().promise);
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    // The stop's re-read came before the background registered the connection.
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await expect
      .element(page.getByLabelText("Name", { exact: true }))
      .toHaveValue("Synthetic vault");
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("");
    await expect.element(page.getByLabelText("Email", { exact: true })).toHaveValue("");
  });

  test("a failed sync of another connection keeps a stopped add pending", async () => {
    const client = mockClient();
    const other = {
      ...registered,
      connectionId: "other",
      label: "Other vault",
      state: "ready" as const,
      providerSession: "active" as const,
    };
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [other] })
      .mockResolvedValueOnce({ ...status(), connections: [other] })
      .mockResolvedValueOnce({ ...status(), connections: [other] })
      .mockResolvedValue({ ...status(), connections: [other, registered] });
    client.begin.mockReturnValue(held<SetupReply>().promise);
    client.sync.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
    await mount(client);
    await page.getByText("Add a connection", { exact: true }).first().click();
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await page.getByRole("button", { name: "Other vault: Sync", exact: true }).click();
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledTimes(3));
    await expect
      .element(page.getByLabelText("Name", { exact: true }))
      .toHaveValue("Synthetic vault");
    await page.getByRole("button", { name: "Refresh connections", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("");
  });

  test("Cancel setup with nothing running lets an earlier stop's re-read land", async () => {
    const client = mockClient();
    const reread = held<SetupReply>();
    client.list.mockResolvedValueOnce(status()).mockReturnValueOnce(reread.promise);
    client.begin.mockReturnValue(held<SetupReply>().promise);
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    await vi.waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await page.getByLabelText("Master password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    reread.resolve({ ...status(), connections: [registered] });
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("");
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("a failed sync re-reads the rows", async () => {
    const client = mockClient();
    const saved = { ...registered, state: "ready" as const, providerSession: "active" as const };
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [saved] })
      .mockResolvedValue({ ...status(), connections: [{ ...saved, providerSession: "none" }] });
    client.sync.mockResolvedValue({
      ok: false,
      error: { code: "setup-reauthentication-required" },
    });
    await mount(client);
    await page.getByRole("button", { name: "Synthetic vault: Sync", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/^Sign in again to sync\./)).toBeVisible();
  });

  test("Cancel setup leaves sign-in-again mode and touches nothing when nothing runs", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [registered] });
    const { changed } = await mount(client);
    await page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }).click();
    await vi.waitFor(() => expect(addForm()).toBe("Sign in to Synthetic vault again"));
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    await vi.waitFor(() => expect(addForm()).toBe("Add a connection"));
    await expect
      .element(page.getByRole("button", { name: "Cancel setup", exact: true }))
      .toBeDisabled();
    expect(client.close).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  test("stopping the first load re-reads the connections without reloading saved settings", async () => {
    const client = mockClient();
    const first = held<SetupReply>();
    client.list
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ...status(), connections: [registered] });
    const changed = vi.fn();
    await render(
      <QueryClientProvider client={createMetadataQueryClient()}>
        <BitwardenSetup
          client={client}
          onCatalogChanged={changed}
          renderOthers={(listed) => <p>{listed ? `Listed: ${listed.join(", ")}` : "Not listed"}</p>}
        />
      </QueryClientProvider>,
    );
    await expect.element(page.getByText("Not listed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    first.resolve(status());
    // Stopping re-reads at once; nothing was written, so saved settings need no reload.
    await expect.element(page.getByText("Listed: registered", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Connections loaded. Add a vault or sign in again below."))
      .toBeVisible();
    expect(changed).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  test("stopping a first load that does not answer says so", async () => {
    const client = mockClient();
    client.list.mockReturnValue(held<SetupReply>().promise);
    await render(
      <QueryClientProvider client={createMetadataQueryClient()}>
        <BitwardenSetup client={client} onCatalogChanged={vi.fn()} />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
    await expect.element(page.getByText("Loading stopped.", { exact: true })).toBeVisible();
  });

  test("sync after a log out explains how to restore it", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          connectionId: "saved-c",
          label: "Saved vault",
          email: "saved@example.test",
          environment: { kind: "cloud" as const, region: "us" as const },
          state: "ready" as const,
          autoUnlock: "enabled" as const,
          providerSession: "active" as const,
        },
      ],
    });
    client.sync.mockResolvedValue({ ok: false, error: { code: "auto-unlock-disabled" } });
    await mount(client);
    await page.getByRole("button", { name: "Saved vault: Sync", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "This connection is logged out on this device. Sign in again to use and sync it.",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText(/The connection could not do this/))
      .not.toBeInTheDocument();
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
      .element(page.getByText(/The connection could not do this \(http-error\)/))
      .toBeVisible();
    expect(port.postMessage.mock.calls.map(([message]) => message.type)).toContain(
      "connection.sync",
    );
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Pateat could not confirm the result.");
  });

  test("an account mismatch names the failed check", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          connectionId: "saved-c",
          label: "Saved vault",
          email: "saved@example.test",
          environment: { kind: "cloud" as const, region: "us" as const },
          state: "ready" as const,
          autoUnlock: "enabled" as const,
          providerSession: "active" as const,
        },
      ],
    });
    client.sync.mockResolvedValue({
      ok: false,
      error: { code: "account-mismatch", check: "token-unlock" },
    });
    await mount(client);
    await page.getByRole("button", { name: "Saved vault: Sync", exact: true }).click();
    await expect.element(page.getByText(/did not agree \(check: token-unlock\)/)).toBeVisible();
  });
}
