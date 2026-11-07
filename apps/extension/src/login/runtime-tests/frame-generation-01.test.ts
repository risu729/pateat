import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, otherItemId, sender, target, startsOf, uriMatch, harness } =
  createRuntimeTestHarness(fake);

// A sign-in form in a frame of the tab's page is sent for generation as the tab's page is,
// as Apple Account's `idmsa.apple.com` frame in `account.apple.com/sign-in` (ADR 0086,
// delivery 3).
describe("a frame's sign-in page sent for generation (ADR 0086)", () => {
  const portal = "https://portal.example/account";
  const evil = "https://evil.example/";
  const unsaved = { siteDefaults: [], bindings: [] };
  const generated = parseLoginRecipe({
    version: 1,
    id: "gen-synthetic",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "username", target: target("user") },
          { slot: "password", target: target("password") },
        ],
      },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 1,
  });
  const loginPage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/signin",
      language: "en",
      complete: true,
      candidates: [
        { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
        { id: "c2", role: "password", target: target("password") },
        { id: "c3", role: "button", target: target("login"), label: "Sign in" },
      ],
    },
  };
  const frame = (top = portal) => {
    fake.state.tabUrls[1] = top;
    return { frameId: 3, documentId: "frame-one", tab: { id: 1, url: top } };
  };
  /** Every URL matches the item, except one of `evil.example`. */
  const matchAll: LiveUriMatcher = async (_connection, url) => ({
    ok: true,
    data: uriMatch({
      targetOrigin: new URL(url).origin,
      ...(new URL(url).hostname === "evil.example" ? { candidates: [] } : {}),
    }),
  });
  const uris = vi.fn<LiveUriMatcher>(matchAll);
  function setup() {
    const report = vi.fn<(entry: LoginReport) => void>();
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
        sent?.();
        h.recipes.recipe.mockImplementation(async (at: string, path: string) =>
          at === origin && path === "/signin" ? generated : undefined,
        );
        h.recipes.starts.mockImplementation(async (at: string) =>
          at === origin ? startsOf([generated.steps[0]!]) : [],
        );
        return { outcome: "recipe", recipe: generated } as const;
      }),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(
        async () => ({ outcome: "abstained", reason: "ambiguous" }) as const,
      ),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" }) as const),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    const h = harness(unsaved, {
      allowedOrigins: [],
      uris,
      username: true,
      otherUsername: true,
      custom: [],
      generation: service,
      report,
    });
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.starts.mockResolvedValue(startsOf([]));
    const skips = () =>
      report.mock.calls.flatMap(([entry]) =>
        entry.type === "generation" && entry.outcome === "skipped" ? [entry] : [],
      );
    return { h, service, skips };
  }
  const signIn = (h: ReturnType<typeof harness>, from: Record<string, unknown>) =>
    h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        signIn: { path: "/signin" },
      },
      sender(from),
    );
  const extracts = () => fake.state.messages.filter((entry) => entry.type === "login.extract");

  afterEach(() => {
    for (const listener of fake.state.removed.splice(0)) listener(1);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.awaited = { ok: true };
    fake.state.gone = new Set();
    fake.state.goneFrames = new Set();
    fake.state.onPresent = undefined;
    fake.state.extracted = { login: loginPage };
    fake.state.signs = undefined;
    fake.state.loaded = true;
    uris.mockReset();
    uris.mockImplementation(matchAll);
  });

  it("sends the frame's own page under its origin and logs in there with the recipe", async () => {
    const { h, service } = setup();
    // Offered as the tab's page is: the frame announces its sign-in input once it shows.
    expect(await h.hello(frame(), false)).toMatchObject({
      ok: false,
      reason: "recipe-not-found",
      generate: true,
    });
    fake.state.onReconnect = () => h.hello(frame());
    expect(await signIn(h, frame())).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    // Only a frame that shows in the tab's page answers with its description.
    expect(extracts()).toEqual([expect.objectContaining({ page: "login", shown: true })]);
    expect(service.generate.mock.calls[0]![0].observation).toMatchObject({
      origin,
      path: "/signin",
    });
    // Both the frame's URL and the tab's were matched against the vault.
    expect(uris.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining(["https://login.example/signin", portal]),
    );
    // The frame announces again and runs the recipe it was sent for.
    await vi.waitFor(() =>
      expect(fake.state.reconnects).toContainEqual({
        tabId: 1,
        frameId: 3,
        documentId: "frame-one",
      }),
    );
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
  });

  it("sends the page for the items that match the tab too, hiding every frame item's username", async () => {
    const { h, service } = setup();
    const one = { itemId, matches: [{ uriIndex: 0, match: 0 as const }] };
    const other = { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 as const }] };
    // Both items match the frame; only the first matches the tab's page.
    uris.mockImplementation(async (_connection, url) => ({
      ok: true,
      data: uriMatch({
        targetOrigin: new URL(url).origin,
        candidates: new URL(url).origin === origin ? [one, other] : [one],
      }),
    }));
    await h.hello(frame(), false);
    expect(await signIn(h, frame())).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    const read = h.fields.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]);
    expect(read).toContainEqual([itemId, "login.username"]);
    expect(read).toContainEqual([otherItemId, "login.username"]);
  });

  it("never sends a frame inside a page the item does not match", async () => {
    const { h, service, skips } = setup();
    await h.hello(frame(evil), false);
    expect(await signIn(h, frame(evil))).toMatchObject({ ok: false });
    expect(skips()).toContainEqual(
      expect.objectContaining({ reason: "no-vault-match", detail: "frame-top-mismatch" }),
    );
    expect(extracts()).toEqual([]);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("never sends a frame that does not show in the tab's page, reading it once", async () => {
    const { h, service, skips } = setup();
    fake.state.extracted = { login: { ok: false, reason: "frame-hidden" } };
    await h.hello(frame(), false);
    expect(await signIn(h, frame())).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() =>
      expect(skips()).toContainEqual(expect.objectContaining({ reason: "frame-hidden" })),
    );
    expect(extracts()).toHaveLength(1);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("never offers a frame's page as a sign-in entry", async () => {
    const { h } = setup();
    // A URL that names another path of the site, as a tab's page offered as an entry has.
    fake.state.pageUrl = "https://login.example/signin?return_to=%2Faccount";
    const reply = await h.hello({ ...frame(), url: fake.state.pageUrl }, false);
    expect(reply).toMatchObject({ generate: true });
    expect(reply).not.toHaveProperty("entry");
    // The same page as another tab's own page is offered as one.
    fake.state.tabUrls[2] = fake.state.pageUrl;
    expect(
      await h.hello({ tab: { id: 2 }, documentId: "page", url: fake.state.pageUrl }, false),
    ).toMatchObject({
      generate: true,
      entry: true,
    });
  });
});
