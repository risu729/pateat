import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { ServiceClient } from "../../apps/extension/src/options/service-client";
import { ServiceConnection } from "../../apps/extension/src/options/service-connection";
import type {
  ServiceErrorCode,
  ServiceResponse,
  ServiceState,
} from "../../packages/contracts/src/index";

// Synthetic service state only; no request leaves the page.

const ORIGIN = "https://pateat.example.com";
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
const failed = (error: ServiceErrorCode): ServiceResponse => ({
  ok: false,
  error,
  state: { kind: "disconnected" },
});

function mockClient(initial: ServiceState = { kind: "disconnected" }) {
  return {
    get: vi.fn<ServiceClient["get"]>().mockResolvedValue(ok(initial)),
    requestSiteAccess: vi.fn<ServiceClient["requestSiteAccess"]>().mockResolvedValue(true),
    forget: vi.fn<ServiceClient["forget"]>().mockResolvedValue(ok({ kind: "disconnected" })),
    pair: vi.fn<ServiceClient["pair"]>().mockResolvedValue(ok(connected)),
    disconnect: vi
      .fn<ServiceClient["disconnect"]>()
      .mockResolvedValue(ok({ kind: "disconnected" }, true)),
    openSignIn: vi.fn<ServiceClient["openSignIn"]>().mockResolvedValue(undefined),
  };
}

async function submitPair(origin = ORIGIN) {
  await page.getByLabelText("Service address", { exact: true }).fill(origin);
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("pairs in one click with an exact HTTPS address and shows no code", async () => {
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
  expect(client.pair).not.toHaveBeenCalled();

  await address.fill(`${ORIGIN}/`);
  await page.getByLabelText("Device name", { exact: true }).fill("  Work laptop  ");
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  expect(client.requestSiteAccess).toHaveBeenCalledWith(ORIGIN);
  expect(client.pair).toHaveBeenCalledExactlyOnceWith(ORIGIN, "Work laptop");
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
  await expect.element(page.getByText("pateat.example.com", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Named Work laptop on the service", { exact: true }))
    .toBeVisible();
  expect(client.openSignIn).not.toHaveBeenCalled();
  // No typed-code flow remains.
  expect(document.body.textContent).not.toMatch(/code|approval/i);
  await expect.element(page.getByRole("button", { name: "Try again" })).not.toBeInTheDocument();
});

test("validates the device name with the shared label rules", async () => {
  const client = mockClient();
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await page.getByLabelText("Service address", { exact: true }).fill(ORIGIN);
  const name = page.getByLabelText("Device name", { exact: true });
  await name.fill("   ");
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  await expect.element(page.getByRole("alert").getByText("Enter a device name.")).toBeVisible();
  await name.fill("Tab\tname");
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  await expect
    .element(page.getByRole("alert").getByText(/without control characters/))
    .toBeVisible();
  expect(client.requestSiteAccess).not.toHaveBeenCalled();
  expect(client.pair).not.toHaveBeenCalled();
});

test("does not pair when site access is declined", async () => {
  const client = mockClient();
  client.requestSiteAccess.mockResolvedValue(false);
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect.element(page.getByText(/site access when Chrome asks/)).toBeVisible();
  expect(client.pair).not.toHaveBeenCalled();
  expect(client.openSignIn).not.toHaveBeenCalled();
});

test("opens the sign-in page once and pairs on Try again", async () => {
  const client = mockClient();
  client.pair.mockResolvedValueOnce(failed("sign-in-needed"));
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect
    .element(
      page.getByText(`Sign in to ${ORIGIN} in the new tab, then come back here.`, { exact: false }),
    )
    .toBeVisible();
  await expect.element(page.getByText(/ask its operator/)).toBeVisible();
  expect(client.openSignIn).toHaveBeenCalledExactlyOnceWith(ORIGIN);

  await page.getByRole("button", { name: "Try again", exact: true }).click();
  expect(client.pair).toHaveBeenCalledTimes(2);
  expect(client.pair).toHaveBeenLastCalledWith(ORIGIN, "Chrome");
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
  expect(client.openSignIn).toHaveBeenCalledOnce();
});

test("opens no second tab automatically while sign-in is still needed", async () => {
  const client = mockClient();
  client.pair.mockResolvedValue(failed("sign-in-needed"));
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect.element(page.getByText(/in the new tab/)).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.element(page.getByText(/open the sign-in page, then come back here/)).toBeVisible();
  expect(client.pair).toHaveBeenCalledTimes(2);
  expect(client.openSignIn).toHaveBeenCalledOnce();

  await page.getByRole("button", { name: "Open sign-in page", exact: true }).click();
  expect(client.openSignIn).toHaveBeenCalledTimes(2);
  expect(client.openSignIn).toHaveBeenLastCalledWith(ORIGIN);
  expect(client.pair).toHaveBeenCalledTimes(2);
});

test("retries once when the page is shown or focused again", async () => {
  const client = mockClient();
  client.pair.mockResolvedValueOnce(failed("sign-in-needed"));
  let pairs = 0;
  client.pair.mockImplementation(async () => {
    pairs += 1;
    return ok(connected);
  });
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect.element(page.getByText(/in the new tab/)).toBeVisible();
  expect(client.pair).toHaveBeenCalledOnce();
  // Returning fires both events; only one retry follows.
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
  window.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(pairs).toBe(1);
  expect(client.pair).toHaveBeenCalledTimes(2);
});

test("removes the return listeners on unmount while other page listeners stay active", async () => {
  const client = mockClient();
  client.pair.mockResolvedValue(failed("sign-in-needed"));
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect.element(page.getByText(/in the new tab/)).toBeVisible();
  expect(client.pair).toHaveBeenCalledOnce();
  const controller = new AbortController();
  const shown = vi.fn();
  const focused = vi.fn();
  document.addEventListener("visibilitychange", shown, { signal: controller.signal });
  window.addEventListener("focus", focused, { signal: controller.signal });
  try {
    await cleanup();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shown).toHaveBeenCalledOnce();
    expect(focused).toHaveBeenCalledOnce();
    expect(client.pair).toHaveBeenCalledOnce();
    expect(client.openSignIn).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
  }
});

test("does not retry on focus before a sign-in page was opened", async () => {
  const client = mockClient();
  client.pair.mockResolvedValue(failed("unreachable"));
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect.element(page.getByText(/could not be reached/)).toBeVisible();
  window.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(client.pair).toHaveBeenCalledOnce();
});

test.each([
  ["sign-in-rejected", /did not accept your sign-in/],
  ["extension-not-allowed", /does not accept this build of Pateat.*PAIRING_EXTENSION_IDS/],
  ["pairing-unavailable", /Pairing is not configured on this service/],
  ["unreachable", /could not be reached/],
  ["rate-limited", /slow down/],
  ["unexpected-response", /unexpected answer/],
] as const)("explains %s and offers Try again", async (error, text) => {
  const client = mockClient();
  client.pair.mockResolvedValue(failed(error));
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  await expect.element(page.getByText(text)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open sign-in page" }))
    .not.toBeInTheDocument();
  expect(client.openSignIn).not.toHaveBeenCalled();
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
  await expect.element(page.getByText(/^Named .* on the service$/)).toBeVisible();
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

test("shows when recipes last synced and when the service rejects the device", async () => {
  const synced = mockClient({ ...connected, syncedAt: Date.UTC(2026, 9, 10, 6, 0) });
  await render(<ServiceConnection client={synced} pollMs={60_000} />);
  await expect.element(page.getByText(/^Recipes and settings synced /)).toBeVisible();
  await cleanup();

  await render(<ServiceConnection client={mockClient(connected)} pollMs={60_000} />);
  await expect
    .element(page.getByText("Recipes and settings have not finished syncing yet", { exact: true }))
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
    .element(page.getByText("Recipes and settings have not finished syncing yet", { exact: true }))
    .toBeVisible();
  client.get.mockResolvedValue(ok({ ...connected, syncedAt: Date.UTC(2026, 9, 10, 6, 0) }));
  await expect.element(page.getByText(/^Recipes and settings synced /)).toBeVisible();
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
    .element(
      page.getByText(
        "Disconnected on this device, but the service could not confirm it. Revoke this device from https://pateat.example.com/manage in a browser that can open it.",
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(client.pair).not.toHaveBeenCalled();
});

test("requires an explicit profile choice before retrying a multi-profile pairing", async () => {
  const client = mockClient();
  const local = "00000000-0000-4000-8000-000000000010";
  const agent = "00000000-0000-4000-8000-000000000011";
  client.pair.mockResolvedValueOnce({
    ...failed("profile-required"),
    profiles: [
      { id: local, name: "Local browser" },
      { id: agent, name: "Agent browser" },
    ],
  });
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await submitPair();
  const choices = page.getByRole("combobox", { name: "Settings profile", exact: true });
  await expect.element(choices).toHaveValue("");
  const retry = page.getByRole("button", { name: "Pair this device", exact: true });
  await expect.element(retry).toBeDisabled();
  expect(client.pair).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(client.pair).toHaveBeenCalledOnce();
  await choices.selectOptions(agent);
  await expect.element(retry).toBeEnabled();
  await retry.click();
  expect(client.pair).toHaveBeenLastCalledWith(ORIGIN, "Chrome", agent);
  await expect.element(page.getByText("This device is paired.", { exact: true })).toBeVisible();
  expect(client.openSignIn).not.toHaveBeenCalled();
});
