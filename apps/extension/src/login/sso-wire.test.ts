import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
const fake = await vi.hoisted(async () =>
  (await import("./runtime-tests/browser-fake")).createBrowserFake(),
);
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
import { createSsoClient, ssoChooseRequestSchema, ssoResponseSchema } from "./sso-wire";
const { createRuntimeTestHarness, createLoginRuntime } = await import("./runtime-tests/harness");
const { harness } = createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const from = [
  {
    id: "synthetic-extension",
    url: "https://site.example.test/",
    tab: { id: 7, url: "https://site.example.test/" },
    frameId: 0,
    documentId: "doc",
  },
  { id: "other-extension", url: popup.url },
  { id: "synthetic-extension", url: "chrome-extension://synthetic-extension/options.html" },
  { id: "synthetic-extension", url: `${popup.url}?other=true` },
  { id: "synthetic-extension", url: `${popup.url}/nested` },
];
beforeEach(() => {
  Object.assign(fake.state, {
    storage: {},
    session: {},
    openTabs: [],
    messages: [],
    tabUrls: {},
    pageUrl: "https://site.example.test/",
    onReconnect: undefined,
  });
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tab of [1, 7]) listener(tab);
  fake.state.replaced.length = 0;
  vi.useRealTimers();
});
describe("SSO popup transport and sender boundary", () => {
  it("serializes only scoped opaque selections and strictly validates response envelopes", async () => {
    const send = vi.fn(async (_message: unknown): Promise<unknown> => ({ ok: true }));
    const client = createSsoClient(send);
    await client.get(7);
    await client.choose({
      tabId: 7,
      offerId: "offer",
      selection: { kind: "unmap", method: { number: 1 } },
    });
    await client.cancel(7, "offer");
    expect(send.mock.calls.map(([value]) => value)).toEqual([
      { version: 1, type: "login.sso.get", tabId: 7 },
      {
        version: 1,
        type: "login.sso.choose",
        tabId: 7,
        offerId: "offer",
        selection: { kind: "unmap", method: { number: 1 } },
      },
      { version: 1, type: "login.sso.cancel", tabId: 7, offerId: "offer" },
    ]);
    send.mockResolvedValue({ ok: true, password: "must-not-leak" });
    await expect(client.get(7)).rejects.toThrow();
    await expect(client.cancel(7, "offer")).rejects.toThrow();
  });
  it("rejects arbitrary origins/accounts, unknown controls, and malformed method references from popup requests", () => {
    const choice = {
      version: 1,
      type: "login.sso.choose",
      tabId: 7,
      offerId: "offer",
      selection: { kind: "sso", method: { number: 1 }, candidateId: "opaque-candidate" },
    };
    expect(v.safeParse(ssoChooseRequestSchema, choice).success).toBe(true);
    for (const extra of [
      { origin: "https://foreign.example" },
      { account: { connectionId: "forged", itemId: "forged" } },
      { makeDefault: true },
      { label: "guessed provider" },
      { proof: "P".repeat(43) },
    ])
      expect(
        v.safeParse(ssoChooseRequestSchema, {
          ...choice,
          selection: { ...choice.selection, ...extra },
        }).success,
      ).toBe(false);
    expect(v.safeParse(ssoChooseRequestSchema, { ...choice, tabId: -1 }).success).toBe(false);
    expect(
      v.safeParse(ssoChooseRequestSchema, {
        ...choice,
        selection: { ...choice.selection, method: { number: 0 } },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ssoResponseSchema, { ok: true, username: "private-synthetic@example.test" })
        .success,
    ).toBe(false);
  });
  it("only the exact popup can reach the real runtime's SSO controller", async () => {
    const h = harness();
    const runtime = createLoginRuntime(h.store, { fields: h.fields, recipes: h.recipes });
    expect(await runtime.handle({ version: 1, type: "login.sso.get", tabId: 7 }, popup)).toEqual({
      ok: true,
    });
    await Promise.all(
      from.map(async (sender) => {
        expect(
          await runtime.handle({ version: 1, type: "login.sso.get", tabId: 7 }, sender as never),
        ).toBeUndefined();
        expect(
          await runtime.handle(
            {
              version: 1,
              type: "login.sso.choose",
              tabId: 7,
              offerId: "offer",
              selection: { kind: "native", route: "password" },
            },
            sender as never,
          ),
        ).toBeUndefined();
      }),
    );
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
});
