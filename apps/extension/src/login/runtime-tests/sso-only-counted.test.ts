import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  type SettingsResponse,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../../vault/__fixtures__/policy";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LiveDocument } from "../runtime/types";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
const io = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  getItems: vi.fn(),
  setItems: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.mock("wxt/utils/storage", () => ({ storage: io }));
const { createRuntimeState } = await import("../runtime/state");
const { choose } = await import("../runtime/choice-save");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const origin = "https://rp.example.test";
const userId = "c0000000-0000-4000-8000-000000000001";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const own = "a0000000-0000-4000-8000-000000000001";
const ssoOnly = "a0000000-0000-4000-8000-000000000002";
const connection: VaultConnectionMetadata = {
  id: "vault",
  label: "Synthetic vault",
  provider: "bitwarden",
  server: "cloud-us",
  userId,
  snapshotId,
  state: "ready",
  groups: [],
  items: [
    {
      id: own,
      label: "Site password",
      allowedOrigins: [],
      groupIds: [],
      fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" }],
    },
    {
      id: ssoOnly,
      label: "Site through a provider",
      allowedOrigins: [],
      groupIds: [],
      fields: [{ id: "custom.0", label: "SSO", name: "SSO", kind: "text" }],
    },
  ],
};

/** Both items match the page and neither is the saved default. */
function harness(sso: boolean, signIn: "auto" | "fill" = "auto") {
  const catalog = { connections: [connection] };
  const settings = createDefaultSettings(catalog);
  setAccountPolicy(settings, connection);
  settings.pagePermissionDefaults = {
    "sign-in": signIn,
    confirm: "fill",
    "personal-details": "fill",
  };
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings },
    catalog,
  };
  const uris = vi.fn<LiveUriMatcher>(async () => ({
    ok: true,
    data: {
      connectionId: connection.id,
      userId,
      snapshotId,
      targetOrigin: origin,
      candidates: [own, ssoOnly].map((itemId) => ({
        itemId,
        matches: [{ uriIndex: 0, match: 0 }],
      })),
      unavailableUris: [],
      unavailableItemIds: [],
    },
  }));
  const rt = createRuntimeState(
    { handle: vi.fn(async () => structuredClone(saved)), update: vi.fn() },
    {
      fields: vi.fn(async () => "Synthetic value"),
      uris,
      badge: createLoginBadge({ setBadge: vi.fn(), storage: memoryBadgeStorage() }),
      ...(sso ? { sso: { describe: vi.fn(), candidates: vi.fn(), validate: vi.fn() } } : {}),
    },
  );
  rt.vars.sessionLoaded = Promise.resolve();
  const live = (frameId = 0): LiveDocument => ({
    document: { origin, tabId: 7, frameId, documentId: "document-" + frameId },
    token: "token",
    url: origin + "/signin",
    path: "/signin",
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  });
  return { rt, saved, live };
}
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems.mockReset().mockResolvedValue([]);
  io.setItems.mockReset().mockResolvedValue(undefined);
});

// A paused site offers every match before this count (ADR 0062), so it has no case here.
describe("an SSO-only item among a page's accounts (ADR 0026)", () => {
  it("counts where the SSO route can log in by itself, so the tab asks", async () => {
    const h = harness(true);
    expect(await choose(h.rt, h.saved, h.live())).toMatchObject({
      reason: "account-ambiguous",
    });
  });
  it.each([
    ["SSO off", () => harness(false), {}],
    ["a fill-only sign-in page", () => harness(true, "fill"), {}],
    ["a confirmation page", () => harness(true), { confirm: true }],
    ["a frame", () => harness(true), { frameId: 3 }],
  ] as const)(
    "is not counted on %s, where only the site's own item can log in",
    async (_name, make, page: { confirm?: boolean; frameId?: number }) => {
      const h = make();
      expect(
        await choose(
          h.rt,
          h.saved,
          h.live(page.frameId),
          undefined,
          false,
          false,
          [],
          page.confirm === true,
        ),
      ).toMatchObject({ connectionId: connection.id, itemId: own, source: "match" });
    },
  );
});
