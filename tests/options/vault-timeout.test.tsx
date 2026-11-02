import { createDefaultSettings, type LocalSettings } from "../../packages/contracts/src/index";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useState } from "react";
import { cleanup, render } from "vitest-browser-react";
import { UnlockForm, type UnlockResult } from "../../apps/extension/src/options/unlock-form";
import { VaultTimeoutPanel } from "../../apps/extension/src/options/vault-timeout";
import type { VaultTimeoutSetting } from "../../apps/extension/src/vault/timeout";

const password = "synthetic-component-password-only";

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const field = () => page.getByLabelText("Master password", { exact: true });
const unlockButton = (name = "Unlock") => page.getByRole("button", { name, exact: true });

async function mountForm(
  onSubmit = vi.fn<(value: string) => Promise<UnlockResult>>(async () => ({ ok: true })),
  props: { disabled?: boolean; accountLabel?: string; submitLabel?: string } = {},
) {
  await render(<UnlockForm onSubmit={onSubmit} {...props} />);
  return onSubmit;
}

test("the unlock form sends the typed password once and empties the field at once", async () => {
  const answer = held<UnlockResult>();
  const onSubmit = await mountForm(vi.fn(() => answer.promise));
  await expect.element(unlockButton()).toBeDisabled();
  await field().fill(password);
  await unlockButton().click();
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(password);
  // The password leaves the page with the request.
  await expect.element(field()).toHaveValue("");
  await expect.element(field()).toBeDisabled();
  await expect.element(unlockButton()).toBeDisabled();
  answer.resolve({ ok: true });
  await expect.element(field()).toBeEnabled();
  expect(document.body.textContent).not.toContain("Invalid master password.");
  expect(document.body.innerHTML).not.toContain(password);
});

test("the unlock form submits with Enter and not without a password", async () => {
  const onSubmit = await mountForm();
  await field().click();
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  await field().fill(password);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith(password));
});

test("a wrong master password says so on the field and the next try clears it", async () => {
  const onSubmit = await mountForm(
    vi
      .fn<(value: string) => Promise<UnlockResult>>()
      .mockResolvedValueOnce({ ok: false, error: "wrong-password" })
      .mockImplementationOnce(() => new Promise(() => undefined)),
  );
  await field().fill("synthetic-wrong-password");
  await unlockButton().click();
  await expect.element(page.getByText("Invalid master password.", { exact: true })).toBeVisible();
  await expect.element(field()).toHaveAttribute("aria-invalid", "true");
  await expect.element(field()).toHaveValue("");
  await expect.element(field()).toHaveFocus();
  const described = field().element().getAttribute("aria-describedby");
  expect(described && document.getElementById(described)?.textContent).toContain(
    "Invalid master password.",
  );
  await field().fill(password);
  await unlockButton().click();
  expect(onSubmit).toHaveBeenCalledTimes(2);
  await expect
    .element(page.getByText("Invalid master password.", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(field()).not.toHaveAttribute("aria-invalid");
});

test.each([
  [
    "an unavailable answer",
    async (): Promise<UnlockResult> => ({ ok: false, error: "unavailable" }),
  ],
  [
    "a rejected request",
    async (): Promise<UnlockResult> => Promise.reject(new Error("Synthetic port closed")),
  ],
])("%s says the vault could not be unlocked, not that the password is wrong", async (_, answer) => {
  await mountForm(vi.fn(answer));
  await field().fill(password);
  await unlockButton().click();
  await expect
    .element(
      page.getByText("The vault could not be unlocked. Refresh and try again.", { exact: true }),
    )
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Invalid master password.");
  await expect.element(field()).not.toHaveAttribute("aria-invalid");
  await expect.element(field()).toHaveValue("");
});

test("after a failed try the cursor returns once the page enables the form again", async () => {
  // The settings page keeps its forms disabled until its operation has finished.
  function Page() {
    const [busy, setBusy] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setBusy(false)}>
          Finish operation
        </button>
        <UnlockForm
          disabled={busy}
          onSubmit={async () => {
            setBusy(true);
            return { ok: false, error: "wrong-password" };
          }}
        />
      </>
    );
  }
  const finish = page.getByRole("button", { name: "Finish operation", exact: true });
  await render(<Page />);
  await field().fill("synthetic-wrong-password");
  await unlockButton().click();
  await expect.element(page.getByText("Invalid master password.", { exact: true })).toBeVisible();
  await expect.element(field()).toBeDisabled();
  expect(document.activeElement).not.toBe(field().element());
  await finish.click();
  await expect.element(field()).toBeEnabled();
  await expect.element(field()).toHaveFocus();
  // Focus is not taken again on a later render.
  await finish.click();
  await expect.element(finish).toHaveFocus();
});

test("a disabled unlock form sends nothing", async () => {
  const onSubmit = await mountForm(undefined, { disabled: true });
  await expect.element(field()).toBeDisabled();
  await expect.element(unlockButton()).toBeDisabled();
  field().element().closest("form")!.requestSubmit();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("the unlock form names its account and can label its button", async () => {
  await mountForm(undefined, { accountLabel: "test@example.test", submitLabel: "Open vault" });
  await expect.element(page.getByText("test@example.test", { exact: true })).toBeVisible();
  await expect.element(unlockButton("Open vault")).toBeVisible();
});

/** The settings page's draft: each edit is saved at once as the next draft. */
async function mountPanel(initial?: VaultTimeoutSetting) {
  const saved = vi.fn<(value: VaultTimeoutSetting | undefined) => void>();
  function Harness() {
    const [draft, setDraft] = useState<LocalSettings>(() => ({
      ...createDefaultSettings(),
      ...(initial ? { vaultTimeout: initial } : {}),
    }));
    return (
      <VaultTimeoutPanel
        draft={draft}
        edit={(update) => {
          const next = structuredClone(draft);
          update(next);
          saved(next.vaultTimeout);
          setDraft(next);
          return true;
        }}
      />
    );
  }
  await render(<Harness />);
  return saved;
}
// The labels hold the selects' option text, so the two selects are found by their order.
const timeoutSelect = () => page.getByRole("combobox").nth(0);
const actionSelect = () => page.getByRole("combobox").nth(1);
const minutes = () => page.getByLabelText("Minutes", { exact: true });
const message = () => document.querySelector("#vault-timeout-message")?.textContent;
const neverNote =
  "Never keeps the unlock key on this device, so the vaults unlock by themselves after a browser restart and stay open to anyone who can use this browser profile.";
const memoryNote =
  "The unlock key stays in memory only, so a browser restart also locks the vaults.";

test("the vault timeout shows the synced setting with labelled choices", async () => {
  await mountPanel({ timeout: 240, action: "log-out" });
  await expect.element(page.getByRole("heading", { name: "Vault timeout" })).toBeVisible();
  await expect.element(timeoutSelect()).toHaveValue("240");
  await expect.element(actionSelect()).toHaveValue("log-out");
  const labels = [...document.querySelectorAll("#vault-timeout-select option")].map(
    (option) => option.textContent,
  );
  expect(labels).toEqual([
    "1 minute",
    "5 minutes",
    "15 minutes",
    "30 minutes",
    "1 hour",
    "4 hours",
    "On system idle",
    "On system lock",
    "On browser restart",
    "Never",
    "Custom",
  ]);
  // No "Immediately", as agreed for this extension.
  expect(labels).not.toContain("Immediately");
  expect(minutes().query()).toBeNull();
  await expect.element(page.getByText(/Applies on all your devices\.$/u)).toBeVisible();
});

test("an absent setting is Never with Lock, and choosing them again stores nothing", async () => {
  const saved = await mountPanel();
  await expect.element(timeoutSelect()).toHaveValue("never");
  await expect.element(actionSelect()).toHaveValue("lock");
  await actionSelect().selectOptions("log-out");
  await vi.waitFor(() =>
    expect(saved).toHaveBeenLastCalledWith({ timeout: "never", action: "log-out" }),
  );
  await actionSelect().selectOptions("lock");
  // Back at the default, the synced document leaves it out.
  await vi.waitFor(() => expect(saved).toHaveBeenLastCalledWith(undefined));
});

test.each<[string, VaultTimeoutSetting["timeout"]]>([
  ["1", 1],
  ["5", 5],
  ["15", 15],
  ["30", 30],
  ["60", 60],
  ["240", 240],
  ["system-idle", "system-idle"],
  ["system-lock", "system-lock"],
  ["restart", "restart"],
])("choosing %s saves it and keeps the action", async (choice, timeout) => {
  const saved = await mountPanel({ timeout: "never", action: "log-out" });
  await expect.element(timeoutSelect()).toHaveValue("never");
  await timeoutSelect().selectOptions(choice);
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ timeout, action: "log-out" }),
  );
  await expect.element(timeoutSelect()).toHaveValue(choice);
});

test("choosing Never saves it", async () => {
  const saved = await mountPanel({ timeout: 15, action: "log-out" });
  await expect.element(timeoutSelect()).toHaveValue("15");
  await timeoutSelect().selectOptions("never");
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ timeout: "never", action: "log-out" }),
  );
});

test("Custom saves its prefilled minutes, then a whole number in range on blur", async () => {
  const saved = await mountPanel();
  await expect.element(timeoutSelect()).toHaveValue("never");
  await timeoutSelect().selectOptions("custom");
  await expect.element(minutes()).toHaveValue(60);
  // The prefilled minutes count at once.
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ timeout: 60, action: "lock" }),
  );
  await minutes().fill("45");
  expect(saved).toHaveBeenCalledOnce();
  await actionSelect().click();
  await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(saved).toHaveBeenLastCalledWith({ timeout: 45, action: "lock" });
  await expect.element(timeoutSelect()).toHaveValue("custom");
  await expect.element(page.getByText(memoryNote, { exact: true })).toBeVisible();
});

test("Custom minutes are saved with Enter too", async () => {
  const saved = await mountPanel({ timeout: 15, action: "log-out" });
  await expect.element(timeoutSelect()).toHaveValue("15");
  await timeoutSelect().selectOptions("custom");
  // A preset is the starting value of the custom minutes.
  await expect.element(minutes()).toHaveValue(15);
  await minutes().fill("90");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ timeout: 90, action: "log-out" }),
  );
});

test.each(["0", "-3", "1.5", "525601", ""])(
  "Custom minutes %j are refused with the allowed range",
  async (typed) => {
    const saved = await mountPanel({ timeout: 45, action: "lock" });
    await expect.element(timeoutSelect()).toHaveValue("custom");
    await expect.element(minutes()).toHaveValue(45);
    await minutes().fill(typed);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(message()).toBe("Enter whole minutes from 1 to 525,600."));
    await actionSelect().click();
    expect(saved).not.toHaveBeenCalled();
  },
);

test("Custom minutes equal to the saved ones are not saved again", async () => {
  const saved = await mountPanel({ timeout: 45, action: "lock" });
  await expect.element(minutes()).toHaveValue(45);
  await minutes().click();
  await userEvent.keyboard("{Enter}");
  await actionSelect().click();
  expect(saved).not.toHaveBeenCalled();
  await minutes().fill("525600");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ timeout: 525_600, action: "lock" }),
  );
});

test("the timeout action saves Log out and Lock", async () => {
  const saved = await mountPanel({ timeout: 5, action: "lock" });
  await expect.element(actionSelect()).toHaveValue("lock");
  await expect
    .element(
      page.getByText(
        "Lock keeps the sync sign-in; unlock with the master password, without the server.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await actionSelect().selectOptions("log-out");
  await vi.waitFor(() => expect(saved).toHaveBeenLastCalledWith({ timeout: 5, action: "log-out" }));
  await expect
    .element(
      page.getByText("Log out also forgets the sync sign-in; sign in again to use the vault.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await actionSelect().selectOptions("lock");
  await vi.waitFor(() => expect(saved).toHaveBeenLastCalledWith({ timeout: 5, action: "lock" }));
});

test("the note warns only for Never that the key stays on this device", async () => {
  await mountPanel({ timeout: "never", action: "lock" });
  await expect.element(page.getByText(neverNote, { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain(memoryNote);
  await timeoutSelect().selectOptions("restart");
  await expect.element(page.getByText(memoryNote, { exact: true })).toBeVisible();
  expect(document.body.textContent).not.toContain(neverNote);
});
