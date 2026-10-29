import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginStep,
} from "@pateat/contracts";
import { vaultFailure } from "../../vault/record";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import { statusResponseSchema } from "../choice-wire";
import { createLoginBadge, memoryBadgeStorage, setActionBadge } from "../badge";
import type { LoginGeneration, LoginReport } from "../runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  trusted,
  sender,
  target,
  recipe,
  userId,
  savedBinding,
  otherItemId,
  uriMatch,
  harness,
  setPause,
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
    describe("when no item matches, after a vault check (ADR 0025)", () => {
      const none: Awaited<ReturnType<LiveUriMatcher>> = {
        ok: true,
        data: uriMatch({ candidates: [] }),
      };
      function vault() {
        let held = 0;
        const answers: ((synced: boolean) => void)[] = [];
        const insideHold: boolean[] = [];
        const value = {
          refreshIfStale: vi.fn(),
          enter: vi.fn(async () => {
            held += 1;
            let left = false;
            return () => {
              if (left) return;
              left = true;
              held -= 1;
            };
          }),
          checkAfterMiss: vi.fn(() => {
            insideHold.push(held > 0);
            return new Promise<boolean>((resolve) => {
              answers.push(resolve);
            });
          }),
        };
        return { value, answers, insideHold };
      }

      it("asks for a check when the saved default's item no longer matches the page", async () => {
        const sync = vault();
        const h = harness({}, { allowedOrigins: [], uris: async () => none, vault: sync.value });
        expect(await h.hello()).toEqual({ ok: false, reason: "item-origin-mismatch" });
        expect(sync.value.checkAfterMiss).toHaveBeenCalledTimes(1);
        sync.answers[0]!(true);
        await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      });
      it("asks for no check when a one-time pick's item no longer matches the page", async () => {
        const sync = vault();
        let calls = 0;
        const h = harness(unsaved, {
          allowedOrigins: [],
          // Both items match when the choice is offered; the picked one no longer does.
          uris: async () => (calls++ === 0 ? { ok: true, data: both } : none),
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        let again: unknown;
        fake.state.onReconnect = async () => {
          again = await h.hello();
          return again;
        };
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
        );
        await vi.waitFor(() =>
          expect(again).toEqual({ ok: false, reason: "item-origin-mismatch" }),
        );
        expect(sync.value.checkAfterMiss).not.toHaveBeenCalled();
      });
      it.each<[string, Partial<LocalSettings>, Parameters<typeof harness>[1], string]>([
        [
          "two items match",
          unsaved,
          { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          "account-ambiguous",
        ],
        [
          "another item's rules could not be evaluated",
          unsaved,
          {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: uriMatch({ unavailableItemIds: [otherItemId] }) }),
          },
          "item-uri-unevaluated",
        ],
        [
          "the vault is locked",
          unsaved,
          { allowedOrigins: [], uris: async () => vaultFailure("crypto-locked") },
          "vault-unavailable",
        ],
        ["no live URI matching is available", unsaved, { allowedOrigins: [] }, "default-not-set"],
        [
          "the saved default's account is not connected here",
          {
            siteDefaults: [
              {
                origin,
                provider: "bitwarden",
                server: "cloud-us",
                userId: "other-account",
                itemId,
              },
            ],
          },
          { allowedOrigins: [origin] },
          "connection-missing",
        ],
      ])("asks for no check when %s", async (_name, overrides, live, reason) => {
        const sync = vault();
        const h = harness(overrides, { ...live, vault: sync.value });
        expect(await h.hello()).toEqual({ ok: false, reason });
        expect(sync.value.checkAfterMiss).not.toHaveBeenCalled();
      });
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
      it("offers a choice on a new page of a tab whose login Pateat stopped, once its default is removed", async () => {
        // In the owner's Chrome, removing github.com's default stopped its login as
        // `policy-changed`; the reloaded page was refused for several accounts and the popup
        // offered nothing, because the page resumed the stopped record.
        const h = harness({}, { uris: async () => ({ ok: true, data: both }) });
        fake.state.onAwait = () => {
          h.settings.revision += 1;
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "blocked", outcome: "policy-changed" },
          ]),
        );
        fake.state.onAwait = undefined;
        h.settings.settings.siteDefaults = [];
        h.settings.revision += 1;
        const next = { documentId: "synthetic-next" };
        expect(await h.hello(next)).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(fake.state.storage["pateat.login-attempts.v5"]).toEqual([]);
        expect(await ask(h)).toEqual({ ...offered, documentId: "synthetic-next" });
        fake.state.onReconnect = () => h.hello(next);
        expect(await pick(h, next)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { account: { itemId: otherItemId }, document: { documentId: "synthetic-next" } },
          ]),
        );
      });
      it("badges the tab and offers only the refused document's candidates", async () => {
        const h = await refused();
        expect(fake.state.badges[1]).toEqual({
          text: "2",
          title: "Pateat: 2 accounts match this page. Click to choose one.",
        });
        expect(await ask(h)).toEqual(offered);
        // Only the popup page may ask or pick; the settings page and the site cannot.
        expect(await ask(h, trusted)).toBeUndefined();
        expect(await ask(h, sender())).toBeUndefined();
        expect(await pick(h, {}, trusted)).toBeUndefined();
        expect(await pick(h, {}, sender())).toBeUndefined();
        expect(fake.state.reconnects).toEqual([]);
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("dispatches the offered choice snapshot before a badge can reenter tab cleanup", async () => {
        const badge = createLoginBadge({
          setBadge: setActionBadge,
          storage: memoryBadgeStorage(),
        });
        const snapshots: Record<string, unknown>[] = [];
        const set = fake.browser.storage.session.set;
        const writing = vi
          .spyOn(fake.browser.storage.session, "set")
          .mockImplementation((values) => {
            snapshots.push(structuredClone(values));
            return set(values);
          });
        onTestFinished(() => writing.mockRestore());
        const choicesAtBadge: unknown[] = [];
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          badge: {
            ...badge,
            choice: (tabId, value) => {
              if (value) {
                choicesAtBadge.push(snapshots.at(-1)?.["pateat.login-choices.v1"]);
                // Chrome can close a tab while the toolbar reacts to its choice.
                for (const listener of fake.state.removed) listener(tabId);
              }
              badge.choice(tabId, value);
            },
          },
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(choicesAtBadge).toMatchObject([
          [{ document: { tabId: 1, documentId: "synthetic-document" } }],
        ]);
        await vi.waitFor(() => expect(fake.state.session["pateat.login-choices.v1"]).toEqual([]));
        const restarted = matching();
        expect(await ask(restarted)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.reconnects).toEqual([]);
      });
      it.each(["throw", "reject"] as const)(
        "continues admission after session initialization fails by %s",
        async (failure) => {
          const reading = vi
            .spyOn(fake.browser.storage.session, "get")
            .mockImplementationOnce(() => {
              if (failure === "throw") throw new Error("Synthetic session read failure");
              return Promise.reject(new Error("Synthetic session read failure"));
            });
          try {
            const h = matching();
            expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
            expect(await ask(h)).toEqual(offered);
            expect(fake.state.session["pateat.login-choices.v1"]).toMatchObject([
              { document: { documentId: "synthetic-document" } },
            ]);
          } finally {
            reading.mockRestore();
          }
        },
      );
      it.each(["throw", "reject"] as const)(
        "keeps an offered choice usable after its session write fails by %s",
        async (failure) => {
          const writing = vi.spyOn(fake.browser.storage.session, "set").mockImplementation(() => {
            if (failure === "throw") throw new Error("Synthetic session write failure");
            return Promise.reject(new Error("Synthetic session write failure"));
          });
          try {
            const h = matching();
            expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
            expect(await ask(h)).toEqual(offered);
            expect(h.fields).not.toHaveBeenCalled();
          } finally {
            writing.mockRestore();
          }
        },
      );
      it("restarts only the refused document with a one-time pick and saves nothing", async () => {
        const h = await refused();
        expect(await pick(h)).toEqual({ ok: true });
        expect(fake.state.reconnects).toEqual([
          { tabId: 1, frameId: 0, documentId: "synthetic-document" },
        ]);
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        expect(await ask(h)).toEqual({ ok: false, reason: "no-choice" });
        await vi.waitFor(() =>
          expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
        );
        expect(h.fields.mock.calls[0]![0]).toMatchObject({
          account: { origin, connectionId, itemId: otherItemId },
          fieldId: "login.password",
        });
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it.each([false, true])(
        "widens the picked item's saved binding that lacks a slot only for a pick made the default (makeDefault=%s, ADR 0027)",
        async (makeDefault) => {
          const withUsername = parseLoginRecipe({
            ...recipe,
            slots: ["username", "password"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [
                  { slot: "username", target: target("user") },
                  { slot: "password", target: target("password") },
                ],
              },
              recipe.steps[1]!,
            ],
          });
          const narrow: SavedLoginBinding = {
            ...savedBinding,
            itemId: otherItemId,
            slots: [{ slot: "username", field: "username" }],
          };
          const h = harness(
            { siteDefaults: [], bindings: [narrow] },
            {
              allowedOrigins: [],
              uris: async () => ({ ok: true, data: both }),
              otherUsername: true,
            },
          );
          h.recipes.recipe.mockResolvedValue(withUsername);
          expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
          fake.state.onReconnect = () => h.hello();
          expect(await pick(h, { makeDefault })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
          );
          // The gap is filled from the item for this login either way.
          expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toContain("login.password");
          if (makeDefault) {
            await vi.waitFor(() =>
              expect(h.settings.settings.bindings).toEqual([
                { ...narrow, slots: [...narrow.slots, { slot: "password", field: "password" }] },
              ]),
            );
          } else {
            expect(h.store.update).not.toHaveBeenCalled();
            expect(h.settings.settings.bindings).toEqual([narrow]);
          }
        },
      );
      it("saves a pick marked as the default only after authenticated", async () => {
        const h = await refused();
        fake.state.onReconnect = async () => {
          const started = await h.hello();
          expect(h.store.update).not.toHaveBeenCalled();
          return started;
        };
        expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
        expect(h.settings.settings.siteDefaults).toEqual([
          expect.objectContaining({ origin, userId, itemId: otherItemId }),
        ]);
      });
      it.each([
        [{ verdict: "unclear" }, false],
        [{ verdict: "unclear", reason: "already-judged" }, false],
        [{ verdict: "unclear", reason: "judgement-limit" }, false],
        [{ verdict: "unclear", reason: "daily-limit" }, false],
        [{ verdict: "unclear", reason: "monthly-limit" }, false],
        [{ verdict: "unclear", reason: "judged-signed-in" }, true],
        [{ verdict: "signed-in" }, true],
      ] as const)(
        "saves a popup pick only after confirmed completion (%j, confirmed=%s)",
        async (answer, confirmed) => {
          const signedIn = vi.fn<(tabId: number, origin: string) => void>();
          const report = vi.fn<(entry: LoginReport) => void>();
          const tabBadge = createLoginBadge({
            setBadge: vi.fn(async () => undefined),
            storage: memoryBadgeStorage(),
          });
          const h = harness(unsaved, {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: both }),
            generation: {
              available: vi.fn(async () => true as const),
              generate: vi.fn(async () => ({ outcome: "abstained", reason: "ambiguous" }) as const),
              generateEntry: vi.fn(
                async () => ({ outcome: "abstained", reason: "ambiguous" }) as const,
              ),
              judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
                args[4]?.();
                return answer;
              }),
              slotFields: vi.fn(async () => undefined),
            },
            signedIn,
            badge: tabBadge,
            report: (entry) => {
              report(entry);
              tabBadge.observe(entry);
            },
          });
          // There is no learned marker. The submitted form disappears on a quiet page.
          const { completion: _completion, ...withoutCompletion } = recipe;
          h.recipes.recipe.mockResolvedValue(withoutCompletion);
          fake.state.present = new Set(["password", "login"]);
          expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
          fake.state.onReconnect = () => h.hello();
          fake.state.signs = {
            password: false,
            code: false,
            captcha: false,
            invalid: false,
            alert: false,
          };
          fake.state.extracted = {
            "signed-in": {
              ok: true,
              observation: {
                version: 1,
                origin,
                path: "/home",
                complete: true,
                language: "en",
                candidates: [
                  { id: "logout", role: "button", target: target("logout"), label: "Sign out" },
                ],
              },
            },
          };
          fake.state.onExecute = async (message) => {
            if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
            fake.state.present = new Set();
            fake.state.observedPath = "/home";
          };
          expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
          await vi.waitFor(
            () =>
              expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
                { state: "authenticated" },
              ]),
            { timeout: 12_000 },
          );
          const popupStatus = await h.login.handle(
            { version: 1, type: "login.status.get", tabId: 1 },
            popup,
          );
          const parsedStatus = v.parse(statusResponseSchema, popupStatus);
          expect(parsedStatus).toMatchObject({ ok: true, login: { state: "authenticated" } });
          const attempt = report.mock.calls
            .flatMap(([entry]) => (entry.type === "attempt" ? [entry] : []))
            .at(-1);
          if (confirmed) {
            await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledOnce());
            expect(h.settings.settings.siteDefaults).toEqual([
              expect.objectContaining({ origin, userId, itemId: otherItemId }),
            ]);
            expect(signedIn.mock.calls).toEqual([[1, origin]]);
            expect(attempt).not.toHaveProperty("unconfirmed");
            if (parsedStatus.ok) expect(parsedStatus.login).not.toHaveProperty("unconfirmed");
          } else {
            expect(h.store.update).not.toHaveBeenCalled();
            expect(h.settings.settings.siteDefaults).toEqual([]);
            expect(signedIn).not.toHaveBeenCalled();
            expect(attempt).toMatchObject({ state: "authenticated", unconfirmed: true });
            expect(parsedStatus).toMatchObject({
              login: { state: "authenticated", unconfirmed: true },
            });
          }
        },
        15_000,
      );
      it("keeps a paused site's pause after a pick whose sign-in is unconfirmed (ADR 0062)", async () => {
        vi.useFakeTimers();
        onTestFinished(() => void vi.useRealTimers());
        const report = vi.fn<(entry: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          generation: {
            available: vi.fn(async () => true as const),
            generate: vi.fn(async () => ({ outcome: "abstained", reason: "ambiguous" }) as const),
            generateEntry: vi.fn(
              async () => ({ outcome: "abstained", reason: "ambiguous" }) as const,
            ),
            judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
              args[4]?.();
              return { verdict: "unclear" };
            }),
            slotFields: vi.fn(async () => undefined),
          },
          report,
        });
        const { completion: _completion, ...withoutCompletion } = recipe;
        h.recipes.recipe.mockResolvedValue(withoutCompletion);
        fake.state.present = new Set(["password", "login"]);
        expect(await setPause(h, true)).toEqual({ ok: true, until: expect.any(Number) });
        expect(await h.hello()).toEqual({ ok: false, reason: "paused" });
        fake.state.onReconnect = () => h.hello();
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        fake.state.extracted = {
          "signed-in": {
            ok: true,
            observation: {
              version: 1,
              origin,
              path: "/home",
              complete: true,
              language: "en",
              candidates: [
                { id: "logout", role: "button", target: target("logout"), label: "Sign out" },
              ],
            },
          },
        };
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await pick(h)).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
              { state: "authenticated", unconfirmed: true },
            ]),
          { timeout: 12_000 },
        );
        await vi.advanceTimersByTimeAsync(100);
        // Only a confirmed sign-in ends the pause, as it is the only one Pateat tells of.
        expect(fake.state.session["pateat.login-pauses.v1"]).toHaveLength(1);
        expect(report).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: "pause", action: "picked" }),
        );
      }, 15_000);
      it("refuses a pick that is not offered, for another document, or after the page left", async () => {
        const h = await refused();
        expect(await pick(h, { itemId: "80000000-0000-4000-8000-000000000009" })).toEqual({
          ok: false,
          reason: "not-a-candidate",
        });
        expect(await pick(h, { documentId: "other-document" })).toEqual({
          ok: false,
          reason: "no-choice",
        });
        fake.state.gone.add("synthetic-document");
        expect(await pick(h)).toEqual({ ok: false, reason: "document-gone" });
        // Nothing stays picked: the next announcement is refused again.
        fake.state.gone.clear();
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("drops a pick that started nothing, and the form's next appearance asks again", async () => {
        const h = await refused();
        // The form moved past its first step, so the document announces without a start.
        fake.state.onReconnect = () => h.hello({}, false);
        expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
        expect(fake.state.session["pateat.login-picks.v1"]).toEqual([]);
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(fake.state.badges[1]?.text).toBe("2");
        expect(h.fields).not.toHaveBeenCalled();
      });
      const rejecting = { ...recipe, rejection: target("rejected") };
      const rejectedOffer = {
        ...offered,
        ask: "rejected",
        candidates: [
          { connectionId, itemId },
          { connectionId, itemId: otherItemId },
        ],
      };
      const rejectedTitle =
        "Pateat: the site did not accept the last login in this tab. Click to choose an account.";
      it("offers the accounts again once the site rejects a picked account in its page", async () => {
        const h = await refused();
        // Another tab of the site waits on its own choice of several accounts.
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "account-ambiguous",
        });
        h.recipes.recipe.mockResolvedValue(rejecting);
        fake.state.observed = ["missing", "unique"];
        expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "blocked", outcome: "credential-rejected" },
          ]),
        );
        const before = fake.state.messages.filter((entry) => entry.type === "login.execute");
        // The page announces again on the result, then once its form's first step shows.
        expect(await h.hello({}, false)).toMatchObject({ ok: false });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
        expect(fake.state.storage["pateat.login-attempts.v5"]).toEqual([]);
        expect(await ask(h)).toEqual(rejectedOffer);
        expect(fake.state.badges[1]).toEqual({ text: "2", title: rejectedTitle });
        // The other tab's popup chooses no account either.
        expect(
          await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
        ).toMatchObject({ documentId: "other-tab", rejectedElsewhere: true });
        // Nothing was saved as the default, and the page is not filled again.
        expect(h.store.update).not.toHaveBeenCalled();
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual(
          before,
        );
        // Another account picked there logs in.
        h.recipes.recipe.mockResolvedValue(recipe);
        fake.state.observed = ["unique", "missing"];
        fake.state.onReconnect = () => h.hello();
        expect(await pick(h, { itemId })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "authenticated", account: { itemId } },
          ]),
        );
      });
      it("offers the accounts again once the site rejects a picked account in a page on another path", async () => {
        const generate = vi.fn<LoginGeneration["generate"]>(async () => ({
          outcome: "abstained",
          reason: "ambiguous",
        }));
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          generation: {
            available: vi.fn(async () => true as const),
            generate,
            generateEntry: vi.fn(),
            judge: vi.fn(async () => ({ verdict: "unclear" as const })),
            slotFields: vi.fn(async () => undefined),
          },
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        // A login resumes its own recipe by ID on any path.
        h.recipes.recipe.mockImplementation(async (_at: string, path: string, id?: string) =>
          path === "/signin" || id === rejecting.id ? rejecting : undefined,
        );
        fake.state.observed = ["missing", "unique"];
        fake.state.onReconnect = () => h.hello();
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The site answers with its form and an error on the path the form posted to, in a
          // new document, where no recipe starts.
          fake.state.gone.add("synthetic-document");
          fake.state.pageUrl = "https://login.example/session";
          fake.state.observedPath = "/session";
          setTimeout(() => void h.hello({ documentId: "document-failed" }, false), 0);
        };
        expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            {
              state: "blocked",
              outcome: "credential-rejected",
              document: { documentId: "document-failed" },
            },
          ]),
        );
        // Its announcement on the result asks at once: the page may be sent for a recipe
        // like any sign-in page without one, rather than being taken as signed in.
        fake.state.onExecute = undefined;
        expect(await h.hello({ documentId: "document-failed" }, false)).toMatchObject({
          ok: false,
          reason: "recipe-not-found",
          generate: true,
        });
        expect(fake.state.storage["pateat.login-attempts.v5"]).toEqual([]);
        // Once a recipe starts on that path, its form offers the accounts.
        const session = {
          ...recipe,
          id: "synthetic-session",
          steps: recipe.steps.map((step) => ({ ...step, path: "/session" })),
        };
        h.recipes.recipe.mockImplementation(async (_at, path) =>
          path === "/session" ? session : undefined,
        );
        expect(await h.hello({ documentId: "document-failed" })).toEqual({
          ok: false,
          reason: "account-asked",
        });
        expect(await ask(h)).toEqual({ ...rejectedOffer, documentId: "document-failed" });
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("never fills the page a saved default was rejected in again, and fills later pages once", async () => {
        const report = vi.fn<(entry: LoginReport) => void>();
        const h = harness({}, { uris: async () => ({ ok: true, data: both }), report });
        h.recipes.recipe.mockResolvedValue(rejecting);
        fake.state.observed = ["missing", "unique"];
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "blocked", outcome: "credential-rejected" },
          ]),
        );
        const before = fake.state.messages.filter((entry) => entry.type === "login.execute");
        await h.hello({}, false);
        expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
        const sent = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
        const kinds = () =>
          sent()
            .slice(before.length)
            .map(
              (entry) =>
                (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
            );
        expect(sent()).toEqual(before);
        expect(await ask(h)).toEqual(rejectedOffer);
        // The whole document that showed the rejection is kept unfilled (ADR 0021 D).
        expect(fake.state.session["pateat.login-ask-fills.v1"]).toEqual(["1 synthetic-document"]);
        // A later page of the tab is filled once with the default, pressing nothing, and the
        // tab asks again once the fill ends.
        fake.state.observed = ["unique", "missing"];
        const next = { documentId: "synthetic-next" };
        expect(await h.hello(next)).toEqual({ ok: true });
        await vi.waitFor(() => expect(kinds()).toEqual(["fill"]));
        await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
        expect(fake.state.storage["pateat.login-attempts.v5"]).toEqual([]);
        expect(await ask(h)).toEqual({ ...rejectedOffer, documentId: "synthetic-next" });
        expect(fake.state.badges[1]).toEqual({ text: "2", title: rejectedTitle });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "start", tabId: 1, account: "default", fillOnly: true }),
        );
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "attempt",
            tabId: 1,
            state: "blocked",
            outcome: "cancelled",
            reason: "fill-only",
          }),
        );
        expect(report).toHaveBeenCalledWith({
          type: "refused",
          tabId: 1,
          origin,
          reason: "account-asked",
          detail: "rejected",
          candidates: 2,
        });
        // The same page showing its form again only asks.
        expect(await h.hello(next)).toEqual({ ok: false, reason: "account-asked" });
        expect(kinds()).toEqual(["fill"]);
        // Another tab of the site fills once and asks too; its popup chooses no account.
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
        await vi.waitFor(() => expect(kinds()).toEqual(["fill", "fill"]));
        await vi.waitFor(async () =>
          expect(
            await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
          ).toMatchObject({ ask: "rejected-elsewhere", rejectedElsewhere: true }),
        );
        expect(fake.state.badges[2]?.title).toBe(
          "Pateat: the site did not accept a login in another tab. Click to choose an account.",
        );
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("moves a rejected ask with a replaced tab and logs its end once the tab closes", async () => {
        const report = vi.fn<(entry: LoginReport) => void>();
        const h = harness({}, { uris: async () => ({ ok: true, data: both }), report });
        h.recipes.recipe.mockResolvedValue(rejecting);
        fake.state.observed = ["missing", "unique"];
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "blocked", outcome: "credential-rejected" },
          ]),
        );
        await h.hello({}, false);
        expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
        expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        // Chrome replaces the tab (prerendering): the ask goes with it.
        fake.state.tabUrls[2] = fake.state.pageUrl;
        for (const listener of fake.state.replaced) listener(2, 1);
        await vi.waitFor(() =>
          expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([
            { tabId: 2, origin },
          ]),
        );
        for (const listener of fake.state.removed) listener(2);
        await vi.waitFor(() =>
          expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([]),
        );
        expect(report).toHaveBeenCalledWith({
          type: "ask-ended",
          tabId: 2,
          origin,
          ask: "rejected",
          cause: "tab-closed",
        });
      });
      it("offers the choice again after a worker restart, or clears it once the page is gone", async () => {
        await refused();
        // A new worker starts with only session storage; its badge survived.
        const restarted = matching();
        fake.state.onReconnect = () => restarted.hello();
        expect(await ask(restarted)).toEqual(offered);
        expect(fake.state.reconnects.at(-1)).toEqual({
          tabId: 1,
          frameId: 0,
          documentId: "synthetic-document",
        });

        const again = matching();
        fake.state.gone.add("synthetic-document");
        expect(await ask(again)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        await vi.waitFor(() => expect(fake.state.session["pateat.login-choices.v1"]).toEqual([]));
      });
      it("offers the choice after a restart when a newer announcement overtakes the asked one", async () => {
        await refused();
        const restarted = matching();
        // The worker's reconnect of every tab announces the document again while the
        // popup's reconnect is still admitted, so the popup's answer comes back stale.
        let overtaken: Promise<unknown> | undefined;
        fake.state.onReconnect = async () => {
          const asked = restarted.hello();
          overtaken = restarted.hello();
          return asked;
        };
        expect(await ask(restarted)).toEqual(offered);
        expect(await overtaken).toEqual({ ok: false, reason: "account-ambiguous" });
      });
    });
  });
});
