import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, startsOf, savedBinding, otherItemId, uriMatch, harness } =
  createRuntimeTestHarness(fake);

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
  describe("probed independently", () => {
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
      // The email field the recipe filled on /signin is known on this path too (#831).
      const extracts = fake.state.messages.filter((entry) => entry.type === "login.extract");
      expect(extracts.length).toBeGreaterThan(0);
      for (const entry of extracts) expect(entry).toMatchObject({ known: [target("email")] });
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
        undefined,
        undefined,
        undefined,
        expect.any(Array),
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
      inPlace(() => fake.state.present?.add("customer"));
      let h!: ReturnType<typeof harness>;
      // The new slot is one no template names, so the saved binding's gap stays.
      const next = continuedWithCustomer;
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "failed", reason: "invalid-output" };
      });
      h = start(service, {
        settings: { bindings: [usernameOnly] },
        custom: [{ name: "Customer", kind: "text" }],
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
    const memberPage = describedPage("/signin", [
      { id: "c1", role: "text", target: target("member"), label: "Member ID" },
      { id: "c2", role: "button", target: target("next-member"), label: "Next" },
    ]);
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
    it("never continues a login that only fills while the tab asks, even once Next is pressed", async () => {
      // The site rejected this tab's last login: the tab asks, and its only match fills the
      // email page without pressing Next (ADR 0021 D).
      fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
      const service = generation();
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(executed()).toEqual(["fill:email"]);
      expect(status()).toEqual([]);
      // The person presses Next: the password form shows in the same document, which
      // announces itself again. Nothing continues the recipe there.
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { login: passwordPage("/signin") };
      expect(await h.hello({}, false)).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email"]);
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
        await h.store.update(undefined, "settings-save", (snapshot) => snapshot);
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
});
