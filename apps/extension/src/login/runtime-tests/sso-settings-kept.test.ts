import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings, type SettingsResponse } from "@pateat/contracts";
import type { SsoWork } from "../runtime/sso-state";
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
const { ssoVaultChanged } = await import("../runtime/sso/flow");
const { settingsChanged } = await import("../runtime/messages");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const itemId = "a0000000-0000-4000-8000-000000000001";

/** An SSO flow at its IdP, under settings revision 3. */
function harness() {
  let saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings: createDefaultSettings() },
    catalog: { connections: [] },
  };
  const rt = createRuntimeState(
    { handle: vi.fn(async () => structuredClone(saved)), update: vi.fn() },
    {
      fields: vi.fn(async () => "Synthetic value"),
      badge: createLoginBadge({ setBadge: vi.fn(), storage: memoryBadgeStorage() }),
    },
  );
  rt.attemptRecords.write = vi.fn(async () => undefined);
  rt.vars.sessionLoaded = Promise.resolve();
  rt.vars.policyRead = Promise.resolve();
  const live: LiveDocument = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" },
    token: "rp-token",
    url: rp + "/signin",
    path: "/signin",
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  const work: SsoWork = {
    id: "sso-parent",
    account: { origin: rp, connectionId: "rp-vault", itemId },
    source: {
      account: { connectionId: "rp-vault", itemId },
      method: { number: 1 },
      sourceEvidence: "E".repeat(43),
    },
    chosen: { connectionId: "rp-vault", itemId, saved: true, source: "default" },
    selected: { account: { connectionId: "idp-vault", itemId }, origin: idp },
    phase: "at-idp",
    live,
    rpLive: live,
    saved: structuredClone(saved),
    abort: new AbortController(),
    startedAt: Date.now(),
    used: new Set(),
    busy: false,
    ended: false,
  };
  rt.sso.flows.set(7, work);
  const next = (change: (value: typeof saved) => void) => {
    const value = structuredClone(saved);
    value.snapshot.revision++;
    change(value);
    saved = value;
  };
  return { rt, work, next };
}
const unrelated = (value: Extract<SettingsResponse, { ok: true }>) => {
  // Another site's account choice, as another tab's login saves it.
  value.snapshot.settings.siteDefaults.push({
    origin: "https://elsewhere.example.test",
    provider: "bitwarden",
    server: "cloud-us",
    userId: itemId,
    itemId,
  });
};
const fillOnly = (value: Extract<SettingsResponse, { ok: true }>) => {
  value.snapshot.settings.pagePermissionDefaults = {
    "sign-in": "fill",
    confirm: "fill",
    "personal-details": "fill",
  };
};
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems.mockReset().mockResolvedValue([]);
  io.setItems.mockReset().mockResolvedValue(undefined);
  fake.state.messages = [];
});

describe("an SSO flow across a settings change (ADR 0026)", () => {
  it.each(["synced", "saved"] as const)(
    "keeps the flow over %s settings that change nothing it depends on",
    async (source) => {
      const h = harness();
      await h.rt.sso.loaded;
      h.next(unrelated);
      settingsChanged(h.rt, source);
      await vi.waitFor(() => expect(h.work.saved.snapshot.revision).toBe(4));
      expect(h.work.ended).toBe(false);
      expect(h.rt.sso.flows.get(7)).toBe(h.work);
    },
  );
  it("ends the flow when a page it depends on is set to fill only", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    h.next(fillOnly);
    settingsChanged(h.rt, "synced");
    await vi.waitFor(() => expect(h.work.ended).toBe(true));
  });
  it("keeps the flow over a vault notice that changes nothing it depends on", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    h.next(unrelated);
    await ssoVaultChanged(h.rt);
    expect(h.work.ended).toBe(false);
    expect(h.work.saved.snapshot.revision).toBe(4);
    h.next(fillOnly);
    await ssoVaultChanged(h.rt);
    expect(h.work.ended).toBe(true);
  });
});
