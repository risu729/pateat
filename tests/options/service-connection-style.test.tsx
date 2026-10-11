import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- Apply the options page stylesheet.
import "../../apps/extension/entrypoints/options/style.css";
import type { ServiceClient } from "../../apps/extension/src/options/service-client";
import { ServiceConnection } from "../../apps/extension/src/options/service-connection";
import type { ServiceResponse } from "../../packages/contracts/src/index";

// Layout checks with the real options stylesheet, Tailwind preflight included, so a
// form control the base rules miss shows up as an unstyled inline field. Synthetic
// service state only; no request leaves the page.

const ORIGIN = "https://pateat.example.com";
const disconnected: ServiceResponse = { ok: true, state: { kind: "disconnected" } };

function mockClient() {
  return {
    get: vi.fn<ServiceClient["get"]>().mockResolvedValue(disconnected),
    requestSiteAccess: vi.fn<ServiceClient["requestSiteAccess"]>().mockResolvedValue(true),
    forget: vi.fn<ServiceClient["forget"]>().mockResolvedValue(disconnected),
    pair: vi.fn<ServiceClient["pair"]>().mockResolvedValue({
      ok: false,
      error: "unreachable",
      state: { kind: "disconnected" },
    }),
    disconnect: vi.fn<ServiceClient["disconnect"]>().mockResolvedValue(disconnected),
    openSignIn: vi.fn<ServiceClient["openSignIn"]>().mockResolvedValue(undefined),
  };
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

/** A field must look like one: boxed, filled, as wide as its label and under its text. */
function expectFieldLayout(input: HTMLInputElement) {
  const label = input.closest("label");
  const text = label?.firstChild;
  if (!label || text?.nodeType !== Node.TEXT_NODE) throw new Error("Field has no label text");
  const style = getComputedStyle(input);
  expect(Number.parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
  expect(style.borderTopStyle).not.toBe("none");
  expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

  const range = document.createRange();
  range.selectNodeContents(text);
  const textBox = range.getBoundingClientRect();
  const labelBox = label.getBoundingClientRect();
  const inputBox = input.getBoundingClientRect();
  expect(inputBox.width).toBeGreaterThanOrEqual(labelBox.width - 1);
  expect(inputBox.top).toBeGreaterThanOrEqual(textBox.bottom - 0.5);
}

function expectNoStatusBox(status: HTMLElement) {
  const style = getComputedStyle(status);
  expect(status.textContent).toBe("");
  expect(status.getBoundingClientRect().height).toBe(0);
  expect(Number.parseFloat(style.borderTopWidth)).toBe(0);
  expect(Number.parseFloat(style.borderLeftWidth)).toBe(0);
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("shows the pairing fields as full-width boxed inputs under their labels", async () => {
  await render(<ServiceConnection client={mockClient()} pollMs={60_000} />);
  await expect.element(page.getByLabelText("Service address", { exact: true })).toBeVisible();
  expectFieldLayout(byId<HTMLInputElement>("sync-service-address"));
  expectFieldLayout(byId<HTMLInputElement>("sync-service-label"));
});

test("draws the status box only while it has a message", async () => {
  const client = mockClient();
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  await expect.element(page.getByLabelText("Service address", { exact: true })).toBeVisible();
  const status = byId("sync-service-status");
  expectNoStatusBox(status);

  // A validation error is shown next to the fields, not in the status box.
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  await expect.element(page.getByRole("alert").getByText(/Enter an HTTPS address/)).toBeVisible();
  expectNoStatusBox(status);

  await page.getByLabelText("Service address", { exact: true }).fill(ORIGIN);
  await page.getByRole("button", { name: "Pair this device", exact: true }).click();
  await expect.element(page.getByText(/could not be reached/)).toBeVisible();
  expect(client.pair).toHaveBeenCalledOnce();
  const style = getComputedStyle(status);
  expect(status.getBoundingClientRect().height).toBeGreaterThan(0);
  expect(Number.parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
  expect(Number.parseFloat(style.borderLeftWidth)).toBeGreaterThan(0);
  expect(Number.parseFloat(style.paddingTop)).toBeGreaterThan(0);
});

test("keeps the Forget saved connection button clear of the status box", async () => {
  const client = mockClient();
  client.get.mockResolvedValue({ ok: false, error: "storage-corrupt" });
  await render(<ServiceConnection client={client} pollMs={60_000} />);
  const forget = page.getByRole("button", { name: "Forget saved connection", exact: true });
  await expect.element(forget).toBeVisible();
  await expect.element(page.getByText(/cannot read its saved service connection/)).toBeVisible();

  const statusBox = byId("sync-service-status").getBoundingClientRect();
  const forgetBox = byId("sync-service-forget").getBoundingClientRect();
  expect(statusBox.height).toBeGreaterThan(0);
  expect(forgetBox.top - statusBox.bottom).toBeGreaterThanOrEqual(8);
});
