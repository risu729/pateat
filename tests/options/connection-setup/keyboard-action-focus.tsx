import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { SetupReply } from "../../../apps/extension/src/connections/types";
import type { ConnectionSetupTestContext } from "./context";

export function registerKeyboardActionFocus({
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
}: Pick<
  ConnectionSetupTestContext,
  | "flowId"
  | "expiresAt"
  | "status"
  | "mockClient"
  | "held"
  | "painted"
  | "mount"
  | "fillNew"
  | "statusOutput"
  | "pressWithKeyboard"
>) {
  test("a failed connect keeps keyboard focus on Connect", async () => {
    const client = mockClient();
    const pending = held<SetupReply>();
    client.begin.mockReturnValue(pending.promise);
    await mount(client);
    await fillNew();
    const connect = await pressWithKeyboard("Connect Bitwarden");
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    // While it runs the button is unavailable but keeps focus.
    await expect.element(connect).toHaveFocus();
    await expect.element(connect).toHaveAttribute("aria-disabled", "true");
    pending.resolve({ ok: false, error: { code: "resource-limit" } });
    await expect.element(page.getByText(/reached a resource limit/)).toBeVisible();
    await expect.element(connect).toBeEnabled();
    await expect.element(connect).toHaveFocus();
  });

  test("a failed sync or refresh keeps keyboard focus on its button", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          connectionId: "saved-a",
          label: "Saved vault",
          email: "saved@example.test",
          environment: { kind: "cloud", region: "us" },
          state: "ready",
          autoUnlock: "enabled",
          providerSession: "active",
        },
      ],
    });
    client.sync.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
    await mount(client);
    const sync = await pressWithKeyboard("Saved vault: Sync");
    await expect.element(page.getByText(/reached a resource limit/)).toBeVisible();
    await expect.element(sync).toBeEnabled();
    await expect.element(sync).toHaveFocus();
    client.list.mockRejectedValue(new Error("synthetic failure"));
    const refresh = await pressWithKeyboard("Refresh connections");
    await expect.element(page.getByText(/^Pateat could not confirm the result\./)).toBeVisible();
    await expect.element(refresh).toBeEnabled();
    await expect.element(refresh).toHaveFocus();
  });

  test("sending and resending the email code keep keyboard focus on the code field", async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0, 1],
      expiresAt,
    });
    const pending = held<SetupReply>();
    client.sendEmailCode
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, kind: "email-code", flowId, result: "sent" })
      .mockResolvedValueOnce({ ok: false, error: { code: "provider-permission-required" } });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    const code = page.getByLabelText("Verification code", { exact: true });
    await expect.element(code).toHaveFocus();
    // Choosing email sends a code, which disables the method select while it runs.
    const method = page.getByRole("combobox", { name: "Verification method", exact: true });
    (method.element() as HTMLElement).focus();
    await method.selectOptions("1");
    await expect.element(method).toBeDisabled();
    pending.resolve({ ok: true, kind: "email-code", flowId, result: "sent" });
    await expect.element(page.getByText(/The server sent a verification code/)).toBeVisible();
    await expect.element(code).toHaveFocus();
    // Resend code sits in the same disabled form while it sends.
    await pressWithKeyboard("Resend code");
    await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(2));
    await expect
      .element(page.getByRole("button", { name: "Resend code", exact: true }))
      .toBeEnabled();
    await expect.element(code).toHaveFocus();
    // A send that ends the sign-in removes the code field; the status says why.
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      await pressWithKeyboard("Resend code");
      await expect.element(code).not.toBeInTheDocument();
      await expect.element(statusOutput()).toHaveFocus();
      // Focus moves without scrolling the page to the status.
      const call = focus.mock.contexts.indexOf(statusOutput().element() as HTMLElement);
      expect(focus.mock.calls[call]).toEqual([{ preventScroll: true }]);
    } finally {
      focus.mockRestore();
    }
  });

  test("Cancel setup with nothing running hands keyboard focus to the status", async () => {
    await mount();
    await fillNew();
    const cancel = await pressWithKeyboard("Cancel setup");
    await expect.element(page.getByText("Setup cancelled.", { exact: true })).toBeVisible();
    // Nothing is left to cancel, so the button is disabled.
    await expect.element(cancel).toBeDisabled();
    await expect.element(statusOutput()).toHaveFocus();
  });

  test("a challenge leaves focus the person moved outside the setup", async () => {
    const client = mockClient();
    const pending = held<SetupReply>();
    client.begin.mockReturnValue(pending.promise);
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    const outside = document.createElement("input");
    outside.setAttribute("aria-label", "Outside field");
    document.body.append(outside);
    try {
      outside.focus();
      pending.resolve({ ok: true, kind: "mfa-required", flowId, providers: [0], expiresAt });
      await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeEnabled();
      await painted();
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
}
