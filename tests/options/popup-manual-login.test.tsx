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
