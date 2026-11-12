import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  createAttemptMetadata,
  transitionLoginAttempt,
  type LoginRecipe,
  type SettingsResponse,
  type SsoRecipeDocument,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../../vault/__fixtures__/policy";
import type { AdmitContext } from "../runtime/admit-context";
import type { ManualStart } from "../runtime/manual-scope";
import type { PickedAccount } from "../runtime/session-schemas";
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
const { offerSso } = await import("../runtime/sso/entry");
const { cancelSso } = await import("../runtime/sso/flow");
const { authorizeSso } = await import("../runtime/sso-effects");
const { allowed } = await import("../runtime/plan-2");
const { registerSsoChild } = await import("../runtime/sso-state");
const { handle: dispatch } = await import("../runtime/messages");
const { admit } = await import("../runtime/admit");
const { ssoRefresh } = await import("../runtime/sso/moved");
const { createLoginSites } = await import("../sites");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const idp = "https://idp.other.test";
const rpItem = "a0000000-0000-4000-8000-000000000001";
const idpItem = "a0000000-0000-4000-8000-000000000002";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const connection = (id: string, itemId: string, origin: string): VaultConnectionMetadata => ({
  id,
  label: "Synthetic " + id,
  provider: "bitwarden",
  server: "cloud-us",
  userId: itemId,
  snapshotId,
  state: "ready",
  groups: [],
  items: [
    {
      id: itemId,
      label: "Synthetic item",
      allowedOrigins: [origin],
      groupIds: [],
      fields: [
        { id: "login.username", label: "Username", name: null, kind: "text" },
        { id: "login.password", label: "Password", name: null, kind: "hidden" },
        ...(origin === rp
          ? [
              {
                id: "custom." + snapshotId + ".0",
                label: "SSO 2",
                name: "SSO 2",
                kind: "text" as const,
              },
            ]
          : []),
      ],
    },
  ],
});
const cleanup: ReturnType<typeof createRuntimeState>[] = [];
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
async function harness(policy: "auto" | "rp-fill" | "idp-fill" | "idp-paused", native = false) {
  const catalog = {
    connections: [connection("rp-vault", rpItem, rp), connection("idp-vault", idpItem, idp)],
  };
  const settings = createDefaultSettings(catalog);
  for (const value of catalog.connections) setAccountPolicy(settings, value);
  if (policy === "rp-fill" || policy === "idp-fill")
    settings.sitePagePermissions = [
      {
        hostname: policy === "rp-fill" ? "rp.example.test" : "idp.other.test",
        includeSubdomains: false,
        permissions: { "sign-in": "fill" },
      },
    ];
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings },
    catalog,
  };
  const account = { origin: rp, connectionId: "rp-vault", itemId: rpItem };
  const selected = { account: { connectionId: "idp-vault", itemId: idpItem }, origin: idp };
  const source = { account, method: { number: 2 }, sourceEvidence: "E".repeat(43) };
  const ssoRecipe: SsoRecipeDocument = {
    version: 1,
    id: "synthetic-sso",
    revision: 1,
    origin: rp,
    sso: {
      path: "/signin",
      layouts: [
        {
          key: "1000",
          createdAt: 1000,
          entries: [
            { label: "Alternative provider", target: { by: "id", value: "alternative-entry" } },
          ],
        },
      ],
    },
  };
  const handle = vi.fn(async () => structuredClone(saved));
  const update = vi.fn();
  const fields = vi.fn<ReturnType<typeof createRuntimeState>["fields"]>(
    async () => "Synthetic value",
  );
  const rt = createRuntimeState(
    { handle, update },
    {
      fields,
      sites: createLoginSites({ read: async () => structuredClone(saved.snapshot) }),
      recipes: {
        recipe: async () => undefined,
        starts: async () => [],
        entries: async () => [],
        sso: async () => [ssoRecipe],
        ssoFence: async () => () => true,
      },
      sso: {
        describe: vi.fn(async () => ({
          ok: true as const,
          data: {
            sourceEvidence: source.sourceEvidence,
            policyRevision: 3,
            methods: [
              {
                method: { number: 2 },
                form: "bracket" as const,
                automatic: false,
                label: "Alternative provider",
              },
            ],
          },
        })),
        candidates: vi.fn(),
        validate: vi.fn(async () => ({
          ok: true as const,
          data: { sourceEvidence: source.sourceEvidence, policyRevision: 3, candidates: [] },
        })),
      },
      bindingSnapshotCurrent: () => true,
      badge: createLoginBadge({ setBadge: vi.fn(), storage: memoryBadgeStorage() }),
    },
  );
  cleanup.push(rt);
  rt.attemptRecords.write = vi.fn(async () => undefined);
  rt.vars.sessionLoaded = Promise.resolve();
  const live: LiveDocument = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" },
    token: "rp-token",
    url: rp + "/signin",
    path: "/signin",
    incognito: false,
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  rt.documents.set("7:0", live);
  const pick: PickedAccount = {
    tabId: 7,
    origin: rp,
    documentId: live.document.documentId,
    connectionId: "rp-vault",
    itemId: rpItem,
    makeDefault: false,
    waitedMs: 0,
    manual: true,
    manualRequestId: "manual-request",
  };
  const request: ManualStart = {
    document: live.document,
    url: live.url,
    path: live.path,
    topUrl: live.url,
    topDocumentId: live.document.documentId,
    expiresAt: Date.now() + 300_000,
    status: { requestId: "manual-request", state: "evaluating" },
    pick,
  };
  rt.picked.set(7, pick);
  rt.manualStarts.set(7, request);
  if (policy === "idp-paused")
    rt.pauses.until = async (urls) => (urls.includes(idp) ? Date.now() + 60_000 : undefined);
  const ctx = {
    document: live.document,
    live,
    key: "7:0",
    incognito: false,
    paused: policy === "rp-fill",
    signIn: { path: live.path },
    manual: { request, pick },
    refuse: vi.fn(async (reason: string) => ({ ok: false as const, reason })),
  } as unknown as AdmitContext;
  const offered = vi.fn(async () => ({
    offerId: "offer",
    result: Promise.resolve({ ok: true as const, choiceId: "opaque-choice" }),
  }));
  rt.ssoChoices!.request = offered;
  rt.ssoChoices!.consume = vi.fn(async () => ({
    ok: true as const,
    document: live.document,
    account,
    selection: native
      ? { kind: "native" as const, route: "password" as const }
      : { kind: "sso" as const, source, selected, label: "Alternative provider" },
  }));
  fake.state.tabUrls[7] = live.url;
  delivery.mockImplementation(async (_tabId, message) => {
    if (message["type"] === "login.sso.inspect" || message["type"] === "login.sso.prepare")
      return {
        ok: true,
        url: live.url,
        destinations: [idp + "/login"],
        ...(message["type"] === "login.sso.prepare" ? { handle: "prepared-entry" } : {}),
      };
    if (message["type"] === "login.sso.commit") {
      const sender = {
        id: fake.browser.runtime.id,
        tab: { id: 7, incognito: false },
        frameId: 0,
        documentId: live.document.documentId,
        origin: rp,
        url: live.url,
      } as never;
      const pointer = await authorizeSso(
        rt,
        { ...message, type: "login.sso.authorize", phase: "pointer" },
        sender,
      );
      return pointer.ok
        ? authorizeSso(rt, { ...message, type: "login.sso.authorize", phase: "click" }, sender)
        : pointer;
    }
    return { ok: true };
  });
  await Promise.all([rt.sso.loaded, rt.confirmFill.loaded]);
  return { rt, ctx, request, offered, update, fields, saved, source, selected, account, ssoRecipe };
}
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems
    .mockReset()
    .mockImplementation(async (keys: string[]) => keys.map((key) => ({ key, value: null })));
  io.setItems.mockReset().mockResolvedValue(undefined);
  delivery.mockReset();
  fake.state.tabUrls = {};
  fake.state.incognito = new Set();
  fake.state.granted = true;
});
afterEach(() => {
  for (const rt of cleanup.splice(0)) cancelSso(rt, 7, "synthetic-test-finished");
});

async function activeIdp() {
  const h = await harness("auto");
  expect(await offerSso(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
  const work = h.rt.sso.flows.get(7)!;
  const live: LiveDocument = {
    ...h.ctx.live,
    token: "idp-token",
    url: idp + "/signin",
    path: "/signin",
    document: { origin: idp, tabId: 7, frameId: 0, documentId: "same-idp-document" },
  };
  work.live = live;
  work.phase = "at-idp";
  h.rt.documents.set("7:0", live);
  fake.state.tabUrls[7] = live.url;
  const recipe: LoginRecipe = {
    version: 1,
    id: "native-idp",
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
    completion: [{ target: { by: "id", value: "signed-in" } }],
    maxSubmissions: 1,
  };
  let metadata = createAttemptMetadata({
    id: "awaiting-native-child",
    recipe,
    policyRevision: 3,
    account: { ...h.selected.account, origin: idp },
    choice: { route: "password", variant: 0 },
    facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
    document: live.document,
    timing: { ...live.timing, pageMs: 0 },
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
    metadata = transitionLoginAttempt(metadata, event);
  expect(registerSsoChild(h.rt.sso, work, metadata)).toBe(true);
  const run = { metadata, recipe, live, running: false } as never;
  h.rt.attempts.set(7, run);
  expect(metadata.state).toBe("awaiting-result");
  expect(await allowed(h.rt, run)).toBeDefined();
  delivery.mockClear();
  const sender = {
    id: fake.browser.runtime.id,
    tab: { id: 7, incognito: false },
    frameId: 0,
    documentId: live.document.documentId,
    origin: idp,
    url: idp + "/continue-in-place",
  };
  fake.state.tabUrls[7] = sender.url;
  const ready = vi.fn(async () => {
    h.rt.hellos.set("moved-ready", 1);
    return admit(h.rt, sender as never, live.token, "moved-ready", 1);
  });
  delivery.mockImplementation(async (_tab, message, options) => {
    if (message["type"] === "login.reconnect") {
      expect(options).toEqual({ frameId: 0, documentId: live.document.documentId });
      return ready();
    }
    if (message["type"] === "login.sso.idp") {
      expect(h.rt.documents.get("7:0")?.url).toBe(sender.url);
      expect(work.live.url).toBe(sender.url);
      return { kind: "continue", target: { by: "id", value: "continue-after-native" } };
    }
    if (message["type"] === "login.native.cancel") {
      expect(message["attemptId"]).toBe(metadata.id);
      expect(await allowed(h.rt, run)).toBeUndefined();
      return { ok: true };
    }
    if (message["type"] === "login.sso.prepare")
      return { ok: true, url: sender.url, destinations: [], handle: "same-idp-continue" };
    if (message["type"] === "login.sso.commit") {
      const pointer = await authorizeSso(
        h.rt,
        { ...message, type: "login.sso.authorize", phase: "pointer" },
        sender as never,
      );
      return pointer.ok
        ? authorizeSso(
            h.rt,
            { ...message, type: "login.sso.authorize", phase: "click" },
            sender as never,
          )
        : pointer;
    }
    return { ok: true };
  });
  const signal = (
    overrides: Record<string, unknown> = {},
    token = live.token,
    type = "login.document.moved",
  ) => dispatch(h.rt, { version: 1, type, token }, { ...sender, ...overrides } as never);
  return { ...h, work, live, run, sender, ready, signal };
}
describe("the existing moved-message dispatcher for an active SSO IdP document", () => {
  it("uses reconnect and normal admission to refresh the live URL before finite IdP reading and effect", async () => {
    const h = await activeIdp();
    await h.signal();
    await h.work.moved;
    expect(h.ready).toHaveBeenCalledTimes(1);
    expect(await h.ready.mock.results[0]!.value).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(h.rt.documents.get("7:0")?.url).toBe(idp + "/continue-in-place");
    expect(h.work.operation?.stage).toBe("spent");
    expect(h.rt.attempts.has(7)).toBe(false);
    expect(await allowed(h.rt, h.run)).toBeUndefined();
    expect(
      delivery.mock.calls.filter(([, message]) => message["type"] === "login.sso.prepare"),
    ).toHaveLength(1);
    expect(delivery.mock.calls.some(([, message]) => message["type"] === "login.cancel")).toBe(
      false,
    );
  });
  it.each([
    "token",
    "document",
    "origin",
    "frame",
    "sender",
    "cookie",
    "ended",
    "non-sso",
    "message-type",
  ])("does not reconnect, classify or mutate for a wrong %s signal", async (wrong) => {
    const h = await activeIdp();
    let overrides: Record<string, unknown> = {};
    if (wrong === "document") overrides = { documentId: "different-idp-document" };
    if (wrong === "origin") overrides = { origin: rp, url: rp + "/other" };
    if (wrong === "frame") overrides = { frameId: 1 };
    if (wrong === "sender") overrides = { id: "another-extension" };
    if (wrong === "cookie") overrides = { tab: { id: 7, incognito: true } };
    if (wrong === "ended") h.work.ended = true;
    if (wrong === "non-sso") {
      h.rt.sso.flows.delete(7);
      h.rt.attempts.delete(7);
    }
    await h.signal(
      overrides,
      wrong === "token" ? "stale-token" : h.live.token,
      wrong === "message-type" ? "other.document.moved" : "login.document.moved",
    );
    await h.work.moved;
    expect(h.ready).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
  });
});

it.each(["read-again", "cancelled", "replaced-document"])(
  "coalesces burst path signals and obeys %s withdrawal before a second reconnect",
  async (after) => {
    const h = await activeIdp();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const reconnect = vi.fn(async () => {
      if (reconnect.mock.calls.length === 1) {
        entered.resolve();
        await gate.promise;
      }
      return { ok: true };
    });
    delivery.mockImplementation(async (_tab, message) => {
      expect(message["type"]).toBe("login.reconnect");
      return reconnect();
    });
    await h.signal();
    await entered.promise;
    await Promise.all(Array.from({ length: 10 }, () => h.signal()));
    expect(reconnect).toHaveBeenCalledTimes(1);
    if (after === "cancelled") h.work.ended = true;
    if (after === "replaced-document")
      h.rt.documents.set("7:0", { ...h.live, token: "new-content-token" });
    gate.resolve();
    await h.work.moved;
    expect(reconnect).toHaveBeenCalledTimes(after === "read-again" ? 2 : 1);
    expect(h.ready).not.toHaveBeenCalled();
    expect(delivery.mock.calls.every(([, message]) => message["type"] === "login.reconnect")).toBe(
      true,
    );
  },
);

it("does not bypass the native duplicate-document boundary without an exact pending moved signal", async () => {
  const h = await activeIdp();
  expect(await h.ready()).toEqual({ ok: false, reason: "duplicate-document" });
  expect(h.rt.documents.get("7:0")).toBe(h.live);
  expect(h.work.live.url).toBe(idp + "/signin");
  expect(
    delivery.mock.calls.filter(([, message]) =>
      ["login.reconnect", "login.sso.idp", "login.sso.prepare", "login.sso.commit"].includes(
        String(message["type"]),
      ),
    ),
  ).toEqual([]);
});
it("withdraws one pending refresh only for its exact document, token, partition and changed URL", async () => {
  const h = await activeIdp();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  delivery.mockImplementation(async (_tab, message) => {
    expect(message["type"]).toBe("login.reconnect");
    entered.resolve();
    await gate.promise;
    return { ok: true };
  });
  await h.signal();
  await entered.promise;
  const refresh = (
    old = h.live,
    document = h.live.document,
    token = h.live.token,
    url = h.sender.url,
  ) => ssoRefresh(h.rt, old, document, token, url);
  expect(refresh(h.live, h.live.document, "stale-token")).toBe(false);
  expect(refresh(h.live, { ...h.live.document, documentId: "other-document" })).toBe(false);
  expect(refresh(h.live, { ...h.live.document, origin: rp })).toBe(false);
  expect(refresh(h.live, { ...h.live.document, frameId: 1 })).toBe(false);
  expect(refresh(h.live, h.live.document, h.live.token, h.live.url)).toBe(false);
  expect(refresh({ ...h.live })).toBe(false);
  h.rt.incognitoTabs.set(7, true);
  expect(refresh()).toBe(false);
  h.rt.incognitoTabs.set(7, false);
  h.work.ended = true;
  expect(refresh()).toBe(false);
  h.work.ended = false;
  expect(refresh()).toBe(true);
  expect(refresh()).toBe(false);
  gate.resolve();
  await h.work.moved;
  expect(h.ready).not.toHaveBeenCalled();
  expect(delivery).toHaveBeenCalledTimes(1);
});
