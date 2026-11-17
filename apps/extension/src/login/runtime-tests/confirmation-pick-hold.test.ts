// A page a **Fill** press sent for generation (ADR 0035, amended 2026-11-17): only a
// verification that comes back fills, nothing else starts a login there that presses
// buttons, also after a worker restart, and the person's own Log in now still logs in.
import { describe, expect, it, vi } from "vitest";
import type { ManualStartRequest } from "../manual-wire";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { pickFixture } = await import("./confirmation-pick-fixture");
const {
  harness,
  connectionId,
  itemId,
  popup,
  stored,
  executes,
  confirmations,
  cached,
  announce,
  settled,
  startsOf,
  liveDefault,
  generation,
  both,
  start,
  offers,
  press,
  clicks,
  secretAnswer,
  sessionKey,
  origin,
  generated,
  signInCached,
  ready,
  heldPage,
} = pickFixture(fake);

describe("a page a Fill press sent for generation", () => {
  it("starts no login after a worker restart either", async () => {
    await heldPage();
    // The worker idles out: a new runtime reads the session store and the page announces
    // again with its sign-in form ready, as the startup reconnect makes it.
    const next = harness({ siteDefaults: [liveDefault()] }, { uris: both, custom: [] });
    signInCached(next);
    expect(await ready(next)).toEqual({ ok: false, reason: "not-a-verification-page" });
    await settled(next);
    expect(executes()).toEqual([]);
    expect(stored() ?? []).toEqual([]);
  });

  it("lets the hold go once its document leaves that path", async () => {
    const h = await heldPage();
    const holds = () =>
      (fake.state.session[sessionKey] as { claims: { key: string }[] }).claims.filter((entry) =>
        entry.key.startsWith('["generation","pick",'),
      );
    expect(holds()).toHaveLength(1);
    // The single-page site moves the same document to another path.
    fake.state.pageUrl = `${origin}/account`;
    fake.state.observedPath = "/account";
    await h.hello({ documentId: "confirmation-document", url: `${origin}/account` }, false);
    await vi.waitFor(() => expect(holds()).toEqual([]));
  });

  it("still logs in with the person's own Log in now", async () => {
    const h = await heldPage();
    const offered = await offers(h);
    if (!offered.ok) throw new Error("No page");
    const target = offered.targets[0]!;
    // A sign-in page now: the popup offers Log in now, not Fill.
    expect(target.fill).toBeUndefined();
    const request: ManualStartRequest = {
      requestId: "manual-request",
      document: target.document,
      scope: target.scope,
      connectionId,
      itemId,
    };
    expect(
      await h.login.handle({ version: 1, type: "login.manual.start", ...request }, popup),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(clicks()).not.toEqual([]));
    expect(stored()).toEqual([
      expect.objectContaining({ account: expect.objectContaining({ itemId }) }),
    ]);
  });

  // Its document's announcements while its generation runs are answered before admission,
  // from the tab's confirmation work, so they never reach the press or the hold.
  it("is not ended by its page announcing again while it is sent", async () => {
    const { service, answer } = generation();
    const { h } = start({}, { generation: service, custom: [] });
    await secretAnswer(h)();
    fake.state.onReconnect = () => announce(h);
    expect(await press(h)).toMatchObject({ ok: true, state: "generating" });
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    await announce(h);
    expect(await offers(h)).toMatchObject({ fill: { state: "generating" } });
    h.recipes.routes.mockResolvedValue([cached()]);
    h.recipes.recipe.mockResolvedValue(cached());
    answer.resolve({ outcome: "recipe", recipe: cached() });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(await offers(h)).toMatchObject({ fill: { state: "filled" } });
    expect(service.generate).toHaveBeenCalledTimes(1);
  });

  it("is not offered on a secret-answer page whose path a sign-in recipe starts on", async () => {
    const { service } = generation();
    const { h } = start({}, { generation: service, custom: [] });
    const unoffered = secretAnswer(h);
    h.recipes.starts.mockResolvedValue(startsOf([generated().steps[0]!]));
    await unoffered();
    const offered = await offers(h);
    expect(offered.ok && offered.targets.some((entry) => entry.fill)).toBe(false);
  });
});
