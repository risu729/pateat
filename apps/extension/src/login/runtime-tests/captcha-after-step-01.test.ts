import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, startsOf, uriMatch, harness } = createRuntimeTestHarness(fake);

// A site that asks for a CAPTCHA only once its button was pressed, as Epic Games' email step
// did on 2026-11-07 (issue #1379): the person solves it, and the page goes on in the same
// document (ADR 0029, S4, amendment of 2026-11-07).
describe("a CAPTCHA the page shows after a step (ADR 0029, S4)", () => {
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
    fake.state.present = new Set(["email", "next"]);
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
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "gen-synthetic-captcha",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    ],
    maxSubmissions: 1,
  });
  const continued = parseLoginRecipe({
    ...emailFirst,
    revision: 2,
    slots: ["username", "password"],
    steps: [
      ...emailFirst.steps,
      { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("password") }] },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  const describedPage = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const passwordPage = describedPage("/signin", [
    { id: "c1", role: "password", target: target("password"), label: "Password" },
    { id: "c2", role: "button", target: target("login"), label: "Log in" },
  ]);
  const homePage = describedPage("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  const unsolved = { ...quiet, captcha: true, captchaUnsolved: true };
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => {
        const { step } = (
          entry as unknown as {
            operation: {
              step: {
                kind: string;
                target?: { value: string };
                fields?: { target: { value: string } }[];
              };
            };
          }
        ).operation;
        return `${step.kind}:${step.target?.value ?? step.fields?.map((field) => field.target.value).join(",")}`;
      });
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
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true as const, data: uriMatch() }));
  function generation(generate: LoginGeneration["generate"]) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(generate),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return { verdict: "signed-in" };
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  /** A login whose Next brings up a CAPTCHA, and the service that continues its recipe. */
  function start(report?: LoginReport[]) {
    let h!: ReturnType<typeof harness>;
    const service = generation(async () => {
      h.recipes.recipe.mockResolvedValue(continued);
      return { outcome: "recipe" as const, recipe: continued as LoginRecipe };
    });
    h = harness(
      { siteDefaults: [], bindings: [] },
      {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        ...(report ? { report: (value: LoginReport) => report.push(value) } : {}),
      },
    );
    h.recipes.recipe.mockResolvedValue(emailFirst);
    h.recipes.starts.mockResolvedValue(startsOf([emailFirst.steps[0]!]));
    fake.state.signs = quiet;
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click") return;
      // The CAPTCHA opens over the email form, whose button waits meanwhile.
      if (step.target?.value === "next") {
        fake.state.signs = unsolved;
        fake.state.unusable = new Set(["next"]);
      }
      if (step.target?.value === "login") {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.signIn = false;
        fake.state.signs = quiet;
        fake.state.extracted = { "signed-in": homePage };
      }
    };
    return { h, service };
  }
  /** The site's answer to the solved CAPTCHA: the password step, in the same document. */
  const passwordStep = () => {
    fake.state.signs = { ...quiet, password: true };
    fake.state.unusable = new Set(["email", "next"]);
    fake.state.present = new Set(["email", "next", "password", "login"]);
    fake.state.signIn = true;
    fake.state.extracted = { login: passwordPage };
  };
  const unsettled = () => {
    expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
    expect(status()![0]!["outcome"]).toBeUndefined();
  };
  it("waits while the person solves it, then continues on the step the page shows", async () => {
    const reports: LoginReport[] = [];
    const { h, service } = start(reports);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    // Longer than the advance's own wait: the result is neither settled nor judged.
    await vi.advanceTimersByTimeAsync(60_000);
    unsettled();
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toHaveProperty("timing.personSince", expect.any(Number));
    expect(reports).toContainEqual(
      expect.objectContaining({ type: "attempt", cause: "captcha-shown" }),
    );
    passwordStep();
    await until(settled("authenticated"));
    expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(status()![0]).not.toHaveProperty("timing.personSince");
    const signedIn = reports.find(
      (entry) => entry.type === "attempt" && entry.state === "authenticated",
    ) as { times: Record<string, number> };
    expect(signedIn.times["personMs"]).toBeGreaterThanOrEqual(50_000);
  });
  it("keeps following when the CAPTCHA closes and the person presses the button again", async () => {
    const { h, service } = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(20_000);
    // Closed without the page going on: the email form and its button show again.
    fake.state.signs = quiet;
    fake.state.unusable = new Set();
    await vi.advanceTimersByTimeAsync(60_000);
    unsettled();
    // The person presses Next, solves the CAPTCHA it brings up, and the page goes on.
    fake.state.signs = unsolved;
    fake.state.unusable = new Set(["next"]);
    await vi.advanceTimersByTimeAsync(30_000);
    unsettled();
    passwordStep();
    await until(settled("authenticated"));
    // Pateat pressed Next once; the person's press is theirs.
    expect(executed()).toEqual(["fill:email", "click:next", "fill:password", "click:login"]);
    expect(service.generate).toHaveBeenCalledTimes(1);
  });
  it("ends as a challenge once the CAPTCHA was left unsolved for two minutes", async () => {
    const { h, service } = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(100_000);
    unsettled();
    await until(settled("watching", "challenge"), 60_000);
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
  });
  it("settles the email form as before once no CAPTCHA showed", async () => {
    const { h, service } = start();
    fake.state.onExecute = undefined;
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 60_000);
    expect(service.generate).not.toHaveBeenCalled();
  });
});
