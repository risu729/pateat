import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import { vaultFailure } from "../../vault/record";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  target,
  startsOf,
  recipe,
  userId,
  savedBinding,
  otherItemId,
  uriMatch,
  harness,
} = createRuntimeTestHarness(fake);

describe("production login document admission", () => {
  afterEach(() => {
    // Close every test's tabs, so no attempt left reconciling answers a later test.
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2, 3, 4]) listener(tabId);
    fake.state.replaced.length = 0;
  });
  beforeEach(() => {
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
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.siteAccount = { ok: false };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.incognito = new Set();
    fake.state.openTabs = undefined;
  });

  describe("a tab that moves to another origin", () => {
    const second = "https://second.example";
    const secondUrl = `${second}/signin`;
    const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    type Stored = {
      id: string;
      state: string;
      outcome?: string;
      submissions: number;
      mutationIntent?: true;
      changedAt?: number;
    } & {
      account: { origin: string };
      document: { tabId: number; documentId: string };
    };
    const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Stored[];
    const at = (from: string) => stored().find((entry) => entry.account.origin === from);
    const twoSites = (live: Parameters<typeof harness>[1] = {}) => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", server: "cloud-us", userId, itemId },
            { origin: second, provider: "bitwarden", server: "cloud-us", userId, itemId },
          ],
          bindings: [savedBinding, { ...savedBinding, recipeId: secondRecipe.id, origin: second }],
        },
        { allowedOrigins: [origin, second], ...live },
      );
      h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
        path !== "/signin"
          ? undefined
          : from === origin
            ? recipe
            : from === second
              ? secondRecipe
              : undefined,
      );
      h.recipes.starts.mockImplementation(async (from: string) =>
        startsOf(
          from === origin ? [recipe.steps[0]!] : from === second ? [secondRecipe.steps[0]!] : [],
        ),
      );
      return h;
    };
    const navigate = (
      h: ReturnType<typeof harness>,
      url: string,
      documentId: string,
      start = true,
    ) => {
      fake.state.tabUrls[1] = url;
      return h.hello({ documentId, url }, start);
    };
    const holdClicks = (...from: string[]) => {
      fake.state.onExecute = (message) => {
        const operation = message["operation"] as {
          step: { kind: string };
          document: { origin: string };
        };
        return operation.step.kind === "click" && from.includes(operation.document.origin)
          ? new Promise(() => undefined)
          : Promise.resolve();
      };
    };

    it("keeps another tab off an origin whose login was stopped while the page had its click", async () => {
      // The click may have submitted the password, so its result may still arrive.
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
      h.login.settingsChanged("synced");
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "policy-changed",
          submissions: 1,
          mutationIntent: true,
        }),
      );
      fake.state.onExecute = undefined;
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
    });
    const idle = { operationId: undefined, operationKind: undefined, operationEffect: undefined };
    it.each([
      // A submitted step was observed, then Pateat stopped the login.
      ["blocked policy-changed after an observed step", "blocked", "policy-changed", idle, true],
      [
        "blocked cancelled before any submission",
        "blocked",
        "cancelled",
        { ...idle, submissions: 0 },
        true,
      ],
      ["blocked cancelled after a submission", "blocked", "cancelled", idle, false],
      [
        "blocked policy-changed with a click the page may have received",
        "blocked",
        "policy-changed",
        {},
        false,
      ],
      [
        "blocked policy-changed with a fill in flight",
        "blocked",
        "policy-changed",
        { operationKind: "fill", operationEffect: "submit", mutationIntent: true },
        false,
      ],
      [
        "blocked policy-changed settled as unknown",
        "blocked",
        "policy-changed",
        { ...idle, settled: true },
        false,
      ],
      ["blocked credential-rejected", "blocked", "credential-rejected", idle, false],
      ["blocked challenge", "blocked", "challenge", idle, false],
      // A login that has not succeeded holds the origin only for a while after it changed.
      [
        "blocked challenge unchanged for 5 minutes",
        "blocked",
        "challenge",
        { ...idle, age: 5 * 60_000 + 1000 },
        true,
      ],
      [
        "reconciling unknown-submit unchanged for 5 minutes",
        "reconciling",
        "unknown-submit",
        { ...idle, settled: true, age: 5 * 60_000 + 1000 },
        true,
      ],
      [
        "reconciling unknown-submit changed 4 minutes ago",
        "reconciling",
        "unknown-submit",
        { ...idle, settled: true, age: 4 * 60_000 },
        false,
      ],
      ["blocked submission-limit", "blocked", "submission-limit", idle, false],
      // Retries spent on failures that changed nothing on the page (owner, 2026-10-12).
      ["blocked retry-limit", "blocked", "retry-limit", idle, true],
    ] as const)(
      "decides whether another tab's %s record holds the origin",
      async (_name, state, outcome, extra, released) => {
        const { age, ...rest } = extra as typeof extra & { age?: number };
        // A password the site refused, or one whose submission may still arrive, is not
        // submitted again from another tab (ADR 0022).
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
        const [record] = stored();
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        try {
          fake.state.storage["pateat.login-attempts.v5"] = [
            {
              ...record!,
              state,
              outcome,
              mutationIntent: undefined,
              ...rest,
              // A record's age is taken when the case runs, not when the table was built.
              ...(age === undefined ? {} : { changedAt: Date.now() - age }),
              // A result settled as unknown is watched (ADR 0027). Here the watch is over,
              // since another tab's first step releases a login still watched.
              ...(state === "reconciling" && "settled" in rest
                ? {
                    watch: {
                      since: Date.now() - 10 * 60_000 - 1000,
                      documentId: record!.document.documentId,
                      pages: 0,
                    },
                  }
                : {}),
            },
          ];
          fake.state.onExecute = undefined;
          const restarted = twoSites();
          expect(await restarted.login.active()).toBe(false);
          const sent = executes().length;
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual(
            released ? { ok: true } : { ok: false, reason: "origin-busy" },
          );
          if (released) await vi.waitFor(() => expect(executes().length).toBeGreaterThan(sent));
          else expect(executes()).toHaveLength(sent);
        } finally {
          fake.browser.tabs.query = query;
        }
      },
    );
    it.each([
      [
        "blocked policy-changed before any submission",
        "policy-changed",
        { ...idle, submissions: 0 },
        true,
      ],
      [
        "blocked value-mismatch before any submission",
        "value-mismatch",
        { ...idle, submissions: 0 },
        true,
      ],
      ["blocked cancelled before any submission", "cancelled", { ...idle, submissions: 0 }, true],
      // A stop after a submission resumes: the site may send the tab back to its first step.
      ["blocked policy-changed after an observed step", "policy-changed", idle, false],
      ["blocked value-mismatch after a submission", "value-mismatch", idle, false],
      ["blocked cancelled after a submission", "cancelled", idle, false],
      [
        "blocked policy-changed with a click the page may have received",
        "policy-changed",
        {},
        false,
      ],
      [
        "blocked policy-changed with a fill in flight",
        "policy-changed",
        { operationKind: "fill", operationEffect: "submit", mutationIntent: true },
        false,
      ],
      [
        "blocked policy-changed settled as unknown",
        "policy-changed",
        { ...idle, settled: true },
        false,
      ],
      ["blocked challenge", "challenge", idle, false],
    ] as const)(
      "decides whether the tab's own %s record lets a new page of it log in",
      async (_name, outcome, extra, released) => {
        // A login Pateat itself stopped before any submission holds no tab, its own
        // included; any other ended record is resumed and never submits again (ADR 0022).
        const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
        const [record] = stored();
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          fake.state.storage["pateat.login-attempts.v5"] = [
            {
              ...record!,
              state: "blocked",
              outcome,
              mutationIntent: undefined,
              ...extra,
              // Past ADR 0022's hold on other tabs, which a release would otherwise end early.
              changedAt: Date.now() - 6 * 60_000,
            },
          ];
          fake.state.onExecute = undefined;
          const restarted = twoSites();
          expect(await restarted.login.active()).toBe(false);
          const sent = executes().length;
          // The same document announcing again, as after a restarted worker, resumes it.
          expect(await restarted.hello()).toEqual({ ok: true });
          await flush();
          expect(executes()).toHaveLength(sent);
          expect(at(origin)).toMatchObject({ id: record!.id, state: "blocked", outcome });
          if (!released) {
            // A later page watches for the login form; the record is still resumed.
            expect(await restarted.hello({ documentId: "next-page" }, false)).toMatchObject({
              ok: false,
              reason: "login-stopped",
            });
            expect(at(origin)).toMatchObject({ id: record!.id, state: "blocked", outcome });
          }
          expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes().length).toBeGreaterThan(sent));
          if (released) expect(at(origin)?.id).not.toBe(record!.id);
          else {
            // Once the form shows again, the tab asks for an account and only fills, so it
            // never submits again (ADR 0021 D).
            await vi.waitFor(async () => expect(await restarted.login.active()).toBe(false));
            expect(
              executes()
                .slice(sent)
                .map(
                  (entry) =>
                    (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
                ),
            ).toEqual(["fill"]);
            expect(at(origin)).toBeUndefined();
            expect(fake.state.badges[1]?.title).toContain("the last login on this site stopped");
          }
        } finally {
          fake.browser.tabs.query = query;
        }
      },
    );
    it("asks in this tab only once its stopped login's form shows again, and logs why", async () => {
      // APA Hotel: the login stopped after its click; the tab must not stay stuck, and must
      // not submit again either (ADR 0021 D, owner's choice 2026-10-12).
      const report = vi.fn<(report: LoginReport) => void>();
      holdClicks(origin);
      const h = twoSites({ report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v5"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "policy-changed",
            mutationIntent: undefined,
            ...idle,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites({ report });
        const asked = executes().length;
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(async () => expect(await restarted.login.active()).toBe(false));
        // It fills the form once, pressing nothing.
        expect(executes()).toHaveLength(asked + 1);
        expect(
          report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "refused")
            .at(-1),
        ).toMatchObject({
          reason: "account-asked",
          detail: "stopped-login",
        });
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.session["pateat.login-rejected-asks.v1"] ?? []).toEqual([]);
        // The page is filled once on its path.
        expect(fake.state.session["pateat.login-ask-fills.v1"]).toEqual(["1 next-page /signin"]);
        // Another tab of the site is not asked: it logs in, with its click.
        const sent = executes().length;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(
            executes()
              .slice(sent)
              .map(
                (entry) =>
                  (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
              ),
          ).toContain("click"),
        );
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("keeps resuming a stopped login while it still holds the site, so other tabs wait", async () => {
      // A challenge just after the click holds the site for 5 minutes (ADR 0022); its tab's
      // later login page does not end that early, and does not ask yet.
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v5"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "challenge",
            mutationIntent: undefined,
            ...idle,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        const sent = executes().length;
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(executes()).toHaveLength(sent);
        expect(at(origin)).toMatchObject({
          id: record!.id,
          state: "blocked",
          outcome: "challenge",
        });
        expect(fake.state.session["pateat.login-stopped-asks.v1"] ?? []).toEqual([]);
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "origin-busy",
        });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("logs once per page why a page that resumes a login held after a submission does nothing", async () => {
      // The resumed attempt is unchanged, so its own line is debug (ADR 0019).
      const report = vi.fn<(report: LoginReport) => void>();
      holdClicks(origin);
      const h = twoSites({ report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v5"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "challenge",
            mutationIntent: undefined,
            ...idle,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites({ report });
        report.mockClear();
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
        // The same page announcing again carries the login: a repeat, logged at debug only.
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({
          ok: false,
          reason: "duplicate-document",
        });
        expect(await restarted.hello({ documentId: "third-page" })).toEqual({ ok: true });
        const entries = report.mock.calls.map(([entry]) => entry);
        const page = {
          type: "refused",
          tabId: 1,
          origin,
          reason: "not-started",
          detail: "stopped-login",
        };
        expect(entries.filter((entry) => entry.type === "refused")).toEqual([
          page,
          { type: "refused", tabId: 1, origin, reason: "duplicate-document" },
          page,
        ]);
        expect(entries.filter((entry) => entry.type === "attempt")).toEqual([
          expect.objectContaining({ state: "blocked", outcome: "challenge", repeat: true }),
          expect.objectContaining({ state: "blocked", outcome: "challenge", repeat: true }),
        ]);
        expect(at(origin)).toMatchObject({ id: record!.id, outcome: "challenge" });
        // A login that stopped before any submission is not the hold's case: a restarted
        // worker resumes it in its own page without this line.
        fake.state.storage["pateat.login-attempts.v5"] = [
          { ...stored()[0]!, submissions: 0, document: { ...record!.document } },
        ];
        const again = twoSites({ report });
        report.mockClear();
        expect(await again.hello()).toEqual({ ok: true });
        expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "not-started" }));
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends another tab's hold 5 minutes after its record last changed, not after a resume", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        // The login was stopped by a challenge 6 minutes ago and its tab was left open.
        const changedAt = Date.now() - 6 * 60_000;
        fake.state.storage["pateat.login-attempts.v5"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "challenge",
            mutationIntent: undefined,
            ...idle,
            changedAt,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        // Its tab's page announces again after the restart; the unchanged record keeps its time.
        await restarted.hello({ documentId: "challenge-page" }, false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "challenge", changedAt });
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: true,
        });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it(
      "keeps the time a held login last progressed when its tab shows another page",
      { timeout: 10_000 },
      async () => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
        const [record] = stored();
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        try {
          // The result stayed unknown 6 minutes ago and its tab was left open.
          const changedAt = Date.now() - 6 * 60_000;
          fake.state.storage["pateat.login-attempts.v5"] = [
            {
              ...record!,
              state: "reconciling",
              outcome: "unknown-submit",
              settled: true,
              changedAt,
              // Watched since then (ADR 0027).
              watch: { since: changedAt, documentId: record!.document.documentId, pages: 0 },
            },
          ];
          fake.state.onExecute = undefined;
          // The user browses on to a page that is neither the completion nor the next step.
          fake.state.observedPath = "/elsewhere";
          const restarted = twoSites();
          // The page's first announcement: it shows no sign-in form.
          expect(await restarted.hello({ documentId: "after-login" }, false)).toMatchObject({
            ok: true,
          });
          await vi.waitFor(
            () =>
              expect(at(origin)).toMatchObject({
                state: "reconciling",
                outcome: "unknown-submit",
                settled: true,
                document: { documentId: "after-login" },
              }),
            { timeout: 6000 },
          );
          // A new page is not the login's progress, so the hold has ended.
          expect(at(origin)?.changedAt).toBe(changedAt);
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
            ok: true,
          });
        } finally {
          fake.browser.tabs.query = query;
        }
      },
    );
    it("keeps another tab off an origin whose login still runs, and says why", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      expect(fake.state.badges[2]?.title).toBe(
        "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.",
      );
      expect(executes()).toHaveLength(2);
      // Once that tab closes, this tab logs in and its tooltip is reset.
      fake.state.onExecute = undefined;
      for (const listener of fake.state.removed) listener(1);
      await vi.waitFor(() => expect(stored()).toEqual([]));
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab-again" })).toEqual({
        ok: true,
      });
      expect(fake.state.badges[2]?.title).toBe("Pateat");
    });
    it("keeps each origin's record of a tab across a restart", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      const before = stored();
      expect(before.map((entry) => [entry.document.tabId, entry.account.origin])).toEqual([
        [1, origin],
        [1, second],
      ]);
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        expect(await restarted.login.active()).toBe(false);
        expect(stored()).toEqual(before);
        // Each origin's document resumes its own ended record; nothing runs again.
        const sent = executes().length;
        expect(await navigate(restarted, fake.state.pageUrl, "after-restart", false)).toMatchObject(
          { reason: "logged-in" },
        );
        expect(at(origin)).toMatchObject({ id: before[0]!.id, outcome: "left-origin" });
        expect(await navigate(restarted, secondUrl, "second-after-restart", false)).toMatchObject({
          reason: "logged-in",
        });
        expect(at(second)).toMatchObject({ id: before[1]!.id, state: "authenticated" });
        expect(executes()).toHaveLength(sent);
        // The origin the tab left still holds against another tab.
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "origin-busy",
        });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends a running attempt left behind by a restart when the tab moves to another origin", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent", submissions: 1 });
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        // The restart only observes the attempt it found; it is still running.
        expect(await restarted.login.active()).toBe(true);
        expect(at(origin)).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
        expect(await navigate(restarted, secondUrl, "second-document")).toEqual({ ok: true });
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "left-origin",
          submissions: 1,
        });
        await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
        expect(stored()).toHaveLength(2);
        expect(await restarted.login.active()).toBe(false);
        expect(executes()).toHaveLength(4);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("treats two stored records of one tab and origin as unavailable storage", async () => {
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      const [record] = stored();
      fake.state.storage["pateat.login-attempts.v5"] = [
        record,
        { ...record, id: crypto.randomUUID(), document: { ...record!.document, documentId: "x" } },
      ];
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = twoSites();
        fake.state.tabUrls[1] = secondUrl;
        expect(await restarted.hello({ documentId: "after-restart", url: secondUrl })).toEqual({
          ok: false,
          reason: "storage-unavailable",
        });
        expect(executes()).toHaveLength(2);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
  });
  describe("live provider URI matches", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    it("let the saved default fill when its URI matches this page", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields).toHaveBeenCalledTimes(1);
      // One query per document and snapshot, for the default's connection and the full URL.
      expect(uris).toHaveBeenCalledTimes(1);
      expect(uris.mock.calls[0]?.slice(0, 2)).toEqual([
        connectionId,
        "https://login.example/signin",
      ]);
    });
    it.each<[string, Awaited<ReturnType<LiveUriMatcher>>, string]>([
      [
        "no rule of the item matches",
        { ok: true, data: uriMatch({ candidates: [] }) },
        "item-origin-mismatch",
      ],
      [
        "only another item matches",
        {
          ok: true,
          data: uriMatch({
            candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
          }),
        },
        "item-origin-mismatch",
      ],
      [
        "the item's rules could not be evaluated",
        { ok: true, data: uriMatch({ candidates: [], unavailableItemIds: [itemId] }) },
        "item-uri-unevaluated",
      ],
      [
        "only another item's rules could not be evaluated",
        { ok: true, data: uriMatch({ candidates: [], unavailableItemIds: [otherItemId] }) },
        "item-origin-mismatch",
      ],
      [
        "a different snapshot answered",
        {
          ok: true,
          data: uriMatch({ snapshotId: "60000000-0000-4000-8000-000000000002" }),
        },
        "vault-unavailable",
      ],
      ["the vault is locked", vaultFailure("crypto-locked"), "vault-unavailable"],
    ])("refuse before any field read when %s", async (_name, answer, reason) => {
      const h = harness({}, { allowedOrigins: [], uris: async () => answer });
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("refuse when the matcher throws", async () => {
      const h = harness(
        {},
        {
          allowedOrigins: [],
          uris: async () => {
            throw new Error("synthetic host failure");
          },
        },
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("report a default awaiting field review as unavailable without matching", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({}, { allowedOrigins: [], uris, quarantined: true });
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(uris).not.toHaveBeenCalled();
    });
    it("ask again after the connection's snapshot is replaced", async () => {
      const replaced = "60000000-0000-4000-8000-000000000002";
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({}, { allowedOrigins: [], uris });
      fake.state.onExecute = async () => {
        h.snapshot.current = replaced;
        uris.mockResolvedValue({ ok: true, data: uriMatch({ snapshotId: replaced }) });
        fake.state.onExecute = undefined;
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(uris).toHaveBeenCalledTimes(2));
    });
    it("are not consulted for a page without a recipe", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      fake.state.pageUrl = "https://other.example/signin";
      expect(await harness({}, { allowedOrigins: [], uris }).hello()).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(uris).not.toHaveBeenCalled();
    });
    it("keep static allowed origins working without a matcher", async () => {
      const h = harness({}, { allowedOrigins: [] });
      expect(await h.hello()).toEqual({ ok: false, reason: "item-origin-mismatch" });
    });
  });
  void parseLoginRecipe({
    ...recipe,
    slots: ["branch", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "password", target: target("password") },
        ],
      },
      recipe.steps[1],
    ],
  });

  describe("without a saved account choice", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const unsaved = { siteDefaults: [], bindings: [] };
    void uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    it("lets another tab start only once an authenticated login saved its choice", async () => {
      // Saving bumps the policy revision, which would stop a login started meanwhile.
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris });
      const update = h.store.update.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      h.store.update.mockImplementationOnce(async (...args) => {
        await held;
        return update(...args);
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      fake.state.tabUrls[2] = fake.state.pageUrl;
      // The other tab waits for the save, then is admitted again with the new revision.
      const other = h.hello({ tab: { id: 2 }, documentId: "other-tab" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(executes()).toHaveLength(2);
      release();
      expect(await other).toEqual({ ok: true });
      expect(h.settings.settings.siteDefaults).toHaveLength(1);
      // Checked against the saved revision, it is not stopped as a policy change.
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "authenticated", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
    });
  });
});
