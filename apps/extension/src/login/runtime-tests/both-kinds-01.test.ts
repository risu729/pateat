import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginChooserRecipe } from "@pateat/contracts";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, recipe, target, uriMatch, harness } = createRuntimeTestHarness(fake);

// The same URL shows a sign-in form or a list of accounts by the state of the browser's
// session, so one recipe holds layouts of both (ADR 0028, #1248): a new login runs the list
// when it shows, and the form's layouts otherwise.
describe("a recipe that holds a sign-in form and a list of accounts (#1248)", () => {
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
    fake.state.signIn = false;
    fake.state.awaited = { ok: true };
    fake.state.awaitReply = undefined;
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
  });

  const verify = { by: "text" as const, value: "Verify" };
  /** The list stored beside the harness's sign-in form, under the same recipe. */
  const list: LoginChooserRecipe = {
    version: 1,
    id: recipe.id,
    revision: recipe.revision,
    origin,
    layout: "2000",
    chooser: { path: "/signin", continue: verify },
  };
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true as const, data: uriMatch() }));
  const generation = () => ({
    available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
    generate: vi.fn<LoginGeneration["generate"]>(async () => ({
      outcome: "abstained",
      reason: "ambiguous",
    })),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "signed-in" })),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  });
  const executions = () =>
    fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
      list?: unknown;
      operation: { step: { kind: string } };
    }[];
  const listAsked = () =>
    fake.state.messages.some(
      (entry) =>
        entry.type === "login.await" &&
        (entry as unknown as { readiness: { accounts?: boolean } }).readiness.accounts === true,
    );

  it("runs the list when it shows", async () => {
    const h = harness(
      { siteDefaults: [], bindings: [] },
      { allowedOrigins: [], uris, username: true, custom: [], generation: generation() },
    );
    h.recipes.chooser.mockResolvedValue(list);
    h.recipes.starts.mockResolvedValue([
      { path: "/signin", steps: [recipe.steps[0]!], list: [verify] },
    ]);
    // The document reads a list: no sign-in input, and the list's button.
    fake.state.awaitReply = (readiness) => (readiness.accounts === true ? { ok: true } : undefined);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executions().length).toBeGreaterThan(0));
    expect(executions()[0]!.list).toBeDefined();
    expect(executions().some((entry) => entry.operation.step.kind === "fill")).toBe(false);
  });

  it("runs the form's layout when the list does not show", async () => {
    const h = harness();
    h.recipes.chooser.mockResolvedValue(list);
    h.recipes.starts.mockResolvedValue([
      { path: "/signin", steps: [recipe.steps[0]!], list: [verify] },
    ]);
    fake.state.awaitReply = (readiness) =>
      readiness.accounts === true ? { ok: false, reason: "timeout" } : undefined;
    expect(await h.hello()).toEqual({ ok: true });
    expect(listAsked()).toBe(true);
    await vi.waitFor(() => expect(executions().length).toBeGreaterThan(0));
    expect(executions()[0]).toMatchObject({ operation: { step: { kind: "fill" } } });
    expect(executions()[0]!.list).toBeUndefined();
  });

  it("never runs another recipe's list on the form's path", async () => {
    const h = harness();
    h.recipes.chooser.mockResolvedValue({ ...list, id: "gen-another" });
    fake.state.awaitReply = (readiness) => (readiness.accounts === true ? { ok: true } : undefined);
    expect(await h.hello()).toEqual({ ok: true });
    expect(listAsked()).toBe(false);
    await vi.waitFor(() => expect(executions().length).toBeGreaterThan(0));
    expect(executions()[0]).toMatchObject({ operation: { step: { kind: "fill" } } });
  });

  const other = { by: "text" as const, value: "Use another account" };
  /** The list with an `other` branch whose own form starts on the list's path. */
  const withOther = (): LoginChooserRecipe => ({
    ...list,
    chooser: {
      path: "/signin",
      other,
      afterOther: parseLoginRecipe({
        version: 1,
        id: recipe.id,
        revision: recipe.revision,
        origin,
        layout: "2000",
        pageKind: "sign-in",
        slots: ["password"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "password", target: target("other-password") }],
          },
          { kind: "click", path: "/signin", target: target("other-login"), purpose: "submit" },
        ],
        maxSubmissions: 1,
      }),
    },
  });

  it("runs the list's other branch when only its form shows, and none of the form's", async () => {
    const h = harness();
    h.recipes.chooser.mockResolvedValue(withOther());
    fake.state.present = new Set(["other-password", "other-login"]);
    fake.state.awaitReply = (readiness) =>
      readiness.accounts === true
        ? { ok: false, reason: "timeout" }
        : (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
              fake.state.present!.has(entry.value),
            )
          ? { ok: true }
          : { ok: false, reason: "timeout" };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executions().length).toBeGreaterThan(0));
    expect(executions()[0]).toMatchObject({
      operation: { step: { kind: "fill", fields: [{ target: target("other-password") }] } },
    });
  });

  // Every page the recipe's path may show, by which of the list, its `other` branch's form
  // and the recipe's own form are there: the list goes first, then the branch when the
  // form is not there, then the form (ADR 0028).
  it.each(
    [false, true].flatMap((listShows) =>
      [false, true].flatMap((branchShows) =>
        [false, true].map((formShows) => ({ listShows, branchShows, formShows })),
      ),
    ),
  )("chooses by what shows: %o", async ({ listShows, branchShows, formShows }) => {
    // As above, an account the list can name.
    const h = harness(
      { siteDefaults: [], bindings: [] },
      { allowedOrigins: [], uris, username: true, custom: [], generation: generation() },
    );
    h.recipes.chooser.mockResolvedValue(withOther());
    h.recipes.starts.mockResolvedValue([
      { path: "/signin", steps: [recipe.steps[0]!], list: [verify] },
    ]);
    fake.state.present = new Set([
      ...(branchShows ? ["other-password", "other-login"] : []),
      ...(formShows ? ["password", "login"] : []),
    ]);
    fake.state.awaitReply = (readiness) =>
      readiness.accounts === true
        ? listShows
          ? { ok: true }
          : { ok: false, reason: "timeout" }
        : (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
              fake.state.present!.has(entry.value),
            )
          ? { ok: true }
          : { ok: false, reason: "timeout" };
    const reply = await h.hello();
    const expected = listShows
      ? "list"
      : branchShows && !formShows
        ? "other-password"
        : formShows
          ? "password"
          : "none";
    expect(reply).toEqual({ ok: true });
    // With nothing there, the form's login waits for its first step.
    if (expected === "none") return expect(executions()).toEqual([]);
    await vi.waitFor(() => expect(executions().length).toBeGreaterThan(0));
    const first = executions()[0]!;
    if (expected === "list") expect(first.list).toBeDefined();
    else
      expect(first).toMatchObject({
        operation: { step: { kind: "fill", fields: [{ target: target(expected) }] } },
      });
  });
});
