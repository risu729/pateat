import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  laterStartSteps,
  parseLoginRecipe,
  type LocalSettings,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import { laterReadiness } from "../wire";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, harness } = createRuntimeTestHarness(fake);

describe("an item without a password, up to its password (ADR 0036)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0)) listener(1);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    // Next leads to the password page in the same document.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "next") {
        fake.state.observedPath = "/password";
        fake.state.present = new Set(["password", "login"]);
      }
    };
  });
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "synthetic-email-first",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
      {
        kind: "fill",
        path: "/password",
        fields: [{ slot: "password", target: target("password") }],
      },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  function start(
    live: Parameters<typeof harness>[1] = {},
    {
      password = false,
      overrides = {},
    }: { password?: boolean; overrides?: Partial<LocalSettings> } = {},
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(overrides, {
      username: true,
      report,
      passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
      ...live,
    });
    h.recipes.recipe.mockResolvedValue(emailFirst);
    const original = h.store.handle.getMockImplementation()!;
    if (!password)
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          for (const field of response.catalog.connections[0]!.items[0]!.fields)
            if (field.id === "login.password") field.empty = true;
        return response;
      });
    return { h, report };
  }
  async function until(check: () => boolean, maxMs = 60_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const ask = (h: ReturnType<typeof harness>) => {
    let decided: ConditionalDecision | undefined;
    void h.login
      .conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
      })
      .then((value) => (decided = value));
    return () => decided;
  };
  const answered = (decision: ConditionalDecision | undefined) => {
    expect(decision).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
    return decision as Extract<ConditionalDecision, { kind: "answer" }>;
  };
  const attempts = (report: ReturnType<typeof start>["report"]) =>
    report.mock.calls.flatMap(([entry]) => (entry.type === "attempt" ? [entry] : []));
  const judgements = (report: ReturnType<typeof start>["report"]) =>
    report.mock.calls.flatMap(([entry]) => (entry.type === "judge" ? [entry] : []));

  const nextLeadsTo = (path: string, then?: () => void) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "next") {
        fake.state.observedPath = path;
        fake.state.present = new Set();
        then?.();
      }
    };
  };
  const described = (path: string) => ({
    ok: true,
    observation: {
      version: 1,
      origin,
      path,
      language: "en",
      complete: true,
      candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
    },
  });
  type JudgeAnswer = Awaited<ReturnType<LoginGeneration["judge"]>>;
  const judging = (answer: JudgeAnswer) => {
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return answer;
    });
    return {
      judge,
      generation: {
        available: vi.fn<LoginGeneration["available"]>(async () => true),
        generate: vi.fn<LoginGeneration["generate"]>(),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge,
        slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      },
    };
  };
  const passwordRead = (h: ReturnType<typeof harness>) =>
    h.fields.mock.calls.some(([read]) => read.fieldId === "login.password");
  describe("a passkey button beside the stop's password field", () => {
    const securityKey = target("use-passkey");
    const learned = parseLoginRecipe({
      ...emailFirst,
      revision: 2,
      handlers: [{ kind: "passkey", path: "/password", target: securityKey }],
    });
    const passwordPage = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/password",
        language: "en",
        complete: true,
        candidates: [
          { id: "c1", role: "password", target: target("password"), label: "Password" },
          { id: "c2", role: "button", target: target("login"), label: "Sign in" },
          { id: "c3", role: "button", target: securityKey, label: "Sign in with a passkey" },
        ],
      },
    };
    const withButton = (h: () => ReturnType<typeof harness>) => {
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click" && step.target.value === "next") {
          fake.state.observedPath = "/password";
          fake.state.present = new Set(["password", "login", "use-passkey"]);
          fake.state.extracted = { "signed-in": passwordPage };
        }
        if (step.kind === "click" && step.target.value === "use-passkey")
          h().login.passkeyAnswered(1, origin, "login.example");
      };
    };
    const pressed = () =>
      executed().filter((step) => step.kind === "click" && step.target.value === "use-passkey")
        .length;
    it("does not judge a stop's page that no longer shows the password field", async () => {
      vi.useFakeTimers();
      const { judge, generation } = judging({ verdict: "challenge", recipe: learned });
      const { h } = start({ generation });
      // The password page shows, then its field goes before the three seconds are over.
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click" && step.target.value === "next") {
          fake.state.observedPath = "/password";
          fake.state.present = new Set(["password", "login"]);
          fake.state.extracted = { "signed-in": passwordPage };
          setTimeout(() => (fake.state.present = new Set(["login"])), 1_000);
        }
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2 });
      expect(status()![0]).not.toHaveProperty("stopJudged");
      expect(judge).not.toHaveBeenCalled();
    });
    it("types the password of an item that holds one, never pressing a learned button", async () => {
      vi.useFakeTimers();
      const { judge, generation } = judging({ verdict: "unclear" });
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      const started = start({ generation }, { password: true });
      h = started.h;
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 4);
      expect(executed()).toEqual([
        expect.objectContaining({ kind: "fill", path: "/signin" }),
        expect.objectContaining({ kind: "click", target: target("next") }),
        expect.objectContaining({ kind: "fill", path: "/password" }),
        expect.objectContaining({ kind: "click", target: target("login") }),
      ]);
      expect(status()![0]).not.toHaveProperty("stopAt");
      // The password page shows again with the button after the submission, as after a wrong
      // password: the button is still not pressed while the password field shows.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pressed()).toBe(0);
      expect(status()![0]).toMatchObject({ handlers: [] });
      expect(passwordRead(h)).toBe(true);
      // No page of a login that types its password is judged as a stop's.
      for (const call of judge.mock.calls) expect(call[7]).toBeUndefined();
    });
    it("never presses a learned button while an in-place form swaps in its password field", async () => {
      vi.useFakeTimers();
      // One path: the email, Next, then the password swapped in, with the passkey button
      // shown throughout, learned at another login's stop.
      const inPlace = parseLoginRecipe({
        version: 1,
        id: "synthetic-in-place",
        revision: 2,
        origin,
        pageKind: "sign-in",
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "username", target: target("email") }],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "password", target: target("password") }],
          },
          { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
        ],
        handlers: [{ kind: "passkey", path: "/signin", target: securityKey }],
        maxSubmissions: 2,
      });
      const { judge, generation } = judging({ verdict: "unclear" });
      const { h } = start({ generation }, { password: true });
      h.recipes.recipe.mockResolvedValue(inPlace);
      fake.state.present = new Set(["email", "next", "use-passkey"]);
      // After Next the email field is disabled, and the password field shows two seconds
      // later: in between, no fill field of the route can be typed in.
      fake.state.onExecute = async (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click" && step.target.value === "next") {
          fake.state.unusable = new Set(["email"]);
          setTimeout(() => {
            fake.state.present = new Set(["email", "password", "login", "use-passkey"]);
          }, 2_000);
        }
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 4);
      expect(executed()).toEqual([
        expect.objectContaining({
          kind: "fill",
          fields: [expect.objectContaining({ slot: "username" })],
        }),
        expect.objectContaining({ kind: "click", target: target("next") }),
        expect.objectContaining({
          kind: "fill",
          fields: [expect.objectContaining({ slot: "password" })],
        }),
        expect.objectContaining({ kind: "click", target: target("login") }),
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pressed()).toBe(0);
      expect(status()![0]).toMatchObject({ handlers: [] });
      expect(judge.mock.calls.every((call) => call[7] === undefined)).toBe(true);
    });
    it("does not judge the stop's page again for a path that has a passkey handler", async () => {
      vi.useFakeTimers();
      const { judge, generation } = judging({ verdict: "challenge", recipe: learned });
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      const shows = fake.state.onExecute!;
      // The learned button is not on the page this time.
      fake.state.onExecute = async (message, tabId) => {
        await shows(message, tabId);
        fake.state.present?.delete("use-passkey");
      };
      const started = start({ generation });
      h = started.h;
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, stopAt: 2 });
      expect(status()![0]).not.toHaveProperty("stopJudged");
      expect(attempts(started.report).at(-1)).toMatchObject({ reason: "password-empty" });
      expect(judge).not.toHaveBeenCalled();
      expect(pressed()).toBe(0);
    });
    it("keeps a login that only fills while its tab asks from judging its stop, its lines marked (ADR 0066)", async () => {
      vi.useFakeTimers();
      // The password page also asks for the username. This tab logged out of the site (ADR
      // 0021 D) and shows that page, where the item's login starts at a later step (ADR
      // 0049), fills the username and stops at the password.
      const confirming = parseLoginRecipe({
        ...emailFirst,
        id: "synthetic-confirming",
        steps: [
          emailFirst.steps[0],
          emailFirst.steps[1],
          {
            kind: "fill",
            path: "/password",
            fields: [{ slot: "username", target: target("account") }],
          },
          ...emailFirst.steps.slice(2),
        ],
      });
      fake.state.session["pateat.login-stopped-asks.v1"] = [{ tabId: 1, origin }];
      fake.state.pageUrl = "https://login.example/password";
      fake.state.observedPath = "/password";
      fake.state.present = new Set(["account", "password", "login"]);
      fake.state.extracted = { "signed-in": passwordPage };
      fake.state.onExecute = undefined;
      const { judge, generation } = judging({ verdict: "unclear" });
      const { h, report } = start({ generation });
      h.recipes.recipe.mockImplementation(async (_origin, path) =>
        path === "/signin" ? confirming : undefined,
      );
      h.recipes.starts.mockResolvedValue([
        {
          path: "/signin",
          steps: [confirming.steps[0]!],
          later: laterStartSteps(confirming).map(laterReadiness),
        },
      ]);
      Object.assign(h.recipes, {
        later: vi.fn(async (_origin: string, path: string) =>
          path === "/password" ? [confirming] : [],
        ),
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(
        report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "start"),
      ).toMatchObject({ fillOnly: true, startStep: 2 });
      expect(executed().map((step) => step.kind)).toEqual(["fill"]);
      // The attempt contract refuses such a login a judgement at its stop, so it writes no
      // `recipe.judge` line; its end names the stop's reason, and the mark still keeps that
      // warning on the device.
      expect(judge).not.toHaveBeenCalled();
      expect(judgements(report)).toEqual([]);
      expect(attempts(report).at(-1)).toMatchObject({
        state: "watching",
        reason: "password-empty",
        fillOnly: true,
      });
      for (const entry of attempts(report)) expect(entry).toHaveProperty("fillOnly", true);
      expect(passwordRead(h)).toBe(false);
    });
    it("does not judge the stop's page again after a restart during the request", async () => {
      vi.useFakeTimers();
      const first = judging({ verdict: "unclear" });
      // The request never answers: the worker stops while it is out.
      first.judge.mockImplementation(async (...args) => {
        args[4]?.();
        return new Promise(() => undefined);
      });
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      h = start({ generation: first.generation }).h;
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["stopJudged"] === true);
      expect(first.judge).toHaveBeenCalledTimes(1);
      expect(status()![0]).toMatchObject({ state: "ready", stepIndex: 2, stopAt: 2 });
      fake.state.messages = [];
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const second = judging({ verdict: "challenge", recipe: learned });
        const restarted = start({ generation: second.generation });
        h = restarted.h;
        void h.hello({ documentId: "after-restart" }, false);
        await until(() => status()?.[0]?.["state"] === "watching");
        // The attempt sent its page already: not again, and nothing is pressed.
        expect(second.judge).not.toHaveBeenCalled();
        expect(judgements(restarted.report)).toContainEqual(
          expect.objectContaining({ verdict: "not-sent", reason: "stop-judged", stop: "password" }),
        );
        expect(status()![0]).toMatchObject({
          outcome: "challenge",
          stepIndex: 2,
          stopJudged: true,
        });
        expect(attempts(restarted.report).at(-1)).toMatchObject({ reason: "password-empty" });
        expect(pressed()).toBe(0);
        expect(passwordRead(h)).toBe(false);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("presses the button for a login with a password once that field is gone", async () => {
      vi.useFakeTimers();
      const { generation } = judging({ verdict: "unclear" });
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      const started = start({ generation }, { password: true });
      h = started.h;
      h.recipes.recipe.mockResolvedValue(learned);
      const typed = fake.state.onExecute!;
      // After the password, the same path asks only for the passkey, as a second factor.
      fake.state.onExecute = async (message, tabId) => {
        await typed(message, tabId);
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "click" && step.target.value === "login")
          fake.state.present = new Set(["use-passkey"]);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => pressed() === 1);
      expect(executed().map((step) => step.kind)).toEqual([
        "fill",
        "click",
        "fill",
        "click",
        "click",
      ]);
      expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 4 }] });
    });
  });
  describe("on a recipe that ends at Continue, its password page not generated yet", () => {
    const identifierFirst = (maxSubmissions: number) =>
      parseLoginRecipe({
        version: 1,
        id: "synthetic-identifier-first",
        revision: 1,
        origin,
        pageKind: "sign-in",
        slots: ["username"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/signin",
            fields: [{ slot: "username", target: target("email") }],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        ],
        maxSubmissions,
      });
    let clickedAt: number | undefined;
    function begin(
      path: string,
      then?: (h: ReturnType<typeof harness>) => void,
      { maxSubmissions = 2, live = {} }: { maxSubmissions?: number; live?: object } = {},
    ) {
      const { judge, generation } = judging({ verdict: "unclear" });
      const started = start({ generation, ...live });
      started.h.recipes.recipe.mockResolvedValue(identifierFirst(maxSubmissions));
      clickedAt = undefined;
      nextLeadsTo(path, () => {
        clickedAt = Date.now();
        then?.(started.h);
      });
      return { ...started, judge, generation };
    }
    const reachedStop = () => status()?.[0]?.["stepIndex"] === 2 && status()?.[0]?.["stopAt"] === 2;
    it("judges the page Continue loads, then stops there when it moves nothing on", async () => {
      vi.useFakeTimers();
      const { h, report, judge, generation } = begin("/verify");
      // The page after Continue shows no sign-in input, only something to describe.
      fake.state.extracted = { "signed-in": described("/verify") };
      expect(await h.hello()).toEqual({ ok: true });
      expect(status()![0]).toMatchObject({ route: "password", stepCount: 2, stopAt: 2 });
      await until(reachedStop);
      // Neither asked for a passkey nor continued (no URI matcher here), the page is judged
      // once the step's wait ran out; an undecided answer takes the login to its stop.
      expect(Date.now() - clickedAt!).toBeGreaterThanOrEqual(9_500);
      expect(judge).toHaveBeenCalledTimes(1);
      await until(() => status()?.[0]?.["state"] === "watching");
      // No request came: it ends challenge, watched, naming the missing password.
      expect(status()![0]).toMatchObject({
        outcome: "challenge",
        stepIndex: 2,
        stopAt: 2,
        submissions: 1,
      });
      expect(attempts(report).at(-1)).toMatchObject({
        state: "watching",
        stop: "password",
        reason: "password-empty",
      });
      expect(executed()).toEqual([
        expect.objectContaining({ kind: "fill", path: "/signin" }),
        expect.objectContaining({ kind: "click", target: target("next") }),
      ]);
      expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "refused" }));
      expect(generation.generate).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });
    it("presses a passkey button that shows at the stop past the plan's last step", async () => {
      vi.useFakeTimers();
      const { h, judge } = begin("/signin");
      const key = target("use-passkey");
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({
          ...identifierFirst(2),
          handlers: [{ kind: "passkey", path: "/signin", target: key }],
        }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(reachedStop);
      // The button shows once the login stands at its stop, where no step is.
      fake.state.present = new Set(["use-passkey"]);
      await until(() => executed().length === 3);
      expect(executed()[2]).toMatchObject({ kind: "click", path: "/signin", target: key });
      // The handler went in at the stop, which stays just past the plan's last step.
      expect(status()![0]).toMatchObject({
        stepCount: 3,
        stopAt: 3,
        submissions: 2,
        // The recipe's two, the click's one and the one kept for an answer at the stop.
        maxSubmissions: 4,
        handlers: [{ index: 0, start: 2 }],
      });
      expect(judge).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });
    it("stops once the step's budget runs out on a page that stays on its path", async () => {
      vi.useFakeTimers();
      const { h, judge, generation } = begin("/signin");
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clickedAt !== undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
      await until(reachedStop);
      expect(Date.now() - clickedAt!).toBeGreaterThanOrEqual(9_500);
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2 });
      expect(generation.generate).not.toHaveBeenCalled();
      expect(judge).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });
    it("stops on a request the bridge answered after Continue, as its answer", async () => {
      vi.useFakeTimers();
      const { h, generation } = begin("/signin", (login) =>
        login.login.passkeyAnswered(1, origin, "login.example"),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(
        () => status()?.[0]?.["state"] === "reconciling" && status()?.[0]?.["submissions"] === 2,
      );
      expect(Date.now() - clickedAt!).toBeLessThan(5_000);
      expect(status()![0]).toMatchObject({ stepIndex: 2, stopAt: 2 });
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
      expect(generation.generate).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });
    it("answers a request the page makes after Continue with the item", async () => {
      vi.useFakeTimers();
      let decided: (() => ConditionalDecision | undefined) | undefined;
      const { h, generation } = begin("/signin", (login) => {
        decided = ask(login);
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => decided?.() !== undefined);
      expect(Date.now() - clickedAt!).toBeLessThan(5_000);
      // Recorded as a submission at the stop before the answer went back.
      expect(status()![0]).toMatchObject({
        state: "reconciling",
        stepIndex: 2,
        stopAt: 2,
        submissions: 2,
      });
      answered(decided!());
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
      expect(generation.generate).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });
    it("answers the request on a recipe whose budget is Continue's one submission", async () => {
      vi.useFakeTimers();
      // A recipe of the email and Continue needs only one submission, as a generated one may
      // record; the answer at the stop is one more.
      let decided: (() => ConditionalDecision | undefined) | undefined;
      const { h } = begin(
        "/signin",
        (login) => {
          decided = ask(login);
        },
        { maxSubmissions: 1 },
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => decided?.() !== undefined);
      answered(decided!());
      expect(status()![0]).toMatchObject({ state: "reconciling", stepIndex: 2, submissions: 2 });
    });
    it("does not take a request waiting from before Continue as the stop's", async () => {
      vi.useFakeTimers();
      const { h } = begin("/signin");
      const decided = ask(h);
      // Time passes between the request and the login's first step, as it does on a page.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clickedAt !== undefined);
      // Right after Continue the waiting request says nothing about the page it led to.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(decided()).toBeUndefined();
      expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
      // At the stop, once the step's budget ran out, it is answered as a waiting one.
      await until(() => decided() !== undefined);
      expect(Date.now() - clickedAt!).toBeGreaterThanOrEqual(9_500);
      answered(decided());
      expect(status()![0]).toMatchObject({ stepIndex: 2, submissions: 2 });
    });
    it("holds the answered page while it stays on the path the answer was given on", async () => {
      vi.useFakeTimers();
      let decided: (() => ConditionalDecision | undefined) | undefined;
      const { h } = begin("/verify", (login) => {
        decided = ask(login);
      });
      // The page has something to describe, so it is not taken for one still loading.
      fake.state.extracted = { "signed-in": described("/verify") };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => decided?.() !== undefined);
      answered(decided!()).answered(true);
      const since = Date.now();
      await until(() => status()?.[0]?.["state"] !== "reconciling");
      expect(Date.now() - since).toBeGreaterThanOrEqual(14_000);
      expect(Date.now() - since).toBeLessThan(17_000);
      expect(status()![0]).toMatchObject({ stepIndex: 2, submissions: 2 });
      expect(passwordRead(h)).toBe(false);
    });
    it("holds an answered page that shows nothing yet past the 15 seconds", async () => {
      vi.useFakeTimers();
      let decided: (() => ConditionalDecision | undefined) | undefined;
      const { h, judge } = begin("/verify", (login) => {
        decided = ask(login);
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => decided?.() !== undefined);
      answered(decided!()).answered(true);
      // A loader: nothing a signed-in page's description could carry (ADR 0034's hold).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(status()![0]).toMatchObject({ state: "reconciling", stepIndex: 2 });
      expect(judge).not.toHaveBeenCalled();
    });
    it("does not hold the answered page once it leaves that path", async () => {
      vi.useFakeTimers();
      let decided: (() => ConditionalDecision | undefined) | undefined;
      const { h } = begin("/verify", (login) => {
        decided = ask(login);
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => decided?.() !== undefined);
      answered(decided!()).answered(true);
      const since = Date.now();
      fake.state.observedPath = "/home";
      await until(() => status()?.[0]?.["state"] !== "reconciling");
      expect(Date.now() - since).toBeLessThan(14_000);
      expect(passwordRead(h)).toBe(false);
    });
    it("still refuses an item without a passkey, naming it", async () => {
      const { h, report } = begin("/signin", undefined, {
        live: { passkeys: vi.fn(async () => ({ passkey: false, discoverable: false })) },
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refused",
          reason: "no-route",
          detail: "password-empty:no-passkey",
        }),
      );
      expect(executed()).toEqual([]);
      expect(status() ?? []).toEqual([]);
    });
  });
});
