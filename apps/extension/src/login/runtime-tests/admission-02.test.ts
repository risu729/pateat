import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings, type LoginStep } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  itemId,
  sender,
  target,
  recipe,
  otherItemId,
  uriMatch,
  liveAccountPolicy,
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
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
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
  it("logs which check refused the later steps of a page whose first step is missing (ADR 0049)", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    expect(
      await shownHello(h, {}, { later: { steps: 2, partial: 1, miss: "target" } }),
    ).toMatchObject({ reason: "form-not-ready" });
    expect(
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused"),
    ).toEqual([
      {
        type: "refused",
        tabId: 1,
        origin,
        reason: "not-started",
        detail: "first-step-missing",
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        laterSteps: 2,
        laterPartial: 1,
        laterMiss: "target",
      },
    ]);
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
  it.each([["a site whose access the user withheld", undefined, "no-site-access"]])(
    "logs why the page of %s with a recipe is not admitted",
    async (_name, overrides, reason) => {
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
    },
  );
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
      // Before the click: nothing was submitted, in the document the login began in.
      unsubmitted: true,
      name: "SyntaxError",
      message: "synthetic settings answer",
      stack: expect.any(String),
    });
  });
  it("marks an exception of a login that only fills while its tab asks (ADR 0066)", async () => {
    // This tab's login stopped after a submission (ADR 0062 B); the item is the site default.
    fake.state.session["pateat.login-stopped-asks.v1"] = [{ tabId: 1, origin }];
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    // The settings read after the fill fails once.
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
      report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "start"),
    ).toMatchObject({ fillOnly: true });
    // Its line stays on the device, as every line of such a login.
    expect(
      report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "exception"),
    ).toMatchObject({ name: "SyntaxError", fillOnly: true });
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
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
      h.settings.settings.accountPolicies = [liveAccountPolicy({ enabled: false })];
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
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
      const [record] = (values["pateat.login-attempts.v5"] ?? []) as Record<string, unknown>[];
      if (offset === 0 && record?.["state"] === "executing" && record["mutationIntent"])
        offset = 16_000;
      await set(values);
    };
    const report = vi.fn<(report: LoginReport) => void>();
    try {
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "blocked", outcome: "retry-limit" },
      ]),
    );
    const [record] = fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[];
    fake.state.storage["pateat.login-attempts.v5"] = [
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
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "authenticated", retries: 2 },
        ]),
      );
    } finally {
      fake.browser.tabs.query = query;
    }
  });
  it.each([
    { state: "retryable", outcome: "structural-mismatch", retries: 1, retryRequired: true },
    { state: "ready", retries: 1 },
  ])(
    "never settles as unknown a $state attempt whose page no longer shows the step",
    async (left) => {
      // A restarted worker finds the attempt between steps or waiting to be tried again, on a
      // page without its step: nothing was submitted, so there is no result to wait for, and
      // the step's own wait and the retries decide (ADR 0022).
      fake.state.awaited = { ok: false, reason: "timeout" };
      const first = harness();
      expect(await first.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "blocked", outcome: "retry-limit" },
        ]),
      );
      const [record] = fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[];
      const { outcome: _outcome, retryRequired: _retryRequired, ...between } = record!;
      fake.state.storage["pateat.login-attempts.v5"] = [{ ...between, ...left }];
      fake.state.present = new Set();
      const report = vi.fn<(report: LoginReport) => void>();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { report });
        expect(await restarted.hello({ documentId: "after-restart" })).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
              { state: "blocked", outcome: "retry-limit", retries: 2, submissions: 0 },
            ]),
          { timeout: 4_500 },
        );
        expect(
          report.mock.calls.some(
            ([entry]) => entry.type === "attempt" && entry.outcome === "unknown-submit",
          ),
        ).toBe(false);
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
      } finally {
        fake.browser.tabs.query = query;
      }
    },
  );
  describe("how long a login took (ADR 0019)", () => {
    const attemptReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls
        .map(([entry]) => entry)
        .filter(
          (entry): entry is Extract<LoginReport, { type: "attempt" }> => entry.type === "attempt",
        );
    it("logs the times once, when the login signs in", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      const before = Date.now();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attemptReports(report).map((entry) => entry.state)).toContain("authenticated"),
      );
      const reports = attemptReports(report);
      expect(reports.filter((entry) => entry.times)).toHaveLength(1);
      const { times } = reports.find((entry) => entry.state === "authenticated")!;
      // Nothing waited for the service or the person: all of it is the site and Pateat.
      expect(times).toEqual({
        totalMs: expect.any(Number),
        serviceMs: 0,
        networkMs: 0,
        personMs: 0,
        pageMs: expect.any(Number),
        otherMs: times!.totalMs - times!.pageMs,
      });
      expect(times!.totalMs).toBeLessThanOrEqual(Date.now() - before);
      // The record keeps its stamps, never a value's typing time.
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated", timing: { since: expect.any(Number), serviceMs: 0 } },
      ]);
    });
    it("counts the wait for the site's answer to a click apart from Pateat's own time", async () => {
      // The site shows the signed-in page 400 ms after the click.
      fake.state.present = new Set(["password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          setTimeout(() => {
            fake.state.present = new Set(["authenticated"]);
          }, 400);
      };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attemptReports(report).map((entry) => entry.state)).toContain("authenticated"),
      );
      const { times } = attemptReports(report).find((entry) => entry.state === "authenticated")!;
      expect(times!.pageMs).toBeGreaterThanOrEqual(300);
      expect(times!.serviceMs + times!.personMs + times!.pageMs + times!.otherMs).toBe(
        times!.totalMs,
      );
      // The record no longer waits for the site.
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
        { state: "authenticated", timing: { pageMs: times!.pageMs } },
      ]);
      expect(fake.state.storage["pateat.login-attempts.v5"]).not.toHaveProperty(
        "0.timing.pageSince",
      );
    });
    it("takes over the time of the sign-in entry pressed just before, once", async () => {
      // The entry page was seen five seconds ago; its generation took 2 s, 0.3 s of it on
      // the network, and its entry was pressed a second ago.
      const now = Date.now();
      const press = {
        tabId: 1,
        origin,
        recipeId: "synthetic-entry",
        revision: 2,
        pressedAt: new Date(now - 1_000).toISOString(),
        documentId: "entry-page",
        url: `${origin}/`,
        checked: true,
        timing: { since: now - 5_000, serviceMs: 2_000, networkMs: 300, personMs: 0 },
      };
      fake.state.session["pateat.login-entry-presses.v1"] = [press];
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(attemptReports(report).map((entry) => entry.state)).toContain("authenticated"),
      );
      const { times } = attemptReports(report).find((entry) => entry.state === "authenticated")!;
      expect(times).toMatchObject({ serviceMs: 2_000, networkMs: 300, personMs: 0 });
      expect(times!.totalMs).toBeGreaterThanOrEqual(5_000);
      // From the press until the next page was seen, the login waited for the site.
      expect(times!.pageMs).toBeGreaterThanOrEqual(1_000);
      expect(times!.otherMs).toBe(times!.totalMs - 2_000 - times!.pageMs);
      // The press keeps no time, so no later login takes it again.
      const { timing: _taken, ...untimed } = press;
      expect(fake.state.session["pateat.login-entry-presses.v1"]).toEqual([untimed]);
    });
    it("counts on from the stored record after a worker restart", async () => {
      fake.state.awaited = { ok: false, reason: "timeout" };
      const first = harness();
      expect(await first.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "blocked", outcome: "retry-limit" },
        ]),
      );
      const [record] = fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[];
      // The stopped worker had spent a minute on the login: 5 s on the service, of which
      // 0.8 s on the network, and 1 s waiting for the person.
      const since = Date.now() - 60_000;
      fake.state.storage["pateat.login-attempts.v5"] = [
        {
          ...record,
          state: "retryable",
          outcome: "structural-mismatch",
          retries: 1,
          retryRequired: true,
          timing: { since, serviceMs: 5_000, networkMs: 800, personMs: 1_000, pageMs: 0 },
        },
      ];
      fake.state.awaited = { ok: true };
      fake.state.present = new Set(["password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          fake.state.present = new Set(["authenticated"]);
      };
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const report = vi.fn<(report: LoginReport) => void>();
        const restarted = harness({}, { report });
        expect(await restarted.hello({ documentId: "after-restart" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(attemptReports(report).map((entry) => entry.state)).toContain("authenticated"),
        );
        const { times } = attemptReports(report).find((entry) => entry.state === "authenticated")!;
        expect(times).toMatchObject({ serviceMs: 5_000, networkMs: 800, personMs: 1_000 });
        expect(times!.totalMs).toBeGreaterThanOrEqual(60_000);
        expect(times!.otherMs).toBe(times!.totalMs - 6_000 - times!.pageMs);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
  });
  describe("a login form inside a frame", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
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
        expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([
          { state: "authenticated" },
        ]),
      );
      expect(signedIn.mock.calls.toSorted()).toEqual([
        [1, origin],
        [1, "https://portal.example"],
      ]);
    });
    it("ignores a sandboxed frame of an admitted page before any policy or vault access", async () => {
      const h = harness();
      const top = "https://login.example/home";
      // `<iframe sandbox>` of the login page: its URL is the site's, its origin opaque (#637).
      expect(await h.hello(framed(top, { origin: "null" }))).toEqual({
        ok: false,
        reason: "unauthorized-document",
      });
      expect(h.store.handle).not.toHaveBeenCalled();
      expect(h.recipes.recipe).not.toHaveBeenCalled();
      expect(fake.state.messages).toEqual([]);
      // The same frame with the site's origin starts the login.
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
    });
    it("fills nothing in a frame of a page a rule pauses (ADR 0062)", async () => {
      const h = harness({
        excludedSites: [{ hostname: "evil.example", includeSubdomains: false }],
      });
      expect(await h.hello(framed("https://evil.example/"))).toMatchObject({ ok: false });
      expect(h.fields).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
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
      expect(fake.state.storage["pateat.login-attempts.v5"]).toHaveLength(1);
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
});
