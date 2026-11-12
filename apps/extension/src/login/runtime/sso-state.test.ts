import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings, type LoginAttemptMetadata } from "@pateat/contracts";
import { createSsoState, registerSsoChild, ssoChild, type SsoWork } from "./sso-state";

const io = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock("wxt/utils/storage", () => ({ storage: io }));
const key = "session:pateat.sso-intents.v1";
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const account = {
  origin: rp,
  connectionId: "site",
  itemId: "a0000000-0000-4000-8000-000000000001",
};
const selected = {
  account: { connectionId: "provider", itemId: "a0000000-0000-4000-8000-000000000002" },
  origin: idp,
};
const document = { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" };
const journal = () => ({
  id: "flow",
  document,
  account,
  idp: { ...selected.account, origin: idp },
  method: 1,
  sourceEvidence: "E".repeat(43),
  phase: "entering-idp",
});
const work = (): SsoWork => {
  const live = {
    document,
    token: "PRIVATE-DOCUMENT-TOKEN",
    url: rp + "/signin?state=PRIVATE-STATE",
    path: "/signin",
    seenAt: 1,
    timing: { since: 1, serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  return {
    id: "flow",
    account,
    chosen: {
      connectionId: account.connectionId,
      itemId: account.itemId,
      saved: false,
      source: "pick",
    },
    source: { account, method: { number: 1 }, sourceEvidence: "E".repeat(43) },
    selected,
    label: "PRIVATE-LABEL",
    entryId: "PRIVATE-ENTRY",
    phase: "entering-idp",
    rpLive: live,
    live,
    saved: {
      version: 1,
      ok: true,
      snapshot: { version: 1, revision: 1, settings: createDefaultSettings() },
      catalog: { connections: [] },
    },
    abort: new AbortController(),
    startedAt: 123,
    used: new Set(["PRIVATE-USED"]),
    operation: {
      id: "operation",
      handle: "PRIVATE-PREPARED-HANDLE",
      live,
      stage: "intent",
      destinations: [idp + "/?private=PRIVATE-DESTINATION"],
    },
    busy: false,
    ended: false,
  };
};
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
});

describe("memory-only SSO execution authority", () => {
  it("loads persisted intent only as an interrupted tab hold", async () => {
    io.getItem.mockResolvedValue([journal()]);
    const state = createSsoState();
    await state.loaded;
    expect(io.getItem).toHaveBeenCalledWith(key);
    expect(state.interrupted.get(7)).toEqual(journal());
    expect(state.flows.size).toBe(0);
    expect(state.native.size).toBe(0);
    expect(state.healthy()).toBe(true);
    expect(io.setItem).not.toHaveBeenCalled();
  });
  it.each([
    { ...journal(), username: "person@example.test" },
    { ...journal(), handle: "old-handle" },
    { ...journal(), phase: "authorized" },
    { ...journal(), sourceEvidence: "wrong" },
    { ...journal(), document: { ...document, frameId: -1 } },
    Array(101).fill(journal()),
  ])("fails closed on malformed or overbroad interrupted authority %#", async (bad) => {
    io.getItem.mockResolvedValue(Array.isArray(bad) ? bad : [bad]);
    const state = createSsoState();
    await state.loaded;
    expect(state.healthy()).toBe(false);
    expect(state.flows.size).toBe(0);
    expect(state.native.size).toBe(0);
    expect(state.interrupted.size).toBe(0);
    await expect(state.write()).rejects.toThrow("sso-storage-unavailable");
    expect(io.setItem).not.toHaveBeenCalled();
  });
  it("records only minimal secret-free diagnostic intent, excluding all executable objects", async () => {
    const state = createSsoState();
    await state.loaded;
    state.flows.set(7, work());
    await state.write();
    expect(io.setItem).toHaveBeenCalledWith(key, [{ ...journal(), operationId: "operation" }]);
    const serialized = JSON.stringify(io.setItem.mock.calls);
    expect(serialized).not.toMatch(
      /PRIVATE|username|password|token|handle|destinations|recipe|choice|abort|settings|snapshot/u,
    );
  });
  it("omits completed flows and preserves other interrupted tab holds", async () => {
    const old = { ...journal(), document: { ...document, tabId: 8 }, id: "interrupted" };
    io.getItem.mockResolvedValue([old]);
    const state = createSsoState();
    await state.loaded;
    state.flows.set(7, { ...work(), ended: true });
    await state.write();
    expect(io.setItem).toHaveBeenCalledWith(key, [old]);
  });
  it("a worker restart cannot restore an active flow, native override or prepared handle", async () => {
    const state = createSsoState();
    await state.loaded;
    state.flows.set(7, work());
    await state.write();
    io.getItem.mockResolvedValue(structuredClone(io.setItem.mock.calls[0]![1]));
    const restarted = createSsoState();
    await restarted.loaded;
    expect(restarted.flows.size).toBe(0);
    expect(restarted.native.size).toBe(0);
    expect(restarted.interrupted.get(7)).toEqual({ ...journal(), operationId: "operation" });
  });
  it("marks a storage read failure unhealthy without restoring authority", async () => {
    io.getItem.mockRejectedValue(new Error("session unavailable"));
    const state = createSsoState();
    await state.loaded;
    expect(state.healthy()).toBe(false);
    await expect(state.write()).rejects.toThrow("sso-storage-unavailable");
    expect(io.setItem).not.toHaveBeenCalled();
  });
  it("serializes writes and prevents a later effect after an unknown persistence result", async () => {
    let reject!: (error: Error) => void;
    io.setItem.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const state = createSsoState();
    await state.loaded;
    state.flows.set(7, work());
    const first = state.write();
    const firstRejected = expect(first).rejects.toThrow("unknown write");
    const second = state.write();
    const secondRejected = expect(second).rejects.toThrow("unknown write");
    await vi.waitFor(() => expect(io.setItem).toHaveBeenCalledTimes(1));
    reject(new Error("unknown write"));
    await Promise.all([firstRejected, secondRejected]);
    expect(state.healthy()).toBe(false);
    expect(io.setItem).toHaveBeenCalledTimes(1);
  });
  const childMetadata = (): LoginAttemptMetadata =>
    ({
      id: "child-attempt",
      document: { ...document, origin: idp, documentId: "idp-document" },
      account: { ...selected.account, origin: idp },
    }) as LoginAttemptMetadata;
  it("registers one immutable exact child attempt and never an unrelated run for the same IdP account", async () => {
    const state = createSsoState();
    await state.loaded;
    const flow = work();
    state.flows.set(7, flow);
    const metadata = childMetadata();
    expect(ssoChild(state, metadata)).toBe(false);
    expect(registerSsoChild(state, flow, metadata)).toBe(true);
    expect(flow.childId).toBe(metadata.id);
    expect(ssoChild(state, metadata)).toBe(true);
    expect(ssoChild(state, { ...metadata, id: "unrelated-direct-idp-login" })).toBe(false);
    for (const changed of [
      { ...metadata, account },
      { ...metadata, account: { ...metadata.account, connectionId: "other-vault" } },
      { ...metadata, account: { ...metadata.account, itemId: account.itemId } },
      { ...metadata, account: { ...metadata.account, origin: rp } },
    ])
      expect(ssoChild(state, changed)).toBe(false);
  });
  it.each(["cancelled", "removed", "returned-rp"])(
    "keeps a late child classified after its parent is %s",
    async (ending) => {
      const state = createSsoState();
      await state.loaded;
      const flow = work();
      state.flows.set(7, flow);
      const metadata = childMetadata();
      expect(registerSsoChild(state, flow, metadata)).toBe(true);
      if (ending === "cancelled") {
        flow.ended = true;
        flow.abort.abort();
      }
      if (ending === "removed") state.flows.delete(7);
      if (ending === "returned-rp") {
        flow.phase = "returning-rp";
        flow.live = flow.rpLive;
        flow.ended = true;
        state.flows.delete(7);
      }
      expect(ssoChild(state, metadata)).toBe(true);
      expect(ssoChild(state, { ...metadata, id: "direct-login-later" })).toBe(false);
    },
  );
  it.each([
    "ended",
    "other-tab",
    "subframe",
    "other-origin",
    "other-document-origin",
    "other-account",
  ])("refuses to register an %s run as a child", async (change) => {
    const state = createSsoState();
    await state.loaded;
    const flow = work();
    const metadata = childMetadata();
    if (change === "ended") flow.ended = true;
    if (change === "other-tab") metadata.document.tabId = 8;
    if (change === "subframe") metadata.document.frameId = 1;
    if (change === "other-origin") metadata.account.origin = rp;
    if (change === "other-document-origin") metadata.document.origin = rp;
    if (change === "other-account") metadata.account.itemId = account.itemId;
    expect(registerSsoChild(state, flow, metadata)).toBe(false);
    expect(state.children.size).toBe(0);
  });
  it("refuses a second child for a parent and a reused child ID for another parent", async () => {
    const state = createSsoState();
    await state.loaded;
    const flow = work();
    const metadata = childMetadata();
    expect(registerSsoChild(state, flow, metadata)).toBe(true);
    expect(registerSsoChild(state, flow, { ...metadata, id: "second-child" })).toBe(false);
    expect(registerSsoChild(state, { ...work(), id: "another-parent" }, metadata)).toBe(false);
    expect(state.children.size).toBe(1);
  });
  it("retains only inert child classification after a worker restart, never execution authority", async () => {
    const state = createSsoState();
    await state.loaded;
    const flow = work();
    state.flows.set(7, flow);
    const metadata = childMetadata();
    expect(registerSsoChild(state, flow, metadata)).toBe(true);
    await state.write();
    expect(JSON.stringify(io.setItem.mock.calls)).not.toContain("child-attempt");
    io.getItem.mockResolvedValue(structuredClone(io.setItem.mock.calls[0]![1]));
    const restarted = createSsoState();
    await restarted.loaded;
    expect(restarted.children.size).toBe(0);
    expect(ssoChild(restarted, metadata)).toBe(true);
    expect(restarted.flows.size).toBe(0);
    expect(restarted.native.size).toBe(0);
  });
});
