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
    pageKind: "sign-in",
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
    completion: [{ target: { by: "id", value: "welcome" } }],
    rejection: { by: "id", value: "login-error" },
    maxSubmissions: 1,
  };
}

type Listed = Omit<ManageRecipes, "unreadable"> & Partial<Pick<ManageRecipes, "unreadable">>;

function mockClient(initial: Listed) {
  let current: ManageRecipes = { unreadable: [], ...initial };
  return {
    dashboard: vi.fn<ManageClient["dashboard"]>(),
    profileId: "00000000-0000-4000-8000-000000000001",
    selectProfile: vi.fn<ManageClient["selectProfile"]>(),
    profiles: vi.fn<ManageClient["profiles"]>(async () => ({
      version: 1,
      profiles: [{ id: "00000000-0000-4000-8000-000000000001", name: "Default" }],
    })),
    copyProfile: vi.fn<ManageClient["copyProfile"]>(),
    renameProfile: vi.fn<ManageClient["renameProfile"]>(),
    deleteProfile: vi.fn<ManageClient["deleteProfile"]>(),
    assignProfile: vi.fn<ManageClient["assignProfile"]>(),
    devices: vi.fn<ManageClient["devices"]>(),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(async () => ({
      version: 1,
      profileId: "00000000-0000-4000-8000-000000000001",
      revision: 0,
      settings: null,
    })),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(async () => structuredClone(current)),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(async (recipeId, expectedRevision) => {
      const change = { recipeId, revision: expectedRevision + 1, state: "revoked" as const };
      const revoked = { change, updatedAt: UPDATED + 60_000 };
      current = {
        version: 1,
        recipes: [
          ...(current.unreadable.some((entry) => entry.recipeId === recipeId) ? [revoked] : []),
          ...current.recipes.map((entry) => (entry.change.recipeId === recipeId ? revoked : entry)),
        ],
        unreadable: current.unreadable.filter((entry) => entry.recipeId !== recipeId),
      };
      return { version: 1, change };
    }),
    requestLog: vi.fn<ManageClient["requestLog"]>(),
    deleteRequestLog: vi.fn<ManageClient["deleteRequestLog"]>(),
    models: vi.fn<ManageClient["models"]>(),
    saveModels: vi.fn<ManageClient["saveModels"]>(),
    replace(next: Listed) {
      current = { unreadable: [], ...next };
    },
  } satisfies ManageClient & { replace(next: Listed): void };
}

// Recipes are listed on their site's page; revoked ones on the Sites list.
async function mount(client: ManageClient, path = "/manage/sites/https/bank.example") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path={path} />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** One recipe's entry on the site's page: its heading, facts, steps and JSON. */
const recipeItem = (id: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: id }) });

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
    .element(page.getByRole("link", { name: "Sites" }).first())
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(page.getByRole("heading", { level: 1, name: "https://bank.example" }))
    .toBeVisible();
  const details = recipeItem("bank-signin");
  for (const text of [
    "Revision2, updated 2026-10-11 08:15 UTC",
    "Page kindSign-in",
    'Fill "username" into id "username", "password" into name "pass" (prepare)',
    'Click test-id "go" to submit',
    'id "welcome" on any page',
    'Rejectionid "login-error"',
    "SubmissionsAt most 1",
  ])
    // oxlint-disable-next-line no-await-in-loop -- one element, checked in order
    await expect.element(details).toMatchTextContent(text);
  await page.getByText("JSON of bank-signin").click();
  await expect.element(details.getByText(/"maxSubmissions": 1/)).toBeVisible();
  // A revoked recipe keeps no origin, so it is not on any site's page.
  await expect.element(page.getByText("old-signin")).not.toBeInTheDocument();

  // Revoking asks once more; cancelling changes nothing.
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await expect.element(page.getByText("Revoke bank-signin, revision 2?")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Confirm" })).toHaveFocus();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toHaveFocus();
  expect(client.revokeRecipe).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => client.revokeRecipe).toHaveBeenCalledWith("bank-signin", 2);
  await expect.element(page.getByRole("status")).toHaveTextContent("bank-signin revoked");
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe shop-signin" }))
    .toBeVisible();

  // The Sites list keeps every revoked recipe, with its last revision and when.
  await cleanup();
  await mount(client, "/manage/sites");
  const revoked = page.getByRole("region", { name: "Revoked recipes" });
  await expect
    .element(revoked)
    .toMatchTextContent("bank-signinRevision 3, revoked 2026-10-11 08:16 UTC");
  await expect
    .element(revoked)
    .toMatchTextContent("old-signinRevision 3, revoked 2026-10-11 08:15 UTC");
  await expect.element(revoked).not.toMatchTextContent("shop-signin");
});

test("shows that devices never log in on a page generated as a verification (ADR 0035)", async () => {
  const kinds = [
    ["confirm", "Verification while signed in; devices never log in here"],
    ["unclear", "Unclear, handled as a verification; devices never log in here"],
  ] as const;
  const client = mockClient({
    version: 1,
    recipes: kinds.map(([pageKind]) => {
      const change = active(`bank-${pageKind}`).change;
      return { change: { ...change, recipe: { ...change.recipe, pageKind } }, updatedAt: UPDATED };
    }),
  });
  await mount(client);
  for (const [pageKind, text] of kinds)
    // oxlint-disable-next-line no-await-in-loop -- one element per kind, checked in order
    await expect.element(recipeItem(`bank-${pageKind}`)).toMatchTextContent(`Page kind${text}`);
});

test("lists recipes the service can no longer read on the Sites list and revokes them", async () => {
  const client = mockClient({
    version: 1,
    recipes: [active("shop-signin")],
    unreadable: [{ recipeId: "bank-signin", revision: 2, updatedAt: UPDATED }],
  });
  await mount(client, "/manage/sites");
  const unreadable = page.getByRole("region", { name: "Unreadable recipes" });
  await expect
    .element(unreadable)
    .toMatchTextContent("bank-signinRevision 2, updated 2026-10-11 08:15 UTC");
  await expect.element(unreadable).not.toMatchTextContent("shop-signin");

  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await expect.element(page.getByText("Revoke bank-signin, revision 2?")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => client.revokeRecipe).toHaveBeenCalledWith("bank-signin", 2);
  await expect.element(page.getByRole("status")).toHaveTextContent("bank-signin revoked");
  // The list goes once empty; the recipe is now a tombstone, whose heading takes focus.
  await expect.element(unreadable).not.toBeInTheDocument();
  const revoked = page.getByRole("region", { name: "Revoked recipes" });
  await expect
    .element(revoked)
    .toMatchTextContent("bank-signinRevision 3, revoked 2026-10-11 08:16 UTC");
  await expect.element(page.getByRole("heading", { name: "Revoked recipes" })).toHaveFocus();
});

test("shows no unreadable recipes section when there are none", async () => {
  await mount(mockClient({ version: 1, recipes: [active("shop-signin")] }), "/manage/sites");
  await expect.element(page.getByRole("heading", { name: "Revoked recipes" })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Unreadable recipes" }))
    .not.toBeInTheDocument();
});

test("lists only the recipes of the site the page is for", async () => {
  const elsewhere = active("card-signin");
  elsewhere.change.recipe.origin = "https://card.example";
  await mount(mockClient({ version: 1, recipes: [active("bank-signin"), elsewhere] }));
  await expect.element(recipeItem("bank-signin")).toBeVisible();
  await expect.element(page.getByText("card-signin")).not.toBeInTheDocument();
});

test("lists each identifier set of a recipe with several (ADR 0027)", async () => {
  // A custom-field slot named from the page's text, which may hold brackets.
  const member = "会員番号 (ログインID)";
  const varied = recipe("bank-signin", 1);
  varied.alternatives = [
    {
      slots: [member, "password"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [
            { slot: member, target: { by: "id", value: "contract" } },
            { slot: "password", target: { by: "name", value: "pass" } },
          ],
        },
        {
          kind: "click",
          path: "/login",
          target: { by: "test-id", value: "go" },
          purpose: "submit",
        },
      ],
    },
  ];
  const client = mockClient({
    version: 1,
    recipes: [
      {
        change: { recipeId: "bank-signin", revision: 1, state: "active", recipe: varied },
        updatedAt: UPDATED,
      },
    ],
  });
  await mount(client);
  const details = recipeItem("bank-signin");
  for (const text of [
    `Slots"username", "password", "${member}"`,
    'Identifier set 1 ("username", "password")',
    `Identifier set 2 ("${member}", "password")`,
    `Fill "${member}" into id "contract", "password" into name "pass" (prepare)`,
  ])
    // oxlint-disable-next-line no-await-in-loop -- one element, checked in order
    await expect.element(details).toMatchTextContent(text);
  // Each name is isolated from the text around it.
  const isolated = [...details.element().querySelectorAll("bdi")].map((node) => node.textContent);
  expect(isolated.filter((text) => text === member)).toHaveLength(3);
});

test("shows a recipe's passkey sign-in route (ADR 0027)", async () => {
  const withPasskey = recipe("bank-signin", 1);
  withPasskey.passkey = { path: "/login", target: { by: "id", value: "passkey-login" } };
  const client = mockClient({
    version: 1,
    recipes: [
      {
        change: { recipeId: "bank-signin", revision: 1, state: "active", recipe: withPasskey },
        updatedAt: UPDATED,
      },
      active("card-signin"),
    ],
  });
  await mount(client);
  await expect
    .element(recipeItem("bank-signin"))
    .toMatchTextContent(
      'Passkey sign-inClick id "passkey-login" on /login for an account with a discoverable passkey',
    );
  await expect.element(recipeItem("card-signin")).toMatchTextContent("Passkey sign-inNone");
});

test("shows a passkey-only recipe and its one click (ADR 0053)", async () => {
  const button = { by: "id", value: "passkey-login" } as const;
  const only: LoginRecipe = {
    version: 1,
    id: "bank-passkey",
    revision: 1,
    origin: "https://bank.example",
    pageKind: "sign-in",
    slots: [],
    passkeyOnly: true,
    passkey: { path: "/login", target: button },
    steps: [{ kind: "click", path: "/login", target: button, purpose: "submit" }],
    maxSubmissions: 1,
  };
  const client = mockClient({
    version: 1,
    recipes: [
      {
        change: { recipeId: "bank-passkey", revision: 1, state: "active", recipe: only },
        updatedAt: UPDATED,
      },
    ],
  });
  await mount(client);
  const details = recipeItem("bank-passkey");
  for (const text of [
    "Passkey onlyOnly an account with a discoverable passkey for the site signs in here",
    '/login Click id "passkey-login" to submit',
  ])
    // oxlint-disable-next-line no-await-in-loop -- one element, checked in order
    await expect.element(details).toMatchTextContent(text);
  expect(details.element().textContent).not.toContain("Slots");
});

test("shows an entry recipe's sign-in entry, which devices do not click yet (ADR 0031)", async () => {
  const client = mockClient({
    version: 1,
    recipes: [
      {
        change: {
          recipeId: "bank-entry",
          revision: 1,
          state: "active",
          recipe: {
            version: 1,
            id: "bank-entry",
            revision: 1,
            origin: "https://bank.example",
            entry: { path: "/", target: { by: "text", value: "Login" } },
          },
        },
        updatedAt: UPDATED,
      },
    ],
  });
  await mount(client);
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-entry" }))
    .toBeVisible();
  await page.getByText("JSON of bank-entry").click();
  const details = recipeItem("bank-entry");
  for (const text of [
    'Sign-in entryClick text "Login" on / to open the site\'s login page. Devices do not click it yet.',
    '"entry": {',
  ])
    // oxlint-disable-next-line no-await-in-loop -- one element, checked in order
    await expect.element(details).toMatchTextContent(text);
});

test("shows a chooser recipe's buttons and branches, which devices do not use yet (ADR 0028)", async () => {
  const client = mockClient({
    version: 1,
    recipes: [
      {
        change: {
          recipeId: "bank-chooser",
          revision: 1,
          state: "active",
          recipe: {
            version: 1,
            id: "bank-chooser",
            revision: 1,
            origin: "https://bank.example",
            chooser: {
              path: "/login",
              other: { by: "text", value: "Use another account" },
              continue: { by: "text", value: "Log back in" },
            },
          },
        },
        updatedAt: UPDATED,
      },
    ],
  });
  await mount(client);
  await page.getByText("JSON of bank-chooser").click();
  const details = recipeItem("bank-chooser");
  for (const text of [
    "Account listOn /login, click the entry of the chosen item's account. Devices do not do this yet.",
    'Shown accountClick text "Log back in"',
    'Another accountClick text "Use another account"',
    "After an accountNot generated yet",
    "After another accountNot generated yet",
    '"chooser": {',
  ])
    // oxlint-disable-next-line no-await-in-loop -- one element, checked in order
    await expect.element(details).toMatchTextContent(text);
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
  await expect.element(page.getByText("2, updated 2026-10-11 08:15 UTC")).toBeVisible();
  // Focus returns to the control the owner used, and a retry confirms the revision now shown.
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toHaveFocus();
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => client.revokeRecipe).toHaveBeenLastCalledWith("bank-signin", 2);
});

test("moves focus between Revoke and Confirm while the list is refreshing", async () => {
  const client = mockClient({ version: 1, recipes: [active("bank-signin")] });
  const queryClient = await mount(client);
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toBeVisible();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  client.recipes.mockImplementationOnce(async () => {
    await held;
    return { version: 1, recipes: [active("bank-signin")], unreadable: [] };
  });
  void queryClient.invalidateQueries();
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  await expect.element(page.getByRole("button", { name: "Confirm" })).toHaveFocus();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toHaveFocus();
  expect(client.recipes).toHaveBeenCalledTimes(2);
  release();
});

test("revokes the revision the owner confirmed, even if the list refreshes meanwhile", async () => {
  const client = mockClient({ version: 1, recipes: [active("bank-signin")] });
  const queryClient = await mount(client);
  await page.getByRole("button", { name: "Revoke recipe bank-signin" }).click();
  client.replace({ version: 1, recipes: [active("bank-signin", 2)] });
  await queryClient.invalidateQueries();
  await expect.element(page.getByText("2, updated 2026-10-11 08:15 UTC")).toBeVisible();
  // The prompt still names the revision the owner asked to revoke.
  await expect.element(page.getByText("Revoke bank-signin, revision 1?")).toBeVisible();
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
  await expect.element(page.getByRole("status")).toHaveTextContent("bank-signin revoked");
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(/could not be refreshed and may be out of date/);
  await expect.element(page.getByRole("heading", { name: "shop-signin" })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Recipes", exact: true })).toHaveFocus();
});

test("says when a generated recipe has no signed-in marker yet", async () => {
  const entry = active("new-signin");
  delete entry.change.recipe.completion;
  await mount(mockClient({ version: 1, recipes: [entry] }));
  await expect
    .element(recipeItem("new-signin"))
    .toMatchTextContent(
      "Signed-in markersNot learned yet; set from the page after the first sign-in",
    );
});

test("says when there are no recipes", async () => {
  const client = mockClient({ version: 1, recipes: [] });
  await mount(client);
  await expect.element(page.getByText("No recipes", { exact: true })).toBeVisible();
  await cleanup();
  await mount(client, "/manage/sites");
  await expect.element(page.getByText("No revoked recipes")).toBeVisible();
});

test("says when a recipe to revoke no longer exists", async () => {
  const client = mockClient({ version: 1, recipes: [active("bank-signin")] });
  await mount(client);
  await expect
    .element(page.getByRole("button", { name: "Revoke recipe bank-signin" }))
    .toBeVisible();
  client.revokeRecipe.mockRejectedValueOnce(new ManageApiError("not_found"));
  // The refresh is held so the page can be seen between the answer and the new list.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  client.recipes.mockImplementationOnce(async () => {
    await held;
    return { version: 1, recipes: [], unreadable: [] };
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
  await expect.element(page.getByText("No recipes", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Recipes", exact: true })).toHaveFocus();
});

test("asks for a reload when the recipes cannot be read", async () => {
  const client = mockClient({ version: 1, recipes: [] });
  client.recipes.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
  await expect.element(page.getByText("No recipes", { exact: true })).not.toBeInTheDocument();
  await cleanup();
  await mount(client, "/manage/sites");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
  await expect.element(page.getByText("No revoked recipes")).not.toBeInTheDocument();
});
