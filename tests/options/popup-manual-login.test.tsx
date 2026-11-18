import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
} from "../../packages/contracts/src/index";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import type {
  ManualClient,
  ManualOfferResponse,
  ManualStartResponse,
} from "../../apps/extension/src/login/manual-wire";
import { ManualLogin } from "../../apps/extension/src/popup/manual-login";

const origin = "https://bank.example";
const primary = { connectionId: "demo-personal", itemId: "primary" };
const secondary = { connectionId: "demo-personal", itemId: "secondary" };
const target = (frameId = 0, candidates = [primary]) => ({
  document: { origin, tabId: 7, frameId, documentId: `document-${frameId}` },
  scope: `scope-${frameId}`,
  candidates,
});
const saved = (): Extract<SettingsResponse, { ok: true }> => ({
  version: 1,
  ok: true,
  snapshot: { version: 1, revision: 1, settings: createDefaultSettings() },
  catalog: structuredClone(DUMMY_VAULT_CATALOG),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(initial: ManualOfferResponse = { ok: true, targets: [target()] }) {
  const client = {
    get: vi.fn<ManualClient["get"]>().mockResolvedValue(initial),
    start: vi.fn<ManualClient["start"]>().mockResolvedValue({ ok: true, state: "evaluating" }),
    cancel: vi.fn<ManualClient["cancel"]>().mockResolvedValue({ ok: true }),
    fill: vi.fn<ManualClient["fill"]>().mockResolvedValue({ ok: true, state: "preparing" }),
  };
  const onStarted = vi.fn();
  const onBusy = vi.fn();
  const onReprompt = vi.fn();
  const query = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={query}>
      <ManualLogin
        client={client}
        tabId={7}
        saved={saved()}
        disabled={false}
        onStarted={onStarted}
        onBusy={onBusy}
        onReprompt={onReprompt}
      />
    </QueryClientProvider>,
  );
  const update = (answer: ManualOfferResponse) => {
    client.get.mockResolvedValue(answer);
    query.setQueryData(["popup", "manual", 7, 1], answer);
  };
  return { client, onStarted, onBusy, onReprompt, update };
}
const button = () => page.getByRole("button", { name: "Log in now", exact: true });
afterEach(cleanup);

test("a sole matching account starts only the exact offered document and account", async () => {
  const h = await mount();
  await expect.element(button()).toBeEnabled();
  await userEvent.click(button());
  expect(h.client.start).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    document: target().document,
    scope: "scope-0",
    ...primary,
  });
  expect(h.onBusy.mock.calls).toEqual([[true], [false]]);
  expect(h.onStarted).not.toHaveBeenCalled();
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
});

test("multiple matches require an explicit account and multiple documents offer a frame selector", async () => {
  const h = await mount({
    ok: true,
    targets: [target(0, [primary, secondary]), target(3, [secondary])],
  });
  await expect.element(button()).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Account to log in with" })
    .selectOptions(JSON.stringify([secondary.connectionId, secondary.itemId]));
  await expect.element(button()).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Page to log in to" })
    .selectOptions(JSON.stringify([3, "document-3", "scope-3"]));
  await userEvent.click(button());
  expect(h.client.start).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    document: target(3).document,
    scope: "scope-3",
    ...secondary,
  });
});

test("a second click during the request sends no second login", async () => {
  const h = await mount();
  const reply = deferred<ManualStartResponse>();
  h.client.start.mockReturnValue(reply.promise);
  await expect.element(button()).toBeEnabled();
  await userEvent.click(button());
  await userEvent.click(button());
  expect(h.client.start).toHaveBeenCalledTimes(1);
  reply.resolve({ ok: false, reason: "page-changed" });
  await expect
    .element(page.getByText("The page changed or is not ready. Reload it, then try again."))
    .toBeVisible();
});

test("an old started status cannot close a new pending request", async () => {
  const h = await mount({
    ok: true,
    targets: [target()],
    status: { requestId: "previous", state: "started" },
  });
  const reply = deferred<ManualStartResponse>();
  h.client.start.mockReturnValue(reply.promise);
  await expect.element(button()).toBeEnabled();
  await userEvent.click(button());
  expect(h.onStarted).not.toHaveBeenCalled();
  reply.resolve({ ok: true, state: "evaluating" });
  await expect.poll(() => h.onBusy.mock.calls).toEqual([[true], [false]]);
  expect(h.onStarted).not.toHaveBeenCalled();
  const requestId = h.client.start.mock.calls[0]![0].requestId;
  h.update({ ok: true, targets: [], status: { requestId, state: "started" } });
  await expect.poll(() => h.onStarted).toHaveBeenCalledTimes(1);
});

test("an explicitly chosen account disappearing cannot silently select the remaining account", async () => {
  const h = await mount({ ok: true, targets: [target(0, [primary, secondary])] });
  await page
    .getByRole("combobox", { name: "Account to log in with" })
    .selectOptions(JSON.stringify([secondary.connectionId, secondary.itemId]));
  h.update({ ok: true, targets: [target(0, [primary])] });
  await expect.element(button()).toBeDisabled();
  await expect
    .element(
      page.getByText(
        "No eligible account matches this page. Check the item's site address and sync the vault.",
      ),
    )
    .toBeVisible();
  expect(h.client.start).not.toHaveBeenCalled();
});

test("a selected frame disappearing cannot silently select the top page", async () => {
  const h = await mount({ ok: true, targets: [target(), target(3)] });
  await page
    .getByRole("combobox", { name: "Page to log in to" })
    .selectOptions(JSON.stringify([3, "document-3", "scope-3"]));
  h.update({ ok: true, targets: [target()] });
  await expect.element(button()).toBeDisabled();
  await expect
    .element(page.getByText("The page changed or is not ready. Reload it, then try again."))
    .toBeVisible();
  expect(h.client.start).not.toHaveBeenCalled();
});

test.each(["evaluating", "generating"] as const)(
  "shows %s status while the page has no selectable target",
  async (state) => {
    await mount({ ok: true, targets: [], status: { requestId: "pending", state } });
    await expect.element(button()).toBeDisabled();
    await expect
      .element(
        page.getByText(
          state === "generating"
            ? "Checking the page before starting the login…"
            : "Preparing this login…",
        ),
      )
      .toBeVisible();
  },
);

test("keeps the master password action available without starting another request", async () => {
  const h = await mount({
    ok: true,
    targets: [],
    status: { requestId: "pending", state: "evaluating", reason: "master-password-reprompt" },
  });
  await userEvent.click(
    page.getByRole("button", { name: "Enter the master password", exact: true }),
  );
  expect(h.onReprompt).toHaveBeenCalledTimes(1);
  expect(h.client.start).not.toHaveBeenCalled();
});

test("a request that keeps preparing can be cancelled, and only that request", async () => {
  const h = await mount({
    ok: true,
    targets: [],
    status: { requestId: "pending", state: "evaluating" },
  });
  const cancel = page.getByRole("button", { name: "Cancel this login", exact: true });
  await expect.element(cancel).toBeEnabled();
  h.client.cancel.mockImplementation(async () => {
    h.client.get.mockResolvedValue({
      ok: true,
      targets: [target()],
      status: { requestId: "pending", state: "blocked", reason: "cancelled" },
    });
    return { ok: true };
  });
  await userEvent.click(cancel);
  expect(h.client.cancel).toHaveBeenCalledExactlyOnceWith(7, "pending");
  await expect
    .element(page.getByText("Cancelled. Nothing will start from this request."))
    .toBeVisible();
  await expect.element(cancel).not.toBeInTheDocument();
  await expect.element(button()).toBeEnabled();
  expect(h.client.start).not.toHaveBeenCalled();
  expect(h.onBusy.mock.calls).toEqual([[true], [false]]);
});

test("offers no cancel without a pending request", async () => {
  await mount({ ok: true, targets: [target()], status: { requestId: "old", state: "started" } });
  await expect.element(button()).toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Cancel this login", exact: true }))
    .not.toBeInTheDocument();
});

test("numbers embedded forms among frames only", async () => {
  await mount({ ok: true, targets: [target(), target(3), target(5)] });
  const pages = page.getByRole("combobox", { name: "Page to log in to" });
  await expect.element(pages).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "This page (bank.example)", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("option", { name: "Embedded form 1 (bank.example)", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("option", { name: "Embedded form 2 (bank.example)", exact: true }))
    .toBeInTheDocument();
});

test("follows the tab's current page until a choice, then reports that page going away", async () => {
  const replaced = (frameId: number, candidates = [primary, secondary]) => ({
    ...target(frameId, candidates),
    document: { ...target(frameId).document, documentId: "replacement" },
  });
  const h = await mount({ ok: true, targets: [target(0, [primary])] });
  await expect.element(button()).toBeEnabled();
  h.update({ ok: true, targets: [replaced(0, [primary])] });
  await userEvent.click(button());
  expect(h.client.start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ document: replaced(0).document }),
  );
  h.update({ ok: true, targets: [target(0, [primary, secondary])] });
  await page
    .getByRole("combobox", { name: "Account to log in with" })
    .selectOptions(JSON.stringify([secondary.connectionId, secondary.itemId]));
  await expect.element(button()).toBeEnabled();
  h.update({ ok: true, targets: [replaced(0)] });
  await expect.element(button()).toBeDisabled();
  await expect
    .element(page.getByText("The page changed or is not ready. Reload it, then try again."))
    .toBeVisible();
  expect(h.client.start).toHaveBeenCalledTimes(1);
});

test("says plainly when the page has no sign-in form", async () => {
  await mount({ ok: true, targets: [], reason: "no-document" });
  await expect.element(page.getByText("No sign-in form was found on this page.")).toBeVisible();
  await expect.element(button()).toBeDisabled();
});

// A Log in now that waits for the person's sign-in method choice (ADR 0085, amended
// 2026-11-18), and why one that could not start ended.
test("points to the method choice while the request waits for it, and can cancel it", async () => {
  const h = await mount({
    ok: true,
    targets: [],
    status: { requestId: "pending", state: "choosing" },
  });
  await expect.element(button()).toBeDisabled();
  await expect
    .element(
      page.getByText("Choose how to sign in under Sign-in method below. The login starts then."),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Cancel this login", exact: true }))
    .toBeEnabled();
  expect(h.client.start).not.toHaveBeenCalled();
});

test("a start that answers with the method choice keeps the popup open", async () => {
  const h = await mount();
  h.client.start.mockResolvedValue({ ok: true, state: "choosing" });
  await userEvent.click(button());
  expect(h.client.start).toHaveBeenCalledTimes(1);
  expect(h.onStarted).not.toHaveBeenCalled();
});

test.each([
  [
    "choice-timed-out",
    "No sign-in method was chosen in time. Nothing will start from this request. Press Log in now again.",
  ],
  [
    "settings-changed",
    "The page, vault or settings changed before the sign-in method was used. Press Log in now again.",
  ],
  [
    "sso-manual-scope-unavailable",
    "Signing in through a provider needs automatic sign-in on this site and the provider, with neither paused. Choose another method, or change Page behavior or resume the site.",
  ],
  [
    "invalid-value",
    "The SSO fields have invalid syntax, duplicate methods or mixed formats. Correct the vault item and sync it.",
  ],
])("says why a request that could not start ended: %s", async (reason, text) => {
  await mount({
    ok: true,
    targets: [target()],
    status: { requestId: "pending", state: "blocked", reason },
  });
  await expect.element(page.getByText(text)).toBeVisible();
  await expect.element(button()).toBeEnabled();
});
