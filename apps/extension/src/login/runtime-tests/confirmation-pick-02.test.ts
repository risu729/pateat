// **Fill** from the popup (ADR 0035, amended 2026-11-17) while the tab or page changes
// under the press: a login starting meanwhile, the press expiring, the page or its top page
// moving on, a paused site's page without a recipe, and the tab's own login afterwards.
import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
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
  cached,
  configure,
  announce,
  settled,
  setPause,
  authenticated,
  generation,
  both,
  start,
  offers,
  press,
  clicks,
  secretAnswer,
} = pickFixture(fake);
type H = ReturnType<typeof harness>;
type Answer = "verified" | "closed" | "unavailable";

/** A re-prompt item's press that waits on its master password window. */
async function asking(frame?: Record<string, unknown>) {
  const answers: PromiseWithResolvers<Answer>[] = [];
  const ask = vi.fn(async () => {
    const answer = Promise.withResolvers<Answer>();
    answers.push(answer);
    return answer.promise;
  });
  const { h } = start(
    { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] },
    { askMasterPassword: ask, reprompt: true, otherReprompt: true },
  );
  if (frame) await portal(h);
  configure(h);
  if (frame) fake.state.pageUrl = `${origin}/portal`;
  await announce(h, frame);
  fake.state.onReconnect = () => announce(h, frame);
  expect(await press(h, otherItemId, frame ? 3 : 0)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  await settled(h);
  expect(await offers(h)).toMatchObject({ fill: { state: "asked" } });
  return { h, ask, answers };
}

/** The tab's top page, which holds the verification page as a frame. */
async function portal(h: H, documentId = "portal-top") {
  const url = `${origin}/portal`;
  fake.state.pageUrl = url;
  fake.state.tabUrls[1] = url;
  fake.state.observedPath = "/portal";
  await h.hello({ documentId, url }, false);
  fake.state.observedPath = "/confirm";
}
const frame = {
  frameId: 3,
  documentId: "confirm-frame",
  url: `${origin}/confirm`,
  tab: { id: 1, incognito: false, url: `${origin}/portal` },
};

describe("a Fill press while the tab changes", () => {
  it("is refused when a login starts in the tab before the page announces", async () => {
    const { h } = start();
    const confirm = configure(h);
    const signIn = parseLoginRecipe(recipe);
    h.recipes.recipe.mockImplementation(async (_origin: string, path: string) =>
      path === "/signin" ? signIn : confirm,
    );
    await announce(h);
    // The login's first field read waits, so it is still running when the page answers.
    const field = Promise.withResolvers<string>();
    fake.state.onReconnect = async () => {
      h.fields.mockReturnValue(field.promise);
      await h.hello({
        frameId: 2,
        documentId: "signin-frame",
        url: `${origin}/signin`,
        tab: { id: 1, incognito: false, url: `${origin}/confirm` },
      });
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
      return announce(h);
    };
    expect(await press(h)).toEqual({ ok: false, reason: "login-running" });
    expect(h.fields.mock.calls.map(([read]) => read.account.itemId)).not.toContain(otherItemId);
    expect(confirmations()).toEqual([]);
    field.resolve("");
  });

  it("ends when it expires while its master password window is open", async () => {
    const { h, answers } = await asking();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    expect(await offers(h)).toMatchObject({ fill: { state: "blocked", reason: "timed-out" } });
    clock.mockRestore();
    answers[0]!.resolve("verified");
    await announce(h);
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });

  it("ends when the page moves on while its master password window is open", async () => {
    const { h, answers } = await asking();
    // The tab's next document on the same URL, as after a reload.
    await announce(h, { documentId: "next-document" });
    expect(await offers(h)).toMatchObject({ fill: { state: "blocked", reason: "page-changed" } });
    fake.state.onReconnect = () => announce(h, { documentId: "next-document" });
    answers[0]!.resolve("verified");
    await announce(h, { documentId: "next-document" });
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });

  it("ends a frame's press when its top page moves on", async () => {
    const { h, answers } = await asking(frame);
    await portal(h, "portal-next");
    expect(await offers(h)).toMatchObject({ fill: { state: "blocked", reason: "page-changed" } });
    answers[0]!.resolve("verified");
    await announce(h, frame);
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });
});

describe("a Fill press and the site's other state", () => {
  it("sends a paused site's secret-answer page once and fills a confirm result", async () => {
    const { service, answer } = generation();
    const { h } = start({}, { generation: service, custom: [] });
    const unoffered = secretAnswer(h);
    expect(await setPause(h, true)).toMatchObject({ ok: true });
    await unoffered();
    expect(service.generate).not.toHaveBeenCalled();
    fake.state.onReconnect = () => announce(h);
    expect(await press(h)).toMatchObject({ ok: true, state: "generating" });
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    const generated = cached();
    h.recipes.routes.mockResolvedValue([generated]);
    h.recipes.recipe.mockResolvedValue(generated);
    answer.resolve({ outcome: "recipe", recipe: generated });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(clicks()).toEqual([]);
  });

  it("leaves the page to the person for the tab's own login once its window was closed", async () => {
    const ask = vi.fn<() => Promise<Answer>>();
    const { h, options } = await authenticated({ uris: both, askMasterPassword: ask });
    // Both items ask for their master password from now on.
    options.reprompt = true;
    options.otherReprompt = true;
    h.settings.settings.repromptSites = [{ hostname: "login.example", includeSubdomains: false }];
    configure(h);
    // The login's own window could not show: its fill stops, and the next announcement
    // would ask again.
    ask.mockResolvedValueOnce("unavailable");
    await announce(h);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await settled(h);
    fake.state.onReconnect = () => announce(h);
    ask.mockResolvedValueOnce("closed");
    await press(h, otherItemId);
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({ fill: { state: "blocked", reason: "closed" } }),
    );
    expect(ask).toHaveBeenCalledTimes(2);
    // The person closed the press's window on this page: the login neither asks again nor
    // fills it.
    ask.mockResolvedValue("verified");
    await announce(h);
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });
});
