import type { CustomField } from "./harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
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
const { origin, connectionId, itemId, target, startsOf, savedBinding, uriMatch, harness } =
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
  void describedPage("/home", [
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
  describe("for an item without a password, with a passkey (ADR 0036)", () => {
    const passwordRead = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.some(([read]) => read.fieldId === "login.password");

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
      const proceed = { by: "text" as const, value: "Log back in" };
      const listed: LoginChooserRecipe = {
        version: 1,
        id: "gen-synthetic-chooser",
        revision: 1,
        origin,
        layout: "1000",
        chooser: { path: "/signin", other },
      };
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
          layout: "1000",
          pageKind: "sign-in",
          slots,
          steps,
          maxSubmissions,
        });
      const passwordBranch = (revision = 1) =>
        branchOf(revision, ["password"], [fillOn("password", "password"), logIn]);
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
          branch: "1000:account",
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
          branch: "1000:other",
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
        fake.state.storage["pateat.login-attempts.v5"] = [{ ...record, state: "ready" }];
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
        const branchWithButton = (learned: boolean) =>
          parseLoginRecipe({
            ...passwordBranch(),
            ...(learned
              ? { handlers: [{ kind: "passkey", path: "/password", target: securityKey }] }
              : {}),
          });
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
    });
  });
});
