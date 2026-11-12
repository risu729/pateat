import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { SetupReply } from "../../../apps/extension/src/connections/types";
import { localSyncTime } from "../../../apps/extension/src/time";
import type { ConnectionSetupTestContext } from "./context";

export function registerConnectionManagement({
  ready,
  status,
  mockClient,
  held,
  mount,
}: Pick<ConnectionSetupTestContext, "ready" | "status" | "mockClient" | "held" | "mount">) {
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
      syncedAt: Date.UTC(2026, 9, 13, 14, 51),
    };
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [saved] })
      .mockResolvedValue({ ...status(), connections: [{ ...saved, providerSession: "none" }] });
    await mount(client);
    await expect.element(page.getByText("Automatic unlock on", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Sync sign-in saved on this device", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/^Vault synced /)).toBeVisible();
    // Actions other than the row's main one are in its menu.
    await page.getByRole("button", { name: "More for Saved vault", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Saved vault: Forget sync sign-in", exact: true })
      .click();
    expect(client.forgetProviderSession).toHaveBeenCalledWith("saved-b");
    expect(client.requestProviderPermission).not.toHaveBeenCalled();
    await expect
      .element(page.getByText(/Sync sign-in removed from this device\. This does not sign out/))
      .toBeVisible();
    await expect.element(page.getByText("Not signed in for sync", { exact: true })).toBeVisible();
    // Without a sync sign-in, signing in again comes first.
    await expect
      .element(page.getByRole("button", { name: "Saved vault: Sign in again", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "More for Saved vault", exact: true }).click();
    await expect
      .element(
        page.getByRole("menuitem", { name: "Saved vault: Forget sync sign-in", exact: true }),
      )
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByText("Automatic unlock on", { exact: true })).toBeVisible();
  });

  test("a running sync says so, can be cancelled from the header, and its reply refreshes the row", async () => {
    const client = mockClient();
    const saved = {
      connectionId: "saved-s",
      label: "Saved vault",
      email: "saved@example.test",
      environment: { kind: "cloud" as const, region: "us" as const },
      state: "ready" as const,
      autoUnlock: "enabled" as const,
      providerSession: "active" as const,
      syncedAt: Date.UTC(2026, 9, 13, 18, 53),
    };
    const synced = Date.UTC(2026, 9, 13, 18, 55);
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [saved] })
      .mockResolvedValue({ ...status(), connections: [{ ...saved, syncedAt: synced }] });
    const pending = held<SetupReply>();
    client.sync.mockReturnValueOnce(pending.promise);
    await mount(client);
    const sync = page.getByRole("button", { name: "Saved vault: Sync", exact: true });
    await sync.click();
    await expect.element(page.getByText("Syncing Saved vault…", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await expect.element(sync).toBeDisabled();
    pending.resolve(ready());
    await expect
      .element(page.getByText("Vault verified, unlocked and copied to this device."))
      .toBeVisible();
    await expect.element(sync).toBeEnabled();
    await expect
      .element(page.getByRole("button", { name: "Cancel", exact: true }))
      .not.toBeInTheDocument();
    // The reply re-reads the connections, which carry the new sync time.
    expect(client.list).toHaveBeenCalledTimes(2);
    await expect
      .element(page.getByText(`Vault synced ${localSyncTime(synced)}`, { exact: true }))
      .toBeVisible();
    // A second sync stopped from the header closes the private lifetime; its late reply is ignored.
    const late = held<SetupReply>();
    client.sync.mockReturnValueOnce(late.promise);
    await sync.click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(client.close).toHaveBeenCalledTimes(1);
    await expect
      .element(page.getByText("Stopped. Refresh to see the current state.", { exact: true }))
      .toBeVisible();
    await expect.element(sync).toBeEnabled();
    late.resolve(ready());
    await expect
      .element(page.getByText("Stopped. Refresh to see the current state.", { exact: true }))
      .toBeVisible();
    // Stopping re-reads the rows once; the late reply adds no read.
    expect(client.list).toHaveBeenCalledTimes(3);
  });

  test("deleting a connection needs an explicit confirmation and then removes it from the list", async () => {
    const client = mockClient();
    const saved = (connectionId: string, label: string) => ({
      connectionId,
      label,
      email: "saved@example.test",
      environment: { kind: "cloud" as const, region: "us" as const },
      state: "configured" as const,
      autoUnlock: "unknown" as const,
      providerSession: "none" as const,
    });
    const leftover = saved("leftover", "Leftover vault");
    const kept = saved("kept", "Kept vault");
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [leftover, kept] })
      .mockResolvedValue({ ...status(), connections: [kept] });
    const { changed } = await mount(client);
    const more = page.getByRole("button", { name: "More for Leftover vault", exact: true });
    const remove = page.getByRole("menuitem", {
      name: "Leftover vault: Delete connection",
      exact: true,
    });
    await more.click();
    await remove.click();
    expect(client.deleteConnection).not.toHaveBeenCalled();
    const dialog = page.getByRole("alertdialog", { name: "Delete Leftover vault?", exact: true });
    await expect.element(dialog).toHaveAccessibleName("Delete Leftover vault?");
    await expect
      .element(dialog)
      .toHaveAccessibleDescription(
        "This removes the connection, its local vault copy, unlock key and sync sign-in from this device. It does not sign out other sessions, and the synced settings of its account stay for other devices and a later connection.",
      );
    // Close composes the repo's Button, including its ref and keyboard focus.
    const keep = dialog.getByRole("button", { name: "Keep connection", exact: true });
    await expect.element(keep).toHaveFocus();
    await keep.click();
    await expect.element(page.getByText("Connection kept.")).toBeVisible();
    await expect.element(more).toHaveFocus();
    expect(client.deleteConnection).not.toHaveBeenCalled();
    await more.click();
    await remove.click();
    await page
      .getByRole("alertdialog", { name: "Delete Leftover vault?", exact: true })
      .getByRole("button", { name: "Delete connection", exact: true })
      .click();
    await vi.waitFor(() => expect(client.deleteConnection).toHaveBeenCalledWith("leftover"));
    expect(client.deleteConnection).toHaveBeenCalledTimes(1);
    expect(client.requestProviderPermission).not.toHaveBeenCalled();
    await expect
      .element(page.getByText(/^Connection deleted from this device.*does not sign out/))
      .toBeVisible();
    await expect.element(page.getByText("Leftover vault", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Kept vault", { exact: true })).toBeVisible();
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalled();
  });

  test("the delete dialog traps focus, ignores its backdrop and keeps its payload through closing", async () => {
    const client = mockClient();
    const saved = (connectionId: string, label: string) => ({
      connectionId,
      label,
      email: "saved@example.test",
      environment: { kind: "cloud" as const, region: "us" as const },
      state: "configured" as const,
      autoUnlock: "unknown" as const,
      providerSession: "none" as const,
    });
    client.list.mockResolvedValue({
      ...status(),
      connections: [saved("first", "First vault"), saved("second", "Second vault")],
    });
    await mount(client);
    const more = page.getByRole("button", { name: "More for Second vault", exact: true });
    await more.click();
    await page
      .getByRole("menuitem", { name: "Second vault: Delete connection", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Delete Second vault?", exact: true });
    const keep = dialog.getByRole("button", { name: "Keep connection", exact: true });
    const remove = dialog.getByRole("button", { name: "Delete connection", exact: true });
    await expect.element(keep).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(remove).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect.element(keep).toHaveFocus();
    // A real pointer press on the backdrop leaves the modal and its safe action intact.
    const backdrop = document.querySelector<HTMLElement>("#bitwarden-delete-backdrop")!;
    await page.elementLocator(backdrop).click({ position: { x: 8, y: 8 } });
    await expect.element(dialog).toBeVisible();
    expect(client.begin).not.toHaveBeenCalled();
    expect(client.deleteConnection).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("Connections loaded. Add a vault or sign in again below."))
      .toBeVisible();
    await keep.click();
    await expect.element(more).toHaveFocus();
    await more.click();
    await page
      .getByRole("menuitem", { name: "Second vault: Delete connection", exact: true })
      .click();
    await expect.element(keep).toHaveFocus();
    const popup = dialog.element();
    await vi.waitFor(() => expect(getComputedStyle(popup).opacity).toBe("1"));
    // Hold a real CSS closing transition long enough to inspect the rendered payload.
    popup.style.transitionDuration = "1s";
    const title = popup.querySelector("h2")!;
    let lostPayload = false;
    const observer = new MutationObserver(() => {
      if (popup.isConnected && title.textContent !== "Delete Second vault?") lostPayload = true;
    });
    observer.observe(popup, { childList: true, characterData: true, subtree: true });
    try {
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(popup).toHaveAttribute("data-ending-style"));
      expect(popup.isConnected).toBe(true);
      expect(title.textContent).toBe("Delete Second vault?");
      await expect.element(more).toHaveFocus();
      await vi.waitFor(() => expect(popup.isConnected).toBe(false), { timeout: 2500 });
      expect(lostPayload).toBe(false);
    } finally {
      observer.disconnect();
    }
    await expect.element(page.getByText("Connection kept.", { exact: true })).toBeVisible();
    expect(client.deleteConnection).not.toHaveBeenCalled();
  });

  test.each(["keep", "escape", "delete"] as const)(
    "the closing dialog cannot activate its retained buttons after %s",
    async (action) => {
      const client = mockClient();
      const saved = {
        connectionId: "closing",
        label: "Closing vault",
        email: "saved@example.test",
        environment: { kind: "cloud" as const, region: "us" as const },
        state: "configured" as const,
        autoUnlock: "unknown" as const,
        providerSession: "none" as const,
      };
      client.list.mockResolvedValue({ ...status(), connections: [saved] });
      await mount(client);
      await page.getByRole("button", { name: "More for Closing vault", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Closing vault: Delete connection", exact: true })
        .click();
      const dialog = page.getByRole("alertdialog", { name: "Delete Closing vault?", exact: true });
      const popup = dialog.element();
      const keep = dialog.getByRole("button", { name: "Keep connection", exact: true });
      const remove = dialog.getByRole("button", { name: "Delete connection", exact: true });
      const keepButton = keep.element();
      const deleteButton = remove.element();
      await expect.element(keep).toHaveFocus();
      await vi.waitFor(() => expect(getComputedStyle(popup).opacity).toBe("1"));
      // The buttons remain rendered during an actual CSS exit; use pointer clicks on them.
      popup.style.transitionDuration = "5s";
      try {
        if (action === "delete") {
          client.list.mockResolvedValue(status());
          await remove.click();
          await expect
            .element(page.getByText(/^Connection deleted from this device/))
            .toBeVisible();
          // A fast result has already cleared busy, so that guard cannot mask this regression.
          await vi.waitFor(() => expect(deleteButton).not.toBeDisabled());
        } else if (action === "keep") await keep.click();
        else await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => expect(popup).toHaveAttribute("data-ending-style"));
        expect(popup.isConnected).toBe(true);
        await page.elementLocator(deleteButton).click();
        expect(client.deleteConnection).toHaveBeenCalledTimes(action === "delete" ? 1 : 0);
        if (action === "delete") {
          await page.elementLocator(keepButton).click();
          await expect
            .element(page.getByText(/^Connection deleted from this device/))
            .toBeVisible();
          await expect
            .element(page.getByText("Connection kept.", { exact: true }))
            .not.toBeInTheDocument();
        } else {
          await expect.element(page.getByText("Connection kept.", { exact: true })).toBeVisible();
          await expect.element(page.getByText("Closing vault", { exact: true })).toBeVisible();
        }
      } finally {
        for (const animation of popup.getAnimations()) animation.finish();
      }
      await vi.waitFor(() => expect(popup.isConnected).toBe(false));
    },
  );

  test("the delete dialog fits a phone viewport with a long connection name", async () => {
    await page.viewport(320, 640);
    try {
      const client = mockClient();
      const label = "Synthetic".repeat(30);
      client.list.mockResolvedValue({
        ...status(),
        connections: [
          {
            connectionId: "phone",
            label,
            email: "saved@example.test",
            environment: { kind: "cloud", region: "us" },
            state: "configured",
            autoUnlock: "unknown",
            providerSession: "none",
          },
        ],
      });
      await mount(client);
      await page.getByRole("button", { name: `More for ${label}`, exact: true }).click();
      await page
        .getByRole("menuitem", { name: `${label}: Delete connection`, exact: true })
        .click();
      const dialog = page.getByRole("alertdialog", { name: `Delete ${label}?`, exact: true });
      await expect
        .element(dialog.getByRole("button", { name: "Keep connection", exact: true }))
        .toHaveFocus();
      const popup = dialog.element();
      const bounds = popup.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(16);
      expect(bounds.right).toBeLessThanOrEqual(304);
      expect(bounds.top).toBeGreaterThanOrEqual(16);
      expect(bounds.bottom).toBeLessThanOrEqual(624);
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
      await userEvent.keyboard("{Escape}");
    } finally {
      await page.viewport(1280, 720);
    }
  });

  test("a failed delete keeps the connection listed and shows the error", async () => {
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
    client.list.mockResolvedValue({ ...status(), connections: [leftover] });
    client.deleteConnection.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
    await mount(client);
    await page.getByRole("button", { name: "More for Leftover vault", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Leftover vault: Delete connection", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "Delete Leftover vault?", exact: true })
      .getByRole("button", { name: "Delete connection", exact: true })
      .click();
    await expect.element(page.getByText(/reached a resource limit/)).toBeVisible();
    await expect.element(page.getByText("Leftover vault", { exact: true })).toBeVisible();
    // The row is usable again: its menu is enabled once the delete has failed.
    await expect
      .element(page.getByRole("button", { name: "More for Leftover vault", exact: true }))
      .toBeEnabled();
  });
}
