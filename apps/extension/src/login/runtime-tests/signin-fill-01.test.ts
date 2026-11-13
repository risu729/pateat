import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type LoginAttemptMetadata,
  type LoginStep,
} from "@pateat/contracts";
import { createLoginBadge, memoryBadgeStorage } from "../badge";
import type { LoginReport } from "../runtime/report";
import type { LoginGeneration } from "../runtime/deps";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  otherItemId,
  target,
  recipe,
  savedBinding,
  uriMatch,
  harness,
  setPause,
  realTime,
} = createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
} as never;
const fillPolicy: Partial<LocalSettings> = {
  pagePermissionDefaults: { "sign-in": "fill", confirm: "fill", "personal-details": "fill" },
};
const stored = () =>
  (fake.state.storage["pateat.login-attempts.v5"] ?? []) as LoginAttemptMetadata[];
const executes = () =>
  fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
    operation: { signInFill?: true; stepIndex: number; step: LoginStep };
    choose?: true;
    accountSwitch?: unknown;
    otherSwitch?: true;
  }[];
let changes: (() => void)[] = [];
const change = () => {
  const waiting = changes.splice(0);
  for (const resolve of waiting) resolve();
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
    extracted: {},
    signs: undefined,
    loaded: true,
    openTabs: undefined,
  });
  changes = [];
  vi.spyOn(fake.browser.tabs, "sendMessage").mockImplementation(async (...args) => {
    const message = args[1];
    if (message["type"] === "login.fill.change") {
      fake.state.messages.push(structuredClone(message) as (typeof fake.state.messages)[number]);
      await new Promise<void>((resolve) => changes.push(resolve));
      return { ok: true };
    }
    return originalSend(...args);
  });
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tab of [1, 2, 3]) listener(tab);
  fake.state.replaced.length = 0;
  change();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function start(overrides: Partial<LocalSettings> = {}, live: Parameters<typeof harness>[1] = {}) {
  const reports: LoginReport[] = [];
  const h = harness(
    { ...fillPolicy, ...overrides },
    {
      ...live,
      report: (entry) => {
        reports.push(entry);
        live.report?.(entry);
      },
    },
  );
  return { h, reports };
}
/** The page got `count` fills, and the attempt waits for its next step or is done. */
async function filled(count = 1) {
  await vi.waitFor(() => expect(executes()).toHaveLength(count));
  await vi.waitFor(() =>
    expect(changes.length > 0 || stored()[0]?.fillDone === true, JSON.stringify(stored())).toBe(
      true,
    ),
  );
}
const bothPages = (path = "/password") =>
  parseLoginRecipe({
    ...recipe,
    id: "synthetic-two-page-fill",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
      { kind: "fill", path, fields: [{ slot: "password", target: target("password") }] },
      { kind: "click", path, target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
const twoPageStart = (path = "/password", live: Parameters<typeof harness>[1] = {}) => {
  const used = bothPages(path);
  const test = start(
    {
      bindings: [
        {
          ...savedBinding,
          recipeId: used.id,
          slots: [
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        },
      ],
    },
    { username: true, ...live },
  );
  test.h.recipes.recipe.mockResolvedValue(used);
  fake.state.present = new Set(["email", "next"]);
  return test;
};

describe("profile sign-in autofill runtime", () => {
  it("fills the password route without clicks, judge, logout detection, learning or default saves", async () => {
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(),
    };
    const { h, reports } = start(
      {},
      { generation, passkeys: async () => ({ passkey: true, discoverable: true }) },
    );
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({ ...recipe, passkey: { path: "/signin", target: target("passkey") } }),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await filled();
    expect(stored()).toMatchObject([
      { signInFill: true, route: "password", stepIndex: 1, submissions: 0 },
    ]);
    expect(stored()[0]).not.toHaveProperty("fillOnly");
    expect(executes()).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({
          signInFill: true,
          step: expect.objectContaining({ kind: "fill" }),
        }),
      }),
    ]);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.password"]);
    expect(generation.judge).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(h.store.update).not.toHaveBeenCalled();
    expect(
      fake.state.messages.some(
        (entry) =>
          entry.type === "login.state" ||
          entry.type === "login.switch" ||
          entry.type === "login.choose",
      ),
    ).toBe(false);
    expect(executes()[0]).not.toHaveProperty("accountSwitch");
    expect(executes()[0]).not.toHaveProperty("choose");
    expect(reports).toContainEqual(
      expect.objectContaining({
        type: "start",
        fillMode: "sign-in-fill",
        permissionSource: "default",
      }),
    );
  });

  it("uses the sole URI match without saving it as a default", async () => {
    const { h } = start(
      { siteDefaults: [] },
      { uris: async () => ({ ok: true, data: uriMatch() }) },
    );
    expect(await h.hello()).toEqual({ ok: true });
    await filled();
    expect(stored()[0]?.account.itemId).toBe(itemId);
    expect(h.store.update).not.toHaveBeenCalled();
  });

  it("asks for multiple matches and permits a valid explicit pick to log in normally", async () => {
    const { h } = start(
      { siteDefaults: [] },
      {
        uris: async () => ({
          ok: true,
          data: uriMatch({
            candidates: [
              { itemId, matches: [{ uriIndex: 0, match: 0 }] },
              { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
            ],
          }),
        }),
      },
    );
    expect(await h.hello()).toMatchObject({ ok: false, reason: "account-ambiguous" });
    expect(executes()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
    fake.state.onReconnect = () => h.hello();
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "stale-document",
          connectionId,
          itemId,
          makeDefault: false,
        },
        popup,
      ),
    ).toMatchObject({ ok: false });
    expect(executes()).toEqual([]);
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "synthetic-document",
          connectionId,
          itemId,
          makeDefault: false,
        },
        popup,
      ),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(executes().some((entry) => entry.operation.step.kind === "click")).toBe(true),
    );
    expect(stored()[0]).not.toHaveProperty("signInFill");
    expect(executes().some((entry) => entry.operation.step.kind === "click")).toBe(true);
  });

  it.each(["new-document", "posted-back", "new-path", "same-path"] as const)(
    "fills the next page only after its fields become writable: %s",
    async (move) => {
      const samePath = move !== "new-path";
      const { h } = twoPageStart(samePath ? "/signin" : "/password");
      expect(await h.hello()).toEqual({ ok: true });
      await filled();
      expect(executes()[0]?.operation.stepIndex).toBe(0);
      expect(stored()[0]?.fillBaseline).toMatchObject({ ready: false, nextStep: 2 });
      fake.state.present = new Set(["password", "login"]);
      if (move === "new-path") {
        fake.state.pageUrl = `${origin}/password`;
        fake.state.observedPath = "/password";
        await h.hello({ url: fake.state.pageUrl });
      } else if (move === "new-document") {
        // The first step does not show there, so the document announces no start.
        await h.hello({ documentId: "replacement-document" }, false);
      } else if (move === "posted-back") {
        // The form posts back to its own path and shows the identifier beside the password
        // again: the first step shows, but so does the next field, which goes on.
        fake.state.present = new Set(["email", "password", "login"]);
        await h.hello({ documentId: "posted-back" });
      }
      change();
      await filled(2);
      expect(executes().map((entry) => entry.operation.stepIndex)).toEqual([0, 2]);
      expect(executes().every((entry) => entry.operation.step.kind === "fill")).toBe(true);
      expect(stored()[0]?.submissions).toBe(0);
    },
  );

  it("never advances on an unchanged same-path second field that was already writable", async () => {
    const { h } = twoPageStart("/signin");
    fake.state.present = new Set(["email", "password", "next", "login"]);
    await h.hello();
    await filled();
    expect(stored()[0]?.fillBaseline).toMatchObject({ ready: true, nextStep: 2 });
    change();
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    expect(executes()).toHaveLength(1);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.username"]);
  });

  it("ends without another field read when the policy or vault changes while waiting", async () => {
    const { h } = twoPageStart("/signin");
    await h.hello();
    await filled();
    delete h.settings.settings.pagePermissionDefaults;
    h.settings.revision += 1;
    await h.login.settingsChanged("saved");
    fake.state.present = new Set(["password", "login"]);
    change();
    await vi.waitFor(() => expect(stored()[0]?.state).toBe("blocked"));
    expect(executes()).toHaveLength(1);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.username"]);
  });

  it("keeps confirm-off pages observable but never selects an account or fills", async () => {
    const { h, reports } = start({
      sitePagePermissions: [
        { hostname: "login.example", includeSubdomains: false, permissions: { confirm: "off" } },
      ],
    });
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.starts.mockResolvedValue([]);
    h.recipes.routes.mockResolvedValue([parseLoginRecipe({ ...recipe, pageKind: "confirm" })]);
    fake.state.present = new Set(["password", "login", "authenticated"]);
    expect(await h.hello()).toMatchObject({ ok: false, reason: "page-off" });
    await vi.waitFor(() =>
      expect(reports).toContainEqual(
        expect.objectContaining({
          type: "refused",
          reason: "page-off",
          pageKind: "confirm",
          permissionSource: "site",
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
        }),
      ),
    );
    expect(h.fields).not.toHaveBeenCalled();
    expect(executes()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it.each(["authenticated", "credential-rejected"] as const)(
    "applies newly enabled autofill before prior %s account and logout guards",
    async (outcome) => {
      const generation = {
        available: vi.fn<LoginGeneration["available"]>(async () => true),
        generate: vi.fn<LoginGeneration["generate"]>(),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(),
      };
      const { h } = start({ pagePermissionDefaults: undefined }, { generation });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...recipe, rejection: target("rejected") }),
      );
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          fake.state.present = new Set([
            "password",
            "login",
            outcome === "authenticated" ? "authenticated" : "rejected",
          ]);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(stored()[0]?.outcome).toBe(outcome));
      const old = stored()[0]!.id;
      h.settings.settings.pagePermissionDefaults = fillPolicy.pagePermissionDefaults;
      h.settings.revision += 1;
      await h.login.settingsChanged("saved");
      fake.state.onExecute = undefined;
      fake.state.present = new Set(["password", "login"]);
      fake.state.messages = [];
      h.fields.mockClear();
      generation.judge.mockClear();
      expect(await h.hello({ documentId: "after-policy-change" })).toEqual({ ok: true });
      await filled();
      expect(stored()[0]).toMatchObject({ signInFill: true, submissions: 0 });
      expect(stored()[0]!.id).not.toBe(old);
      expect(executes().every((entry) => entry.operation.step.kind === "fill")).toBe(true);
      expect(fake.state.messages.some((entry) => entry.type === "login.state")).toBe(false);
      expect(generation.judge).not.toHaveBeenCalled();
    },
  );
  it.each(["authenticated", "credential-rejected"] as const)(
    "starts passive autofill after worker restart with a previous normal %s record",
    async (outcome) => {
      const first = start({ pagePermissionDefaults: undefined });
      first.h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...recipe, rejection: target("rejected") }),
      );
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          fake.state.present = new Set([
            "password",
            "login",
            outcome === "authenticated" ? "authenticated" : "rejected",
          ]);
      };
      await first.h.hello();
      await vi.waitFor(() => expect(stored()[0]?.outcome).toBe(outcome));
      const old = stored()[0]!.id;
      fake.state.onExecute = undefined;
      fake.state.present = new Set(["password", "login"]);
      fake.state.messages = [];
      const restarted = start();
      expect(await restarted.h.hello({ documentId: "after-restart" })).toEqual({ ok: true });
      await filled();
      expect(stored()[0]).toMatchObject({ signInFill: true, submissions: 0 });
      expect(stored()[0]!.id).not.toBe(old);
      expect(fake.state.messages.some((entry) => entry.type === "login.state")).toBe(false);
    },
  );

  it("consumes an intent when a new document arrives before the old fill acknowledgement", async () => {
    let acknowledge: (() => void) | undefined;
    const { h } = start();
    fake.state.onExecute = async () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    await h.hello();
    await vi.waitFor(() =>
      expect(stored()[0]).toMatchObject({
        stepIndex: 0,
        mutationIntent: true,
        operationKind: "fill",
      }),
    );
    expect(h.fields).toHaveBeenCalledTimes(1);
    const old = stored()[0]!.id;
    fake.state.onExecute = undefined;
    // A document that shows the sign-in form again, as after a reload, is filled anew.
    expect(await h.hello({ documentId: "navigated-before-ack" })).toEqual({ ok: true });
    await filled(2);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]!.id).not.toBe(old);
    expect(stored()[0]).toMatchObject({
      document: { documentId: "navigated-before-ack" },
      submissions: 0,
      fillDone: true,
    });
    expect(
      (
        fake.state.messages.filter((entry) => entry.type === "login.execute").at(-1) as never as {
          operation: { document: { documentId: string } };
        }
      ).operation.document.documentId,
    ).toBe("navigated-before-ack");
    // The old document's late acknowledgement fills nothing more.
    // The page answers the old fill late; a request handled after that answer sees its
    // outcome.
    const late = vi
      .mocked(fake.browser.tabs.sendMessage)
      .mock.calls.findIndex(([, message]) => message["type"] === "login.execute");
    acknowledge!();
    await vi.mocked(fake.browser.tabs.sendMessage).mock.results[late]!.value;
    await h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup);
    expect(executes()).toHaveLength(2);
    expect(h.fields).toHaveBeenCalledTimes(2);
  });

  it("ends after its last fill, so later pages neither resume nor expire it", async () => {
    const badge = createLoginBadge({
      storage: memoryBadgeStorage(),
      setBadge: async () => undefined,
    });
    const { h } = start({}, { badge, report: (entry) => badge.observe(entry) });
    await h.hello();
    await filled();
    expect(stored()[0]).toMatchObject({ state: "blocked", fillDone: true, submissions: 0 });
    expect(changes).toHaveLength(0);
    expect(executes().every((entry) => entry.operation.step.kind === "fill")).toBe(true);
    const status = await h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup);
    expect(status).toMatchObject({ login: { signInFill: true, fillDone: true, state: "blocked" } });
    // The person submits; the signed-in page shows no sign-in form and starts nothing.
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["authenticated"]);
    h.recipes.recipe.mockResolvedValue(undefined);
    await h.hello({ url: fake.state.pageUrl, documentId: "signed-in" }, false);
    expect(stored()).toEqual([]);
    expect(executes()).toHaveLength(1);
  });

  it("persists expiration without same-document replay and permits a fresh reload", async () => {
    const badge = createLoginBadge({
      storage: memoryBadgeStorage(),
      setBadge: async () => undefined,
    });
    const { h } = twoPageStart("/signin", { badge, report: (entry) => badge.observe(entry) });
    await h.hello();
    await filled();
    const id = stored()[0]!.id;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 600_001);
    change();
    await vi.waitFor(() =>
      expect(stored()[0]).toMatchObject({ state: "blocked", fillExpired: true }),
    );
    const status = await h.login.handle({ version: 1, type: "login.status.get", tabId: 1 }, popup);
    expect(status).toMatchObject({
      login: { signInFill: true, fillExpired: true, state: "blocked" },
    });
    await h.hello();
    expect(executes()).toHaveLength(1);
    expect(stored()[0]!.id).toBe(id);
    expect(await h.hello({ documentId: "fresh-reload" })).toEqual({ ok: true });
    await filled(2);
    expect(stored()[0]!.id).not.toBe(id);
    expect(stored()[0]).toMatchObject({ signInFill: true, submissions: 0 });
    expect(stored()[0]?.fillExpired).toBeUndefined();
  });
  it.each(["same-button", "new-page"] as const)(
    "generates a stable newly exposed missing page as a bounded continuation without judging: %s",
    async (flow) => {
      const first = parseLoginRecipe({
        ...recipe,
        id: "gen-synthetic-passive-continuation",
        slots: ["username"],
        completion: undefined,
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "username", target: target("email") }],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        ],
        maxSubmissions: 1,
      });
      const continued = parseLoginRecipe({
        ...first,
        revision: 2,
        slots: ["username", "password"],
        steps: [
          ...(flow === "same-button" ? first.steps.slice(0, -1) : first.steps),
          {
            kind: "fill",
            path: flow === "same-button" ? "/signin" : "/password",
            fields: [{ slot: "password", target: target("password") }],
          },
          {
            kind: "click",
            path: flow === "same-button" ? "/signin" : "/password",
            target: target(flow === "same-button" ? "next" : "login"),
            purpose: "submit",
          },
        ],
        maxSubmissions: flow === "same-button" ? 1 : 2,
      });
      const generation = {
        available: vi.fn<LoginGeneration["available"]>(async () => true),
        generate: vi.fn<LoginGeneration["generate"]>(async () => ({
          outcome: "recipe",
          recipe: continued,
        })),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge: vi.fn<LoginGeneration["judge"]>(),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      };
      const { h, reports } = start(
        { siteDefaults: [], bindings: [] },
        {
          username: true,
          custom: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          generation,
        },
      );
      h.recipes.recipe.mockResolvedValue(first);
      h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: [first.steps[0]!] }]);
      fake.state.present = new Set(["email", "next"]);
      await h.hello();
      await filled();
      expect(generation.generate).not.toHaveBeenCalled();
      vi.useFakeTimers({ toFake: ["Date"] });
      fake.state.signIn = true;
      fake.state.present = new Set(["password", flow === "same-button" ? "next" : "login"]);
      if (flow === "new-page") {
        fake.state.pageUrl = `${origin}/password`;
        fake.state.observedPath = "/password";
        await h.hello({ url: fake.state.pageUrl, documentId: "password-page" }, false);
      }
      fake.state.extracted["login"] = {
        ok: true,
        observation: {
          version: 1,
          origin,
          path: flow === "same-button" ? "/signin" : "/password",
          language: "en",
          complete: true,
          candidates: [
            { id: "c1", role: "password", target: target("password"), label: "Password" },
            {
              id: "c2",
              role: "button",
              target: target(flow === "same-button" ? "next" : "login"),
              label: "Log in",
            },
          ],
        },
      };
      change();
      await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
      expect(generation.generate).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 1_001);
      h.recipes.recipe.mockResolvedValue(continued);
      change();
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(executes(), JSON.stringify({ stored: stored(), reports })).toHaveLength(2),
      );
      expect(executes().map((entry) => entry.operation.stepIndex)).toEqual([
        0,
        flow === "same-button" ? 1 : 2,
      ]);
      expect(executes().every((entry) => entry.operation.step.kind === "fill")).toBe(true);
      expect(generation.judge).not.toHaveBeenCalled();
      expect(stored()[0]).toMatchObject({ signInFill: true, recipeRevision: 2, submissions: 0 });
      expect(h.store.update).not.toHaveBeenCalled();
    },
  );
  it("fills an ordinary password beside an empty TOTP slot without requiring or reading its code", async () => {
    const { h } = start({
      bindings: [
        {
          ...savedBinding,
          slots: [
            { slot: "password", field: "password" },
            { slot: "totp", field: "totp" },
          ],
        },
      ],
    });
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({
        ...recipe,
        slots: ["password", "totp"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "password", target: target("password") },
              { slot: "totp", target: target("code") },
            ],
          },
          recipe.steps[1],
        ],
      }),
    );
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields.push({
          id: "login.totp-code",
          label: "Code",
          name: null,
          kind: "otp",
          empty: true,
        } as never);
      return response;
    });
    fake.state.present = new Set(["password", "code", "login"]);
    expect(await h.hello()).toEqual({ ok: true });
    await filled();
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.password"]);
    expect(executes()[0]?.operation.step).toMatchObject({
      kind: "fill",
      fields: [{ slot: "password" }],
    });
    expect(stored()[0]?.submissions).toBe(0);
  });
  it("stops a waiting passive login when its vault locks, without reading the next password", async () => {
    const { h } = twoPageStart("/signin");
    await h.hello();
    await filled();
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) response.catalog.connections[0]!.state = "locked";
      return response;
    });
    fake.state.present = new Set(["password", "login"]);
    change();
    await vi.waitFor(() =>
      expect(stored()[0], JSON.stringify([stored(), executes()])).toMatchObject({
        state: "blocked",
        outcome: "policy-changed",
      }),
    );
    expect(executes()).toHaveLength(1);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.username"]);
  });
  it("delegates conditional and unactivated passkeys under autofill but keeps activated requests eligible", async () => {
    const { h } = start();
    const input = { tabId: 1, origin, documentId: "synthetic-document", allowCredentials: false };
    expect(
      await h.login.passkeyPagePermission({ ...input, conditional: true, userActivation: true }),
    ).toBe("sign-in-fill");
    expect(
      await h.login.passkeyPagePermission({ ...input, conditional: false, userActivation: false }),
    ).toBe("sign-in-fill");
    expect(
      await h.login.passkeyPagePermission({ ...input, conditional: false, userActivation: true }),
    ).toBeUndefined();
  });

  it("fills the username again when the first page shows again in a new document", async () => {
    const { h } = twoPageStart("/password");
    await h.hello();
    await filled();
    const old = stored()[0]!.id;
    // A reload while it waits for the password page: the username is empty again.
    expect(await h.hello({ documentId: "reloaded" })).toEqual({ ok: true });
    await filled(2);
    expect(executes().map((entry) => entry.operation.stepIndex)).toEqual([0, 0]);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]!.id).not.toBe(old);
    expect(stored()[0]).toMatchObject({ document: { documentId: "reloaded" }, stepIndex: 1 });
  });

  it("fills the username again when a reload on its own path shows only the first step", async () => {
    const { h } = twoPageStart("/signin");
    await h.hello();
    await filled();
    const old = stored()[0]!.id;
    expect(await h.hello({ documentId: "reloaded" })).toEqual({ ok: true });
    await filled(2);
    expect(executes().map((entry) => entry.operation.stepIndex)).toEqual([0, 0]);
    expect(stored()[0]!.id).not.toBe(old);
  });

  it("wakes for a learned detail handler that shows later in the same document", async () => {
    const handler = {
      kind: "detail" as const,
      path: "/signin",
      fields: [{ detail: "phone-last-4" as const, target: target("phone") }],
      target: target("confirm"),
    };
    const { h } = twoPageStart("/password");
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({ ...bothPages("/password"), handlers: [handler] }),
    );
    await h.hello();
    await filled();
    const waits = () => fake.state.messages.filter((entry) => entry.type === "login.fill.change");
    const handlerReads = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.observe" &&
          JSON.stringify(entry["targets"]) === JSON.stringify([target("phone"), target("confirm")]),
      ).length;
    expect(waits()[0]).toMatchObject({
      handlers: [
        { path: "/signin", require: "present", targets: [target("phone"), target("confirm")] },
      ],
    });
    expect(waits()[0]).not.toHaveProperty("changed");
    const before = handlerReads();
    // The page answers once the handler's elements show; the worker reads it again, and its
    // next wait first waits for another change, as the handler is not usable yet.
    change();
    await vi.waitFor(() => expect(waits()).toHaveLength(2));
    expect(handlerReads()).toBe(before + 1);
    expect(waits()[1]).toMatchObject({ changed: true });
  });

  it("stops a waiting fill that a restarted worker resumes on a paused site", async () => {
    fake.state.openTabs = [1];
    const first = twoPageStart("/password");
    await first.h.hello();
    await filled();
    const restarted = twoPageStart("/password");
    expect(await setPause(restarted.h, true, 1, "10m")).toMatchObject({ ok: true });
    fake.state.pageUrl = `${origin}/password`;
    fake.state.observedPath = "/password";
    fake.state.present = new Set(["password", "login"]);
    expect(
      await restarted.h.hello({ url: fake.state.pageUrl, documentId: "password-page" }, false),
    ).toMatchObject({ ok: false });
    await vi.waitFor(() =>
      expect(restarted.reports).toContainEqual(
        expect.objectContaining({
          type: "attempt",
          state: "blocked",
          outcome: "policy-changed",
          cause: "paused",
        }),
      ),
    );
    expect(stored()).toEqual([]);
    expect(executes()).toHaveLength(1);
    expect(restarted.h.fields).not.toHaveBeenCalled();
  });

  it("follows the tab's site rule in a frame of that tab", async () => {
    const portal = "https://portal.example/account";
    const { h } = start(
      {
        pagePermissionDefaults: undefined,
        sitePagePermissions: [
          {
            hostname: "portal.example",
            includeSubdomains: false,
            permissions: { "sign-in": "fill" },
          },
        ],
      },
      {
        allowedOrigins: [],
        uris: vi.fn<LiveUriMatcher>(async (_connection, url) => ({
          ok: true,
          data: uriMatch({ targetOrigin: new URL(url).origin }),
        })),
      },
    );
    fake.state.tabUrls[1] = portal;
    await h.hello({ documentId: "portal-page", url: portal }, false);
    expect(
      await h.hello({ frameId: 3, documentId: "frame-one", tab: { id: 1, url: portal } }),
    ).toEqual({ ok: true });
    await filled();
    expect(stored()[0]).toMatchObject({ signInFill: true, fillPermissionSource: "site" });
    expect(executes().every((entry) => entry.operation.step.kind === "fill")).toBe(true);
    expect(
      await h.login.passkeyPagePermission({
        tabId: 1,
        origin,
        documentId: "frame-one",
        allowCredentials: false,
        conditional: true,
        userActivation: false,
      }),
    ).toBe("sign-in-fill");
  });

  it("stops on a later page when its account is no longer the one a new fill would choose", async () => {
    const { h } = twoPageStart("/password");
    await h.hello();
    await filled();
    // Another item became the site's saved default meanwhile.
    h.settings.settings.siteDefaults = [
      { ...h.settings.settings.siteDefaults[0]!, itemId: otherItemId },
    ];
    fake.state.pageUrl = `${origin}/password`;
    fake.state.observedPath = "/password";
    fake.state.present = new Set(["password", "login"]);
    expect(await h.hello({ url: fake.state.pageUrl, documentId: "password-page" }, false)).toEqual({
      ok: false,
      reason: "account-changed",
    });
    expect(executes()).toHaveLength(1);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual(["login.username"]);
  });
});
