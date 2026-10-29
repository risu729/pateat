import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginChooserRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import { createRecipeRepairs } from "../repair";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, otherItemId, uriMatch, liveDefault, harness } =
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
  describe("a login on a chooser's list (ADR 0028)", () => {
    const other = { by: "text" as const, value: "Sign in with another profile" };
    const listed: LoginChooserRecipe = {
      version: 1,
      id: "gen-synthetic-chooser",
      revision: 1,
      origin,
      layout: "1000",
      chooser: { path: "/signin", other },
    };
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
          layout: "1000",
          pageKind: "sign-in",
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
      overrides: Partial<LocalSettings> = {},
    ) => {
      const h = harness(
        { siteDefaults: [], bindings: [], ...overrides },
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
        branch: "1000:account",
      });
      // The page after the sign-in is judged on that branch.
      expect(service.judge.mock.calls[0]!.slice(0, 3)).toEqual([listed.id, 2, "password"]);
      expect(service.judge.mock.calls[0]![5]).toBe("1000:account");
      expect(status()![0]).toMatchObject({
        recipeId: listed.id,
        recipeRevision: 2,
        chooser: { click: "entry" },
        submissions: 2,
      });
      expect(reports.find((entry) => entry.type === "start")).toMatchObject({ click: "entry" });
      // Its attempt reports name the branch, which its first result's code carries
      // (ADR 0019, amended 2026-10-18).
      expect(reports.filter((entry) => entry.type === "attempt").at(-1)).toMatchObject({
        state: "authenticated",
        recipeRevision: 2,
        branch: "1000:account",
      });
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
    it("runs the chooser layout whose list buttons show, records it and keeps it on resume (ADR 0060)", async () => {
      fake.state.chosen = { ok: true, click: "other" };
      // The newer layout names its button in another language, which the page does not show.
      const japanese = { by: "text" as const, value: "別のプロフィールでサインイン" };
      const newer: LoginChooserRecipe = {
        ...listed,
        layout: "2000",
        chooser: { path: "/signin", other: japanese },
      };
      const reports: LoginReport[] = [];
      const h = onList(generation(), reports);
      h.recipes.chooser.mockImplementation(async (...args: unknown[]) =>
        args[3] === "1000" ? listed : newer,
      );
      const choosers = vi.fn(async () => [
        { recipe: listed, language: "en" as const, createdAt: 1000 },
        { recipe: newer, language: "ja" as const, createdAt: 2000 },
      ]);
      Object.assign(h.recipes, { choosers });
      fake.state.present = new Set([other.value]);
      // The page holds a click forever, so the login is still running when it resumes.
      fake.state.onExecute = () => new Promise(() => undefined);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks().length > 0);
      // The older layout's button shows, so it runs: its button is clicked and recorded.
      expect(clicks()[0]!.operation.step.target).toEqual(other);
      expect(clicks()[0]!.list).toMatchObject({ click: "other", other });
      expect(status()![0]).toMatchObject({ layout: "1000", chooser: { click: "other" } });
      expect(reports.find((entry) => entry.type === "start")).toMatchObject({
        layout: "1000",
        layouts: 2,
        click: "other",
      });
      // Only one layout fits, so the page's language is not read.
      expect(fake.state.messages.some((entry) => entry.type === "login.extract")).toBe(false);
      // The login's next document loads the same layout, which is not chosen again.
      await h.hello({ documentId: "synthetic-document-2" });
      expect(h.recipes.chooser).toHaveBeenLastCalledWith(origin, "/signin", listed.id, "1000");
      expect(choosers).toHaveBeenCalledTimes(1);
    });
    it("ends a resumed login whose chooser revision dropped the route of its click", async () => {
      fake.state.chosen = { ok: true, click: "other" };
      const reports: LoginReport[] = [];
      const h = onList(generation(), reports);
      // The page holds the click forever, so the login is still running when it resumes.
      fake.state.onExecute = () => new Promise(() => undefined);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks().length > 0);
      h.recipes.chooser.mockResolvedValue({ ...listed, revision: 2, chooser: { path: "/signin" } });
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(status()![0]).toMatchObject({ state: "blocked", outcome: "policy-changed" });
      expect(reports.filter((entry) => entry.type === "attempt").at(-1)).toMatchObject({
        outcome: "policy-changed",
        cause: "recipe-changed",
      });
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
    it("sends the list for repair when the chooser's button no longer shows (ADR 0041 section 6)", async () => {
      fake.state.chosen = {
        ok: true,
        click: "none",
        miss: {
          username: "email",
          entries: 1,
          fits: 0,
          beside: 0,
          other: "missing",
          continue: "none",
        },
      };
      const listPage = {
        ok: true,
        observation: {
          version: 1,
          origin,
          path: "/signin",
          language: "ja",
          complete: true,
          candidates: [
            {
              id: "c1",
              role: "button",
              target: { by: "text", value: "別のプロフィールでログイン" },
              label: "別のプロフィールでログイン",
            },
          ],
          accounts: ["[email]"],
        },
      };
      fake.state.extracted = { accounts: listPage };
      const service = generation();
      const reports: LoginReport[] = [];
      const h = onList(service, reports, {
        repairs: createRecipeRepairs({
          read: async () => fake.state.storage["repairs"],
          write: async (value) => {
            fake.state.storage["repairs"] = value;
          },
        }),
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      expect(service.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          observation: listPage.observation,
          repair: { recipeId: listed.id, revision: 1 },
        }),
        expect.any(Function),
      );
      // A list carries no signed-in hint (ADR 0035), and the login ends as before.
      expect(service.generate.mock.calls[0]![0]).not.toHaveProperty("signedIn");
      expect(status()![0]).toMatchObject({ outcome: "account-not-listed" });
      expect(reports.filter((entry) => entry.type === "repair")).toEqual([
        expect.objectContaining({ recipeId: listed.id, outcome: "due" }),
      ]);
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
    describe("on the other branch's form shown on the list's path", () => {
      afterEach(() => {
        fake.state.awaitReply = undefined;
      });
      const afterOther = parseLoginRecipe({
        version: 1,
        id: listed.id,
        revision: 2,
        origin,
        layout: "1000",
        pageKind: "sign-in",
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
        maxSubmissions: 1,
      });
      const withOther: LoginChooserRecipe = {
        ...listed,
        revision: 2,
        chooser: { ...listed.chooser, afterOther },
      };
      const shows = (h: ReturnType<typeof onList>, list: boolean | "both" = false) => {
        h.recipes.chooser.mockResolvedValue(withOther);
        h.recipes.starts.mockResolvedValue([
          { path: "/signin", steps: [afterOther.steps[0]!], list: [other] },
        ]);
        fake.state.present = list === true ? new Set() : new Set(["email", "password", "login"]);
        fake.state.awaitReply = (readiness) =>
          list === "both" || (readiness.accounts === true) === list
            ? { ok: true }
            : { ok: false, reason: "timeout" };
      };
      it("logs in on that branch without a click on the list", async () => {
        const reports: LoginReport[] = [];
        const service = generation();
        const h = onList(service, reports);
        shows(h);
        fake.state.signIn = true;
        // The signed-in page replaces the form once it is submitted.
        fake.state.onExecute = async (message) => {
          const step = (message["operation"] as { step: LoginStep }).step;
          if (step.kind !== "click") return;
          fake.state.observedPath = "/home";
          fake.state.present = new Set();
          fake.state.extracted = { "signed-in": homePage };
        };
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(executed()).toEqual(["fill:email,password", "click:login"]);
        expect(fake.state.messages.some((entry) => entry.type === "login.choose")).toBe(false);
        expect(clicks().every((entry) => entry.list === undefined)).toBe(true);
        expect(status()![0]).toMatchObject({
          recipeRevision: 2,
          chooser: { click: "other-shown" },
          stepCount: 2,
          maxSubmissions: 1,
        });
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          click: "other-shown",
        });
        // The page after the sign-in is judged on the other branch.
        expect(service.judge.mock.calls[0]![5]).toBe("1000:other");
      });
      it("starts the other branch of the chooser layout ranked first (ADR 0060)", async () => {
        // Two layouts, each with its own form after "another profile"; no list button shows,
        // so the page's language decides, and the older layout is in it.
        const newerOther = parseLoginRecipe({
          ...afterOther,
          layout: "2000",
          steps: [
            {
              kind: "fill",
              path: "/signin",
              fields: [
                { slot: "username", target: target("mail") },
                { slot: "password", target: target("password") },
              ],
            },
            { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
          ],
        });
        const newer: LoginChooserRecipe = {
          ...withOther,
          layout: "2000",
          chooser: {
            path: "/signin",
            other: { by: "text", value: "別のプロフィールでサインイン" },
            afterOther: newerOther,
          },
        };
        const reports: LoginReport[] = [];
        const h = onList(generation(), reports);
        shows(h);
        h.recipes.chooser.mockImplementation(async (...args: unknown[]) =>
          args[3] === "1000" ? withOther : newer,
        );
        Object.assign(h.recipes, {
          choosers: vi.fn(async () => [
            { recipe: withOther, language: "ja" as const, createdAt: 1000 },
            { recipe: newer, language: "en" as const, createdAt: 2000 },
          ]),
        });
        fake.state.extracted = {
          accounts: {
            ok: true,
            observation: { version: 1, origin, path: "/signin", language: "ja", complete: true },
          },
        };
        fake.state.onExecute = () => new Promise(() => undefined);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => executed().length > 0);
        expect(executed()).toEqual(["fill:email,password"]);
        expect(status()![0]).toMatchObject({ layout: "1000", chooser: { click: "other-shown" } });
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          layout: "1000",
          layouts: 2,
        });
        expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toEqual([
          expect.objectContaining({ page: "accounts" }),
        ]);
      });
      it.each([
        ["the list shows", true],
        ["the list shows beside the form", "both"],
      ] as const)("still clicks on the list while %s", async (_name, list) => {
        fake.state.chosen = { ok: true, click: "other" };
        const h = onList(generation());
        shows(h, list);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks().length > 0);
        expect(clicks()[0]!.operation.step.target).toEqual(other);
        expect(status()![0]).toMatchObject({ chooser: { click: "other" } });
      });
      it("only fills the form for the default after a rejected login", async () => {
        // The site rejected this tab's login (ADR 0021 D); the item is the site default.
        fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
        const reports: LoginReport[] = [];
        const h = onList(generation(), reports, {}, { siteDefaults: [liveDefault()] });
        shows(h);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(executed()).toEqual(["fill:email,password"]);
        expect(reports.find((entry) => entry.type === "start")).toMatchObject({
          fillOnly: true,
          click: "other-shown",
        });
        expect(reports.at(-1)).toMatchObject({
          type: "refused",
          reason: "account-asked",
          detail: "rejected",
        });
      });
      it("logs in with the account picked after a rejected login", async () => {
        // The site rejected this tab's login (ADR 0062), and two items match without a
        // default; the person then pressed the button for another account on the list.
        fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
        const both = uriMatch({
          candidates: [
            { itemId, matches: [{ uriIndex: 0, match: 0 }] },
            { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
          ],
        });
        const h = onList(generation(), undefined, {
          uris: async () => ({ ok: true, data: both }),
          otherUsername: true,
        });
        shows(h);
        expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
        expect(executed()).toEqual([]);
        fake.state.onReconnect = () => h.hello();
        expect(
          await h.login.handle(
            {
              version: 1,
              type: "login.choice.pick",
              tabId: 1,
              documentId: "synthetic-document",
              connectionId,
              itemId: otherItemId,
              makeDefault: false,
            },
            {
              id: "synthetic-extension",
              url: "chrome-extension://synthetic-extension/popup.html",
            } as never,
          ),
        ).toEqual({ ok: true });
        await until(() => executed().length >= 2);
        expect(executed()).toEqual(["fill:email,password", "click:login"]);
        expect(status()![0]).toMatchObject({
          account: { itemId: otherItemId },
          chooser: { click: "other-shown" },
        });
      });
      describe("before the chooser has that branch (owner 2026-10-17)", () => {
        const otherForm = describedPage("/signin", [
          { id: "c1", role: "email", target: target("email"), label: "Email" },
          { id: "c2", role: "password", target: target("password"), label: "Password" },
          { id: "c3", role: "button", target: target("login"), label: "Log in" },
        ]);
        const formOnly = (service: ReturnType<typeof generation>, reports?: LoginReport[]) => {
          service.available.mockResolvedValue(true);
          const h = onList(service, reports);
          fake.state.present = new Set(["email", "password", "login"]);
          fake.state.extracted = { login: otherForm };
          fake.state.awaitReply = (readiness) =>
            readiness.accounts === true ? { ok: false, reason: "timeout" } : { ok: true };
          return h;
        };
        it("sends the form as the other branch's first page and logs in on it", async () => {
          const reports: LoginReport[] = [];
          let h!: ReturnType<typeof onList>;
          const service = generation(async () => {
            h.recipes.chooser.mockResolvedValue(withOther);
            h.recipes.starts.mockResolvedValue([
              { path: "/signin", steps: [afterOther.steps[0]!], list: [other] },
            ]);
            return { outcome: "recipe", recipe: withOther };
          });
          h = formOnly(service, reports);
          // The first announcement offers the page; nothing is sent before its form shows.
          expect(await h.hello({}, false)).toMatchObject({
            ok: false,
            reason: "form-not-ready",
            generate: true,
          });
          expect(service.available).toHaveBeenCalledWith(
            origin,
            "/signin",
            { recipeId: listed.id, revision: 1 },
            "1000:other",
          );
          expect(service.generate).not.toHaveBeenCalled();
          expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() =>
            expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
          );
          expect(service.generate).toHaveBeenCalledTimes(1);
          expect(service.generate.mock.calls[0]![0]).toMatchObject({
            observation: otherForm.observation,
            base: { recipeId: listed.id, revision: 1 },
            branch: "1000:other",
          });
          expect(reports.filter((entry) => entry.type === "generation")).toEqual([
            expect.objectContaining({
              outcome: "recipe",
              page: "other",
              recipeId: listed.id,
              baseRevision: 1,
            }),
          ]);
          // The page announces again and starts on the stored branch, clicking nothing.
          fake.state.signIn = true;
          fake.state.onExecute = async (message) => {
            const step = (message["operation"] as { step: LoginStep }).step;
            if (step.kind !== "click") return;
            fake.state.observedPath = "/home";
            fake.state.present = new Set();
            fake.state.extracted = { "signed-in": homePage };
          };
          expect(await h.hello()).toEqual({ ok: true });
          await until(settled("authenticated"));
          expect(executed()).toEqual(["fill:email,password", "click:login"]);
          expect(status()![0]).toMatchObject({ chooser: { click: "other-shown" } });
        });
        it("never sends a form without a field for the account", async () => {
          // The password form after the person's own click on a listed profile.
          const reports: LoginReport[] = [];
          const service = generation();
          const h = formOnly(service, reports);
          fake.state.extracted = { login: passwordPage("/signin") };
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() =>
            expect(reports.find((entry) => entry.type === "generation")).toMatchObject({
              outcome: "skipped",
              reason: "no-account-field",
              page: "other",
            }),
          );
          expect(service.generate).not.toHaveBeenCalled();
        });
        it("sends a form that asks for a phone number beside the password", async () => {
          const service = generation();
          const h = formOnly(service);
          fake.state.extracted = {
            login: describedPage("/signin", [
              { id: "c1", role: "tel", target: target("phone"), autocomplete: "tel", group: "g1" },
              { id: "c2", role: "password", target: target("password"), group: "g1" },
              { id: "c3", role: "button", target: target("login"), group: "g1" },
            ]),
          };
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        });
        it("never counts a field of another form beside a password-only form", async () => {
          // A search box in the page header, with no `type=search`, beside the password form.
          const reports: LoginReport[] = [];
          const service = generation();
          const h = formOnly(service, reports);
          fake.state.extracted = {
            login: describedPage("/signin", [
              { id: "c1", role: "text", target: target("search"), label: "Search", group: "g1" },
              { id: "c2", role: "password", target: target("password"), group: "g2" },
              { id: "c3", role: "button", target: target("login"), group: "g2" },
            ]),
          };
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() =>
            expect(reports.find((entry) => entry.type === "generation")).toMatchObject({
              reason: "no-account-field",
            }),
          );
          expect(service.generate).not.toHaveBeenCalled();
        });
        it("sends nothing once the list shows", async () => {
          const reports: LoginReport[] = [];
          const service = generation();
          const h = formOnly(service, reports);
          expect(await h.hello({}, false)).toMatchObject({ generate: true });
          // The list renders after the form announced itself.
          fake.state.awaitReply = () => ({ ok: true });
          expect(await h.signIn()).not.toEqual({ ok: false, reason: "generating" });
          expect(reports.find((entry) => entry.type === "generation")).toMatchObject({
            outcome: "skipped",
            reason: "list-shown",
            page: "other",
          });
          expect(service.generate).not.toHaveBeenCalled();
        });
        it.each([
          ["the page was sent already", "sent" as const, true],
          ["the chooser has no button for another account", true as const, false],
        ])("offers nothing when %s", async (_name, available, button) => {
          const service = generation();
          const h = formOnly(service);
          service.available.mockResolvedValue(available);
          if (!button)
            h.recipes.chooser.mockResolvedValue({ ...listed, chooser: { path: "/signin" } });
          const first = await h.hello({}, false);
          expect(first).not.toHaveProperty("generate");
          expect(await h.signIn()).not.toEqual({ ok: false, reason: "generating" });
          expect(service.generate).not.toHaveBeenCalled();
        });
      });
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
  });
});
