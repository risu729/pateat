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
  expect(client.start).toHaveBeenCalledWith(ORIGIN, "Work laptop");
  await expect.element(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
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
  release();
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(/is paired with https:\/\/pateat\.example\.com/))
    .toBeVisible();
  const calls = client.check.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(client.check.mock.calls.length).toBe(calls);
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
