import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginTarget, SsoRecipeDocument } from "@pateat/contracts";
import { manualOfferResponseSchema } from "../manual-wire";
import { ssoResponseSchema } from "../sso-wire";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { learnSsoEntry } = await import("../runtime/sso/learned-entries");
const { origin, connectionId, itemId, otherItemId, userId, uriMatch, harness } =
  createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const evidence = "E".repeat(43);
/** The IBMid item's sign-in origin, which the site item's URL-form `SSO` field names. */
const ibm = "https://login.ibm.com";
// The four buttons of `flow.idp.hashicorp.com/login` (#1687): each submits the page's own
// form to the page's own origin, and the site sends the tab on to the IdP.
const button = (value: string): LoginTarget => ({ by: "id", value });
const buttons = [
  { id: "c1", role: "button", target: button("sign-in-ibmid"), label: "Sign in with IBMid" },
  { id: "c2", role: "button", target: button("sign-in-github"), label: "Sign in with GitHub" },
  { id: "c3", role: "button", target: button("sign-in-sso"), label: "Sign in with SSO" },
  { id: "c4", role: "button", target: button("submit-button"), label: "Continue" },
];
const original = fake.browser.tabs.sendMessage;
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
const prepared = () =>
  delivery.mock.calls.filter(
    ([, message]) => (message as { type?: string }).type === "login.sso.prepare",
  );
/** Where each button goes, by its id: the page's own form, unless a test says. */
let destinations: Record<string, string> = {};

/**
 * The HCP item ("HCP / Terraform"): a URL-form `SSO` method mapped to the IBMid item at
 * `login.ibm.com`, on the broker page, where no entry was pressed before.
 */
function setup(options: { idpName?: string; entries?: typeof buttons } = {}) {
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
            origins: [ibm],
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
  // No recipe has an SSO layout of this page yet: the first press generates one for the
  // pressed entry's label, as the service does.
  let heads: SsoRecipeDocument[] = [];
  const generateSso = vi.fn(async (request: { labels: string[] }) => {
    const label = request.labels[0]!;
    const recipe: SsoRecipeDocument = {
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
            entries: [{ label, target: buttons.find((entry) => entry.label === label)!.target }],
          },
        ],
      },
    };
    heads = [recipe];
    return { outcome: "recipe" as const, recipe };
  });
  const h = harness(
    {},
    {
      uris,
      custom: [{ name: "SSO", kind: "text" }],
      username: true,
      otherUsername: true,
      otherLabel: options.idpName ?? "IBMid",
      sso: sso as never,
      generation: { generateSso } as never,
    },
  );
  const account = { provider: "bitwarden", server: "cloud-us", userId };
  h.settings.settings.ssoMappings = [
    { ...account, itemId, method: 1, idp: { ...account, itemId: otherItemId, origin: ibm } },
  ];
  const recipes = h.recipes as typeof h.recipes & Record<string, unknown>;
  recipes["sso"] = vi.fn(async () => heads);
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
        candidates: options.entries ?? buttons,
      },
    },
  };
  const popupSends = async (message: Record<string, unknown>) =>
    h.login.handle({ version: 1, ...message }, popup);
  const methods = async () =>
    v.parse(ssoResponseSchema, await popupSends({ type: "login.sso.get", tabId: 1 }));
  const offer = async () =>
    v.parse(manualOfferResponseSchema, await popupSends({ type: "login.manual.get", tabId: 1 }));
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
  return { h, methods, offer, logInNow, generateSso };
}
/** The flow pressed exactly the IBMid button, once per press. */
const pressedIbm = (times = 1) => {
  expect(prepared()).toHaveLength(times);
  for (const [, message] of prepared())
    expect(message).toMatchObject({ target: button("sign-in-ibmid") });
};

beforeEach(() => {
  vi.setTimerTickMode("manual");
  destinations = {};
  delivery.mockClear();
  delivery.mockImplementation(async (tabId, message, frame) => {
    const { type, target } = message as { type?: string; target?: LoginTarget };
    // The press itself is not under test: the flow stops at its preparation.
    if (type === "login.sso.prepare") return { ok: false, reason: "synthetic-stop" };
    if (type === "login.sso.inspect")
      return {
        ok: true,
        url: fake.state.pageUrl,
        destinations: [
          destinations[(target as { value?: string } | undefined)?.value ?? ""] ??
            origin + "/login/lookup/",
        ],
      };
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
  fake.state.tabUrls = {};
  fake.state.observed = ["unique", "missing"];
  fake.state.observedPath = "/signin";
  fake.state.gone = new Set();
  fake.state.goneFrames = new Set();
  fake.state.loaded = true;
  fake.state.incognito = new Set();
  fake.state.openTabs = undefined;
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
  fake.state.replaced.length = 0;
  fake.state.updated.length = 0;
});

describe("a broker page's first visit starts SSO by itself (#1687)", () => {
  it("presses the entry its label names for the IdP item, with no popup", async () => {
    const s = setup();
    void s.h.signIn();
    await vi.waitFor(() => pressedIbm());
    expect(await s.methods()).toEqual({ ok: true });
  });

  it("presses it by the origin's label too, when the IdP item has another name", async () => {
    const s = setup({ idpName: "Work login" });
    void s.h.signIn();
    await vi.waitFor(() => pressedIbm());
  });

  it("presses it again from Log in now, after the automatic press stopped", async () => {
    const s = setup();
    void s.h.signIn();
    await vi.waitFor(() => pressedIbm());
    // The synthetic press stopped; the person asks once more.
    await vi.waitFor(async () => expect((await s.offer()).ok).toBe(true));
    expect(await s.logInNow()).toMatchObject({ ok: true });
    await vi.waitFor(() => pressedIbm(2));
    expect(await s.methods()).toEqual({ ok: true });
  });

  it("presses it once the popup opens on a worker that forgot the page", async () => {
    // A restarted worker knows no document of the tab, and asks only the tabs of sites
    // with a saved default to announce again: the popup's offer asks this one.
    const s = setup();
    fake.state.onReconnect = async () => s.h.signIn();
    await s.offer();
    await vi.waitFor(() => pressedIbm());
  });

  it.each([
    ["no entry names the IdP", { entries: buttons.slice(1) }],
    ["the IdP item is called SSO and the origin names nothing on the page", { idpName: "SSO" }],
  ] as const)("shows the choice, and presses nothing, when %s", async (_, options) => {
    const s = setup(options);
    if ("idpName" in options) {
      const account = { provider: "bitwarden", server: "cloud-us", userId };
      s.h.settings.settings.ssoMappings = [
        {
          ...account,
          itemId,
          method: 1,
          idp: { ...account, itemId: otherItemId, origin: "https://idp.example" },
        },
      ];
    }
    void s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    expect(prepared()).toHaveLength(0);
  });

  it("never presses the named entry when it goes to another origin", async () => {
    const s = setup();
    destinations["sign-in-ibmid"] = "https://other-provider.example/authorize";
    void s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    expect(prepared()).toHaveLength(0);
  });

  it("never presses the named entry once a flow learned it for another IdP", async () => {
    const s = setup();
    await learnSsoEntry(origin, "/signin", button("sign-in-ibmid"), "https://github.com");
    void s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    expect(prepared()).toHaveLength(0);
  });

  it("Log in now answers at once, rather than waiting for the page's own earlier admission", async () => {
    const s = setup({ entries: buttons.slice(1) });
    void s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    const answer = await s.offer();
    if (!answer.ok || !answer.targets[0]) throw new Error("No target");
    // The page's own automatic admission still waits for its method offer.
    fake.state.onReconnect = async () => ({ ok: false });
    expect(
      await s.h.login.handle(
        {
          version: 1,
          type: "login.manual.start",
          requestId: "manual-request",
          document: answer.targets[0].document,
          scope: answer.targets[0].scope,
          connectionId,
          itemId,
        },
        popup,
      ),
    ).toEqual({ ok: true, state: "evaluating" });
    // The popup shows the request as still preparing, with its cancel, and the person's
    // cancel ends it.
    expect(
      await s.h.login.handle(
        { version: 1, type: "login.manual.cancel", tabId: 1, requestId: "manual-request" },
        popup,
      ),
    ).toEqual({ ok: true });
    expect(await s.offer()).toMatchObject({ status: { state: "blocked", reason: "cancelled" } });
  });

  it("keeps the pause: a paused page presses nothing by itself", async () => {
    const s = setup();
    s.h.settings.settings.excludedSites = [{ hostname: "login.example", includeSubdomains: true }];
    await s.h.signIn();
    expect(prepared()).toHaveLength(0);
  });
});
