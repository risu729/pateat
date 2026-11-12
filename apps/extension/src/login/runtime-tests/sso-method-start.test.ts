import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
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
const { createLoginSites } = await import("../sites");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
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
        hostname: policy === "rp-fill" ? "rp.example.test" : "idp.example.test",
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
  const fields = vi.fn(async () => "Synthetic value");
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
  return { rt, ctx, request, offered, update, fields, saved };
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
describe("actual explicit SSO-method admission after the chooser", () => {
  it("starts numbered SSO 2 when both origins already allow automatic sign-in", async () => {
    const h = await harness("auto");
    expect(await offerSso(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(h.offered).toHaveBeenCalledWith(expect.objectContaining({ automatic: false }));
    expect(h.rt.sso.flows.get(7)).toMatchObject({
      source: { method: { number: 2 } },
      operation: { stage: "spent" },
    });
    expect(h.request.status).toEqual({ requestId: "manual-request", state: "started" });
    expect(h.rt.picked.has(7)).toBe(false);
    expect(delivery.mock.calls.some(([, message]) => message["type"] === "login.sso.commit")).toBe(
      true,
    );
    expect(h.fields).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each(["rp-fill", "idp-fill", "idp-paused"] as const)(
    "does not promote a one-page grant over %s into cross-origin SSO authority",
    async (policy) => {
      const h = await harness(policy);
      expect(await offerSso(h.rt, h.ctx)).toEqual({
        ok: false,
        reason: "sso-manual-scope-unavailable",
      });
      expect(h.rt.sso.flows.size).toBe(0);
      expect(
        delivery.mock.calls.some(([, message]) => message["type"] === "login.sso.commit"),
      ).toBe(false);
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it("keeps an explicit native receipt inside the existing one-page manual scope", async () => {
    const h = await harness("rp-fill", true);
    expect(await offerSso(h.rt, h.ctx)).toBeUndefined();
    expect(h.rt.sso.native.get(7)).toMatchObject({ route: "password", document: h.ctx.document });
    expect(h.rt.manualStarts.get(7)).toBe(h.request);
    expect(h.rt.sso.flows.size).toBe(0);
    expect(delivery.mock.calls.some(([, message]) => message["type"] === "login.sso.commit")).toBe(
      false,
    );
  });
});
