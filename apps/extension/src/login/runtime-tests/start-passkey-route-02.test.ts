import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, recipe, liveItemPolicy, harness } =
  createRuntimeTestHarness(fake);

describe("the start page's passkey route (ADR 0027)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
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
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["password", "login", "Sign in with a passkey"]);
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.unusable = new Set();
  });
  const button = { by: "text" as const, value: "Sign in with a passkey" };
  const home = [{ target: target("logout") }];
  const { completion: _unlearned, ...unlearned } = recipe;
  const routed = parseLoginRecipe({
    ...unlearned,
    id: "synthetic-passkey-route",
    passkey: { path: "/signin", target: button },
  });
  void parseLoginRecipe({ ...routed, completion: home });
  const discoverable = () => vi.fn(async () => ({ passkey: true, discoverable: true }));

  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  void observation("/elsewhere", [
    { id: "c1", role: "link", target: target("help"), label: "Help" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target.value === value).length;
  const fills = () => executed().filter((step) => step.kind === "fill").length;
  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown }>,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click") return;
      const next = pages[step.target.value];
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };
  function generation(judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      // Like the service, it says just before the request leaves the device.
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  function start(
    used: LoginRecipe,
    live: Parameters<typeof harness>[1] = {},
    overrides: Partial<LocalSettings> = {},
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(overrides, { passkeys: discoverable(), report, ...live });
    h.recipes.recipe.mockResolvedValue(used);
    return { h, report };
  }
  async function until(check: () => boolean, maxMs = 200_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);
  describe("the held click", () => {
    const securityKey = { by: "text" as const, value: "Use security key" };
    const webauthnPage = observation("/login/webauthn", [
      { id: "c1", role: "button", target: securityKey, label: "Use security key" },
    ]);
    const toWebauthn = {
      path: "/login/webauthn",
      present: [securityKey.value],
      extracted: webauthnPage,
    };
    const signedIn = () => {
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
    };
    it("treats the clicking document as new after a worker restart and ends at once", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: { path: "/signin", present: [button.value] } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      // The hold lived in the old worker's memory; the same document announces itself again.
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = start(routed, { generation: service });
        await restarted.h.hello({}, false);
        // Well before the 3 seconds an unexplained page would get.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(status()![0]).toMatchObject({ state: "blocked", outcome: "challenge" });
      } finally {
        fake.browser.tabs.query = query;
      }
      expect(clicks(button.value)).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
    });
    it.each<[string, (h: ReturnType<typeof harness>) => void, Record<string, unknown>]>([
      [
        "a settings revision",
        (h) => {
          h.settings.revision += 1;
        },
        { cause: "settings-revision" },
      ],
      [
        "the item's exclusion",
        (h) => {
          h.settings.settings.itemPolicies = [liveItemPolicy(itemId, { excluded: true })];
        },
        { cause: "plan" },
      ],
    ])(
      "ends as a policy change, not a challenge, after %s during the hold",
      async (_l, edit, cause) => {
        vi.useFakeTimers();
        onClick({ [button.value]: { path: "/signin", present: [button.value] } });
        const service = generation(async () => ({ verdict: "signed-in" }));
        const { h, report } = start(routed, { generation: service });
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks(button.value) === 1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(status()![0]).toMatchObject({ state: "awaiting-result" });
        edit(h);
        await until(settled("blocked", "policy-changed"), 5_000);
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          route: "passkey",
          outcome: "policy-changed",
          ...cause,
        });
        // The page that follows is neither judged nor taken as signed in.
        signedIn();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(status()![0]).toMatchObject({ state: "blocked", outcome: "policy-changed" });
        expect(service.judge).not.toHaveBeenCalled();
      },
    );
    it("judges the page once the clicked button is only hidden in its document", async () => {
      vi.useFakeTimers();
      // An app that signs in with the passkey and keeps its sign-in view in the DOM, hidden.
      onClick({ [button.value]: { path: "/home", present: [button.value], extracted: homePage } });
      const clicked = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        await clicked(message, tabId);
        fake.state.unusable = new Set([button.value]);
      };
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      // Well before the held click's two minutes.
      await until(settled("authenticated"), 20_000);
      expect(status()![0]).toMatchObject({ route: "passkey", submissions: 1 });
      expect(clicks(button.value)).toBe(1);
      expect(service.judge).toHaveBeenCalledTimes(1);
    });
    it("names the login's item for the passkey bridge while the click is held", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: { path: "/signin", present: [button.value] } });
      const { h } = start(routed, { generation: generation() });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      await vi.advanceTimersByTimeAsync(60_000);
      // The passkey request the click causes is answered with this login's item only.
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      expect(await h.login.loginAccount(1, "https://other.example")).toBeUndefined();
      expect(await h.login.loginAccount(2, origin)).toBeUndefined();
      await until(settled("blocked", "challenge"));
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });
    it("takes over a revision that adds a handler, judging both pages on the passkey route", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: toWebauthn, [securityKey.value]: toHome });
      const taken = parseLoginRecipe({
        ...routed,
        revision: 2,
        handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
      });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: taken })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "passkey",
        recipeRevision: 2,
        handlers: [{ index: 0, start: 1 }],
        stepCount: 2,
        submissions: 2,
      });
      expect(status()![0]).not.toHaveProperty("variant");
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [routed.id, 1, "passkey", webauthnPage.observation],
        [routed.id, 2, "passkey", homePage.observation],
      ]);
      expect(clicks(button.value)).toBe(1);
      expect(clicks(securityKey.value)).toBe(1);
      expect(fills()).toBe(0);
    });
    it.each<[string, Record<string, unknown>]>([
      ["moves the passkey button", { passkey: { path: "/signin", target: target("other") } }],
      ["drops the passkey route", { passkey: undefined }],
    ])("keeps its revision and ends as a challenge when the next one %s", async (_l, change) => {
      vi.useFakeTimers();
      onClick({ [button.value]: toWebauthn, [securityKey.value]: toHome });
      const next = parseLoginRecipe({
        ...routed,
        revision: 2,
        handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
        ...change,
      });
      const service = generation();
      service.judge.mockResolvedValueOnce({ verdict: "challenge", recipe: next });
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"), 20_000);
      expect(status()![0]).toMatchObject({ route: "passkey", recipeRevision: 1, handlers: [] });
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(clicks(securityKey.value)).toBe(0);
    });
  });
});
