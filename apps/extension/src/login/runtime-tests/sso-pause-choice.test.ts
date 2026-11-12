import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  type SettingsResponse,
  type SsoRecipeDocument,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../../vault/__fixtures__/policy";
import type { AdmitContext } from "../runtime/admit-context";
import type { SsoMapping } from "../sso-mapping-store";
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
const { beginSso, cancelSso } = await import("../runtime/sso/flow");
const { authorizeSso } = await import("../runtime/sso-effects");
const { pauseFor } = await import("../runtime/pause");
const { createLoginPauses } = await import("../pause");
const { createSsoChoiceController } = await import("../sso-choice");
const { createSsoMappingStore } = await import("../sso-mapping-store");
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
async function harness(pauses: ReturnType<typeof createLoginPauses>) {
  const policy: string = "auto";
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
      pauses,
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
        candidates: vi.fn(async () => ({
          ok: true as const,
          data: {
            sourceEvidence: source.sourceEvidence,
            policyRevision: 3,
            candidates: [{ account: selected.account, snapshotId, origins: [idp] }],
          },
        })),
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
  let mappings: SsoMapping[] = [];
  const store = createSsoMappingStore({
    read: async () => mappings,
    write: async (value) => {
      mappings = value;
    },
    clear: async () => {
      mappings = [];
    },
  });
  rt.ssoChoices = createSsoChoiceController({
    source: rt.options.sso!,
    store,
    readSettings: async () => structuredClone(saved),
    currentDocument: (value) => rt.documents.get("7:0")?.document.documentId === value.documentId,
  });
  const grants = vi.fn(authorizeSso);
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
      const pointer = await grants(
        rt,
        { ...message, type: "login.sso.authorize", phase: "pointer" },
        sender,
      );
      return pointer.ok
        ? grants(rt, { ...message, type: "login.sso.authorize", phase: "click" }, sender)
        : pointer;
    }
    return { ok: true };
  });
  await Promise.all([rt.sso.loaded, rt.confirmFill.loaded]);
  return { rt, ctx, request, update, fields, saved, source, selected, account, ssoRecipe, grants };
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
  for (const rt of cleanup.splice(0)) {
    rt.ssoChoices?.invalidateAll();
    cancelSso(rt, 7, "synthetic-test-finished");
  }
  vi.useRealTimers();
});

describe("a pause requested while an actual SSO method chooser is pending", () => {
  it.each([
    { site: "rp", result: "success", privateWindow: false },
    { site: "idp", result: "success", privateWindow: false },
    { site: "rp", result: "failure", privateWindow: false },
    { site: "idp", result: "failure", privateWindow: false },
    { site: "rp", result: "success", privateWindow: true },
    { site: "idp", result: "failure", privateWindow: true },
  ])(
    "fences $site while the $result pause write is pending (other cookie partition=$privateWindow)",
    async ({ site, result, privateWindow }) => {
      vi.useFakeTimers();
      let stored: unknown = null;
      const writing = Promise.withResolvers<void>();
      const acknowledgement = Promise.withResolvers<void>();
      const setValue = vi.fn(async (value: unknown) => {
        writing.resolve();
        await acknowledgement.promise;
        stored = structuredClone(value);
      });
      const pauses = createLoginPauses({ getValue: async () => stored, setValue });
      const h = await harness(pauses);
      const offered = offerSso(h.rt, h.ctx);
      let shown: Awaited<ReturnType<NonNullable<typeof h.rt.ssoChoices>["get"]>>;
      await vi.waitFor(async () => {
        shown = await h.rt.ssoChoices!.get(7);
        expect(shown).toMatchObject({ ok: true, offer: { methods: [expect.anything()] } });
      });
      const offer = shown!.ok && shown!.offer;
      if (!offer) throw new Error("No actual SSO method offer");
      const candidate = offer.methods[0]!.candidates[0]!;
      expect(
        await h.rt.ssoChoices!.choose({
          tabId: 7,
          offerId: offer.id,
          selection: { kind: "mapping", method: { number: 2 }, candidateId: candidate.id },
        }),
      ).toEqual({ ok: true });
      expect(h.rt.sso.flows.size).toBe(0);
      fake.state.tabUrls[8] = (site === "rp" ? rp : idp) + "/account";
      if (privateWindow) fake.state.incognito.add(8);
      const pausing = pauseFor(h.rt, 8, "10m");
      await writing.promise;
      expect(setValue).toHaveBeenCalledTimes(1);
      expect(stored).toBeNull();
      const choosing = h.rt.ssoChoices!.choose({
        tabId: 7,
        offerId: offer.id,
        selection: { kind: "sso", method: { number: 2 }, candidateId: candidate.id },
      });
      await vi.advanceTimersByTimeAsync(100);
      const effects = () =>
        delivery.mock.calls.filter(([, message]) =>
          ["login.sso.prepare", "login.sso.commit"].includes(String(message["type"])),
        );
      if (privateWindow) {
        expect(await choosing).toEqual({ ok: true });
        expect(await offered).toEqual({ ok: false, reason: "sso-in-progress" });
        expect(effects().map(([, message]) => message["type"])).toEqual([
          "login.sso.prepare",
          "login.sso.commit",
        ]);
        expect(h.grants).toHaveBeenCalledTimes(2);
        expect(h.grants.mock.results.every((call) => call.type === "return")).toBe(true);
      } else {
        expect(effects()).toEqual([]);
        expect(h.grants).not.toHaveBeenCalled();
        expect(h.rt.sso.flows.size).toBe(0);
      }
      if (result === "success") acknowledgement.resolve();
      else acknowledgement.reject(new Error("Synthetic pause write was not acknowledged"));
      expect(await pausing).toMatchObject({ ok: result === "success" });
      await choosing;
      const outcome = await offered;
      if (!privateWindow) {
        expect(outcome).not.toEqual({ ok: false, reason: "sso-in-progress" });
        expect(effects()).toEqual([]);
        expect(h.grants).not.toHaveBeenCalled();
        expect(h.rt.sso.flows.size).toBe(0);
        const freshContext = { ...h.ctx };
        delete freshContext.manual;
        const fresh = () =>
          beginSso(
            h.rt,
            freshContext,
            h.saved,
            { connectionId: "rp-vault", itemId: rpItem, saved: false, source: "match" },
            { kind: "sso", source: h.source, selected: h.selected, label: "Alternative provider" },
          );
        expect(await fresh()).not.toEqual({ ok: false, reason: "sso-in-progress" });
        expect(effects()).toEqual([]);
        expect(h.grants).not.toHaveBeenCalled();
        if (result === "failure") {
          expect(await pauseFor(h.rt, 8, undefined)).toEqual({ ok: true });
          expect(await fresh()).toEqual({ ok: false, reason: "sso-in-progress" });
          expect(effects().map(([, message]) => message["type"])).toEqual([
            "login.sso.prepare",
            "login.sso.commit",
          ]);
          expect(h.grants).toHaveBeenCalledTimes(2);
        }
      }
    },
  );
});
