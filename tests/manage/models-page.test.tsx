import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  DEFAULT_MODEL_CONFIG,
  type ManageModels,
  type ModelConfig,
} from "../../packages/contracts/src/index";
import { ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

// A synthetic model list only; the client is replaced, so nothing leaves the page.

const VIEW: ManageModels = {
  version: 1,
  config: DEFAULT_MODEL_CONFIG,
  saved: false,
  catalog: "models-api",
  models: [
    {
      provider: "anthropic",
      id: "claude-opus-9",
      displayName: "Claude Opus 9",
      efforts: ["low"],
      rates: null,
      fast: "none",
    },
    {
      provider: "anthropic",
      id: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      efforts: ["low", "medium", "high"],
      rates: { input: 4, output: 20 },
      fast: "failing",
      fastRates: { input: 8, output: 40 },
    },
    {
      provider: "anthropic",
      id: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      efforts: ["low", "medium"],
      rates: { input: 2, output: 10 },
      fast: "none",
    },
    {
      provider: "anthropic",
      id: "claude-haiku-5-5",
      displayName: "Claude Haiku 5.5",
      efforts: ["low"],
      rates: { input: 0.1, output: 0.5 },
      fast: "none",
    },
  ],
};

function mockClient(saveError?: ManageApiError) {
  let view = structuredClone(VIEW);
  return {
    dashboard: vi.fn<ManageClient["dashboard"]>(),
    devices: vi.fn<ManageClient["devices"]>(),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(),
    requestLog: vi.fn<ManageClient["requestLog"]>(),
    deleteRequestLog: vi.fn<ManageClient["deleteRequestLog"]>(),
    claude: vi.fn<ManageClient["claude"]>(async () => ({
      version: 1,
      console: {
        issuer: "https://pateat.example",
        subject: "owner:4f3c2b1a-0e9d-4c8b-a7f6-e5d4c3b2a190",
        audience: "https://api.anthropic.com",
      },
      identifiers: null,
      storedInvalid: false,
    })),
    saveClaude: vi.fn<ManageClient["saveClaude"]>(),
    testClaude: vi.fn<ManageClient["testClaude"]>(),
    models: vi.fn<ManageClient["models"]>(async () => structuredClone(view)),
    saveModels: vi.fn<ManageClient["saveModels"]>(async (config: ModelConfig) => {
      if (saveError) throw saveError;
      view = { ...view, config: structuredClone(config), saved: true };
      return structuredClone(view);
    }),
    profileId: undefined,
    selectProfile: vi.fn<ManageClient["selectProfile"]>(),
    profiles: vi.fn<ManageClient["profiles"]>(),
    copyProfile: vi.fn<ManageClient["copyProfile"]>(),
    renameProfile: vi.fn<ManageClient["renameProfile"]>(),
    deleteProfile: vi.fn<ManageClient["deleteProfile"]>(),
    assignProfile: vi.fn<ManageClient["assignProfile"]>(),
  } satisfies ManageClient;
}

async function mount(client: ManageClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path="/manage/claude" />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

const select = (id: string) => document.querySelector<HTMLSelectElement>(`#${id}`)!;

test("shows each role's models in order, with the fallbacks after a refusal", async () => {
  await mount(mockClient());
  await expect.element(page.getByRole("heading", { name: "Recipe generation" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Sign-in judge" })).toBeVisible();
  expect(document.title).toBe("Claude – Pateat");
  await expect.element(page.getByRole("region", { name: "Models" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Models", level: 2 })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Recipe generation", level: 3 }))
    .toBeVisible();
  await expect.element(page.getByText("These are the defaults.")).toBeVisible();
  expect(select("models-generate-0-model").value).toBe("claude-opus-5-5");
  expect(select("models-generate-1-model").value).toBe("claude-sonnet-5-5");
  await expect.element(page.getByText("Fallback 1 after a refusal").first()).toBeVisible();
  // A model without a price, and fast mode that keeps failing, cannot be chosen.
  const unpriced = [...select("models-generate-0-model").options].find(
    (option) => option.value === "claude-opus-9",
  )!;
  expect([unpriced.disabled, unpriced.textContent]).toEqual([
    true,
    "Claude Opus 9 (no published price yet)",
  ]);
  const fast = [...select("models-generate-0-speed").options].find(
    (option) => option.value === "fast",
  )!;
  expect([fast.disabled, fast.textContent]).toEqual([
    true,
    "Fast (unavailable: its last calls failed)",
  ]);
});

test("saves an edited order and effort", async () => {
  const client = mockClient();
  await mount(client);
  await expect.element(page.getByRole("heading", { name: "Recipe generation" })).toBeVisible();
  await page.getByRole("button", { name: "Move Claude Sonnet 5.5 up" }).first().click();
  await page.getByRole("combobox", { name: "Effort" }).first().selectOptions("medium");
  await page.getByRole("button", { name: "Add a fallback" }).first().click();
  await page.getByRole("button", { name: "Save models" }).click();
  await expect.element(page.getByText("Models saved")).toBeVisible();
  expect(client.saveModels).toHaveBeenCalledWith({
    generate: [
      { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", speed: "standard" },
      { provider: "anthropic", model: "claude-opus-5-5", effort: "low", speed: "standard" },
      { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", speed: "standard" },
    ],
    judge: DEFAULT_MODEL_CONFIG.judge,
  });
});

test("explains a model the list no longer offers", async () => {
  const client = mockClient(new ManageApiError("model_unavailable"));
  await mount(client);
  await expect.element(page.getByRole("heading", { name: "Recipe generation" })).toBeVisible();
  await page.getByRole("button", { name: "Save models" }).click();
  await expect
    .element(page.getByText(/is no longer offered\. The page now shows the current list/))
    .toBeVisible();
  // The page reads the list again.
  expect(client.models).toHaveBeenCalledTimes(2);
});

test("offers the defaults only while the list offers their models", async () => {
  const client = mockClient();
  client.models.mockImplementation(async () => ({
    ...structuredClone(VIEW),
    config: {
      generate: [
        { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", speed: "standard" },
      ],
      judge: [
        { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", speed: "standard" },
      ],
    },
    models: VIEW.models.filter((model) => model.id !== "claude-sonnet-5-5"),
  }));
  await mount(client);
  await expect.element(page.getByRole("heading", { name: "Recipe generation" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Use the defaults" })).toBeDisabled();
});
