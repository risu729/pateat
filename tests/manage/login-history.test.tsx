import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { ManageLoginHistory } from "../../packages/contracts/src/index";
import { createManageClient, ManageApiError, type ManageClient } from "../../services/api/web/api";
import { LOGIN_HISTORY_QUERY_KEY, LoginHistory } from "../../services/api/web/login-history";
import { RequestLogPage } from "../../services/api/web/request-log";

// Synthetic metadata only; these mocks never send a request.
const ID = "00000000-0000-4000-8000-000000000001";
const AT = Date.UTC(2026, 10, 10, 12);
const entry: ManageLoginHistory["entries"][number] = {
  id: ID,
  at: AT,
  origin: "https://bank.example",
  recipeId: "gen-synthetic",
  revision: 2,
  outcome: "authenticated",
  cause: null,
  extensionBuild: "development",
  totalMs: 4000,
  personMs: 2000,
  serviceMs: 500,
  networkMs: 100,
  pageMs: 1500,
};
const empty: ManageLoginHistory = { version: 1, entries: [], next: null };
const first: ManageLoginHistory = { version: 1, entries: [entry], next: { at: AT, id: ID } };
function mockClient() {
  return {
    ...createManageClient(async () => {
      throw new Error("Unexpected request");
    }),
    loginHistory: vi.fn<ManageClient["loginHistory"]>(async () => first),
    requestLog: vi.fn<ManageClient["requestLog"]>(async () => ({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 1,
      problems: 0,
      oldestAt: AT,
    })),
    deleteRequestLog: vi.fn<ManageClient["deleteRequestLog"]>(async () => ({
      version: 1,
      deleted: 0,
      outcomes: 0,
      logins: 1,
      problems: 0,
    })),
  };
}
async function mount(client: ManageClient, fullPage = false) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queries}>
      {fullPage ? <RequestLogPage client={client} /> : <LoginHistory client={client} />}
    </QueryClientProvider>,
  );
  return queries;
}
afterEach(async () => {
  await cleanup();
});

test("shows only metadata, recorded durations and network time within service time", async () => {
  const client = mockClient();
  await mount(client);
  await expect
    .element(page.getByRole("list", { name: "Login records" }))
    .toMatchTextContent("https://bank.example");
  await expect
    .element(page.getByRole("list", { name: "Login records" }))
    .toMatchTextContent("Signed in");
  await expect.element(page.getByText("2026-11-10 12:00:00 UTC", { exact: true })).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await expect.element(page.getByText("gen-synthetic, revision 2", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Network within service (lower bound)", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("100 ms", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Not recorded", { exact: true })).toBeVisible();
});

test("validates origin before applying filters and resets the cursor on apply and clear", async () => {
  const client = mockClient();
  await mount(client);
  await expect.element(page.getByRole("button", { name: "Older", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect
    .poll(() => client.loginHistory.mock.calls.at(-1)?.[0])
    .toEqual({ beforeAt: AT, beforeId: ID });
  await expect
    .element(page.getByText("Showing 1 older login record.", { exact: true }))
    .toBeVisible();
  const rejects = async (typed: string) => {
    await page.getByLabelText("Site", { exact: true }).fill(typed);
    const count = client.loginHistory.mock.calls.length;
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect
      .element(page.getByLabelText("Site", { exact: true }))
      .toHaveAttribute("aria-invalid", "true");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Enter a site address such as https://example.com.");
    expect(client.loginHistory).toHaveBeenCalledTimes(count);
  };
  await rejects("bank.example");
  await rejects("ftp://bank.example");
  // A trailing slash, a path or an uppercase host is reduced to the origin.
  const appliesOrigin = async (typed: string) => {
    await page.getByLabelText("Site", { exact: true }).fill(typed);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect
      .poll(() => client.loginHistory.mock.calls.at(-1)?.[0])
      .toEqual({ origin: "https://bank.example" });
    await page.getByRole("button", { name: "Clear filters" }).click();
  };
  await appliesOrigin("https://bank.example/");
  await appliesOrigin("https://Bank.Example/login?next=1");
  await page.getByLabelText("Site", { exact: true }).fill(" https://bank.example ");
  await page.getByRole("combobox", { name: "Result", exact: true }).selectOptions("timeout");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect
    .poll(() => client.loginHistory.mock.calls.at(-1)?.[0])
    .toEqual({ origin: "https://bank.example", outcome: "timeout" });
  await expect
    .element(page.getByRole("status").filter({ hasText: "Showing" }))
    .toHaveTextContent(
      "Showing the 1 newest login record. Filtered by https://bank.example, Timed out.",
    );
  // Typed but not applied: the list still says which filters it follows.
  await page.getByLabelText("Site", { exact: true }).fill("https://draft.example");
  await page.getByRole("combobox", { name: "Result", exact: true }).selectOptions("");
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect
    .poll(() => client.loginHistory.mock.calls.at(-1)?.[0])
    .toEqual({ origin: "https://bank.example", outcome: "timeout", beforeAt: AT, beforeId: ID });
  await expect
    .element(page.getByRole("status").filter({ hasText: "Showing" }))
    .toHaveTextContent(
      "Showing 1 older login record. Filtered by https://bank.example, Timed out.",
    );
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect.element(page.getByLabelText("Site", { exact: true })).toHaveValue("");
  await expect.element(page.getByRole("combobox", { name: "Result", exact: true })).toHaveValue("");
  await expect.poll(() => client.loginHistory.mock.calls.at(-1)?.[0]).toEqual({});
  await expect
    .element(page.getByText("Showing the 1 newest login record.", { exact: true }))
    .toBeVisible();
});

test("offers Older when every record on a page was left out by the service", async () => {
  const client = mockClient();
  client.loginHistory.mockResolvedValueOnce({ ...first, entries: [] });
  await mount(client);
  await expect
    .element(
      page.getByText(
        "None of the login records on this page can be shown. Choose Older for earlier ones.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect
    .poll(() => client.loginHistory.mock.calls.at(-1)?.[0])
    .toEqual({ beforeAt: AT, beforeId: ID });
  await expect.element(page.getByRole("list", { name: "Login records" })).toBeVisible();
});

test("shows loading, empty older pages, and returns to newest without losing filters", async () => {
  const client = mockClient();
  let resolve!: (value: ManageLoginHistory) => void;
  client.loginHistory.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount(client);
  await expect.element(page.getByText("Loading login history…", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled();
  resolve(first);
  await expect.element(page.getByRole("button", { name: "Older", exact: true })).toBeEnabled();
  client.loginHistory.mockResolvedValueOnce(empty);
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect
    .element(page.getByText("No older login records match these filters.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Older", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Newest", exact: true }).click();
  await expect.element(page.getByRole("list", { name: "Login records" })).toBeVisible();
  await expect.poll(() => client.loginHistory.mock.calls.at(-1)?.[0]).toEqual({});
  const count = client.loginHistory.mock.calls.length;
  await page.getByRole("button", { name: "Newest", exact: true }).click();
  await expect.poll(() => client.loginHistory.mock.calls.length).toBe(count + 1);
});

test("reports a failed request and retries with Newest", async () => {
  const client = mockClient();
  client.loginHistory.mockRejectedValueOnce(new ManageApiError("network"));
  await mount(client);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
  await page.getByRole("button", { name: "Newest", exact: true }).click();
  await expect.element(page.getByRole("list", { name: "Login records" })).toBeVisible();
});

test("preserves dirty inputs across refetch and invalidates login history after Delete all", async () => {
  const client = mockClient();
  const queries = await mount(client, true);
  await expect.element(page.getByRole("list", { name: "Login records" })).toBeVisible();
  await page.getByLabelText("Site", { exact: true }).fill("https://draft.example");
  await page.getByRole("combobox", { name: "Result", exact: true }).selectOptions("timeout");
  await queries.invalidateQueries({ queryKey: LOGIN_HISTORY_QUERY_KEY });
  await expect
    .element(page.getByLabelText("Site", { exact: true }))
    .toHaveValue("https://draft.example");
  await expect
    .element(page.getByRole("combobox", { name: "Result", exact: true }))
    .toHaveValue("timeout");
  expect(client.loginHistory.mock.calls.at(-1)?.[0]).toEqual({});
  client.loginHistory.mockResolvedValue(empty);
  await page.getByRole("button", { name: "Delete all", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect
    .element(page.getByText("No login records match these filters.", { exact: true }))
    .toBeVisible();
  expect(client.deleteRequestLog).toHaveBeenCalledOnce();
  await expect
    .element(page.getByLabelText("Site", { exact: true }))
    .toHaveValue("https://draft.example");
});

test("the real client encodes filters and paired cursor, and rejects unsafe response fields", async () => {
  const fetcher = vi.fn(async () => Response.json(first));
  const client = createManageClient(fetcher);
  expect(
    await client.loginHistory({
      origin: "http://localhost:8080",
      outcome: "timeout",
      beforeAt: 0,
      beforeId: ID,
    }),
  ).toEqual(first);
  expect(fetcher).toHaveBeenCalledWith(
    `/manage/api/logins?origin=http%3A%2F%2Flocalhost%3A8080&outcome=timeout&beforeAt=0&beforeId=${ID}`,
    { credentials: "same-origin", redirect: "error" },
  );
  fetcher.mockResolvedValueOnce(
    Response.json({ ...first, entries: [{ ...entry, request: "private" }] }),
  );
  await expect(client.loginHistory()).rejects.toMatchObject({ code: "unexpected-response" });
  fetcher.mockResolvedValueOnce(Response.json({ version: 1, entries: [], next: { at: 1 } }));
  await expect(client.loginHistory()).rejects.toMatchObject({ code: "unexpected-response" });
});
