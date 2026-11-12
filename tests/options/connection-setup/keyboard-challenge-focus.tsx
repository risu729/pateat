import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { ConnectionSetupTestContext } from "./context";

export function registerKeyboardChallengeFocus({
  flowId,
  expiresAt,
  status,
  mockClient,
  mount,
  fillNew,
  statusOutput,
}: Pick<
  ConnectionSetupTestContext,
  "flowId" | "expiresAt" | "status" | "mockClient" | "mount" | "fillNew" | "statusOutput"
>) {
  test.each(["ready", "error", "cancel"] as const)(
    "a verification challenge takes keyboard focus and hands it to the status after %s",
    async (end) => {
      const client = mockClient();
      client.begin.mockResolvedValue({
        ok: true,
        kind: "mfa-required",
        flowId,
        providers: [0],
        expiresAt,
      });
      if (end === "error")
        client.continue.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
      await mount(client);
      await fillNew();
      await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
      const code = page.getByLabelText("Verification code", { exact: true });
      await expect.element(code).toHaveFocus();
      if (end === "cancel") {
        await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
        await expect
          .element(page.getByText("Setup stopped. Refresh to see the current state."))
          .toBeVisible();
      } else {
        await code.fill("000123");
        await page.getByRole("button", { name: "Verify code", exact: true }).click();
        await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(1));
      }
      await expect.element(code).not.toBeInTheDocument();
      await expect.element(statusOutput()).toHaveFocus();
    },
  );

  test("a new-device challenge, and a rejected code asking again, focus the code field", async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "new-device-verification-required",
      flowId,
      invalidOtp: false,
      expiresAt,
    });
    client.continue.mockResolvedValue({
      ok: true,
      kind: "new-device-verification-required",
      flowId,
      invalidOtp: true,
      expiresAt,
    });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    const code = page.getByLabelText("New-device verification code", { exact: true });
    await expect.element(code).toHaveFocus();
    await code.fill("000987");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await expect
      .element(page.getByText("The code was not accepted.", { exact: true }))
      .toBeVisible();
    await expect.element(code).toHaveFocus();
  });

  test("deleting a connection leaves keyboard focus on the status instead of the page", async () => {
    const client = mockClient();
    const leftover = {
      connectionId: "leftover",
      label: "Leftover vault",
      email: "saved@example.test",
      environment: { kind: "cloud" as const, region: "us" as const },
      state: "configured" as const,
      autoUnlock: "unknown" as const,
      providerSession: "none" as const,
    };
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [leftover] })
      .mockResolvedValue(status());
    await mount(client);
    await page.getByRole("button", { name: "More for Leftover vault", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Leftover vault: Delete connection", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Delete Leftover vault?", exact: true })
      .getByRole("button", { name: "Delete connection", exact: true })
      .click();
    await expect.element(page.getByText(/^Connection deleted from this device/)).toBeVisible();
    await expect.element(page.getByText("Leftover vault", { exact: true })).not.toBeInTheDocument();
    await expect.element(statusOutput()).toHaveFocus();
  });

  test("Add another connection moves focus into the form it opens", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          connectionId: "saved-a",
          label: "Saved vault",
          email: "saved@example.test",
          environment: { kind: "cloud", region: "eu" },
          state: "configured",
          autoUnlock: "unknown",
          providerSession: "none",
        },
      ],
    });
    await mount(client);
    await page.getByRole("button", { name: "Saved vault: Sign in again", exact: true }).click();
    await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveFocus();
    await page.getByRole("button", { name: "Add another connection", exact: true }).click();
    await expect.element(page.getByRole("combobox", { name: "Server", exact: true })).toHaveFocus();
  });
}
