import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup } from "vitest-browser-react";
import type { SetupReply } from "../../../apps/extension/src/connections/types";
import { localClockTime } from "../../../apps/extension/src/time";
import type { ConnectionSetupTestContext } from "./context";

export function registerChallengeLifetime(
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
  }: Pick<
    ConnectionSetupTestContext,
    | "password"
    | "flowId"
    | "expiresAt"
    | "ready"
    | "status"
    | "mockClient"
    | "held"
    | "painted"
    | "mount"
    | "fillNew"
    | "withFakeInterval"
    | "expiredText"
    | "endedLine"
    | "addForm"
  >,
  fixtures: Pick<ConnectionSetupTestContext, "registered">,
) {
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
    await page
      .getByRole("combobox", { name: "Verification method", exact: true })
      .selectOptions("1");
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
    await expect
      .element(page.getByText("The code was not accepted.", { exact: true }))
      .toBeVisible();
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
      .element(page.getByText("Vault verified, unlocked and copied to this device."))
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
    await expect
      .element(page.getByText("The sign-in timed out waiting for the code."))
      .toBeVisible();
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
        await expect
          .element(page.getByLabelText("Verification code", { exact: true }))
          .toBeVisible();
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
        .element(page.getByText("Vault verified, unlocked and copied to this device."))
        .toBeVisible();
      expect(page.getByText(expiredText).query()).toBeNull();
    });
  });

  test("an ended first sign-in switches the form to finishing its connection", async () => {
    await withFakeInterval(async () => {
      const client = mockClient();
      client.list
        .mockResolvedValueOnce(status())
        .mockResolvedValue({ ...status(), connections: [fixtures.registered] });
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
      .element(page.getByText("Vault verified, unlocked and copied to this device."))
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
      .element(page.getByText("Setup stopped. Refresh to see the current state."))
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

  test("Sign in again on a logged-out connection unlocks it without an automatic-unlock choice", async () => {
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
    await expect
      .element(page.getByText("Logged out on this device", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Saved vault: Sign in again", exact: true }).click();
    // The vault timeout decides how long the key stays; the form no longer asks.
    expect(document.body.textContent).not.toContain("Enable automatic unlock");
    await page.getByLabelText("Master password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in and sync", exact: true }).click();
    await vi.waitFor(() => expect(client.begin).toHaveBeenCalledTimes(1));
    expect(client.begin.mock.calls[0]![0]).toEqual({
      kind: "existing",
      connectionId: "saved-a",
      password,
    });
    await expect
      .element(page.getByText("Vault verified, unlocked and copied to this device."))
      .toBeVisible();
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
        page.getByText("Vault accepted. 1 item needs its field settings reviewed before use."),
      )
      .toBeVisible();
    // The page reports a count, never the item IDs.
    expect(document.body.textContent).not.toContain("affected-item");
  });
}
