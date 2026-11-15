import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings, type SettingsResponse } from "@pateat/contracts";
import type { AdmitContext } from "../runtime/admit-context";
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
const { cancelSso, ssoAdmit } = await import("../runtime/sso/flow");
const { forgetTab } = await import("../runtime/messages");
const { MAX_SSO_JOURNAL, SSO_INTERRUPTED_HOLD_MS } = await import("../runtime/sso-state");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const itemId = "a0000000-0000-4000-8000-000000000001";
const sourceEvidence = "E".repeat(43);

function harness() {
  const saved: Extract<SettingsResponse, { ok: true }> = {
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
  const live = (origin: string, documentId: string): LiveDocument => ({
    document: { origin, tabId: 7, frameId: 0, documentId },
    token: documentId + "-token",
    url: origin + "/signin",
    path: "/signin",
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  });
  const rpLive = live(rp, "rp-document");
  const flow = (change: Partial<SsoWork> = {}): SsoWork => ({
    id: "sso-parent",
    account: { origin: rp, connectionId: "rp-vault", itemId },
    source: {
      account: { connectionId: "rp-vault", itemId },
      method: { number: 1 },
      sourceEvidence,
    },
    chosen: { connectionId: "rp-vault", itemId, saved: true, source: "default" },
    selected: { account: { connectionId: "idp-vault", itemId }, origin: idp },
    phase: "prepared",
    live: rpLive,
    rpLive,
    saved,
    abort: new AbortController(),
    startedAt: Date.now(),
    used: new Set(),
    busy: false,
    ended: false,
    ...change,
  });
  const admit = (origin: string, frameId = 0) => {
    const page = live(origin, origin + "-next");
    const ctx = {
      document: { ...page.document, frameId },
      live: page,
      key: "7:" + frameId,
      refuse: vi.fn((reason: string) => ({ ok: false as const, reason })),
    } as unknown as AdmitContext;
    return ssoAdmit(rt, ctx);
  };
  return { rt, flow, admit };
}
const operation = (stage: "prepared" | "intent" | "pointer" | "spent") => ({
  id: "entry-operation",
  handle: "handle",
  live: undefined as unknown as LiveDocument,
  stage,
  destinations: [idp + "/login"],
});
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems.mockReset().mockResolvedValue([]);
  io.setItems.mockReset().mockResolvedValue(undefined);
  fake.state.messages = [];
});
afterEach(() => vi.useRealTimers());

describe("an interrupted SSO flow's hold (ADR 0026)", () => {
  it("leaves no hold after a flow that stopped before any click intent", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    h.rt.sso.flows.set(7, h.flow({ operation: { ...operation("prepared") } }));
    cancelSso(h.rt, 7, "sso-generation-refused");
    expect(h.rt.sso.interrupted.has(7)).toBe(false);
    expect(await h.admit("https://unrelated.example.test")).toBeUndefined();
    expect(await h.admit(rp)).toBeUndefined();
  });
  it.each([
    ["a durable click intent", { operation: operation("intent") }],
    ["a pressed entry", { operation: operation("spent") }],
    ["a tab at the IdP", { phase: "at-idp" as const }],
  ])("holds only the RP and IdP origins after %s", async (_name, change) => {
    const h = harness();
    await h.rt.sso.loaded;
    h.rt.sso.flows.set(7, h.flow(change));
    cancelSso(h.rt, 7, "sso-stopped");
    expect(h.rt.sso.interrupted.has(7)).toBe(true);
    expect(await h.admit(rp)).toEqual({ ok: false, reason: "sso-interrupted" });
    expect(await h.admit(idp)).toEqual({ ok: false, reason: "sso-interrupted" });
    // A frame of another origin on the held page neither waits nor ends the hold.
    expect(await h.admit("https://frame.example.test", 3)).toBeUndefined();
    expect(h.rt.sso.interrupted.has(7)).toBe(true);
    // The tab going on to another site ends it.
    expect(await h.admit("https://unrelated.example.test")).toBeUndefined();
    expect(h.rt.sso.interrupted.has(7)).toBe(false);
    expect(await h.admit(rp)).toBeUndefined();
  });
  it("ends a hold once its time has run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    await h.rt.sso.loaded;
    h.rt.sso.flows.set(7, h.flow({ phase: "entering-idp" }));
    cancelSso(h.rt, 7, "sso-stopped");
    vi.setSystemTime(Date.now() + SSO_INTERRUPTED_HOLD_MS - 1);
    expect(await h.admit(rp)).toEqual({ ok: false, reason: "sso-interrupted" });
    vi.setSystemTime(Date.now() + 1);
    expect(await h.admit(rp)).toBeUndefined();
    expect(h.rt.sso.interrupted.has(7)).toBe(false);
  });
  it.each([false, true])(
    "forgets the hold of a tab replaced or closed (closed: %s)",
    async (closed) => {
      const h = harness();
      await h.rt.sso.loaded;
      h.rt.sso.flows.set(7, h.flow({ phase: "at-idp" }));
      cancelSso(h.rt, 7, "sso-stopped");
      forgetTab(h.rt, 7, closed);
      expect(h.rt.sso.interrupted.size).toBe(0);
    },
  );
});

describe("the SSO intent journal", () => {
  const record = (tabId: number) => ({
    id: "sso-" + tabId,
    document: { origin: rp, tabId, frameId: 0, documentId: "document-" + tabId },
    account: { origin: rp, connectionId: "rp-vault", itemId },
    idp: { connectionId: "idp-vault", itemId, origin: idp },
    method: 1,
    sourceEvidence,
    phase: "at-idp",
  });
  it("keeps the newest records of an overfull journal instead of disabling SSO", async () => {
    io.getItem.mockResolvedValue(Array.from({ length: MAX_SSO_JOURNAL + 50 }, (_, i) => record(i)));
    const h = harness();
    await h.rt.sso.loaded;
    expect(h.rt.sso.healthy()).toBe(true);
    expect(h.rt.sso.interrupted.size).toBe(MAX_SSO_JOURNAL);
    expect(h.rt.sso.interrupted.has(49)).toBe(false);
    expect(h.rt.sso.interrupted.has(MAX_SSO_JOURNAL + 49)).toBe(true);
  });
  it("prunes the oldest holds when writing a full journal", async () => {
    io.getItem.mockResolvedValue(
      Array.from({ length: MAX_SSO_JOURNAL }, (_, i) => record(i + 100)),
    );
    const h = harness();
    await h.rt.sso.loaded;
    h.rt.sso.flows.set(7, h.flow({ phase: "at-idp" }));
    await h.rt.sso.write();
    const written = io.setItem.mock.lastCall![1] as { document: { tabId: number } }[];
    expect(written).toHaveLength(MAX_SSO_JOURNAL);
    expect(written.some((entry) => entry.document.tabId === 100)).toBe(false);
    expect(written.at(-1)!.document.tabId).toBe(7);
    expect(h.rt.sso.healthy()).toBe(true);
  });
});
