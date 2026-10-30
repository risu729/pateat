import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginChooserRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, uriMatch, harness } = createRuntimeTestHarness(fake);

describe("a chooser's passkey button beside its list (ADR 0079)", () => {
  afterEach(() => {
    vi.useRealTimers();
    fake.state.signIn = false;
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    vi.useFakeTimers();
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
    fake.state.present = new Set([button.value]);
    fake.state.unusable = new Set();
    fake.state.signIn = false;
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });
  const button = { by: "text" as const, value: "Sign in with a passkey" };
  const other = { by: "text" as const, value: "Sign in with another profile" };
  const home = [{ target: target("logout") }];
  const homePage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/home",
      language: "en",
      complete: true,
      candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
    },
  };
  const chooser: LoginChooserRecipe = {
    version: 1,
    id: "gen-synthetic-chooser",
    revision: 1,
    origin,
    layout: "1000",
    chooser: {
      path: "/signin",
      other,
      passkey: parseLoginRecipe({
        version: 1,
        id: "gen-synthetic-chooser",
        revision: 1,
        origin,
        layout: "1000",
        pageKind: "sign-in",
        slots: [],
        passkeyOnly: true,
        passkey: { path: "/signin", target: button },
        steps: [{ kind: "click", path: "/signin", target: button, purpose: "submit" }],
        completion: home,
        maxSubmissions: 1,
      }),
    },
  };
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const clicks = () =>
    fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
      list?: Record<string, unknown>;
      operation: { step: { kind: string; target?: { value: string } } };
    }[];
  async function until(check: () => boolean, maxMs = 200_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true as const, data: uriMatch() }));
  const generation = () => ({
    available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
    generate: vi.fn<LoginGeneration["generate"]>(async () => ({
      outcome: "abstained",
      reason: "ambiguous",
    })),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "signed-in" };
    }),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  });
  const onList = (discoverable: boolean, reports?: LoginReport[]) => {
    const h = harness(
      { siteDefaults: [], bindings: [] },
      {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: generation(),
        passkeys: vi.fn(async () => ({ passkey: discoverable, discoverable })),
        ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
      },
    );
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.chooser.mockResolvedValue(chooser);
    h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: [], list: [other] }]);
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || step.target?.value !== button.value) return;
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
    };
    return h;
  };
  it("presses the button for an account whose item holds a discoverable passkey", async () => {
    const reports: LoginReport[] = [];
    const h = onList(true, reports);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "authenticated");
    expect(clicks().map((entry) => entry.operation.step.target?.value)).toEqual([button.value]);
    // The list's entry is never clicked, so no list rides on the click.
    expect(clicks()[0]).not.toHaveProperty("list");
    expect(h.fields).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({
      recipeId: chooser.id,
      route: "passkey",
      chooser: { click: "passkey" },
    });
    expect(reports.find((entry) => entry.type === "start")).toMatchObject({ click: "passkey" });
  });
  it("clicks the list's entry for an account whose item has no passkey", async () => {
    const h = onList(false);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks().length > 0);
    expect(clicks()[0]!.operation.step.target?.value).toBe("[account]");
    expect(clicks()[0]!.list).toMatchObject({ click: "entry" });
    expect(status()![0]).toMatchObject({ chooser: { click: "entry" } });
    expect(status()![0]).not.toMatchObject({ route: "passkey" });
  });
});
