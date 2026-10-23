import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { i18n, saveLanguagePreference } from "../../apps/extension/src/i18n";
import { BitwardenSetup } from "../../apps/extension/src/options/bitwarden-setup";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import type { ConnectionClient } from "../../apps/extension/src/options/connection-client";
import type { SetupReply } from "../../apps/extension/src/connections/types";

const PASSWORD = "synthetic-translation-test-password";
const FLOW = "50000000-0000-4000-8000-000000000001";
const ready = (): SetupReply => ({
  ok: true,
  kind: "ready",
  connectionId: "synthetic",
  snapshotId: "synthetic-snapshot",
  policyReviewItemIds: [],
});
function client() {
  return {
    requestProviderPermission: vi
      .fn<ConnectionClient["requestProviderPermission"]>()
      .mockResolvedValue(true),
    list: vi
      .fn<ConnectionClient["list"]>()
      .mockResolvedValue({ ok: true, kind: "status", connections: [] }),
    begin: vi.fn<ConnectionClient["begin"]>().mockImplementation(async () => ready()),
    continue: vi.fn<ConnectionClient["continue"]>().mockImplementation(async () => ready()),
    cancel: vi.fn<ConnectionClient["cancel"]>(),
    sync: vi.fn<ConnectionClient["sync"]>(),
    disableAutoUnlock: vi.fn<ConnectionClient["disableAutoUnlock"]>(),
    lock: vi.fn<ConnectionClient["lock"]>(),
    unlock: vi.fn<ConnectionClient["unlock"]>(),
    forgetProviderSession: vi.fn<ConnectionClient["forgetProviderSession"]>(),
    deleteConnection: vi.fn<ConnectionClient["deleteConnection"]>(),
    review: vi.fn<ConnectionClient["review"]>(),
    sendEmailCode: vi
      .fn<ConnectionClient["sendEmailCode"]>()
      .mockImplementation(async (flowId) => ({
        ok: true,
        kind: "email-code",
        flowId,
        result: "sent",
      })),
    keepAlive: vi
      .fn<ConnectionClient["keepAlive"]>()
      .mockImplementation(async (flowId) => ({ ok: true, kind: "waiting", flowId })),
    close: vi.fn<ConnectionClient["close"]>(),
  };
}
function japanese(key: string) {
  const translated = i18n.t(key);
  expect(translated).not.toBe(key);
  return translated;
}
async function mount(value = client()) {
  const queries = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={queries}>
      <BitwardenSetup client={value} onCatalogChanged={vi.fn()} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByLabelText("Name", { exact: true })).toBeVisible();
  return queries;
}
async function credentials() {
  await page.getByLabelText("Name", { exact: true }).fill("Synthetic vault");
  await page.getByLabelText("Email", { exact: true }).fill("synthetic@example.test");
  await page.getByLabelText("Master password", { exact: true }).fill(PASSWORD);
}
beforeEach(() => {
  localStorage.clear();
  saveLanguagePreference("en");
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await i18n.changeLanguage("en");
});

test("language changes preserve sign-in inputs and focus, then localize a pending result without resubmitting", async () => {
  const value = client();
  let finish!: (reply: SetupReply) => void;
  value.begin.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const queries = await mount(value);
  await credentials();
  const password = page.getByLabelText("Master password", { exact: true }).element();
  await i18n.changeLanguage("ja");
  const translatedPassword = page.getByLabelText(japanese("Master password"), { exact: true });
  await expect.element(translatedPassword).toHaveValue(PASSWORD);
  await expect.element(translatedPassword).toHaveFocus();
  expect(translatedPassword.element()).toBe(password);
  await expect
    .element(page.getByLabelText(japanese("Email"), { exact: true }))
    .toHaveValue("synthetic@example.test");
  await page.getByRole("button", { name: japanese("Connect Bitwarden"), exact: true }).click();
  await vi.waitFor(() => expect(value.begin).toHaveBeenCalledOnce());
  await expect.element(translatedPassword).toHaveValue("");
  expect(value.begin.mock.calls[0]![0]).toMatchObject({
    password: PASSWORD,
    email: "synthetic@example.test",
  });
  await i18n.changeLanguage("en");
  finish(ready());
  const notice = "Vault verified, unlocked and copied to this device.";
  await expect.element(page.getByText(notice, { exact: true })).toBeVisible();
  await i18n.changeLanguage("ja");
  await expect.element(page.getByText(japanese(notice), { exact: true })).toBeVisible();
  expect(value.begin).toHaveBeenCalledOnce();
  expect(JSON.stringify(queries.getQueryCache().getAll())).not.toContain(PASSWORD);
  expect(JSON.stringify(queries.getMutationCache().getAll())).not.toContain(PASSWORD);
});

// The authenticator (0) and email (1), which sends its code first as the official extension.
test.each([0, 1] as const)(
  "a manual MFA draft survives translation and submits exactly once with provider %i",
  async (provider) => {
    const value = client();
    value.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId: FLOW,
      expiresAt: Date.now() + 3_600_000,
      providers: [provider],
    });
    let finish!: (reply: SetupReply) => void;
    value.continue.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount(value);
    await credentials();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    const code = page.getByLabelText("Verification code", { exact: true });
    await code.fill("000123");
    const element = code.element();
    await i18n.changeLanguage("ja");
    const translatedCode = page.getByLabelText(japanese("Verification code"), { exact: true });
    await expect.element(translatedCode).toHaveValue("000123");
    await expect.element(translatedCode).toHaveFocus();
    expect(translatedCode.element()).toBe(element);
    await page.getByRole("button", { name: japanese("Verify code"), exact: true }).click();
    await vi.waitFor(() =>
      expect(value.continue).toHaveBeenCalledExactlyOnceWith({
        flowId: FLOW,
        twoFactor: { provider, code: "000123" },
      }),
    );
    await expect.element(translatedCode).toHaveValue("");
    await i18n.changeLanguage("en");
    expect(value.continue).toHaveBeenCalledOnce();
    finish(ready());
  },
);

test("the email code's send result and Resend follow the language", async () => {
  const value = client();
  value.begin.mockResolvedValue({
    ok: true,
    kind: "mfa-required",
    flowId: FLOW,
    providers: [1],
    expiresAt: Date.now() + 3_600_000,
  });
  await mount(value);
  await credentials();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  const sent = "The server sent a verification code to the account's two-step email.";
  await expect.element(page.getByText(sent, { exact: true })).toBeVisible();
  expect(value.sendEmailCode).toHaveBeenCalledExactlyOnceWith(FLOW);
  await i18n.changeLanguage("ja");
  await expect.element(page.getByText(japanese(sent), { exact: true })).toBeVisible();
  // The code screen's end is worded and formatted in the page's language.
  await expect
    .element(page.getByText(/^.+ までにコードを入力してください。それを過ぎるとログインが終了し/u))
    .toBeVisible();
  value.sendEmailCode.mockResolvedValueOnce({
    ok: true,
    kind: "email-code",
    flowId: FLOW,
    result: "rate-limited",
  });
  await page.getByRole("button", { name: japanese("Resend code"), exact: true }).click();
  await expect
    .element(
      page.getByText(
        japanese("The server is limiting code emails. Wait a few minutes before resending."),
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(value.sendEmailCode).toHaveBeenCalledTimes(2);
});

test("a stored vault label remains literal text in Japanese", async () => {
  const value = client();
  const label = "<img src=x onerror=alert(1)>";
  value.list.mockResolvedValue({
    ok: true,
    kind: "status",
    connections: [
      {
        connectionId: "synthetic",
        label,
        email: "synthetic@example.test",
        environment: { kind: "cloud", region: "us" },
        state: "disabled",
        autoUnlock: "disabled",
        providerSession: "none",
      },
    ],
  });
  await i18n.changeLanguage("ja");
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <BitwardenSetup client={value} onCatalogChanged={vi.fn()} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
});

test("self-hosted address validation translates in place before any provider request", async () => {
  const value = client();
  await mount(value);
  await credentials();
  await page.getByRole("combobox", { name: "Server", exact: true }).selectOptions("self-hosted");
  await page
    .getByLabelText("Server address", { exact: true })
    .fill("https://synthetic.example/path");
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  const message =
    "Enter a name, a valid email and the master password. A self-hosted server address is an HTTPS address such as https://vault.example.com, or HTTP on localhost or 127.0.0.1, with no path, credentials, query or fragment.";
  await expect.element(page.getByText(message, { exact: true })).toBeVisible();
  await i18n.changeLanguage("ja");
  await expect.element(page.getByText(japanese(message), { exact: true })).toBeVisible();
  await expect
    .element(page.getByLabelText(japanese("Server address"), { exact: true }))
    .toHaveValue("https://synthetic.example/path");
  expect(value.requestProviderPermission).not.toHaveBeenCalled();
  expect(value.begin).not.toHaveBeenCalled();
});
