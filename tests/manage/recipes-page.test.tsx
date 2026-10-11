import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { LoginRecipe, ManageRecipes } from "../../packages/contracts/src/index";
import { ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

// Synthetic recipes only; the client is replaced, so nothing leaves the page.

const UPDATED = Date.UTC(2026, 9, 11, 8, 15);

function recipe(id: string, revision: number): LoginRecipe {
  return {
    version: 1,
    id,
    revision,
    origin: "https://bank.example",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [
          { slot: "username", target: { by: "id", value: "username" } },
          { slot: "password", target: { by: "name", value: "pass" } },
        ],
      },
      { kind: "click", path: "/login", target: { by: "test-id", value: "go" }, purpose: "submit" },
    ],
    completion: { path: "/home", target: { by: "id", value: "welcome" } },
    rejection: { by: "id", value: "login-error" },
    maxSubmissions: 1,
  };
}

function mockClient(initial: ManageRecipes) {
  let current = initial;
  return {
    devices: vi.fn<ManageClient["devices"]>(),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(async () => structuredClone(current)),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(async (recipeId, expectedRevision) => {
      const change = { recipeId, revision: expectedRevision + 1, state: "revoked" as const };
      current = {
        version: 1,
        recipes: current.recipes.map((entry) =>
          entry.change.recipeId === recipeId ? { change, updatedAt: UPDATED + 60_000 } : entry,
        ),
      };
      return { version: 1, change };
    }),
    replace(next: ManageRecipes) {
      current = next;
    },
  } satisfies ManageClient & { replace(next: ManageRecipes): void };
}

async function mount(client: ManageClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path="/manage/recipes" />
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(async () => {
  await cleanup();
});

const active = (id: string, revision = 1) => ({
  change: { recipeId: id, revision, state: "active" as const, recipe: recipe(id, revision) },
  updatedAt: UPDATED,
});

test("shows a recipe's steps, targets and JSON, then revokes it", async () => {
  const client = mockClient({
    version: 1,
    recipes: [
      active("bank-signin", 2),
      active("shop-signin"),
      { change: { recipeId: "old-signin", revision: 3, state: "revoked" }, updatedAt: UPDATED },
    ],
  });
  await mount(client);
  await expect
    .element(page.getByRole("link", { name: "Recipes" }))
    .toHaveAttribute("aria-current", "page");
  const list = page.getByRole("list").filter({ hasText: "bank-signin" }).first();
  await expect
    .element(list)
    .toMatchTextContent("https://bank.example · revision 2 · updated 2026-10-11 08:15 UTC");
  await expect.element(page.getByRole("listitem").filter({ hasText: "old-signin" })).toBeVisible();

  await page.getByText("Steps and JSON for bank-signin").click();
  const details = page.getByRole("group").first();
  await expect.element(details).toBeVisible();
  for (const text of [
    'Fill username into id "username", password into name "pass" (prepare)',
    'Click test-id "go" to submit',
    'id "welcome" on /home',
    'Rejectionid "login-error"',
    '"maxSubmissions": 1',
  ])
    // oxlint-disable-next-line no-await-in-loop -- one element, checked in order
    await expect.element(details).toMatchTextContent(text);

  // Revoking asks once more; cancelling changes nothing.
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await expect.element(page.getByRole("button", { name: "Confirm" })).toHaveFocus();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toHaveFocus();
  expect(client.revokeRecipe).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => client.revokeRecipe).toHaveBeenCalledWith("bank-signin", 2);
  await expect.element(page.getByRole("status")).toHaveTextContent("bank-signin was revoked.");
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("(revision 3, revoked 2026-10-11 08:16 UTC)")).toBeVisible();
});

test("reports a revocation that lost to another write and shows the current recipes", async () => {
  const client = mockClient({ version: 1, recipes: [active("bank-signin")] });
  await mount(client);
  client.replace({ version: 1, recipes: [active("bank-signin", 2)] });
  client.revokeRecipe.mockRejectedValueOnce(new ManageApiError("recipe_conflict"));
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(/changed elsewhere or is already revoked/);
  await expect.element(page.getByText(/revision 2/)).toBeVisible();
  // Focus returns to the control the owner used, and a retry confirms the revision now shown.
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toHaveFocus();
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => client.revokeRecipe).toHaveBeenLastCalledWith("bank-signin", 2);
});

test("revokes the revision the owner confirmed, even if the list refreshes meanwhile", async () => {
  const client = mockClient({ version: 1, recipes: [active("bank-signin")] });
  const queryClient = await mount(client);
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  client.replace({ version: 1, recipes: [active("bank-signin", 2)] });
  await queryClient.invalidateQueries();
  await expect.element(page.getByText(/revision 2/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => client.revokeRecipe).toHaveBeenCalledWith("bank-signin", 1);
});

test("keeps the last list and says so when it cannot be refreshed after a revocation", async () => {
  const client = mockClient({
    version: 1,
    recipes: [active("bank-signin"), active("shop-signin")],
  });
  await mount(client);
  await expect.element(page.getByRole("heading", { name: "shop-signin" })).toBeVisible();
  client.recipes.mockRejectedValue(new ManageApiError("network"));
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("bank-signin was revoked.");
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(/could not be refreshed and may be out of date/);
  await expect.element(page.getByRole("heading", { name: "shop-signin" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Recipes", exact: true })).toHaveFocus();
});

test("says when a generated recipe has no completion target yet", async () => {
  const entry = active("new-signin");
  delete entry.change.recipe.completion;
  await mount(mockClient({ version: 1, recipes: [entry] }));
  await page.getByText("Steps and JSON for new-signin").click();
  await expect
    .element(page.getByRole("group").first())
    .toMatchTextContent("CompletionNot learned yet; set from the page after the first sign-in");
});

test("says when there are no recipes", async () => {
  await mount(mockClient({ version: 1, recipes: [] }));
  await expect.element(page.getByText("No active recipes.")).toBeVisible();
  await expect.element(page.getByText("No revoked recipes.")).toBeVisible();
});

test("says when a recipe to revoke no longer exists", async () => {
  const client = mockClient({ version: 1, recipes: [active("bank-signin")] });
  await mount(client);
  client.revokeRecipe.mockRejectedValueOnce(new ManageApiError("not_found"));
  // The refresh is held so the page can be seen between the answer and the new list.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  client.recipes.mockImplementationOnce(async () => {
    await held;
    return { version: 1, recipes: [] };
  });
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That recipe no longer exists. The page now shows the current recipes.");
  // Focus waits for the refresh instead of landing on a control it is about to remove.
  const revokeButton = page.getByRole("button", { name: "Revoke recipe bank-signin" });
  await expect.element(revokeButton).toBeVisible();
  await expect.element(revokeButton).not.toHaveFocus();
  release();
  await expect.element(page.getByText("No active recipes.")).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Recipes", exact: true })).toHaveFocus();
});

test("asks for a reload when the recipes cannot be read", async () => {
  const client = mockClient({ version: 1, recipes: [] });
  client.recipes.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
  await expect.element(page.getByText("No revoked recipes.")).not.toBeInTheDocument();
});
