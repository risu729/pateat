import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginStep } from "@pateat/contracts";
import { createLoginBadge, memoryBadgeStorage, type BadgeDetails } from "../badge";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, excludingLive, harness } =
  createRuntimeTestHarness(fake);

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
  it("fills the identifier, stops before the password and ends challenge, watched", async () => {
    vi.useFakeTimers();
    const { h, report } = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, stopAt: 2 });
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).not.toContain("login.password");
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attempt",
        state: "watching",
        stop: "password",
        reason: "password-empty",
        // A watched login says so, so its first result is sent when the watch ends.
        watched: true,
      }),
    );
  });
  it("answers the document's waiting request at the stop as one submission", async () => {
    vi.useFakeTimers();
    const { h } = start();
    let decided: ConditionalDecision | undefined;
    void h.login
      .conditionalRequest({
        tabId: 1,
        origin,
        documentId: "synthetic-document",
        signal: new AbortController().signal,
      })
      .then((value) => (decided = value));
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => decided !== undefined);
    expect(decided).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
    expect(status()![0]).toMatchObject({ state: "reconciling", stepIndex: 2, submissions: 2 });
    (decided as Extract<ConditionalDecision, { kind: "answer" }>).answered(true);
    // The password form still shows: held for 15 seconds, then left to the person.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(status()![0]).toMatchObject({ state: "reconciling" });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge" });
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
  });
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
  const quiet = (message: Record<string, unknown>) => ({
    password: false,
    code: false,
    captcha: false,
    invalid: false,
    alert: false,
    username: (message["account"] as { username?: string } | undefined)?.username !== undefined,
  });
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
  it("names its stop in every report of the login", async () => {
    vi.useFakeTimers();
    const { h, report } = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    const reports = attempts(report);
    expect(reports.length).toBeGreaterThan(1);
    for (const entry of reports) expect(entry).toMatchObject({ stop: "password" });
    // Only the end at the stop names the missing password.
    expect(reports.filter((entry) => entry.reason === "password-empty")).toEqual([
      expect.objectContaining({ state: "watching", outcome: "challenge", stepIndex: 2 }),
    ]);
    // The stop waits a moment for a request before it ends.
    expect(passwordRead(h)).toBe(false);
  });
  it("waits three seconds at the stop for a request before it ends", async () => {
    vi.useFakeTimers();
    const { h } = start();
    let reached: number | undefined;
    nextLeadsTo("/password", () => {
      fake.state.present = new Set(["password", "login"]);
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => {
      if (reached === undefined && status()?.[0]?.["stepIndex"] === 2) reached = Date.now();
      return status()?.[0]?.["state"] === "watching";
    });
    expect(Date.now() - reached!).toBeGreaterThanOrEqual(2_900);
    expect(Date.now() - reached!).toBeLessThan(4_000);
  });
  it("answers at the stop a request that came after the identifier's submission", async () => {
    vi.useFakeTimers();
    const { h } = start();
    let decided: (() => ConditionalDecision | undefined) | undefined;
    // The password page asks for a passkey by itself once Next was clicked.
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind === "click" && step.target.value === "next") {
        fake.state.observedPath = "/password";
        fake.state.present = new Set(["password", "login"]);
        decided = ask(h);
      }
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => decided?.() !== undefined);
    // Recorded as a submission at the stop before the answer went back.
    expect(status()![0]).toMatchObject({ state: "reconciling", stepIndex: 2, submissions: 2 });
    answered(decided!());
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("counts a request the bridge answered after the identifier as the stop's answer", async () => {
    vi.useFakeTimers();
    const { h } = start();
    // A request that showed a prompt, answered with the login's item, then the tab moves to
    // another page of the passkey's site.
    nextLeadsTo("/password", () => {
      fake.state.present = new Set(["password", "login"]);
      h.login.passkeyAnswered(1, origin, "login.example");
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(
      () => status()?.[0]?.["state"] === "reconciling" && status()?.[0]?.["submissions"] === 2,
    );
    expect(status()![0]).toMatchObject({ stepIndex: 2, stopAt: 2 });
    fake.state.signs = quiet;
    fake.state.tabUrls[1] = "https://www.login.example/home";
    // The new page is read a second apart before the move completes the login.
    void h.hello({ documentId: "home-document", url: "https://www.login.example/home" }, false);
    await until(() => status()?.[0]?.["state"] === "authenticated");
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("holds the answered login for 15 seconds while the password form shows", async () => {
    vi.useFakeTimers();
    const { h, report } = start();
    const decided = ask(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => decided() !== undefined);
    answered(decided()).answered(true);
    const since = Date.now();
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(Date.now() - since).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - since).toBeLessThan(17_000);
    expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, submissions: 2 });
    expect(attempts(report).at(-1)).toMatchObject({
      state: "watching",
      stop: "password",
      reason: "password-empty",
    });
    expect(passwordRead(h)).toBe(false);
  });
  it("ends at the stop when the bridge could not answer", async () => {
    vi.useFakeTimers();
    const { h, report } = start();
    const decided = ask(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => decided() !== undefined);
    answered(decided()).answered(false);
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", submissions: 2 });
    expect(attempts(report).at(-1)).toMatchObject({
      state: "watching",
      cause: "answer-failed",
      reason: "password-empty",
    });
  });
  it("still refuses an item whose password the account may not fill", async () => {
    const excluded = excludingLive(["login.password"]);
    // A route that fills the password cannot bind it.
    const bound = start({}, { password: true, overrides: excluded });
    expect(await bound.h.hello()).toEqual({ ok: false, reason: "binding-field-excluded" });
    // A route that binds only the identifier ends no-route, naming the password apart from
    // an empty one.
    const { h, report } = start({}, { password: true, overrides: excluded });
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...emailFirst,
        id: "synthetic-identifier-only",
        slots: ["username"],
        steps: emailFirst.steps.slice(0, 2),
        maxSubmissions: 1,
      }),
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "refused",
        reason: "no-route",
        detail: "password-not-allowed",
      }),
    );
    expect(executed()).toEqual([]);
    expect(status() ?? []).toEqual([]);
  });
  it("still refuses an item without a passkey, as without a password", async () => {
    const { h, report } = start({
      passkeys: vi.fn(async () => ({ passkey: false, discoverable: false })),
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    // The log names why it does not go on to a passkey, never a value.
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "refused",
        reason: "no-route",
        detail: "password-empty:no-passkey",
      }),
    );
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("refuses a passkey-only item on a site whose passkey requests go to the browser, naming the list", async () => {
    // ADR 0007: the item holds a passkey, which Pateat does not use there.
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    const { h, report } = start(
      { passkeys },
      { overrides: { passkeyBrowserSites: [{ hostname: new URL(origin).hostname }] } },
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "refused",
        reason: "no-route",
        detail: "password-empty:passkey-browser-site",
      }),
    );
    expect(passkeys).not.toHaveBeenCalled();
    expect(executed()).toEqual([]);
  });
  it("badges the refusal of an item without a passkey and tells the popup why", async () => {
    const setBadge = vi.fn(async (_details: BadgeDetails) => undefined);
    const tabBadge = createLoginBadge({ setBadge, storage: memoryBadgeStorage() });
    const { h } = start({
      passkeys: vi.fn(async () => ({ passkey: false, discoverable: false })),
      badge: tabBadge,
      report: (entry) => tabBadge.observe(entry),
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    await vi.waitFor(() =>
      expect(setBadge).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tabId: 1,
          text: "!",
          title:
            "Pateat: the login did not succeed (no-route: password-empty:no-passkey). Click for details.",
        }),
      ),
    );
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    expect(
      await h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup),
    ).toMatchObject({
      ok: true,
      origin,
      recipe: "page",
      refused: { reason: "no-route", detail: "password-empty:no-passkey" },
    });
  });
  it("still refuses an item without a password in a frame, naming the frame", async () => {
    const { h, report } = start();
    // The tab shows another page of the site around the frame that shows the sign-in.
    const top = "https://login.example/account";
    fake.state.tabUrls[1] = top;
    expect(
      await h.hello({ frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } }),
    ).toEqual({ ok: false, reason: "no-route" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "refused",
        reason: "no-route",
        detail: "password-empty:frame",
      }),
    );
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(status() ?? []).toEqual([]);
  });
  it("still refuses a form that asks for the password with the identifier", async () => {
    const { h, report } = start();
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...emailFirst,
        id: "synthetic-one-page",
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "username", target: target("email") },
              { slot: "password", target: target("password") },
            ],
          },
          { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
        ],
        maxSubmissions: 1,
      }),
    );
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    // No advance comes before the password, so the log names that.
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "refused",
        reason: "no-route",
        detail: "password-empty:no-advance",
      }),
    );
    expect(executed()).toEqual([]);
  });
  it("completes on a page after the identifier that the judge finds signed in", async () => {
    vi.useFakeTimers();
    const { judge, generation } = judging({ verdict: "signed-in" });
    const { h, report } = start({ generation });
    nextLeadsTo("/verify");
    fake.state.signs = quiet;
    fake.state.extracted = { "signed-in": described("/verify") };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "authenticated");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]!.slice(0, 3)).toEqual([
      emailFirst.id,
      emailFirst.revision,
      "password",
    ]);
    expect(judgements(report).at(-1)).toMatchObject({ verdict: "signed-in" });
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("never sends a page beside the sign-in form after the identifier", async () => {
    vi.useFakeTimers();
    const { judge, generation } = judging({ verdict: "unclear" });
    const { h, report } = start({ generation });
    // Next keeps the identifier's form shown on its path, beside a form that asks for a
    // detail.
    nextLeadsTo("/signin", () => {
      fake.state.present = new Set(["email", "next", "birth", "submit"]);
    });
    fake.state.signs = quiet;
    fake.state.extracted = {
      "signed-in": {
        ok: true,
        observation: {
          version: 1,
          origin,
          path: "/signin",
          language: "en",
          complete: true,
          candidates: [
            { id: "c1", role: "email", target: target("email"), group: "side" },
            { id: "c2", role: "button", target: target("next"), label: "Next", group: "side" },
            {
              id: "c3",
              role: "text",
              target: target("birth"),
              label: "Birth year and month",
              group: "box",
            },
            { id: "c4", role: "button", target: target("submit"), label: "Log in", group: "box" },
          ],
        },
      },
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => judgements(report).length > 0);
    expect(judge).not.toHaveBeenCalled();
    expect(judgements(report)).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "sign-in-shown" }),
    ]);
    expect(passwordRead(h)).toBe(false);
  });
  it("completes on a page after the identifier judged signed-in before", async () => {
    vi.useFakeTimers();
    const { judge, generation } = judging({ verdict: "unclear", reason: "judged-signed-in" });
    const { h, report } = start({ generation });
    nextLeadsTo("/verify");
    fake.state.signs = quiet;
    fake.state.extracted = { "signed-in": described("/verify") };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "authenticated");
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judgements(report).at(-1)).toMatchObject({
      verdict: "unclear",
      reason: "judged-signed-in",
      completed: true,
    });
    expect(judgements(report).at(-1)).not.toHaveProperty("notCompleted");
    expect(passwordRead(h)).toBe(false);
  });
  it.each([undefined, "already-judged", "judgement-limit", "daily-limit", "timeout"])(
    "ends challenge, watched, when the judge cannot decide the page after the identifier (%s)",
    async (reason) => {
      vi.useFakeTimers();
      const { judge, generation } = judging({
        verdict: "unclear",
        ...(reason ? { reason } : {}),
      } as JudgeAnswer);
      const { h, report } = start({ generation });
      nextLeadsTo("/verify");
      fake.state.signs = quiet;
      fake.state.extracted = { "signed-in": described("/verify") };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 1 });
      expect(judge).toHaveBeenCalledTimes(1);
      expect(judgements(report).at(-1)).toMatchObject({
        verdict: "unclear",
        notCompleted: "password-empty",
      });
      expect(judgements(report).at(-1)).not.toHaveProperty("completed");
      expect(passwordRead(h)).toBe(false);
    },
  );
  it("judges a later page of the login watched at its stop and completes it signed in", async () => {
    vi.useFakeTimers();
    // Watched at the stop with nothing in flight, the login judges the watch's own pages as
    // any watched login does (ADR 0036 rules 4 and 5, ADR 0027).
    const { judge, generation } = judging({ verdict: "signed-in" });
    const { h, report } = start({ generation });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, stopAt: 2 });
    expect(status()![0]!["operationId"]).toBeUndefined();
    const sent = judge.mock.calls.length;
    // The person signs in some other way; the tab opens a page of the origin.
    fake.state.signs = quiet;
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    fake.state.present = new Set();
    fake.state.extracted = { "signed-in": described("/home") };
    expect(await h.hello({ documentId: "home-document" }, false)).toMatchObject({ ok: true });
    await until(() => status()?.[0]?.["state"] !== "watching");
    expect(judge).toHaveBeenCalledTimes(sent + 1);
    expect(status()![0]).toMatchObject({ state: "authenticated", outcome: "authenticated" });
    expect(judgements(report).at(-1)).toMatchObject({ verdict: "signed-in", watched: true });
    expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
    expect(passwordRead(h)).toBe(false);
  });
  it("keeps the login watched at its stop when a later page is judged rejected", async () => {
    vi.useFakeTimers();
    // No password was submitted, so the judge's rejection refuses none (ADR 0036).
    const { judge, generation } = judging({ verdict: "rejected" });
    const { h, report } = start({ generation });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    const sent = judge.mock.calls.length;
    fake.state.signs = quiet;
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    fake.state.present = new Set();
    fake.state.extracted = { "signed-in": described("/home") };
    expect(await h.hello({ documentId: "home-document" }, false)).toMatchObject({ ok: true });
    await until(() => judge.mock.calls.length === sent + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(status()![0]).toMatchObject({ state: "watching", outcome: "challenge" });
    expect(judgements(report).at(-1)).toMatchObject({ verdict: "rejected", watched: true });
    expect(passwordRead(h)).toBe(false);
  });
  it("stays watched at its stop when a later page is judged optional (ADR 0065)", async () => {
    vi.useFakeTimers();
    // No password was submitted, so an optional page proves no sign-in.
    const { judge, generation } = judging({ verdict: "optional" });
    const { h, report } = start({ generation });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    const sent = judge.mock.calls.length;
    fake.state.signs = quiet;
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    fake.state.present = new Set();
    fake.state.extracted = { "signed-in": described("/home") };
    expect(await h.hello({ documentId: "home-document" }, false)).toMatchObject({ ok: true });
    await until(() => judge.mock.calls.length === sent + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(status()![0]).toMatchObject({ state: "watching", outcome: "challenge" });
    expect(judgements(report).at(-1)).toMatchObject({ verdict: "optional", watched: true });
    expect(passwordRead(h)).toBe(false);
  });
  it("ends challenge, watched, at the stop on an optional answer (ADR 0065)", async () => {
    vi.useFakeTimers();
    const { judge, generation } = judging({ verdict: "optional" });
    const { h, report } = start({ generation });
    nextLeadsTo("/verify");
    fake.state.signs = quiet;
    fake.state.extracted = { "signed-in": described("/verify") };
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 1 });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judgements(report).at(-1)).toMatchObject({
      verdict: "optional",
      notCompleted: "password-empty",
    });
    expect(judgements(report).at(-1)).not.toHaveProperty("completed");
    expect(passwordRead(h)).toBe(false);
  });
  it("ends at the stop when the attempt refuses the answer", async () => {
    vi.useFakeTimers();
    // A login left at its stop by a stopped worker, with its submissions spent.
    const first = start();
    expect(await first.h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    const { watch: _watch, outcome: _outcome, ...record } = status()![0] as Record<string, unknown>;
    expect(record).toMatchObject({ stepIndex: 2, stopAt: 2, maxSubmissions: 2 });
    fake.state.storage["pateat.login-attempts.v5"] = [
      { ...record, state: "ready", submissions: 2 },
    ];
    fake.state.messages = [];
    fake.state.observedPath = "/password";
    fake.state.present = new Set(["password", "login"]);
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    try {
      const { h, report } = start();
      // The password page of the restarted worker asks for a passkey by itself.
      let decided: ConditionalDecision | undefined;
      void h.login
        .conditionalRequest({
          tabId: 1,
          origin,
          documentId: "after-restart",
          signal: new AbortController().signal,
        })
        .then((value) => (decided = value));
      await vi.advanceTimersByTimeAsync(0);
      void h.hello({ documentId: "after-restart" }, false);
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, submissions: 2 });
      expect(attempts(report).at(-1)).toMatchObject({
        state: "watching",
        reason: "password-empty",
      });
      // The request is not the login's to answer: it is handed on once the login ended.
      await until(() => decided !== undefined);
      expect(decided).toMatchObject({ kind: "delegate" });
      expect(executed()).toEqual([]);
      expect(passwordRead(h)).toBe(false);
    } finally {
      fake.browser.tabs.query = query;
    }
  });
  it("is not signed in by the username in the header after the identifier", async () => {
    vi.useFakeTimers();
    const { h, report } = start();
    nextLeadsTo("/verify");
    fake.state.signs = quiet;
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "watching");
    expect(status()![0]).toMatchObject({ outcome: "challenge" });
    // The page is never told the username, so it cannot show it as a sign-in.
    const states = fake.state.messages.filter((entry) => entry.type === "login.state");
    expect(states).not.toEqual([]);
    for (const entry of states) expect(entry).not.toHaveProperty("account");
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", e2: false, decision: "judge" }),
    );
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).not.toContain("login.password");
  });
  it("is signed in by the username in the header with a password, as before", async () => {
    vi.useFakeTimers();
    // The same pages for an item that holds its password: no stop, so E2 counts.
    const { h } = start({}, { password: true });
    nextLeadsTo("/verify");
    fake.state.signs = quiet;
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => status()?.[0]?.["state"] === "authenticated");
    expect(status()![0]).not.toHaveProperty("stopAt");
    expect(fake.state.messages.some((entry) => entry.type === "login.state" && entry.account)).toBe(
      true,
    );
  });
  it.each([
    ["is not signed in by", false, { state: "blocked", outcome: "left-origin" }],
    ["with a password is signed in by", true, { state: "authenticated" }],
  ] as const)(
    "%s the username on another origin of the site its tab moved to",
    async (_label, password, expected) => {
      vi.useFakeTimers();
      const { h } = start({ allowedOrigins: [origin] }, { password });
      // Next never answers: the tab moves to another origin of the site meanwhile.
      fake.state.onExecute = (message) => {
        const step = (message["operation"] as { step: LoginStep }).step;
        return step.kind === "click" ? new Promise(() => undefined) : Promise.resolve();
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      fake.state.signs = quiet;
      fake.state.tabUrls[1] = "https://www.login.example/home";
      void h.hello({ documentId: "home-document", url: "https://www.login.example/home" }, false);
      await until(
        () =>
          status()?.[0]?.["state"] !== "awaiting-result" &&
          status()?.[0]?.["state"] !== "submit-intent",
      );
      expect(status()![0]).toMatchObject(expected);
      // The moved page is told the username only for an item that signs in with its password.
      const told = fake.state.messages.some(
        (entry) => entry.type === "login.state" && entry.account !== undefined,
      );
      expect(told).toBe(password);
    },
  );
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
    it("judges the page once, presses the button it learns and answers the request", async () => {
      vi.useFakeTimers();
      const { judge, generation } = judging({ verdict: "challenge", recipe: learned });
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      const started = start({ generation });
      h = started.h;
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 3);
      // No request came within the three seconds, so the page was judged as a stop's.
      expect(judge).toHaveBeenCalledTimes(1);
      expect(judge.mock.calls[0]!.slice(0, 3)).toEqual([emailFirst.id, 1, "password"]);
      expect(judge.mock.calls[0]![3]).toMatchObject({ path: "/password" });
      expect(judge.mock.calls[0]![7]).toBe(true);
      expect(executed()).toEqual([
        expect.objectContaining({ kind: "fill", path: "/signin" }),
        expect.objectContaining({ kind: "click", target: target("next") }),
        expect.objectContaining({ kind: "click", path: "/password", target: securityKey }),
      ]);
      // The handler went in before the stop, which moved along with the plan.
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        stepCount: 5,
        stopAt: 3,
        stopJudged: true,
        handlers: [{ index: 0, start: 2 }],
      });
      expect(judgements(started.report)).toContainEqual(
        expect.objectContaining({ verdict: "challenge", takenOver: true, stop: "password" }),
      );
      // The click is held while its button shows, as any handler's (ADR 0027), and the
      // request it made is the login's to answer with its item.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status()![0]).toMatchObject({
        state: "awaiting-result",
        stepIndex: 2,
        submissions: 2,
        maxSubmissions: 3,
      });
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      // The tab moves on to the passkey's site, signed in.
      fake.state.signs = quiet;
      fake.state.tabUrls[1] = "https://www.login.example/home";
      void h.hello({ documentId: "home-document", url: "https://www.login.example/home" }, false);
      await until(() => status()?.[0]?.["state"] === "authenticated");
      expect(pressed()).toBe(1);
      expect(judge).toHaveBeenCalledTimes(1);
      expect(executed().filter((step) => step.kind === "fill")).toHaveLength(1);
      expect(passwordRead(h)).toBe(false);
    });
    it("presses a button learned before at the stop, with no judge call", async () => {
      vi.useFakeTimers();
      const { judge, generation } = judging({ verdict: "unclear" });
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      const started = start({ generation });
      h = started.h;
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => pressed() === 1);
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        stepIndex: 2,
        stepCount: 5,
        stopAt: 3,
        handlers: [{ index: 0, start: 2 }],
      });
      expect(status()![0]).not.toHaveProperty("stopJudged");
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      fake.state.signs = quiet;
      fake.state.tabUrls[1] = "https://www.login.example/home";
      void h.hello({ documentId: "home-document", url: "https://www.login.example/home" }, false);
      await until(() => status()?.[0]?.["state"] === "authenticated");
      expect(pressed()).toBe(1);
      expect(judge).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });
    it("leaves a pressed button that never signs in to the person, never pressing it twice", async () => {
      vi.useFakeTimers();
      const { judge, generation } = judging({ verdict: "unclear" });
      const started = start({ generation });
      const { h } = started;
      h.recipes.recipe.mockResolvedValue(learned);
      // The button is pressed, but the page stays as it is.
      withButton(() => ({ login: { passkeyAnswered: () => undefined } }) as never);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => pressed() === 1);
      // Held while its button shows, as any handler's click, then left to the person.
      await until(() => status()?.[0]?.["state"] === "watching", 200_000);
      expect(status()![0]).toMatchObject({ outcome: "challenge", stepIndex: 2, stopAt: 3 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pressed()).toBe(1);
      expect(judge).not.toHaveBeenCalled();
      expect(executed().filter((step) => step.kind === "fill")).toHaveLength(1);
      expect(passwordRead(h)).toBe(false);
    });
    it.each<[string, JudgeAnswer]>([
      ["abstains", { verdict: "unclear" }],
      ["finds no button", { verdict: "challenge" }],
      ["is busy", { verdict: "retry", reason: "busy" }],
      ["refuses the page", { verdict: "unclear", reason: "not-judgeable" }],
    ])("ends challenge, watched, as password-empty when the judge %s", async (_label, answer) => {
      vi.useFakeTimers();
      const { judge, generation } = judging(answer);
      let h!: ReturnType<typeof harness>;
      withButton(() => h);
      const started = start({ generation });
      h = started.h;
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => status()?.[0]?.["state"] === "watching");
      expect(judge).toHaveBeenCalledTimes(1);
      expect(judge.mock.calls[0]![7]).toBe(true);
      expect(status()![0]).toMatchObject({
        outcome: "challenge",
        stepIndex: 2,
        stopAt: 2,
        stopJudged: true,
        handlers: [],
      });
      expect(attempts(started.report).at(-1)).toMatchObject({
        state: "watching",
        stop: "password",
        reason: "password-empty",
      });
      expect(judgements(started.report).at(-1)).toMatchObject({
        verdict: answer.verdict,
        stop: "password",
      });
      expect(pressed()).toBe(0);
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
      expect(passwordRead(h)).toBe(false);
    });
  });
});
