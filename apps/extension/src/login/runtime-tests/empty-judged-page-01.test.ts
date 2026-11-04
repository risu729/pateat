import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, sender, target, uriMatch, harness } = createRuntimeTestHarness(fake);

// A judged page that described nothing, as a page still loading, is read again once its
// document says it shows something (ADR 0027 amendment of 2026-11-04).
describe("a judged page that described nothing", () => {
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
  const verifyPage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/verify",
      language: "en",
      complete: true,
      candidates: [{ id: "c1", role: "button", target: target("verify"), label: "Verify" }],
    },
  };
  const uris = async () => ({ ok: true as const, data: uriMatch() });
  const status = () => fake.state.storage["pateat.login-attempts.v5"];

  async function settledEmpty(verdict: "signed-in" | "unclear") {
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict };
    });
    const service = {
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
    };
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
    // The click's page, in the same document, shows nothing to describe yet.
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
      fake.state.present = new Set();
      fake.state.observedPath = "/verify";
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", settled: true },
        ]),
      { timeout: 8_000 },
    );
    const judged = () =>
      report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : []));
    expect(judged()).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "no-candidates" }),
    ]);
    expect(judge).not.toHaveBeenCalled();
    // The document was asked to say once it shows something, for the watch's ten minutes.
    const watches = fake.state.messages.filter((entry) => entry.type === "login.extract.watch");
    expect(watches).toEqual([expect.objectContaining({ timeoutMs: 600_000 })]);
    const described = (from: Record<string, unknown> = {}, token = "synthetic-token") =>
      h.login.handle({ version: 1, type: "login.document.described", token }, sender(from));
    return { judge, judged, described, h };
  }

  it("judges the page again once it shows something, as Oracle's Verify page", async () => {
    // Seen on 2026-11-04 at 11:26 UTC: the judge read Oracle's "Verify your identity" page
    // while it was still loading, sent nothing, and the tab sat until the person moved on.
    const { judge, judged, described } = await settledEmpty("signed-in");
    fake.state.extracted = { "signed-in": verifyPage };
    // Another document of the tab, or the wrong token, reads nothing again.
    await described({ documentId: "other-document" });
    await described({}, "other-token");
    await quiet();
    expect(judge).not.toHaveBeenCalled();
    await described();
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 8_000,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]![3]).toEqual(verifyPage.observation);
    expect(judged().at(-1)).toMatchObject({ verdict: "signed-in" });
  }, 20_000);

  it("reads it once: a page judged since stays watched, and a later report reads nothing", async () => {
    const { judge, described } = await settledEmpty("unclear");
    fake.state.extracted = { "signed-in": verifyPage };
    await described();
    await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1), { timeout: 8_000 });
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", settled: true },
        ]),
      { timeout: 8_000 },
    );
    // The page was described, so nothing waits for it any more.
    await described();
    await quiet();
    expect(judge).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("reads a later document of the tab that showed something, as the first one", async () => {
    const { judge, described, h } = await settledEmpty("signed-in");
    // The tab's next document is still loading too when it is read.
    fake.state.gone.add("synthetic-document");
    await h.hello({ documentId: "document-2" }, false);
    await vi.waitFor(
      () =>
        expect(
          fake.state.messages.filter((entry) => entry.type === "login.extract.watch"),
        ).toHaveLength(2),
      { timeout: 8_000 },
    );
    expect(judge).not.toHaveBeenCalled();
    fake.state.extracted = { "signed-in": verifyPage };
    await described({ documentId: "document-2" });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 8_000,
    });
    expect(judge).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("asks a page that keeps turning empty again at most three times", async () => {
    const { judge, described } = await settledEmpty("signed-in");
    const watches = () =>
      fake.state.messages.filter((entry) => entry.type === "login.extract.watch");
    // Each report is read on a page that is empty again by then.
    for (const count of [2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      await described();
      // eslint-disable-next-line no-await-in-loop
      await vi.waitFor(() => expect(watches()).toHaveLength(count), { timeout: 8_000 });
    }
    await described();
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", settled: true },
        ]),
      { timeout: 8_000 },
    );
    await quiet();
    await described();
    await quiet();
    expect(watches()).toHaveLength(3);
    expect(judge).not.toHaveBeenCalled();
  }, 30_000);
});

/** Lets a report that would read the page again run, if it did. */
async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
