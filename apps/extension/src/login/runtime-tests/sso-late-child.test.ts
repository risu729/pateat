import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttemptMetadata,
  createDefaultSettings,
  holdsOrigin,
  parseAttemptMetadata,
  recoverLoginAttempt,
  transitionLoginAttempt,
  type LoginRecipe,
  type SettingsResponse,
} from "@pateat/contracts";
import type { SsoWork } from "../runtime/sso-state";
import type { Execution, LiveDocument } from "../runtime/types";
import type { AdmitContext } from "../runtime/admit-context";
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
const { registerSsoChild, ssoChild } = await import("../runtime/sso-state");
const { change } = await import("../runtime/attempt");
const { keep } = await import("../runtime/session-store");
const { heldElsewhere } = await import("../runtime/hold");
const { allowed } = await import("../runtime/plan-2");
const { ssoAdmit, beginSso, installSsoLifecycle } = await import("../runtime/sso/flow");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const itemId = "a0000000-0000-4000-8000-000000000001";
const metadataFor = (recipe: LoginRecipe, live: LiveDocument) => {
  let value = createAttemptMetadata({
    id: "native-idp-run",
    timing: { ...live.timing, pageMs: 0 },
    recipe,
    policyRevision: 3,
    account: { origin: idp, connectionId: "idp-vault", itemId },
    choice: { route: "password", variant: 0 },
    facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
    document: live.document,
  });
  for (const event of [
    { type: "RESOLVE" },
    { type: "PREPARE", operationId: "fill", kind: "fill" },
    { type: "MUTATION_INTENT", operationId: "fill" },
    { type: "OPERATION_OK", operationId: "fill" },
    { type: "PREPARE", operationId: "submit", kind: "click" },
    { type: "SUBMIT_INTENT", operationId: "submit" },
    { type: "SUBMITTED", operationId: "submit" },
  ])
    value = transitionLoginAttempt(value, event);
  return value;
};
function harness() {
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings: createDefaultSettings() },
    catalog: { connections: [] },
  };
  const update = vi.fn(async (_revision, _cause, mutate) => {
    saved.snapshot = {
      ...mutate(structuredClone(saved.snapshot)),
      revision: saved.snapshot.revision + 1,
    };
    return structuredClone(saved.snapshot);
  });
  const handle = vi.fn(async () => structuredClone(saved));
  const signedIn = vi.fn();
  const report = vi.fn();
  const rt = createRuntimeState(
    { handle, update },
    {
      fields: vi.fn(async () => "Synthetic value"),

      signedIn,
      report,
      badge: createLoginBadge({ setBadge: vi.fn(), storage: memoryBadgeStorage() }),
    },
  );
  rt.attemptRecords.write = vi.fn(async () => undefined);
  const timing = { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 };
  const live: LiveDocument = {
    document: { origin: idp, tabId: 7, frameId: 0, documentId: "idp-document" },
    token: "idp-token",
    url: idp + "/signin",
    path: "/signin",
    seenAt: Date.now(),
    timing,
  };
  const rpLive: LiveDocument = {
    ...live,
    document: { ...live.document, origin: rp, documentId: "rp-document" },
    token: "rp-token",
    url: rp + "/signin",
  };
  const recipe: LoginRecipe = {
    version: 1,
    id: "synthetic-idp",
    revision: 1,
    origin: idp,
    pageKind: "sign-in",
    slots: ["password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/signin", target: { by: "id", value: "submit" }, purpose: "submit" },
    ],
    completion: [{ target: { by: "id", value: "authenticated" } }],
    maxSubmissions: 1,
  };
  const metadata = metadataFor(recipe, live);
  const flow: SsoWork = {
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
    rpLive,
    saved,
    abort: new AbortController(),
    startedAt: Date.now(),
    used: new Set(),
    busy: false,
    ended: false,
  };
  const binding = {
    origin: idp,
    provider: "bitwarden" as const,
    server: "cloud-us",
    userId: itemId,
    itemId,
    itemName: "Synthetic IdP",
  };
  const run: Execution = {
    metadata,
    recipe,
    live,
    running: false,
    choice: { connectionId: "idp-vault", binding },
  };
  rt.documents.set("7:0", live);
  rt.attempts.set(7, run);
  rt.sso.flows.set(7, flow);
  const ctx = {
    document: rpLive.document,
    live: rpLive,
    key: "7:0",
    refuse: vi.fn((reason: string) => ({ ok: false as const, reason })),
  } as unknown as AdmitContext;
  return { rt, run, flow, live, rpLive, saved, update, signedIn, report, ctx };
}
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems.mockReset().mockResolvedValue([]);
  io.setItems.mockReset().mockResolvedValue(undefined);
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.messages = [];
  fake.browser.tabs.onUpdated.clear();
  fake.browser.tabs.onCreated.clear();
});

describe("actual native-child completion callbacks", () => {
  it.each(["active", "cancelled", "removed", "returned-rp"])(
    "does not save IdP defaults, proofs, picks or relogin counts after a parent is %s",
    async (ending) => {
      const h = harness();
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      expect(registerSsoChild(h.rt.sso, h.flow, h.run.metadata)).toBe(true);
      const parent = parseAttemptMetadata({
        version: 1,
        id: h.flow.id,
        recipeId: "synthetic-sso",
        recipeRevision: 1,
        layout: "1000",
        policyRevision: 3,
        account: h.flow.account,
        route: "sso",
        ssoParent: true,
        facts: { password: false, totp: false, passkey: false, discoverablePasskey: false },
        handlers: [],
        document: h.rpLive.document,
        state:
          ending === "returned-rp"
            ? "authenticated"
            : ending === "active"
              ? "reconciling"
              : "blocked",
        ...(ending === "returned-rp"
          ? { outcome: "authenticated" }
          : ending === "active"
            ? {}
            : { outcome: "cancelled" }),
        stepIndex: 0,
        stepCount: 1,
        submissions: 1,
        maxSubmissions: 1,
        retries: 0,
        maxRetries: 2,
        usedOperationIds: [],
        timing: { since: 100, serviceMs: 2, networkMs: 3, personMs: 4, pageMs: 5 },
      });
      const parentBefore = structuredClone(parent);
      h.flow.parent = parent;
      h.rt.persisted.set("7 " + rp, parent);
      const originalPick = {
        attemptId: "rp-choice",
        origin: rp,
        connectionId: "rp-vault",
        itemId,
      } as never;
      h.rt.picked.set(7, originalPick);
      if (ending === "cancelled") {
        h.flow.ended = true;
        h.flow.abort.abort();
        h.rt.sso.flows.delete(7);
      }
      if (ending === "removed") h.rt.sso.flows.delete(7);
      if (ending === "returned-rp") {
        h.flow.phase = "returning-rp";
        h.flow.ended = true;
        h.rt.sso.flows.delete(7);
      }
      await change(h.rt, h.run, { type: "OBSERVED", result: "authenticated" });
      expect(h.run.metadata.state).toBe("authenticated");
      expect(h.rt.persisted.get("7 " + rp)).toEqual(parentBefore);
      expect(h.flow.parent).toEqual(parentBefore);
      expect(h.rt.attemptRecords.write).toHaveBeenCalledWith(
        expect.arrayContaining([parentBefore]),
      );
      expect(h.update).not.toHaveBeenCalled();
      expect(h.saved.snapshot.settings.siteDefaults).toEqual([]);
      expect(h.rt.confirmFill.proofs).toEqual([]);
      expect(h.rt.relogins.size).toBe(0);
      expect(h.rt.picked.get(7)).toBe(originalPick);
      expect(h.run.choice).toBeUndefined();
      expect(h.signedIn).not.toHaveBeenCalled();
      expect(h.report.mock.calls.flat()).not.toContainEqual(
        expect.objectContaining({ type: "attempt" }),
      );
      expect(io.setItem.mock.calls.some(([key]) => key === "session:pateat.confirm-fills.v1")).toBe(
        false,
      );
    },
  );
  it("still records proof, default and relogin for an unrelated direct IdP login", async () => {
    const h = harness();
    await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
    h.rt.sso.flows.clear();
    await change(h.rt, h.run, { type: "OBSERVED", result: "authenticated" });
    expect(h.run.metadata.state).toBe("authenticated");
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.saved.snapshot.settings.siteDefaults).toContainEqual(
      expect.objectContaining({ origin: idp, itemId }),
    );
    expect(h.rt.confirmFill.proofs).toContainEqual(
      expect.objectContaining({ id: h.run.metadata.id, origin: idp }),
    );
    expect(h.rt.relogins.size).toBe(1);
    expect(h.signedIn).toHaveBeenCalledWith(7, idp);
  });
});

describe("SSO admission waits for diagnostic journal loading", () => {
  it("holds admission until a restored interrupted intent can be read", async () => {
    let load!: (value: unknown) => void;
    io.getItem.mockImplementation((key) =>
      key === "session:pateat.sso-intents.v1"
        ? new Promise((resolve) => {
            load = resolve;
          })
        : Promise.resolve(null),
    );
    const h = harness();
    h.rt.sso.flows.clear();
    let settled = false;
    const admission = ssoAdmit(h.rt, h.ctx).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.ctx.refuse).not.toHaveBeenCalled();
    load([
      {
        id: h.flow.id,
        document: h.rpLive.document,
        account: h.flow.account,
        idp: { ...h.flow.selected.account, origin: idp },
        method: 1,
        sourceEvidence: "E".repeat(43),
        phase: "entering-idp",
      },
    ]);
    expect(await admission).toEqual({ ok: false, reason: "sso-interrupted" });
    expect(h.rt.sso.flows.size).toBe(0);
    expect(io.setItem).not.toHaveBeenCalled();
  });
  it("creates no flow or write before journal loading, then refuses an unreadable journal", async () => {
    let load!: (value: unknown) => void;
    io.getItem.mockImplementation((key) =>
      key === "session:pateat.sso-intents.v1"
        ? new Promise((resolve) => {
            load = resolve;
          })
        : Promise.resolve(null),
    );
    const h = harness();
    h.rt.sso.flows.clear();
    h.rt.documents.set("7:0", h.rpLive);
    let settled = false;
    const admission = beginSso(h.rt, h.ctx, h.saved, h.flow.chosen, {
      kind: "sso",
      source: h.flow.source,
      selected: h.flow.selected,
      label: "Synthetic",
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.rt.sso.flows.size).toBe(0);
    expect(io.setItem).not.toHaveBeenCalled();
    load([{ malformed: true }]);
    expect(await admission).toEqual({ ok: false, reason: "sso-scope-changed" });
    expect(h.rt.sso.flows.size).toBe(0);
    expect(io.setItem).not.toHaveBeenCalled();
  });
});

describe("actual restored-child recovery has no RP or IdP authority", () => {
  it.each(["awaiting-result", "authenticated"] as const)(
    "keeps restored %s child metadata inert with an empty worker child map",
    async (state) => {
      const first = harness();
      await Promise.all([first.rt.sso.loaded, first.rt.confirmFill.loaded]);
      expect(registerSsoChild(first.rt.sso, first.flow, first.run.metadata)).toBe(true);
      if (state === "authenticated")
        await change(first.rt, first.run, { type: "OBSERVED", result: "authenticated" });
      else await keep(first.rt, first.run.metadata);
      const stored = structuredClone(
        [...first.rt.persisted.values()].find((entry) => entry.account.origin === idp)!,
      );
      expect(stored.ssoChild).toEqual({ parentId: first.flow.id, attemptId: stored.id });
      const restored = harness();
      await Promise.all([restored.rt.sso.loaded, restored.rt.confirmFill.loaded]);
      restored.rt.sso.flows.clear();
      restored.rt.sso.children.clear();
      restored.run.metadata = recoverLoginAttempt(stored);
      expect(ssoChild(restored.rt.sso, restored.run.metadata)).toBe(true);
      expect(await allowed(restored.rt, restored.run)).toBeUndefined();
      expect(restored.rt.fields).not.toHaveBeenCalled();
      await change(restored.rt, restored.run, { type: "OBSERVED", result: "authenticated" });
      expect(restored.update).not.toHaveBeenCalled();
      expect(restored.saved.snapshot.settings.siteDefaults).toEqual([]);
      expect(restored.rt.confirmFill.proofs).toEqual([]);
      expect(restored.rt.relogins.size).toBe(0);
      expect(restored.signedIn).not.toHaveBeenCalled();
      expect(restored.run.choice).toBeUndefined();
      expect(restored.rt.sso.flows.size).toBe(0);
      expect(restored.rt.sso.native.size).toBe(0);
    },
  );
});

describe("historical SSO-child holds keep evidence without blocking another login", () => {
  it("retains an active parent hold for an unreleased child", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    expect(registerSsoChild(h.rt.sso, h.flow, h.run.metadata)).toBe(true);
    await keep(h.rt, h.run.metadata);
    expect(holdsOrigin(h.run.metadata)).toBe(true);
    expect(heldElsewhere(h.rt, 8, idp)).toBe(true);
  });
  it("a released detached child retains mutation evidence but has no origin hold", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    expect(registerSsoChild(h.rt.sso, h.flow, h.run.metadata)).toBe(true);
    h.run.metadata = parseAttemptMetadata({
      ...h.run.metadata,
      state: "blocked",
      outcome: "cancelled",
      mutationIntent: true,
      ssoChild: { ...h.run.metadata.ssoChild!, released: true },
    });
    h.rt.sso.flows.clear();
    h.rt.sso.children.clear();
    h.rt.documents.set("7:0", h.rpLive);
    await keep(h.rt, h.run.metadata);
    expect(h.run.metadata).toMatchObject({
      submissions: 1,
      mutationIntent: true,
      operationId: "submit",
    });
    expect(holdsOrigin(h.run.metadata)).toBe(false);
    expect(heldElsewhere(h.rt, 8, idp)).toBe(false);
  });
  it("keeps the existing hold for ordinary native mutation evidence", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    h.rt.sso.flows.clear();
    h.run.metadata = parseAttemptMetadata({
      ...h.run.metadata,
      state: "blocked",
      outcome: "cancelled",
      mutationIntent: true,
    });
    await keep(h.rt, h.run.metadata);
    expect(holdsOrigin(h.run.metadata)).toBe(true);
    expect(heldElsewhere(h.rt, 8, idp)).toBe(true);
  });
});

describe("actual SSO lifecycle uses browser event delivery", () => {
  it.each([rp + "/callback", idp + "/login"])(
    "keeps an allowed same-tab origin update %s",
    async (url) => {
      const h = harness();
      await h.rt.sso.loaded;
      installSsoLifecycle(h.rt);
      fake.emitUpdated(7, { url });
      expect(h.rt.sso.flows.get(7)).toBe(h.flow);
      expect(h.flow.abort.signal.aborted).toBe(false);
    },
  );
  it("cancels a flow when the real onUpdated listener sees an unexpected origin", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    installSsoLifecycle(h.rt);
    fake.emitUpdated(7, { url: "https://unexpected.example.test/continuation" });
    expect(h.rt.sso.flows.has(7)).toBe(false);
    expect(h.flow.abort.signal.aborted).toBe(true);
    expect(h.rt.sso.interrupted.has(7)).toBe(true);
    await h.rt.sso.write();
  });
  it("cancels the opener flow when onCreated delivers a new browsing context", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    installSsoLifecycle(h.rt);
    fake.emitCreated({ id: 9, openerTabId: 7, url: idp + "/login" });
    expect(h.rt.sso.flows.has(7)).toBe(false);
    expect(h.flow.abort.signal.aborted).toBe(true);
    await h.rt.sso.write();
  });
  it("does not cancel a flow for an unrelated newly created tab", async () => {
    const h = harness();
    await h.rt.sso.loaded;
    installSsoLifecycle(h.rt);
    fake.emitCreated({ id: 9, openerTabId: 8, url: idp + "/login" });
    expect(h.rt.sso.flows.get(7)).toBe(h.flow);
    expect(h.flow.abort.signal.aborted).toBe(false);
  });
});
