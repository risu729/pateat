import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  itemId,
  target,
  startsOf,
  savedBinding,
  otherItemId,
  uriMatch,
  liveDefault,
  harness,
} = createRuntimeTestHarness(fake);

describe("continuing a generated recipe after its final advance (ADR 0018)", () => {
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
    // The email page: its field and Next show, and no password input yet.
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
    id: "gen-synthetic-continued",
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
  const continuedOn = (path: string, change: Partial<LoginRecipe> = {}) =>
    parseLoginRecipe({
      ...emailFirst,
      revision: 2,
      slots: ["username", "password"],
      steps: [
        ...emailFirst.steps,
        { kind: "fill", path, fields: [{ slot: "password", target: target("password") }] },
        { kind: "click", path, target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 2,
      ...change,
    });
  const describedPage = (path: string, candidates: unknown[], complete = true) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete, candidates },
  });
  const passwordPage = (path: string, complete = true) =>
    describedPage(
      path,
      [
        { id: "c1", role: "password", target: target("password"), label: "Password" },
        { id: "c2", role: "button", target: target("login"), label: "Log in" },
      ],
      complete,
    );
  const homePage = describedPage("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
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
  function generation(
    generate: LoginGeneration["generate"] = async () => ({
      outcome: "abstained",
      reason: "ambiguous",
    }),
    judge: LoginGeneration["judge"] = async () => ({ verdict: "signed-in" }),
  ) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(generate),
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
    service: ReturnType<typeof generation>,
    options: {
      recipe?: LoginRecipe;
      settings?: Partial<LocalSettings>;
      report?: LoginReport[];
      custom?: CustomField[];
      /** The item's passkey facts (ADR 0027); none by default. */
      passkeys?: () => Promise<{ passkey: boolean; discoverable: boolean }>;
    } = {},
  ) {
    const reports = options.report;
    const h = harness(options.settings ?? { siteDefaults: [], bindings: [] }, {
      allowedOrigins: [],
      uris,
      username: true,
      custom: options.custom ?? [],
      generation: service,
      ...(options.passkeys ? { passkeys: options.passkeys } : {}),
      ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
    });
    const first = options.recipe ?? emailFirst;
    h.recipes.recipe.mockResolvedValue(first);
    h.recipes.starts.mockResolvedValue(startsOf([first.steps[0]!]));
    return h;
  }
  const answering = (h: () => ReturnType<typeof harness>, next: LoginRecipe) =>
    (async () => {
      h().recipes.recipe.mockResolvedValue(next);
      return { outcome: "recipe" as const, recipe: next };
    }) satisfies LoginGeneration["generate"];
  const onClick = (next: () => void) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click") return;
      if (step.target?.value === "next") next();
      if (step.target?.value === "login") {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.signIn = false;
        fake.state.extracted = { "signed-in": homePage };
      }
    };
  };
  const inPlace = (also?: () => void) =>
    onClick(() => {
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { login: passwordPage("/signin") };
      also?.();
    });
  const allSteps = ["fill:email", "click:next", "fill:password", "click:login"];
  const measured = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute" && "next" in entry)
      .map((entry) => {
        const { step } = (
          entry as unknown as { operation: { step: { kind: string; target?: { value: string } } } }
        ).operation;
        return `${step.kind}:${step.target?.value ?? ""}`;
      });
  it("asks again while the vault match could not evaluate the login's own item", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    const reports: LoginReport[] = [];
    h = start(service, { report: reports });
    let incomplete = 0;
    uris.mockImplementation(async () => {
      // Once the password form shows, the item's URIs cannot be evaluated for a moment.
      if (!fake.state.present?.has("password") || incomplete >= 3)
        return { ok: true as const, data: uriMatch() };
      incomplete += 1;
      return {
        ok: true as const,
        data: uriMatch({
          candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
          unavailableItemIds: [itemId],
        }),
      };
    });
    try {
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(incomplete).toBe(3);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual(allSteps);
      // Each round logs nothing new while the reason stays the same.
      expect(
        reports
          .filter((entry) => entry.type === "generation")
          .map((entry) => [entry.outcome, "reason" in entry ? entry.reason : undefined]),
      ).toEqual([
        ["skipped", "scope-incomplete"],
        ["recipe", undefined],
      ]);
    } finally {
      uris.mockImplementation(async () => ({ ok: true as const, data: uriMatch() }));
    }
  });
  it.each<[string, LoginRecipe, string]>([
    [
      "changes a step the login ran",
      parseLoginRecipe({
        ...continuedOn("/signin"),
        steps: [
          { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("user") }] },
          ...continuedOn("/signin").steps.slice(1),
        ],
      }),
      "not-continued",
    ],
    [
      "is another recipe",
      parseLoginRecipe({ ...continuedOn("/signin"), id: "gen-other" }),
      "recipe-changed",
    ],
    ["is not newer", parseLoginRecipe({ ...continuedOn("/signin"), revision: 1 }), "not-continued"],
  ])("never takes over a revision that %s", async (_label, next, reason) => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const reports: LoginReport[] = [];
    const service = generation(answering(() => h, next));
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ recipeRevision: 1 });
    // Why it was not taken over is logged with it, as a code (ADR 0019).
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "recipe", takenOver: false, notTakenOver: reason }),
    ]);
  });
  const usernameOnly: SavedLoginBinding = {
    ...savedBinding,
    recipeId: emailFirst.id,
    slots: [{ slot: "username", field: "username" }],
  };
  const continuedWithCustomer = parseLoginRecipe({
    ...emailFirst,
    revision: 2,
    slots: ["username", "Customer number"],
    steps: [
      ...emailFirst.steps,
      {
        kind: "fill",
        path: "/signin",
        fields: [{ slot: "Customer number", target: target("customer") }],
      },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  it("takes over a revision the saved binding lacks a slot of and widens it (amended 2026-10-19)", async () => {
    inPlace();
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service, {
      settings: {
        siteDefaults: [liveDefault()],
        bindings: [usernameOnly],
      },
      report: reports,
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ recipeRevision: 2, stepCount: 4 });
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toContain("login.password");
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "recipe", takenOver: true }),
    ]);
    // The binding keeps its entry and gains the password; the default stays as it was.
    expect(h.settings.settings.bindings).toEqual([
      {
        ...usernameOnly,
        slots: [...usernameOnly.slots, { slot: "password", field: "password" }],
      },
    ]);
    expect(h.settings.settings.siteDefaults).toEqual([liveDefault()]);
  });
  it.each<[string, (() => LoginGeneration["slotFields"]) | undefined, CustomField[], string]>([
    [
      "no template names it",
      undefined,
      [{ name: "Customer", kind: "text" }],
      "binding-slots-mismatch",
    ],
    [
      "the generated map names a field the item lacks",
      () => async () => [{ slot: "Customer number", field: { custom: "Customer" } }],
      [],
      "field-missing",
    ],
  ])(
    "never takes over a revision whose new slot the saved binding lacks when %s, and logs why",
    async (_label, slotFields, custom, reason) => {
      inPlace(() => fake.state.present?.add("customer"));
      const reports: LoginReport[] = [];
      let h!: ReturnType<typeof harness>;
      const service = generation(answering(() => h, continuedWithCustomer));
      if (slotFields) service.slotFields.mockImplementation(slotFields());
      h = start(service, { settings: { bindings: [usernameOnly] }, report: reports, custom });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain(
        "login.password",
      );
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "recipe", takenOver: false, notTakenOver: reason }),
      ]);
      expect(h.settings.settings.bindings).toEqual([usernameOnly]);
    },
  );
  it("takes over a revision whose new custom slot the generated map fills", async () => {
    inPlace(() => fake.state.present?.add("customer"));
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedWithCustomer));
    service.slotFields.mockResolvedValue([
      { slot: "Customer number", field: { custom: "Customer" } },
    ]);
    h = start(service, {
      settings: { bindings: [usernameOnly] },
      custom: [{ name: "Customer", kind: "text" }],
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(["fill:email", "click:next", "fill:customer", "click:login"]);
    const executes = fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(executes[2]!.values).toEqual([{ slot: "Customer number", value: "synthetic-secret" }]);
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain("login.password");
    expect(h.settings.settings.bindings).toEqual([
      {
        ...usernameOnly,
        slots: [...usernameOnly.slots, { slot: "Customer number", field: { custom: "Customer" } }],
      },
    ]);
  });
  it("judges the page instead when the recipe already has a completion", async () => {
    onClick(() => {
      fake.state.observedPath = "/signin/password";
      fake.state.present = new Set(["password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { "signed-in": passwordPage("/signin/password") };
    });
    const learned = parseLoginRecipe({
      ...emailFirst,
      completion: [{ target: target("logout") }],
    });
    const service = generation(undefined, async () => ({ verdict: "unclear" }));
    const h = start(service, { recipe: learned });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).toHaveBeenCalledTimes(1);
  });
  it("runs every step of a continued same-path recipe later, with no request", async () => {
    // The swap shows the password form only after Next; the email form hides.
    inPlace();
    const service = generation();
    const h = start(service, { recipe: continuedOn("/signin") });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // Next is now an advance with a next step on its path, measured with its click.
    expect(measured()).toEqual(["click:next"]);
    expect(service.generate).not.toHaveBeenCalled();
  });
  it("runs a continued progressive form later while its password input was hidden before Next", async () => {
    // The password input exists but is hidden until Next; the email field stays writable.
    fake.state.present = new Set(["email", "next", "password"]);
    fake.state.unusable = new Set(["password"]);
    onClick(() => {
      fake.state.unusable = new Set();
      fake.state.present = new Set(["email", "next", "password", "login"]);
    });
    const service = generation();
    const h = start(service, { recipe: continuedOn("/signin") });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(measured()).toEqual(["click:next"]);
    expect(service.generate).not.toHaveBeenCalled();
  });
  it("never continues a later run whose password input was writable before Next", async () => {
    // A limitation of the same-path rule (ADR 0013): a password input that was already
    // usable before Next cannot tell that Next worked.
    fake.state.present = new Set(["email", "next", "password"]);
    onClick(() => {
      fake.state.present = new Set(["email", "next", "password", "login"]);
    });
    const service = generation();
    const h = start(service, { recipe: continuedOn("/signin") });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(service.generate).not.toHaveBeenCalled();
  });
  describe("a learned button that goes on to the password (ADR 0048)", () => {
    const choose = target("choose-password");
    const handler = { kind: "password" as const, path: "/signin", target: choose };
    const choicePage = describedPage("/signin", [
      { id: "c1", role: "button", target: choose, label: "Password" },
      { id: "c2", role: "button", target: target("mobile"), label: "Mobile" },
    ]);
    const withHandler = parseLoginRecipe({ ...emailFirst, revision: 2, handlers: [handler] });
    const continued = continuedOn("/signin", { revision: 3, handlers: [handler] });
    const withPress = [
      "fill:email",
      "click:next",
      "click:choose-password",
      "fill:password",
      "click:login",
    ];
    const choosing = ({
      skip = false,
      dead = false,
      keep = false,
      hide = false,
      beside = [] as string[],
    } = {}) => {
      const passwordForm = () => {
        fake.state.present = new Set([
          "password",
          "login",
          ...(keep ? ["choose-password", "mobile"] : []),
        ]);
        fake.state.signIn = true;
        fake.state.extracted = { login: passwordPage("/signin") };
      };
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click") return;
        if (step.target?.value === "next" && skip) passwordForm();
        else if (step.target?.value === "next") {
          fake.state.present = new Set(["choose-password", "mobile", ...beside]);
          fake.state.signIn = false;
          fake.state.extracted = { "signed-in": choicePage };
        }
        if (step.target?.value === "choose-password" && hide) {
          fake.state.unusable = new Set(["choose-password", "mobile"]);
          setTimeout(() => {
            passwordForm();
            fake.state.present!.add("choose-password").add("mobile");
          }, 300);
        } else if (step.target?.value === "choose-password" && !dead) passwordForm();
        if (step.target?.value === "login") {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
          fake.state.signIn = false;
          fake.state.extracted = { "signed-in": homePage };
        }
      };
    };
    it("presses the button the judge named, continues on the password page and signs in", async () => {
      choosing();
      const reports: LoginReport[] = [];
      let h!: ReturnType<typeof harness>;
      const service = generation(
        answering(() => h, continued),
        async (_id, revision) => {
          if (revision !== 1) return { verdict: "signed-in" };
          h.recipes.recipe.mockResolvedValue(withHandler);
          return { verdict: "challenge", recipe: withHandler };
        },
      );
      h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(withPress);
      // The choice page was judged under the first revision; the page after the press was
      // sent once to continue the handler's revision, never judged.
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [emailFirst.id, 1, "password", choicePage.observation],
        [emailFirst.id, 3, "password", homePage.observation],
      ]);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        base: { recipeId: emailFirst.id, revision: 2 },
        observation: passwordPage("/signin").observation,
      });
      expect(status()![0]).toMatchObject({
        recipeRevision: 3,
        handlers: [{ index: 0, start: 2 }],
        stepCount: 5,
        submissions: 3,
      });
      expect(
        reports.flatMap((entry) =>
          entry.type === "handler" ? [`${entry.kind} ${entry.outcome} ${entry.steps}`] : [],
        ),
      ).toEqual(["password entered 1"]);
    });
    it("continues on a password form shown beside the button it pressed, without holding", async () => {
      choosing({ keep: true });
      let h!: ReturnType<typeof harness>;
      const service = generation(
        answering(() => h, continued),
        async (_id, revision) =>
          revision === 1 ? { verdict: "challenge", recipe: withHandler } : { verdict: "signed-in" },
      );
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      // Well within the two minutes a held click waits while its button shows.
      await until(settled("authenticated"), 60_000);
      expect(executed()).toEqual(withPress);
      expect(service.generate).toHaveBeenCalledTimes(1);
    });
    it("continues on the password form after the page hid the button it pressed", async () => {
      // The choice stays in the document, hidden, which is no sign of it shown again.
      choosing({ hide: true });
      let h!: ReturnType<typeof harness>;
      const service = generation(
        answering(() => h, continued),
        async (_id, revision) =>
          revision === 1 ? { verdict: "challenge", recipe: withHandler } : { verdict: "signed-in" },
      );
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"), 60_000);
      expect(executed()).toEqual(withPress);
    });
    it("presses it on a later login when the page shows, then types the password", async () => {
      choosing();
      const service = generation();
      const h = start(service, { recipe: continued });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(withPress);
      // Next and the press each confirm the password form on their own path, as measured
      // just before their click (ADR 0013).
      expect(measured()).toEqual(["click:next", "click:choose-password"]);
      expect(service.generate).not.toHaveBeenCalled();
    });
    it("leaves the button alone when the site shows the password form at once", async () => {
      choosing({ skip: true });
      const service = generation();
      const h = start(service, { recipe: continued });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(allSteps);
      expect(status()![0]).toMatchObject({ handlers: [] });
    });
    it("never presses a button whose text does not name the password", async () => {
      choosing();
      const service = generation(undefined, async () => ({ verdict: "challenge" }));
      const h = start(service, { recipe: continued });
      const original = fake.state.onExecute!;
      // The content script reads the live button's text as not naming the password choice.
      fake.state.onExecute = async (message, tabId) => {
        await original(message, tabId);
        fake.state.unusable = new Set(["choose-password"]);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(executed()).toEqual(["fill:email", "click:next"]);
      expect(status()![0]).toMatchObject({ outcome: "challenge", handlers: [] });
    });
    const observedAs = (value: string) =>
      fake.state.messages.flatMap((entry) => {
        if (entry.type !== "login.observe") return [];
        const { targets, require } = entry as unknown as {
          targets: { value: string }[];
          require?: string[];
        };
        return targets.flatMap((item, index) => (item.value === value ? [require?.[index]] : []));
      });
    const checkedChoice = () =>
      fake.state.messages.flatMap((entry) => {
        if (entry.type !== "login.execute" || !("passwordChoice" in entry)) return [];
        const { operation, passwordChoice } = entry as unknown as {
          operation: { step: { kind: string; target?: { value: string } } };
          passwordChoice: unknown;
        };
        return [`${operation.step.kind}:${operation.step.target?.value} ${String(passwordChoice)}`];
      });
    const passkeyHandler = {
      kind: "passkey" as const,
      path: "/signin",
      target: target("use-passkey"),
    };
    const withPasskey = async () => ({ passkey: true, discoverable: false });
    it("enters the handler only on its button's live text and checks it again at the press", async () => {
      choosing();
      const service = generation();
      const h = start(service, { recipe: continued });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(withPress);
      // Entered on its rendered text, never on its being shown alone.
      expect(observedAs("choose-password")).toContain("password-choice");
      expect(observedAs("choose-password")).not.toContain("shown");
      // The click asks the document to read the text again in the press's own task.
      expect(checkedChoice()).toEqual(["click:choose-password true"]);
    });
    it("presses nothing when the button's text changed before the press", async () => {
      choosing();
      const service = generation();
      const h = start(service, { recipe: continued });
      const original = fake.state.onExecute!;
      // The document refuses the click: the button no longer names the password.
      fake.state.onExecute = async (message, tabId) => {
        if (message["passwordChoice"] === true)
          fake.state.executeReply = {
            ok: false,
            reason: "structural-mismatch",
            detail: "target-missing",
          };
        else await original(message, tabId);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => checkedChoice().length > 0 && status()?.[0]?.["state"] !== "executing");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(withPress.slice(0, 3));
      // The click failed without acting: the attempt waits for the page as after any
      // failed click, never pressing the button again.
      expect(status()![0]).toMatchObject({
        state: "reconciling",
        outcome: "structural-mismatch",
      });
    });
    it("never presses it once the login filled its password", async () => {
      // A form that takes the password, then asks how to confirm the sign-in on its path.
      const afterPassword = parseLoginRecipe({
        ...emailFirst,
        revision: 2,
        slots: ["username", "password"],
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
        handlers: [handler],
      });
      fake.state.present = new Set(["email", "password", "login"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind === "click" && step.target?.value === "login") {
          fake.state.present = new Set(["choose-password", "mobile"]);
          fake.state.extracted = { "signed-in": choicePage };
        }
      };
      const service = generation(undefined, async () => ({ verdict: "challenge" }));
      const h = start(service, { recipe: afterPassword });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(executed()).toEqual(["fill:email,password", "click:login"]);
      expect(status()![0]).toMatchObject({ outcome: "challenge", handlers: [] });
    });
    it("never presses it in a frame, even one on the recipe's own site", async () => {
      choosing();
      const service = generation(undefined, async () => ({ verdict: "challenge" }));
      const h = start(service, { recipe: continued });
      const top = "https://login.example/portal";
      fake.state.tabUrls[1] = top;
      expect(
        await h.hello({ frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } }),
      ).toEqual({ ok: true });
      await until(() => executed().length >= 2 && status()?.[0]?.["state"] !== "executing");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email", "click:next"]);
      expect(status()![0]).toMatchObject({ handlers: [] });
    });
    it("never presses it while the route's password field already shows writable", async () => {
      // The password field shows before Next and stays writable beside the choice after it.
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click") return;
        if (step.target?.value === "next")
          fake.state.present = new Set(["choose-password", "mobile", "password", "login"]);
        if (step.target?.value === "login") {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
          fake.state.extracted = { "signed-in": homePage };
        }
      };
      const service = generation(undefined, async () => ({ verdict: "challenge" }));
      const h = start(service, { recipe: continued });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length >= 2 && status()?.[0]?.["state"] !== "executing");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).not.toContain("click:choose-password");
      expect(status()![0]).toMatchObject({ handlers: [] });
    });
    it("goes on to the password rather than a passkey button shown beside it", async () => {
      choosing({ beside: ["use-passkey"] });
      let h!: ReturnType<typeof harness>;
      const both = [passkeyHandler, handler];
      const service = generation(
        answering(() => h, continuedOn("/signin", { revision: 3, handlers: both })),
      );
      h = start(service, {
        recipe: parseLoginRecipe({ ...emailFirst, revision: 2, handlers: both }),
        passkeys: withPasskey,
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(withPress);
      expect(status()![0]).toMatchObject({ handlers: [{ index: 1, start: 2 }] });
    });
    it("ends challenge when its button shows again, never pressing a passkey beside it", async () => {
      choosing({ dead: true, beside: ["use-passkey"] });
      const service = generation(undefined, async () => ({ verdict: "unclear" }));
      const both = [passkeyHandler, handler];
      const h = start(service, {
        recipe: parseLoginRecipe({ ...emailFirst, revision: 2, handlers: both }),
        passkeys: withPasskey,
      });
      const original = fake.state.onExecute!;
      // The press reloads the page, which asks again how to confirm the sign-in.
      fake.state.onExecute = async (message, tabId) => {
        await original(message, tabId);
        if (message["passwordChoice"] !== true) return;
        fake.state.gone.add("synthetic-document");
        setTimeout(() => void h.hello({ documentId: "choice-again" }, false), 0);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(executed()).toEqual(withPress.slice(0, 3));
      expect(status()![0]).toMatchObject({
        outcome: "challenge",
        handlers: [{ index: 1, start: 2 }],
      });
    });
    it("ends challenge and watches when the press does nothing", async () => {
      choosing({ dead: true });
      const service = generation(undefined, async () => ({ verdict: "unclear" }));
      const h = start(service, { recipe: continued });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(executed()).toEqual(withPress.slice(0, 3));
      expect(status()![0]).toMatchObject({
        outcome: "challenge",
        handlers: [{ index: 0, start: 2 }],
      });
      // The page that kept the button was never judged while it showed.
      expect(service.judge).not.toHaveBeenCalled();
    });
    it("after a logout, logs in again from the first page, pressing Next and the button", async () => {
      choosing();
      const service = generation();
      const h = start(service, { recipe: continued });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(withPress);
      // The site signs out and shows the email page again in the tab (ADR 0062).
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["email", "next"]);
      fake.state.signIn = false;
      fake.state.extracted = {};
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(settled("authenticated"));
      await until(() => executed().length === withPress.length * 2);
      // The new login runs the whole recipe again, its learned button included.
      expect(executed()).toEqual([...withPress, ...withPress]);
      expect(service.generate).not.toHaveBeenCalled();
    });
  });
  describe("an optional page after the sign-in (ADR 0065)", () => {
    const checkupPage = describedPage("/checkup", [
      { id: "c1", role: "button", target: target("verify-now"), label: "Verify now" },
      { id: "c2", role: "button", target: target("remind-later"), label: "Remind me later" },
    ]);
    const passwordRecipe = continuedOn("/signin");
    const steps = ["fill:email", "click:next", "fill:password", "click:login"];
    const noSigns = { password: false, code: false, captcha: false, invalid: false, alert: false };
    const checkup = (signs: Partial<typeof noSigns> = {}) => {
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click") return;
        if (step.target?.value === "next") {
          fake.state.present = new Set(["password", "login"]);
          fake.state.signIn = true;
        }
        if (step.target?.value === "login") {
          fake.state.observedPath = "/checkup";
          fake.state.present = new Set(["verify-now", "remind-later"]);
          fake.state.signIn = false;
          fake.state.extracted = { "signed-in": checkupPage };
          // No sign of a sign-in step and no evidence of one (ADR 0029), unless given.
          fake.state.signs = { ...noSigns, ...signs };
        }
      };
    };
    it("completes as signed in, presses nothing and leaves the page", async () => {
      checkup();
      const service = generation(undefined, async () => ({ verdict: "optional" }));
      const h = start(service, { recipe: passwordRecipe });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(steps);
      expect(service.judge.mock.calls.map((call) => call[3])).toEqual([checkupPage.observation]);
      expect(status()![0]).toMatchObject({ state: "authenticated", handlers: [] });
      // Signed in, not the yellow mark of an unconfirmed sign-in.
      expect(status()![0]!["unconfirmed"]).toBeUndefined();
    });
    it("does not complete on an optional page before the password was sent", async () => {
      // The identifier's button submits; the page after it offers a passkey or the password.
      const identifierOnly = parseLoginRecipe({
        ...emailFirst,
        steps: [
          emailFirst.steps[0]!,
          { kind: "click", path: "/signin", target: target("next"), purpose: "submit" },
        ],
      });
      const choicePage = describedPage("/options", [
        { id: "c1", role: "button", target: target("use-passkey"), label: "Use a passkey" },
        { id: "c2", role: "button", target: target("use-password"), label: "Use your password" },
      ]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click" || step.target?.value !== "next") return;
        fake.state.observedPath = "/options";
        fake.state.present = new Set(["use-passkey", "use-password"]);
        fake.state.extracted = { "signed-in": choicePage };
        fake.state.signs = noSigns;
      };
      const service = generation(undefined, async () => ({ verdict: "optional" }));
      const h = start(service, { recipe: identifierOnly });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => service.judge.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email", "click:next"]);
      // Not known to be signed in: it settles as an undecided page that does not complete.
      expect(status()![0]).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
    });
    it("fails closed as a challenge when its description left out a choice", async () => {
      checkup();
      const service = generation(undefined, async () => ({ verdict: "optional" }));
      // The page offers how to receive a code as radio buttons, which no candidate names.
      fake.state.onExecute = (
        (inner) => async (message: Record<string, unknown>, tabId: number) => {
          await inner!(message, tabId);
          if (fake.state.observedPath === "/checkup")
            fake.state.extracted = { "signed-in": { ...checkupPage, inputLeftOut: true } };
        }
      )(fake.state.onExecute);
      const h = start(service, { recipe: passwordRecipe });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(executed()).toEqual(steps);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()![0]).toMatchObject({ outcome: "challenge" });
    });
    it("fails closed as a challenge when the page shows a code field", async () => {
      checkup({ code: true });
      const service = generation(undefined, async () => ({ verdict: "optional" }));
      const h = start(service, { recipe: passwordRecipe });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(executed()).toEqual(steps);
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()![0]).toMatchObject({ outcome: "challenge" });
    });
  });
});
