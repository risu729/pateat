import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type SavedLoginBinding,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
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

    const usernamePassword: SavedLoginBinding["slots"] = [
      { slot: "username", field: "username" },
      { slot: "password", field: "password" },
    ];
    void {
      kind: "fill" as const,
      path: "/signin",
      fields: [{ slot: "username", target: target("email") }],
    };
    void {
      kind: "click" as const,
      path: "/signin",
      target: target("next"),
      purpose: "advance" as const,
    };
    void {
      kind: "fill" as const,
      path: "/signin",
      fields: [{ slot: "password", target: target("password") }],
    };
    void {
      kind: "click" as const,
      path: "/signin",
      target: target("login"),
      purpose: "submit" as const,
    };

    it("ends as unknown after a worker restart while Next runs, never filling or clicking again", async () => {
      onStep((kind, element) => {
        if (kind === "click" && element === "next")
          fake.state.unusable = new Set(["email", "next"]);
      });
      // The page never answers Next, as when the worker stops while it runs.
      const answered = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        await answered(message, tabId);
        const { step } = message["operation"] as { step: LoginStep };
        if (step.kind === "click") await new Promise<void>(() => undefined);
      };
      const h = start();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await until(() => status()?.[0]?.["state"] === "submit-intent");
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        // A new worker has only the stored attempt; the password form now shows.
        fake.state.onExecute = undefined;
        const restarted = start();
        expect(await restarted.login.active()).toBe(true);
        expect(status()![0]).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
        expect(await restarted.hello({}, false)).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(executed()).toEqual(allSteps.slice(0, 2));
        expect(status()![0]).toMatchObject({
          state: "reconciling",
          outcome: "unknown-submit",
          stepIndex: 1,
          submissions: 1,
        });
        // A new document of the tab does not continue either.
        expect(await restarted.hello({ documentId: "after-restart" }, false)).toEqual({
          ok: true,
          // The settled login is watched: its first step showing releases it (ADR 0027).
          starts: expect.any(Array),
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(executed()).toEqual(allSteps.slice(0, 2));
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    describe("beside a passkey route", () => {
      const button = { by: "text" as const, value: "Sign in with a passkey" };
      const routed = () =>
        parseLoginRecipe({ ...identifierFirst(), passkey: { path: "/signin", target: button } });
      beforeEach(() => {
        fake.state.present = new Set(["email", "next", "password", "login", button.value]);
      });
      it("continues in place on the password route", async () => {
        swapForms();
        const h = begin(routed(), usernamePassword, {
          passkeys: async () => ({ passkey: true, discoverable: false }),
        });
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(status()![0]).toMatchObject({ route: "password" });
        expect(executed()).toEqual(allSteps);
      });
      it("only clicks the passkey button on the passkey route, whose one step submits", async () => {
        onStep((kind, element) => {
          if (kind === "click" && element === button.value)
            fake.state.present?.add("authenticated");
        });
        const h = begin(routed(), usernamePassword, {
          passkeys: async () => ({ passkey: true, discoverable: true }),
        });
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(status()![0]).toMatchObject({ route: "passkey", stepCount: 1 });
        expect(executed()).toEqual([`click:${button.value}`]);
      });
    });
  });
});
