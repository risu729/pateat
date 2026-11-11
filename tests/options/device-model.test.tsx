import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import {
  DeviceModelPanel,
  createDeviceModelClient,
  type DeviceClefClient,
  type DeviceClefView,
  type DeviceModelClient,
  type DeviceModelView,
} from "../../apps/extension/src/options/device-model";
import { createDefaultSettings, type LocalSettings } from "../../packages/contracts/src/index";
import {
  DEVICE_MODEL_KEY,
  DEVICE_MODEL_SPEND_KEY,
  DEVICE_CLEF_KEY,
} from "../../apps/extension/src/service/device-model";

const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));
vi.mock("../../apps/extension/src/storage", () => ({
  trustedRecord: (key: string) => ({
    read: async () => structuredClone(stored.get(key)),
    write: async (value: unknown) => {
      stored.set(key, structuredClone(value));
    },
    clear: async () => {
      stored.delete(key);
    },
  }),
}));
beforeEach(() => {
  stored.clear();
});

// This device's text-model key (ADR 0040), with synthetic keys and clients only.

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
        provider: change.provider,
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
  expect(client.save).toHaveBeenCalledExactlyOnceWith({ provider: "anthropic", apiKey: KEY });
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
    .element(page.getByText("Paste the whole API key for the selected provider.", { exact: true }))
    .toBeVisible();
  expect(client.save).not.toHaveBeenCalled();
});

test("a limit is saved as a synced setting when the field is left and refused out of range", async () => {
  const client = syntheticClient({
    saved: true,
    provider: "anthropic",
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
    provider: "anthropic",
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

test("switching providers clears only the draft and never reinterprets the saved key", async () => {
  const client = syntheticClient({
    saved: true,
    provider: "anthropic",
    ending: "wxyz",
    spentTodayUsd: 1,
    spentMonthUsd: 2,
  });
  await mount(client);
  const selector = page.getByLabelText("Text model provider", { exact: true });
  await expect
    .element(page.getByLabelText("Replace the Anthropic API key", { exact: true }))
    .toHaveAttribute("placeholder", "••••wxyz");
  await selector.selectOptions("openai");
  const openai = page.getByLabelText("OpenAI API key", { exact: true });
  await expect.element(openai).toHaveValue("");
  await expect.element(openai).toHaveAttribute("placeholder", "sk-…");
  await expect.element(page.getByRole("button", { name: "Save key", exact: true })).toBeDisabled();
  expect(client.save).not.toHaveBeenCalled();
  await openai.fill("synthetic-openai-draft-key");
  await selector.selectOptions("anthropic");
  await expect
    .element(page.getByLabelText("Replace the Anthropic API key", { exact: true }))
    .toHaveValue("");
  expect(client.save).not.toHaveBeenCalled();
  await selector.selectOptions("openai");
  await openai.fill("synthetic-openai-saved-key");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  expect(client.save).toHaveBeenCalledExactlyOnceWith({
    provider: "openai",
    apiKey: "synthetic-openai-saved-key",
  });
  await expect
    .element(page.getByLabelText("Replace the OpenAI API key", { exact: true }))
    .toHaveValue("");
  expect(document.body.innerHTML).not.toContain("synthetic-openai-saved-key");
});

test("provider and key replacement preserve the aggregate spend and independent Clef record", async () => {
  const spend = {
    version: 1,
    day: "2026-11-11",
    dayMicroUsd: 1_250_000,
    month: "2026-11",
    monthMicroUsd: 12_500_000,
  };
  const clef = {
    version: 1,
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "synthetic-clef-token",
  };
  stored.set(DEVICE_MODEL_SPEND_KEY, spend);
  stored.set(DEVICE_CLEF_KEY, clef);
  const client = createDeviceModelClient(() => Date.UTC(2026, 10, 11));
  await client.save({ provider: "anthropic", apiKey: KEY });
  await client.save({ provider: "openai", apiKey: " synthetic-openai-key-abcd " });
  expect(stored.get(DEVICE_MODEL_KEY)).toEqual({
    version: 1,
    provider: "openai",
    apiKey: "synthetic-openai-key-abcd",
  });
  expect(await client.read()).toEqual({
    saved: true,
    provider: "openai",
    ending: "abcd",
    spentTodayUsd: 1.25,
    spentMonthUsd: 12.5,
  });
  expect(JSON.stringify(await client.read())).not.toContain("synthetic-openai-key-abcd");
  expect(stored.get(DEVICE_MODEL_SPEND_KEY)).toEqual(spend);
  expect(stored.get(DEVICE_CLEF_KEY)).toEqual(clef);
  await client.remove();
  expect(await client.read()).toEqual({ saved: false });
  expect(stored.get(DEVICE_MODEL_SPEND_KEY)).toEqual(spend);
  expect(stored.get(DEVICE_CLEF_KEY)).toEqual(clef);
});
