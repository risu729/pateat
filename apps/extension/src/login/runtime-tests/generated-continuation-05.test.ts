import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginChooserRecipe,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration, LoginReport } from "../runtime";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, startsOf, uriMatch, harness } =
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

    describe("when the page asks for a passkey by itself (ADR 0034)", () => {
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
      const signedIn = () => {
        list.shows = false;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.extracted = { "signed-in": homePage };
      };
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
    const toPage = (path: string, present: string[]) =>
      onClick(() => {
        fake.state.observedPath = path;
        fake.state.present = new Set(present);
        fake.state.signIn = true;
        fake.state.extracted = { login: passwordPage(path) };
      });
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
  });
});
