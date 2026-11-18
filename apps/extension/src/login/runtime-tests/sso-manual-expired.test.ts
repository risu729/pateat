import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualOfferResponseSchema, type ManualStartRequest } from "../manual-wire";
import { ssoResponseSchema, type SsoSelection } from "../sso-wire";
import { MANUAL_START_MS } from "../runtime/manual-scope";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, otherItemId, snapshotId, uriMatch, harness } =
  createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
/** How long a method offer waits for the person (`OFFER_MS` in sso-choice.ts). */
const OFFER_MS = 600_000;
const idp = "https://idp.example";
const evidence = "E".repeat(43);
const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");

type Described = { ok: true; data: unknown } | { ok: false; reason: string };
/**
 * The site item's own password and its automatic `SSO` method, whose saved provider
 * account the person has not chosen yet, as on the page of #1687.
 */
function setup() {
  const described = (): Described => ({
    ok: true,
    data: {
      sourceEvidence: evidence,
      policyRevision: 1,
      methods: [
        { method: { number: 1 }, form: "bracket", automatic: true, label: "Synthetic provider" },
      ],
    },
  });
  const sso = {
    describe: vi.fn(async (): Promise<Described> => described()),
    candidates: vi.fn(async () => ({
      ok: true as const,
      data: {
        sourceEvidence: evidence,
        policyRevision: 1,
        candidates: [
          { account: { connectionId, itemId: otherItemId }, snapshotId, origins: [idp] },
        ],
      },
    })),
    validate: vi.fn(async () => ({
      ok: true as const,
      data: { sourceEvidence: evidence, policyRevision: 1, candidates: [] },
    })),
  };
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
  const h = harness(
    {},
    {
      uris,
      custom: [{ name: "SSO", kind: "text" }],
      otherUsername: true,
      sso: sso as never,
    },
  );
  const popupSends = async (message: Record<string, unknown>) =>
    h.login.handle({ version: 1, ...message }, popup);
  const offer = async () =>
    v.parse(manualOfferResponseSchema, await popupSends({ type: "login.manual.get", tabId: 1 }));
  const status = async () => {
    const answer = await offer();
    return answer.ok ? answer.status : undefined;
  };
  const methods = async () =>
    v.parse(ssoResponseSchema, await popupSends({ type: "login.sso.get", tabId: 1 }));
  const shown = async () => {
    const answer = await methods();
    if (!answer.ok || !answer.offer) throw new Error("No method offer");
    return answer.offer;
  };
  const choose = async (selection: SsoSelection) =>
    popupSends({
      type: "login.sso.choose",
      tabId: 1,
      offerId: (await shown()).id,
      selection,
    });
  const request = async (): Promise<ManualStartRequest> => {
    const answer = await offer();
    if (!answer.ok || !answer.targets[0]) throw new Error("No target: " + JSON.stringify(answer));
    return {
      requestId: "manual-request",
      document: answer.targets[0].document,
      scope: answer.targets[0].scope,
      connectionId,
      itemId,
    };
  };
  /**
   * The page shows its sign-in input, its method offer waits for the person, and it runs
   * out after `OFFER_MS` with nothing chosen (01:57 to 02:07:30 of #1687).
   */
  async function expire() {
    const first = h.signIn();
    await vi.waitFor(async () =>
      expect(await methods()).toMatchObject({ offer: { reason: "mapping-required" } }),
    );
    await vi.advanceTimersByTimeAsync(OFFER_MS);
    expect(await first).toEqual({ ok: false, reason: "expired" });
    expect(await methods()).toEqual({ ok: true });
  }
  /**
   * The person presses **Log in now**; the page announces itself again with its ready
   * first step, as the content script does.
   */
  async function logInNow() {
    const answered: unknown[] = [];
    fake.state.onReconnect = async () => {
      const answer = await h.hello();
      answered.push(answer);
      return answer;
    };
    const started = popupSends({ type: "login.manual.start", ...(await request()) });
    return { started, answered };
  }
  return { h, sso, uris, described, offer, status, methods, shown, choose, expire, logInNow };
}

beforeEach(() => {
  // Only `advanceTimersByTimeAsync` moves the clock: a method offer waits ten minutes.
  vi.setTimerTickMode("manual");
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.badges = {};
  fake.state.reconnects = [];
  fake.state.onReconnect = undefined;
  fake.state.messages = [];
  fake.state.granted = true;
  fake.state.pageUrl = origin + "/signin";
  fake.state.onExecute = undefined;
  fake.state.tabUrls = {};
  fake.state.observed = ["unique", "missing"];
  fake.state.observedPath = "/signin";
  fake.state.present = undefined;
  fake.state.unusable = new Set();
  fake.state.awaited = { ok: true };
  fake.state.onAwait = undefined;
  fake.state.executeReply = undefined;
  fake.state.gone = new Set();
  fake.state.goneFrames = new Set();
  fake.state.onPresent = undefined;
  fake.state.extracted = {};
  fake.state.signs = undefined;
  fake.state.loaded = true;
  fake.state.incognito = new Set();
  fake.state.openTabs = undefined;
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
  fake.state.replaced.length = 0;
  fake.state.updated.length = 0;
});

describe("Log in now after the page's SSO method offer expired (#1687)", () => {
  it("opens the method offer again and starts the login the person chooses there", async () => {
    const s = setup();
    await s.expire();
    const { started } = await s.logInNow();
    // The popup's start answers at once and says the request waits for the choice; it
    // never shows only "Preparing" while the method offer waits unseen.
    expect(await started).toEqual({ ok: true, state: "choosing" });
    expect(await s.status()).toEqual({ requestId: "manual-request", state: "choosing" });
    expect(await s.shown()).toMatchObject({
      password: true,
      methods: [{ method: { number: 1 }, reason: "mapping-required" }],
    });
    expect(await s.choose({ kind: "native", route: "password" })).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).not.toHaveLength(0));
    await vi.waitFor(async () =>
      expect(await s.status()).toEqual({ requestId: "manual-request", state: "started" }),
    );
    expect(s.h.fields).toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ connectionId, itemId }) }),
    );
  });

  it("goes on as evaluating once the method is chosen, before the login starts", async () => {
    const s = setup();
    await s.expire();
    const { started } = await s.logInNow();
    expect(await started).toEqual({ ok: true, state: "choosing" });
    // The page's recipe is read once the method was chosen.
    const reading = Promise.withResolvers<void>();
    const read = s.h.recipes.recipe.mock.calls.length;
    const recipe = s.h.recipes.recipe.getMockImplementation()!;
    s.h.recipes.recipe.mockImplementationOnce(async (...args) => {
      await reading.promise;
      return recipe(...args);
    });
    expect(await s.choose({ kind: "native", route: "password" })).toEqual({ ok: true });
    await vi.waitFor(() => expect(s.h.recipes.recipe.mock.calls.length).toBeGreaterThan(read));
    expect(await s.status()).toEqual({ requestId: "manual-request", state: "evaluating" });
    reading.resolve();
    await vi.waitFor(async () => expect(await s.status()).toMatchObject({ state: "started" }));
  });

  it("ends at once with the person's cancel of the method choice", async () => {
    const s = setup();
    await s.expire();
    const { started, answered } = await s.logInNow();
    expect(await started).toEqual({ ok: true, state: "choosing" });
    const offerId = (await s.shown()).id;
    expect(
      await s.h.login.handle({ version: 1, type: "login.sso.cancel", tabId: 1, offerId }, popup),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(answered).toEqual([{ ok: false, reason: "cancelled" }]));
    expect(await s.status()).toEqual({
      requestId: "manual-request",
      state: "blocked",
      reason: "cancelled",
    });
    expect(executes()).toEqual([]);
  });

  it("withdraws the method offer at once when the person cancels the request", async () => {
    const s = setup();
    await s.expire();
    const { started, answered } = await s.logInNow();
    expect(await started).toEqual({ ok: true, state: "choosing" });
    expect(
      await s.h.login.handle(
        { version: 1, type: "login.manual.cancel", tabId: 1, requestId: "manual-request" },
        popup,
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(answered).toEqual([{ ok: false, reason: "manual-request-ended" }]),
    );
    expect(await s.methods()).toEqual({ ok: true });
    expect(await s.status()).toMatchObject({ state: "blocked", reason: "cancelled" });
  });

  it("ends when its time runs out, with its offer, rather than ten minutes later", async () => {
    const s = setup();
    await s.expire();
    const { started, answered } = await s.logInNow();
    expect(await started).toEqual({ ok: true, state: "choosing" });
    await vi.advanceTimersByTimeAsync(MANUAL_START_MS);
    await vi.waitFor(() =>
      expect(answered).toEqual([{ ok: false, reason: "manual-request-ended" }]),
    );
    expect(await s.status()).toEqual({
      requestId: "manual-request",
      state: "blocked",
      reason: "choice-timed-out",
    });
    expect(await s.methods()).toEqual({ ok: true });
    expect(executes()).toEqual([]);
  });

  it("ends with the settings change that withdraws the offer (#1695 scope)", async () => {
    const s = setup();
    await s.expire();
    const { started, answered } = await s.logInNow();
    expect(await started).toEqual({ ok: true, state: "choosing" });
    // The site's own rules are among what the offer reads.
    s.h.settings.settings.excludedSites = [{ hostname: "login.example", includeSubdomains: true }];
    s.h.login.settingsChanged("synced");
    await vi.waitFor(() => expect(answered).toEqual([{ ok: false, reason: "settings-changed" }]));
    expect(await s.status()).toMatchObject({ state: "blocked", reason: "settings-changed" });
    expect(executes()).toEqual([]);
  });

  it("ends at once with the reason when the offer cannot open", async () => {
    const s = setup();
    await s.expire();
    s.sso.describe.mockResolvedValue({ ok: false, reason: "field-unreadable" });
    const { started } = await s.logInNow();
    expect(await started).toEqual({ ok: false, reason: "field-unreadable" });
    expect(await s.status()).toEqual({
      requestId: "manual-request",
      state: "blocked",
      reason: "field-unreadable",
    });
    expect(await s.methods()).toEqual({ ok: true });
  });

  it("ends at once with the reason when the offer refuses while it is built", async () => {
    const s = setup();
    await s.expire();
    // The page's read of the methods passes; the offer's own read finds a malformed field.
    s.sso.describe
      .mockResolvedValueOnce(s.described())
      .mockResolvedValueOnce({ ok: false, reason: "invalid-value" });
    const { started } = await s.logInNow();
    expect(await started).toEqual({ ok: false, reason: "invalid-value" });
    expect(await s.status()).toEqual({
      requestId: "manual-request",
      state: "blocked",
      reason: "invalid-value",
    });
  });

  it("keeps the one-page scope: a hop needs automatic sign-in on the site", async () => {
    const s = setup();
    await s.expire();
    s.h.settings.settings.sitePagePermissions = [
      { hostname: "login.example", includeSubdomains: false, permissions: { "sign-in": "fill" } },
    ];
    const { started, answered } = await s.logInNow();
    expect(await started).toEqual({ ok: true, state: "choosing" });
    const method = (await s.shown()).methods[0]!;
    const candidateId = method.candidates[0]!.id;
    expect(await s.choose({ kind: "sso", method: method.method, candidateId })).toEqual({
      ok: true,
    });
    await vi.waitFor(() =>
      expect(answered).toEqual([{ ok: false, reason: "sso-manual-scope-unavailable" }]),
    );
    expect(await s.status()).toMatchObject({
      state: "blocked",
      reason: "sso-manual-scope-unavailable",
    });
    expect(executes()).toEqual([]);
  });

  describe("a request the person ended while its page was read", () => {
    async function heldDescribe(outcome: "ok" | "fails") {
      const s = setup();
      await s.expire();
      const held = Promise.withResolvers<void>();
      s.sso.describe.mockImplementationOnce(async () => {
        await held.promise;
        return outcome === "ok"
          ? s.described()
          : { ok: false as const, reason: "field-unreadable" };
      });
      const { started, answered } = await s.logInNow();
      await vi.waitFor(() => expect(s.sso.describe).toHaveBeenCalledTimes(3));
      expect(
        await s.h.login.handle(
          { version: 1, type: "login.manual.cancel", tabId: 1, requestId: "manual-request" },
          popup,
        ),
      ).toEqual({ ok: true });
      held.resolve();
      expect(await started).toEqual({ ok: false, reason: "cancelled" });
      return { s, answered };
    }

    it("opens no method offer for it", async () => {
      const { s, answered } = await heldDescribe("ok");
      expect(answered).toEqual([{ ok: false, reason: "manual-request-ended" }]);
      expect(await s.methods()).toEqual({ ok: true });
      expect(await s.status()).toMatchObject({ state: "blocked", reason: "cancelled" });
    });

    it("keeps the reason it ended with", async () => {
      const { s, answered } = await heldDescribe("fails");
      expect(answered).toEqual([{ ok: false, reason: "field-unreadable" }]);
      expect(await s.status()).toMatchObject({ state: "blocked", reason: "cancelled" });
    });
  });
});
