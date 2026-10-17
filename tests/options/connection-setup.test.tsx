import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
// oxlint-disable-next-line import/no-unassigned-import -- Exercise real modal positioning and transitions.
import "../../apps/extension/entrypoints/options/style.css";
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
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import type { SetupReply } from "../../apps/extension/src/connections/types";
import { localClockTime, localSyncTime } from "../../apps/extension/src/time";

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
    await expect.element(page.getByText(/valid email and master password/)).toBeVisible();
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
  await expect.element(page.getByText("Chrome asks for access to localhost:8000")).toBeVisible();
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
    .element(page.getByText(/Self-hosted addresses must be HTTPS roots, or HTTP on localhost/))
    .toBeVisible();
  expect(client.requestProviderPermission).not.toHaveBeenCalled();
  expect(client.begin).not.toHaveBeenCalled();
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
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
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
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
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
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("0");
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
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
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("0");
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
  await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(3));
  await expect.element(page.getByText(/The server sent a verification code/)).toBeVisible();
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("0");
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
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

test("a waiting challenge keeps the worker running until its flow ends", async () => {
  await withFakeInterval(async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0],
      expiresAt,
    });
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
    // The first message goes out as the challenge shows, before the worker's idle count ends.
    await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalled());
    expect(client.keepAlive).toHaveBeenCalledWith(flowId);
    await painted();
    const shown = client.keepAlive.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(shown + 1));
    // A busy worker's refusal leaves the challenge waiting.
    client.keepAlive.mockResolvedValueOnce({ ok: false, error: { code: "resource-limit" } });
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(shown + 2));
    await painted();
    expect(page.getByLabelText("Verification code", { exact: true }).query()).not.toBeNull();
    // The page asks again as soon as it shows, after Chrome slowed a background tab's timers.
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(shown + 3));
    // A flow the worker no longer holds before its 5 minutes, as after Chrome restarted the
    // worker, ends the challenge and says so where the password goes.
    client.keepAlive.mockResolvedValueOnce({ ok: false, error: { code: "setup-expired" } });
    vi.advanceTimersByTime(20_000);
    await expect.element(page.getByText(expiredText)).toBeVisible();
    await expect
      .element(page.getByLabelText("Verification code", { exact: true }))
      .not.toBeInTheDocument();
    expect(endedLine()).toMatch(
      /^The sign-in ended early, by .+, before its 5 minutes\. This usually means Chrome stopped Pateat's background\. Enter the master password to start again\.$/u,
    );
    // React runs the effect's cleanup after the next paint.
    await painted();
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await painted();
    expect(client.keepAlive).toHaveBeenCalledTimes(shown + 4);
  });
});

test("the code screen names its end, and the page asks as it comes", async () => {
  const client = mockClient();
  // The end is a real timer, so it is set close: the page asks once it passes.
  const soon = Date.now() + 2_500;
  client.begin.mockResolvedValueOnce({
    ok: true,
    kind: "mfa-required",
    flowId,
    providers: [0],
    expiresAt: soon,
  });
  client.keepAlive.mockImplementation(async (id) =>
    Date.now() < soon
      ? { ok: true, kind: "waiting", flowId: id }
      : { ok: false, error: { code: "setup-expired" } },
  );
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await expect
    .element(page.getByText(`Enter the code by ${localClockTime(soon)}.`, { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText("The sign-in timed out waiting for the code."), { timeout: 5_000 })
    .toBeVisible();
  await expect
    .element(page.getByLabelText("Verification code", { exact: true }))
    .not.toBeInTheDocument();
  expect(endedLine()).toBe(
    `The sign-in timed out at ${localClockTime(soon)}: no code was entered within 5 minutes. Enter the master password to start again.`,
  );
  // The reason is read with the password field it is next to.
  expect(document.querySelector("#bitwarden-password")?.getAttribute("aria-describedby")).toBe(
    "bitwarden-sign-in-ended",
  );
  // Starting again clears it.
  await page.getByLabelText("Master password", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(endedLine()).toBeNull());
});

test("a refused code keeps the code screen, its method and its sent email", async () => {
  const client = mockClient();
  const challenge = {
    ok: true as const,
    kind: "mfa-required" as const,
    flowId,
    providers: [0, 1] as (0 | 1)[],
    expiresAt,
  };
  client.begin.mockResolvedValue(challenge);
  client.continue
    .mockResolvedValueOnce({ ...challenge, invalidCode: true })
    .mockResolvedValueOnce(ready());
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await page.getByRole("combobox", { name: "Verification method", exact: true }).selectOptions("1");
  await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(1));
  await page.getByLabelText("Verification code", { exact: true }).fill("000111");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect
    .element(
      page.getByText(
        "The code was not accepted: it is wrong or no longer valid. Enter the code from the latest email, or Resend code.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByText("The code was not accepted.", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Verification method", exact: true }))
    .toHaveValue("1");
  // No second email without Resend code, and the code field is empty and focused for the next.
  await painted();
  expect(client.sendEmailCode).toHaveBeenCalledTimes(1);
  await expect.element(page.getByLabelText("Verification code", { exact: true })).toHaveValue("");
  await expect.element(page.getByLabelText("Verification code", { exact: true })).toHaveFocus();
  expect(endedLine()).toBeNull();
  // A new code clears the warning about the refused one.
  await page.getByRole("button", { name: "Resend code", exact: true }).click();
  await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(2));
  await expect
    .element(page.getByText(/^The code was not accepted: it is wrong/u))
    .not.toBeInTheDocument();
  await page.getByLabelText("Verification code", { exact: true }).fill("000123");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect
    .element(
      page.getByText(
        "Vault verified and local cache accepted. Check automatic-unlock status below.",
      ),
    )
    .toBeVisible();
  expect(client.continue).toHaveBeenLastCalledWith({
    flowId,
    twoFactor: { provider: 1, code: "000123" },
  });
});

test("heartbeats that find the end at once end the challenge once", async () => {
  const client = mockClient();
  client.begin.mockResolvedValue({
    ok: true,
    kind: "mfa-required",
    flowId,
    providers: [0],
    expiresAt,
  });
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(1));
  await painted();
  const answers = held<SetupReply>();
  client.keepAlive.mockReturnValue(answers.promise);
  // As when a frozen tab shows again and its overdue timers run with it.
  document.dispatchEvent(new Event("visibilitychange"));
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(3));
  const reads = client.list.mock.calls.length;
  answers.resolve({ ok: false, error: { code: "setup-expired" } });
  await expect.element(page.getByText(expiredText, { exact: true })).toBeVisible();
  await painted();
  await painted();
  expect(page.getByText(expiredText, { exact: true }).query()).not.toBeNull();
  expect(client.list).toHaveBeenCalledTimes(reads + 1);
});

test("work the end stopped after a code says it reached the end", async () => {
  const client = mockClient();
  const pending = held<SetupReply>();
  const end = Date.now() + 1_000;
  client.begin.mockResolvedValue({
    ok: true,
    kind: "mfa-required",
    flowId,
    providers: [0],
    expiresAt: end,
  });
  client.continue.mockReturnValue(pending.promise);
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await page.getByLabelText("Verification code", { exact: true }).fill("000123");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(end), { timeout: 3_000 });
  // The server took the code, but the vault download and unlock ran past the end.
  pending.resolve({ ok: false, error: { code: "cancelled" } });
  const late =
    "The sign-in reached its 5-minute end before it finished. Enter the master password to start again.";
  await expect.element(page.getByText(late, { exact: true }).first()).toBeVisible();
  expect(endedLine()).toBe(late);
});

test("a refused new-device code keeps its screen until Verify", async () => {
  const client = mockClient();
  const challenge = {
    ok: true as const,
    kind: "new-device-verification-required" as const,
    flowId,
    invalidOtp: false,
    expiresAt,
  };
  client.begin.mockResolvedValue(challenge);
  client.continue.mockResolvedValueOnce({ ...challenge, invalidOtp: true });
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await page.getByLabelText("New-device verification code", { exact: true }).fill("000111");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect
    .element(
      page.getByText(
        "The code was not accepted: it is wrong or no longer valid. Enter the code from the latest email.",
      ),
    )
    .toBeVisible();
  expect(endedLine()).toBeNull();
});

test("a code entered after the end says the sign-in timed out", async () => {
  const client = mockClient();
  const past = Date.now() - 1;
  client.begin.mockResolvedValue({
    ok: true,
    kind: "new-device-verification-required",
    flowId,
    invalidOtp: false,
    expiresAt: past,
  });
  // The heartbeat cannot tell first: the worker is busy.
  client.keepAlive.mockResolvedValue({ ok: false, error: { code: "resource-limit" } });
  client.continue.mockResolvedValue({ ok: false, error: { code: "setup-expired" } });
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await page.getByLabelText("New-device verification code", { exact: true }).fill("000123");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect.element(page.getByText("The sign-in timed out waiting for the code.")).toBeVisible();
  expect(endedLine()).toBe(
    `The sign-in timed out at ${localClockTime(past)}: no code was entered within 5 minutes. Enter the master password to start again.`,
  );
});

test.each([
  ["email only", [1] as (0 | 1)[], false],
  ["email only, after Resend code", [1] as (0 | 1)[], true],
  ["email chosen after the authenticator", [0, 1] as (0 | 1)[], false],
])(
  "an ended flow ends the challenge after an email code was sent: %s",
  async (_, providers, resend) => {
    await withFakeInterval(async () => {
      const client = mockClient();
      client.begin.mockResolvedValue({
        ok: true,
        kind: "mfa-required",
        flowId,
        providers,
        expiresAt,
      });
      await mount(client);
      await fillNew();
      await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
      await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
      if (providers[0] === 0)
        await page
          .getByRole("combobox", { name: "Verification method", exact: true })
          .selectOptions("1");
      await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(1));
      await expect.element(page.getByText(/The server sent a verification code/)).toBeVisible();
      if (resend) {
        await page.getByRole("button", { name: "Resend code", exact: true }).click();
        await vi.waitFor(() => expect(client.sendEmailCode).toHaveBeenCalledTimes(2));
        await expect
          .element(page.getByRole("button", { name: "Resend code", exact: true }))
          .toBeEnabled();
      }
      client.keepAlive.mockResolvedValue({ ok: false, error: { code: "setup-expired" } });
      vi.advanceTimersByTime(20_000);
      await expect.element(page.getByText(expiredText)).toBeVisible();
      await expect
        .element(page.getByLabelText("Verification code", { exact: true }))
        .not.toBeInTheDocument();
    });
  },
);

test("an ended flow answered while Verify code runs leaves that request to answer", async () => {
  await withFakeInterval(async () => {
    const client = mockClient();
    client.begin.mockResolvedValue({
      ok: true,
      kind: "mfa-required",
      flowId,
      providers: [0],
      expiresAt,
    });
    const pending = held<SetupReply>();
    client.continue.mockReturnValue(pending.promise);
    await mount(client);
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(1));
    await page.getByLabelText("Verification code", { exact: true }).fill("000123");
    await page.getByRole("button", { name: "Verify code", exact: true }).click();
    await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(1));
    client.keepAlive.mockResolvedValue({ ok: false, error: { code: "setup-expired" } });
    vi.advanceTimersByTime(20_000);
    await vi.waitFor(() => expect(client.keepAlive).toHaveBeenCalledTimes(2));
    await painted();
    expect(page.getByText(expiredText).query()).toBeNull();
    pending.resolve(ready());
    await expect
      .element(
        page.getByText(
          "Vault verified and local cache accepted. Check automatic-unlock status below.",
        ),
      )
      .toBeVisible();
    expect(page.getByText(expiredText).query()).toBeNull();
  });
});

test("an ended first sign-in switches the form to finishing its connection", async () => {
  await withFakeInterval(async () => {
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
    await mount(client);
    await fillNew();
    await page.getByLabelText("Email", { exact: true }).fill("Test@Example.test");
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await expect.element(page.getByLabelText("Verification code", { exact: true })).toBeVisible();
    await painted();
    client.keepAlive.mockResolvedValue({ ok: false, error: { code: "setup-expired" } });
    vi.advanceTimersByTime(20_000);
    await expect.element(page.getByText(expiredText)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }))
      .toBeVisible();
    await vi.waitFor(() => expect(addForm()).toBe("Sign in to Synthetic vault again"));
  });
});

test("new-device verification is a distinct manual continuation and clears its code", async () => {
  const client = mockClient();
  client.begin.mockResolvedValue({
    ok: true,
    kind: "new-device-verification-required",
    flowId,
    invalidOtp: false,
    expiresAt,
  });
  const pending = held<SetupReply>();
  client.continue.mockReturnValue(pending.promise);
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await page.getByLabelText("New-device verification code", { exact: true }).fill("000987");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await vi.waitFor(() => expect(client.continue).toHaveBeenCalledTimes(1));
  await expect
    .element(page.getByLabelText("New-device verification code", { exact: true }))
    .toHaveValue("");
  pending.resolve(ready());
  await expect
    .element(
      page.getByText(
        "Vault verified and local cache accepted. Check automatic-unlock status below.",
      ),
    )
    .toBeVisible();
  expect(client.continue).toHaveBeenCalledWith({ flowId, newDeviceOtp: "000987" });
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
    .element(page.getByText("Setup stopped. Refresh to confirm the latest state."))
    .toBeVisible();
  expect(changed).toHaveBeenCalledTimes(changes);
  // Stopping re-reads the rows once; the late reply adds no read.
  expect(client.list).toHaveBeenCalledTimes(2);
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
    .element(page.getByText("Vault accepted. 1 item needs its field settings reviewed before use."))
    .toBeVisible();
  // The page reports a count, never the item IDs.
  expect(document.body.textContent).not.toContain("affected-item");
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
    await expect.element(page.getByText("Saved settings loaded. Revision 0")).toBeVisible();
    // The draft's save is still pending when setup replaces the vault metadata.
    let resolveSave!: (value: SettingsResponse) => void;
    settings.saveSettings.mockReturnValueOnce(
      new Promise<SettingsResponse>((resolve) => {
        resolveSave = resolve;
      }),
    );
    await page.getByLabelText("Origin", { exact: true }).fill("draft.example");
    await page.getByRole("button", { name: "Exclude site", exact: true }).click();
    await fillNew();
    await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
    await vi.waitFor(() => expect(connection.begin).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByText(/Vault metadata changed\. Your unsaved draft has been preserved/))
      .toBeVisible();
    resolveSave(saved(1));
    await expect
      .element(page.getByText(/Vault metadata changed while settings were being saved/))
      .toBeVisible();
    expect(document.getElementById("site-list")?.textContent).toContain("draft.example");
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
    // Editing further cannot unblock a draft based on potentially replaced vault metadata.
    await page.getByLabelText("Origin", { exact: true }).fill("next-draft.example");
    await page.getByRole("button", { name: "Exclude site", exact: true }).click();
    expect(settings.saveSettings).toHaveBeenCalledTimes(1);
    settings.getSettings.mockResolvedValue(saved(7));
    await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
    await expect.element(page.getByText("Saved settings loaded. Revision 7")).toBeVisible();
    expect(document.getElementById("site-list")?.textContent).not.toContain("draft.example");
    await page.getByLabelText("Origin", { exact: true }).fill("reviewed.example");
    await page.getByRole("button", { name: "Exclude site", exact: true }).click();
    await vi.waitFor(() => expect(settings.saveSettings).toHaveBeenCalledTimes(2));
    expect(settings.saveSettings.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 7 });
  },
);

test("a challenge while adding a connection reloads a clean draft to the revision the new policy entry wrote", async () => {
  const connection = mockClient();
  connection.begin.mockResolvedValue({
    ok: true,
    kind: "mfa-required",
    flowId,
    providers: [0],
    expiresAt,
  });
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
  await expect.element(page.getByText("Saved settings loaded. Revision 0")).toBeVisible();
  settings.getSettings.mockResolvedValue(saved(1));
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  await expect.element(page.getByText("Enter a two-step verification code.")).toBeVisible();
  await expect.element(page.getByText("Saved settings loaded. Revision 1")).toBeVisible();
  expect(settings.getSettings).toHaveBeenCalledTimes(2);
});

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
                  { id: "login.password", label: "Password", name: null, kind: "hidden" },
                  {
                    id: `custom.${snapshot}.0`,
                    label: "Duplicate",
                    name: "Duplicate",
                    kind: "text",
                  },
                  {
                    id: `custom.${snapshot}.1`,
                    label: "Duplicate",
                    name: "Duplicate",
                    kind: "text",
                  },
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
    .element(page.getByRole("menuitem", { name: "Saved vault: Forget sync sign-in", exact: true }))
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
    .element(
      page.getByText(
        "Vault verified and local cache accepted. Check automatic-unlock status below.",
      ),
    )
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
    .element(page.getByText("Stopped. Refresh to confirm the latest state.", { exact: true }))
    .toBeVisible();
  await expect.element(sync).toBeEnabled();
  late.resolve(ready());
  await expect
    .element(page.getByText("Stopped. Refresh to confirm the latest state.", { exact: true }))
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
      "This removes the connection, its local vault cache, unlock key and sync sign-in from this device. It does not sign out other sessions, and saved settings that refer to it will show it as unavailable.",
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
        await expect.element(page.getByText(/^Connection deleted from this device/)).toBeVisible();
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
        await expect.element(page.getByText(/^Connection deleted from this device/)).toBeVisible();
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
    await page.getByRole("menuitem", { name: `${label}: Delete connection`, exact: true }).click();
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

test("a failed first sign-in switches the form to finishing its connection with automatic unlock", async () => {
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
  await expect.element(page.getByText(/The provider rejected this sign-in/)).toBeVisible();
  await expect
    .element(page.getByLabelText("Enable automatic unlock on this device", { exact: true }))
    .toBeChecked();
  await expect.element(page.getByLabelText("Master password", { exact: true })).toHaveFocus();
  await page.getByLabelText("Master password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in and sync", exact: true }).click();
  await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(2));
  expect(client.begin.mock.calls[1]![0]).toEqual({
    kind: "existing",
    connectionId: "registered",
    password,
    autoUnlock: "enable",
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
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("Synthetic vault");
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
  await expect
    .element(page.getByLabelText("Enable automatic unlock on this device", { exact: true }))
    .toBeChecked();
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
  await expect.element(page.getByText(/^Setup is incomplete: sso\./)).toBeVisible();
});

test("Sign in again on a connection with an unreadable record leaves automatic unlock unchecked", async () => {
  const client = mockClient();
  client.list.mockResolvedValue({
    ...status(),
    connections: [{ ...registered, state: "unavailable" }],
  });
  await mount(client);
  await page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }).click();
  await expect
    .element(page.getByLabelText("Enable automatic unlock on this device", { exact: true }))
    .not.toBeChecked();
});

test("Sign in again on a connection that never unlocked enables automatic unlock", async () => {
  const client = mockClient();
  client.list.mockResolvedValue({ ...status(), connections: [registered] });
  await mount(client);
  await page.getByRole("button", { name: "Synthetic vault: Sign in again", exact: true }).click();
  await expect
    .element(page.getByLabelText("Enable automatic unlock on this device", { exact: true }))
    .toBeChecked();
  await expect
    .element(page.getByText(/finish setting up this connection\. Automatic unlock is enabled/))
    .toBeVisible();
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
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("Synthetic vault");
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
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("Synthetic vault");
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
  client.sync.mockResolvedValue({ ok: false, error: { code: "setup-reauthentication-required" } });
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

test("sync after automatic unlock was disabled explains how to restore it", async () => {
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
        /Automatic unlock is off for this connection, and Sync needs it\. Sign in again/,
      ),
    )
    .toBeVisible();
  await expect.element(page.getByText(/Connection operation unavailable/)).not.toBeInTheDocument();
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

test("each connection's row holds its vault access, which waits for saved settings", async () => {
  const connection = mockClient();
  connection.list.mockResolvedValue({
    ...status(),
    connections: [
      {
        connectionId: "synthetic",
        label: "Synthetic vault",
        email: "saved@example.test",
        environment: { kind: "cloud" as const, region: "us" as const },
        state: "ready" as const,
        autoUnlock: "enabled" as const,
        providerSession: "active" as const,
      },
    ],
  });
  const catalog = {
    connections: [
      {
        id: "synthetic",
        label: "Synthetic vault",
        provider: "bitwarden",
        groups: [],
        items: [
          {
            id: "login",
            label: "Synthetic login",
            allowedOrigins: [],
            groupIds: [],
            fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" }],
          },
        ],
      },
    ],
  } satisfies Extract<SettingsResponse, { ok: true }>["catalog"];
  function saved(revision: number): Extract<SettingsResponse, { ok: true }> {
    const settings = createDefaultSettings(catalog);
    // An entry for a connection this device no longer has keeps a place on the page.
    settings.connections.push({ ...settings.connections[0]!, connectionId: "gone" });
    return { version: 1, ok: true, snapshot: { version: 1, revision, settings }, catalog };
  }
  const settings = {
    getSettings: vi.fn<SettingsClient["getSettings"]>().mockResolvedValue(saved(0)),
    saveSettings: vi.fn<SettingsClient["saveSettings"]>().mockImplementation(async (request) => ({
      ...saved(request.expectedRevision + 1),
      snapshot: {
        version: 1,
        revision: request.expectedRevision + 1,
        settings: structuredClone(request.settings),
      },
    })),
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
  const use = page.getByRole("switch", { name: "Synthetic vault: Use this vault", exact: true });
  await expect.element(use).not.toBeChecked();
  expect(document.getElementById("bitwarden-connections")?.contains(use.element())).toBe(true);
  await expect.element(page.getByText("Unavailable connection", { exact: true })).toBeVisible();
  await expect.element(page.getByText("gone. Its saved settings are preserved.")).toBeVisible();
  // There is no separate vault access section.
  await expect.element(page.getByRole("heading", { name: "Vault access" })).not.toBeInTheDocument();

  await use.click();
  await expect.element(page.getByText("Settings saved locally. Revision 1")).toBeVisible();
  expect(settings.saveSettings.mock.calls[0]?.[0].settings.connections[0]).toMatchObject({
    connectionId: "synthetic",
    enabled: true,
  });
  const read = held<SettingsResponse>();
  settings.getSettings.mockReturnValue(read.promise);
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect.element(use).toBeDisabled();
  await expect
    .element(page.getByRole("combobox", { name: "Synthetic vault: Items for Pateat" }))
    .toBeDisabled();
  read.resolve(saved(4));
  await expect.element(page.getByText("Saved settings loaded. Revision 4")).toBeVisible();
  await expect.element(use).toBeEnabled();
  await expect.element(use).not.toBeChecked();
});

const statusOutput = () => page.elementLocator(document.getElementById("bitwarden-setup-status")!);

test.each(["ready", "error", "cancel"] as const)(
  "a verification challenge takes keyboard focus and hands it to the status after %s",
  async (end) => {
    const client = mockClient();
    client.begin.mockResolvedValue({ ok: true, kind: "mfa-required", flowId, providers: [0] });
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
        .element(page.getByText("Setup stopped. Refresh to confirm the latest state."))
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
  });
  client.continue.mockResolvedValue({
    ok: true,
    kind: "new-device-verification-required",
    flowId,
    invalidOtp: true,
  });
  await mount(client);
  await fillNew();
  await page.getByRole("button", { name: "Connect Bitwarden", exact: true }).click();
  const code = page.getByLabelText("New-device verification code", { exact: true });
  await expect.element(code).toHaveFocus();
  await code.fill("000987");
  await page.getByRole("button", { name: "Verify code", exact: true }).click();
  await expect
    .element(page.getByText("The new-device code was rejected. Enter a new code manually."))
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

/** Focuses a button and presses Enter, as a keyboard or screen reader user does. */
async function pressWithKeyboard(name: string) {
  const button = page.getByRole("button", { name, exact: true });
  (button.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  return button;
}

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
  await expect.element(page.getByText(/^The operation could not be confirmed/)).toBeVisible();
  await expect.element(refresh).toBeEnabled();
  await expect.element(refresh).toHaveFocus();
});
