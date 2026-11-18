// The IdP leg of an SSO flow on pages that are neither the IdP's sign-in form nor a finite
// step (#1687, 2026-11-18): a risk check between the IdP's own pages and its method
// chooser, on the IdP's own origin, after the IdP's own login submitted or before it began.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttemptMetadata,
  createDefaultSettings,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginRecipe,
  type SettingsResponse,
  type SsoRecipeDocument,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../../vault/__fixtures__/policy";
import type { AdmitContext } from "../runtime/admit-context";
import type { ManualStart } from "../runtime/manual-scope";
import type { PickedAccount } from "../runtime/session-schemas";
import type { Execution, LiveDocument } from "../runtime/types";
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
const { cancelSso, ssoAdmit, ssoChildChanged } = await import("../runtime/sso/flow");
const { authorizeSso } = await import("../runtime/sso-effects");
const { allowed } = await import("../runtime/plan-2");
const { change } = await import("../runtime/attempt");
const { registerSsoChild } = await import("../runtime/sso-state");
const { admit } = await import("../runtime/admit");
const { keep } = await import("../runtime/session-store");
const { reportLeavesLog } = await import("../runtime/report");
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
                label: "SSO",
                name: "SSO",
                kind: "text" as const,
              },
            ]
          : []),
      ],
    },
  ],
});
/** The IdP's own recipe: its identifier and password steps share one path. */
const idpRecipe: LoginRecipe = {
  version: 1,
  id: "native-idp",
  revision: 1,
  origin: idp,
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill",
      effect: "prepare",
      path: "/authsvc",
      fields: [{ slot: "username", target: { by: "id", value: "username" } }],
    },
    { kind: "click", path: "/authsvc", target: { by: "id", value: "next" }, purpose: "advance" },
    {
      kind: "fill",
      effect: "prepare",
      path: "/authsvc",
      fields: [{ slot: "password", target: { by: "id", value: "password" } }],
    },
    { kind: "click", path: "/authsvc", target: { by: "id", value: "submit" }, purpose: "submit" },
  ],
  completion: [{ target: { by: "id", value: "signed-in" } }],
  maxSubmissions: 2,
};
const cleanup: ReturnType<typeof createRuntimeState>[] = [];
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
/** What the IdP page reads as, for `login.sso.idp`. */
let reading: Record<string, unknown> = { kind: "unknown" };
async function harness() {
  const catalog = {
    connections: [connection("rp-vault", rpItem, rp), connection("idp-vault", idpItem, idp)],
  };
  const settings = createDefaultSettings(catalog);
  for (const value of catalog.connections) setAccountPolicy(settings, value);
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings },
    catalog,
  };
  const account = { origin: rp, connectionId: "rp-vault", itemId: rpItem };
  const selected = { account: { connectionId: "idp-vault", itemId: idpItem }, origin: idp };
  const source = { account, method: { number: 1 }, sourceEvidence: "E".repeat(43) };
  const ssoRecipe: SsoRecipeDocument = {
    version: 1,
    id: "synthetic-sso",
    revision: 1,
    origin: rp,
    sso: {
      path: "/login",
      layouts: [
        {
          key: "1000",
          createdAt: 1000,
          entries: [{ label: "Synthetic IdP", target: { by: "id", value: "idp-entry" } }],
        },
      ],
    },
  };
  const report = vi.fn();
  const rt = createRuntimeState(
    { handle: vi.fn(async () => structuredClone(saved)), update: vi.fn() },
    {
      fields: vi.fn(async () => "Synthetic value"),
      report,
      sites: createLoginSites({ read: async () => structuredClone(saved.snapshot) }),
      recipes: {
        recipe: async (origin: string) => (origin === idp ? idpRecipe : undefined),
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
                method: { number: 1 },
                form: "bracket" as const,
                automatic: true,
                label: "Synthetic IdP",
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
  // The broker page, whose entry the flow presses by itself.
  const rpLive: LiveDocument = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" },
    token: "rp-token",
    url: rp + "/login",
    path: "/login",
    incognito: false,
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  rt.documents.set("7:0", rpLive);
  // The person's Log in now picked the RP's item, as the flow's account.
  const pick: PickedAccount = {
    tabId: 7,
    origin: rp,
    documentId: rpLive.document.documentId,
    connectionId: "rp-vault",
    itemId: rpItem,
    makeDefault: false,
    waitedMs: 0,
    manual: true,
    manualRequestId: "manual-request",
  };
  const request: ManualStart = {
    document: rpLive.document,
    url: rpLive.url,
    path: rpLive.path,
    topUrl: rpLive.url,
    topDocumentId: rpLive.document.documentId,
    expiresAt: Date.now() + 300_000,
    status: { requestId: "manual-request", state: "evaluating" },
    pick,
  };
  rt.picked.set(7, pick);
  rt.manualStarts.set(7, request);
  const rpCtx = {
    document: rpLive.document,
    live: rpLive,
    key: "7:0",
    incognito: false,
    paused: false,
    signIn: { path: rpLive.path },
    manual: { request, pick },
    refuse: vi.fn(async (reason: string) => ({ ok: false as const, reason })),
  } as unknown as AdmitContext;
  rt.ssoChoices!.request = vi.fn(async () => ({
    offerId: "offer",
    result: Promise.resolve({ ok: true as const, choiceId: "opaque-choice" }),
  }));
  rt.ssoChoices!.consume = vi.fn(async () => ({
    ok: true as const,
    document: rpLive.document,
    account,
    selection: { kind: "sso" as const, source, selected, label: "Synthetic IdP" },
  }));
  fake.state.tabUrls[7] = rpLive.url;
  delivery.mockImplementation(async (_tabId, message) => {
    if (message["type"] === "login.sso.inspect" || message["type"] === "login.sso.prepare")
      return {
        ok: true,
        url: rpLive.url,
        destinations: [idp + "/authsvc"],
        ...(message["type"] === "login.sso.prepare" ? { handle: "prepared-entry" } : {}),
      };
    if (message["type"] === "login.sso.commit") {
      const sender = {
        id: fake.browser.runtime.id,
        tab: { id: 7, incognito: false },
        frameId: 0,
        documentId: rpLive.document.documentId,
        origin: rp,
        url: rpLive.url,
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
    if (message["type"] === "login.sso.idp") return reading;
    // The RP's page after the IdP shows the selected identity and no sign-in.
    if (message["type"] === "login.sso.return") return { ok: true, identity: "match" };
    if (message["type"] === "login.state")
      return {
        ok: true,
        loaded: true,
        signs: {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
          username: true,
        },
      };
    if (message["type"] === "login.observe")
      return {
        path: new URL(fake.state.tabUrls[7] ?? rpLive.url).pathname,
        targets: (message["targets"] as unknown[]).map(() => "missing"),
      };
    return { ok: true };
  });
  await Promise.all([rt.sso.loaded, rt.confirmFill.loaded]);
  expect(await offerSso(rt, rpCtx)).toEqual({ ok: false, reason: "sso-in-progress" });
  const work = rt.sso.flows.get(7)!;
  expect(work.operation?.stage).toBe("spent");
  /** The tab's next IdP document, at `path`, announced as admission sees it. */
  const idpPage = (documentId: string, path: string) => {
    const live: LiveDocument = {
      ...rpLive,
      token: documentId + "-token",
      url: idp + path + "?txn=synthetic",
      path,
      document: { origin: idp, tabId: 7, frameId: 0, documentId },
    };
    rt.documents.set("7:0", live);
    fake.state.tabUrls[7] = live.url;
    const ctx = {
      ...rpCtx,
      document: live.document,
      live,
      signIn: undefined,
      manual: undefined,
      refuse: vi.fn(async (reason: string) => ({ ok: false as const, reason })),
    } as unknown as AdmitContext;
    return { live, ctx };
  };
  /** The tab's next RP document, after the IdP. */
  const rpPage = (documentId: string, path: string) => {
    const live: LiveDocument = {
      ...rpLive,
      token: documentId + "-token",
      url: rp + path,
      path,
      document: { ...rpLive.document, documentId },
    };
    rt.documents.set("7:0", live);
    fake.state.tabUrls[7] = live.url;
    const ctx = {
      ...rpCtx,
      document: live.document,
      live,
      signIn: undefined,
      manual: undefined,
      refuse: vi.fn(async (reason: string) => ({ ok: false as const, reason })),
    } as unknown as AdmitContext;
    return { live, ctx };
  };
  return { rt, work, idpPage, rpPage, report, selected };
}
/** The IdP's own login, started on its identifier page and driven to `events`. */
function idpChild(
  h: Awaited<ReturnType<typeof harness>>,
  live: LiveDocument,
  events: Parameters<typeof transitionLoginAttempt>[1][],
): Execution {
  let metadata: LoginAttemptMetadata = createAttemptMetadata({
    id: "idp-child",
    recipe: idpRecipe,
    policyRevision: 3,
    account: { ...h.selected.account, origin: idp },
    choice: { route: "password", variant: 0 },
    facts: { password: true, totp: true, passkey: false, discoverablePasskey: false },
    document: live.document,
    timing: { ...live.timing, pageMs: 0 },
  });
  for (const event of [{ type: "RESOLVE" } as const, ...events])
    metadata = transitionLoginAttempt(metadata, event);
  expect(registerSsoChild(h.rt.sso, h.work, metadata)).toBe(true);
  const run: Execution = { metadata, recipe: idpRecipe, live, running: false };
  h.rt.attempts.set(7, run);
  return run;
}
/** The four steps of the IdP's own login, up to its submission. */
const submitted = [
  { type: "PREPARE", operationId: "username", kind: "fill" },
  { type: "MUTATION_INTENT", operationId: "username" },
  { type: "OPERATION_OK", operationId: "username" },
  { type: "PREPARE", operationId: "next", kind: "click" },
  { type: "SUBMIT_INTENT", operationId: "next" },
  { type: "SUBMITTED", operationId: "next" },
  { type: "OBSERVED", result: "continue" },
  { type: "PREPARE", operationId: "password", kind: "fill" },
  { type: "MUTATION_INTENT", operationId: "password" },
  { type: "OPERATION_OK", operationId: "password" },
  { type: "PREPARE", operationId: "submit", kind: "click" },
  { type: "SUBMIT_INTENT", operationId: "submit" },
  { type: "SUBMITTED", operationId: "submit" },
] as Parameters<typeof transitionLoginAttempt>[1][];

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
  reading = { kind: "unknown" };
});
afterEach(() => {
  for (const rt of cleanup.splice(0)) cancelSso(rt, 7, "synthetic-test-finished");
});

describe("an IdP page that is neither its sign-in form nor a finite step", () => {
  it("waits as a sign-in in progress before the IdP's own login began, through a risk check and a method chooser", async () => {
    const h = await harness();
    // The IdP's first page shows no identifier input, then a risk check, then its method
    // chooser, all on its own origin: none ends the flow.
    for (const [documentId, path] of [
      ["idp-first", "/authsvc"],
      ["idp-risk", "/risk/v3.0/authz/pages/compute"],
      ["idp-methods", "/authsvc"],
    ] as const) {
      const page = h.idpPage(documentId, path);
      // oxlint-disable-next-line no-await-in-loop -- the tab's pages come one after another
      expect(await ssoAdmit(h.rt, page.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
      expect(page.ctx.refuse).toHaveBeenCalledWith("sso-in-progress");
      expect(h.rt.sso.flows.get(7)).toBe(h.work);
      expect(h.work.ended).toBe(false);
      expect(h.work.phase).toBe("at-idp");
    }
    // Nothing was pressed or filled on the IdP's pages.
    expect(
      delivery.mock.calls.filter(([, message]) =>
        ["login.sso.prepare", "login.fill", "login.click"].includes(String(message["type"])),
      ),
    ).toHaveLength(1);
  });
  it("admits the risk check and the method chooser with the IdP's own login that submitted", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, submitted);
    expect(run.metadata.state).toBe("awaiting-result");
    for (const [documentId, path] of [
      ["idp-risk", "/risk/v3.0/authz/pages/compute"],
      ["idp-methods", "/authsvc"],
    ] as const) {
      const page = h.idpPage(documentId, path);
      // The page goes on to the tab's ordinary admission, which resumes the IdP's own login
      // there, as a direct login of the IdP goes on to its handlers after its submit.
      // oxlint-disable-next-line no-await-in-loop -- the tab's pages come one after another
      expect(await ssoAdmit(h.rt, page.ctx)).toBeUndefined();
      expect(page.ctx.refuse).not.toHaveBeenCalled();
      expect(h.rt.sso.flows.get(7)).toBe(h.work);
      expect(h.work.ended).toBe(false);
      expect(h.rt.attempts.get(7)).toBe(run);
      run.live = page.live;
      run.metadata = transitionLoginAttempt(run.metadata, {
        type: "NAVIGATED",
        document: page.live.document,
      });
      // oxlint-disable-next-line no-await-in-loop -- each page is checked in turn
      expect(await allowed(h.rt, run)).toBeDefined();
    }
  });
  it("still stops on an IdP page that reads as unsafe", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    idpChild(h, first.live, submitted);
    reading = { kind: "unsafe", reason: "permission-or-account-creation" };
    const page = h.idpPage("idp-consent", "/consent");
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual({ ok: false, reason: "sso-idp-stop" });
    expect(h.work.ended).toBe(true);
  });
  it("stops once the IdP's own login ended blocked", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, submitted);
    run.metadata = transitionLoginAttempt(run.metadata, { type: "CANCEL" });
    expect(run.metadata.state).toBe("blocked");
    const page = h.idpPage("idp-risk", "/risk/v3.0/authz/pages/compute");
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual({ ok: false, reason: "sso-idp-stop" });
    expect(h.work.ended).toBe(true);
  });
});

describe("the IdP's own login while it is watched", () => {
  it("keeps the flow when its result settled as unknown, and ends it once the login is blocked", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, submitted);
    run.metadata = transitionLoginAttempt(run.metadata, {
      type: "OBSERVED",
      result: "unknown",
      document: first.live.document,
    });
    expect(run.metadata.settled).toBe(true);
    ssoChildChanged(h.rt, run);
    expect(h.rt.sso.flows.get(7)).toBe(h.work);
    expect(h.work.ended).toBe(false);
    run.metadata = transitionLoginAttempt(run.metadata, { type: "CANCEL" });
    expect(run.metadata.state).toBe("blocked");
    ssoChildChanged(h.rt, run);
    expect(h.work.ended).toBe(true);
  });
});

describe("the IdP's own login is never silent", () => {
  it("logs each change of its state on the device, marked as the hop's own login", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, []);
    h.report.mockClear();
    await change(h.rt, run, { type: "PREPARE", operationId: "username", kind: "fill" });
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attempt",
        origin: idp,
        recipeId: "native-idp",
        state: "executing",
        ssoChild: true,
      }),
    );
  });
  it("logs why a step of it was not authorized when the flow's scope no longer holds", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, []);
    // The tab's URL moved on without the document announcing it yet.
    fake.state.tabUrls[7] = idp + "/authsvc?txn=later";
    h.report.mockClear();
    expect(await allowed(h.rt, run)).toBeUndefined();
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "refused", reason: "sso-scope-changed", detail: "idp-step" }),
    );
  });
});

describe("the tab's own admission of the IdP's pages", () => {
  it("resumes the submitted child on the risk check and the method chooser, never ending the flow", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, submitted);
    await keep(h.rt, run.metadata);
    for (const [documentId, path] of [
      ["idp-risk", "/risk/v3.0/authz/pages/compute"],
      ["idp-methods", "/authsvc"],
    ] as const) {
      const url = idp + path + "?txn=synthetic";
      fake.state.tabUrls[7] = url;
      const sender = {
        id: fake.browser.runtime.id,
        tab: { id: 7, incognito: false, url },
        frameId: 0,
        documentId,
        origin: idp,
        url,
      };
      h.rt.hellos.set("hello-" + documentId, 1);
      // oxlint-disable-next-line no-await-in-loop -- the tab's pages come one after another
      await admit(h.rt, sender as never, documentId + "-token", "hello-" + documentId, 1);
      // No refusal outside the SSO allow-list ended the flow (`sso-idp-admission-stopped`),
      // and the IdP's own login took the page over.
      expect(h.work.ended).toBe(false);
      expect(h.rt.sso.flows.get(7)).toBe(h.work);
      expect(h.report).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: "sso-idp-admission-stopped" }),
      );
      const resumed = h.rt.attempts.get(7);
      expect(resumed?.metadata.id).toBe("idp-child");
      expect(resumed?.live.document.documentId).toBe(documentId);
    }
  });
});

describe("an IdP page that is no step after the IdP's own login", () => {
  it("waits once that login signed in, pressing nothing", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, submitted);
    run.metadata = transitionLoginAttempt(run.metadata, {
      type: "OBSERVED",
      result: "authenticated",
      document: first.live.document,
    });
    expect(run.metadata.state).toBe("authenticated");
    ssoChildChanged(h.rt, run);
    const before = delivery.mock.calls.length;
    const page = h.idpPage("idp-landing", "/landing");
    expect(await ssoAdmit(h.rt, page.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(h.work.ended).toBe(false);
    expect(
      delivery.mock.calls
        .slice(before)
        .filter(([, message]) => String(message["type"]).startsWith("login.sso.prepare")),
    ).toEqual([]);
  });
  it("logs the end of a child the flow detaches before a finite step", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    idpChild(h, first.live, submitted);
    reading = { kind: "continue", target: { by: "id", value: "continue" } };
    h.report.mockClear();
    const page = h.idpPage("idp-confirm", "/confirm");
    await ssoAdmit(h.rt, page.ctx);
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attempt",
        state: "blocked",
        outcome: "cancelled",
        reason: "sso-detached",
        ssoChild: true,
      }),
    );
  });
});

describe("the flow's bounds and its RP return", () => {
  it("ends a flow that waited on an IdP page with no step at its ten minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const h = await harness();
      const page = h.idpPage("idp-first", "/authsvc");
      expect(await ssoAdmit(h.rt, page.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
      h.report.mockClear();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.work.ended).toBe(true);
      expect(h.rt.sso.flows.has(7)).toBe(false);
      await vi.waitFor(() =>
        expect(h.report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "attempt", state: "blocked", reason: "sso-expired" }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("completes on the RP's own evidence after a watched child", async () => {
    const h = await harness();
    const first = h.idpPage("idp-first", "/authsvc");
    const run = idpChild(h, first.live, submitted);
    run.metadata = transitionLoginAttempt(run.metadata, {
      type: "OBSERVED",
      result: "unknown",
      document: first.live.document,
    });
    ssoChildChanged(h.rt, run);
    expect(h.work.ended).toBe(false);
    h.work.phase = "at-idp";
    h.report.mockClear();
    const back = h.rpPage("rp-back", "/home");
    expect(await ssoAdmit(h.rt, back.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.parent?.state).toBe("authenticated");
    // The detached child's end and its release are logged, marked as the hop's.
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "sso-detached", ssoChild: true }),
    );
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "sso-released", ssoChild: true, repeat: true }),
    );
  });
});

describe("where a login report goes", () => {
  it("keeps the IdP's own login lines in the local log only", () => {
    const attempt = {
      type: "attempt",
      tabId: 7,
      origin: idp,
      recipeId: "native-idp",
      recipeRevision: 1,
      route: "password",
      state: "blocked",
      stepIndex: 0,
      stepCount: 4,
    } as const;
    expect(reportLeavesLog(attempt)).toBe(true);
    expect(reportLeavesLog({ ...attempt, ssoChild: true })).toBe(false);
    expect(
      reportLeavesLog({ type: "refused", tabId: 7, origin: idp, reason: "sso-in-progress" }),
    ).toBe(true);
  });
});
