import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { SitePolicy } from "../../apps/extension/src/options/site-policy";
import type { LocalSettings, SiteAccountsResponse } from "../../packages/contracts/src/index";

// Synthetic local and remote policy panels share one document, as on the options page.
afterEach(async () => cleanup());

test("local and remote profile site controls have unique IDs and their own descriptions", async () => {
  const draft: LocalSettings = {
    connections: [],
    accountPolicies: [],
    itemPolicies: [],
    customFieldReviews: [],
    excludedSites: [],
    repromptSites: [],
    passkeyBrowserSites: [],
    siteDefaults: [],
    bindings: [],
  };
  const findSiteAccounts = vi.fn(async (origin: string): Promise<SiteAccountsResponse> => ({
    version: 1,
    ok: true,
    origin,
    accounts: [],
    complete: true,
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { draft, catalog: { connections: [] }, edit: vi.fn(() => true), findSiteAccounts };
  await render(
    <QueryClientProvider client={queryClient}>
      <section aria-label="Local policy">
        <SitePolicy {...props} />
      </section>
      <section aria-label="Remote profile policy">
        <SitePolicy {...props} idPrefix="profile-" />
      </section>
    </QueryClientProvider>,
  );
  const local = page.getByRole("region", { name: "Local policy", exact: true });
  const remote = page.getByRole("region", { name: "Remote profile policy", exact: true });
  const localOrigin = local.getByRole("textbox", { name: "Origin", exact: true });
  const remoteOrigin = remote.getByRole("textbox", { name: "Origin", exact: true });
  await expect.element(localOrigin).toHaveAttribute("id", "site-origin");
  await expect.element(remoteOrigin).toHaveAttribute("id", "profile-site-origin");
  await expect
    .element(local.getByRole("combobox", { name: "Default account", exact: true }))
    .toHaveAttribute("aria-describedby", "default-account-note");
  await expect
    .element(remote.getByRole("combobox", { name: "Default account", exact: true }))
    .toHaveAttribute("aria-describedby", "profile-default-account-note");

  await localOrigin.fill("invalid");
  await local.getByRole("button", { name: "Save default", exact: true }).click();
  await expect.element(localOrigin).toHaveAttribute("aria-describedby", "site-error");
  await expect.element(remoteOrigin).not.toHaveAttribute("aria-describedby");
  await remoteOrigin.fill("also invalid");
  await remote.getByRole("button", { name: "Save default", exact: true }).click();
  await expect.element(remoteOrigin).toHaveAttribute("aria-describedby", "profile-site-error");
  expect(local.element().querySelector("#site-error")).not.toBeNull();
  expect(remote.element().querySelector("#profile-site-error")).not.toBeNull();
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(props.edit).not.toHaveBeenCalled();
});
