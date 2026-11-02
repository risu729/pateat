import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { createMetadataQueryClient } from "../../apps/extension/src/options/client";
import {
  ServiceReports,
  type ServiceReportsClient,
} from "../../apps/extension/src/options/service-reports";
import type { ServiceReportsSetting } from "../../apps/extension/src/service/reports-setting";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

function reportsClient(initial: ServiceReportsSetting = { send: true }) {
  let stored = initial;
  return {
    read: vi.fn(async () => stored),
    write: vi.fn(async (value: ServiceReportsSetting) => {
      stored = value;
    }),
  } satisfies ServiceReportsClient;
}

async function mount(client: ServiceReportsClient) {
  await render(
    <QueryClientProvider client={createMetadataQueryClient()}>
      <ServiceReports client={client} />
    </QueryClientProvider>,
  );
}

const toggle = () =>
  page.getByLabelText("Send login records and problem reports to the service", { exact: true });
const status = () => document.querySelector("#service-reports-status")?.textContent;

test("sending is on by default and turning it off saves on this device", async () => {
  const client = reportsClient();
  await mount(client);
  await expect.element(toggle()).toBeChecked();
  await toggle().click();
  await vi.waitFor(() =>
    expect(client.write).toHaveBeenCalledExactlyOnceWith({
      send: false,
      since: expect.any(Number),
    }),
  );
  await expect.element(toggle()).not.toBeChecked();
  await vi.waitFor(() => expect(status()).toBe("Saved on this device."));
  await toggle().click();
  await vi.waitFor(() =>
    expect(client.write).toHaveBeenLastCalledWith({ send: true, since: expect.any(Number) }),
  );
});

test("a setting that cannot be read shows Unavailable and offers no change", async () => {
  await mount({
    read: vi.fn(() => Promise.reject(new Error("storage"))),
    write: vi.fn(),
  });
  await vi.waitFor(() => expect(status()).toBe("Unavailable"));
  await expect.element(toggle()).toBeDisabled();
});

test("a failed save says so", async () => {
  const client = reportsClient({ send: false });
  client.write.mockRejectedValueOnce(new Error("storage"));
  await mount(client);
  await expect.element(toggle()).not.toBeChecked();
  await toggle().click();
  await vi.waitFor(() => expect(status()).toBe("The setting could not be saved. Try again."));
});
