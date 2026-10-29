import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginStep,
} from "@pateat/contracts";
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
  sender,
  target,
  recipe,
  savedBinding,
  otherItemId,
  uriMatch,
  liveAccountPolicy,
  liveReview,
  excludingLive,
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
  const branchRecipe = parseLoginRecipe({
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
  const branchBinding: SavedLoginBinding = {
    ...savedBinding,
    slots: [
      { slot: "branch", field: { custom: "Branch" } },
      { slot: "password", field: "password" },
    ],
  };
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

      void { ...recipe, rejection: target("rejected") };

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
        it("fills another tab of the origin once too, asking why", async () => {
          const report = vi.fn<(entry: LoginReport) => void>();
          rejected();
          const h = matched(report);
          fake.state.tabUrls[2] = fake.state.pageUrl;
          await filledOnly(h, { tab: { id: 2 }, documentId: "other-tab" });
          expect(
            await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
          ).toMatchObject({ ask: "rejected-elsewhere", rejectedElsewhere: true });
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ type: "start", tabId: 2, fillOnly: true }),
          );
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "refused",
              tabId: 2,
              reason: "account-asked",
              detail: "rejected-elsewhere",
            }),
          );
        });
        it("never clicks the account switch while it only fills, and asks", async () => {
          rejected();
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), username: true },
          );
          h.recipes.recipe.mockResolvedValue(
            parseLoginRecipe({
              ...recipe,
              accountSwitch: { by: "text", value: "Use another account" },
            }),
          );
          // The login page shows another account than the one to fill.
          fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(1));
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          const sent = fake.state.messages.filter((entry) => entry.type === "login.execute");
          expect(sent.at(-1)!.accountSwitch).toBeUndefined();
          expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.switch");
          // The fill-only record is forgotten and the tab asks.
          expect(attempts()).toEqual([]);
          expect(fake.state.badges[1]?.text).toBe("2");
        });
        it("times a login picked after a fill-only one from where that one started", async () => {
          rejected();
          const h = matched();
          // The signed-out page is seen at once, and its form shows a minute later.
          await h.hello({ documentId: "signed-out" }, false);
          vi.useFakeTimers({ toFake: ["Date"] });
          onTestFinished(() => void vi.useRealTimers());
          const formShown = Date.now() + 60_000;
          vi.setSystemTime(formShown);
          await filledOnly(h, { documentId: "signed-out" });
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          vi.setSystemTime(formShown + 30_000);
          expect(await pick(h, { documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          // The fill-only login took the page's time before it; the picked one counts from
          // the fill-only login's start, with the time the choice waited as the person's.
          const [record] = attempts();
          expect(record!.timing.since).toBe(formShown);
          // About 30 s: each check of `vi.waitFor` moves the faked clock on by 50 ms.
          expect(record!.timing.personMs).toBeGreaterThan(29_000);
        });
        it("fills again after a reload or a worker restart and keeps asking", async () => {
          rejected();
          await filledOnly(matched(), { documentId: "signed-out" });
          const restarted = matched();
          // The document that was filled is not filled again by a restarted worker.
          expect(await restarted.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "account-asked",
          });
          expect(restarted.fields).not.toHaveBeenCalled();
          await filledOnly(restarted, { documentId: "reloaded" });
          expect(restarted.fields).toHaveBeenCalledTimes(1);
          expect(rejectedAsks()).toEqual([{ tabId: 1, origin }]);
          // Nothing was ever clicked while the tab asked.
          expect(steps().map((step) => step.kind)).toEqual(["fill", "fill"]);
        });
        it("forgets a fill-only record a stopped worker left ended", async () => {
          const h = matched();
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          const [done] = attempts();
          // As a worker that stopped after ending the fill, before forgetting it, leaves it.
          fake.state.storage["pateat.login-attempts.v5"] = [
            { ...done, fillOnly: true, state: "blocked", outcome: "cancelled" },
          ];
          rejected();
          const restarted = matched();
          await filledOnly(restarted, { documentId: "reloaded" });
          expect(attempts()).toEqual([]);
        });
        it("does not hold the site for other tabs while a tab only fills", async () => {
          // This tab's login stopped after a submission: only this tab asks.
          fake.state.session["pateat.login-stopped-asks.v1"] = [{ tabId: 1, origin }];
          const h = matched();
          // The fill never answers, so it stays running.
          fake.state.onExecute = () => new Promise(() => undefined);
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(1));
          expect(attempts()).toMatchObject([{ fillOnly: true }]);
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(2));
          expect(steps().map((step) => step.kind)).toEqual(["fill", "fill"]);
          expect(attempts()[1]).not.toHaveProperty("fillOnly");
        });
        it("asks without filling when several accounts match and none is the default", async () => {
          rejected();
          const h = harness(unsaved, {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: both }),
          });
          expect(await h.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "account-asked",
          });
          expect(steps()).toEqual([]);
          expect(h.fields).not.toHaveBeenCalled();
        });
        it("logs a page generated as a verification after the login as such, never as a logout (ADR 0035)", async () => {
          const report = vi.fn<(report: LoginReport) => void>();
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), report },
          );
          const confirm = parseLoginRecipe({
            ...recipe,
            id: "gen-confirm",
            pageKind: "confirm",
            steps: recipe.steps.map((step) => ({ ...step, path: "/verify" })),
          });
          h.recipes.routes.mockResolvedValue([recipe, confirm]);
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          const executed = fake.state.messages.filter((entry) => entry.type === "login.execute");
          fake.state.pageUrl = `${origin}/verify`;
          // The page announces its first step ready, as one that read the origin's starts
          // before its recipe was generated again as `confirm` would: a logout before.
          // The reply names the page's first step, so the document reports it shown at once.
          const confirming = {
            path: "/verify",
            require: "writable",
            targets: [target("password")],
          };
          expect(await h.hello({ documentId: "verify" })).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
            confirm: confirming,
          });
          expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }));
          expect(attempts()).toMatchObject([{ state: "authenticated" }]);
          expect(await shownHello(h, { documentId: "verify" })).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
            confirm: confirming,
          });
          // It logs what the page showed, never a value: the recipes' signed-in marker (E1),
          // and the tab's previous page of the origin, where the action was chosen.
          const refusals = () =>
            report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
          await vi.waitFor(() =>
            expect(refusals()).toEqual([
              {
                type: "refused",
                tabId: 1,
                origin,
                reason: "not-started",
                detail: "confirm-unsupported",
                recipeId: "gen-confirm",
                recipeRevision: confirm.revision,
                pageKind: "confirm",
                e1: true,
                e2: false,
                previousUrl: `${origin}/signin`,
              },
            ]),
          );
          // Nothing is filled, and the login stays signed in.
          expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual(
            executed,
          );
          expect(attempts()).toMatchObject([{ state: "authenticated" }]);
          // The tab leaves the page without the person's submit. E1 showed there, so the
          // next page is not read for it.
          fake.state.pageUrl = `${origin}/home`;
          await h.hello({ documentId: "home" }, false);
          await vi.waitFor(() =>
            expect(
              report.mock.calls
                .map(([entry]) => entry)
                .filter((entry) => entry.type === "confirm-left"),
            ).toEqual([
              {
                type: "confirm-left",
                tabId: 1,
                origin,
                recipeId: "gen-confirm",
                recipeRevision: confirm.revision,
                pageKind: "confirm",
                personSubmitted: false,
              },
            ]),
          );
        });
      });
    });
    it("needs a manual binding when the recipe has a slot other than the built-ins", async () => {
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
      });
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: false, reason: "binding-not-found" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("does not choose while the vault account is unknown", async () => {
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
      });
      h.snapshot.userId = undefined;
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
  });
  describe("with a saved account choice and a synced binding", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    it("uses no vault item before the first settings sync since pairing", async () => {
      const h = harness({}, { settingsSyncPending: true });
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("refuses an item whose custom fields changed since their review", async () => {
      const h = harness({
        bindings: [branchBinding],
        ...excludingLive(["login.totp", { custom: "Branch", position: 1, count: 1 }]),
        customFieldReviews: [
          { ...liveReview(), evidence: `bitwarden-v1:sha256:${"b".repeat(64)}` },
        ],
      });
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: false, reason: "review-required" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("refuses an account whose user ID has synced policy on another server", async () => {
      const h = harness({
        accountPolicies: [
          liveAccountPolicy(),
          liveAccountPolicy({ server: "https://vault.example.test", enabled: false }),
        ],
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("fills a custom field through the synced binding's field name", async () => {
      const h = harness({ bindings: [branchBinding] });
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
      expect(h.fields.mock.calls.map((call) => call[0].fieldId)).toEqual([
        `custom.${snapshotId}.0`,
        "login.password",
      ]);
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it.each<[string, "text" | "hidden" | "linked", Record<string, string>]>([
      ["text", "text", {}],
      ["Hidden", "hidden", { secret: "hidden" }],
      ["Linked to the password", "linked", { secret: "password" }],
    ])("marks a %s custom field's value for its input rule", async (_name, kind, secret) => {
      const h = harness(
        { bindings: [branchBinding] },
        {
          custom: [
            {
              name: "Branch",
              kind,
              ...(kind === "linked" ? { linkedFieldId: "login.password" } : {}),
            },
          ],
        },
      );
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      expect(executes()[0]!.values).toEqual([
        { slot: "branch", value: "synthetic-secret", ...secret },
        { slot: "password", value: "synthetic-secret", secret: "password" },
      ]);
    });
    it.each<[string, Parameters<typeof harness>[1], boolean]>([
      ["a text custom field", { username: true, custom: [{ name: "Branch", kind: "text" }] }, true],
      [
        "a custom field Linked to the username",
        {
          username: true,
          custom: [{ name: "Branch", kind: "linked", linkedFieldId: "login.username" }],
        },
        false,
      ],
    ])(
      "compares the page on a password step with %s only when it fills no username",
      async (_name, live, compared) => {
        const h = harness({ bindings: [branchBinding] }, live);
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).not.toEqual([]));
        expect(executes()[0]!.account).toEqual(
          compared ? { username: "my2@example.com" } : undefined,
        );
      },
    );
    it.each<[string, Parameters<typeof harness>[1], Partial<LocalSettings>, string]>([
      [
        "two custom fields share the bound name",
        {
          custom: [
            { name: "Branch", kind: "text" },
            { name: "Branch", kind: "text" },
          ],
        },
        {},
        "field-ambiguous",
      ],
      [
        "no custom field has the bound name",
        { custom: [{ name: "Region", kind: "text" }] },
        {},
        "field-missing",
      ],
      [
        "the bound custom field is excluded",
        {},
        excludingLive([{ custom: "Branch", position: 1, count: 1 }]),
        "binding-field-excluded",
      ],
      [
        "the bound custom field holds a TOTP key (owner, 2026-10-23)",
        { custom: [{ name: "Branch", kind: "text", totpSeed: true }] },
        {},
        "totp-field-mismatch",
      ],
    ])(
      "refuses a synced binding before any field read when %s",
      async (_name, live, overrides, reason) => {
        const h = harness({ bindings: [branchBinding], ...overrides }, live);
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        expect(await h.hello()).toEqual({ ok: false, reason });
        expect(h.fields).not.toHaveBeenCalled();
        expect(executes()).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      },
    );
    it("uses a binding saved for another vault account only as a template", async () => {
      const other = { ...branchBinding, userId: "70000000-0000-4000-8000-000000000002" };
      // The template's field name must resolve on this item (ADR 0027).
      const missing = harness(
        { bindings: [other] },
        { custom: [{ name: "Region", kind: "text" }] },
      );
      missing.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await missing.hello()).toEqual({ ok: false, reason: "field-missing" });
      expect(missing.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(missing.store.update).not.toHaveBeenCalled();
    });
  });
  it.each([
    ["the same recipe revision resumes", 1, { ok: true }],
    ["a replaced recipe revision is refused", 2, { ok: false, reason: "recipe-not-found" }],
  ])("after navigation, %s", async (_name, revision, expected) => {
    // The submit never answers, so the attempt is still running when the page changes.
    fake.state.onExecute = (message) =>
      (message["operation"] as { step: { kind: string } }).step.kind === "click"
        ? new Promise(() => undefined)
        : Promise.resolve();
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    // A replacement changes the route's steps, so it never extends the running revision.
    h.recipes.recipe.mockResolvedValue(
      revision === recipe.revision ? recipe : { ...recipe, revision, maxSubmissions: 2 },
    );
    expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual(expected);
    expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/signin", recipe.id, undefined);
  });
  it("starts no login on a recipe the sync its lookup started removed", async () => {
    // The lookup answered from the cache; the sync it started then revoked the recipe.
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    h.recipes.withdrawn.mockResolvedValue(true);
    expect(await h.hello()).toEqual({ ok: false, reason: "recipe-not-found" });
    expect(h.recipes.withdrawn).toHaveBeenCalledWith(origin, recipe.id, undefined);
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }));
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "refused", reason: "recipe-not-found", detail: "withdrawn" }),
    );
  });
  describe("a submitted login its recipe no longer runs", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const record = () =>
      (
        fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined
      )?.[0];
    const clicked = async (report: (report: LoginReport) => void) => {
      fake.state.onExecute = (message) =>
        (message["operation"] as { step: { kind: string } }).step.kind === "click"
          ? new Promise(() => undefined)
          : Promise.resolve();
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      return h;
    };
    it.each([
      [
        "its revision was replaced",
        (h: ReturnType<typeof harness>) =>
          h.recipes.recipe.mockResolvedValue({ ...recipe, revision: 2, maxSubmissions: 2 }),
      ],
      [
        "it was withdrawn",
        (h: ReturnType<typeof harness>) => {
          h.recipes.recipe.mockResolvedValue(undefined);
          h.recipes.withdrawn.mockResolvedValue(true);
        },
      ],
    ])("ends when %s, so its tab asks again after the hold", async (_name, change) => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = await clicked(report);
      const id = record()?.["id"];
      change(h);
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(record()).toMatchObject({ id, state: "blocked", outcome: "policy-changed" });
      expect(await h.login.active()).toBe(false);
      expect(
        report.mock.calls
          .map(([entry]) => entry)
          .filter((entry) => entry.type === "attempt")
          .at(-1),
      ).toMatchObject({ state: "blocked", outcome: "policy-changed", cause: "recipe-changed" });
      // The refused page itself is never filled, also when it announces again.
      expect(await h.hello({ documentId: "synthetic-document-2" })).toMatchObject({ ok: false });
      expect(executes()).toHaveLength(2);
      // The click may have reached the site, so the login holds it for 5 minutes (ADR 0022,
      // owner 2026-10-24); after that, the tab's next page that shows the first step asks
      // and only fills (ADR 0062).
      h.recipes.recipe.mockResolvedValue(recipe);
      h.recipes.withdrawn.mockResolvedValue(false);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now + 6 * 60_000);
      try {
        expect(await h.hello({ documentId: "synthetic-document-3" })).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(3));
        expect(
          (executes()[2] as unknown as { operation: { step: LoginStep } }).operation.step.kind,
        ).toBe("fill");
        await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
      } finally {
        clock.mockRestore();
      }
    });
    it("releases its tab after the hold when its recipe stays withdrawn", async () => {
      // Duolingo, 2026-10-25: with the recipe revoked, its first step never showed again,
      // so every later page of the tab was answered `login-stopped` and never offered for
      // generation.
      const h = await clicked(vi.fn());
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.withdrawn.mockResolvedValue(true);
      h.recipes.starts.mockResolvedValue([]);
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(record()).toMatchObject({ state: "blocked", outcome: "policy-changed" });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now + 6 * 60_000);
      try {
        // The page shows no first step: none is left to show.
        expect(await h.hello({ documentId: "synthetic-document-3" }, false)).toEqual({
          ok: false,
          reason: "recipe-not-found",
        });
        expect(record()).toBeUndefined();
        expect(h.recipes.withdrawn).toHaveBeenLastCalledWith(origin, recipe.id);
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(executes()).toHaveLength(2);
      } finally {
        clock.mockRestore();
      }
    });
    it("stays resumable when the recipes could not be read (owner, 2026-10-23)", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = await clicked(report);
      const before = record();
      h.recipes.recipe.mockResolvedValue(undefined);
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(h.recipes.withdrawn).toHaveBeenLastCalledWith(origin, recipe.id, undefined);
      expect(record()).toMatchObject({ id: before?.["id"], state: before?.["state"] });
      expect(record()?.["outcome"]).toBeUndefined();
      expect(await h.login.active()).toBe(true);
      expect(report).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "attempt", cause: "recipe-changed" }),
      );
    });
  });
  describe("a recipe with several layouts (ADR 0060)", () => {
    const older = parseLoginRecipe({ ...recipe, layout: "1000" });
    const newer = parseLoginRecipe({
      ...recipe,
      layout: "2000",
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("passcode") }],
        },
        { kind: "click", path: "/signin", target: target("continue"), purpose: "submit" },
      ],
    });
    const executes = () =>
      fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
        operation: { step: { kind: string; fields?: { target: unknown }[]; target?: unknown } };
      }[];
    const filled = () => executes()[0]?.operation.step.fields?.[0]?.target;
    const withLayouts = (
      h: ReturnType<typeof harness>,
      layouts: { recipe: typeof recipe; language?: "ja" | "en"; createdAt: number }[],
    ) => {
      const listed = vi.fn(async (at: string, path: string) =>
        at === origin && path === "/signin" ? layouts : [],
      );
      const of = vi.fn(async () => layouts.map((entry) => entry.recipe));
      Object.assign(h.recipes, { layouts: listed, layoutsOf: of });
      // By ID the cache answers the newest layout, or the one asked for.
      h.recipes.recipe.mockImplementation(
        async (at: string, path: string, _id?: string, layout?: string) =>
          at === origin && path === "/signin"
            ? (layouts.find((entry) => entry.recipe.layout === layout)?.recipe ??
              layouts.at(-1)!.recipe)
            : undefined,
      );
      return { listed, of };
    };
    const helloIn = (h: ReturnType<typeof harness>, language?: "ja" | "en") => {
      if (language)
        fake.state.extracted["login"] = {
          ok: true,
          observation: { version: 1, origin, path: "/signin", language, complete: true },
        };
      return h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          start: { path: "/signin" },
        },
        sender(),
      );
    };
    const extracts = () => fake.state.messages.filter((entry) => entry.type === "login.extract");
    it("runs the layout whose start elements show most, records it and keeps it on resume", async () => {
      fake.state.onExecute = (message) =>
        (message["operation"] as { step: { kind: string } }).step.kind === "click"
          ? new Promise(() => undefined)
          : Promise.resolve();
      fake.state.present = new Set(["password", "login"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      const { listed } = withLayouts(h, [
        { recipe: older, createdAt: 1000 },
        { recipe: newer, createdAt: 2000 },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      // The older layout's form shows and the newer one's does not, so the older runs.
      expect(filled()).toEqual(target("password"));
      // Every layout's start elements are read as shown in one observation.
      const counted = fake.state.messages.filter(
        (entry) =>
          entry.type === "login.observe" && entry.require?.every((value) => value === "shown"),
      );
      expect(counted.map((entry) => entry.targets)).toEqual([
        [target("password"), target("login"), target("passcode"), target("continue")],
      ]);
      // One layout fits, so the page's language is never read.
      expect(extracts()).toEqual([]);
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([{ layout: "1000" }]);
      expect(
        report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "start"),
      ).toMatchObject({ layout: "1000", layouts: 2 });
      // The next document of the login resumes the same layout, which is not chosen again.
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({ ok: true });
      expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/signin", recipe.id, "1000");
      expect(listed).toHaveBeenCalledTimes(1);
    });
    it("stops a resumed login whose layout was removed, never running another", async () => {
      fake.state.onExecute = (message) =>
        (message["operation"] as { step: { kind: string } }).step.kind === "click"
          ? new Promise(() => undefined)
          : Promise.resolve();
      fake.state.present = new Set(["password", "login"]);
      const h = harness();
      withLayouts(h, [
        { recipe: older, createdAt: 1000 },
        { recipe: newer, createdAt: 2000 },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([{ layout: "1000" }]);
      // The owner removed layout 1000 meanwhile: its revision 2 holds layout 2000 alone.
      const removed = { ...newer, revision: 2 };
      h.recipes.recipe.mockImplementation(
        async (_at: string, _path: string, _id?: string, layout?: string) =>
          layout === undefined || layout === "2000" ? removed : undefined,
      );
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/signin", recipe.id, "1000");
      // Even a lookup that answered another layout would not take the login over.
      h.recipes.recipe.mockResolvedValue(removed);
      expect(await h.hello({ documentId: "synthetic-document-3" })).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(executes()).toHaveLength(2);
    });
    it("takes over a newer revision in which only another layout changed", async () => {
      fake.state.onExecute = (message) =>
        (message["operation"] as { step: { kind: string } }).step.kind === "click"
          ? new Promise(() => undefined)
          : Promise.resolve();
      fake.state.present = new Set(["password", "login"]);
      const h = harness();
      withLayouts(h, [
        { recipe: older, createdAt: 1000 },
        { recipe: newer, createdAt: 2000 },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      // Revision 2 changed layout 2000 only, so layout 1000's projection is the same.
      const atTwo = { ...older, revision: 2 };
      h.recipes.recipe.mockImplementation(
        async (_at: string, _path: string, _id?: string, layout?: string) =>
          layout === "1000" ? atTwo : { ...newer, revision: 2, maxSubmissions: 2 },
      );
      expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({ ok: true });
      expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/signin", recipe.id, "1000");
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { layout: "1000", recipeRevision: 2 },
      ]);
    });
    it("takes the layout in the page's language when both show whole", async () => {
      fake.state.present = new Set(["password", "login", "passcode", "continue"]);
      const h = harness();
      withLayouts(h, [
        { recipe: older, language: "ja", createdAt: 1000 },
        { recipe: newer, language: "en", createdAt: 2000 },
      ]);
      expect(await helloIn(h, "ja")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      expect(filled()).toEqual(target("password"));
      // The language is read from the page's description, as the layouts' was.
      expect(extracts()).toMatchObject([{ page: "login" }]);
    });
    it("takes the newest layout when nothing else tells them apart", async () => {
      fake.state.present = new Set(["password", "login", "passcode", "continue"]);
      const h = harness();
      withLayouts(h, [
        { recipe: older, language: "ja", createdAt: 1000 },
        { recipe: newer, language: "ja", createdAt: 2000 },
      ]);
      expect(await helloIn(h, "en")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      expect(filled()).toEqual(target("passcode"));
      // Both are of one language, so the page's is never read.
      expect(extracts()).toEqual([]);
    });
  });
});
