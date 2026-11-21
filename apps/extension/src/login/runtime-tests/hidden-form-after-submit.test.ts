import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, recipe, harness } = createRuntimeTestHarness(fake);

// My Digital Connect (2026-11-21 19:45 UTC): the page the submit loads is signed in, but it
// keeps hidden copies of the sign-in fields. In a new document after the login's own step,
// a sign-in field counts only shown (ADR 0029 amendment of 2026-11-21).
describe("a sign-in form kept hidden after the submit (ADR 0029)", () => {
  afterEach(() => {
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
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
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.hiddenInputs = new Set();
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
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const signedInPage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/signin",
      language: "en",
      complete: true,
      candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
    },
  };
  const { completion: _completion, ...unmarked } = recipe;
  const withoutMarker = parseLoginRecipe(unmarked);
  const marked = parseLoginRecipe({
    ...unmarked,
    completion: [{ target: target("logout"), absent: [target("password")] }],
  });
  function start(chosen: typeof recipe) {
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "signed-in" };
    });
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(
      {},
      {
        report,
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
          generate: vi.fn<LoginGeneration["generate"]>(async () => ({
            outcome: "skipped",
            reason: "sent",
          })),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge,
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      },
    );
    h.recipes.recipe.mockResolvedValue(chosen);
    return { h, judge, report };
  }
  /** On the submit, the page shows a sign-out button and keeps the password input hidden. */
  function signsIn(h: ReturnType<typeof harness>, newDocument: boolean) {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string } }).step;
      if (step.kind !== "click") return;
      fake.state.present = new Set(["logout", "password"]);
      fake.state.hiddenInputs = new Set(["password"]);
      fake.state.extracted = { "signed-in": signedInPage };
      if (!newDocument) return;
      fake.state.gone.add("synthetic-document");
      setTimeout(() => void h.hello({ documentId: "signed-in" }, false), 0);
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
  }

  it("sends the new page to the judge and completes on its answer", async () => {
    const { h, judge } = start(withoutMarker);
    signsIn(h, true);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "authenticated", document: { documentId: "signed-in" } },
        ]),
      { timeout: 6_000 },
    );
    expect(judge).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("completes on a marker whose field is only hidden in the new page, without the judge", async () => {
    const { h, judge } = start(marked);
    signsIn(h, true);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(status()).toMatchObject([
          { state: "authenticated", document: { documentId: "signed-in" } },
        ]),
      { timeout: 6_000 },
    );
    expect(judge).not.toHaveBeenCalled();
  }, 10_000);

  it("still reads a form the submit's own document hides as the sign-in page", async () => {
    const { h, judge, report } = start(marked);
    signsIn(h, false);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(
      () =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "judge", verdict: "not-sent" }),
        ),
      { timeout: 6_000 },
    );
    expect(status()).not.toMatchObject([{ state: "authenticated" }]);
    expect(judge).not.toHaveBeenCalled();
  }, 10_000);
});
