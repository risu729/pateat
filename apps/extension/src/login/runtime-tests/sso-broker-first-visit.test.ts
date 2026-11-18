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

/** The IBMid item, as discovery finds it: its own URI holds `login.ibm.com`. */
const ibmItem = {
  account: { connectionId, itemId: otherItemId },
  snapshotId: "b0000000-0000-4000-8000-000000000001",
  origins: [ibm],
};
type Discovery =
  | { ok: true; data: { sourceEvidence: string; policyRevision: number; candidates: unknown[] } }
  | { ok: false; reason: string };
const discovered = (candidates: unknown[]): Discovery => ({
  ok: true,
  data: { sourceEvidence: evidence, policyRevision: 1, candidates },
});

/**
 * The HCP item ("HCP / Terraform"): a URL-form `SSO` method mapped to the IBMid item at
 * `login.ibm.com`, on the broker page, where no entry was pressed before. With `saved`
 * false, the settings hold no mapping, as the owner's do.
 */
function setup(
  options: {
    idpName?: string;
    entries?: readonly (typeof buttons)[number][];
    saved?: false;
    discovery?: Discovery;
  } = {},
) {
  const sso = {
    describe: vi.fn(async () => ({
      ok: true as const,
      data: {
        sourceEvidence: evidence,
        policyRevision: 1,
        methods: [{ method: { number: 1 }, form: "url", automatic: true }],
      },
    })),
    candidates: vi.fn(async () => options.discovery ?? discovered([ibmItem])),
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
  if (options.saved !== false)
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
        candidates: [...(options.entries ?? buttons)],
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
  return { h, sso, methods, offer, logInNow, generateSso, send: popupSends };
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
    [
      "a link, which is never pressed, names the IdP too",
      {
        entries: [
          ...buttons,
          {
            id: "c5",
            role: "link",
            target: { by: "href", value: "/ibmid/help" } as unknown as LoginTarget,
            label: "About IBMid",
          },
        ],
      },
    ],
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

  it("Log in now ends at once when the page announces nothing for it", async () => {
    const s = setup({ entries: buttons.slice(1) });
    void s.h.signIn();
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    const answer = await s.offer();
    if (!answer.ok || !answer.targets[0]) throw new Error("No target");
    // The page's own automatic admission still waits for its method offer, and the page
    // answers the request's reconnect without announcing for it: nothing drives the
    // request, so the popup shows why at once, never "Preparing" until it times out.
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
    ).toEqual({ ok: false, reason: "not-started" });
    expect(await s.offer()).toMatchObject({ status: { state: "blocked", reason: "not-started" } });
  });

  it("keeps the pause: a paused page presses nothing by itself", async () => {
    const s = setup();
    s.h.settings.settings.excludedSites = [{ hostname: "login.example", includeSubdomains: true }];
    await s.h.signIn();
    expect(prepared()).toHaveLength(0);
  });
});

// The owner's settings hold no SSO mapping (ADR 0085, amended 2026-11-18): discovery's one
// IdP item, whose own URI holds the method's origin and whose username is the site item's,
// is used for the sign-in by itself, and nothing is saved.
describe("a broker page with no saved mapping (#1687)", () => {
  it("presses the IBMid entry on a fresh tab, with no popup, and saves nothing", async () => {
    const s = setup({ saved: false });
    void s.h.signIn();
    await vi.waitFor(() => pressedIbm());
    expect(await s.methods()).toEqual({ ok: true });
    expect(s.sso.validate).toHaveBeenCalled();
    expect(s.h.settings.settings.ssoMappings ?? []).toEqual([]);
    expect(s.h.store.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      "two IdP items hold the origin",
      discovered([
        ibmItem,
        { ...ibmItem, account: { connectionId, itemId: "80000000-0000-4000-8000-000000000009" } },
      ]),
      "mapping-required",
    ],
    // Discovery leaves out an item whose username is not the site item's.
    ["the IdP item's username is not the site item's", discovered([]), "mapping-required"],
    // Discovery refuses an item that holds the origin only by a Regex rule.
    [
      "the origin is held only by a Regex URI",
      { ok: false as const, reason: "uri-unavailable" },
      "uri-unavailable",
    ],
  ] as const)("asks the person, and presses nothing, when %s", async (_, discovery, reason) => {
    const s = setup({ saved: false, discovery });
    void s.h.signIn();
    await vi.waitFor(async () => expect(await s.methods()).toMatchObject({ offer: { reason } }));
    expect(prepared()).toHaveLength(0);
    expect(s.h.settings.settings.ssoMappings ?? []).toEqual([]);
  });
});

describe("the popup's re-announcement after a worker restart (#1687)", () => {
  const two = discovered([
    ibmItem,
    { ...ibmItem, account: { connectionId, itemId: "80000000-0000-4000-8000-000000000009" } },
  ]);

  it("never presses by itself on a page whose automatic offer the person cancelled", async () => {
    const s = setup({ saved: false, discovery: two });
    void s.h.signIn();
    let shown: Awaited<ReturnType<typeof s.methods>> | undefined;
    await vi.waitFor(async () => {
      shown = await s.methods();
      expect(shown).toMatchObject({ offer: { reason: "mapping-required" } });
    });
    if (!shown?.ok || !shown.offer) throw new Error("No offer");
    expect(await s.send({ type: "login.sso.cancel", tabId: 1, offerId: shown.offer.id })).toEqual({
      ok: true,
    });
    await vi.waitFor(() =>
      expect(fake.state.session["pateat.login-sso-cancels.v1"]).toEqual(["1 synthetic-document"]),
    );
    // The worker restarts; the vault now holds only the IBMid item, and the popup asks
    // the page it forgot to announce again.
    const after = setup({ saved: false });
    fake.state.onReconnect = async () => after.h.signIn();
    await after.offer();
    expect(fake.state.reconnects).not.toHaveLength(0);
    expect(prepared()).toHaveLength(0);
    expect(after.sso.describe).toHaveBeenCalled();
    expect(after.sso.candidates).not.toHaveBeenCalled();
    // The person's own Log in now still offers it, and presses the IBMid entry.
    expect(await after.logInNow()).toMatchObject({ ok: true });
    await vi.waitFor(() => pressedIbm());
  });

  it("presses once when Log in now comes during the re-announced automatic press", async () => {
    const s = setup();
    const generate = s.generateSso.getMockImplementation()!;
    const gate = Promise.withResolvers<void>();
    s.generateSso.mockImplementationOnce(async (request) => {
      await gate.promise;
      return generate(request);
    });
    fake.state.onReconnect = async () => s.h.signIn();
    void s.offer();
    await vi.waitFor(() => expect(s.generateSso).toHaveBeenCalled());
    // The person presses Log in now while the automatic press waits for its layout.
    const answer = await s.offer();
    const started = answer.ok && answer.targets[0] ? await s.logInNow() : answer;
    gate.resolve();
    await vi.waitFor(() => pressedIbm());
    // The request replaced the automatic flow before its press, or found it running.
    expect(JSON.stringify(started)).toMatch(/"state":"started"|login-running/);
    // The replaced flow's own work settles; it presses nothing after its layout arrives.
    // oxlint-disable-next-line no-await-in-loop -- each turn lets one pending step run
    for (let turn = 0; turn < 1000; turn++) await Promise.resolve();
    expect(prepared()).toHaveLength(1);
  });
});
