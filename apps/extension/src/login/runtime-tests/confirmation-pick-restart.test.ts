// **Fill** from the popup (ADR 0035, amended 2026-11-17) after the worker restarted: the
// worker keeps the documents it admitted in memory only, so a verification page that
// announced before the restart is unknown to the popup's first offer afterwards.
import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings } from "@pateat/contracts";
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
  configure,
  settled,
  both,
  offers,
  press,
  clicks,
} = pickFixture(fake);
type H = ReturnType<typeof harness>;

// The verification page's URL carries the page the site returns to afterwards.
const url = `${origin}/confirm?continue=${encodeURIComponent(`${origin}/my/security`)}`;
const announce = (h: H) => h.hello({ documentId: "confirmation-document", url }, false);

/** A verification page announced in tab 1, then a worker that restarted since. */
async function restarted(settings: Partial<LocalSettings> = {}) {
  const before = harness(settings, { uris: both });
  configure(before);
  fake.state.pageUrl = url;
  await announce(before);
  // The page answers a reconnect as its content script does, to the restarted worker.
  fake.state.openTabs = [1];
  const after = harness(settings, { uris: both });
  configure(after);
  fake.state.pageUrl = url;
  fake.state.onReconnect = () => announce(after);
  fake.state.reconnects = [];
  return after;
}

describe("the popup's Fill after a worker restart", () => {
  // Without a saved default the restarted worker does not ask the tab to announce, and the
  // offer asks its page; with one, the offer waits for the announcement the worker asked for.
  it.each<[string, Partial<LocalSettings>, { tabId: number; frameId?: number }]>([
    ["without a saved default for the site", { siteDefaults: [] }, { tabId: 1, frameId: 0 }],
    ["with a saved default for the site", {}, { tabId: 1 }],
  ])("offers it on a page that announced before %s", async (_name, settings, asked) => {
    const h = await restarted(settings);
    expect(await offers(h)).toMatchObject({
      ok: true,
      targets: [
        expect.objectContaining({
          document: expect.objectContaining({ documentId: "confirmation-document" }),
          fill: true,
        }),
      ],
    });
    expect(fake.state.reconnects).toEqual([asked]);
    // The offer is the one a press uses: the picked account fills once and nothing presses.
    expect(await press(h, otherItemId)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(clicks()).toEqual([]);
  });

  it("asks no page whose path has no verification recipe", async () => {
    const h = await restarted({ siteDefaults: [] });
    h.recipes.routes.mockResolvedValue([parseLoginRecipe(recipe)]);
    h.recipes.recipe.mockResolvedValue(parseLoginRecipe(recipe));
    expect(await offers(h)).toMatchObject({ ok: true, targets: [], reason: "no-document" });
    expect(fake.state.reconnects).toEqual([]);
  });

  it("asks no verification page where confirm is off", async () => {
    const h = await restarted({
      siteDefaults: [],
      pagePermissionDefaults: { "sign-in": "auto", confirm: "off", "personal-details": "fill" },
    });
    expect(await offers(h)).toMatchObject({ ok: true, targets: [], reason: "no-document" });
    expect(fake.state.reconnects).toEqual([]);
  });
});
