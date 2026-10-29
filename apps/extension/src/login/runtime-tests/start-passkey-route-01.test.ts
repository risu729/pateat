import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  recipeStartSteps,
  type LocalSettings,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  itemId,
  snapshotId,
  target,
  startsOf,
  recipe,
  userId,
  savedBinding,
  uriMatch,
  harness,
  realTime,
} = createRuntimeTestHarness(fake);

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
  const learned = parseLoginRecipe({ ...routed, completion: home });
  const discoverable = () => vi.fn(async () => ({ passkey: true, discoverable: true }));
  const secondFactor = () => vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const elsewhere = observation("/elsewhere", [
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
  it("clicks the passkey button for an item with a discoverable passkey and never fills", async () => {
    onClick({ [button.value]: toHome });
    const { h } = start(learned);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "passkey", stepCount: 1, submissions: 1 });
    expect(status()![0]).not.toHaveProperty("variant");
    expect(executed()).toEqual([
      { kind: "click", path: "/signin", target: button, purpose: "submit" },
    ]);
    // The click carries no values, and no vault field is read.
    const execute = fake.state.messages.find((entry) => entry.type === "login.execute")!;
    expect(execute.values).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("fills the password route for an item whose passkey is only a second factor", async () => {
    fake.state.present = new Set(["password", "login", "Sign in with a passkey", "logout"]);
    fake.state.observedPath = "/home";
    const { h } = start(learned, { passkeys: secondFactor() });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "password", variant: 0 });
    expect(fills()).toBe(1);
    expect(clicks(button.value)).toBe(0);
    expect(clicks("login")).toBe(1);
  });
  it("fills the password route on a site whose passkey requests go to the browser (ADR 0007)", async () => {
    fake.state.present = new Set(["password", "login", "Sign in with a passkey", "logout"]);
    fake.state.observedPath = "/home";
    const passkeys = discoverable();
    const { h } = start(
      learned,
      { passkeys },
      { passkeyBrowserSites: [{ hostname: new URL(origin).hostname }] },
    );
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({
      route: "password",
      variant: 0,
      facts: { passkey: false, discoverablePasskey: false },
    });
    expect(fills()).toBe(1);
    expect(clicks(button.value)).toBe(0);
    // The item's passkeys are not even looked up there.
    expect(passkeys).not.toHaveBeenCalled();
  });
  it('treats a hostname chosen "Always" as listed while its write waits (ADR 0007)', async () => {
    fake.state.present = new Set(["password", "login", "Sign in with a passkey", "logout"]);
    fake.state.observedPath = "/home";
    const passkeys = discoverable();
    const pendingBrowserSite = vi.fn((page: string) => page === origin);
    const { h } = start(learned, { passkeys, pendingBrowserSite });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "password", facts: { passkey: false } });
    expect(clicks(button.value)).toBe(0);
    expect(passkeys).not.toHaveBeenCalled();
    expect(pendingBrowserSite).toHaveBeenCalledWith(origin);
  });
  it("never takes the passkey route on such a site, even for an item without a password", async () => {
    // As in the test below, only the passkey route could sign this item in.
    const custom = parseLoginRecipe({
      ...learned,
      slots: ["member-number", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "member-number", target: target("member") },
            { slot: "password", target: target("password") },
          ],
        },
        recipe.steps[1]!,
      ],
    });
    const passkeys = discoverable();
    const { h } = start(
      custom,
      { passkeys },
      { bindings: [], passkeyBrowserSites: [{ hostname: new URL(origin).hostname }] },
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "binding-not-found" });
    expect(clicks(button.value)).toBe(0);
    expect(passkeys).not.toHaveBeenCalled();
  });
  it("takes the passkey route for an item without a password or a fitting binding", async () => {
    onClick({ [button.value]: toHome });
    // The password variant fills a custom slot this item has no binding for, and the
    // item's password is empty: the password route would refuse.
    const custom = parseLoginRecipe({
      ...learned,
      slots: ["member-number", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "member-number", target: target("member") },
            { slot: "password", target: target("password") },
          ],
        },
        recipe.steps[1]!,
      ],
    });
    const { h } = start(custom, {}, { bindings: [] });
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields =
          response.catalog.connections[0]!.items[0]!.fields.map((field) =>
            field.id === "login.password" ? { ...field, empty: true as const } : field,
          );
      return response;
    });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({
      route: "passkey",
      facts: { password: false, discoverablePasskey: true },
    });
    expect(fills()).toBe(0);
    // Without the passkey, the same item refuses as before.
    const refused = start(custom, { passkeys: secondFactor() }, { bindings: [] });
    refused.h.store.handle.mockImplementation(h.store.handle.getMockImplementation()!);
    expect(await refused.h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
  });
  it("watches the passkey button first and stops when it never shows, filling nothing", async () => {
    const { h } = start(learned);
    h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: recipeStartSteps(learned) }]);
    const watched = await h.hello({}, false);
    expect(watched).toMatchObject({ ok: false, reason: "form-not-ready" });
    expect(
      (watched as { starts: { targets: unknown[] }[] }).starts.map((entry) => entry.targets),
    ).toEqual([[button], [target("password")]]);
    // The password form was ready, but the chosen route's button never appears.
    fake.state.awaited = { ok: false, reason: "timeout" };
    expect(await h.hello({ documentId: "ready-document" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([
        { route: "passkey", state: "blocked", outcome: "retry-limit", submissions: 0 },
      ]),
    );
    const awaited = fake.state.messages.find((entry) => entry.type === "login.await") as
      | { readiness: { targets: unknown[] } }
      | undefined;
    expect(awaited?.readiness.targets).toEqual([button]);
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("holds the page while the button shows and judges it on the passkey route once gone", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/signin", present: [button.value] } });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    // A WebAuthn exchange or a chooser the person answers keeps the button showing.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ state: "awaiting-result" });
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["logout"]);
    fake.state.extracted = { "signed-in": homePage };
    await until(settled("authenticated"));
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(service.judge).toHaveBeenCalledWith(
      routed.id,
      routed.revision,
      "passkey",
      homePage.observation,
      expect.any(Function),
      undefined,
      undefined,
      undefined,
      expect.any(Array),
    );
    // The button is no input: only the form's fields need one (ADR 0029 S1).
    const read = fake.state.messages
      .filter((entry) => entry.type === "login.observe")
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => Array.isArray(entry["require"]))
      .flatMap((entry) =>
        (entry["targets"] as LoginTarget[]).map((observed, index) => ({
          button: observed.value === button.value,
          require: (entry["require"] as string[])[index],
        })),
      );
    const inputs = ["input", "shown-input"];
    expect(read.filter((entry) => entry.button).length).toBeGreaterThan(0);
    expect(read.filter((entry) => entry.button && inputs.includes(entry.require!))).toEqual([]);
    expect(read.some((entry) => !entry.button && inputs.includes(entry.require!))).toBe(true);
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });
  it("ends challenge on the passkey route when the judge answers optional (ADR 0065)", async () => {
    vi.useFakeTimers();
    const checkup = observation("/checkup", [
      { id: "c1", role: "button", target: target("remind-later"), label: "Remind me later" },
    ]);
    onClick({ [button.value]: { path: "/checkup", present: [], extracted: checkup } });
    const clicked = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      await clicked(message, tabId);
      // No sign of a sign-in step and no evidence of one (ADR 0029).
      if (fake.state.observedPath === "/checkup")
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
    };
    const service = generation(async () => ({ verdict: "optional" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    // A page the route's own checks do not prove ends the passkey route `challenge`.
    await until(settled("blocked", "challenge"));
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });
  it("holds the clicking document whatever path a same-document URL change gives it", async () => {
    vi.useFakeTimers();
    // The page moves to another path with pushState while its passkey prompt still shows.
    onClick({ [button.value]: { path: "/signin/verify", present: [button.value] } });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ state: "awaiting-result" });
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["logout"]);
    fake.state.extracted = { "signed-in": homePage };
    await until(settled("authenticated"));
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });
  it("ends as a challenge when the button still shows after two minutes", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/signin", present: [button.value] } });
    const service = generation();
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    await vi.advanceTimersByTimeAsync(115_000);
    expect(status()![0]).toMatchObject({ state: "awaiting-result" });
    await until(settled("blocked", "challenge"), 10_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });
  it("leaves a new document that shows the button again to the person at once", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/signin", present: [button.value, "password"] } });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    // The page reloads back to the start page, which shows the button and the form again.
    await h.hello({ documentId: "reloaded" }, false);
    await until(settled("blocked", "challenge"), 5_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("never sends the start page that shows the password form again without the button", async () => {
    vi.useFakeTimers();
    // The click re-renders the start page's password form in the same document.
    onClick({
      [button.value]: {
        path: "/signin",
        present: ["password", "login"],
        extracted: observation("/signin", [
          { id: "c1", role: "password", target: target("password"), label: "Password" },
          { id: "c2", role: "button", target: target("login"), label: "Log in" },
        ]),
      },
    });
    const service = generation(async () => ({ verdict: "rejected" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "challenge"), 20_000);
    // Judging it would spend the start path's one judgement and could add a handler there.
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it.each<[string, LoginGeneration["judge"] | undefined]>([
    ["unclear", async () => ({ verdict: "unclear" })],
    ["rejected", async () => ({ verdict: "rejected" })],
    ["challenge without a handler", async () => ({ verdict: "challenge" })],
    ["a temporary refusal", async () => ({ verdict: "retry", reason: "busy" })],
    ["no judgement at all", undefined],
  ])("ends as a challenge after %s, never typing the password", async (_label, judge) => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/elsewhere", present: [], extracted: elsewhere } });
    const service = judge ? generation(judge) : undefined;
    const { h } = start(routed, service ? { generation: service } : {});
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "challenge"), 20_000);
    if (service) {
      expect(service.judge).toHaveBeenCalledTimes(1);
      // The account's slots go with the page, but the route reads no vault value for their
      // shapes (owner 2026-10-23, ADR 0027).
      const slots = service.judge.mock.calls[0]![8];
      expect(slots).toContainEqual(expect.objectContaining({ fieldName: "Branch" }));
      expect(JSON.stringify(slots)).not.toContain("valueShape");
    }
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(status()![0]!["settled"]).toBeUndefined();
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
  });
  describe("reads the page's sign-in state as the password route does (owner, 2026-10-24)", () => {
    const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
    it("completes on the username in the header, without the judge", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: { path: "/elsewhere", present: [], extracted: elsewhere } });
      fake.state.signs = { ...quiet, username: true };
      const service = generation();
      const { h, report } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"), 20_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "state",
          route: "passkey",
          e2: true,
          decision: "signed-in",
        }),
      );
      expect(fills()).toBe(0);
    });
    it("completes a quiet page the judge found signed in before, after Pateat's answer", async () => {
      vi.useFakeTimers();
      fake.state.signs = quiet;
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind !== "click" || step.target.value !== button.value) return;
        fake.state.observedPath = "/elsewhere";
        fake.state.present = new Set();
        fake.state.extracted = { "signed-in": elsewhere };
        h.login.passkeyRequested(1, origin);
        vi.setSystemTime(Date.now() + 1);
        h.login.passkeyAnswered(1, origin, "login.example");
      };
      const service = generation(async () => ({ verdict: "unclear", reason: "judged-signed-in" }));
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"), 20_000);
      expect(service.judge).toHaveBeenCalledTimes(1);
    });
    it("leaves a quiet page undecided when no passkey answer went back", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: { path: "/elsewhere", present: [], extracted: elsewhere } });
      fake.state.signs = quiet;
      const service = generation(async () => ({ verdict: "unclear", reason: "judged-signed-in" }));
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"), 20_000);
    });
    it("ends as a challenge when the site asks for a passkey again after the answer", async () => {
      vi.useFakeTimers();
      fake.state.signs = quiet;
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind !== "click" || step.target.value !== button.value) return;
        fake.state.observedPath = "/elsewhere";
        fake.state.present = new Set();
        fake.state.extracted = { "signed-in": elsewhere };
        // Pateat answers the button's request, then the site asks for another passkey.
        h.login.passkeyAnswered(1, origin, "login.example");
        vi.setSystemTime(Date.now() + 1);
        h.login.passkeyRequested(1, origin);
      };
      const service = generation(async () => ({ verdict: "unclear", reason: "judged-signed-in" }));
      const { h, report } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"), 20_000);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "state", s5: true, decision: "continuing" }),
      );
    });
    it("counts no request before the answer, as the button's own", async () => {
      vi.useFakeTimers();
      fake.state.signs = { ...quiet, username: true };
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind !== "click" || step.target.value !== button.value) return;
        fake.state.observedPath = "/elsewhere";
        fake.state.present = new Set();
        fake.state.extracted = { "signed-in": elsewhere };
        h.login.passkeyRequested(1, origin);
        vi.setSystemTime(Date.now() + 1);
        h.login.passkeyAnswered(1, origin, "login.example");
      };
      const service = generation();
      const { h, report } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"), 20_000);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "state", s5: false, decision: "signed-in" }),
      );
    });
  });
  it("ends as a challenge on the rejection marker", async () => {
    onClick({ [button.value]: { path: "/signin", present: ["rejected"] } });
    const { h } = start(parseLoginRecipe({ ...learned, rejection: target("rejected") }));
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
    );
    expect(fills()).toBe(0);
  });
  it("saves only the site default after a signed-in page, never a binding", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: toHome });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
    const { h } = start(
      routed,
      { generation: service, uris, allowedOrigins: [] },
      { siteDefaults: [], bindings: [] },
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => h.store.update.mock.calls.length === 1);
    expect(status()![0]).toMatchObject({ state: "authenticated", route: "passkey" });
    expect(h.settings.settings.siteDefaults).toEqual([
      {
        origin,
        provider: "bitwarden",
        server: "cloud-us",
        userId,
        itemId,
        itemName: "Synthetic item",
        accountName: "Synthetic live vault",
      },
    ]);
    expect(h.settings.settings.bindings).toEqual([]);
  });
  it("still runs a handler on the page after the passkey click", async () => {
    const securityKey = { by: "text" as const, value: "Use security key" };
    onClick({
      [button.value]: { path: "/login/webauthn", present: [securityKey.value] },
      [securityKey.value]: toHome,
    });
    const { h } = start(
      parseLoginRecipe({
        ...learned,
        handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
      }),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(
      executed().map((step) => (step.kind === "click" ? step.target.value : step.kind)),
    ).toEqual([button.value, securityKey.value]);
    expect(status()![0]).toMatchObject({
      route: "passkey",
      handlers: [{ index: 0, start: 1 }],
      stepCount: 2,
    });
  }, 10_000);
  it("resumes on the passkey route without reading the facts again", async () => {
    realTime();
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    onClick({ [button.value]: { path: "/next", present: [] } });
    const { h, report } = start(learned, { passkeys });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicks(button.value)).toBe(1));
    // The passkey is removed from the vault meanwhile; the running login keeps its route.
    passkeys.mockResolvedValue({ passkey: false, discoverable: false });
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["logout"]);
    await h.hello({ documentId: "next-page" }, false);
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(passkeys).toHaveBeenCalledTimes(1);
    expect(fills()).toBe(0);
    // Diagnostics name the route without a variant and never the item's facts.
    const attempts = report.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === "attempt");
    expect(attempts).not.toEqual([]);
    for (const entry of attempts) {
      expect(entry).toMatchObject({ route: "passkey" });
      expect(entry).not.toHaveProperty("variant");
    }
    const serialized = JSON.stringify(report.mock.calls);
    for (const key of ['"facts"', '"discoverablePasskey"', '"discoverable"', '"totp"'])
      expect(serialized).not.toContain(key);
  });
  it("presses a passkey-only page's button again after a logout (#833, ADR 0062)", async () => {
    const only = parseLoginRecipe({
      version: 1,
      id: "synthetic-passkey-only",
      revision: 1,
      origin,
      pageKind: "sign-in",
      slots: [],
      passkeyOnly: true,
      passkey: { path: "/signin", target: button },
      steps: [{ kind: "click", path: "/signin", target: button, purpose: "submit" }],
      completion: home,
      maxSubmissions: 1,
    });
    onClick({ [button.value]: toHome });
    const { h, report } = start(only);
    h.recipes.starts.mockResolvedValue(startsOf(only.steps));
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(clicks(button.value)).toBe(1);
    // A page of the site without the button only watches for it.
    expect(await h.hello({ documentId: "home" }, false)).toMatchObject({
      ok: false,
      reason: "logged-in",
    });
    // The site logs out: the same tab shows the start page with its button again, and the
    // passkey route presses it again, as on any visit (#833, ADR 0062).
    const first = status()![0]!["id"];
    fake.state.observedPath = "/signin";
    fake.state.present = new Set([button.value]);
    expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "authenticated", route: "passkey" }]),
    );
    expect(status()![0]!["id"]).not.toBe(first);
    expect(clicks(button.value)).toBe(2);
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.badges[1]?.text ?? "").not.toMatch(/^\d+$/u);
    expect(
      report.mock.calls.filter(([entry]) => entry.type === "start").map(([entry]) => entry),
    ).toEqual([
      expect.objectContaining({ tabId: 1, recipeId: only.id }),
      expect.objectContaining({ tabId: 1, recipeId: only.id }),
    ]);
  });
  describe("a totp handler after the passkey click, probed independently", () => {
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const withCode = parseLoginRecipe({ ...learned, handlers: [codeHandler] });
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
    const handlerOutcomes = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome]] : [],
      );
    const withTotp = (h: ReturnType<typeof harness>) => {
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          response.catalog.connections[0]!.items[0]!.fields.push({
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
          });
        return response;
      });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
    };
    it("types the code on the page after the passkey click and keeps the route", async () => {
      onClick({ [button.value]: toCode, verify: toHome });
      const { h, report } = start(withCode);
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(status()![0]).toMatchObject({
        route: "passkey",
        facts: { totp: true },
        handlers: [{ index: 0, start: 1 }],
        stepCount: 3,
        submissions: 2,
      });
      expect(
        executed().map((step) => (step.kind === "click" ? step.target.value : step.kind)),
      ).toEqual([button.value, "fill", "verify"]);
      expect(codeFills().map((entry) => entry.values)).toEqual([
        [{ slot: "totp", value: "012345", secret: "otp" }],
      ]);
      // Only the code is read; no password is.
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.totp-code"]);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
      // Nothing is saved for the passkey route's login.
      expect(h.settings.settings.bindings).toEqual([savedBinding]);
    }, 10_000);
    const namedFor = (field: "username" | { custom: string }) => [
      {
        ...savedBinding,
        recipeId: withCode.id,
        slots: [
          { slot: "password", field: "password" as const },
          { slot: "totp", field },
        ],
      },
    ];
    const branchId = `custom.${snapshotId}.0`;
    it("types a code made from a custom field a saved binding names on this route", async () => {
      onClick({ [button.value]: toCode, verify: toHome });
      // The item's custom field `Branch` is a Text field holding a TOTP key.
      const { h, report } = start(
        withCode,
        { custom: [{ name: "Branch", kind: "text", totpSeed: true }] },
        { bindings: namedFor({ custom: "Branch" }) },
      );
      withTotp(h);
      h.fields.mockImplementation(async ({ fieldId, code }) =>
        code && fieldId === branchId ? "654321" : undefined,
      );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(status()![0]).toMatchObject({ route: "passkey", facts: { totp: true } });
      expect(codeFills().map((entry) => entry.values)).toEqual([
        [{ slot: "totp", value: "654321", secret: "otp" }],
      ]);
      // Only the code is read, as a code from the named field; no password is.
      expect(h.fields.mock.calls.map(([request]) => [request.fieldId, request.code])).toEqual([
        [branchId, true],
      ]);
      expect(clicks("verify")).toBe(1);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
    }, 10_000);
    it.each([
      ["a Linked custom field", { custom: "Branch" }, true],
      ["the username", "username", false],
    ] as const)(
      "never makes a code from %s a saved binding names on this route",
      async (_label, field, linked) => {
        onClick({ [button.value]: toCode, verify: toHome });
        const { h, report } = start(
          withCode,
          {
            username: true,
            ...(linked
              ? { custom: [{ name: "Branch", kind: "linked", linkedFieldId: "login.password" }] }
              : {}),
          },
          { bindings: namedFor(field) },
        );
        withTotp(h);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
        );
        expect(status()![0]).toMatchObject({ route: "passkey", facts: { totp: false } });
        expect(h.fields).not.toHaveBeenCalled();
        expect(codeFills()).toEqual([]);
        expect(handlerOutcomes(report)).toEqual([[0, "totp", "missing-fact"]]);
      },
    );
    it("takes over a revision that adds a totp handler on the passkey route", async () => {
      vi.useFakeTimers();
      const codePage = observation("/two-factor", [
        {
          id: "c1",
          role: "text",
          target: target("app-code"),
          label: "Code",
          autocomplete: "one-time-code",
        },
        { id: "c2", role: "button", target: target("verify"), label: "Verify" },
      ]);
      onClick({ [button.value]: { ...toCode, extracted: codePage }, verify: toHome });
      const taken = parseLoginRecipe({ ...routed, revision: 2, handlers: [codeHandler] });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: taken })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const { h } = start(routed, { generation: service });
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "passkey",
        recipeRevision: 2,
        handlers: [{ index: 0, start: 1 }],
        stepCount: 3,
        submissions: 2,
      });
      expect(service.judge.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        [1, "passkey"],
        [2, "passkey"],
      ]);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(clicks(button.value)).toBe(1);
    });
    it("leaves a code page shown again in a new document to the person on this route", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: toCode, verify: toCode });
      const { h, report } = start(withCode);
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("verify") === 1);
      fake.state.pageUrl = `${origin}/two-factor`;
      await h.hello({ documentId: "again" }, false);
      await until(settled("blocked", "challenge"), 5_000);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(handlerOutcomes(report)).toEqual([
        [0, "totp", "entered"],
        [0, "totp", "shown-again"],
      ]);
    });
  });
  describe("the held click", () => {
    const securityKey = { by: "text" as const, value: "Use security key" };
    void observation("/login/webauthn", [
      { id: "c1", role: "button", target: securityKey, label: "Use security key" },
    ]);

    it("never runs a start-page handler on a new document that shows the button again", async () => {
      vi.useFakeTimers();
      // A handler on the start path, such as a key prompt, shows beside the button.
      const prompted = parseLoginRecipe({
        ...routed,
        handlers: [{ kind: "passkey", path: "/signin", target: securityKey }],
      });
      onClick({ [button.value]: { path: "/signin", present: [button.value, securityKey.value] } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h } = start(prompted, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      // The clicking document holds: the handler is not entered while its button shows.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(clicks(securityKey.value)).toBe(0);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", handlers: [] });
      // The tab reloads back to the start page: it goes to the person at once.
      await h.hello({ documentId: "reloaded" }, false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(clicks(securityKey.value)).toBe(0);
      expect(clicks(button.value)).toBe(1);
      expect(status()![0]).toMatchObject({
        route: "passkey",
        state: "blocked",
        outcome: "challenge",
        handlers: [],
      });
      expect(service.judge).not.toHaveBeenCalled();
    });
  });
});
