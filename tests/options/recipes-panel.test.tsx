import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { RecipeClient } from "../../apps/extension/src/options/recipe-client";
import { RecipesPanel } from "../../apps/extension/src/options/recipes-panel";
import type {
  LocalRecipeResponse,
  LocalRecipeState,
  RecipeFile,
} from "../../apps/extension/src/service/local-recipes";

// Synthetic recipe summaries only (ADR 0039); no request leaves the page.

const SITE = "https://bank.example";
const deviceState = (ids: string[] = []): LocalRecipeState => ({
  source: "device",
  recipes: ids.map((id) => ({ id, origin: SITE, revision: 1, kind: "login" })),
  waiting: 0,
});
const ok = (state: LocalRecipeState, extra: object = {}): LocalRecipeResponse => ({
  version: 1,
  ok: true,
  state,
  ...extra,
});
const exported: RecipeFile = { format: "pateat-recipes", version: 1, recipes: [] };

function mockClient(initial: LocalRecipeState = deviceState()) {
  return {
    get: vi.fn<RecipeClient["get"]>().mockResolvedValue(ok(initial)),
    importFile: vi.fn<RecipeClient["importFile"]>(),
    remove: vi.fn<RecipeClient["remove"]>(),
    clear: vi.fn<RecipeClient["clear"]>().mockResolvedValue(ok(deviceState())),
    exportFile: vi
      .fn<RecipeClient["exportFile"]>()
      .mockResolvedValue(ok(initial, { file: exported })),
  };
}

/** Chooses a file in the hidden file input, as the file picker would. */
async function choose(content: string, name = "recipes.json") {
  const input = document.querySelector<HTMLInputElement>("#recipe-file")!;
  const transfer = new DataTransfer();
  transfer.items.add(new File([content], name, { type: "application/json" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("without a service, imports a recipe file and lists the recipes kept here", async () => {
  const client = mockClient();
  client.importFile.mockResolvedValue(
    ok(deviceState(["bank-signin"]), {
      imported: { added: 1, updated: 0, unchanged: 0, skipped: 1 },
    }),
  );
  await render(<RecipesPanel client={client} pollMs={60_000} />);
  await expect
    .element(page.getByText(/No sync service is paired, so logins use the recipes saved/))
    .toBeVisible();
  await expect
    .element(page.getByText("No recipes are saved on this device.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Export recipes" })).toBeDisabled();

  await choose(JSON.stringify({ format: "pateat-recipes", version: 1, recipes: [] }));
  await expect
    .element(page.getByText(/Imported 1 new recipe and 0 newer revisions\. 1 recipe was skipped/))
    .toBeVisible();
  expect(client.importFile).toHaveBeenCalledExactlyOnceWith({
    format: "pateat-recipes",
    version: 1,
    recipes: [],
  });
  await expect.element(page.getByText(SITE, { exact: true })).toBeVisible();
  await expect.element(page.getByText("bank-signin · revision 1", { exact: true })).toBeVisible();
});

test("refuses a file that is not JSON without asking the background", async () => {
  const client = mockClient();
  await render(<RecipesPanel client={client} pollMs={60_000} />);
  await expect.element(page.getByRole("button", { name: "Import recipe file" })).toBeVisible();
  await choose("not json");
  await expect.element(page.getByText(/That file is not a Pateat recipe file/)).toBeVisible();
  expect(client.importFile).not.toHaveBeenCalled();
});

test("removes a kept recipe and exports the recipes in use", async () => {
  const client = mockClient(deviceState(["bank-signin"]));
  client.remove.mockResolvedValue(ok(deviceState()));
  client.exportFile.mockResolvedValue(ok(deviceState(["bank-signin"]), { file: exported }));
  const download = vi.fn();
  await render(<RecipesPanel client={client} download={download} pollMs={60_000} />);
  await page.getByRole("button", { name: "Export recipes" }).click();
  expect(download).toHaveBeenCalledExactlyOnceWith(exported);
  await expect.element(page.getByText("Exported 0 recipes.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove recipe bank-signin" }).click();
  expect(client.remove).toHaveBeenCalledExactlyOnceWith("bank-signin");
  await expect
    .element(page.getByText("Removed recipe bank-signin.", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("No recipes are saved on this device.", { exact: true }))
    .toBeVisible();
});

test("while paired, shows the synced recipes read-only and the recipes waiting to upload", async () => {
  const client = mockClient({
    source: "service",
    recipes: [{ id: "synced", origin: SITE, revision: 3, kind: "chooser" }],
    waiting: 2,
  });
  await render(<RecipesPanel client={client} pollMs={60_000} />);
  await expect
    .element(page.getByText("Logins use the recipes synced from the service.", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText(/2 recipes saved on this device before pairing are not on the service/))
    .toBeVisible();
  await expect
    .element(page.getByText("synced · revision 3 · chooser page", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Import recipe file" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /Remove recipe/ })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Discard recipes not uploaded" }).click();
  expect(client.clear).toHaveBeenCalledOnce();
});

test("offers to remove recipes that cannot be read", async () => {
  const client = mockClient({ source: "unavailable", recipes: [], waiting: 0, unreadable: true });
  await render(<RecipesPanel client={client} pollMs={60_000} />);
  await expect
    .element(page.getByText(/Pateat cannot read the recipes saved on this device/))
    .toBeVisible();
  await page.getByRole("button", { name: "Remove all saved recipes" }).click();
  expect(client.clear).toHaveBeenCalledOnce();
  await expect
    .element(page.getByText("No recipes are saved on this device.", { exact: true }))
    .toBeVisible();
});
