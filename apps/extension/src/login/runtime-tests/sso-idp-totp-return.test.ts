// An SSO flow through an IdP that asks for its password, shows a risk check with nothing
// to choose, a method chooser its own login's handler answers and a TOTP page, then sends
// the tab back through the RP's own callback to its signed-in page, as in the owner's
// Chrome on 2026-11-20 (14:33–14:37 UTC): the flow signed in by itself, but its parent was
// recorded `cancelled` (`sso-return-unconfirmed`), its IdP login `cancelled`
// (`sso-detached`), and about 40 `sso-scope-changed` refusals came 62 ms apart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttemptMetadata,
  createDefaultSettings,
  transitionLoginAttempt,
  type LoginAttemptEvent,
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
const { cancelSso, ssoAdmit } = await import("../runtime/sso/flow");
const { authorizeSso } = await import("../runtime/sso-effects");
const { allowed } = await import("../runtime/plan-2");
const { reconcileBounded } = await import("../runtime/sign-in");
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
                label: "SSO",
                name: "SSO",
                kind: "text" as const,
              },
            ]
          : [{ id: "login.totp", label: "TOTP", name: null, kind: "hidden" as const }]),
      ],
    },
  ],
});
const target = (value: string) => ({ by: "id" as const, value });
/** The IdP's own recipe: identifier and password, then its method chooser and TOTP page. */
const idpRecipe: LoginRecipe = {
  version: 1,
  id: "native-idp",
  revision: 4,
  origin: idp,
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill",
      effect: "prepare",
      path: "/authsvc",
      fields: [{ slot: "username", target: target("username") }],
    },
    { kind: "click", path: "/authsvc", target: target("next"), purpose: "advance" },
    {
      kind: "fill",
      effect: "prepare",
      path: "/authsvc",
      fields: [{ slot: "password", target: target("password") }],
    },
    { kind: "click", path: "/authsvc", target: target("submit"), purpose: "submit" },
  ],
  handlers: [
    { kind: "authenticator", path: "/mfa", target: target("method-authenticator") },
    { kind: "totp", path: "/mfa", field: target("code"), target: target("verify") },
  ],
  completion: [{ target: target("signed-in") }],
  maxSubmissions: 2,
};
const cleanup: ReturnType<typeof createRuntimeState>[] = [];
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
/** What each IdP page reads as, for `login.sso.idp`, by its document. */
const idpReadings = new Map<string, Record<string, unknown>>();
/** What each RP page shows of the selected identity, for `login.sso.return`, by document. */
const identities = new Map<string, string>();
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
    revision: 2,
    origin: rp,
    sso: {
      path: "/login",
      layouts: [
        {
          key: "1000",
          createdAt: 1000,
          entries: [{ label: "Synthetic IdP", target: target("idp-entry") }],
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
  // The RP's broker page, whose provider entry the flow presses by itself.
  const rpLive: LiveDocument = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "rp-broker" },
    token: "rp-token",
    url: rp + "/login",
    path: "/login",
    incognito: false,
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  rt.documents.set("7:0", rpLive);
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
  delivery.mockImplementation(async (_tabId, message, options) => {
    const documentId = (options as { documentId?: string } | undefined)?.documentId ?? "";
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
    if (message["type"] === "login.sso.idp") return idpReadings.get(documentId);
    if (message["type"] === "login.sso.return")
      return identities.get(documentId) === "unsafe"
        ? { ok: false, reason: "unsafe-return" }
        : { ok: true, identity: identities.get(documentId) ?? "absent" };
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
          username: identities.get(documentId) === "match",
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
  /** The tab's next top document, as admission sees it. */
  const page = (origin: string, documentId: string, path: string, query = "") => {
    const live: LiveDocument = {
      ...rpLive,
      token: documentId + "-token",
      url: origin + path + query,
      path,
      document: { origin, tabId: 7, frameId: 0, documentId },
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
  return { rt, work, page, report, selected, ssoRecipe };
}
/** The IdP's own login, started on its identifier page. */
function idpChild(h: Awaited<ReturnType<typeof harness>>, live: LiveDocument): Execution {
  const metadata: LoginAttemptMetadata = transitionLoginAttempt(
    createAttemptMetadata({
      id: "idp-child",
      recipe: idpRecipe,
      policyRevision: 3,
      account: { ...h.selected.account, origin: idp },
      choice: { route: "password", variant: 0 },
      facts: { password: true, totp: true, passkey: false, discoverablePasskey: false },
      document: live.document,
      timing: { ...live.timing, pageMs: 0 },
    }),
    { type: "RESOLVE" },
  );
  expect(registerSsoChild(h.rt.sso, h.work, metadata)).toBe(true);
  const run: Execution = { metadata, recipe: idpRecipe, live, running: false };
  h.rt.attempts.set(7, run);
  return run;
}
const step = (run: Execution, events: LoginAttemptEvent[]) => {
  for (const event of events) run.metadata = transitionLoginAttempt(run.metadata, event);
};
/** A click of `id`, up to its submission. */
const click = (id: string): LoginAttemptEvent[] => [
  { type: "PREPARE", operationId: id, kind: "click" },
  { type: "SUBMIT_INTENT", operationId: id },
  { type: "SUBMITTED", operationId: id },
];
/** A fill of `id` that only prepares. */
const fill = (id: string): LoginAttemptEvent[] => [
  { type: "PREPARE", operationId: id, kind: "fill" },
  { type: "MUTATION_INTENT", operationId: id },
  { type: "OPERATION_OK", operationId: id },
];

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
  idpReadings.clear();
  identities.clear();
});
afterEach(() => {
  for (const rt of cleanup.splice(0)) cancelSso(rt, 7, "synthetic-test-finished");
});

describe("an SSO sign-in through the IdP's password, risk check, method chooser and TOTP", () => {
  it("records the parent signed in once the RP shows it, and the IdP's login never cancelled", async () => {
    const h = await harness();
    // The IdP's sign-in form: its own login fills the identifier and the password.
    const form = h.page(idp, "idp-form", "/authsvc", "?txn=1");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [
      ...fill("username"),
      ...click("next"),
      { type: "OBSERVED", result: "continue" },
      ...fill("password"),
      ...click("submit"),
    ]);
    expect(run.metadata.state).toBe("awaiting-result");
    /** The tab's next IdP page, admitted with the IdP's own login, whose steps it allows. */
    const next = async (documentId: string, path: string, reading: Record<string, unknown>) => {
      idpReadings.set(documentId, reading);
      const shown = h.page(idp, documentId, path, "?txn=" + documentId);
      expect(await ssoAdmit(h.rt, shown.ctx)).toBeUndefined();
      expect(shown.ctx.refuse).not.toHaveBeenCalled();
      run.live = shown.live;
      step(run, [{ type: "NAVIGATED", document: shown.live.document }]);
      expect(await allowed(h.rt, run)).toBeDefined();
      return shown;
    };
    // A risk check that shows nothing to choose and sends the tab on by itself.
    await next("idp-risk", "/risk/v3.0/authz/pages/compute", { kind: "unknown", controls: false });
    expect(run.metadata).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
    // The method chooser, whose authenticator method the login's own handler presses.
    const chooser = await next("idp-methods", "/mfa", { kind: "unknown", controls: true });
    step(run, [
      { type: "HANDLER", handler: 0, steps: 1, effects: 1, document: chooser.live.document },
      ...click("method"),
    ]);
    // The TOTP page, whose code the login's other handler fills and submits.
    const code = await next("idp-code", "/mfa", { kind: "unknown", controls: true });
    step(run, [
      { type: "HANDLER", handler: 1, steps: 2, effects: 1, document: code.live.document },
      ...fill("code"),
      ...click("verify"),
    ]);
    expect(run.metadata.state).toBe("awaiting-result");
    expect(h.work.ended).toBe(false);
    h.report.mockClear();
    // The RP's own callback, which shows nothing of the sign-in yet: the flow waits.
    const callback = h.page(rp, "rp-callback", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(callback.ctx.refuse).toHaveBeenCalledWith("sso-in-progress", "rp-return");
    expect(h.work.ended).toBe(false);
    expect(h.work.parent?.state).toBe("reconciling");
    // The IdP's login no longer acts, and nothing recorded it as ended yet.
    expect(h.rt.attempts.has(7)).toBe(false);
    expect(h.report).not.toHaveBeenCalledWith(expect.objectContaining({ ssoChild: true }));
    // The RP's signed-in page, which shows the selected identity.
    identities.set("rp-home", "match");
    const home = h.page(rp, "rp-home", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.parent).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(h.report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attempt", route: "sso", state: "authenticated" }),
    );
    // The IdP's login ends once, as the sign-in it led to, released from its IdP hold.
    const childLines = h.report.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line["ssoChild"] === true);
    expect(childLines).toEqual([
      expect.objectContaining({
        state: "authenticated",
        outcome: "authenticated",
        reason: "sso-released",
      }),
    ]);
    expect(h.work.childRecord).toMatchObject({
      state: "authenticated",
      ssoChild: { released: true },
    });
    expect(h.report).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
  });
  it("releases the IdP's login as one that left its origin when the flow ends unsigned", async () => {
    const h = await harness();
    const form = h.page(idp, "idp-form", "/authsvc", "?txn=1");
    idpReadings.set("idp-form", { kind: "native" });
    const run = idpChild(h, form.live);
    expect(await ssoAdmit(h.rt, form.ctx)).toBeUndefined();
    step(run, [
      ...fill("username"),
      ...click("next"),
      { type: "OBSERVED", result: "continue" },
      ...fill("password"),
      ...click("submit"),
    ]);
    const callback = h.page(rp, "rp-callback", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    h.report.mockClear();
    cancelSso(h.rt, 7, "sso-expired");
    await vi.waitFor(() =>
      expect(h.report).toHaveBeenCalledWith(
        expect.objectContaining({
          ssoChild: true,
          state: "blocked",
          outcome: "left-origin",
          reason: "sso-released",
        }),
      ),
    );
    expect(h.report).not.toHaveBeenCalledWith(
      expect.objectContaining({ ssoChild: true, outcome: "cancelled" }),
    );
  });
});

describe("the RP's pages on the way back", () => {
  it("asks the RP-return judge again on the RP's next document", async () => {
    const h = await harness();
    h.work.phase = "at-idp";
    const learned = structuredClone(h.ssoRecipe);
    learned.revision++;
    learned.sso.layouts[0]!.completion = [{ target: target("learned-marker") }];
    // The RP's callback is judged not signed in; its signed-in page is, and the marker the
    // judge names shows there.
    const judgeSso = vi
      .fn()
      .mockResolvedValueOnce({ signedIn: false })
      .mockImplementationOnce(async () => {
        h.rt.recipes.sso = async () => [learned];
        return { signedIn: true, recipe: learned };
      });
    h.rt.generation = {
      available: async () => true as const,
      generate: vi.fn(),
      generateEntry: vi.fn(),
      slotFields: async () => undefined,
      judge: vi.fn(),
      judgeSso,
    };
    const base = delivery.getMockImplementation()!;
    delivery.mockImplementation(async (tabId, message, options) => {
      const documentId = (options as { documentId?: string } | undefined)?.documentId;
      if (message["type"] === "login.extract")
        return {
          ok: true,
          observation: {
            version: 1,
            origin: rp,
            path: new URL(fake.state.tabUrls[7]!).pathname,
            language: "en",
            complete: true,
            candidates: [
              { id: "marker", role: "button", target: target("learned-marker"), label: "Menu" },
            ],
          },
        };
      if (
        message["type"] === "login.observe" &&
        documentId === "rp-home" &&
        (message["targets"] as { value?: string }[]).some(
          (entry) => entry.value === "learned-marker",
        )
      )
        return { path: "/home", targets: ["unique"] };
      return base(tabId, message, options);
    });
    const callback = h.page(rp, "rp-callback", "/callback", "?code=synthetic");
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    // The same document is not judged twice.
    expect(await ssoAdmit(h.rt, callback.ctx)).toEqual({ ok: false, reason: "sso-in-progress" });
    expect(judgeSso).toHaveBeenCalledTimes(1);
    const home = h.page(rp, "rp-home", "/home");
    expect(await ssoAdmit(h.rt, home.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(judgeSso).toHaveBeenCalledTimes(2);
    expect(h.work.parent).toMatchObject({
      state: "authenticated",
      recipeRevision: learned.revision,
    });
  });
  it("ends the flow on an RP page that is never a return, also after an IdP that showed none", async () => {
    const h = await harness();
    // The entry was spent and the tab came straight back to an RP page that asks for a
    // permission or creates an account.
    identities.set("rp-signup", "unsafe");
    const signup = h.page(rp, "rp-signup", "/signup");
    expect(await ssoAdmit(h.rt, signup.ctx)).toEqual({
      ok: false,
      reason: "sso-return-unconfirmed",
    });
    expect(h.work.ended).toBe(true);
    expect(h.work.parent?.state).toBe("blocked");
  });
});

describe("an IdP step whose tab has left its document", () => {
  it("stops reading that document after one refusal and asks it to announce its URL", async () => {
    const h = await harness();
    const code = h.page(idp, "idp-code", "/mfa", "?txn=code");
    idpReadings.set("idp-code", { kind: "native" });
    const run = idpChild(h, code.live);
    expect(await ssoAdmit(h.rt, code.ctx)).toBeUndefined();
    step(run, [...fill("username"), ...click("next")]);
    expect(run.metadata.state).toBe("awaiting-result");
    // The page submitted its code and the tab's URL moved on, before any page announced.
    fake.state.tabUrls[7] = idp + "/mfa?txn=next";
    h.report.mockClear();
    delivery.mockClear();
    const started = Date.now();
    await reconcileBounded(h.rt, run);
    // One round, not one every 50 ms until the result's three seconds ran out.
    expect(Date.now() - started).toBeLessThan(1000);
    const refusals = h.report.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line["reason"] === "sso-scope-changed");
    expect(refusals).toEqual([expect.not.objectContaining({ repeat: true })]);
    expect(refusals[0]).toMatchObject({ type: "refused", detail: "idp-step" });
    // The document is asked once to announce again, for a URL it changed in place; the
    // tab's next page announces by itself. Nothing else is read there.
    await vi.waitFor(() =>
      expect(
        delivery.mock.calls.filter(([, message]) => message["type"] === "login.reconnect"),
      ).toEqual([
        [
          7,
          expect.objectContaining({ type: "login.reconnect" }),
          expect.objectContaining({ documentId: "idp-code" }),
        ],
      ]),
    );
    expect(delivery.mock.calls.some(([, message]) => message["type"] === "login.observe")).toBe(
      false,
    );
    // The login waits for that page, unchanged.
    expect(run.metadata.state).toBe("awaiting-result");
    expect(h.rt.attempts.get(7)).toBe(run);
    expect(h.work.ended).toBe(false);
  });
});
