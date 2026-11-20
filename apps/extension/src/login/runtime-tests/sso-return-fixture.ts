// The SSO RP-return fixture: an SSO flow whose entry was pressed on the RP's broker page,
// with the IdP's own login and the RP pages the tab comes back to.
import { afterEach, beforeEach, expect, vi } from "vitest";
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
import { createRuntimeState } from "../runtime/state";
import { offerSso } from "../runtime/sso/entry";
import { cancelSso } from "../runtime/sso/flow";
import { authorizeSso } from "../runtime/sso-effects";
import { registerSsoChild } from "../runtime/sso-state";
import { createLoginSites } from "../sites";
import { createLoginBadge, memoryBadgeStorage } from "../badge";
import type { createBrowserFake } from "./browser-fake";
const rp = "https://rp.example.test";
const idp = "https://idp.other.test";
/** Another origin of the RP's site, which the RP item matches, as a broker's portal. */
const portal = "https://portal.example.test";
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
      allowedOrigins: origin === rp ? [rp, portal] : [origin],
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
/** The session storage the fixture's test mocks `wxt/utils/storage` with. */
type Io = Record<"getItem" | "setItem" | "getItems" | "setItems", ReturnType<typeof vi.fn>>;
export function ssoReturnFixture(fake: ReturnType<typeof createBrowserFake>, io: Io) {
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
  return {
    rp,
    idp,
    portal,
    target,
    idpRecipe,
    delivery,
    idpReadings,
    identities,
    harness,
    idpChild,
    step,
    click,
    fill,
  };
}
