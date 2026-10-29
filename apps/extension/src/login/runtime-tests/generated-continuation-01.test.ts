import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, itemId, target, startsOf, uriMatch, harness } = createRuntimeTestHarness(fake);

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
        pageKind: "sign-in",
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
        pageKind: "sign-in",
        recipeId: emailFirst.id,
        baseRevision: 1,
        takenOver: true,
      },
    ]);
  });
  it("after a logout, logs in again with the continued recipe without generating it again", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    const service = generation(answering(() => h, next));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // The site signs out and shows the email page again in the tab (ADR 0062).
    h.recipes.starts.mockResolvedValue(startsOf([next.steps[0]!]));
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.signIn = false;
    fake.state.extracted = {};
    onClick(() => undefined);
    expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
    await until(() => executed().length >= allSteps.length + 1);
    await vi.advanceTimersByTimeAsync(20_000);
    // It logs in again with the continued revision and asks the service for nothing more.
    expect(executed()).toEqual([...allSteps, "fill:email", "click:next"]);
    expect(status()).toMatchObject([{ recipeRevision: 2, document: { documentId: "signed-out" } }]);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(fake.state.badges[1]?.text).toBe("");
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
      const records = values["pateat.login-attempts.v5"] as { recipeRevision?: number }[];
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
    // The email field the recipe filled on `/signin` may show again there, read-only (#831).
    expect(
      fake.state.messages.find((entry) => entry.type === "login.extract") as unknown,
    ).toMatchObject({ page: "login", known: [target("email")] });
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
          login: { ...passwordPage("/signin", false), gap: "unsupported-control" },
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
        detail: "unsupported-control",
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

  void parseLoginRecipe({
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
});
