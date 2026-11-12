import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manualOfferResponseSchema, type ManualStartRequest } from "../manual-wire";
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
  uriMatch,
  harness,
  setPause,
  sender,
  trusted,
  realTime,
  recipe,
} = createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const uris = () =>
  vi.fn<LiveUriMatcher>(async (_connection, url) => ({
    ok: true,
    data: uriMatch({ targetOrigin: new URL(url).origin }),
  }));
const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
const stored = () => (fake.state.storage["pateat.login-attempts.v5"] ?? []) as { state: string }[];
const offer = async (h: ReturnType<typeof harness>) =>
  v.parse(
    manualOfferResponseSchema,
    await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
  );
async function request(h: ReturnType<typeof harness>, frameId = 0): Promise<ManualStartRequest> {
  const answer = await offer(h);
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw new Error("No page");
  const target = answer.targets.find((entry) => entry.document.frameId === frameId);
  expect(target).toBeDefined();
  return {
    requestId: "manual-request",
    document: target!.document,
    scope: target!.scope,
    connectionId,
    itemId,
  };
}
const run = (h: ReturnType<typeof harness>, pick: ManualStartRequest) =>
  h.login.handle({ version: 1, type: "login.manual.start", ...pick }, popup);

beforeEach(() => {
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.badges = {};
  fake.state.reconnects = [];
  fake.state.onReconnect = undefined;
  fake.state.messages = [];
  fake.state.granted = true;
  fake.state.pageUrl = origin + "/signin";
  fake.state.onExecute = undefined;
  fake.state.tabUrls = {};
  fake.state.observed = ["unique", "missing"];
  fake.state.observedPath = "/signin";
  fake.state.present = undefined;
  fake.state.unusable = new Set();
  fake.state.awaited = { ok: true };
  fake.state.onAwait = undefined;
  fake.state.executeReply = undefined;
  fake.state.gone = new Set();
  fake.state.goneFrames = new Set();
  fake.state.onPresent = undefined;
  fake.state.extracted = {};
  fake.state.signs = undefined;
  fake.state.loaded = true;
  fake.state.incognito = new Set();
  fake.state.openTabs = undefined;
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
  fake.state.replaced.length = 0;
});

describe("one-time login through the popup and actual runtime", () => {
  it.each(["excluded", "private", "allowlist", "timed"] as const)(
    "logs in once past the %s automatic hold without changing its policy",
    async (hold) => {
      realTime();
      const h = harness(
        {
          ...(hold === "excluded"
            ? { excludedSites: [{ hostname: "login.example", includeSubdomains: true }] }
            : {}),
          ...(hold === "allowlist" ? { allowedSitesEnabled: true, allowedSites: [] } : {}),
        },
        { uris: uris() },
      );
      if (hold === "private") {
        fake.state.incognito.add(1);
        delete h.settings.settings.loginInPrivateWindows;
      }
      if (hold === "timed") await setPause(h, true);
      const hello = () => h.hello(hold === "private" ? { tab: { id: 1, incognito: true } } : {});
      expect(await hello()).toMatchObject({ ok: false });
      expect(executes()).toEqual([]);
      const settings = structuredClone(h.settings);
      const pauses = structuredClone(fake.state.session["pateat.login-pauses.v1"]);
      const asks = structuredClone(fake.state.session["pateat.login-ask-every-time.v1"]);
      const sessionPicks = structuredClone(fake.state.session["pateat.login-switch-picks.v1"]);
      const pick = await request(h);
      fake.state.onReconnect = hello;
      expect(await run(h, pick)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
      expect(executes()).toHaveLength(2);
      expect(h.store.update).not.toHaveBeenCalled();
      expect(h.settings).toEqual(settings);
      expect(fake.state.session["pateat.login-pauses.v1"]).toEqual(pauses);
      expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual(asks);
      expect(fake.state.session["pateat.login-switch-picks.v1"]).toEqual(sessionPicks);
    },
  );

  it("rejects requests from content pages, options pages and another extension", async () => {
    const h = harness(
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { uris: uris() },
    );
    await h.hello();
    const pick = await request(h);
    const answers = await Promise.all(
      [sender(), trusted, { ...popup, id: "other-extension" }].flatMap((from) => [
        h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, from as never),
        h.login.handle({ version: 1, type: "login.manual.start", ...pick }, from as never),
      ]),
    );
    expect(answers).toEqual(Array(6).fill(undefined));
    expect(fake.state.reconnects).toEqual([]);
    expect(executes()).toEqual([]);
  });

  it.each(["document", "path", "account", "permission", "vault"] as const)(
    "rechecks %s after the offer before releasing any field",
    async (change) => {
      const match = uris();
      const h = harness(
        { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
        { uris: match },
      );
      await h.hello();
      const pick = await request(h);
      if (change === "document") await h.hello({ documentId: "replacement" });
      if (change === "path") fake.state.tabUrls[1] = origin + "/other";
      if (change === "account") pick.itemId = otherItemId;
      if (change === "permission") fake.state.granted = false;
      if (change === "vault")
        match.mockResolvedValue({ ok: false, error: { code: "vault-locked" } });
      expect(await run(h, pick)).toMatchObject({ ok: false });
      expect(h.fields).not.toHaveBeenCalled();
      expect(fake.state.reconnects).toEqual([]);
    },
  );

  it("keeps one pending request per tab and persists no unstarted manual pick", async () => {
    realTime();
    const h = harness(
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { uris: uris() },
    );
    await h.hello();
    const pick = await request(h);
    expect(await run(h, pick)).toEqual({ ok: true, state: "evaluating" });
    expect(await run(h, pick)).toEqual({ ok: false, reason: "preparing" });
    expect(await offer(h)).toEqual({
      ok: true,
      targets: [],
      status: { state: "evaluating", requestId: "manual-request" },
    });
    expect(JSON.stringify(fake.state.session)).not.toContain('"manual":true');
    expect(executes()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("targets the selected frame and neither lends nor cancels its authority for a sibling", async () => {
    realTime();
    const top = "https://portal.example/account";
    const h = harness(
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { allowedOrigins: [], uris: uris() },
    );
    fake.state.tabUrls[1] = top;
    await h.hello({ documentId: "top", url: top }, false);
    const frame = { frameId: 3, documentId: "selected", tab: { id: 1, url: top } };
    await h.hello(frame);
    const pick = await request(h, 3);
    expect(await run(h, pick)).toEqual({ ok: true, state: "evaluating" });
    expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 3, documentId: "selected" }]);
    await h.hello({ ...frame, frameId: 4, documentId: "sibling" });
    expect(executes()).toEqual([]);
    expect(await offer(h)).toMatchObject({
      status: { state: "evaluating", requestId: "manual-request" },
    });
    expect(await h.hello(frame)).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    expect(h.fields.mock.calls[0]![0]).toMatchObject({ account: { connectionId, itemId } });
  });
});

describe("manual attempt records", () => {
  it("allows a fresh manual attempt after terminal success while automatic admission stays held", async () => {
    realTime();
    const h = harness({}, { uris: uris() });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
    expect(executes()).toHaveLength(2);
    const previous = structuredClone(stored());
    await h.hello();
    expect(executes()).toHaveLength(2);
    const pick = await request(h);
    fake.state.onReconnect = () => h.hello();
    expect(await run(h, pick)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(4));
    expect(h.fields).toHaveBeenCalledTimes(2);
    expect(stored()).not.toEqual(previous);
    expect(h.store.update).not.toHaveBeenCalled();
  });

  it("cannot replace an automatic attempt that started after its offer", async () => {
    realTime();
    const h = harness(
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { uris: uris() },
    );
    await h.hello();
    const pick = await request(h);
    const field = Promise.withResolvers<string>();
    h.fields.mockReturnValue(field.promise);
    h.settings.settings.excludedSites = [];
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(1));
    const active = structuredClone(stored());
    expect(await run(h, pick)).toEqual({ ok: false, reason: "login-running" });
    expect(stored()).toEqual(active);
    expect(executes()).toEqual([]);
    expect(fake.state.reconnects).toEqual([]);
    field.resolve("synthetic-password");
    await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
    expect(executes()).toHaveLength(2);
  });

  it("serializes manual provenance only after attaching it to an attempt", async () => {
    realTime();
    const h = harness(
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { uris: uris() },
    );
    await h.hello();
    const pick = await request(h);
    const field = Promise.withResolvers<string>();
    h.fields.mockReturnValue(field.promise);
    expect(await run(h, pick)).toEqual({ ok: true, state: "evaluating" });
    expect(fake.state.session["pateat.login-picks.v1"]).toEqual([]);
    await h.hello();
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(1));
    expect(fake.state.session["pateat.login-picks.v1"]).toEqual([
      expect.objectContaining({
        manual: true,
        makeDefault: false,
        attemptId: expect.any(String),
        connectionId,
        itemId,
      }),
    ]);
    const attached = structuredClone(fake.state.session["pateat.login-picks.v1"]);
    expect(JSON.stringify(attached)).not.toContain("expiresAt");
    field.resolve("synthetic-password");
    await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
    expect(h.store.update).not.toHaveBeenCalled();
  });
});

it("an explicit retry can pass another tab's inactive failure without changing its record", async () => {
  realTime();
  const h = harness({}, { uris: uris() });
  h.fields.mockResolvedValue(undefined);
  await h.hello({ tab: { id: 2 }, documentId: "other-tab" });
  await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "blocked" }]));
  const other = structuredClone(stored()[0]);
  h.settings.settings.excludedSites = [{ hostname: "login.example", includeSubdomains: false }];
  h.fields.mockResolvedValue("synthetic-password");
  await h.hello();
  const pick = await request(h);
  fake.state.onReconnect = () => h.hello();
  expect(await run(h, pick)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(stored()).toHaveLength(2));
  expect(stored()).toContainEqual(other);
  await vi.waitFor(() => expect(executes()).toHaveLength(2));
  expect(stored()).toContainEqual(other);
});

describe("manual authorization while the selected recipe is rechecked", () => {
  it.each(["expired", "query", "fragment"] as const)(
    "starts no attempt when the authorization becomes %s during the recipe await",
    async (change) => {
      realTime();
      const h = harness(
        { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
        { uris: uris() },
      );
      await h.hello();
      const pick = await request(h);
      const withdrawn = Promise.withResolvers<boolean>();
      h.recipes.withdrawn.mockReturnValueOnce(withdrawn.promise);
      fake.state.onReconnect = () => h.hello();
      const starting = run(h, pick);
      await vi.waitFor(() => expect(h.recipes.withdrawn).toHaveBeenCalledTimes(1));
      expect(h.fields).not.toHaveBeenCalled();
      expect(stored()).toEqual([]);
      const before = structuredClone(stored());
      const clock =
        change === "expired"
          ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000)
          : undefined;
      try {
        if (change === "expired") {
          expect(await offer(h)).toMatchObject({
            status: { requestId: pick.requestId, state: "blocked", reason: "timed-out" },
          });
        } else {
          fake.state.tabUrls[1] =
            fake.state.pageUrl + (change === "query" ? "?changed=1" : "#changed");
        }
        withdrawn.resolve(false);
        await starting;
        expect(stored()).toEqual(before);
        expect(h.fields).not.toHaveBeenCalled();
        expect(executes()).toEqual([]);
        expect(fake.state.session["pateat.login-picks.v1"]).toEqual([]);
      } finally {
        clock?.mockRestore();
        withdrawn.resolve(false);
      }
    },
  );
});

describe("a manual retry of a cached non-login page in a frame", () => {
  it.each(["confirm", "unclear"] as const)(
    "repairs a selected %s frame without executing its old recipe",
    async (pageKind) => {
      realTime();
      const portal = "https://portal.example/account";
      const frame = { frameId: 3, documentId: "selected", tab: { id: 1, url: portal } };
      const cached = { ...recipe, id: "gen-synthetic", pageKind };
      const answer = Promise.withResolvers<Awaited<ReturnType<LoginGeneration["generate"]>>>();
      const generation = {
        available: vi.fn<LoginGeneration["available"]>(async () => true),
        generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
          sent?.();
          return await answer.promise;
        }),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge: vi.fn<LoginGeneration["judge"]>(),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      };
      const repairs = {
        due: vi.fn(async () => "due" as const),
        hold: vi.fn(async () => undefined),
      };
      const h = harness(
        { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
        { uris: uris(), allowedOrigins: [], custom: [], generation, repairs },
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue([]);
      h.recipes.routes.mockResolvedValue([cached]);
      fake.state.tabUrls[1] = portal;
      fake.state.extracted = {
        login: {
          ok: true,
          observation: {
            version: 1,
            origin,
            path: "/signin",
            language: "en",
            complete: true,
            candidates: [
              { id: "password", role: "password", target: { by: "id", value: "password" } },
              {
                id: "login",
                role: "button",
                target: { by: "id", value: "login" },
                label: "Sign in",
              },
            ],
          },
        },
      };
      await h.hello({ documentId: "top", url: portal }, false);
      await h.hello(frame, false);
      const pick = await request(h, 3);
      fake.state.onReconnect = () =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            signIn: { path: "/signin" },
          },
          sender(frame),
        );
      expect(await run(h, pick)).toMatchObject({ ok: true, state: "generating" });
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
      expect(repairs.due).toHaveBeenCalledExactlyOnceWith({
        recipeId: cached.id,
        revision: cached.revision,
        documentId: "selected",
      });
      expect(generation.generate.mock.calls[0]![0]).toMatchObject({
        observation: { origin, path: "/signin" },
        repair: { recipeId: cached.id, revision: cached.revision },
      });
      expect(generation.generate.mock.calls[0]![0].manual).toBeUndefined();
      expect(fake.state.reconnects).toEqual([{ tabId: 1, frameId: 3, documentId: "selected" }]);
      expect(cached.pageKind).toBe(pageKind);
      expect(stored()).toEqual([]);
      expect(executes()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      answer.resolve({ outcome: "abstained", reason: "ambiguous" });
      await vi.waitFor(async () =>
        expect(await offer(h)).toMatchObject({
          status: { requestId: pick.requestId, state: "blocked" },
        }),
      );
      expect(cached.pageKind).toBe(pageKind);
      expect(executes()).toEqual([]);
    },
  );
});

it("a stale reprompt re-entry cannot cancel a newer pending manual request", async () => {
  realTime();
  const firstWindow = Promise.withResolvers<"closed">();
  const askMasterPassword = vi
    .fn<() => Promise<"closed">>()
    .mockReturnValueOnce(firstWindow.promise)
    .mockResolvedValueOnce("closed");
  const h = harness(
    {
      excludedSites: [{ hostname: "login.example", includeSubdomains: false }],
      repromptSites: [{ hostname: "login.example", includeSubdomains: false }],
    },
    { uris: uris(), reprompt: true, askMasterPassword },
  );
  await h.hello();
  const first = await request(h);
  fake.state.onReconnect = () => h.hello();
  expect(await run(h, first)).toMatchObject({ ok: true, state: "evaluating" });
  expect(askMasterPassword).toHaveBeenCalledTimes(1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000);
  expect(await offer(h)).toMatchObject({
    status: { requestId: first.requestId, state: "blocked", reason: "timed-out" },
  });
  clock.mockRestore();
  fake.state.onReconnect = undefined;
  const second = { ...first, requestId: "replacement-request" };
  expect(await run(h, second)).toMatchObject({ ok: true, state: "evaluating" });
  firstWindow.resolve("closed");
  expect(await offer(h)).toMatchObject({
    status: { requestId: second.requestId, state: "evaluating" },
  });
  await h.login.handle({ version: 1, type: "login.reprompt.ask", tabId: 1 }, popup);
  expect(await offer(h)).toMatchObject({
    status: { requestId: second.requestId, state: "evaluating" },
  });
  expect(stored()).toEqual([]);
  expect(h.fields).not.toHaveBeenCalled();
  expect(executes()).toEqual([]);
});

it("keeps an existing ask-every-time policy after a successful manual login", async () => {
  realTime();
  const asking = [
    {
      site: "login.example",
      incognito: false,
      defaults: JSON.stringify([
        [origin, "bitwarden", "70000000-0000-4000-8000-000000000001", itemId],
      ]),
    },
  ];
  fake.state.session["pateat.login-ask-every-time.v1"] = structuredClone(asking);
  const h = harness({}, { uris: uris() });
  expect(await h.hello()).toMatchObject({ ok: false });
  const settings = structuredClone(h.settings);
  const pick = await request(h);
  fake.state.onReconnect = () => h.hello();
  expect(await run(h, pick)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(stored()).toMatchObject([{ state: "authenticated" }]));
  expect(fake.state.session["pateat.login-ask-every-time.v1"]).toEqual(asking);
  expect(fake.state.session["pateat.login-switch-picks.v1"]).toBeUndefined();
  expect(h.settings).toEqual(settings);
  expect(h.store.update).not.toHaveBeenCalled();
});
