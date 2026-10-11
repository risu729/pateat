import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { ManageDevices } from "../../packages/contracts/src/index";
import { createManageClient, ManageApiError, type ManageClient } from "../../services/api/web/api";
import { ManageApp } from "../../services/api/web/app";

// Synthetic devices only; the client is replaced, so nothing leaves the page.

const LAPTOP = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const PHONE = "7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52";
const PAIRED = Date.UTC(2026, 9, 10, 12, 30);

function devices(revokedAt: number | null = null): ManageDevices {
  return {
    version: 1,
    devices: [
      { id: LAPTOP, label: "Work laptop", createdAt: PAIRED, revokedAt: null },
      { id: PHONE, label: "", createdAt: PAIRED, revokedAt },
    ],
  };
}

function mockClient(initial = devices()) {
  let current = initial;
  return {
    devices: vi.fn<ManageClient["devices"]>(async () => structuredClone(current)),
    revokeDevice: vi.fn<ManageClient["revokeDevice"]>(async (id) => {
      current = {
        ...current,
        devices: current.devices.map((device) =>
          device.id === id ? { ...device, revokedAt: PAIRED + 60_000 } : device,
        ),
      };
    }),
  } satisfies ManageClient;
}

async function mount(client: ManageClient, path = "/manage") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <ManageApp client={client} path={path} />
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

test("lists devices and revokes one", async () => {
  const client = mockClient();
  await mount(client);
  await expect
    .element(page.getByRole("link", { name: "Devices" }))
    .toHaveAttribute("aria-current", "page");
  await expect.element(page.getByRole("cell", { name: "Work laptop" })).toBeVisible();
  await expect.element(page.getByRole("cell", { name: "Unnamed device" })).toBeVisible();
  await expect
    .element(page.getByRole("cell", { name: "2026-10-10 12:30 UTC" }).first())
    .toBeVisible();

  await page.getByRole("button", { name: /^Revoke Unnamed device, paired / }).click();
  expect(client.revokeDevice).toHaveBeenCalledWith(PHONE);
  await expect.element(page.getByText("Revoked 2026-10-10 12:31 UTC")).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("Unnamed device was revoked.");
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
  await expect.element(page.getByRole("cell", { name: "Work laptop" })).toBeVisible();
});

test("links the source and the bundled notices", async () => {
  await mount(mockClient());
  await expect
    .element(page.getByRole("link", { name: "its source" }))
    .toHaveAttribute("href", "https://github.com/risu729/pateat/tree/main");
  await expect
    .element(page.getByRole("link", { name: "third-party notices" }))
    .toHaveAttribute("href", "/manage/assets/notices.md");
});

test("renders no page for an unknown path", async () => {
  await mount(mockClient(), "/manage/unknown");
  await expect.element(page.getByText("No such page.")).toBeVisible();
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

  fetcher.mockResolvedValueOnce(Response.json({ version: 1, devices: [{ id: "x" }] }));
  await expect(client.devices()).rejects.toMatchObject({ code: "unexpected-response" });
  fetcher.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
  await expect(client.devices()).rejects.toMatchObject({ code: "forbidden" });
  fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(client.devices()).rejects.toMatchObject({ code: "network" });
});
