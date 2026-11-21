import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, savedBinding, harness } = createRuntimeTestHarness(fake);

// An identifier split over several inputs (ADR 0089): the worker reads the username and,
// when the recipe's boxes cannot take it, leaves the page to the person before any fill.
// Synthetic recipe and values.
describe("a login whose recipe splits the username over several inputs", () => {
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
    fake.state.present = undefined;
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.loaded = true;
  });
  const split = parseLoginRecipe({
    version: 1,
    id: "synthetic-split",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["username"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [{ slot: "username", target: target("number1"), split: [4, 4, 5] }],
      },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    ],
    completion: [{ target: target("authenticated") }],
    maxSubmissions: 1,
  });
  const bindings = [{ ...savedBinding, slots: [{ slot: "username", field: "username" as const }] }];
  const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const attempts = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
    report.mock.calls.flatMap(([entry]) => (entry.type === "attempt" ? [entry] : []));

  it("sends the fill with the username whole when the boxes can take it", async () => {
    const h = harness({ bindings }, { username: true });
    h.recipes.recipe.mockResolvedValue(split);
    h.fields.mockImplementation(async () => "1234-5678-12345");
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed().length).toBeGreaterThan(0));
    expect(executed()[0]).toMatchObject({
      operation: { step: { kind: "fill", fields: [{ slot: "username", split: [4, 4, 5] }] } },
      values: [{ slot: "username" }],
    });
  });

  it("fills nothing and leaves the page to the person when they cannot", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({ bindings }, { username: true, report });
    h.recipes.recipe.mockResolvedValue(split);
    h.fields.mockImplementation(async () => "1234-5678-123456");
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts(report).at(-1)).toMatchObject({
        outcome: "challenge",
        cause: "identifier-unfit",
      }),
    );
    expect(executed()).toEqual([]);
    // The value is never logged.
    expect(JSON.stringify(report.mock.calls)).not.toContain("1234");
  });
});
