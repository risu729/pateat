import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { ServiceClient } from "../../apps/extension/src/options/service-client";
import { ServiceConnection } from "../../apps/extension/src/options/service-connection";
import type { ServiceResponse, ServiceState } from "../../packages/contracts/src/index";

// Synthetic service state only; no request leaves the page.

const ORIGIN = "https://pateat.example.com";
const pairing: ServiceState = {
  kind: "pairing",
  origin: ORIGIN,
  label: "Work laptop",
  code: "ABCD-EFGH",
  enrollUrl: `${ORIGIN}/enroll?challenge=${"A".repeat(43)}&label=Work+laptop`,
  expiresAt: Date.now() + 15 * 60 * 1000,
};
const connected: ServiceState = {
  kind: "connected",
  origin: ORIGIN,
  label: "Work laptop",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
};
const ok = (state: ServiceState, revoked?: boolean): ServiceResponse => ({
  ok: true,
  state,
  ...(revoked === undefined ? {} : { revoked }),
});

function mockClient(initial: ServiceState = { kind: "disconnected" }) {
  return {
    get: vi.fn<ServiceClient["get"]>().mockResolvedValue(ok(initial)),
    requestSiteAccess: vi.fn<ServiceClient["requestSiteAccess"]>().mockResolvedValue(true),
    forget: vi.fn<ServiceClient["forget"]>().mockResolvedValue(ok({ kind: "disconnected" })),
    start: vi.fn<ServiceClient["start"]>().mockResolvedValue(ok(pairing)),
    check: vi.fn<ServiceClient["check"]>().mockResolvedValue(ok(pairing)),
    cancel: vi.fn<ServiceClient["cancel"]>().mockResolvedValue(ok({ kind: "disconnected" })),
    disconnect: vi
      .fn<ServiceClient["disconnect"]>()
      .mockResolvedValue(ok({ kind: "disconnected" }, true)),
    openApproval: vi.fn<ServiceClient["openApproval"]>().mockResolvedValue(undefined),
  };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("starts pairing only with an exact HTTPS address", async () => {
  const client = mockClient();
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  const address = page.getByLabelText("Service address", { exact: true });
  for (const input of ["http://pateat.example.com", "https://pateat.example.com/api"]) {
    // oxlint-disable-next-line no-await-in-loop -- one form, filled in turn
    await address.fill(input);
    // oxlint-disable-next-line no-await-in-loop -- one form, filled in turn
    await page.getByRole("button", { name: "Pair this device", exact: true }).click();
    // oxlint-disable-next-line no-await-in-loop -- one form, filled in turn
    await expect.element(page.getByRole("alert").getByText(/Enter an HTTPS address/)).toBeVisible();
  }
  expect(client.start).not.toHaveBeenCalled();

  await address.fill(`${ORIGIN}/`);
  await page.getByLabelText("Device name", { exact: true }).fill("Work laptop");
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  expect(client.requestSiteAccess).toHaveBeenCalledWith(ORIGIN);
  expect(client.start).toHaveBeenCalledWith(ORIGIN, "Work laptop");
  await expect.element(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
});

test("does not start pairing when site access is declined", async () => {
  const client = mockClient();
  client.requestSiteAccess.mockResolvedValue(false);
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await page.getByLabelText("Service address", { exact: true }).fill(ORIGIN);
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  await expect.element(page.getByText(/site access when Chrome asks/)).toBeVisible();
  expect(client.start).not.toHaveBeenCalled();
});

test("asks for site access again without abandoning a pairing", async () => {
  const client = mockClient(pairing);
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await expect.element(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Allow site access" }))
    .not.toBeInTheDocument();
  await cleanup();

  const blocked = mockClient();
  blocked.get.mockResolvedValue({ ok: false, error: "site-access-needed", state: pairing });
  blocked.check.mockResolvedValue(ok(connected));
  await render(<ServiceConnection client={blocked} pollMs={60_000} />);
  await page.getByRole("button", { name: "Allow site access", exact: true }).click();
  expect(blocked.requestSiteAccess).toHaveBeenCalledWith(ORIGIN);
  expect(blocked.check).toHaveBeenCalledOnce();
  expect(blocked.cancel).not.toHaveBeenCalled();
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
});

test("keeps the way out while forgetting fails", async () => {
  const client = mockClient();
  client.get.mockResolvedValue({ ok: false, error: "storage-corrupt" });
  client.forget.mockResolvedValue({ ok: false, error: "storage-unavailable" });
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await page.getByRole("button", { name: "Forget saved connection", exact: true }).click();
  await expect.element(page.getByText(/could not read or save/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Forget saved connection", exact: true }))
    .toBeVisible();
});

test("drops the way out once the saved connection is readable again", async () => {
  const client = mockClient();
  client.get.mockResolvedValue({ ok: false, error: "storage-corrupt" });
  client.forget.mockResolvedValue({ ok: false, error: "wrong-state", state: connected });
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await page.getByRole("button", { name: "Forget saved connection", exact: true }).click();
  await expect.element(page.getByText(/is paired with/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Forget saved connection" }))
    .not.toBeInTheDocument();
});

test("forgets an unreadable saved connection", async () => {
  const client = mockClient();
  client.get.mockResolvedValue({ ok: false, error: "storage-corrupt" });
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await page.getByRole("button", { name: "Forget saved connection", exact: true }).click();
  expect(client.forget).toHaveBeenCalledOnce();
  await expect
    .element(page.getByText("Saved connection forgotten.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByLabelText("Service address", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Forget saved connection" }))
    .not.toBeInTheDocument();
});

test("opens the approval page and polls until paired", async () => {
  const client = mockClient(pairing);
  // Hold the first check so the pairing view stays until the approval page is opened.
  let release: () => void = () => undefined;
  client.check
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, error: "code-mismatch", state: pairing });
        }),
    )
    .mockResolvedValueOnce(ok(connected));
  await render(<ServiceConnection client={client} pollMs={50} />);
  await page.getByRole("button", { name: "Open approval page", exact: true }).click();
  expect(client.openApproval).toHaveBeenCalledWith(pairing.enrollUrl);
  await vi.waitFor(() => expect(client.check).toHaveBeenCalledOnce());
  // Once paired, the page waits for the first recipe sync through `get` instead.
  client.get.mockResolvedValue(ok(connected));
  release();
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(/is paired with https:\/\/pateat\.example\.com/))
    .toBeVisible();
  const calls = client.check.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(client.check.mock.calls.length).toBe(calls);
});

test("clears a transient error once the service answers again", async () => {
  const client = mockClient(pairing);
  client.check.mockResolvedValueOnce({ ok: false, error: "unreachable", state: pairing });
  await render(<ServiceConnection client={client} pollMs={50} />);
  await expect.element(page.getByText(/could not be reached/)).toBeVisible();
  await expect
    .element(page.getByText("Waiting for approval on the service.", { exact: true }))
    .toBeVisible();
});

test("explains a mismatched code and keeps the pairing", async () => {
  const client = mockClient(pairing);
  client.check.mockResolvedValue({ ok: false, error: "code-mismatch", state: pairing });
  await render(<ServiceConnection client={client} pollMs={50} />);
  await expect.element(page.getByText(/The approval page has a different code/)).toBeVisible();
  await expect.element(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
});

test("returns to the form when a pairing expires or is cancelled", async () => {
  const client = mockClient(pairing);
  client.check.mockResolvedValue({
    ok: false,
    error: "pairing-expired",
    state: { kind: "disconnected" },
  });
  await render(<ServiceConnection client={client} pollMs={50} />);
  await expect.element(page.getByText(/Pairing expired/)).toBeVisible();
  await expect.element(page.getByLabelText("Service address", { exact: true })).toBeVisible();

  await cleanup();
  const cancelling = mockClient(pairing);
  await render(<ServiceConnection client={cancelling} pollMs={60_000} />);
  await page.getByRole("button", { name: "Cancel pairing", exact: true }).click();
  expect(cancelling.cancel).toHaveBeenCalledOnce();
  await expect.element(page.getByText("Pairing cancelled.", { exact: true })).toBeVisible();
});

test("shows when recipes last synced and when the service rejects the device", async () => {
  const synced = mockClient({ ...connected, syncedAt: Date.UTC(2026, 9, 10, 6, 0) });
  await render(<ServiceConnection client={synced} pollMs={60_000} />);
  await expect.element(page.getByText(/Recipes and settings last synced at/)).toBeVisible();
  await cleanup();

  await render(<ServiceConnection client={mockClient(connected)} pollMs={60_000} />);
  await expect
    .element(page.getByText("Recipes and settings have not finished syncing yet.", { exact: true }))
    .toBeVisible();
  await cleanup();

  await render(
    <ServiceConnection client={mockClient({ ...connected, rejected: true })} pollMs={60_000} />,
  );
  await expect.element(page.getByText(/no longer accepts this device/)).toBeVisible();
  await cleanup();

  await render(
    <ServiceConnection client={mockClient({ ...connected, cacheFull: true })} pollMs={60_000} />,
  );
  await expect.element(page.getByText(/no longer fit/)).toBeVisible();
});

test("shows the first sync finishing without a reload", async () => {
  const client = mockClient(connected);
  await render(<ServiceConnection client={client} pollMs={20} />);
  await expect
    .element(page.getByText("Recipes and settings have not finished syncing yet.", { exact: true }))
    .toBeVisible();
  client.get.mockResolvedValue(ok({ ...connected, syncedAt: Date.UTC(2026, 9, 10, 6, 0) }));
  await expect.element(page.getByText(/Recipes and settings last synced at/)).toBeVisible();
  const calls = client.get.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(client.get).toHaveBeenCalledTimes(calls);
});

test("tells the owner when the service could not confirm a disconnect", async () => {
  const client = mockClient(connected);
  client.disconnect.mockResolvedValue(ok({ kind: "disconnected" }, false));
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await page.getByRole("button", { name: "Disconnect this device", exact: true }).click();
  await expect
    .element(page.getByText(/Revoke this device from https:\/\/pateat\.example\.com\/manage/))
    .toBeVisible();
  expect(client.check).not.toHaveBeenCalled();
});
