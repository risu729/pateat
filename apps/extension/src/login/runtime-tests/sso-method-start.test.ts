import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  createAttemptMetadata,
  type LoginRecipe,
  type SettingsResponse,
  type SsoGenerationRequest,
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
const { beginSso, cancelSso, ssoAdmit } = await import("../runtime/sso/flow");
const { authorizeSso, ssoPress } = await import("../runtime/sso-effects");
const { ssoScope } = await import("../runtime/sso-scope");
const { pauseFor } = await import("../runtime/pause");
const { allowed } = await import("../runtime/plan-2");
const { registerSsoChild } = await import("../runtime/sso-state");
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

async function generationStart(form: "url" | "bracket", label: string) {
  const h = await harness("auto");
  h.rt.manualStarts.clear();
  h.rt.picked.clear();
  h.rt.options.sso!.describe = vi.fn(async () => ({
    ok: true as const,
    data: {
      sourceEvidence: h.source.sourceEvidence,
      policyRevision: 3,
      methods: [{ method: { number: 2 }, form, automatic: false, label }],
    },
  }));
  const rpUsername = "rp-private-username";
  const idpUsername = "idp-private-username";
  h.fields.mockImplementation(async ({ account }) =>
    account.origin === rp ? rpUsername : idpUsername,
  );
  let heads: SsoRecipeDocument[] = [];
  h.rt.recipes.sso = vi.fn(async () => heads);
  const generate = vi.fn(async (request: SsoGenerationRequest) => {
    const recipe = structuredClone(h.ssoRecipe);
    recipe.sso.layouts[0]!.entries = [
      { label: request.labels[0]!, target: { by: "id", value: "selected-entry" } },
    ];
    heads = [recipe];
    return { outcome: "recipe" as const, recipe };
  });
  h.rt.generation = { generateSso: generate } as never;
  const baseDelivery = delivery.getMockImplementation()!;
  delivery.mockImplementation(async (tab, message, options) =>
    message["type"] === "login.extract"
      ? {
          ok: true,
          observation: {
            version: 1,
            origin: rp,
            path: "/signin",
            language: "en",
            complete: true,
            candidates: [
              {
                id: "chosen",
                role: "button",
                label,
                target: { by: "id", value: "selected-entry" },
              },
              {
                id: "other",
                role: "button",
                label: "Continue as " + rpUsername,
                target: { by: "id", value: "other-entry" },
              },
            ],
          },
        }
      : baseDelivery(tab, message, options),
  );
  const start = () =>
    beginSso(
      h.rt,
      h.ctx,
      h.saved,
      { connectionId: "rp-vault", itemId: rpItem, saved: false, source: "match" },
      { kind: "sso", source: h.source, selected: h.selected, label },
      { label, target: { by: "id", value: "selected-entry" } },
    );
  return {
    ...h,
    start,
    generate,
    rpUsername,
    idpUsername,
    setHeads: (next: SsoRecipeDocument[]) => {
      heads = next;
    },
  };
}
describe("actual SSO generation keeps local account labels private", () => {
  it("redacts a URL-form observed selected label together with its page before any outgoing generation request", async () => {
    const h = await generationStart("url", "Continue as idp-private-username");
    expect(await h.start()).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(h.generate).toHaveBeenCalledTimes(1);
    const payload = h.generate.mock.calls[0]![0];
    expect(JSON.stringify(payload)).not.toContain(h.rpUsername);
    expect(JSON.stringify(payload)).not.toContain(h.idpUsername);
    expect(payload.labels).toEqual([
      payload.observation.candidates.find((entry) => entry.id === "chosen")!.label,
    ]);
    const prepares = delivery.mock.calls.filter(
      ([, message]) => message["type"] === "login.sso.prepare",
    );
    expect(prepares.map(([, message]) => message["target"])).toEqual([
      { by: "id", value: "selected-entry" },
    ]);
    expect(JSON.stringify(io.setItem.mock.calls)).not.toContain(h.idpUsername);
  });
  it.each(["cached", "repaired"])(
    "keeps the explicit URL-form target when a %s redacted label also names another account control",
    async (phase) => {
      const h = await generationStart("url", "Continue as idp-private-username");
      const cached = structuredClone(h.ssoRecipe);
      cached.sso.layouts[0]!.entries = [
        { label: "Continue as [account]", target: { by: "id", value: "other-entry" } },
      ];
      if (phase === "cached") h.setHeads([cached]);
      else
        h.generate.mockImplementation(async () => {
          h.setHeads([cached]);
          return { outcome: "recipe", recipe: cached };
        });
      const result = await h.start();
      const prepared = delivery.mock.calls.filter(
        ([, message]) => message["type"] === "login.sso.prepare",
      );
      expect(
        prepared.some(
          ([, message]) => (message["target"] as { value?: string }).value === "other-entry",
        ),
      ).toBe(false);
      if (phase === "cached") {
        expect(result.reason).toBe("sso-in-progress");
        expect(prepared.map(([, message]) => message["target"])).toEqual([
          { by: "id", value: "selected-entry" },
        ]);
      } else {
        expect(result.reason).not.toBe("sso-in-progress");
        expect(prepared).toEqual([]);
      }
    },
  );
  it("retains the explicit bracket provider label as its authorized field value", async () => {
    const h = await generationStart("bracket", "Alternative provider");
    expect(await h.start()).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(h.generate.mock.calls[0]![0].labels).toEqual(["Alternative provider"]);
  });
  it.each(["source", "target"])(
    "refuses a stale %s before preparing a generated selected entry",
    async (changed) => {
      const h = await generationStart("url", "Continue as idp-private-username");
      const generate = h.generate.getMockImplementation()!;
      h.generate.mockImplementation(async (request) => {
        const result = await generate(request);
        if (changed === "source") h.rt.options.bindingSnapshotCurrent = () => false;
        else {
          const delivered = delivery.getMockImplementation()!;
          delivery.mockImplementation(async (tab, message, options) =>
            message["type"] === "login.sso.inspect"
              ? { ok: false, reason: "target-changed" }
              : delivered(tab, message, options),
          );
        }
        return result;
      });
      expect(await h.start()).not.toEqual({ ok: false, reason: "sso-in-progress" });
      expect(
        delivery.mock.calls.filter(([, message]) => message["type"] === "login.sso.commit"),
      ).toEqual([]);
    },
  );
});
describe("actual cached SSO layout repair", () => {
  it.each([true, false])(
    "chooses a current repaired target rather than the retained stale layout (current=%s)",
    async (current) => {
      const h = await generationStart("bracket", "Alternative provider");
      const old = structuredClone(h.ssoRecipe);
      old.sso.layouts[0]!.entries[0]!.target = { by: "id", value: "stale-entry" };
      h.setHeads([old]);
      h.generate.mockImplementation(async () => {
        const repaired = { ...structuredClone(old), revision: 2 };
        repaired.sso.layouts.push({
          ...structuredClone(old.sso.layouts[0]!),
          key: "2000",
          createdAt: 2000,
          entries: [
            { label: "Alternative provider", target: { by: "id", value: "current-entry" } },
          ],
        });
        h.setHeads([repaired]);
        return { outcome: "recipe", recipe: repaired };
      });
      const baseDelivery = delivery.getMockImplementation()!;
      delivery.mockImplementation(async (tab, message, options) => {
        if (message["type"] === "login.sso.inspect") {
          const target = message["target"] as { value?: string };
          if (target.value !== "current-entry" || !current)
            return { ok: false, reason: "target-changed" };
        }
        return baseDelivery(tab, message, options);
      });
      const result = await h.start();
      const prepares = delivery.mock.calls.filter(
        ([, message]) => message["type"] === "login.sso.prepare",
      );
      expect(h.generate).toHaveBeenCalledTimes(1);
      if (current) {
        expect(result).toEqual({ ok: false, reason: "sso-in-progress" });
        expect(h.rt.sso.flows.get(7)?.layout).toBe("2000");
        expect(prepares.map(([, message]) => message["target"])).toEqual([
          { by: "id", value: "current-entry" },
        ]);
      } else {
        expect(result).not.toEqual({ ok: false, reason: "sso-in-progress" });
        expect(prepares).toEqual([]);
      }
      expect(
        prepares.some(
          ([, message]) => (message["target"] as { value?: string }).value === "stale-entry",
        ),
      ).toBe(false);
    },
  );
});
describe("actual pause persistence fences an IdP operation before pause UI finishes", () => {
  it.each([
    "rp-scope",
    "rp-press",
    "rp-pointer",
    "rp-click",
    "rp-native",
    "idp-scope",
    "opposite-private",
  ])("enforces %s while tab-query acknowledgement is pending", async (operation) => {
    const h = await harness("auto");
    expect(await offerSso(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    const work = h.rt.sso.flows.get(7)!;
    const live: LiveDocument = {
      ...h.ctx.live,
      token: "idp-token",
      url: idp + "/signin",
      document: { origin: idp, tabId: 7, frameId: 0, documentId: "idp-document" },
    };
    h.rt.documents.set("7:0", live);
    h.rt.incognitoTabs.set(7, false);
    work.live = live;
    work.phase = "at-idp";
    fake.state.tabUrls[7] = live.url;
    let nativeRun: Parameters<typeof allowed>[1] | undefined;
    if (operation === "rp-native") {
      const recipe: LoginRecipe = {
        version: 1,
        id: "native-child",
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
          {
            kind: "click",
            path: "/signin",
            target: { by: "id", value: "submit" },
            purpose: "submit",
          },
        ],
        completion: [{ target: { by: "id", value: "signed-in" } }],
        maxSubmissions: 1,
      };
      const metadata = createAttemptMetadata({
        id: "exact-child",
        recipe,
        policyRevision: 3,
        account: { ...h.selected.account, origin: idp },
        choice: { route: "password", variant: 0 },
        facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
        document: live.document,
        timing: { ...live.timing, pageMs: 0 },
      });
      expect(registerSsoChild(h.rt.sso, work, metadata)).toBe(true);
      const run = { metadata, live, recipe, running: false } as never;
      h.rt.attempts.set(7, run);
      expect(await allowed(h.rt, run)).toBeDefined();
      nativeRun = run;
    }
    const pausedOrigin = operation === "idp-scope" ? idp : rp;
    fake.state.tabUrls[8] = pausedOrigin + "/settings";
    if (operation === "opposite-private") fake.state.incognito.add(8);
    let entered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.spyOn(fake.browser.tabs, "query").mockImplementation(async () => {
      entered();
      await blocked;
      return [];
    });
    const baseDelivery = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tab, message, options) =>
      message["type"] === "login.sso.prepare"
        ? { ok: true, url: live.url, destinations: [], handle: "fresh-idp-handle" }
        : baseDelivery(tab, message, options),
    );
    const pausing = pauseFor(h.rt, 8, "10m");
    try {
      await pending;
      expect(
        await h.rt.pauses.until([pausedOrigin], operation === "opposite-private"),
      ).toBeGreaterThan(Date.now());
      const commitCount = delivery.mock.calls.filter(
        ([, message]) => message["type"] === "login.sso.commit",
      ).length;
      if (operation.endsWith("scope") || operation === "opposite-private") {
        expect(await ssoScope(h.rt, work, live)).toBe(operation === "opposite-private");
      } else if (operation === "rp-press") {
        expect(
          await ssoPress(h.rt, work, live, { by: "id", value: "continue-entry" }, "continue", {
            username: "Synthetic value",
            kind: "continue",
          }),
        ).toBe(false);
      } else if (operation === "rp-native") {
        expect(nativeRun).toBeDefined();
        expect(await allowed(h.rt, nativeRun!)).toBeUndefined();
      } else {
        const phase = operation === "rp-pointer" ? "pointer" : "click";
        work.operation = {
          id: "held-idp-operation",
          handle: "held-idp-handle",
          live,
          destinations: [],
          stage: phase === "pointer" ? "intent" : "pointer",
        };
        expect(
          await authorizeSso(
            h.rt,
            {
              version: 1,
              type: "login.sso.authorize",
              token: live.token,
              flowId: work.id,
              operationId: work.operation.id,
              handle: work.operation.handle,
              phase,
            },
            {
              id: fake.browser.runtime.id,
              tab: { id: 7, incognito: false },
              frameId: 0,
              documentId: live.document.documentId,
              origin: idp,
              url: live.url,
            } as never,
          ),
        ).toEqual({ ok: false });
      }
      expect(
        delivery.mock.calls.filter(([, message]) => message["type"] === "login.sso.commit"),
      ).toHaveLength(commitCount);
    } finally {
      release();
      await pausing;
      query.mockRestore();
    }
  });
});

it("reads an already persisted RP pause on an active IdP without relying on parent cancellation", async () => {
  const h = await harness("auto");
  expect(await offerSso(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
  const work = h.rt.sso.flows.get(7)!;
  const live: LiveDocument = {
    ...h.ctx.live,
    url: idp + "/signin",
    token: "idp-token",
    document: { origin: idp, tabId: 7, frameId: 0, documentId: "idp-current" },
  };
  work.live = live;
  work.phase = "at-idp";
  h.rt.documents.set("7:0", live);
  fake.state.tabUrls[7] = live.url;
  expect(await ssoScope(h.rt, work, live)).toBe(true);
  await h.rt.pauses.pause(rp, false, "10m");
  expect(work.ended).toBe(false);
  expect(h.rt.sso.flows.get(7)).toBe(work);
  expect(await ssoScope(h.rt, work, live)).toBe(false);
});
describe("same-document native IdP handoff", () => {
  it.each([true, false, undefined])(
    "withdraws old native authority and requires a narrow cancellation acknowledgement before Continue (%s)",
    async (acknowledged) => {
      const h = await harness("auto");
      expect(await offerSso(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
      const work = h.rt.sso.flows.get(7)!;
      const live: LiveDocument = {
        ...h.ctx.live,
        token: "idp-token",
        url: idp + "/signin",
        document: { origin: idp, tabId: 7, frameId: 0, documentId: "idp-spa" },
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
          {
            kind: "click",
            path: "/signin",
            target: { by: "id", value: "submit" },
            purpose: "submit",
          },
        ],
        completion: [{ target: { by: "id", value: "signed-in" } }],
        maxSubmissions: 1,
      };
      const metadata = createAttemptMetadata({
        id: "old-native",
        recipe,
        policyRevision: 3,
        account: { ...h.selected.account, origin: idp },
        choice: { route: "password", variant: 0 },
        facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
        document: live.document,
        timing: { ...live.timing, pageMs: 0 },
      });
      expect(registerSsoChild(h.rt.sso, work, metadata)).toBe(true);
      const run = { metadata, recipe, live, running: false } as never;
      h.rt.attempts.set(7, run);
      expect(await allowed(h.rt, run)).toBeDefined();
      const sender = {
        id: fake.browser.runtime.id,
        tab: { id: 7, incognito: false },
        frameId: 0,
        documentId: live.document.documentId,
        origin: idp,
        url: live.url,
      } as never;
      let cancelled = false;
      const prepare = vi.fn();
      const commit = vi.fn();
      delivery.mockImplementation(async (_tab, message) => {
        if (message["type"] === "login.cancel") cancelled = true;
        if (message["type"] === "login.native.cancel") {
          expect(message["attemptId"]).toBe("old-native");
          expect(await allowed(h.rt, run)).toBeUndefined();
          return acknowledged === undefined ? undefined : { ok: acknowledged };
        }
        if (message["type"] === "login.sso.idp")
          return { kind: "continue", target: { by: "id", value: "continue-after-native" } };
        if (message["type"] === "login.sso.prepare") {
          expect(cancelled).toBe(false);
          expect(await allowed(h.rt, run)).toBeUndefined();
          prepare(message);
          return { ok: true, url: live.url, destinations: [], handle: "same-document-continue" };
        }
        if (message["type"] === "login.sso.commit") {
          expect(cancelled).toBe(false);
          expect(
            await authorizeSso(
              h.rt,
              { ...message, type: "login.sso.authorize", phase: "pointer" },
              sender,
            ),
          ).toEqual({ ok: true });
          const clicked = await authorizeSso(
            h.rt,
            { ...message, type: "login.sso.authorize", phase: "click" },
            sender,
          );
          commit(clicked);
          return clicked;
        }
        return { ok: true };
      });
      const ctx = {
        ...h.ctx,
        live,
        document: live.document,
        signIn: { path: live.path },
      } as AdmitContext;
      const result = await ssoAdmit(h.rt, ctx);
      if (acknowledged !== true) {
        expect(result).toEqual({ ok: false, reason: "sso-native-detach-failed" });
        expect(prepare).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(h.rt.attempts.has(7)).toBe(false);
        expect(await allowed(h.rt, run)).toBeUndefined();
        expect(work.ended).toBe(true);
        return;
      }
      expect(result).toEqual({ ok: false, reason: "sso-in-progress" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({ idp: { username: "Synthetic value", kind: "continue" } }),
      );
      expect(commit).toHaveBeenCalledWith({ ok: true });
      expect(h.rt.attempts.has(7)).toBe(false);
      expect(await allowed(h.rt, run)).toBeUndefined();
      expect(work.ended).toBe(false);
      expect(cancelled).toBe(false);
    },
  );
});
