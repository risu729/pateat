import { describe, expect, it, vi } from "vitest";
import { createServiceClient } from "../options/service-client";

// Synthetic origins only; no tab opens and no message leaves the test.

function harness() {
  const openTab = vi.fn(async (_url: string) => undefined);
  const client = createServiceClient({
    send: vi.fn(async () => undefined),
    openTab,
    requestSiteAccess: vi.fn(async () => true),
  });
  return { client, openTab };
}

describe("openSignIn", () => {
  it("opens the service's /manage page", async () => {
    const { client, openTab } = harness();
    await client.openSignIn("https://pateat.example.com");
    expect(openTab.mock.calls).toEqual([["https://pateat.example.com/manage"]]);
  });

  it.each([
    ["plain HTTP", "http://pateat.example.com"],
    ["a path", "https://pateat.example.com/manage"],
    ["credentials", "https://user@pateat.example.com"],
    ["another scheme", "javascript:alert(1)"],
    ["not a URL", "pateat"],
  ])("refuses an origin with %s", async (_, origin) => {
    const { client, openTab } = harness();
    await expect(client.openSignIn(origin)).rejects.toThrow();
    expect(openTab).not.toHaveBeenCalled();
  });
});
