import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import {
  DeviceModelPanel,
  type DeviceClefClient,
  type DeviceClefView,
  type DeviceModelClient,
  type DeviceModelView,
} from "../../apps/extension/src/options/device-model";
import { createDefaultSettings, type LocalSettings } from "../../packages/contracts/src/index";

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
        ending: change.apiKey.slice(-4),
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

/** The settings page's draft: each edit is saved at once as the next draft. */
async function mount(client: DeviceModelClient, limits?: LocalSettings["modelSpendLimits"]) {
  const saved = vi.fn<(value: LocalSettings["modelSpendLimits"]) => void>();
  function Harness() {
    const [draft, setDraft] = useState<LocalSettings>(() => ({
      ...createDefaultSettings(),
      ...(limits ? { modelSpendLimits: limits } : {}),
    }));
    return (
      <DeviceModelPanel
        client={client}
        draft={draft}
        edit={(update) => {
          const next = structuredClone(draft);
          update(next);
          saved(next.modelSpendLimits);
          setDraft(next);
          return true;
        }}
      />
    );
  }
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  return saved;
}

const keyField = () => page.getByLabelText("Anthropic API key", { exact: true });
const daily = () => page.getByLabelText("Daily limit (USD)", { exact: true });
const monthly = () => page.getByLabelText("Monthly limit (USD)", { exact: true });

test("a pasted key is saved on this device and never shown again", async () => {
  const client = syntheticClient();
  await mount(client);
  await expect.element(daily()).toHaveValue(5);
  await expect.element(monthly()).toHaveValue(100);
  await keyField().fill(` ${KEY} `);
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  expect(client.save).toHaveBeenCalledExactlyOnceWith({ apiKey: KEY });
  const replace = page.getByLabelText("Replace the Anthropic API key", { exact: true });
  await expect.element(replace).toHaveValue("");
  await expect.element(replace).toHaveAttribute("placeholder", "••••wxyz");
  await expect.element(page.getByText("Saved on this device.", { exact: true })).toBeVisible();
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

test("a limit is saved as a synced setting when the field is left and refused out of range", async () => {
  const client = syntheticClient({
    saved: true,
    ending: "wxyz",
    spentTodayUsd: 1.25,
    spentMonthUsd: 12.5,
  });
  const saved = await mount(client);
  await expect.element(page.getByText(/\$1\.25 today and \$12\.50 this month/u)).toBeVisible();
  await daily().fill("2.5");
  await monthly().click();
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ dailyUsd: 2.5, monthlyUsd: 100 }),
  );
  await monthly().fill("-1");
  await daily().click();
  await expect
    .element(page.getByText("Enter an amount in US dollars from 0 to 100,000.", { exact: true }))
    .toBeVisible();
  expect(saved).toHaveBeenCalledTimes(1);
  // Back at the defaults, the synced document leaves them out.
  await daily().fill("5");
  await monthly().fill("100");
  await daily().click();
  await vi.waitFor(() => expect(saved).toHaveBeenLastCalledWith(undefined));
  expect(client.save).not.toHaveBeenCalled();
});

test("the limits are set without a key, and show the profile's values", async () => {
  const saved = await mount(syntheticClient(), { dailyUsd: 1, monthlyUsd: 20 });
  await expect.element(daily()).toHaveValue(1);
  await expect.element(monthly()).toHaveValue(20);
  await monthly().fill("30");
  await daily().click();
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledExactlyOnceWith({ dailyUsd: 1, monthlyUsd: 30 }),
  );
});

test("the key is removed from this device", async () => {
  const client = syntheticClient({
    saved: true,
    ending: "wxyz",
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

test("a Cloudflare account and token are saved on this device for Clef (ADR 0083)", async () => {
  const token = "synthetic-cloudflare-token-1234";
  let view: DeviceClefView = { saved: false };
  const clef = {
    read: vi.fn(async () => view),
    save: vi.fn<DeviceClefClient["save"]>(async (change) => {
      view = { saved: true, accountEnding: change.accountId.slice(-4) };
    }),
    remove: vi.fn(async () => {
      view = { saved: false };
    }),
  } satisfies DeviceClefClient;
  await mount({ ...syntheticClient(), clef });
  const account = page.getByLabelText("Cloudflare account ID", { exact: true });
  const save = page.getByRole("button", { name: "Save token", exact: true });
  await account.fill("not an account");
  await page.getByLabelText("Cloudflare API token", { exact: true }).fill(token);
  await save.click();
  await expect
    .element(
      page.getByText(
        "Paste the 32-character account ID and the whole API token from the Cloudflare dashboard.",
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(clef.save).not.toHaveBeenCalled();
  await account.fill(" 0123456789ABCDEF0123456789abcdef ");
  await save.click();
  expect(clef.save).toHaveBeenCalledExactlyOnceWith({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: token,
  });
  await expect
    .element(
      page.getByText("Cloudflare token saved for the account ending in cdef.", { exact: true }),
    )
    .toBeVisible();
  expect(document.body.innerHTML).not.toContain(token);
  await page.getByRole("button", { name: "Remove token", exact: true }).click();
  expect(clef.remove).toHaveBeenCalledOnce();
  await expect
    .element(page.getByText("The token was removed from this device.", { exact: true }))
    .toBeVisible();
});
