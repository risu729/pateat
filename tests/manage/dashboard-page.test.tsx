import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createManageClient, ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";
import { syntheticDashboard } from "./dashboard-fixture";

// A synthetic dashboard only; the client is replaced, so nothing leaves the page.

const NOW = Date.UTC(2026, 9, 18, 12);

function mockClient() {
  return {
    dashboard: vi.fn<ManageClient["dashboard"]>(async (range) => ({
      ...syntheticDashboard(NOW),
      range,
    })),
    devices: vi.fn<ManageClient["devices"]>(),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(),
    settings: vi.fn<ManageClient["settings"]>(),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(),
    revokeLayout: vi.fn<ManageClient["revokeLayout"]>(),
    requestLog: vi.fn<ManageClient["requestLog"]>(),
    deleteRequestLog: vi.fn<ManageClient["deleteRequestLog"]>(),
    models: vi.fn<ManageClient["models"]>(),
    saveModels: vi.fn<ManageClient["saveModels"]>(),
  } satisfies ManageClient;
}

async function mount(client: ManageClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path="/manage/dashboard" />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

test("is the first section and shows speed, stats and failures for 7 days", async () => {
  const client = mockClient();
  await mount(client);
  const links = page.getByRole("navigation", { name: "Sections" }).getByRole("link");
  await expect.element(links.first()).toMatchTextContent("Dashboard");
  await expect.element(links.first()).toHaveAttribute("aria-current", "page");
  await expect.element(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  expect(client.dashboard).toHaveBeenCalledWith("7d");
  await expect.element(page.getByRole("radio", { name: "7 days" })).toBeChecked();

  // Login speed comes first: signed-in logins less the person's time, apart for those that
  // waited on the service.
  const speed = page.getByRole("region", { name: "Speed" });
  await expect
    .element(speed.getByRole("heading", { level: 3 }).first())
    .toHaveTextContent("Logins");
  await expect
    .element(page.getByText("5 of 51 signed-in logins (10%) waited on the service."))
    .toBeVisible();
  const waited = page.getByRole("region", { name: "Waited on the service · login time" });
  await expect.element(waited).toMatchTextContent("p50 10.4 s · n 5");
  await expect.element(waited).toMatchTextContent("Values: 8.1 s, 9.8 s");
  const recipeOnly = page.getByRole("region", { name: "Recipe only · login time" });
  await expect.element(recipeOnly).toMatchTextContent("p50 3.7 s · p90 6.9 s · n 46");
  const loginParts = page.getByRole("table", { name: "Median login time by part" });
  await expect
    .element(loginParts.getByRole("row").nth(1))
    .toMatchTextContent("Waited on the service420 ms8.9 s1.1 s400 ms0 ms5");
  await expect.element(loginParts).toMatchTextContent("Waiting for the site");
  const loginTrend = page.getByRole("table", { name: /^Median login time by UTC day/ });
  await expect
    .element(
      loginTrend.getByRole("row", {
        name: new RegExp(`^${syntheticDashboard(NOW).daily[2]!.day}`),
      }),
    )
    .toMatchTextContent(`${syntheticDashboard(NOW).daily[2]!.day}–00`);
  const loginSites = page.getByRole("table", { name: /^Logins per site/ });
  await expect
    .element(loginSites.getByRole("row", { name: /^https:\/\/bank\.example/ }))
    .toMatchTextContent("14125.6 s · n 12");
  const loginBuilds = page.getByRole("table", { name: /^Logins per extension build/ });
  await expect.element(loginBuilds).toMatchTextContent("8f3a754");

  // Below 20 values the values are listed; from 20 the p90 is shown.
  const generate = page.getByRole("region", { name: "Generate · model time" });
  await expect.element(generate).toMatchTextContent("p50 9.4 s · n 12");
  await expect.element(generate).toMatchTextContent("Values: 7.6 s, 8.1 s");
  await expect.element(generate).not.toMatchTextContent("p90");
  const judge = page.getByRole("region", { name: "Judge · model time" });
  await expect.element(judge).toMatchTextContent("p50 2.6 s · p90 4.7 s · n 42");
  await expect.element(judge).not.toMatchTextContent("Values:");

  // Each chart has its numbers in a table; the charts load lazily and are hidden from
  // assistive technology.
  const parts = page.getByRole("table", { name: "Median server time by part" });
  await expect
    .element(parts.getByRole("row").nth(2))
    .toMatchTextContent("Judge180 ms300 ms2.6 s40 ms41");
  const trend = page.getByRole("table", { name: /^Median model time by UTC day/ });
  await expect.element(trend).toBeInTheDocument();
  const gap = syntheticDashboard(NOW).daily[2]!.day;
  await expect
    .element(trend.getByRole("row", { name: new RegExp(`^${gap}`) }))
    .toMatchTextContent(`${gap}–0–0`);
  // Without the page's stylesheet the charts have no height to draw in; their containers
  // show that the lazily loaded chunk rendered.
  await expect
    .poll(
      () => document.querySelectorAll('[data-slot="chart"] .recharts-responsive-container').length,
      { timeout: 10_000 },
    )
    .toBe(4);
  for (const chart of document.querySelectorAll('[data-slot="chart"]'))
    expect(chart.getAttribute("aria-hidden")).toBe("true");

  const sites = page.getByRole("table", { name: /^Requests per site/ });
  await expect
    .element(sites.getByRole("link", { name: "https://bank.example" }))
    .toHaveAttribute("href", "/manage/sites/https/bank.example");
  // Each median shows how many values it is of.
  await expect
    .element(sites.getByRole("row", { name: /^https:\/\/bank\.example/ }))
    .toMatchTextContent("9.8 s · n 3");
  const builds = page.getByRole("table", { name: /per service build/ });
  await expect.element(builds).toMatchTextContent("031b5aa");
  await expect.element(builds).toMatchTextContent("Not recorded");
  const slowest = page.getByRole("table", { name: "The 10 requests with the longest server time" });
  await expect.element(slowest.getByRole("row").nth(1)).toMatchTextContent("15.0 s");

  await expect.element(page.getByText("$0.42 of $5.00")).toBeVisible();
  await expect.element(page.getByText("$7.35 of $100.00")).toBeVisible();
  await expect.element(page.getByText("280,920 / 24,630")).toBeVisible();
  // Every login counts in the stats; the first logins are counted apart.
  await expect.element(page.getByText("51 of 55 (93%)")).toBeVisible();
  const loginDays = page.getByRole("table", { name: /^Logins by UTC day/ });
  // Days without a login are left out.
  await expect.poll(() => loginDays.getByRole("row").elements().length).toBe(8);
  await expect
    .element(page.getByRole("heading", { name: "First login with each recipe version" }))
    .toBeVisible();
  await expect.element(page.getByText("3 of 4 (75%)")).toBeVisible();
  await expect
    .element(
      page.getByRole("table", { name: "How the first login with each recipe version ended" }),
    )
    .toBeVisible();

  // Failure groups open to their latest rows; a login's site is the one its record holds.
  const failures = page.getByRole("region", { name: "Failures" });
  const unknownSubmit = failures.getByRole("listitem").filter({ hasText: "unknown-submit" });
  await expect.element(unknownSubmit).toMatchTextContent("https://shop.example");
  const abstained = failures.getByRole("listitem").filter({ hasText: "abstained" });
  await expect.element(abstained.getByRole("group")).not.toHaveAttribute("open");
  await abstained.getByText("abstained", { exact: true }).click();
  await expect.element(abstained.getByRole("group")).toHaveAttribute("open");
  await expect
    .element(abstained.getByRole("table", { name: "The latest 3 times abstained came" }))
    .toBeVisible();
  // `challenge` waited for the person: listed apart, not as a failure.
  await expect.element(page.getByRole("heading", { name: "Needed the person" })).toBeVisible();
  await expect
    .element(failures.getByRole("listitem").filter({ hasText: "challenge" }))
    .toMatchTextContent("2 times");
});

test("asks for another range", async () => {
  const client = mockClient();
  await mount(client);
  await expect.element(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.getByRole("radio", { name: "30 days" }).click();
  await expect.element(page.getByRole("radio", { name: "30 days" })).toBeChecked();
  expect(client.dashboard).toHaveBeenLastCalledWith("30d");
  await page.getByRole("radio", { name: "24 hours" }).click();
  expect(client.dashboard).toHaveBeenLastCalledWith("24h");
});

test("reports a failed load", async () => {
  const client = mockClient();
  client.dashboard.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("Your sign-in may have expired. Reload the page to sign in again.");
});

test("the client asks for the range and validates the answer, the fixture included", async () => {
  const fetcher = vi.fn(async (_input: string, _init?: RequestInit) =>
    Response.json(syntheticDashboard(NOW)),
  );
  const client = createManageClient(fetcher);
  expect(await client.dashboard("30d")).toEqual(syntheticDashboard(NOW));
  expect(fetcher).toHaveBeenLastCalledWith("/manage/api/dashboard?range=30d", {
    credentials: "same-origin",
    redirect: "error",
  });
  fetcher.mockResolvedValueOnce(Response.json({ ...syntheticDashboard(NOW), llm: [{}] }));
  await expect(client.dashboard("7d")).rejects.toMatchObject({ code: "unexpected-response" });
});
