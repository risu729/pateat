import type { TransferFile, TransferResponse } from "../../packages/contracts/src/index";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import {
  createTransferClient,
  TransferPanel,
  type TransferClient,
} from "../../apps/extension/src/options/transfer";

// Export and import (ADR 0040), with a synthetic client and file only.

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const FILE: TransferFile = {
  format: "pateat-transfer",
  version: 1,
  exportedAt: "2026-10-23T12:00:00.000Z",
  settings: {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [{ hostname: "shop.example", includeSubdomains: false }],
    passkeyBrowserSites: [],
    repromptSites: [],
    siteDefaults: [],
    bindings: [],
    detailLinks: [],
  },
  recipes: [],
};

const PREVIEW: TransferResponse = {
  version: 1,
  ok: true,
  type: "settings.import-preview",
  sites: Array.from({ length: 12 }, (_, index) => `https://site-${index}.example`),
  policies: 2,
  others: 1,
  recipes: 2,
};

function syntheticClient(
  answers: {
    export?: TransferResponse;
    preview?: TransferResponse;
    import?: TransferResponse;
  } = {},
) {
  return {
    exportFile: vi.fn(
      async (): Promise<TransferResponse> =>
        answers.export ?? { version: 1, ok: true, type: "settings.export", file: FILE },
    ),
    importFile: vi.fn(async (_file: unknown, apply: boolean): Promise<TransferResponse> =>
      apply
        ? (answers.import ?? { version: 1, ok: true, type: "settings.import", recipes: 2 })
        : (answers.preview ?? PREVIEW),
    ),
  } satisfies TransferClient;
}

async function mount(
  client: TransferClient,
  options: { blocked?: boolean; onImported?: () => void; save?: () => void } = {},
) {
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <TransferPanel
        client={client}
        blocked={options.blocked ?? false}
        onImported={options.onImported ?? (() => undefined)}
        save={options.save ?? (() => undefined)}
        now={() => Date.UTC(2026, 9, 23, 12)}
      />
    </QueryClientProvider>,
  );
}

const exportButton = () => page.getByRole("button", { name: "Export to a file" });
const importButton = () => page.getByRole("button", { name: "Import from a file" });
const fileInput = () => page.getByLabelText("Pateat export file", { exact: true });
const chosen = (text: string, name = "pateat-export.json") =>
  new File([text], name, { type: "application/json" });

test("exports the file as a dated JSON download", async () => {
  const client = syntheticClient();
  const save = vi.fn();
  await mount(client, { save });
  await exportButton().click();
  await expect.element(page.getByText("Exported the settings and 0 recipes.")).toBeVisible();
  expect(save).toHaveBeenCalledWith(
    "pateat-export-2026-10-23.json",
    `${JSON.stringify(FILE, null, 2)}\n`,
  );
});

test("shows what an import would change and imports only once confirmed", async () => {
  const client = syntheticClient();
  const onImported = vi.fn();
  await mount(client, { onImported });
  await fileInput().upload(chosen(JSON.stringify(FILE)));
  await expect.element(page.getByText("Importing this file will:")).toBeVisible();
  await expect
    .element(page.getByText("Choose which of your vault items Pateat uses on 12 sites:"))
    .toBeVisible();
  await expect.element(page.getByText("https://site-9.example")).toBeVisible();
  await expect.element(page.getByText("https://site-10.example")).not.toBeInTheDocument();
  await expect.element(page.getByText("and 2 more")).toBeVisible();
  await expect.element(page.getByText("Change 2 vault limits.")).toBeVisible();
  await expect.element(page.getByText("Change 1 site rule.")).toBeVisible();
  await expect.element(page.getByText("Keep 2 new or newer recipes.")).toBeVisible();
  expect(client.importFile).toHaveBeenCalledWith(FILE, false);
  expect(onImported).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect
    .element(page.getByText("Imported the settings and 2 new or newer recipes."))
    .toBeVisible();
  expect(client.importFile).toHaveBeenLastCalledWith(FILE, true);
  expect(onImported).toHaveBeenCalledTimes(1);
  await expect.element(page.getByText("Importing this file will:")).not.toBeInTheDocument();
});

test("imports nothing when the preview is cancelled, or changes nothing", async () => {
  const client = syntheticClient();
  await mount(client);
  await fileInput().upload(chosen(JSON.stringify(FILE)));
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByText("Importing this file will:")).not.toBeInTheDocument();
  expect(client.importFile).toHaveBeenCalledTimes(1);

  client.importFile.mockResolvedValueOnce({
    ...PREVIEW,
    sites: [],
    policies: 0,
    others: 0,
    recipes: 0,
  });
  await fileInput().upload(chosen(JSON.stringify(FILE)));
  await expect.element(page.getByText("This file changes nothing here.")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Import", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Close" }).click();
  expect(client.importFile).toHaveBeenCalledTimes(2);
});

test("refuses a file that is not JSON without asking the service worker", async () => {
  const client = syntheticClient();
  const onImported = vi.fn();
  await mount(client, { onImported });
  await fileInput().upload(chosen("not json"));
  await expect
    .element(
      page.getByText("This is not a Pateat export file, or its settings do not fit with these."),
    )
    .toBeVisible();
  expect(client.importFile).not.toHaveBeenCalled();
  expect(onImported).not.toHaveBeenCalled();
});

test("says why an import or export did not finish", async () => {
  const client = syntheticClient({
    export: { version: 1, ok: false, error: "too-large" },
    preview: { version: 1, ok: false, error: "too-large" },
  });
  const save = vi.fn();
  await mount(client, { save });
  await exportButton().click();
  await expect
    .element(page.getByText("The settings or recipes are larger than an export file holds."))
    .toBeVisible();
  expect(save).not.toHaveBeenCalled();
  await fileInput().upload(chosen(JSON.stringify(FILE)));
  await expect
    .element(
      page.getByText(
        "The file's settings or recipes do not fit with the ones on this device. Nothing was imported.",
      ),
    )
    .toBeVisible();
});

test("holds the import while the page has unsaved changes", async () => {
  await mount(syntheticClient(), { blocked: true });
  await expect.element(importButton()).toBeDisabled();
  await expect.element(exportButton()).toBeEnabled();
  await expect
    .element(page.getByText("Save or reload the settings above before you import."))
    .toBeVisible();
});

test("the client sends settings requests and parses the answers", async () => {
  const send = vi.fn(async (request: unknown) =>
    (request as { type: string }).type === "settings.export"
      ? { version: 1, ok: true, type: "settings.export", file: FILE }
      : { version: 1, ok: false, error: "nope" },
  );
  const client = createTransferClient(send);
  expect(await client.exportFile()).toMatchObject({ ok: true, file: FILE });
  expect(send).toHaveBeenCalledWith({ version: 1, type: "settings.export" });
  await expect(client.importFile({ some: "file" }, false)).rejects.toThrow();
  expect(send).toHaveBeenCalledWith({
    version: 1,
    type: "settings.import",
    file: { some: "file" },
    apply: false,
  });
});
