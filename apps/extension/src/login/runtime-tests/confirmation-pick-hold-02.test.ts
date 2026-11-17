// A page a **Fill** press sent for generation (ADR 0035, amended 2026-11-17): the hold
// comes before SSO admission and after a framed login's move, and a generation the
// service gave no answer to holds nothing, so the person may press again.
import { describe, expect, it, vi } from "vitest";
import type { LoginOperation } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { pickFixture } = await import("./confirmation-pick-fixture");
const {
  harness,
  liveDefault,
  both,
  signInCached,
  clicks,
  origin,
  stored,
  executes,
  confirmations,
  cached,
  settled,
  generation,
  start,
  offers,
  press,
  secretAnswer,
  ready,
  heldPage,
  configure,
  announce,
  otherItemId,
} = pickFixture(fake);

type Answer = Awaited<ReturnType<LoginGeneration["generate"]>>;
/** The service answers each generation with the next of `answers`, made when it is asked. */
function answering(...answers: (() => Answer)[]) {
  const { service } = generation();
  for (const answer of answers)
    service.generate.mockImplementationOnce(async (_request, sent) => {
      sent?.();
      return answer();
    });
  return service;
}
const fillOffered = async (h: Awaited<ReturnType<typeof heldPage>>) => {
  const offered = await offers(h);
  return offered.ok && offered.targets.some((entry) => entry.fill === true);
};

describe("a Fill press on a site whose default item signs in through SSO", () => {
  it("fills without SSO admission taking its page's announcement", async () => {
    const describeSso = vi.fn(async () => ({ ok: false as const, reason: "synthetic-sso" }));
    const sso = { describe: describeSso, candidates: vi.fn(), validate: vi.fn() } as never;
    const { h } = start({}, { sso, custom: [{ name: "SSO", kind: "text" }] });
    configure(h);
    // The page's own announcement is admitted as before this press.
    await announce(h);
    const before = describeSso.mock.calls.length;
    fake.state.onReconnect = () => announce(h);
    expect(await press(h, otherItemId)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(describeSso).toHaveBeenCalledTimes(before);
    expect(await offers(h)).toMatchObject({ fill: { state: "filled" } });
    expect(clicks()).toEqual([]);
  });
});

describe("a page a Fill press sent for generation", () => {
  it("is held before SSO is offered, so no SSO entry is looked for there", async () => {
    await heldPage();
    // After a worker restart, the default item has an SSO field: an admitted page asks the
    // vault for its SSO methods.
    const describeSso = vi.fn(async () => ({ ok: false as const, reason: "synthetic-sso" }));
    const sso = { describe: describeSso, candidates: vi.fn(), validate: vi.fn() } as never;
    const next = harness(
      { siteDefaults: [liveDefault()] },
      { uris: both, custom: [{ name: "SSO", kind: "text" }], sso },
    );
    signInCached(next);
    expect(await ready(next)).toEqual({ ok: false, reason: "not-a-verification-page" });
    await settled(next);
    expect(describeSso).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
  });

  it("still ends a login in its frame whose frame went away in place", async () => {
    const h = await heldPage();
    // A frame of the held page signs in, and its click waits for the site.
    fake.state.onExecute = (message) =>
      (message["operation"] as LoginOperation).step.kind === "click"
        ? new Promise(() => undefined)
        : Promise.resolve();
    fake.state.tabUrls[1] = `${origin}/confirm`;
    expect(
      await h.hello({
        frameId: 3,
        documentId: "frame-one",
        tab: { id: 1, url: `${origin}/confirm` },
      }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicks()).toHaveLength(1));
    expect(stored()).toEqual([expect.objectContaining({ state: "submit-intent" })]);
    // The single-page site replaces the frame after the sign-in: the held page is read for
    // the frame's result and stays held.
    fake.state.gone.add("frame-one");
    fake.state.goneFrames.add(3);
    fake.state.signs = {
      password: false,
      code: false,
      captcha: false,
      invalid: false,
      alert: false,
    };
    const answered = Promise.withResolvers<unknown>();
    fake.state.onReconnect = () => {
      const announced = ready(h);
      answered.resolve(announced);
      return announced;
    };
    await h.login.tabLoaded({ id: 1, url: `${origin}/confirm` } as never);
    expect(await answered.promise).toEqual({ ok: false, reason: "not-a-verification-page" });
    expect(stored()).toEqual([expect.objectContaining({ state: "authenticated" })]);
  });

  it("may be pressed again after its generation got no answer, and then fills", async () => {
    const service = answering(
      () => ({ outcome: "unavailable", reason: "daily-limit" }),
      () => {
        h.recipes.routes.mockResolvedValue([cached()]);
        h.recipes.recipe.mockResolvedValue(cached());
        return { outcome: "recipe", recipe: cached() };
      },
    );
    const { h } = start({}, { generation: service, custom: [] });
    await secretAnswer(h)();
    fake.state.onReconnect = () => ready(h);
    expect(await press(h)).toMatchObject({ ok: true, state: "generating" });
    // The limit's own reason, not "not a verification page".
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({ fill: { state: "blocked", reason: "daily-limit" } }),
    );
    await settled(h);
    expect(await fillOffered(h)).toBe(true);
    expect(await press(h, undefined, 0, "fill-again")).toMatchObject({
      ok: true,
      state: "generating",
    });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(service.generate).toHaveBeenCalledTimes(2);
    await settled(h);
    expect(await offers(h)).toMatchObject({ fill: { state: "filled" } });
  });

  it("is not offered again once the service found no login page there", async () => {
    const service = answering(() => ({ outcome: "abstained", reason: "ambiguous" }));
    const { h } = start({}, { generation: service, custom: [] });
    await secretAnswer(h)();
    fake.state.onReconnect = () => ready(h);
    expect(await press(h)).toMatchObject({ ok: true, state: "generating" });
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({
        fill: { state: "blocked", reason: "not-a-verification-page" },
      }),
    );
    await settled(h);
    expect(await fillOffered(h)).toBe(false);
    expect(await press(h, undefined, 0, "fill-again")).toMatchObject({
      ok: false,
      reason: "not-a-verification-page",
    });
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(executes()).toEqual([]);
  });
});
