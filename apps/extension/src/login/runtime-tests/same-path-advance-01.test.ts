import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type SavedLoginBinding,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { target, startsOf, recipe, savedBinding, harness } = createRuntimeTestHarness(fake);

describe("an advance whose next step is on the same path (ADR 0013)", () => {
  afterEach(() => {
    vi.useRealTimers();
    fake.state.faint = new Set();
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
    // An identifier-first form: the email form shows, the password form is hidden.
    fake.state.present = new Set(["email", "next", "password", "login"]);
    fake.state.unusable = new Set(["password", "login"]);
    fake.state.faint = new Set();
    fake.state.ambiguous = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });
  const identifierFirst = (steps?: unknown[]) =>
    parseLoginRecipe({
      ...recipe,
      slots: ["username", "password"],
      steps: steps ?? [
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
        { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ],
      rejection: target("rejected"),
      maxSubmissions: 2,
    });
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
  async function until(check: () => boolean, maxMs = 30_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);
  const swapForms = (also?: () => void) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click") return;
      if (step.target?.value === "next") {
        fake.state.unusable = new Set(["email", "next"]);
        also?.();
      }
      if (step.target?.value === "login") fake.state.present?.add("authenticated");
    };
  };
  const start = (withRecipe = identifierFirst(), live: Parameters<typeof harness>[1] = {}) => {
    const h = harness(
      {
        bindings: [
          {
            ...savedBinding,
            slots: [
              { slot: "username", field: "username" },
              { slot: "password", field: "password" },
              { slot: "branch", field: { custom: "Branch" } },
            ],
          },
        ],
      },
      { username: true, ...live },
    );
    h.recipes.recipe.mockResolvedValue(withRecipe);
    h.recipes.starts.mockResolvedValue(startsOf([withRecipe.steps[0]!]));
    return h;
  };
  const allSteps = ["fill:email", "click:next", "fill:password", "click:login"];
  it("continues in the same document once the password form shows", async () => {
    swapForms();
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
    // Only the Next click has the document measure the password field, as its fill waits
    // for it, in the same task as the click.
    expect(
      fake.state.messages
        .filter((entry) => entry.type === "login.execute")
        .map((entry) => (entry as Record<string, unknown>)["next"]),
    ).toEqual([
      undefined,
      { require: "described-writable", targets: [target("password")] },
      undefined,
      undefined,
    ]);
  });
  describe("marks a login that submitted nothing yet in its first document (ADR 0066)", () => {
    const blockedReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "attempt" && value.state === "blocked" ? [value] : [],
      );
    it("on a wrong account at the email fill", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "wrong-account"));
      expect(blockedReports(report)).toEqual([
        expect.objectContaining({ outcome: "wrong-account", stepIndex: 0, unsubmitted: true }),
      ]);
    });
    it("but not on a wrong account at the password fill after Next", async () => {
      swapForms();
      const onExecute = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        await onExecute(message, tabId);
        const step = (
          message["operation"] as { step: { kind: string; fields?: { slot: string }[] } }
        ).step;
        if (step.fields?.some((field) => field.slot === "password"))
          fake.state.executeReply = { ok: false, reason: "wrong-account" };
      };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "wrong-account"));
      expect(executed()).toEqual(["fill:email", "click:next", "fill:password"]);
      const [blocked] = blockedReports(report);
      expect(blocked).toMatchObject({ outcome: "wrong-account", stepIndex: 2 });
      expect(blocked).not.toHaveProperty("unsubmitted");
    });
  });
  it("continues once a password input the email form kept for the browser shows", async () => {
    // Microsoft Entra's email view keeps its password input off-screen and hidden from
    // assistive technology for the browser to fill (2026-10-17): the password fill's wait
    // counts it as writable, but the page's description does not see it.
    fake.state.unusable = new Set(["login"]);
    fake.state.faint = new Set(["password"]);
    swapForms(() => {
      // Next shows that same input in the password view, in the same document.
      fake.state.faint = new Set();
    });
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
  });
  describe("says in the log why such an advance was never confirmed (ADR 0019)", () => {
    const states = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
    beforeEach(() => {
      fake.state.signs = {
        password: true,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
    });
    afterEach(() => {
      fake.state.measures = true;
    });
    it("names a password input that stayed transparent after Next", async () => {
      fake.state.unusable = new Set(["login"]);
      fake.state.faint = new Set(["password"]);
      // Next shows the password view, but its input never becomes visible as described.
      swapForms(() => {
        fake.state.unusable = new Set(["login"]);
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      expect(states(report)).toEqual([
        expect.objectContaining({
          decision: "unknown",
          reshownMiss: "not-submit",
          advanceBefore: "unusable",
          advanceAfter: "unusable",
          advanceWhy: "transparent",
          advancePath: "same",
        }),
      ]);
      // Only codes: no locator of the step's fields goes to the log.
      expect(JSON.stringify(states(report))).not.toContain('"value"');
    });
    it("names a password form that already showed before Next", async () => {
      fake.state.unusable = new Set();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      expect(states(report)).toEqual([
        expect.objectContaining({
          reshownMiss: "not-submit",
          advanceBefore: "unique",
          advanceAfter: "unique",
          advanceWhy: "ok",
          advancePath: "same",
        }),
      ]);
    });
    it("names several password inputs and another path", async () => {
      swapForms(() => {
        fake.state.ambiguous = new Set(["password"]);
        fake.state.observedPath = "/signin/password";
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      expect(states(report)).toEqual([
        expect.objectContaining({
          advanceBefore: "unusable",
          advanceAfter: "ambiguous",
          advanceWhy: "matches-2",
          advancePath: "other",
        }),
      ]);
    });
    it("names an advance whose document answered without the measurement as unmeasured", async () => {
      fake.state.measures = false;
      // The password form shows after Next, but nothing says it was not ready before.
      swapForms();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      expect(states(report)).toEqual([
        expect.objectContaining({
          advanceBefore: "unmeasured",
          advanceAfter: "unique",
          advanceWhy: "ok",
          advancePath: "same",
        }),
      ]);
      expect(executed()).toEqual(["fill:email", "click:next"]);
    });
    it("leaves the fields out when the advance is confirmed", async () => {
      swapForms();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = start(identifierFirst(), { report });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(JSON.stringify(report.mock.calls)).not.toContain("advanceBefore");
      expect(
        fake.state.messages.filter((entry) => entry.type === "login.observe" && "explain" in entry),
      ).toEqual([]);
    });
  });
  it("never continues while the password view has not shown the kept input", async () => {
    fake.state.unusable = new Set(["login"]);
    fake.state.faint = new Set(["password"]);
    // Next leaves the email view up, as while the account is checked: the kept input is
    // still the only password input, so the password is never typed into it.
    swapForms(() => {
      fake.state.unusable = new Set(["login"]);
    });
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("continues after a same-document URL change that keeps the path", async () => {
    let announced: Promise<unknown> | undefined;
    const h = start();
    swapForms(() => {
      // `history.pushState` to the same path with another query; the document announces
      // again and is told it already carries the attempt.
      fake.state.pageUrl = "https://login.example/signin?step=password";
      announced = h.hello();
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(await announced).toEqual({ ok: false, reason: "duplicate-document" });
    expect(executed()).toEqual(allSteps);
  });
  it("continues in a new document the form was posted to on the same path", async () => {
    const h = start();
    swapForms(() => fake.state.gone.add("synthetic-document"));
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await until(() => status()?.[0]?.["state"] === "reconciling");
    // The new document shows only the password form.
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    expect(await h.hello({ documentId: "posted" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
  });
  it("waits for a password form that shows late and continues within the limit", async () => {
    swapForms(() => {
      // The email form goes, but the password form shows only after nine seconds.
      fake.state.unusable = new Set(["email", "next", "password", "login"]);
      setTimeout(() => (fake.state.unusable = new Set(["email", "next"])), 9_000);
    });
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
  });
  it("ends as unknown after ten seconds without the password form, never clicking Next again", async () => {
    // The email form is still shown and writable; the password form never shows.
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
    expect(status()![0]!["outcome"]).toBeUndefined();
    await until(settled("reconciling", "unknown-submit"), 5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 1 });
  });
  it("never continues when the password form already showed before Next", async () => {
    // Both forms show from the start; that page needs a one-step recipe.
    fake.state.unusable = new Set();
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("never continues to a step that clicks the advance's own button again", async () => {
    fake.state.unusable = new Set();
    const h = start(
      identifierFirst([
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
        { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        { kind: "click", path: "/signin", target: target("next"), purpose: "submit" },
      ]),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(["fill:email", "click:next"]);
    // The Next click measured no next step: the step after it clicks the same button.
    expect(
      fake.state.messages
        .filter((entry) => entry.type === "login.execute")
        .map((entry) => (entry as Record<string, unknown>)["next"]),
    ).toEqual([undefined, undefined]);
  });
  it("never continues on the same path after a click that submits", async () => {
    swapForms();
    const h = start(
      identifierFirst([
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
        { kind: "click", path: "/signin", target: target("next"), purpose: "submit" },
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ]),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("settles a rejection shown after Next before looking for the password form", async () => {
    swapForms(() => fake.state.present?.add("rejected"));
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "credential-rejected"));
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("never continues when the password form shows after Next's wait but before its click", async () => {
    swapForms();
    const h = start();
    // The page reveals the password form by itself while the click is being prepared,
    // after the Next button's wait, as a debounced input handler may.
    const original = h.store.handle.getMockImplementation()!;
    let revealedAfter: number | undefined;
    h.store.handle.mockImplementation(async () => {
      if (status()?.[0]?.["state"] === "submit-intent" && revealedAfter === undefined) {
        fake.state.unusable = new Set(["login"]);
        revealedAfter = executed().length;
      }
      return original();
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    // Revealed after the email fill and before the Next click.
    expect(revealedAfter).toBe(1);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("never continues when part of the next step was usable before Next", async () => {
    // The branch field already shows beside the account form; only the password is new.
    swapForms();
    const h = start(
      parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "branch", "password"],
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
            fields: [
              { slot: "branch", target: target("branch") },
              { slot: "password", target: target("password") },
            ],
          },
          { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
        ],
      }),
    );
    fake.state.present?.add("branch");
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("never continues when the password field matched several elements before Next", async () => {
    fake.state.ambiguous = new Set(["password"]);
    swapForms(() => (fake.state.ambiguous = new Set()));
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });
  it("types the password before a handler shown with the password form on that path", async () => {
    // As on another path, the route's next step comes before the recipe's handlers.
    const securityKey = { by: "text" as const, value: "Use security key" };
    swapForms(() => fake.state.present?.add(securityKey.value));
    const h = start(
      parseLoginRecipe({
        ...identifierFirst(),
        handlers: [{ kind: "passkey", path: "/signin", target: securityKey }],
      }),
      { passkeys: async () => ({ passkey: true, discoverable: false }) },
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ handlers: [] });
  });
  describe("further shapes", () => {
    const begin = (
      used: LoginRecipe,
      slots: SavedLoginBinding["slots"],
      live: Parameters<typeof harness>[1] = {},
    ) => {
      const h = harness({ bindings: [{ ...savedBinding, slots }] }, { username: true, ...live });
      h.recipes.recipe.mockResolvedValue(used);
      h.recipes.starts.mockResolvedValue(startsOf([used.steps[0]!]));
      return h;
    };
    const onStep = (react: (kind: string, element: string) => void) => {
      fake.state.onExecute = async (message) => {
        const { step } = message["operation"] as { step: LoginStep };
        react(step.kind, step.kind === "fill" ? step.fields[0]!.target.value : step.target.value);
      };
    };
    const nexts = () =>
      fake.state.messages
        .filter((entry) => entry.type === "login.execute")
        .map((entry) => (entry as Record<string, unknown>)["next"]);
    const measures = (value: string) => ({
      require: "described-writable",
      targets: [target(value)],
    });
    const usernamePassword: SavedLoginBinding["slots"] = [
      { slot: "username", field: "username" },
      { slot: "password", field: "password" },
    ];
    const emailFill = {
      kind: "fill" as const,
      path: "/signin",
      fields: [{ slot: "username", target: target("email") }],
    };
    const nextClick = {
      kind: "click" as const,
      path: "/signin",
      target: target("next"),
      purpose: "advance" as const,
    };
    const passwordFill = {
      kind: "fill" as const,
      path: "/signin",
      fields: [{ slot: "password", target: target("password") }],
    };
    const loginClick = {
      kind: "click" as const,
      path: "/signin",
      target: target("login"),
      purpose: "submit" as const,
    };
    const typed = () =>
      identifierFirst([
        { ...emailFill, effect: "advance", event: "input" },
        { ...passwordFill, effect: "submit", event: "input" },
      ]);
    it("continues after an email fill whose input event shows the password form", async () => {
      fake.state.present = new Set(["email", "password"]);
      fake.state.unusable = new Set(["password"]);
      onStep((kind, element) => {
        if (kind !== "fill") return;
        if (element === "email") fake.state.unusable = new Set();
        if (element === "password") fake.state.present?.add("authenticated");
      });
      const h = start(typed());
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(["fill:email", "fill:password"]);
      expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 2 });
      // The email fill has the document measure the password field before its first input.
      expect(nexts()).toEqual([measures("password"), undefined]);
    });
    it("never continues when the password form shows after the email fill's wait but before its input", async () => {
      fake.state.present = new Set(["email", "password"]);
      fake.state.unusable = new Set(["password"]);
      const h = start(typed());
      // The page reveals the password form by itself while the fill is being prepared.
      const original = h.store.handle.getMockImplementation()!;
      let revealed = false;
      h.store.handle.mockImplementation(async () => {
        if (status()?.[0]?.["state"] === "submit-intent" && executed().length === 0) {
          fake.state.unusable = new Set();
          revealed = true;
        }
        return original();
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(revealed).toBe(true);
      expect(executed()).toEqual(["fill:email"]);
    });
    it("never continues after an input-triggered email fill when the password form already showed", async () => {
      fake.state.present = new Set(["email", "password"]);
      fake.state.unusable = new Set();
      const h = start(typed());
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email"]);
    });
    it("continues through two identifier stages on one path to the password", async () => {
      // Email, then a member number, then the password, each swapped in by its Next.
      fake.state.present = new Set(["email", "next", "member", "next2", "password", "login"]);
      fake.state.unusable = new Set(["member", "next2", "password", "login"]);
      onStep((kind, element) => {
        if (kind !== "click") return;
        if (element === "next")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
        if (element === "next2")
          fake.state.unusable = new Set(["email", "next", "member", "next2"]);
        if (element === "login") fake.state.present?.add("authenticated");
      });
      const staged = parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "member", "password"],
        steps: [
          emailFill,
          nextClick,
          { kind: "fill", path: "/signin", fields: [{ slot: "member", target: target("member") }] },
          { kind: "click", path: "/signin", target: target("next2"), purpose: "advance" },
          passwordFill,
          loginClick,
        ],
        maxSubmissions: 3,
      });
      const h = begin(staged, [
        { slot: "username", field: "username" },
        { slot: "member", field: { custom: "Branch" } },
        { slot: "password", field: "password" },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual([
        "fill:email",
        "click:next",
        "fill:member",
        "click:next2",
        "fill:password",
        "click:login",
      ]);
      expect(status()![0]).toMatchObject({ stepIndex: 5, submissions: 3 });
      // Each Next measures its own next step; nothing else does.
      expect(nexts()).toEqual([
        undefined,
        measures("member"),
        undefined,
        measures("password"),
        undefined,
        undefined,
      ]);
    });
    it("stops after the second Next when the password form never shows, clicking each Next once", async () => {
      fake.state.present = new Set(["email", "next", "member", "next2", "password", "login"]);
      fake.state.unusable = new Set(["member", "next2", "password", "login"]);
      onStep((kind, element) => {
        // The second Next leaves the member form shown; the password form never comes.
        if (kind === "click" && element === "next")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
      });
      const staged = parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "member", "password"],
        steps: [
          emailFill,
          nextClick,
          { kind: "fill", path: "/signin", fields: [{ slot: "member", target: target("member") }] },
          { kind: "click", path: "/signin", target: target("next2"), purpose: "advance" },
          passwordFill,
          loginClick,
        ],
        maxSubmissions: 3,
      });
      const h = begin(staged, [
        { slot: "username", field: "username" },
        { slot: "member", field: { custom: "Branch" } },
        { slot: "password", field: "password" },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 4);
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email", "click:next", "fill:member", "click:next2"]);
      expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
    });
    it("continues in place in a recipe with a handler on that path, then enters the handler", async () => {
      // The TOTP form also lives on /signin and shows in place after Log in.
      fake.state.present = new Set(["email", "next", "password", "login", "code", "verify"]);
      fake.state.unusable = new Set(["password", "login", "code", "verify"]);
      onStep((kind, element) => {
        if (kind !== "click") return;
        if (element === "next") fake.state.unusable = new Set(["email", "next", "code", "verify"]);
        if (element === "login")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
        if (element === "verify") fake.state.present?.add("authenticated");
      });
      const handled = parseLoginRecipe({
        ...identifierFirst(),
        handlers: [
          { kind: "totp", path: "/signin", field: target("code"), target: target("verify") },
        ],
      });
      const h = begin(handled, usernamePassword);
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          (response.catalog.connections[0]!.items[0]!.fields as unknown[]).push({
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
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual([...allSteps, "fill:code", "click:verify"]);
      expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 4 }] });
    });
    it("never enters a handler on that path while waiting for the password form", async () => {
      // Next shows the TOTP form instead of the password form: the advance is not
      // confirmed, and a handler is entered only after a step that submits.
      fake.state.present = new Set(["email", "next", "password", "login", "code", "verify"]);
      fake.state.unusable = new Set(["password", "login", "code", "verify"]);
      onStep((kind, element) => {
        if (kind === "click" && element === "next")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
      });
      const handled = parseLoginRecipe({
        ...identifierFirst(),
        handlers: [
          { kind: "totp", path: "/signin", field: target("code"), target: target("verify") },
        ],
      });
      const h = begin(handled, usernamePassword);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(executed()).toEqual(allSteps.slice(0, 2));
    });
    describe("with password variants", () => {
      const varied = () =>
        parseLoginRecipe({
          ...identifierFirst(),
          slots: ["username", "pin"],
          steps: [
            emailFill,
            nextClick,
            { kind: "fill", path: "/signin", fields: [{ slot: "pin", target: target("pin") }] },
            loginClick,
          ],
          alternatives: [
            {
              slots: ["contract", "password"],
              steps: [
                {
                  kind: "fill",
                  path: "/signin",
                  fields: [{ slot: "contract", target: target("contract") }],
                },
                nextClick,
                passwordFill,
                loginClick,
              ],
            },
          ],
        });
      const byContract: SavedLoginBinding["slots"] = [
        { slot: "contract", field: { custom: "Contract" } },
        { slot: "password", field: "password" },
      ];
      const contractOnly = { custom: [{ name: "Contract", kind: "text" as const }] };
      beforeEach(() => {
        fake.state.present = new Set(["email", "contract", "next", "pin", "password", "login"]);
        fake.state.unusable = new Set(["pin", "password", "login"]);
      });
      it("continues when the chosen variant's next step shows", async () => {
        onStep((kind, element) => {
          if (kind !== "click") return;
          if (element === "next")
            fake.state.unusable = new Set(["email", "contract", "next", "pin"]);
          if (element === "login") fake.state.present?.add("authenticated");
        });
        const h = begin(varied(), byContract, contractOnly);
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(status()![0]).toMatchObject({ variant: 1 });
        expect(executed()).toEqual(["fill:contract", "click:next", "fill:password", "click:login"]);
      });
      it("never continues when only another variant's next step shows", async () => {
        onStep((kind, element) => {
          if (kind === "click" && element === "next")
            fake.state.unusable = new Set(["email", "contract", "next", "password", "login"]);
        });
        const h = begin(varied(), byContract, contractOnly);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => executed().length === 2);
        await until(settled("reconciling", "unknown-submit"), 15_000);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(status()![0]).toMatchObject({ variant: 1 });
        expect(executed()).toEqual(["fill:contract", "click:next"]);
      });
    });
    it("never continues on a password form that shows and hides again between checks", async () => {
      onStep((kind, element) => {
        if (kind !== "click" || element !== "next") return;
        fake.state.unusable = new Set(["email", "next", "password", "login"]);
        // Shown for 100 ms between two of the 200 ms checks, then gone again.
        setTimeout(() => (fake.state.unusable = new Set(["email", "next"])), 50);
        setTimeout(
          () => (fake.state.unusable = new Set(["email", "next", "password", "login"])),
          150,
        );
      });
      const h = start();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // Next measured the password form hidden, in the same task as its click.
      expect(nexts()).toEqual([undefined, measures("password")]);
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(allSteps.slice(0, 2));
    });
    it("never continues when an unknown account shows the email form again", async () => {
      onStep((kind, element) => {
        if (kind !== "click" || element !== "next") return;
        // The email form goes, then comes back with an error that is not the recipe's
        // rejection; the password form stays hidden.
        fake.state.unusable = new Set(["email", "next", "password", "login"]);
        setTimeout(() => {
          fake.state.unusable = new Set(["password", "login"]);
          fake.state.present?.add("account-error");
        }, 500);
      });
      const h = start();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
      await until(settled("reconciling", "unknown-submit"), 5_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 1 });
    });
    it("checks a later advance's new document against that advance's own check", async () => {
      // Each Next posts the form back to /signin. The second document already shows the
      // password form before its Next, so the third one cannot confirm that Next, whatever
      // the first Next found.
      const staged = parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "member", "password"],
        steps: [
          emailFill,
          nextClick,
          { kind: "fill", path: "/signin", fields: [{ slot: "member", target: target("member") }] },
          { kind: "click", path: "/signin", target: target("next2"), purpose: "advance" },
          passwordFill,
          loginClick,
        ],
        maxSubmissions: 3,
      });
      const h = begin(staged, [
        { slot: "username", field: "username" },
        { slot: "member", field: { custom: "Branch" } },
        { slot: "password", field: "password" },
      ]);
      fake.state.present = new Set(["email", "next"]);
      fake.state.unusable = new Set();
      onStep((kind, element) => {
        if (kind !== "click") return;
        if (element === "next") fake.state.gone.add("synthetic-document");
        if (element === "next2") fake.state.gone.add("posted-member");
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await until(() => status()?.[0]?.["state"] === "reconciling");
      fake.state.present = new Set(["member", "next2", "password", "login"]);
      expect(await h.hello({ documentId: "posted-member" }, false)).toEqual({ ok: true });
      await until(() => executed().length === 4);
      await until(() => status()?.[0]?.["state"] === "reconciling");
      fake.state.present = new Set(["password", "login"]);
      expect(await h.hello({ documentId: "posted-password" }, false)).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email", "click:next", "fill:member", "click:next2"]);
    });
  });
});
