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
import { createLoginGeneration } from "../service/generation";
import { createRecipeSync } from "../service/recipes";
import type { ServiceTransport } from "../service/transport";
import type { LoginGeneration } from "./runtime";
import type { LoginFieldSource } from "./vault";

const fake = vi.hoisted(() => {
  const state = {
    storage: {} as Record<string, unknown>,
    messages: [] as {
      type: string;
      values?: { slot: string; value: string }[];
      account?: { username: string };
      accountSwitch?: unknown;
      outcome?: string;
    }[],
    /** Overrides the document's answer to an execution, such as a wrong-account refusal. */
    executeReply: undefined as
      | undefined
      | { ok: boolean; reason?: string; switchable?: true; mutation?: "none" | "possible" },
    /** The document's answer to clicking an account switch. */
    switchReply: { ok: true } as { ok: boolean },
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
    /** `chrome.storage.session`. */
    session: {} as Record<string, unknown>,
    /** Tab-specific toolbar badge text and title. */
    badges: {} as Record<number, { text?: string; title?: string }>,
    /** Each `login.reconnect` and the document it was sent to. */
    reconnects: [] as { tabId: number; frameId?: number; documentId?: string }[],
    /** The document's announce in answer to `login.reconnect`, as the content script does. */
    onReconnect: undefined as undefined | (() => Promise<unknown>),
  };
  const browser = {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
    permissions: { contains: async () => state.granted },
    action: {
      setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => {
        state.badges[tabId] = { ...state.badges[tabId], text };
      },
      setTitle: async ({ tabId, title }: { tabId: number; title: string }) => {
        state.badges[tabId] = { ...state.badges[tabId], title };
      },
    },
    storage: {
      session: {
        get: async (keys: string[]) =>
          Object.fromEntries(
            keys.filter((key) => key in state.session).map((key) => [key, state.session[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.session, structuredClone(values));
        },
      },
      local: {
        setAccessLevel: async () => undefined,
        get: async (keys: string[]) =>
          Object.fromEntries(
            keys.filter((key) => key in state.storage).map((key) => [key, state.storage[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.storage, structuredClone(values));
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) delete state.storage[key];
        },
      },
    },
    tabs: {
      query: async () => [],
      get: async (id: number) => ({ id, url: state.tabUrls[id] ?? state.pageUrl }),
      sendMessage: async (
        _tabId: number,
        message: Record<string, unknown>,
        options?: { frameId?: number; documentId?: string },
      ) => {
        if (options?.documentId && state.gone.has(options.documentId))
          throw new Error("Could not establish connection. Receiving end does not exist.");
        state.messages.push(structuredClone(message) as (typeof state.messages)[number]);
        if (message["type"] === "login.reconnect") {
          state.reconnects.push({ tabId: _tabId, ...options });
          return (await state.onReconnect?.()) ?? { ok: false };
        }
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
        if (message["type"] === "login.switch") return state.switchReply;
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
    /** Adds a login username field to the other item. */
    otherUsername?: boolean;
    /** Recipe generation for pages without a recipe. */
    generation?: LoginGeneration;
    /** The item's passkey facts, read when a login starts (ADR 0027). */
    passkeys?: (account: unknown) => Promise<{ passkey: boolean; discoverable: boolean }>;
    /** Automatic vault sync (ADR 0025). */
    vault?: Parameters<typeof createLoginRuntime>[1]["vault"];
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
                  ...(live.otherUsername
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
    ...(live.passkeys ? { passkeys: live.passkeys } : {}),
    ...(live.vault ? { vault: live.vault } : {}),
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
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
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
    fake.state.switchReply = { ok: true };
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
      expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
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
  it("clicks the recipe's account switch only after recording it, then starts afresh once", async () => {
    const accountSwitch = { by: "text", value: "Use another account" } as const;
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    const h = harness({}, { username: true });
    h.recipes.recipe.mockResolvedValue(parseLoginRecipe({ ...recipe, accountSwitch }));
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const attempts = () => fake.state.storage["pateat.login-attempts.v2"];
    const types = () => fake.state.messages.map((entry) => entry.type);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(types()).toContain("login.switch"));
    expect(attempts()).toMatchObject([
      { state: "blocked", outcome: "account-switched", submissions: 0 },
    ]);
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(executes()[0]!.accountSwitch).toEqual(accountSwitch);
    // The switch is stored and published before the page is asked to click it.
    expect(
      fake.state.messages.findIndex((entry) => entry.outcome === "account-switched"),
    ).toBeLessThan(types().indexOf("login.switch"));
    // The page it leads to starts a new attempt, which never switches again.
    expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(attempts()).toMatchObject([
        { state: "blocked", outcome: "wrong-account", accountSwitched: true },
      ]),
    );
    expect(executes()).toHaveLength(2);
    expect(executes()[1]!.accountSwitch).toBeUndefined();
    expect(types().filter((type) => type === "login.switch")).toHaveLength(1);
  });
  it("ends as wrong-account and keeps the tab when the page does not click the switch", async () => {
    fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
    fake.state.switchReply = { ok: false };
    const h = harness({}, { username: true });
    h.recipes.recipe.mockResolvedValue(
      parseLoginRecipe({ ...recipe, accountSwitch: { by: "text", value: "Use another account" } }),
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
    );
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
        { state: "blocked", outcome: "wrong-account", submissions: 0 },
      ]),
    );
    expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch");
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "wrong-account" });
    // The next document of the tab does not start another attempt.
    await h.hello({ documentId: "next-page" });
    expect(executes()).toHaveLength(1);
  });
  it("stops without a retry or a click when a value does not fit its input", async () => {
    fake.state.executeReply = { ok: false, reason: "value-mismatch" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
        { state: "blocked", outcome: "value-mismatch", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "value-mismatch" });
  });
  it("does not click when the page rejects the filled values", async () => {
    fake.state.executeReply = { ok: false, reason: "fill-rejected", mutation: "possible" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
        { state: "blocked", outcome: "fill-rejected", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
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
    // A document that already carries a running attempt cannot start another one.
    expect(await h.hello()).toEqual({ ok: false, reason: "duplicate-document" });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
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
      expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v2"]).toHaveLength(1);
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
        expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
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
      fake.state.storage["pateat.login-attempts.v2"] as { state: string; outcome?: string }[];
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
  describe("a tab that moves to another origin", () => {
    const second = "https://second.example";
    const secondUrl = `${second}/signin`;
    const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    type Stored = { id: string; state: string; outcome?: string; submissions: number } & {
      account: { origin: string };
      document: { tabId: number; documentId: string };
    };
    const stored = () => (fake.state.storage["pateat.login-attempts.v2"] ?? []) as Stored[];
    const at = (from: string) => stored().find((entry) => entry.account.origin === from);
    /** Both origins have their own recipe, binding and saved default for the same item. */
    const twoSites = () => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", userId, itemId },
            { origin: second, provider: "bitwarden", userId, itemId },
          ],
          bindings: [savedBinding, { ...savedBinding, recipeId: secondRecipe.id, origin: second }],
        },
        { allowedOrigins: [origin, second] },
      );
      h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
        path !== "/signin"
          ? undefined
          : from === origin
            ? recipe
            : from === second
              ? secondRecipe
              : undefined,
      );
      h.recipes.firstSteps.mockImplementation(async (from: string) =>
        from === origin ? [recipe.steps[0]!] : from === second ? [secondRecipe.steps[0]!] : [],
      );
      return h;
    };
    /** The tab's page is replaced by a new top-level document at `url`. */
    /** `start: false` is a page of the origin without the login form's first step. */
    const navigate = (
      h: ReturnType<typeof harness>,
      url: string,
      documentId: string,
      start = true,
    ) => {
      fake.state.tabUrls[1] = url;
      return h.hello({ documentId, url }, start);
    };
    /** Clicks on `from` never answer, as when the page leaves while submitting. */
    const holdClicks = (...from: string[]) => {
      fake.state.onExecute = (message) => {
        const operation = message["operation"] as {
          step: { kind: string };
          document: { origin: string };
        };
        return operation.step.kind === "click" && from.includes(operation.document.origin)
          ? new Promise(() => undefined)
          : Promise.resolve();
      };
    };
    it("starts the next origin's login after an authenticated attempt in the tab", async () => {
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(executes()).toHaveLength(4);
      expect(h.fields.mock.calls.map(([request]) => request.account.origin)).toEqual([
        origin,
        second,
      ]);
      // The first origin's record is kept as it was.
      expect(at(origin)).toMatchObject({ state: "authenticated", document: { tabId: 1 } });
      expect(await h.login.active()).toBe(false);
    });
    it("ends a submitted attempt as left-origin and lets the next origin log in", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent", submissions: 1 });
      expect(await h.login.active()).toBe(true);
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
        document: { tabId: 1, documentId: "synthetic-document" },
      });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(stored()).toHaveLength(2);
      // Nothing is left running, so a deferred policy write may proceed.
      expect(await h.login.active()).toBe(false);
      expect(executes().map((entry) => (entry as { operation?: unknown }).operation)).toEqual([
        expect.objectContaining({ document: expect.objectContaining({ origin }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin: second }) }),
        expect.objectContaining({ document: expect.objectContaining({ origin: second }) }),
      ]);
    });
    it("ends a submitted attempt when the next origin has no recipe", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, "https://elsewhere.example/home", "elsewhere-document")).toEqual({
        ok: false,
        reason: "recipe-not-found",
      });
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(stored()).toHaveLength(1);
      expect(await h.login.active()).toBe(false);
      expect(executes()).toHaveLength(2);
    });
    it("asks instead of submitting when the site's form shows again after it left", async () => {
      // site -> identity provider -> back to the site's login form (ADR 0021 D, ADR 0022).
      holdClicks(origin, second);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      expect(await navigate(h, fake.state.pageUrl, "returned-document")).toEqual({
        ok: false,
        reason: "logged-out",
      });
      // Only the site's record was released; the identity provider's stays until its form shows.
      expect(at(origin)).toBeUndefined();
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(await navigate(h, secondUrl, "second-again")).toEqual({
        ok: false,
        reason: "logged-out",
      });
      expect(executes()).toHaveLength(4);
      expect(h.fields).toHaveBeenCalledTimes(2);
    });
    it("never submits again when the tab returns to an origin it left", async () => {
      holdClicks(origin, second);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      expect(at(second)).toMatchObject({ state: "submit-intent", submissions: 1 });
      // Back on a page of the first origin, which keeps its own ended record and only
      // watches for the login form (ADR 0021 D).
      expect(await navigate(h, fake.state.pageUrl, "returned-document", false)).toMatchObject({
        ok: false,
        reason: "logged-in",
      });
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
      });
      // And once more to the second origin, which also stays ended.
      expect(await navigate(h, secondUrl, "second-again", false)).toMatchObject({
        reason: "logged-in",
      });
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(stored()).toHaveLength(2);
      expect(executes()).toHaveLength(4);
      expect(h.fields).toHaveBeenCalledTimes(2);
    });
    it("keeps another tab off an origin the tab left until the tab closes", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      fake.state.onExecute = undefined;
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      for (const listener of fake.state.removed) listener(1);
      await vi.waitFor(() => expect(stored()).toEqual([]));
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab-again" })).toEqual({
        ok: true,
      });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([{ state: "authenticated", document: { tabId: 2 } }]),
      );
    });
    it("keeps each origin's record of a tab across a restart", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      const before = stored();
      expect(before.map((entry) => [entry.document.tabId, entry.account.origin])).toEqual([
        [1, origin],
        [1, second],
      ]);
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        expect(await restarted.login.active()).toBe(false);
        expect(stored()).toEqual(before);
        // Each origin's document resumes its own ended record; nothing runs again.
        const sent = executes().length;
        expect(await navigate(restarted, fake.state.pageUrl, "after-restart", false)).toMatchObject(
          { reason: "logged-in" },
        );
        expect(at(origin)).toMatchObject({ id: before[0]!.id, outcome: "left-origin" });
        expect(await navigate(restarted, secondUrl, "second-after-restart", false)).toMatchObject({
          reason: "logged-in",
        });
        expect(at(second)).toMatchObject({ id: before[1]!.id, state: "authenticated" });
        expect(executes()).toHaveLength(sent);
        // The origin the tab left still holds against another tab.
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "origin-busy",
        });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends a running attempt left behind by a restart when the tab moves to another origin", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent", submissions: 1 });
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        // The restart only observes the attempt it found; it is still running.
        expect(await restarted.login.active()).toBe(true);
        expect(at(origin)).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
        expect(await navigate(restarted, secondUrl, "second-document")).toEqual({ ok: true });
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "left-origin",
          submissions: 1,
        });
        await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
        expect(stored()).toHaveLength(2);
        expect(await restarted.login.active()).toBe(false);
        expect(executes()).toHaveLength(4);
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("treats two stored records of one tab and origin as unavailable storage", async () => {
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      const [record] = stored();
      fake.state.storage["pateat.login-attempts.v2"] = [
        record,
        { ...record, id: crypto.randomUUID(), document: { ...record!.document, documentId: "x" } },
      ];
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = twoSites();
        fake.state.tabUrls[1] = secondUrl;
        expect(await restarted.hello({ documentId: "after-restart", url: secondUrl })).toEqual({
          ok: false,
          reason: "storage-unavailable",
        });
        expect(executes()).toHaveLength(2);
      } finally {
        fake.browser.tabs.query = query;
      }
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
    describe("when no item matches, after a vault check (ADR 0025)", () => {
      const none: Awaited<ReturnType<LiveUriMatcher>> = {
        ok: true,
        data: uriMatch({ candidates: [] }),
      };
      /** A vault sync whose miss checks each wait until the test answers them. */
      function vault() {
        let held = 0;
        const answers: ((synced: boolean) => void)[] = [];
        const insideHold: boolean[] = [];
        const value = {
          refreshIfStale: vi.fn(),
          enter: vi.fn(async () => {
            held += 1;
            let left = false;
            return () => {
              if (left) return;
              left = true;
              held -= 1;
            };
          }),
          checkAfterMiss: vi.fn(() => {
            insideHold.push(held > 0);
            return new Promise<boolean>((resolve) => {
              answers.push(resolve);
            });
          }),
        };
        return { value, answers, insideHold };
      }
      const flush = async () => {
        for (let index = 0; index < 5; index += 1)
          // oxlint-disable-next-line no-await-in-loop -- lets each pending step run
          await new Promise((resolve) => setTimeout(resolve, 0));
      };
      it("asks for a check within the page's hold and reconnects only the refused document", async () => {
        const sync = vault();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "default-not-set" });
        expect(sync.value.checkAfterMiss).toHaveBeenCalledTimes(1);
        expect(sync.insideHold).toEqual([true]);
        await flush();
        expect(fake.state.reconnects).toEqual([]);
        sync.answers[0]!(true);
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual([
            { tabId: 1, frameId: 0, documentId: "synthetic-document" },
          ]),
        );
        await flush();
        expect(fake.state.reconnects).toHaveLength(1);
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("reconnects a refused frame by its own frame and document", async () => {
        const sync = vault();
        // The tab shows the page around the frame; the frame's own URL is the login page.
        fake.state.tabUrls[1] = "https://login.example/home";
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(
          await h.hello({
            frameId: 3,
            documentId: "synthetic-frame-document",
            tab: { id: 1, url: "https://login.example/home" },
          }),
        ).toEqual({ ok: false, reason: "default-not-set" });
        sync.answers[0]!(true);
        await vi.waitFor(() =>
          expect(fake.state.reconnects).toEqual([
            { tabId: 1, frameId: 3, documentId: "synthetic-frame-document" },
          ]),
        );
      });
      it("reconnects nothing when no check applied a new snapshot in time", async () => {
        const sync = vault();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "default-not-set" });
        sync.answers[0]!(false);
        await flush();
        expect(fake.state.reconnects).toEqual([]);
      });
      it.each<[string, (h: ReturnType<typeof harness>) => Promise<unknown>]>([
        ["announced again", (h) => h.hello()],
        ["was replaced by another document", (h) => h.hello({ documentId: "synthetic-next" })],
        [
          "went away with its tab",
          async () => {
            for (const listener of fake.state.removed) listener(1);
          },
        ],
      ])("reconnects nothing once the refused document %s", async (_name, change) => {
        const sync = vault();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => none,
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "default-not-set" });
        await change(h);
        sync.answers[0]!(true);
        await flush();
        expect(fake.state.reconnects).toEqual([]);
      });
      it("asks for a check when the saved default's item no longer matches the page", async () => {
        const sync = vault();
        const h = harness({}, { allowedOrigins: [], uris: async () => none, vault: sync.value });
        expect(await h.hello()).toEqual({ ok: false, reason: "item-origin-mismatch" });
        expect(sync.value.checkAfterMiss).toHaveBeenCalledTimes(1);
        sync.answers[0]!(true);
        await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      });
      it("asks for no check when a one-time pick's item no longer matches the page", async () => {
        const sync = vault();
        let calls = 0;
        const h = harness(unsaved, {
          allowedOrigins: [],
          // Both items match when the choice is offered; the picked one no longer does.
          uris: async () => (calls++ === 0 ? { ok: true, data: both } : none),
          vault: sync.value,
        });
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        let again: unknown;
        fake.state.onReconnect = async () => {
          again = await h.hello();
          return again;
        };
        await h.login.handle(
          {
            version: 1,
            type: "login.choice.pick",
            tabId: 1,
            documentId: "synthetic-document",
            connectionId,
            itemId: otherItemId,
            makeDefault: false,
          },
          {
            id: "synthetic-extension",
            url: "chrome-extension://synthetic-extension/popup.html",
          } as never,
        );
        await vi.waitFor(() =>
          expect(again).toEqual({ ok: false, reason: "item-origin-mismatch" }),
        );
        expect(sync.value.checkAfterMiss).not.toHaveBeenCalled();
      });
      it.each<[string, Partial<LocalSettings>, Parameters<typeof harness>[1], string]>([
        [
          "two items match",
          unsaved,
          { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          "account-ambiguous",
        ],
        [
          "another item's rules could not be evaluated",
          unsaved,
          {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: uriMatch({ unavailableItemIds: [otherItemId] }) }),
          },
          "item-uri-unevaluated",
        ],
        [
          "the vault is locked",
          unsaved,
          { allowedOrigins: [], uris: async () => vaultFailure("crypto-locked") },
          "vault-unavailable",
        ],
        ["no live URI matching is available", unsaved, { allowedOrigins: [] }, "default-not-set"],
        [
          "the saved default's account is not connected here",
          { siteDefaults: [{ origin, provider: "bitwarden", userId: "other-account", itemId }] },
          { allowedOrigins: [origin] },
          "connection-missing",
        ],
      ])("asks for no check when %s", async (_name, overrides, live, reason) => {
        const sync = vault();
        const h = harness(overrides, { ...live, vault: sync.value });
        expect(await h.hello()).toEqual({ ok: false, reason });
        expect(sync.value.checkAfterMiss).not.toHaveBeenCalled();
      });
    });
    describe("when the popup picks one of several matches (ADR 0021)", () => {
      const popup = {
        id: "synthetic-extension",
        url: "chrome-extension://synthetic-extension/popup.html",
      } as never;
      const ask = (h: ReturnType<typeof harness>, from: never = popup) =>
        h.login.handle({ version: 1, type: "login.choice.get", tabId: 1 }, from);
      const pick = (
        h: ReturnType<typeof harness>,
        overrides: Record<string, unknown> = {},
        from: never = popup,
      ) =>
        h.login.handle(
          {
            version: 1,
            type: "login.choice.pick",
            tabId: 1,
            documentId: "synthetic-document",
            connectionId,
            itemId: otherItemId,
            makeDefault: false,
            ...overrides,
          },
          from,
        );
      const matching = () =>
        harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
        });
      const refused = async () => {
        const h = matching();
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        // The document announces again when asked, with its first step still showing.
        fake.state.onReconnect = () => h.hello();
        return h;
      };
      const offered = {
        ok: true,
        origin,
        documentId: "synthetic-document",
        candidates: [
          { connectionId, itemId },
          { connectionId, itemId: otherItemId },
        ],
      };
      it("badges the tab and offers only the refused document's candidates", async () => {
        const h = await refused();
        expect(fake.state.badges[1]).toEqual({
          text: "2",
          title: "Pateat: 2 accounts match this page. Click to choose one.",
        });
        expect(await ask(h)).toEqual(offered);
        // Only the popup page may ask or pick; the settings page and the site cannot.
        expect(await ask(h, trusted)).toBeUndefined();
        expect(await ask(h, sender())).toBeUndefined();
        expect(await pick(h, {}, trusted)).toBeUndefined();
        expect(await pick(h, {}, sender())).toBeUndefined();
        expect(fake.state.reconnects).toEqual([]);
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("restarts only the refused document with a one-time pick and saves nothing", async () => {
        const h = await refused();
        expect(await pick(h)).toEqual({ ok: true });
        expect(fake.state.reconnects).toEqual([
          { tabId: 1, frameId: 0, documentId: "synthetic-document" },
        ]);
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        expect(await ask(h)).toEqual({ ok: false, reason: "no-choice" });
        await vi.waitFor(() =>
          expect(JSON.stringify(fake.state.messages)).toContain("authenticated"),
        );
        expect(h.fields.mock.calls[0]![0]).toMatchObject({
          account: { origin, connectionId, itemId: otherItemId },
          fieldId: "login.password",
        });
        expect(h.store.update).not.toHaveBeenCalled();
      });
      it("saves a pick marked as the default only after authenticated", async () => {
        const h = await refused();
        fake.state.onReconnect = async () => {
          const started = await h.hello();
          expect(h.store.update).not.toHaveBeenCalled();
          return started;
        };
        expect(await pick(h, { makeDefault: true })).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
        expect(h.settings.settings.siteDefaults).toEqual([
          expect.objectContaining({ origin, userId, itemId: otherItemId }),
        ]);
      });
      it("refuses a pick that is not offered, for another document, or after the page left", async () => {
        const h = await refused();
        expect(await pick(h, { itemId: "80000000-0000-4000-8000-000000000009" })).toEqual({
          ok: false,
          reason: "not-a-candidate",
        });
        expect(await pick(h, { documentId: "other-document" })).toEqual({
          ok: false,
          reason: "no-choice",
        });
        fake.state.gone.add("synthetic-document");
        expect(await pick(h)).toEqual({ ok: false, reason: "document-gone" });
        // Nothing stays picked: the next announcement is refused again.
        fake.state.gone.clear();
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("drops a pick that started nothing, and the form's next appearance asks again", async () => {
        const h = await refused();
        // The form moved past its first step, so the document announces without a start.
        fake.state.onReconnect = () => h.hello({}, false);
        expect(await pick(h)).toEqual({ ok: false, reason: "not-started" });
        expect(fake.state.session["pateat.login-picks.v1"]).toEqual([]);
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(fake.state.badges[1]?.text).toBe("2");
        expect(h.fields).not.toHaveBeenCalled();
      });
      it("offers the choice again after a worker restart, or clears it once the page is gone", async () => {
        await refused();
        // A new worker starts with only session storage; its badge survived.
        const restarted = matching();
        fake.state.onReconnect = () => restarted.hello();
        expect(await ask(restarted)).toEqual(offered);
        expect(fake.state.reconnects.at(-1)).toEqual({
          tabId: 1,
          frameId: 0,
          documentId: "synthetic-document",
        });

        const again = matching();
        fake.state.gone.add("synthetic-document");
        expect(await ask(again)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        await vi.waitFor(() => expect(fake.state.session["pateat.login-choices.v1"]).toEqual([]));
      });
      it("ends the choice once a default is saved for the site", async () => {
        const h = await refused();
        h.settings.settings.siteDefaults = [{ origin, provider: "bitwarden", userId, itemId }];
        expect(await ask(h)).toEqual({ ok: false, reason: "no-choice" });
        expect(await pick(h)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        expect(fake.state.reconnects).toEqual([]);
      });
      it("keeps the pick with the attempt it started and forgets it when the tab closes", async () => {
        const h = await refused();
        expect(await pick(h)).toEqual({ ok: true });
        expect(fake.state.session).toEqual({
          "pateat.login-picks.v1": [
            {
              tabId: 1,
              origin,
              documentId: "synthetic-document",
              attemptId: expect.any(String),
              connectionId,
              itemId: otherItemId,
              makeDefault: false,
            },
          ],
          "pateat.login-choices.v1": [],
          "pateat.login-logouts.v1": [],
        });
        for (const listener of fake.state.removed) listener(1);
        await vi.waitFor(() =>
          expect(fake.state.session).toEqual({
            "pateat.login-picks.v1": [],
            "pateat.login-choices.v1": [],
            "pateat.login-logouts.v1": [],
          }),
        );
      });
      it("offers a choice in a tab that holds only another origin's record", async () => {
        const second = "https://second.example";
        const h = harness(
          {
            siteDefaults: [{ origin: second, provider: "bitwarden", userId, itemId }],
            bindings: [{ ...savedBinding, recipeId: "second-signin", origin: second }],
          },
          {
            allowedOrigins: [],
            uris: async (_connection, url) => ({
              ok: true,
              data: { ...both, targetOrigin: new URL(url).origin },
            }),
          },
        );
        const secondRecipe = parseLoginRecipe({ ...recipe, id: "second-signin", origin: second });
        h.recipes.recipe.mockImplementation(async (from: string, path: string) =>
          path !== "/signin" ? undefined : from === origin ? recipe : secondRecipe,
        );
        h.recipes.firstSteps.mockImplementation(async () => [recipe.steps[0]!]);
        fake.state.tabUrls[1] = `${second}/signin`;
        expect(await h.hello({ url: `${second}/signin` })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v2"]).toMatchObject([
            { state: "authenticated", account: { origin: second } },
          ]),
        );
        fake.state.tabUrls[1] = fake.state.pageUrl;
        expect(await h.hello({ documentId: "first-site" })).toEqual({
          ok: false,
          reason: "account-ambiguous",
        });
        expect(await ask(h)).toMatchObject({ ok: true, origin, documentId: "first-site" });
      });
      it("keeps a pick with its login past an account switch", async () => {
        fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: both }),
          username: true,
        });
        h.recipes.recipe.mockResolvedValue(
          parseLoginRecipe({
            ...recipe,
            accountSwitch: { by: "text", value: "Use another account" },
          }),
        );
        h.fields.mockImplementation(async ({ fieldId }) =>
          fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
        );
        const stored = () =>
          fake.state.storage["pateat.login-attempts.v2"] as { id: string; state: string }[];
        const picks = () => fake.state.session["pateat.login-picks.v1"] as { attemptId?: string }[];
        expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
        fake.state.onReconnect = () => h.hello();
        expect(await pick(h)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch"),
        );
        const [switched] = stored();
        // The page the switch leads to logs in with the picked account, and the pick
        // follows that login to its later pages.
        expect(await h.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(() => expect(stored()[0]!.id).not.toBe(switched!.id));
        await vi.waitFor(() => expect(picks()[0]!.attemptId).toBe(stored()[0]!.id));
        expect(h.fields.mock.calls.at(-1)![0]).toMatchObject({
          account: { itemId: otherItemId },
        });
        expect(fake.state.badges[1]?.text).toBe("");
      });
      describe("after a logout in the same tab (ADR 0021 D)", () => {
        const logouts = () => fake.state.session["pateat.login-logouts.v1"];
        const attempts = () =>
          fake.state.storage["pateat.login-attempts.v2"] as {
            state: string;
            account: { itemId: string };
          }[];
        /** Logs in with the saved default, then the login form shows again in the tab. */
        const loggedOut = async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // A page of the site without the form only watches for it.
          expect(await h.hello({ documentId: "home" }, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
          expect(attempts()).toHaveLength(1);
          expect(await h.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "logged-out",
          });
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          return h;
        };
        it("asks with the saved default first and releases only this tab's record", async () => {
          const h = await loggedOut();
          expect(attempts()).toEqual([]);
          expect(fake.state.badges[1]).toEqual({
            text: "2",
            title: "Pateat: you logged out of this site in this tab. Click to choose an account.",
          });
          expect(await ask(h)).toEqual({
            ok: true,
            origin,
            documentId: "signed-out",
            candidates: [
              { connectionId, itemId },
              { connectionId, itemId: otherItemId },
            ],
            logout: true,
          });
          expect(logouts()).toEqual([{ tabId: 1, origin }]);
          // A one-time pick logs in and leaves the saved default as it was.
          expect(await pick(h, { documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          expect(h.settings.settings.siteDefaults).toEqual([
            { origin, provider: "bitwarden", userId, itemId },
          ]);
          expect(logouts()).toEqual([]);
        });
        it("replaces the saved default with a pick marked as the default", async () => {
          const h = await loggedOut();
          expect(await pick(h, { documentId: "signed-out", makeDefault: true })).toEqual({
            ok: true,
          });
          await vi.waitFor(() =>
            expect(h.settings.settings.siteDefaults).toEqual([
              expect.objectContaining({ origin, userId, itemId: otherItemId }),
            ]),
          );
        });
        it("watches in the document that logged in and asks when its form shows again", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The document announces again after its login ended, as the content script does.
          expect(await h.hello({}, false)).toEqual({
            ok: false,
            reason: "logged-in",
            starts: [signinStart],
          });
          expect(await h.hello()).toEqual({ ok: false, reason: "logged-out" });
          expect(fake.state.badges[1]?.text).toBe("2");
        });
        it("keeps asking after a reload or a worker restart until a pick logs in", async () => {
          await loggedOut();
          const restarted = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await restarted.hello({ documentId: "reloaded" })).toEqual({
            ok: false,
            reason: "logged-out",
          });
          expect(restarted.fields).not.toHaveBeenCalled();
        });
        it("keeps other tabs off the site while it asks, and is kept off by their logins", async () => {
          const h = await loggedOut();
          // Cookies are shared: another tab must not log in again behind the user's logout.
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
            ok: false,
            reason: "origin-busy",
          });
          expect(h.fields).toHaveBeenCalledTimes(1);
          // Once this tab closes, the other tab logs in, and it then holds the site.
          for (const listener of fake.state.removed) listener(1);
          await vi.waitFor(() => expect(logouts()).toEqual([]));
          fake.state.onReconnect = undefined;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab-2" })).toEqual({
            ok: true,
          });
        });
      });
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
    // The submit never answers, so the attempt is still running when the page changes.
    fake.state.onExecute = (message) =>
      (message["operation"] as { step: { kind: string } }).step.kind === "click"
        ? new Promise(() => undefined)
        : Promise.resolve();
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(2),
    );
    // A replacement changes the route's steps, so it never extends the running revision.
    h.recipes.recipe.mockResolvedValue(
      revision === recipe.revision ? recipe : { ...recipe, revision, maxSubmissions: 2 },
    );
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
        judge: vi.fn<LoginGeneration["judge"]>(
          implementation.judge ?? (async () => ({ verdict: "unclear" })),
        ),
      };
    }
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    const status = () => fake.state.storage["pateat.login-attempts.v2"];

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
      // The username's shape goes with its slot; the value itself never does.
      expect(service.generate).toHaveBeenCalledWith({
        version: 1,
        observation: loginPage.observation,
        slots: [
          expect.objectContaining({
            id: "username",
            kind: "identifier",
            valueShape: { length: 16, classes: ["ascii-letter", "ascii-symbol"], email: false },
          }),
          expect.not.objectContaining({ valueShape: expect.anything() }),
        ],
      });
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.username"]);
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

    it("sends the username's shape only when every matching item agrees", async () => {
      fake.state.extracted = { login: loginPage };
      const both = async () => ({
        ok: true as const,
        data: uriMatch({
          candidates: [itemId, otherItemId].map((id) => ({
            itemId: id,
            matches: [{ uriIndex: 0, match: 0 }],
          })),
        }),
      });
      const read: string[] = [];
      const sentShape = async (
        usernames: Record<string, string | Error | undefined>,
        options: { overrides?: Partial<LocalSettings>; uris?: LiveUriMatcher } = {},
      ) => {
        const service = generation();
        const h = harness(
          { ...unsaved, ...options.overrides },
          {
            allowedOrigins: [],
            uris: options.uris ?? both,
            username: true,
            otherUsername: true,
            generation: service,
          },
        );
        read.length = 0;
        h.fields.mockImplementation(async ({ account }) => {
          read.push(account.itemId);
          const value = usernames[account.itemId];
          if (value instanceof Error) throw value;
          return value;
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.firstSteps.mockResolvedValue([]);
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        return service.generate.mock.calls[0]![0].slots.find((slot) => slot.id === "username")!
          .valueShape;
      };
      const digits = (length: number) => ({ length, classes: ["ascii-digit"], email: false });
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "00005678" })).toEqual(
        digits(8),
      );
      // Different lengths, an unreadable username or an unchecked item send no shape.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "0000123456" })).toBe(
        undefined,
      );
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: undefined })).toBe(undefined);
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: new Error("locked") })).toBe(
        undefined,
      );
      // Same length but other characters, or an email, is a different shape.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "abcd1234" })).toBe(undefined);
      expect(await sentShape({ [itemId]: "a@b.test", [otherItemId]: "ab.cdefg" })).toBe(undefined);
      // A username too long to shape cannot be compared, so nothing is sent.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "1".repeat(1025) })).toBe(
        undefined,
      );
      expect(
        await sentShape(
          { [itemId]: "00001234", [otherItemId]: "00005678" },
          {
            uris: async () => ({
              ok: true as const,
              data: uriMatch({ unavailableItemIds: [otherItemId] }),
            }),
          },
        ),
      ).toBe(undefined);
      // An empty or excluded username does not count, and an excluded one is never read.
      expect(await sentShape({ [itemId]: "00001234", [otherItemId]: "" })).toEqual(digits(8));
      const excluded = {
        connections: [
          {
            connectionId,
            enabled: true,
            selection: { mode: "all" as const, groupIds: [], itemIds: [] },
            excludedItemIds: [],
            excludedFields: [{ itemId: otherItemId, fieldId: "login.username" }],
          },
        ],
      };
      expect(
        await sentShape(
          { [itemId]: "00001234", [otherItemId]: "0000123456" },
          { overrides: excluded },
        ),
      ).toEqual(digits(8));
      expect(read).toEqual([itemId]);
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

    it("offers nothing for a page sent recently, a path a recipe starts on, a frame or an incomplete description", async () => {
      const service = generation({ available: async () => false });
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.firstSteps.mockResolvedValue([]);
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });

      service.available.mockResolvedValue(true);
      // Recipes that start on this path (two, so neither is selected), or an unreadable cache.
      fake.state.extracted = { login: loginPage };
      h.recipes.firstSteps.mockResolvedValue([generated.steps[0]!, generated.steps[0]!]);
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

    it("offers the page an account switch leads to when no recipe starts on its path", async () => {
      const service = generation();
      const h = harness({}, { uris, username: true, generation: service });
      const switching = parseLoginRecipe({
        ...recipe,
        accountSwitch: { by: "text", value: "Use another account" },
      });
      h.recipes.recipe.mockImplementation(async (_origin, path) =>
        path === "/signin" ? switching : undefined,
      );
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
      );
      fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.switch"),
      );
      // The switch leads to an email page; the origin's only recipe starts on `/signin`.
      fake.state.pageUrl = "https://login.example/signin/id";
      expect(await h.hello({ documentId: "next-page" }, false)).toEqual({
        ok: false,
        reason: "recipe-not-found",
        starts: [expect.objectContaining({ path: "/signin" })],
        generate: true,
      });
      expect(service.available).toHaveBeenCalledWith(origin, "/signin/id");
    });

    it("offers no page of a tab whose attempt ended without a switch", async () => {
      const service = generation();
      const h = harness({}, { uris, username: true, generation: service });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? "my2@example.com" : "synthetic-secret",
      );
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "wrong-account" }]),
      );
      fake.state.pageUrl = "https://login.example/signin/id";
      expect(await h.hello({ documentId: "next-page" }, false)).not.toHaveProperty("generate");
      // Another tab on the same page, without an attempt, is offered.
      expect(await h.hello({ documentId: "other-tab", tab: { id: 2 } }, false)).toMatchObject({
        generate: true,
      });
      expect(service.generate).not.toHaveBeenCalled();
    });

    it("learns the completion from the page after the final submission", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
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
        "password",
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
        const service = generation({ judge: async () => ({ verdict }) });
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
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
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

describe("second-factor page handlers chosen per account (ADR 0027)", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["password", "login"]);
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });

  const securityKey = { by: "text" as const, value: "Use security key" };
  const keyHandler = { kind: "passkey" as const, path: "/login/webauthn", target: securityKey };
  const { completion: _unlearned, ...unlearned } = recipe;
  const plain = parseLoginRecipe(unlearned);
  const home = { path: "/home", target: target("logout") };
  /** npm's shape: a handler for its security-key page and a learned completion. */
  const handled = parseLoginRecipe({ ...unlearned, completion: home, handlers: [keyHandler] });
  const taken = parseLoginRecipe({ ...unlearned, revision: 2, handlers: [keyHandler] });
  const withPasskey = vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const webauthnPage = observation("/login/webauthn", [
    { id: "c1", role: "button", target: securityKey, label: "Use security key" },
  ]);
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v2"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map(
        (entry) =>
          (
            entry as unknown as {
              operation: { step: { kind: string; target?: { value: string } } };
            }
          ).operation.step,
      );
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target?.value === value).length;
  /** What each click leads to: the next path, its elements and its description. */
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown } | "hang">,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click" || !step.target) return;
      const next = pages[step.target.value];
      if (next === "hang") return new Promise<void>(() => undefined);
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };
  const toWebauthn = {
    path: "/login/webauthn",
    present: ["Use security key"],
    extracted: webauthnPage,
  };
  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  function generation(judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => false),
      generate: vi.fn<LoginGeneration["generate"]>(async () => "none"),
      judge: vi.fn<LoginGeneration["judge"]>(judge),
    };
  }
  /** Replaces the item's catalog fields, as a vault sync would. */
  const editFields = (
    h: ReturnType<typeof harness>,
    edit: (fields: Record<string, unknown>[]) => Record<string, unknown>[],
  ) => {
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = edit(item.fields as never) as never;
      }
      return response;
    });
  };
  /** Advances fake time until the check holds. */
  async function until(check: () => boolean, maxMs = 200_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);

  describe("the item's facts", () => {
    it.each([
      [
        "a password, a TOTP secret and a discoverable passkey",
        { passkey: true, discoverable: true },
        { empty: false },
        { password: true, totp: true, passkey: true, discoverablePasskey: true },
      ],
      [
        "a second-factor passkey and an empty TOTP field",
        { passkey: true, discoverable: false },
        { empty: true },
        { password: true, totp: false, passkey: true, discoverablePasskey: false },
      ],
      [
        "a failed passkey lookup and no TOTP field",
        "fails",
        undefined,
        { password: true, totp: false, passkey: false, discoverablePasskey: false },
      ],
    ] as const)("records %s when the login starts", async (_label, held, totp, facts) => {
      const passkeys = vi.fn(async () => {
        if (held === "fails") throw new Error("native host unavailable");
        return held;
      });
      const h = harness({}, { passkeys });
      if (totp)
        editFields(h, (fields) => [
          ...fields,
          {
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
            ...(totp.empty ? { empty: true } : {}),
          },
        ]);
      fake.state.present = undefined;
      expect(await h.hello()).toEqual({ ok: true });
      expect(passkeys).toHaveBeenCalledWith({ origin, connectionId, itemId });
      await vi.waitFor(() => expect(status()).toHaveLength(1));
      expect(status()![0]).toMatchObject({ route: "password", facts, handlers: [] });
      // A sync while the login runs never changes the recorded facts.
      expect(passkeys).toHaveBeenCalledTimes(1);
    });

    it("refuses a login whose bound password is empty as no-route", async () => {
      const h = harness({}, { passkeys: withPasskey });
      editFields(h, (fields) =>
        fields.map((field) =>
          field["id"] === "login.password" ? { ...field, empty: true } : field,
        ),
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(executed()).toEqual([]);
      expect(status() ?? []).toEqual([]);
    });

    it("refuses a login whose Linked password field reads an empty password as no-route", async () => {
      const linked = {
        passkeys: withPasskey,
        custom: [{ name: "Secret", kind: "linked" as const, linkedFieldId: "login.password" }],
      };
      const bindings = [
        { ...savedBinding, slots: [{ slot: "password", field: { custom: "Secret" } }] },
      ];
      const h = harness({ bindings }, linked);
      editFields(h, (fields) =>
        fields.map((field) =>
          field["id"] === "login.password" ? { ...field, empty: true } : field,
        ),
      );
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(h.fields).not.toHaveBeenCalled();
      // The same binding starts while the password holds a value.
      fake.state.present = undefined;
      expect(await harness({ bindings }, linked).hello({ documentId: "again" })).toEqual({
        ok: true,
      });
    });
  });

  describe("on the page after an effect step", () => {
    it("clicks the security-key button once and signs in through the completion", async () => {
      onClick({ login: toWebauthn, "Use security key": toHome });
      const h = harness({}, { passkeys: withPasskey });
      h.recipes.recipe.mockResolvedValue(handled);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "click"]);
      expect(clicks("Use security key")).toBe(1);
      // The handler joined the attempt after the route's final click, with its own budget.
      expect(status()![0]).toMatchObject({
        handlers: [{ index: 0, start: 2 }],
        stepIndex: 2,
        stepCount: 3,
        submissions: 2,
        maxSubmissions: 2,
      });
      // The handler's element is observed apart from the recipe's own result targets.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({ type: "login.observe", targets: [securityKey] }),
      );
    }, 10_000);

    it.each([
      ["holds no passkey", vi.fn(async () => ({ passkey: false, discoverable: false }))],
      ["cannot be asked about passkeys", undefined],
    ])("ends as a challenge without a click when the item %s", async (_label, passkeys) => {
      onClick({ login: toWebauthn, "Use security key": toHome });
      const h = harness({}, passkeys ? { passkeys } : {});
      h.recipes.recipe.mockResolvedValue(handled);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(clicks("Use security key")).toBe(0);
      expect(status()![0]).toMatchObject({ handlers: [] });
    });

    it("leaves a handler page shown again after its handler ran to the person", async () => {
      vi.useFakeTimers();
      const passkeyButton = { by: "text" as const, value: "Use passkey" };
      const twice = parseLoginRecipe({
        ...unlearned,
        handlers: [keyHandler, { kind: "passkey", path: "/login/verify", target: passkeyButton }],
      });
      onClick({
        login: toWebauthn,
        "Use security key": { path: "/login/verify", present: ["Use passkey"] },
        // Back to the first handler's page, as after a failed key.
        "Use passkey": toWebauthn,
      });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(twice);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(clicks("Use security key")).toBe(1);
      expect(clicks("Use passkey")).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
    });

    it("judges the page only once the clicked button is gone", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toWebauthn });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      // A WebAuthn exchange or a chooser the person answers keeps the button showing.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
      await until(settled("authenticated"));
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(service.judge).toHaveBeenCalledWith(
        plain.id,
        plain.revision,
        "password",
        homePage.observation,
      );
      expect(clicks("Use security key")).toBe(1);
    });

    it("ends as a challenge when the clicked button still shows after two minutes", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toWebauthn });
      const service = generation();
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      await until(settled("blocked", "challenge"), 10_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(clicks("Use security key")).toBe(1);
    });

    it("leaves a new document that shows the clicked handler's button to the person at once", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toWebauthn });
      const service = generation();
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      // The page reloads after the click and shows the button again.
      fake.state.pageUrl = `${origin}/login/webauthn`;
      await h.hello({ documentId: "reloaded" }, false);
      await until(settled("blocked", "challenge"), 5_000);
      expect(service.judge).not.toHaveBeenCalled();
      expect(clicks("Use security key")).toBe(1);
    });

    describe("the pages judged after one effect step", () => {
      const page = (path: string, complete = true) => {
        const described = observation(path, [
          { id: "c1", role: "link", target: target("help"), label: "Help" },
        ]);
        return { ...described, observation: { ...described.observation, complete } };
      };
      const judged = () => status()![0]!["judged"] as { pages: number } | undefined;
      /** The login's click leads to `/elsewhere`, which no check explains. */
      async function settledLogin(
        judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" }),
        extracted = page("/elsewhere"),
      ) {
        vi.useFakeTimers();
        onClick({ login: { path: "/elsewhere", present: [], extracted } });
        const service = generation(judge);
        const h = harness({}, { passkeys: withPasskey, generation: service });
        h.recipes.recipe.mockResolvedValue(plain);
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("reconciling", "unknown-submit"), 10_000);
        expect(status()![0]).toMatchObject({ settled: true });
        return { h, service };
      }
      /** The tab opens another page of the origin, which settles in turn. */
      async function open(h: ReturnType<typeof harness>, path: string) {
        fake.state.pageUrl = `${origin}${path}`;
        fake.state.observedPath = path;
        fake.state.present = new Set();
        fake.state.extracted = { "signed-in": page(path) };
        await h.hello({ documentId: `document${path.replaceAll("/", "-")}` }, false);
        await vi.advanceTimersByTimeAsync(30_000);
      }

      it("sends at most two pages the model saw, also after the result settled", async () => {
        const { h, service } = await settledLogin();
        expect(service.judge).toHaveBeenCalledTimes(1);
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(2);
        expect(judged()).toMatchObject({ pages: 2 });
        await open(h, "/billing");
        expect(service.judge).toHaveBeenCalledTimes(2);
        expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]);
      });

      it("does not count a page it could not describe completely", async () => {
        const { h, service } = await settledLogin(undefined, page("/elsewhere", false));
        expect(service.judge).not.toHaveBeenCalled();
        expect(judged()).toBeUndefined();
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(service.judge.mock.calls[0]![3]).toMatchObject({ path: "/settings" });
        expect(judged()).toMatchObject({ pages: 1 });
      });

      /** The extension's own judge mapping over a service that gives these answers. */
      function serviceAnswering(...reasons: ("busy" | "already-judged" | "recipe-conflict")[]) {
        const judgeCompletion = vi.fn<ServiceTransport["judgeCompletion"]>(async () => {
          const reason = reasons.shift();
          return {
            kind: "result",
            result: reason
              ? { version: 1, status: "unavailable", reason }
              : { version: 1, status: "unclear" },
          };
        });
        const service = createLoginGeneration({
          service: {
            connection: async () => ({
              origin: "https://pateat.example.com",
              deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
              credential: `pateat_device_${"C".repeat(43)}`,
              rejected: false,
            }),
          },
          transport: { generateRecipe: vi.fn(), judgeCompletion },
          storage: { read: async () => undefined, write: async () => undefined },
          sync: async () => "synced",
          refresh: async () => "synced",
        });
        return (...args: Parameters<LoginGeneration["judge"]>) => service.judge(...args);
      }

      it("gives back a page the service refused while busy", async () => {
        const { h, service } = await settledLogin(serviceAnswering("busy"));
        expect(service.judge).toHaveBeenCalledTimes(1);
        expect(judged()).toMatchObject({ pages: 0 });
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(2);
        expect(service.judge.mock.calls[1]![3]).toMatchObject({ path: "/settings" });
        expect(judged()).toMatchObject({ pages: 1 });
      });

      it("spends a page the service refused for good", async () => {
        const { h, service } = await settledLogin(
          serviceAnswering("already-judged", "recipe-conflict"),
        );
        expect(judged()).toMatchObject({ pages: 1 });
        await open(h, "/settings");
        expect(judged()).toMatchObject({ pages: 2 });
        await open(h, "/billing");
        expect(service.judge).toHaveBeenCalledTimes(2);
      });

      it("counts a page whose request a worker restart cut off", async () => {
        vi.useFakeTimers();
        onClick({ login: { path: "/elsewhere", present: [], extracted: page("/elsewhere") } });
        const lost = generation(() => new Promise(() => undefined));
        const h = harness({}, { passkeys: withPasskey, generation: lost });
        h.recipes.recipe.mockResolvedValue(plain);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => lost.judge.mock.calls.length === 1, 10_000);
        expect(judged()).toMatchObject({ pages: 1 });
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          const service = generation();
          const restarted = harness({}, { passkeys: withPasskey, generation: service });
          restarted.recipes.recipe.mockResolvedValue(plain);
          await open(restarted, "/settings");
          await open(restarted, "/billing");
          await open(restarted, "/account");
          expect(service.judge).toHaveBeenCalledTimes(1);
          expect(judged()).toMatchObject({ pages: 2 });
        } finally {
          fake.browser.tabs.query = query;
        }
      });
    });

    it("judges the page after an advance whose next step never appeared", async () => {
      vi.useFakeTimers();
      const advancing = parseLoginRecipe({
        ...unlearned,
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
      const elsewhere = observation("/verify", [
        { id: "c1", role: "button", target: target("resend"), label: "Resend email" },
      ]);
      fake.state.present = new Set(["continue"]);
      onClick({ continue: { path: "/verify", present: ["resend"], extracted: elsewhere } });
      const service = generation(async () => ({ verdict: "challenge" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(advancing);
      h.recipes.firstSteps.mockResolvedValue([advancing.steps[0]!]);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(service.judge).toHaveBeenCalledWith(
        advancing.id,
        advancing.revision,
        "password",
        elsewhere.observation,
      );
      expect(executed()).toHaveLength(1);
    });

    it("sends a page without the marker even when the recipe has a completion", async () => {
      vi.useFakeTimers();
      const learned = parseLoginRecipe({ ...unlearned, completion: home });
      const welcome = observation("/welcome", [
        { id: "c1", role: "button", target: target("account"), label: "Account" },
      ]);
      onClick({ login: { path: "/welcome", present: ["account"], extracted: welcome } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(service.judge).toHaveBeenCalledWith(
        learned.id,
        learned.revision,
        "password",
        welcome.observation,
      );
    });

    it("does not send a page that shows the completion marker", async () => {
      vi.useFakeTimers();
      const learned = parseLoginRecipe({ ...unlearned, completion: home });
      // The marker shows, but on another path than the completion's.
      onClick({ login: { path: "/account", present: ["logout"], extracted: homePage } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });
  });

  describe("the first login on a page that gains a handler", () => {
    it("takes the new revision over and clicks the handler with a grown budget", async () => {
      vi.useFakeTimers();
      let atClick: Record<string, unknown> | undefined;
      onClick({ login: toWebauthn, "Use security key": toHome });
      const recordAtClick = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        const step = (message["operation"] as { step: { target?: { value: string } } }).step;
        if (step.target?.value === "Use security key") atClick = structuredClone(status()![0]);
        await recordAtClick(message, tabId);
      };
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: taken })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      // The handler ran only once the attempt recorded the revision it belongs to.
      expect(atClick).toMatchObject({
        state: "submit-intent",
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepIndex: 2,
        stepCount: 3,
        submissions: 2,
        maxSubmissions: 2,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(service.judge.mock.calls).toEqual([
        [plain.id, 1, "password", webauthnPage.observation],
        // The page after the handler is judged for the new revision.
        [plain.id, 2, "password", homePage.observation],
      ]);
    });

    it("pulls only recipes after the takeover, so a settings change does not stop the login", async () => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toHome });
      const connection = {
        origin: "https://pateat.example.com",
        deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
        credential: `pateat_device_${"C".repeat(43)}`,
        rejected: false,
      };
      const change = { recipeId: taken.id, revision: 2, state: "active" as const, recipe: taken };
      let h: ReturnType<typeof harness> | undefined;
      // The settings half of a full sync applies a synced change, as the background wires it.
      const settings = {
        run: vi.fn(async () => {
          h!.login.settingsChanged();
          return "synced" as const;
        }),
        clear: vi.fn(async () => undefined),
      };
      const recipeSync = createRecipeSync({
        service: { connection: async () => connection, recordSync: async () => undefined },
        transport: {
          recipeChanges: async () => ({
            kind: "page",
            page: { version: 1, changes: [change], cursor: 1, complete: true },
          }),
        },
        storage: {
          read: async () => undefined,
          write: async () => undefined,
          clear: async () => undefined,
        },
        schedule: { read: async () => undefined, write: async () => undefined },
        settings,
      });
      const judgeCompletion = vi
        .fn<ServiceTransport["judgeCompletion"]>()
        .mockResolvedValueOnce({
          kind: "result",
          result: { version: 1, status: "challenge", change },
        })
        .mockResolvedValueOnce({ kind: "result", result: { version: 1, status: "signed-in" } });
      const refresh = vi.fn(() => recipeSync.sync({ settings: false }));
      const sync = vi.fn(() => recipeSync.sync());
      const service = createLoginGeneration({
        service: { connection: async () => connection },
        transport: { generateRecipe: vi.fn(), judgeCompletion },
        storage: { read: async () => undefined, write: async () => undefined },
        sync,
        refresh,
      });
      h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => settled("authenticated")() || settled("blocked")());
      // A full sync here ended the login as blocked/policy-changed in the owner's Chrome.
      expect(status()![0]).toMatchObject({ state: "authenticated" });
      expect(clicks("Use security key")).toBe(1);
      expect(
        judgeCompletion.mock.calls.map((call) => [call[3].revision, call[3].observation]),
      ).toEqual([
        [1, webauthnPage.observation],
        [2, homePage.observation],
      ]);
      expect(refresh).toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(settings.run).not.toHaveBeenCalled();
    });

    it.each([
      ["changes the route's steps", { ...taken, maxSubmissions: 2 }],
      ["is another recipe", { ...taken, id: "another-recipe" }],
      ["is not newer", { ...taken, revision: 1 }],
    ])("ends as a challenge without a click when the revision %s", async (_label, next) => {
      vi.useFakeTimers();
      onClick({ login: toWebauthn, "Use security key": toHome });
      const service = generation(async () => ({
        verdict: "challenge",
        recipe: parseLoginRecipe(next),
      }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(clicks("Use security key")).toBe(0);
      expect(status()![0]).toMatchObject({ recipeRevision: 1, handlers: [] });
    });

    it.each([
      ["the taken-over revision", taken, { ok: true }, 2],
      ["a cache that still holds the older revision", plain, { ok: true }, 2],
      [
        "a newer revision that only adds a completion",
        parseLoginRecipe({ ...taken, revision: 3, completion: home }),
        { ok: true },
        3,
      ],
      [
        "a newer revision that changes the route",
        parseLoginRecipe({ ...taken, revision: 3, maxSubmissions: 2 }),
        { ok: false, reason: "recipe-not-found" },
        2,
      ],
    ] as const)(
      "after navigation, resumes with %s",
      async (_label, cached, expected, recipeRevision) => {
        vi.useFakeTimers();
        // The handler's click never answers, so the attempt is running when the page changes.
        onClick({ login: toWebauthn, "Use security key": "hang" });
        const service = generation(async () => ({ verdict: "challenge", recipe: taken }));
        const h = harness({}, { passkeys: withPasskey, generation: service });
        h.recipes.recipe.mockResolvedValue(plain);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("Use security key") === 1);
        h.recipes.recipe.mockResolvedValue(cached);
        expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual(expected);
        expect(status()![0]).toMatchObject({ recipeRevision, handlers: [{ index: 0, start: 2 }] });
      },
    );
  });

  describe("generation slots", () => {
    const unsaved = { siteDefaults: [], bindings: [] };
    const loginPage = observation("/signin", [
      { id: "c1", role: "email", target: target("user"), autocomplete: "username" },
      { id: "c2", role: "password", target: target("password") },
      { id: "c3", role: "button", target: target("login"), label: "Sign in" },
    ]);
    const uris = async () => ({ ok: true as const, data: uriMatch() });

    it.each([
      ["is empty", {}, true],
      ["is excluded", { excludedFields: [{ itemId, fieldId: "login.password" }] }, false],
    ])(
      "offers no password when the matching item's password %s",
      async (_label, excluded, empty) => {
        fake.state.extracted = { login: loginPage };
        const service = { ...generation(), available: vi.fn(async () => true) };
        const h = harness(
          {
            ...unsaved,
            connections: [
              {
                connectionId,
                enabled: true,
                selection: { mode: "all", groupIds: [], itemIds: [] },
                excludedItemIds: [],
                excludedFields: [],
                ...excluded,
              },
            ],
          },
          { allowedOrigins: [], uris, username: true, generation: service },
        );
        if (empty)
          editFields(h, (fields) =>
            fields.map((field) =>
              field["id"] === "login.password" ? { ...field, empty: true } : field,
            ),
          );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.firstSteps.mockResolvedValue([]);
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
        expect(service.generate.mock.calls[0]![0].slots).toEqual([
          expect.objectContaining({ id: "username", kind: "identifier" }),
        ]);
      },
    );
  });

  it("removes the previous attempt store and logs in without reading it", async () => {
    fake.state.present = undefined;
    fake.state.storage["pateat.login-attempts.v1"] = [{ id: "retired-record" }];
    const h = harness({}, { passkeys: withPasskey });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(fake.state.storage).not.toHaveProperty(["pateat.login-attempts.v1"]);
  });

  describe("the item a running login uses", () => {
    it("is named only while the tab's login on that origin has not ended", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      expect(await h.login.loginAccount(1, "https://other.example")).toBeUndefined();
      expect(await h.login.loginAccount(2, origin)).toBeUndefined();
    });

    it("is not named once the login's result settled as unknown", async () => {
      vi.useFakeTimers();
      onClick({ login: { path: "/elsewhere", present: [] } });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("login") === 1);
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });

    it("keeps naming a running login's item after a worker restart", async () => {
      onClick({ login: "hang" });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(clicks("login")).toBe(1));
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { passkeys: withPasskey });
        expect(await restarted.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
        expect(status()).toMatchObject([{ state: "reconciling" }]);
        expect(await restarted.login.loginAccount(1, "https://other.example")).toBeUndefined();
      } finally {
        fake.browser.tabs.query = query;
      }
    });

    it("does not name a settled login's item after a worker restart", async () => {
      vi.useFakeTimers();
      onClick({ login: { path: "/elsewhere", present: [] } });
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 10_000);
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = harness({}, { passkeys: withPasskey });
        expect(await restarted.login.loginAccount(1, origin)).toBeUndefined();
      } finally {
        fake.browser.tabs.query = query;
      }
    });

    it("is not named once the login ended", async () => {
      fake.state.present = undefined;
      const h = harness({}, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });
  });
});
