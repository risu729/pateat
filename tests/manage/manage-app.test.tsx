import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  DEVICE_IDLE_LIMIT_MS,
  type ManageDevices,
  type ManageRequestLog,
} from "../../packages/contracts/src/index";
import { createManageClient, ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";
import { PROBLEMS_QUERY_KEY } from "../../services/api/web/problems";

// Synthetic devices only; the client is replaced, so nothing leaves the page.

const LAPTOP = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const PHONE = "7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52";
const DAY_MS = 24 * 60 * 60 * 1000;
// Relative to the real clock, so these devices never age into expiry, and days apart, so
// no two shown times fall in the same minute whenever the test runs.
const PAIRED = Math.floor((Date.now() - 30 * DAY_MS) / 60_000) * 60_000;
const LAPTOP_USED = Date.now() - DAY_MS;
const PHONE_USED = Date.now() - 2 * DAY_MS;

function formatted(milliseconds: number) {
  return `${new Date(milliseconds).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function devices(revokedAt: number | null = null): ManageDevices {
  return {
    version: 1,
    devices: [
      {
        id: LAPTOP,
        label: "Work laptop",
        createdAt: PAIRED,
        lastUsedAt: LAPTOP_USED,
        revokedAt: null,
      },
      { id: PHONE, label: "", createdAt: PAIRED, lastUsedAt: PHONE_USED, revokedAt },
    ],
  };
}

function mockClient(initial = devices()) {
  let current = initial;
  let logged: ManageRequestLog = {
    version: 1,
    entries: 3,
    outcomes: 1,
    logins: 12,
    problems: 0,
    oldestAt: PAIRED,
  };
  return {
    dashboard: vi.fn<ManageClient["dashboard"]>(),
    devices: vi.fn<ManageClient["devices"]>(async () => structuredClone(current)),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(async (id) => {
      current = {
        ...current,
        devices: current.devices.map((device) =>
          device.id === id ? { ...device, revokedAt: PAIRED + 60_000 } : device,
        ),
      };
    }),
    settings: vi.fn<ManageClient["settings"]>(async () => ({
      version: 1,
      revision: 0,
      settings: null,
    })),
    saveSettings: vi.fn<ManageClient["saveSettings"]>(),
    recipes: vi.fn<ManageClient["recipes"]>(async () => ({
      version: 1,
      recipes: [],
      unreadable: [],
    })),
    revokeRecipe: vi.fn<ManageClient["revokeRecipe"]>(),
    requestLog: vi.fn<ManageClient["requestLog"]>(async () => structuredClone(logged)),
    deleteRequestLog: vi.fn<ManageClient["deleteRequestLog"]>(async () => {
      const { entries: deleted, outcomes, logins, problems } = logged;
      logged = { version: 1, entries: 0, outcomes: 0, logins: 0, problems: 0, oldestAt: null };
      return { version: 1, deleted, outcomes, logins, problems };
    }),
    models: vi.fn<ManageClient["models"]>(),
    saveModels: vi.fn<ManageClient["saveModels"]>(),
    claude: vi.fn<ManageClient["claude"]>(),
    saveClaude: vi.fn<ManageClient["saveClaude"]>(),
    testClaude: vi.fn<ManageClient["testClaude"]>(),
    problems: vi.fn<ManageClient["problems"]>(async () => ({
      version: 1,
      problems: [
        {
          device: "Work laptop",
          extensionBuild: "1c42ad3",
          level: "warn",
          event: "login.attempt",
          fields: { origin: "https://bank.example", outcome: "target-missing", step: 2 },
          loggedAt: LAPTOP_USED,
          receivedAt: LAPTOP_USED,
        },
        {
          device: "",
          extensionBuild: "development",
          level: "error",
          event: "error.unhandled",
          fields: { name: "TypeError", stack: "background.js:1:2" },
          loggedAt: PHONE_USED,
          receivedAt: PHONE_USED,
        },
      ],
    })),
  } satisfies ManageClient;
}

async function mount(
  client: ManageClient,
  path = "/manage",
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path={path} />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

test.each([
  ["/manage/dashboard", "Dashboard – Pateat"],
  ["/manage", "Devices – Pateat"],
  ["/manage/sites", "Sites – Pateat"],
  ["/manage/request-log", "Request log – Pateat"],
  ["/manage/problems", "Problems – Pateat"],
  ["/manage/sites/https/bank.example", "https://bank.example – Pateat"],
  ["/manage/sites/http/bank.example:8080", "http://bank.example:8080 – Pateat"],
  ["/manage/sites/https/BANK.example", "Pateat"],
])("sets the document title for %s", async (path, title) => {
  await mount(mockClient(), path);
  expect(document.title).toBe(title);
});

test("updates the hoisted title on path changes and restores the static title on unmount", async () => {
  // Match the title retained in manage/index.html before the app renders.
  const staticTitle = document.createElement("title");
  staticTitle.textContent = "Pateat";
  document.head.prepend(staticTitle);
  const client = mockClient();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = (path: string) => (
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path={path} />
    </QueryClientProvider>
  );
  try {
    expect(document.title).toBe("Pateat");
    const view = await render(app("/manage"));
    expect(document.title).toBe("Devices – Pateat");
    expect(document.head.querySelector("title")?.textContent).toBe("Devices – Pateat");
    expect(staticTitle.textContent).toBe("Pateat");

    await view.rerender(app("/manage/sites"));
    expect(document.title).toBe("Sites – Pateat");
    await view.rerender(app("/manage/sites/https/bank.example"));
    expect(document.title).toBe("https://bank.example – Pateat");
    await view.rerender(app("/manage"));
    expect(document.title).toBe("Devices – Pateat");

    await view.unmount();
    expect(document.title).toBe("Pateat");
    expect(document.head.querySelector("title")).toBe(staticTitle);
  } finally {
    await cleanup();
    staticTitle.remove();
  }
});

test("lists devices and revokes one", async () => {
  const client = mockClient();
  await mount(client);
  await expect
    .element(page.getByRole("link", { name: "Devices" }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(page.getByRole("heading", { level: 1, name: "Devices" })).toBeVisible();
  const laptop = page.getByRole("listitem").filter({ hasText: "Work laptop" });
  const phone = page.getByRole("listitem").filter({ hasText: "Unnamed device" });
  await expect
    .element(laptop)
    .toMatchTextContent(`Paired ${formatted(PAIRED)}, last used ${formatted(LAPTOP_USED)}`);
  await expect
    .element(phone)
    .toMatchTextContent(`Paired ${formatted(PAIRED)}, last used ${formatted(PHONE_USED)}`);
  await expect
    .element(page.getByText("A device unused for 90 days expires and must be paired again"))
    .toBeVisible();

  await page.getByRole("button", { name: /^Revoke Unnamed device, paired / }).click();
  expect(client.revokeDevice).toHaveBeenCalledWith(PHONE);
  await expect.element(phone).toMatchTextContent(`revoked ${formatted(PAIRED + 60_000)}`);
  await expect.element(phone).toMatchTextContent("Revoked");
  await expect.element(page.getByRole("status")).toHaveTextContent("Unnamed device revoked");
  await expect
    .element(page.getByRole("button", { name: /^Revoke Work laptop, paired / }))
    .toBeEnabled();
});

test("shows a device unused past the idle limit as expired, not revocable", async () => {
  const listed = devices();
  listed.devices[1]!.lastUsedAt = Date.now() - DEVICE_IDLE_LIMIT_MS - DAY_MS;
  await mount(mockClient(listed));
  await expect
    .element(page.getByRole("listitem").filter({ hasText: "Unnamed device" }))
    .toMatchTextContent("Expired");
  await expect
    .element(page.getByRole("button", { name: /^Revoke Unnamed device, paired / }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /^Revoke Work laptop, paired / }))
    .toBeEnabled();
});

test("says when no device is paired", async () => {
  await mount(mockClient({ version: 1, devices: [] }));
  await expect.element(page.getByText("No devices are paired with this account.")).toBeVisible();
});

test("asks for a reload when the sign-in has expired", async () => {
  const client = mockClient();
  client.devices.mockRejectedValue(new ManageApiError("network"));
  await mount(client);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Your sign-in may have expired. Reload the page to sign in again.");
});

test("reports a failed revocation and keeps the device listed", async () => {
  const client = mockClient();
  client.revokeDevice.mockRejectedValue(new ManageApiError("not_found"));
  await mount(client);
  await page.getByRole("button", { name: /^Revoke Work laptop, paired / }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("It no longer exists. Reload the page.");
  await expect.element(page.getByText("Work laptop")).toBeVisible();
});

test("deletes the whole request log after a confirmation", async () => {
  const client = mockClient();
  await mount(client, "/manage/request-log");
  await expect
    .element(page.getByRole("link", { name: "Request log" }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(
      page.getByText(
        `3 requests, 1 first login result, and 12 login records logged since ${formatted(PAIRED)}.`,
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("Each request, login result and login record is kept for 365 days"))
    .toBeVisible();

  // Cancelling asks nothing of the service and gives the button back.
  await page.getByRole("button", { name: "Delete all" }).click();
  await expect
    .element(
      page.getByText(
        "Delete all 3 requests, 1 first login result, and 12 login records? This cannot be undone.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Confirm" })).toHaveFocus();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByRole("button", { name: "Delete all" })).toHaveFocus();
  expect(client.deleteRequestLog).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  expect(client.deleteRequestLog).toHaveBeenCalledTimes(1);
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("3 requests, 1 first login result, and 12 login records deleted");
  await expect.element(page.getByText("No requests are logged.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Delete all" })).toBeDisabled();
});

test("names only the login results and records when no request is logged", async () => {
  const client = mockClient();
  client.requestLog.mockResolvedValue({
    version: 1,
    entries: 0,
    outcomes: 2,
    logins: 1,
    problems: 0,
    oldestAt: PAIRED,
  });
  await mount(client, "/manage/request-log");
  await expect
    .element(
      page.getByText(`2 first login results and 1 login record logged since ${formatted(PAIRED)}.`),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Delete all" }).click();
  await expect
    .element(
      page.getByText("Delete all 2 first login results and 1 login record? This cannot be undone."),
    )
    .toBeVisible();
});

test("counts problem lines and deletes them with the log (ADR 0066)", async () => {
  const client = mockClient();
  client.requestLog.mockResolvedValue({
    version: 1,
    entries: 0,
    outcomes: 0,
    logins: 0,
    problems: 1,
    oldestAt: PAIRED,
  });
  await mount(client, "/manage/request-log");
  await expect
    .element(page.getByText(`1 problem line logged since ${formatted(PAIRED)}.`))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Delete all" })).toBeEnabled();
  // The Problems page read before shows none once they are deleted.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(PROBLEMS_QUERY_KEY, await client.problems());
  await cleanup();
  await mount(client, "/manage/request-log", queryClient);
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await vi.waitFor(() =>
    expect(queryClient.getQueryState(PROBLEMS_QUERY_KEY)?.isInvalidated).toBe(true),
  );
});

test("lists the problem lines devices sent, newest first (ADR 0066)", async () => {
  const client = mockClient();
  await mount(client, "/manage/problems");
  await expect
    .element(page.getByRole("link", { name: "Problems" }))
    .toHaveAttribute("aria-current", "page");
  const rows = page.getByRole("listitem").filter({ hasText: /login\.attempt|error\.unhandled/ });
  // Each row reads: event, when, device, build, its fields, and the level.
  await expect
    .element(rows.nth(0))
    .toHaveTextContent(
      `login.attempt${formatted(LAPTOP_USED)}, Work laptop, 1c42ad3` +
        "origin=https://bank.example outcome=target-missing step=2warn",
    );
  await expect
    .element(rows.nth(1))
    .toHaveTextContent(
      `error.unhandled${formatted(PHONE_USED)}, Unnamed device, development` +
        "name=TypeError stack=background.js:1:2error",
    );
  await expect.element(page.getByText(/^Each line is kept for 30 days/)).toBeVisible();
});

test("says when no problem line was sent", async () => {
  const client = mockClient();
  client.problems.mockResolvedValue({ version: 1, problems: [] });
  await mount(client, "/manage/problems");
  await expect.element(page.getByText("No problems were sent.")).toBeVisible();
});

test("reports a failed deletion and keeps the log shown", async () => {
  const client = mockClient();
  client.deleteRequestLog.mockRejectedValue(new ManageApiError("rate_limited"));
  await mount(client, "/manage/request-log");
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Too many requests in the last minute. Wait a minute and try again.");
  await expect
    .element(page.getByText(/^3 requests, 1 first login result, and 12 login records logged since/))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Delete all" })).toHaveFocus();
});

test("links the source, its license and the bundled notices", async () => {
  await mount(mockClient());
  await expect.element(page.getByText("Pateat test-revision")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Source" }))
    .toHaveAttribute("href", "https://github.com/risu729/pateat/tree/main");
  await expect
    .element(page.getByRole("link", { name: "GPL-3.0-only" }))
    .toHaveAttribute("href", "https://github.com/risu729/pateat/blob/main/LICENSE-GPL-3.0.txt");
  await expect
    .element(page.getByRole("link", { name: "Third-party notices" }))
    .toHaveAttribute("href", "/manage/assets/notices.md");
  await expect.element(page.getByRole("combobox", { name: /^Theme/ })).toBeVisible();
});

test("the client sends same-origin requests and validates answers", async () => {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/manage/api/devices") return Response.json(devices());
    if (init?.method === "POST") return new Response(null, { status: 204 });
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  const client = createManageClient(fetcher);
  expect(await client.devices()).toEqual(devices());
  await client.revokeDevice(PHONE);
  expect(fetcher).toHaveBeenLastCalledWith(`/manage/api/devices/${PHONE}/revoke`, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
  });

  fetcher.mockResolvedValueOnce(
    Response.json({ version: 1, deleted: 2, outcomes: 1, logins: 3, problems: 4 }),
  );
  expect(await client.deleteRequestLog()).toEqual({
    version: 1,
    deleted: 2,
    outcomes: 1,
    logins: 3,
    problems: 4,
  });
  expect(fetcher).toHaveBeenLastCalledWith("/manage/api/request-log", {
    method: "DELETE",
    credentials: "same-origin",
    redirect: "error",
  });

  fetcher.mockResolvedValueOnce(Response.json({ version: 1, devices: [{ id: "x" }] }));
  await expect(client.devices()).rejects.toMatchObject({ code: "unexpected-response" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
  await expect(client.devices()).rejects.toMatchObject({ code: "forbidden" });
  fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(client.devices()).rejects.toMatchObject({ code: "network" });
});
