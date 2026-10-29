import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxTargetUrlLength } from "@pateat/bitwarden";
import { parseLoginRecipe, type LoginStep } from "@pateat/contracts";
import { vaultFailure } from "../../vault/record";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  snapshotId,
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
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const unsaved = { siteDefaults: [], bindings: [] };
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    it("logs in with the only URI-matched item and saves the choice after authenticated", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, { allowedOrigins: [], uris, report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      // The log names how the account was chosen, and that the choice was saved.
      const decisions = () =>
        report.mock.calls
          .map(([entry]) => entry)
          .filter((entry) => entry.type === "start" || entry.type === "choice");
      await vi.waitFor(() => expect(decisions()).toHaveLength(2));
      expect(decisions()).toEqual([
        {
          type: "start",
          tabId: 1,
          origin,
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
          route: "password",
          variant: 0,
          account: "match",
          candidates: 1,
          itemId,
        },
        { type: "choice", tabId: 1, origin, outcome: "saved" },
      ]);
      expect(h.fields.mock.calls[0]![0]).toMatchObject({
        account: { origin, connectionId, itemId },
        fieldId: "login.password",
      });
      expect(h.store.update.mock.calls[0]![0]).toBe(1);
      expect(h.store.update.mock.calls[0]![1]).toBe("account-choice");
      // The saved default names the provider account, not this device's connection, and
      // keeps the connection's label for display.
      expect(h.settings.settings.siteDefaults).toEqual([
        {
          origin,
          provider: "bitwarden",
          server: "cloud-us",
          userId,
          itemId,
          itemName: "Synthetic item",
          accountName: "Synthetic live vault",
        },
      ]);
      expect(h.settings.settings.bindings).toEqual([
        { ...savedBinding, accountName: "Synthetic live vault" },
      ]);
      // One query per document while every connection's snapshot is unchanged.
      expect(uris).toHaveBeenCalledTimes(1);
    });
    describe("with a generated recipe that has no completion yet", () => {
      const { completion: _unlearned, ...generated } = recipe;
      const start = async (withRecipe: typeof generated) => {
        const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
        const h = harness(unsaved, { allowedOrigins: [], uris });
        h.recipes.recipe.mockResolvedValue(withRecipe);
        expect(await h.hello()).toEqual({ ok: true });
        return h;
      };
      const published = () => JSON.stringify(fake.state.messages);
      it("never reports authenticated or saves a choice after submitting", async () => {
        const h = await start(generated);
        // Nothing settles the submission until the observation budget runs out.
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        // After the last step there is nothing to look for: no completion, rejection or step.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({ type: "login.observe", targets: [] }),
        );
        expect(published()).not.toContain("authenticated");
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
      it("still reports a rejection target, observed first", async () => {
        fake.state.observed = ["unique"];
        const h = await start({ ...generated, rejection: target("error") });
        await vi.waitFor(() => expect(published()).toContain("credential-rejected"));
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({ type: "login.observe", targets: [target("error")] }),
        );
        expect(h.store.update).not.toHaveBeenCalled();
      });
      const twoPages = (rejection?: string) =>
        parseLoginRecipe({
          ...generated,
          ...(rejection ? { rejection: target(rejection) } : {}),
          steps: [
            { kind: "click", path: "/signin", target: target("continue"), purpose: "advance" },
            {
              kind: "fill",
              path: "/next",
              fields: [{ slot: "password", target: target("password") }],
            },
            { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
          ],
          maxSubmissions: 2,
        });
      it("waits for the next page's field behind a rejection target", async () => {
        fake.state.observedPath = "/next";
        fake.state.present = new Set();
        await start(twoPages("error"));
        await vi.waitFor(() =>
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.observe").length,
          ).toBeGreaterThanOrEqual(3),
        );
        // Neither the rejection nor the field is there, so only the advance click ran.
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          1,
        );
      });
      it("continues to the next page's step", async () => {
        fake.state.observedPath = "/next";
        fake.state.present = new Set(["password", "login"]);
        await start(twoPages());
        // The next step's field is the only target, so it is observed at index 0.
        await vi.waitFor(() =>
          expect(fake.state.messages).toContainEqual(
            expect.objectContaining({ type: "login.observe", targets: [target("password")] }),
          ),
        );
        await vi.waitFor(() => expect(published()).toContain('"stepIndex":2'), { timeout: 6_000 });
      }, 10_000);
    });
    it("refuses the only URI match when its account is connected more than once", async () => {
      // Both connections of the account follow its one synced policy (ADR 0023), so both
      // are searched; the automatic choice names the provider account as a saved default
      // would, so it stays ambiguous.
      const uris = vi.fn<LiveUriMatcher>(async (connection) => ({
        ok: true,
        data: uriMatch({ connectionId: connection }),
      }));
      const h = harness(unsaved, { allowedOrigins: [], uris, duplicateAccount: true });
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.store.update).not.toHaveBeenCalled();
    });
    describe("with the account the page set in its username input", () => {
      const withUsername = parseLoginRecipe({
        ...recipe,
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
          recipe.steps[1]!,
        ],
      });
      const twoAccounts = (report?: (entry: LoginReport) => void) => {
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          username: true,
          otherUsername: true,
          ...(report ? { report } : {}),
        });
        h.recipes.recipe.mockResolvedValue(withUsername);
        h.fields.mockImplementation(async ({ account, fieldId }) =>
          fieldId === "login.username"
            ? account.itemId === itemId
              ? "a@example.com"
              : "b@example.com"
            : "synthetic-secret",
        );
        return h;
      };
      const asked = () =>
        fake.state.messages.filter((entry) => entry.type === "login.site.account");
      it("logs in with the item whose username the page's value equals, never saving it", async () => {
        fake.state.siteAccount = { ok: true, index: 1 };
        const report = vi.fn<(entry: LoginReport) => void>();
        const h = twoAccounts(report);
        expect(await h.hello()).toEqual({ ok: true });
        // Every matching item's username goes to the page's script, which answers an index.
        expect(asked()).toEqual([
          expect.objectContaining({
            path: "/signin",
            targets: [target("email")],
            usernames: ["a@example.com", "b@example.com"],
          }),
        ]);
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
            { state: "authenticated" },
          ]),
        );
        expect(
          h.fields.mock.calls.some(
            ([request]) =>
              request.account.itemId === otherItemId && request.fieldId === "login.password",
          ),
        ).toBe(true);
        expect(
          h.fields.mock.calls.some(
            ([request]) =>
              request.account.itemId === itemId && request.fieldId === "login.password",
          ),
        ).toBe(false);
        // The log names how the account was chosen, and nothing is saved as the default.
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({
            type: "start",
            account: "site-value",
            candidates: 2,
            itemId: otherItemId,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.store.update).not.toHaveBeenCalledWith(
          expect.anything(),
          "account-choice",
          expect.anything(),
        );
        expect(h.settings.settings.siteDefaults).toEqual([]);
      });
      it("still asks for a pick when the page's value names no single item", async () => {
        fake.state.siteAccount = { ok: false };
        const h = twoAccounts();
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(asked()).toHaveLength(1);
      });
      it("reads no username when another item's username cannot be read", async () => {
        fake.state.siteAccount = { ok: true, index: 0 };
        const h = twoAccounts();
        h.fields.mockImplementation(async ({ account, fieldId }) => {
          if (fieldId === "login.username" && account.itemId === otherItemId)
            throw new Error("unavailable");
          return fieldId === "login.username" ? "a@example.com" : "synthetic-secret";
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(asked()).toEqual([]);
      });
      it("never picks by the page's value on a paused site (ADR 0062)", async () => {
        fake.state.siteAccount = { ok: true, index: 1 };
        fake.state.openTabs = [1];
        const h = twoAccounts();
        await setPause(h, true);
        expect(await h.hello()).toMatchObject({ ok: false, reason: "paused" });
        expect(asked()).toEqual([]);
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
      });
      it("never picks by the page's value in a tab that asks after a stopped login (ADR 0062)", async () => {
        fake.state.siteAccount = { ok: true, index: 1 };
        fake.state.session["pateat.login-stopped-asks.v1"] = [{ tabId: 1, origin }];
        const h = twoAccounts();
        expect(await h.hello()).toEqual({ ok: false, reason: "account-asked" });
        expect(asked()).toEqual([]);
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
      });
      it("asks nothing for a recipe without an account input on the page's path", async () => {
        fake.state.siteAccount = { ok: true, index: 0 };
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          username: true,
          otherUsername: true,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(asked()).toEqual([]);
        expect(h.fields).not.toHaveBeenCalled();
      });
    });
    describe("with a completion that also lists absent elements", () => {
      const learned = parseLoginRecipe({
        ...recipe,
        completion: [{ ...recipe.completion![0]!, absent: [target("password")] }],
      });
      const published = () => JSON.stringify(fake.state.messages);
      it("authenticates once the marker shows and the field is gone", async () => {
        fake.state.present = new Set(["authenticated"]);
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"state":"authenticated"'));
        // The completion target comes first, then the elements that must be missing, each
        // counting its hidden copies too (ADR 0037 amendment of 2026-10-22).
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            targets: [target("authenticated"), target("password")],
            links: [true, false],
            hidden: [true, true],
          }),
        );
      });
      it("authenticates on a later marker while an earlier one's field is still there", async () => {
        // The first marker needs the password field gone; the second, learned on another
        // signed-in page, needs nothing (ADR 0029).
        const two = parseLoginRecipe({
          ...learned,
          completion: [...learned.completion!, { target: target("account") }],
        });
        fake.state.present = new Set(["authenticated", "password", "account"]);
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
        });
        h.recipes.recipe.mockResolvedValue(two);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"state":"authenticated"'));
        // Each marker comes with the elements it needs missing, in the learned order.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            targets: [target("authenticated"), target("password"), target("account")],
          }),
        );
      });
      it("never authenticates while the field is still there", async () => {
        fake.state.present = new Set(["authenticated", "password", "login"]);
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        expect(published()).not.toContain('"state":"authenticated"');
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
      const noSigns = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      const afterClick =
        (present: string[], path: string, unusable: string[] = []) =>
        async (message: Record<string, unknown>) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set(present);
          fake.state.unusable = new Set(unusable);
          fake.state.observedPath = path;
        };
      it("completes on the marker shown on another path, before reading the sign-in state (ADR 0029)", async () => {
        fake.state.present = new Set(["password", "login"]);
        fake.state.signs = noSigns;
        fake.state.onExecute = afterClick(["authenticated"], "/home");
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          report,
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"state":"authenticated"'), {
          timeout: 8_000,
        });
        // A marker proves the sign-in on any path, so the completion check settles it.
        expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "state" }));
      }, 12_000);
      it("never counts a hidden marker, as on the sign-in page after a failed password (ADR 0029)", async () => {
        fake.state.present = new Set(["password", "login"]);
        fake.state.signs = noSigns;
        // The site keeps a hidden "Sign out" in a closed menu on every page.
        fake.state.onExecute = afterClick(["authenticated", "password", "login"], "/signin", [
          "authenticated",
        ]);
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          report,
        });
        h.recipes.recipe.mockResolvedValue(recipe);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        expect(published()).not.toContain('"state":"authenticated"');
        expect(report).toHaveBeenCalledWith(expect.objectContaining({ type: "state", e1: false }));
      }, 10_000);
      it("never counts the marker while a hidden field must still be gone on its path", async () => {
        fake.state.present = new Set(["password", "login"]);
        fake.state.signs = noSigns;
        // A failed sign-in hides the form again on the completion's own path.
        fake.state.onExecute = afterClick(["authenticated", "password"], "/signin", ["password"]);
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          report,
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "state", s1: false, e1: false, decision: "judge" }),
        );
        expect(published()).not.toContain('"state":"authenticated"');
      }, 10_000);
    });
    it("saves nothing while another login is still running", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const second = "https://second.example";
      const h = harness(
        {
          siteDefaults: [
            { origin: second, provider: "bitwarden", server: "cloud-us", userId, itemId },
          ],
          bindings: [],
        },
        { allowedOrigins: [second], uris: async () => ({ ok: true, data: uriMatch() }), report },
      );
      h.recipes.recipe.mockImplementation(async (at: string) =>
        at === origin ? recipe : at === second ? { ...recipe, origin: second } : undefined,
      );
      fake.state.tabUrls[2] = `${second}/signin`;
      let held = false;
      fake.state.onExecute = async (_message, tabId) => {
        if (tabId !== 2) return;
        held = true;
        await new Promise(() => undefined);
      };
      expect(await h.hello({ tab: { id: 2 }, url: `${second}/signin` })).toEqual({ ok: true });
      await vi.waitFor(() => expect(held).toBe(true));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
      );
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith({
          type: "choice",
          tabId: 1,
          origin,
          outcome: "login-in-progress",
        }),
      );
      expect(h.store.update).not.toHaveBeenCalled();
    });
    describe("next to another login between pages after a worker restart", () => {
      const second = "https://second.example";
      const sites = {
        siteDefaults: [
          { origin: second, provider: "bitwarden" as const, server: "cloud-us", userId, itemId },
        ],
        bindings: [],
      };
      const records = () =>
        (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Record<string, unknown>[];
      const restartBetweenPages = async (age: number) => {
        const report = vi.fn<(report: LoginReport) => void>();
        const setup = {
          allowedOrigins: [second],
          uris: async () => ({ ok: true as const, data: uriMatch() }),
        };
        const first = harness(sites, setup);
        first.recipes.recipe.mockImplementation(async (at: string) =>
          at === second ? { ...recipe, origin: second } : undefined,
        );
        fake.state.tabUrls[2] = `${second}/signin`;
        let held = false;
        fake.state.onExecute = async (message, tabId) => {
          if (tabId !== 2 || (message["operation"] as { step: LoginStep }).step.kind !== "click")
            return;
          held = true;
          await new Promise(() => undefined);
        };
        expect(await first.hello({ tab: { id: 2 }, url: `${second}/signin` })).toEqual({
          ok: true,
        });
        await vi.waitFor(() => expect(held).toBe(true));
        await vi.waitFor(() => expect(records()).toMatchObject([{ state: "submit-intent" }]));
        fake.state.onExecute = undefined;
        const [record] = records();
        record!["changedAt"] = (record!["changedAt"] as number) - age;
        // Both tabs are still open.
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        const h = harness(sites, { ...setup, report });
        h.recipes.recipe.mockImplementation(async (at: string) =>
          at === origin ? recipe : at === second ? { ...recipe, origin: second } : undefined,
        );
        expect(await h.login.active()).toBe(true);
        return { h, report };
      };
      const query = fake.browser.tabs.query;
      afterEach(() => {
        fake.browser.tabs.query = query;
      });
      it("saves nothing while that login changed within two minutes", async () => {
        const { h, report } = await restartBetweenPages(10_000);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(report).toHaveBeenCalledWith({
            type: "choice",
            tabId: 1,
            origin,
            outcome: "login-in-progress",
          }),
        );
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it.each([
        ["has not changed for two minutes (owner, 2026-10-24)", 2 * 60_000],
        // A clock set back ends the wait rather than prolonging it.
        ["changed after the clock was set back", -60_000],
      ])("saves the choice once that login %s", async (_name, age) => {
        const { h, report } = await restartBetweenPages(age);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(report).toHaveBeenCalledWith({
            type: "choice",
            tabId: 1,
            origin,
            outcome: "saved",
          }),
        );
        expect(h.settings.settings.siteDefaults).toContainEqual(
          expect.objectContaining({ origin, itemId }),
        );
      });
    });
    it("saves the choice next to a login whose result settled as unknown", async () => {
      const second = "https://second.example";
      const { completion: _unlearned, ...generated } = recipe;
      const h = harness(
        {
          siteDefaults: [
            { origin: second, provider: "bitwarden", server: "cloud-us", userId, itemId },
          ],
          bindings: [],
        },
        { allowedOrigins: [second], uris: async () => ({ ok: true, data: uriMatch() }) },
      );
      h.recipes.recipe.mockImplementation(async (at: string) =>
        at === origin ? recipe : at === second ? { ...generated, origin: second } : undefined,
      );
      fake.state.tabUrls[2] = `${second}/signin`;
      const attempts = () =>
        (fake.state.storage["pateat.login-attempts.v5"] ?? []) as Record<string, unknown>[];
      expect(await h.hello({ tab: { id: 2 }, url: `${second}/signin` })).toEqual({ ok: true });
      // The record stays until its tab closes; it must not hold the choice off for as long.
      await vi.waitFor(
        () => expect(attempts()).toMatchObject([{ state: "reconciling", settled: true }]),
        { timeout: 6_000 },
      );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      expect(h.settings.settings.siteDefaults).toContainEqual(
        expect.objectContaining({ origin, itemId }),
      );
    }, 10_000);
    it("never saves an account other than the one the attempt used", async () => {
      const replaced = "60000000-0000-4000-8000-000000000002";
      const onlyOther = uriMatch({
        snapshotId: replaced,
        candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
      });
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris });
      fake.state.onExecute = async () => {
        fake.state.onExecute = undefined;
        // Only another item matches while the next document announces itself, then the
        // attempt's own item matches again and the login completes.
        h.snapshot.current = replaced;
        // Restore the attempt's item once that document's query has chosen the other one.
        uris.mockImplementationOnce(async () => {
          h.snapshot.current = snapshotId;
          return { ok: true, data: onlyOther };
        });
        await h.hello({ documentId: "synthetic-document-2" });
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
      );
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("saves nothing when the credential is rejected", async () => {
      const rejecting = { ...recipe, rejection: target("rejected") };
      fake.state.observed = ["missing", "unique"];
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
      });
      h.recipes.recipe.mockResolvedValue(rejecting);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("credential-rejected"),
      );
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("keeps a saved default even when more items match, and saves only its binding", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: both }));
      const h = harness({ bindings: [] }, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      // The saved default, which has no item name, is kept as is, never rewritten.
      expect(h.settings.settings.siteDefaults).toEqual([
        { origin, provider: "bitwarden", server: "cloud-us", userId, itemId },
      ]);
      expect(h.settings.settings.bindings).toEqual([
        { ...savedBinding, accountName: "Synthetic live vault" },
      ]);
      // The default is used through this device's connection.
      expect(h.fields.mock.calls[0]![0]).toMatchObject({
        account: { origin, connectionId, itemId },
      });
    });
    it("names a new default after this device's connection but keeps a stored binding", async () => {
      // A binding made by AI generation has no account name.
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({ siteDefaults: [] }, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      expect(h.settings.settings.siteDefaults).toEqual([
        {
          origin,
          provider: "bitwarden",
          server: "cloud-us",
          userId,
          itemId,
          itemName: "Synthetic item",
          accountName: "Synthetic live vault",
        },
      ]);
      expect(h.settings.settings.bindings).toEqual([savedBinding]);
    });
    it("reports a locked vault, not a missing account, for a provider-account default", async () => {
      const h = harness(
        { siteDefaults: [{ origin, provider: "bitwarden", server: "cloud-us", userId, itemId }] },
        { allowedOrigins: [origin] },
      );
      h.snapshot.userId = undefined;
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("refuses a provider-account default whose account is not connected here", async () => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", server: "cloud-us", userId: "other-account", itemId },
          ],
        },
        { allowedOrigins: [origin] },
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "connection-missing" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it.each<[string, Awaited<ReturnType<LiveUriMatcher>>, string, Partial<LoginReport>]>([
      ["two items match", { ok: true, data: both }, "account-ambiguous", { candidates: 2 }],
      [
        "no item matches",
        { ok: true, data: uriMatch({ candidates: [] }) },
        "default-not-set",
        { detail: "no-uri-match" },
      ],
      [
        "another item's rules could not be evaluated",
        { ok: true, data: uriMatch({ unavailableItemIds: [otherItemId] }) },
        "item-uri-unevaluated",
        {},
      ],
      ["the vault is locked", vaultFailure("crypto-locked"), "vault-unavailable", {}],
    ])("refuses before any field read when %s", async (_name, answer, reason, logged) => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, { allowedOrigins: [], uris: async () => answer, report });
      expect(await h.hello()).toEqual({ ok: false, reason });
      // The log says how many accounts could answer, or that no vault item matched.
      expect(report).toHaveBeenCalledWith({ type: "refused", tabId: 1, origin, reason, ...logged });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("logs in on a page URL longer than a saved URI may be, as Bitwarden matches it", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      fake.state.pageUrl = `https://login.example/signin?SAMLRequest=${"a".repeat(8200)}`;
      const h = harness(unsaved, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      expect(uris).toHaveBeenCalledWith(connectionId, fake.state.pageUrl, undefined);
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
      );
    });
    it("refuses a page URL longer than Chromium allows as a URL, not a vault failure", async () => {
      // The crypto host rejects a target over Chromium's URL limit as an invalid request.
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) =>
        url.length > maxTargetUrlLength
          ? vaultFailure("invalid-request")
          : { ok: true, data: uriMatch() },
      );
      const report = vi.fn<(report: LoginReport) => void>();
      fake.state.pageUrl = `https://login.example/signin?SAMLRequest=${"a".repeat(maxTargetUrlLength)}`;
      const h = harness(unsaved, { allowedOrigins: [], uris, report });
      expect(await h.hello()).toEqual({ ok: false, reason: "url-too-long" });
      expect(report).toHaveBeenCalledWith({
        type: "refused",
        tabId: 1,
        origin,
        reason: "url-too-long",
      });
      expect(uris).not.toHaveBeenCalled();
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("refuses a saved default's page URL longer than Chromium allows as a URL", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      fake.state.pageUrl = `https://login.example/signin?SAMLRequest=${"a".repeat(maxTargetUrlLength)}`;
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: false, reason: "url-too-long" });
      expect(uris).not.toHaveBeenCalled();
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
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
      const flush = async () => {
        for (let index = 0; index < 5; index += 1)
          // oxlint-disable-next-line no-await-in-loop -- lets each pending step run
          await new Promise((resolve) => setTimeout(resolve, 0));
      };
      it("asks for a check within the page's hold and reconnects only the refused document", async () => {
        const sync = vault();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "default-not-set" });
        expect(sync.value.checkAfterMiss).toHaveBeenCalledTimes(1);
        expect(sync.insideHold).toEqual([true]);
        await flush();
        expect(fake.state.reconnects).toEqual([]);
        sync.answers[0]!(true);
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual([
            { tabId: 1, frameId: 0, documentId: "synthetic-document" },
          ]),
        );
        await flush();
        expect(fake.state.reconnects).toHaveLength(1);
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("reconnects a refused frame by its own frame and document", async () => {
        const sync = vault();
        // The tab shows the page around the frame; the frame's own URL is the login page.
        fake.state.tabUrls[1] = "https://login.example/home";
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(
          await h.hello({
            frameId: 3,
            documentId: "synthetic-frame-document",
            tab: { id: 1, url: "https://login.example/home" },
          }),
        ).toEqual({ ok: false, reason: "default-not-set" });
        sync.answers[0]!(true);
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual([
            { tabId: 1, frameId: 3, documentId: "synthetic-frame-document" },
          ]),
        );
      });
      it("reconnects nothing when no check applied a new snapshot in time", async () => {
        const sync = vault();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "default-not-set" });
        sync.answers[0]!(false);
        await flush();
        expect(fake.state.reconnects).toEqual([]);
      });
      it.each<[string, (h: ReturnType<typeof harness>) => Promise<unknown>]>([
        ["announced again", (h) => h.hello()],
        ["was replaced by another document", (h) => h.hello({ documentId: "synthetic-next" })],
        [
          "went away with its tab",
          async () => {
            for (const listener of fake.state.removed) listener(1);
          },
        ],
      ])("reconnects nothing once the refused document %s", async (_name, change) => {
        const sync = vault();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "default-not-set" });
        await change(h);
        sync.answers[0]!(true);
        await flush();
        expect(fake.state.reconnects).toEqual([]);
      });
    });
  });
});
