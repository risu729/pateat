import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdsOrigin,
  parseLoginRecipe,
  type LoginAttemptMetadata,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, harness } = createRuntimeTestHarness(fake);

// A login that sent nothing but its account identifier before its stop (ADR 0036, #1847):
// its tab's move to another origin of the site never signs it in, its page is never sent
// to the judge, and the login it ends holds nothing against the site's other tabs.
describe("a move after only the identifier of an item without a password", () => {
  afterEach(() => {
    vi.useRealTimers();
    // Both tabs close, so no login of the last case runs on into the next.
    for (const listener of fake.state.removed.splice(0)) for (const tab of [1, 2]) listener(tab);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    // Next never answers: the tab moves to another origin of the site meanwhile.
    fake.state.onExecute = (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      return step.kind === "click" ? new Promise(() => undefined) : Promise.resolve();
    };
  });
  const www = "https://www.login.example";
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "synthetic-email-first",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
      {
        kind: "fill",
        path: "/password",
        fields: [{ slot: "password", target: target("password") }],
      },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
  const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
  async function until(check: () => boolean, maxMs = 60_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  /** A login of the item, its Next in flight when the tab moves to the site's `www`. */
  async function moved(password: boolean) {
    vi.useFakeTimers();
    const report = vi.fn<(entry: LoginReport) => void>();
    // The judge would read the moved page as signed in.
    const judge = vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return { verdict: "signed-in" };
    });
    const h = harness(
      {},
      {
        allowedOrigins: [origin],
        username: true,
        report,
        passkeys: vi.fn(async () => ({ passkey: true, discoverable: false })),
        generation: {
          available: vi.fn<LoginGeneration["available"]>(async () => true),
          generate: vi.fn<LoginGeneration["generate"]>(),
          generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
          judge,
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      },
    );
    h.recipes.recipe.mockResolvedValue(emailFirst);
    const original = h.store.handle.getMockImplementation()!;
    if (!password)
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          for (const field of response.catalog.connections[0]!.items[0]!.fields)
            if (field.id === "login.password") field.empty = true;
        return response;
      });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    // A quiet page that shows no username, which the judge would call signed in.
    fake.state.signs = quiet;
    fake.state.observedPath = "/home";
    fake.state.extracted = {
      "signed-in": {
        ok: true,
        observation: {
          version: 1,
          origin: www,
          path: "/home",
          language: "en",
          complete: true,
          candidates: [{ id: "c1", role: "button", target: target("logout"), label: "Sign out" }],
        },
      },
    };
    fake.state.tabUrls[1] = `${www}/home`;
    void h.hello({ documentId: "home-document", url: `${www}/home` }, false);
    await until(
      () =>
        status()?.[0]?.["state"] !== "awaiting-result" &&
        status()?.[0]?.["state"] !== "submit-intent",
    );
    const judgements = report.mock.calls.flatMap(([entry]) =>
      entry.type === "judge" ? [entry] : [],
    );
    return { h, judge, judgements, report };
  }

  it("ends left-origin without the judge, holding nothing", async () => {
    const { h, judge, judgements, report } = await moved(false);
    const record = status()![0] as unknown as LoginAttemptMetadata;
    expect(record).toMatchObject({ state: "blocked", outcome: "left-origin", stopAt: 2 });
    expect(judge).not.toHaveBeenCalled();
    expect(judgements).toEqual([]);
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ type: "move", origin: www, reason: "no-factor" }),
    );
    expect(holdsOrigin(record)).toBe(false);
    // Another tab of the site logs in rather than being refused `origin-busy`.
    fake.state.onExecute = undefined;
    fake.state.observedPath = "/signin";
    fake.state.tabUrls[2] = fake.state.pageUrl;
    expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
  });

  it("is still judged, and signed in, for an item that signs in with its password", async () => {
    // No stop: an identifier's Next is judged on the moved page as before (ADR 0022
    // amendment of 2026-11-08).
    const { judge } = await moved(true);
    expect(status()![0]).toMatchObject({ state: "authenticated" });
    expect(status()![0]).not.toHaveProperty("stopAt");
    expect(judge).toHaveBeenCalledTimes(1);
  });
});
