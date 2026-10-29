import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
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
  shownHello,
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
  const signinStart = {
    path: "/signin",
    require: "writable",
    targets: [{ by: "id", value: "password" }],
  };
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
    const unsaved = { siteDefaults: [], bindings: [] };
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    describe("when the popup picks one of several matches (ADR 0021)", () => {
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const ask = (h: ReturnType<typeof harness>, from: never = popup) =>
        h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, from);
      const pick = (
        h: ReturnType<typeof harness>,
        overrides: Record<string, unknown> = {},
        from: never = popup,
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.choice.pick",
            tabId: 1,
            documentId: "synthetic-document",
            connectionId,
            itemId: otherItemId,
            makeDefault: false,
            ...overrides,
          },
          from,
        );
      const matching = () =>
        harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
        });
      const refused = async () => {
        const h = matching();
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        // The document announces again when asked, with its first step still showing.
        fake.state.onReconnect = () => h.hello();
        return h;
      };
      const offered = {
        ok: true,
        origin,
        documentId: "synthetic-document",
        candidates: [
          { connectionId, itemId },
          { connectionId, itemId: otherItemId },
        ],
      };
      void { ...recipe, rejection: target("rejected") };

      it("ends the choice after a restart once the page can no longer be admitted", async () => {
        await refused();
        const restarted = matching();
        fake.state.onReconnect = () => restarted.hello();
        // Site access was withdrawn while the worker slept; the page answers but is refused.
        fake.state.granted = false;
        expect(await ask(restarted)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        // The open popup asking again sends no further reconnects.
        expect(await ask(restarted)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.reconnects).toHaveLength(1);
      });
      it("says the pick waits while another tab's login holds the site, and keeps the choice", async () => {
        // Another tab logs in to the site with its saved default and is still running.
        fake.state.onExecute = () => new Promise(() => undefined);
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await harness().hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toHaveLength(1),
        );
        // The other tab stays open, so its record outlives this worker's start.
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        try {
          const h = await refused();
          expect(await ask(h)).toEqual({ ...offered, held: true });
          const sent = fake.state.reconnects.length;
          expect(await pick(h)).toEqual({ ok: false, reason: "origin-busy" });
          // Nothing was sent to the page, and the choice still waits for a later pick.
          expect(fake.state.reconnects).toHaveLength(sent);
          expect(fake.state.session["pateat.login-picks.v1"] ?? []).toEqual([]);
          expect(await ask(h)).toEqual({ ...offered, held: true });
          expect(fake.state.badges[1]?.text).toBe("2");
        } finally {
          fake.browser.tabs.query = query;
        }
      });
      it("keeps the choice when another tab's login starts holding the site during the pick", async () => {
        const h = await refused();
        fake.state.onExecute = () => new Promise(() => undefined);
        fake.state.tabUrls[2] = fake.state.pageUrl;
        const other = { tab: { id: 2 }, documentId: "other-tab" };
        expect(await h.hello(other)).toEqual({ ok: false, reason: "account-ambiguous" });
        fake.state.onReconnect = async () => {
          if (fake.state.reconnects.at(-1)?.tabId === 2) return h.hello(other);
          // Another tab's pick starts its login before this page announces again.
          expect(await pick(h, { tabId: 2, documentId: "other-tab", itemId })).toEqual({
            ok: true,
          });
          return h.hello();
        };
        expect(await pick(h)).toEqual({ ok: false, reason: "origin-busy" });
        // The page does not announce again when the hold ends, so the choice stays.
        expect(await ask(h)).toEqual({ ...offered, held: true });
        expect(fake.state.badges[1]?.text).toBe("2");
      });
      it("starts the pick when a newer announcement of the page overtakes the asked one", async () => {
        const h = await refused();
        // The page announces twice, for example after a worker restart; the pick's own
        // announcement comes back stale and the newer one takes the pick.
        let overtaken: Promise<unknown> | undefined;
        fake.state.onReconnect = async () => {
          const asked = h.hello();
          overtaken = h.hello();
          return asked;
        };
        expect(await pick(h)).toEqual({ ok: true });
        expect(await overtaken).toEqual({ ok: true });
      });
      it("ends the choice once a default is saved for the site", async () => {
        const h = await refused();
        h.settings.settings.siteDefaults = [
          { origin, provider: "bitwarden", server: "cloud-us", userId, itemId },
        ];
        expect(await ask(h)).toEqual({ ok: false, reason: "no-choice" });
        expect(await pick(h)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        expect(fake.state.reconnects).toEqual([]);
      });
      it("keeps the choice once a rule pauses the site, as a pause does (ADR 0062)", async () => {
        const h = await refused();
        expect(fake.state.badges[1]?.text).toBe("2");
        h.settings.settings.excludedSites = [
          { hostname: "login.example", includeSubdomains: false },
        ];
        h.login.settingsChanged("saved");
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The waiting choice's count shows over the pause.
        expect(fake.state.badges[1]?.text).toBe("2");
        expect(await ask(h)).toEqual(offered);
      });
      it("takes a pick on a site a rule pauses, as a pick on a paused site logs in", async () => {
        const h = await refused();
        h.settings.settings.excludedSites = [{ hostname: "example", includeSubdomains: true }];
        expect(await pick(h)).toEqual({ ok: true });
      });
      it("keeps the choice and takes a pick on a site the allowed sites leave out (ADR 0077)", async () => {
        const h = await refused();
        h.settings.settings.allowedSitesEnabled = true;
        h.settings.settings.allowedSites = [
          { hostname: "other.example", includeSubdomains: false },
        ];
        h.login.settingsChanged("saved");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fake.state.badges[1]?.text).toBe("2");
        expect(await ask(h)).toEqual(offered);
        expect(await pick(h)).toEqual({ ok: true });
      });
      it("keeps the choice when another site is excluded", async () => {
        const h = await refused();
        h.settings.settings.excludedSites = [
          { hostname: "other.example", includeSubdomains: false },
        ];
        h.login.settingsChanged("saved");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fake.state.badges[1]?.text).toBe("2");
        expect(await ask(h)).toEqual(offered);
      });
      it("keeps a choice decided while a rule paused the site", async () => {
        let h: ReturnType<typeof harness> | undefined;
        h = harness(unsaved, {
          allowedOrigins: [],
          // The site is excluded while the vault is searched, before the choice is offered.
          uris: async () => {
            h!.settings.settings.excludedSites = [
              { hostname: "login.example", includeSubdomains: false },
            ];
            h!.login.settingsChanged("saved");
            return { ok: true, data: both };
          },
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(await ask(h)).toMatchObject({ ok: true });
      });
      it("keeps a frame's choice once a rule pauses the tab's site around it", async () => {
        // Both the frame's and the tab's URL match each item, so the frame is refused.
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async (_connection, url) => ({
            ok: true,
            data: { ...both, targetOrigin: new URL(url).origin },
          }),
        });
        fake.state.tabUrls[1] = "https://portal.example/account";
        const frame = {
          frameId: 3,
          documentId: "synthetic-document",
          tab: { id: 1, url: "https://portal.example/account" },
        };
        expect(await h.hello(frame)).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(fake.state.badges[1]?.text).toBe("2");
        h.settings.settings.excludedSites = [
          { hostname: "portal.example", includeSubdomains: false },
        ];
        h.login.settingsChanged("synced");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fake.state.badges[1]?.text).toBe("2");
        expect(await ask(h)).toMatchObject({ ok: true });
      });
      it("keeps the pick with the attempt it started and forgets it when the tab closes", async () => {
        const h = await refused();
        expect(await pick(h)).toEqual({ ok: true });
        expect(fake.state.session).toEqual({
          "pateat.login-picks.v1": [
            {
              tabId: 1,
              origin,
              documentId: "synthetic-document",
              attemptId: expect.any(String),
              connectionId,
              itemId: otherItemId,
              makeDefault: false,
              waitedMs: expect.any(Number),
            },
          ],
          "pateat.login-choices.v1": [],
          "pateat.login-stopped-asks.v1": [],
          "pateat.login-rejected-asks.v1": [],
          "pateat.login-ask-fills.v1": [],
          "pateat.login-entry-presses.v1": [],
          "pateat.login-noted.v1": [["1 synthetic-document /signin", ["account-ambiguous "]]],
          "pateat.login-relogins.v1": [],
          "pateat.login-detail-offers.v1": [],
          "pateat.login-pending-details.v1": [],
          "pateat.login-refused-details.v1": [],
        });
        // The time the popup offered the choice is the person's, in the login's times too
        // (ADR 0019).
        const [{ waitedMs }] = fake.state.session["pateat.login-picks.v1"] as [
          { waitedMs: number },
        ];
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { timing: { personMs: waitedMs } },
        ]);
        for (const listener of fake.state.removed) listener(1);
        await vi.waitFor(() =>
          expect(fake.state.session).toEqual({
            "pateat.login-noted.v1": [],
            "pateat.login-picks.v1": [],
            "pateat.login-choices.v1": [],
            "pateat.login-stopped-asks.v1": [],
            "pateat.login-rejected-asks.v1": [],
            "pateat.login-ask-fills.v1": [],
            "pateat.login-entry-presses.v1": [],
            "pateat.login-relogins.v1": [],
            "pateat.login-detail-offers.v1": [],
            "pateat.login-pending-details.v1": [],
            "pateat.login-refused-details.v1": [],
          }),
        );
      });
      it("offers a choice in a tab that holds only another origin's record", async () => {
        const second = "https://second.example";
        const h = harness(
          {
            siteDefaults: [
              { origin: second, provider: "bitwarden", server: "cloud-us", userId, itemId },
            ],
            bindings: [{ ...savedBinding, recipeId: "second-signin", origin: second }],
          },
          {
            allowedOrigins: [],
            uris: async (_connection, url) => ({
              ok: true,
              data: { ...both, targetOrigin: new URL(url).origin },
            }),
          },
        );
        const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
        h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
          path !== "/signin" ? undefined : from === origin ? recipe : secondRecipe,
        );
        h.recipes.starts.mockImplementation(async () => startsOf([recipe.steps[0]!]));
        fake.state.tabUrls[1] = `${second}/signin`;
        expect(await h.hello({ url: `${second}/signin` })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "authenticated", account: { origin: second } },
          ]),
        );
        fake.state.tabUrls[1] = fake.state.pageUrl;
        expect(await h.hello({ documentId: "first-site" })).toEqual({
          ok: false,
          reason: "account-ambiguous",
        });
        expect(await ask(h)).toMatchObject({ ok: true, origin, documentId: "first-site" });
      });
      it("keeps a pick with its login past an account switch", async () => {
        fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          username: true,
        });
        h.recipes.recipe.mockResolvedValue(
          parseLoginRecipe({
            ...recipe,
            accountSwitch: { by: "text", value: "Use another account" },
          }),
        );
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
        );
        const stored = () =>
          fake.state.storage["pateat.login-attempts.v5"] as { id: string; state: string }[];
        const picks = () => fake.state.session["pateat.login-picks.v1"] as { attemptId?: string }[];
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        fake.state.onReconnect = () => h.hello();
        expect(await pick(h)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch"),
        );
        const [switched] = stored();
        // The page the switch leads to logs in with the picked account, and the pick
        // follows that login to its later pages.
        expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(() => expect(stored()[0]!.id).not.toBe(switched!.id));
        await vi.waitFor(() => expect(picks()[0]!.attemptId).toBe(stored()[0]!.id));
        expect(h.fields.mock.calls.at(-1)![0]).toMatchObject({
          account: { itemId: otherItemId },
        });
        expect(fake.state.badges[1]?.text).toBe("");
      });
      describe("after a logout (ADR 0062)", () => {
        const steps = () =>
          fake.state.messages
            .filter((entry) => entry.type === "login.execute")
            .map(
              (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step,
            );
        const attempts = () =>
          (fake.state.storage["pateat.login-attempts.v5"] ?? []) as {
            id: string;
            state: string;
            account: { itemId: string };
            document: { tabId: number; documentId: string };
          }[];
        const relogins = () => fake.state.session["pateat.login-relogins.v1"];
        const matched = (report?: (entry: LoginReport) => void) =>
          harness(
            {},
            {
              allowedOrigins: [],
              uris: async () => ({ ok: true, data: both }),
              ...(report ? { report } : {}),
            },
          );
        const signedIn = async (
          h: ReturnType<typeof harness>,
          from: { tab?: { id: number }; documentId?: string } = {},
          itemIdUsed = itemId,
        ) => {
          const tabId = from.tab?.id ?? 1;
          const known = attempts().find((entry) => entry.document.tabId === tabId)?.id;
          expect(await h.hello(from)).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(
              attempts().find((entry) => entry.document.tabId === tabId && entry.id !== known),
            ).toMatchObject({ state: "authenticated", account: { itemId: itemIdUsed } }),
          );
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
        };
        it("logs in again with the saved default once the first step shows again in the tab", async () => {
          const report = vi.fn<(entry: LoginReport) => void>();
          const h = matched(report);
          await signedIn(h);
          // A page of the site without the form only watches for it.
          expect(await h.hello({ documentId: "home" }, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
          await signedIn(h, { documentId: "signed-out" });
          // Only this tab's record was released, and nothing asks.
          expect(attempts()).toHaveLength(1);
          expect(steps().map((step) => step.kind)).toEqual(["fill", "click", "fill", "click"]);
          expect(await ask(h)).toEqual({ ok: false, reason: "no-choice" });
          expect(fake.state.session["pateat.login-choices.v1"] ?? []).toEqual([]);
          const starts = report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "start");
          expect(starts).toEqual([
            expect.objectContaining({ tabId: 1, account: "default" }),
            expect.objectContaining({ tabId: 1, account: "default" }),
          ]);
          expect(
            report.mock.calls.filter(
              ([entry]) => entry.type === "refused" && entry.reason !== "not-started",
            ),
          ).toEqual([]);
        });
        it("logs in again when the form shows again in the document that logged in", async () => {
          const h = matched();
          await signedIn(h);
          // The document announces again after its login ended, as the content script does.
          expect(await h.hello({}, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
          await signedIn(h);
          expect(attempts()).toHaveLength(1);
        });
        it("logs in again in another tab of the site, whose session the logout ended too", async () => {
          const h = matched();
          await signedIn(h);
          fake.state.tabUrls[2] = fake.state.pageUrl;
          await signedIn(h, { tab: { id: 2 }, documentId: "other-tab" });
          expect(attempts().map((entry) => [entry.document.tabId, entry.state])).toEqual([
            [1, "authenticated"],
            [2, "authenticated"],
          ]);
          expect(fake.state.badges[2]?.text ?? "").not.toMatch(/^\d+$/u);
        });
        it("asks again after the tab's pick when no default is saved (ADR 0063)", async () => {
          const h = harness(unsaved, {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: both }),
          });
          expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
          fake.state.onReconnect = () => h.hello();
          expect(await pick(h)).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          // The pick did not make its account the default: the site asks every time.
          const before = steps().length;
          expect(await h.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "account-asked",
          });
          expect(steps()).toHaveLength(before);
        });
        it("logs a sign-in form that does not start a login while the tab is signed in", async () => {
          const report = vi.fn<(report: LoginReport) => void>();
          const h = matched(report);
          const refusals = () =>
            report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
          await signedIn(h);
          // A sign-in input whose form is not the recipe's first step: still logged in.
          const watching = { ok: false, reason: "logged-in", starts: [signinStart] };
          expect(await shownHello(h, { documentId: "home" })).toEqual(watching);
          expect(await shownHello(h, { documentId: "home" })).toEqual(watching);
          expect(refusals()).toEqual([
            { type: "refused", tabId: 1, origin, reason: "not-started", detail: "logged-in" },
          ]);
        });
        it("keeps the tab's login with it after Chrome replaces the tab", async () => {
          const h = matched();
          await signedIn(h);
          fake.state.tabUrls[2] = fake.state.pageUrl;
          for (const listener of fake.state.replaced) listener(2, 1);
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([{ state: "authenticated", document: { tabId: 2 } }]),
          );
          // The restored page of the site only watches, as after a reload.
          expect(await h.hello({ tab: { id: 2 }, documentId: "restored" }, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
        });
        it("keeps the tab's login when the replacement starts a stopped worker", async () => {
          const h = matched();
          await signedIn(h);
          // The worker had stopped; only the tab's new ID is open when it starts again.
          fake.state.replaced.length = 0;
          fake.state.tabUrls[2] = fake.state.pageUrl;
          const query = fake.browser.tabs.query;
          fake.browser.tabs.query = async () => [{ id: 2 }] as never;
          try {
            const restarted = matched();
            for (const listener of fake.state.replaced) listener(2, 1);
            await vi.waitFor(() =>
              expect(attempts()).toMatchObject([
                { state: "authenticated", document: { tabId: 2 } },
              ]),
            );
            expect(
              await restarted.hello({ tab: { id: 2 }, documentId: "restored" }, false),
            ).toEqual({ ok: false, reason: "logged-in", starts: [signinStart] });
          } finally {
            fake.browser.tabs.query = query;
          }
        });
        describe("twice within 10 minutes (relogin-limit)", () => {
          const reloginTitle =
            "Pateat logged in to this site twice in 10 minutes. Click to choose an account.";
          const limited = {
            ok: true,
            origin,
            documentId: "signed-out-again",
            candidates: [
              { connectionId, itemId },
              { connectionId, itemId: otherItemId },
            ],
            ask: "relogin-limit",
          };
          const twice = async (report?: (entry: LoginReport) => void) => {
            const h = matched(report);
            await signedIn(h);
            await signedIn(h, { documentId: "signed-out" });
            return h;
          };
          it("asks instead of logging in a third time, filling nothing", async () => {
            const report = vi.fn<(entry: LoginReport) => void>();
            const h = await twice(report);
            expect(relogins()).toEqual([
              {
                site: "login.example",
                incognito: false,
                at: [expect.any(Number), expect.any(Number)],
              },
            ]);
            const before = steps().length;
            expect(await h.hello({ documentId: "signed-out-again" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
            expect(steps()).toHaveLength(before);
            expect(h.fields).toHaveBeenCalledTimes(2);
            // The saved default is listed first, as the popup shows it.
            expect(await ask(h)).toEqual(limited);
            expect(fake.state.badges[1]).toEqual({ text: "2", title: reloginTitle });
            expect(report).toHaveBeenCalledWith({
              type: "refused",
              tabId: 1,
              origin,
              reason: "relogin-limit",
              candidates: 2,
            });
          });
          it("counts passkey sign-ins Pateat answered by itself, then treats the default as unset", async () => {
            const h = matched();
            // An answer of a login or of the person's choice is not counted.
            h.login.passkeyAnswered(1, origin, "login.example");
            h.login.passkeyAnswered(1, origin, "login.example", undefined, { incognito: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(relogins() ?? []).toEqual([]);
            expect(await h.login.defaultUnset(origin, false)).toBe(false);
            // The login page asks for a passkey on load after each logout, and Pateat
            // answers it alone each time.
            const silent = { silent: true, incognito: false } as const;
            h.login.passkeyAnswered(1, origin, "login.example", undefined, silent);
            h.login.passkeyAnswered(1, origin, "login.example", undefined, silent);
            await vi.waitFor(() =>
              expect(relogins()).toEqual([
                {
                  site: "login.example",
                  incognito: false,
                  at: [expect.any(Number), expect.any(Number)],
                },
              ]),
            );
            // The next request opens the chooser or is handed on, so the loop stops; the
            // page's own login asks too. Incognito windows count apart.
            expect(await h.login.defaultUnset(origin, false)).toBe(true);
            expect(await h.login.defaultUnset(origin, true)).toBe(false);
            expect(await h.hello({ documentId: "signed-out-again" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
          });
          it("logs in with a pick in the popup, which is not counted", async () => {
            const h = await twice();
            expect(await h.hello({ documentId: "signed-out-again" })).toMatchObject({
              reason: "relogin-limit",
            });
            fake.state.onReconnect = () => h.hello({ documentId: "signed-out-again" });
            expect(await pick(h, { documentId: "signed-out-again" })).toEqual({ ok: true });
            await vi.waitFor(() =>
              expect(attempts()).toMatchObject([
                { state: "authenticated", account: { itemId: otherItemId } },
              ]),
            );
            expect(fake.state.badges[1]?.text).not.toBe("2");
            // Still two counted: the next automatic login asks again.
            expect((relogins() as { at: number[] }[])[0]!.at).toHaveLength(2);
            expect(await h.hello({ documentId: "signed-out-third" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
          });
          it("logs in again once 10 minutes passed since the first counted login", async () => {
            const h = await twice();
            const [first] = (relogins() as { at: number[] }[])[0]!.at;
            const clock = vi.spyOn(Date, "now").mockImplementation(() => first! + 10 * 60_000);
            try {
              await signedIn(h, { documentId: "signed-out-again" });
            } finally {
              clock.mockRestore();
            }
            expect((relogins() as { at: number[] }[])[0]!.at).toHaveLength(2);
          });
          it("counts the logins of two tabs that log each other out together", async () => {
            const h = matched();
            await signedIn(h);
            fake.state.tabUrls[2] = fake.state.pageUrl;
            await signedIn(h, { tab: { id: 2 }, documentId: "other-tab" });
            // The first tab's session ended when the second logged in, as on a site that
            // allows one session at a time.
            expect(await h.hello({ documentId: "signed-out" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
            expect(await h.hello({ tab: { id: 2 }, documentId: "other-signed-out" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
          });
          it("counts an incognito window's logins apart", async () => {
            const h = await twice();
            fake.state.incognito.add(2);
            fake.state.tabUrls[2] = fake.state.pageUrl;
            await signedIn(h, { tab: { id: 2 }, documentId: "private" });
            expect(relogins()).toEqual([
              {
                site: "login.example",
                incognito: false,
                at: [expect.any(Number), expect.any(Number)],
              },
              { site: "login.example", incognito: true, at: [expect.any(Number)] },
            ]);
          });
          it("keeps counting across a worker restart", async () => {
            await twice();
            const restarted = matched();
            expect(await restarted.hello({ documentId: "signed-out-again" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
          });
          it("forgets the site's logins once all of its tabs closed", async () => {
            const h = await twice();
            // Another site's tab stays open.
            const query = vi
              .spyOn(fake.browser.tabs, "query")
              .mockResolvedValue([{ id: 3, url: "https://elsewhere.example/" }] as never);
            try {
              for (const listener of fake.state.removed) listener(1);
              await vi.waitFor(() => expect(relogins()).toEqual([]));
            } finally {
              query.mockRestore();
            }
            await signedIn(h, { documentId: "reopened" });
          });
          it("keeps the site's logins while another of its tabs is open", async () => {
            const h = await twice();
            const query = vi
              .spyOn(fake.browser.tabs, "query")
              .mockResolvedValue([{ id: 2, url: fake.state.pageUrl }] as never);
            try {
              for (const listener of fake.state.removed) listener(1);
              await vi.waitFor(() =>
                expect(fake.state.session["pateat.login-noted.v1"]).toBeDefined(),
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
              expect((relogins() as { at: number[] }[])[0]!.at).toHaveLength(2);
            } finally {
              query.mockRestore();
            }
            fake.state.tabUrls[2] = fake.state.pageUrl;
            expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
              ok: false,
              reason: "relogin-limit",
            });
          });
        });
      });
      describe("while the tab asks after a rejected or stopped login (ADR 0021 D)", () => {
        const steps = () =>
          fake.state.messages
            .filter((entry) => entry.type === "login.execute")
            .map(
              (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step,
            );
        const attempts = () =>
          (fake.state.storage["pateat.login-attempts.v5"] ?? []) as {
            state: string;
            account: { itemId: string };
            timing: { since: number; personMs: number };
          }[];
        const rejectedAsks = () => fake.state.session["pateat.login-rejected-asks.v1"];
        const rejected = (tabId = 1) => {
          fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId, origin }];
        };
        const matched = (report?: (entry: LoginReport) => void) =>
          harness(
            {},
            {
              allowedOrigins: [],
              uris: async () => ({ ok: true, data: both }),
              ...(report ? { report } : {}),
            },
          );
        const filledOnly = async (
          h: ReturnType<typeof harness>,
          from: Record<string, unknown> = {},
        ) => {
          const before = steps().length;
          expect(await h.hello(from)).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(before + 1));
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          expect(steps().at(-1)?.kind).toBe("fill");
          // The tab asks as soon as the fill ends.
          const tabId = (from["tab"] as { id: number } | undefined)?.id ?? 1;
          expect(fake.state.badges[tabId]?.text).toBe("2");
          // The content script announces again on the ended status, without a start.
          expect(await h.hello(from, false)).toMatchObject({
            ok: false,
            reason: "form-not-ready",
          });
          expect(fake.state.badges[tabId]?.text).toBe("2");
          // The form showing again in the same document only asks.
          expect(await h.hello(from)).toEqual({ ok: false, reason: "account-asked" });
        };
        it("presses no key of a software keyboard while it only fills, and asks", async () => {
          // A PIN pad may submit at its last digit, so a fill-only login ends before a keypad
          // fill (ADR 0021 D, 0067).
          rejected();
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), username: true },
          );
          h.recipes.recipe.mockResolvedValue(
            parseLoginRecipe({
              ...recipe,
              steps: [
                {
                  kind: "fill",
                  path: "/signin",
                  fields: [
                    {
                      slot: "password",
                      target: target("password"),
                      keypad: { by: "id", value: "keys" },
                    },
                  ],
                },
                recipe.steps[1],
              ],
            }),
          );
          const before = steps().length;
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(fake.state.badges[1]?.text).toBe("2"));
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          expect(steps()).toHaveLength(before);
          expect(attempts()).toEqual([]);
        });
        it("fills once with the saved default, pressing nothing, and asks with it first", async () => {
          const report = vi.fn<(entry: LoginReport) => void>();
          rejected();
          const h = matched(report);
          await filledOnly(h, { documentId: "signed-out" });
          expect(steps().map((step) => step.kind)).toEqual(["fill"]);
          expect(attempts()).toEqual([]);
          expect(fake.state.session["pateat.login-ask-fills.v1"]).toEqual(["1 signed-out /signin"]);
          expect(fake.state.badges[1]).toEqual({
            text: "2",
            title:
              "Pateat: the site did not accept the last login in this tab. Click to choose an account.",
          });
          expect(await ask(h)).toEqual({
            ok: true,
            origin,
            documentId: "signed-out",
            candidates: [
              { connectionId, itemId },
              { connectionId, itemId: otherItemId },
            ],
            ask: "rejected",
          });
          const starts = report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "start");
          expect(starts).toEqual([
            expect.objectContaining({
              tabId: 1,
              account: "default",
              candidates: 2,
              fillOnly: true,
            }),
          ]);
          expect(starts[0]).not.toHaveProperty("itemId");
          expect(report).toHaveBeenCalledWith({
            type: "refused",
            tabId: 1,
            origin,
            reason: "account-asked",
            detail: "rejected",
            candidates: 2,
          });
          // A one-time pick logs in, ends the asking and leaves the saved default as it was.
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          expect(await pick(h, { documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          expect(attempts()[0]).not.toHaveProperty("fillOnly");
          expect(h.settings.settings.siteDefaults).toEqual([
            { origin, provider: "bitwarden", server: "cloud-us", userId, itemId },
          ]);
          expect(rejectedAsks()).toEqual([]);
        });
      });
    });
  });
});
