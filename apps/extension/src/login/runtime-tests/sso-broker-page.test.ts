import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoRecipeDocument } from "@pateat/contracts";
import { manualOfferResponseSchema } from "../manual-wire";
import { ssoResponseSchema, type SsoSelection } from "../sso-wire";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, otherItemId, userId, uriMatch, harness } =
  createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
/** How long a method offer waits for the person (`OFFER_MS` in sso-choice.ts). */
const OFFER_MS = 600_000;
const idp = "https://idp.example";
const evidence = "E".repeat(43);
const provider = { by: "id" as const, value: "provider-entry" };
const plain = { by: "id" as const, value: "continue" };
const original = fake.browser.tabs.sendMessage;
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
const prepared = () =>
  delivery.mock.calls.filter(
    ([, message]) => (message as { type?: string }).type === "login.sso.prepare",
  );
/** The SSO flow presses the provider entry: it prepares exactly that target. */
const pressed = () => {
  expect(prepared()).toHaveLength(1);
  expect(prepared()[0]![1]).toMatchObject({ target: provider });
};

/**
 * A broker page, as `flow.idp.hashicorp.com/login` of #1687: the site item's URL-form
 * `SSO` method signs in at `idp`, and the page's provider button submits a form to the
 * page's own origin, which sends the tab on. No entry names the mapped origin itself.
 */
function setup(options: { mapped?: boolean; learned?: boolean } = {}) {
  const sso = {
    describe: vi.fn(async () => ({
      ok: true as const,
      data: {
        sourceEvidence: evidence,
        policyRevision: 1,
        methods: [{ method: { number: 1 }, form: "url", automatic: true }],
      },
    })),
    candidates: vi.fn(async () => ({
      ok: true as const,
      data: {
        sourceEvidence: evidence,
        policyRevision: 1,
        candidates: [
          {
            account: { connectionId, itemId: otherItemId },
            snapshotId: "b0000000-0000-4000-8000-000000000001",
            origins: [idp],
          },
        ],
      },
    })),
    validate: vi.fn(async () => ({
      ok: true as const,
      data: { sourceEvidence: evidence, policyRevision: 1, candidates: [] },
    })),
  };
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
  const h = harness(
    {},
    {
      uris,
      custom: [{ name: "SSO", kind: "text" }],
      username: true,
      otherUsername: true,
      sso: sso as never,
    },
  );
  const account = { provider: "bitwarden", server: "cloud-us", userId };
  if (options.mapped !== false)
    h.settings.settings.ssoMappings = [
      { ...account, itemId, method: 1, idp: { ...account, itemId: otherItemId, origin: idp } },
    ];
  const layout: SsoRecipeDocument = {
    version: 1,
    id: "synthetic-sso",
    revision: 1,
    origin,
    sso: {
      path: "/signin",
      layouts: [
        {
          key: "1000",
          createdAt: 1000,
          entries: [{ label: "Continue with the provider", target: provider }],
        },
      ],
    },
  };
  const recipes = h.recipes as typeof h.recipes & Record<string, unknown>;
  let learned = options.learned !== false;
  recipes["sso"] = vi.fn(async () => (learned ? [layout] : []));
  /** The page's SSO layout arrives, as generation stores it after a first explicit choice. */
  const learn = () => {
    learned = true;
  };
  recipes["ssoFence"] = vi.fn(async () => () => true);
  fake.state.extracted = {
    login: {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/signin",
        language: "en",
        complete: true,
        candidates: [
          { id: "c1", role: "button", target: provider, label: "Continue with the provider" },
          { id: "c2", role: "button", target: plain, label: "Continue" },
        ],
      },
    },
  };
  const popupSends = async (message: Record<string, unknown>) =>
    h.login.handle({ version: 1, ...message }, popup);
  const methods = async () =>
    v.parse(ssoResponseSchema, await popupSends({ type: "login.sso.get", tabId: 1 }));
  const shown = async () => {
    const answer = await methods();
    if (!answer.ok || !answer.offer) throw new Error("No method offer");
    return answer.offer;
  };
  const choose = async (selection: SsoSelection) =>
    popupSends({ type: "login.sso.choose", tabId: 1, offerId: (await shown()).id, selection });
  const offer = async () =>
    v.parse(manualOfferResponseSchema, await popupSends({ type: "login.manual.get", tabId: 1 }));
  /** The person presses **Log in now**; the page announces itself again. */
  async function logInNow() {
    fake.state.onReconnect = async () => h.signIn();
    const answer = await offer();
    if (!answer.ok || !answer.targets[0]) throw new Error("No target: " + JSON.stringify(answer));
    return popupSends({
      type: "login.manual.start",
      requestId: "manual-request",
      document: answer.targets[0].document,
      scope: answer.targets[0].scope,
      connectionId,
      itemId,
    });
  }
  return { h, sso, methods, shown, choose, offer, logInNow, learn };
}

/** Where the provider button's form goes: the broker page's own origin, unless a test says. */
let destination = "";
beforeEach(() => {
  vi.setTimerTickMode("manual");
  destination = origin + "/self-service/login";
  delivery.mockClear();
  // The provider button posts the page's own form; the site redirects to the IdP.
  delivery.mockImplementation(async (tabId, message, frame) => {
    const type = (message as { type?: string }).type;
    // The press itself is not under test: the flow stops at its preparation.
    if (type === "login.sso.prepare") return { ok: false, reason: "synthetic-stop" };
    if (type === "login.sso.inspect")
      return { ok: true, url: fake.state.pageUrl, destinations: [destination] };
    return original(tabId, message, frame);
  });
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.badges = {};
  fake.state.reconnects = [];
  fake.state.onReconnect = undefined;
  fake.state.messages = [];
  fake.state.granted = true;
  fake.state.pageUrl = origin + "/signin";
  fake.state.onExecute = undefined;
  fake.state.tabUrls = {};
  fake.state.observed = ["unique", "missing"];
  fake.state.observedPath = "/signin";
  fake.state.present = undefined;
  fake.state.unusable = new Set();
  fake.state.awaited = { ok: true };
  fake.state.onAwait = undefined;
  fake.state.executeReply = undefined;
  fake.state.gone = new Set();
  fake.state.goneFrames = new Set();
  fake.state.onPresent = undefined;
  fake.state.signs = undefined;
  fake.state.loaded = true;
  fake.state.incognito = new Set();
  fake.state.openTabs = undefined;
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
  fake.state.replaced.length = 0;
  fake.state.updated.length = 0;
});

describe("a fresh tab on a broker page (#1687)", () => {
  it("presses the provider entry the page's layout learned, with the saved mapping", async () => {
    const s = setup();
    void s.h.signIn();
    await vi.waitFor(pressed);
    // The automatic decision opened no offer for the person to answer.
    expect(await s.methods()).toEqual({ ok: true });
  });

  it.each([
    ["no layout learned the entry", { learned: false }, "entry-required"],
    ["no mapping is saved", { mapped: false }, "mapping-required"],
  ] as const)("shows the choice when %s, and presses nothing", async (_, options, reason) => {
    const s = setup(options);
    void s.h.signIn();
    await vi.waitFor(async () => expect(await s.methods()).toMatchObject({ offer: { reason } }));
    expect(prepared()).toHaveLength(0);
  });

  it("never presses a learned entry whose own destination is another origin", async () => {
    const s = setup();
    destination = "https://other-provider.example/authorize";
    void s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    expect(prepared()).toHaveLength(0);
  });

  it.each(["paused", "private"] as const)(
    "keeps the guards: a %s page presses nothing by itself",
    async (guard) => {
      const s = setup();
      if (guard === "paused")
        s.h.settings.settings.excludedSites = [
          { hostname: "login.example", includeSubdomains: true },
        ];
      else fake.state.incognito = new Set([1]);
      const answer = await s.h.signIn();
      expect(prepared()).toHaveLength(0);
      // A paused site never reaches the method choice; a private window stops at the
      // flow's own scope check, before any press (ADR 0026).
      if (guard === "paused") expect(s.sso.describe).not.toHaveBeenCalled();
      else expect(answer).toEqual({ ok: false, reason: "sso-scope-changed" });
    },
  );

  it("Log in now on a waiting offer says it waits for the choice, and the chosen entry is pressed", async () => {
    const s = setup({ learned: false });
    const first = s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    // The page's own offer is replaced by the person's request, which never waits unseen.
    expect(await s.logInNow()).toEqual({ ok: true, state: "choosing" });
    expect(await first).toEqual({ ok: false, reason: "replaced" });
    const shown = await s.shown();
    const entry = shown.entries.find((item) => item.label === "Continue with the provider");
    const candidateId = shown.methods[0]!.selectedId!;
    expect(entry && candidateId).toBeTruthy();
    // The person's explicit request never presses a learned entry by itself.
    s.learn();
    expect(prepared()).toHaveLength(0);
    expect(
      await s.choose({ kind: "sso", method: { number: 1 }, candidateId, entryId: entry!.id }),
    ).toEqual({ ok: true });
    await vi.waitFor(pressed);
  });

  it("Log in now after the page's offer expired opens the choice again", async () => {
    const s = setup({ learned: false });
    const first = s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    await vi.advanceTimersByTimeAsync(OFFER_MS);
    expect(await first).toEqual({ ok: false, reason: "expired" });
    expect(await s.logInNow()).toEqual({ ok: true, state: "choosing" });
    expect(await s.shown()).toMatchObject({ methods: [{ method: { number: 1 } }] });
  });
});
