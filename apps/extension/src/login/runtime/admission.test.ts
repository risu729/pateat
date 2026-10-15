import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as v from "valibot";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type LoginEntryRecipe,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import { vaultFailure } from "../../vault/record";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import { acceptsSecret, type SecretInput } from "../inputs";
import { statusResponseSchema } from "../choice-wire";
import { createLoginBadge, memoryBadgeStorage } from "../badge";
import type { GenerationOutcome, LoginGeneration } from "./recipes";
import type { LoginReport } from "./reports";
import {
  connectionId,
  harness,
  itemId,
  origin,
  otherItemId,
  recipe,
  savedBinding,
  sender,
  shownHello,
  snapshotId,
  startsOf,
  target,
  trusted,
  uriMatch,
  userId,
} from "./__fixtures__/harness";

const { fake } = await vi.hoisted(() => import("./__fixtures__/browser"));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));

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
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
  });
  it("completes a saved-default HTTPS login with a local recipe and live field", async () => {
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    expect(h.fields).toHaveBeenCalledTimes(1);
    // The saved default and binding are already stored, so nothing is written back.
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.observe")).not.toEqual([]),
    );
    expect(h.store.update).not.toHaveBeenCalled();
    // The content script fills a Bitwarden password only into a password input.
    expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.values).toEqual([
      { slot: "password", value: "synthetic-secret", secret: "password" },
    ]);
    expect(h.fields.mock.calls[0]![0]).toMatchObject({
      account: { origin, connectionId, itemId },
      fieldId: "login.password",
    });
    // An item without a username never asks the page to compare the shown account.
    expect(
      fake.state.messages.filter((entry) => entry.type === "login.execute" && entry.account),
    ).toEqual([]);
  });
  it("sends the username with a password-only fill and stops on a wrong displayed account", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account" };
    const h = harness({}, { username: true });
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "blocked", outcome: "wrong-account", submissions: 0, retries: 0 },
      ]),
    );
    const executes = fake.state.messages.filter((entry) => entry.type === "login.execute");
    // The fill is refused once and never retried; the click never runs.
    expect(executes).toHaveLength(1);
    expect(executes[0]!.account).toEqual({ username: "my2@example.com" });
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
      "login.password",
      "login.username",
    ]);
  });
  it("clicks the recipe's account switch only after recording it, then starts afresh once", async () => {
    const accountSwitch = { by: "text", value: "Use another account" } as const;
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    const h = harness({}, { username: true });
    h.recipes.recipe.mockResolvedValue(parseLoginRecipe({ ...recipe, accountSwitch }));
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const attempts = () => fake.state.storage["pateat.login-attempts.v4"];
    const types = () => fake.state.messages.map((entry) => entry.type);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(types()).toContain("login.switch"));
    expect(attempts()).toMatchObject([
      { state: "blocked", outcome: "account-switched", submissions: 0 },
    ]);
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(executes()[0]!.accountSwitch).toEqual(accountSwitch);
    // The switch is stored and published before the page is asked to click it.
    expect(
      fake.state.messages.findIndex((entry) => entry.outcome === "account-switched"),
    ).toBeLessThan(types().indexOf("login.switch"));
    // The page it leads to starts a new attempt, which never switches again.
    expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        { state: "blocked", outcome: "wrong-account", accountSwitched: true },
      ]),
    );
    expect(executes()).toHaveLength(2);
    expect(executes()[1]!.accountSwitch).toBeUndefined();
    expect(types().filter((type) => type === "login.switch")).toHaveLength(1);
  });
  it("ends as wrong-account and keeps the tab when the page does not click the switch", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    fake.state.switchReply = { ok: false };
    const h = harness({}, { username: true });
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({ ...recipe, accountSwitch: { by: "text", value: "Use another account" } }),
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "blocked", outcome: "wrong-account", submissions: 0 },
      ]),
    );
    expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch");
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "wrong-account" });
    // The next document of the tab does not start another attempt.
    await h.hello({ documentId: "next-page" });
    expect(executes()).toHaveLength(1);
  });
  it("stops without a retry or a click when a value does not fit its input", async () => {
    fake.state.executeReply = { ok: false, reason: "value-mismatch" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "blocked", outcome: "value-mismatch", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "value-mismatch" });
  });
  it.each(["target-missing", "form-changed"] as const)(
    "logs the page's reason when a step fails with %s",
    async (detail) => {
      fake.state.executeReply = { ok: false, reason: "structural-mismatch", detail };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "attempt", cause: detail }),
        ),
      );
    },
  );
  describe("telling of a login that signed in (ADR 0007)", () => {
    const attempts = () =>
      (fake.state.storage["pateat.login-attempts.v4"] ?? []) as { state: string }[];
    it("tells once when a login reaches signed in, and not again on the tab's next page", async () => {
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness({}, { signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
      expect(signedIn.mock.calls).toEqual([[1, origin]]);
      // The tab's next page of the site starts nothing and tells nothing.
      await h.hello({ documentId: "next-page" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(signedIn).toHaveBeenCalledOnce();
    });
    it.each([
      ["a wrong account", { ok: false, reason: "wrong-account" }],
      ["a value the page rejects", { ok: false, reason: "value-mismatch" }],
    ])("never tells of a login stopped by %s", async (_name, reply) => {
      fake.state.executeReply = reply;
      const states: string[] = [];
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness(
        {},
        {
          signedIn,
          report: (entry) => {
            if (entry.type === "attempt") states.push(entry.state);
          },
        },
      );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "blocked" }]));
      expect(states.length).toBeGreaterThan(1);
      expect(signedIn).not.toHaveBeenCalled();
    });
    it("never tells of a login whose completion is not seen", async () => {
      fake.state.observed = ["missing", "missing"];
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness({}, { signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          2,
        ),
      );
      // Wait for the observation budget to end without seeing the completion.
      await vi.waitFor(
        () =>
          expect(attempts()).toMatchObject([
            { state: "reconciling", outcome: "unknown-submit", settled: true },
          ]),
        { timeout: 6_000 },
      );
      expect(signedIn).not.toHaveBeenCalled();
    }, 10_000);
    it("completes the login when telling of it throws", async () => {
      const signedIn = vi.fn(() => {
        throw new Error("storage");
      });
      const h = harness({}, { signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
      expect(signedIn).toHaveBeenCalledOnce();
      expect(await h.login.active()).toBe(false);
    });
  });
  it("does not click when the page rejects the filled values", async () => {
    fake.state.executeReply = { ok: false, reason: "fill-rejected", mutation: "possible" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "blocked", outcome: "fill-rejected", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
  });
  it.each([
    ["an origin without a saved default", "https://other.example/signin"],
    ["a subdomain of the saved origin", "https://sub.login.example/signin"],
    ["a different port of the saved origin", "https://login.example:8443/signin"],
  ])("stops %s without a recipe before any policy or vault access", async (_name, url) => {
    fake.state.pageUrl = url;
    const h = harness();
    expect(await h.hello()).toEqual({ ok: false, reason: "recipe-not-found" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it.each([
    [
      "plain HTTP even with a saved HTTP default",
      "http://login.example/signin",
      {
        siteDefaults: [{ origin: "http://login.example", provider: "bitwarden", userId, itemId }],
      },
    ],
    [
      "an excluded site",
      "https://login.example/signin",
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
    ],
  ])("ignores %s before any policy, vault or page access", async (_name, url, overrides) => {
    fake.state.pageUrl = url;
    const h = harness(overrides as Partial<LocalSettings>);
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.recipes.recipe).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it.each([
    // Chrome withholds the tab's URL without host access to the tab's page.
    ["a frame whose tab URL is withheld", { frameId: 1 }],
    ["a sender without a document id", { documentId: undefined }],
  ])("ignores %s on a saved-default origin", async (_name, overrides) => {
    const h = harness();
    expect(await h.hello(overrides)).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it("never admits the loopback probe origin outside the probe build", async () => {
    fake.state.storage["pateat.login-probe-origin.v1"] = { origin: "http://127.0.0.1:3847" };
    fake.state.pageUrl = "http://127.0.0.1:3847/signin";
    const h = harness({ siteDefaults: [] });
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.recipes.recipe).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it("refuses a fill authorization once site access is withdrawn mid-attempt", async () => {
    const h = harness();
    const answers: unknown[] = [];
    fake.state.onExecute = async (message) => {
      const operation = message["operation"] as { attemptId: string; operationId: string };
      const authorize = () =>
        h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(),
        );
      answers.push(await authorize());
      fake.state.granted = false;
      answers.push(await authorize());
      fake.state.onExecute = undefined;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toEqual([true, false]);
  });
  const signinStart = {
    path: "/signin",
    require: "writable",
    targets: [{ by: "id", value: "password" }],
  };
  it("refuses an admitted page without a saved recipe and never reads the vault", async () => {
    fake.state.pageUrl = "https://login.example/elsewhere";
    const h = harness();
    // The origin has a recipe elsewhere, so the document watches for its first step.
    expect(await h.hello()).toEqual({
      ok: false,
      reason: "recipe-not-found",
      starts: [signinStart],
    });
    // The policy catalog (and with it every configured vault) is never opened.
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it("leaves a path where several recipes start out of the watch list", async () => {
    fake.state.pageUrl = "https://login.example/elsewhere";
    const h = harness();
    h.recipes.starts.mockResolvedValue(
      startsOf([
        recipe.steps[0]!,
        { ...recipe.steps[0]!, fields: [{ slot: "password", target: target("other") }] },
        { ...recipe.steps[0]!, path: "/other" },
      ] as never),
    );
    expect(await h.hello()).toEqual({
      ok: false,
      reason: "recipe-not-found",
      starts: [{ ...signinStart, path: "/other" }],
    });
  });
  it("starts only after the document reports the first step ready", async () => {
    const h = harness();
    expect(await h.hello({}, false)).toEqual({
      ok: false,
      reason: "form-not-ready",
      starts: [signinStart],
    });
    // A start reported for another path does not count for this one.
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          start: { path: "/elsewhere" },
        },
        sender(),
      ),
    ).toEqual({ ok: false, reason: "form-not-ready", starts: [signinStart] });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    // The same document announces again once its form appears.
    expect(await h.hello()).toEqual({ ok: true });
    // A document that already carries a running attempt cannot start another one.
    expect(await h.hello()).toEqual({ ok: false, reason: "duplicate-document" });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
  });
  it("logs once when a sign-in input shows but no login starts", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    const notStarted = () =>
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
    // Without a shown sign-in input, watching is not logged.
    expect(await h.hello({}, false)).toMatchObject({ reason: "form-not-ready" });
    expect(notStarted()).toEqual([]);
    // The recipe starts on this path, but its first step's elements were not found.
    const watching = { ok: false, reason: "form-not-ready", starts: [signinStart] };
    expect(await shownHello(h)).toEqual(watching);
    // The same document reporting again is not logged again.
    expect(await shownHello(h)).toEqual(watching);
    expect(notStarted()).toEqual([
      {
        type: "refused",
        tabId: 1,
        origin,
        reason: "not-started",
        detail: "first-step-missing",
      },
    ]);
    // No recipe of the origin starts on this path.
    h.recipes.recipe.mockResolvedValue(undefined);
    expect(await shownHello(h, { documentId: "elsewhere" })).toMatchObject({
      reason: "recipe-not-found",
    });
    expect(notStarted().at(-1)).toMatchObject({
      reason: "not-started",
      detail: "no-recipe-on-path",
    });
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("does not log a sign-in input on an origin without a recipe", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.starts.mockResolvedValue([]);
    expect(await shownHello(h)).toEqual({ ok: false, reason: "recipe-not-found" });
    // Ordinary browsing: logged only while debug logging is on.
    expect(report.mock.calls.map(([entry]) => entry)).toEqual([
      { type: "refused", tabId: 1, origin, reason: "recipe-not-found", unrelated: true },
    ]);
  });
  it.each([
    [
      "an excluded site",
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      "site-excluded",
    ],
    ["a site whose access the user withheld", undefined, "no-site-access"],
  ])("logs why the page of %s with a recipe is not admitted", async (_name, overrides, reason) => {
    const report = vi.fn<(report: LoginReport) => void>();
    if (!overrides) fake.state.granted = false;
    const h = harness((overrides ?? {}) as Partial<LocalSettings>, { report });
    const refusals = () => report.mock.calls.map(([entry]) => entry);
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    // The same page again is a repeat.
    expect(await h.hello({}, false)).toEqual({ ok: false, reason: "unauthorized-document" });
    // A frame is not the tab's page, and an origin without a recipe is ordinary browsing.
    expect(await h.hello({ frameId: 1 })).toEqual({ ok: false, reason: "unauthorized-document" });
    h.recipes.starts.mockResolvedValue([]);
    expect(await h.hello({ documentId: "other" })).toEqual({
      ok: false,
      reason: "unauthorized-document",
    });
    expect(refusals()).toEqual([
      { type: "refused", tabId: 1, origin, reason },
      { type: "refused", tabId: 1, origin, reason, repeat: true },
    ]);
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.recipes.recipe).not.toHaveBeenCalled();
  });
  it("logs a page that gave up starting after its tries were stale", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    // The tab moved on while the document's settings were read.
    fake.state.tabUrls[1] = "https://elsewhere.example/";
    for (let tries = 0; tries < 4; tries += 1)
      // eslint-disable-next-line no-await-in-loop
      expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
    expect(report.mock.calls.map(([entry]) => entry)).toEqual([
      { type: "refused", tabId: 1, origin, reason: "stale-document" },
      { type: "refused", tabId: 1, origin, reason: "stale-document", repeat: true },
      { type: "refused", tabId: 1, origin, reason: "stale-document", repeat: true },
      { type: "refused", tabId: 1, origin, reason: "stale-document", repeat: true },
      { type: "refused", tabId: 1, origin, reason: "stale-document", detail: "gave-up" },
    ]);
  });
  it("names the tab's page URL in its reports, but not a frame's", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    fake.state.pageUrl = "https://login.example/signin?next=%2Fhome#top";
    const h = harness({}, { report, urls: true });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry.type)).toContain("attempt"),
    );
    const reports = report.mock.calls.map(([entry]) => entry);
    expect(reports.find((entry) => entry.type === "start")?.url).toBe(fake.state.pageUrl);
    expect(reports.find((entry) => entry.type === "attempt")?.url).toBe(fake.state.pageUrl);
    report.mockClear();
    fake.state.tabUrls[1] = fake.state.pageUrl;
    expect(
      await h.hello({ frameId: 2, documentId: "frame", tab: { id: 1, url: fake.state.pageUrl } }),
    ).toEqual({ ok: false, reason: "tab-busy" });
    expect(
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused"),
    ).toEqual([{ type: "refused", tabId: 1, origin, reason: "tab-busy", frame: true }]);
  });
  it("logs the same refusal on the same page once, and again on a new page", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({ siteDefaults: [] }, { report });
    const first = await h.hello();
    expect(first).toMatchObject({ ok: false });
    expect(await h.hello()).toEqual(first);
    expect(await h.hello({ documentId: "next-page" })).toEqual(first);
    // A restarted worker reconnects every page: the same page again is still a repeat.
    const restarted = harness({ siteDefaults: [] }, { report });
    expect(await restarted.hello({ documentId: "next-page" })).toEqual(first);
    const { reason } = first as { reason: string };
    expect(
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused"),
    ).toEqual([
      expect.objectContaining({ reason }),
      expect.objectContaining({ reason, repeat: true }),
      expect.not.objectContaining({ repeat: true }),
      expect.objectContaining({ reason, repeat: true }),
    ]);
  });
  it("logs an exception that stops a login with its name and message", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    // The settings read before the next step fails once.
    fake.state.onExecute = async () => {
      fake.state.onExecute = undefined;
      h.store.handle.mockRejectedValueOnce(new SyntaxError("synthetic settings answer"));
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "exception" }),
      ),
    );
    expect(
      report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "exception"),
    ).toEqual({
      type: "exception",
      tabId: 1,
      origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      route: "password",
      state: expect.any(String),
      stepIndex: 1,
      name: "SyntaxError",
      message: "synthetic settings answer",
      stack: expect.any(String),
    });
  });
  it("logs only the type of a thrown value that is not an Error", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onExecute = async () => {
      fake.state.onExecute = undefined;
      h.store.handle.mockRejectedValueOnce("synthetic thrown text");
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "exception", name: "string" }),
      ),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("synthetic thrown text");
  });
  it("resumes a login whose submit replaced its document without logging an exception", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    const entries = () => report.mock.calls.map(([entry]) => entry);
    // The click submits the form, and the page navigates before the result is observed.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: LoginStep }).step.kind === "click")
        fake.state.gone.add("synthetic-document");
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "reconciling", stepIndex: 1 },
      ]),
    );
    expect(entries()).toContainEqual(
      expect.objectContaining({
        type: "attempt",
        state: "reconciling",
        cause: "document-gone",
        reason: "no-receiver",
      }),
    );
    // The page it led to proves the sign-in.
    expect(await h.hello({ documentId: "next-document" }, false)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "authenticated" },
      ]),
    );
    expect(entries().filter((entry) => entry.type === "exception")).toEqual([]);
  });
  it("refuses a different content script instance in an already announced document", async () => {
    const h = harness();
    expect(await h.hello({}, false)).toMatchObject({ reason: "form-not-ready" });
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "other-token",
          start: { path: "/signin" },
        },
        sender(),
      ),
    ).toEqual({ ok: false, reason: "duplicate-document" });
  });
  it("logs a document announcing again while it carries a login", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    expect(await h.hello()).toEqual({ ok: true });
    expect(await h.hello()).toEqual({ ok: false, reason: "duplicate-document" });
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual({
      type: "refused",
      tabId: 1,
      origin,
      reason: "duplicate-document",
    });
  });
  it("a policy change while waiting for elements stops before any intent or vault read", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onAwait = () => {
      h.settings.revision += 1;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "blocked", outcome: "policy-changed", usedOperationIds: [] },
      ]),
    );
    // The log names what withdrew the login.
    expect(report.mock.calls.at(-1)![0]).toMatchObject({
      type: "attempt",
      state: "blocked",
      outcome: "policy-changed",
      cause: "settings-revision",
    });
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it("names the plan's refusal when the vault is turned off while waiting for elements", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onAwait = () => {
      h.settings.settings.connections[0]!.enabled = false;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "blocked", outcome: "policy-changed", cause: "plan" }),
      ),
    );
    expect(report.mock.calls.at(-1)![0]).toMatchObject({ reason: "connection-disabled" });
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("retries twice, then stops before any vault read or page change when a step's elements never appear", async () => {
    fake.state.awaited = { ok: false, reason: "timeout" };
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        {
          state: "blocked",
          outcome: "retry-limit",
          retries: 2,
          submissions: 0,
          usedOperationIds: [],
        },
      ]),
    );
    // The first wait and one per retry, each from the same step.
    expect(fake.state.messages.filter((entry) => entry.type === "login.await")).toHaveLength(3);
    expect(
      report.mock.calls.map(([entry]) => (entry.type === "attempt" ? entry.state : entry.type)),
    ).toEqual([
      "start",
      "ready",
      "retryable",
      "ready",
      "retryable",
      "ready",
      "retryable",
      "blocked",
    ]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it("logs in when a retry finds the step's elements that the first wait did not", async () => {
    let waits = 0;
    fake.state.onAwait = () => {
      waits += 1;
      fake.state.awaited = waits === 1 ? { ok: false, reason: "timeout" } : { ok: true };
    };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "authenticated", retries: 1 },
      ]),
    );
    expect(h.fields).toHaveBeenCalled();
  });
  it("tries a fill again whose operation expired before it went to the page", async () => {
    // The first fill's operation expires while its authorization is read, as on a slow
    // worker: nothing reached the page, so it is no submission to observe.
    const now = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
    const set = fake.browser.storage.local.set;
    fake.browser.storage.local.set = async (values: Record<string, unknown>) => {
      const [record] = (values["pateat.login-attempts.v4"] ?? []) as Record<string, unknown>[];
      if (offset === 0 && record?.["state"] === "executing" && record["mutationIntent"])
        offset = 16_000;
      await set(values);
    };
    const report = vi.fn<(report: LoginReport) => void>();
    try {
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
          { state: "authenticated", retries: 1, submissions: 1 },
        ]),
      );
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "retryable",
          outcome: "timeout",
          cause: "operation-invalid",
        }),
      );
      expect(
        report.mock.calls.some(
          ([entry]) => entry.type === "attempt" && entry.state === "reconciling",
        ),
      ).toBe(false);
      // The expired operation never reached the page; only the retry's fill and click did.
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2);
    } finally {
      fake.browser.storage.local.set = set;
      clock.mockRestore();
    }
  });
  it("retries a retryable attempt that a restarted worker finds once its page shows the step", async () => {
    // A worker that stopped before retrying left the attempt waiting to be tried again.
    fake.state.awaited = { ok: false, reason: "timeout" };
    const first = harness();
    expect(await first.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
        { state: "blocked", outcome: "retry-limit" },
      ]),
    );
    const [record] = fake.state.storage["pateat.login-attempts.v4"] as Record<string, unknown>[];
    fake.state.storage["pateat.login-attempts.v4"] = [
      {
        ...record,
        state: "retryable",
        outcome: "structural-mismatch",
        retries: 1,
        retryRequired: true,
      },
    ];
    fake.state.awaited = { ok: true };
    // The new page still shows the login form; the click signs in.
    fake.state.present = new Set(["password", "login"]);
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: LoginStep }).step.kind === "click")
        fake.state.present = new Set(["authenticated"]);
    };
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    try {
      const restarted = harness();
      expect(await restarted.hello({ documentId: "after-restart" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
          { state: "authenticated", retries: 2 },
        ]),
      );
    } finally {
      fake.browser.tabs.query = query;
    }
  });
  describe("a login form inside a frame", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    // The tab shows the page around the frame; the frame's own URL is the login page.
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    it("never names the tab's page URL in the reports of a login in a same-site frame", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const signin = fake.state.pageUrl;
      const top = "https://login.example/elsewhere?next=1";
      fake.state.pageUrl = top;
      const h = harness({}, { report, urls: true });
      expect(await h.hello()).toMatchObject({ ok: false, reason: "recipe-not-found" });
      fake.state.pageUrl = signin;
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields).toHaveBeenCalledTimes(1);
      const reports = report.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.type !== "refused");
      expect(reports.map((entry) => entry.type)).toContain("attempt");
      expect(reports.filter((entry) => entry.url !== undefined)).toEqual([]);
    });
    it("logs in on another site's page only when both URLs match the item's URIs", async () => {
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello(framed("https://portal.example/account"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(uris.mock.calls.map((call) => call[1])).toEqual([
        "https://login.example/signin",
        "https://portal.example/account",
      ]);
    });
    it("refuses before any field read when only the frame's URL matches", async () => {
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({
          targetOrigin: new URL(url).origin,
          ...(new URL(url).origin === origin ? {} : { candidates: [] }),
        }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello(framed("https://evil.example/"))).toEqual({
        ok: false,
        reason: "frame-top-mismatch",
      });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("chooses an account only among items matching both URLs", async () => {
      // Without a saved default, the frame's URL matches two items but the tab's only one.
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({
          targetOrigin: new URL(url).origin,
          candidates:
            new URL(url).origin === origin
              ? [
                  { itemId, matches: [{ uriIndex: 0, match: 0 }] },
                  { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
                ]
              : [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
        }),
      }));
      const h = harness({ siteDefaults: [] }, { allowedOrigins: [], uris });
      expect(await h.hello(framed("https://portal.example/"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields.mock.calls[0]![0]).toMatchObject({ account: { itemId } });
    });
    it("tells of both the frame's and the tab page's origin once it signed in (ADR 0007)", async () => {
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }));
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = harness({}, { allowedOrigins: [], uris, signedIn });
      expect(await h.hello(framed("https://portal.example/account"))).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
          { state: "authenticated" },
        ]),
      );
      expect(signedIn.mock.calls.toSorted()).toEqual([
        [1, origin],
        [1, "https://portal.example"],
      ]);
    });
    it("ignores a frame on an excluded page before any policy or vault access", async () => {
      const h = harness({
        excludedSites: [{ hostname: "evil.example", includeSubdomains: false }],
      });
      expect(await h.hello(framed("https://evil.example/"))).toEqual({
        ok: false,
        reason: "unauthorized-document",
      });
      expect(h.store.handle).not.toHaveBeenCalled();
      expect(h.recipes.recipe).not.toHaveBeenCalled();
      expect(fake.state.messages).toEqual([]);
    });
    it("starts one attempt when the page and its frame announce at the same time", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const h = harness();
      const top = "https://login.example/signin";
      const answers = await Promise.all([
        h.hello({ documentId: "page-document", url: top }),
        h.hello(framed(top)),
      ]);
      expect(answers).toContainEqual({ ok: true });
      expect(answers).toContainEqual({ ok: false, reason: "tab-busy" });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      expect(fake.state.storage["pateat.login-attempts.v4"]).toHaveLength(1);
    });
    it("keeps one attempt per tab and lets only a new page end a frame's attempt", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      const top = "https://login.example/home";
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      // The page around the frame and another frame of it never take the attempt over.
      expect(await h.hello({ documentId: "page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(await h.hello(framed(top, { frameId: 5, documentId: "widget-document" }))).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      // A sign-in input reported only for the log does not log the hold again.
      expect(await shownHello(h, { documentId: "page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      // The log tells a refused frame from the tab's page.
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "refused" ? [[value.reason, value.frame]] : [],
        ),
      ).toEqual([
        ["tab-busy", undefined],
        ["tab-busy", true],
      ]);
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      // While the frame is still there, a new top document is its own page announcing.
      fake.state.gone = new Set(["page-document"]);
      expect(await h.hello({ documentId: "late-page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      // A new page in the tab ends the frame's attempt without a fill on the new page.
      fake.state.gone = new Set(["frame-document", "widget-document"]);
      fake.state.tabUrls[1] = "https://login.example/signin";
      await h.hello({ documentId: "next-page" });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
          { state: "blocked", outcome: "cancelled" },
        ]),
      );
      expect(executes()).toHaveLength(1);
    });
  });
  describe("a frame's attempt when the tab changes page", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    const stored = () =>
      fake.state.storage["pateat.login-attempts.v4"] as { state: string; outcome?: string }[];
    it("lets a new page's frame that announced first keep its document", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const h = harness();
      // The previous page of the tab, without a login form.
      fake.state.tabUrls[1] = "https://login.example/home";
      expect(
        await h.hello({ documentId: "home-document", url: "https://login.example/home" }),
      ).toMatchObject({ ok: false });
      // The next page's login frame announces and starts before its own page does.
      const top = "https://login.example/account";
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      fake.state.gone = new Set(["home-document"]);
      expect(await h.hello({ documentId: "account-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      expect(stored()).toMatchObject([{ state: "executing" }]);
    });
    it("ends the attempt when the tab moves to a page on another origin", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      const top = "https://portal.example/account";
      fake.state.tabUrls[1] = top;
      expect(await h.hello({ documentId: "portal-document", url: top })).toMatchObject({
        ok: false,
      });
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      // The login navigates the whole tab; the frame goes with the old page.
      fake.state.gone = new Set(["frame-document", "portal-document"]);
      fake.state.tabUrls[1] = "https://portal.example/dashboard";
      await h.hello({ documentId: "dashboard-document", url: "https://portal.example/dashboard" });
      expect(stored()).toMatchObject([{ state: "blocked", outcome: "cancelled" }]);
      expect(executes()).toHaveLength(1);
    });
    it("refuses an operation once the tab shows another site", async () => {
      let authorized: unknown;
      const h = harness();
      fake.state.onExecute = async (message) => {
        fake.state.tabUrls[1] = "https://elsewhere.example/";
        const operation = message["operation"] as { attemptId: string; operationId: string };
        authorized = await h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(framed("https://elsewhere.example/")),
        );
      };
      expect(await h.hello(framed("https://login.example/home"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(authorized).toBe(false));
    });
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
    const stored = () => (fake.state.storage["pateat.login-attempts.v4"] ?? []) as Stored[];
    const at = (from: string) => stored().find((entry) => entry.account.origin === from);
    /** Both origins have their own recipe, binding and saved default for the same item. */
    const twoSites = (live: Parameters<typeof harness>[1] = {}) => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", userId, itemId },
            { origin: second, provider: "bitwarden", userId, itemId },
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
    /** The tab's page is replaced by a new top-level document at `url`. */
    /** `start: false` is a page of the origin without the login form's first step. */
    const navigate = (
      h: ReturnType<typeof harness>,
      url: string,
      documentId: string,
      start = true,
    ) => {
      fake.state.tabUrls[1] = url;
      return h.hello({ documentId, url }, start);
    };
    /** Clicks on `from` never answer, as when the page leaves while submitting. */
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
    it("starts the next origin's login after an authenticated attempt in the tab", async () => {
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(executes()).toHaveLength(4);
      expect(h.fields.mock.calls.map(([request]) => request.account.origin)).toEqual([
        origin,
        second,
      ]);
      // The first origin's record is kept as it was.
      expect(at(origin)).toMatchObject({ state: "authenticated", document: { tabId: 1 } });
      expect(await h.login.active()).toBe(false);
    });
    it("tells of each origin's login in the tab as it signs in (ADR 0007)", async () => {
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      const h = twoSites({ signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      expect(signedIn.mock.calls).toEqual([[1, origin]]);
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(signedIn.mock.calls).toEqual([
        [1, origin],
        [1, second],
      ]);
    });
    it("tells nothing of a submitted login that left its origin", async () => {
      const signedIn = vi.fn<(tabId: number, origin: string) => void>();
      holdClicks(origin);
      const h = twoSites({ signedIn });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(
        await navigate(h, "https://elsewhere.example/home", "elsewhere-document"),
      ).toMatchObject({ ok: false });
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(signedIn).not.toHaveBeenCalled();
    });
    it("ends a submitted attempt as left-origin and lets the next origin log in", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent", submissions: 1 });
      expect(await h.login.active()).toBe(true);
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
        document: { tabId: 1, documentId: "synthetic-document" },
      });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(stored()).toHaveLength(2);
      // Nothing is left running, so a deferred policy write may proceed.
      expect(await h.login.active()).toBe(false);
      expect(executes().map((entry) => (entry as { operation?: unknown }).operation)).toEqual([
        expect.objectContaining({ document: expect.objectContaining({ origin }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin: second }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin: second }) }),
      ]);
    });
    /** A page of the second site whose login form is in a frame of the same origin. */
    const secondPage = `${second}/account`;
    const secondFrame = () => {
      fake.state.tabUrls[1] = secondPage;
      return h2frame;
    };
    const h2frame = {
      frameId: 3,
      documentId: "second-frame",
      url: secondUrl,
      tab: { id: 1, url: secondPage },
    };
    it("starts the next site's framed login after the tab's login ended on another site", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" }),
      );
      fake.state.executeReply = undefined;
      expect(await navigate(h, secondPage, "second-page", false)).toMatchObject({ ok: false });
      // The ended login of the site the tab left never holds the next site's frame.
      expect(await h.hello(secondFrame())).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" });
    });
    it("lets the next site log in after the tab's framed login on another site", async () => {
      const portal = "https://portal.example/account";
      const h = twoSites({ allowedOrigins: [origin, second, "https://portal.example"] });
      fake.state.tabUrls[1] = portal;
      expect(
        await h.hello({ frameId: 5, documentId: "portal-frame", tab: { id: 1, url: portal } }),
      ).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "authenticated",
          document: { frameId: 5 },
          pageOrigin: "https://portal.example",
        }),
      );
      // After a worker restart, the next site's page and its frame are not held either.
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = twoSites();
        expect(await restarted.login.active()).toBe(false);
        expect(await navigate(restarted, secondPage, "second-page", false)).toMatchObject({
          reason: "recipe-not-found",
        });
        expect(await restarted.hello(secondFrame())).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
        expect(at(origin)).toMatchObject({ state: "authenticated", document: { frameId: 5 } });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends the left site's login when the next site's frame announces before its page", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await h.hello(secondFrame())).toEqual({ ok: true });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
      });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(await h.login.active()).toBe(false);
    });
    it("still holds a frame of the same page while its login runs", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      // A frame of the second site's origin inside the first site's page is not another site.
      expect(await h.hello({ ...h2frame, tab: { id: 1, url: fake.state.pageUrl } })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
    });
    it("offers the next site's page for generation after the tab's login ended", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const available = vi.fn<LoginGeneration["available"]>(async () => true);
      const h = twoSites({
        uris: async (_connection, url) => ({
          ok: true,
          data: uriMatch({ targetOrigin: new URL(url).origin }),
        }),
        generation: {
          available,
          generate: vi.fn<LoginGeneration["generate"]>(),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge: vi.fn<LoginGeneration["judge"]>(),
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" }),
      );
      expect(
        await navigate(h, "https://elsewhere.example/login", "elsewhere-document", false),
      ).toEqual({ ok: false, reason: "recipe-not-found", starts: [], generate: true });
      expect(available).toHaveBeenCalledWith("https://elsewhere.example", "/login");
    });
    it("ends a submitted attempt when the next origin has no recipe", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, "https://elsewhere.example/home", "elsewhere-document")).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(stored()).toHaveLength(1);
      expect(await h.login.active()).toBe(false);
      expect(executes()).toHaveLength(2);
    });
    describe("after Pateat answered the site's passkey request (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      /** Submits on the site, then has the passkey bridge answer for `rpId` at `answerAt`. */
      const submitted = async (rpId = "login.example") => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, rpId);
        fake.state.signs = quiet;
        return h;
      };
      it("completes when the tab moves on to the passkey's site and its page is quiet", async () => {
        const h = await submitted();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        expect(executes()).toHaveLength(2);
      });
      it("waits until the new page has loaded", async () => {
        const h = await submitted();
        fake.state.loaded = false;
        setTimeout(() => (fake.state.loaded = true), 1_500);
        const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        // Two readings while loading, then two once loaded.
        expect(reads().length).toBeGreaterThanOrEqual(4);
      }, 10_000);
      /** A frame of the new page at https://www.login.example/home. */
      const homeFrame = {
        frameId: 3,
        documentId: "home-frame",
        url: "https://widgets.login.example/panel",
        tab: { id: 1, url: "https://www.login.example/home" },
      };
      it("leaves the move to the new top page when its frame announces first", async () => {
        const h = await submitted();
        fake.state.tabUrls[1] = homeFrame.tab.url;
        await h.hello(homeFrame, false);
        expect(at(origin)).toMatchObject({ state: "submit-intent" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("lets a frame that announces while the top page is read wait for it", async () => {
        const h = await submitted();
        const top = navigate(h, "https://www.login.example/home", "home-document", false);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await h.hello(homeFrame, false);
        expect(await top).not.toEqual({ ok: false, reason: "stale-document" });
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when the new page shows a password field", async () => {
        const h = await submitted();
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page still asks for a code", async () => {
        const h = await submitted();
        fake.state.signs = { ...quiet, code: true };
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page asks for a passkey again", async () => {
        const h = await submitted();
        // The new page's own request, as the bridge reports it before the page announces.
        h.login.passkeyRequested(1, "https://www.login.example");
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        // The login waits for the tab's next page, but the answer before that request no
        // longer counts.
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("reads the tab's next page when the first one went away before it was read", async () => {
        const h = await submitted();
        fake.state.gone = new Set(["redirect-document"]);
        expect(
          await navigate(h, "https://sso.login.example/redirect", "redirect-document", false),
        ).toEqual({ ok: false, reason: "stale-document" });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
      });
      it("ends left-origin when the next page comes more than 30 seconds after the answer", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        holdClicks(origin);
        const h = twoSites({ report });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, "login.example");
        fake.state.signs = quiet;
        fake.state.gone = new Set(["redirect-document"]);
        await navigate(h, "https://sso.login.example/redirect", "redirect-document", false);
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({
            type: "move",
            origin: "https://www.login.example",
            reason: "no-factor",
          }),
        );
      });
      it("ends left-origin on a host outside the passkey's RP ID", async () => {
        const h = await submitted("www.login.example");
        await navigate(h, "https://account.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("tells of the login's and the passkey site's origin once (ADR 0007)", async () => {
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        holdClicks(origin);
        const h = twoSites({ signedIn });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, "login.example");
        fake.state.signs = quiet;
        expect(signedIn).not.toHaveBeenCalled();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        expect(signedIn.mock.calls.toSorted()).toEqual([
          [1, origin],
          [1, "https://www.login.example"],
        ]);
        // Another page of the passkey's site tells nothing more.
        await navigate(h, "https://www.login.example/settings", "settings-document", false);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(signedIn).toHaveBeenCalledTimes(2);
      });
      it("tells nothing when the passkey site's page asks for a password again", async () => {
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        holdClicks(origin);
        const h = twoSites({ signedIn });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, "login.example");
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(signedIn).not.toHaveBeenCalled();
      });
      describe("on another site, as a second factor after the password (ADR 0022)", () => {
        const console = "https://console.elsewhere.example/home";
        it("completes when the page shows the account's username", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(executes()).toHaveLength(2);
        });
        it("checks the tab's next page when the first one went away before it was read", async () => {
          // Shaped like Oracle Cloud's sign-in (2026-10-13): a redirect through another
          // page that leaves before Pateat reads it, then the console.
          const report = vi.fn<(report: LoginReport) => void>();
          holdClicks(origin);
          const h = twoSites({ username: true, report });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          fake.state.gone = new Set(["callback-document"]);
          expect(
            await navigate(h, "https://www.elsewhere.example/callback", "callback-document", false),
          ).toEqual({ ok: false, reason: "stale-document" });
          expect(at(origin)).not.toMatchObject({ state: "blocked" });
          expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
            expect.objectContaining({
              type: "move",
              origin: "https://www.elsewhere.example",
              reason: "page-gone",
              kept: true,
            }),
          );
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        });
        it("logs why a move that ends left-origin did not complete", async () => {
          const report = vi.fn<(report: LoginReport) => void>();
          holdClicks(origin);
          const h = twoSites({ username: true, report });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, password: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
          expect(report.mock.calls.map(([entry]) => entry)).toContainEqual({
            type: "move",
            tabId: 1,
            origin: "https://console.elsewhere.example",
            recipeId: recipe.id,
            recipeRevision: recipe.revision,
            route: "password",
            reason: "sign-in-shown",
          });
        });
        it("ends left-origin when the page does not show it and no judge is paired", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 10_000);
        it("ends left-origin when the move comes more than 30 seconds after the answer", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          const now = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
          onTestFinished(() => clock.mockRestore());
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
        it("completes when the judge answers signed-in for the page", async () => {
          const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
            args[4]?.();
            return { verdict: "signed-in" };
          });
          holdClicks(origin);
          const h = twoSites({
            username: true,
            generation: {
              available: vi.fn<LoginGeneration["available"]>(async () => true),
              generate: vi.fn<LoginGeneration["generate"]>(),
              generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
              judge,
              slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
            },
          });
          const consoleHome = {
            ok: true,
            observation: {
              version: 1,
              origin: "https://console.elsewhere.example",
              path: "/home",
              language: "en",
              complete: true,
              candidates: [
                { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
              ],
            },
          };
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = quiet;
          fake.state.extracted = { "signed-in": consoleHome };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(judge).toHaveBeenCalledTimes(1);
          expect(judge.mock.calls[0]![3]).toEqual(consoleHome.observation);
          expect(executes()).toHaveLength(2);
        }, 15_000);
        it("ends left-origin when the answer came before the submission", async () => {
          holdClicks(origin);
          const h = twoSites({ username: true });
          h.login.passkeyAnswered(1, origin, "login.example");
          await new Promise((resolve) => setTimeout(resolve, 5));
          fake.state.signs = { ...quiet, username: true };
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
        it("ends left-origin when the password was filled but not submitted", async () => {
          // The password goes in with the identifier, but the click only advances, and the
          // site answers with a passkey as the sign-in itself.
          const advancing = parseLoginRecipe({
            ...recipe,
            steps: [
              recipe.steps[0]!,
              { kind: "click", path: "/signin", target: target("login"), purpose: "advance" },
            ],
          });
          holdClicks(origin);
          const h = twoSites({ username: true });
          h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
            from === origin && path === "/signin" ? advancing : undefined,
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
        it("ends left-origin when no password was sent before the answer", async () => {
          // An identifier step, then the passkey: the passkey is the sign-in itself.
          const identifier = parseLoginRecipe({
            ...recipe,
            slots: ["username"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [{ slot: "username", target: target("password") }],
              },
              { kind: "click", path: "/signin", target: target("login"), purpose: "advance" },
            ],
          });
          holdClicks(origin);
          const h = harness(
            {
              siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }],
              bindings: [{ ...savedBinding, slots: [{ slot: "username", field: "username" }] }],
            },
            { allowedOrigins: [origin], username: true },
          );
          h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
            from === origin && path === "/signin" ? identifier : undefined,
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          h.login.passkeyAnswered(1, origin, "login.example");
          fake.state.signs = { ...quiet, username: true };
          await navigate(h, console, "console-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        });
      });
      it("ends left-origin when the answer came before the submission", async () => {
        holdClicks(origin);
        const h = twoSites();
        h.login.passkeyAnswered(1, origin, "login.example");
        await new Promise((resolve) => setTimeout(resolve, 5));
        fake.state.signs = quiet;
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
    });
    describe("after a page of the site asked for a passkey (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const auth = "https://auth.login.example";
      const item = { connectionId, itemId };
      /**
       * Submits on the site, then moves the tab to a page of another origin of the site that
       * asks for a passkey, which holds the login.
       */
      const askedThere = async (live: Parameters<typeof harness>[1] = {}) => {
        holdClicks(origin);
        const h = twoSites(live);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = quiet;
        h.login.passkeyRequested(1, auth);
        expect(await navigate(h, `${auth}/passkey`, "auth-document", false)).toEqual({
          ok: false,
          reason: "stale-document",
        });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        return h;
      };
      it("completes when the tab comes back after the login's item answered there", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        const signedIn = vi.fn<(tabId: number, origin: string) => void>();
        const h = await askedThere({ report, signedIn });
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        expect(executes()).toHaveLength(2);
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({
            type: "move",
            origin: auth,
            reason: "passkey-request",
            kept: true,
          }),
        );
        expect(signedIn.mock.calls.toSorted()).toEqual([
          [1, auth],
          [1, origin],
        ]);
      });
      it("keeps waiting while the page that asked announces again", async () => {
        const h = await askedThere();
        expect(await navigate(h, `${auth}/passkey`, "auth-document", false)).toMatchObject({
          ok: false,
        });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("leaves the move to the top page when a frame of the page that asked announces", async () => {
        const h = await askedThere();
        fake.state.tabUrls[1] = `${auth}/passkey`;
        await h.hello(
          {
            frameId: 3,
            documentId: "auth-frame",
            url: `${auth}/frame`,
            tab: { id: 1, url: `${auth}/passkey` },
          },
          false,
        );
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when the page that asked shows a password field again", async () => {
        const h = await askedThere();
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, `${auth}/passkey`, "auth-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page after the answer asks for a passkey again", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        h.login.passkeyRequested(1, "https://www.login.example");
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page that asked stays open", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
        onTestFinished(() => void vi.useRealTimers());
        const h = await askedThere();
        await vi.advanceTimersByTimeAsync(61_000);
        vi.useRealTimers();
        await vi.waitFor(() =>
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" }),
        );
        expect(await h.login.active()).toBe(false);
      });
      it("completes on another host of the passkey's site", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when another item answered there", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        const h = await askedThere({ report });
        h.login.passkeyAnswered(1, auth, "login.example", {
          connectionId,
          itemId: "80000000-0000-4000-8000-000000000009",
        });
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
          expect.objectContaining({ type: "move", origin, reason: "no-factor" }),
        );
      });
      it("ends left-origin when nothing answered there", async () => {
        const h = await askedThere();
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page after the answer shows a password field", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, `${origin}/signin`, "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page after the answer comes more than 30 seconds later", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await navigate(h, `${origin}/callback`, "callback-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("reads the tab's next page when the one it came back to went away", async () => {
        const h = await askedThere();
        h.login.passkeyAnswered(1, auth, "login.example", item);
        fake.state.gone = new Set(["callback-document"]);
        expect(await navigate(h, `${origin}/callback`, "callback-document", false)).toEqual({
          ok: false,
          reason: "stale-document",
        });
        expect(at(origin)).not.toMatchObject({ state: "blocked" });
        await navigate(h, `${origin}/home`, "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("never completes on the account's username once such a page asked", async () => {
        const h = await askedThere();
        fake.state.signs = { ...quiet, username: true };
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the page of another site asks for a passkey", async () => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = quiet;
        h.login.passkeyRequested(1, "https://auth.elsewhere.example");
        await navigate(h, "https://auth.elsewhere.example/passkey", "auth-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
    });
    describe("right after a password submission (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      const signedIn = { ...quiet, username: true };
      const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
      /** Submits the password on the site; the item has a username. */
      const submitted = async () => {
        holdClicks(origin);
        const h = twoSites({ username: true });
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = signedIn;
        return h;
      };
      it("completes when the site's other origin shows the account's username", async () => {
        const h = await submitted();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        // Read twice once loaded, each time with the username for the page's comparison.
        expect(reads()).toEqual([
          expect.objectContaining({ account: { username: "synthetic-secret" } }),
          expect.objectContaining({ account: { username: "synthetic-secret" } }),
        ]);
        expect(executes()).toHaveLength(2);
      });
      it("waits until the new page has loaded", async () => {
        const h = await submitted();
        fake.state.loaded = false;
        setTimeout(() => (fake.state.loaded = true), 1_500);
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        // Two readings while loading, then two once loaded.
        expect(reads()).toHaveLength(4);
      }, 10_000);
      it("reads again while the loaded page does not show the username yet", async () => {
        const h = await submitted();
        fake.state.signs = quiet;
        setTimeout(() => (fake.state.signs = signedIn), 1_500);
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        expect(reads()).toHaveLength(4);
      }, 10_000);
      it("ends left-origin when the new page does not show the username", async () => {
        const h = await submitted();
        fake.state.signs = quiet;
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toHaveLength(5);
      }, 10_000);
      it("ends left-origin without reading the page for an item without a username", async () => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        fake.state.signs = signedIn;
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
      it("saves the account choice and holds no other tab once it completes", async () => {
        holdClicks(origin);
        const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
        const h = harness(
          { siteDefaults: [], bindings: [] },
          { allowedOrigins: [], uris, username: true },
        );
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        expect(h.settings.settings.siteDefaults).toEqual([]);
        fake.state.signs = signedIn;
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        await vi.waitFor(() =>
          expect(h.settings.settings.siteDefaults).toMatchObject([{ origin, itemId }]),
        );
        // Another tab of the site logs in rather than being refused `origin-busy`.
        fake.state.onExecute = undefined;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      });
      it("ends left-origin when the new page shows a password field", async () => {
        const h = await submitted();
        fake.state.signs = { ...signedIn, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page asks for a code", async () => {
        const h = await submitted();
        fake.state.signs = { ...signedIn, code: true };
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin on another registrable domain", async () => {
        const h = await submitted();
        await navigate(h, "https://elsewhere.example/home", "elsewhere-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
      it("ends left-origin when the move comes more than 30 seconds after the submission", async () => {
        const h = await submitted();
        const now = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 31_000);
        onTestFinished(() => clock.mockRestore());
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        expect(reads()).toEqual([]);
      });
      describe("asks the judge once when the username does not show", () => {
        const www = "https://www.login.example";
        const movedHome = {
          ok: true,
          observation: {
            version: 1,
            origin: www,
            path: "/home",
            language: "en",
            complete: true,
            candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
          },
        };
        type JudgeAnswer = Awaited<ReturnType<LoginGeneration["judge"]>>;
        /** Submits the password with the judge answering `answer`; the page shows no username. */
        const judged = async (answer: () => Promise<JudgeAnswer>, runs?: LoginRecipe) => {
          const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
            args[4]?.();
            return answer();
          });
          const report = vi.fn<(entry: LoginReport) => void>();
          holdClicks(origin);
          const h = twoSites({
            username: true,
            report,
            generation: {
              available: vi.fn<LoginGeneration["available"]>(async () => true),
              generate: vi.fn<LoginGeneration["generate"]>(),
              generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
              judge,
              slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
            },
          });
          if (runs)
            h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
              from === origin && path === "/signin" ? runs : undefined,
            );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes()).toHaveLength(2));
          fake.state.signs = quiet;
          fake.state.extracted = { "signed-in": movedHome };
          const judgements = () =>
            report.mock.calls.flatMap(([entry]) => (entry.type === "judge" ? [entry] : []));
          return { h, judge, judgements };
        };
        it("completes when the judge answers signed-in", async () => {
          const { h, judge, judgements } = await judged(async () => ({ verdict: "signed-in" }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
          expect(judge).toHaveBeenCalledTimes(1);
          expect(judge.mock.calls[0]!.slice(0, 4)).toEqual([
            recipe.id,
            recipe.revision,
            "password",
            movedHome.observation,
          ]);
          expect(judgements()).toEqual([
            expect.objectContaining({ verdict: "sent", origin: www, moved: true }),
            expect.objectContaining({ verdict: "signed-in", origin: www, moved: true }),
          ]);
          // Five readings for the username, then one more once the answer is back.
          expect(reads()).toHaveLength(6);
          expect(executes()).toHaveLength(2);
        }, 15_000);
        it("completes on a page judged signed-in before", async () => {
          const { h } = await judged(async () => ({
            verdict: "unclear",
            reason: "judged-signed-in",
          }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated" });
        }, 15_000);
        it.each([
          ["cannot decide", { verdict: "unclear" }],
          ["found the page undecided before", { verdict: "unclear", reason: "already-judged" }],
          ["answers challenge", { verdict: "challenge" }],
          ["is unreachable", { verdict: "retry", reason: "unreachable" }],
        ] as const)(
          "ends left-origin when the judge %s",
          async (_name, answer) => {
            const { h, judge, judgements } = await judged(async () => answer);
            await navigate(h, `${www}/home`, "home-document", false);
            expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
            expect(judge).toHaveBeenCalledTimes(1);
            expect(judgements().at(-1)).toMatchObject({ verdict: answer.verdict, moved: true });
          },
          15_000,
        );
        it("ends left-origin when the page shows a password field once the answer is back", async () => {
          const { h } = await judged(async () => {
            fake.state.signs = { ...quiet, password: true };
            return { verdict: "signed-in" };
          });
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("ends left-origin when the page asks for a passkey while it is judged", async () => {
          let h: ReturnType<typeof harness> | undefined;
          ({ h } = await judged(async () => {
            h!.login.passkeyRequested(1, www);
            return { verdict: "signed-in" };
          }));
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
        }, 15_000);
        it("logs a page it could not describe and sends nothing", async () => {
          const { h, judge, judgements } = await judged(async () => ({ verdict: "signed-in" }));
          fake.state.extracted = {};
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
          expect(judge).not.toHaveBeenCalled();
          expect(judgements()).toEqual([
            expect.objectContaining({ verdict: "not-sent", reason: "no-candidates", moved: true }),
          ]);
        }, 15_000);
        it("completes on a marker learned on that origin, without the judge", async () => {
          const learned = parseLoginRecipe({
            ...recipe,
            completion: [...recipe.completion!, { target: target("account"), origin: www }],
          });
          const { h, judge } = await judged(async () => ({ verdict: "unclear" }), learned);
          await navigate(h, `${www}/home`, "home-document", false);
          expect(at(origin)).toMatchObject({ state: "authenticated" });
          expect(judge).not.toHaveBeenCalled();
          // Only the marker learned there is looked for on that page.
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.observe").at(-1),
          ).toMatchObject({ targets: [target("account")] });
        }, 15_000);
        it("waits for the same document announcing again instead of judging it twice", async () => {
          let answer: (value: JudgeAnswer) => void = () => undefined;
          const { h, judge } = await judged(
            () => new Promise<JudgeAnswer>((resolve) => (answer = resolve)),
          );
          const first = navigate(h, `${www}/home`, "home-document", false);
          await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1), { timeout: 8_000 });
          const again = navigate(h, `${www}/home`, "home-document", false);
          // The second announcement reaches the move while the page is still being judged.
          await new Promise((resolve) => setTimeout(resolve, 200));
          answer({ verdict: "signed-in" });
          expect(await first).toEqual({ ok: false, reason: "stale-document" });
          await again;
          expect(judge).toHaveBeenCalledTimes(1);
          expect(at(origin)).toMatchObject({ state: "authenticated" });
        }, 15_000);
      });
      it("never completes on an http page of the site", async () => {
        const h = await submitted();
        // An http page is not admitted, so the move is not seen and the login is unchanged.
        expect(await navigate(h, "http://www.login.example/home", "home-document", false)).toEqual({
          ok: false,
          reason: "unauthorized-document",
        });
        expect(at(origin)).toMatchObject({ state: "submit-intent" });
        expect(reads()).toEqual([]);
      });
    });
    it("fills without submitting when the site's form shows again after it left", async () => {
      // site -> identity provider -> back to the site's login form (ADR 0021 D, ADR 0022).
      holdClicks(origin, second);
      const h = twoSites();
      const kinds = () =>
        executes().map(
          (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
        );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      // The site's form is filled once, never clicked, and its record is forgotten.
      expect(await navigate(h, fake.state.pageUrl, "returned-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(5));
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(kinds().at(-1)).toBe("fill");
      expect(at(origin)).toBeUndefined();
      // The tab asks once the fill ends; the form showing again only asks.
      expect(fake.state.badges[1]?.text).toBe("1");
      expect(await navigate(h, fake.state.pageUrl, "returned-document")).toEqual({
        ok: false,
        reason: "logged-out",
      });
      // Only the site's record was released; the identity provider's stays until its form shows.
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(await navigate(h, secondUrl, "second-again")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(6));
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(kinds()).toEqual(["fill", "click", "fill", "click", "fill", "fill"]);
      expect(h.fields).toHaveBeenCalledTimes(4);
    });
    it("never submits again when the tab returns to an origin it left", async () => {
      holdClicks(origin, second);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      expect(at(second)).toMatchObject({ state: "submit-intent", submissions: 1 });
      // Back on a page of the first origin, which keeps its own ended record and only
      // watches for the login form (ADR 0021 D).
      expect(await navigate(h, fake.state.pageUrl, "returned-document", false)).toMatchObject({
        ok: false,
        reason: "logged-in",
      });
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
      });
      // And once more to the second origin, which also stays ended.
      expect(await navigate(h, secondUrl, "second-again", false)).toMatchObject({
        reason: "logged-in",
      });
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(stored()).toHaveLength(2);
      expect(executes()).toHaveLength(4);
      expect(h.fields).toHaveBeenCalledTimes(2);
    });
    it("keeps another tab off an origin the tab left until the tab closes", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      fake.state.onExecute = undefined;
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      for (const listener of fake.state.removed) listener(1);
      await vi.waitFor(() => expect(stored()).toEqual([]));
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab-again" })).toEqual({
        ok: true,
      });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 2 } }]),
      );
    });
    it("lets another tab log in once the tab's login authenticated", async () => {
      // The login form in another tab means the site's session has ended (ADR 0022).
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([
          { state: "authenticated", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
      expect(executes()).toHaveLength(4);
    });
    it.each(["wrong-account", "value-mismatch"] as const)(
      "lets another tab log in once Pateat stopped the tab's login as %s",
      async (reason) => {
        // Nothing was submitted, so another tab's login cannot submit the password twice.
        fake.state.executeReply = { ok: false, reason };
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: reason }),
        );
        fake.state.executeReply = undefined;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(stored()).toMatchObject([
            { state: "blocked", outcome: reason, document: { tabId: 1 } },
            { state: "authenticated", document: { tabId: 2 } },
          ]),
        );
      },
    );
    it("lets another tab log in after a vault read failed before the page got anything", async () => {
      // The prepared fill never reached the page, so nothing can be in flight (ADR 0022).
      const h = twoSites();
      h.fields.mockRejectedValueOnce(new Error("synthetic vault failure"));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "policy-changed",
          submissions: 0,
        }),
      );
      expect(at(origin)?.mutationIntent).toBeUndefined();
      expect(executes()).toHaveLength(0);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([
          { state: "blocked", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
    });
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
          fake.state.storage["pateat.login-attempts.v4"] = [
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
          fake.state.storage["pateat.login-attempts.v4"] = [
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
            // Once the form shows again, the tab asks like after a logout and only fills,
            // so it never submits again (ADR 0021 D).
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
        fake.state.storage["pateat.login-attempts.v4"] = [
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
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(async () => expect(await restarted.login.active()).toBe(false));
        expect(
          report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "refused")
            .at(-1),
        ).toMatchObject({
          reason: "logged-out",
          detail: "stopped-login",
        });
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
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
        fake.state.storage["pateat.login-attempts.v4"] = [
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
        fake.state.storage["pateat.login-attempts.v4"] = [
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
        fake.state.storage["pateat.login-attempts.v4"] = [
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
        fake.state.storage["pateat.login-attempts.v4"] = [
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
          fake.state.storage["pateat.login-attempts.v4"] = [
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
        "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait 5 minutes and reload this page, to log in here.",
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
      fake.state.storage["pateat.login-attempts.v4"] = [
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
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const unsaved = { siteDefaults: [], bindings: [] };
    const both = uriMatch({
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
        expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
          { state: "authenticated", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
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
      // The saved default names the provider account, not this device's connection, and
      // keeps the connection's label for display.
      expect(h.settings.settings.siteDefaults).toEqual([
        {
          origin,
          provider: "bitwarden",
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
      // The automatic choice names the provider account as a saved default would, so it
      // stays ambiguous even though the other connection is not enabled.
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris, duplicateAccount: true });
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.store.update).not.toHaveBeenCalled();
    });
    describe("with a completion that also lists absent elements", () => {
      // A learned completion on the sign-in page's own path: the sign-out marker counts
      // only once the password field is gone (ADR 0018).
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
        // The completion target comes first, then the elements that must be missing.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            targets: [target("authenticated"), target("password")],
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
          siteDefaults: [{ origin: second, provider: "bitwarden", userId, itemId }],
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
    it("saves the choice next to a login whose result settled as unknown", async () => {
      const second = "https://second.example";
      const { completion: _unlearned, ...generated } = recipe;
      const h = harness(
        {
          siteDefaults: [{ origin: second, provider: "bitwarden", userId, itemId }],
          bindings: [],
        },
        { allowedOrigins: [second], uris: async () => ({ ok: true, data: uriMatch() }) },
      );
      h.recipes.recipe.mockImplementation(async (at: string) =>
        at === origin ? recipe : at === second ? { ...generated, origin: second } : undefined,
      );
      fake.state.tabUrls[2] = `${second}/signin`;
      const attempts = () =>
        (fake.state.storage["pateat.login-attempts.v4"] ?? []) as Record<string, unknown>[];
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
        { origin, provider: "bitwarden", userId, itemId },
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
        { siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }] },
        { allowedOrigins: [origin] },
      );
      h.snapshot.userId = undefined;
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("refuses a provider-account default whose account is not connected here", async () => {
      const h = harness(
        { siteDefaults: [{ origin, provider: "bitwarden", userId: "other-account", itemId }] },
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
    describe("when no item matches, after a vault check (ADR 0025)", () => {
      const none: Awaited<ReturnType<LiveUriMatcher>> = {
        ok: true,
        data: uriMatch({ candidates: [] }),
      };
      /** A vault sync whose miss checks each wait until the test answers them. */
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
          { siteDefaults: [{ origin, provider: "bitwarden", userId: "other-account", itemId }] },
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
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
            { state: "blocked", outcome: "policy-changed" },
          ]),
        );
        fake.state.onAwait = undefined;
        h.settings.settings.siteDefaults = [];
        h.settings.revision += 1;
        const next = { documentId: "synthetic-next" };
        expect(await h.hello(next)).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(fake.state.storage["pateat.login-attempts.v4"]).toEqual([]);
        expect(await ask(h)).toEqual({ ...offered, documentId: "synthetic-next" });
        fake.state.onReconnect = () => h.hello(next);
        expect(await pick(h, next)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
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
      // Reported by the owner on 2026-10-13: three accounts matched github.com, the pick's
      // stored email was stale, and after GitHub's "incorrect username or password" page the
      // popup offered no account, so another one could not be tried.
      const rejecting = { ...recipe, rejection: target("rejected") };
      const rejectedOffer = {
        ...offered,
        logout: "rejected",
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
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
            { state: "blocked", outcome: "credential-rejected" },
          ]),
        );
        const before = fake.state.messages.filter((entry) => entry.type === "login.execute");
        // The page announces again on the result, then once its form's first step shows.
        expect(await h.hello({}, false)).toMatchObject({ ok: false });
        expect(await h.hello()).toEqual({ ok: false, reason: "logged-out" });
        expect(fake.state.storage["pateat.login-attempts.v4"]).toEqual([]);
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
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
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
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
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
        expect(fake.state.storage["pateat.login-attempts.v4"]).toEqual([]);
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
          reason: "logged-out",
        });
        expect(await ask(h)).toEqual({ ...rejectedOffer, documentId: "document-failed" });
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("asks without filling the page a saved default was rejected in", async () => {
        const h = harness({}, { uris: async () => ({ ok: true, data: both }) });
        h.recipes.recipe.mockResolvedValue(rejecting);
        fake.state.observed = ["missing", "unique"];
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
            { state: "blocked", outcome: "credential-rejected" },
          ]),
        );
        const before = fake.state.messages.filter((entry) => entry.type === "login.execute");
        await h.hello({}, false);
        expect(await h.hello()).toEqual({ ok: false, reason: "logged-out" });
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual(
          before,
        );
        expect(await ask(h)).toEqual(rejectedOffer);
        // A later page of the tab is filled with the default, as after a logout.
        fake.state.observed = ["unique", "missing"];
        const next = { documentId: "synthetic-next" };
        expect(await h.hello(next)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
            { fillOnly: true, document: { documentId: "synthetic-next" } },
          ]),
        );
        await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
        // Another tab of the site fills and asks too; its popup chooses no account either.
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
        await vi.waitFor(async () =>
          expect(
            await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
          ).toMatchObject({ logout: "other-tab", rejectedElsewhere: true }),
        );
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
          expect(fake.state.storage["pateat.login-attempts.v4"]).toHaveLength(1),
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
        h.settings.settings.siteDefaults = [{ origin, provider: "bitwarden", userId, itemId }];
        expect(await ask(h)).toEqual({ ok: false, reason: "no-choice" });
        expect(await pick(h)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        expect(fake.state.reconnects).toEqual([]);
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
            },
          ],
          "pateat.login-choices.v1": [],
          "pateat.login-logouts.v1": [],
          "pateat.login-logout-fills.v1": [],
          "pateat.login-stopped-asks.v1": [],
          "pateat.login-rejected-asks.v1": [],
          "pateat.login-entry-presses.v1": [],
          "pateat.login-noted.v1": [["1 synthetic-document /signin", ["account-ambiguous "]]],
        });
        for (const listener of fake.state.removed) listener(1);
        await vi.waitFor(() =>
          expect(fake.state.session).toEqual({
            "pateat.login-noted.v1": [],
            "pateat.login-picks.v1": [],
            "pateat.login-choices.v1": [],
            "pateat.login-logouts.v1": [],
            "pateat.login-logout-fills.v1": [],
            "pateat.login-stopped-asks.v1": [],
            "pateat.login-rejected-asks.v1": [],
            "pateat.login-entry-presses.v1": [],
          }),
        );
      });
      it("offers a choice in a tab that holds only another origin's record", async () => {
        const second = "https://second.example";
        const h = harness(
          {
            siteDefaults: [{ origin: second, provider: "bitwarden", userId, itemId }],
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
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
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
          fake.state.storage["pateat.login-attempts.v4"] as { id: string; state: string }[];
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
      describe("after a logout in the same tab (ADR 0021 D)", () => {
        const logouts = () => fake.state.session["pateat.login-logouts.v1"];
        const steps = () =>
          fake.state.messages
            .filter((entry) => entry.type === "login.execute")
            .map(
              (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step,
            );
        /**
         * The form shows after a logout: the saved default fills it once without a click and
         * the record is forgotten; the document then announces again and asks.
         */
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
          expect(await h.hello(from)).toEqual({ ok: false, reason: "logged-out" });
        };
        const attempts = () =>
          fake.state.storage["pateat.login-attempts.v4"] as {
            state: string;
            account: { itemId: string };
          }[];
        /** Logs in with the saved default, then the login form shows again in the tab. */
        const loggedOut = async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // A page of the site without the form only watches for it.
          expect(await h.hello({ documentId: "home" }, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
          expect(attempts()).toHaveLength(1);
          await filledOnly(h, { documentId: "signed-out" });
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          return h;
        };
        it("never clicks the account switch while it only fills, and asks", async () => {
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
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The login page after the logout shows another account than the one to fill.
          fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
          const before = steps().length;
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(before + 1));
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          const sent = fake.state.messages.filter((entry) => entry.type === "login.execute");
          expect(sent.at(-1)!.accountSwitch).toBeUndefined();
          expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.switch");
          // The fill-only record is forgotten and the tab asks.
          expect(attempts()).toEqual([]);
          expect(fake.state.badges[1]?.text).toBe("2");
        });
        it("asks with the saved default first and releases only this tab's record", async () => {
          const h = await loggedOut();
          expect(attempts()).toEqual([]);
          expect(fake.state.badges[1]).toEqual({
            text: "2",
            title: "Pateat: you logged out of this site in this tab. Click to choose an account.",
          });
          expect(await ask(h)).toEqual({
            ok: true,
            origin,
            documentId: "signed-out",
            candidates: [
              { connectionId, itemId },
              { connectionId, itemId: otherItemId },
            ],
            logout: "this-tab",
          });
          expect(logouts()).toEqual([{ tabId: 1, origin }]);
          // A one-time pick logs in and leaves the saved default as it was.
          expect(await pick(h, { documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          expect(h.settings.settings.siteDefaults).toEqual([
            { origin, provider: "bitwarden", userId, itemId },
          ]);
          expect(logouts()).toEqual([]);
        });
        it("keeps asking as the tab that logged out after Chrome replaces the tab", async () => {
          const h = await loggedOut();
          // Chrome discarded the idle tab and shows it again under a new ID.
          fake.state.tabUrls[2] = fake.state.pageUrl;
          for (const listener of fake.state.replaced) listener(2, 1);
          await vi.waitFor(() => expect(logouts()).toEqual([{ tabId: 2, origin }]));
          // The restored page fills once and asks as this tab, not as another tab.
          await filledOnly(h, { tab: { id: 2 }, documentId: "restored" });
          expect(
            await h.login.handle({ version: 1, type: "login.choice.get", tabId: 2 }, popup),
          ).toMatchObject({ documentId: "restored", logout: "this-tab" });
          expect(fake.state.badges[2]?.title).toBe(
            "Pateat: you logged out of this site in this tab. Click to choose an account.",
          );
        });
        it("keeps the tab's login with it after Chrome replaces the tab", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
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
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The worker had stopped; only the tab's new ID is open when it starts again.
          fake.state.replaced.length = 0;
          fake.state.tabUrls[2] = fake.state.pageUrl;
          const query = fake.browser.tabs.query;
          fake.browser.tabs.query = async () => [{ id: 2 }] as never;
          try {
            const restarted = harness(
              {},
              { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
            );
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
        it("replaces the saved default with a pick marked as the default", async () => {
          const h = await loggedOut();
          expect(await pick(h, { documentId: "signed-out", makeDefault: true })).toEqual({
            ok: true,
          });
          await vi.waitFor(() =>
            expect(h.settings.settings.siteDefaults).toEqual([
              expect.objectContaining({ origin, userId, itemId: otherItemId }),
            ]),
          );
        });
        it("watches in the document that logged in and asks when its form shows again", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The document announces again after its login ended, as the content script does.
          expect(await h.hello({}, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
          await filledOnly(h);
          expect(fake.state.badges[1]?.text).toBe("2");
        });
        it("fills again after a reload or a worker restart and keeps asking", async () => {
          await loggedOut();
          const restarted = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          // The document that was filled is not filled again by a restarted worker.
          expect(await restarted.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "logged-out",
          });
          expect(restarted.fields).not.toHaveBeenCalled();
          await filledOnly(restarted, { documentId: "reloaded" });
          expect(restarted.fields).toHaveBeenCalledTimes(1);
          expect(logouts()).toEqual([{ tabId: 1, origin }]);
          // Nothing was ever clicked after the logout.
          expect(steps().map((step) => step.kind)).toEqual(["fill", "click", "fill", "fill"]);
        });
        it("forgets a fill-only record a stopped worker left ended", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          const [done] = attempts();
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          // As a worker that stopped after ending the fill, before forgetting it, leaves it.
          fake.state.storage["pateat.login-attempts.v4"] = [
            { ...done, fillOnly: true, state: "blocked", outcome: "cancelled" },
          ];
          const restarted = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          await filledOnly(restarted, { documentId: "reloaded" });
          expect(attempts()).toEqual([]);
        });
        it("does not hold the site for other tabs while a tab only fills", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The fill after the logout never answers, so it stays running.
          fake.state.onExecute = () => new Promise(() => undefined);
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(3));
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(4));
          expect(steps().map((step) => step.kind)).toEqual(["fill", "click", "fill", "fill"]);
        });
        it("asks without filling when several accounts match and none is the default", async () => {
          const h = harness(unsaved, {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: both }),
          });
          expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
          fake.state.onReconnect = () => h.hello();
          expect(await pick(h)).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          const before = steps().length;
          expect(await h.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "logged-out",
          });
          expect(steps()).toHaveLength(before);
        });
        it("logs a sign-in form that is not taken as a logout, and which tab logged out", async () => {
          const report = vi.fn<(report: LoginReport) => void>();
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), report },
          );
          const refusals = () =>
            report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // A sign-in input whose form is not the recipe's first step: still logged in.
          const watching = { ok: false, reason: "logged-in", starts: [signinStart] };
          expect(await shownHello(h, { documentId: "home" })).toEqual(watching);
          expect(await shownHello(h, { documentId: "home" })).toEqual(watching);
          expect(refusals()).toEqual([
            { type: "refused", tabId: 1, origin, reason: "not-started", detail: "logged-in" },
          ]);
          // The fill after the logout ends asking, and that is logged with the tab that
          // logged out; the content script does not announce a start again for that form.
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(refusals().at(-1)).toMatchObject({ reason: "logged-out", detail: "this-tab" }),
          );
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(refusals().at(-1)).toMatchObject({
              tabId: 2,
              reason: "logged-out",
              detail: "other-tab",
            }),
          );
          expect(refusals().filter((entry) => entry.reason === "logged-out")).toHaveLength(2);
          // The logout itself, and each login with how its account was chosen.
          const decisions = report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "start" || entry.type === "logout");
          expect(decisions).toEqual([
            expect.objectContaining({ type: "start", tabId: 1, account: "default" }),
            {
              type: "logout",
              tabId: 1,
              origin,
              recipeId: recipe.id,
              recipeRevision: recipe.revision,
            },
            expect.objectContaining({
              type: "start",
              tabId: 1,
              account: "default",
              candidates: 2,
              fillOnly: true,
            }),
            expect.objectContaining({ type: "start", tabId: 2, fillOnly: true }),
          ]);
          expect(decisions[0]).not.toHaveProperty("itemId");
        });
        it("asks in other tabs of the site while it asks, and a pick there logs in", async () => {
          const h = await loggedOut();
          // Cookies are shared: another tab must not log in again behind the user's logout,
          // so it asks too.
          fake.state.tabUrls[2] = fake.state.pageUrl;
          await filledOnly(h, { tab: { id: 2 }, documentId: "other-tab" });
          expect(fake.state.badges[2]).toEqual({
            text: "2",
            title:
              "Pateat: you logged out of this site in another tab. Click to choose an account.",
          });
          expect(h.fields).toHaveBeenCalledTimes(3);
          fake.state.onReconnect = () => h.hello({ tab: { id: 2 }, documentId: "other-tab" });
          expect(await pick(h, { tabId: 2, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          // The tab that logged out still asks, and its pick may log in over that login.
          expect(logouts()).toEqual([{ tabId: 1, origin }]);
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          expect(await pick(h, { documentId: "signed-out", itemId })).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toHaveLength(2));
          expect(logouts()).toEqual([]);
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
        {
          connections: [
            {
              connectionId,
              enabled: true,
              selection: { mode: "all", groupIds: [], itemIds: [] },
              excludedItemIds: [],
              excludedFields: [{ itemId, fieldId: `custom.${snapshotId}.0` }],
            },
          ],
        },
        "binding-field-excluded",
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
    expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/signin", recipe.id);
  });
  describe("on a page without a recipe", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const generated = parseLoginRecipe({
      version: 1,
      id: "gen-synthetic",
      revision: 1,
      origin,
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
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 1,
    });
    const page = (path: string, candidates: unknown[]) => ({
      ok: true,
      observation: { version: 1, origin, path, language: "en", complete: true, candidates },
    });
    const loginPage = page("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    const homePage = page("/home", [
      { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
    ]);
    function generation(implementation: Partial<LoginGeneration> = {}) {
      return {
        available: vi.fn<LoginGeneration["available"]>(
          implementation.available ?? (async () => true),
        ),
        // Like the service, each says just before the request leaves the device.
        generate: vi.fn<LoginGeneration["generate"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generate ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generateEntry ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
          args[4]?.();
          return (implementation.judge ?? (async () => ({ verdict: "unclear" }) as const))(...args);
        }),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(
          implementation.slotFields ?? (async () => undefined),
        ),
      };
    }
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    const status = () => fake.state.storage["pateat.login-attempts.v4"];

    it("sends a matching sign-in page for generation and runs the returned recipe", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      // An item without custom fields offers only built-in slots.
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      // The first announcement only offers generation; nothing reads the vault yet.
      expect(await h.hello({}, false)).toEqual({
        ok: false,
        reason: "recipe-not-found",
        starts: [],
        generate: true,
      });
      expect(h.store.handle).not.toHaveBeenCalled();
      service.generate.mockImplementation(async () => {
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        return { outcome: "recipe", recipe: generated };
      });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
      );
      expect(service.available).toHaveBeenCalledWith(origin, "/signin");
      // Only slots the matching item can fill are offered.
      // The username's shape goes with its slot; the value itself never does.
      expect(service.generate).toHaveBeenCalledWith(
        {
          version: 1,
          observation: loginPage.observation,
          slots: [
            expect.objectContaining({
              id: "username",
              kind: "identifier",
              valueShape: { length: 16, classes: ["ascii-letter", "ascii-symbol"], email: false },
            }),
            expect.not.objectContaining({ valueShape: expect.anything() }),
          ],
        },
        expect.any(Function),
      );
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.username"]);
      // The document announces again and starts the generated recipe at once.
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          2,
        ),
      );
      expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.values).toEqual([
        { slot: "username", value: "synthetic-secret" },
        { slot: "password", value: "synthetic-secret", secret: "password" },
      ]);
    });

    it("logs a page sent for generation, then the answer", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      const generations = () =>
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "generation");
      await vi.waitFor(() => expect(generations()).toHaveLength(2));
      expect(generations()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "sent" },
        { type: "generation", tabId: 1, origin, outcome: "abstained", reason: "ambiguous" },
      ]);
    });

    it("spins the tab's icon from the page's send until its answer", async () => {
      fake.state.extracted = { login: loginPage };
      let answer!: (outcome: GenerationOutcome) => void;
      const service = generation({
        generate: () =>
          new Promise<GenerationOutcome>((resolve) => {
            answer = resolve;
          }),
      });
      const stop = vi.fn();
      const spin = vi.fn((_tabId: number) => stop);
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        spin,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(spin).not.toHaveBeenCalled();
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(spin).toHaveBeenCalledWith(1));
      expect(stop).not.toHaveBeenCalled();
      answer({ outcome: "abstained", reason: "ambiguous" });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      expect(spin).toHaveBeenCalledTimes(1);
    });

    it("stops the spin when the request fails after it was sent", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation({
        generate: async () => {
          throw new Error("network");
        },
      });
      const stop = vi.fn();
      const spin = vi.fn((_tabId: number) => stop);
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        spin,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      expect(spin.mock.calls).toEqual([[1]]);
    });

    it("tells the popup that the page went to the AI, then what came back", async () => {
      fake.state.extracted = { login: loginPage };
      let answer!: (outcome: GenerationOutcome) => void;
      const service = generation({
        generate: () =>
          new Promise<GenerationOutcome>((resolve) => {
            answer = resolve;
          }),
      });
      const tabBadge = createLoginBadge({
        setBadge: vi.fn(async () => undefined),
        storage: memoryBadgeStorage(),
      });
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        badge: tabBadge,
        report: (entry) => tabBadge.observe(entry),
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const ask = () => h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup);
      expect(await ask()).toEqual({ ok: true, origin, recipe: "none" });
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await ask()).toMatchObject({ ok: true, origin, recipe: "none" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      // The badge spins while the request is out, so the popup knows it is in flight.
      await vi.waitFor(async () =>
        expect(await ask()).toEqual({
          ok: true,
          origin,
          recipe: "none",
          asking: true,
          page: expect.objectContaining({ state: "generating" }),
          generation: { outcome: "sent" },
        }),
      );
      expect(tabBadge.asking(1)).toBe(true);
      answer({ outcome: "abstained", reason: "ambiguous" });
      await vi.waitFor(async () =>
        expect(await ask()).toMatchObject({
          generation: { outcome: "abstained", reason: "ambiguous" },
        }),
      );
      // The spin ended with the answer, though the page may still say `generating`.
      const after = await ask();
      expect(after).not.toHaveProperty("asking");
      expect(tabBadge.asking(1)).toBe(false);
    });

    it("clips a page's over-long refusal reason to the popup's limit", async () => {
      // The content script's refusal reason is any text it sent.
      const reason = `extract-${"x".repeat(300)}`;
      fake.state.extracted = { login: { ok: false, reason } };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      await h.signIn();
      await vi.waitFor(
        () =>
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ type: "generation", outcome: "skipped", reason }),
          ),
        { timeout: 6_000 },
      );
      expect(service.generate).not.toHaveBeenCalled();
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const answer = await h.login.handle(
        { version: 1, type: "login.status.get", tabId: 1 },
        popup,
      );
      // The popup's client parses the answer, so it must stay within its schema.
      const parsed = v.parse(statusResponseSchema, answer);
      expect(parsed).toMatchObject({ ok: true, origin, recipe: "none" });
      expect(parsed.ok && parsed.page?.generationSkip).toBe(reason.slice(0, 200));
    }, 10_000);

    it("logs a page that stopped answering before it was sent", async () => {
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      // The page stops answering, as while it is replaced.
      fake.state.gone.add("synthetic-document");
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith({
          type: "generation",
          tabId: 1,
          origin,
          outcome: "skipped",
          reason: "unreachable",
          detail: "no-receiver",
        }),
      );
      expect(service.generate).not.toHaveBeenCalled();
    });

    describe("pages that announced while the request was in flight", () => {
      /** A generation whose answer waits until `release`; the recipe is then cached. */
      function pending(report?: (report: LoginReport) => void) {
        fake.state.extracted = { login: loginPage };
        const service = generation();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          ...(report ? { report } : {}),
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        let release!: () => void;
        const answered = new Promise<void>((resolve) => {
          release = resolve;
        });
        service.generate.mockImplementation(async (_request, sent) => {
          sent?.();
          await answered;
          h.recipes.recipe.mockImplementation(async (at: string, path: string) =>
            at === origin && path === "/signin" ? generated : undefined,
          );
          h.recipes.starts.mockImplementation(async (at: string) =>
            at === origin ? startsOf([generated.steps[0]!]) : [],
          );
          return { outcome: "recipe", recipe: generated };
        });
        return { h, service, release };
      }
      /** A top-level document reports a visible sign-in input on its path. */
      const signInFrom = (h: ReturnType<typeof harness>, from: Record<string, unknown>) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            signIn: { path: new URL(String(from["url"] ?? fake.state.pageUrl)).pathname },
          },
          sender(from),
        );
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

      it("starts a page that replaced the document in its tab", async () => {
        const { h, service, release } = pending();
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        // The tab loads the page again; the page is still being sent, so it gets nothing.
        service.available.mockResolvedValue("sending");
        expect(await signInFrom(h, { documentId: "replacement" })).toEqual({
          ok: false,
          reason: "recipe-not-found",
        });
        release();
        // Only the page the tab shows now is asked to announce again, once.
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual([
            { tabId: 1, frameId: 0, documentId: "replacement" },
          ]),
        );
        expect(await h.hello({ documentId: "replacement" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.execute"),
          ).toHaveLength(2),
        );
        expect(service.generate).toHaveBeenCalledTimes(1);
      });

      it("starts the same page in another tab", async () => {
        const { h, service, release } = pending();
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        service.available.mockResolvedValue("sending");
        expect(await signInFrom(h, { tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "recipe-not-found",
        });
        release();
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual(
            expect.arrayContaining([
              { tabId: 1, frameId: 0, documentId: "synthetic-document" },
              { tabId: 2, frameId: 0, documentId: "other-tab" },
            ]),
          ),
        );
        expect(fake.state.reconnects).toHaveLength(2);
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      });

      /** Caches `value` for the origin's `/signin`, or nothing. */
      const cache = (h: ReturnType<typeof harness>, value: LoginRecipe | undefined) => {
        h.recipes.recipe.mockImplementation(async (at: string, path: string) =>
          at === origin && path === "/signin" ? value : undefined,
        );
        h.recipes.starts.mockImplementation(async (at: string) =>
          at === origin && value ? startsOf([value.steps[0]!]) : [],
        );
      };
      /** Tab 2's page logs in with a cached recipe before this page is sent. */
      async function loggedIn(h: ReturnType<typeof harness>) {
        cache(h, recipe);
        expect(await h.hello({ tab: { id: 2 }, documentId: "done" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
            { state: "authenticated" },
          ]),
        );
        cache(h, undefined);
      }
      /** Sends tab 1's page and lets the answer arrive once `during` has run. */
      async function generate(
        h: ReturnType<typeof harness>,
        service: ReturnType<typeof generation>,
        release: () => void,
        during: () => Promise<void> = async () => undefined,
      ) {
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        service.available.mockResolvedValue("sending");
        await during();
        release();
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toContainEqual({
            tabId: 1,
            frameId: 0,
            documentId: "synthetic-document",
          }),
        );
        await settle();
      }

      it("leaves pages of another path or origin, and a frame on the same path", async () => {
        const { h, service, release } = pending();
        await generate(h, service, release, async () => {
          fake.state.tabUrls[2] = `${origin}/home`;
          expect(
            await signInFrom(h, {
              tab: { id: 2 },
              documentId: "other-path",
              url: `${origin}/home`,
            }),
          ).toEqual({ ok: false, reason: "recipe-not-found" });
          fake.state.tabUrls[3] = "https://other.example/signin";
          expect(
            await signInFrom(h, {
              tab: { id: 3 },
              documentId: "other-origin",
              url: "https://other.example/signin",
            }),
          ).toMatchObject({ ok: false });
          expect(
            await signInFrom(h, {
              tab: { id: 4, url: fake.state.pageUrl },
              frameId: 5,
              documentId: "framed",
            }),
          ).toMatchObject({ ok: false, reason: "recipe-not-found" });
        });
        expect(fake.state.reconnects).toHaveLength(1);
      });

      it("leaves the page that carries its tab's login, also once it finished", async () => {
        const { h, service, release } = pending();
        await loggedIn(h);
        await generate(h, service, release);
        expect(fake.state.reconnects).toHaveLength(1);
      });

      it("starts a new page of a tab whose earlier login finished", async () => {
        const { h, service, release } = pending();
        await loggedIn(h);
        await generate(h, service, release, async () => {
          expect(await signInFrom(h, { tab: { id: 2 }, documentId: "after-login" })).toMatchObject({
            ok: false,
            reason: "logged-in",
          });
        });
        expect(fake.state.reconnects).toHaveLength(2);
        expect(fake.state.reconnects).toContainEqual({
          tabId: 2,
          frameId: 0,
          documentId: "after-login",
        });
      });

      it("leaves the page of a tab whose frame runs a login", async () => {
        const { h, service, release } = pending();
        // The frame's login waits on its first step, so it keeps running.
        fake.state.onExecute = (_message, tabId) =>
          tabId === 2 ? new Promise<void>(() => undefined) : Promise.resolve();
        cache(h, recipe);
        expect(
          await h.hello({
            tab: { id: 2, url: fake.state.pageUrl },
            frameId: 5,
            documentId: "frame",
          }),
        ).toEqual({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.execute"),
        );
        cache(h, undefined);
        await generate(h, service, release, async () => {
          expect(await signInFrom(h, { tab: { id: 2 }, documentId: "around-frame" })).toEqual({
            ok: false,
            reason: "tab-busy",
          });
        });
        expect(fake.state.reconnects).toHaveLength(1);
      });

      it.each([
        ["at info while the tab still shows the page", undefined, {}],
        ["at debug once the tab moved on", `${origin}/home`, { unrelated: true }],
      ] as const)(
        "logs a page that could not be asked to announce again %s",
        async (_name, moved, level) => {
          const report = vi.fn<(report: LoginReport) => void>();
          const { h, service, release } = pending(report);
          expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
          // The page stops answering after it was sent, as when its content script is gone.
          fake.state.gone.add("synthetic-document");
          if (moved) fake.state.tabUrls[1] = moved;
          release();
          await vi.waitFor(() =>
            expect(report).toHaveBeenCalledWith({
              type: "refused",
              tabId: 1,
              origin,
              reason: "reconnect-failed",
              ...level,
            }),
          );
          expect(report).toHaveBeenCalledWith(
            expect.objectContaining({ type: "generation", outcome: "recipe" }),
          );
          expect(report).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "generation", outcome: "skipped" }),
          );
        },
      );
    });

    it("sends the username's shape only when every matching item agrees", async () => {
      fake.state.extracted = { login: loginPage };
      const both = async () => ({
        ok: true as const,
        data: uriMatch({
          candidates: [itemId, otherItemId].map((id) => ({
            itemId: id,
            matches: [{ uriIndex: 0, match: 0 }],
          })),
        }),
      });
      const read: string[] = [];
      const sentShape = async (
        usernames: Record<string, string | Error | undefined>,
        options: { overrides?: Partial<LocalSettings>; uris?: LiveUriMatcher } = {},
      ) => {
        const service = generation();
        const h = harness(
          { ...unsaved, ...options.overrides },
          {
            allowedOrigins: [],
            uris: options.uris ?? both,
            username: true,
            otherUsername: true,
            custom: [],
            generation: service,
          },
        );
        read.length = 0;
        h.fields.mockImplementation(async ({ account }) => {
          read.push(account.itemId);
          const value = usernames[account.itemId];
          if (value instanceof Error) throw value;
          return value;
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        return service.generate.mock.calls[0]![0].slots.find((slot) => slot.id === "username")!
          .valueShape;
      };
      const digits = (length: number) => ({ length, classes: ["ascii-digit"], email: false });
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "00005678" })).toEqual(
        digits(8),
      );
      // Different lengths or an unchecked item send no shape.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "0000123456" })).toBe(
        undefined,
      );
      // Same length but other characters, or an email, is a different shape.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "abcd1234" })).toBe(undefined);
      expect(await sentShape({ [itemId]: "a@b.test", [otherItemId]: "ab.cdefg" })).toBe(undefined);
      // A username too long to shape cannot be compared, so nothing is sent.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "1".repeat(1025) })).toBe(
        undefined,
      );
      expect(
        await sentShape(
          { [itemId]: "00001234", [otherItemId]: "00005678" },
          {
            uris: async () => ({
              ok: true as const,
              data: uriMatch({ unavailableItemIds: [otherItemId] }),
            }),
          },
        ),
      ).toBe(undefined);
      // An empty or excluded username does not count, and an excluded one is never read.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "" })).toEqual(digits(8));
      const excluded = {
        connections: [
          {
            connectionId,
            enabled: true,
            selection: { mode: "all" as const, groupIds: [], itemIds: [] },
            excludedItemIds: [],
            excludedFields: [{ itemId: otherItemId, fieldId: "login.username" }],
          },
        ],
      };
      expect(
        await sentShape(
          { [itemId]: "00001234", [otherItemId]: "0000123456" },
          { overrides: excluded },
        ),
      ).toEqual(digits(8));
      expect(read).toEqual([itemId]);
    });

    describe("the account's own usernames", () => {
      const both = async () => ({
        ok: true as const,
        data: uriMatch({
          candidates: [itemId, otherItemId].map((id) => ({
            itemId: id,
            matches: [{ uriIndex: 0, match: 0 }],
          })),
        }),
      });
      /** Synthetic usernames of the two matching items; other fields read as before. */
      const usernames = (
        h: ReturnType<typeof harness>,
        values: Record<string, string | Error> = {
          [itemId]: "Taro.Yamada",
          [otherItemId]: "an",
        },
      ) =>
        h.fields.mockImplementation(async ({ account, fieldId }) => {
          if (fieldId !== "login.username") return "synthetic-secret";
          const value = values[account.itemId];
          if (value instanceof Error) throw value;
          return value;
        });
      const shownPage = (path: string) =>
        page(path, [
          { id: "c1", role: "email", target: target("user"), label: "Email for taro.yamada" },
          { id: "c2", role: "password", target: target("password"), label: "Password" },
          { id: "c3", role: "button", target: target("login"), label: "Sign in" },
          {
            id: "c4",
            role: "link",
            target: { by: "text", value: "Not TARO.YAMADA?" },
            label: "Not TARO.YAMADA?",
          },
          { id: "c5", role: "link", target: target("other"), label: "Use another account" },
        ]);
      const withHeadings = (shown: ReturnType<typeof page>, headings: string[]) => ({
        ...shown,
        observation: { ...shown.observation, title: "ｔａｒｏ．ｙａｍａｄａ - Example", headings },
      });

      it("hides them from a page sent for generation", async () => {
        fake.state.extracted = {
          login: withHeadings(shownPage("/signin"), ["Welcome back, @Taro.Yamada", "an"]),
        };
        const service = generation();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: both,
          username: true,
          otherUsername: true,
          custom: [],
          generation: service,
        });
        usernames(h);
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        const { observation } = service.generate.mock.calls[0]![0];
        expect(observation.title).toBe("[account] - Example");
        // A username shorter than three characters, such as "an", is not looked for.
        expect(observation.headings).toEqual(["Welcome back, [account]", "an"]);
        expect(observation.candidates.map((candidate) => [candidate.id, candidate.label])).toEqual([
          ["c1", "Email for [account]"],
          ["c2", "Password"],
          ["c3", "Sign in"],
          ["c5", "Use another account"],
        ]);
        expect(JSON.stringify(service.generate.mock.calls).toLowerCase()).not.toContain("taro");
        // Each username is read once, for its shape and for hiding it.
        expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
          "login.username",
          "login.username",
        ]);
      });

      it.each([
        ["a username that cannot be read", "username-unread", new Error("locked")],
        ["a submit button that names a username", "username-shown", "hanako"],
      ] as const)("sends no page with %s", async (_label, reason, other) => {
        fake.state.extracted = {
          login: page("/signin", [
            { id: "c1", role: "email", target: target("user"), group: "f1" },
            { id: "c2", role: "password", target: target("password"), group: "f1" },
            {
              id: "c3",
              role: "button",
              target: { by: "text", value: "Log in as taro.yamada" },
              group: "f1",
            },
          ]),
        };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: both,
          username: true,
          otherUsername: true,
          custom: [],
          generation: service,
          report,
        });
        usernames(h, { [itemId]: "taro.yamada", [otherItemId]: other });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() =>
          expect(report).toHaveBeenCalledWith({
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason,
          }),
        );
        expect(service.generate).not.toHaveBeenCalled();
        expect(JSON.stringify(report.mock.calls).toLowerCase()).not.toContain("taro");
      });

      it("reads no username of an item that holds none, and still sends the page", async () => {
        fake.state.extracted = { login: withHeadings(shownPage("/signin"), ["Hi taro.yamada"]) };
        const service = generation();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: both,
          username: true,
          otherUsername: "empty",
          custom: [],
          generation: service,
        });
        // The other item's username field is present with no value, which resolves as
        // missing: reading it would fail, so it is never read.
        usernames(h, { [itemId]: "taro.yamada" });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        expect(service.generate.mock.calls[0]![0].observation.headings).toEqual(["Hi [account]"]);
        expect(h.fields.mock.calls.map(([request]) => request.account.itemId)).toEqual([itemId]);
      });

      it("hides them, and the login's own, from the judged page", async () => {
        let signedIn = false;
        const matching = async () =>
          signedIn ? { ok: true as const, data: uriMatch({ candidates: [] }) } : uris();
        fake.state.extracted = {
          "signed-in": page("/home", [
            { id: "c1", role: "button", target: target("logout"), label: "Sign out taro.yamada" },
            {
              id: "c2",
              role: "link",
              target: { by: "text", value: "taro.yamada" },
              label: "taro.yamada",
            },
          ]),
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: matching,
          username: true,
          generation: service,
          report,
        });
        usernames(h, { [itemId]: "taro.yamada" });
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The page after the sign-in matches no item by its URL; the login's own is hidden.
          signedIn = true;
          fake.state.present = new Set(["logout"]);
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(service.judge).toHaveBeenCalledTimes(1);
        const observation = service.judge.mock.calls[0]![3];
        expect(observation.candidates).toEqual([
          { id: "c1", role: "button", target: target("logout"), label: "Sign out [account]" },
        ]);
        expect(JSON.stringify(service.judge.mock.calls).toLowerCase()).not.toContain("taro");
        expect(JSON.stringify(report.mock.calls).toLowerCase()).not.toContain("taro");
      }, 10_000);

      it("judges no page whose usernames cannot be read", async () => {
        let signedIn = false;
        fake.state.extracted = { "signed-in": homePage };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.fields.mockImplementation(async ({ fieldId }) => {
          if (signedIn && fieldId === "login.username") throw new Error("locked");
          return "synthetic-secret";
        });
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          signedIn = true;
          fake.state.present = new Set(["logout"]);
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(report).toHaveBeenCalledWith(
              expect.objectContaining({
                type: "judge",
                verdict: "not-sent",
                reason: "username-unread",
              }),
            ),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);
    });

    it("sends nothing when no vault item matches the page", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch({ candidates: [] }) }),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "no-vault-match",
        detail: "no-item",
      });
      expect(service.generate).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });

    it("logs why the vault could not tell whether an item matches", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => vaultFailure("crypto-locked"),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "vault-unavailable",
        detail: "crypto-locked",
      });
      expect(service.generate).not.toHaveBeenCalled();
    });

    it("logs a sign-in page not sent because every vault connection is turned off", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const disabled = {
        ...unsaved,
        connections: [
          {
            connectionId,
            enabled: false,
            selection: { mode: "all" as const, groupIds: [], itemIds: [] },
            excludedItemIds: [],
            excludedFields: [],
          },
        ],
      };
      const h = harness(disabled, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "connection-disabled",
      });
      expect(service.generate).not.toHaveBeenCalled();
    });

    it("logs a page not offered while the service is not connected", async () => {
      const service = generation({ available: async () => "not-connected" });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "not-connected",
      });
    });

    describe("a page that lists accounts (ADR 0028)", () => {
      const listPage = {
        ok: true,
        observation: {
          ...page("/signin", [
            {
              id: "c1",
              role: "button",
              target: { by: "text", value: "Use another profile" },
              label: "Use another profile",
            },
          ]).observation,
          accounts: ["[account]"],
        },
      };
      /** The document announces, ten seconds after loading, that it lists accounts. */
      const listHello = (
        h: ReturnType<typeof harness>,
        names?: string[],
        from: Record<string, unknown> = {},
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            list: { path: "/signin", ...(names ? { names } : {}) },
          },
          sender(from),
        );
      const setup = (live: Partial<Parameters<typeof harness>[1]> = {}) => {
        fake.state.extracted = { accounts: listPage };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          custom: [],
          generation: service,
          report,
          ...live,
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        // A list by email is sent only for an email username, unless it shows a control
        // for another account.
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu@example.com" : "synthetic-secret",
        );
        const generations = () =>
          report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "generation");
        return { service, h, generations };
      };

      it("logs a page offered for generation that showed nothing to send, at debug level", async () => {
        const { service, h, generations } = setup();
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        // The first announcement logs nothing: the page may still show a list.
        expect(generations()).toEqual([]);
        const unoffered = (why: string, from: Record<string, unknown> = {}) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              unoffered: { path: "/signin", why },
            },
            sender(from),
          );
        expect(await unoffered("no-list")).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "nothing-offered",
            detail: "no-list",
          },
        ]);
        expect(service.generate).not.toHaveBeenCalled();
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        // Another path than the document's is not logged for it.
        expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({ generate: true });
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            unoffered: { path: "/elsewhere", why: "no-list" },
          },
          sender({ documentId: "next-page" }),
        );
        expect(generations()).toHaveLength(1);
        // The tab's next document after a submitted password form says so.
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender({ documentId: "next-page" }),
        );
        expect(await h.hello({ documentId: "after" }, false)).toMatchObject({ generate: true });
        await unoffered("no-list", { documentId: "after" });
        expect(generations().at(-1)).toMatchObject({
          reason: "nothing-offered",
          detail: "after-sign-in",
        });
        // A reason outside the list is refused by the message schema.
        expect(await unoffered("other", { documentId: "next-page" })).toBeUndefined();
      });

      it("logs why a shown control for another account did not count", async () => {
        const { h, generations } = setup();
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            list: { path: "/signin", names: ["Help"], otherMiss: "other-holds-name" },
          },
          sender(),
        );
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "other-holds-name",
          },
        ]);
      });

      it("sends a list with an email as a list, logging it as one", async () => {
        const { service, h, generations } = setup();
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(generations()).toHaveLength(2));
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
        });
        expect(
          fake.state.messages.find((entry) => entry.type === "login.extract"),
        ).not.toHaveProperty("names");
        expect(service.generate).toHaveBeenCalledWith(
          expect.objectContaining({ observation: listPage.observation }),
          expect.any(Function),
        );
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "sent", page: "accounts" },
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "abstained",
            reason: "ambiguous",
            page: "accounts",
          },
        ]);
      });

      it("sends a list by email for a username that is not one only with a control for another account", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu729" : "synthetic-secret",
        );
        const emailHello = (documentId: string, other?: true) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/signin", ...(other ? { other } : {}) },
            },
            sender({ documentId }),
          );
        // As on myUNSW: no address on the page can be compared with the username.
        expect(await h.hello({ documentId: "bare" }, false)).toMatchObject({ generate: true });
        expect(await emailHello("bare")).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "no-email-username",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        expect(service.generate).not.toHaveBeenCalled();
        // With a control to sign in with another account, the list is sent for it.
        expect(await h.hello({ documentId: "other" }, false)).toMatchObject({ generate: true });
        expect(await emailHello("other", true)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
        });
        expect(generations()).toContainEqual(
          expect.objectContaining({ outcome: "sent", page: "accounts" }),
        );
        expect(JSON.stringify(fake.state.messages)).not.toContain("risu729");
      });

      it("sends a list by email without a control for another account for an email username", async () => {
        const { service, h, generations } = setup({
          uris: async () => ({
            ok: true,
            data: uriMatch({
              candidates: [itemId, otherItemId].map((id) => ({
                itemId: id,
                matches: [{ uriIndex: 0, match: 0 }],
              })),
            }),
          }),
          otherUsername: true,
        });
        // One matching item's username is an email; the other's is not.
        h.fields.mockImplementation(async ({ fieldId, account }) =>
          fieldId !== "login.username"
            ? "synthetic-secret"
            : account.itemId === itemId
              ? "risu729"
              : "risu@example.com",
        );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(generations()).not.toContainEqual(
          expect.objectContaining({ reason: "no-listed-account" }),
        );
        // Both usernames were read for their shape.
        expect(
          new Set(
            h.fields.mock.calls
              .filter(([request]) => request.fieldId === "login.username")
              .map(([request]) => request.account.itemId),
          ),
        ).toEqual(new Set([itemId, otherItemId]));
      });

      it("logs a complete description without accounts on a list as a mismatch (ADR 0019)", async () => {
        const { service, h, generations } = setup();
        fake.state.extracted = {
          accounts: {
            ok: true,
            observation: page("/signin", listPage.observation.candidates).observation,
          },
        };
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h)).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(
          () =>
            expect(generations()).toEqual([
              {
                type: "generation",
                tabId: 1,
                origin,
                outcome: "skipped",
                reason: "incomplete-observation",
                detail: "list-mismatch",
              },
            ]),
          { timeout: 4_000 },
        );
        expect(service.generate).not.toHaveBeenCalled();
      });

      it("sends a list of names only when one names a matching item's username", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "Risu729" : "synthetic-secret",
        );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await listHello(h, ["Help", "Create new account"])).toMatchObject({
          ok: false,
          reason: "recipe-not-found",
        });
        // A page offered only by its short texts is mostly ordinary browsing: logged at
        // debug level.
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "no-name-match",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        // Another page whose shown text is the username, ignoring case and a leading `@`.
        expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({ generate: true });
        expect(await listHello(h, ["@risu729", "Help"], { documentId: "next-page" })).toEqual({
          ok: false,
          reason: "generating",
        });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        // Only the matching text goes back, to be hidden; the username itself never does.
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
          names: ["@risu729"],
        });
        expect(JSON.stringify(fake.state.messages)).not.toContain("Risu729");
      });

      it("sends a list of names that name no item when it shows a control for another account", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu@example.com" : "synthetic-secret",
        );
        const otherHello = () =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/signin", names: ["taro.yamada", "Help"], other: true },
            },
            sender(),
          );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await otherHello()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        // Every shown text goes back to be hidden, as a possible account name.
        expect(fake.state.messages.find((entry) => entry.type === "login.extract")).toMatchObject({
          page: "accounts",
          names: ["taro.yamada", "Help"],
        });
        expect(generations()).not.toContainEqual(
          expect.objectContaining({ reason: "no-listed-account" }),
        );
        expect(JSON.stringify(fake.state.messages)).not.toContain("risu@example.com");
      });

      it("reads no list on a page whose path holds a matching item's username", async () => {
        const { service, h, generations } = setup();
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu729" : "synthetic-secret",
        );
        // A signed-in page under the account's own name, as a pull request page whose
        // comment shows its author beside its buttons (owner 2026-10-12 19:45 UTC).
        const url = `${origin}/risu729/pateat/pull/1`;
        fake.state.pageUrl = url;
        const pathHello = (list: Record<string, unknown>) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/risu729/pateat/pull/1", ...list },
            },
            sender({ url }),
          );
        expect(await h.hello({ url }, false)).toMatchObject({ generate: true });
        expect(await pathHello({ names: ["risu729", "Edit"] })).toMatchObject({
          ok: false,
          reason: "recipe-not-found",
        });
        // Not even an email list is read there.
        expect(await h.hello({ url, documentId: "email-page" }, false)).toMatchObject({
          generate: true,
        });
        expect(
          await h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/risu729/pateat/pull/1" },
            },
            sender({ url, documentId: "email-page" }),
          ),
        ).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "username-in-path",
          },
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "no-listed-account",
            detail: "username-in-path",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        expect(service.generate).not.toHaveBeenCalled();
        // The usernames were read for the email list too.
        expect(h.fields).toHaveBeenCalledWith(
          expect.objectContaining({ fieldId: "login.username" }),
        );
      });

      it("logs a shown email address that is no entry, and sends only names", async () => {
        const { service, h, generations } = setup();
        const missed = (from: Record<string, unknown>, names?: string[]) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              list: { path: "/signin", ...(names ? { names } : {}), missed: "not-rendered" },
            },
            sender(from),
          );
        expect(await h.hello({}, false)).toMatchObject({ generate: true });
        expect(await missed({})).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(generations()).toEqual([
          {
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "not-a-list",
            detail: "not-rendered",
          },
        ]);
        expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
        // With texts beside buttons, those are still compared with the usernames.
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "risu729" : "synthetic-secret",
        );
        expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({ generate: true });
        expect(await missed({ documentId: "next-page" }, ["risu729"])).toEqual({
          ok: false,
          reason: "generating",
        });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      });

      it("offers no page where a stored list starts, and watches for the list there", async () => {
        const { service, h } = setup();
        const other = { by: "text" as const, value: "Use another profile" };
        h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: [], list: [other] }]);
        expect(await h.hello({}, false)).toEqual({
          ok: false,
          reason: "recipe-not-found",
          starts: [{ path: "/signin", require: "clickable", targets: [other], accounts: true }],
        });
        expect(await listHello(h)).toMatchObject({ ok: false, reason: "recipe-not-found" });
        expect(service.available).not.toHaveBeenCalled();
        expect(service.generate).not.toHaveBeenCalled();
      });

      it("never sends the tab's next page of the origin after a password form was submitted", async () => {
        const { service, h, generations } = setup();
        expect(
          await h.login.handle(
            { version: 1, type: "login.document.submitted", token: "synthetic-token" },
            sender(),
          ),
        ).toBeUndefined();
        expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
          generate: true,
        });
        expect(await listHello(h, undefined, { documentId: "after-sign-in" })).not.toEqual({
          ok: false,
          reason: "generating",
        });
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "after-sign-in" },
        ]);
        // The page after that one may be sent.
        expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ generate: true });
        expect(await listHello(h, undefined, { documentId: "later" })).toEqual({
          ok: false,
          reason: "generating",
        });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      });

      it("never sends the tab's next page as one asking for an identifier alone (ADR 0016)", async () => {
        const { h, generations } = setup();
        const identifierHello = (documentId: string) =>
          h.login.handle(
            {
              version: 1,
              type: "login.document.ready",
              token: "synthetic-token",
              signIn: { path: new URL(fake.state.pageUrl).pathname, identifier: true },
            },
            sender({ documentId }),
          );
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
          generate: true,
        });
        expect(await identifierHello("after-sign-in")).not.toEqual({
          ok: false,
          reason: "generating",
        });
        expect(generations()).toEqual([
          { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "after-sign-in" },
        ]);
        expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ generate: true });
        // The page after that one may be sent.
        expect(await identifierHello("later")).toEqual({ ok: false, reason: "generating" });
      });

      it("sends a list that loads more than a minute after the submission", async () => {
        const { service, h, generations } = setup();
        const at = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(at);
        onTestFinished(() => clock.mockRestore());
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        // A single-page app signed in and out in one document; the reload comes later.
        clock.mockReturnValue(at + 61_000);
        expect(await h.hello({ documentId: "reloaded" }, false)).toMatchObject({ generate: true });
        expect(await listHello(h, undefined, { documentId: "reloaded" })).toEqual({
          ok: false,
          reason: "generating",
        });
        clock.mockRestore();
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(generations()).not.toContainEqual(
          expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
        );
      });

      it.each([
        ["just under a minute", 59_000],
        ["after the clock went back", -1_000],
      ])("still skips a list that loads %s", async (_, offset) => {
        const { service, h, generations } = setup();
        const at = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(at);
        onTestFinished(() => clock.mockRestore());
        await h.login.handle(
          { version: 1, type: "login.document.submitted", token: "synthetic-token" },
          sender(),
        );
        clock.mockReturnValue(at + offset);
        expect(await h.hello({ documentId: "reloaded" }, false)).toMatchObject({ generate: true });
        await listHello(h, undefined, { documentId: "reloaded" });
        expect(generations()).toContainEqual(
          expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
        );
        expect(service.generate).not.toHaveBeenCalled();
      });
    });

    describe("a site's sign-in entry (ADR 0031)", () => {
      const entryUrl = `${origin}/?return_to=%2Fbookmarks`;
      const loginUrl = "https://accounts.login.example/login";
      const entryRecipe: LoginEntryRecipe = {
        version: 1,
        id: "synthetic-entry",
        revision: 2,
        origin,
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      const entryPage = {
        ok: true,
        observation: {
          ...page("/", [
            {
              id: "c1",
              role: "link",
              target: { by: "text", value: "Create account" },
              label: "Create account",
            },
            { id: "c2", role: "link", target: { by: "text", value: "Login" }, label: "Login" },
          ]).observation,
        },
      };
      const inspected = (overrides: Record<string, unknown> = {}) => ({
        ok: true,
        state: "unique",
        href: loginUrl,
        url: fake.state.pageUrl,
        ...overrides,
      });
      /** The document announces, ten seconds after loading, that it shows no sign-in input. */
      const entryHello = (h: ReturnType<typeof harness>, from: Record<string, unknown> = {}) =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            entry: { path: new URL(String(from["url"] ?? fake.state.pageUrl)).pathname },
          },
          sender(from),
        );
      const setup = (
        options: {
          entries?: LoginEntryRecipe[];
          overrides?: Partial<LocalSettings>;
          uris?: LiveUriMatcher;
        } = {},
      ) => {
        fake.state.extracted = { entry: entryPage };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(
          { ...unsaved, ...options.overrides },
          {
            allowedOrigins: [],
            uris: options.uris ?? uris,
            username: true,
            custom: [],
            generation: service,
            report,
            ...(options.entries ? { entries: options.entries } : {}),
          },
        );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        const reports = (type: LoginReport["type"]) =>
          report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === type);
        return { service, h, report, reports };
      };
      const sent = (type: string) =>
        (fake.state.messages as Record<string, unknown>[]).filter(
          (entry) => entry["type"] === type,
        );
      const blocks = () => fake.state.storage["pateat.login-entry-blocks.v1"];
      const presses = () => fake.state.session["pateat.login-entry-presses.v1"];
      beforeEach(() => {
        fake.state.pageUrl = entryUrl;
        fake.state.entry = {
          hosts: { ok: true, hosts: ["login.example", "accounts.login.example", "other.example"] },
          inspect: undefined,
          press: { ok: true },
          check: { ok: true, signIn: true, start: false, signUp: false },
        };
        fake.state.onPress = undefined;
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      describe("sending the page", () => {
        it("sends a page whose URL names another path of its site, without slots", async () => {
          const { service, h, reports } = setup();
          expect(await h.hello({}, false)).toEqual({
            ok: false,
            reason: "recipe-not-found",
            starts: [],
            generate: true,
            entry: true,
          });
          service.generateEntry.mockImplementation(async (_request, sentNow) => {
            sentNow?.();
            return { outcome: "recipe", recipe: entryRecipe };
          });
          expect(await entryHello(h)).toEqual({ ok: false, reason: "generating" });
          await vi.waitFor(() => expect(sent("login.reconnect")).toHaveLength(1));
          // Only the hosts on the page's site go back to the extractor.
          expect(sent("login.extract")).toEqual([
            expect.objectContaining({
              page: "entry",
              onSite: ["login.example", "accounts.login.example"],
            }),
          ]);
          expect(service.generateEntry).toHaveBeenCalledWith(
            { version: 1, observation: entryPage.observation },
            expect.any(Function),
          );
          expect(service.generate).not.toHaveBeenCalled();
          // Nothing of the vault is read for the page.
          expect(h.fields).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            { type: "generation", tabId: 1, origin, outcome: "sent", page: "entry" },
            { type: "generation", tabId: 1, origin, outcome: "recipe", page: "entry" },
          ]);
        });

        it.each([
          // entry.test.ts reads every other kind of return target.
          ["the bare top page", `${origin}/`],
          ["another site's URL", `${origin}/?return_to=https%3A%2F%2Fevil.example%2Fx`],
        ])("offers no entry for %s, and logs a page announced anyway", async (_label, url) => {
          fake.state.pageUrl = url;
          const { service, h, reports } = setup();
          const readiness = await h.hello({}, false);
          expect(readiness).toMatchObject({ generate: true });
          expect(readiness).not.toHaveProperty("entry");
          expect(await entryHello(h)).toMatchObject({ ok: false, reason: "recipe-not-found" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            {
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason: "no-return-target",
              page: "entry",
            },
          ]);
        });

        it("offers the page again once a return target names another host of the site", async () => {
          fake.state.pageUrl = `${origin}/?return_to=https%3A%2F%2Faccounts.login.example%2Fsettings`;
          const { h } = setup();
          expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
        });

        it.each([
          [
            "no vault item matches",
            { uris: async () => ({ ok: true as const, data: uriMatch({ candidates: [] }) }) },
            "no-vault-match",
          ],
        ] as const)("sends nothing when %s", async (_label, options, reason) => {
          const { service, h, reports } = setup(options);
          expect(await h.hello({}, false)).toMatchObject({ entry: true });
          expect(await entryHello(h)).toMatchObject({ ok: false, reason: "recipe-not-found" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason, page: "entry" }),
          ]);
        });

        it("sends nothing while any tab keeps a logout of the site", async () => {
          fake.state.session["pateat.login-logouts.v1"] = [
            { tabId: 2, origin: "https://accounts.login.example" },
          ];
          const { service, h, reports } = setup();
          expect(await h.hello({}, false)).toMatchObject({ entry: true });
          await entryHello(h);
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "logged-out" }),
          ]);
        });

        it("never sends the tab's next page of the origin after a password form was submitted", async () => {
          const { service, h, reports } = setup();
          await h.login.handle(
            { version: 1, type: "login.document.submitted", token: "synthetic-token" },
            sender(),
          );
          expect(await h.hello({ documentId: "after-sign-in" }, false)).toMatchObject({
            entry: true,
          });
          await entryHello(h, { documentId: "after-sign-in" });
          expect(service.generateEntry).not.toHaveBeenCalled();
          expect(reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
          ]);
          // The page after that one may be sent.
          expect(await h.hello({ documentId: "later" }, false)).toMatchObject({ entry: true });
          expect(await entryHello(h, { documentId: "later" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledTimes(1));
        });

        it("sends no page that is held in the retry window or lists no link", async () => {
          const held = setup();
          held.service.available.mockResolvedValue("sent");
          expect(await held.h.hello({}, false)).not.toHaveProperty("entry");
          expect(held.reports("generation")).toEqual([
            expect.objectContaining({ outcome: "skipped", reason: "sent" }),
          ]);
          const buttons = setup();
          fake.state.extracted = {
            entry: {
              ok: true,
              observation: {
                ...page("/", [
                  {
                    id: "c1",
                    role: "button",
                    target: { by: "text", value: "Menu" },
                    label: "Menu",
                  },
                ]).observation,
              },
            },
          };
          expect(await buttons.h.hello({ documentId: "buttons" }, false)).toMatchObject({
            entry: true,
          });
          expect(await entryHello(buttons.h, { documentId: "buttons" })).toEqual({
            ok: false,
            reason: "generating",
          });
          await vi.waitFor(() =>
            expect(buttons.reports("generation")).toEqual([
              expect.objectContaining({ outcome: "skipped", reason: "no-entry-link" }),
            ]),
          );
          expect(buttons.service.generateEntry).not.toHaveBeenCalled();
        });

        it.each([
          // A description with a field is no entry page.
          ["/", true, "not-entry"],
          // One of another path describes another page.
          ["/other", false, "path-changed"],
        ] as const)(
          "logs why a described entry page is not sent (%s, ADR 0019)",
          async (path, withField, detail) => {
            const link = {
              id: "c1",
              role: "link",
              target: { by: "text", value: "Log in" },
              label: "Log in",
            };
            const field = { id: "c2", role: "text", target: { by: "id", value: "q" } };
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: page(path, withField ? [link, field] : [link]) };
            expect(await h.hello({}, false)).toMatchObject({ entry: true });
            await entryHello(h);
            await vi.waitFor(() =>
              expect(reports("generation")).toEqual([
                expect.objectContaining({
                  outcome: "skipped",
                  reason: "incomplete-observation",
                  page: "entry",
                  detail,
                }),
              ]),
            );
            expect(service.generateEntry).not.toHaveBeenCalled();
          },
        );

        it("counts an entry recipe's path as a recipe start, so the page is never sent", async () => {
          fake.state.entry.inspect = inspected();
          const { service, h } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          expect(service.available).not.toHaveBeenCalled();
          expect(service.generateEntry).not.toHaveBeenCalled();
        });

        describe("on a page that also lists accounts (ADR 0028)", () => {
          const listPage = {
            ok: true,
            observation: { ...entryPage.observation, accounts: ["[account]"] },
          };
          /** The document announces both a list of accounts and a page without a sign-in input. */
          const bothHello = (
            h: ReturnType<typeof harness>,
            names?: string[],
            from: Record<string, unknown> = {},
          ) =>
            h.login.handle(
              {
                version: 1,
                type: "login.document.ready",
                token: "synthetic-token",
                list: { path: "/", ...(names ? { names } : {}) },
                entry: { path: "/" },
              },
              sender(from),
            );

          it("sends a page that lists an account by email as a list, never also as an entry", async () => {
            const { service, h, reports } = setup();
            // A list by email is sent for an email username (ADR 0028).
            h.fields.mockImplementation(async ({ fieldId }) =>
              fieldId === "login.username" ? "risu@example.com" : "synthetic-secret",
            );
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            expect(await bothHello(h)).toEqual({ ok: false, reason: "generating" });
            await vi.waitFor(() => expect(reports("generation")).toHaveLength(2));
            expect(sent("login.extract")).toEqual([expect.objectContaining({ page: "accounts" })]);
            expect(service.generate).toHaveBeenCalledTimes(1);
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(reports("generation")).toEqual([
              expect.objectContaining({ outcome: "sent", page: "accounts" }),
              expect.objectContaining({ outcome: "abstained", page: "accounts" }),
            ]);
          });

          it("sends neither a list nor an entry on a page whose path holds the username", async () => {
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            fake.state.pageUrl = `${origin}/risu729?return_to=%2Fbookmarks`;
            h.fields.mockImplementation(async ({ fieldId }) =>
              fieldId === "login.username" ? "risu729" : "synthetic-secret",
            );
            const pathHello = (names: string[]) =>
              h.login.handle(
                {
                  version: 1,
                  type: "login.document.ready",
                  token: "synthetic-token",
                  list: { path: "/risu729", names },
                  entry: { path: "/risu729" },
                },
                sender(),
              );
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            // Whether a shown text names the item or not (owner 2026-10-12 19:45 UTC).
            expect(await pathHello(["risu729", "Edit"])).toMatchObject({ ok: false });
            expect(await h.hello({ documentId: "next-page" }, false)).toMatchObject({
              generate: true,
            });
            expect(
              await h.login.handle(
                {
                  version: 1,
                  type: "login.document.ready",
                  token: "synthetic-token",
                  list: { path: "/risu729", names: ["Edit"] },
                  entry: { path: "/risu729" },
                },
                sender({ documentId: "next-page" }),
              ),
            ).toMatchObject({ ok: false });
            expect(service.generate).not.toHaveBeenCalled();
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(sent("login.extract")).toEqual([]);
            expect(reports("generation")).toEqual([
              expect.objectContaining({
                outcome: "skipped",
                reason: "no-listed-account",
                detail: "username-in-path",
              }),
              expect.objectContaining({
                outcome: "skipped",
                reason: "no-listed-account",
                detail: "username-in-path",
              }),
            ]);
          });

          it("sends the page as an entry when no listed short text names a matching item", async () => {
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            h.fields.mockImplementation(async ({ fieldId }) =>
              fieldId === "login.username" ? "synthetic-user" : "synthetic-secret",
            );
            expect(await h.hello({}, false)).toMatchObject({ generate: true, entry: true });
            expect(await bothHello(h, ["Help", "Create account"])).toEqual({
              ok: false,
              reason: "generating",
            });
            await vi.waitFor(() => expect(service.generateEntry).toHaveBeenCalledTimes(1));
            expect(service.generate).not.toHaveBeenCalled();
            expect(sent("login.extract")).toEqual([expect.objectContaining({ page: "entry" })]);
            await vi.waitFor(() => expect(reports("generation")).toHaveLength(3));
            expect(reports("generation")).toEqual([
              // At debug level: the short texts named no item.
              expect.objectContaining({
                outcome: "skipped",
                reason: "no-listed-account",
                detail: "no-name-match",
              }),
              expect.objectContaining({ outcome: "sent", page: "entry" }),
              expect.objectContaining({ outcome: "abstained", page: "entry" }),
            ]);
          });

          it("sends neither after a password form was submitted, logging it once", async () => {
            const { service, h, reports } = setup();
            fake.state.extracted = { entry: entryPage, accounts: listPage };
            await h.login.handle(
              { version: 1, type: "login.document.submitted", token: "synthetic-token" },
              sender(),
            );
            const from = { documentId: "after-sign-in" };
            expect(await h.hello(from, false)).toMatchObject({ entry: true });
            expect(await bothHello(h, ["Help"], from)).not.toEqual({
              ok: false,
              reason: "generating",
            });
            expect(service.generate).not.toHaveBeenCalled();
            expect(service.generateEntry).not.toHaveBeenCalled();
            expect(sent("login.extract")).toEqual([]);
            expect(reports("generation")).toEqual([
              expect.objectContaining({ outcome: "skipped", reason: "after-sign-in" }),
            ]);
          });
        });
      });

      describe("pressing the entry", () => {
        it("presses the one on-site link after its checks and stores the press first", async () => {
          fake.state.entry.inspect = inspected();
          let stored: unknown;
          fake.state.onPress = () => {
            stored = presses();
          };
          const { h, reports } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "pressed",
            },
          ]);
          expect(sent("login.entry.inspect")).toEqual([
            expect.objectContaining({ target: entryRecipe.entry.target, timeoutMs: 10_000 }),
          ]);
          expect(sent("login.entry.press")).toEqual([
            expect.objectContaining({
              target: entryRecipe.entry.target,
              href: loginUrl,
              url: entryUrl,
            }),
          ]);
          expect(stored).toEqual([
            {
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              revision: 2,
              pressedAt: expect.any(String),
              documentId: "synthetic-document",
              url: entryUrl,
            },
          ]);
          // The press is no attempt: nothing is recorded, held or read from the vault.
          expect(fake.state.storage["pateat.login-attempts.v4"] ?? []).toEqual([]);
          expect(h.fields).not.toHaveBeenCalled();
        });

        it.each([
          ["a page that names no return target", { url: `${origin}/` }, "no-return-target"],
          ["a missing link", { inspect: { state: "missing" } }, "target-missing"],
          ["a link named twice", { inspect: { state: "ambiguous" } }, "target-ambiguous"],
          ["a button", { inspect: { refusal: "not-link", href: undefined } }, "not-link"],
          ["a script link", { inspect: { refusal: "script-link" } }, "script-link"],
          ["a link that opens a new tab", { inspect: { refusal: "new-window" } }, "new-window"],
          ["a link with only an image", { inspect: { refusal: "no-text" } }, "no-text"],
          [
            "an `http:` link",
            { inspect: { href: "http://accounts.login.example/login" } },
            "link-not-https",
          ],
          [
            "a link to another site",
            { inspect: { href: "https://other.example/login" } },
            "link-off-site",
          ],
          [
            "a link naming another site in its query",
            { inspect: { href: `${loginUrl}?next=%2F%5Cevil.example%2F` } },
            "link-query-off-site",
          ],
          [
            "a page whose URL changed while it was inspected",
            { inspect: { url: `${origin}/` } },
            "no-return-target",
          ],
          [
            "a destination on an excluded site",
            {
              overrides: {
                excludedSites: [{ hostname: "accounts.login.example", includeSubdomains: false }],
              },
            },
            "destination-excluded",
          ],
          [
            "no vault item matching the page",
            { uris: async () => ({ ok: true as const, data: uriMatch({ candidates: [] }) }) },
            "no-vault-match",
          ],
          [
            "a logout of the site kept in another tab",
            { logout: { tabId: 2, origin: "https://accounts.login.example" } },
            "logged-out",
          ],
          [
            "a blocked revision",
            {
              block: {
                recipeId: "synthetic-entry",
                revision: 2,
                reason: "sign-up",
                blockedAt: "2026-10-12T07:30:04.000Z",
              },
            },
            "blocked",
          ],
          [
            "a link the page changed before the click",
            { press: { ok: false, reason: "target-changed" } },
            "target-changed",
          ],
          [
            "a page that navigated between the check and the click",
            { press: { ok: false, reason: "page-changed" } },
            "page-changed",
          ],
          [
            "a document that went away before the click",
            { press: { ok: false, reason: "cancelled" } },
            "cancelled",
          ],
          [
            "a page inspected on another origin of the site",
            { inspect: { url: "https://accounts.login.example/?return_to=%2Fbookmarks" } },
            "page-changed",
          ],
          [
            "a page inspected on another path of the origin",
            { inspect: { url: `${origin}/other?return_to=%2Fbookmarks` } },
            "page-changed",
          ],
          [
            "a link whose userinfo names the site",
            { inspect: { href: "https://login.example@other.example/login" } },
            "link-off-site",
          ],
          [
            "a link naming another site in a second query value",
            { inspect: { href: `${loginUrl}?next=%2Fok&next=https%3A%2F%2Fother.example%2F` } },
            "link-query-off-site",
          ],
          [
            "a link whose `href` does not parse",
            { inspect: { href: "not a URL" } },
            "link-off-site",
          ],
          [
            "a link to the page itself, only at another fragment",
            { inspect: { href: `${entryUrl}#login` } },
            "link-same-page",
          ],
          [
            "a link whose query key names another site",
            { inspect: { href: `${loginUrl}?https%3A%2F%2Fother.example%2F` } },
            "link-query-off-site",
          ],
          ["a link that downloads", { inspect: { refusal: "download" } }, "download"],
        ] as const)("refuses %s, logging why", async (_label, options, reason) => {
          const option = options as {
            url?: string;
            inspect?: Record<string, unknown>;
            overrides?: Partial<LocalSettings>;
            uris?: LiveUriMatcher;
            logout?: { tabId: number; origin: string };
            block?: Record<string, unknown>;
            press?: unknown;
          };
          if (option.url) fake.state.pageUrl = option.url;
          fake.state.entry.inspect = inspected(option.inspect);
          if (option.press) fake.state.entry.press = option.press;
          if (option.logout) fake.state.session["pateat.login-logouts.v1"] = [option.logout];
          if (option.block) fake.state.storage["pateat.login-entry-blocks.v1"] = [option.block];
          const { h, reports } = setup({
            entries: [entryRecipe],
            ...(option.overrides ? { overrides: option.overrides } : {}),
            ...(option.uris ? { uris: option.uris } : {}),
          });
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "refused",
              reason,
            },
          ]);
          expect(sent("login.entry.press")).toHaveLength(option.press ? 1 : 0);
          // A press that clicked nothing does not count against the tab's limit.
          expect(presses() ?? []).toEqual([]);
        });

        it("refuses a press while the recipe changed or a frame announces", async () => {
          fake.state.entry.inspect = inspected();
          const { h, reports } = setup({ entries: [entryRecipe] });
          // A frame never presses; it gets no entry recipe at all.
          expect(
            await h.hello(
              { frameId: 3, documentId: "frame", tab: { id: 1, url: entryUrl } },
              false,
            ),
          ).toEqual({ ok: false, reason: "recipe-not-found" });
          expect(sent("login.entry.inspect")).toEqual([]);
          // The cache moved on to a newer revision before the press.
          h.recipes.entries.mockResolvedValueOnce([entryRecipe]);
          h.recipes.entries.mockResolvedValue([{ ...entryRecipe, revision: 3 }]);
          expect(await h.hello({}, false)).toEqual({ ok: false, reason: "entry", starts: [] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")[0]).toMatchObject({
            outcome: "refused",
            reason: "recipe-changed",
          });
        });

        describe("with a login of the site", () => {
          const saved = {
            siteDefaults: [{ origin, provider: "bitwarden" as const, userId, itemId }],
            bindings: [savedBinding],
          };
          const signin = `${origin}/signin`;
          const withLogin = () => {
            fake.state.entry.inspect = inspected();
            const context = setup({ entries: [entryRecipe], overrides: saved });
            context.h.recipes.recipe.mockImplementation(async (_at, path) =>
              path === "/signin" ? recipe : undefined,
            );
            context.h.recipes.starts.mockResolvedValue(startsOf([recipe.steps[0]!]));
            return context;
          };

          it("refuses a press in a tab that already ran a login on the site", async () => {
            // The entry page is another origin of the login's site.
            const www = "https://www.login.example";
            const wwwEntry = { ...entryRecipe, origin: www };
            fake.state.entry.inspect = inspected({ url: `${www}/?return_to=%2Fbookmarks` });
            const context = setup({
              entries: [wwwEntry],
              overrides: saved,
              uris: async (_connection, url) => ({
                ok: true,
                data: uriMatch({ targetOrigin: new URL(url).origin }),
              }),
            });
            const { h, reports } = context;
            h.recipes.recipe.mockImplementation(async (at, path) =>
              at === origin && path === "/signin" ? recipe : undefined,
            );
            h.recipes.starts.mockImplementation(async (at) =>
              at === origin ? startsOf([recipe.steps[0]!]) : [],
            );
            fake.state.tabUrls[1] = signin;
            expect(await h.hello({ documentId: "login", url: signin })).toEqual({ ok: true });
            await vi.waitFor(() =>
              expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
                { state: "authenticated" },
              ]),
            );
            const entryAt = `${www}/?return_to=%2Fbookmarks`;
            fake.state.tabUrls[1] = entryAt;
            expect(await h.hello({ documentId: "entry", url: entryAt }, false)).toMatchObject({
              reason: "entry",
            });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              origin: www,
              outcome: "refused",
              reason: "site-record",
            });
          });

          it("refuses a press while another tab's login holds the site", async () => {
            const { h, reports } = withLogin();
            // The other tab's login stays on its first step.
            fake.state.onExecute = () => new Promise(() => undefined);
            fake.state.tabUrls[2] = signin;
            await h.hello({ tab: { id: 2 }, documentId: "login", url: signin });
            await vi.waitFor(() => expect(sent("login.execute")).toHaveLength(1));
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({ outcome: "refused", reason: "site-held" });
          });
        });

        it("presses at most once per tab in 10 minutes", async () => {
          const recent = new Date(Date.now() - 5 * 60_000).toISOString();
          const old = new Date(Date.now() - 11 * 60_000).toISOString();
          const stored = (pressedAt: string) => [
            {
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              revision: 2,
              pressedAt,
              documentId: "earlier-document",
              url: entryUrl,
              checked: true,
            },
          ];
          fake.state.entry.inspect = inspected();
          fake.state.session["pateat.login-entry-presses.v1"] = stored(recent);
          const limited = setup({ entries: [entryRecipe] });
          expect(await limited.h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(limited.reports("entry")).toHaveLength(1));
          expect(limited.reports("entry")[0]).toMatchObject({
            outcome: "refused",
            reason: "press-limit",
          });
          // Another tab is not limited by this one's press.
          expect(
            await limited.h.hello({ tab: { id: 2 }, documentId: "other-tab" }, false),
          ).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(limited.reports("entry")).toHaveLength(2));
          expect(limited.reports("entry")[1]).toMatchObject({ tabId: 2, outcome: "pressed" });
          for (const listener of fake.state.removed.splice(0))
            for (const tab of [1, 2]) listener(tab);
          fake.state.session = { "pateat.login-entry-presses.v1": stored(old) };
          const later = setup({ entries: [entryRecipe] });
          expect(await later.h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(later.reports("entry")).toHaveLength(1));
          expect(later.reports("entry")[0]).toMatchObject({ outcome: "pressed" });
        });

        it("refuses another document's press while one is checked, and logs a refusal once", async () => {
          let release!: () => void;
          fake.state.entry.inspect = new Promise((resolve) => {
            release = () => resolve(inspected({ state: "missing" }));
          });
          const { h, reports } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          // The same document announcing again leaves the running check alone.
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          expect(await h.hello({ documentId: "next" }, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")[0]).toMatchObject({ outcome: "refused", reason: "in-progress" });
          // The first document was replaced meanwhile, so its press stops without a click.
          release();
          await vi.waitFor(() => expect(sent("login.entry.inspect")).toHaveLength(1));
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(sent("login.entry.press")).toEqual([]);
          expect(reports("entry")).toHaveLength(1);
        });

        it("takes a press the page never answered as none, checks no next page and limits the tab", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          fake.state.entry.inspect = inspected();
          // The document gave no answer to the press, so nothing says the link was clicked.
          fake.state.onPress = () => {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          };
          const { h, reports } = setup({ entries: [entryRecipe] });
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "refused",
              reason: "unconfirmed",
            },
          ]);
          // It still counts against the tab's limit, but no check of a next page is due.
          expect(presses()).toEqual([
            expect.objectContaining({ tabId: 1, recipeId: entryRecipe.id, checked: true }),
          ]);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(reports("entry")).toHaveLength(1);
          expect(blocks()).toBeUndefined();
          fake.state.onPress = undefined;
          fake.state.pageUrl = loginUrl;
          await h.hello({ documentId: "next-page", url: loginUrl }, false);
          expect(sent("login.entry.check")).toEqual([]);
          // The tab comes back to the entry page in a new document: the same worker refuses.
          fake.state.pageUrl = entryUrl;
          expect(await h.hello({ documentId: "back-again" }, false)).toMatchObject({
            reason: "entry",
          });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "refused", reason: "press-limit" });
          expect(sent("login.entry.press")).toHaveLength(1);
        });

        it("logs a refusal the document repeats as a repeat, and a new document's afresh", async () => {
          fake.state.entry.inspect = inspected({ state: "missing" });
          const { h, reports } = setup({ entries: [entryRecipe] });
          const refusal = {
            type: "entry",
            tabId: 1,
            origin,
            recipeId: entryRecipe.id,
            recipeRevision: 2,
            outcome: "refused",
            reason: "target-missing",
          };
          for (const [count, documentId] of [
            [1, "synthetic-document"],
            [2, "synthetic-document"],
            [3, "other-document"],
          ] as const) {
            // eslint-disable-next-line no-await-in-loop
            expect(await h.hello({ documentId }, false)).toMatchObject({ reason: "entry" });
            // eslint-disable-next-line no-await-in-loop
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(count));
          }
          expect(reports("entry")).toEqual([refusal, { ...refusal, repeat: true }, refusal]);
        });

        it("logs why it stops when the tab cannot be read or shows another origin", async () => {
          fake.state.entry.inspect = inspected();
          const { h, reports } = setup({ entries: [entryRecipe] });
          // Every read of the tab after the entry recipe was looked up is the press's.
          let failing = false;
          const entries = h.recipes.entries.getMockImplementation()!;
          h.recipes.entries.mockImplementation(async (at) => {
            const found = await entries(at);
            if (found.length) failing = true;
            return found;
          });
          const get = fake.browser.tabs.get;
          const read = vi.spyOn(fake.browser.tabs, "get").mockImplementation(async (id: number) => {
            if (failing) throw new Error("No tab with id.");
            return get(id);
          });
          try {
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "tab-unavailable",
            });
          } finally {
            read.mockRestore();
          }
          // The tab already shows another origin when the press starts.
          h.recipes.entries.mockImplementation(async (at) => {
            const found = await entries(at);
            if (found.length) fake.state.tabUrls[1] = "https://other.example/";
            return found;
          });
          expect(await h.hello({ documentId: "moved" }, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "refused", reason: "page-changed" });
          expect(sent("login.entry.inspect")).toEqual([]);
        });

        it("refuses, logging why, when the device's blocks cannot be read, and reads them again", async () => {
          fake.state.entry.inspect = inspected();
          const local = fake.browser.storage.local;
          const get = local.get;
          const failing = vi
            .spyOn(local, "get")
            .mockImplementation(async (keys: string | string[]) =>
              [keys].flat().includes("pateat.login-entry-blocks.v1")
                ? Promise.reject(new Error("storage unavailable"))
                : get(keys),
            );
          try {
            const { h, reports } = setup({ entries: [entryRecipe] });
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "storage-unavailable",
            });
            expect(sent("login.entry.inspect")).toEqual([]);
            failing.mockRestore();
            // A failed read is not kept: the next document reads the blocks again.
            expect(await h.hello({ documentId: "later" }, false)).toMatchObject({
              reason: "entry",
            });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
            expect(reports("entry")[1]).toMatchObject({ outcome: "pressed" });
          } finally {
            failing.mockRestore();
          }
        });

        it("refuses, logging why, when the press cannot be stored, and clicks nothing", async () => {
          fake.state.entry.inspect = inspected();
          const session = fake.browser.storage.session;
          const set = session.set;
          const failing = vi
            .spyOn(session, "set")
            .mockImplementation(async (values: Record<string, unknown>) =>
              Array.isArray(values["pateat.login-entry-presses.v1"]) &&
              (values["pateat.login-entry-presses.v1"] as unknown[]).length > 0
                ? Promise.reject(new Error("storage unavailable"))
                : set(values),
            );
          try {
            const { h, reports } = setup({ entries: [entryRecipe] });
            expect(await h.hello({}, false)).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
            expect(reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "storage-unavailable",
            });
            expect(sent("login.entry.press")).toEqual([]);
            expect(presses() ?? []).toEqual([]);
          } finally {
            failing.mockRestore();
          }
        });
      });

      describe("the page after the press", () => {
        /** Presses the entry and returns once the press is logged. */
        const pressed = async (options: Parameters<typeof setup>[0] = {}) => {
          fake.state.entry.inspect = inspected();
          const context = setup({ entries: [entryRecipe], ...options });
          expect(await context.h.hello({}, false)).toMatchObject({ reason: "entry" });
          await vi.waitFor(() =>
            expect(context.reports("entry")).toEqual([
              expect.objectContaining({ outcome: "pressed" }),
            ]),
          );
          return context;
        };
        const next = { documentId: "next-page", url: loginUrl } as const;

        it("lets a login page of the site go on as any login page", async () => {
          const { h, reports } = await pressed();
          fake.state.pageUrl = loginUrl;
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toEqual([
            expect.objectContaining({ starts: [], timeoutMs: 10_000 }),
          ]);
          expect(reports("entry")).toHaveLength(1);
          expect(blocks()).toBeUndefined();
          expect(presses()).toEqual([expect.objectContaining({ checked: true })]);
          // Checked once: the next announcement is not checked again.
          await h.hello(next, false);
          expect(sent("login.entry.check")).toHaveLength(1);
        });

        it.each([
          [
            "a sign-up form",
            { url: loginUrl, check: { ok: true, signIn: true, start: false, signUp: true } },
            "sign-up",
          ],
          [
            "a page without a sign-in input",
            { url: loginUrl, check: { ok: true, signIn: false, start: false, signUp: false } },
            "no-sign-in",
          ],
          ["another site", { url: "https://other.example/oauth" }, "left-site"],
        ] as const)(
          "blocks the revision on %s and never sends that page",
          async (_label, option, reason) => {
            const { h, reports, service } = await pressed();
            if ("check" in option) fake.state.entry.check = option.check;
            fake.state.pageUrl = option.url;
            expect(await h.hello({ ...next, url: option.url }, false)).toMatchObject({
              ok: false,
              reason: "entry-blocked",
            });
            expect(reports("entry")[1]).toEqual({
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "blocked",
              reason,
            });
            expect(blocks()).toEqual([
              { recipeId: entryRecipe.id, revision: 2, reason, blockedAt: expect.any(String) },
            ]);
            // The blocked page is refused on each announcement, never offered for generation.
            expect(
              await h.login.handle(
                {
                  version: 1,
                  type: "login.document.ready",
                  token: "synthetic-token",
                  signIn: { path: new URL(option.url).pathname },
                },
                sender({ ...next, url: option.url }),
              ),
            ).toMatchObject({ reason: "entry-blocked" });
            expect(service.available).not.toHaveBeenCalled();
            // The blocked revision is not pressed again, even after the tab's limit.
            for (const listener of fake.state.removed.splice(0)) listener(1);
            fake.state.pageUrl = entryUrl;
            fake.state.messages = [];
            const again = setup({ entries: [entryRecipe] });
            expect(await again.h.hello({ documentId: "again" }, false)).toMatchObject({
              reason: "entry",
            });
            await vi.waitFor(() => expect(again.reports("entry")).toHaveLength(1));
            expect(again.reports("entry")[0]).toMatchObject({
              outcome: "refused",
              reason: "blocked",
            });
            expect(sent("login.entry.press")).toEqual([]);
          },
        );

        it("takes a same-document URL change as the next page", async () => {
          const { h, reports } = await pressed();
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
          fake.state.pageUrl = `${origin}/?return_to=%2Fbookmarks#login`;
          expect(await h.hello({}, false)).toMatchObject({ reason: "entry-blocked" });
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
        });

        it("blocks a press whose tab showed no next page within 10 seconds", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { reports } = await pressed();
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
          expect(blocks()).toEqual([expect.objectContaining({ reason: "no-sign-in" })]);
        });

        it("blocks a press whose tab went to another site without announcing", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { reports } = await pressed();
          fake.state.tabUrls[1] = "https://other.example/excluded";
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "left-site" });
        });

        it("checks the next page of a press a restarted worker finds in the session", async () => {
          await pressed();
          // A new worker reads the press the old one stored; the old one is never asked again.
          fake.state.messages = [];
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: true };
          const restarted = setup({ entries: [entryRecipe] });
          fake.state.pageUrl = loginUrl;
          expect(await restarted.h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
          expect(restarted.reports("entry")).toEqual([
            expect.objectContaining({ outcome: "blocked", reason: "sign-up" }),
          ]);
        });

        it("checks only the pressing tab's top document after the pressed page", async () => {
          const { h, reports } = await pressed();
          fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
          // The pressed document announcing again on the pressed URL is not the next page.
          await h.hello({}, false);
          // Nor is a frame of the tab, or a page of the site in another tab.
          fake.state.pageUrl = loginUrl;
          await h.hello(
            { frameId: 3, documentId: "frame", url: loginUrl, tab: { id: 1, url: loginUrl } },
            false,
          );
          fake.state.tabUrls[2] = loginUrl;
          expect(
            await h.hello({ tab: { id: 2 }, documentId: "other-tab", url: loginUrl }, false),
          ).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toEqual([]);
          expect(blocks()).toBeUndefined();
          expect(presses()).toEqual([expect.not.objectContaining({ checked: true })]);
          expect(reports("entry")).not.toContainEqual(
            expect.objectContaining({ outcome: "blocked" }),
          );
          // The tab's own next top document is still checked.
          fake.state.entry.check = { ok: true, signIn: true, start: false, signUp: false };
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toHaveLength(1);
          expect(presses()).toEqual([expect.objectContaining({ checked: true })]);
        });

        it("blocks only the pressed revision of its recipe, and presses a newer revision", async () => {
          const blockedAt = "2026-10-12T07:00:00.000Z";
          const otherBlock = {
            recipeId: "other-entry",
            revision: 2,
            reason: "left-site",
            blockedAt,
          };
          // A block of an older revision of the same recipe, and one of another recipe.
          fake.state.storage["pateat.login-entry-blocks.v1"] = [
            otherBlock,
            { recipeId: entryRecipe.id, revision: 1, reason: "sign-up", blockedAt },
          ];
          const { h, reports } = await pressed();
          fake.state.entry.check = { ok: true, signIn: true, start: false, signUp: true };
          fake.state.pageUrl = loginUrl;
          expect(await h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
          // The older revision's block gives way; the other recipe's block stays.
          expect(blocks()).toEqual([
            otherBlock,
            {
              recipeId: entryRecipe.id,
              revision: 2,
              reason: "sign-up",
              blockedAt: expect.any(String),
            },
          ]);
          // The recipe sync brings revision 3, which the block of revision 2 does not hold.
          h.recipes.entries.mockResolvedValue([{ ...entryRecipe, revision: 3 }]);
          fake.state.pageUrl = entryUrl;
          fake.state.tabUrls[2] = entryUrl;
          expect(
            await h.hello({ tab: { id: 2 }, documentId: "revision-3", url: entryUrl }, false),
          ).toMatchObject({ reason: "entry" });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(3));
          expect(reports("entry")[2]).toMatchObject({
            tabId: 2,
            recipeRevision: 3,
            outcome: "pressed",
          });
        });

        it("checks in time a press a restarted worker finds unchecked, and leaves a checked one", async () => {
          const pressedAt = new Date(Date.now() - 30_000).toISOString();
          const press = (tabId: number, checked: boolean) => ({
            tabId,
            origin,
            recipeId: entryRecipe.id,
            revision: 2,
            pressedAt,
            documentId: `pressed-${tabId}`,
            url: entryUrl,
            ...(checked ? { checked: true } : {}),
          });
          fake.state.session["pateat.login-entry-presses.v1"] = [press(1, false), press(2, true)];
          // Both tabs still show the pressed page; no next page announced before the restart.
          const { reports } = setup({ entries: [entryRecipe] });
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(1));
          expect(reports("entry")).toEqual([
            {
              type: "entry",
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              recipeRevision: 2,
              outcome: "blocked",
              reason: "no-sign-in",
            },
          ]);
          expect(presses()).toEqual([
            expect.objectContaining({ tabId: 1, checked: true }),
            expect.objectContaining({ tabId: 2, checked: true }),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(reports("entry")).toHaveLength(1);
        });

        it("settles a press whose next page's check was lost, once the timer comes due again", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { h, reports } = await pressed();
          let fail!: () => void;
          fake.state.entry.check = new Promise((_resolve, reject) => {
            fail = () => reject(new Error("Receiving end does not exist."));
          });
          fake.state.pageUrl = loginUrl;
          const answer = h.hello(next, false);
          await vi.waitFor(() => expect(sent("login.entry.check")).toHaveLength(1));
          // The press's timer comes due while the check runs and leaves the press to it.
          await vi.advanceTimersByTimeAsync(15_000);
          expect(reports("entry")).toHaveLength(1);
          fail();
          expect(await answer).not.toMatchObject({ reason: "entry-blocked" });
          // The tab shows another page of the site, which gets the step wait once more.
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toEqual({
            type: "entry",
            tabId: 1,
            origin,
            recipeId: entryRecipe.id,
            recipeRevision: 2,
            outcome: "blocked",
            reason: "no-sign-in",
          });
          expect(blocks()).toEqual([expect.objectContaining({ reason: "no-sign-in" })]);
        });

        it("settles a press as no-sign-in when its next page comes too late, but lets that page go on", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { h, reports } = await pressed();
          // The clock moves past the press's wait and the step wait before any timer runs.
          vi.setSystemTime(Date.now() + 25_000);
          fake.state.pageUrl = loginUrl;
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toEqual([]);
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
          expect(blocks()).toEqual([expect.objectContaining({ reason: "no-sign-in" })]);
          expect(await h.hello(next, false)).not.toMatchObject({ reason: "entry-blocked" });
          expect(reports("entry")).toHaveLength(2);
        });

        it("lets a page on another site that comes too late go on, and settles the press as no-sign-in", async () => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { h, reports } = await pressed();
          vi.setSystemTime(Date.now() + 25_000);
          const elsewhere = "https://other.example/oauth";
          fake.state.pageUrl = elsewhere;
          expect(await h.hello({ ...next, url: elsewhere }, false)).not.toMatchObject({
            reason: "entry-blocked",
          });
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
        });

        it.each([
          ["no URL yet", ""],
          ["a URL that does not parse", "not a URL"],
        ])("waits once more for a tab with %s, then blocks the press", async (_label, url) => {
          vi.useFakeTimers({ shouldAdvanceTime: true });
          const { reports } = await pressed();
          fake.state.tabUrls[1] = url;
          await vi.advanceTimersByTimeAsync(10_000);
          expect(reports("entry")).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(10_000);
          await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "no-sign-in" });
        });

        it("refuses every announcement of a page that blocked the press, also one that overtook its check", async () => {
          const { h, reports } = await pressed();
          let answer!: (value: unknown) => void;
          fake.state.entry.check = new Promise((resolve) => {
            answer = resolve;
          });
          fake.state.pageUrl = loginUrl;
          const first = h.hello(next, false);
          await vi.waitFor(() => expect(sent("login.entry.check")).toHaveLength(1));
          const second = h.hello(next, false);
          answer({ ok: true, signIn: true, start: false, signUp: true });
          expect(await first).toMatchObject({ reason: "stale-document" });
          expect(await second).toMatchObject({ reason: "entry-blocked" });
          expect(await h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
          expect(sent("login.entry.check")).toHaveLength(1);
          expect(reports("entry")[1]).toMatchObject({ outcome: "blocked", reason: "sign-up" });
        });

        it("keeps other recipes' blocks when the device's blocks cannot be read, and blocks in this worker", async () => {
          const otherBlock = {
            recipeId: "other-entry",
            revision: 2,
            reason: "left-site",
            blockedAt: "2026-10-12T07:00:00.000Z",
          };
          fake.state.storage["pateat.login-entry-blocks.v1"] = [otherBlock];
          // A restarted worker finds the press and has not read the device's blocks yet.
          fake.state.session["pateat.login-entry-presses.v1"] = [
            {
              tabId: 1,
              origin,
              recipeId: entryRecipe.id,
              revision: 2,
              pressedAt: new Date().toISOString(),
              documentId: "pressed-document",
              url: entryUrl,
            },
          ];
          fake.state.entry.check = { ok: true, signIn: true, start: false, signUp: true };
          const local = fake.browser.storage.local;
          const get = local.get;
          const failing = vi
            .spyOn(local, "get")
            .mockImplementation(async (keys: string | string[]) =>
              [keys].flat().includes("pateat.login-entry-blocks.v1")
                ? Promise.reject(new Error("storage unavailable"))
                : get(keys),
            );
          try {
            const { h, reports } = setup({ entries: [entryRecipe] });
            fake.state.pageUrl = loginUrl;
            expect(await h.hello(next, false)).toMatchObject({ reason: "entry-blocked" });
            expect(reports("entry")).toEqual([
              {
                type: "entry",
                tabId: 1,
                origin,
                recipeId: entryRecipe.id,
                recipeRevision: 2,
                outcome: "blocked",
                reason: "sign-up",
                detail: "storage-unavailable",
              },
            ]);
            expect(blocks()).toEqual([otherBlock]);
            failing.mockRestore();
            // The device's blocks read again do not hold it, but this worker does.
            fake.state.pageUrl = entryUrl;
            fake.state.tabUrls[2] = entryUrl;
            fake.state.entry.inspect = inspected();
            expect(
              await h.hello({ tab: { id: 2 }, documentId: "other-tab", url: entryUrl }, false),
            ).toMatchObject({ reason: "entry" });
            await vi.waitFor(() => expect(reports("entry")).toHaveLength(2));
            expect(reports("entry")[1]).toMatchObject({
              tabId: 2,
              outcome: "refused",
              reason: "blocked",
            });
            expect(sent("login.entry.press")).toEqual([]);
          } finally {
            failing.mockRestore();
          }
        });
      });
    });

    it.each([
      ["the extractor's refusal", { ok: false, reason: "no-locator" }, "no-locator"],
      ["an answer that fails its check", { ok: true }, "extract-failed"],
    ] as const)(
      "logs %s when the page cannot be described",
      async (_name, extracted, reason) => {
        fake.state.extracted = { login: extracted };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        // Read three times a second apart, as a form rendered in steps may still settle.
        await vi.waitFor(
          () =>
            expect(report).toHaveBeenCalledWith({
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason,
            }),
          { timeout: 4_000 },
        );
        expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toHaveLength(
          3,
        );
        expect(service.generate).not.toHaveBeenCalled();
      },
      10_000,
    );

    it("stops at once for a cancelled document", async () => {
      fake.state.extracted = { login: { ok: false, reason: "cancelled" } };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "generation", outcome: "skipped", reason: "cancelled" }),
        ),
      );
      expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toHaveLength(1);
    });

    it("reads a page again that could not be described yet", async () => {
      fake.state.extracted = { login: { ok: false, reason: "no-locator" } };
      const service = generation();
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      // The form finishes rendering before the next read.
      fake.state.extracted = { login: loginPage };
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalled(), { timeout: 4_000 });
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        observation: loginPage.observation,
      });
    }, 10_000);

    it("offers nothing for a page sent recently, a path a recipe starts on, a frame or an incomplete description", async () => {
      const service = generation({ available: async () => "sent" as const });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      // The log says once per document why a page with no recipe is not sent.
      const generations = () =>
        report.mock.calls.flatMap(([value]) => (value.type === "generation" ? [value] : []));
      expect(generations()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "sent" },
      ]);

      service.available.mockResolvedValue(true);
      // Recipes that start on this path (two, so neither is selected), or an unreadable cache.
      fake.state.extracted = { login: loginPage };
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!, generated.steps[0]!]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      h.recipes.starts.mockRejectedValue(new Error("cache"));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(service.generate).not.toHaveBeenCalled();

      // The extractor's gap says why, without page text (ADR 0019).
      fake.state.extracted = {
        login: {
          ...loginPage,
          observation: { ...loginPage.observation, complete: false },
          gap: "unlocated-button",
        },
      };
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await vi.waitFor(
        () =>
          expect(generations().at(-1)).toEqual({
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "incomplete-observation",
            detail: "unlocated-button",
          }),
        { timeout: 4_000 },
      );
      expect(service.generate).not.toHaveBeenCalled();

      fake.state.tabUrls = { 1: "https://top.example/" };
      expect(
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "frame-token",
            signIn: { path: "/" },
          },
          sender({
            frameId: 3,
            documentId: "frame-document",
            tab: { id: 1, url: "https://login.example/" },
          }),
        ),
      ).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(service.generate).not.toHaveBeenCalled();
    }, 10_000);

    it("offers the page an account switch leads to when no recipe starts on its path", async () => {
      const service = generation();
      const h = harness({}, { uris, username: true, generation: service });
      const switching = parseLoginRecipe({
        ...recipe,
        accountSwitch: { by: "text", value: "Use another account" },
      });
      h.recipes.recipe.mockImplementation(async (_origin, path) =>
        path === "/signin" ? switching : undefined,
      );
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
      );
      fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch"),
      );
      // The switch leads to an email page; the origin's only recipe starts on `/signin`.
      fake.state.pageUrl = "https://login.example/signin/id";
      expect(await h.hello({ documentId: "next-page" }, false)).toEqual({
        ok: false,
        reason: "recipe-not-found",
        starts: [expect.objectContaining({ path: "/signin" })],
        generate: true,
      });
      expect(service.available).toHaveBeenCalledWith(origin, "/signin/id");
    });

    it("offers no page of a tab whose attempt ended without a switch", async () => {
      const service = generation();
      const h = harness({}, { uris, username: true, generation: service });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
      );
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "wrong-account" }]),
      );
      fake.state.pageUrl = "https://login.example/signin/id";
      expect(await h.hello({ documentId: "next-page" }, false)).not.toHaveProperty("generate");
      // Another tab on the same page, without an attempt, is offered.
      expect(await h.hello({ documentId: "other-tab", tab: { id: 2 } }, false)).toMatchObject({
        generate: true,
      });
      expect(service.generate).not.toHaveBeenCalled();
    });

    it("learns the completion from the page after the final submission", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        // The click signs in: the form goes and the next page shows a sign-out button.
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledWith(
        generated.id,
        generated.revision,
        "password",
        homePage.observation,
        expect.any(Function),
      );
      // The automatic choice is saved with its built-in binding once signed in.
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalled());
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: generated.id,
          slots: [
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        }),
      ]);
    }, 10_000);

    it("spins the tab's icon while the page after the submission is judged", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const stop = vi.fn();
      const spin = vi.fn((_tabId: number) => stop);
      const service = generation({
        judge: async () => {
          expect(stop).not.toHaveBeenCalled();
          return { verdict: "signed-in" };
        },
      });
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        spin,
      });
      h.recipes.recipe.mockResolvedValue(generated);
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(spin.mock.calls).toEqual([[1]]);
      expect(stop).toHaveBeenCalledTimes(1);
    }, 10_000);

    it.each([
      ["rejected", { state: "blocked", outcome: "credential-rejected" }],
      ["challenge", { state: "watching", outcome: "challenge" }],
      ["unclear", { state: "reconciling", outcome: "unknown-submit" }],
    ] as const)(
      "settles a %s judgement without saving the account",
      async (verdict, expected) => {
        fake.state.extracted = { "signed-in": homePage };
        const service = generation({
          judge: async () => ({ verdict, ...(verdict === "unclear" ? { reason: "timeout" } : {}) }),
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([expected]), { timeout: 6_000 });
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(h.store.update).not.toHaveBeenCalled();
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toEqual([
          {
            type: "judge",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            route: "password",
            verdict: "sent",
          },
          {
            type: "judge",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            route: "password",
            verdict,
            ...(verdict === "unclear" ? { reason: "timeout" } : {}),
          },
        ]);
        // The log's last word on the login: it ended, or its result settled as unknown.
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          ...expected,
          ...(verdict === "unclear" ? { settled: true } : {}),
        });
        expect(
          report.mock.calls.filter(([value]) => value.type === "attempt" && value.settled),
        ).toHaveLength(verdict === "unclear" ? 1 : 0);
      },
      10_000,
    );

    it.each([
      [
        "an incomplete description",
        { ...homePage, gap: "unfillable-field" as const },
        "unfillable-field",
      ],
      ["a refused description", { ok: false, reason: "no-candidates" }, "no-candidates"],
    ])(
      "reports why it does not send %s",
      async (_label, extracted, reason) => {
        fake.state.extracted = {
          "signed-in":
            "observation" in extracted
              ? { ...extracted, observation: { ...extracted.observation, complete: false } }
              : extracted,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toContainEqual({
          type: "judge",
          tabId: 1,
          origin,
          recipeId: generated.id,
          recipeRevision: generated.revision,
          route: "password",
          verdict: "not-sent",
          reason,
        });
      },
      10_000,
    );

    it("does not send the page while the recipe's fields are still shown", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
      // The log says why.
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "sign-in-shown" }),
      );
    }, 10_000);

    it("sends the page when a field's locator names an element that is no input there", async () => {
      // 2026-10-12: Wise's signed-in page gave the password field's React ID to an empty div.
      fake.state.extracted = {
        "signed-in": page("/signin", [
          { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
        ]),
      };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind !== "click") return;
        fake.state.present = new Set(["user", "password", "logout"]);
        fake.state.unusable = new Set(["user", "password"]);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledTimes(1);
      // Only an input counts as the sign-in field, shown for the sign-in state.
      const requires = fake.state.messages
        .filter((entry) => entry.type === "login.observe")
        .map((entry) => (entry as Record<string, unknown>)["require"]);
      expect(requires).toContainEqual(["shown-input", "shown-input"]);
      expect(requires).toContainEqual(expect.arrayContaining(["input", "input"]));
    }, 10_000);

    it("sends a page whose path may carry a token with that segment as [id]", async () => {
      const accountHome = page("/[id]/home", [
        { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
      ]);
      fake.state.extracted = { "signed-in": accountHome };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/0123456789abcdef0123456789abcdef/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledWith(
        generated.id,
        generated.revision,
        "password",
        accountHome.observation,
        expect.any(Function),
      );
    }, 10_000);

    it("does not send a page that shows a sign-in field on another path (S1)", async () => {
      fake.state.extracted = { "signed-in": homePage };
      fake.state.signs = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        // The form shows again elsewhere; its field may be left out of the description.
        fake.state.present = new Set(["user"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(service.judge).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "sign-in-shown" }),
      );
    }, 10_000);

    describe("the sign-in state (ADR 0029)", () => {
      it("logs a passkey request after the submission, but not one before it", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        // The sign-in page's own request, before the submission, does not count.
        h.login.passkeyRequested(1, origin);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          setTimeout(() => h.login.passkeyRequested(1, origin), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s1: false, s5: true, decision: "continuing" })]);
      }, 10_000);

      it("does not count a passkey request made before the submission", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        h.login.passkeyRequested(1, origin);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s5: false, decision: "judge" })]);
      }, 10_000);

      it("does not count a passkey request of another origin", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          setTimeout(() => h.login.passkeyRequested(1, "https://other.example"), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s5: false, decision: "judge" })]);
      }, 10_000);

      const noSigns = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };

      /**
       * Logs in on the generated recipe; the click leads to `/home` with `signs`, and the
       * judge answers `answer`.
       */
      async function judged(
        answer: Awaited<ReturnType<LoginGeneration["judge"]>>,
        signs: typeof noSigns = noSigns,
        answering?: () => void,
        described: unknown = homePage,
      ) {
        fake.state.extracted = { "signed-in": described };
        fake.state.signs = signs;
        const service = generation({
          judge: async () => {
            answering?.();
            return answer;
          },
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 8_000 });
        const judges = () =>
          report.mock.calls.flatMap(([value]) =>
            value.type === "judge" && value.verdict !== "sent" ? [value] : [],
          );
        return { judges, service, report };
      }

      it.each([
        undefined,
        "already-judged",
        "judged-signed-in",
        "judgement-limit",
        "daily-limit",
        "monthly-limit",
      ])(
        "completes a page with no sign and no evidence the judge did not decide (%s)",
        async (reason) => {
          const { judges, service } = await judged({
            verdict: "unclear",
            ...(reason ? { reason } : {}),
          });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]),
          );
          expect(judges()).toEqual([
            expect.objectContaining({ verdict: "unclear", completed: true }),
          ]);
          expect(judges()[0]).not.toHaveProperty("disabledLeftOut");
          expect(judges()[0]).not.toHaveProperty("notCompleted");
          // A description that left nothing out is sent without the mark.
          expect(service.judge.mock.calls[0]).toHaveLength(5);
        },
        12_000,
      );

      // A description that left out a disabled field that may not be a sign-in field is
      // still judged, but such a field may be a code field waiting for a timer or a sent
      // code, so only `signed-in` completes the page (owner, 2026-10-12; Q-move's history
      // page after a sign-in was never judged).
      const disabledLeftOut = { ...homePage, disabledLeftOut: true };

      it("judges a page that left out a disabled field and completes it on signed-in", async () => {
        const { judges, service, report } = await judged(
          { verdict: "signed-in" },
          noSigns,
          undefined,
          disabledLeftOut,
        );
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "authenticated", outcome: "authenticated" }]),
        );
        // The description goes as it is, and the request says a field was left out.
        expect(service.judge.mock.calls[0]![3]).toEqual(homePage.observation);
        expect(service.judge.mock.calls[0]!.slice(5)).toEqual([undefined, true]);
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toEqual([
          expect.objectContaining({ verdict: "sent", disabledLeftOut: true }),
          expect.objectContaining({ verdict: "signed-in", disabledLeftOut: true }),
        ]);
        expect(judges()[0]).not.toHaveProperty("notCompleted");
      }, 12_000);

      it.each([undefined, "already-judged", "daily-limit"])(
        "does not complete a page that left out a disabled field the judge did not decide (%s)",
        async (reason) => {
          const { judges } = await judged(
            { verdict: "unclear", ...(reason ? { reason } : {}) },
            noSigns,
            undefined,
            disabledLeftOut,
          );
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          );
          expect(judges()).toEqual([
            expect.objectContaining({
              verdict: "unclear",
              disabledLeftOut: true,
              notCompleted: "disabled-left-out",
            }),
          ]);
          expect(judges()[0]).not.toHaveProperty("completed");
        },
        12_000,
      );

      it("names no left-out field for an undecided answer that would not complete anyway", async () => {
        const { judges } = await judged(
          { verdict: "unclear", reason: "timeout" },
          noSigns,
          undefined,
          disabledLeftOut,
        );
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        );
        expect(judges()).toEqual([
          expect.objectContaining({ verdict: "unclear", reason: "timeout", disabledLeftOut: true }),
        ]);
        expect(judges()[0]).not.toHaveProperty("notCompleted");
      }, 12_000);

      it("rejects a page that left out a disabled field as usual", async () => {
        await judged({ verdict: "rejected" }, noSigns, undefined, disabledLeftOut);
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
        );
      }, 12_000);

      it("never completes on a page judged challenge before", async () => {
        await judged({ verdict: "unclear", reason: "judged-challenge" });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
      }, 12_000);

      it.each(["timeout", "judged-rejected", "judgement-unanswered"])(
        "never completes on %s",
        async (reason) => {
          const { judges } = await judged({ verdict: "unclear", reason });
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          );
          expect(judges()[0]).not.toHaveProperty("completed");
        },
        12_000,
      );

      it("keeps a page undecided when a sign shows by the time the judge answers", async () => {
        const { judges } = await judged({ verdict: "unclear" }, noSigns, () => {
          fake.state.signs = { ...noSigns, code: true };
        });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        );
        expect(judges()[0]).not.toHaveProperty("completed");
      }, 12_000);

      it("leaves another sign-in step the judge did not decide to the person", async () => {
        const { judges } = await judged({ verdict: "unclear" }, { ...noSigns, code: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
        );
        expect(judges()[0]).not.toHaveProperty("completed");
      }, 12_000);

      it("rejects on a failure shown next to the sign-in fields, comparing the username in the page", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, password: true, alert: true, username: false };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        // A second reading agrees, so the login is rejected without asking the judge.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 8_000 },
        );
        expect(report).toHaveBeenCalledWith({
          type: "state",
          tabId: 1,
          origin,
          recipeId: generated.id,
          recipeRevision: generated.revision,
          route: "password",
          ...{ s1: true, s2: true, s3: false, s4: false, s5: false, f1: false, f2: true },
          ...{ e1: false, e2: false, e3: false },
          decision: "rejected",
          // Read against its own reading at the step, not as a form shown again.
          reshownMiss: "same-document",
        });
        // The username goes to the page for its comparison only.
        expect(fake.state.messages.find((entry) => entry.type === "login.state")?.account).toEqual({
          username: "synthetic-secret",
        });
        // The submitted document is compared with its own reading, never asked for fields.
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.state" && entry.fields !== undefined,
          ),
        ).toEqual([]);
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);

      /**
       * Logs in on the generated recipe; the click loads the sign-in form again in a new
       * document, which shows `signs` when the worker names the sign-in fields to read.
       */
      async function reshown(signs: typeof noSigns & { alertMiss?: string }) {
        fake.state.extracted = { "signed-in": homePage };
        // The submitted document never shows a failure; only the new one can.
        fake.state.signs = (message) =>
          message["fields"] ? { ...signs, username: false } : { ...noSigns, username: false };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The site answers the submission with its sign-in page, as a new document.
          fake.state.gone.add("synthetic-document");
          setTimeout(() => void h.hello({ documentId: "document-again" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        const states = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
        await vi.waitFor(() => expect(states().length).toBeGreaterThan(0), { timeout: 8_000 });
        // Only the re-shown document is asked for its sign-in fields' marks.
        const reads = fake.state.messages.filter((entry) => entry.type === "login.state");
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((entry) => Array.isArray(entry.fields))).toBe(true);
        return { service, states, report, h };
      }

      it.each([
        ["a sign-in field marked invalid (F1)", { invalid: true }, { f1: true, f2: false }],
        ["an alert (F2)", { alert: true }, { f1: false, f2: true }],
      ])(
        "rejects the sign-in form shown again in a new document with %s",
        async (_label, shown, flags) => {
          const { service, states } = await reshown({ ...noSigns, password: true, ...shown });
          await vi.waitFor(
            () =>
              expect(status()).toMatchObject([
                { state: "blocked", outcome: "credential-rejected" },
              ]),
            { timeout: 8_000 },
          );
          expect(states()).toEqual([
            expect.objectContaining({ s1: true, s4: false, ...flags, reshown: true }),
          ]);
          expect(states()[0]).toMatchObject({ decision: "rejected" });
          expect(service.judge).not.toHaveBeenCalled();
        },
        12_000,
      );

      it("asks for an account once the sign-in form shows again in a new document without a mark", async () => {
        // Seen on github.com on 2026-10-13: its "Incorrect username or password" page was read
        // as unknown, the login was watched, and the popup offered no account. The page says
        // why no alert beside the form counted, value-free, for the log.
        const { service, states, report, h } = await reshown({
          ...noSigns,
          password: true,
          alertMiss: "other-form",
        });
        await vi.waitFor(() => expect(status()).toEqual([]), { timeout: 8_000 });
        expect(states()).toEqual([
          expect.objectContaining({ s1: true, f1: false, f2: false, reshown: true }),
        ]);
        expect(states()[0]).toMatchObject({ decision: "unknown", alertMiss: "other-form" });
        expect(states()[0]).not.toHaveProperty("reshownMiss");
        // The attempt that settles on it says the sign-in form still showed.
        expect(
          report.mock.calls.flatMap(([value]) =>
            value.type === "attempt" && value.outcome === "unknown-submit" && value.settled
              ? [value]
              : [],
          ),
        ).toEqual([expect.objectContaining({ cause: "sign-in-shown" })]);
        expect(service.judge).not.toHaveBeenCalled();
        expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.session["pateat.login-rejected-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        // The page is asked to announce again, and asks once its first step shows.
        expect(fake.state.reconnects).toContainEqual({
          tabId: 1,
          frameId: 0,
          documentId: "document-again",
        });
        const executes = fake.state.messages.filter((entry) => entry.type === "login.execute");
        expect(await h.hello({ documentId: "document-again" })).toEqual({
          ok: false,
          reason: "logged-out",
        });
        expect(fake.state.badges[1]).toEqual({
          text: "1",
          title:
            "Pateat: the site did not accept the last login in this tab. Click to choose an account.",
        });
        // Nothing is filled or pressed on that page again.
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual(
          executes,
        );
      }, 12_000);

      it("never rejects the sign-in form shown again in a new document with a CAPTCHA", async () => {
        const { states } = await reshown({
          ...noSigns,
          password: true,
          captcha: true,
          invalid: true,
          alert: true,
        });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 8_000 },
        );
        expect(states()).toEqual([
          expect.objectContaining({ s1: true, s4: true, f1: true, f2: true, reshown: true }),
        ]);
        expect(states()[0]).toMatchObject({ decision: "unknown" });
      }, 12_000);

      /**
       * Logs in on the generated recipe; the submitted document settles as unknown first,
       * and `pages` then load in new documents, one after another, `afterMs` later. Each
       * shows `signs` when the worker names the sign-in fields to read.
       */
      async function settledFirst(pages: (typeof noSigns)[], afterMs = 0) {
        fake.state.extracted = { "signed-in": homePage };
        let shown = { ...noSigns, password: true };
        fake.state.signs = (message) =>
          message["fields"] ? { ...shown, username: false } : { ...noSigns, password: true };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        const states = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
        // A slow answer: the submitted document's reading settles the login first.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([
              { state: "reconciling", outcome: "unknown-submit", settled: true },
            ]),
          { timeout: 8_000 },
        );
        expect(states()).toEqual([
          expect.objectContaining({ s1: true, decision: "unknown", reshownMiss: "same-document" }),
        ]);
        expect(states()[0]).not.toHaveProperty("reshown");
        if (afterMs > 0) {
          const now = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + afterMs);
          onTestFinished(() => clock.mockRestore());
        }
        // Each page is read before the next one loads, so they run one after another.
        /* eslint-disable no-await-in-loop */
        for (const [index, signs] of pages.entries()) {
          shown = signs;
          fake.state.gone.add(index === 0 ? "synthetic-document" : `document-${index}`);
          await h.hello({ documentId: `document-${index + 1}` }, false);
          await vi.waitFor(() => expect(states().length).toBeGreaterThan(index + 1), {
            timeout: 8_000,
          });
        }
        /* eslint-enable no-await-in-loop */
        return { states, service };
      }

      it("rejects the sign-in form shown again after the submitted document settled", async () => {
        // A slow answer, still well within 30 seconds of the submission.
        const { states, service } = await settledFirst([
          { ...noSigns, password: true, invalid: true },
        ]);
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 8_000 },
        );
        expect(states()[1]).toMatchObject({
          f1: true,
          reshown: true,
          settled: true,
          decision: "rejected",
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 20_000);

      it("asks for an account when the form shows again without a mark after the submitted document settled", async () => {
        await settledFirst([{ ...noSigns, password: true }]);
        await vi.waitFor(() => expect(status()).toEqual([]), { timeout: 8_000 });
        expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.reconnects).toContainEqual({
          tabId: 1,
          frameId: 0,
          documentId: "document-1",
        });
      }, 20_000);

      it.each([
        ["a code input", { code: true }],
        ["a CAPTCHA", { captcha: true }],
      ])(
        "keeps watching the sign-in form shown again with %s beside it",
        async (_label, extra) => {
          const { states } = await reshown({ ...noSigns, password: true, ...extra });
          await vi.waitFor(
            () =>
              expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
            { timeout: 8_000 },
          );
          expect(states()[0]).toMatchObject({ reshown: true, decision: "unknown" });
          expect(fake.state.session["pateat.login-logouts.v1"] ?? []).toEqual([]);
        },
        12_000,
      );

      it("reads only the first new document after the submission as the form shown again", async () => {
        // The person's own retry in the form shown again loads a third document. A code input
        // beside the form keeps the login watched rather than asking again.
        const { states } = await settledFirst([
          { ...noSigns, password: true, code: true },
          { ...noSigns, password: true, invalid: true, alert: true },
        ]);
        expect(states()[1]).toMatchObject({ reshown: true, decision: "unknown" });
        expect(states()[2]).toMatchObject({
          f1: false,
          f2: false,
          decision: "unknown",
          reshownMiss: "later-document",
        });
        expect(states()[2]).not.toHaveProperty("reshown");
        const reads = fake.state.messages.filter((entry) => entry.type === "login.state");
        expect(reads.at(-1)).not.toHaveProperty("fields");
        expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]);
      }, 30_000);

      it("never reads a new document more than 30 seconds after the submission as its answer", async () => {
        // The login settled and is watched; the person's own later attempt loads the
        // sign-in form with an error.
        const { states } = await settledFirst(
          [{ ...noSigns, password: true, invalid: true, alert: true }],
          31_000,
        );
        expect(states()[1]).toMatchObject({
          s1: true,
          f1: false,
          f2: false,
          decision: "unknown",
          reshownMiss: "late",
        });
        expect(states()[1]).not.toHaveProperty("reshown");
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.state" && entry.fields !== undefined,
          ),
        ).toEqual([]);
        expect(status()).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", settled: true },
        ]);
      }, 20_000);

      it("rejects the sign-in form shown again after a page judged challenge", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = (message) =>
          message["fields"]
            ? { ...noSigns, password: true, alert: true, username: false }
            : { ...noSigns, username: false };
        const service = generation({ judge: async () => ({ verdict: "challenge" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The submitted document shows an approval page first.
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "watching", outcome: "challenge" }]),
          { timeout: 8_000 },
        );
        // The site then answers with its sign-in form and an error, as a new document.
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.observedPath = "/signin";
        fake.state.gone.add("synthetic-document");
        await h.hello({ documentId: "document-again" }, false);
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
          { timeout: 10_000 },
        );
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])).at(-1),
        ).toMatchObject({ f2: true, reshown: true, decision: "rejected" });
        expect(service.judge).toHaveBeenCalledTimes(1);
      }, 20_000);

      it("never reads the sign-in form shown again after an advance as a rejection", async () => {
        const advancing = parseLoginRecipe({
          ...generated,
          steps: [
            {
              kind: "fill",
              path: "/signin",
              fields: [{ slot: "username", target: target("user") }],
            },
            { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
            {
              kind: "fill",
              path: "/next",
              fields: [{ slot: "password", target: target("password") }],
            },
            { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
          ],
          maxSubmissions: 2,
        });
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = (message) =>
          message["fields"]
            ? { ...noSigns, alert: true, invalid: true, username: false }
            : { ...noSigns, username: false };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(advancing);
        fake.state.present = new Set(["user", "next"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // Next loads an unexpected page that shows the username form again.
          fake.state.present = new Set(["user"]);
          fake.state.observedPath = "/signin/again";
          fake.state.gone.add("synthetic-document");
          setTimeout(() => void h.hello({ documentId: "document-again" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        const states = () =>
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : []));
        await vi.waitFor(() => expect(states().length).toBeGreaterThan(0), { timeout: 16_000 });
        expect(states()[0]).toMatchObject({
          s1: true,
          f1: false,
          f2: false,
          decision: "unknown",
          reshownMiss: "not-submit",
        });
        expect(states()[0]).not.toHaveProperty("reshown");
        expect(
          fake.state.messages.filter(
            (entry) => entry.type === "login.state" && entry.fields !== undefined,
          ),
        ).toEqual([]);
        expect(status()).not.toMatchObject([{ outcome: "credential-rejected" }]);
      }, 25_000);

      it("logs reaching the return target the sign-in page's URL named, before the judge", async () => {
        fake.state.pageUrl = `${origin}/signin?return_to=%2Fhome`;
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = noSigns;
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The click loads the return target in a new document.
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          fake.state.pageUrl = `${origin}/home`;
          setTimeout(() => void h.hello({ documentId: "document-home" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        const states = report.mock.calls.flatMap(([value]) =>
          value.type === "state" ? [value] : [],
        );
        expect(states).toEqual([
          expect.objectContaining({ s1: false, s5: false, e3: true, decision: "signed-in" }),
        ]);
        // Read twice, a second apart, and completed without a model call.
        expect(fake.state.messages.filter((entry) => entry.type === "login.state")).toHaveLength(2);
        expect(service.judge).not.toHaveBeenCalled();
      }, 12_000);

      it("completes when the username shows in the header, without the judge", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "state", e2: true, decision: "signed-in" }),
        );
        expect(service.judge).not.toHaveBeenCalled();
      }, 12_000);

      it("waits for the document to finish loading before it completes", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(
              fake.state.messages.filter((entry) => entry.type === "login.state").length,
            ).toBeGreaterThanOrEqual(3),
          { timeout: 10_000, interval: 10 },
        );
        expect(status()).not.toMatchObject([{ state: "authenticated" }]);
        fake.state.loaded = true;
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 4_000,
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 20_000);

      it("leaves the page to the judge when the document never finishes loading", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 16_000 });
        expect(status()).not.toMatchObject([{ state: "authenticated" }]);
      }, 20_000);

      it("leaves the page to the judge when the second reading shows no evidence", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        // The header changes after the first reading, as on a page still redirecting.
        await vi.waitFor(
          () =>
            expect(
              fake.state.messages.filter((entry) => entry.type === "login.state"),
            ).toHaveLength(1),
          { timeout: 6_000, interval: 10 },
        );
        fake.state.signs = noSigns;
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 8_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ e2: false, decision: "judge" })]);
      }, 12_000);
    });

    describe("custom-field offers and their shapes (ADR 0027)", () => {
      const thirdItemId = "80000000-0000-4000-8000-000000000003";
      const matched =
        (ids: string[], extra: Partial<UriCandidates> = {}) =>
        async () => ({
          ok: true as const,
          data: uriMatch({
            candidates: ids.map((id) => ({ itemId: id, matches: [{ uriIndex: 0, match: 0 }] })),
            ...extra,
          }),
        });
      const field = (index: number) => `custom.${snapshotId}.${index}`;
      const digits = (length: number) => ({ length, classes: ["ascii-digit"], email: false });
      /** Sends the sign-in page and answers each read from `values`, keyed by item and field. */
      async function sendPage(
        values: Record<string, string | undefined>,
        live: Parameters<typeof harness>[1],
        overrides: Partial<LocalSettings> = {},
      ) {
        fake.state.extracted = { login: loginPage };
        const service = generation();
        const h = harness(
          { ...unsaved, ...overrides },
          {
            allowedOrigins: [],
            uris: matched([itemId, otherItemId]),
            generation: service,
            ...live,
          },
        );
        h.fields.mockImplementation(
          async ({ account, fieldId }) =>
            // Synthetic values only; a missing key is a read that gives nothing.
            values[`${account.itemId} ${fieldId}`],
        );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        const request = service.generate.mock.calls[0]![0];
        return {
          request,
          custom: request.slots.filter((slot) => slot.fieldName !== undefined),
          reads: h.fields.mock.calls.map(([read]) => `${read.account.itemId} ${read.fieldId}`),
        };
      }
      const twoItems = {
        custom: [
          { name: "Branch", kind: "text" as const },
          { name: "PIN", kind: "hidden" as const },
        ],
        otherCustom: [{ name: "Branch", kind: "text" as const }],
      };

      it("offers the matching items' fields by name and shapes a Text field they agree on", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: "456" },
          twoItems,
        );
        expect(sent.custom).toEqual([
          {
            id: "custom-1",
            kind: "identifier",
            description: "value of the user's vault field named in fieldName",
            fieldName: "Branch",
            valueShape: digits(3),
          },
          {
            id: "custom-2",
            kind: "hidden",
            description:
              "concealed value of the user's vault field named in fieldName, such as a PIN",
            fieldName: "PIN",
          },
        ]);
        // A Hidden value is never read for a shape, and no value is sent.
        expect(sent.reads).toEqual([`${itemId} ${field(0)}`, `${otherItemId} ${field(0)}`]);
        expect(JSON.stringify(sent.request)).not.toMatch(/123|456|Synthetic item/u);
      });

      it.each<[string, string | undefined, object | undefined]>([
        ["another length", "4567", undefined],
        ["other characters", "4b6", undefined],
        ["an unreadable value", undefined, undefined],
        ["a value too long to shape", "1".repeat(1025), undefined],
        ["an empty value, which does not count", "", digits(3)],
      ])("sends a Text shape only when the items agree: %s", async (_label, other, shape) => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: other },
          twoItems,
        );
        expect(sent.custom[0]!.valueShape).toEqual(shape);
        expect(sent.custom.map((slot) => slot.fieldName)).toEqual(["Branch", "PIN"]);
      });

      it("offers a field an item excludes only from the items that allow it", async () => {
        const settings = (excluded: object) => ({
          connections: [
            {
              connectionId,
              enabled: true,
              selection: { mode: "all" as const, groupIds: [], itemIds: [] },
              excludedItemIds: [],
              excludedFields: [],
              ...excluded,
            },
          ],
        });
        const values = { [`${itemId} ${field(0)}`]: "1", [`${otherItemId} ${field(0)}`]: "4567" };
        const field0 = await sendPage(
          values,
          twoItems,
          settings({ excludedFields: [{ itemId, fieldId: field(0) }] }),
        );
        // Offers are numbered in the order the items' fields are found.
        expect(field0.custom.map((slot) => [slot.id, slot.fieldName, slot.valueShape])).toEqual([
          ["custom-1", "PIN", undefined],
          ["custom-2", "Branch", digits(4)],
        ]);
        expect(field0.reads).toEqual([`${otherItemId} ${field(0)}`]);
        // An excluded item offers no field and is never read.
        const item = await sendPage(values, twoItems, settings({ excludedItemIds: [otherItemId] }));
        expect(item.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", digits(1)],
          ["PIN", undefined],
        ]);
        expect(item.reads).toEqual([`${itemId} ${field(0)}`]);
      });

      it("offers nothing from an item awaiting review and reads none of its values", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: "4567" },
          { ...twoItems, quarantined: true },
        );
        // Only the other item's field is offered and shaped; the reviewed item's PIN is not.
        expect(sent.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", digits(4)],
        ]);
        expect(sent.reads).toEqual([`${otherItemId} ${field(0)}`]);
      });

      it("offers names without shapes when an item could not be checked", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123" },
          {
            ...twoItems,
            uris: matched([itemId], { unavailableItemIds: [otherItemId] }),
          },
        );
        expect(sent.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", undefined],
          ["PIN", undefined],
        ]);
        expect(sent.reads).toEqual([]);
      });

      it("reads at most 32 values for shapes and sends the rest without one", async () => {
        const sixteen = Array.from({ length: 16 }, (_, index) => ({
          name: `Field ${index + 1}`,
          kind: "text" as const,
        }));
        const values = Object.fromEntries(
          [itemId, otherItemId, thirdItemId].flatMap((id) =>
            sixteen.map((_, index) => [`${id} ${field(index)}`, "12"]),
          ),
        );
        const sent = await sendPage(values, {
          custom: sixteen,
          otherCustom: sixteen,
          extraItems: [{ id: thirdItemId, custom: sixteen }],
          uris: matched([itemId, otherItemId, thirdItemId]),
        });
        expect(sent.custom).toHaveLength(16);
        // Each offer reads three values: ten fit in 32, and no offer is shaped in part.
        expect(sent.custom.map((slot) => slot.valueShape !== undefined)).toEqual([
          ...Array.from({ length: 10 }, () => true),
          ...Array.from({ length: 6 }, () => false),
        ]);
        expect(sent.reads).toHaveLength(30);
        expect(new Set(sent.reads).size).toBe(30);
      });
    });

    describe("a custom-slot binding built before the first login (ADR 0027)", () => {
      const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
      const sibling = (field: { custom: string }, extra: Partial<SavedLoginBinding> = {}) => ({
        ...branchBinding,
        itemId: otherItemId,
        itemName: "Other synthetic item",
        slots: [
          { slot: "branch", field },
          { slot: "password", field: "password" as const },
        ],
        ...extra,
      });
      const regionAndBranch = {
        custom: [
          { name: "Branch", kind: "text" as const },
          { name: "Region", kind: "text" as const },
        ],
      };
      async function login(
        bindings: SavedLoginBinding[],
        map: Awaited<ReturnType<LoginGeneration["slotFields"]>> | Error,
        live: Parameters<typeof harness>[1] = regionAndBranch,
        overrides: Partial<LocalSettings> = {},
      ) {
        const service = generation({
          available: async () => "sent" as const,
          slotFields: async () => {
            if (map instanceof Error) throw map;
            return map;
          },
        });
        const h = harness({ bindings, ...overrides }, { ...live, generation: service });
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        return { h, service, answer: await h.hello() };
      }

      it("takes another item's saved binding first and saves the result after authenticated", async () => {
        const { h, service, answer } = await login(
          [sibling({ custom: "Branch" })],
          [{ slot: "branch", field: { custom: "Region" } }],
        );
        expect(answer).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
        expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
          `custom.${snapshotId}.0`,
          "login.password",
        ]);
        expect(service.slotFields).toHaveBeenCalledWith(branchRecipe.id);
        await vi.waitFor(() => expect(h.store.update).toHaveBeenCalled());
        expect(h.settings.settings.bindings).toContainEqual(
          expect.objectContaining({
            recipeId: branchRecipe.id,
            itemId,
            slots: [
              { slot: "branch", field: { custom: "Branch" } },
              { slot: "password", field: "password" },
            ],
          }),
        );
      });

      it("falls back to the generated map when no sibling binding resolves on the item", async () => {
        const { h, answer } = await login(
          [sibling({ custom: "Gone" })],
          [{ slot: "branch", field: { custom: "Region" } }],
        );
        expect(answer).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
        expect(h.fields.mock.calls[0]![0].fieldId).toBe(`custom.${snapshotId}.1`);
      });

      it("ignores a sibling binding of another origin or recipe", async () => {
        const { answer } = await login(
          [
            sibling({ custom: "Branch" }, { origin: "https://other.example" }),
            sibling({ custom: "Branch" }, { recipeId: "another-recipe" }),
          ],
          undefined,
        );
        expect(answer).toEqual({ ok: false, reason: "binding-not-found" });
      });

      it.each<[string, Awaited<ReturnType<LoginGeneration["slotFields"]>> | Error, string]>([
        ["no map", undefined, "binding-not-found"],
        ["an unreadable map", new Error("synthetic storage failure"), "binding-not-found"],
        [
          "a map without the slot",
          [{ slot: "region", field: { custom: "Region" } }],
          "binding-not-found",
        ],
        [
          "a map naming a missing field",
          [{ slot: "branch", field: { custom: "Gone" } }],
          "field-missing",
        ],
        [
          "a map whose same-name count changed",
          [{ slot: "branch", field: { custom: "Branch", position: 1, count: 3 } }],
          "field-count-changed",
        ],
      ])("stops before any read with %s", async (_label, map, reason) => {
        const { h, answer } = await login([], map);
        expect(answer).toEqual({ ok: false, reason });
        expect(h.fields).not.toHaveBeenCalled();
        expect(executes()).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      });

      it.each<[string, SavedLoginBinding[], Awaited<ReturnType<LoginGeneration["slotFields"]>>]>([
        ["a generated map", [], [{ slot: "branch", field: { custom: "PIN" } }]],
        ["another item's binding", [sibling({ custom: "PIN" })], undefined],
      ])(
        "marks a Hidden field bound from %s, so a plain text input refuses it",
        async (_label, bindings, map) => {
          // The content script's input rule, for the step's synthetic inputs: the branch
          // target is a plain text input and the password target a password input.
          const inputs: Record<"branch" | "password", SecretInput> = {
            branch: { type: "text", autocomplete: "", inputMode: "", maxLength: -1 },
            password: { type: "password", autocomplete: "", inputMode: "", maxLength: -1 },
          };
          fake.state.onExecute = async (message) => {
            const values = message["values"] as {
              slot: keyof typeof inputs;
              secret?: "password" | "otp" | "hidden";
            }[];
            if (values.some(({ slot, secret }) => !acceptsSecret(inputs[slot], secret)))
              fake.state.executeReply = { ok: false, reason: "structural-mismatch" };
          };
          const { h, answer } = await login(bindings, map, {
            custom: [{ name: "PIN", kind: "hidden" }],
          });
          expect(answer).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(fake.state.storage["pateat.login-attempts.v4"]).toMatchObject([
              { state: "blocked", outcome: "retry-limit", retries: 2, submissions: 0 },
            ]),
          );
          // The step is tried again twice, and the page refuses the same values each time.
          expect(executes()).toHaveLength(3);
          expect(executes()[2]!.values).toEqual([
            { slot: "branch", value: "synthetic-secret", secret: "hidden" },
            { slot: "password", value: "synthetic-secret", secret: "password" },
          ]);
          // A login that never filled is not authenticated, so nothing is saved.
          expect(h.store.update).not.toHaveBeenCalled();
        },
      );
    });
  });
  describe("when the popup asks what Pateat did on the tab's page (ADR 0038)", () => {
    const popup = {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/popup.html",
    } as never;
    const ask = (h: ReturnType<typeof harness>, tabId = 1, from: never = popup) =>
      h.login.handle({ version: 1, type: "login.status.get", tabId }, from);
    const badge = () =>
      createLoginBadge({ setBadge: vi.fn(async () => undefined), storage: memoryBadgeStorage() });

    it.each([
      ["an HTTP page", "http://login.example/signin"],
      ["a browser page", "chrome://settings/"],
      ["a malformed URL", "not a url"],
      ["an empty URL", ""],
    ])("answers no-page for %s", async (_name, url) => {
      fake.state.tabUrls[1] = url;
      const h = harness();
      expect(await ask(h)).toEqual({ ok: false, reason: "no-page" });
    });

    it("reads the top document's URL when the tab's is not given", async () => {
      const h = harness();
      expect(await h.hello()).toEqual({ ok: true });
      // Chrome leaves out a tab's URL without host access, and refuses a closed tab.
      const get = vi
        .spyOn(fake.browser.tabs, "get")
        .mockImplementation(async (id: number) => ({ id, url: undefined }) as never);
      try {
        expect(await ask(h)).toMatchObject({ ok: true, origin, recipe: "page" });
        get.mockRejectedValue(new Error("No tab with id"));
        expect(await ask(h)).toMatchObject({ ok: true, origin, recipe: "page" });
        // A tab without a document of its own has no page.
        expect(await ask(h, 2)).toEqual({ ok: false, reason: "no-page" });
      } finally {
        get.mockRestore();
      }
    });

    it("tells whether a recipe starts on the page, only elsewhere, or not at all", async () => {
      const h = harness();
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = `${origin}/home?next=%2Fsignin#signin`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
      fake.state.tabUrls[1] = "https://other.example/signin";
      expect(await ask(h)).toEqual({ ok: true, origin: "https://other.example", recipe: "none" });
      // A recipe store that cannot be read counts as no recipe.
      fake.state.tabUrls[1] = `${origin}/signin`;
      h.recipes.starts.mockRejectedValueOnce(new Error("idb"));
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "none" });
    });

    it("counts a sign-in entry's path as a recipe on the page", async () => {
      const entry: LoginEntryRecipe = {
        version: 1,
        id: "synthetic-entry",
        revision: 1,
        origin,
        entry: { path: "/", target: { by: "text", value: "Login" } },
      };
      const h = harness({}, { entries: [entry] });
      h.recipes.starts.mockResolvedValue([]);
      fake.state.tabUrls[1] = `${origin}/?return_to=%2Fbookmarks`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = `${origin}/signin`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
    });

    it("gives the top document's state only while the tab shows its path", async () => {
      const h = harness();
      expect(await h.hello()).toEqual({ ok: true });
      const answer = await ask(h);
      expect(answer).toMatchObject({ ok: true, origin, recipe: "page", page: expect.any(Object) });
      // Never a value, recipe step or query.
      expect(JSON.stringify(answer)).not.toContain("synthetic-secret");
      expect(JSON.stringify(answer)).not.toContain("password");
      // The tab moved on before its new page announced.
      fake.state.tabUrls[1] = `${origin}/home`;
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "other-paths" });
      fake.state.tabUrls[1] = "https://other.example/signin";
      expect(await ask(h)).toEqual({ ok: true, origin: "https://other.example", recipe: "none" });
    });

    it("gives the tab's last login, refusal and model request only for the page's origin", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      tabBadge.observe({ type: "generation", tabId: 1, origin, outcome: "recipe", page: "entry" });
      tabBadge.observe({
        type: "attempt",
        tabId: 1,
        origin,
        recipeId: recipe.id,
        recipeRevision: 1,
        route: "password",
        state: "blocked",
        outcome: "credential-rejected",
        cause: "elements-timeout",
        stepIndex: 1,
        stepCount: 2,
      });
      tabBadge.observe({
        type: "refused",
        tabId: 1,
        origin,
        reason: "no-route",
        detail: "password-empty:no-passkey",
      });
      expect(await ask(h)).toEqual({
        ok: true,
        origin,
        recipe: "page",
        login: { state: "blocked", outcome: "credential-rejected", cause: "elements-timeout" },
        refused: { reason: "no-route", detail: "password-empty:no-passkey" },
        generation: { outcome: "recipe", page: "entry" },
      });
      // Another tab, or the tab on another origin before its badge heard of it, gets none.
      fake.state.tabUrls[2] = `${origin}/signin`;
      expect(await ask(h, 2)).toEqual({ ok: true, origin, recipe: "page" });
      fake.state.tabUrls[1] = "https://other.example/signin";
      expect(await ask(h)).toEqual({ ok: true, origin: "https://other.example", recipe: "none" });
      fake.state.tabUrls[1] = `${origin}/signin`;
      expect(await ask(h)).toMatchObject({ login: { state: "blocked" } });
      // The badge drops it when the tab's top page changes origin.
      tabBadge.loaded(1, `${origin}/signin`);
      tabBadge.loaded(1, "https://other.example/");
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
    });

    it("says a model request is in flight while the tab's badge spins", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
      const stop = tabBadge.spin(1);
      try {
        expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page", asking: true });
        // Only that tab's.
        fake.state.tabUrls[2] = `${origin}/signin`;
        expect(await ask(h, 2)).toEqual({ ok: true, origin, recipe: "page" });
      } finally {
        stop();
      }
      expect(await ask(h)).toEqual({ ok: true, origin, recipe: "page" });
    });

    it("clips the badge's codes to the popup's limit", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      const detail = `password-empty:${"y".repeat(250)}`;
      tabBadge.observe({ type: "refused", tabId: 1, origin, reason: "no-route", detail });
      const parsed = v.parse(statusResponseSchema, await ask(h));
      expect(parsed).toMatchObject({
        ok: true,
        refused: { reason: "no-route", detail: detail.slice(0, 200) },
      });
    });

    it("answers only the popup page, and only a well-formed request", async () => {
      const tabBadge = badge();
      const h = harness({}, { badge: tabBadge });
      tabBadge.observe({ type: "generation", tabId: 1, origin, outcome: "sent" });
      expect(await ask(h, 1, trusted)).toBeUndefined();
      expect(await ask(h, 1, sender())).toBeUndefined();
      expect(
        await h.login.handle(
          { version: 1, type: "login.status.get", tabId: 1, origin } as never,
          popup,
        ),
      ).toBeUndefined();
      expect(
        await h.login.handle({ version: 1, type: "login.status.get", tabId: -1 }, popup),
      ).toBeUndefined();
      expect(await ask(h)).toMatchObject({ ok: true, generation: { outcome: "sent" } });
    });
  });
  it("does not answer probe controls outside the probe build", async () => {
    const h = harness();
    expect(
      await h.login.handle(
        { version: 1, type: "login.probe.configure", origin: "http://127.0.0.1:3847" },
        trusted,
      ),
    ).toBeUndefined();
    expect(
      await h.login.handle({ version: 1, type: "login.probe.status" }, trusted),
    ).toBeUndefined();
  });
});
