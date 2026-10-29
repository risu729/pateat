import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceClient, ProfileEditorError } from "../options/service-client";

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
  it("opens the service's /pair/signed-in page", async () => {
    const { client, openTab } = harness();
    await client.openSignIn("https://pateat.example.com");
    expect(openTab.mock.calls).toEqual([["https://pateat.example.com/pair/signed-in"]]);
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

describe("profile editor", () => {
  const ORIGIN = "https://pateat.example.com";
  const PROFILE = "00000000-0000-4000-8000-000000000010";
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the WARP application's /extension/signed-in page", async () => {
    const { client, openTab } = harness();
    await client.profileEditor?.openSignIn(ORIGIN);
    expect(openTab.mock.calls).toEqual([[`${ORIGIN}/extension/signed-in`]]);
  });

  it("reads profiles from /extension/profiles with the browser's sign-in", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ version: 1, profiles: [{ id: PROFILE, name: "Default" }] }),
    );
    vi.stubGlobal("fetch", fetch);
    const { client } = harness();
    expect(await client.profileEditor?.list(ORIGIN)).toEqual({
      version: 1,
      profiles: [{ id: PROFILE, name: "Default" }],
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${ORIGIN}/extension/profiles`);
    expect(init).toMatchObject({ method: "GET", credentials: "include", redirect: "manual" });
  });

  it.each([
    ["a network failure", () => Response.error(), "unreachable"],
    ["a 401", () => Response.json({ error: "unauthorized" }, { status: 401 }), "sign-in-needed"],
    ["the login page itself", () => new Response("<html></html>"), "sign-in-needed"],
    ["a 403", () => Response.json({ error: "forbidden" }, { status: 403 }), "forbidden"],
    ["Access's own 403 page", () => new Response("<html></html>", { status: 403 }), "forbidden"],
    [
      "an extension the service does not list",
      () => Response.json({ error: "extension_not_allowed" }, { status: 403 }),
      "extension-not-allowed",
    ],
    ["a 409", () => Response.json({ error: "conflict" }, { status: 409 }), "conflict"],
    ["a 404", () => Response.json({ error: "not_found" }, { status: 404 }), "not-found"],
    [
      "a 500",
      () => Response.json({ error: "internal_error" }, { status: 500 }),
      "unexpected-response",
    ],
    ["another shape", () => Response.json({ version: 1 }), "unexpected-response"],
  ])("names %s", async (_, answer, reason) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = answer();
        if (response.type === "error") throw new TypeError("Failed to fetch");
        return response;
      }),
    );
    const { client } = harness();
    const failure = await client.profileEditor?.list(ORIGIN).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProfileEditorError);
    expect((failure as ProfileEditorError).reason).toBe(reason);
  });
});
