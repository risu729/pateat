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
import type { ManualClient, ManualOfferResponse } from "../../apps/extension/src/login/manual-wire";
import { ManualLogin } from "../../apps/extension/src/popup/manual-login";

const account = { connectionId: "demo-personal", itemId: "primary" };
const target = {
  document: { origin: "https://bank.example", tabId: 7, frameId: 0, documentId: "document-0" },
  scope: "scope-0",
  candidates: [account],
};
async function mount(initial: ManualOfferResponse) {
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: {
      version: 1,
      revision: 1,
      settings: {
        ...createDefaultSettings(),
        pagePermissionDefaults: { "sign-in": "fill", confirm: "off", "personal-details": "fill" },
      },
    },
    catalog: structuredClone(DUMMY_VAULT_CATALOG),
  };
  const before = structuredClone(saved);
  const client = {
    get: vi.fn<ManualClient["get"]>().mockResolvedValue(initial),
    start: vi.fn<ManualClient["start"]>().mockResolvedValue({ ok: true, state: "evaluating" }),
  };
  const onStarted = vi.fn();
  const query = createMetadataQueryClient();
  await render(
    <QueryClientProvider client={query}>
      <ManualLogin
        client={client}
        tabId={7}
        saved={saved}
        disabled={false}
        onBusy={vi.fn()}
        onStarted={onStarted}
        onReprompt={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const update = (answer: ManualOfferResponse) => {
    client.get.mockResolvedValue(answer);
    query.setQueryData(["popup", "manual", 7, 1], answer);
  };
  return { saved, before, client, onStarted, update };
}
const button = () => page.getByRole("button", { name: "Log in now", exact: true });
afterEach(cleanup);

test("the button becomes available when passive autofill is idle and starts only the explicit offered login", async () => {
  const h = await mount({ ok: true, targets: [], reason: "login-running" });
  await expect.element(button()).toBeDisabled();
  expect(h.client.start).not.toHaveBeenCalled();
  h.update({ ok: true, targets: [target] });
  await expect.element(button()).toBeEnabled();
  expect(h.client.start).not.toHaveBeenCalled();
  await userEvent.click(button());
  expect(h.client.start).toHaveBeenCalledExactlyOnceWith({
    requestId: expect.any(String),
    document: target.document,
    scope: target.scope,
    ...account,
  });
  expect(h.onStarted).not.toHaveBeenCalled();
  const requestId = h.client.start.mock.calls[0]![0].requestId;
  h.update({ ok: true, targets: [], status: { requestId, state: "started" } });
  await expect.poll(() => h.onStarted).toHaveBeenCalledTimes(1);
  expect(h.saved).toEqual(h.before);
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
});

test("confirm-off permits an explicit check while a confirmed non-login result stays blocked", async () => {
  const h = await mount({ ok: true, targets: [target] });
  h.client.start.mockImplementation(async ({ requestId }) => {
    h.update({ ok: true, targets: [], status: { requestId, state: "generating" } });
    return { ok: true, state: "generating" };
  });
  await expect.element(button()).toBeEnabled();
  expect(h.client.start).not.toHaveBeenCalled();
  await userEvent.click(button());
  await expect.element(button()).toBeDisabled();
  await expect
    .element(page.getByText("Checking the page before starting the login…"))
    .toBeVisible();
  const requestId = h.client.start.mock.calls[0]![0].requestId;
  h.update({
    ok: true,
    targets: [],
    status: { requestId, state: "blocked", reason: "not-a-login-page" },
  });
  await expect
    .element(
      page.getByText(
        "No login form could be used on this page. Open the site's sign-in page and try again.",
      ),
    )
    .toBeVisible();
  await expect.element(button()).toBeDisabled();
  expect(h.client.start).toHaveBeenCalledTimes(1);
  expect(h.onStarted).not.toHaveBeenCalled();
  expect(h.saved).toEqual(h.before);
});
