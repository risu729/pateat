import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LoginAttemptMetadata,
  type LoginOperation,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  harness,
  recipe,
  origin,
  itemId,
  otherItemId,
  connectionId,
  sender,
  target,
  uriMatch,
  realTime,
} = createRuntimeTestHarness(fake);
const attemptKey = "pateat.login-attempts.v5";
const sessionKey = "pateat.confirm-fills.v1";
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const stored = () => fake.state.storage[attemptKey] as LoginAttemptMetadata[];
const executes = () =>
  fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
    operation: LoginOperation;
    values: { slot: string; value: string }[];
  }[];
const confirmations = () =>
  executes().filter((entry) => entry.operation.attemptId.startsWith("confirm:"));
const cached = (kind: "confirm" | "unclear" = "confirm") =>
  parseLoginRecipe({
    ...recipe,
    id: "synthetic-confirm",
    pageKind: kind,
    steps: recipe.steps.map((step) => ({ ...step, path: "/confirm" })),
  });
const uris = async (_connection: string, url: string) => ({
  ok: true as const,
  data: uriMatch({ targetOrigin: new URL(url).origin }),
});
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
    onExecute: undefined,
    onAwait: undefined,
    tabUrls: {},
    incognito: new Set(),
    observed: ["unique", "missing"],
    unusable: new Set(),
    disabled: new Set(),
    faint: new Set(),
    ambiguous: new Set(),
    unobservable: new Set(),
    awaited: { ok: true },
    executeReply: undefined,
    gone: new Set(),
    goneFrames: new Set(),
    onPresent: undefined,
    extracted: {},
    signs: undefined,
    loaded: true,
    openTabs: undefined,
    signIn: false,
  });
});
afterEach(async () => {
  for (const listener of fake.state.removed.splice(0))
    for (const tabId of [1, 2, 3]) listener(tabId);
  fake.state.replaced.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
type H = ReturnType<typeof harness>;
async function authenticated(live: Parameters<typeof harness>[1] = {}) {
  const reports: LoginReport[] = [];
  const h = harness({}, { uris, ...live, report: (entry) => reports.push(entry) });
  fake.state.onExecute = async (message) => {
    if ((message["operation"] as LoginOperation).step.kind === "click")
      fake.state.present = new Set(["authenticated"]);
  };
  expect(await h.hello()).toEqual({ ok: true });
  await vi.waitFor(() => expect(stored()[0]).toMatchObject({ state: "authenticated" }));
  await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
  await vi.waitFor(() =>
    expect(fake.state.session[sessionKey]).toMatchObject({
      proofs: [expect.objectContaining({ itemId })],
    }),
  );
  h.fields.mockClear();
  h.store.update.mockClear();
  fake.state.onExecute = undefined;
  return { h, reports, original: structuredClone(stored()) };
}
function configure(h: H, confirm: LoginRecipe = cached()) {
  h.recipes.routes.mockResolvedValue([confirm]);
  h.recipes.recipe.mockResolvedValue(confirm);
  fake.state.pageUrl = `${origin}/confirm`;
  fake.state.observedPath = "/confirm";
  fake.state.present = new Set(["password", "login"]);
  return confirm;
}
const announce = (h: H, from: Record<string, unknown> = {}) =>
  h.hello({ documentId: "confirmation-document", ...from }, false);
async function settled(h: H) {
  await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
}

describe("confirmed-session confirmation filling", () => {
  it.each(["confirm", "unclear"] as const)(
    "fills %s with the authenticated account without changing its attempt or settings",
    async (kind) => {
      const { h, original, reports } = await authenticated({ username: true });
      configure(h, cached(kind));
      h.settings.settings.siteDefaults[0]!.itemId = otherItemId;
      h.settings.settings.pagePermissionDefaults = {
        "sign-in": "fill",
        confirm: "fill",
        "personal-details": "off",
      };
      const before = structuredClone(h.settings);
      expect(await announce(h)).toMatchObject({ ok: false, reason: "confirm-fill" });
      await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
      await settled(h);
      expect(confirmations()[0]).toMatchObject({
        operation: {
          attemptId: `confirm:${original[0]!.id}`,
          signInFill: true,
          step: { kind: "fill", effect: "prepare" },
        },
      });
      expect(h.fields.mock.calls.every(([read]) => read.account.itemId === itemId)).toBe(true);
      expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
        "login.password",
        "login.username",
      ]);
      expect(stored()).toEqual(original);
      expect(h.settings).toEqual(before);
      expect(h.store.update).not.toHaveBeenCalled();
      expect(reports.filter((entry) => entry.type === "start")).toHaveLength(1);
      expect(executes().map((entry) => entry.operation.step.kind)).toEqual([
        "fill",
        "click",
        "fill",
      ]);
    },
  );

  it("obeys confirm off independently of sign-in auto and never reads a value", async () => {
    const { h, original } = await authenticated();
    configure(h);
    h.settings.settings.pagePermissionDefaults = {
      "sign-in": "auto",
      confirm: "off",
      "personal-details": "fill",
    };
    expect(await announce(h)).toMatchObject({ ok: false, reason: "page-off" });
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
    expect(stored()).toEqual(original);
  });

  it.each([
    "unconfirmed",
    "fillOnly",
    "signInFill",
    "blocked",
    "different-account",
    "different-tab",
    "browser-restart",
    "corrupt-session",
    "full-claims",
  ] as const)("refuses an ineligible %s context", async (reason) => {
    const { h } = await authenticated();
    configure(h);
    const record = stored()[0]!;
    if (reason === "unconfirmed") record.unconfirmed = true;
    if (reason === "fillOnly") record.fillOnly = true;
    if (reason === "signInFill") record.signInFill = true;
    if (reason === "blocked") record.state = "blocked";
    if (reason === "different-account") record.account.itemId = otherItemId;
    // A restart restores the actual durable record; it must not mint a session proof.
    if (["browser-restart", "corrupt-session", "full-claims"].includes(reason)) {
      if (reason === "browser-restart") fake.state.session = {};
      if (reason === "corrupt-session")
        fake.state.session[sessionKey] = { proofs: "invalid", claims: [] };
      if (reason === "full-claims") {
        const session = fake.state.session[sessionKey] as { claims: unknown[] };
        session.claims = Array.from({ length: 512 }, (_, i) => ({
          key: `claimed-${i}`,
          tabId: 1,
          document: record.document,
        }));
      }
    }
    fake.state.openTabs = [1];
    const next = harness({}, { uris });
    configure(next);
    await announce(next, reason === "different-tab" ? { tab: { id: 2, incognito: false } } : {});
    await settled(next);
    expect(next.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });

  it("persists proof and claim over worker restart and never replays an unknown delivery", async () => {
    const { h, original } = await authenticated();
    configure(h);
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as LoginOperation).attemptId.startsWith("confirm:"))
        throw new Error("lost acknowledgement");
    };
    await announce(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    const session = structuredClone(fake.state.session[sessionKey]);
    expect(session).toMatchObject({ proofs: [expect.anything()], claims: [expect.anything()] });
    fake.state.openTabs = [1];
    const restarted = harness({}, { uris });
    configure(restarted);
    await announce(restarted);
    await settled(restarted);
    expect(restarted.fields).not.toHaveBeenCalled();
    expect(confirmations()).toHaveLength(1);
    expect(fake.state.session[sessionKey]).toEqual(session);
    expect(stored()).toEqual(original);
    await announce(restarted, { documentId: "fresh-document" });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(2));
    await settled(restarted);
    expect(stored()).toEqual(original);
  });

  it.each(["session-read", "session-write"] as const)("refuses when %s fails", async (phase) => {
    const { h, original } = await authenticated();
    configure(h);
    if (phase === "session-write")
      vi.spyOn(fake.browser.storage.session, "set").mockRejectedValue(new Error("unavailable"));
    else vi.spyOn(fake.browser.storage.session, "get").mockRejectedValue(new Error("unavailable"));
    fake.state.openTabs = [1];
    const next = phase === "session-read" ? harness({}, { uris }) : h;
    if (next !== h) configure(next);
    await announce(next);
    await settled(next);
    expect(confirmations()).toEqual([]);
    expect(next.fields).not.toHaveBeenCalled();
    expect(stored()).toEqual(original);
  });

  it("keeps a repeat hello attached to the same in-flight read and blocks manual/switch operations", async () => {
    const { h, original } = await authenticated();
    configure(h);
    const held = Promise.withResolvers<string>();
    h.fields.mockReturnValueOnce(held.promise);
    await announce(h);
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(1));
    expect(await h.login.active()).toBe(true);
    const settingsBefore = structuredClone(h.settings);
    await announce(h);
    expect(
      await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
    ).toMatchObject({ ok: true, targets: [], reason: "login-running" });
    expect(
      await h.login.handle({ version: 1, type: "login.default.chosen", tabId: 1 }, popup),
    ).toEqual({ ok: false, reason: "login-running" });
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.choice.pick",
          tabId: 1,
          documentId: "confirmation-document",
          connectionId,
          itemId: otherItemId,
          makeDefault: true,
        },
        popup,
      ),
    ).toEqual({ ok: false, reason: "no-choice" });
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.switch.start",
          tabId: 1,
          connectionId,
          itemId: otherItemId,
          makeDefault: true,
        },
        popup,
      ),
    ).toEqual({ ok: false, reason: "in-progress" });
    expect(fake.state.reconnects).toEqual([]);
    expect(h.settings).toEqual(settingsBefore);
    held.resolve("synthetic-confirm-secret");
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(h.fields).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual(original);
  });

  it.each([
    "navigation",
    "top-path",
    "access",
    "permission",
    "settings-revision",
    "profile",
    "snapshot",
    "recipe",
    "vault-lock",
    "excluded-field",
  ] as const)("cancels a late vault read after %s changes", async (change) => {
    let scope = "profile-a";
    const { h, original } = await authenticated({ bindingScope: async () => scope });
    configure(h);
    const held = Promise.withResolvers<string>();
    h.fields.mockReturnValueOnce(held.promise);
    await announce(h);
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(1));
    if (change === "navigation") {
      fake.state.pageUrl = `${origin}/other`;
      fake.state.observedPath = "/other";
      await announce(h, { documentId: "replacement-document", url: `${origin}/other` });
    }
    if (change === "top-path") fake.state.tabUrls[1] = `${origin}/other`;
    if (change === "access") fake.state.granted = false;
    if (change === "permission")
      h.settings.settings.pagePermissionDefaults = {
        "sign-in": "auto",
        confirm: "off",
        "personal-details": "fill",
      };
    if (change === "settings-revision") h.settings.revision += 1;
    if (change === "profile") scope = "profile-b";
    if (change === "snapshot") h.snapshot.current = "60000000-0000-4000-8000-000000000002";
    if (change === "recipe") h.recipes.recipe.mockResolvedValue(undefined);
    if (change === "vault-lock" || change === "excluded-field") {
      const originalHandle = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await originalHandle();
        if (response.ok) {
          if (change === "vault-lock") response.catalog.connections[0]!.state = "locked";
          else
            response.snapshot.settings.itemPolicies = [
              {
                provider: "bitwarden",
                server: "cloud-us",
                userId: response.catalog.connections[0]!.userId!,
                itemId,
                itemName: "Synthetic item",
                selected: false,
                excluded: false,
                excludedFields: ["password"],
              },
            ];
        }
        return response;
      });
    }
    held.resolve("synthetic-confirm-secret");
    await settled(h);
    expect(confirmations()).toEqual([]);
    expect(stored()).toEqual(original);
  });

  it("fences a recipe mutation in the last awaited scope check before delivery", async () => {
    let epoch = 0;
    let reads = 0;
    let mutate = false;
    const { h } = await authenticated({
      bindingScope: async () => {
        if (mutate && ++reads === 2) epoch += 1;
        return "profile-a";
      },
    });
    configure(h);
    h.recipes.fence.mockImplementation(async () => {
      const captured = epoch;
      return () => epoch === captured;
    });
    h.fields.mockImplementation(async () => {
      mutate = true;
      return "synthetic-confirm-secret";
    });
    await announce(h);
    await settled(h);
    expect(reads).toBe(2);
    expect(epoch).toBe(1);
    expect(confirmations()).toEqual([]);
  });

  it("authorizes only its current exact operation, document and destination while awaiting acknowledgement", async () => {
    const { h } = await authenticated();
    configure(h);
    const held = Promise.withResolvers<void>();
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as LoginOperation).attemptId.startsWith("confirm:"))
        await held.promise;
    };
    await announce(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    const operation = confirmations()[0]!.operation;
    const request = {
      version: 1,
      type: "login.operation.authorize",
      token: "synthetic-token",
      attemptId: operation.attemptId,
      operationId: operation.operationId,
    };
    const from = sender({ documentId: "confirmation-document" });
    expect(await h.login.handle(request, from)).toBe(true);
    expect(
      await h.login.handle(
        { ...request, type: "login.destination.check", destination: `${origin}/guarded` },
        from,
      ),
    ).toEqual({ ok: true });
    expect(
      await h.login.handle(
        {
          ...request,
          type: "login.destination.check",
          destination: "https://sibling.login.example/guarded",
        },
        from,
      ),
    ).toEqual({ ok: true });
    expect(
      await h.login.handle(
        {
          ...request,
          type: "login.destination.check",
          destination: "https://elsewhere.example/guarded",
        },
        from,
      ),
    ).toEqual({ ok: false, reason: "not-authorized" });
    expect(
      await h.login.handle(
        {
          ...request,
          type: "login.destination.check",
          destination: "http://login.example/guarded",
        },
        from,
      ),
    ).toEqual({ ok: false, reason: "not-authorized" });
    await Promise.all(
      [
        { documentId: "different" },
        { frameId: 2 },
        { tab: { id: 2, incognito: false } },
        { url: `${origin}/other` },
        { id: "other-extension" },
      ].map(async (override) => {
        expect(
          await h.login.handle(
            request,
            sender({ documentId: "confirmation-document", ...override }),
          ),
        ).not.toBe(true);
      }),
    );
    expect(await h.login.handle({ ...request, operationId: "different" }, from)).toBe(false);
    h.settings.revision += 1;
    expect(await h.login.handle(request, from)).toBe(false);
    held.resolve();
    await settled(h);
    expect(await h.login.handle(request, from)).not.toBe(true);
  });
});

function generation() {
  const answer = Promise.withResolvers<Awaited<ReturnType<LoginGeneration["generate"]>>>();
  let requests = 0;
  const service = {
    available: vi.fn<LoginGeneration["available"]>(async () => true),
    generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
      sent?.();
      requests += 1;
      return requests === 1 ? answer.promise : new Promise(() => undefined);
    }),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  };
  return { service, answer };
}
describe("confirmation classification after authentication", () => {
  it.each(["confirm", "unclear", "sign-in"] as const)(
    "re-admits a generated %s recipe without replacing the authenticated login",
    async (kind) => {
      const { service, answer } = generation();
      const { h, original } = await authenticated({
        username: true,
        custom: [],
        generation: service,
      });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "whole-synthetic-user@example.test" : "synthetic-secret",
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.routes.mockResolvedValue([]);
      h.recipes.starts.mockResolvedValue([]);
      fake.state.pageUrl = `${origin}/confirm`;
      fake.state.observedPath = "/confirm";
      fake.state.present = new Set(["password", "login"]);
      fake.state.extracted["login"] = {
        ok: true,
        observation: {
          version: 1,
          origin,
          path: "/confirm",
          language: "en",
          complete: true,
          headerText: "Signed in as whole-synthetic-user@example.test",
          candidates: [
            { id: "password", role: "password", target: target("password") },
            {
              id: "login",
              role: "button",
              target: target("login"),
              label: "Confirm access for whole-synthetic-user@example.test",
            },
          ],
        },
      };
      const offer = () =>
        h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "synthetic-token",
            signIn: { path: "/confirm" },
          },
          sender({ documentId: "generated-confirmation" }),
        );
      expect(await offer()).toMatchObject({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      const request = service.generate.mock.calls[0]![0];
      expect(JSON.stringify(request)).not.toContain("whole-synthetic-user@example.test");
      expect(h.fields.mock.calls.every(([read]) => read.account.itemId === itemId)).toBe(true);
      expect(stored()).toEqual(original);
      expect(confirmations()).toEqual([]);
      const generated = parseLoginRecipe({ ...cached(), pageKind: kind });
      h.recipes.routes.mockResolvedValue([generated]);
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.onReconnect =
        kind === "sign-in" ? () => h.hello({ documentId: "generated-confirmation" }) : offer;
      answer.resolve({ outcome: "recipe", recipe: generated });
      await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      if (kind === "sign-in") {
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      } else await settled(h);
      expect(service.generate).toHaveBeenCalledTimes(1);
      if (kind === "sign-in") expect(confirmations()).toEqual([]);
      else expect(confirmations()).toHaveLength(1);
      expect(executes().filter((entry) => entry.operation.step.kind === "click")).toHaveLength(1);
      expect(stored()).toEqual(original);
      expect(h.store.update).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
    },
  );
});

describe("confirmation path and frame scope", () => {
  it.each(["same-top", "top-replaced", "top-SPA", "top-not-matched"] as const)(
    "checks %s while an embedded confirmation read is pending",
    async (scenario) => {
      const { h, original } = await authenticated({
        uris: async (_connection, url) => ({
          ok: true,
          data: uriMatch({
            targetOrigin: new URL(url).origin,
            ...(scenario === "top-not-matched" && new URL(url).pathname === "/portal"
              ? { candidates: [] }
              : {}),
          }),
        }),
      });
      fake.state.pageUrl = `${origin}/portal`;
      await h.hello({ documentId: "top-document", url: `${origin}/portal` }, false);
      fake.state.tabUrls[1] = fake.state.pageUrl;
      const confirm = configure(h);
      fake.state.pageUrl = `${origin}/portal`;
      fake.state.observedPath = "/confirm";
      const held = Promise.withResolvers<string>();
      h.fields.mockReturnValueOnce(held.promise);
      const frame = {
        frameId: 3,
        documentId: "confirm-frame",
        url: `${origin}/confirm`,
        tab: { id: 1, incognito: false, url: `${origin}/portal` },
      };
      if (scenario === "top-not-matched") {
        const originalHandle = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await originalHandle();
          if (response.ok) response.catalog.connections[0]!.items[0]!.allowedOrigins = [];
          return response;
        });
      }
      await announce(h, frame);
      if (scenario !== "top-not-matched")
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(1));
      if (scenario === "top-replaced")
        await h.hello({ documentId: "replacement-top", url: `${origin}/portal` }, false);
      if (scenario === "top-SPA") fake.state.tabUrls[1] = `${origin}/another-portal`;
      held.resolve("synthetic-secret");
      await settled(h);
      expect(confirmations()).toHaveLength(scenario === "same-top" ? 1 : 0);
      if (scenario === "same-top")
        expect(confirmations()[0]!.operation.document).toMatchObject({
          frameId: 3,
          documentId: "confirm-frame",
        });
      expect(stored()).toEqual(original);
      expect(confirm.pageKind).toBe("confirm");
    },
  );

  it.each(["code", "keypad", "effect", "click"] as const)(
    "leaves a confirmation %s step untouched",
    async (kind) => {
      const { h, original } = await authenticated();
      const base = cached();
      const step =
        kind === "click"
          ? base.steps[1]!
          : {
              ...base.steps[0]!,
              ...(kind === "effect" ? { effect: "submit", event: "input" } : {}),
              fields: [
                {
                  slot: kind === "code" ? "totp" : "password",
                  target: target("password"),
                  ...(kind === "keypad" ? { keypad: { by: "id", value: "keypad" } } : {}),
                },
              ],
            };
      const unsafe = parseLoginRecipe({
        ...base,
        maxSubmissions: 2,
        slots: [kind === "code" ? "totp" : "password"],
        steps: kind === "click" || kind === "effect" ? [step] : [step, base.steps[1]!],
      });
      configure(h, unsafe);
      await announce(h);
      await settled(h);
      expect(confirmations()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(stored()).toEqual(original);
    },
  );
});

it("uses the real recipe cache mutation epoch across the final asynchronous profile check", async () => {
  const { createRecipeSync } = await import("../../service/recipes");
  const { toLoginLayout } = await import("@pateat/contracts");
  const document = {
    version: 1 as const,
    id: "synthetic-confirm",
    revision: 1,
    origin,
    layouts: [toLoginLayout(cached(), { key: "1000", createdAt: 1000 })],
  };
  const connection = {
    origin: "https://service.example",
    deviceId: "60000000-0000-4000-8000-000000000001",
    credential: `pateat_device_${"C".repeat(43)}`,
    rejected: false,
    settingsSynced: true as const,
  };
  const clearStorage = Promise.withResolvers<void>();
  const cache = createRecipeSync({
    service: {
      connection: async () => connection,
      fence: () => () => true,
      recordSync: async () => undefined,
    },
    transport: {
      recipeChanges: async () => ({
        kind: "page",
        page: { version: 1, changes: [], cursor: 1, complete: true },
      }),
    },
    storage: {
      read: async () => ({
        version: 2,
        origin: connection.origin,
        deviceId: connection.deviceId,
        cursor: 1,
        recipes: [document],
      }),
      write: async () => undefined,
      readRecovery: async () => undefined,
      writeRecovery: async () => undefined,
      clear: async () => clearStorage.promise,
    },
    schedule: {
      read: async () => ({ version: 1, startedAt: 5000, retryAt: 9e12 }),
      write: async () => undefined,
    },
    now: () => 5000,
    build: "synthetic-test",
  });
  let afterRead = false;
  let scopeChecks = 0;
  let clearing: Promise<void> | undefined;
  const { h } = await authenticated({
    bindingScope: async () => {
      if (afterRead && ++scopeChecks === 2) clearing = cache.clear();
      return "profile-a";
    },
  });
  const current = (await cache.recipes.routes!(origin))[0]!;
  configure(h, current);
  h.recipes.fence.mockImplementation((value) => cache.recipes.fence!(value));
  expect(await cache.recipes.withdrawn!(origin, current.id, current.layout)).toBe(false);
  const originalFence = await cache.recipes.fence!(current);
  expect(originalFence?.()).toBe(true);
  h.fields.mockImplementation(async () => {
    afterRead = true;
    return "synthetic-confirm-secret";
  });
  await announce(h);
  await settled(h);
  expect(scopeChecks).toBe(2);
  expect(originalFence?.()).toBe(false);
  expect(confirmations()).toEqual([]);
  clearStorage.resolve();
  await clearing;
});

it.each(["abstained", "unknown"] as const)(
  "does not regenerate an %s classification in the same authenticated document after worker restart",
  async (outcome) => {
    const { service, answer } = generation();
    const { h, original } = await authenticated({ generation: service, custom: [] });
    const missing = (next: H) => {
      next.recipes.recipe.mockResolvedValue(undefined);
      next.recipes.routes.mockResolvedValue([]);
      next.recipes.starts.mockResolvedValue([]);
    };
    missing(h);
    fake.state.pageUrl = `${origin}/confirm`;
    fake.state.observedPath = "/confirm";
    fake.state.extracted["login"] = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/confirm",
        language: "en",
        complete: true,
        candidates: [{ id: "password", role: "password", target: target("password") }],
      },
    };
    const offer = (next: H) =>
      next.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          signIn: { path: "/confirm" },
        },
        sender({ documentId: "classified-document" }),
      );
    await offer(h);
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    if (outcome === "abstained") answer.resolve({ outcome: "abstained", reason: "ambiguous" });
    else answer.reject(new Error("unknown request outcome"));
    await settled(h);
    expect(await offer(h)).toMatchObject({ ok: false, reason: "logged-in" });
    fake.state.openTabs = [1];
    const restarted = harness({}, { uris, generation: service, custom: [] });
    missing(restarted);
    expect(await offer(restarted)).toMatchObject({ ok: false, reason: "logged-in" });
    await settled(restarted);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(confirmations()).toEqual([]);
    expect(stored()).toEqual(original);
  },
);

it.each([
  "same-frame-document",
  "same-frame-SPA",
  "top",
  "sibling-frame",
  "wrong-origin",
  "top-URI-mismatch",
] as const)("scopes a framed authentication's later confirmation to %s", async (scenario) => {
  const h = harness(
    {},
    {
      uris: async (_connection, url) => ({
        ok: true,
        data: uriMatch({
          targetOrigin: new URL(url).origin,
          ...(scenario === "top-URI-mismatch" && new URL(url).pathname === "/portal"
            ? { candidates: [] }
            : {}),
        }),
      }),
    },
  );
  // Start with a live matching top page and authenticate through its embedded frame.
  fake.state.pageUrl = `${origin}/portal`;
  fake.state.tabUrls[1] = fake.state.pageUrl;
  await h.hello({ documentId: "framed-auth-top", url: fake.state.pageUrl }, false);
  fake.state.observedPath = "/signin";
  fake.state.present = new Set(["password", "login"]);
  fake.state.onExecute = async (message) => {
    if ((message["operation"] as LoginOperation).step.kind === "click")
      fake.state.present = new Set(["authenticated"]);
  };
  const authFrame = {
    frameId: 3,
    documentId: "authentication-frame",
    url: `${origin}/signin`,
    tab: { id: 1, incognito: false, url: `${origin}/portal` },
  };
  expect(await h.hello(authFrame)).toEqual({ ok: true });
  await vi.waitFor(() =>
    expect(stored()[0]).toMatchObject({ state: "authenticated", document: { frameId: 3 } }),
  );
  await settled(h);
  await vi.waitFor(() =>
    expect(fake.state.session[sessionKey]).toMatchObject({
      proofs: [expect.objectContaining({ itemId })],
    }),
  );
  const original = structuredClone(stored());
  h.fields.mockClear();
  h.store.update.mockClear();
  fake.state.onExecute = undefined;
  configure(h);
  fake.state.pageUrl = `${origin}/portal`;
  fake.state.tabUrls[1] = fake.state.pageUrl;
  fake.state.observedPath = "/confirm";
  let from: Record<string, unknown> = {
    ...authFrame,
    documentId: scenario === "same-frame-SPA" ? authFrame.documentId : "confirmation-frame",
    url: `${origin}/confirm`,
  };
  if (scenario === "top") {
    fake.state.pageUrl = `${origin}/confirm`;
    fake.state.tabUrls[1] = fake.state.pageUrl;
    from = { documentId: "framed-auth-top", url: fake.state.pageUrl };
  }
  if (scenario === "sibling-frame") from = { ...from, frameId: 4 };
  if (scenario === "wrong-origin")
    from = { ...from, url: "https://other.example/confirm", origin: "https://other.example" };
  if (scenario === "top-URI-mismatch") {
    const originalHandle = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const result = await originalHandle();
      if (result.ok) result.catalog.connections[0]!.items[0]!.allowedOrigins = [];
      return result;
    });
  }
  await announce(h, from);
  await settled(h);
  expect(confirmations()).toHaveLength(
    ["wrong-origin", "top-URI-mismatch"].includes(scenario) ? 0 : 1,
  );
  expect(stored()).toEqual(original);
  expect(h.store.update).not.toHaveBeenCalled();
  expect(h.fields.mock.calls.every(([read]) => read.account.itemId === itemId)).toBe(true);
  expect(executes().filter((entry) => entry.operation.step.kind === "click")).toHaveLength(1);
});
