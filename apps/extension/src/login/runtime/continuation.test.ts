import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginChooserRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "./recipes";
import type { LoginReport } from "./reports";
import type { ConditionalDecision } from "../../passkeys/runtime";
import {
  type CustomField,
  connectionId,
  harness,
  itemId,
  origin,
  otherItemId,
  savedBinding,
  startsOf,
  target,
  uriMatch,
  userId,
} from "./__fixtures__/harness";

const { fake } = await vi.hoisted(() => import("./__fixtures__/browser"));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));

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

  /** A recipe generated from the email page: it fills the email address and clicks Next. */
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "gen-synthetic-continued",
    revision: 1,
    origin,
    slots: ["username"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    ],
    maxSubmissions: 1,
  });
  /** The service's next revision: the password page's steps appended. */
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
    fake.state.storage["pateat.login-attempts.v4"] as Record<string, unknown>[] | undefined;
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
  /** A generated login: no saved account choice, the item found by its URI. */
  function start(
    service: ReturnType<typeof generation>,
    options: {
      recipe?: LoginRecipe;
      settings?: Partial<LocalSettings>;
      report?: LoginReport[];
      custom?: CustomField[];
    } = {},
  ) {
    const reports = options.report;
    const h = harness(options.settings ?? { siteDefaults: [], bindings: [] }, {
      allowedOrigins: [],
      uris,
      username: true,
      custom: options.custom ?? [],
      generation: service,
      ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
    });
    const first = options.recipe ?? emailFirst;
    h.recipes.recipe.mockResolvedValue(first);
    h.recipes.starts.mockResolvedValue(startsOf([first.steps[0]!]));
    return h;
  }
  /** The service appends the password page and the cache holds it before the answer. */
  const answering = (h: () => ReturnType<typeof harness>, next: LoginRecipe) =>
    (async () => {
      h().recipes.recipe.mockResolvedValue(next);
      return { outcome: "recipe" as const, recipe: next };
    }) satisfies LoginGeneration["generate"];
  /**
   * What the clicks do: Next shows the password form (`next`), and Log in signs in on
   * `/home`.
   */
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
  /** Next swaps the password form in, in the same document on the same path. */
  const inPlace = (also?: () => void) =>
    onClick(() => {
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { login: passwordPage("/signin") };
      also?.();
    });
  const allSteps = ["fill:email", "click:next", "fill:password", "click:login"];
  /** The steps that carried the next step's targets to measure with them (ADR 0013). */
  const measured = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute" && "next" in entry)
      .map((entry) => {
        const { step } = (
          entry as unknown as { operation: { step: { kind: string; target?: { value: string } } } }
        ).operation;
        return `${step.kind}:${step.target?.value ?? ""}`;
      });

  it("continues in the same document on the same path and saves both slots", async () => {
    inPlace();
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    const service = generation(answering(() => h, next));
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // The final advance had no next step when it ran, so nothing was measured with it; the
    // takeover alone moved the login on.
    expect(measured()).toEqual([]);
    // One request with the revision it continues, the page's description and no value.
    expect(service.generate).toHaveBeenCalledTimes(1);
    const request = service.generate.mock.calls[0]![0];
    expect(request).toMatchObject({
      base: { recipeId: emailFirst.id, revision: 1 },
      observation: passwordPage("/signin").observation,
    });
    // The recipe already fills the username, so only the password is offered.
    expect(request.slots.map((slot) => slot.id)).toEqual(["password"]);
    expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
    // The page after the final submission is judged under the continued revision.
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(service.judge.mock.calls[0]!.slice(0, 3)).toEqual([emailFirst.id, 2, "password"]);
    expect(status()![0]).toMatchObject({
      recipeRevision: 2,
      stepIndex: 3,
      stepCount: 4,
      submissions: 2,
      maxSubmissions: 2,
    });
    // The account choice saved after the sign-in binds both pages' slots.
    expect(h.settings.settings.bindings).toEqual([
      expect.objectContaining({
        recipeId: emailFirst.id,
        slots: [
          { slot: "username", field: "username" },
          { slot: "password", field: "password" },
        ],
      }),
    ]);
    expect(h.settings.settings.siteDefaults).toEqual([expect.objectContaining({ itemId })]);
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "recipe",
        recipeId: emailFirst.id,
        baseRevision: 1,
        takenOver: true,
      },
    ]);
    // The read-only email field the recipe filled is left out of the description.
    expect(
      fake.state.messages.find((entry) => entry.type === "login.extract") as unknown,
    ).toMatchObject({ page: "login", known: [target("email")] });
  });

  it("hides the account's username from the continuation's page and the judged page", async () => {
    const shown = {
      ...describedPage("/signin", [
        { id: "c1", role: "password", target: target("password"), label: "Password for Taro" },
        { id: "c2", role: "button", target: target("login"), label: "Log in" },
        { id: "c3", role: "link", target: target("switch-taro"), label: "Switch account" },
      ]),
    };
    shown.observation = { ...shown.observation, headings: ["Hi TARO"] } as typeof shown.observation;
    inPlace(() => (fake.state.extracted = { login: shown }));
    const judged = describedPage("/home", [
      { id: "c1", role: "button", target: target("logout"), label: "Sign out ｔａｒｏ" },
    ]);
    const clicks = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      await clicks(message, tabId);
      if (fake.state.extracted["signed-in"] === homePage)
        fake.state.extracted = { "signed-in": judged };
    };
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "taro" : "synthetic-secret",
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    const request = service.generate.mock.calls[0]![0];
    expect(request.observation).toMatchObject({
      headings: ["Hi [account]"],
      candidates: [
        { id: "c1", label: "Password for [account]" },
        { id: "c2", label: "Log in" },
      ],
    });
    expect(request.observation.candidates).toHaveLength(2);
    expect(service.judge.mock.calls[0]![3].candidates).toEqual([
      { id: "c1", role: "button", target: target("logout"), label: "Sign out [account]" },
    ]);
    const sent = JSON.stringify([service.generate.mock.calls, service.judge.mock.calls]);
    expect(sent.toLowerCase()).not.toContain("taro");
    expect(sent).not.toContain("ｔａｒｏ");
  });

  it.each([
    ["a username that cannot be read", "username-unread"],
    ["a field locator that holds the username", "username-shown"],
  ] as const)("sends no continuation page with %s", async (_label, reason) => {
    inPlace(() => {
      if (reason === "username-shown")
        fake.state.extracted = {
          login: describedPage("/signin", [
            { id: "c1", role: "password", target: target("password-taro"), label: "Password" },
            { id: "c2", role: "button", target: target("login"), label: "Log in" },
          ]),
        };
    });
    let continued = false;
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    h.fields.mockImplementation(async ({ fieldId }) => {
      if (fieldId !== "login.username") return "synthetic-secret";
      if (continued && reason === "username-unread") throw new Error("locked");
      return "taro";
    });
    const clicks = fake.state.onExecute!;
    fake.state.onExecute = async (message, tabId) => {
      await clicks(message, tabId);
      continued = true;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason,
        recipeId: emailFirst.id,
        baseRevision: 1,
      },
    ]);
    expect(JSON.stringify(reports).toLowerCase()).not.toContain("taro");
  });

  it("logs the continuation's page when it leaves the device, then the answer", async () => {
    inPlace();
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    const answer = answering(() => h, next);
    // Like the service, it says just before the request leaves the device.
    const service = generation(async (_request, sent) => {
      sent?.();
      return answer();
    });
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "sent",
        recipeId: emailFirst.id,
        baseRevision: 1,
      },
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "recipe",
        recipeId: emailFirst.id,
        baseRevision: 1,
        takenOver: true,
      },
    ]);
  });

  it("after a logout, only fills the continued recipe's first page and never presses Next", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    const service = generation(answering(() => h, next));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // The site signs out and shows the email page again in the tab (ADR 0021 D).
    h.recipes.starts.mockResolvedValue(startsOf([next.steps[0]!]));
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.signIn = false;
    fake.state.extracted = {};
    onClick(() => undefined);
    expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
    await until(() => executed().length === allSteps.length + 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual([...allSteps, "fill:email"]);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).toHaveBeenCalledTimes(1);
    // The fill-only record is forgotten and the tab asks for an account.
    expect(status()).toEqual([]);
    expect(fake.state.badges[1]?.text).toBe("1");
  });

  it("reports the continuation as not taken over when its record cannot be written", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const reports: LoginReport[] = [];
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service, { report: reports });
    const { set } = fake.browser.storage.local;
    // The record naming the continued revision cannot be stored.
    fake.browser.storage.local.set = async (values: Record<string, unknown>) => {
      const records = values["pateat.login-attempts.v4"] as { recipeRevision?: number }[];
      if (records?.some((record) => record.recipeRevision === 2)) throw new Error("quota");
      return set(values);
    };
    try {
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => reports.some((entry) => entry.type === "generation"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "recipe", baseRevision: 1, takenOver: false }),
      ]);
      expect(executed()).toEqual(allSteps.slice(0, 2));
    } finally {
      fake.browser.storage.local.set = set;
    }
  });

  it("waits a second after the password form shows before sending it", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(700);
    expect(service.generate).not.toHaveBeenCalled();
    await until(() => service.generate.mock.calls.length === 1, 2_000);
    await until(settled("authenticated"));
  });

  it("continues after a same-document URL change to another path", async () => {
    let h!: ReturnType<typeof harness>;
    inPlace(() => {
      // `history.pushState`: only the tab's committed URL shows the new path.
      fake.state.tabUrls[1] = "https://login.example/signin/password";
      fake.state.observedPath = "/signin/password";
      fake.state.unusable = new Set();
      fake.state.present = new Set(["password", "login"]);
      fake.state.extracted = { login: passwordPage("/signin/password") };
    });
    const service = generation(answering(() => h, continuedOn("/signin/password")));
    h = start(service);
    uris.mockClear();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(service.generate.mock.calls[0]![0].observation.path).toBe("/signin/password");
    // The vault match for the request used the URL the page shows now.
    expect(uris.mock.calls.map(([, url]) => url)).toContain(
      "https://login.example/signin/password",
    );
  });

  it("continues in a new document on another path", async () => {
    let h!: ReturnType<typeof harness>;
    onClick(() => fake.state.gone.add("synthetic-document"));
    const service = generation(answering(() => h, continuedOn("/signin/password")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await until(() => status()?.[0]?.["state"] === "reconciling");
    expect(service.generate).not.toHaveBeenCalled();
    // The password page loads as a new document of the tab.
    fake.state.pageUrl = "https://login.example/signin/password";
    fake.state.observedPath = "/signin/password";
    fake.state.present = new Set(["password", "login"]);
    fake.state.signIn = true;
    fake.state.extracted = { login: passwordPage("/signin/password") };
    expect(await h.hello({ documentId: "password-document" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).toHaveBeenCalledTimes(1);
  });

  it("judges the email form shown again where it posted instead of continuing on it", async () => {
    // An unknown account: the email form shows again on another path, beside a recovery
    // email input that is not the recipe's.
    const again = describedPage("/signin/identifier", [
      { id: "c1", role: "text", target: target("email"), autocomplete: "username" },
      { id: "c2", role: "button", target: target("next"), label: "Next" },
    ]);
    onClick(() => {
      fake.state.observedPath = "/signin/identifier";
      fake.state.present = new Set(["email", "next"]);
      fake.state.signIn = { identifier: true };
      fake.state.extracted = { login: again, "signed-in": again };
    });
    const service = generation(undefined, async () => ({ verdict: "rejected" }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.judge.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("judges a page whose only sign-in input is an email box once the recipe fills the username", async () => {
    // A page with an unrelated email input, such as a newsletter box, after the email form.
    const page = describedPage("/welcome", [
      { id: "c1", role: "text", target: target("newsletter"), autocomplete: "email" },
      { id: "c2", role: "button", target: target("subscribe"), label: "Subscribe" },
    ]);
    onClick(() => {
      fake.state.observedPath = "/welcome";
      fake.state.present = new Set(["newsletter", "subscribe"]);
      fake.state.signIn = { identifier: true };
      fake.state.extracted = { login: page, "signed-in": page };
    });
    const service = generation(undefined, async () => ({ verdict: "unclear" }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.judge.mock.calls.length === 1);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("continues on a password input revealed below the email field it filled", async () => {
    // A progressive form: Next keeps the email field writable and reveals the password
    // input below it on the same path.
    onClick(() => {
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = { password: true };
      fake.state.extracted = { login: passwordPage("/signin") };
    });
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.generate.mock.calls[0]![0].slots.map((slot) => slot.id)).toEqual(["password"]);
  });

  it("sends the page only once it has loaded and shows the password input", async () => {
    let h!: ReturnType<typeof harness>;
    // The email form goes; the password input shows, or the page finishes loading, later.
    onClick(() => {
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.extracted = { login: passwordPage("/signin") };
      setTimeout(() => (fake.state.signIn = true), 4_000);
    });
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(service.generate).not.toHaveBeenCalled();
    await until(settled("authenticated"));
    expect(service.generate).toHaveBeenCalledTimes(1);
  });

  it("reads the page again while its description lacks the password input it qualified with", async () => {
    // Next swaps the password view in on the same path, but the first reads describe only
    // the email view: its field and Next, and no password input.
    const emailView = describedPage("/signin", [
      { id: "c1", role: "email", target: target("email"), label: "Email" },
      { id: "c2", role: "button", target: target("next"), label: "Next" },
    ]);
    inPlace(() => {
      fake.state.extracted = { login: emailView };
      setTimeout(() => (fake.state.extracted = { login: passwordPage("/signin") }), 3_000);
    });
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // Only the description with the password input was sent.
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.generate.mock.calls[0]![0].observation).toEqual(
      passwordPage("/signin").observation,
    );
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "field-not-described" }),
      expect.objectContaining({ outcome: "recipe", takenOver: true }),
    ]);
  });

  it("never sends a description without the identifier input the page qualified with", async () => {
    // A recipe that fills only a password, whose Next shows an email input that its
    // description never shows.
    const passwordFirst = parseLoginRecipe({
      ...emailFirst,
      slots: ["password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("password") }],
        },
        emailFirst.steps[1]!,
      ],
    });
    onClick(() => {
      fake.state.unusable = new Set(["password", "next"]);
      fake.state.present = new Set(["password", "next", "email"]);
      fake.state.signIn = { identifier: true };
      fake.state.extracted = {
        login: describedPage("/signin", [
          { id: "c1", role: "button", target: target("next"), label: "Next" },
        ]),
      };
    });
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { recipe: passwordFirst, report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "field-not-described" }),
    ]);
  });

  it("never sends an incomplete description and never judges the page", async () => {
    inPlace(
      () =>
        (fake.state.extracted = {
          login: { ...passwordPage("/signin", false), gap: "shadow-control" },
        }),
    );
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]!["continuation"]).toBeUndefined();
    // Logged once for the document, and the skipped judge with why.
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "incomplete-observation",
        detail: "shadow-control",
        recipeId: emailFirst.id,
        baseRevision: 1,
      },
    ]);
    expect(reports.filter((entry) => entry.type === "judge")).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "continuation", recipeRevision: 1 }),
    ]);
  });

  it("settles a sign-in page it does not continue on as unknown, whatever its signs (ADR 0029)", async () => {
    inPlace(() => {
      fake.state.unusable = new Set(["email", "next", "password", "login"]);
      fake.state.present = new Set(["password", "login"]);
      fake.state.signs = {
        password: true,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
    });
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.judge).not.toHaveBeenCalled();
    expect(reports.filter((entry) => entry.type === "state")).toEqual([
      expect.objectContaining({ s1: false, s2: true, decision: "continuing" }),
    ]);
  });

  it("logs the content script's own refusal of the continuation page", async () => {
    inPlace(() => (fake.state.extracted = { login: { ok: false, reason: "no-locator" } }));
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "no-locator", baseRevision: 1 }),
    ]);
  });

  it.each([
    ["an abstention", { outcome: "abstained", reason: "ambiguous" }],
    ["a page sent within the retry window", { outcome: "skipped", reason: "sent" }],
    ["a revoked recipe", { outcome: "unavailable", reason: "recipe-revoked" }],
    [
      "refused model output",
      { outcome: "failed", reason: "invalid-output", check: "plan", detail: "incompatible-role" },
    ],
  ] as const)("settles as unknown after %s, with no judge call", async (_label, answer) => {
    inPlace();
    const service = generation(async () => answer);
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(status()![0]).toMatchObject({ continuation: { operationId: expect.any(String) } });
    // The refused output's check and code are logged with the continuation too.
    const { outcome: answered, ...fields } = answer;
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: answered, ...fields, baseRevision: 1 }),
    ]);
    expect(reports.filter((entry) => entry.type === "judge")).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "continuation" }),
    ]);
    // A later document of the same step sends nothing again.
    fake.state.extracted = { login: passwordPage("/signin") };
    expect(await h.hello({ documentId: "again" }, false)).toEqual({
      ok: true,
      // The settled login is watched: its first step showing releases it (ADR 0027).
      starts: expect.any(Array),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
  });

  it("gives back a request refused before any model call, for a later document", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(async () => ({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    }));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    // This document does not send it again; nothing is judged.
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]!["continuation"]).toBeUndefined();
    service.generate.mockImplementation(answering(() => h, continuedOn("/signin")));
    expect(await h.hello({ documentId: "again" }, false)).toEqual({
      ok: true,
      // The settled login is watched: its first step showing releases it (ADR 0027).
      starts: expect.any(Array),
    });
    await until(settled("authenticated"));
    expect(service.generate).toHaveBeenCalledTimes(2);
    expect(executed()).toEqual(allSteps);
  });

  it("never sends a given-back request again from the same document after a path change", async () => {
    inPlace();
    const service = generation(async () => ({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status()![0]!["continuation"]).toBeUndefined();
    // `history.pushState` to another path: the page still shows the password form.
    fake.state.tabUrls[1] = "https://login.example/signin/password";
    fake.state.observedPath = "/signin/password";
    fake.state.extracted = { login: passwordPage("/signin/password") };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("offers no custom field that the recipe's generated slot map already names", async () => {
    inPlace();
    const service = generation();
    service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Branch" } }]);
    const h = start(service, {
      custom: [
        { name: "Branch", kind: "text" },
        { name: "PIN", kind: "hidden" },
      ],
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    expect(service.slotFields).toHaveBeenCalledWith(emailFirst.id);
    expect(
      service.generate.mock.calls[0]![0].slots.map((slot) => [slot.id, slot.fieldName]),
    ).toEqual([
      ["password", undefined],
      ["custom-2", "PIN"],
    ]);
  });

  it("never sends the page again after a worker restart during the request", async () => {
    inPlace();
    const lost = generation(() => new Promise(() => undefined));
    const h = start(lost);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => lost.generate.mock.calls.length === 1);
    expect(status()![0]).toMatchObject({ continuation: { operationId: expect.any(String) } });
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    try {
      const service = generation();
      const restarted = start(service);
      expect(await restarted.hello({}, false)).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      // With the continued revision in the cache, the record no longer matches it.
      const later = start(generation());
      later.recipes.recipe.mockResolvedValue(continuedOn("/signin"));
      expect(await later.hello({ documentId: "later" }, false)).toMatchObject({
        ok: false,
        reason: "recipe-not-found",
      });
    } finally {
      fake.browser.tabs.query = query;
    }
  });

  it("takes over a revision that reached the cache while a new document resumed", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    let answer!: () => void;
    const reports: LoginReport[] = [];
    const service = generation(async () => {
      h.recipes.recipe.mockResolvedValue(next);
      await new Promise<void>((resolve) => (answer = resolve));
      return { outcome: "recipe", recipe: next };
    });
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    // The form posts back to its path before the answer; the cache already holds it.
    fake.state.gone.add("synthetic-document");
    expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ recipeRevision: 2, document: { documentId: "again" } });
    answer();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    // The answer reached the document that asked after it was left.
    const generated = reports.filter((entry) => entry.type === "generation");
    expect(generated).toEqual([expect.objectContaining({ outcome: "recipe" })]);
    expect(generated[0]).not.toHaveProperty("takenOver");
  });

  it("takes over an answer that arrives after the new document's ten seconds", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    let answer!: () => void;
    const service = generation(async () => {
      await new Promise<void>((resolve) => (answer = resolve));
      return { outcome: "recipe", recipe: next };
    });
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    // The form posts back to its path; the answer, not yet cached, comes much later.
    fake.state.gone.add("synthetic-document");
    expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    answer();
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ recipeRevision: 2, document: { documentId: "again" } });
    expect(service.generate).toHaveBeenCalledTimes(1);
  });

  it("asks for the vault match again after a transient failure", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    const get = fake.browser.tabs.get;
    let failures = 0;
    fake.browser.tabs.get = (async (id: number) => {
      // The tab cannot be read for a moment once the password form shows.
      if (fake.state.present?.has("password") && failures < 3) {
        failures += 1;
        throw new Error("tab busy");
      }
      return get(id);
    }) as typeof get;
    try {
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(failures).toBe(3);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual(allSteps);
    } finally {
      fake.browser.tabs.get = get;
    }
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

  it.each<[string, LoginRecipe]>([
    [
      "changes a step the login ran",
      parseLoginRecipe({
        ...continuedOn("/signin"),
        steps: [
          { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("user") }] },
          ...continuedOn("/signin").steps.slice(1),
        ],
      }),
    ],
    ["is another recipe", parseLoginRecipe({ ...continuedOn("/signin"), id: "gen-other" })],
    ["is not newer", parseLoginRecipe({ ...continuedOn("/signin"), revision: 1 })],
  ])("never takes over a revision that %s", async (_label, next) => {
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
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "recipe", takenOver: false }),
    ]);
  });

  it("never takes over a revision the saved binding cannot fill", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    // A binding saved for the recipe holds the username slot only.
    h = start(service, {
      settings: {
        bindings: [
          {
            ...savedBinding,
            recipeId: emailFirst.id,
            slots: [{ slot: "username", field: "username" }],
          },
        ],
      },
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain("login.password");
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

  describe("probed independently", () => {
    /** A worker restart: a new runtime over the same storage finds tab 1 open. */
    async function restarted<T>(run: () => Promise<T>): Promise<T> {
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        return await run();
      } finally {
        fake.browser.tabs.query = query;
      }
    }
    const fieldReads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([request]) => request.fieldId);
    /** The page signs of ADR 0029 with none shown. */
    const noSigns = { password: false, code: false, captcha: false, invalid: false, alert: false };
    afterEach(() => {
      uris.mockReset();
      uris.mockImplementation(async () => ({ ok: true as const, data: uriMatch() }));
      fake.state.signs = undefined;
      fake.state.loaded = true;
    });

    it("restarts the stable second when the page moves to another path within it", async () => {
      let h!: ReturnType<typeof harness>;
      inPlace();
      const service = generation(answering(() => h, continuedOn("/signin/password")));
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // Shown on /signin first; 600 ms later a same-document URL change moves it.
      await vi.advanceTimersByTimeAsync(600);
      expect(service.generate).not.toHaveBeenCalled();
      fake.state.tabUrls[1] = "https://login.example/signin/password";
      fake.state.observedPath = "/signin/password";
      fake.state.unusable = new Set();
      fake.state.present = new Set(["password", "login"]);
      fake.state.extracted = { login: passwordPage("/signin/password") };
      const moved = Date.now();
      await until(() => service.generate.mock.calls.length === 1, 5_000);
      // Never sent before a full second on the new path.
      expect(Date.now() - moved).toBeGreaterThanOrEqual(1_000);
      expect(service.generate.mock.calls[0]![0].observation.path).toBe("/signin/password");
      // The email field the recipe filled on /signin is not known on this path.
      const extracts = fake.state.messages.filter((entry) => entry.type === "login.extract");
      expect(extracts.every((entry) => !("known" in entry))).toBe(true);
      await until(settled("authenticated"));
      expect(executed()).toEqual(allSteps);
    });

    it("waits a full second again when the sign-in input goes away and comes back", async () => {
      let h!: ReturnType<typeof harness>;
      inPlace();
      const service = generation(answering(() => h, continuedOn("/signin")));
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(500);
      // The password input flickers away for a moment.
      fake.state.signIn = false;
      await vi.advanceTimersByTimeAsync(600);
      expect(service.generate).not.toHaveBeenCalled();
      fake.state.signIn = true;
      const back = Date.now();
      await until(() => service.generate.mock.calls.length === 1, 5_000);
      expect(Date.now() - back).toBeGreaterThanOrEqual(1_000);
      await until(settled("authenticated"));
    });

    it.each([
      [
        "a check-your-email page",
        describedPage("/signin/check-email", [
          { id: "c1", role: "button", target: target("resend"), label: "Resend email" },
        ]),
        ["resend"],
      ],
      [
        "a passkey prompt",
        describedPage("/signin/passkey", [
          { id: "c1", role: "button", target: target("use-passkey"), label: "Use your passkey" },
        ]),
        ["use-passkey"],
      ],
    ] as const)("judges %s instead of continuing on it", async (_label, page, present) => {
      onClick(() => {
        fake.state.observedPath = page.observation.path;
        fake.state.present = new Set(present);
        fake.state.signIn = false;
        fake.state.extracted = { "signed-in": page };
      });
      const service = generation(undefined, async () => ({ verdict: "challenge" }));
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching", "challenge"));
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).toHaveBeenCalledWith(
        emailFirst.id,
        1,
        "password",
        page.observation,
        expect.any(Function),
      );
      expect(status()![0]!["continuation"]).toBeUndefined();
    });

    it("sends the page once a later round describes it completely", async () => {
      let h!: ReturnType<typeof harness>;
      inPlace(() => {
        fake.state.extracted = { login: passwordPage("/signin", false) };
        // A widget that finishes rendering a few seconds later.
        setTimeout(() => (fake.state.extracted = { login: passwordPage("/signin") }), 3_000);
      });
      const service = generation(answering(() => h, continuedOn("/signin")));
      const reports: LoginReport[] = [];
      h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(2_500);
      // Incomplete descriptions were read, none sent, and nothing recorded for them.
      expect(
        fake.state.messages.filter((entry) => entry.type === "login.extract").length,
      ).toBeGreaterThan(1);
      expect(service.generate).not.toHaveBeenCalled();
      expect(status()![0]!["continuation"]).toBeUndefined();
      await until(settled("authenticated"));
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0].observation.complete).toBe(true);
      expect(executed()).toEqual(allSteps);
      // The skipped rounds are logged once for the document, and no judge was skipped.
      expect(
        reports
          .filter((entry) => entry.type === "generation")
          .map((entry) => [entry.outcome, "reason" in entry ? entry.reason : undefined]),
      ).toEqual([
        ["skipped", "incomplete-observation"],
        ["recipe", undefined],
      ]);
      const judged = reports.filter((entry) => entry.type === "judge");
      expect(judged.map((entry) => [entry.verdict, entry.recipeRevision])).toEqual([
        ["sent", 2],
        ["signed-in", 2],
      ]);
    });

    it("may send the page again after a restart before the request was recorded", async () => {
      inPlace();
      const first = generation();
      const h = start(first);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // The worker stops while it matches the vault item for the described page's request.
      let matching = 0;
      uris.mockImplementation(async () => {
        if (!fake.state.messages.some((entry) => entry.type === "login.extract"))
          return { ok: true as const, data: uriMatch() };
        matching += 1;
        return new Promise(() => undefined);
      });
      await until(() => matching > 0, 5_000);
      expect(first.generate).not.toHaveBeenCalled();
      expect(status()![0]!["continuation"]).toBeUndefined();
      uris.mockImplementation(async () => ({ ok: true as const, data: uriMatch() }));
      await restarted(async () => {
        let again!: ReturnType<typeof harness>;
        const service = generation(answering(() => again, continuedOn("/signin")));
        again = start(service);
        expect(await again.hello({}, false)).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(service.generate).toHaveBeenCalledTimes(1);
        expect(service.generate.mock.calls[0]![0]).toMatchObject({
          base: { recipeId: emailFirst.id, revision: 1 },
        });
      });
      expect(first.generate).not.toHaveBeenCalled();
      // Next ran once, before the restart.
      expect(executed().filter((step) => step === "click:next")).toHaveLength(1);
    });

    it("resumes at the continued page's first step after a restart, never clicking Next again", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(answering(() => h, next));
      h = start(service);
      // The worker stops right after it recorded the takeover, before the next step.
      const settingsOf = h.store.handle.getMockImplementation()!;
      let stopped = 0;
      h.store.handle.mockImplementation(async () => {
        const record = status()?.[0];
        if (record?.["recipeRevision"] === 2 && record["state"] === "ready") {
          stopped += 1;
          return new Promise<never>(() => undefined);
        }
        return settingsOf();
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => stopped > 0);
      expect(status()![0]).toMatchObject({ state: "ready", recipeRevision: 2, stepIndex: 2 });
      expect(executed()).toEqual(allSteps.slice(0, 2));
      await restarted(async () => {
        const quiet = generation();
        const again = start(quiet);
        again.recipes.recipe.mockResolvedValue(next);
        expect(await again.hello({}, false)).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(quiet.generate).not.toHaveBeenCalled();
        expect(fieldReads(again)).toContain("login.password");
      });
      expect(executed()).toEqual(allSteps);
      expect(service.generate).toHaveBeenCalledTimes(1);
    });

    it("takes over another device's continuation found in the cache by a later document", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      // This device's answer could not be used (the model's output was invalid, so the
      // request is spent); another device's continuation synced meanwhile.
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "failed", reason: "invalid-output" };
      });
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(service.judge).not.toHaveBeenCalled();
      // The form posts back to its path: the new document takes the cached revision over.
      fake.state.gone.add("synthetic-document");
      expect(await h.hello({ documentId: "again" }, false)).toEqual({
        ok: true,
        // The settled login is watched: its first step showing releases it (ADR 0027).
        starts: expect.any(Array),
      });
      await until(settled("authenticated"));
      expect(executed()).toEqual(allSteps);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(status()![0]).toMatchObject({ recipeRevision: 2, document: { documentId: "again" } });
    });

    it("refuses a cached takeover the saved binding cannot fill: no fill, unknown", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "failed", reason: "invalid-output" };
      });
      h = start(service, {
        settings: {
          bindings: [
            {
              ...savedBinding,
              recipeId: emailFirst.id,
              slots: [{ slot: "username", field: "username" }],
            },
          ],
        },
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      fake.state.gone.add("synthetic-document");
      expect(await h.hello({ documentId: "again" }, false)).toEqual({
        ok: true,
        // The settled login is watched: its first step showing releases it (ADR 0027).
        starts: expect.any(Array),
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(status()![0]).toMatchObject({
        state: "reconciling",
        outcome: "unknown-submit",
        recipeRevision: 1,
      });
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(fieldReads(h)).not.toContain("login.password");
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.judge).not.toHaveBeenCalled();
    });

    it("stops at a settings sync during the request and never fills the continued page", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        h.login.settingsChanged("synced");
        return { outcome: "recipe", recipe: next };
      });
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "policy-changed"));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(status()![0]).toMatchObject({ state: "blocked", recipeRevision: 1 });
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(fieldReads(h)).not.toContain("login.password");
    });

    it("sends nothing once the login's item no longer matches the page", async () => {
      inPlace();
      const service = generation();
      const reports: LoginReport[] = [];
      const h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // The item's URI no longer matches: another item is the page's only candidate.
      uris.mockImplementation(async () => ({
        ok: true as const,
        data: uriMatch({
          candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
        }),
      }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]!["continuation"]).toBeUndefined();
      // The page qualified and was described, so it is not judged either: it settles unknown.
      expect(status()![0]).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
      expect(fieldReads(h)).not.toContain("login.password");
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "skipped", reason: "no-vault-match", baseRevision: 1 }),
      ]);
      expect(reports.filter((entry) => entry.type === "judge")).toEqual([
        expect.objectContaining({ verdict: "not-sent", reason: "continuation" }),
      ]);
    });

    /** A member ID page: a custom field and Next, no built-in sign-in input. */
    const memberPage = describedPage("/signin", [
      { id: "c1", role: "text", target: target("member"), label: "Member ID" },
      { id: "c2", role: "button", target: target("next-member"), label: "Next" },
    ]);
    /** The first page of a recipe that asks for the member ID before the email address. */
    const memberFirst = parseLoginRecipe({
      ...emailFirst,
      slots: ["branch"],
      steps: [
        { kind: "fill", path: "/signin", fields: [{ slot: "branch", target: target("member") }] },
        { kind: "click", path: "/signin", target: target("next-member"), purpose: "advance" },
      ],
    });

    it("judges a page that asks only for a custom field instead of continuing on it", async () => {
      // Next leads to a member ID page: no password, username or email input to continue on
      // (the fixed rule: only a built-in slot the recipe does not fill yet qualifies).
      onClick(() => {
        // The email form is gone; a page still showing it is never judged.
        fake.state.present = new Set(["member", "next-member"]);
        fake.state.signIn = { password: false, identifier: false };
        fake.state.extracted = { "signed-in": memberPage, login: memberPage };
      });
      const service = generation(undefined, async () => ({ verdict: "unclear" }));
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()![0]!["continuation"]).toBeUndefined();
    });

    it("continues twice: member ID, Next, email, Next, password, Log in", async () => {
      const withEmail = parseLoginRecipe({
        ...memberFirst,
        revision: 2,
        slots: ["branch", "username"],
        steps: [
          ...memberFirst.steps,
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "username", target: target("email") }],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        ],
        maxSubmissions: 2,
      });
      const withPassword = parseLoginRecipe({
        ...withEmail,
        revision: 3,
        slots: ["branch", "username", "password"],
        steps: [
          ...withEmail.steps,
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "password", target: target("password") }],
          },
          { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
        ],
        maxSubmissions: 3,
      });
      const emailPage = describedPage("/signin", [
        { id: "c1", role: "email", target: target("email"), label: "Email" },
        { id: "c2", role: "button", target: target("next"), label: "Next" },
      ]);
      // The member ID form shows first; each Next swaps in the next form on the same path.
      fake.state.present = new Set(["member", "next-member"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click") return;
        if (step.target?.value === "next-member") {
          fake.state.unusable = new Set(["member", "next-member"]);
          fake.state.present = new Set(["member", "next-member", "email", "next"]);
          fake.state.signIn = { identifier: true };
          fake.state.extracted = { login: emailPage };
        }
        if (step.target?.value === "next") {
          fake.state.unusable = new Set(["member", "next-member", "email", "next"]);
          fake.state.present = new Set([
            "member",
            "next-member",
            "email",
            "next",
            "password",
            "login",
          ]);
          fake.state.signIn = { password: true };
          fake.state.extracted = { login: passwordPage("/signin") };
        }
        if (step.target?.value === "login") {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
          fake.state.signIn = false;
          fake.state.extracted = { "signed-in": homePage };
        }
      };
      let h!: ReturnType<typeof harness>;
      const reports: LoginReport[] = [];
      const service = generation(async (request) => {
        const next = request.base?.revision === 1 ? withEmail : withPassword;
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "recipe", recipe: next };
      });
      service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Member" } }]);
      h = start(service, {
        recipe: memberFirst,
        report: reports,
        custom: [{ name: "Member", kind: "text" }],
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual([
        "fill:member",
        "click:next-member",
        "fill:email",
        "click:next",
        "fill:password",
        "click:login",
      ]);
      const requests = service.generate.mock.calls.map(([request]) => request);
      expect(requests.map((request) => request.base)).toEqual([
        { recipeId: memberFirst.id, revision: 1 },
        { recipeId: memberFirst.id, revision: 2 },
      ]);
      // Each request offers only the slots the recipe does not fill yet: never the member ID
      // field, which the recipe's generated slot map already names.
      expect(requests.map((request) => request.slots.map((slot) => slot.id))).toEqual([
        ["username", "password"],
        ["password"],
      ]);
      // The second request knows the member ID and email fields the recipe filled.
      const extracts = fake.state.messages.filter(
        (entry) => entry.type === "login.extract" && (entry as { page?: string }).page === "login",
      );
      expect(extracts.at(-1)).toMatchObject({ known: [target("member"), target("email")] });
      expect(status()![0]).toMatchObject({
        recipeRevision: 3,
        stepCount: 6,
        submissions: 3,
        maxSubmissions: 3,
      });
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: memberFirst.id,
          slots: [
            { slot: "branch", field: { custom: "Member" } },
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        }),
      ]);
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "recipe", baseRevision: 1, takenOver: true }),
        expect.objectContaining({ outcome: "recipe", baseRevision: 2, takenOver: true }),
      ]);
      // No value reaches a request or the local log.
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(reports)).not.toContain("synthetic-secret");
    });

    it("proves the sign-in by the continued revision's completion, with no judge call", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const reports: LoginReport[] = [];
      const next = continuedOn("/signin", {
        completion: [{ target: target("logout") }],
      });
      const service = generation(answering(() => h, next));
      h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"));
      expect(executed()).toEqual(allSteps);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]).toMatchObject({ recipeRevision: 2 });
      // Neither the request nor the local log carries a value.
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(reports)).not.toContain("synthetic-secret");
    });

    it("completes on confirmed sign-in evidence once the continuation was not used (ADR 0029)", async () => {
      // The member ID's Next signs in: the page shows the username in its header beside a
      // newsletter email box. The recipe fills no username, so the box qualifies and the
      // page is sent first (an ADR 0018 limitation); the model finds no login form there.
      const home = describedPage("/home", [
        { id: "c1", role: "text", target: target("newsletter"), autocomplete: "email" },
        { id: "c2", role: "button", target: target("logout"), label: "Sign out" },
      ]);
      fake.state.present = new Set(["member", "next-member"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click" || step.target?.value !== "next-member") return;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["newsletter", "logout"]);
        fake.state.signIn = { identifier: true };
        fake.state.extracted = { login: home, "signed-in": home };
        fake.state.signs = { ...noSigns, username: true };
      };
      const reports: LoginReport[] = [];
      const service = generation(async () => ({ outcome: "abstained", reason: "no-login-form" }));
      service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Member" } }]);
      const h = start(service, {
        recipe: memberFirst,
        report: reports,
        custom: [{ name: "Member", kind: "text" }],
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"));
      expect(executed()).toEqual(["fill:member", "click:next-member"]);
      // The request went first, then the evidence completed the login without the judge.
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        base: { recipeId: memberFirst.id, revision: 1 },
        observation: home.observation,
      });
      expect(service.judge).not.toHaveBeenCalled();
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "abstained", reason: "no-login-form", baseRevision: 1 }),
      ]);
      expect(reports.filter((entry) => entry.type === "state")).toEqual([
        expect.objectContaining({ s1: false, e2: true, decision: "signed-in" }),
      ]);
      expect(reports.findIndex((entry) => entry.type === "generation")).toBeLessThan(
        reports.findIndex((entry) => entry.type === "state"),
      );
      // Completed, not settled unknown: no skipped judge is logged.
      expect(reports.filter((entry) => entry.type === "judge")).toEqual([]);
      expect(status()![0]).toMatchObject({ recipeRevision: 1, submissions: 1 });
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: memberFirst.id,
          slots: [{ slot: "branch", field: { custom: "Member" } }],
        }),
      ]);
    });

    it("leaves a qualifying page unknown when its sign-in evidence is never confirmed", async () => {
      // The same page in a document that never finishes loading: the evidence never counts.
      const home = describedPage("/home", [
        { id: "c1", role: "text", target: target("newsletter"), autocomplete: "email" },
        { id: "c2", role: "button", target: target("logout"), label: "Sign out" },
      ]);
      fake.state.present = new Set(["member", "next-member"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click" || step.target?.value !== "next-member") return;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["newsletter", "logout"]);
        fake.state.signIn = { identifier: true };
        fake.state.extracted = { login: home, "signed-in": home };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
      };
      const reports: LoginReport[] = [];
      const service = generation(async () => ({ outcome: "abstained", reason: "no-login-form" }));
      service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Member" } }]);
      const h = start(service, {
        recipe: memberFirst,
        report: reports,
        custom: [{ name: "Member", kind: "text" }],
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.generate).toHaveBeenCalledTimes(1);
      // A qualifying page is still never judged.
      expect(service.judge).not.toHaveBeenCalled();
      expect(reports.filter((entry) => entry.type === "judge")).toEqual([
        expect.objectContaining({ verdict: "not-sent", reason: "continuation" }),
      ]);
      expect(h.settings.settings.bindings).toEqual([]);
    });

    it("after a logout, a fill-only login is never continued, even once Next is pressed", async () => {
      // Next signs in at once on this site: the username shows in the page header.
      onClick(() => {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.signIn = false;
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
      });
      const service = generation();
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"));
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      // The site signs out and shows the email page again: the login only fills it (ADR 0021 D).
      fake.state.signs = undefined;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["email", "next"]);
      fake.state.unusable = new Set();
      fake.state.extracted = {};
      inPlace();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => executed().length === 3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(executed()).toEqual([...allSteps.slice(0, 2), "fill:email"]);
      expect(status()).toEqual([]);
      // The person presses Next: the password form shows in the same document, which
      // announces itself again. Nothing continues the recipe there.
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { login: passwordPage("/signin") };
      expect(await h.hello({ documentId: "signed-out" }, false)).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual([...allSteps.slice(0, 2), "fill:email"]);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.some((entry) => entry.type === "login.extract")).toBe(false);
      expect(status()).toEqual([]);
      expect(fake.state.badges[1]?.text).toBe("1");
    });

    it("never presses Next again after a policy change stopped the request, and only fills", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        // A settings save lands while the model answers.
        await h.store.update(undefined, (snapshot) => snapshot);
        return { outcome: "recipe", recipe: next };
      });
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "policy-changed"));
      expect(status()![0]).toMatchObject({ recipeRevision: 1, submissions: 1 });
      // Next submitted, so the form shown again in a new document never starts a login that
      // presses it again (#292 releases only a login that submitted nothing): the tab asks
      // and the form is only filled, with no Next and no request (ADR 0021 D).
      fake.state.gone.add("synthetic-document");
      onClick(() => undefined);
      fake.state.present = new Set(["email", "next"]);
      fake.state.unusable = new Set();
      fake.state.signIn = false;
      fake.state.extracted = {};
      expect(await h.hello({ documentId: "again" })).toEqual({ ok: true });
      await until(() => executed().length === 3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual([...allSteps.slice(0, 2), "fill:email"]);
      expect(fieldReads(h)).not.toContain("login.password");
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()).toEqual([]);
      expect(fake.state.badges[1]?.text).toBe("1");
    });
  });

  describe("a login on a chooser's list (ADR 0028)", () => {
    const other = { by: "text" as const, value: "Sign in with another profile" };
    const listed: LoginChooserRecipe = {
      version: 1,
      id: "gen-synthetic-chooser",
      revision: 1,
      origin,
      chooser: { path: "/signin", other },
    };
    /** The service's next revision: the password form after a profile, as `afterAccount`. */
    const withAccount: LoginChooserRecipe = {
      ...listed,
      revision: 2,
      chooser: {
        ...listed.chooser,
        afterAccount: parseLoginRecipe({
          version: 1,
          id: listed.id,
          revision: 2,
          origin,
          slots: ["password"],
          steps: [
            {
              kind: "fill",
              path: "/signin",
              fields: [{ slot: "password", target: target("password") }],
            },
            { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
          ],
          maxSubmissions: 1,
        }),
      },
    };
    const onList = (
      service: ReturnType<typeof generation>,
      reports?: LoginReport[],
      live: Parameters<typeof harness>[1] = {},
    ) => {
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
          ...live,
        },
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.chooser.mockResolvedValue(listed);
      h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: [], list: [other] }]);
      fake.state.present = new Set();
      return h;
    };
    const clicks = () =>
      fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
        list?: Record<string, unknown>;
        operation: { step: { target?: unknown } };
      }[];

    it("clicks the account's profile, generates its branch and signs in", async () => {
      // The profile's click shows the password form in place.
      onClick(() => undefined);
      const clicked = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        const step = (message["operation"] as { step: { kind: string; target?: unknown } }).step;
        if (step.kind === "click" && JSON.stringify(step.target).includes("[account]")) {
          fake.state.present = new Set(["password", "login"]);
          fake.state.signIn = true;
          fake.state.extracted = { login: passwordPage("/signin") };
        }
        await clicked(message, tabId);
      };
      const reports: LoginReport[] = [];
      let h!: ReturnType<typeof harness>;
      const service = generation(async () => {
        h.recipes.chooser.mockResolvedValue(withAccount);
        return { outcome: "recipe", recipe: withAccount };
      });
      h = onList(service, reports);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(["click:[account]", "fill:password", "click:login"]);
      // The list's choice gets the account's username and the chooser's button.
      expect(fake.state.messages.find((entry) => entry.type === "login.choose")).toMatchObject({
        path: "/signin",
        list: { others: [], othersComplete: true, other },
      });
      expect(clicks()[0]!.list).toMatchObject({ click: "entry", others: [], other });
      expect(clicks()[1]).not.toHaveProperty("list");
      // The page after the click is the account branch's first page.
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        base: { recipeId: listed.id, revision: 1 },
        branch: "account",
      });
      // The page after the sign-in is judged on that branch.
      expect(service.judge.mock.calls[0]!.slice(0, 3)).toEqual([listed.id, 2, "password"]);
      expect(service.judge.mock.calls[0]![5]).toBe("account");
      expect(status()![0]).toMatchObject({
        recipeId: listed.id,
        recipeRevision: 2,
        chooser: { click: "entry" },
        submissions: 2,
      });
      expect(reports.find((entry) => entry.type === "start")).toMatchObject({ click: "entry" });
    });

    it("continues through the other button when no profile fits", async () => {
      fake.state.chosen = { ok: true, click: "other" };
      const service = generation();
      const h = onList(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks().length > 0);
      expect(clicks()[0]!.operation.step.target).toEqual(other);
      expect(clicks()[0]!.list).toMatchObject({ click: "other" });
      expect(status()![0]).toMatchObject({ chooser: { click: "other" } });
    });

    it("presses the continue button beside the one shown account that fits", async () => {
      const proceed = { by: "text" as const, value: "Log back in" };
      fake.state.chosen = { ok: true, click: "continue" };
      const h = onList(generation());
      h.recipes.chooser.mockResolvedValue({
        ...listed,
        chooser: { ...listed.chooser, continue: proceed },
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks().length > 0);
      expect(clicks()[0]!.operation.step.target).toEqual(proceed);
      expect(clicks()[0]!.list).toMatchObject({ click: "continue", continue: proceed, other });
      expect(status()![0]).toMatchObject({ chooser: { click: "continue" } });
    });

    it("ends account-not-listed without a click when nothing fits and there is no button", async () => {
      const miss = {
        username: "email",
        entries: 2,
        masked: 1,
        sameDomain: 1,
        fits: 0,
        beside: 0,
        other: "missing",
        continue: "none",
      };
      fake.state.chosen = { ok: true, click: "none", miss };
      const reports: LoginReport[] = [];
      const h = onList(generation(), reports);
      expect(await h.hello()).toEqual({ ok: true });
      expect(status()![0]).toMatchObject({
        state: "blocked",
        outcome: "account-not-listed",
        submissions: 0,
      });
      expect(clicks()).toEqual([]);
      // The start report carries what the list showed, for the log.
      const started = reports.find((entry) => entry.type === "start");
      expect(started).toMatchObject({ click: "none" });
      expect(started && "listMiss" in started ? started.listMiss : undefined).toEqual(miss);
    });

    it("waits for the list again when the document cannot say what it shows", async () => {
      fake.state.chosen = { ok: false };
      const h = onList(generation());
      expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
      expect(status()).toBeUndefined();
    });

    const named = { username: "name", entries: 1, beside: 0, named: 0, other: "none" };
    it.each([
      // `none` says what the list showed, and only `none` does.
      { ok: true, click: "none" },
      { ok: true, click: "entry", miss: { ...named, continue: "none" } },
      // A miss holds only counts and codes.
      { ok: true, click: "none", miss: { ...named, continue: "none", text: "taro" } },
      { ok: true, click: "none", miss: { ...named, continue: "taro" } },
      { ok: true, click: "none", miss: { ...named, continue: "none", entries: -1 } },
    ])(
      "waits for the list again when its answer's miss does not fit its click: %j",
      async (chosen) => {
        fake.state.chosen = chosen;
        const h = onList(generation());
        expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
        expect(status()).toBeUndefined();
      },
    );

    describe("when the page asks for a passkey by itself (ADR 0034)", () => {
      /**
       * Whether the list shows: only a wait for the list's accounts reads it, since the
       * entry's click target names no element for `login.observe`.
       */
      let list = { shows: true };
      beforeEach(() => {
        list = { shows: true };
        fake.state.awaitReply = (readiness) =>
          readiness.accounts === true
            ? list.shows
              ? { ok: true }
              : { ok: false, reason: "timeout" }
            : undefined;
      });
      afterEach(() => {
        fake.state.awaitReply = undefined;
      });
      const discoverable = () => vi.fn(async () => ({ passkey: true, discoverable: true }));
      /** The passkey bridge passes the list page's conditional request to the login. */
      const ask = (h: ReturnType<typeof harness>, signal = new AbortController().signal) => {
        let decided: ConditionalDecision | undefined;
        void h.login
          .conditionalRequest({ tabId: 1, origin, documentId: "synthetic-document", signal })
          .then((value) => (decided = value));
        return { decided: () => decided };
      };
      const flush = async () => {
        for (let index = 0; index < 10; index++)
          // eslint-disable-next-line no-await-in-loop
          await vi.advanceTimersByTimeAsync(0);
      };
      const answerOf = (decision: ConditionalDecision | undefined) => {
        expect(decision).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
        return decision as Extract<ConditionalDecision, { kind: "answer" }>;
      };
      const routeChanges = (reports: LoginReport[]) =>
        reports
          .filter((entry) => entry.type === "attempt" && "routeChange" in entry)
          .map((entry) => (entry as { routeChange?: string }).routeChange);
      /** The page signs in after the answer, as its home page shows instead of the list. */
      const signedIn = () => {
        list.shows = false;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.extracted = { "signed-in": homePage };
      };
      /**
       * The profile's click shows the password form in place, the service generates the
       * account branch, and the password's click signs in.
       */
      const branchSignsIn = (h: () => ReturnType<typeof harness>) => {
        onClick(() => undefined);
        const clicked = fake.state.onExecute!;
        fake.state.onExecute = async (message, tabId) => {
          const step = (message["operation"] as { step: { kind: string; target?: unknown } }).step;
          if (step.kind === "click" && JSON.stringify(step.target).includes("[account]")) {
            list.shows = false;
            fake.state.present = new Set(["password", "login"]);
            fake.state.signIn = true;
            fake.state.extracted = { login: passwordPage("/signin") };
          }
          await clicked(message, tabId);
        };
        return generation(async () => {
          h().recipes.chooser.mockResolvedValue(withAccount);
          return { outcome: "recipe", recipe: withAccount };
        });
      };

      it("answers a request that waits before the list announces, clicking nothing on it", async () => {
        const reports: LoginReport[] = [];
        const h = onList(generation(), reports, { passkeys: discoverable() });
        const request = ask(h);
        await flush();
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => request.decided() !== undefined, 5_000);
        const answer = answerOf(request.decided());
        expect(status()![0]).toMatchObject({
          route: "passkey",
          state: "submit-intent",
          stepCount: 1,
          submissions: 1,
          chooser: { click: "entry" },
        });
        // The list's choice is still made and recorded; nothing on the list is clicked.
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.choose");
        signedIn();
        answer.answered(true);
        await until(settled("authenticated"), 20_000);
        expect(status()![0]).toMatchObject({ route: "passkey", chooser: { click: "entry" } });
        expect(clicks()).toEqual([]);
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          route: "passkey",
          click: "entry",
        });
        expect(routeChanges(reports)).toEqual([]);
      });

      it("switches to the passkey when the request comes while the click waits for the list", async () => {
        const reports: LoginReport[] = [];
        const h = onList(generation(), reports, { passkeys: discoverable() });
        let request: ReturnType<typeof ask> | undefined;
        // The page asks for a passkey while its list renders.
        fake.state.onAwait = () => {
          request ??= ask(h);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => request?.decided() !== undefined, 5_000);
        const answer = answerOf(request!.decided());
        expect(status()![0]).toMatchObject({
          route: "passkey",
          variant: 0,
          state: "submit-intent",
          submissions: 1,
          chooser: { click: "entry" },
        });
        signedIn();
        answer.answered(true);
        await until(settled("authenticated"), 20_000);
        expect(clicks()).toEqual([]);
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          route: "password",
          click: "entry",
        });
        expect(routeChanges(reports)).toEqual(["page-request"]);
      });

      it("keeps the password once the list was clicked, and withholds the request after the sign-in", async () => {
        const reports: LoginReport[] = [];
        let h!: ReturnType<typeof harness>;
        const service = branchSignsIn(() => h);
        h = onList(service, reports, { passkeys: discoverable() });
        let request: ReturnType<typeof ask> | undefined;
        // The page asks for a passkey only as its list is clicked.
        const clicked = fake.state.onExecute!;
        fake.state.onExecute = async (message, tabId) => {
          request ??= ask(h);
          await clicked(message, tabId);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(executed()).toEqual(["click:[account]", "fill:password", "click:login"]);
        expect(status()![0]).toMatchObject({ route: "password", chooser: { click: "entry" } });
        await until(() => request?.decided() !== undefined, 5_000);
        expect(request!.decided()).toEqual({ kind: "withhold" });
        expect(routeChanges(reports)).toEqual([]);
      });

      it("falls back to the list's click when the item cannot answer", async () => {
        const reports: LoginReport[] = [];
        let h!: ReturnType<typeof harness>;
        const service = branchSignsIn(() => h);
        h = onList(service, reports, { passkeys: discoverable() });
        const request = ask(h);
        await flush();
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => request.decided() !== undefined, 5_000);
        expect(status()![0]).toMatchObject({ route: "passkey", variant: 0 });
        answerOf(request.decided()).answered(false);
        // The passkey bridge passes the request to the login again after a failure.
        const again = ask(h);
        await until(settled("authenticated"));
        expect(executed()).toEqual(["click:[account]", "fill:password", "click:login"]);
        expect(clicks()[0]!.list).toMatchObject({ click: "entry" });
        expect(status()![0]).toMatchObject({
          route: "password",
          variant: 0,
          chooser: { click: "entry" },
        });
        expect(routeChanges(reports)).toEqual(["answer-failed"]);
        await until(() => again.decided() !== undefined, 5_000);
        expect(again.decided()).toEqual({ kind: "withhold" });
      });

      it("falls back to the list's click when the request went away before the answer", async () => {
        const reports: LoginReport[] = [];
        const controller = new AbortController();
        // The page cancels its request while the login starts.
        const passkeys = vi.fn(async () => {
          controller.abort();
          return { passkey: true, discoverable: true };
        });
        let h!: ReturnType<typeof harness>;
        const service = branchSignsIn(() => h);
        h = onList(service, reports, { passkeys });
        ask(h, controller.signal);
        await flush();
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(executed()).toEqual(["click:[account]", "fill:password", "click:login"]);
        expect(status()![0]).toMatchObject({ route: "password", variant: 0 });
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          route: "passkey",
          click: "entry",
        });
        expect(routeChanges(reports)).toEqual(["request-missing"]);
      });

      it("answers on the other button's route with the account planned again for it", async () => {
        fake.state.chosen = { ok: true, click: "other" };
        const reports: LoginReport[] = [];
        const h = onList(generation(), reports, { passkeys: discoverable() });
        const request = ask(h);
        await flush();
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => request.decided() !== undefined, 5_000);
        const answer = answerOf(request.decided());
        expect(status()![0]).toMatchObject({
          route: "passkey",
          variant: 0,
          state: "submit-intent",
          account: { connectionId, itemId },
          chooser: { click: "other" },
        });
        signedIn();
        answer.answered(true);
        await until(settled("authenticated"), 20_000);
        expect(clicks()).toEqual([]);
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          route: "passkey",
          click: "other",
        });
      });

      describe("while the list may still show after the answer", () => {
        it("holds the login while the list shows, then falls back to its click", async () => {
          const reports: LoginReport[] = [];
          let h!: ReturnType<typeof harness>;
          const service = branchSignsIn(() => h);
          h = onList(service, reports, { passkeys: discoverable() });
          const request = ask(h);
          await flush();
          expect(await h.hello()).toEqual({ ok: true });
          await until(() => request.decided() !== undefined, 5_000);
          answerOf(request.decided()).answered(true);
          // The site may still be exchanging the assertion while its list shows.
          await vi.advanceTimersByTimeAsync(12_000);
          expect(status()![0]).toMatchObject({ route: "passkey", state: "awaiting-result" });
          expect(executed()).toEqual([]);
          expect(service.judge).not.toHaveBeenCalled();
          await until(settled("authenticated"), 30_000);
          expect(executed()).toEqual(["click:[account]", "fill:password", "click:login"]);
          expect(status()![0]).toMatchObject({
            route: "password",
            variant: 0,
            chooser: { click: "entry" },
          });
          expect(routeChanges(reports)).toEqual(["sign-in-shown"]);
          // Only the page after the password's click was judged.
          expect(service.judge).toHaveBeenCalledTimes(1);
        });

        it("signs in on the passkey when the site leaves the list a few seconds after the answer", async () => {
          const reports: LoginReport[] = [];
          const service = generation();
          const h = onList(service, reports, { passkeys: discoverable() });
          const request = ask(h);
          await flush();
          expect(await h.hello()).toEqual({ ok: true });
          await until(() => request.decided() !== undefined, 5_000);
          answerOf(request.decided()).answered(true);
          // The list shows for a while before the site moves to its signed-in page.
          setTimeout(signedIn, 5_000);
          await vi.advanceTimersByTimeAsync(4_500);
          expect(status()![0]).toMatchObject({ route: "passkey", state: "awaiting-result" });
          expect(service.judge).not.toHaveBeenCalled();
          await until(settled("authenticated"), 20_000);
          expect(status()![0]).toMatchObject({ route: "passkey", chooser: { click: "entry" } });
          expect(executed()).toEqual([]);
          expect(routeChanges(reports)).toEqual([]);
        });

        it("holds a login on the other button's route while the list shows, then clicks it", async () => {
          fake.state.chosen = { ok: true, click: "other" };
          const reports: LoginReport[] = [];
          const service = generation();
          const h = onList(service, reports, { passkeys: discoverable() });
          const request = ask(h);
          await flush();
          expect(await h.hello()).toEqual({ ok: true });
          await until(() => request.decided() !== undefined, 5_000);
          answerOf(request.decided()).answered(true);
          await vi.advanceTimersByTimeAsync(12_000);
          expect(status()![0]).toMatchObject({ route: "passkey", state: "awaiting-result" });
          expect(executed()).toEqual([]);
          expect(service.judge).not.toHaveBeenCalled();
          await until(() => executed().length > 0, 10_000);
          expect(executed()[0]).toBe(`click:${other.value}`);
          expect(clicks()[0]!.list).toMatchObject({ click: "other" });
          expect(routeChanges(reports)).toEqual(["sign-in-shown"]);
        });
      });

      it("ends account-not-listed without an answer when nothing on the list fits", async () => {
        fake.state.chosen = {
          ok: true,
          click: "none",
          miss: {
            username: "name",
            entries: 0,
            beside: 1,
            named: 0,
            other: "none",
            continue: "one",
          },
        };
        const reports: LoginReport[] = [];
        const h = onList(generation(), reports, { passkeys: discoverable() });
        const request = ask(h);
        await flush();
        expect(await h.hello()).toEqual({ ok: true });
        expect(status()![0]).toMatchObject({
          state: "blocked",
          outcome: "account-not-listed",
          submissions: 0,
        });
        await until(() => request.decided() !== undefined, 5_000);
        expect(request.decided()).toEqual({ kind: "delegate", reason: "login-ended" });
        expect(clicks()).toEqual([]);
        // The plan took the passkey route for the waiting request; the list then ended it.
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          route: "passkey",
          click: "none",
        });
        expect(status()![0]).toMatchObject({ route: "passkey" });
      });
    });
  });

  describe("for an item without a password, with a passkey (ADR 0036)", () => {
    /** The generated login of an item whose password is empty, with a passkey. */
    function keyOnly(service: ReturnType<typeof generation>) {
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        },
      );
      h.recipes.recipe.mockResolvedValue(emailFirst);
      h.recipes.starts.mockResolvedValue(startsOf([emailFirst.steps[0]!]));
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          for (const field of response.catalog.connections[0]!.items[0]!.fields)
            if (field.id === "login.password") field.empty = true;
        return response;
      });
      return h;
    }
    const passwordRead = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.some(([read]) => read.fieldId === "login.password");
    /** Next leads to a password page on another path, which the recipe does not fill yet. */
    const toPasswordPage = () =>
      onClick(() => {
        fake.state.observedPath = "/password";
        fake.state.present = new Set(["password", "login"]);
        fake.state.signIn = true;
        fake.state.extracted = { login: passwordPage("/password") };
      });

    it("continues the recipe on the password page and stops at its password", async () => {
      toPasswordPage();
      let h!: ReturnType<typeof harness>;
      const service = generation(answering(() => h, continuedOn("/password")));
      h = keyOnly(service);
      expect(await h.hello()).toEqual({ ok: true });
      expect(status()![0]).toMatchObject({ stepCount: 2, stopAt: 2, maxSubmissions: 2 });
      await until(settled("watching"));
      // The page is sent once, offering the password slot though the item's is empty.
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0].slots).toContainEqual(
        expect.objectContaining({ id: "password" }),
      );
      // The continued revision is taken over; its password fill is the new stop.
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        stepIndex: 2,
        stepCount: 4,
        stopAt: 2,
        outcome: "challenge",
      });
      expect(executed()).toEqual(["fill:email", "click:next"]);
      expect(service.judge).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });

    it("answers the password page's request at the continued stop", async () => {
      let h!: ReturnType<typeof harness>;
      let decided: ConditionalDecision | undefined;
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(continuedOn("/password"));
        // The password page asks for a passkey by itself while the page is continued.
        void h.login
          .conditionalRequest({
            tabId: 1,
            origin,
            documentId: "synthetic-document",
            signal: new AbortController().signal,
          })
          .then((value) => (decided = value));
        return { outcome: "recipe" as const, recipe: continuedOn("/password") };
      });
      toPasswordPage();
      h = keyOnly(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => decided !== undefined);
      expect(decided).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
      expect(status()![0]).toMatchObject({
        state: "reconciling",
        stepIndex: 2,
        stepCount: 4,
        stopAt: 2,
        submissions: 2,
      });
      expect(executed()).toEqual(["fill:email", "click:next"]);
      expect(passwordRead(h)).toBe(false);
    });

    it("stops after Continue when the continuation abstains, with no judge call", async () => {
      toPasswordPage();
      const service = generation();
      const h = keyOnly(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]).toMatchObject({
        recipeRevision: 1,
        stepIndex: 2,
        stepCount: 2,
        stopAt: 2,
        outcome: "challenge",
      });
      expect(executed()).toEqual(["fill:email", "click:next"]);
      expect(passwordRead(h)).toBe(false);
    });

    it("runs a passkey button the judge learns on the page after Continue", async () => {
      const securityKey = target("use-passkey");
      const learned = parseLoginRecipe({
        ...emailFirst,
        revision: 2,
        handlers: [{ kind: "passkey", path: "/passkey", target: securityKey }],
      });
      onClick(() => {
        // A page that asks for nothing until its button is pressed.
        fake.state.observedPath = "/passkey";
        fake.state.present = new Set(["use-passkey"]);
        fake.state.extracted = {
          "signed-in": describedPage("/passkey", [
            { id: "c1", role: "button", target: securityKey, label: "Use a passkey" },
          ]),
        };
      });
      let judged = 0;
      const service = generation(undefined, async () => {
        judged += 1;
        return judged === 1 ? { verdict: "challenge", recipe: learned } : { verdict: "signed-in" };
      });
      const h = keyOnly(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 3);
      expect(executed()).toEqual(["fill:email", "click:next", "click:use-passkey"]);
      // The handler went in before the stop, which moved along with the plan.
      expect(status()![0]).toMatchObject({ recipeRevision: 2, stepCount: 3, stopAt: 3 });
      expect(service.generate).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });

    /**
     * Such a login with other item fields: custom fields, the built-in TOTP field (`held`
     * or `empty`), a saved binding, and reports collected. The TOTP field reads a code.
     */
    function keyOnlyWith(
      service: ReturnType<typeof generation>,
      options: {
        recipe?: LoginRecipe;
        custom?: CustomField[];
        totp?: "held" | "empty";
        settings?: Partial<LocalSettings>;
        report?: LoginReport[];
      } = {},
    ) {
      const used = options.recipe ?? emailFirst;
      const reports = options.report;
      const h = harness(options.settings ?? { siteDefaults: [], bindings: [] }, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: options.custom ?? [],
        generation: service,
        passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
      });
      h.recipes.recipe.mockResolvedValue(used);
      h.recipes.starts.mockResolvedValue(startsOf([used.steps[0]!]));
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (!response.ok) return response;
        const item = response.catalog.connections[0]!.items[0]!;
        for (const field of item.fields) if (field.id === "login.password") field.empty = true;
        if (options.totp)
          item.fields.push({
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
            ...(options.totp === "empty" ? { empty: true as const } : {}),
          });
        return response;
      });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
      return h;
    }
    const reads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([read]) => read.fieldId);
    /** Next leads to a page on `path` showing `present`, described as a sign-in page. */
    const toPage = (path: string, present: string[]) =>
      onClick(() => {
        fake.state.observedPath = path;
        fake.state.present = new Set(present);
        fake.state.signIn = true;
        fake.state.extracted = { login: passwordPage(path) };
      });
    /** The service's next revision: these steps appended on `/password`. */
    const continuedWith = (slots: string[], steps: object[], maxSubmissions = 2) =>
      parseLoginRecipe({
        ...emailFirst,
        revision: 2,
        slots: ["username", ...slots],
        steps: [...emailFirst.steps, ...steps],
        maxSubmissions,
      });
    const fillOn = (slot: string, value: string, path = "/password") => ({
      kind: "fill",
      path,
      fields: [{ slot, target: target(value) }],
    });
    const logIn = {
      kind: "click",
      path: "/password",
      target: target("login"),
      purpose: "submit",
    };
    /** The values the login's fills typed, by slot. */
    const typed = () =>
      fake.state.messages.flatMap((entry) =>
        entry.type === "login.execute" ? (entry.values ?? []).map((value) => value.slot) : [],
      );

    it("types a continued TOTP code and stops at the password after it", async () => {
      toPage("/password", ["code", "password", "login"]);
      let h!: ReturnType<typeof harness>;
      const next = continuedWith(
        ["totp", "password"],
        [fillOn("totp", "code"), fillOn("password", "password"), logIn],
      );
      const service = generation(answering(() => h, next));
      h = keyOnlyWith(service, { totp: "held" });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        stepIndex: 3,
        stepCount: 5,
        stopAt: 3,
        outcome: "challenge",
      });
      expect(executed()).toEqual(["fill:email", "click:next", "fill:code"]);
      expect(typed()).toEqual(["username", "totp"]);
      // The code was read once, for its fill; the password never was.
      expect(reads(h).filter((fieldId) => fieldId === "login.totp-code")).toHaveLength(1);
      expect(passwordRead(h)).toBe(false);
    });

    it("does not take over a continuation that first fills a value the item lacks", async () => {
      toPage("/password", ["code", "password", "login"]);
      let h!: ReturnType<typeof harness>;
      const next = continuedWith(
        ["totp", "password"],
        [fillOn("totp", "code"), fillOn("password", "password"), logIn],
      );
      const service = generation(answering(() => h, next));
      h = keyOnlyWith(service, { totp: "empty" });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(service.generate).toHaveBeenCalledTimes(1);
      // The login stays on its own revision, at its stop past Continue.
      expect(status()![0]).toMatchObject({
        recipeRevision: 1,
        stepIndex: 2,
        stepCount: 2,
        stopAt: 2,
        outcome: "challenge",
      });
      expect(executed()).toEqual(["fill:email", "click:next"]);
      expect(reads(h)).not.toContain("login.totp-code");
      expect(passwordRead(h)).toBe(false);
    });

    it.each([
      ["a hidden custom field", { name: "Secret", kind: "hidden" as const }],
      [
        "a field Linked to the password",
        { name: "Secret", kind: "linked" as const, linkedFieldId: "login.password" },
      ],
    ])("stops at a continued slot bound to %s, never reading it", async (_label, field) => {
      toPage("/password", ["password", "login"]);
      let h!: ReturnType<typeof harness>;
      const next = continuedWith(["secret"], [fillOn("secret", "password"), logIn]);
      const service = generation(answering(() => h, next));
      service.slotFields.mockResolvedValue([{ slot: "secret", field: { custom: "Secret" } }]);
      h = keyOnlyWith(service, { custom: [field] });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        stepIndex: 2,
        stepCount: 4,
        stopAt: 2,
        outcome: "challenge",
      });
      expect(executed()).toEqual(["fill:email", "click:next"]);
      // Only the username was read; the bound field never is.
      expect(new Set(reads(h))).toEqual(new Set(["login.username"]));
    });

    it("stops past the continued steps again when they fill no password and advance", async () => {
      // A sign-in page whose continuation only presses another button that advances.
      toPage("/password", ["password", "login", "use-password"]);
      let h!: ReturnType<typeof harness>;
      const next = continuedWith(
        [],
        [{ kind: "click", path: "/password", target: target("use-password"), purpose: "advance" }],
      );
      // The first page is continued; the page after it is not.
      const service = generation(async (request) => {
        if (request.base?.revision !== 1) return { outcome: "abstained", reason: "ambiguous" };
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "recipe", recipe: next };
      });
      h = keyOnlyWith(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("watching"));
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        stepIndex: 3,
        stepCount: 3,
        stopAt: 3,
        outcome: "challenge",
      });
      expect(executed()).toEqual(["fill:email", "click:next", "click:use-password"]);
      expect(service.judge).not.toHaveBeenCalled();
      expect(passwordRead(h)).toBe(false);
    });

    it.each([
      [
        "the password slot bound to another field",
        { name: "Secret", kind: "text" as const },
        continuedOn("/password", { revision: 1 }),
        [
          { slot: "username", field: "username" },
          { slot: "password", field: { custom: "Secret" } },
        ],
      ],
      [
        "a hidden field",
        { name: "PIN", kind: "hidden" as const },
        parseLoginRecipe({
          ...emailFirst,
          slots: ["username", "pin"],
          steps: [
            {
              kind: "fill",
              path: "/signin",
              fields: [
                { slot: "username", target: target("email") },
                { slot: "pin", target: target("pin") },
              ],
            },
            emailFirst.steps[1]!,
          ],
        }),
        [
          { slot: "username", field: "username" },
          { slot: "pin", field: { custom: "PIN" } },
        ],
      ],
    ])(
      "refuses a route that reads a password from %s, naming it",
      async (_label, field, used, slots) => {
        const reports: LoginReport[] = [];
        const service = generation();
        const h = keyOnlyWith(service, {
          recipe: used,
          custom: [field],
          report: reports,
          settings: {
            siteDefaults: [],
            bindings: [{ ...savedBinding, recipeId: used.id, slots } as SavedLoginBinding],
          },
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
        expect(reports).toContainEqual(
          expect.objectContaining({
            type: "refused",
            reason: "no-route",
            detail: "password-empty:password-field",
          }),
        );
        expect(executed()).toEqual([]);
        expect(h.fields).not.toHaveBeenCalled();
      },
    );

    describe("on a chooser's list (owner, 2026-10-13 06:32 UTC)", () => {
      const other = { by: "text" as const, value: "Sign in with another profile" };
      /** The button beside one shown account (ADR 0028). */
      const proceed = { by: "text" as const, value: "Log back in" };
      const listed: LoginChooserRecipe = {
        version: 1,
        id: "gen-synthetic-chooser",
        revision: 1,
        origin,
        chooser: { path: "/signin", other },
      };
      /** A branch recipe under the chooser's ID, at `revision`. */
      const branchOf = (
        revision: number,
        slots: string[],
        steps: object[],
        maxSubmissions = 1,
      ): LoginRecipe =>
        parseLoginRecipe({
          version: 1,
          id: listed.id,
          revision,
          origin,
          slots,
          steps,
          maxSubmissions,
        });
      /** After the profile's click: the password form on `/password`. */
      const passwordBranch = (revision = 1) =>
        branchOf(revision, ["password"], [fillOn("password", "password"), logIn]);
      /** After another account: the email and Continue on `/email`. */
      const identifierBranch = (revision = 1, more: object[] = []) =>
        branchOf(
          revision,
          more.length ? ["username", "password"] : ["username"],
          [
            fillOn("username", "email", "/email"),
            { kind: "click", path: "/email", target: target("next"), purpose: "advance" },
            ...more,
          ],
          more.length ? 2 : 1,
        );
      /** `chooser` with the button beside one shown account. */
      const withContinue = (chooser: LoginChooserRecipe): LoginChooserRecipe => ({
        ...chooser,
        chooser: { ...chooser.chooser, continue: proceed },
      });
      const withBranch = (
        revision: number,
        branches: { afterAccount?: LoginRecipe; afterOther?: LoginRecipe },
      ): LoginChooserRecipe => ({
        ...listed,
        revision,
        chooser: { ...listed.chooser, ...branches },
      });
      /** A login of the item without a password, on the list, its recipe `chooser`. */
      const keyOnList = (
        service: ReturnType<typeof generation>,
        chooser: LoginChooserRecipe,
        options: Parameters<typeof keyOnlyWith>[1] = {},
      ) => {
        const h = keyOnlyWith(service, options);
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.chooser.mockImplementation(async (at?: string) =>
          at === undefined || at === origin ? chooser : undefined,
        );
        h.recipes.starts.mockImplementation(async (at: string) =>
          at === origin ? [{ path: "/signin", steps: [], list: [other] }] : [],
        );
        fake.state.present = new Set();
        return h;
      };
      /**
       * What the clicks do: the profile's row shows the password page, the other button the
       * email page, and its Next the password page.
       */
      const onListClick = (also?: (value: string) => void) => {
        fake.state.onExecute = async (message) => {
          const step = (
            message["operation"] as { step: { kind: string; target?: { value: string } } }
          ).step;
          if (step.kind !== "click") return;
          const value = step.target?.value ?? "";
          if (value === "[account]" || value === "next" || value === proceed.value) {
            fake.state.observedPath = "/password";
            fake.state.present = new Set(["password", "login"]);
            fake.state.signIn = true;
            fake.state.extracted = { login: passwordPage("/password") };
          }
          if (value === other.value) {
            fake.state.observedPath = "/email";
            fake.state.present = new Set(["email", "next"]);
            fake.state.signIn = true;
          }
          also?.(value);
        };
      };
      /** The passkey bridge passes the top document's conditional request to the login. */
      const ask = (h: ReturnType<typeof harness>, documentId = "synthetic-document") => {
        let decided: ConditionalDecision | undefined;
        void h.login
          .conditionalRequest({
            tabId: 1,
            origin,
            documentId,
            signal: new AbortController().signal,
          })
          .then((value) => (decided = value));
        return () => decided;
      };
      const attemptReports = (reports: LoginReport[]) =>
        reports.flatMap((entry) => (entry.type === "attempt" ? [entry] : []));

      it("answers the password page's request after the stored branch's row click", async () => {
        const reports: LoginReport[] = [];
        const service = generation();
        const h = keyOnList(service, withBranch(1, { afterAccount: passwordBranch() }), {
          report: reports,
        });
        let decided: (() => ConditionalDecision | undefined) | undefined;
        // The password page asks for a passkey by itself as soon as the row is clicked.
        onListClick((value) => {
          if (value === "[account]") decided = ask(h);
        });
        expect(await h.hello()).toEqual({ ok: true });
        expect(status()![0]).toMatchObject({
          chooser: { click: "entry" },
          stepCount: 3,
          stopAt: 1,
          maxSubmissions: 2,
        });
        await until(() => decided?.() !== undefined);
        expect(decided!()).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
        // The row's click and the answer at the stop are the branch's two submissions.
        expect(status()![0]).toMatchObject({
          state: "reconciling",
          stepIndex: 1,
          stopAt: 1,
          submissions: 2,
        });
        expect(executed()).toEqual(["click:[account]"]);
        expect(service.generate).not.toHaveBeenCalled();
        expect(passwordRead(h)).toBe(false);
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          route: "password",
          click: "entry",
        });
        const attempts = attemptReports(reports);
        expect(attempts).not.toEqual([]);
        for (const entry of attempts) expect(entry).toMatchObject({ stop: "password" });
      });

      it("generates the missing branch after the row's click and stops at its password", async () => {
        onListClick();
        const reports: LoginReport[] = [];
        let h!: ReturnType<typeof harness>;
        const continued = withBranch(2, { afterAccount: passwordBranch(2) });
        const service = generation(async () => {
          h.recipes.chooser.mockResolvedValue(continued);
          return { outcome: "recipe", recipe: continued };
        });
        h = keyOnList(service, listed, { report: reports });
        expect(await h.hello()).toEqual({ ok: true });
        // The click alone, with one submission kept for the answer.
        expect(status()![0]).toMatchObject({
          chooser: { click: "entry" },
          stepCount: 1,
          stopAt: 1,
          maxSubmissions: 2,
        });
        await until(settled("watching"));
        // The page after the click is sent once as the account branch's first page,
        // offering the password slot though the item's password is empty.
        expect(service.generate).toHaveBeenCalledTimes(1);
        const request = service.generate.mock.calls[0]![0];
        expect(request).toMatchObject({
          base: { recipeId: listed.id, revision: 1 },
          branch: "account",
        });
        expect(request.slots).toContainEqual(expect.objectContaining({ id: "password" }));
        expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
        // The branch is taken over; its password fill is the stop, which never runs.
        expect(status()![0]).toMatchObject({
          recipeRevision: 2,
          stepIndex: 1,
          stepCount: 3,
          stopAt: 1,
          maxSubmissions: 2,
          submissions: 1,
          outcome: "challenge",
        });
        expect(executed()).toEqual(["click:[account]"]);
        expect(service.judge).not.toHaveBeenCalled();
        expect(passwordRead(h)).toBe(false);
        expect(attemptReports(reports).at(-1)).toMatchObject({
          state: "watching",
          stop: "password",
          reason: "password-empty",
        });
      });

      it("continues an identifier-only branch after another account, then stops", async () => {
        fake.state.chosen = { ok: true, click: "other" };
        onListClick();
        let h!: ReturnType<typeof harness>;
        const continued = withBranch(2, {
          afterOther: identifierBranch(2, [fillOn("password", "password"), logIn]),
        });
        const service = generation(async () => {
          h.recipes.chooser.mockResolvedValue(continued);
          return { outcome: "recipe", recipe: continued };
        });
        h = keyOnList(service, withBranch(1, { afterOther: identifierBranch() }));
        expect(await h.hello()).toEqual({ ok: true });
        // The click, the email and Continue; the stop lies just past them.
        expect(status()![0]).toMatchObject({
          chooser: { click: "other" },
          stepCount: 3,
          stopAt: 3,
          maxSubmissions: 3,
        });
        await until(settled("watching"));
        expect(service.generate).toHaveBeenCalledTimes(1);
        expect(service.generate.mock.calls[0]![0]).toMatchObject({
          base: { recipeId: listed.id, revision: 1 },
          branch: "other",
        });
        expect(status()![0]).toMatchObject({
          recipeRevision: 2,
          stepIndex: 3,
          stepCount: 5,
          stopAt: 3,
          submissions: 2,
          maxSubmissions: 3,
          outcome: "challenge",
        });
        expect(executed()).toEqual([`click:${other.value}`, "fill:email", "click:next"]);
        expect(typed()).toEqual(["username"]);
        expect(passwordRead(h)).toBe(false);
      });

      it("ends at the stop past the click when the generated branch cannot take it", async () => {
        onListClick();
        const reports: LoginReport[] = [];
        let h!: ReturnType<typeof harness>;
        // The branch asks for a code the item lacks before the password.
        const continued = withBranch(2, {
          afterAccount: branchOf(
            2,
            ["password", "totp"],
            [fillOn("totp", "code"), fillOn("password", "password"), logIn],
          ),
        });
        const service = generation(async () => {
          h.recipes.chooser.mockResolvedValue(continued);
          return { outcome: "recipe", recipe: continued };
        });
        h = keyOnList(service, listed, { totp: "empty", report: reports });
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("watching"));
        expect(service.generate).toHaveBeenCalledTimes(1);
        // Not taken over: the login stays on its own revision, at its stop past the click.
        expect(status()![0]).toMatchObject({
          recipeRevision: 1,
          stepIndex: 1,
          stepCount: 1,
          stopAt: 1,
          outcome: "challenge",
        });
        expect(executed()).toEqual(["click:[account]"]);
        expect(reads(h)).not.toContain("login.totp-code");
        expect(passwordRead(h)).toBe(false);
        expect(attemptReports(reports).at(-1)).toMatchObject({
          state: "watching",
          stop: "password",
          reason: "password-empty:fills-lacking",
        });
      });

      /** A stored branch that asks for a code the item lacks before the password. */
      const codeBranch = () =>
        branchOf(
          1,
          ["password", "totp"],
          [fillOn("totp", "code"), fillOn("password", "password"), logIn],
        );

      it.each([
        ["the account's row", "entry"],
        ["the button beside the account", "continue"],
      ] as const)(
        "reads the list, then refuses an account branch that cannot take the stop at %s",
        async (_label, click) => {
          fake.state.chosen = { ok: true, click };
          onListClick();
          const reports: LoginReport[] = [];
          const h = keyOnList(
            generation(),
            withContinue(
              withBranch(1, { afterAccount: codeBranch(), afterOther: identifierBranch() }),
            ),
            { totp: "empty", report: reports },
          );
          expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
          expect(reports).toContainEqual(
            expect.objectContaining({
              type: "refused",
              reason: "no-route",
              detail: "password-empty:fills-lacking",
            }),
          );
          // The list was asked what fits, and nothing on it was pressed.
          expect(fake.state.messages.some((entry) => entry.type === "login.choose")).toBe(true);
          expect(executed()).toEqual([]);
          expect(status() ?? []).toEqual([]);
          expect(reads(h)).not.toContain("login.totp-code");
          expect(passwordRead(h)).toBe(false);
        },
      );

      it("goes on through another account when the account branch cannot take the stop", async () => {
        // The item's account is not listed, so the list leads to `other`.
        fake.state.chosen = { ok: true, click: "other" };
        onListClick();
        const service = generation();
        const h = keyOnList(
          service,
          withBranch(1, { afterAccount: codeBranch(), afterOther: identifierBranch() }),
          { totp: "empty" },
        );
        expect(await h.hello()).toEqual({ ok: true });
        expect(status()![0]).toMatchObject({
          chooser: { click: "other" },
          stepCount: 3,
          stopAt: 3,
          maxSubmissions: 3,
        });
        await until(settled("watching"));
        expect(executed()).toEqual([`click:${other.value}`, "fill:email", "click:next"]);
        expect(reads(h)).not.toContain("login.totp-code");
        expect(passwordRead(h)).toBe(false);
      });

      it("ends account-not-listed on the click alone when nothing fits and there is no button", async () => {
        fake.state.chosen = {
          ok: true,
          click: "none",
          miss: {
            username: "email",
            entries: 1,
            masked: 0,
            sameDomain: 0,
            fits: 0,
            beside: 0,
            other: "missing",
            continue: "none",
          },
        };
        const h = keyOnList(generation(), withBranch(1, { afterAccount: codeBranch() }), {
          totp: "empty",
        });
        expect(await h.hello()).toEqual({ ok: true });
        expect(status()![0]).toMatchObject({
          state: "blocked",
          outcome: "account-not-listed",
          stepCount: 1,
          stopAt: 1,
          submissions: 0,
        });
        expect(executed()).toEqual([]);
      });

      it("refuses an other branch that cannot take the stop, pressing nothing", async () => {
        fake.state.chosen = { ok: true, click: "other" };
        const reports: LoginReport[] = [];
        const h = keyOnList(generation(), withBranch(1, { afterOther: codeBranch() }), {
          totp: "empty",
          report: reports,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
        expect(reports).toContainEqual(
          expect.objectContaining({
            type: "refused",
            reason: "no-route",
            detail: "password-empty:fills-lacking",
          }),
        );
        expect(executed()).toEqual([]);
        expect(status() ?? []).toEqual([]);
        expect(passwordRead(h)).toBe(false);
      });

      it("presses the button beside the account and stops at the branch's password", async () => {
        fake.state.chosen = { ok: true, click: "continue" };
        onListClick();
        const h = keyOnList(
          generation(),
          withContinue(withBranch(1, { afterAccount: passwordBranch() })),
        );
        expect(await h.hello()).toEqual({ ok: true });
        expect(status()![0]).toMatchObject({
          chooser: { click: "continue" },
          stepCount: 3,
          stopAt: 1,
          maxSubmissions: 2,
        });
        await until(settled("watching"));
        expect(status()![0]).toMatchObject({ stepIndex: 1, outcome: "challenge", submissions: 1 });
        expect(executed()).toEqual([`click:${proceed.value}`]);
        expect(passwordRead(h)).toBe(false);
      });

      it("stands at the stop again after a worker restart past the click", async () => {
        onListClick();
        const chooser = withBranch(1, { afterAccount: passwordBranch() });
        const first = keyOnList(generation(), chooser);
        expect(await first.hello()).toEqual({ ok: true });
        await until(settled("watching"));
        const { watch: _watch, outcome: _outcome, ...record } = status()![0]!;
        expect(record).toMatchObject({ stepIndex: 1, stopAt: 1, submissions: 1 });
        // The worker stopped while the login stood at its stop.
        fake.state.storage["pateat.login-attempts.v4"] = [{ ...record, state: "ready" }];
        fake.state.messages = [];
        const url = `${origin}/password`;
        fake.state.tabUrls[1] = url;
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          const h = keyOnList(generation(), chooser);
          fake.state.present = new Set(["password", "login"]);
          // The password page of the restarted worker asks for a passkey by itself.
          const decided = ask(h, "after-restart");
          await vi.advanceTimersByTimeAsync(0);
          void h.hello({ documentId: "after-restart", url }, false);
          await until(() => decided() !== undefined);
          expect(decided()).toMatchObject({ kind: "answer", item: { connectionId, itemId } });
          expect(status()![0]).toMatchObject({
            state: "reconciling",
            stepIndex: 1,
            stopAt: 1,
            submissions: 2,
            chooser: { click: "entry" },
          });
          // Nothing runs again: neither the row's click nor the password.
          expect(executed()).toEqual([]);
          expect(passwordRead(h)).toBe(false);
        } finally {
          fake.browser.tabs.query = query;
        }
      });

      it("ends left-origin without a fill when the row's click leaves the origin", async () => {
        const auth = "https://auth.login.example";
        const service = generation();
        const h = keyOnList(service, listed);
        let clicked = false;
        fake.state.onExecute = async () => {
          clicked = true;
        };
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicked);
        // The row's link loads the site's sign-in page on another origin.
        fake.state.tabUrls[1] = `${auth}/password`;
        fake.state.present = new Set(["password", "login"]);
        await h.hello({ documentId: "auth-document", url: `${auth}/password` }, false);
        await until(() => status()?.find((entry) => entry["state"] === "blocked") !== undefined);
        expect(
          status()!.find((entry) => (entry["account"] as { origin: string }).origin === origin),
        ).toMatchObject({ state: "blocked", outcome: "left-origin", stopAt: 1 });
        expect(executed()).toEqual(["click:[account]"]);
        // Neither the page there nor its steps are asked for: the move is a known limit.
        expect(service.generate).not.toHaveBeenCalled();
        expect(service.judge).not.toHaveBeenCalled();
        expect(passwordRead(h)).toBe(false);
      });

      describe("with a passkey button beside the branch's password field", () => {
        const securityKey = target("use-passkey");
        /** The stored branch, its button learned as a `passkey` handler or not. */
        const branchWithButton = (learned: boolean) =>
          parseLoginRecipe({
            ...passwordBranch(),
            ...(learned
              ? { handlers: [{ kind: "passkey", path: "/password", target: securityKey }] }
              : {}),
          });
        /** The row's click shows the password page with the button beside its field. */
        const buttonShown = (h: () => ReturnType<typeof harness>) =>
          onListClick((value) => {
            if (value === "[account]") {
              fake.state.present = new Set(["password", "login", "use-passkey"]);
              fake.state.extracted = {
                "signed-in": describedPage("/password", [
                  { id: "c1", role: "password", target: target("password"), label: "Password" },
                  { id: "c2", role: "button", target: target("login"), label: "Sign in" },
                  { id: "c3", role: "button", target: securityKey, label: "Use a passkey" },
                ]),
              };
            }
            // The button asks for a passkey, which the bridge answers with the item.
            if (value === "use-passkey") h().login.passkeyAnswered(1, origin, "login.example");
          });

        it("presses a handler the branch holds at the stop, with no judge call", async () => {
          let h!: ReturnType<typeof harness>;
          buttonShown(() => h);
          const service = generation();
          h = keyOnList(service, withBranch(1, { afterAccount: branchWithButton(true) }));
          expect(await h.hello()).toEqual({ ok: true });
          await until(() => executed().length === 2);
          expect(executed()).toEqual(["click:[account]", "click:use-passkey"]);
          // The handler went in before the stop, which moved along with the plan.
          expect(status()![0]).toMatchObject({
            chooser: { click: "entry" },
            stepIndex: 1,
            stepCount: 4,
            stopAt: 2,
            handlers: [{ index: 0, start: 1 }],
          });
          expect(status()![0]).not.toHaveProperty("stopJudged");
          expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
          expect(service.judge).not.toHaveBeenCalled();
          expect(service.generate).not.toHaveBeenCalled();
          expect(passwordRead(h)).toBe(false);
        });

        it("does not send the stop's page to be judged without a learned handler", async () => {
          let h!: ReturnType<typeof harness>;
          buttonShown(() => h);
          const reports: LoginReport[] = [];
          const service = generation();
          h = keyOnList(service, withBranch(1, { afterAccount: branchWithButton(false) }), {
            report: reports,
          });
          expect(await h.hello()).toEqual({ ok: true });
          await until(settled("watching"));
          expect(status()![0]).toMatchObject({ stepIndex: 1, stopAt: 1, outcome: "challenge" });
          expect(status()![0]).not.toHaveProperty("stopJudged");
          expect(service.judge).not.toHaveBeenCalled();
          expect(reports).toContainEqual(
            expect.objectContaining({
              type: "judge",
              verdict: "not-sent",
              reason: "chooser",
              stop: "password",
            }),
          );
          expect(executed()).toEqual(["click:[account]"]);
          expect(passwordRead(h)).toBe(false);
        });
      });

      it("presses nothing on the list for a login that only fills after a logout", async () => {
        // This tab logged out of the site (ADR 0021 D); the item is the site default.
        fake.state.session["pateat.login-logouts.v1"] = [{ tabId: 1, origin }];
        const service = generation();
        const reports: LoginReport[] = [];
        const h = keyOnList(service, withBranch(1, { afterAccount: passwordBranch() }), {
          settings: {
            siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }],
            bindings: [],
          },
          report: reports,
        });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(5_000);
        // It fills nothing there, ends, and the tab asks for an account.
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          fillOnly: true,
        });
        expect(reports.find((entry) => entry.type === "start")).not.toHaveProperty("click");
        expect(attemptReports(reports).at(-1)).toMatchObject({
          state: "blocked",
          reason: "fill-only",
        });
        expect(reports.at(-1)).toMatchObject({ type: "refused", reason: "logged-out" });
        expect(executed()).toEqual([]);
        expect(fake.state.messages.some((entry) => entry.type === "login.choose")).toBe(false);
        expect(service.generate).not.toHaveBeenCalled();
        expect(passwordRead(h)).toBe(false);
      });
    });
  });
});
