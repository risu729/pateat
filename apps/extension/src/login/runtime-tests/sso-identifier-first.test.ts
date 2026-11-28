import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LoginAttemptMetadata,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
  type SsoRecipeDocument,
} from "@pateat/contracts";
import { createRecipeRepairs } from "../repair";
import { ssoResponseSchema } from "../sso-wire";
import { manualOfferResponseSchema } from "../manual-wire";
import type { LoginGeneration } from "../runtime/deps";
import type { GenerationOutcome, LoginReport } from "../runtime/report";
import type { LiveUriMatcher } from "../../vault/site-candidates";
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
  startsOf,
  target,
  sender,
  harness,
} = createRuntimeTestHarness(fake);

// An SSO item's sign-in on a site that asks first for the account's email on its own
// page, before any entry for the IdP shows (owner, 2026-11-28 07:42 UTC, ADR 0085
// amendment of that day, #1847): the site's identifier page (`origin`) sends the tab to a
// broker page of another site, whose provider entry leads on to the IdP.
const broker = "https://broker.example";
const idp = "https://idp.example";
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const evidence = "E".repeat(43);
const page = (at: string, path: string, candidates: unknown[]) => ({
  ok: true,
  observation: { version: 1, origin: at, path, language: "en", complete: true, candidates },
});
const email = { id: "c1", role: "email", target: target("email"), label: "Email" };
const next = { id: "c2", role: "button", target: target("next"), label: "Continue" };
const identifierPage = (extra: unknown[] = []) => page(origin, "/signin", [email, next, ...extra]);
const acme: LoginTarget = { by: "id", value: "sign-in-acme" };
const brokerPage = page(broker, "/login", [
  { ...email, id: "b1" },
  { id: "b2", role: "button", target: acme, label: "Sign in with Acme" },
  { id: "b3", role: "button", target: target("submit"), label: "Continue" },
]);
const identifierFirst = parseLoginRecipe({
  version: 1,
  id: "gen-identifier",
  revision: 3,
  origin,
  pageKind: "sign-in",
  slots: ["username"],
  steps: [
    { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
    { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
  ],
  maxSubmissions: 1,
});
const original = fake.browser.tabs.sendMessage;
const delivery = vi.spyOn(fake.browser.tabs, "sendMessage");
const prepared = () =>
  delivery.mock.calls.filter(
    ([, message]) => (message as { type?: string }).type === "login.sso.prepare",
  );
/** Where an entry goes, by its id: the page's own origin unless a test says. */
let destinations: Record<string, string> = {};
const executed = () =>
  fake.state.messages
    .filter((entry) => entry.type === "login.execute")
    .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
const records = () =>
  (fake.state.storage["pateat.login-attempts.v5"] as LoginAttemptMetadata[] | undefined) ?? [];
async function until(check: () => boolean, maxMs = 30_000) {
  for (let spent = 0; !check(); spent += 100) {
    if (spent > maxMs) throw new Error("Condition not reached in fake time");
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  }
}

/**
 * The site item ("Acme work account"): an empty password, the IdP account's username as its
 * Username and a URL-form `SSO` field, mapped to the IdP item ("Acme") at `idp`.
 */
function setup(
  options: {
    mapped?: false;
    username?: "empty";
    recipe?: LoginRecipe | null;
    custom?: { name: string; kind: "text" }[];
    overrides?: Parameters<typeof harness>[0];
    generate?: (request: unknown) => Promise<GenerationOutcome>;
  } = {},
) {
  const idpItem = {
    account: { connectionId, itemId: otherItemId },
    snapshotId: "b0000000-0000-4000-8000-000000000001",
    origins: [idp],
  };
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
        candidates:
          options.mapped === false
            ? [idpItem, { ...idpItem, account: { connectionId, itemId: "other-idp" } }]
            : [idpItem],
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
  const generation = {
    available: vi.fn<LoginGeneration["available"]>(async () => true),
    generate: vi.fn<LoginGeneration["generate"]>(async (request, sent) => {
      sent?.();
      return (await options.generate?.(request)) ?? { outcome: "abstained", reason: "ambiguous" };
    }),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    // The broker page has no SSO layout yet: the press generates one for its entry.
    generateSso: vi.fn(async (request: { labels: string[] }) => {
      const recipe: SsoRecipeDocument = {
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
              entries: [{ label: request.labels[0]!, target: acme }],
            },
          ],
        },
      };
      heads = [recipe];
      return { outcome: "recipe" as const, recipe };
    }),
  };
  const report = vi.fn<(entry: LoginReport) => void>();
  const repairs = createRecipeRepairs({
    read: async () => fake.state.storage["repairs"],
    write: async (value) => {
      fake.state.storage["repairs"] = value;
    },
  });
  const h = harness(options.overrides ?? {}, {
    allowedOrigins: [origin, broker],
    uris,
    custom: options.custom ?? [{ name: "SSO", kind: "text" }],
    username: true,
    otherUsername: true,
    otherLabel: "Acme",
    sso: sso as never,
    generation: generation as never,
    repairs,
    report,
  });
  // The site item holds no password, and with `username` none for its Username either.
  const handle = h.store.handle.getMockImplementation()!;
  h.store.handle.mockImplementation(async () => {
    const response = await handle();
    if (response.ok)
      for (const field of response.catalog.connections[0]!.items[0]!.fields)
        if (
          field.id === "login.password" ||
          (field.id === "login.username" && options.username === "empty")
        )
          field.empty = true;
    return response;
  });
  if (options.mapped !== false) {
    const account = { provider: "bitwarden", server: "cloud-us", userId };
    h.settings.settings.ssoMappings = [
      { ...account, itemId, method: 1, idp: { ...account, itemId: otherItemId, origin: idp } },
    ];
  }
  if (options.recipe !== null) {
    const recipe = options.recipe ?? identifierFirst;
    h.recipes.recipe.mockImplementation(async (at, path) =>
      at === origin && path === "/signin" ? recipe : undefined,
    );
    h.recipes.starts.mockImplementation(async (at) =>
      at === origin ? startsOf([recipe.steps[0]!]) : [],
    );
  } else {
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.starts.mockResolvedValue([]);
  }
  const recipes = h.recipes as typeof h.recipes & Record<string, unknown>;
  recipes["sso"] = vi.fn(async () => heads);
  recipes["ssoFence"] = vi.fn(async () => () => true);
  fake.state.extracted = { login: identifierPage() };
  /** A document of the tab announces itself at `url`, as its content script does. */
  const announce = (
    url: string,
    documentId: string,
    kind: "start" | "signIn" | "plain" = "start",
    frame: Record<string, unknown> = {},
  ) => {
    fake.state.pageUrl = url;
    fake.state.tabUrls[1] = url;
    const path = new URL(url).pathname;
    return h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        ...(kind === "start" ? { start: { path } } : kind === "signIn" ? { signIn: { path } } : {}),
      },
      sender({ documentId, url, ...frame }),
    );
  };
  const methods = async () =>
    v.parse(
      ssoResponseSchema,
      await h.login.handle({ version: 1, type: "login.sso.get", tabId: 1 }, popup),
    );
  /** The person cancels the waiting method offer. */
  const cancel = async () => {
    const shown = await methods();
    if (!shown.ok || !shown.offer) throw new Error("No offer");
    return h.login.handle(
      { version: 1, type: "login.sso.cancel", tabId: 1, offerId: shown.offer.id },
      popup,
    );
  };
  const refusals = () =>
    report.mock.calls.flatMap(([entry]) => (entry.type === "refused" ? [entry] : []));
  return { h, sso, generation, report, refusals, announce, methods, cancel };
}
const handoffKey = "pateat.login-sso-handoffs.v1";
/** The answers of Continue presses still pending. */
const releases: (() => void)[] = [];

beforeEach(() => {
  vi.setTimerTickMode("manual");
  destinations = {};
  delivery.mockClear();
  delivery.mockImplementation(async (tabId, message, frame) => {
    const { type, target: pressed } = message as { type?: string; target?: LoginTarget };
    // The press itself is not under test: the flow stops at its preparation.
    if (type === "login.sso.prepare") return { ok: false, reason: "synthetic-stop" };
    if (type === "login.sso.inspect")
      return {
        ok: true,
        url: fake.state.pageUrl,
        destinations: [
          destinations[(pressed as { value?: string } | undefined)?.value ?? ""] ??
            `${new URL(fake.state.pageUrl).origin}/lookup`,
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
  fake.state.pageUrl = `${origin}/signin`;
  fake.state.tabUrls = {};
  fake.state.observed = ["unique", "missing"];
  fake.state.observedPath = "/signin";
  fake.state.present = new Set(["email", "next"]);
  fake.state.unusable = new Set();
  fake.state.awaited = { ok: true };
  fake.state.executeReply = undefined;
  fake.state.gone = new Set();
  fake.state.goneFrames = new Set();
  fake.state.signs = undefined;
  fake.state.loaded = true;
  fake.state.incognito = new Set();
  fake.state.openTabs = undefined;
  // Continue answers only once released: the site sends the tab on meanwhile.
  fake.state.onExecute = (message) => {
    const step = (message["operation"] as { step: LoginStep }).step;
    return step.kind === "click"
      ? new Promise<void>((resolve) => {
          releases.push(resolve);
        })
      : Promise.resolve();
  };
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
  fake.state.replaced.length = 0;
  fake.state.updated.length = 0;
});

describe("an identifier page before the IdP's entry (#1847)", () => {
  it("types the Username, presses Continue, and the broker page presses the IdP's entry", async () => {
    const s = setup();
    void s.announce(`${origin}/signin`, "signin-document");
    await until(() => executed().length === 2);
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    // Only the item's own Username is read, never its password or `SSO` field.
    expect(s.h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.username"]);
    expect(records()[0]).toMatchObject({ ssoHandoff: true, state: "submit-intent" });
    expect(fake.state.session[handoffKey]).toEqual([`1 ${origin}/signin`]);
    // The site sends the tab to the broker page, whose own SSO offer presses the entry
    // named for the IdP item.
    fake.state.extracted = { login: brokerPage };
    void s.announce(`${broker}/login`, "broker-document", "signIn");
    await until(() => prepared().length === 1);
    expect(prepared()[0]![1]).toMatchObject({ target: acme });
    const handoff = records().find((record) => record.account.origin === origin)!;
    expect(handoff).toMatchObject({ outcome: "left-origin", ssoHandoff: true });
    // Nothing more was typed, on either page.
    expect(executed()).toHaveLength(2);
    expect(s.generation.generate).not.toHaveBeenCalled();
  });

  it("never types again after Back to the identifier page, until Log in now", async () => {
    const s = setup();
    void s.announce(`${origin}/signin`, "signin-document");
    await until(() => executed().length === 2);
    fake.state.extracted = { login: brokerPage };
    void s.announce(`${broker}/login`, "broker-document", "signIn");
    await until(() => prepared().length === 1);
    for (const release of releases.splice(0)) release();
    // Back: a new document of the identifier page, and the restored one.
    fake.state.extracted = { login: identifierPage() };
    void s.announce(`${origin}/signin`, "signin-again");
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
    );
    expect(await s.cancel()).toEqual({ ok: true });
    await until(() =>
      s.refusals().some((entry) => entry.detail === "entry-required:identifier:typed"),
    );
    void s.announce(`${origin}/signin`, "signin-document");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toHaveLength(2);
    // The person's own Log in now on the page hands off once more.
    const offered = v.parse(
      manualOfferResponseSchema,
      await s.h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
    );
    if (!offered.ok || !offered.targets[0]) throw new Error("No target");
    const { documentId } = offered.targets[0].document;
    fake.state.onReconnect = () => s.announce(`${origin}/signin`, documentId);
    void s.h.login.handle(
      {
        version: 1,
        type: "login.manual.start",
        requestId: "manual-request",
        document: offered.targets[0].document,
        scope: offered.targets[0].scope,
        connectionId,
        itemId,
      },
      popup,
    );
    await until(() => executed().length === 4);
    expect(
      executed()
        .slice(2)
        .map((step) => step.kind),
    ).toEqual(["fill", "click"]);
  });

  it("presses an entry the identifier page shows for the IdP instead", async () => {
    const s = setup();
    const entry = { id: "c3", role: "button", target: acme, label: "Sign in with Acme" };
    destinations["sign-in-acme"] = `${idp}/authorize`;
    fake.state.extracted = { login: identifierPage([entry]) };
    void s.announce(`${origin}/signin`, "signin-document");
    await until(() => prepared().length === 1);
    expect(prepared()[0]![1]).toMatchObject({ target: acme });
    expect(executed()).toEqual([]);
  });

  it.each([
    [
      "the page shows a password field",
      {},
      [{ id: "c3", role: "password", target: target("password"), label: "Password" }],
      "entry-required:identifier:password-field",
    ],
    [
      "the page asks for two fields",
      {},
      [{ id: "c3", role: "text", target: target("company"), label: "Company" }],
      "entry-required:identifier:fields",
    ],
    [
      "the item's Username is empty",
      { username: "empty" as const },
      [],
      "entry-required:identifier:no-username",
    ],
  ])(
    "waits for the person's choice, typing nothing, when %s",
    async (_, options, extra, detail) => {
      const s = setup(options);
      fake.state.extracted = { login: identifierPage(extra) };
      void s.announce(`${origin}/signin`, "signin-document");
      await vi.waitFor(async () =>
        expect(await s.methods()).toMatchObject({ offer: { reason: "entry-required" } }),
      );
      expect(await s.cancel()).toEqual({ ok: true });
      await until(() => s.refusals().some((entry) => entry.detail === detail));
      expect(executed()).toEqual([]);
      expect(s.h.fields).not.toHaveBeenCalled();
      expect(fake.state.session[handoffKey] ?? []).toEqual([]);
    },
  );

  it("waits for the person's mapping when two IdP items qualify, typing nothing", async () => {
    const s = setup({ mapped: false });
    void s.announce(`${origin}/signin`, "signin-document");
    await vi.waitFor(async () =>
      expect(await s.methods()).toMatchObject({ offer: { reason: "mapping-required" } }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual([]);
    expect(s.h.fields).not.toHaveBeenCalled();
  });

  it("types nothing in a frame", async () => {
    const s = setup();
    const top = `${origin}/account`;
    fake.state.tabUrls[1] = top;
    fake.state.pageUrl = `${origin}/signin`;
    await s.h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        start: { path: "/signin" },
      },
      sender({ frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual([]);
    expect(s.h.fields).not.toHaveBeenCalled();
  });

  it.each([
    ["paused", { excludedSites: [{ hostname: "login.example", includeSubdomains: true }] }],
    [
      "Fill-only",
      {
        pagePermissionDefaults: {
          "sign-in": "fill" as const,
          confirm: "fill" as const,
          "personal-details": "fill" as const,
        },
      },
    ],
  ])("types nothing on a %s page", async (_, overrides) => {
    const s = setup({ overrides });
    await s.announce(`${origin}/signin`, "signin-document");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executed()).toEqual([]);
    expect(s.h.fields).not.toHaveBeenCalled();
    expect(prepared()).toEqual([]);
  });

  it("generates a first visit's recipe for the Username alone, then types it", async () => {
    const generated = parseLoginRecipe({ ...identifierFirst, id: "gen-first", revision: 1 });
    // The item also offers a custom field, which a hand-off never sends.
    const s = setup({
      recipe: null,
      custom: [
        { name: "SSO", kind: "text" },
        { name: "Branch", kind: "text" },
      ],
      generate: async () => {
        s.h.recipes.recipe.mockImplementation(async (at, path) =>
          at === origin && path === "/signin" ? generated : undefined,
        );
        s.h.recipes.starts.mockImplementation(async (at) =>
          at === origin ? startsOf([generated.steps[0]!]) : [],
        );
        fake.state.onReconnect = () => s.announce(`${origin}/signin`, "signin-document");
        return { outcome: "recipe", recipe: generated };
      },
    });
    expect(await s.announce(`${origin}/signin`, "signin-document", "plain")).toMatchObject({
      generate: true,
    });
    void s.announce(`${origin}/signin`, "signin-document", "signIn");
    await until(() => s.generation.generate.mock.calls.length === 1);
    const [request] = s.generation.generate.mock.calls[0]!;
    expect(request.slots.map((slot) => slot.id)).toEqual(["username"]);
    await until(() => executed().length === 2);
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(records()[0]).toMatchObject({ ssoHandoff: true, recipeId: "gen-first" });
  });

  it("sends a stale recipe's start page for repair, for the Username alone", async () => {
    // The page's field took another id since the recipe was made (as `ember9`, which now
    // names a link).
    const stale = parseLoginRecipe({
      ...identifierFirst,
      steps: [
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("ember9") }] },
        identifierFirst.steps[1]!,
      ],
    });
    const s = setup({
      recipe: stale,
      custom: [
        { name: "SSO", kind: "text" },
        { name: "Branch", kind: "text" },
      ],
    });
    fake.state.pageUrl = `${origin}/signin`;
    fake.state.tabUrls[1] = fake.state.pageUrl;
    await s.h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        shown: { path: "/signin", miss: { missing: [target("ember9")], status: 200 } },
      },
      sender({ documentId: "signin-document" }),
    );
    await until(() => s.generation.generate.mock.calls.length === 1);
    const [request] = s.generation.generate.mock.calls[0]!;
    expect(request).toMatchObject({ repair: { recipeId: stale.id, revision: 3 } });
    expect(request.slots.map((slot) => slot.id)).toEqual(["username"]);
    expect(executed()).toEqual([]);
  });
});
