import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LoginStep,
  type LoginTarget,
  type SsoRecipeDocument,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  otherItemId,
  userId,
  uriMatch,
  target,
  liveDefault,
  harness,
} = createRuntimeTestHarness(fake);
// The site's own sign-in is on `origin`; its identifier step sends the tab to a broker page
// on another site, whose provider entry signs in at the mapped IdP (#1847).
const broker = "https://broker.example";
const idp = "https://idp.example";
const evidence = "E".repeat(43);
const idpEntry: LoginTarget = { by: "id", value: "sign-in-example-id" };
const buttons = [
  { id: "c1", role: "button", target: idpEntry, label: "Sign in with Example ID" },
  { id: "c2", role: "button", target: { by: "id" as const, value: "continue" }, label: "Continue" },
];
const original = fake.browser.tabs.sendMessage;
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
const prepared = () =>
  delivery.mock.calls.filter(
    ([, message]) => (message as { type?: string }).type === "login.sso.prepare",
  );
const status = () =>
  fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
async function until(check: () => boolean, maxMs = 60_000) {
  for (let spent = 0; !check(); spent += 100) {
    if (spent > maxMs) throw new Error("Condition not reached in fake time");
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  }
}

/** The site's identifier-first sign-in, whose clicks send the tab away. */
const emailFirst = parseLoginRecipe({
  version: 1,
  id: "synthetic-email-first",
  revision: 1,
  origin,
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
    { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    { kind: "fill", path: "/password", fields: [{ slot: "password", target: target("password") }] },
    { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
  ],
  maxSubmissions: 2,
});
/** A one-page password sign-in, whose submit sends the tab away. */
const onePage = parseLoginRecipe({
  version: 1,
  id: "synthetic-one-page",
  revision: 1,
  origin,
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill",
      path: "/signin",
      fields: [
        { slot: "username", target: target("email") },
        { slot: "password", target: target("password") },
      ],
    },
    { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
  ],
  maxSubmissions: 1,
});

/**
 * The site item holds a password and a URL-form `SSO` method mapped to the IdP item at
 * `idp`. The vault describes the method only for the broker page: on the site's own page
 * the item signs in with its password.
 */
function setup(recipe = emailFirst) {
  const sso = {
    describe: vi.fn(async (account: { origin: string }) => ({
      ok: true as const,
      data: {
        sourceEvidence: evidence,
        policyRevision: 1,
        methods:
          account.origin === broker
            ? [{ method: { number: 1 }, form: "url" as const, automatic: true }]
            : [],
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
  const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
    ok: true,
    data: uriMatch({ targetOrigin: new URL(url).origin }),
  }));
  let heads: SsoRecipeDocument[] = [];
  const generateSso = vi.fn(async (request: { labels: string[] }) => {
    const label = request.labels[0]!;
    const layout: SsoRecipeDocument = {
      version: 1,
      id: "synthetic-sso",
      revision: 1,
      origin: broker,
      sso: {
        path: "/login",
        layouts: [
          {
            key: "1000",
            createdAt: 1000,
            entries: [{ label, target: buttons.find((button) => button.label === label)!.target }],
          },
        ],
      },
    };
    heads = [layout];
    return { outcome: "recipe" as const, recipe: layout };
  });
  const report = vi.fn<(entry: LoginReport) => void>();
  const h = harness(
    { siteDefaults: [liveDefault(), liveDefault({ origin: broker })] },
    {
      uris,
      report,
      allowedOrigins: [origin, broker],
      custom: [{ name: "SSO", kind: "text" }],
      username: true,
      otherUsername: true,
      otherLabel: "Example ID",
      sso: sso as never,
      // No page is sent for a recipe: the device is not paired.
      generation: { generateSso, available: async () => "not-connected" } as never,
    },
  );
  const account = { provider: "bitwarden", server: "cloud-us", userId };
  h.settings.settings.ssoMappings = [
    { ...account, itemId, method: 1, idp: { ...account, itemId: otherItemId, origin: idp } },
  ];
  h.recipes.recipe.mockImplementation(async (at: string) => (at === origin ? recipe : undefined));
  const recipes = h.recipes as typeof h.recipes & Record<string, unknown>;
  recipes["sso"] = vi.fn(async () => heads);
  recipes["ssoFence"] = vi.fn(async () => () => true);
  return { h, sso, generateSso, report };
}

/** Runs the site's login to its first click, which never answers: the tab moved on. */
async function moved(recipe = emailFirst) {
  const s = setup(recipe);
  fake.state.onExecute = (message) => {
    const step = (message["operation"] as { step: LoginStep }).step;
    return step.kind === "click" ? new Promise(() => undefined) : Promise.resolve();
  };
  expect(await s.h.hello()).toEqual({ ok: true });
  await until(() => executed().length === 2);
  expect(status()![0]).toMatchObject({ state: "submit-intent" });
  // The tab's page is now the broker's, which shows its provider entries and no sign-in form.
  fake.state.signs = { password: false, code: false, captcha: false, invalid: false, alert: false };
  fake.state.extracted = {
    login: {
      ok: true,
      observation: {
        version: 1,
        origin: broker,
        path: "/login",
        language: "en",
        complete: true,
        candidates: buttons,
      },
    },
  };
  delivery.mockClear();
  return s;
}
/** The runtime's reports of moves that did not complete the login (ADR 0022). */
const moves = (s: ReturnType<typeof setup>) =>
  s.report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "move");
/** The broker page's top document announces itself, as its sign-in entries show. */
async function visit(s: ReturnType<typeof setup>, url: string, documentId: string, start = true) {
  fake.state.tabUrls[1] = url;
  let result: unknown;
  void s.h.hello({ documentId, url }, start).then((value) => (result = value));
  await until(() => result !== undefined);
  return result;
}

beforeEach(() => {
  delivery.mockClear();
  delivery.mockImplementation(async (tabId, message, frame) => {
    const { type } = message as { type?: string };
    // The press itself is not under test: the flow stops at its preparation.
    if (type === "login.sso.prepare") return { ok: false, reason: "synthetic-stop" };
    if (type === "login.sso.inspect")
      return { ok: true, url: fake.state.tabUrls[1], destinations: [broker + "/login/lookup"] };
    return original(tabId, message, frame);
  });
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.badges = {};
  fake.state.messages = [];
  fake.state.granted = true;
  fake.state.pageUrl = origin + "/signin";
  fake.state.tabUrls = {};
  fake.state.incognito = new Set();
  fake.state.observedPath = "/signin";
  fake.state.present = new Set(["email", "next", "password", "login"]);
  fake.state.unusable = new Set();
  fake.state.unobservable = new Set();
  fake.state.awaited = { ok: true };
  fake.state.executeReply = undefined;
  fake.state.gone = new Set();
  fake.state.extracted = {};
  fake.state.signs = undefined;
  fake.state.onExecute = undefined;
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) listener(1);
});

describe("a broker page a site's login sent the tab to (#1847)", () => {
  it("ends the login it left, then presses its IdP entry in the same announcement", async () => {
    const s = await moved();
    const answer = await visit(s, broker + "/login", "broker-document");
    // The identifier's Next was a possible submission: the login ended on the broker page.
    expect(status()![0]).toMatchObject({ state: "blocked", outcome: "left-origin" });
    expect(moves(s)).toEqual([expect.objectContaining({ origin: broker, reason: "no-factor" })]);
    // The same announcement went on to the broker's own offer, which pressed its entry: its
    // answer is the synthetic press's stop.
    expect(answer).toEqual({ ok: false, reason: "sso-entry-prepare" });
    expect(prepared()).toHaveLength(1);
    expect(prepared()[0]![1]).toMatchObject({ target: idpEntry });
    expect(s.sso.describe).toHaveBeenCalledWith(expect.objectContaining({ origin: broker }));
  });

  it("leaves the login to the top page when only a frame of the broker announces", async () => {
    const s = await moved();
    fake.state.tabUrls[1] = broker + "/login";
    const framed = await s.h.hello({
      frameId: 3,
      documentId: "broker-frame",
      url: broker + "/widget",
      tab: { id: 1, url: broker + "/login" },
    });
    // The frame neither ends the login nor offers SSO: the login still holds the tab, and
    // only its top page decides the move.
    expect(framed).toEqual({ ok: false, reason: "tab-busy" });
    expect(moves(s)).toEqual([]);
    expect(status()![0]).toMatchObject({ state: "submit-intent" });
    expect(prepared()).toHaveLength(0);
    await visit(s, broker + "/login", "broker-document");
    expect(status()![0]).toMatchObject({ state: "blocked", outcome: "left-origin" });
    expect(prepared()).toHaveLength(1);
  });

  it("completes a login whose password the move followed, and offers no SSO", async () => {
    const s = await moved(onePage);
    // Nothing on the quiet page asks for a sign-in.
    fake.state.extracted = {};
    await visit(s, broker + "/home", "home-document", false);
    await until(() => status()![0]!["state"] === "authenticated");
    expect(status()![0]).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(s.sso.describe).not.toHaveBeenCalledWith(expect.objectContaining({ origin: broker }));
    expect(prepared()).toHaveLength(0);
  });

  it("keeps the login on a page of another origin that asks for a passkey, pressing nothing", async () => {
    const s = await moved();
    s.h.login.passkeyRequested(1, broker);
    expect(await visit(s, broker + "/login", "broker-document")).toEqual({
      ok: false,
      reason: "stale-document",
    });
    expect(status()![0]).toMatchObject({ state: "submit-intent" });
    expect(moves(s)).toEqual([
      expect.objectContaining({ origin: broker, reason: "passkey-request", kept: true }),
    ]);
    expect(prepared()).toHaveLength(0);
  });
});
