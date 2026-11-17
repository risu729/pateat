// **Fill** from the popup (ADR 0035, amended 2026-11-17) after the worker restarted: the
// worker keeps the documents it admitted in memory only, so a verification page that
// announced before the restart is unknown to the popup's first offer afterwards.
import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginRecipe } from "@pateat/contracts";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { pickFixture } = await import("./confirmation-pick-fixture");
const {
  harness,
  recipe,
  origin,
  otherItemId,
  confirmations,
  executes,
  cached,
  configure,
  settled,
  both,
  offers,
  press,
  clicks,
} = pickFixture(fake);
type H = ReturnType<typeof harness>;

// The verification page's URL carries the page the site returns to afterwards.
const query = `?continue=${encodeURIComponent(`${origin}/my/security`)}`;

interface Page {
  /** The page's URL; `/confirm` with the return query by default. */
  url?: string;
  /** Its path as observed, which the recipe starts on. */
  path?: string;
  confirm?: LoginRecipe;
  /** The sender's tab, as for a private window. */
  tab?: { id: number; incognito: boolean };
  /** How the page answers the restarted worker's reconnect; it announces by default. */
  answer?: (announce: () => Promise<unknown>) => Promise<unknown>;
}

/** A verification page announced in tab 1, then a worker that restarted since. */
async function restarted(settings: Partial<LocalSettings> = {}, page: Page = {}) {
  const url = page.url ?? `${origin}/confirm${query}`;
  const from = { documentId: "confirmation-document", url, ...(page.tab ? { tab: page.tab } : {}) };
  const set = (h: H) => {
    configure(h, page.confirm);
    fake.state.pageUrl = url;
    fake.state.observedPath = page.path ?? "/confirm";
    return h;
  };
  const before = set(harness(settings, { uris: both }));
  await before.hello(from, false);
  fake.state.openTabs = [1];
  fake.state.reconnects = [];
  fake.state.messages = [];
  let after: H | undefined;
  const announce = () => after!.hello(from, false);
  fake.state.onReconnect = () => (page.answer ? page.answer(announce) : announce());
  after = set(harness(settings, { uris: both }));
  return after;
}
const offered = {
  ok: true,
  targets: [
    expect.objectContaining({
      document: expect.objectContaining({ documentId: "confirmation-document" }),
      fill: true,
    }),
  ],
};
const unknown = { ok: true, targets: [], reason: "no-document" };
/** The press fills once with the picked account and presses nothing. */
async function fills(h: H) {
  expect(await press(h, otherItemId)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
  await settled(h);
  expect(clicks()).toEqual([]);
}

describe("the popup's Fill after a worker restart", () => {
  // Without a saved default the restarted worker does not ask the tab to announce, and the
  // offer asks its page; with one, the offer waits for the announcement the worker asked for.
  it.each<[string, Partial<LocalSettings>, { tabId: number; frameId?: number }]>([
    ["without a saved default for the site", { siteDefaults: [] }, { tabId: 1, frameId: 0 }],
    ["with a saved default for the site", {}, { tabId: 1 }],
  ])("offers it on a page that announced before %s", async (_name, settings, asked) => {
    const h = await restarted(settings);
    expect(await offers(h)).toMatchObject(offered);
    expect(fake.state.reconnects).toEqual([asked]);
    // The offer itself runs nothing on the page.
    expect(executes()).toEqual([]);
    await fills(h);
  });

  it("offers it on an unclear page and on a path with a redacted segment", async () => {
    const unclear = await restarted({ siteDefaults: [] }, { confirm: cached("unclear") });
    expect(await offers(unclear)).toMatchObject(offered);
    const tenant = "3f2b6c1e-8d4a-4b7e-9c0f-1a2b3c4d5e6f";
    const confirm = parseLoginRecipe({
      ...cached(),
      steps: cached().steps.map((step) => ({ ...step, path: "/[id]/confirm" })),
    });
    const h = await restarted(
      { siteDefaults: [] },
      { url: `${origin}/${tenant}/confirm${query}`, path: "/[id]/confirm", confirm },
    );
    expect(await offers(h)).toMatchObject(offered);
    expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 0 }]);
  });

  it.each(["excluded", "private"] as const)("offers it on a page of a %s site", async (kind) => {
    const settings: Partial<LocalSettings> =
      kind === "excluded"
        ? {
            siteDefaults: [],
            excludedSites: [{ hostname: "login.example", includeSubdomains: false }],
          }
        : ({ siteDefaults: [], loginInPrivateWindows: undefined } as Partial<LocalSettings>);
    if (kind === "private") fake.state.incognito = new Set([1]);
    const h = await restarted(
      settings,
      kind === "private" ? { tab: { id: 1, incognito: true } } : {},
    );
    expect(await offers(h)).toMatchObject(offered);
    await fills(h);
  });

  it("sends one reconnect while another is in flight", async () => {
    // The page answers the restarted worker's own reconnect only once released.
    const release = Promise.withResolvers<void>();
    const h = await restarted(
      {},
      { answer: async (announce) => (await release.promise, announce()) },
    );
    const first = offers(h);
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    release.resolve();
    expect(await first).toMatchObject(offered);
    // Two offers at once without a saved default ask the page once.
    const next = await restarted({ siteDefaults: [] });
    const [one, two] = await Promise.all([offers(next), offers(next)]);
    expect(one).toMatchObject(offered);
    expect(two).toMatchObject(offered);
    expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 0 }]);
  });

  it.each([
    [
      "without a content script",
      () =>
        Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
    ],
    ["that never answers", () => new Promise<never>(() => {})],
  ] as const)("says no form was found on a page %s", async (_name, answer) => {
    const h = await restarted({ siteDefaults: [] }, { answer });
    expect(await offers(h)).toMatchObject(unknown);
    expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 0 }]);
  });

  it("asks no page whose path has no verification recipe", async () => {
    const h = await restarted({ siteDefaults: [] });
    h.recipes.routes.mockResolvedValue([parseLoginRecipe(recipe)]);
    h.recipes.recipe.mockResolvedValue(parseLoginRecipe(recipe));
    expect(await offers(h)).toMatchObject(unknown);
    expect(fake.state.reconnects).toEqual([]);
  });

  it("asks no verification page where confirm is off", async () => {
    const h = await restarted({
      siteDefaults: [],
      pagePermissionDefaults: { "sign-in": "auto", confirm: "off", "personal-details": "fill" },
    });
    expect(await offers(h)).toMatchObject(unknown);
    expect(fake.state.reconnects).toEqual([]);
  });
});
