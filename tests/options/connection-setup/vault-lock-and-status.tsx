import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { ConnectionSetupTestContext } from "./context";

export function registerVaultLockAndStatus({
  password,
  status,
  mockClient,
  mount,
  registered,
  lockedVault,
  unlockField,
  unlockRow,
  submitUnlock,
}: Pick<
  ConnectionSetupTestContext,
  | "password"
  | "status"
  | "mockClient"
  | "mount"
  | "registered"
  | "lockedVault"
  | "unlockField"
  | "unlockRow"
  | "submitUnlock"
>) {
  test("a locked vault offers Unlock in its row instead of Sync or a sign-in", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [{ ...lockedVault, providerSession: "none" }],
    });
    await mount(client);
    await expect.element(page.getByText("Vault locked", { exact: true })).toBeVisible();
    await expect.element(unlockRow()).toHaveAttribute("aria-expanded", "false");
    // Even without a sync sign-in, the offline unlock comes first.
    expect(page.getByRole("button", { name: "Locked vault: Sign in again" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Locked vault: Sync" }).query()).toBeNull();
    expect(document.body.textContent).not.toContain("Automatic unlock");
    expect(document.body.textContent).not.toContain("Locks at the vault timeout");
    await unlockRow().click();
    await expect.element(unlockRow()).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByText("locked@example.test", { exact: true }).last())
      .toBeVisible();
    await expect.element(unlockField()).toHaveFocus();
    // The button closes the form again without a request.
    await unlockRow().click();
    await expect.element(submitUnlock()).not.toBeInTheDocument();
    expect(client.unlock).not.toHaveBeenCalled();
  });

  test("Unlock sends the master password to the worker and re-reads the vaults", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [lockedVault] })
      .mockResolvedValue({
        ...status(),
        connections: [{ ...lockedVault, state: "ready" as const }],
      });
    const { changed } = await mount(client);
    await unlockRow().click();
    await unlockField().fill(password);
    await submitUnlock().click();
    await vi.waitFor(() =>
      expect(client.unlock).toHaveBeenCalledExactlyOnceWith("saved-l", password),
    );
    await expect.element(page.getByText("Vault unlocked.", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Locked vault: Sync", exact: true }))
      .toBeVisible();
    expect(page.getByLabelText("Master password", { exact: true }).elements()).toHaveLength(1);
    expect(changed).toHaveBeenCalled();
    expect(client.begin).not.toHaveBeenCalled();
    expect(client.requestProviderPermission).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(password);
  });

  test("a wrong master password keeps the unlock form open and says so", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [lockedVault] });
    client.unlock.mockResolvedValueOnce({
      ok: false,
      error: { code: "crypto-failed", check: "master-password" },
    });
    await mount(client);
    await unlockRow().click();
    await unlockField().fill("synthetic-wrong-password");
    await submitUnlock().click();
    await expect
      .element(page.getByText("Invalid master password.", { exact: true }).first())
      .toBeVisible();
    await expect.element(unlockField()).toHaveValue("");
    await expect.element(unlockField()).toHaveAttribute("aria-invalid", "true");
    await expect.element(submitUnlock()).toBeVisible();
    expect(client.list).toHaveBeenCalledTimes(1);
    // The next try reaches the worker again.
    await unlockField().fill(password);
    await submitUnlock().click();
    await vi.waitFor(() => expect(client.unlock).toHaveBeenCalledTimes(2));
    await expect.element(page.getByText("Vault unlocked.", { exact: true })).toBeVisible();
  });

  test("an unlock the vault data refuses names the check instead of a wrong password", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [lockedVault] });
    client.unlock.mockResolvedValueOnce({
      ok: false,
      error: { code: "crypto-failed", check: "sdk-decrypt" },
    });
    await mount(client);
    await unlockRow().click();
    await unlockField().fill(password);
    await submitUnlock().click();
    const text =
      "Pateat could not decrypt this vault's data (check: sdk-decrypt). Report this check name.";
    // Said in the form and in the page status.
    await vi.waitFor(() =>
      expect(page.getByText(text, { exact: true }).elements().length).toBeGreaterThanOrEqual(2),
    );
    expect(document.body.textContent).not.toContain("Invalid master password.");
    expect(document.body.textContent).not.toContain("Refresh and try again");
    await expect.element(unlockField()).not.toHaveAttribute("aria-invalid");
  });

  test("an unlock the crypto host itself fails asks to refresh, not for a check name", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [lockedVault] });
    client.unlock.mockResolvedValueOnce({ ok: false, error: { code: "crypto-failed" } });
    await mount(client);
    await unlockRow().click();
    await unlockField().fill(password);
    await submitUnlock().click();
    await expect
      .element(
        page.getByText("The vault could not be unlocked. Refresh and try again.", { exact: true }),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Invalid master password.");
    expect(document.body.textContent).not.toContain("could not decrypt");
  });

  test("a sync the vault data refuses says which check, not to refresh", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    client.list.mockResolvedValue({ ...status(), connections: [open] });
    client.sync.mockResolvedValueOnce({
      ok: false,
      error: { code: "crypto-failed", check: "attachment" },
    });
    await mount(client);
    await page.getByRole("button", { name: "Locked vault: Sync", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "Pateat could not decrypt this vault's data (check: attachment). Report this check name.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Refresh, then try again");
  });

  test("the last automatic check's failure is a status line of its connection", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          ...open,
          syncedAt: Date.UTC(2026, 10, 9, 20, 0),
          syncFailure: {
            at: Date.UTC(2026, 10, 11, 9, 0),
            code: "crypto-failed",
            check: "sdk-decrypt",
          },
        },
      ],
    });
    await mount(client);
    await expect
      .element(
        page.getByText(
          /^Last automatic sync failed \(.+\)\. Pateat could not decrypt this vault's data \(check: sdk-decrypt\)\. Report this check name\.$/,
        ),
      )
      .toBeVisible();
  });

  test("an automatic check that failed otherwise gives its code and asks to press Sync", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        { ...open, syncFailure: { at: Date.UTC(2026, 10, 11, 9, 0), code: "network" } },
      ],
    });
    await mount(client);
    await expect
      .element(
        page.getByText(
          /^Last automatic sync failed \(.+, network\)\. Press Sync to try again now\.$/,
        ),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Refresh, then try again");
  });

  test("a connection whose checks did not fail shows no automatic sync line", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    client.list.mockResolvedValue({ ...status(), connections: [open] });
    await mount(client);
    await expect.element(page.getByText("Automatic unlock on", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("Last automatic sync failed");
  });

  test("items strict decryption refused are listed by ID with a link to the web vault", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    const itemId = "00000000-0000-4000-8000-000000000002";
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          ...open,
          environment: { kind: "cloud" as const, region: "eu" as const },
          unusableItems: [{ itemId, check: "sdk-decrypt" }],
          unusableItemCount: 3,
        },
      ],
    });
    await mount(client);
    await expect
      .element(
        page.getByText(
          "3 items could not be read and are not used. Open each in Bitwarden to fix or delete it.",
          { exact: true },
        ),
      )
      .toBeVisible();
    const link = page.getByRole("link", { name: `Item ${itemId} (check: sdk-decrypt)` });
    await expect
      .element(link)
      .toHaveAttribute("href", `https://vault.bitwarden.eu/#/vault?itemId=${itemId}`);
    await expect.element(link).toHaveAttribute("target", "_blank");
  });

  test("items used without some fields are listed with the fields not read", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    const itemId = "00000000-0000-4000-8000-000000000003";
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        {
          ...open,
          partialItems: [
            {
              itemId,
              fields: ["login.password", "fields.2.value", "login.uris.0", "card.number"],
              moreFieldCount: 3,
            },
          ],
          partialItemCount: 2,
        },
      ],
    });
    await mount(client);
    await expect
      .element(
        page.getByText(
          "2 items are used without the fields that could not be read. Open each in Bitwarden to fix those fields.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByRole("link", {
          name: `Item ${itemId} (not read: Password, Custom field 3 value, URI 1, card.number, 3 more)`,
        }),
      )
      .toHaveAttribute("href", `https://vault.bitwarden.com/#/vault?itemId=${itemId}`);
  });

  test("one unusable item is named in the singular", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    client.list.mockResolvedValue({
      ...status(),
      connections: [
        { ...open, unusableItems: [{ itemId: "00000000-0000-4000-8000-000000000002" }] },
      ],
    });
    await mount(client);
    await expect
      .element(
        page.getByText(
          "1 item could not be read and is not used. Open it in Bitwarden to fix or delete it.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Item 00000000-0000-4000-8000-000000000002" }))
      .toHaveAttribute(
        "href",
        "https://vault.bitwarden.com/#/vault?itemId=00000000-0000-4000-8000-000000000002",
      );
  });

  test("an unlock that fails otherwise says the vault could not be unlocked", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [lockedVault] });
    client.unlock.mockResolvedValueOnce({ ok: false, error: { code: "storage-failed" } });
    await mount(client);
    await unlockRow().click();
    await unlockField().fill(password);
    await submitUnlock().click();
    await expect
      .element(
        page.getByText("The vault could not be unlocked. Refresh and try again.", { exact: true }),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Invalid master password.");
    await expect.element(unlockField()).not.toHaveAttribute("aria-invalid");
  });

  test("Lock in the row menu locks the vault and keeps its sync sign-in", async () => {
    const client = mockClient();
    const open = { ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const };
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [open] })
      .mockResolvedValue({ ...status(), connections: [lockedVault] });
    const { changed } = await mount(client);
    await page.getByRole("button", { name: "More for Locked vault", exact: true }).click();
    await page.getByRole("menuitem", { name: "Locked vault: Lock", exact: true }).click();
    await vi.waitFor(() => expect(client.lock).toHaveBeenCalledExactlyOnceWith("saved-l"));
    expect(client.disableAutoUnlock).not.toHaveBeenCalled();
    await expect
      .element(
        page.getByText(
          "Vault locked. Unlock it with the master password; the sync sign-in stays.",
          {
            exact: true,
          },
        ),
      )
      .toBeVisible();
    await expect.element(unlockRow()).toBeVisible();
    expect(changed).toHaveBeenCalled();
    // A locked vault cannot be locked again, but can still be logged out.
    await page.getByRole("button", { name: "More for Locked vault", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Locked vault: Lock", exact: true }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("menuitem", { name: "Locked vault: Log out", exact: true }))
      .not.toHaveAttribute("aria-disabled", "true");
  });

  test("Log out in the row menu removes the unlock key and the sync sign-in", async () => {
    const client = mockClient();
    client.list
      .mockResolvedValueOnce({ ...status(), connections: [lockedVault] })
      .mockResolvedValue({
        ...status(),
        connections: [
          { ...lockedVault, state: "disabled" as const, providerSession: "none" as const },
        ],
      });
    client.disableAutoUnlock.mockResolvedValueOnce({
      ok: true,
      kind: "disabled",
      connectionId: "saved-l",
    });
    await mount(client);
    await unlockRow().click();
    await expect.element(submitUnlock()).toBeVisible();
    await page.getByRole("button", { name: "More for Locked vault", exact: true }).click();
    await page.getByRole("menuitem", { name: "Locked vault: Log out", exact: true }).click();
    await vi.waitFor(() =>
      expect(client.disableAutoUnlock).toHaveBeenCalledExactlyOnceWith("saved-l"),
    );
    expect(client.lock).not.toHaveBeenCalled();
    await expect
      .element(
        page.getByText("Logged out on this device. Sign in again to use this vault.", {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("Logged out on this device", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Locked vault: Sign in again", exact: true }))
      .toBeVisible();
    // The open unlock form went with the lock state.
    await expect.element(submitUnlock()).not.toBeInTheDocument();
    await page.getByRole("button", { name: "More for Locked vault", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Locked vault: Log out", exact: true }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("menuitem", { name: "Locked vault: Lock", exact: true }))
      .toHaveAttribute("aria-disabled", "true");
  });

  test("Lock is not offered for a connection that never unlocked", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({ ...status(), connections: [registered] });
    await mount(client);
    await page.getByRole("button", { name: "More for Synthetic vault", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Synthetic vault: Lock", exact: true }))
      .toHaveAttribute("aria-disabled", "true");
  });

  test("an open vault whose key is in memory says it locks at the vault timeout", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [{ ...lockedVault, state: "ready" as const }],
    });
    await mount(client);
    await expect
      .element(page.getByText("Locks at the vault timeout", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Automatic unlock off");
  });

  test("a sync of a vault locked meanwhile asks for the unlock", async () => {
    const client = mockClient();
    client.list.mockResolvedValue({
      ...status(),
      connections: [{ ...lockedVault, state: "ready" as const, autoUnlock: "enabled" as const }],
    });
    client.sync.mockResolvedValueOnce({ ok: false, error: { code: "vault-locked" } });
    await mount(client);
    await page.getByRole("button", { name: "Locked vault: Sync", exact: true }).click();
    await expect
      .element(
        page.getByText("The vault is locked. Unlock it with the master password first.", {
          exact: true,
        }),
      )
      .toBeVisible();
  });
}
