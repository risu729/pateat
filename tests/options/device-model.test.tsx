import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import {
  DeviceModelPanel,
  type DeviceModelClient,
  type DeviceModelView,
} from "../../apps/extension/src/options/device-model";

// This device's own Anthropic API key (ADR 0040), with a synthetic key and client only.

const KEY = "sk-ant-synthetic-component-wxyz";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

function syntheticClient(initial: DeviceModelView = { saved: false }) {
  let view = initial;
  const client = {
    read: vi.fn(async () => view),
    save: vi.fn<DeviceModelClient["save"]>(async (change) => {
      view = {
        saved: true,
        ending: change.apiKey?.slice(-4) ?? (view.saved ? view.ending : ""),
        dailyLimitUsd: change.dailyLimitUsd,
        monthlyLimitUsd: change.monthlyLimitUsd,
        spentTodayUsd: 0,
        spentMonthUsd: 0,
      };
    }),
    remove: vi.fn(async () => {
      view = { saved: false };
    }),
  } satisfies DeviceModelClient;
  return client;
}

async function mount(client: DeviceModelClient) {
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <DeviceModelPanel client={client} />
    </QueryClientProvider>,
  );
}

const keyField = () => page.getByLabelText("Anthropic API key", { exact: true });
const daily = () => page.getByLabelText("Daily limit (USD)", { exact: true });
const monthly = () => page.getByLabelText("Monthly limit (USD)", { exact: true });

test("a pasted key is saved with the default limits and never shown again", async () => {
  const client = syntheticClient();
  await mount(client);
  await expect.element(daily()).toBeDisabled();
  await expect.element(daily()).toHaveValue(5);
  await expect.element(monthly()).toHaveValue(100);
  await keyField().fill(` ${KEY} `);
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  expect(client.save).toHaveBeenCalledExactlyOnceWith({
    apiKey: KEY,
    dailyLimitUsd: 5,
    monthlyLimitUsd: 100,
  });
  const replace = page.getByLabelText("Replace the Anthropic API key", { exact: true });
  await expect.element(replace).toHaveValue("");
  await expect.element(replace).toHaveAttribute("placeholder", "••••wxyz");
  await expect.element(page.getByText("Saved on this device.", { exact: true })).toBeVisible();
  await expect.element(daily()).toBeEnabled();
  expect(document.body.innerHTML).not.toContain(KEY);
});

test("a pasted text that is no key is refused before saving", async () => {
  const client = syntheticClient();
  await mount(client);
  await keyField().fill("sk ant");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await expect
    .element(page.getByText("Paste the whole API key from the Claude Console.", { exact: true }))
    .toBeVisible();
  expect(client.save).not.toHaveBeenCalled();
});

test("a limit is saved when the field is left and refused out of range", async () => {
  const client = syntheticClient({
    saved: true,
    ending: "wxyz",
    dailyLimitUsd: 5,
    monthlyLimitUsd: 100,
    spentTodayUsd: 1.25,
    spentMonthUsd: 12.5,
  });
  await mount(client);
  await expect.element(page.getByText(/\$1\.25 today and \$12\.50 this month/u)).toBeVisible();
  await daily().fill("2.5");
  await monthly().click();
  await vi.waitFor(() =>
    expect(client.save).toHaveBeenCalledExactlyOnceWith({
      dailyLimitUsd: 2.5,
      monthlyLimitUsd: 100,
    }),
  );
  await monthly().fill("-1");
  await daily().click();
  await expect
    .element(page.getByText("Enter an amount in US dollars from 0 to 100,000.", { exact: true }))
    .toBeVisible();
  expect(client.save).toHaveBeenCalledTimes(1);
});

test("the key is removed from this device", async () => {
  const client = syntheticClient({
    saved: true,
    ending: "wxyz",
    dailyLimitUsd: 5,
    monthlyLimitUsd: 100,
    spentTodayUsd: 0,
    spentMonthUsd: 0,
  });
  await mount(client);
  await page.getByRole("button", { name: "Remove key", exact: true }).click();
  expect(client.remove).toHaveBeenCalledOnce();
  await expect.element(keyField()).toBeVisible();
  await expect
    .element(page.getByText("The key was removed from this device.", { exact: true }))
    .toBeVisible();
});
