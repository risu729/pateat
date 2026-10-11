import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsSnapshot,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import { vaultFailure } from "../vault/record";
import type { LiveUriMatcher } from "../vault/site-candidates";
import type { LoginGeneration } from "./runtime";
import type { LoginFieldSource } from "./vault";

const fake = vi.hoisted(() => {
  const state = {
    storage: {} as Record<string, unknown>,
    messages: [] as {
      type: string;
      values?: { slot: string; value: string }[];
      account?: { username: string };
    }[],
    /** Overrides the document's answer to an execution, such as a wrong-account refusal. */
    executeReply: undefined as undefined | { ok: boolean; reason?: string },
    granted: true,
    pageUrl: "https://login.example/signin",
    onExecute: undefined as
      | undefined
      | ((message: Record<string, unknown>, tabId: number) => Promise<void>),
    /** Per-tab URLs; other tabs use `pageUrl`. */
    tabUrls: {} as Record<number, string>,
    /** Completion, then rejection target states reported by observation. */
    observed: ["unique", "missing"],
    observedPath: "/signin",
    /** When set, each requested target is reported unique only if its value is listed. */
    present: undefined as Set<string> | undefined,
    /** The document's answer while it waits for a step's elements. */
    awaited: { ok: true } as { ok: boolean; reason?: string },
    /** Runs while the document waits for a step's elements. */
    onAwait: undefined as undefined | (() => void),
    /** Documents that went away with their page; messages to them fail. */
    gone: new Set<string>(),
    /** Every runtime's tab-closed listener, so a test can close its tabs afterwards. */
    removed: [] as ((tabId: number) => void)[],
    /** The document's description of itself, by the page asked for. */
    extracted: {} as Record<string, unknown>,
  };
  const browser = {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
    permissions: { contains: async () => state.granted },
    storage: {
      local: {
        setAccessLevel: async () => undefined,
        get: async (keys: string[]) =>
          Object.fromEntries(
            keys.filter((key) => key in state.storage).map((key) => [key, state.storage[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.storage, structuredClone(values));
        },
      },
    },
    tabs: {
      query: async () => [],
      get: async (id: number) => ({ id, url: state.tabUrls[id] ?? state.pageUrl }),
      sendMessage: async (
        _tabId: number,
        message: Record<string, unknown>,
        options?: { documentId?: string },
      ) => {
        if (options?.documentId && state.gone.has(options.documentId))
          throw new Error("Could not establish connection. Receiving end does not exist.");
        state.messages.push(structuredClone(message) as (typeof state.messages)[number]);
        if (message["type"] === "login.await") {
          state.onAwait?.();
          return state.awaited;
        }
        if (message["type"] === "login.observe")
          return {
            path: state.observedPath,
            targets: state.present
              ? (message["targets"] as { value: string }[]).map((entry) =>
                  state.present!.has(entry.value) ? "unique" : "missing",
                )
              : [...state.observed],
          };
        if (message["type"] === "login.extract")
          return (
            state.extracted[message["page"] as string] ?? { ok: false, reason: "no-candidates" }
          );
        if (message["type"] === "login.execute") {
          await state.onExecute?.(message, _tabId);
          const operation = message["operation"] as {
            operationId: string;
            document: { documentId: string };
          };
          return {
            ok: true,
            operationId: operation.operationId,
            documentId: operation.document.documentId,
            mutation: state.executeReply && !state.executeReply.ok ? "none" : "possible",
            ...state.executeReply,
          };
        }
        return { ok: true };
      },
      onRemoved: {
        addListener: (listener: (tabId: number) => void) => {
          state.removed.push(listener);
        },
      },
    },
  };
  return { state, browser };
});
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createLoginRuntime } = await import("./runtime");
const { createLoginSites } = await import("./sites");

const origin = "https://login.example";
const connectionId = "50000000-0000-4000-8000-000000000001";
const itemId = "80000000-0000-4000-8000-000000000001";
const snapshotId = "60000000-0000-4000-8000-000000000001";
const trusted = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/options.html",
} as never;
const sender = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "synthetic-extension",
    tab: { id: 1 },
    frameId: 0,
    documentId: "synthetic-document",
    url: fake.state.pageUrl,
    ...overrides,
  }) as never;
const target = (value: string) => ({ by: "id" as const, value });
const recipe = parseLoginRecipe({
  version: 1,
  id: "synthetic-signin",
  revision: 1,
  origin,
  slots: ["password"],
  steps: [
    { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("password") }] },
    { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
  ],
  completion: { path: "/signin", target: target("authenticated") },
  maxSubmissions: 1,
});
const userId = "70000000-0000-4000-8000-000000000001";
const savedBinding: SavedLoginBinding = {
  recipeId: recipe.id,
  origin,
  provider: "bitwarden",
  userId,
  itemId,
  itemName: "Synthetic item",
  slots: [{ slot: "password", field: "password" }],
};

const otherItemId = "80000000-0000-4000-8000-000000000002";
const uriMatch = (overrides: Partial<UriCandidates> = {}): UriCandidates => ({
  connectionId,
  userId,
  snapshotId,
  targetOrigin: origin,
  candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
  unavailableUris: [],
  unavailableItemIds: [],
  ...overrides,
});

function harness(
  overrides: Partial<LocalSettings> = {},
  live: {
    allowedOrigins?: string[];
    uris?: LiveUriMatcher;
    quarantined?: boolean;
    /** Adds a second, not enabled connection of the same provider account. */
    duplicateAccount?: boolean;
    /** Adds a login username field to the item. */
    username?: boolean;
    /** Recipe generation for pages without a recipe. */
    generation?: LoginGeneration;
    /** Replaces the item's custom fields. */
    custom?: {
      name: string | null;
      kind: "text" | "hidden" | "linked";
      linkedFieldId?: string;
    }[];
  } = {},
) {
  const current = { current: snapshotId, userId: userId as string | undefined };
  const settings: LocalSettings = {
    connections: [
      {
        connectionId,
        enabled: true,
        selection: { mode: "all", groupIds: [], itemIds: [] },
        excludedItemIds: [],
        excludedFields: [],
      },
    ],
    excludedSites: [],
    siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }],
    bindings: [savedBinding],
    ...overrides,
  };
  const snapshot: SettingsSnapshot = { version: 1, revision: 1, settings };
  const store = {
    read: vi.fn(async () => structuredClone(snapshot)),
    update: vi.fn(
      async (
        expected: number | undefined,
        mutate: (value: SettingsSnapshot) => SettingsSnapshot,
      ) => {
        if (expected !== undefined && expected !== snapshot.revision)
          throw new Error("revision-conflict");
        const next = mutate(structuredClone(snapshot));
        Object.assign(snapshot, next, { revision: snapshot.revision + 1 });
        return structuredClone(snapshot);
      },
    ),
    handle: vi.fn(async (): Promise<SettingsResponse> => ({
      version: 1,
      ok: true,
      snapshot: structuredClone(snapshot),
      catalog: {
        connections: [
          {
            id: connectionId,
            label: "Synthetic live vault",
            provider: "bitwarden",
            ...(current.userId ? { userId: current.userId } : {}),
            snapshotId: current.current,
            state: "ready",
            ...(live.quarantined ? { quarantinedItemIds: [itemId] } : {}),
            groups: [],
            items: [
              {
                id: itemId,
                label: "Synthetic item",
                allowedOrigins: live.allowedOrigins ?? [origin],
                groupIds: [],
                fields: [
                  ...(live.username
                    ? [
                        {
                          id: "login.username",
                          label: "Username",
                          name: null,
                          kind: "text" as const,
                        },
                      ]
                    : []),
                  { id: "login.password", label: "Password", name: null, kind: "hidden" as const },
                  ...(live.custom ?? [{ name: "Branch", kind: "text" as const }]).map(
                    (field, index) => ({
                      id: `custom.${current.current}.${index}`,
                      label: field.name ?? "",
                      ...field,
                    }),
                  ),
                ],
              },
              {
                id: otherItemId,
                label: "Other synthetic item",
                allowedOrigins: [],
                groupIds: [],
                fields: [
                  { id: "login.password", label: "Password", name: null, kind: "hidden" as const },
                ],
              },
            ],
          },
          ...(live.duplicateAccount
            ? [
                {
                  id: "duplicate-connection",
                  label: "Same account again",
                  provider: "bitwarden",
                  userId,
                  snapshotId: current.current,
                  state: "ready" as const,
                  groups: [],
                  items: [],
                },
              ]
            : []),
        ],
      },
    })),
  };
  const fields = vi.fn<LoginFieldSource>(async () => "synthetic-secret");
  const recipes = {
    recipe: vi.fn(async (at: string, path: string): Promise<typeof recipe | undefined> =>
      at === origin && path === "/signin" ? recipe : undefined,
    ),
    firstSteps: vi.fn(async (at: string) => (at === origin ? [recipe.steps[0]!] : [])),
  };
  const login = createLoginRuntime(store, {
    fields,
    sites: createLoginSites(store),
    recipes,
    ...(live.uris ? { uris: live.uris } : {}),
    ...(live.generation ? { generation: live.generation } : {}),
  });
  // By default the document reports its first step ready, as the content script does
  // once the form appears; `start: false` sends the initial announcement instead.
  const hello = (from: Record<string, unknown> = {}, start = true) =>
    login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        ...(start
          ? { start: { path: new URL(String(from["url"] ?? fake.state.pageUrl)).pathname } }
          : {}),
      },
      sender(from),
    );
  /** The document reports a visible sign-in input on its path. */
  const signIn = () =>
    login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        signIn: { path: new URL(fake.state.pageUrl).pathname },
      },
      sender(),
    );
  return { login, store, fields, recipes, hello, signIn, snapshot: current, settings: snapshot };
}

describe("production login document admission", () => {
  afterEach(() => {
    // Close every test's tabs, so no attempt left reconciling answers a later test.
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });
  it("completes a saved-default HTTPS login with a local recipe and live field", async () => {
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    expect(h.fields).toHaveBeenCalledTimes(1);
    // The saved default and binding are already stored, so nothing is written back.
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.observe")).not.toEqual([]),
    );
    expect(h.store.update).not.toHaveBeenCalled();
    // The content script fills a Bitwarden password only into a password input.
    expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.values).toEqual([
      { slot: "password", value: "synthetic-secret", secret: "password" },
    ]);
    expect(h.fields.mock.calls[0]![0]).toMatchObject({
      account: { origin, connectionId, itemId },
      fieldId: "login.password",
    });
  });
  it("sends the username with a password-only fill and stops on a wrong displayed account", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account" };
    const h = harness({}, { username: true });
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v1"]).toMatchObject([
        { state: "blocked", outcome: "wrong-account", submissions: 0, retries: 0 },
      ]),
    );
    const executes = fake.state.messages.filter((entry) => entry.type === "login.execute");
    // The fill is refused once and never retried; the click never runs.
    expect(executes).toHaveLength(1);
    expect(executes[0]!.account).toEqual({ username: "my2@example.com" });
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
      "login.password",
      "login.username",
    ]);
  });
  it("does not compare the page when the item has no username", async () => {
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    expect(
      fake.state.messages.filter((entry) => entry.type === "login.execute" && entry.account),
    ).toEqual([]);
  });
  it.each([
    ["an origin without a saved default", "https://other.example/signin"],
    ["a subdomain of the saved origin", "https://sub.login.example/signin"],
    ["a different port of the saved origin", "https://login.example:8443/signin"],
  ])("stops %s without a recipe before any policy or vault access", async (_name, url) => {
    fake.state.pageUrl = url;
    const h = harness();
    expect(await h.hello()).toEqual({ ok: false, reason: "recipe-not-found" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it.each([
    [
      "plain HTTP even with a saved HTTP default",
      "http://login.example/signin",
      {
        siteDefaults: [{ origin: "http://login.example", provider: "bitwarden", userId, itemId }],
      },
    ],
    [
      "an excluded site",
      "https://login.example/signin",
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
    ],
  ])("ignores %s before any policy, vault or page access", async (_name, url, overrides) => {
    fake.state.pageUrl = url;
    const h = harness(overrides as Partial<LocalSettings>);
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.recipes.recipe).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it.each([
    // Chrome withholds the tab's URL without host access to the tab's page.
    ["a frame whose tab URL is withheld", { frameId: 1 }],
    ["a sender without a document id", { documentId: undefined }],
  ])("ignores %s on a saved-default origin", async (_name, overrides) => {
    const h = harness();
    expect(await h.hello(overrides)).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it("never admits the loopback probe origin outside the probe build", async () => {
    fake.state.storage["pateat.login-probe-origin.v1"] = { origin: "http://127.0.0.1:3847" };
    fake.state.pageUrl = "http://127.0.0.1:3847/signin";
    const h = harness({ siteDefaults: [] });
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.recipes.recipe).not.toHaveBeenCalled();
    expect(fake.state.messages).toEqual([]);
  });
  it("refuses a fill authorization once site access is withdrawn mid-attempt", async () => {
    const h = harness();
    const answers: unknown[] = [];
    fake.state.onExecute = async (message) => {
      const operation = message["operation"] as { attemptId: string; operationId: string };
      const authorize = () =>
        h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(),
        );
      answers.push(await authorize());
      fake.state.granted = false;
      answers.push(await authorize());
      fake.state.onExecute = undefined;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers).toEqual([true, false]);
  });
  it("respects site access the user withheld in Chrome", async () => {
    fake.state.granted = false;
    const h = harness();
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    expect(h.store.handle).not.toHaveBeenCalled();
  });
  const signinStart = {
    path: "/signin",
    require: "writable",
    targets: [{ by: "id", value: "password" }],
  };
  it("refuses an admitted page without a saved recipe and never reads the vault", async () => {
    fake.state.pageUrl = "https://login.example/elsewhere";
    const h = harness();
    // The origin has a recipe elsewhere, so the document watches for its first step.
    expect(await h.hello()).toEqual({
      ok: false,
      reason: "recipe-not-found",
      starts: [signinStart],
    });
    // The policy catalog (and with it every configured vault) is never opened.
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).toEqual(["login.status"]);
  });
  it("leaves a path where several recipes start out of the watch list", async () => {
    fake.state.pageUrl = "https://login.example/elsewhere";
    const h = harness();
    h.recipes.firstSteps.mockResolvedValue([
      recipe.steps[0]!,
      { ...recipe.steps[0]!, fields: [{ slot: "password", target: target("other") }] },
      { ...recipe.steps[0]!, path: "/other" },
    ] as never);
    expect(await h.hello()).toEqual({
      ok: false,
      reason: "recipe-not-found",
      starts: [{ ...signinStart, path: "/other" }],
    });
  });
  it("starts only after the document reports the first step ready", async () => {
    const h = harness();
    expect(await h.hello({}, false)).toEqual({
      ok: false,
      reason: "form-not-ready",
      starts: [signinStart],
    });
    // A start reported for another path does not count for this one.
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          start: { path: "/elsewhere" },
        },
        sender(),
      ),
    ).toEqual({ ok: false, reason: "form-not-ready", starts: [signinStart] });
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.fields).not.toHaveBeenCalled();
    // The same document announces again once its form appears.
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    // A document that already carries an attempt cannot start another one.
    expect(await h.hello()).toEqual({ ok: false, reason: "duplicate-document" });
  });
  it("refuses a different content script instance in an already announced document", async () => {
    const h = harness();
    expect(await h.hello({}, false)).toMatchObject({ reason: "form-not-ready" });
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "other-token",
          start: { path: "/signin" },
        },
        sender(),
      ),
    ).toEqual({ ok: false, reason: "duplicate-document" });
  });
  it("a policy change while waiting for elements stops before any intent or vault read", async () => {
    const h = harness();
    fake.state.onAwait = () => {
      h.settings.revision += 1;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v1"]).toMatchObject([
        { state: "blocked", outcome: "policy-changed", usedOperationIds: [] },
      ]),
    );
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it("stops before any vault read or page change when a step's elements never appear", async () => {
    fake.state.awaited = { ok: false, reason: "timeout" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v1"]).toMatchObject([
        {
          state: "retryable",
          outcome: "structural-mismatch",
          submissions: 0,
          usedOperationIds: [],
        },
      ]),
    );
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  describe("a login form inside a frame", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    // The tab shows the page around the frame; the frame's own URL is the login page.
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    it("logs in when the item also allows the tab's page", async () => {
      const h = harness();
      expect(await h.hello(framed("https://login.example/home"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields).toHaveBeenCalledTimes(1);
    });
    it("logs in on another site's page only when both URLs match the item's URIs", async () => {
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello(framed("https://portal.example/account"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(uris.mock.calls.map((call) => call[1])).toEqual([
        "https://login.example/signin",
        "https://portal.example/account",
      ]);
    });
    it("refuses before any field read when only the frame's URL matches", async () => {
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({
          targetOrigin: new URL(url).origin,
          ...(new URL(url).origin === origin ? {} : { candidates: [] }),
        }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello(framed("https://evil.example/"))).toEqual({
        ok: false,
        reason: "frame-top-mismatch",
      });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("chooses an account only among items matching both URLs", async () => {
      // Without a saved default, the frame's URL matches two items but the tab's only one.
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({
          targetOrigin: new URL(url).origin,
          candidates:
            new URL(url).origin === origin
              ? [
                  { itemId, matches: [{ uriIndex: 0, match: 0 }] },
                  { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
                ]
              : [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
        }),
      }));
      const h = harness({ siteDefaults: [] }, { allowedOrigins: [], uris });
      expect(await h.hello(framed("https://portal.example/"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields.mock.calls[0]![0]).toMatchObject({ account: { itemId } });
    });
    it("ignores a frame on an excluded page before any policy or vault access", async () => {
      const h = harness({
        excludedSites: [{ hostname: "evil.example", includeSubdomains: false }],
      });
      expect(await h.hello(framed("https://evil.example/"))).toEqual({
        ok: false,
        reason: "unauthorized-document",
      });
      expect(h.store.handle).not.toHaveBeenCalled();
      expect(h.recipes.recipe).not.toHaveBeenCalled();
      expect(fake.state.messages).toEqual([]);
    });
    it("starts one attempt when the page and its frame announce at the same time", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const h = harness();
      const top = "https://login.example/signin";
      const answers = await Promise.all([
        h.hello({ documentId: "page-document", url: top }),
        h.hello(framed(top)),
      ]);
      expect(answers).toContainEqual({ ok: true });
      expect(answers).toContainEqual({ ok: false, reason: "tab-busy" });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      expect(fake.state.storage["pateat.login-attempts.v1"]).toHaveLength(1);
    });
    it("keeps one attempt per tab and lets only a new page end a frame's attempt", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const h = harness();
      const top = "https://login.example/home";
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      // The page around the frame and another frame of it never take the attempt over.
      expect(await h.hello({ documentId: "page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(await h.hello(framed(top, { frameId: 5, documentId: "widget-document" }))).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      // While the frame is still there, a new top document is its own page announcing.
      fake.state.gone = new Set(["page-document"]);
      expect(await h.hello({ documentId: "late-page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      // A new page in the tab ends the frame's attempt without a fill on the new page.
      fake.state.gone = new Set(["frame-document", "widget-document"]);
      fake.state.tabUrls[1] = "https://login.example/signin";
      await h.hello({ documentId: "next-page" });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v1"]).toMatchObject([
          { state: "blocked", outcome: "cancelled" },
        ]),
      );
      expect(executes()).toHaveLength(1);
    });
  });
  describe("a frame's attempt when the tab changes page", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    const stored = () =>
      fake.state.storage["pateat.login-attempts.v1"] as { state: string; outcome?: string }[];
    it("lets a new page's frame that announced first keep its document", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const h = harness();
      // The previous page of the tab, without a login form.
      fake.state.tabUrls[1] = "https://login.example/home";
      expect(
        await h.hello({ documentId: "home-document", url: "https://login.example/home" }),
      ).toMatchObject({ ok: false });
      // The next page's login frame announces and starts before its own page does.
      const top = "https://login.example/account";
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      fake.state.gone = new Set(["home-document"]);
      expect(await h.hello({ documentId: "account-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(fake.state.messages.filter((entry) => entry.type === "login.cancel")).toEqual([]);
      expect(stored()).toMatchObject([{ state: "executing" }]);
    });
    it("ends the attempt when the tab moves to a page on another origin", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const uris = vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      }));
      const h = harness({}, { allowedOrigins: [], uris });
      const top = "https://portal.example/account";
      fake.state.tabUrls[1] = top;
      expect(await h.hello({ documentId: "portal-document", url: top })).toMatchObject({
        ok: false,
      });
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(1));
      // The login navigates the whole tab; the frame goes with the old page.
      fake.state.gone = new Set(["frame-document", "portal-document"]);
      fake.state.tabUrls[1] = "https://portal.example/dashboard";
      await h.hello({ documentId: "dashboard-document", url: "https://portal.example/dashboard" });
      expect(stored()).toMatchObject([{ state: "blocked", outcome: "cancelled" }]);
      expect(executes()).toHaveLength(1);
    });
    it("refuses an operation once the tab shows another site", async () => {
      let authorized: unknown;
      const h = harness();
      fake.state.onExecute = async (message) => {
        fake.state.tabUrls[1] = "https://elsewhere.example/";
        const operation = message["operation"] as { attemptId: string; operationId: string };
        authorized = await h.login.handle(
          {
            version: 1,
            type: "login.operation.authorize",
            token: "synthetic-token",
            attemptId: operation.attemptId,
            operationId: operation.operationId,
          },
          sender(framed("https://elsewhere.example/")),
        );
      };
      expect(await h.hello(framed("https://login.example/home"))).toEqual({ ok: true });
      await vi.waitFor(() => expect(authorized).toBe(false));
    });
  });
  describe("live provider URI matches", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    it("let the saved default fill when its URI matches this page", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({}, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(h.fields).toHaveBeenCalledTimes(1);
      // One query per document and snapshot, for the default's connection and the full URL.
      expect(uris).toHaveBeenCalledTimes(1);
      expect(uris.mock.calls[0]?.slice(0, 2)).toEqual([
        connectionId,
        "https://login.example/signin",
      ]);
    });
    it.each<[string, Awaited<ReturnType<LiveUriMatcher>>, string]>([
      [
        "no rule of the item matches",
        { ok: true, data: uriMatch({ candidates: [] }) },
        "item-origin-mismatch",
      ],
      [
        "only another item matches",
        {
          ok: true,
          data: uriMatch({
            candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
          }),
        },
        "item-origin-mismatch",
      ],
      [
        "the item's rules could not be evaluated",
        { ok: true, data: uriMatch({ candidates: [], unavailableItemIds: [itemId] }) },
        "item-uri-unevaluated",
      ],
      [
        "only another item's rules could not be evaluated",
        { ok: true, data: uriMatch({ candidates: [], unavailableItemIds: [otherItemId] }) },
        "item-origin-mismatch",
      ],
      [
        "a different snapshot answered",
        {
          ok: true,
          data: uriMatch({ snapshotId: "60000000-0000-4000-8000-000000000002" }),
        },
        "vault-unavailable",
      ],
      ["the vault is locked", vaultFailure("crypto-locked"), "vault-unavailable"],
    ])("refuse before any field read when %s", async (_name, answer, reason) => {
      const h = harness({}, { allowedOrigins: [], uris: async () => answer });
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
    });
    it("refuse when the matcher throws", async () => {
      const h = harness(
        {},
        {
          allowedOrigins: [],
          uris: async () => {
            throw new Error("synthetic host failure");
          },
        },
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("report a default awaiting field review as unavailable without matching", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({}, { allowedOrigins: [], uris, quarantined: true });
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(uris).not.toHaveBeenCalled();
    });
    it("ask again after the connection's snapshot is replaced", async () => {
      const replaced = "60000000-0000-4000-8000-000000000002";
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({}, { allowedOrigins: [], uris });
      fake.state.onExecute = async () => {
        h.snapshot.current = replaced;
        uris.mockResolvedValue({ ok: true, data: uriMatch({ snapshotId: replaced }) });
        fake.state.onExecute = undefined;
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(uris).toHaveBeenCalledTimes(2));
    });
    it("are not consulted for a page without a recipe", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      fake.state.pageUrl = "https://other.example/signin";
      expect(await harness({}, { allowedOrigins: [], uris }).hello()).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(uris).not.toHaveBeenCalled();
    });
    it("keep static allowed origins working without a matcher", async () => {
      const h = harness({}, { allowedOrigins: [] });
      expect(await h.hello()).toEqual({ ok: false, reason: "item-origin-mismatch" });
    });
  });
  const branchRecipe = parseLoginRecipe({
    ...recipe,
    slots: ["branch", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "password", target: target("password") },
        ],
      },
      recipe.steps[1],
    ],
  });
  const branchBinding: SavedLoginBinding = {
    ...savedBinding,
    slots: [
      { slot: "branch", field: { custom: "Branch" } },
      { slot: "password", field: "password" },
    ],
  };
  describe("without a saved account choice", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    const unsaved = { siteDefaults: [], bindings: [] };
    const both = uriMatch({
      candidates: [
        { itemId, matches: [{ uriIndex: 0, match: 0 }] },
        { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
    });
    it("logs in with the only URI-matched item and saves the choice after authenticated", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      expect(h.fields.mock.calls[0]![0]).toMatchObject({
        account: { origin, connectionId, itemId },
        fieldId: "login.password",
      });
      expect(h.store.update.mock.calls[0]![0]).toBe(1);
      // The saved default names the provider account, not this device's connection, and
      // keeps the connection's label for display.
      expect(h.settings.settings.siteDefaults).toEqual([
        {
          origin,
          provider: "bitwarden",
          userId,
          itemId,
          itemName: "Synthetic item",
          accountName: "Synthetic live vault",
        },
      ]);
      expect(h.settings.settings.bindings).toEqual([
        { ...savedBinding, accountName: "Synthetic live vault" },
      ]);
      // One query per document while every connection's snapshot is unchanged.
      expect(uris).toHaveBeenCalledTimes(1);
    });
    describe("with a generated recipe that has no completion yet", () => {
      const { completion: _unlearned, ...generated } = recipe;
      const start = async (withRecipe: typeof generated) => {
        const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
        const h = harness(unsaved, { allowedOrigins: [], uris });
        h.recipes.recipe.mockResolvedValue(withRecipe);
        expect(await h.hello()).toEqual({ ok: true });
        return h;
      };
      const published = () => JSON.stringify(fake.state.messages);
      it("never reports authenticated or saves a choice after submitting", async () => {
        const h = await start(generated);
        // Nothing settles the submission until the observation budget runs out.
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        // After the last step there is nothing to look for: no completion, rejection or step.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({ type: "login.observe", targets: [] }),
        );
        expect(published()).not.toContain("authenticated");
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
      it("still reports a rejection target, observed first", async () => {
        fake.state.observed = ["unique"];
        const h = await start({ ...generated, rejection: target("error") });
        await vi.waitFor(() => expect(published()).toContain("credential-rejected"));
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({ type: "login.observe", targets: [target("error")] }),
        );
        expect(h.store.update).not.toHaveBeenCalled();
      });
      const twoPages = (rejection?: string) =>
        parseLoginRecipe({
          ...generated,
          ...(rejection ? { rejection: target(rejection) } : {}),
          steps: [
            { kind: "click", path: "/signin", target: target("continue"), purpose: "advance" },
            {
              kind: "fill",
              path: "/next",
              fields: [{ slot: "password", target: target("password") }],
            },
            { kind: "click", path: "/next", target: target("login"), purpose: "submit" },
          ],
          maxSubmissions: 2,
        });
      it("waits for the next page's field behind a rejection target", async () => {
        fake.state.observedPath = "/next";
        fake.state.present = new Set();
        await start(twoPages("error"));
        await vi.waitFor(() =>
          expect(
            fake.state.messages.filter((entry) => entry.type === "login.observe").length,
          ).toBeGreaterThanOrEqual(3),
        );
        // Neither the rejection nor the field is there, so only the advance click ran.
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          1,
        );
      });
      it("continues to the next page's step", async () => {
        fake.state.observedPath = "/next";
        fake.state.present = new Set(["password", "login"]);
        await start(twoPages());
        // The next step's field is the only target, so it is observed at index 0.
        await vi.waitFor(() =>
          expect(fake.state.messages).toContainEqual(
            expect.objectContaining({ type: "login.observe", targets: [target("password")] }),
          ),
        );
        await vi.waitFor(() => expect(published()).toContain('"stepIndex":2'), { timeout: 6_000 });
      }, 10_000);
    });
    it("refuses the only URI match when its account is connected more than once", async () => {
      // The automatic choice names the provider account as a saved default would, so it
      // stays ambiguous even though the other connection is not enabled.
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris, duplicateAccount: true });
      expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.store.update).not.toHaveBeenCalled();
    });
    describe("with a completion that also lists absent elements", () => {
      // A learned completion on the sign-in page's own path: the sign-out marker counts
      // only once the password field is gone (ADR 0018).
      const learned = parseLoginRecipe({
        ...recipe,
        completion: { ...recipe.completion, absent: [target("password")] },
      });
      const published = () => JSON.stringify(fake.state.messages);
      it("authenticates once the marker shows and the field is gone", async () => {
        fake.state.present = new Set(["authenticated"]);
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"state":"authenticated"'));
        // The completion target comes first, then the elements that must be missing.
        expect(fake.state.messages).toContainEqual(
          expect.objectContaining({
            type: "login.observe",
            targets: [target("authenticated"), target("password")],
          }),
        );
      });
      it("never authenticates while the field is still there", async () => {
        fake.state.present = new Set(["authenticated", "password", "login"]);
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        expect(published()).not.toContain('"state":"authenticated"');
        expect(h.store.update).not.toHaveBeenCalled();
      }, 10_000);
    });
    it("saves nothing while another login is still running", async () => {
      const second = "https://second.example";
      const h = harness(
        {
          siteDefaults: [{ origin: second, provider: "bitwarden", userId, itemId }],
          bindings: [],
        },
        { allowedOrigins: [second], uris: async () => ({ ok: true, data: uriMatch() }) },
      );
      h.recipes.recipe.mockImplementation(async (at: string) =>
        at === origin ? recipe : at === second ? { ...recipe, origin: second } : undefined,
      );
      fake.state.tabUrls[2] = `${second}/signin`;
      let held = false;
      fake.state.onExecute = async (_message, tabId) => {
        if (tabId !== 2) return;
        held = true;
        await new Promise(() => undefined);
      };
      expect(await h.hello({ tab: { id: 2 }, url: `${second}/signin` })).toEqual({ ok: true });
      await vi.waitFor(() => expect(held).toBe(true));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
      );
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("never saves an account other than the one the attempt used", async () => {
      const replaced = "60000000-0000-4000-8000-000000000002";
      const onlyOther = uriMatch({
        snapshotId: replaced,
        candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
      });
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris });
      fake.state.onExecute = async () => {
        fake.state.onExecute = undefined;
        // Only another item matches while the next document announces itself, then the
        // attempt's own item matches again and the login completes.
        h.snapshot.current = replaced;
        // Restore the attempt's item once that document's query has chosen the other one.
        uris.mockImplementationOnce(async () => {
          h.snapshot.current = snapshotId;
          return { ok: true, data: onlyOther };
        });
        await h.hello({ documentId: "synthetic-document-2" });
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
      );
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("saves nothing when the credential is rejected", async () => {
      const rejecting = { ...recipe, rejection: target("rejected") };
      fake.state.observed = ["missing", "unique"];
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
      });
      h.recipes.recipe.mockResolvedValue(rejecting);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(JSON.stringify(fake.state.messages)).toContain("credential-rejected"),
      );
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("keeps a saved default even when more items match, and saves only its binding", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: both }));
      const h = harness({ bindings: [] }, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      // The saved default, which has no item name, is kept as is, never rewritten.
      expect(h.settings.settings.siteDefaults).toEqual([
        { origin, provider: "bitwarden", userId, itemId },
      ]);
      expect(h.settings.settings.bindings).toEqual([
        { ...savedBinding, accountName: "Synthetic live vault" },
      ]);
    });
    it("names a new default after this device's connection but keeps a stored binding", async () => {
      // A binding made by AI generation has no account name.
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness({ siteDefaults: [] }, { allowedOrigins: [], uris });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      expect(h.settings.settings.siteDefaults).toEqual([
        {
          origin,
          provider: "bitwarden",
          userId,
          itemId,
          itemName: "Synthetic item",
          accountName: "Synthetic live vault",
        },
      ]);
      expect(h.settings.settings.bindings).toEqual([savedBinding]);
    });
    it("uses a provider-account default through this device's connection", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: both }));
      const h = harness(
        { siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }] },
        { allowedOrigins: [], uris },
      );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
      expect(h.fields.mock.calls[0]![0]).toMatchObject({
        account: { origin, connectionId, itemId },
      });
    });
    it("reports a locked vault, not a missing account, for a provider-account default", async () => {
      const h = harness(
        { siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }] },
        { allowedOrigins: [origin] },
      );
      h.snapshot.userId = undefined;
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("refuses a provider-account default whose account is not connected here", async () => {
      const h = harness(
        { siteDefaults: [{ origin, provider: "bitwarden", userId: "other-account", itemId }] },
        { allowedOrigins: [origin] },
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "connection-missing" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it.each<[string, Awaited<ReturnType<LiveUriMatcher>>, string]>([
      ["two items match", { ok: true, data: both }, "account-ambiguous"],
      ["no item matches", { ok: true, data: uriMatch({ candidates: [] }) }, "default-not-set"],
      [
        "another item's rules could not be evaluated",
        { ok: true, data: uriMatch({ unavailableItemIds: [otherItemId] }) },
        "item-uri-unevaluated",
      ],
      ["the vault is locked", vaultFailure("crypto-locked"), "vault-unavailable"],
    ])("refuses before any field read when %s", async (_name, answer, reason) => {
      const h = harness(unsaved, { allowedOrigins: [], uris: async () => answer });
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it("needs a manual binding when the recipe has a slot other than the built-ins", async () => {
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
      });
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: false, reason: "binding-not-found" });
      expect(h.fields).not.toHaveBeenCalled();
    });
    it("does not choose while the vault account is unknown", async () => {
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch() }),
      });
      h.snapshot.userId = undefined;
      expect(await h.hello()).toEqual({ ok: false, reason: "vault-unavailable" });
      expect(h.fields).not.toHaveBeenCalled();
    });
  });
  describe("with a saved account choice and a synced binding", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    it("fills a custom field through the synced binding's field name", async () => {
      const h = harness({ bindings: [branchBinding] });
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
      expect(h.fields.mock.calls.map((call) => call[0].fieldId)).toEqual([
        `custom.${snapshotId}.0`,
        "login.password",
      ]);
      expect(h.store.update).not.toHaveBeenCalled();
    });
    it.each<[string, "text" | "hidden" | "linked", Record<string, string>]>([
      ["text", "text", {}],
      ["Hidden", "hidden", { secret: "hidden" }],
      ["Linked to the password", "linked", { secret: "password" }],
    ])("marks a %s custom field's value for its input rule", async (_name, kind, secret) => {
      const h = harness(
        { bindings: [branchBinding] },
        {
          custom: [
            {
              name: "Branch",
              kind,
              ...(kind === "linked" ? { linkedFieldId: "login.password" } : {}),
            },
          ],
        },
      );
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).not.toEqual([]));
      expect(executes()[0]!.values).toEqual([
        { slot: "branch", value: "synthetic-secret", ...secret },
        { slot: "password", value: "synthetic-secret", secret: "password" },
      ]);
    });
    it.each<[string, Parameters<typeof harness>[1], boolean]>([
      ["a text custom field", { username: true, custom: [{ name: "Branch", kind: "text" }] }, true],
      [
        "a custom field Linked to the username",
        {
          username: true,
          custom: [{ name: "Branch", kind: "linked", linkedFieldId: "login.username" }],
        },
        false,
      ],
    ])(
      "compares the page on a password step with %s only when it fills no username",
      async (_name, live, compared) => {
        const h = harness({ bindings: [branchBinding] }, live);
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
        );
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).not.toEqual([]));
        expect(executes()[0]!.account).toEqual(
          compared ? { username: "my2@example.com" } : undefined,
        );
      },
    );
    it.each<[string, Parameters<typeof harness>[1], Partial<LocalSettings>, string]>([
      [
        "two custom fields share the bound name",
        {
          custom: [
            { name: "Branch", kind: "text" },
            { name: "Branch", kind: "text" },
          ],
        },
        {},
        "field-ambiguous",
      ],
      [
        "no custom field has the bound name",
        { custom: [{ name: "Region", kind: "text" }] },
        {},
        "field-missing",
      ],
      [
        "the bound custom field is excluded",
        {},
        {
          connections: [
            {
              connectionId,
              enabled: true,
              selection: { mode: "all", groupIds: [], itemIds: [] },
              excludedItemIds: [],
              excludedFields: [{ itemId, fieldId: `custom.${snapshotId}.0` }],
            },
          ],
        },
        "binding-field-excluded",
      ],
    ])(
      "refuses a synced binding before any field read when %s",
      async (_name, live, overrides, reason) => {
        const h = harness({ bindings: [branchBinding], ...overrides }, live);
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        expect(await h.hello()).toEqual({ ok: false, reason });
        expect(h.fields).not.toHaveBeenCalled();
        expect(executes()).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      },
    );
    it("ignores a binding saved for another vault account", async () => {
      const h = harness({
        bindings: [{ ...branchBinding, userId: "70000000-0000-4000-8000-000000000002" }],
      });
      h.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await h.hello()).toEqual({ ok: false, reason: "binding-not-found" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(h.store.update).not.toHaveBeenCalled();
    });
  });
  it.each([
    ["the same recipe revision resumes", 1, { ok: true }],
    ["a replaced recipe revision is refused", 2, { ok: false, reason: "recipe-not-found" }],
  ])("after navigation, %s", async (_name, revision, expected) => {
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    h.recipes.recipe.mockResolvedValue({ ...recipe, revision });
    expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual(expected);
    expect(h.recipes.recipe).toHaveBeenLastCalledWith(origin, "/signin", recipe.id);
  });
  describe("on a page without a recipe", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const generated = parseLoginRecipe({
      version: 1,
      id: "gen-synthetic",
      revision: 1,
      origin,
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
    const page = (path: string, candidates: unknown[]) => ({
      ok: true,
      observation: { version: 1, origin, path, language: "en", complete: true, candidates },
    });
    const loginPage = page("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    const homePage = page("/home", [
      { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
    ]);
    function generation(implementation: Partial<LoginGeneration> = {}) {
      return {
        available: vi.fn<LoginGeneration["available"]>(
          implementation.available ?? (async () => true),
        ),
        generate: vi.fn<LoginGeneration["generate"]>(
          implementation.generate ?? (async () => "none"),
        ),
        judge: vi.fn<LoginGeneration["judge"]>(implementation.judge ?? (async () => "unclear")),
      };
    }
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    const status = () => fake.state.storage["pateat.login-attempts.v1"];

    it("sends a matching sign-in page for generation and runs the returned recipe", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.firstSteps.mockResolvedValue([]);
      // The first announcement only offers generation; nothing reads the vault yet.
      expect(await h.hello({}, false)).toEqual({
        ok: false,
        reason: "recipe-not-found",
        starts: [],
        generate: true,
      });
      expect(h.store.handle).not.toHaveBeenCalled();
      service.generate.mockImplementation(async () => {
        h.recipes.recipe.mockResolvedValue(generated);
        h.recipes.firstSteps.mockResolvedValue([generated.steps[0]!]);
        return "recipe";
      });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
      );
      expect(service.available).toHaveBeenCalledWith(origin, "/signin");
      // Only slots the matching item can fill are offered.
      expect(service.generate).toHaveBeenCalledWith({
        version: 1,
        observation: loginPage.observation,
        slots: [
          expect.objectContaining({ id: "username", kind: "identifier" }),
          expect.objectContaining({ id: "password", kind: "secret" }),
        ],
      });
      expect(h.fields).not.toHaveBeenCalled();
      // The document announces again and starts the generated recipe at once.
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(
          2,
        ),
      );
      expect(fake.state.messages.find((entry) => entry.type === "login.execute")?.values).toEqual([
        { slot: "username", value: "synthetic-secret" },
        { slot: "password", value: "synthetic-secret", secret: "password" },
      ]);
    });

    it("sends nothing when no vault item matches the page", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch({ candidates: [] }) }),
        username: true,
        generation: service,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.firstSteps.mockResolvedValue([]);
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(service.generate).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });

    it("offers nothing for a page sent recently, an origin with a recipe, a frame or an incomplete description", async () => {
      const service = generation({ available: async () => false });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.firstSteps.mockResolvedValue([]);
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });

      service.available.mockResolvedValue(true);
      // A recipe for the origin that starts on another path, or an unreadable cache.
      fake.state.extracted = { login: loginPage };
      h.recipes.firstSteps.mockResolvedValue([{ ...generated.steps[0]!, path: "/elsewhere" }]);
      expect(await h.signIn()).not.toHaveProperty("generate");
      h.recipes.firstSteps.mockRejectedValue(new Error("cache"));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      h.recipes.firstSteps.mockResolvedValue([]);
      expect(service.generate).not.toHaveBeenCalled();

      fake.state.extracted = {
        login: { ...loginPage, observation: { ...loginPage.observation, complete: false } },
      };
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(service.generate).not.toHaveBeenCalled();

      fake.state.tabUrls = { 1: "https://top.example/" };
      expect(
        await h.login.handle(
          {
            version: 1,
            type: "login.document.ready",
            token: "frame-token",
            signIn: { path: "/" },
          },
          sender({
            frameId: 3,
            documentId: "frame-document",
            tab: { id: 1, url: "https://login.example/" },
          }),
        ),
      ).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(service.generate).not.toHaveBeenCalled();
    });

    it("learns the completion from the page after the final submission", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => "signed-in" });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      h.recipes.firstSteps.mockResolvedValue([generated.steps[0]!]);
      fake.state.present = new Set(["user", "password", "login"]);
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
        // The click signs in: the form goes and the next page shows a sign-out button.
        fake.state.present = new Set(["logout"]);
        fake.state.observedPath = "/home";
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(service.judge).toHaveBeenCalledWith(
        generated.id,
        generated.revision,
        homePage.observation,
      );
      // The automatic choice is saved with its built-in binding once signed in.
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalled());
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: generated.id,
          slots: [
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        }),
      ]);
    }, 10_000);

    it.each([
      ["rejected", { state: "blocked", outcome: "credential-rejected" }],
      ["challenge", { state: "blocked", outcome: "challenge" }],
      ["unclear", { state: "reconciling", outcome: "unknown-submit" }],
    ] as const)(
      "settles a %s judgement without saving the account",
      async (verdict, expected) => {
        fake.state.extracted = { "signed-in": homePage };
        const service = generation({ judge: async () => verdict });
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([expected]), { timeout: 6_000 });
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(h.store.update).not.toHaveBeenCalled();
      },
      10_000,
    );

    it("does not send the page while the recipe's fields are still shown", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => "signed-in" });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    }, 10_000);
  });
  it("does not answer probe controls outside the probe build", async () => {
    const h = harness();
    expect(
      await h.login.handle(
        { version: 1, type: "login.probe.configure", origin: "http://127.0.0.1:3847" },
        trusted,
      ),
    ).toBeUndefined();
    expect(
      await h.login.handle({ version: 1, type: "login.probe.status" }, trusted),
    ).toBeUndefined();
  });
});
