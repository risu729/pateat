import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginAttemptMetadata,
  type LoginStep,
} from "@pateat/contracts";
import { manualOfferResponseSchema, type ManualStartRequest } from "../manual-wire";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  otherItemId,
  uriMatch,
  harness,
  recipe,
  sender,
  realTime,
  target,
  savedBinding,
} = createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const fillPolicy: Partial<LocalSettings> = {
  pagePermissionDefaults: { "sign-in": "fill", confirm: "fill", "personal-details": "fill" },
};
const stored = () =>
  (fake.state.storage["pateat.login-attempts.v5"] ?? []) as LoginAttemptMetadata[];
const executes = () =>
  fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
    operation: { attemptId: string; step: LoginStep; signInFill?: true };
  }[];
const offers = async (h: ReturnType<typeof harness>) =>
  v.parse(
    manualOfferResponseSchema,
    await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
  );
async function request(
  h: ReturnType<typeof harness>,
  requestId = "manual-after-autofill",
): Promise<ManualStartRequest> {
  const offered = await offers(h);
  expect(offered).toMatchObject({
    ok: true,
    targets: [expect.objectContaining({ document: expect.objectContaining({ frameId: 0 }) })],
  });
  if (!offered.ok || !offered.targets[0]) throw new Error("No manual target");
  return {
    requestId,
    document: offered.targets[0].document,
    scope: offered.targets[0].scope,
    connectionId,
    itemId,
  };
}
/** Starts the request; the page answers its reconnect by announcing, as it does. */
const run = (h: ReturnType<typeof harness>, pick: ManualStartRequest) => {
  fake.state.onReconnect ??= async () => h.hello({}, false);
  return h.login.handle({ version: 1, type: "login.manual.start", ...pick }, popup);
};
let changes: (() => void)[] = [];
const releaseChanges = () => {
  for (const resolve of changes.splice(0)) resolve();
};
const originalSend = fake.browser.tabs.sendMessage;
beforeEach(() => {
  realTime();
  Object.assign(fake.state, {
    storage: {},
    session: {},
    messages: [],
    badges: {},
    reconnects: [],
    onReconnect: undefined,
    granted: true,
    pageUrl: `${origin}/signin`,
    observedPath: "/signin",
    present: new Set(["password", "login"]),
    signIn: false,
    onExecute: undefined,
    tabUrls: {},
    incognito: new Set(),
    observed: ["unique", "missing"],
    unusable: new Set(),
    disabled: new Set(),
    faint: new Set(),
    ambiguous: new Set(),
    unobservable: new Set(),
    awaited: { ok: true },
    onAwait: undefined,
    executeReply: undefined,
    switchReply: { ok: true },
    chosen: { ok: true, click: "entry" },
    siteAccount: { ok: false },
    gone: new Set(),
    goneFrames: new Set(),
    onPresent: undefined,
    extracted: {},
    signs: undefined,
    loaded: true,
    openTabs: undefined,
  });
  changes = [];
  vi.spyOn(fake.browser.tabs, "sendMessage").mockImplementation(async (...args) => {
    if (args[1]["type"] === "login.fill.change") {
      fake.state.messages.push(structuredClone(args[1]) as (typeof fake.state.messages)[number]);
      await new Promise<void>((resolve) => changes.push(resolve));
      return { ok: true };
    }
    return originalSend(...args);
  });
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tab of [1, 2, 3]) listener(tab);
  fake.state.replaced.length = 0;
  releaseChanges();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function start(settings: Partial<LocalSettings> = {}, live: Parameters<typeof harness>[1] = {}) {
  const reports: LoginReport[] = [];
  const h = harness(
    { ...fillPolicy, ...settings },
    {
      uris: async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }),
      ...live,
      report: (entry) => reports.push(entry),
    },
  );
  return { h, reports };
}
/**
 * Two fills on one path: the passive fill parks on its read-only wait after the
 * identifier until the password shows, rather than ending once nothing is left to fill.
 */
const twoStep = parseLoginRecipe({
  ...recipe,
  id: "synthetic-two-step-fill",
  slots: ["username", "password"],
  steps: [
    { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
    { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("password") }] },
    { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
  ],
  maxSubmissions: 2,
});
function passive(settings: Partial<LocalSettings> = {}, live: Parameters<typeof harness>[1] = {}) {
  const test = start(
    {
      bindings: [
        {
          ...savedBinding,
          recipeId: twoStep.id,
          slots: [
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        },
      ],
      ...settings,
    },
    { username: true, ...live },
  );
  test.h.recipes.recipe.mockResolvedValue(twoStep);
  fake.state.present = new Set(["email", "next"]);
  return test;
}
async function waiting() {
  await vi.waitFor(() =>
    expect(stored()[0]).toMatchObject({
      signInFill: true,
      state: "ready",
      stepIndex: 1,
      submissions: 0,
    }),
  );
  await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
}
function authenticateOnManualClick() {
  fake.state.onExecute = async (message) => {
    const operation = message["operation"] as { step: LoginStep };
    if (operation.step.kind !== "click") return;
    fake.state.present =
      operation.step.target.value === "next"
        ? new Set(["password", "login"])
        : new Set(["authenticated"]);
  };
}

describe("one-time manual login after passive autofill", () => {
  it("offers and starts one normal login while the passive driver is idle, fencing its late callback", async () => {
    const { h } = passive();
    expect(await h.hello()).toEqual({ ok: true });
    await waiting();
    const previous = stored()[0]!.id;
    const settings = structuredClone(h.settings);
    const pick = await request(h);
    fake.state.onReconnect = () => h.hello();
    authenticateOnManualClick();
    expect(await run(h, pick)).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(stored()[0]).toMatchObject({ state: "authenticated", submissions: 2 }),
    );
    const active = structuredClone(stored());
    expect(active[0]!.id).not.toBe(previous);
    expect(active[0]?.signInFill).toBeUndefined();
    // The passive identifier fill, then the manual login's fill, advance, fill and submit.
    expect(executes()).toHaveLength(5);
    expect(executes()[0]?.operation.signInFill).toBe(true);
    expect(executes().filter((entry) => entry.operation.step.kind === "click")).toHaveLength(2);
    expect(
      executes()
        .slice(1)
        .every((entry) => entry.operation.signInFill === undefined),
    ).toBe(true);
    const reads = h.fields.mock.calls.length;
    releaseChanges();
    await vi.waitFor(() => expect(stored()).toEqual(active));
    expect(executes()).toHaveLength(5);
    // The passive fill's late wake reads nothing more.
    expect(h.fields).toHaveBeenCalledTimes(reads);
    expect(h.fields.mock.calls.slice(0, 3).map(([read]) => read.fieldId)).toEqual([
      "login.username",
      "login.username",
      "login.password",
    ]);
    expect(h.settings).toEqual(settings);
    expect(h.store.update).not.toHaveBeenCalled();
  });

  it("retries a passive fill that ended with nothing left to fill as one normal login", async () => {
    const { h } = start();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(stored()[0]).toMatchObject({ signInFill: true, state: "blocked", fillDone: true }),
    );
    const previous = stored()[0]!.id;
    const settings = structuredClone(h.settings);
    const pick = await request(h);
    fake.state.onReconnect = () => h.hello();
    authenticateOnManualClick();
    expect(await run(h, pick)).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(stored()[0]).toMatchObject({ state: "authenticated", submissions: 1 }),
    );
    expect(stored()[0]!.id).not.toBe(previous);
    expect(stored()[0]?.signInFill).toBeUndefined();
    expect(executes().map((entry) => entry.operation.step.kind)).toEqual(["fill", "fill", "click"]);
    expect(h.settings).toEqual(settings);
    expect(h.store.update).not.toHaveBeenCalled();
  });

  it("does not restore a one-time manual authorization after a worker restart", async () => {
    const { h } = passive();
    await h.hello();
    await waiting();
    const pick = await request(h);
    expect(await run(h, pick)).toMatchObject({ ok: true, state: "evaluating" });
    const restarted = passive().h;
    await restarted.hello();
    await waiting();
    expect(executes().filter((entry) => entry.operation.step.kind === "click")).toEqual([]);
    expect(stored()[0]).toMatchObject({ signInFill: true, submissions: 0 });
    releaseChanges();
    expect(executes().filter((entry) => entry.operation.step.kind === "click")).toEqual([]);
  });
  // The popup asks a page a restarted worker forgot to announce again (ADR 0085, amended
  // 2026-11-18): the fill's own record fences the same document, so nothing is filled
  // twice, and what the person typed meanwhile stays, as the content script keeps a
  // field typed in before its fill (`content-signin-fill.browser.test.ts`).
  it("fills nothing again when the popup re-announces a filled page after a restart", async () => {
    const { h } = passive();
    await h.hello();
    await waiting();
    const filled = executes().length;
    expect(filled).toBeGreaterThan(0);
    const restarted = passive().h;
    fake.state.openTabs = [1];
    fake.state.reconnects = [];
    fake.state.onReconnect = () => restarted.hello();
    await offers(restarted);
    // The restarted worker asks the tab of a site with a login record itself, and the
    // popup waits for that announcement rather than sending another.
    expect(fake.state.reconnects.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(stored()[0]).toMatchObject({ signInFill: true, stepIndex: 1 }));
    releaseChanges();
    expect(executes()).toHaveLength(filled);
    expect(stored()[0]).toMatchObject({ submissions: 0 });
  });
  it("keeps an idle passive login unavailable while its document has a live passkey ceremony", async () => {
    let active = false;
    const passkeyActive = vi.fn(
      (documentId: string) => active && documentId === "synthetic-document",
    );
    const { h } = passive({}, { passkeyActive });
    await h.hello();
    await waiting();
    const pick = await request(h);
    active = true;
    expect(await offers(h)).toMatchObject({ ok: true, targets: [], reason: "login-running" });
    expect(await run(h, pick)).toEqual({ ok: false, reason: "login-running" });
    expect(executes()).toHaveLength(1);
    expect(h.fields).toHaveBeenCalledTimes(1);
    expect(fake.state.reconnects).toEqual([]);
    active = false;
    expect(await offers(h)).toMatchObject({ ok: true, targets: [expect.anything()] });
    expect(passkeyActive).toHaveBeenCalledWith("synthetic-document");
  });
  it.each(["vault-read", "mutation-ack"] as const)(
    "refuses to replace a genuine passive %s in flight",
    async (phase) => {
      const excluded = [{ hostname: "login.example", includeSubdomains: false }];
      const { h } = passive({ excludedSites: excluded });
      await h.hello();
      const pick = await request(h);
      h.settings.settings.excludedSites = [];
      const field = Promise.withResolvers<string>();
      const ack = Promise.withResolvers<void>();
      if (phase === "vault-read") h.fields.mockReturnValueOnce(field.promise);
      else fake.state.onExecute = async () => ack.promise;
      await h.hello();
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(1));
      if (phase === "mutation-ack")
        await vi.waitFor(() => expect(stored()[0]?.mutationIntent).toBe(true));
      const before = structuredClone(stored());
      expect(await offers(h)).toMatchObject({ ok: true, targets: [], reason: "login-running" });
      expect(await run(h, pick)).toEqual({ ok: false, reason: "login-running" });
      expect(stored()).toEqual(before);
      expect(fake.state.reconnects).toEqual([]);
      field.resolve("synthetic-secret");
      ack.resolve();
      await waiting();
      expect(executes()).toHaveLength(1);
    },
  );

  it.each(["document", "path", "account", "site-access", "vault"] as const)(
    "rechecks %s between the idle offer and explicit start",
    async (change) => {
      const { h } = passive();
      await h.hello();
      await waiting();
      const pick = await request(h);
      if (change === "document") await h.hello({ documentId: "replaced" });
      if (change === "path") fake.state.tabUrls[1] = `${origin}/other`;
      if (change === "account") pick.itemId = otherItemId;
      if (change === "site-access") fake.state.granted = false;
      if (change === "vault") {
        const original = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await original();
          if (response.ok) response.catalog.connections[0]!.state = "locked";
          return response;
        });
      }
      expect(await run(h, pick)).toMatchObject({ ok: false });
      expect(executes().some((entry) => entry.operation.step.kind === "click")).toBe(false);
      expect(h.fields).toHaveBeenCalledTimes(1);
      expect(fake.state.reconnects).toEqual([]);
    },
  );
});
function cachedPage(pageKind: "confirm" | "unclear", frameId = 0, claim: "due" | "held" = "due") {
  const cached = parseLoginRecipe({ ...recipe, id: "gen-synthetic-manual-page", pageKind });
  const answer = Promise.withResolvers<Awaited<ReturnType<LoginGeneration["generate"]>>>();
  const generation = {
    available: vi.fn<LoginGeneration["available"]>(async () => true),
    generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
      sent?.();
      return answer.promise;
    }),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  };
  const repairs = { due: vi.fn(async () => claim), hold: vi.fn(async () => undefined) };
  const test = start(
    {
      pagePermissionDefaults: { "sign-in": "fill", confirm: "off", "personal-details": "fill" },
      bindings: [],
    },
    { generation, repairs, custom: [] },
  );
  const { h } = test;
  h.recipes.recipe.mockResolvedValue(undefined);
  h.recipes.starts.mockResolvedValue([]);
  h.recipes.routes.mockResolvedValue([cached]);
  const from =
    frameId === 0
      ? {}
      : { frameId, documentId: "selected-frame", tab: { id: 1, url: `${origin}/portal` } };
  fake.state.extracted["login"] = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/signin",
      language: "en",
      complete: true,
      candidates: [
        { id: "password", role: "password", target: { by: "id", value: "password" } },
        { id: "login", role: "button", target: { by: "id", value: "login" }, label: "Sign in" },
      ],
    },
  };
  const hello = () =>
    h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        signIn: { path: "/signin" },
      },
      sender(from),
    );
  return { ...test, cached, generation, repairs, answer, from, hello };
}
async function targetRequest(h: ReturnType<typeof harness>, frameId: number) {
  const offered = await offers(h);
  expect(offered.ok).toBe(true);
  if (!offered.ok) throw new Error("No page");
  const selected = offered.targets.find((entry) => entry.document.frameId === frameId);
  expect(selected).toBeDefined();
  return {
    requestId: "explicit-reclassification",
    document: selected!.document,
    scope: selected!.scope,
    connectionId,
    itemId,
  };
}

describe("explicit re-evaluation of a cached confirm-off page", () => {
  it.each([
    { pageKind: "confirm", frameId: 0 },
    { pageKind: "unclear", frameId: 0 },
    { pageKind: "confirm", frameId: 3 },
    { pageKind: "unclear", frameId: 3 },
  ] as const)(
    "re-evaluates cached $pageKind in frame $frameId, then executes only a newly generated sign-in",
    async ({ pageKind, frameId }) => {
      const test = cachedPage(pageKind, frameId);
      const { h, cached, generation, repairs, answer, hello } = test;
      if (frameId !== 0) {
        fake.state.tabUrls[1] = `${origin}/portal`;
        await h.hello({ documentId: "top", url: `${origin}/portal` }, false);
      }
      expect(await hello()).toMatchObject({
        ok: false,
        reason: frameId === 0 ? "page-off" : "recipe-not-found",
      });
      const before = structuredClone(h.settings);
      const pick = await targetRequest(h, frameId);
      fake.state.onReconnect = hello;
      expect(await run(h, pick)).toMatchObject({ ok: true, state: "generating" });
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
      expect(repairs.due).toHaveBeenCalledExactlyOnceWith({
        recipeId: cached.id,
        revision: 1,
        documentId: pick.document.documentId,
      });
      expect(generation.generate.mock.calls[0]![0]).toMatchObject({
        repair: { recipeId: cached.id, revision: 1 },
      });
      expect(generation.generate.mock.calls[0]![0].manual).toBeUndefined();
      expect(executes()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(cached.pageKind).toBe(pageKind);
      const generated = parseLoginRecipe({ ...cached, revision: 2, pageKind: "sign-in" });
      h.recipes.recipe.mockResolvedValue(generated);
      h.recipes.routes.mockResolvedValue([generated]);
      authenticateOnManualClick();
      fake.state.onReconnect = () => h.hello(test.from);
      answer.resolve({ outcome: "recipe", recipe: generated });
      await vi.waitFor(() =>
        expect(executes().filter((entry) => entry.operation.step.kind === "click")).toHaveLength(1),
      );
      expect(executes()).toHaveLength(2);
      expect(stored()[0]).toMatchObject({ recipeRevision: 2, submissions: 1 });
      expect(stored()[0]?.signInFill).toBeUndefined();
      expect(cached.pageKind).toBe(pageKind);
      expect(h.settings).toEqual(before);
      expect(h.store.update).not.toHaveBeenCalled();
    },
  );

  it.each(["confirm", "unclear"] as const)(
    "never executes a repair still classified as %s",
    async (pageKind) => {
      const { h, cached, generation, answer, hello } = cachedPage(pageKind);
      await hello();
      const pick = await targetRequest(h, 0);
      fake.state.onReconnect = hello;
      expect(await run(h, pick)).toMatchObject({ ok: true, state: "generating" });
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
      const generated = parseLoginRecipe({ ...cached, revision: 2 });
      h.recipes.routes.mockResolvedValue([generated]);
      answer.resolve({ outcome: "recipe", recipe: generated });
      await vi.waitFor(async () =>
        expect(await offers(h)).toMatchObject({
          status: { requestId: pick.requestId, state: "blocked" },
        }),
      );
      expect(generation.generate).toHaveBeenCalledTimes(1);
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(stored()).toEqual([]);
    },
  );

  it("respects the normal repair hold and starts neither generation nor an old cached recipe", async () => {
    const { h, generation, repairs, hello } = cachedPage("confirm", 0, "held");
    await hello();
    const pick = await targetRequest(h, 0);
    fake.state.onReconnect = hello;
    await run(h, pick);
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({ status: { state: "blocked" } }),
    );
    expect(repairs.due).toHaveBeenCalledTimes(1);
    expect(generation.generate).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
  });
});
