import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type { SetupReply } from "../../../apps/extension/src/connections/types";
import type { ConnectionSetupTestContext } from "./context";

export function registerAddAndVerification({
  password,
  flowId,
  expiresAt,
  ready,
  mockClient,
  held,
  mount,
  fillNew,
}: Pick<
  ConnectionSetupTestContext,
  "password" | "flowId" | "expiresAt" | "ready" | "mockClient" | "held" | "mount" | "fillNew"
>) {
  test.each(["o'brien@example.test", "tom&jerry@example.test", "name@example.x"])(
    "an email the official Bitwarden login accepts, %s, is sent to the worker",
    async (email) => {
      const { client } = await mount();
      await fillNew();
      await page.getByLabelText("Email", { exact: true }).fill(email);
      await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
      await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
      expect(client.begin.mock.calls[0]![0]).toMatchObject({ kind: "new", email });
    },
  );

  test.each(["first..last@example.test", ".first@example.test", "名前@example.test"])(
    "an email the official Bitwarden login refuses, %s, never starts a permission prompt",
    async (email) => {
      const { client } = await mount();
      await fillNew();
      await page.getByLabelText("Email", { exact: true }).fill(email);
      await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
      await expect.element(page.getByText(/a valid email and the master password/)).toBeVisible();
      expect(client.requestProviderPermission).not.toHaveBeenCalled();
      expect(client.begin).not.toHaveBeenCalled();
    },
  );

  test("a loopback HTTP address asks for that origin only (ADR 0059)", async () => {
    const client = mockClient();
    client.requestProviderPermission.mockResolvedValue(false);
    await mount(client);
    await fillNew();
    await page.getByRole("combobox", { name: "Server", exact: true }).selectOptions("self-hosted");
    await page.getByLabelText("Server address", { exact: true }).fill("http://localhost:8000");
    await expect.element(page.getByText("Chrome asks for access to localhost:8000.")).toBeVisible();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    expect(client.requestProviderPermission).toHaveBeenCalledWith({
      kind: "self-hosted",
      baseUrl: "http://localhost:8000",
    });
  });

  test("permission denial clears the password and sends no sign-in request", async () => {
    const client = mockClient();
    client.requestProviderPermission.mockResolvedValue(false);
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(
        page.getByText("Chrome did not grant access to the Bitwarden server, so nothing was sent."),
      )
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
      .element(page.getByText("Vault verified, unlocked and copied to this device."))
      .toBeVisible();
  });

  test.each([
    "http://vault.example",
    "http://localhost.example",
    "http://[::1]:8000",
    "https://vault.example/path",
    "https://user@vault.example",
  ])("invalid self-hosted address %s never starts a permission prompt", async (address) => {
    const { client } = await mount();
    await fillNew();
    await page.getByRole("combobox", { name: "Server", exact: true }).selectOptions("self-hosted");
    await page.getByLabelText("Server address", { exact: true }).fill(address);
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect
      .element(
        page.getByText(
          /A self-hosted server address is an HTTPS address such as https:\/\/vault\.example\.com, or HTTP on localhost/,
        ),
      )
      .toBeVisible();
    expect(client.requestProviderPermission).not.toHaveBeenCalled();
    expect(client.begin).not.toHaveBeenCalled();
  });

  test("pasted name, email and server address are trimmed before they are checked and sent", async () => {
    const { client } = await mount();
    await fillNew();
    await page.getByLabelText("Name", { exact: true }).fill("  Synthetic vault ");
    await page.getByLabelText("Email", { exact: true }).fill(" test@example.test ");
    await page.getByRole("combobox", { name: "Server", exact: true }).selectOptions("self-hosted");
    await page
      .getByLabelText("Server address", { exact: true })
      .fill(" https://vault.example.test ");
    await expect
      .element(page.getByText(/Chrome asks for access to vault\.example\.test/))
      .toBeVisible();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    expect(client.requestProviderPermission.mock.calls[0]![0]).toMatchObject({
      kind: "self-hosted",
      baseUrl: expect.stringMatching(/^https:\/\/vault\.example\.test\/?$/),
    });
    expect(client.begin.mock.calls[0]![0]).toMatchObject({
      kind: "new",
      label: "Synthetic vault",
      email: "test@example.test",
    });
  });

  test("verification codes are sent with their ends trimmed and a blank code sends nothing", async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0],
      expiresAt,
    });
    client.continue.mockResolvedValue({
      ok: true,
      kind: "new-device-verification-required",
      flowId,
      invalidOtp: false,
      expiresAt,
    });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    const mfaCode = page.getByLabelText("Verification code", { exact: true });
    await mfaCode.fill("   ");
    await expect
      .element(page.getByRole("button", { name: "Verify code", exact: true }))
      .toBeDisabled();
    await mfaCode.fill(" 123456\t");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(1));
    expect(client.continue).toHaveBeenCalledWith({
      flowId,
      twoFactor: { provider: 0, code: "123456" },
    });
    await page.getByLabelText("New-device verification code", { exact: true }).fill("\t987654 ");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(2));
    expect(client.continue).toHaveBeenLastCalledWith({ flowId, newDeviceOtp: "987654" });
  });

  test("manual MFA clears the code on submission and never resends without another user action", async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0, 1],
      expiresAt,
    });
    const pending = held<SetupReply>();
    client.continue.mockReturnValue(pending.promise);
    const { queryClient } = await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
    expect(client.continue).not.toHaveBeenCalled();
    expect(client.sendEmailCode).not.toHaveBeenCalled();
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("1");
    await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(1));
    await page.getByLabelText("Verification code", { exact: true }).fill("000123");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(1));
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toHaveValue("");
    expect(client.continue).toHaveBeenCalledWith({
      flowId,
      twoFactor: { provider: 1, code: "000123" },
    });
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain("000123");
    pending.resolve({ ok: true, kind: "mfa-required", flowId, providers: [1], expiresAt });
    await expect
      .element(page.getByRole("button", { name: "Verify code", exact: true }))
      .toBeDisabled();
    expect(client.continue).toHaveBeenCalledTimes(1);
    // The reply was handled once the earlier send's line is gone; the same sign-in already
    // had its one automatic email.
    await expect
      .element(page.getByText(/The server sent a verification code/))
      .not.toBeInTheDocument();
    expect(client.sendEmailCode).toHaveBeenCalledTimes(1);
  });

  test("choosing email sends one code like the official extension, and Resend code sends another", async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0, 1],
      expiresAt,
    });
    const pending = held<SetupReply>();
    client.sendEmailCode.mockReturnValueOnce(pending.promise);
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
    expect(client.sendEmailCode).not.toHaveBeenCalled();
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("1");
    await expect
      .element(page.getByText("Asking the server to email a verification code…", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Resend code", exact: true }))
      .toBeDisabled();
    pending.resolve({ ok: true, kind: "email-code", flowId, result: "sent" });
    await expect
      .element(
        page.getByText("The server sent a verification code to the account's two-step email.", {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(client.sendEmailCode).toHaveBeenCalledWith(flowId);
    // Switching away and back sends nothing more on its own.
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("0");
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("1");
    expect(client.sendEmailCode).toHaveBeenCalledTimes(1);
    client.sendEmailCode.mockResolvedValueOnce({
      ok: true,
      kind: "email-code",
      flowId,
      result: "rate-limited",
    });
    await page.getByRole("button", { name: "Resend code", exact: true }).click();
    await expect.element(page.getByText(/The server is limiting code emails/)).toBeVisible();
    expect(client.sendEmailCode).toHaveBeenCalledTimes(2);
    // The answer is read out, and focus goes back to the code.
    await expect
      .element(page.getByRole("status").filter({ hasText: /limiting code emails/ }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toHaveFocus();
    // As the official page, a send that did not go out is tried again when email is chosen
    // again.
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("0");
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("1");
    await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(3));
    await expect.element(page.getByText(/The server sent a verification code/)).toBeVisible();
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("0");
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("1");
    expect(client.sendEmailCode).toHaveBeenCalledTimes(3);
    expect(client.continue).not.toHaveBeenCalled();
  });

  test("a new sign-in sends its own code, and a send the background refuses ends the sign-in", async () => {
    const client = mockClient();
    const second = "50000000-0000-4000-8000-000000000002";
    client.begin
      .mockResolvedValueOnce({ ok: true, kind: "mfa-required", flowId, providers: [1], expiresAt })
      .mockResolvedValueOnce({
        ok: true,
        kind: "mfa-required",
        flowId: second,
        providers: [1],
        expiresAt,
      });
    client.sendEmailCode
      .mockResolvedValueOnce({ ok: false, error: { code: "provider-permission-required" } })
      .mockResolvedValueOnce({ ok: true, kind: "email-code", flowId: second, result: "sent" });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledWith(flowId));
    await expect
      .element(page.getByLabelText("Verification code", { exact: true }))
      .not.toBeInTheDocument();
    await page.getByLabelText("Master password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByText(/The server sent a verification code/)).toBeVisible();
    expect(client.sendEmailCode).toHaveBeenLastCalledWith(second);
    expect(client.sendEmailCode).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["unavailable", /This server cannot send email codes/],
    ["refused", /The server did not send a code/],
    ["failed", /The code email could not be requested/],
  ] as const)("an email-only sign-in sends its code at once and shows %s", async (result, line) => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [1],
      expiresAt,
    });
    client.sendEmailCode.mockResolvedValue({ ok: true, kind: "email-code", flowId, result });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByText(line)).toBeVisible();
    expect(client.sendEmailCode).toHaveBeenCalledTimes(1);
    // The sign-in still waits for a code.
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
  });
}
