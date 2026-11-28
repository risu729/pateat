import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, uriMatch, harness } = createRuntimeTestHarness(fake);

// UNSW Endeavour (2026-11-28 01:54 UTC): "log on" drew the student record chooser in the
// same document on the same path, with nothing the judge could be shown. Such a page
// completes the login unconfirmed once the sign-in form is gone from the step's own
// document on its sign-in path, and a fresh reading still shows no sign (ADR 0029
// amendment of 2026-11-28).
describe("a judged page with nothing to describe after the sign-in form is gone", () => {
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
    fake.state.present = new Set(["user", "password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.hiddenInputs = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.siteAccount = { ok: false };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    // A page with no sign of a sign-in going on or done: the judge's page.
    fake.state.signs = {
      password: false,
      code: false,
      captcha: false,
      invalid: false,
      alert: false,
    };
    fake.state.loaded = true;
    fake.state.openTabs = undefined;
  });

  const unsaved = { siteDefaults: [], bindings: [] };
  const generated = parseLoginRecipe({
    version: 1,
    id: "gen-synthetic",
    revision: 1,
    origin,
    pageKind: "sign-in",
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
  const uris = async () => ({ ok: true as const, data: uriMatch() });
  const status = () => fake.state.storage["pateat.login-attempts.v5"];
  const watches = () => fake.state.messages.filter((entry) => entry.type === "login.extract.watch");

  /**
   * Starts the login; on its click the page in the same document drops the sign-in form,
   * and `clicked` changes the page further.
   */
  async function submitted(clicked: (h: ReturnType<typeof harness>) => void = () => {}) {
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "signed-in" };
    });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(unsaved, {
      allowedOrigins: [],
      uris,
      username: true,
      generation: {
        available: vi.fn<LoginGeneration["available"]>(async () => true),
        generate: vi.fn<LoginGeneration["generate"]>(async () => ({
          outcome: "abstained",
          reason: "ambiguous",
        })),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(async () => ({
          outcome: "abstained",
          reason: "ambiguous",
        })),
        judge,
        slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      },
      report,
    });
    h.recipes.recipe.mockResolvedValue(generated);
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
      fake.state.present = new Set();
      clicked(h);
    };
    expect(await h.hello()).toEqual({ ok: true });
    const judged = () =>
      report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : []));
    return { judge, judged };
  }

  /** Waits for the login to settle as unknown without the judge, as before the amendment. */
  async function settledUnknown(judge: ReturnType<typeof vi.fn>) {
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", settled: true },
        ]),
      { timeout: 8_000 },
    );
    expect(judge).not.toHaveBeenCalled();
  }

  it("completes unconfirmed on its sign-in path, without the judge, as Endeavour", async () => {
    const { judge, judged } = await submitted();
    await vi.waitFor(
      () => expect(status()).toMatchObject([{ state: "authenticated", unconfirmed: true }]),
      { timeout: 8_000 },
    );
    expect(judge).not.toHaveBeenCalled();
    expect(judged()).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "no-candidates", completed: true }),
    ]);
    // Nothing waits for the page to show something.
    expect(watches()).toEqual([]);
  }, 20_000);

  it("keeps the earlier rule on another path, as Oracle's Verify page still loading", async () => {
    const { judge, judged } = await submitted(() => {
      fake.state.observedPath = "/verify";
    });
    await settledUnknown(judge);
    expect(judged()).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "no-candidates" }),
    ]);
    expect(judged()[0]).not.toHaveProperty("completed");
    expect(watches()).toHaveLength(1);
  }, 20_000);

  it("does not complete while a sign-in input is kept hidden in the step's document", async () => {
    // A single-page site may hide its form while it answers; hidden inputs count here.
    const { judge, judged } = await submitted(() => {
      fake.state.present = new Set(["password"]);
      fake.state.hiddenInputs = new Set(["password"]);
    });
    await settledUnknown(judge);
    expect(judged()).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "sign-in-shown" }),
    ]);
    expect(judged()[0]).not.toHaveProperty("completed");
  }, 20_000);

  it("does not complete when the fresh reading finds the document loading again", async () => {
    // The page starts loading again as it is described, before the fresh reading.
    const { judge, judged } = await submitted(() => {
      fake.state.extracted = Object.defineProperty({}, "signed-in", {
        get: () => {
          fake.state.loaded = false;
          return undefined;
        },
      });
    });
    await settledUnknown(judge);
    expect(judged()).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "no-candidates" }),
    ]);
    expect(judged()[0]).not.toHaveProperty("completed");
    expect(watches()).toHaveLength(1);
  }, 20_000);

  it("does not complete in a new document after the step, which may still be loading", async () => {
    const { judge, judged } = await submitted((h) => {
      fake.state.gone.add("synthetic-document");
      setTimeout(() => void h.hello({ documentId: "document-2" }, false), 0);
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    await settledUnknown(judge);
    expect(status()).toMatchObject([{ document: { documentId: "document-2" } }]);
    expect(judged()).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "no-candidates" }),
    ]);
    expect(judged()[0]).not.toHaveProperty("completed");
    expect(watches()).toHaveLength(1);
  }, 20_000);
});
