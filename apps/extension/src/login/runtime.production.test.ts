import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsStore,
  parseLoginRecipe,
  recipeStartSteps,
  type LocalSettings,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsSnapshot,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import { vaultFailure } from "../vault/record";
import type { LiveUriMatcher } from "../vault/site-candidates";
import { createVaultAutoSync, createVaultSyncRecords } from "../connections/auto-sync";
import { createLoginGeneration } from "../service/generation";
import { createRecipeSync } from "../service/recipes";
import { createSettingsSync } from "../service/settings-sync";
import type { ServiceTransport } from "../service/transport";
import { acceptsSecret, type SecretInput } from "./inputs";
import type { LoginGeneration, LoginReport } from "./runtime";
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
      | {
          ok: boolean;
          reason?: string;
          detail?: string;
          switchable?: true;
          mutation?: "none" | "possible";
        },
    /** The document's answer to clicking an account switch. */
    switchReply: { ok: true } as { ok: boolean },
    /**
     * What the page shows for a continuation, when an observation asks (ADR 0018): `true`
     * for a loaded page with a password input other than the asked targets, `false` for
     * one still loading, or the answer's parts.
     */
    signIn: false as boolean | { password?: boolean; identifier?: boolean },
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
    /** The page signs the document reports for ADR 0029; none when unset. */
    signs: undefined as undefined | Record<string, boolean>,
    /** Whether the document says it has finished loading, with its signs. */
    loaded: true,
    /** `chrome.storage.session`. */
    session: {} as Record<string, unknown>,
    /** Present elements that are hidden or disabled, for an observation that asks. */
    unusable: new Set<string>(),
    /** Elements that match more than once. */
    ambiguous: new Set<string>(),
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
        /** A target's state with `present`, as the content script reports it. */
        const stateOf = (value: string, require: string | undefined) =>
          !state.present!.has(value)
            ? "missing"
            : state.ambiguous.has(value)
              ? "ambiguous"
              : [undefined, "present"].includes(require) === false && state.unusable.has(value)
                ? "unusable"
                : "unique";
        if (message["type"] === "login.observe")
          return {
            path: state.observedPath,
            targets: state.present
              ? (message["targets"] as { value: string }[]).map((entry, index) =>
                  stateOf(entry.value, (message["require"] as string[] | undefined)?.[index]),
                )
              : [...state.observed],
            ...(message["signIn"]
              ? {
                  signIn:
                    typeof state.signIn === "boolean"
                      ? { loaded: state.signIn, password: state.signIn, identifier: false }
                      : {
                          loaded: true,
                          password: state.signIn.password === true,
                          identifier: state.signIn.identifier === true,
                        },
                }
              : {}),
          };
        if (message["type"] === "login.switch") return state.switchReply;
        if (message["type"] === "login.state")
          return state.signs
            ? { ok: true, signs: state.signs, loaded: state.loaded }
            : { ok: false };
        if (message["type"] === "login.extract")
          return (
            state.extracted[message["page"] as string] ?? { ok: false, reason: "no-candidates" }
          );
        if (message["type"] === "login.execute") {
          // An advance's next step, measured just before the click or the first input.
          const next = message["next"] as
            | { require: string; targets: { value: string }[] }
            | undefined;
          const before =
            next && state.present
              ? next.targets.map((entry) => stateOf(entry.value, next.require))
              : undefined;
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
            ...(before && state.executeReply?.ok !== false ? { before } : {}),
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
/** One recipe start per step, as the recipe cache lists single-variant recipes. */
const startsOf = (steps: LoginStep[]) => steps.map((step) => ({ path: step.path, steps: [step] }));
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

type CustomField = {
  name: string | null;
  kind: "text" | "hidden" | "linked";
  linkedFieldId?: string;
};

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
    /** Receives the runtime's reports for the local log, without page URLs unless `urls`. */
    report?: (report: LoginReport) => void;
    urls?: boolean;
    /** Replaces the item's custom fields. */
    custom?: CustomField[];
    /** Custom fields of the other item, which has none otherwise. */
    otherCustom?: CustomField[];
    /** Further items of the connection, each with a password and these custom fields. */
    extraItems?: { id: string; custom: CustomField[] }[];
  } = {},
) {
  const customFields = (fields: CustomField[]) =>
    fields.map((field, index) => ({
      id: `custom.${current.current}.${index}`,
      label: field.name ?? "",
      ...field,
    }));
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
                  ...customFields(live.custom ?? [{ name: "Branch", kind: "text" as const }]),
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
                  ...customFields(live.otherCustom ?? []),
                ],
              },
              ...(live.extraItems ?? []).map((extra) => ({
                id: extra.id,
                label: "Extra synthetic item",
                allowedOrigins: [],
                groupIds: [],
                fields: [
                  { id: "login.password", label: "Password", name: null, kind: "hidden" as const },
                  ...customFields(extra.custom),
                ],
              })),
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
    starts: vi.fn(async (at: string) => (at === origin ? startsOf([recipe.steps[0]!]) : [])),
  };
  const login = createLoginRuntime(store, {
    fields,
    sites: createLoginSites(store),
    recipes,
    ...(live.uris ? { uris: live.uris } : {}),
    ...(live.generation ? { generation: live.generation } : {}),
    ...(live.passkeys ? { passkeys: live.passkeys } : {}),
    ...(live.vault ? { vault: live.vault } : {}),
    ...(live.report
      ? {
          report: (entry: LoginReport) => {
            const { url: _url, ...rest } = entry;
            live.report?.(live.urls ? entry : rest);
          },
        }
      : {}),
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
/** The document reports a visible sign-in input on its path without a ready first step. */
const shownHello = (
  h: { login: { handle(message: unknown, sender: unknown): Promise<unknown> } },
  from: Record<string, unknown> = {},
) =>
  h.login.handle(
    {
      version: 1,
      type: "login.document.ready",
      token: "synthetic-token",
      shown: { path: new URL(fake.state.pageUrl).pathname },
    },
    sender(from),
  );

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
    fake.state.unusable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
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
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
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
    const attempts = () => fake.state.storage["pateat.login-attempts.v3"];
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
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
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
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
        { state: "blocked", outcome: "value-mismatch", submissions: 0, retries: 0 },
      ]),
    );
    expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toHaveLength(1);
    expect(fake.state.messages.at(-1)).toMatchObject({ outcome: "value-mismatch" });
  });
  it.each(["target-missing", "form-changed"] as const)(
    "logs the page's reason when a step fails with %s",
    async (detail) => {
      fake.state.executeReply = { ok: false, reason: "structural-mismatch", detail };
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "attempt", cause: detail }),
        ),
      );
    },
  );
  it("does not click when the page rejects the filled values", async () => {
    fake.state.executeReply = { ok: false, reason: "fill-rejected", mutation: "possible" };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
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
    h.recipes.starts.mockResolvedValue(
      startsOf([
        recipe.steps[0]!,
        { ...recipe.steps[0]!, fields: [{ slot: "password", target: target("other") }] },
        { ...recipe.steps[0]!, path: "/other" },
      ] as never),
    );
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
  it("logs once when a sign-in input shows but no login starts", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    const notStarted = () =>
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
    // Without a shown sign-in input, watching is not logged.
    expect(await h.hello({}, false)).toMatchObject({ reason: "form-not-ready" });
    expect(notStarted()).toEqual([]);
    // The recipe starts on this path, but its first step's elements were not found.
    const watching = { ok: false, reason: "form-not-ready", starts: [signinStart] };
    expect(await shownHello(h)).toEqual(watching);
    // The same document reporting again is not logged again.
    expect(await shownHello(h)).toEqual(watching);
    expect(notStarted()).toEqual([
      {
        type: "refused",
        tabId: 1,
        origin,
        reason: "not-started",
        detail: "first-step-missing",
      },
    ]);
    // No recipe of the origin starts on this path.
    h.recipes.recipe.mockResolvedValue(undefined);
    expect(await shownHello(h, { documentId: "elsewhere" })).toMatchObject({
      reason: "recipe-not-found",
    });
    expect(notStarted().at(-1)).toMatchObject({
      reason: "not-started",
      detail: "no-recipe-on-path",
    });
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("does not log a sign-in input on an origin without a recipe", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.starts.mockResolvedValue([]);
    expect(await shownHello(h)).toEqual({ ok: false, reason: "recipe-not-found" });
    // Ordinary browsing: logged only while debug logging is on.
    expect(report.mock.calls.map(([entry]) => entry)).toEqual([
      { type: "refused", tabId: 1, origin, reason: "recipe-not-found", unrelated: true },
    ]);
  });
  it.each([
    [
      "an excluded site",
      { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
      "site-excluded",
    ],
    ["a site whose access the user withheld", undefined, "no-site-access"],
  ])("logs why the page of %s with a recipe is not admitted", async (_name, overrides, reason) => {
    const report = vi.fn<(report: LoginReport) => void>();
    if (!overrides) fake.state.granted = false;
    const h = harness((overrides ?? {}) as Partial<LocalSettings>, { report });
    const refusals = () => report.mock.calls.map(([entry]) => entry);
    expect(await h.hello()).toEqual({ ok: false, reason: "unauthorized-document" });
    // The same page again is a repeat.
    expect(await h.hello({}, false)).toEqual({ ok: false, reason: "unauthorized-document" });
    // A frame is not the tab's page, and an origin without a recipe is ordinary browsing.
    expect(await h.hello({ frameId: 1 })).toEqual({ ok: false, reason: "unauthorized-document" });
    h.recipes.starts.mockResolvedValue([]);
    expect(await h.hello({ documentId: "other" })).toEqual({
      ok: false,
      reason: "unauthorized-document",
    });
    expect(refusals()).toEqual([
      { type: "refused", tabId: 1, origin, reason },
      { type: "refused", tabId: 1, origin, reason, repeat: true },
    ]);
    expect(h.store.handle).not.toHaveBeenCalled();
    expect(h.recipes.recipe).not.toHaveBeenCalled();
  });
  it("logs a page that gave up starting after its tries were stale", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    // The tab moved on while the document's settings were read.
    fake.state.tabUrls[1] = "https://elsewhere.example/";
    for (let tries = 0; tries < 4; tries += 1)
      // eslint-disable-next-line no-await-in-loop
      expect(await h.hello()).toEqual({ ok: false, reason: "stale-document" });
    expect(report.mock.calls.map(([entry]) => entry)).toEqual([
      { type: "refused", tabId: 1, origin, reason: "stale-document" },
      { type: "refused", tabId: 1, origin, reason: "stale-document", repeat: true },
      { type: "refused", tabId: 1, origin, reason: "stale-document", repeat: true },
      { type: "refused", tabId: 1, origin, reason: "stale-document", repeat: true },
      { type: "refused", tabId: 1, origin, reason: "stale-document", detail: "gave-up" },
    ]);
  });
  it("names the tab's page URL in its reports, but not a frame's", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    fake.state.pageUrl = "https://login.example/signin?next=%2Fhome#top";
    const h = harness({}, { report, urls: true });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry.type)).toContain("attempt"),
    );
    const reports = report.mock.calls.map(([entry]) => entry);
    expect(reports.find((entry) => entry.type === "start")?.url).toBe(fake.state.pageUrl);
    expect(reports.find((entry) => entry.type === "attempt")?.url).toBe(fake.state.pageUrl);
    report.mockClear();
    fake.state.tabUrls[1] = fake.state.pageUrl;
    expect(
      await h.hello({ frameId: 2, documentId: "frame", tab: { id: 1, url: fake.state.pageUrl } }),
    ).toEqual({ ok: false, reason: "tab-busy" });
    expect(
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused"),
    ).toEqual([{ type: "refused", tabId: 1, origin, reason: "tab-busy", frame: true }]);
  });
  it("logs the same refusal on the same page once, and again on a new page", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({ siteDefaults: [] }, { report });
    const first = await h.hello();
    expect(first).toMatchObject({ ok: false });
    expect(await h.hello()).toEqual(first);
    expect(await h.hello({ documentId: "next-page" })).toEqual(first);
    const { reason } = first as { reason: string };
    expect(
      report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused"),
    ).toEqual([
      expect.objectContaining({ reason }),
      expect.objectContaining({ reason, repeat: true }),
      expect.not.objectContaining({ repeat: true }),
    ]);
  });
  it("logs an exception that stops a login with its name and message", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onExecute = async () => {
      fake.state.onExecute = undefined;
      throw new SyntaxError("synthetic page answer");
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "exception" }),
      ),
    );
    expect(
      report.mock.calls.map(([entry]) => entry).find((entry) => entry.type === "exception"),
    ).toEqual({
      type: "exception",
      tabId: 1,
      origin,
      recipeId: recipe.id,
      route: "password",
      state: expect.any(String),
      stepIndex: 0,
      name: "SyntaxError",
      message: "synthetic page answer",
    });
  });
  it("logs only the type of a thrown value that is not an Error", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onExecute = async () => {
      fake.state.onExecute = undefined;
      throw "synthetic thrown text";
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
        expect.objectContaining({ type: "exception", name: "string" }),
      ),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("synthetic thrown text");
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
  it("logs a document announcing again while it carries a login", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    expect(await h.hello()).toEqual({ ok: true });
    expect(await h.hello()).toEqual({ ok: false, reason: "duplicate-document" });
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual({
      type: "refused",
      tabId: 1,
      origin,
      reason: "duplicate-document",
    });
  });
  it("a policy change while waiting for elements stops before any intent or vault read", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onAwait = () => {
      h.settings.revision += 1;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
        { state: "blocked", outcome: "policy-changed", usedOperationIds: [] },
      ]),
    );
    // The log names what withdrew the login.
    expect(report.mock.calls.at(-1)![0]).toMatchObject({
      type: "attempt",
      state: "blocked",
      outcome: "policy-changed",
      cause: "settings-revision",
    });
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it("names the plan's refusal when the vault is turned off while waiting for elements", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    fake.state.onAwait = () => {
      h.settings.settings.connections[0]!.enabled = false;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "blocked", outcome: "policy-changed", cause: "plan" }),
      ),
    );
    expect(report.mock.calls.at(-1)![0]).toMatchObject({ reason: "connection-disabled" });
    expect(h.fields).not.toHaveBeenCalled();
  });
  it("retries twice, then stops before any vault read or page change when a step's elements never appear", async () => {
    fake.state.awaited = { ok: false, reason: "timeout" };
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness({}, { report });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
        {
          state: "blocked",
          outcome: "retry-limit",
          retries: 2,
          submissions: 0,
          usedOperationIds: [],
        },
      ]),
    );
    // The first wait and one per retry, each from the same step.
    expect(fake.state.messages.filter((entry) => entry.type === "login.await")).toHaveLength(3);
    expect(
      report.mock.calls.map(([entry]) => (entry.type === "attempt" ? entry.state : entry.type)),
    ).toEqual([
      "start",
      "ready",
      "retryable",
      "ready",
      "retryable",
      "ready",
      "retryable",
      "blocked",
    ]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });
  it("logs in when a retry finds the step's elements that the first wait did not", async () => {
    let waits = 0;
    fake.state.onAwait = () => {
      waits += 1;
      fake.state.awaited = waits === 1 ? { ok: false, reason: "timeout" } : { ok: true };
    };
    const h = harness();
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
        { state: "authenticated", retries: 1 },
      ]),
    );
    expect(h.fields).toHaveBeenCalled();
  });
  it("retries a retryable attempt that a restarted worker finds once its page shows the step", async () => {
    // A worker that stopped before retrying left the attempt waiting to be tried again.
    fake.state.awaited = { ok: false, reason: "timeout" };
    const first = harness();
    expect(await first.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
        { state: "blocked", outcome: "retry-limit" },
      ]),
    );
    const [record] = fake.state.storage["pateat.login-attempts.v3"] as Record<string, unknown>[];
    fake.state.storage["pateat.login-attempts.v3"] = [
      {
        ...record,
        state: "retryable",
        outcome: "structural-mismatch",
        retries: 1,
        retryRequired: true,
      },
    ];
    fake.state.awaited = { ok: true };
    // The new page still shows the login form; the click signs in.
    fake.state.present = new Set(["password", "login"]);
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: LoginStep }).step.kind === "click")
        fake.state.present = new Set(["authenticated"]);
    };
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    try {
      const restarted = harness();
      expect(await restarted.hello({ documentId: "after-restart" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
          { state: "authenticated", retries: 2 },
        ]),
      );
    } finally {
      fake.browser.tabs.query = query;
    }
  });
  describe("a login form inside a frame", () => {
    const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
    // The tab shows the page around the frame; the frame's own URL is the login page.
    const framed = (top: string, overrides: Record<string, unknown> = {}) => {
      fake.state.tabUrls[1] = top;
      return { frameId: 3, documentId: "frame-document", tab: { id: 1, url: top }, ...overrides };
    };
    it("never names the tab's page URL in the reports of a login in a same-site frame", async () => {
      const report = vi.fn<(report: LoginReport) => void>();
      const signin = fake.state.pageUrl;
      const top = "https://login.example/elsewhere?next=1";
      fake.state.pageUrl = top;
      const h = harness({}, { report, urls: true });
      expect(await h.hello()).toMatchObject({ ok: false, reason: "recipe-not-found" });
      fake.state.pageUrl = signin;
      expect(await h.hello(framed(top))).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      const reports = report.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.type !== "refused");
      expect(reports.map((entry) => entry.type)).toContain("attempt");
      expect(reports.filter((entry) => entry.url !== undefined)).toEqual([]);
    });
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
      expect(fake.state.storage["pateat.login-attempts.v3"]).toHaveLength(1);
    });
    it("keeps one attempt per tab and lets only a new page end a frame's attempt", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { report });
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
      // A sign-in input reported only for the log does not log the hold again.
      expect(await shownHello(h, { documentId: "page-document", url: top })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      // The log tells a refused frame from the tab's page.
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "refused" ? [[value.reason, value.frame]] : [],
        ),
      ).toEqual([
        ["tab-busy", undefined],
        ["tab-busy", true],
      ]);
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
        expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
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
      fake.state.storage["pateat.login-attempts.v3"] as { state: string; outcome?: string }[];
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
    type Stored = {
      id: string;
      state: string;
      outcome?: string;
      submissions: number;
      mutationIntent?: true;
      changedAt?: number;
    } & {
      account: { origin: string };
      document: { tabId: number; documentId: string };
    };
    const stored = () => (fake.state.storage["pateat.login-attempts.v3"] ?? []) as Stored[];
    const at = (from: string) => stored().find((entry) => entry.account.origin === from);
    /** Both origins have their own recipe, binding and saved default for the same item. */
    const twoSites = (live: Parameters<typeof harness>[1] = {}) => {
      const h = harness(
        {
          siteDefaults: [
            { origin, provider: "bitwarden", userId, itemId },
            { origin: second, provider: "bitwarden", userId, itemId },
          ],
          bindings: [savedBinding, { ...savedBinding, recipeId: secondRecipe.id, origin: second }],
        },
        { allowedOrigins: [origin, second], ...live },
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
      h.recipes.starts.mockImplementation(async (from: string) =>
        startsOf(
          from === origin ? [recipe.steps[0]!] : from === second ? [secondRecipe.steps[0]!] : [],
        ),
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
    /** A page of the second site whose login form is in a frame of the same origin. */
    const secondPage = `${second}/account`;
    const secondFrame = () => {
      fake.state.tabUrls[1] = secondPage;
      return h2frame;
    };
    const h2frame = {
      frameId: 3,
      documentId: "second-frame",
      url: secondUrl,
      tab: { id: 1, url: secondPage },
    };
    it("starts the next site's framed login after the tab's login ended on another site", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" }),
      );
      fake.state.executeReply = undefined;
      expect(await navigate(h, secondPage, "second-page", false)).toMatchObject({ ok: false });
      // The ended login of the site the tab left never holds the next site's frame.
      expect(await h.hello(secondFrame())).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" });
    });
    it("lets the next site log in after the tab's framed login on another site", async () => {
      const portal = "https://portal.example/account";
      const h = twoSites({ allowedOrigins: [origin, second, "https://portal.example"] });
      fake.state.tabUrls[1] = portal;
      expect(
        await h.hello({ frameId: 5, documentId: "portal-frame", tab: { id: 1, url: portal } }),
      ).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "authenticated",
          document: { frameId: 5 },
          pageOrigin: "https://portal.example",
        }),
      );
      // After a worker restart, the next site's page and its frame are not held either.
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = twoSites();
        expect(await restarted.login.active()).toBe(false);
        expect(await navigate(restarted, secondPage, "second-page", false)).toMatchObject({
          reason: "recipe-not-found",
        });
        expect(await restarted.hello(secondFrame())).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
        expect(at(origin)).toMatchObject({ state: "authenticated", document: { frameId: 5 } });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends the left site's login when the next site's frame announces before its page", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await h.hello(secondFrame())).toEqual({ ok: true });
      expect(at(origin)).toMatchObject({
        state: "blocked",
        outcome: "left-origin",
        submissions: 1,
      });
      await vi.waitFor(() => expect(at(second)).toMatchObject({ state: "authenticated" }));
      expect(await h.login.active()).toBe(false);
    });
    it("still holds a frame of the same page while its login runs", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      // A frame of the second site's origin inside the first site's page is not another site.
      expect(await h.hello({ ...h2frame, tab: { id: 1, url: fake.state.pageUrl } })).toEqual({
        ok: false,
        reason: "tab-busy",
      });
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
    });
    it("offers the next site's page for generation after the tab's login ended", async () => {
      fake.state.executeReply = { ok: false, reason: "wrong-account" };
      const available = vi.fn<LoginGeneration["available"]>(async () => true);
      const h = twoSites({
        uris: async (_connection, url) => ({
          ok: true,
          data: uriMatch({ targetOrigin: new URL(url).origin }),
        }),
        generation: {
          available,
          generate: vi.fn<LoginGeneration["generate"]>(),
          judge: vi.fn<LoginGeneration["judge"]>(),
          slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
        },
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "wrong-account" }),
      );
      expect(
        await navigate(h, "https://elsewhere.example/login", "elsewhere-document", false),
      ).toEqual({ ok: false, reason: "recipe-not-found", starts: [], generate: true });
      expect(available).toHaveBeenCalledWith("https://elsewhere.example", "/login");
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
    describe("after Pateat answered the site's passkey request (ADR 0022)", () => {
      const quiet = { password: false, code: false, captcha: false, invalid: false, alert: false };
      /** Submits on the site, then has the passkey bridge answer for `rpId` at `answerAt`. */
      const submitted = async (rpId = "login.example") => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        h.login.passkeyAnswered(1, origin, rpId);
        fake.state.signs = quiet;
        return h;
      };
      it("completes when the tab moves on to the passkey's site and its page is quiet", async () => {
        const h = await submitted();
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated", outcome: "authenticated" });
        expect(await h.login.active()).toBe(false);
        expect(executes()).toHaveLength(2);
      });
      it("waits until the new page has loaded", async () => {
        const h = await submitted();
        fake.state.loaded = false;
        setTimeout(() => (fake.state.loaded = true), 1_500);
        const reads = () => fake.state.messages.filter((entry) => entry.type === "login.state");
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
        // Two readings while loading, then two once loaded.
        expect(reads().length).toBeGreaterThanOrEqual(4);
      }, 10_000);
      /** A frame of the new page at https://www.login.example/home. */
      const homeFrame = {
        frameId: 3,
        documentId: "home-frame",
        url: "https://widgets.login.example/panel",
        tab: { id: 1, url: "https://www.login.example/home" },
      };
      it("leaves the move to the new top page when its frame announces first", async () => {
        const h = await submitted();
        fake.state.tabUrls[1] = homeFrame.tab.url;
        await h.hello(homeFrame, false);
        expect(at(origin)).toMatchObject({ state: "submit-intent" });
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("lets a frame that announces while the top page is read wait for it", async () => {
        const h = await submitted();
        const top = navigate(h, "https://www.login.example/home", "home-document", false);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await h.hello(homeFrame, false);
        expect(await top).not.toEqual({ ok: false, reason: "stale-document" });
        expect(at(origin)).toMatchObject({ state: "authenticated" });
      });
      it("ends left-origin when the new page shows a password field", async () => {
        const h = await submitted();
        fake.state.signs = { ...quiet, password: true };
        await navigate(h, "https://www.login.example/signin", "signin-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page still asks for a code", async () => {
        const h = await submitted();
        fake.state.signs = { ...quiet, code: true };
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the new page asks for a passkey again", async () => {
        const h = await submitted();
        // The new page's own request, as the bridge reports it before the page announces.
        h.login.passkeyRequested(1, "https://www.login.example");
        await navigate(h, "https://www.login.example/verify", "verify-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin on a host outside the passkey's RP ID", async () => {
        const h = await submitted("www.login.example");
        await navigate(h, "https://account.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
      it("ends left-origin when the answer came before the submission", async () => {
        holdClicks(origin);
        const h = twoSites();
        h.login.passkeyAnswered(1, origin, "login.example");
        await new Promise((resolve) => setTimeout(resolve, 5));
        fake.state.signs = quiet;
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(executes()).toHaveLength(2));
        await navigate(h, "https://www.login.example/home", "home-document", false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      });
    });
    it("fills without submitting when the site's form shows again after it left", async () => {
      // site -> identity provider -> back to the site's login form (ADR 0021 D, ADR 0022).
      holdClicks(origin, second);
      const h = twoSites();
      const kinds = () =>
        executes().map(
          (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
        );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(await navigate(h, secondUrl, "second-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
      // The site's form is filled once, never clicked, and its record is forgotten.
      expect(await navigate(h, fake.state.pageUrl, "returned-document")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(5));
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(kinds().at(-1)).toBe("fill");
      expect(at(origin)).toBeUndefined();
      // The tab asks once the fill ends; the form showing again only asks.
      expect(fake.state.badges[1]?.text).toBe("1");
      expect(await navigate(h, fake.state.pageUrl, "returned-document")).toEqual({
        ok: false,
        reason: "logged-out",
      });
      // Only the site's record was released; the identity provider's stays until its form shows.
      expect(at(second)).toMatchObject({ state: "blocked", outcome: "left-origin" });
      expect(await navigate(h, secondUrl, "second-again")).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(6));
      await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
      expect(kinds()).toEqual(["fill", "click", "fill", "click", "fill", "fill"]);
      expect(h.fields).toHaveBeenCalledTimes(4);
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
    it("lets another tab log in once the tab's login authenticated", async () => {
      // The login form in another tab means the site's session has ended (ADR 0022).
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "authenticated" }));
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([
          { state: "authenticated", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
      expect(executes()).toHaveLength(4);
    });
    it.each(["wrong-account", "value-mismatch"] as const)(
      "lets another tab log in once Pateat stopped the tab's login as %s",
      async (reason) => {
        // Nothing was submitted, so another tab's login cannot submit the password twice.
        fake.state.executeReply = { ok: false, reason };
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(at(origin)).toMatchObject({ state: "blocked", outcome: reason }),
        );
        fake.state.executeReply = undefined;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(stored()).toMatchObject([
            { state: "blocked", outcome: reason, document: { tabId: 1 } },
            { state: "authenticated", document: { tabId: 2 } },
          ]),
        );
      },
    );
    it("lets another tab log in after a vault read failed before the page got anything", async () => {
      // The prepared fill never reached the page, so nothing can be in flight (ADR 0022).
      const h = twoSites();
      h.fields.mockRejectedValueOnce(new Error("synthetic vault failure"));
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "policy-changed",
          submissions: 0,
        }),
      );
      expect(at(origin)?.mutationIntent).toBeUndefined();
      expect(executes()).toHaveLength(0);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(stored()).toMatchObject([
          { state: "blocked", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
    });
    it("keeps another tab off an origin whose login was stopped while the page had its click", async () => {
      // The click may have submitted the password, so its result may still arrive.
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
      h.login.settingsChanged("synced");
      await vi.waitFor(() =>
        expect(at(origin)).toMatchObject({
          state: "blocked",
          outcome: "policy-changed",
          submissions: 1,
          mutationIntent: true,
        }),
      );
      fake.state.onExecute = undefined;
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
    });
    const idle = { operationId: undefined, operationKind: undefined, operationEffect: undefined };
    it.each([
      // A submitted step was observed, then Pateat stopped the login.
      ["blocked policy-changed after an observed step", "blocked", "policy-changed", idle, true],
      [
        "blocked cancelled before any submission",
        "blocked",
        "cancelled",
        { ...idle, submissions: 0 },
        true,
      ],
      ["blocked cancelled after a submission", "blocked", "cancelled", idle, false],
      [
        "blocked policy-changed with a click the page may have received",
        "blocked",
        "policy-changed",
        {},
        false,
      ],
      [
        "blocked policy-changed with a fill in flight",
        "blocked",
        "policy-changed",
        { operationKind: "fill", operationEffect: "submit", mutationIntent: true },
        false,
      ],
      [
        "blocked policy-changed settled as unknown",
        "blocked",
        "policy-changed",
        { ...idle, settled: true },
        false,
      ],
      ["blocked credential-rejected", "blocked", "credential-rejected", idle, false],
      ["blocked challenge", "blocked", "challenge", idle, false],
      // A login that has not succeeded holds the origin only for a while after it changed.
      [
        "blocked challenge unchanged for 5 minutes",
        "blocked",
        "challenge",
        { ...idle, age: 5 * 60_000 + 1000 },
        true,
      ],
      [
        "reconciling unknown-submit unchanged for 5 minutes",
        "reconciling",
        "unknown-submit",
        { ...idle, settled: true, age: 5 * 60_000 + 1000 },
        true,
      ],
      [
        "reconciling unknown-submit changed 4 minutes ago",
        "reconciling",
        "unknown-submit",
        { ...idle, settled: true, age: 4 * 60_000 },
        false,
      ],
      ["blocked submission-limit", "blocked", "submission-limit", idle, false],
      // Retries spent on failures that changed nothing on the page (owner, 2026-10-12).
      ["blocked retry-limit", "blocked", "retry-limit", idle, true],
    ] as const)(
      "decides whether another tab's %s record holds the origin",
      async (_name, state, outcome, extra, released) => {
        const { age, ...rest } = extra as typeof extra & { age?: number };
        // A password the site refused, or one whose submission may still arrive, is not
        // submitted again from another tab (ADR 0022).
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
        const [record] = stored();
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        try {
          fake.state.storage["pateat.login-attempts.v3"] = [
            {
              ...record!,
              state,
              outcome,
              mutationIntent: undefined,
              ...rest,
              // A record's age is taken when the case runs, not when the table was built.
              ...(age === undefined ? {} : { changedAt: Date.now() - age }),
            },
          ];
          fake.state.onExecute = undefined;
          const restarted = twoSites();
          expect(await restarted.login.active()).toBe(false);
          const sent = executes().length;
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual(
            released ? { ok: true } : { ok: false, reason: "origin-busy" },
          );
          if (released) await vi.waitFor(() => expect(executes().length).toBeGreaterThan(sent));
          else expect(executes()).toHaveLength(sent);
        } finally {
          fake.browser.tabs.query = query;
        }
      },
    );
    it.each([
      [
        "blocked policy-changed before any submission",
        "policy-changed",
        { ...idle, submissions: 0 },
        true,
      ],
      [
        "blocked value-mismatch before any submission",
        "value-mismatch",
        { ...idle, submissions: 0 },
        true,
      ],
      ["blocked cancelled before any submission", "cancelled", { ...idle, submissions: 0 }, true],
      // A stop after a submission resumes: the site may send the tab back to its first step.
      ["blocked policy-changed after an observed step", "policy-changed", idle, false],
      ["blocked value-mismatch after a submission", "value-mismatch", idle, false],
      ["blocked cancelled after a submission", "cancelled", idle, false],
      [
        "blocked policy-changed with a click the page may have received",
        "policy-changed",
        {},
        false,
      ],
      [
        "blocked policy-changed with a fill in flight",
        "policy-changed",
        { operationKind: "fill", operationEffect: "submit", mutationIntent: true },
        false,
      ],
      [
        "blocked policy-changed settled as unknown",
        "policy-changed",
        { ...idle, settled: true },
        false,
      ],
      ["blocked challenge", "challenge", idle, false],
    ] as const)(
      "decides whether the tab's own %s record lets a new page of it log in",
      async (_name, outcome, extra, released) => {
        // A login Pateat itself stopped before any submission holds no tab, its own
        // included; any other ended record is resumed and never submits again (ADR 0022).
        const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
        const [record] = stored();
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          fake.state.storage["pateat.login-attempts.v3"] = [
            {
              ...record!,
              state: "blocked",
              outcome,
              mutationIntent: undefined,
              ...extra,
              // Past ADR 0022's hold on other tabs, which a release would otherwise end early.
              changedAt: Date.now() - 6 * 60_000,
            },
          ];
          fake.state.onExecute = undefined;
          const restarted = twoSites();
          expect(await restarted.login.active()).toBe(false);
          const sent = executes().length;
          // The same document announcing again, as after a restarted worker, resumes it.
          expect(await restarted.hello()).toEqual({ ok: true });
          await flush();
          expect(executes()).toHaveLength(sent);
          expect(at(origin)).toMatchObject({ id: record!.id, state: "blocked", outcome });
          if (!released) {
            // A later page watches for the login form; the record is still resumed.
            expect(await restarted.hello({ documentId: "next-page" }, false)).toMatchObject({
              ok: false,
              reason: "login-stopped",
            });
            expect(at(origin)).toMatchObject({ id: record!.id, state: "blocked", outcome });
          }
          expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(executes().length).toBeGreaterThan(sent));
          if (released) expect(at(origin)?.id).not.toBe(record!.id);
          else {
            // Once the form shows again, the tab asks like after a logout and only fills,
            // so it never submits again (ADR 0021 D).
            await vi.waitFor(async () => expect(await restarted.login.active()).toBe(false));
            expect(
              executes()
                .slice(sent)
                .map(
                  (entry) =>
                    (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
                ),
            ).toEqual(["fill"]);
            expect(at(origin)).toBeUndefined();
            expect(fake.state.badges[1]?.title).toContain("the last login on this site stopped");
          }
        } finally {
          fake.browser.tabs.query = query;
        }
      },
    );
    it("asks in this tab only once its stopped login's form shows again, and logs why", async () => {
      // APA Hotel: the login stopped after its click; the tab must not stay stuck, and must
      // not submit again either (ADR 0021 D, owner's choice 2026-10-12).
      const report = vi.fn<(report: LoginReport) => void>();
      holdClicks(origin);
      const h = twoSites({ report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v3"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "policy-changed",
            mutationIntent: undefined,
            ...idle,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites({ report });
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await vi.waitFor(async () => expect(await restarted.login.active()).toBe(false));
        expect(
          report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "refused")
            .at(-1),
        ).toMatchObject({
          reason: "logged-out",
          detail: "stopped-login",
        });
        expect(fake.state.session["pateat.login-stopped-asks.v1"]).toEqual([{ tabId: 1, origin }]);
        expect(fake.state.session["pateat.login-logouts.v1"]).toEqual([]);
        // Another tab of the site is not asked: it logs in, with its click.
        const sent = executes().length;
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(
            executes()
              .slice(sent)
              .map(
                (entry) =>
                  (entry as unknown as { operation: { step: LoginStep } }).operation.step.kind,
              ),
          ).toContain("click"),
        );
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("keeps resuming a stopped login while it still holds the site, so other tabs wait", async () => {
      // A challenge just after the click holds the site for 5 minutes (ADR 0022); its tab's
      // later login page does not end that early, and does not ask yet.
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        fake.state.storage["pateat.login-attempts.v3"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "challenge",
            mutationIntent: undefined,
            ...idle,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        const sent = executes().length;
        expect(await restarted.hello({ documentId: "next-page" })).toEqual({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(executes()).toHaveLength(sent);
        expect(at(origin)).toMatchObject({
          id: record!.id,
          state: "blocked",
          outcome: "challenge",
        });
        expect(fake.state.session["pateat.login-stopped-asks.v1"] ?? []).toEqual([]);
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: false,
          reason: "origin-busy",
        });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it("ends another tab's hold 5 minutes after its record last changed, not after a resume", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
      const [record] = stored();
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
      try {
        // The login was stopped by a challenge 6 minutes ago and its tab was left open.
        const changedAt = Date.now() - 6 * 60_000;
        fake.state.storage["pateat.login-attempts.v3"] = [
          {
            ...record!,
            state: "blocked",
            outcome: "challenge",
            mutationIntent: undefined,
            ...idle,
            changedAt,
          },
        ];
        fake.state.onExecute = undefined;
        const restarted = twoSites();
        // Its tab's page announces again after the restart; the unchanged record keeps its time.
        await restarted.hello({ documentId: "challenge-page" }, false);
        expect(at(origin)).toMatchObject({ state: "blocked", outcome: "challenge", changedAt });
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: true,
        });
      } finally {
        fake.browser.tabs.query = query;
      }
    });
    it(
      "keeps the time a held login last progressed when its tab shows another page",
      { timeout: 10_000 },
      async () => {
        holdClicks(origin);
        const h = twoSites();
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(at(origin)).toMatchObject({ state: "submit-intent" }));
        const [record] = stored();
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        try {
          // The result stayed unknown 6 minutes ago and its tab was left open.
          const changedAt = Date.now() - 6 * 60_000;
          fake.state.storage["pateat.login-attempts.v3"] = [
            {
              ...record!,
              state: "reconciling",
              outcome: "unknown-submit",
              settled: true,
              changedAt,
            },
          ];
          fake.state.onExecute = undefined;
          // The user browses on to a page that is neither the completion nor the next step.
          fake.state.observedPath = "/elsewhere";
          const restarted = twoSites();
          expect(await restarted.hello({ documentId: "after-login" })).toEqual({ ok: true });
          await vi.waitFor(
            () =>
              expect(at(origin)).toMatchObject({
                state: "reconciling",
                outcome: "unknown-submit",
                settled: true,
                document: { documentId: "after-login" },
              }),
            { timeout: 6000 },
          );
          // A new page is not the login's progress, so the hold has ended.
          expect(at(origin)?.changedAt).toBe(changedAt);
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await restarted.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
            ok: true,
          });
        } finally {
          fake.browser.tabs.query = query;
        }
      },
    );
    it("keeps another tab off an origin whose login still runs, and says why", async () => {
      holdClicks(origin);
      const h = twoSites();
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executes()).toHaveLength(2));
      expect(at(origin)).toMatchObject({ state: "submit-intent" });
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
        ok: false,
        reason: "origin-busy",
      });
      expect(fake.state.badges[2]?.title).toBe(
        "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait 5 minutes and reload this page, to log in here.",
      );
      expect(executes()).toHaveLength(2);
      // Once that tab closes, this tab logs in and its tooltip is reset.
      fake.state.onExecute = undefined;
      for (const listener of fake.state.removed) listener(1);
      await vi.waitFor(() => expect(stored()).toEqual([]));
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab-again" })).toEqual({
        ok: true,
      });
      expect(fake.state.badges[2]?.title).toBe("Pateat");
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
      fake.state.storage["pateat.login-attempts.v3"] = [
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
    it("lets another tab start only once an authenticated login saved its choice", async () => {
      // Saving bumps the policy revision, which would stop a login started meanwhile.
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const h = harness(unsaved, { allowedOrigins: [], uris });
      const update = h.store.update.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      h.store.update.mockImplementationOnce(async (...args) => {
        await held;
        return update(...args);
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      fake.state.tabUrls[2] = fake.state.pageUrl;
      // The other tab waits for the save, then is admitted again with the new revision.
      const other = h.hello({ tab: { id: 2 }, documentId: "other-tab" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(executes()).toHaveLength(2);
      release();
      expect(await other).toEqual({ ok: true });
      expect(h.settings.settings.siteDefaults).toHaveLength(1);
      // Checked against the saved revision, it is not stopped as a policy change.
      await vi.waitFor(() =>
        expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
          { state: "authenticated", document: { tabId: 1 } },
          { state: "authenticated", document: { tabId: 2 } },
        ]),
      );
      await vi.waitFor(() => expect(executes()).toHaveLength(4));
    });
    it("logs in with the only URI-matched item and saves the choice after authenticated", async () => {
      const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, { allowedOrigins: [], uris, report });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      // The log names how the account was chosen, and that the choice was saved.
      const decisions = () =>
        report.mock.calls
          .map(([entry]) => entry)
          .filter((entry) => entry.type === "start" || entry.type === "choice");
      await vi.waitFor(() => expect(decisions()).toHaveLength(2));
      expect(decisions()).toEqual([
        {
          type: "start",
          tabId: 1,
          origin,
          recipeId: recipe.id,
          route: "password",
          variant: 0,
          account: "match",
          candidates: 1,
          itemId,
        },
        { type: "choice", tabId: 1, origin, outcome: "saved" },
      ]);
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
      const noSigns = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };
      const afterClick =
        (present: string[], path: string, unusable: string[] = []) =>
        async (message: Record<string, unknown>) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set(present);
          fake.state.unusable = new Set(unusable);
          fake.state.observedPath = path;
        };
      it("completes on the marker shown on another path once the sign-in state agrees (ADR 0029)", async () => {
        fake.state.present = new Set(["password", "login"]);
        fake.state.signs = noSigns;
        fake.state.onExecute = afterClick(["authenticated"], "/home");
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          report,
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"state":"authenticated"'), {
          timeout: 8_000,
        });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "state", s1: false, e1: true, decision: "signed-in" }),
        );
      }, 12_000);
      it("never counts the marker while a hidden field must still be gone on its path", async () => {
        fake.state.present = new Set(["password", "login"]);
        fake.state.signs = noSigns;
        // A failed sign-in hides the form again on the completion's own path.
        fake.state.onExecute = afterClick(["authenticated", "password"], "/signin", ["password"]);
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris: async () => ({ ok: true, data: uriMatch() }),
          report,
        });
        h.recipes.recipe.mockResolvedValue(learned);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(published()).toContain('"outcome":"unknown-submit"'), {
          timeout: 6_000,
        });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "state", s1: false, e1: false, decision: "judge" }),
        );
        expect(published()).not.toContain('"state":"authenticated"');
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
    it("saves the choice next to a login whose result settled as unknown", async () => {
      const second = "https://second.example";
      const { completion: _unlearned, ...generated } = recipe;
      const h = harness(
        {
          siteDefaults: [{ origin: second, provider: "bitwarden", userId, itemId }],
          bindings: [],
        },
        { allowedOrigins: [second], uris: async () => ({ ok: true, data: uriMatch() }) },
      );
      h.recipes.recipe.mockImplementation(async (at: string) =>
        at === origin ? recipe : at === second ? { ...generated, origin: second } : undefined,
      );
      fake.state.tabUrls[2] = `${second}/signin`;
      const attempts = () =>
        (fake.state.storage["pateat.login-attempts.v3"] ?? []) as Record<string, unknown>[];
      expect(await h.hello({ tab: { id: 2 }, url: `${second}/signin` })).toEqual({ ok: true });
      // The record stays until its tab closes; it must not hold the choice off for as long.
      await vi.waitFor(
        () => expect(attempts()).toMatchObject([{ state: "reconciling", settled: true }]),
        { timeout: 6_000 },
      );
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(h.store.update).toHaveBeenCalledTimes(1));
      expect(h.settings.settings.siteDefaults).toContainEqual(
        expect.objectContaining({ origin, itemId }),
      );
    }, 10_000);
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
    it.each<[string, Awaited<ReturnType<LiveUriMatcher>>, string, Partial<LoginReport>]>([
      ["two items match", { ok: true, data: both }, "account-ambiguous", { candidates: 2 }],
      [
        "no item matches",
        { ok: true, data: uriMatch({ candidates: [] }) },
        "default-not-set",
        { detail: "no-uri-match" },
      ],
      [
        "another item's rules could not be evaluated",
        { ok: true, data: uriMatch({ unavailableItemIds: [otherItemId] }) },
        "item-uri-unevaluated",
        {},
      ],
      ["the vault is locked", vaultFailure("crypto-locked"), "vault-unavailable", {}],
    ])("refuses before any field read when %s", async (_name, answer, reason, logged) => {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, { allowedOrigins: [], uris: async () => answer, report });
      expect(await h.hello()).toEqual({ ok: false, reason });
      // The log says how many accounts could answer, or that no vault item matched.
      expect(report).toHaveBeenCalledWith({ type: "refused", tabId: 1, origin, reason, ...logged });
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
      it("offers a choice on a new page of a tab whose login Pateat stopped, once its default is removed", async () => {
        // In the owner's Chrome, removing github.com's default stopped its login as
        // `policy-changed`; the reloaded page was refused for several accounts and the popup
        // offered nothing, because the page resumed the stopped record.
        const h = harness({}, { uris: async () => ({ ok: true, data: both }) });
        fake.state.onAwait = () => {
          h.settings.revision += 1;
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
            { state: "blocked", outcome: "policy-changed" },
          ]),
        );
        fake.state.onAwait = undefined;
        h.settings.settings.siteDefaults = [];
        h.settings.revision += 1;
        const next = { documentId: "synthetic-next" };
        expect(await h.hello(next)).toEqual({ ok: false, reason: "account-ambiguous" });
        expect(fake.state.storage["pateat.login-attempts.v3"]).toEqual([]);
        expect(await ask(h)).toEqual({ ...offered, documentId: "synthetic-next" });
        fake.state.onReconnect = () => h.hello(next);
        expect(await pick(h, next)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
            { account: { itemId: otherItemId }, document: { documentId: "synthetic-next" } },
          ]),
        );
      });
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
      it("offers the choice after a restart when a newer announcement overtakes the asked one", async () => {
        await refused();
        const restarted = matching();
        // The worker's reconnect of every tab announces the document again while the
        // popup's reconnect is still admitted, so the popup's answer comes back stale.
        let overtaken: Promise<unknown> | undefined;
        fake.state.onReconnect = async () => {
          const asked = restarted.hello();
          overtaken = restarted.hello();
          return asked;
        };
        expect(await ask(restarted)).toEqual(offered);
        expect(await overtaken).toEqual({ ok: false, reason: "account-ambiguous" });
      });
      it("ends the choice after a restart once the page can no longer be admitted", async () => {
        await refused();
        const restarted = matching();
        fake.state.onReconnect = () => restarted.hello();
        // Site access was withdrawn while the worker slept; the page answers but is refused.
        fake.state.granted = false;
        expect(await ask(restarted)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.badges[1]).toEqual({ text: "", title: "Pateat" });
        // The open popup asking again sends no further reconnects.
        expect(await ask(restarted)).toEqual({ ok: false, reason: "no-choice" });
        expect(fake.state.reconnects).toHaveLength(1);
      });
      it("says the pick waits while another tab's login holds the site, and keeps the choice", async () => {
        // Another tab logs in to the site with its saved default and is still running.
        fake.state.onExecute = () => new Promise(() => undefined);
        fake.state.tabUrls[2] = fake.state.pageUrl;
        expect(await harness().hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
          ok: true,
        });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v3"]).toHaveLength(1),
        );
        // The other tab stays open, so its record outlives this worker's start.
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }, { id: 2 }] as never;
        try {
          const h = await refused();
          expect(await ask(h)).toEqual({ ...offered, held: true });
          const sent = fake.state.reconnects.length;
          expect(await pick(h)).toEqual({ ok: false, reason: "origin-busy" });
          // Nothing was sent to the page, and the choice still waits for a later pick.
          expect(fake.state.reconnects).toHaveLength(sent);
          expect(fake.state.session["pateat.login-picks.v1"] ?? []).toEqual([]);
          expect(await ask(h)).toEqual({ ...offered, held: true });
          expect(fake.state.badges[1]?.text).toBe("2");
        } finally {
          fake.browser.tabs.query = query;
        }
      });
      it("keeps the choice when another tab's login starts holding the site during the pick", async () => {
        const h = await refused();
        fake.state.onExecute = () => new Promise(() => undefined);
        fake.state.tabUrls[2] = fake.state.pageUrl;
        const other = { tab: { id: 2 }, documentId: "other-tab" };
        expect(await h.hello(other)).toEqual({ ok: false, reason: "account-ambiguous" });
        fake.state.onReconnect = async () => {
          if (fake.state.reconnects.at(-1)?.tabId === 2) return h.hello(other);
          // Another tab's pick starts its login before this page announces again.
          expect(await pick(h, { tabId: 2, documentId: "other-tab", itemId })).toEqual({
            ok: true,
          });
          return h.hello();
        };
        expect(await pick(h)).toEqual({ ok: false, reason: "origin-busy" });
        // The page does not announce again when the hold ends, so the choice stays.
        expect(await ask(h)).toEqual({ ...offered, held: true });
        expect(fake.state.badges[1]?.text).toBe("2");
      });
      it("starts the pick when a newer announcement of the page overtakes the asked one", async () => {
        const h = await refused();
        // The page announces twice, for example after a worker restart; the pick's own
        // announcement comes back stale and the newer one takes the pick.
        let overtaken: Promise<unknown> | undefined;
        fake.state.onReconnect = async () => {
          const asked = h.hello();
          overtaken = h.hello();
          return asked;
        };
        expect(await pick(h)).toEqual({ ok: true });
        expect(await overtaken).toEqual({ ok: true });
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
          "pateat.login-logout-fills.v1": [],
          "pateat.login-stopped-asks.v1": [],
        });
        for (const listener of fake.state.removed) listener(1);
        await vi.waitFor(() =>
          expect(fake.state.session).toEqual({
            "pateat.login-picks.v1": [],
            "pateat.login-choices.v1": [],
            "pateat.login-logouts.v1": [],
            "pateat.login-logout-fills.v1": [],
            "pateat.login-stopped-asks.v1": [],
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
        h.recipes.starts.mockImplementation(async () => startsOf([recipe.steps[0]!]));
        fake.state.tabUrls[1] = `${second}/signin`;
        expect(await h.hello({ url: `${second}/signin` })).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
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
          fake.state.storage["pateat.login-attempts.v3"] as { id: string; state: string }[];
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
        const steps = () =>
          fake.state.messages
            .filter((entry) => entry.type === "login.execute")
            .map(
              (entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step,
            );
        /**
         * The form shows after a logout: the saved default fills it once without a click and
         * the record is forgotten; the document then announces again and asks.
         */
        const filledOnly = async (
          h: ReturnType<typeof harness>,
          from: Record<string, unknown> = {},
        ) => {
          const before = steps().length;
          expect(await h.hello(from)).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(before + 1));
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          expect(steps().at(-1)?.kind).toBe("fill");
          // The tab asks as soon as the fill ends.
          const tabId = (from["tab"] as { id: number } | undefined)?.id ?? 1;
          expect(fake.state.badges[tabId]?.text).toBe("2");
          // The content script announces again on the ended status, without a start.
          expect(await h.hello(from, false)).toMatchObject({
            ok: false,
            reason: "form-not-ready",
          });
          expect(fake.state.badges[tabId]?.text).toBe("2");
          // The form showing again in the same document only asks.
          expect(await h.hello(from)).toEqual({ ok: false, reason: "logged-out" });
        };
        const attempts = () =>
          fake.state.storage["pateat.login-attempts.v3"] as {
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
          await filledOnly(h, { documentId: "signed-out" });
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          return h;
        };
        it("never clicks the account switch while it only fills, and asks", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), username: true },
          );
          h.recipes.recipe.mockResolvedValue(
            parseLoginRecipe({
              ...recipe,
              accountSwitch: { by: "text", value: "Use another account" },
            }),
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The login page after the logout shows another account than the one to fill.
          fake.state.executeReply = { ok: false, reason: "wrong-account", switchable: true };
          const before = steps().length;
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(before + 1));
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          const sent = fake.state.messages.filter((entry) => entry.type === "login.execute");
          expect(sent.at(-1)!.accountSwitch).toBeUndefined();
          expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.switch");
          // The fill-only record is forgotten and the tab asks.
          expect(attempts()).toEqual([]);
          expect(fake.state.badges[1]?.text).toBe("2");
        });
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
          await filledOnly(h);
          expect(fake.state.badges[1]?.text).toBe("2");
        });
        it("fills again after a reload or a worker restart and keeps asking", async () => {
          await loggedOut();
          const restarted = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          // The document that was filled is not filled again by a restarted worker.
          expect(await restarted.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "logged-out",
          });
          expect(restarted.fields).not.toHaveBeenCalled();
          await filledOnly(restarted, { documentId: "reloaded" });
          expect(restarted.fields).toHaveBeenCalledTimes(1);
          expect(logouts()).toEqual([{ tabId: 1, origin }]);
          // Nothing was ever clicked after the logout.
          expect(steps().map((step) => step.kind)).toEqual(["fill", "click", "fill", "fill"]);
        });
        it("forgets a fill-only record a stopped worker left ended", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          const [done] = attempts();
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
          // As a worker that stopped after ending the fill, before forgetting it, leaves it.
          fake.state.storage["pateat.login-attempts.v3"] = [
            { ...done, fillOnly: true, state: "blocked", outcome: "cancelled" },
          ];
          const restarted = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          await filledOnly(restarted, { documentId: "reloaded" });
          expect(attempts()).toEqual([]);
        });
        it("does not hold the site for other tabs while a tab only fills", async () => {
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }) },
          );
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // The fill after the logout never answers, so it stays running.
          fake.state.onExecute = () => new Promise(() => undefined);
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(3));
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() => expect(steps()).toHaveLength(4));
          expect(steps().map((step) => step.kind)).toEqual(["fill", "click", "fill", "fill"]);
        });
        it("asks without filling when several accounts match and none is the default", async () => {
          const h = harness(unsaved, {
            allowedOrigins: [],
            uris: async () => ({ ok: true, data: both }),
          });
          expect(await h.hello()).toEqual({ ok: false, reason: "account-ambiguous" });
          fake.state.onReconnect = () => h.hello();
          expect(await pick(h)).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          const before = steps().length;
          expect(await h.hello({ documentId: "signed-out" })).toEqual({
            ok: false,
            reason: "logged-out",
          });
          expect(steps()).toHaveLength(before);
        });
        it("logs a sign-in form that is not taken as a logout, and which tab logged out", async () => {
          const report = vi.fn<(report: LoginReport) => void>();
          const h = harness(
            {},
            { allowedOrigins: [], uris: async () => ({ ok: true, data: both }), report },
          );
          const refusals = () =>
            report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");
          expect(await h.hello()).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toMatchObject([{ state: "authenticated" }]));
          // A sign-in input whose form is not the recipe's first step: still logged in.
          const watching = { ok: false, reason: "logged-in", starts: [signinStart] };
          expect(await shownHello(h, { documentId: "home" })).toEqual(watching);
          expect(await shownHello(h, { documentId: "home" })).toEqual(watching);
          expect(refusals()).toEqual([
            { type: "refused", tabId: 1, origin, reason: "not-started", detail: "logged-in" },
          ]);
          // The fill after the logout ends asking, and that is logged with the tab that
          // logged out; the content script does not announce a start again for that form.
          expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(refusals().at(-1)).toMatchObject({ reason: "logged-out", detail: "this-tab" }),
          );
          fake.state.tabUrls[2] = fake.state.pageUrl;
          expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(refusals().at(-1)).toMatchObject({
              tabId: 2,
              reason: "logged-out",
              detail: "other-tab",
            }),
          );
          expect(refusals().filter((entry) => entry.reason === "logged-out")).toHaveLength(2);
          // The logout itself, and each login with how its account was chosen.
          const decisions = report.mock.calls
            .map(([entry]) => entry)
            .filter((entry) => entry.type === "start" || entry.type === "logout");
          expect(decisions).toEqual([
            expect.objectContaining({ type: "start", tabId: 1, account: "default" }),
            { type: "logout", tabId: 1, origin, recipeId: recipe.id },
            expect.objectContaining({
              type: "start",
              tabId: 1,
              account: "default",
              candidates: 2,
              fillOnly: true,
            }),
            expect.objectContaining({ type: "start", tabId: 2, fillOnly: true }),
          ]);
          expect(decisions[0]).not.toHaveProperty("itemId");
        });
        it("asks in other tabs of the site while it asks, and a pick there logs in", async () => {
          const h = await loggedOut();
          // Cookies are shared: another tab must not log in again behind the user's logout,
          // so it asks too.
          fake.state.tabUrls[2] = fake.state.pageUrl;
          await filledOnly(h, { tab: { id: 2 }, documentId: "other-tab" });
          expect(fake.state.badges[2]).toEqual({
            text: "2",
            title:
              "Pateat: you logged out of this site in another tab. Click to choose an account.",
          });
          expect(h.fields).toHaveBeenCalledTimes(3);
          fake.state.onReconnect = () => h.hello({ tab: { id: 2 }, documentId: "other-tab" });
          expect(await pick(h, { tabId: 2, documentId: "other-tab" })).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(attempts()).toMatchObject([
              { state: "authenticated", account: { itemId: otherItemId } },
            ]),
          );
          // The tab that logged out still asks, and its pick may log in over that login.
          expect(logouts()).toEqual([{ tabId: 1, origin }]);
          fake.state.onReconnect = () => h.hello({ documentId: "signed-out" });
          expect(await pick(h, { documentId: "signed-out", itemId })).toEqual({ ok: true });
          await vi.waitFor(() => expect(attempts()).toHaveLength(2));
          expect(logouts()).toEqual([]);
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
    it("uses a binding saved for another vault account only as a template", async () => {
      const other = { ...branchBinding, userId: "70000000-0000-4000-8000-000000000002" };
      // The template's field name must resolve on this item (ADR 0027).
      const missing = harness(
        { bindings: [other] },
        { custom: [{ name: "Region", kind: "text" }] },
      );
      missing.recipes.recipe.mockResolvedValue(branchRecipe);
      expect(await missing.hello()).toEqual({ ok: false, reason: "field-missing" });
      expect(missing.fields).not.toHaveBeenCalled();
      expect(executes()).toEqual([]);
      expect(missing.store.update).not.toHaveBeenCalled();
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
        // Like the service, each says just before the request leaves the device.
        generate: vi.fn<LoginGeneration["generate"]>(async (request, sent) => {
          sent?.();
          return (
            implementation.generate ??
            (async () => ({ outcome: "abstained", reason: "ambiguous" }) as const)
          )(request);
        }),
        judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
          args[4]?.();
          return (implementation.judge ?? (async () => ({ verdict: "unclear" }) as const))(...args);
        }),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(
          implementation.slotFields ?? (async () => undefined),
        ),
      };
    }
    const uris = async () => ({ ok: true as const, data: uriMatch() });
    const status = () => fake.state.storage["pateat.login-attempts.v3"];

    it("sends a matching sign-in page for generation and runs the returned recipe", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      // An item without custom fields offers only built-in slots.
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
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
        h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
        return { outcome: "recipe", recipe: generated };
      });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.reconnect"),
      );
      expect(service.available).toHaveBeenCalledWith(origin, "/signin");
      // Only slots the matching item can fill are offered.
      // The username's shape goes with its slot; the value itself never does.
      expect(service.generate).toHaveBeenCalledWith(
        {
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
        },
        expect.any(Function),
      );
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

    it("logs a page sent for generation, then the answer", async () => {
      fake.state.extracted = { login: loginPage };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      const generations = () =>
        report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "generation");
      await vi.waitFor(() => expect(generations()).toHaveLength(2));
      expect(generations()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "sent" },
        { type: "generation", tabId: 1, origin, outcome: "abstained", reason: "ambiguous" },
      ]);
    });

    it("logs a page whose description threw before it was sent", async () => {
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        custom: [],
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toMatchObject({ generate: true });
      // The page stops answering, as while it is replaced.
      fake.state.gone.add("synthetic-document");
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith({
          type: "generation",
          tabId: 1,
          origin,
          outcome: "skipped",
          reason: "exception",
        }),
      );
      expect(service.generate).not.toHaveBeenCalled();
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
            custom: [],
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
        h.recipes.starts.mockResolvedValue(startsOf([]));
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
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris: async () => ({ ok: true, data: uriMatch({ candidates: [] }) }),
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(report).toHaveBeenCalledWith({
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "no-vault-match",
      });
      expect(service.generate).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });

    it.each([
      ["the extractor's refusal", { ok: false, reason: "no-locator" }, "no-locator"],
      ["an answer that fails its check", { ok: true }, "extract-failed"],
    ] as const)(
      "logs %s when the page cannot be described",
      async (_name, extracted, reason) => {
        fake.state.extracted = { login: extracted };
        const service = generation();
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        // Read three times a second apart, as a form rendered in steps may still settle.
        await vi.waitFor(
          () =>
            expect(report).toHaveBeenCalledWith({
              type: "generation",
              tabId: 1,
              origin,
              outcome: "skipped",
              reason,
            }),
          { timeout: 4_000 },
        );
        expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toHaveLength(
          3,
        );
        expect(service.generate).not.toHaveBeenCalled();
      },
      10_000,
    );

    it("stops at once for a cancelled document", async () => {
      fake.state.extracted = { login: { ok: false, reason: "cancelled" } };
      const service = generation();
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "generation", outcome: "skipped", reason: "cancelled" }),
        ),
      );
      expect(fake.state.messages.filter((entry) => entry.type === "login.extract")).toHaveLength(1);
    });

    it("reads a page again that could not be described yet", async () => {
      fake.state.extracted = { login: { ok: false, reason: "no-locator" } };
      const service = generation();
      const h = harness(unsaved, { allowedOrigins: [], uris, username: true, generation: service });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      // The form finishes rendering before the next read.
      fake.state.extracted = { login: loginPage };
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalled(), { timeout: 4_000 });
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        observation: loginPage.observation,
      });
    }, 10_000);

    it("offers nothing for a page sent recently, a path a recipe starts on, a frame or an incomplete description", async () => {
      const service = generation({ available: async () => "sent" as const });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(await h.hello({}, false)).toEqual({ ok: false, reason: "recipe-not-found" });
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      // The log says once per document why a page with no recipe is not sent.
      const generations = () =>
        report.mock.calls.flatMap(([value]) => (value.type === "generation" ? [value] : []));
      expect(generations()).toEqual([
        { type: "generation", tabId: 1, origin, outcome: "skipped", reason: "sent" },
      ]);

      service.available.mockResolvedValue(true);
      // Recipes that start on this path (two, so neither is selected), or an unreadable cache.
      fake.state.extracted = { login: loginPage };
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!, generated.steps[0]!]));
      expect(await h.signIn()).not.toHaveProperty("generate");
      h.recipes.starts.mockRejectedValue(new Error("cache"));
      expect(await h.signIn()).toEqual({ ok: false, reason: "recipe-not-found" });
      h.recipes.starts.mockResolvedValue(startsOf([]));
      expect(service.generate).not.toHaveBeenCalled();

      fake.state.extracted = {
        login: { ...loginPage, observation: { ...loginPage.observation, complete: false } },
      };
      expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() =>
        expect(fake.state.messages.map((entry) => entry.type)).toContain("login.extract"),
      );
      await vi.waitFor(
        () =>
          expect(generations().at(-1)).toEqual({
            type: "generation",
            tabId: 1,
            origin,
            outcome: "skipped",
            reason: "incomplete-observation",
          }),
        { timeout: 4_000 },
      );
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
    }, 10_000);

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
      h.recipes.starts.mockResolvedValue(startsOf([generated.steps[0]!]));
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
        expect.any(Function),
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
        const service = generation({
          judge: async () => ({ verdict, ...(verdict === "unclear" ? { reason: "timeout" } : {}) }),
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
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
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toEqual([
          {
            type: "judge",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            route: "password",
            verdict: "sent",
          },
          {
            type: "judge",
            tabId: 1,
            origin,
            recipeId: generated.id,
            recipeRevision: generated.revision,
            route: "password",
            verdict,
            ...(verdict === "unclear" ? { reason: "timeout" } : {}),
          },
        ]);
        // The log's last word on the login: it ended, or its result settled as unknown.
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          ...expected,
          ...(verdict === "unclear" ? { settled: true } : {}),
        });
        expect(
          report.mock.calls.filter(([value]) => value.type === "attempt" && value.settled),
        ).toHaveLength(verdict === "unclear" ? 1 : 0);
      },
      10_000,
    );

    it.each([
      [
        "an incomplete description",
        { ...homePage, gap: "unfillable-field" as const },
        "unfillable-field",
      ],
      ["a refused description", { ok: false, reason: "no-candidates" }, "no-candidates"],
    ])(
      "reports why it does not send %s",
      async (_label, extracted, reason) => {
        fake.state.extracted = {
          "signed-in":
            "observation" in extracted
              ? { ...extracted, observation: { ...extracted.observation, complete: false } }
              : extracted,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(service.judge).not.toHaveBeenCalled();
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "judge" ? [value] : [])),
        ).toContainEqual({
          type: "judge",
          tabId: 1,
          origin,
          recipeId: generated.id,
          recipeRevision: generated.revision,
          route: "password",
          verdict: "not-sent",
          reason,
        });
      },
      10_000,
    );

    it("does not send the page while the recipe's fields are still shown", async () => {
      fake.state.extracted = { "signed-in": homePage };
      const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(unsaved, {
        allowedOrigins: [],
        uris,
        username: true,
        generation: service,
        report,
      });
      h.recipes.recipe.mockResolvedValue(generated);
      fake.state.present = new Set(["user", "password", "login"]);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
      // The log says why.
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "sign-in-shown" }),
      );
    }, 10_000);

    describe("the sign-in state (ADR 0029)", () => {
      it("logs a passkey request after the submission, but not one before it", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        // The sign-in page's own request, before the submission, does not count.
        h.login.passkeyRequested(1, origin);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          setTimeout(() => h.login.passkeyRequested(1, origin), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s1: false, s5: true, decision: "continuing" })]);
      }, 10_000);

      it("does not count a passkey request made before the submission", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        h.login.passkeyRequested(1, origin);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s5: false, decision: "judge" })]);
      }, 10_000);

      it("does not count a passkey request of another origin", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
        };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          setTimeout(() => h.login.passkeyRequested(1, "https://other.example"), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 6_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ s5: false, decision: "judge" })]);
      }, 10_000);

      const noSigns = {
        password: false,
        code: false,
        captcha: false,
        invalid: false,
        alert: false,
      };

      it("logs a failure shown next to the sign-in fields, comparing the username in the page", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, password: true, alert: true, username: false };
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          { timeout: 6_000 },
        );
        expect(report).toHaveBeenCalledWith({
          type: "state",
          tabId: 1,
          origin,
          recipeId: generated.id,
          route: "password",
          ...{ s1: true, s2: true, s3: false, s4: false, s5: false, f1: false, f2: true },
          ...{ e1: false, e2: false, e3: false },
          decision: "rejected",
        });
        // The username goes to the page for its comparison; what happens is unchanged.
        expect(fake.state.messages.find((entry) => entry.type === "login.state")?.account).toEqual({
          username: "synthetic-secret",
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);

      it("logs reaching the return target the sign-in page's URL named, before the judge", async () => {
        fake.state.pageUrl = `${origin}/signin?return_to=%2Fhome`;
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = noSigns;
        const service = generation({ judge: async () => ({ verdict: "signed-in" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          // The click loads the return target in a new document.
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
          fake.state.pageUrl = `${origin}/home`;
          setTimeout(() => void h.hello({ documentId: "document-home" }, false), 0);
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        const states = report.mock.calls.flatMap(([value]) =>
          value.type === "state" ? [value] : [],
        );
        expect(states).toEqual([
          expect.objectContaining({ s1: false, s5: false, e3: true, decision: "signed-in" }),
        ]);
        // Read twice, a second apart, and completed without a model call.
        expect(fake.state.messages.filter((entry) => entry.type === "login.state")).toHaveLength(2);
        expect(service.judge).not.toHaveBeenCalled();
      }, 12_000);

      it("completes when the username shows in the header, without the judge", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 8_000,
        });
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({ type: "state", e2: true, decision: "signed-in" }),
        );
        expect(service.judge).not.toHaveBeenCalled();
      }, 12_000);

      it("waits for the document to finish loading before it completes", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
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
        await vi.waitFor(
          () =>
            expect(
              fake.state.messages.filter((entry) => entry.type === "login.state").length,
            ).toBeGreaterThanOrEqual(3),
          { timeout: 10_000, interval: 10 },
        );
        expect(status()).not.toMatchObject([{ state: "authenticated" }]);
        fake.state.loaded = true;
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 4_000,
        });
        expect(service.judge).not.toHaveBeenCalled();
      }, 20_000);

      it("leaves the page to the judge when the document never finishes loading", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
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
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 16_000 });
        expect(status()).not.toMatchObject([{ state: "authenticated" }]);
      }, 20_000);

      it("leaves the page to the judge when the second reading shows no evidence", async () => {
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
        const service = generation({ judge: async () => ({ verdict: "unclear" }) });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness(unsaved, {
          allowedOrigins: [],
          uris,
          username: true,
          generation: service,
          report,
        });
        h.recipes.recipe.mockResolvedValue(generated);
        fake.state.present = new Set(["user", "password", "login"]);
        fake.state.onExecute = async (message) => {
          if ((message["operation"] as { step: { kind: string } }).step.kind !== "click") return;
          fake.state.present = new Set();
          fake.state.observedPath = "/home";
        };
        expect(await h.hello()).toEqual({ ok: true });
        // The header changes after the first reading, as on a page still redirecting.
        await vi.waitFor(
          () =>
            expect(
              fake.state.messages.filter((entry) => entry.type === "login.state"),
            ).toHaveLength(1),
          { timeout: 6_000, interval: 10 },
        );
        fake.state.signs = noSigns;
        await vi.waitFor(() => expect(service.judge).toHaveBeenCalled(), { timeout: 8_000 });
        expect(
          report.mock.calls.flatMap(([value]) => (value.type === "state" ? [value] : [])),
        ).toEqual([expect.objectContaining({ e2: false, decision: "judge" })]);
      }, 12_000);
    });

    describe("custom-field offers and their shapes (ADR 0027)", () => {
      const thirdItemId = "80000000-0000-4000-8000-000000000003";
      const matched =
        (ids: string[], extra: Partial<UriCandidates> = {}) =>
        async () => ({
          ok: true as const,
          data: uriMatch({
            candidates: ids.map((id) => ({ itemId: id, matches: [{ uriIndex: 0, match: 0 }] })),
            ...extra,
          }),
        });
      const field = (index: number) => `custom.${snapshotId}.${index}`;
      const digits = (length: number) => ({ length, classes: ["ascii-digit"], email: false });
      /** Sends the sign-in page and answers each read from `values`, keyed by item and field. */
      async function sendPage(
        values: Record<string, string | undefined>,
        live: Parameters<typeof harness>[1],
        overrides: Partial<LocalSettings> = {},
      ) {
        fake.state.extracted = { login: loginPage };
        const service = generation();
        const h = harness(
          { ...unsaved, ...overrides },
          {
            allowedOrigins: [],
            uris: matched([itemId, otherItemId]),
            generation: service,
            ...live,
          },
        );
        h.fields.mockImplementation(
          async ({ account, fieldId }) =>
            // Synthetic values only; a missing key is a read that gives nothing.
            values[`${account.itemId} ${fieldId}`],
        );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
        expect(await h.signIn()).toEqual({ ok: false, reason: "generating" });
        await vi.waitFor(() => expect(service.generate).toHaveBeenCalled());
        const request = service.generate.mock.calls[0]![0];
        return {
          request,
          custom: request.slots.filter((slot) => slot.fieldName !== undefined),
          reads: h.fields.mock.calls.map(([read]) => `${read.account.itemId} ${read.fieldId}`),
        };
      }
      const twoItems = {
        custom: [
          { name: "Branch", kind: "text" as const },
          { name: "PIN", kind: "hidden" as const },
        ],
        otherCustom: [{ name: "Branch", kind: "text" as const }],
      };

      it("offers the matching items' fields by name and shapes a Text field they agree on", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: "456" },
          twoItems,
        );
        expect(sent.custom).toEqual([
          {
            id: "custom-1",
            kind: "identifier",
            description: "value of the user's vault field named in fieldName",
            fieldName: "Branch",
            valueShape: digits(3),
          },
          {
            id: "custom-2",
            kind: "hidden",
            description:
              "concealed value of the user's vault field named in fieldName, such as a PIN",
            fieldName: "PIN",
          },
        ]);
        // A Hidden value is never read for a shape, and no value is sent.
        expect(sent.reads).toEqual([`${itemId} ${field(0)}`, `${otherItemId} ${field(0)}`]);
        expect(JSON.stringify(sent.request)).not.toMatch(/123|456|Synthetic item/u);
      });

      it.each<[string, string | undefined, object | undefined]>([
        ["another length", "4567", undefined],
        ["other characters", "4b6", undefined],
        ["an unreadable value", undefined, undefined],
        ["a value too long to shape", "1".repeat(1025), undefined],
        ["an empty value, which does not count", "", digits(3)],
      ])("sends a Text shape only when the items agree: %s", async (_label, other, shape) => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: other },
          twoItems,
        );
        expect(sent.custom[0]!.valueShape).toEqual(shape);
        expect(sent.custom.map((slot) => slot.fieldName)).toEqual(["Branch", "PIN"]);
      });

      it("offers a field an item excludes only from the items that allow it", async () => {
        const settings = (excluded: object) => ({
          connections: [
            {
              connectionId,
              enabled: true,
              selection: { mode: "all" as const, groupIds: [], itemIds: [] },
              excludedItemIds: [],
              excludedFields: [],
              ...excluded,
            },
          ],
        });
        const values = { [`${itemId} ${field(0)}`]: "1", [`${otherItemId} ${field(0)}`]: "4567" };
        const field0 = await sendPage(
          values,
          twoItems,
          settings({ excludedFields: [{ itemId, fieldId: field(0) }] }),
        );
        // Offers are numbered in the order the items' fields are found.
        expect(field0.custom.map((slot) => [slot.id, slot.fieldName, slot.valueShape])).toEqual([
          ["custom-1", "PIN", undefined],
          ["custom-2", "Branch", digits(4)],
        ]);
        expect(field0.reads).toEqual([`${otherItemId} ${field(0)}`]);
        // An excluded item offers no field and is never read.
        const item = await sendPage(values, twoItems, settings({ excludedItemIds: [otherItemId] }));
        expect(item.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", digits(1)],
          ["PIN", undefined],
        ]);
        expect(item.reads).toEqual([`${itemId} ${field(0)}`]);
      });

      it("offers nothing from an item awaiting review and reads none of its values", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${otherItemId} ${field(0)}`]: "4567" },
          { ...twoItems, quarantined: true },
        );
        // Only the other item's field is offered and shaped; the reviewed item's PIN is not.
        expect(sent.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", digits(4)],
        ]);
        expect(sent.reads).toEqual([`${otherItemId} ${field(0)}`]);
      });

      it("shapes a Linked field that reads a Text field like that Text field", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123", [`${itemId} ${field(1)}`]: "123" },
          {
            custom: [
              { name: "Branch", kind: "text" },
              { name: "Branch copy", kind: "linked", linkedFieldId: field(0) },
            ],
          },
        );
        expect(sent.custom.map((slot) => [slot.fieldName, slot.kind, slot.valueShape])).toEqual([
          ["Branch", "identifier", digits(3)],
          ["Branch copy", "identifier", digits(3)],
        ]);
        expect(sent.reads).toEqual([`${itemId} ${field(0)}`, `${itemId} ${field(1)}`]);
      });

      it("offers names without shapes when an item could not be checked", async () => {
        const sent = await sendPage(
          { [`${itemId} ${field(0)}`]: "123" },
          {
            ...twoItems,
            uris: matched([itemId], { unavailableItemIds: [otherItemId] }),
          },
        );
        expect(sent.custom.map((slot) => [slot.fieldName, slot.valueShape])).toEqual([
          ["Branch", undefined],
          ["PIN", undefined],
        ]);
        expect(sent.reads).toEqual([]);
      });

      it("reads at most 32 values for shapes and sends the rest without one", async () => {
        const sixteen = Array.from({ length: 16 }, (_, index) => ({
          name: `Field ${index + 1}`,
          kind: "text" as const,
        }));
        const values = Object.fromEntries(
          [itemId, otherItemId, thirdItemId].flatMap((id) =>
            sixteen.map((_, index) => [`${id} ${field(index)}`, "12"]),
          ),
        );
        const sent = await sendPage(values, {
          custom: sixteen,
          otherCustom: sixteen,
          extraItems: [{ id: thirdItemId, custom: sixteen }],
          uris: matched([itemId, otherItemId, thirdItemId]),
        });
        expect(sent.custom).toHaveLength(16);
        // Each offer reads three values: ten fit in 32, and no offer is shaped in part.
        expect(sent.custom.map((slot) => slot.valueShape !== undefined)).toEqual([
          ...Array.from({ length: 10 }, () => true),
          ...Array.from({ length: 6 }, () => false),
        ]);
        expect(sent.reads).toHaveLength(30);
        expect(new Set(sent.reads).size).toBe(30);
      });
    });

    describe("a custom-slot binding built before the first login (ADR 0027)", () => {
      const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
      const sibling = (field: { custom: string }, extra: Partial<SavedLoginBinding> = {}) => ({
        ...branchBinding,
        itemId: otherItemId,
        itemName: "Other synthetic item",
        slots: [
          { slot: "branch", field },
          { slot: "password", field: "password" as const },
        ],
        ...extra,
      });
      const regionAndBranch = {
        custom: [
          { name: "Branch", kind: "text" as const },
          { name: "Region", kind: "text" as const },
        ],
      };
      async function login(
        bindings: SavedLoginBinding[],
        map: Awaited<ReturnType<LoginGeneration["slotFields"]>> | Error,
        live: Parameters<typeof harness>[1] = regionAndBranch,
        overrides: Partial<LocalSettings> = {},
      ) {
        const service = generation({
          available: async () => "sent" as const,
          slotFields: async () => {
            if (map instanceof Error) throw map;
            return map;
          },
        });
        const h = harness({ bindings, ...overrides }, { ...live, generation: service });
        h.recipes.recipe.mockResolvedValue(branchRecipe);
        return { h, service, answer: await h.hello() };
      }

      it("takes another item's saved binding first and saves the result after authenticated", async () => {
        const { h, service, answer } = await login(
          [sibling({ custom: "Branch" })],
          [{ slot: "branch", field: { custom: "Region" } }],
        );
        expect(answer).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
        expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
          `custom.${snapshotId}.0`,
          "login.password",
        ]);
        expect(service.slotFields).toHaveBeenCalledWith(branchRecipe.id);
        await vi.waitFor(() => expect(h.store.update).toHaveBeenCalled());
        expect(h.settings.settings.bindings).toContainEqual(
          expect.objectContaining({
            recipeId: branchRecipe.id,
            itemId,
            slots: [
              { slot: "branch", field: { custom: "Branch" } },
              { slot: "password", field: "password" },
            ],
          }),
        );
      });

      it("falls back to the generated map when no sibling binding resolves on the item", async () => {
        const { h, answer } = await login(
          [sibling({ custom: "Gone" })],
          [{ slot: "branch", field: { custom: "Region" } }],
        );
        expect(answer).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
        expect(h.fields.mock.calls[0]![0].fieldId).toBe(`custom.${snapshotId}.1`);
      });

      it("ignores a sibling binding of another origin or recipe", async () => {
        const { answer } = await login(
          [
            sibling({ custom: "Branch" }, { origin: "https://other.example" }),
            sibling({ custom: "Branch" }, { recipeId: "another-recipe" }),
          ],
          undefined,
        );
        expect(answer).toEqual({ ok: false, reason: "binding-not-found" });
      });

      it.each<[string, Awaited<ReturnType<LoginGeneration["slotFields"]>> | Error, string]>([
        ["no map", undefined, "binding-not-found"],
        ["an unreadable map", new Error("synthetic storage failure"), "binding-not-found"],
        [
          "a map without the slot",
          [{ slot: "region", field: { custom: "Region" } }],
          "binding-not-found",
        ],
        [
          "a map naming a missing field",
          [{ slot: "branch", field: { custom: "Gone" } }],
          "field-missing",
        ],
        [
          "a map whose same-name count changed",
          [{ slot: "branch", field: { custom: "Branch", position: 1, count: 3 } }],
          "field-count-changed",
        ],
      ])("stops before any read with %s", async (_label, map, reason) => {
        const { h, answer } = await login([], map);
        expect(answer).toEqual({ ok: false, reason });
        expect(h.fields).not.toHaveBeenCalled();
        expect(executes()).toEqual([]);
        expect(h.store.update).not.toHaveBeenCalled();
      });

      it("refuses a built binding whose field the item excludes", async () => {
        const { h, answer } = await login(
          [],
          [{ slot: "branch", field: { custom: "Branch" } }],
          regionAndBranch,
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
        );
        expect(answer).toEqual({ ok: false, reason: "binding-field-excluded" });
        expect(h.fields).not.toHaveBeenCalled();
      });

      it.each<[string, SavedLoginBinding[], Awaited<ReturnType<LoginGeneration["slotFields"]>>]>([
        ["a generated map", [], [{ slot: "branch", field: { custom: "PIN" } }]],
        ["another item's binding", [sibling({ custom: "PIN" })], undefined],
      ])(
        "marks a Hidden field bound from %s, so a plain text input refuses it",
        async (_label, bindings, map) => {
          // The content script's input rule, for the step's synthetic inputs: the branch
          // target is a plain text input and the password target a password input.
          const inputs: Record<"branch" | "password", SecretInput> = {
            branch: { type: "text", autocomplete: "", inputMode: "", maxLength: -1 },
            password: { type: "password", autocomplete: "", inputMode: "", maxLength: -1 },
          };
          fake.state.onExecute = async (message) => {
            const values = message["values"] as {
              slot: keyof typeof inputs;
              secret?: "password" | "otp" | "hidden";
            }[];
            if (values.some(({ slot, secret }) => !acceptsSecret(inputs[slot], secret)))
              fake.state.executeReply = { ok: false, reason: "structural-mismatch" };
          };
          const { h, answer } = await login(bindings, map, {
            custom: [{ name: "PIN", kind: "hidden" }],
          });
          expect(answer).toEqual({ ok: true });
          await vi.waitFor(() =>
            expect(fake.state.storage["pateat.login-attempts.v3"]).toMatchObject([
              { state: "blocked", outcome: "retry-limit", retries: 2, submissions: 0 },
            ]),
          );
          // The step is tried again twice, and the page refuses the same values each time.
          expect(executes()).toHaveLength(3);
          expect(executes()[2]!.values).toEqual([
            { slot: "branch", value: "synthetic-secret", secret: "hidden" },
            { slot: "password", value: "synthetic-secret", secret: "password" },
          ]);
          // A login that never filled is not authenticated, so nothing is saved.
          expect(h.store.update).not.toHaveBeenCalled();
        },
      );
    });
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
    fake.state.unusable = new Set();
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
    fake.state.storage["pateat.login-attempts.v3"] as Record<string, unknown>[] | undefined;
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
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      // Like the service, it says just before the request leaves the device.
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
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
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, passkeys ? { passkeys, report } : { report });
      h.recipes.recipe.mockResolvedValue(handled);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(clicks("Use security key")).toBe(0);
      expect(status()![0]).toMatchObject({ handlers: [] });
      expect(report).toHaveBeenCalledWith({
        type: "handler",
        tabId: 1,
        origin,
        recipeId: handled.id,
        handler: 0,
        kind: "passkey",
        outcome: "missing-fact",
        steps: 1,
      });
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
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(twice);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(clicks("Use security key")).toBe(1);
      expect(clicks("Use passkey")).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "handler" ? [[value.handler, value.outcome]] : [],
        ),
      ).toEqual([
        [0, "entered"],
        [1, "entered"],
        [0, "shown-again"],
      ]);
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
        expect.any(Function),
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

    it("holds a handler's click across a same-document URL change while its button remains", async () => {
      vi.useFakeTimers();
      // The page moves to another path with pushState and keeps the button in its DOM.
      onClick({
        login: toWebauthn,
        "Use security key": { path: "/login/webauthn/verify", present: ["Use security key"] },
      });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service });
      h.recipes.recipe.mockResolvedValue(
        parseLoginRecipe({ ...unlearned, handlers: [keyHandler] }),
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("Use security key") === 1);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(fake.state.observedPath).toBe("/login/webauthn/verify");
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      // Without a learned completion, the page is never judged while the button remains.
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
        report?: (report: LoginReport) => void,
      ) {
        vi.useFakeTimers();
        onClick({ login: { path: "/elsewhere", present: [], extracted } });
        const service = generation(judge);
        const h = harness(
          {},
          { passkeys: withPasskey, generation: service, ...(report ? { report } : {}) },
        );
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

      it("reports the settled result once while later pages change nothing", async () => {
        const report = vi.fn<(report: LoginReport) => void>();
        const { h } = await settledLogin(undefined, undefined, report);
        await open(h, "/settings");
        await open(h, "/billing");
        const attempts = report.mock.calls.flatMap(([value]) =>
          value.type === "attempt" ? [value] : [],
        );
        expect(attempts.filter((value) => value.settled)).toHaveLength(1);
        expect(attempts[0]).not.toHaveProperty("repeat");
        // Each new page resumes the attempt; the log repeats it at most quietly.
        expect(attempts.slice(-2)).toMatchObject([
          { state: "reconciling", outcome: "unknown-submit", repeat: true },
          { state: "reconciling", outcome: "unknown-submit", repeat: true },
        ]);
        // The third page is not sent, and the log says why.
        expect(report).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "page-limit" }),
        );
      });

      it("no longer holds policy writes once the result settled, also after a restart", async () => {
        const { h } = await settledLogin();
        // The record stays until the tab closes; counting it would hold settings and vault
        // writes past their limits for every later login.
        expect(await h.login.active()).toBe(false);
        const query = fake.browser.tabs.query;
        fake.browser.tabs.query = async () => [{ id: 1 }] as never;
        try {
          const restarted = harness({}, { passkeys: withPasskey, generation: generation() });
          expect(await restarted.login.active()).toBe(false);
          expect(status()).toMatchObject([{ state: "reconciling", settled: true }]);
        } finally {
          fake.browser.tabs.query = query;
        }
      });

      it("lets a held settings write and vault replacement through once the result settled", async () => {
        const { h } = await settledLogin();
        // The settings half of a full sync, wired to the login as the background wires it.
        const settings = (excludedSites: { hostname: string; includeSubdomains: boolean }[]) => ({
          connections: [],
          excludedSites,
          siteDefaults: [],
          bindings: [],
        });
        const agreed = settings([{ hostname: "intranet.example", includeSubdomains: false }]);
        let local: SettingsSnapshot = { version: 1, revision: 7, settings: agreed };
        const store = createSettingsStore(
          {
            read: async () => structuredClone(local),
            write: async (snapshot) => {
              local = structuredClone(snapshot) as SettingsSnapshot;
            },
          },
          { connections: [] },
        );
        const service = {
          origin: "https://pateat.example.com",
          deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
          credential: `pateat_device_${"C".repeat(43)}`,
          rejected: false,
        };
        const { origin: serviceOrigin, deviceId } = service;
        let since: unknown;
        const settingsSync = createSettingsSync({
          transport: {
            settings: async () => ({
              kind: "state",
              state: { version: 1, revision: 5, settings: settings([]) },
            }),
            saveSettings: vi.fn(),
          },
          settings: store,
          storage: {
            read: async () => ({
              version: 1,
              origin: serviceOrigin,
              deviceId,
              revision: 4,
              settings: agreed,
              local: agreed,
            }),
            write: async () => undefined,
            clear: async () => undefined,
          },
          hold: {
            read: async () => since,
            write: async (value: number) => {
              since = value;
            },
            clear: async () => {
              since = undefined;
            },
          },
          deferred: () => h.login.active(),
        });
        expect(await settingsSync.run(service, () => false)).toBe("synced");
        expect(local.settings.excludedSites).toEqual([]);
        expect(since).toBeUndefined();
        // The vault replacement is not deferred either.
        const outcomes: string[] = [];
        const vault = createVaultAutoSync({
          records: createVaultSyncRecords({ read: async () => undefined, write: async () => {} }),
          connections: async () => ["connection-1"],
          run: async (_id, hold) => {
            const release = await hold.take();
            release?.();
            return release ? "synced" : "deferred";
          },
          loginActive: () => h.login.active(),
          online: () => true,
          report: ({ outcome }) => outcomes.push(outcome),
        });
        vault.refreshIfStale();
        await vault.running();
        expect(outcomes).toEqual(["synced"]);
      });

      it("holds policy writes again while a later page of a settled login is judged", async () => {
        let answer!: (verdict: Awaited<ReturnType<LoginGeneration["judge"]>>) => void;
        const { h, service } = await settledLogin();
        service.judge.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
        await open(h, "/settings");
        expect(service.judge).toHaveBeenCalledTimes(2);
        // A takeover after this answer would be stopped by a policy write meanwhile.
        expect(await h.login.active()).toBe(true);
        answer({ verdict: "unclear" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(status()).toMatchObject([{ state: "reconciling", settled: true }]);
        expect(await h.login.active()).toBe(false);
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
          slotStorage: { read: async () => undefined, write: async () => undefined },
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
      h.recipes.starts.mockResolvedValue(startsOf([advancing.steps[0]!]));
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(service.judge).toHaveBeenCalledWith(
        advancing.id,
        advancing.revision,
        "password",
        elsewhere.observation,
        expect.any(Function),
      );
      expect(executed()).toHaveLength(1);
    });

    it("logs a handler entered mid-route only for its own steps", async () => {
      vi.useFakeTimers();
      const midway = parseLoginRecipe({
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
        handlers: [{ kind: "passkey", path: "/verify", target: securityKey }],
        maxSubmissions: 2,
      });
      fake.state.present = new Set(["continue"]);
      onClick({
        continue: { path: "/verify", present: ["Use security key"] },
        "Use security key": { path: "/next", present: ["password", "login"] },
        login: toHome,
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(midway);
      h.recipes.starts.mockResolvedValue(startsOf([midway.steps[0]!]));
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 1 }] });
      // The route's steps after the handler's click belong to no handler.
      expect(
        report.mock.calls.flatMap(([value]) =>
          value.type === "attempt" && value.state === "executing"
            ? [[value.stepIndex, value.operation, value.handler]]
            : [],
        ),
      ).toEqual([
        [0, "click", undefined],
        [1, "click", 0],
        [2, "fill", undefined],
        [3, "click", undefined],
      ]);
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
        expect.any(Function),
      );
    });

    it("does not send a page that shows the completion marker", async () => {
      vi.useFakeTimers();
      const learned = parseLoginRecipe({ ...unlearned, completion: home });
      // The marker shows, but on another path than the completion's.
      onClick({ login: { path: "/account", present: ["logout"], extracted: homePage } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(learned);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "not-sent", reason: "marker-shown" }),
      );
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
      const answers = [
        { verdict: "challenge" as const, recipe: taken },
        { verdict: "signed-in" as const },
      ];
      const service = generation(async () => answers.shift() ?? { verdict: "unclear" });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
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
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [plain.id, 1, "password", webauthnPage.observation],
        // The page after the handler is judged for the new revision.
        [plain.id, 2, "password", homePage.observation],
      ]);
      // The log shows each judgement, the takeover and the handler's click, in order.
      const reports = report.mock.calls.map(([value]) => value);
      expect(
        reports.flatMap((value) =>
          value.type === "judge"
            ? [`judge ${value.recipeRevision} ${value.verdict} ${value.takenOver ?? "-"}`]
            : value.type === "handler"
              ? [`handler ${value.handler} ${value.outcome}`]
              : value.type === "attempt" && value.handler !== undefined
                ? [`attempt ${value.state} ${value.operation ?? "-"} ${value.effect ?? "-"}`]
                : [],
        ),
      ).toEqual([
        "judge 1 sent -",
        "judge 1 challenge true",
        "handler 0 entered",
        "attempt ready - -",
        "attempt executing click submit",
        "attempt submit-intent click submit",
        "attempt awaiting-result click submit",
        "judge 2 sent -",
        "judge 2 signed-in -",
        "attempt authenticated click submit",
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
          h!.login.settingsChanged("synced");
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
        slotStorage: { read: async () => undefined, write: async () => undefined },
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
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: withPasskey, generation: service, report });
      h.recipes.recipe.mockResolvedValue(plain);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(clicks("Use security key")).toBe(0);
      expect(status()![0]).toMatchObject({ recipeRevision: 1, handlers: [] });
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ type: "judge", verdict: "challenge", takenOver: false }),
      );
      expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ type: "handler" }));
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

  describe("the totp handler", () => {
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const coded = parseLoginRecipe({ ...unlearned, completion: home, handlers: [codeHandler] });
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const noPasskey = vi.fn(async () => ({ passkey: false, discoverable: false }));
    /** Adds the item's built-in TOTP field, as the catalog lists it. */
    const withTotp = (h: ReturnType<typeof harness>, empty = false) =>
      editFields(h, (fields) => [
        ...fields,
        {
          id: "login.totp-code",
          label: "Verification code",
          name: null,
          kind: "otp",
          ...(empty ? { empty: true } : {}),
        },
      ]);
    /** A synthetic code for the TOTP field and a synthetic secret for every other one. */
    const codes = (h: ReturnType<typeof harness>) =>
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
    /** Runs `then` when the code is filled, as the page reacts to it. */
    const onCodeFill = (then: () => void | Promise<void>) => {
      const clicked = fake.state.onExecute;
      fake.state.onExecute = async (message, tabId) => {
        fake.state.executeReply = undefined;
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "fill" && step.fields.some((field) => field.slot === "totp"))
          await then();
        await clicked?.(message, tabId);
      };
    };
    const handlerReports = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome, value.steps]] : [],
      );

    it("fills the item's TOTP code into the code field and clicks its button once", async () => {
      onClick({ login: toCode, verify: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "fill", "click"]);
      expect(clicks("verify")).toBe(1);
      // The code fills only a code input, and is read from the built-in field.
      expect(codeFills().map((entry) => entry.values)).toEqual([
        [{ slot: "totp", value: "012345", secret: "otp" }],
      ]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual([
        "login.password",
        "login.totp-code",
      ]);
      expect(status()![0]).toMatchObject({
        facts: { totp: true },
        handlers: [{ index: 0, start: 2 }],
        stepCount: 4,
        submissions: 2,
        maxSubmissions: 2,
      });
      // Both of its elements are observed before it is entered.
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.observe",
          targets: [target("app-code"), target("verify")],
        }),
      );
      expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
      // The binding saved after the login names the route's slots only.
      expect(h.store.update).not.toHaveBeenCalled();
    }, 10_000);

    it.each([
      ["has no TOTP field", undefined],
      ["has an empty TOTP field", true],
    ])("ends as a challenge without filling when the item %s", async (_label, empty) => {
      onClick({ login: toCode, verify: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      if (empty !== undefined) withTotp(h, empty);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(codeFills()).toEqual([]);
      expect(clicks("verify")).toBe(0);
      expect(handlerReports(report)).toEqual([[0, "totp", "missing-fact", 2]]);
    });

    it("never types a custom field a saved binding names for the code", async () => {
      onClick({ login: toCode, verify: toHome });
      const report = vi.fn<(report: LoginReport) => void>();
      const bindings = [
        {
          ...savedBinding,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field: { custom: "Branch" } },
          ],
        },
      ];
      const h = harness({ bindings }, { passkeys: noPasskey, report });
      withTotp(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(codeFills()).toEqual([]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.password"]);
      expect(handlerReports(report)).toEqual([[0, "totp", "missing-fact", 2]]);
    });

    it("is not entered while only its field or only its button shows", async () => {
      onClick({ login: { path: "/two-factor", present: ["app-code"] } });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(codeFills()).toEqual([]);
      expect(handlerReports(report)).toEqual([]);
    }, 10_000);

    it("is not entered while its field is hidden or disabled", async () => {
      onClick({ login: toCode });
      fake.state.unusable = new Set(["app-code"]);
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
        { timeout: 6_000 },
      );
      expect(fake.state.messages).toContainEqual(
        expect.objectContaining({
          type: "login.observe",
          targets: [target("app-code"), target("verify")],
          require: ["writable", "shown"],
        }),
      );
      expect(codeFills()).toEqual([]);
      expect(handlerReports(report)).toEqual([]);
    }, 10_000);

    it("enters a passkey handler before a totp handler shown with it", async () => {
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      // The recipe lists the code first; the passkey still goes first.
      const both = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [codeHandler, key],
      });
      const shown = { path: "/two-factor", present: ["app-code", "verify", "Use security key"] };
      onClick({ login: shown, "Use security key": toHome, verify: toHome });
      const h = harness({}, { passkeys: withPasskey });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(both);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(codeFills()).toEqual([]);
      // An item without a passkey takes the code instead.
      fake.state.messages = [];
      for (const listener of fake.state.removed.splice(0)) listener(1);
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["password", "login"]);
      const coded2 = harness({}, { passkeys: noPasskey });
      withTotp(coded2);
      codes(coded2);
      coded2.recipes.recipe.mockResolvedValue(both);
      expect(await coded2.hello({ documentId: "second" })).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(clicks("Use security key")).toBe(0);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
    }, 15_000);

    it("types one code per login and leaves a second code page to the person", async () => {
      const again = {
        kind: "totp" as const,
        path: "/two-factor/again",
        field: target("app-code"),
        target: target("confirm"),
      };
      const twice = parseLoginRecipe({ ...unlearned, handlers: [codeHandler, again] });
      onClick({
        login: toCode,
        verify: { path: "/two-factor/again", present: ["app-code", "confirm"] },
      });
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness({}, { passkeys: noPasskey, report });
      withTotp(h);
      codes(h);
      h.recipes.recipe.mockResolvedValue(twice);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
        { timeout: 6_000 },
      );
      expect(codeFills()).toHaveLength(1);
      expect(clicks("confirm")).toBe(0);
      expect(handlerReports(report)).toEqual([
        [0, "totp", "entered", 2],
        [1, "totp", "code-used", 2],
      ]);
    }, 10_000);

    it.each([
      ["", false],
      [" with its field disabled", true],
    ])(
      "leaves the code page shown again in a new document%s to the person",
      async (_label, unusable) => {
        vi.useFakeTimers();
        onClick({ login: toCode, verify: toCode });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks("verify") === 1);
        // A wrong code: the page loads the code form again. A handler that ran counts as
        // shown again whatever state its elements are in.
        if (unusable) fake.state.unusable = new Set(["app-code", "verify"]);
        fake.state.pageUrl = `${origin}/two-factor`;
        await h.hello({ documentId: "again" }, false);
        await until(settled("blocked", "challenge"), 5_000);
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(1);
        expect(handlerReports(report)).toEqual([
          [0, "totp", "entered", 2],
          [0, "totp", "shown-again", 2],
        ]);
      },
    );

    describe("a code page that submits by itself", () => {
      it("settles a form replaced by the code fill without a click", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The page posts the code and replaces its form, as the content script reports.
          fake.state.executeReply = {
            ok: false,
            reason: "structural-mismatch",
            mutation: "possible",
          };
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        });
        const h = harness({}, { passkeys: noPasskey });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        // The page's own submission took the click's place in the budget.
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2, maxSubmissions: 2 });
      }, 10_000);

      it("holds a page that reports its own submission while the button still shows", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The content script saw the page submit the code; the form now says "Verifying".
          fake.state.executeReply = { ok: false, reason: "submitted", mutation: "possible" };
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1), { timeout: 6_000 });
        // The fill named the button, so the page's own submission is watched for.
        expect(codeFills()[0]).toMatchObject({ code: { submit: target("verify") } });
        await new Promise((done) => setTimeout(done, 1_500));
        expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 3 }]);
        expect(handlerReports(report)).toEqual([[0, "totp", "entered", 2]]);
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(clicks("verify")).toBe(0);
      }, 15_000);

      it("settles a page that moved to another path before the click", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        });
        const h = harness({}, { passkeys: noPasskey });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("settles the new document the code fill led to, never filling it again", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          // The page navigates during the fill, so the document never answers.
          fake.state.gone.add("synthetic-document");
          throw new Error("Could not establish connection. Receiving end does not exist.");
        });
        const service = generation(async () => ({ verdict: "signed-in" }));
        const h = harness({}, { passkeys: noPasskey, generation: service });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1));
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 2 }]),
        );
        fake.state.pageUrl = `${origin}/home`;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        expect(await h.hello({ documentId: "signed-in" }, false)).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(service.judge).not.toHaveBeenCalled();
      }, 10_000);

      it("ends as a challenge when the new document shows the code page again", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => {
          fake.state.gone.add("synthetic-document");
          throw new Error("Could not establish connection. Receiving end does not exist.");
        });
        const report = vi.fn<(report: LoginReport) => void>();
        const h = harness({}, { passkeys: noPasskey, report });
        withTotp(h);
        codes(h);
        h.recipes.recipe.mockResolvedValue(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "reconciling", stepIndex: 2 }]),
        );
        fake.state.pageUrl = `${origin}/two-factor`;
        expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
        );
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(handlerReports(report)).toEqual([
          [0, "totp", "entered", 2],
          [0, "totp", "shown-again", 2],
        ]);
      });
    });
  });

  describe("the totp handler, probed independently", () => {
    const CODE = "012345";
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const coded = parseLoginRecipe({ ...unlearned, completion: home, handlers: [codeHandler] });
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const noPasskey = () => vi.fn(async () => ({ passkey: false, discoverable: false }));
    const totpField = (empty = false) => ({
      id: "login.totp-code",
      label: "Verification code",
      name: null,
      kind: "otp",
      ...(empty ? { empty: true } : {}),
    });
    const withTotp = (h: ReturnType<typeof harness>, empty = false) =>
      editFields(h, (fields) => [...fields, totpField(empty)]);
    /** Synthetic values only: a fixed code, a username and a secret. */
    const values = (h: ReturnType<typeof harness>) =>
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code"
          ? CODE
          : fieldId === "login.username"
            ? "synthetic-user"
            : "synthetic-secret",
      );
    const reads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([request]) => request.fieldId);
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
    const handlerOutcomes = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome]] : [],
      );
    /** Runs `then` when the code is filled, as the page reacts to it. */
    const onCodeFill = (then: () => unknown) => {
      const clicked = fake.state.onExecute;
      fake.state.onExecute = async (message, tabId) => {
        fake.state.executeReply = undefined;
        const step = (message["operation"] as { step: LoginStep }).step;
        if (step.kind === "fill" && step.fields.some((field) => field.slot === "totp"))
          await then();
        await clicked?.(message, tabId);
      };
    };
    function start(
      used: LoginRecipe,
      live: Parameters<typeof harness>[1] = {},
      overrides: Partial<LocalSettings> = {},
      totp: "set" | "empty" | "none" = "set",
    ) {
      const report = vi.fn<(report: LoginReport) => void>();
      const h = harness(overrides, { passkeys: noPasskey(), report, ...live });
      if (totp !== "none") withTotp(h, totp === "empty");
      values(h);
      h.recipes.recipe.mockResolvedValue(used);
      return { h, report };
    }
    /** Runs the other runtime of a worker restart on the same storage. */
    async function restarted<T>(run: () => Promise<T>): Promise<T> {
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        return await run();
      } finally {
        fake.browser.tabs.query = query;
      }
    }

    it.each([
      ["has no TOTP field", "none"],
      ["has an empty TOTP field", "empty"],
    ] as const)("reads nothing for the code when the item %s", async (_label, totp) => {
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(coded, {}, {}, totp);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(status()![0]).toMatchObject({ facts: { totp: false }, handlers: [] });
      expect(reads(h)).toEqual(["login.password"]);
      expect(codeFills()).toEqual([]);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "missing-fact"]]);
    });

    it("stops as a policy change without reading the code when its field is excluded after entry", async () => {
      onClick({ login: toCode, verify: toHome });
      let h!: ReturnType<typeof harness>;
      const report = vi.fn<(report: LoginReport) => void>((value) => {
        // The owner excludes the TOTP field once the handler joined the login.
        if (value.type === "handler" && value.outcome === "entered")
          h.settings.settings.connections[0]!.excludedFields = [
            { itemId, fieldId: "login.totp-code" },
          ];
      });
      h = harness({}, { passkeys: noPasskey(), report });
      withTotp(h);
      values(h);
      h.recipes.recipe.mockResolvedValue(coded);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "policy-changed" }]),
      );
      expect(report.mock.calls.at(-1)![0]).toMatchObject({
        type: "attempt",
        cause: "plan",
        reason: "binding-field-excluded",
      });
      expect(reads(h)).toEqual(["login.password"]);
      expect(codeFills()).toEqual([]);
      expect(clicks("verify")).toBe(0);
    });

    it("passes the handler over without reading when its field is excluded before entry", async () => {
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(coded);
      // Excluded after the login started, before the code page shows.
      const original = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          h.settings.settings.connections[0]!.excludedFields = [
            { itemId, fieldId: "login.totp-code" },
          ];
        await original(message, tabId);
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(status()![0]).toMatchObject({ facts: { totp: true }, handlers: [] });
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "missing-fact"]]);
      expect(reads(h)).toEqual(["login.password"]);
      expect(codeFills()).toEqual([]);
    });

    it("sends the code as an OTP secret with the item's username for the account check", async () => {
      onClick({ login: toCode, verify: toHome });
      const { h } = start(coded, { username: true });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(codeFills()).toHaveLength(1);
      expect(codeFills()[0]).toMatchObject({
        values: [{ slot: "totp", value: CODE, secret: "otp" }],
        account: { username: "synthetic-user" },
      });
      // The TOTP fill rule accepts a code input and refuses a password input.
      const numeric: SecretInput = {
        type: "text",
        autocomplete: "",
        inputMode: "numeric",
        maxLength: 6,
      };
      const password: SecretInput = {
        type: "password",
        autocomplete: "",
        inputMode: "",
        maxLength: -1,
      };
      expect(acceptsSecret(numeric, "otp")).toBe(true);
      expect(acceptsSecret(password, "otp")).toBe(false);
    }, 10_000);

    it("ends as wrong-account without a click when the code page shows another account", async () => {
      onClick({ login: toCode, verify: toHome });
      onCodeFill(() => {
        fake.state.executeReply = { ok: false, reason: "wrong-account" };
      });
      const { h } = start(coded, { username: true });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "wrong-account" }]),
      );
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(0);
    });

    it("leaves a code page that keeps its form in the same document to the person after two minutes", async () => {
      vi.useFakeTimers();
      // A wrong code: the page shows its error beside the same form, without a new document.
      onClick({ login: toCode, verify: toCode });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h, report } = start(coded, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("verify") === 1);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      await until(settled("blocked", "challenge"), 30_000);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
    });

    it("never types a second code after a code the start page's route filled", async () => {
      const withCode = parseLoginRecipe({
        ...unlearned,
        completion: home,
        slots: ["password", "totp"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "password", target: target("password") },
              { slot: "totp", target: target("start-code") },
            ],
          },
          recipe.steps[1]!,
        ],
        handlers: [codeHandler],
      });
      const bindings = [
        {
          ...savedBinding,
          recipeId: withCode.id,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field: "totp" as const },
          ],
        },
      ];
      fake.state.present = new Set(["password", "start-code", "login"]);
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(withCode, {}, { bindings });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      // One code, typed by the route on the start page.
      expect(codeFills()).toHaveLength(1);
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click"]);
      expect(clicks("verify")).toBe(0);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "code-used"]]);
      expect(reads(h).filter((fieldId) => fieldId === "login.totp-code")).toHaveLength(1);
    });

    it("waits out a passkey click on a page with both handlers and never types the code there", async () => {
      vi.useFakeTimers();
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      const both = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [codeHandler, key],
      });
      const shown = { path: "/two-factor", present: ["app-code", "verify", securityKey.value] };
      // The security key is cancelled: the same document keeps both forms.
      onClick({ login: shown, [securityKey.value]: shown });
      const { h, report } = start(both, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(securityKey.value) === 1);
      await until(settled("blocked", "challenge"), 200_000);
      expect(codeFills()).toEqual([]);
      expect(clicks("verify")).toBe(0);
      expect(handlerOutcomes(report)).toEqual([[1, "passkey", "entered"]]);
    });

    it("falls back to the code when a new document shows both handlers after the passkey ran", async () => {
      vi.useFakeTimers();
      const key = { kind: "passkey" as const, path: "/two-factor", target: securityKey };
      const both = parseLoginRecipe({
        ...unlearned,
        completion: home,
        handlers: [key, codeHandler],
      });
      const shown = { path: "/two-factor", present: ["app-code", "verify", securityKey.value] };
      onClick({ login: shown, [securityKey.value]: shown, verify: toHome });
      const { h, report } = start(both, { passkeys: withPasskey });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(securityKey.value) === 1);
      // The page reloads after the key and offers both again.
      fake.state.pageUrl = `${origin}/two-factor`;
      await h.hello({ documentId: "reloaded" }, false);
      await until(() => settled("authenticated")() || settled("blocked")(), 20_000);
      // As ADR 0027 states: the passkey is passed over as shown again, the code is not.
      expect(handlerOutcomes(report)).toEqual([
        [0, "passkey", "entered"],
        [1, "totp", "entered"],
      ]);
      expect(codeFills()).toHaveLength(1);
      expect(clicks(securityKey.value)).toBe(1);
      expect(clicks("verify")).toBe(1);
      expect(status()![0]).toMatchObject({ state: "authenticated", submissions: 3 });
    });

    it("takes over a revision that adds a totp handler and types the code once", async () => {
      vi.useFakeTimers();
      const codePage = observation("/two-factor", [
        {
          id: "c1",
          role: "text",
          target: target("app-code"),
          label: "Code",
          inputMode: "numeric",
          maxLength: 6,
        },
        { id: "c2", role: "button", target: target("verify"), label: "Verify" },
      ]);
      onClick({ login: { ...toCode, extracted: codePage }, verify: toHome });
      const next = parseLoginRecipe({ ...unlearned, revision: 2, handlers: [codeHandler] });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: next })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const { h, report } = start(plain, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepCount: 4,
        submissions: 2,
        maxSubmissions: 2,
      });
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(service.judge.mock.calls.map((call) => [call[1], call[3]])).toEqual([
        [1, codePage.observation],
        [2, homePage.observation],
      ]);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
    });

    describe("a code page that submits by itself", () => {
      it("settles a completion shown on the code page's own path without a click", async () => {
        const samePath = parseLoginRecipe({
          ...unlearned,
          completion: { path: "/two-factor", target: target("logout") },
          handlers: [codeHandler],
        });
        onClick({ login: toCode });
        onCodeFill(() => {
          fake.state.present = new Set(["logout"]);
        });
        const { h } = start(samePath);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
      }, 10_000);

      it("settles a rejection shown in place of the form as a rejected credential", async () => {
        const rejecting = parseLoginRecipe({
          ...coded,
          rejection: target("rejected"),
        });
        onClick({ login: toCode });
        onCodeFill(() => {
          fake.state.present = new Set(["rejected"]);
        });
        const { h } = start(rejecting);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() =>
          expect(status()).toMatchObject([{ state: "blocked", outcome: "credential-rejected" }]),
        );
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      });

      it("settles a page that leaves the path while the click waits for its button", async () => {
        onClick({ login: toCode });
        onCodeFill(() => {
          // The page shows a spinner in place of the form and moves on during the wait.
          fake.state.present = new Set(["app-code"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
          fake.state.onAwait = () => {
            fake.state.observedPath = "/home";
            fake.state.present = new Set(["logout"]);
          };
        });
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
          timeout: 6_000,
        });
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("never fills the code again when the button never returns on the same path", async () => {
        onClick({ login: toCode });
        onCodeFill(() => {
          fake.state.present = new Set(["app-code"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
        });
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        // The click step failed for want of its button; a late click could submit an
        // expired code, so the login ends without a retry.
        await vi.waitFor(
          () =>
            expect(status()).toMatchObject([
              {
                state: "blocked",
                stepIndex: 3,
                submissions: 1,
                retries: 0,
                outcome: "retry-limit",
              },
            ]),
          { timeout: 6_000 },
        );
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("never clicks the code's button when it returns only after the wait failed", async () => {
        onClick({ login: toCode, verify: toHome });
        let waits = 0;
        onCodeFill(() => {
          fake.state.present = new Set(["app-code"]);
          fake.state.awaited = { ok: false, reason: "timeout" };
          fake.state.onAwait = () => {
            waits += 1;
            if (waits > 1) fake.state.awaited = { ok: true };
          };
        });
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(
          () => expect(status()).toMatchObject([{ state: "blocked", outcome: "retry-limit" }]),
          { timeout: 6_000 },
        );
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      }, 10_000);

      it("does not treat the route's own fill whose form went away as a submission", async () => {
        // The password page replaces its form after the fill; only a code fill counts.
        fake.state.onExecute = async (message) => {
          const step = (message["operation"] as { step: LoginStep }).step;
          if (step.kind !== "fill") return;
          fake.state.executeReply = {
            ok: false,
            reason: "structural-mismatch",
            mutation: "possible",
          };
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
        };
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()![0]!["state"]).not.toMatch(/^(ready|executing)$/u));
        await new Promise((resolve) => setTimeout(resolve, 200));
        // The route's click was never counted as done by the page.
        expect(status()![0]).toMatchObject({ stepIndex: 0, submissions: 0 });
        expect(clicks("login")).toBe(0);
      });
    });

    describe("a worker restart", () => {
      it("never fills the code again when the worker restarts during the code fill", async () => {
        onClick({ login: toCode, verify: toHome });
        // The code fill never answers; the worker stops meanwhile.
        onCodeFill(() => new Promise<void>(() => undefined));
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(codeFills()).toHaveLength(1));
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "executing" }]));
        fake.state.onExecute = undefined;
        await restarted(async () => {
          const again = start(coded);
          // The same document announces itself to the new worker.
          await again.h.hello({}, false);
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "reconciling", outcome: "unknown-submit" }]),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(again.h.fields).not.toHaveBeenCalled();
        });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      });

      it("takes a new document after a restart during the code fill as the page's submission", async () => {
        onClick({ login: toCode, verify: toHome });
        onCodeFill(() => new Promise<void>(() => undefined));
        const { h } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(status()).toMatchObject([{ state: "executing" }]));
        fake.state.onExecute = undefined;
        fake.state.pageUrl = `${origin}/home`;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        await restarted(async () => {
          const again = start(coded);
          expect(await again.h.hello({ documentId: "signed-in" }, false)).toEqual({ ok: true });
          await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
          expect(again.h.fields).not.toHaveBeenCalled();
        });
        expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(0);
      });

      it("leaves the code page to the person after a restart during the verify click", async () => {
        onClick({ login: toCode, verify: "hang" });
        const { h, report } = start(coded);
        expect(await h.hello()).toEqual({ ok: true });
        await vi.waitFor(() => expect(clicks("verify")).toBe(1));
        fake.state.onExecute = undefined;
        await restarted(async () => {
          const again = start(coded);
          await again.h.hello({}, false);
          await vi.waitFor(() =>
            expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
          );
          expect(again.h.fields).not.toHaveBeenCalled();
          expect(handlerOutcomes(again.report)).toEqual([[0, "totp", "shown-again"]]);
        });
        expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
        expect(codeFills()).toHaveLength(1);
        expect(clicks("verify")).toBe(1);
      });
    });

    it("keeps the code out of reports, records, badges and every other message", async () => {
      onClick({ login: toCode, verify: toHome });
      const { h, report } = start(coded, { username: true });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(codeFills()).toHaveLength(1);
      expect(JSON.stringify(report.mock.calls)).not.toContain(CODE);
      expect(JSON.stringify(fake.state.storage)).not.toContain(CODE);
      expect(JSON.stringify(fake.state.session)).not.toContain(CODE);
      expect(JSON.stringify(fake.state.badges)).not.toContain(CODE);
      expect(JSON.stringify(h.settings)).not.toContain(CODE);
      const others = fake.state.messages.filter((entry) => !codeFills().includes(entry));
      expect(JSON.stringify(others)).not.toContain(CODE);
    }, 10_000);
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
        const service = { ...generation(), available: vi.fn(async (): Promise<true> => true) };
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
          { allowedOrigins: [], uris, username: true, custom: [], generation: service },
        );
        if (empty)
          editFields(h, (fields) =>
            fields.map((field) =>
              field["id"] === "login.password" ? { ...field, empty: true } : field,
            ),
          );
        h.recipes.recipe.mockResolvedValue(undefined);
        h.recipes.starts.mockResolvedValue(startsOf([]));
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
    fake.state.storage["pateat.login-attempts.v2"] = [{ id: "retired-record" }];
    const h = harness({}, { passkeys: withPasskey });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(fake.state.storage).not.toHaveProperty(["pateat.login-attempts.v2"]);
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

  describe("with password route variants", () => {
    const fillOn = (path: string, slots: string[]) => ({
      kind: "fill" as const,
      path,
      fields: slots.map((slot) => ({ slot, target: target(slot) })),
    });
    const clickOn = (path: string, value: string, purpose: "advance" | "submit") => ({
      kind: "click" as const,
      path,
      target: target(value),
      purpose,
    });
    const variantBinding = (slots: SavedLoginBinding["slots"]): SavedLoginBinding => ({
      ...savedBinding,
      recipeId: "synthetic-variants",
      slots,
    });

    it("does not judge a page that shows another variant's field on that variant's path", async () => {
      vi.useFakeTimers();
      // The branch variant signs in on the start page; the member variant continues to
      // `/verify` for its PIN.
      const twoPaths = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-variants",
        slots: ["branch", "password"],
        steps: [fillOn("/signin", ["branch", "password"]), clickOn("/signin", "login", "submit")],
        alternatives: [
          {
            slots: ["member", "pin"],
            steps: [
              fillOn("/signin", ["member"]),
              clickOn("/signin", "next", "advance"),
              fillOn("/verify", ["pin"]),
              clickOn("/verify", "confirm", "submit"),
            ],
          },
        ],
        maxSubmissions: 2,
      });
      // The branch login lands on the member variant's PIN page.
      const pinPage = observation("/verify", [
        { id: "c1", role: "password", target: target("pin"), label: "PIN" },
      ]);
      onClick({ login: { path: "/verify", present: ["pin"], extracted: pinPage } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const h = harness(
        {
          bindings: [
            variantBinding([
              { slot: "branch", field: { custom: "Branch" } },
              { slot: "password", field: "password" },
            ]),
          ],
        },
        { passkeys: withPasskey, generation: service },
      );
      h.recipes.recipe.mockResolvedValue(twoPaths);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(status()![0]).toMatchObject({ variant: 0 });
      // The page is a sign-in page of the route, whichever variant ran, as the service
      // would also answer.
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
    });

    it("takes a revision over on the variant the login runs and clicks the handler", async () => {
      vi.useFakeTimers();
      // Variant 0 has one step more than variant 1, so a handler inserted after the wrong
      // variant's steps would not follow the click that ran.
      const plainVariants = parseLoginRecipe({
        ...unlearned,
        id: "synthetic-variants",
        slots: ["branch", "password"],
        steps: [
          fillOn("/signin", ["branch"]),
          fillOn("/signin", ["password"]),
          clickOn("/signin", "login", "submit"),
        ],
        alternatives: [
          {
            slots: ["contract", "password"],
            steps: [
              fillOn("/signin", ["contract", "password"]),
              clickOn("/signin", "login", "submit"),
            ],
          },
        ],
      });
      const takenVariants = parseLoginRecipe({
        ...plainVariants,
        revision: 2,
        handlers: [keyHandler],
      });
      onClick({ login: toWebauthn, "Use security key": toHome });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: takenVariants })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const h = harness(
        {
          bindings: [
            variantBinding([
              { slot: "contract", field: { custom: "Contract" } },
              { slot: "password", field: "password" },
            ]),
          ],
        },
        {
          passkeys: withPasskey,
          generation: service,
          custom: [{ name: "Contract", kind: "text" }],
        },
      );
      h.recipes.recipe.mockResolvedValue(plainVariants);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "password",
        variant: 1,
        recipeRevision: 2,
        handlers: [{ index: 0, start: 2 }],
        stepCount: 3,
        maxSubmissions: 2,
      });
      expect(clicks("Use security key")).toBe(1);
      expect(executed().map((step) => step.kind)).toEqual(["fill", "click", "click"]);
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [plainVariants.id, 1, "password", webauthnPage.observation],
        [plainVariants.id, 2, "password", homePage.observation],
      ]);
    });
  });
});

describe("password route variants (ADR 0027)", () => {
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
    fake.state.present = undefined;
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });

  const set = (slots: string[]) => ({
    slots,
    steps: [
      {
        kind: "fill" as const,
        path: "/signin",
        fields: slots.map((slot) => ({ slot, target: target(slot) })),
      },
      recipe.steps[1]!,
    ],
  });
  /** A branch number, or a contract number, each with the password. */
  const varied = parseLoginRecipe({
    ...recipe,
    id: "synthetic-variants",
    ...set(["branch", "password"]),
    alternatives: [set(["contract", "password"])],
  });
  const both = {
    custom: [
      { name: "Branch", kind: "text" as const },
      { name: "Contract", kind: "text" as const },
    ],
  };
  const branchField = `custom.${snapshotId}.0`;
  const contractField = `custom.${snapshotId}.1`;
  const bound = (slots: SavedLoginBinding["slots"]): SavedLoginBinding => ({
    ...savedBinding,
    recipeId: varied.id,
    slots,
  });
  const byContract = bound([
    { slot: "contract", field: { custom: "Contract" } },
    { slot: "password", field: "password" },
  ]);
  const everything = bound([
    { slot: "branch", field: { custom: "Branch" } },
    { slot: "contract", field: { custom: "Contract" } },
    { slot: "password", field: "password" },
  ]);
  const excluding = (fieldId: string): Partial<LocalSettings> => ({
    connections: [
      {
        connectionId,
        enabled: true,
        selection: { mode: "all", groupIds: [], itemIds: [] },
        excludedItemIds: [],
        excludedFields: [{ itemId, fieldId }],
      },
    ],
  });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v3"] as Record<string, unknown>[] | undefined;
  /** The targets each executed fill wrote. */
  const filled = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step)
      .flatMap((step) =>
        step.kind === "fill" ? [step.fields.map((field) => field.target.value)] : [],
      );
  function start(
    overrides: Partial<LocalSettings>,
    live: Parameters<typeof harness>[1] = both,
    used: LoginRecipe = varied,
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const passkeys = vi.fn(async () => ({ passkey: false, discoverable: false }));
    const h = harness(overrides, { ...live, report, passkeys });
    h.recipes.recipe.mockResolvedValue(used);
    return { h, report, passkeys };
  }
  const refusals = (report: ReturnType<typeof vi.fn>) =>
    report.mock.calls.map(([entry]) => entry).filter((entry) => entry.type === "refused");

  it("takes the first variant the item's saved binding fills", async () => {
    const { h, report, passkeys } = start({ bindings: [byContract] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "password", variant: 1, stepCount: 2 });
    expect(filled()).toEqual([["contract", "password"]]);
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
      contractField,
      "login.password",
    ]);
    // The facts are read once, whatever number of variants was tried.
    expect(passkeys).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ type: "attempt", route: "password", variant: 1 }),
    );
  });

  it("takes variant 0 when the binding fills it, and ignores the binding's other slots", async () => {
    const { h } = start({ bindings: [everything] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 0 });
    expect(filled()).toEqual([["branch", "password"]]);
    // The contract field is never read for a login on the branch variant.
    expect(h.fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
      branchField,
      "login.password",
    ]);
  });

  it("never bypasses a saved binding with an automatic one", async () => {
    // A generated map could fill the branch variant, but the item's own binding names the
    // contract variant only.
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => [
        { slot: "branch", field: { custom: "Branch" } },
      ]),
    };
    const { h } = start({ bindings: [byContract] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    expect(service.slotFields).not.toHaveBeenCalled();
    // A saved binding that covers no variant refuses; nothing else is tried.
    const stale = bound([
      { slot: "region", field: { custom: "Branch" } },
      { slot: "password", field: "password" },
    ]);
    const refused = start({ bindings: [stale] }, { ...both, generation: service });
    expect(await refused.h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
      ok: false,
      reason: "no-route",
    });
    expect(refusals(refused.report)).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "binding-slots-mismatch" }),
    ]);
    expect(refused.h.fields).not.toHaveBeenCalled();
  });

  it("builds each variant's binding from the generated map when none is saved", async () => {
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => [
        { slot: "branch", field: { custom: "Gone" } },
        { slot: "contract", field: { custom: "Contract" } },
      ]),
    };
    const { h } = start({ bindings: [] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    // The binding saved after authenticated covers the variant that signed in.
    await vi.waitFor(() =>
      expect(h.settings.settings.bindings).toContainEqual(
        expect.objectContaining({
          recipeId: varied.id,
          slots: [
            { slot: "contract", field: { custom: "Contract" } },
            { slot: "password", field: "password" },
          ],
        }),
      ),
    );
  });

  it("moves to the next variant when a field of the first is excluded", async () => {
    const { h } = start({ bindings: [everything], ...excluding(branchField) });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    expect(filled()).toEqual([["contract", "password"]]);
  });

  it("moves past a variant whose bound TOTP field is empty, reading the facts once", async () => {
    const withCode = parseLoginRecipe({
      ...varied,
      ...set(["branch", "password", "totp"]),
    });
    const { h, passkeys } = start(
      { bindings: [bound([...everything.slots, { slot: "totp", field: "totp" }])] },
      both,
      withCode,
    );
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const item = response.catalog.connections[0]!.items[0]!;
        item.fields = [
          ...item.fields,
          { id: "login.totp-code", label: "Code", name: null, kind: "otp", empty: true },
        ] as never;
      }
      return response;
    });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1, facts: { password: true, totp: false } });
    expect(filled()).toEqual([["contract", "password"]]);
    expect(passkeys).toHaveBeenCalledTimes(1);
  });

  it("refuses no-route with the first variant's reason when no variant fits", async () => {
    const slotFields = vi.fn<LoginGeneration["slotFields"]>(async () => undefined);
    const service = {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields,
    };
    const { h, report } = start({ bindings: [] }, { ...both, generation: service });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    // Both variants were tried with one read of the generated map.
    expect(slotFields).toHaveBeenCalledTimes(1);
    expect(refusals(report)).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "binding-not-found" }),
    ]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(status() ?? []).toEqual([]);
  });

  it.each<[string, Partial<LocalSettings>, Parameters<typeof harness>[1], string]>([
    [
      "a saved binding without the variant's slot",
      { bindings: [bound([{ slot: "password", field: "password" }])] },
      both,
      "binding-slots-mismatch",
    ],
    ["no binding", { bindings: [] }, both, "binding-not-found"],
    [
      "an excluded field",
      { bindings: [everything], ...excluding(branchField) },
      both,
      "binding-field-excluded",
    ],
    ["a missing field", { bindings: [everything] }, { custom: [] }, "field-missing"],
  ])(
    "keeps a single-variant recipe's own refusal for %s",
    async (_label, overrides, live, reason) => {
      const single = parseLoginRecipe({ ...varied, alternatives: undefined });
      const { h, report } = start(overrides, live, single);
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(refusals(report)).toEqual([
        expect.not.objectContaining({ detail: expect.anything() }),
      ]);
    },
  );

  it("takes no variant for an item without a password, as the password route needs one", async () => {
    const pinOnly = parseLoginRecipe({
      ...varied,
      alternatives: [{ slots: ["contract"], steps: set(["contract"]).steps }],
    });
    const { h, report } = start(
      { bindings: [bound([{ slot: "contract", field: { custom: "Contract" } }])] },
      both,
      pinOnly,
    );
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields =
          response.catalog.connections[0]!.items[0]!.fields.map((field) =>
            field.id === "login.password" ? { ...field, empty: true as const } : field,
          );
      return response;
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(refusals(report)).toEqual([
      expect.objectContaining({ reason: "no-route", detail: "binding-slots-mismatch" }),
    ]);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it.each([
    ["an unused variant's field", branchField, "authenticated"],
    ["the running variant's field", contractField, "blocked"],
  ])(
    "checks only the running variant's fields when %s is excluded",
    async (_label, fieldId, state) => {
      const { h, report } = start({ bindings: [everything], ...excluding(branchField) });
      // After the fill, the next step's authorization sees the new exclusion; the settings
      // revision stays the same, so only the plan decides.
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind !== "fill") return;
        h.settings.settings.connections[0]!.excludedFields = [{ itemId, fieldId }];
      };
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state }]));
      expect(status()![0]).toMatchObject({ variant: 1 });
      if (state === "blocked") {
        expect(status()![0]).toMatchObject({ outcome: "policy-changed" });
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          cause: "plan",
          reason: "binding-field-excluded",
        });
      }
    },
  );

  it("resumes on the recorded variant without reading the facts again", async () => {
    // Only the contract variant fits when the login starts: the item has no branch field.
    const { h, passkeys } = start(
      { bindings: [everything] },
      { custom: [{ name: "Contract", kind: "text" }] },
    );
    fake.state.observed = ["missing", "missing"];
    let clicked = false;
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as { step: LoginStep }).step.kind === "click") clicked = true;
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicked).toBe(true));
    expect(status()![0]).toMatchObject({ variant: 1 });
    // A vault sync adds the branch field, so the first variant would fit a new login.
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields.push({
          id: `custom.${snapshotId}.5`,
          label: "Branch",
          name: "Branch",
          kind: "text",
        });
      return response;
    });
    fake.state.observed = ["unique", "missing"];
    await h.hello({ documentId: "next-page" });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1 });
    expect(passkeys).toHaveBeenCalledTimes(1);
  });

  it("watches every variant's first step and starts on any of them", async () => {
    const starts = [
      {
        path: "/signin",
        steps: [varied.steps[0]!, varied.alternatives![0]!.steps[0]!],
      },
    ];
    const { h } = start({ bindings: [byContract] });
    h.recipes.starts.mockResolvedValue(starts);
    const watched = await h.hello({}, false);
    expect(watched).toMatchObject({ ok: false, reason: "form-not-ready" });
    // Both variants' fields are watched on the one start path.
    expect(
      (watched as { starts: { targets: unknown[] }[] }).starts.map((entry) => entry.targets),
    ).toEqual([
      [target("branch"), target("password")],
      [target("contract"), target("password")],
    ]);
    expect(h.store.handle).not.toHaveBeenCalled();
    // Two recipes starting on one path still leave it out.
    h.recipes.starts.mockResolvedValue([...starts, { path: "/signin", steps: [recipe.steps[0]!] }]);
    expect(await h.hello({ documentId: "second-document" }, false)).toMatchObject({ starts: [] });
  });

  it("stops after its retries when only another variant's first step is ready", async () => {
    // The document reported the start path ready, as the branch variant's fields showed,
    // but the item fills only the contract variant, whose field never appears.
    fake.state.awaited = { ok: false, reason: "timeout" };
    const { h } = start({ bindings: [byContract] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([
        { variant: 1, state: "blocked", outcome: "retry-limit", submissions: 0 },
      ]),
    );
    const awaited = fake.state.messages.find((entry) => entry.type === "login.await") as
      | { readiness: { targets: unknown[] } }
      | undefined;
    expect(awaited?.readiness.targets).toEqual([target("contract"), target("password")]);
    expect(h.fields).not.toHaveBeenCalled();
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.execute");
  });

  it("removes the previous attempt store on load", async () => {
    fake.state.storage["pateat.login-attempts.v2"] = [{ id: "retired-record" }];
    const { h } = start({ bindings: [byContract] });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(fake.state.storage).not.toHaveProperty(["pateat.login-attempts.v2"]);
  });

  it.each<[string, Partial<LocalSettings>, Parameters<typeof harness>[1], string]>([
    [
      "an item awaiting review",
      { bindings: [byContract] },
      { ...both, quarantined: true },
      "vault-unavailable",
    ],
    [
      "an excluded item",
      {
        bindings: [byContract],
        connections: [
          {
            connectionId,
            enabled: true,
            selection: { mode: "all", groupIds: [], itemIds: [] },
            excludedItemIds: [itemId],
            excludedFields: [],
          },
        ],
      },
      both,
      "item-excluded",
    ],
  ])(
    "stops at once on %s, which no other variant could pass",
    async (_label, overrides, live, reason) => {
      // The refusal applies to every variant alike, so it is reported as itself.
      const { h, report } = start(overrides, live);
      expect(await h.hello()).toEqual({ ok: false, reason });
      expect(refusals(report)).toEqual([
        expect.not.objectContaining({ detail: expect.anything() }),
      ]);
      expect(h.fields).not.toHaveBeenCalled();
    },
  );

  it("starts on the path alone when an alternative's first step needs no element", async () => {
    const waiting = parseLoginRecipe({
      ...varied,
      alternatives: [
        {
          slots: ["contract", "password"],
          steps: [
            {
              kind: "wait",
              path: "/signin",
              target: target("contract"),
              present: true,
              timeoutMs: 1000,
            },
            ...set(["contract", "password"]).steps,
          ],
        },
      ],
    });
    const { h } = start({ bindings: [byContract] }, both, waiting);
    // The document has reported no ready first step, as for a recipe that starts with a wait.
    expect(await h.hello({}, false)).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ variant: 1, stepCount: 3 });
    // Every variant of the recipe without alternatives needs an element, so it waits.
    const plain = start({ bindings: [byContract] });
    expect(await plain.h.hello({ tab: { id: 2 }, documentId: "other-tab" }, false)).toMatchObject({
      ok: false,
      reason: "form-not-ready",
    });
  });

  it("never reports the item's facts, only the route and variant", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    const h = harness({ bindings: [byContract] }, { ...both, report, passkeys });
    h.recipes.recipe.mockResolvedValue(varied);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ facts: { passkey: true, discoverablePasskey: true } });
    const reports = report.mock.calls.map(([entry]) => entry);
    expect(reports.filter((entry) => entry.type === "attempt")).not.toEqual([]);
    for (const entry of reports.filter((value) => value.type === "attempt"))
      expect(entry).toMatchObject({ route: "password", variant: 1 });
    const serialized = JSON.stringify(reports);
    for (const key of ['"facts"', '"discoverablePasskey"', '"passkey"', '"totp"'])
      expect(serialized).not.toContain(key);
  });
});

describe("the start page's passkey route (ADR 0027)", () => {
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
    fake.state.present = new Set(["password", "login", "Sign in with a passkey"]);
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });

  const button = { by: "text" as const, value: "Sign in with a passkey" };
  const home = { path: "/home", target: target("logout") };
  const { completion: _unlearned, ...unlearned } = recipe;
  /** The password form and a passkey sign-in button on one start page, not learned yet. */
  const routed = parseLoginRecipe({
    ...unlearned,
    id: "synthetic-passkey-route",
    passkey: { path: "/signin", target: button },
  });
  const learned = parseLoginRecipe({ ...routed, completion: home });
  const discoverable = () => vi.fn(async () => ({ passkey: true, discoverable: true }));
  const secondFactor = () => vi.fn(async () => ({ passkey: true, discoverable: false }));
  const observation = (path: string, candidates: unknown[]) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete: true, candidates },
  });
  const homePage = observation("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const elsewhere = observation("/elsewhere", [
    { id: "c1", role: "link", target: target("help"), label: "Help" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v3"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
  const clicks = (value: string) =>
    executed().filter((step) => step.kind === "click" && step.target.value === value).length;
  const fills = () => executed().filter((step) => step.kind === "fill").length;
  const toHome = { path: "/home", present: ["logout"], extracted: homePage };
  /** What each click leads to: the next path, its elements and its description. */
  const onClick = (
    pages: Record<string, { path: string; present: string[]; extracted?: unknown }>,
  ) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: LoginStep }).step;
      if (step.kind !== "click") return;
      const next = pages[step.target.value];
      if (!next) return;
      fake.state.observedPath = next.path;
      fake.state.present = new Set(next.present);
      if (next.extracted) fake.state.extracted = { "signed-in": next.extracted };
    };
  };
  function generation(judge: LoginGeneration["judge"] = async () => ({ verdict: "unclear" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(async () => ({
        outcome: "skipped",
        reason: "sent",
      })),
      // Like the service, it says just before the request leaves the device.
      judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
        args[4]?.();
        return judge(...args);
      }),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  function start(
    used: LoginRecipe,
    live: Parameters<typeof harness>[1] = {},
    overrides: Partial<LocalSettings> = {},
  ) {
    const report = vi.fn<(report: LoginReport) => void>();
    const h = harness(overrides, { passkeys: discoverable(), report, ...live });
    h.recipes.recipe.mockResolvedValue(used);
    return { h, report };
  }
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

  it("clicks the passkey button for an item with a discoverable passkey and never fills", async () => {
    onClick({ [button.value]: toHome });
    const { h } = start(learned);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "passkey", stepCount: 1, submissions: 1 });
    expect(status()![0]).not.toHaveProperty("variant");
    expect(executed()).toEqual([
      { kind: "click", path: "/signin", target: button, purpose: "submit" },
    ]);
    // The click carries no values, and no vault field is read.
    const execute = fake.state.messages.find((entry) => entry.type === "login.execute")!;
    expect(execute.values).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("fills the password route for an item whose passkey is only a second factor", async () => {
    fake.state.present = new Set(["password", "login", "Sign in with a passkey", "logout"]);
    fake.state.observedPath = "/home";
    const { h } = start(learned, { passkeys: secondFactor() });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "password", variant: 0 });
    expect(fills()).toBe(1);
    expect(clicks(button.value)).toBe(0);
    expect(clicks("login")).toBe(1);
  });

  it("takes the passkey route for an item without a password or a fitting binding", async () => {
    onClick({ [button.value]: toHome });
    // The password variant fills a custom slot this item has no binding for, and the
    // item's password is empty: the password route would refuse.
    const custom = parseLoginRecipe({
      ...learned,
      slots: ["member-number", "password"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [
            { slot: "member-number", target: target("member") },
            { slot: "password", target: target("password") },
          ],
        },
        recipe.steps[1]!,
      ],
    });
    const { h } = start(custom, {}, { bindings: [] });
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields =
          response.catalog.connections[0]!.items[0]!.fields.map((field) =>
            field.id === "login.password" ? { ...field, empty: true as const } : field,
          );
      return response;
    });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({
      route: "passkey",
      facts: { password: false, discoverablePasskey: true },
    });
    expect(fills()).toBe(0);
    // Without the passkey, the same item refuses as before.
    const refused = start(custom, { passkeys: secondFactor() }, { bindings: [] });
    refused.h.store.handle.mockImplementation(h.store.handle.getMockImplementation()!);
    expect(await refused.h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
  });

  it("watches the passkey button first and stops when it never shows, filling nothing", async () => {
    const { h } = start(learned);
    h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: recipeStartSteps(learned) }]);
    const watched = await h.hello({}, false);
    expect(watched).toMatchObject({ ok: false, reason: "form-not-ready" });
    expect(
      (watched as { starts: { targets: unknown[] }[] }).starts.map((entry) => entry.targets),
    ).toEqual([[button], [target("password")]]);
    // The password form was ready, but the chosen route's button never appears.
    fake.state.awaited = { ok: false, reason: "timeout" };
    expect(await h.hello({ documentId: "ready-document" })).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([
        { route: "passkey", state: "blocked", outcome: "retry-limit", submissions: 0 },
      ]),
    );
    const awaited = fake.state.messages.find((entry) => entry.type === "login.await") as
      | { readiness: { targets: unknown[] } }
      | undefined;
    expect(awaited?.readiness.targets).toEqual([button]);
    expect(executed()).toEqual([]);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("holds the page while the button shows and judges it on the passkey route once gone", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/signin", present: [button.value] } });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
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
      routed.id,
      routed.revision,
      "passkey",
      homePage.observation,
      expect.any(Function),
    );
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });

  it("holds the clicking document whatever path a same-document URL change gives it", async () => {
    vi.useFakeTimers();
    // The page moves to another path with pushState while its passkey prompt still shows.
    onClick({ [button.value]: { path: "/signin/verify", present: [button.value] } });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ state: "awaiting-result" });
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["logout"]);
    fake.state.extracted = { "signed-in": homePage };
    await until(settled("authenticated"));
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });

  it("ends as a challenge when the button still shows after two minutes", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/signin", present: [button.value] } });
    const service = generation();
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    await vi.advanceTimersByTimeAsync(115_000);
    expect(status()![0]).toMatchObject({ state: "awaiting-result" });
    await until(settled("blocked", "challenge"), 10_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
  });

  it("leaves a new document that shows the button again to the person at once", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/signin", present: [button.value, "password"] } });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => clicks(button.value) === 1);
    // The page reloads back to the start page, which shows the button and the form again.
    await h.hello({ documentId: "reloaded" }, false);
    await until(settled("blocked", "challenge"), 5_000);
    expect(service.judge).not.toHaveBeenCalled();
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("never sends the start page that shows the password form again without the button", async () => {
    vi.useFakeTimers();
    // The click re-renders the start page's password form in the same document.
    onClick({
      [button.value]: {
        path: "/signin",
        present: ["password", "login"],
        extracted: observation("/signin", [
          { id: "c1", role: "password", target: target("password"), label: "Password" },
          { id: "c2", role: "button", target: target("login"), label: "Log in" },
        ]),
      },
    });
    const service = generation(async () => ({ verdict: "rejected" }));
    const { h } = start(routed, { generation: service });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "challenge"), 20_000);
    // Judging it would spend the start path's one judgement and could add a handler there.
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(clicks(button.value)).toBe(1);
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it.each<[string, LoginGeneration["judge"] | undefined]>([
    ["unclear", async () => ({ verdict: "unclear" })],
    ["rejected", async () => ({ verdict: "rejected" })],
    ["challenge without a handler", async () => ({ verdict: "challenge" })],
    ["a temporary refusal", async () => ({ verdict: "retry", reason: "busy" })],
    ["no judgement at all", undefined],
  ])("ends as a challenge after %s, never typing the password", async (_label, judge) => {
    vi.useFakeTimers();
    onClick({ [button.value]: { path: "/elsewhere", present: [], extracted: elsewhere } });
    const service = judge ? generation(judge) : undefined;
    const { h } = start(routed, service ? { generation: service } : {});
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "challenge"), 20_000);
    if (service) expect(service.judge).toHaveBeenCalledTimes(1);
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(status()![0]!["settled"]).toBeUndefined();
    expect(fills()).toBe(0);
    expect(h.fields).not.toHaveBeenCalled();
  });

  it("ends as a challenge on the rejection marker", async () => {
    onClick({ [button.value]: { path: "/signin", present: ["rejected"] } });
    const { h } = start(parseLoginRecipe({ ...learned, rejection: target("rejected") }));
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
    );
    expect(fills()).toBe(0);
  });

  it("saves only the site default after a signed-in page, never a binding", async () => {
    vi.useFakeTimers();
    onClick({ [button.value]: toHome });
    const service = generation(async () => ({ verdict: "signed-in" }));
    const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true, data: uriMatch() }));
    const { h } = start(
      routed,
      { generation: service, uris, allowedOrigins: [] },
      { siteDefaults: [], bindings: [] },
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => h.store.update.mock.calls.length === 1);
    expect(status()![0]).toMatchObject({ state: "authenticated", route: "passkey" });
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
    expect(h.settings.settings.bindings).toEqual([]);
  });

  it("still runs a handler on the page after the passkey click", async () => {
    const securityKey = { by: "text" as const, value: "Use security key" };
    onClick({
      [button.value]: { path: "/login/webauthn", present: [securityKey.value] },
      [securityKey.value]: toHome,
    });
    const { h } = start(
      parseLoginRecipe({
        ...learned,
        handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
      }),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(
      executed().map((step) => (step.kind === "click" ? step.target.value : step.kind)),
    ).toEqual([button.value, securityKey.value]);
    expect(status()![0]).toMatchObject({
      route: "passkey",
      handlers: [{ index: 0, start: 1 }],
      stepCount: 2,
    });
  }, 10_000);

  it("resumes on the passkey route without reading the facts again", async () => {
    const passkeys = vi.fn(async () => ({ passkey: true, discoverable: true }));
    onClick({ [button.value]: { path: "/next", present: [] } });
    const { h, report } = start(learned, { passkeys });
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(clicks(button.value)).toBe(1));
    // The passkey is removed from the vault meanwhile; the running login keeps its route.
    passkeys.mockResolvedValue({ passkey: false, discoverable: false });
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    fake.state.present = new Set(["logout"]);
    await h.hello({ documentId: "next-page" }, false);
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]));
    expect(status()![0]).toMatchObject({ route: "passkey" });
    expect(passkeys).toHaveBeenCalledTimes(1);
    expect(fills()).toBe(0);
    // Diagnostics name the route without a variant and never the item's facts.
    const attempts = report.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.type === "attempt");
    expect(attempts).not.toEqual([]);
    for (const entry of attempts) {
      expect(entry).toMatchObject({ route: "passkey" });
      expect(entry).not.toHaveProperty("variant");
    }
    const serialized = JSON.stringify(report.mock.calls);
    for (const key of ['"facts"', '"discoverablePasskey"', '"discoverable"', '"totp"'])
      expect(serialized).not.toContain(key);
  });

  describe("a totp handler after the passkey click, probed independently", () => {
    const codeHandler = {
      kind: "totp" as const,
      path: "/two-factor",
      field: target("app-code"),
      target: target("verify"),
    };
    const toCode = { path: "/two-factor", present: ["app-code", "verify"] };
    const withCode = parseLoginRecipe({ ...learned, handlers: [codeHandler] });
    const codeFills = () =>
      fake.state.messages.filter(
        (entry) =>
          entry.type === "login.execute" && entry.values?.some((value) => value.slot === "totp"),
      );
    const handlerOutcomes = (report: ReturnType<typeof vi.fn<(report: LoginReport) => void>>) =>
      report.mock.calls.flatMap(([value]) =>
        value.type === "handler" ? [[value.handler, value.kind, value.outcome]] : [],
      );
    /** Adds the item's built-in TOTP field and answers its read with a synthetic code. */
    const withTotp = (h: ReturnType<typeof harness>) => {
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          response.catalog.connections[0]!.items[0]!.fields.push({
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
          });
        return response;
      });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
    };

    it("types the code on the page after the passkey click and keeps the route", async () => {
      onClick({ [button.value]: toCode, verify: toHome });
      const { h, report } = start(withCode);
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 6_000,
      });
      expect(status()![0]).toMatchObject({
        route: "passkey",
        facts: { totp: true },
        handlers: [{ index: 0, start: 1 }],
        stepCount: 3,
        submissions: 2,
      });
      expect(
        executed().map((step) => (step.kind === "click" ? step.target.value : step.kind)),
      ).toEqual([button.value, "fill", "verify"]);
      expect(codeFills().map((entry) => entry.values)).toEqual([
        [{ slot: "totp", value: "012345", secret: "otp" }],
      ]);
      // Only the code is read; no password is.
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).toEqual(["login.totp-code"]);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "entered"]]);
      // Nothing is saved for the passkey route's login.
      expect(h.settings.settings.bindings).toEqual([savedBinding]);
    }, 10_000);

    it("never types a custom field a saved binding names for the code on this route", async () => {
      onClick({ [button.value]: toCode, verify: toHome });
      const bindings = [
        {
          ...savedBinding,
          recipeId: withCode.id,
          slots: [
            { slot: "password", field: "password" as const },
            { slot: "totp", field: { custom: "Branch" } },
          ],
        },
      ];
      const { h, report } = start(withCode, {}, { bindings });
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(status()).toMatchObject([{ state: "blocked", outcome: "challenge" }]),
      );
      expect(status()![0]).toMatchObject({ route: "passkey" });
      expect(h.fields).not.toHaveBeenCalled();
      expect(codeFills()).toEqual([]);
      expect(handlerOutcomes(report)).toEqual([[0, "totp", "missing-fact"]]);
    });

    it("takes over a revision that adds a totp handler on the passkey route", async () => {
      vi.useFakeTimers();
      const codePage = observation("/two-factor", [
        {
          id: "c1",
          role: "text",
          target: target("app-code"),
          label: "Code",
          autocomplete: "one-time-code",
        },
        { id: "c2", role: "button", target: target("verify"), label: "Verify" },
      ]);
      onClick({ [button.value]: { ...toCode, extracted: codePage }, verify: toHome });
      const taken = parseLoginRecipe({ ...routed, revision: 2, handlers: [codeHandler] });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: taken })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const { h } = start(routed, { generation: service });
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "passkey",
        recipeRevision: 2,
        handlers: [{ index: 0, start: 1 }],
        stepCount: 3,
        submissions: 2,
      });
      expect(service.judge.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        [1, "passkey"],
        [2, "passkey"],
      ]);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(clicks(button.value)).toBe(1);
    });

    it("leaves a code page shown again in a new document to the person on this route", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: toCode, verify: toCode });
      const { h, report } = start(withCode);
      withTotp(h);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks("verify") === 1);
      fake.state.pageUrl = `${origin}/two-factor`;
      await h.hello({ documentId: "again" }, false);
      await until(settled("blocked", "challenge"), 5_000);
      expect(codeFills()).toHaveLength(1);
      expect(clicks("verify")).toBe(1);
      expect(handlerOutcomes(report)).toEqual([
        [0, "totp", "entered"],
        [0, "totp", "shown-again"],
      ]);
    });
  });

  describe("the held click", () => {
    const securityKey = { by: "text" as const, value: "Use security key" };
    const webauthnPage = observation("/login/webauthn", [
      { id: "c1", role: "button", target: securityKey, label: "Use security key" },
    ]);
    const toWebauthn = {
      path: "/login/webauthn",
      present: [securityKey.value],
      extracted: webauthnPage,
    };
    const signedIn = () => {
      fake.state.observedPath = "/home";
      fake.state.present = new Set(["logout"]);
      fake.state.extracted = { "signed-in": homePage };
    };

    it("never runs a start-page handler on a new document that shows the button again", async () => {
      vi.useFakeTimers();
      // A handler on the start path, such as a key prompt, shows beside the button.
      const prompted = parseLoginRecipe({
        ...routed,
        handlers: [{ kind: "passkey", path: "/signin", target: securityKey }],
      });
      onClick({ [button.value]: { path: "/signin", present: [button.value, securityKey.value] } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h } = start(prompted, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      // The clicking document holds: the handler is not entered while its button shows.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(clicks(securityKey.value)).toBe(0);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", handlers: [] });
      // The tab reloads back to the start page: it goes to the person at once.
      await h.hello({ documentId: "reloaded" }, false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(clicks(securityKey.value)).toBe(0);
      expect(clicks(button.value)).toBe(1);
      expect(status()![0]).toMatchObject({
        route: "passkey",
        state: "blocked",
        outcome: "challenge",
        handlers: [],
      });
      expect(service.judge).not.toHaveBeenCalled();
    });

    it("treats the clicking document as new after a worker restart and ends at once", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: { path: "/signin", present: [button.value] } });
      const service = generation(async () => ({ verdict: "signed-in" }));
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result" });
      // The hold lived in the old worker's memory; the same document announces itself again.
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        const restarted = start(routed, { generation: service });
        await restarted.h.hello({}, false);
        // Well before the 3 seconds an unexplained page would get.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(status()![0]).toMatchObject({ state: "blocked", outcome: "challenge" });
      } finally {
        fake.browser.tabs.query = query;
      }
      expect(clicks(button.value)).toBe(1);
      expect(service.judge).not.toHaveBeenCalled();
    });

    it.each<[string, (h: ReturnType<typeof harness>) => void, Record<string, unknown>]>([
      [
        "a settings revision",
        (h) => {
          h.settings.revision += 1;
        },
        { cause: "settings-revision" },
      ],
      [
        "the item's exclusion",
        (h) => {
          h.settings.settings.connections[0]!.excludedItemIds = [itemId];
        },
        { cause: "plan" },
      ],
    ])(
      "ends as a policy change, not a challenge, after %s during the hold",
      async (_l, edit, cause) => {
        vi.useFakeTimers();
        onClick({ [button.value]: { path: "/signin", present: [button.value] } });
        const service = generation(async () => ({ verdict: "signed-in" }));
        const { h, report } = start(routed, { generation: service });
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => clicks(button.value) === 1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(status()![0]).toMatchObject({ state: "awaiting-result" });
        edit(h);
        await until(settled("blocked", "policy-changed"), 5_000);
        expect(report.mock.calls.at(-1)![0]).toMatchObject({
          type: "attempt",
          route: "passkey",
          outcome: "policy-changed",
          ...cause,
        });
        // The page that follows is neither judged nor taken as signed in.
        signedIn();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(status()![0]).toMatchObject({ state: "blocked", outcome: "policy-changed" });
        expect(service.judge).not.toHaveBeenCalled();
      },
    );

    it("names the login's item for the passkey bridge while the click is held", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: { path: "/signin", present: [button.value] } });
      const { h } = start(routed, { generation: generation() });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => clicks(button.value) === 1);
      await vi.advanceTimersByTimeAsync(60_000);
      // The passkey request the click causes is answered with this login's item only.
      expect(await h.login.loginAccount(1, origin)).toEqual({ connectionId, itemId });
      expect(await h.login.loginAccount(1, "https://other.example")).toBeUndefined();
      expect(await h.login.loginAccount(2, origin)).toBeUndefined();
      await until(settled("blocked", "challenge"));
      expect(await h.login.loginAccount(1, origin)).toBeUndefined();
    });

    it("takes over a revision that adds a handler, judging both pages on the passkey route", async () => {
      vi.useFakeTimers();
      onClick({ [button.value]: toWebauthn, [securityKey.value]: toHome });
      const taken = parseLoginRecipe({
        ...routed,
        revision: 2,
        handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
      });
      const service = generation();
      service.judge
        .mockResolvedValueOnce({ verdict: "challenge", recipe: taken })
        .mockResolvedValueOnce({ verdict: "signed-in" });
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(status()![0]).toMatchObject({
        route: "passkey",
        recipeRevision: 2,
        handlers: [{ index: 0, start: 1 }],
        stepCount: 2,
        submissions: 2,
      });
      expect(status()![0]).not.toHaveProperty("variant");
      expect(service.judge.mock.calls.map((call) => call.slice(0, 4))).toEqual([
        [routed.id, 1, "passkey", webauthnPage.observation],
        [routed.id, 2, "passkey", homePage.observation],
      ]);
      expect(clicks(button.value)).toBe(1);
      expect(clicks(securityKey.value)).toBe(1);
      expect(fills()).toBe(0);
    });

    it.each<[string, Record<string, unknown>]>([
      ["moves the passkey button", { passkey: { path: "/signin", target: target("other") } }],
      ["drops the passkey route", { passkey: undefined }],
    ])("keeps its revision and ends as a challenge when the next one %s", async (_l, change) => {
      vi.useFakeTimers();
      onClick({ [button.value]: toWebauthn, [securityKey.value]: toHome });
      const next = parseLoginRecipe({
        ...routed,
        revision: 2,
        handlers: [{ kind: "passkey", path: "/login/webauthn", target: securityKey }],
        ...change,
      });
      const service = generation();
      service.judge.mockResolvedValueOnce({ verdict: "challenge", recipe: next });
      const { h } = start(routed, { generation: service });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"), 20_000);
      expect(status()![0]).toMatchObject({ route: "passkey", recipeRevision: 1, handlers: [] });
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(clicks(securityKey.value)).toBe(0);
    });
  });
});

describe("an advance whose next step is on the same path (ADR 0013)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    vi.useFakeTimers();
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
    // An identifier-first form: the email form shows, the password form is hidden.
    fake.state.present = new Set(["email", "next", "password", "login"]);
    fake.state.unusable = new Set(["password", "login"]);
    fake.state.ambiguous = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });

  const identifierFirst = (steps?: unknown[]) =>
    parseLoginRecipe({
      ...recipe,
      slots: ["username", "password"],
      steps: steps ?? [
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
        { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ],
      rejection: target("rejected"),
      maxSubmissions: 2,
    });
  const status = () =>
    fake.state.storage["pateat.login-attempts.v3"] as Record<string, unknown>[] | undefined;
  /** The steps the document was asked to run, as `kind:element`. */
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => {
        const { step } = (
          entry as unknown as {
            operation: {
              step: {
                kind: string;
                target?: { value: string };
                fields?: { target: { value: string } }[];
              };
            };
          }
        ).operation;
        return `${step.kind}:${step.target?.value ?? step.fields?.map((field) => field.target.value).join(",")}`;
      });
  async function until(check: () => boolean, maxMs = 30_000) {
    for (let spent = 0; !check(); spent += 100) {
      if (spent > maxMs) throw new Error("Condition not reached in fake time");
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(100);
    }
  }
  const settled = (state: string, outcome?: string) => () =>
    status()?.[0]?.["state"] === state &&
    (outcome === undefined || status()?.[0]?.["outcome"] === outcome);
  /** Next hides the email form and shows the password form; Log in signs in. */
  const swapForms = (also?: () => void) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click") return;
      if (step.target?.value === "next") {
        fake.state.unusable = new Set(["email", "next"]);
        also?.();
      }
      if (step.target?.value === "login") fake.state.present?.add("authenticated");
    };
  };
  const start = (withRecipe = identifierFirst(), live: Parameters<typeof harness>[1] = {}) => {
    const h = harness(
      {
        bindings: [
          {
            ...savedBinding,
            slots: [
              { slot: "username", field: "username" },
              { slot: "password", field: "password" },
              { slot: "branch", field: { custom: "Branch" } },
            ],
          },
        ],
      },
      { username: true, ...live },
    );
    h.recipes.recipe.mockResolvedValue(withRecipe);
    h.recipes.starts.mockResolvedValue(startsOf([withRecipe.steps[0]!]));
    return h;
  };
  const allSteps = ["fill:email", "click:next", "fill:password", "click:login"];

  it("continues in the same document once the password form shows", async () => {
    swapForms();
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
    // Only the Next click has the document measure the password field, as its fill waits
    // for it, in the same task as the click.
    expect(
      fake.state.messages
        .filter((entry) => entry.type === "login.execute")
        .map((entry) => (entry as Record<string, unknown>)["next"]),
    ).toEqual([
      undefined,
      { path: "/signin", require: "writable", targets: [target("password")] },
      undefined,
      undefined,
    ]);
  });

  it("continues after a same-document URL change that keeps the path", async () => {
    let announced: Promise<unknown> | undefined;
    const h = start();
    swapForms(() => {
      // `history.pushState` to the same path with another query; the document announces
      // again and is told it already carries the attempt.
      fake.state.pageUrl = "https://login.example/signin?step=password";
      announced = h.hello();
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(await announced).toEqual({ ok: false, reason: "duplicate-document" });
    expect(executed()).toEqual(allSteps);
  });

  it("continues in a new document the form was posted to on the same path", async () => {
    const h = start();
    swapForms(() => fake.state.gone.add("synthetic-document"));
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await until(() => status()?.[0]?.["state"] === "reconciling");
    // The new document shows only the password form.
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    expect(await h.hello({ documentId: "posted" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
  });

  it("waits for a password form that shows late and continues within the limit", async () => {
    swapForms(() => {
      // The email form goes, but the password form shows only after nine seconds.
      fake.state.unusable = new Set(["email", "next", "password", "login"]);
      setTimeout(() => (fake.state.unusable = new Set(["email", "next"])), 9_000);
    });
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
  });

  it("ends as unknown after ten seconds without the password form, never clicking Next again", async () => {
    // The email form is still shown and writable; the password form never shows.
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
    expect(status()![0]!["outcome"]).toBeUndefined();
    await until(settled("reconciling", "unknown-submit"), 5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 1 });
  });

  it("never continues when the password form already showed before Next", async () => {
    // Both forms show from the start; that page needs a one-step recipe.
    fake.state.unusable = new Set();
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("never continues to a step that clicks the advance's own button again", async () => {
    fake.state.unusable = new Set();
    const h = start(
      identifierFirst([
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
        { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        { kind: "click", path: "/signin", target: target("next"), purpose: "submit" },
      ]),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(["fill:email", "click:next"]);
  });

  it("never continues on the same path after a click that submits", async () => {
    swapForms();
    const h = start(
      identifierFirst([
        { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
        { kind: "click", path: "/signin", target: target("next"), purpose: "submit" },
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "password", target: target("password") }],
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ]),
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("settles a rejection shown after Next before looking for the password form", async () => {
    swapForms(() => fake.state.present?.add("rejected"));
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "credential-rejected"));
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("never continues when the password form shows after Next's wait but before its click", async () => {
    swapForms();
    const h = start();
    // The page reveals the password form by itself while the click is being prepared,
    // after the Next button's wait, as a debounced input handler may.
    const original = h.store.handle.getMockImplementation()!;
    let revealedAfter: number | undefined;
    h.store.handle.mockImplementation(async () => {
      if (status()?.[0]?.["state"] === "submit-intent" && revealedAfter === undefined) {
        fake.state.unusable = new Set(["login"]);
        revealedAfter = executed().length;
      }
      return original();
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    // Revealed after the email fill and before the Next click.
    expect(revealedAfter).toBe(1);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("never continues when part of the next step was usable before Next", async () => {
    // The branch field already shows beside the account form; only the password is new.
    swapForms();
    const h = start(
      parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "branch", "password"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "username", target: target("email") }],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
          {
            kind: "fill",
            path: "/signin",
            fields: [
              { slot: "branch", target: target("branch") },
              { slot: "password", target: target("password") },
            ],
          },
          { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
        ],
      }),
    );
    fake.state.present?.add("branch");
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("never continues when the password field matched several elements before Next", async () => {
    fake.state.ambiguous = new Set(["password"]);
    swapForms(() => (fake.state.ambiguous = new Set()));
    const h = start();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"), 15_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("types the password before a handler shown with the password form on that path", async () => {
    // As on another path, the route's next step comes before the recipe's handlers.
    const securityKey = { by: "text" as const, value: "Use security key" };
    swapForms(() => fake.state.present?.add(securityKey.value));
    const h = start(
      parseLoginRecipe({
        ...identifierFirst(),
        handlers: [{ kind: "passkey", path: "/signin", target: securityKey }],
      }),
      { passkeys: async () => ({ passkey: true, discoverable: false }) },
    );
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ handlers: [] });
  });

  describe("further shapes", () => {
    /** Starts a login with these binding slots and live catalog options. */
    const begin = (
      used: LoginRecipe,
      slots: SavedLoginBinding["slots"],
      live: Parameters<typeof harness>[1] = {},
    ) => {
      const h = harness({ bindings: [{ ...savedBinding, slots }] }, { username: true, ...live });
      h.recipes.recipe.mockResolvedValue(used);
      h.recipes.starts.mockResolvedValue(startsOf([used.steps[0]!]));
      return h;
    };
    /** Runs `react` with each executed step's kind and element, as the page reacts. */
    const onStep = (react: (kind: string, element: string) => void) => {
      fake.state.onExecute = async (message) => {
        const { step } = message["operation"] as { step: LoginStep };
        react(step.kind, step.kind === "fill" ? step.fields[0]!.target.value : step.target.value);
      };
    };
    /** The `next` each executed step asked the document to measure before its effect. */
    const nexts = () =>
      fake.state.messages
        .filter((entry) => entry.type === "login.execute")
        .map((entry) => (entry as Record<string, unknown>)["next"]);
    const measures = (value: string) => ({
      path: "/signin",
      require: "writable",
      targets: [target(value)],
    });
    const usernamePassword: SavedLoginBinding["slots"] = [
      { slot: "username", field: "username" },
      { slot: "password", field: "password" },
    ];
    const emailFill = {
      kind: "fill" as const,
      path: "/signin",
      fields: [{ slot: "username", target: target("email") }],
    };
    const nextClick = {
      kind: "click" as const,
      path: "/signin",
      target: target("next"),
      purpose: "advance" as const,
    };
    const passwordFill = {
      kind: "fill" as const,
      path: "/signin",
      fields: [{ slot: "password", target: target("password") }],
    };
    const loginClick = {
      kind: "click" as const,
      path: "/signin",
      target: target("login"),
      purpose: "submit" as const,
    };

    /**
     * No buttons: typing the email shows the password form, and typing the password signs
     * in. A recipe allows no click after an input-triggered effect on its path.
     */
    const typed = () =>
      identifierFirst([
        { ...emailFill, effect: "advance", event: "input" },
        { ...passwordFill, effect: "submit", event: "input" },
      ]);

    it("continues after an email fill whose input event shows the password form", async () => {
      fake.state.present = new Set(["email", "password"]);
      fake.state.unusable = new Set(["password"]);
      onStep((kind, element) => {
        if (kind !== "fill") return;
        if (element === "email") fake.state.unusable = new Set();
        if (element === "password") fake.state.present?.add("authenticated");
      });
      const h = start(typed());
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(["fill:email", "fill:password"]);
      expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 2 });
      // The email fill has the document measure the password field before its first input.
      expect(nexts()).toEqual([measures("password"), undefined]);
    });

    it("never continues when the password form shows after the email fill's wait but before its input", async () => {
      fake.state.present = new Set(["email", "password"]);
      fake.state.unusable = new Set(["password"]);
      const h = start(typed());
      // The page reveals the password form by itself while the fill is being prepared.
      const original = h.store.handle.getMockImplementation()!;
      let revealed = false;
      h.store.handle.mockImplementation(async () => {
        if (status()?.[0]?.["state"] === "submit-intent" && executed().length === 0) {
          fake.state.unusable = new Set();
          revealed = true;
        }
        return original();
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(revealed).toBe(true);
      expect(executed()).toEqual(["fill:email"]);
    });

    it("never continues after an input-triggered email fill when the password form already showed", async () => {
      fake.state.present = new Set(["email", "password"]);
      fake.state.unusable = new Set();
      const h = start(typed());
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email"]);
    });

    it("continues through two identifier stages on one path to the password", async () => {
      // Email, then a member number, then the password, each swapped in by its Next.
      fake.state.present = new Set(["email", "next", "member", "next2", "password", "login"]);
      fake.state.unusable = new Set(["member", "next2", "password", "login"]);
      onStep((kind, element) => {
        if (kind !== "click") return;
        if (element === "next")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
        if (element === "next2")
          fake.state.unusable = new Set(["email", "next", "member", "next2"]);
        if (element === "login") fake.state.present?.add("authenticated");
      });
      const staged = parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "member", "password"],
        steps: [
          emailFill,
          nextClick,
          { kind: "fill", path: "/signin", fields: [{ slot: "member", target: target("member") }] },
          { kind: "click", path: "/signin", target: target("next2"), purpose: "advance" },
          passwordFill,
          loginClick,
        ],
        maxSubmissions: 3,
      });
      const h = begin(staged, [
        { slot: "username", field: "username" },
        { slot: "member", field: { custom: "Branch" } },
        { slot: "password", field: "password" },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual([
        "fill:email",
        "click:next",
        "fill:member",
        "click:next2",
        "fill:password",
        "click:login",
      ]);
      expect(status()![0]).toMatchObject({ stepIndex: 5, submissions: 3 });
      // Each Next measures its own next step; nothing else does.
      expect(nexts()).toEqual([
        undefined,
        measures("member"),
        undefined,
        measures("password"),
        undefined,
        undefined,
      ]);
    });

    it("stops after the second Next when the password form never shows, clicking each Next once", async () => {
      fake.state.present = new Set(["email", "next", "member", "next2", "password", "login"]);
      fake.state.unusable = new Set(["member", "next2", "password", "login"]);
      onStep((kind, element) => {
        // The second Next leaves the member form shown; the password form never comes.
        if (kind === "click" && element === "next")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
      });
      const staged = parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "member", "password"],
        steps: [
          emailFill,
          nextClick,
          { kind: "fill", path: "/signin", fields: [{ slot: "member", target: target("member") }] },
          { kind: "click", path: "/signin", target: target("next2"), purpose: "advance" },
          passwordFill,
          loginClick,
        ],
        maxSubmissions: 3,
      });
      const h = begin(staged, [
        { slot: "username", field: "username" },
        { slot: "member", field: { custom: "Branch" } },
        { slot: "password", field: "password" },
      ]);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 4);
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email", "click:next", "fill:member", "click:next2"]);
      expect(status()![0]).toMatchObject({ stepIndex: 3, submissions: 2 });
    });

    it("continues in place in a recipe with a handler on that path, then enters the handler", async () => {
      // The TOTP form also lives on /signin and shows in place after Log in.
      fake.state.present = new Set(["email", "next", "password", "login", "code", "verify"]);
      fake.state.unusable = new Set(["password", "login", "code", "verify"]);
      onStep((kind, element) => {
        if (kind !== "click") return;
        if (element === "next") fake.state.unusable = new Set(["email", "next", "code", "verify"]);
        if (element === "login")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
        if (element === "verify") fake.state.present?.add("authenticated");
      });
      const handled = parseLoginRecipe({
        ...identifierFirst(),
        handlers: [
          { kind: "totp", path: "/signin", field: target("code"), target: target("verify") },
        ],
      });
      const h = begin(handled, usernamePassword);
      const original = h.store.handle.getMockImplementation()!;
      h.store.handle.mockImplementation(async () => {
        const response = await original();
        if (response.ok)
          (response.catalog.connections[0]!.items[0]!.fields as unknown[]).push({
            id: "login.totp-code",
            label: "Verification code",
            name: null,
            kind: "otp",
          });
        return response;
      });
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
      );
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual([...allSteps, "fill:code", "click:verify"]);
      expect(status()![0]).toMatchObject({ handlers: [{ index: 0, start: 4 }] });
    });

    it("never enters a handler on that path while waiting for the password form", async () => {
      // Next shows the TOTP form instead of the password form: the advance is not
      // confirmed, and a handler is entered only after a step that submits.
      fake.state.present = new Set(["email", "next", "password", "login", "code", "verify"]);
      fake.state.unusable = new Set(["password", "login", "code", "verify"]);
      onStep((kind, element) => {
        if (kind === "click" && element === "next")
          fake.state.unusable = new Set(["email", "next", "password", "login"]);
      });
      const handled = parseLoginRecipe({
        ...identifierFirst(),
        handlers: [
          { kind: "totp", path: "/signin", field: target("code"), target: target("verify") },
        ],
      });
      const h = begin(handled, usernamePassword);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(executed()).toEqual(allSteps.slice(0, 2));
    });

    describe("with password variants", () => {
      /** Variant 0 asks for a PIN after Next; variant 1, for the password. */
      const varied = () =>
        parseLoginRecipe({
          ...identifierFirst(),
          slots: ["username", "pin"],
          steps: [
            emailFill,
            nextClick,
            { kind: "fill", path: "/signin", fields: [{ slot: "pin", target: target("pin") }] },
            loginClick,
          ],
          alternatives: [
            {
              slots: ["contract", "password"],
              steps: [
                {
                  kind: "fill",
                  path: "/signin",
                  fields: [{ slot: "contract", target: target("contract") }],
                },
                nextClick,
                passwordFill,
                loginClick,
              ],
            },
          ],
        });
      const byContract: SavedLoginBinding["slots"] = [
        { slot: "contract", field: { custom: "Contract" } },
        { slot: "password", field: "password" },
      ];
      const contractOnly = { custom: [{ name: "Contract", kind: "text" as const }] };
      beforeEach(() => {
        fake.state.present = new Set(["email", "contract", "next", "pin", "password", "login"]);
        fake.state.unusable = new Set(["pin", "password", "login"]);
      });

      it("continues when the chosen variant's next step shows", async () => {
        onStep((kind, element) => {
          if (kind !== "click") return;
          if (element === "next")
            fake.state.unusable = new Set(["email", "contract", "next", "pin"]);
          if (element === "login") fake.state.present?.add("authenticated");
        });
        const h = begin(varied(), byContract, contractOnly);
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(status()![0]).toMatchObject({ variant: 1 });
        expect(executed()).toEqual(["fill:contract", "click:next", "fill:password", "click:login"]);
      });

      it("never continues when only another variant's next step shows", async () => {
        onStep((kind, element) => {
          if (kind === "click" && element === "next")
            fake.state.unusable = new Set(["email", "contract", "next", "password", "login"]);
        });
        const h = begin(varied(), byContract, contractOnly);
        expect(await h.hello()).toEqual({ ok: true });
        await until(() => executed().length === 2);
        await until(settled("reconciling", "unknown-submit"), 15_000);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(status()![0]).toMatchObject({ variant: 1 });
        expect(executed()).toEqual(["fill:contract", "click:next"]);
      });
    });

    it("never continues on a password form that shows and hides again between checks", async () => {
      onStep((kind, element) => {
        if (kind !== "click" || element !== "next") return;
        fake.state.unusable = new Set(["email", "next", "password", "login"]);
        // Shown for 100 ms between two of the 200 ms checks, then gone again.
        setTimeout(() => (fake.state.unusable = new Set(["email", "next"])), 50);
        setTimeout(
          () => (fake.state.unusable = new Set(["email", "next", "password", "login"])),
          150,
        );
      });
      const h = start();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // Next measured the password form hidden, in the same task as its click.
      expect(nexts()).toEqual([undefined, measures("password")]);
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(allSteps.slice(0, 2));
    });

    it("never continues when an unknown account shows the email form again", async () => {
      onStep((kind, element) => {
        if (kind !== "click" || element !== "next") return;
        // The email form goes, then comes back with an error that is not the recipe's
        // rejection; the password form stays hidden.
        fake.state.unusable = new Set(["email", "next", "password", "login"]);
        setTimeout(() => {
          fake.state.unusable = new Set(["password", "login"]);
          fake.state.present?.add("account-error");
        }, 500);
      });
      const h = start();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(status()![0]).toMatchObject({ state: "awaiting-result", stepIndex: 1 });
      await until(settled("reconciling", "unknown-submit"), 5_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(status()![0]).toMatchObject({ stepIndex: 1, submissions: 1 });
    });

    it("checks a later advance's new document against that advance's own check", async () => {
      // Each Next posts the form back to /signin. The second document already shows the
      // password form before its Next, so the third one cannot confirm that Next, whatever
      // the first Next found.
      const staged = parseLoginRecipe({
        ...identifierFirst(),
        slots: ["username", "member", "password"],
        steps: [
          emailFill,
          nextClick,
          { kind: "fill", path: "/signin", fields: [{ slot: "member", target: target("member") }] },
          { kind: "click", path: "/signin", target: target("next2"), purpose: "advance" },
          passwordFill,
          loginClick,
        ],
        maxSubmissions: 3,
      });
      const h = begin(staged, [
        { slot: "username", field: "username" },
        { slot: "member", field: { custom: "Branch" } },
        { slot: "password", field: "password" },
      ]);
      fake.state.present = new Set(["email", "next"]);
      fake.state.unusable = new Set();
      onStep((kind, element) => {
        if (kind !== "click") return;
        if (element === "next") fake.state.gone.add("synthetic-document");
        if (element === "next2") fake.state.gone.add("posted-member");
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await until(() => status()?.[0]?.["state"] === "reconciling");
      fake.state.present = new Set(["member", "next2", "password", "login"]);
      expect(await h.hello({ documentId: "posted-member" }, false)).toEqual({ ok: true });
      await until(() => executed().length === 4);
      await until(() => status()?.[0]?.["state"] === "reconciling");
      fake.state.present = new Set(["password", "login"]);
      expect(await h.hello({ documentId: "posted-password" }, false)).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"), 15_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual(["fill:email", "click:next", "fill:member", "click:next2"]);
    });

    it("ends as unknown after a worker restart while Next runs, never filling or clicking again", async () => {
      onStep((kind, element) => {
        if (kind === "click" && element === "next")
          fake.state.unusable = new Set(["email", "next"]);
      });
      // The page never answers Next, as when the worker stops while it runs.
      const answered = fake.state.onExecute!;
      fake.state.onExecute = async (message, tabId) => {
        await answered(message, tabId);
        const { step } = message["operation"] as { step: LoginStep };
        if (step.kind === "click") await new Promise<void>(() => undefined);
      };
      const h = start();
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await until(() => status()?.[0]?.["state"] === "submit-intent");
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        // A new worker has only the stored attempt; the password form now shows.
        fake.state.onExecute = undefined;
        const restarted = start();
        expect(await restarted.login.active()).toBe(true);
        expect(status()![0]).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
        expect(await restarted.hello({}, false)).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(executed()).toEqual(allSteps.slice(0, 2));
        expect(status()![0]).toMatchObject({
          state: "reconciling",
          outcome: "unknown-submit",
          stepIndex: 1,
          submissions: 1,
        });
        // A new document of the tab does not continue either.
        expect(await restarted.hello({ documentId: "after-restart" }, false)).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(executed()).toEqual(allSteps.slice(0, 2));
      } finally {
        fake.browser.tabs.query = query;
      }
    });

    describe("beside a passkey route", () => {
      const button = { by: "text" as const, value: "Sign in with a passkey" };
      const routed = () =>
        parseLoginRecipe({ ...identifierFirst(), passkey: { path: "/signin", target: button } });
      beforeEach(() => {
        fake.state.present = new Set(["email", "next", "password", "login", button.value]);
      });

      it("continues in place on the password route", async () => {
        swapForms();
        const h = begin(routed(), usernamePassword, {
          passkeys: async () => ({ passkey: true, discoverable: false }),
        });
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(status()![0]).toMatchObject({ route: "password" });
        expect(executed()).toEqual(allSteps);
      });

      it("only clicks the passkey button on the passkey route, whose one step submits", async () => {
        onStep((kind, element) => {
          if (kind === "click" && element === button.value)
            fake.state.present?.add("authenticated");
        });
        const h = begin(routed(), usernamePassword, {
          passkeys: async () => ({ passkey: true, discoverable: true }),
        });
        expect(await h.hello()).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(status()![0]).toMatchObject({ route: "passkey", stepCount: 1 });
        expect(executed()).toEqual([`click:${button.value}`]);
      });
    });
  });
});

describe("continuing a generated recipe after its final advance (ADR 0018)", () => {
  afterEach(() => {
    vi.useRealTimers();
    fake.state.signIn = false;
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    vi.useFakeTimers();
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
    // The email page: its field and Next show, and no password input yet.
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.signIn = false;
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
  });

  /** A recipe generated from the email page: it fills the email address and clicks Next. */
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: "gen-synthetic-continued",
    revision: 1,
    origin,
    slots: ["username"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
    ],
    maxSubmissions: 1,
  });
  /** The service's next revision: the password page's steps appended. */
  const continuedOn = (path: string, change: Partial<LoginRecipe> = {}) =>
    parseLoginRecipe({
      ...emailFirst,
      revision: 2,
      slots: ["username", "password"],
      steps: [
        ...emailFirst.steps,
        { kind: "fill", path, fields: [{ slot: "password", target: target("password") }] },
        { kind: "click", path, target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 2,
      ...change,
    });
  const describedPage = (path: string, candidates: unknown[], complete = true) => ({
    ok: true,
    observation: { version: 1, origin, path, language: "en", complete, candidates },
  });
  const passwordPage = (path: string, complete = true) =>
    describedPage(
      path,
      [
        { id: "c1", role: "password", target: target("password"), label: "Password" },
        { id: "c2", role: "button", target: target("login"), label: "Log in" },
      ],
      complete,
    );
  const homePage = describedPage("/home", [
    { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
  ]);
  const status = () =>
    fake.state.storage["pateat.login-attempts.v3"] as Record<string, unknown>[] | undefined;
  const executed = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute")
      .map((entry) => {
        const { step } = (
          entry as unknown as {
            operation: {
              step: {
                kind: string;
                target?: { value: string };
                fields?: { target: { value: string } }[];
              };
            };
          }
        ).operation;
        return `${step.kind}:${step.target?.value ?? step.fields?.map((field) => field.target.value).join(",")}`;
      });
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
  const uris = vi.fn<LiveUriMatcher>(async () => ({ ok: true as const, data: uriMatch() }));
  function generation(
    generate: LoginGeneration["generate"] = async () => ({
      outcome: "abstained",
      reason: "ambiguous",
    }),
    judge: LoginGeneration["judge"] = async () => ({ verdict: "signed-in" }),
  ) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
      generate: vi.fn<LoginGeneration["generate"]>(generate),
      judge: vi.fn<LoginGeneration["judge"]>(judge),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
  }
  /** A generated login: no saved account choice, the item found by its URI. */
  function start(
    service: ReturnType<typeof generation>,
    options: {
      recipe?: LoginRecipe;
      settings?: Partial<LocalSettings>;
      report?: LoginReport[];
      custom?: CustomField[];
    } = {},
  ) {
    const reports = options.report;
    const h = harness(options.settings ?? { siteDefaults: [], bindings: [] }, {
      allowedOrigins: [],
      uris,
      username: true,
      custom: options.custom ?? [],
      generation: service,
      ...(reports ? { report: (value: LoginReport) => reports.push(value) } : {}),
    });
    const first = options.recipe ?? emailFirst;
    h.recipes.recipe.mockResolvedValue(first);
    h.recipes.starts.mockResolvedValue(startsOf([first.steps[0]!]));
    return h;
  }
  /** The service appends the password page and the cache holds it before the answer. */
  const answering = (h: () => ReturnType<typeof harness>, next: LoginRecipe) =>
    (async () => {
      h().recipes.recipe.mockResolvedValue(next);
      return { outcome: "recipe" as const, recipe: next };
    }) satisfies LoginGeneration["generate"];
  /**
   * What the clicks do: Next shows the password form (`next`), and Log in signs in on
   * `/home`.
   */
  const onClick = (next: () => void) => {
    fake.state.onExecute = async (message) => {
      const step = (message["operation"] as { step: { kind: string; target?: { value: string } } })
        .step;
      if (step.kind !== "click") return;
      if (step.target?.value === "next") next();
      if (step.target?.value === "login") {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.signIn = false;
        fake.state.extracted = { "signed-in": homePage };
      }
    };
  };
  /** Next swaps the password form in, in the same document on the same path. */
  const inPlace = (also?: () => void) =>
    onClick(() => {
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { login: passwordPage("/signin") };
      also?.();
    });
  const allSteps = ["fill:email", "click:next", "fill:password", "click:login"];
  /** The steps that carried the next step's targets to measure with them (ADR 0013). */
  const measured = () =>
    fake.state.messages
      .filter((entry) => entry.type === "login.execute" && "next" in entry)
      .map((entry) => {
        const { step } = (
          entry as unknown as { operation: { step: { kind: string; target?: { value: string } } } }
        ).operation;
        return `${step.kind}:${step.target?.value ?? ""}`;
      });

  it("continues in the same document on the same path and saves both slots", async () => {
    inPlace();
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    const service = generation(answering(() => h, next));
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // The final advance had no next step when it ran, so nothing was measured with it; the
    // takeover alone moved the login on.
    expect(measured()).toEqual([]);
    // One request with the revision it continues, the page's description and no value.
    expect(service.generate).toHaveBeenCalledTimes(1);
    const request = service.generate.mock.calls[0]![0];
    expect(request).toMatchObject({
      base: { recipeId: emailFirst.id, revision: 1 },
      observation: passwordPage("/signin").observation,
    });
    // The recipe already fills the username, so only the password is offered.
    expect(request.slots.map((slot) => slot.id)).toEqual(["password"]);
    expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
    // The page after the final submission is judged under the continued revision.
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(service.judge.mock.calls[0]!.slice(0, 3)).toEqual([emailFirst.id, 2, "password"]);
    expect(status()![0]).toMatchObject({
      recipeRevision: 2,
      stepIndex: 3,
      stepCount: 4,
      submissions: 2,
      maxSubmissions: 2,
    });
    // The account choice saved after the sign-in binds both pages' slots.
    expect(h.settings.settings.bindings).toEqual([
      expect.objectContaining({
        recipeId: emailFirst.id,
        slots: [
          { slot: "username", field: "username" },
          { slot: "password", field: "password" },
        ],
      }),
    ]);
    expect(h.settings.settings.siteDefaults).toEqual([expect.objectContaining({ itemId })]);
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "recipe",
        recipeId: emailFirst.id,
        baseRevision: 1,
        takenOver: true,
      },
    ]);
    // The read-only email field the recipe filled is left out of the description.
    expect(
      fake.state.messages.find((entry) => entry.type === "login.extract") as unknown,
    ).toMatchObject({ page: "login", known: [target("email")] });
  });

  it("after a logout, only fills the continued recipe's first page and never presses Next", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    const service = generation(answering(() => h, next));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // The site signs out and shows the email page again in the tab (ADR 0021 D).
    h.recipes.starts.mockResolvedValue(startsOf([next.steps[0]!]));
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["email", "next"]);
    fake.state.unusable = new Set();
    fake.state.signIn = false;
    fake.state.extracted = {};
    onClick(() => undefined);
    expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
    await until(() => executed().length === allSteps.length + 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual([...allSteps, "fill:email"]);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).toHaveBeenCalledTimes(1);
    // The fill-only record is forgotten and the tab asks for an account.
    expect(status()).toEqual([]);
    expect(fake.state.badges[1]?.text).toBe("1");
  });

  it("reports the continuation as not taken over when its record cannot be written", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const reports: LoginReport[] = [];
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service, { report: reports });
    const { set } = fake.browser.storage.local;
    // The record naming the continued revision cannot be stored.
    fake.browser.storage.local.set = async (values: Record<string, unknown>) => {
      const records = values["pateat.login-attempts.v3"] as { recipeRevision?: number }[];
      if (records?.some((record) => record.recipeRevision === 2)) throw new Error("quota");
      return set(values);
    };
    try {
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => reports.some((entry) => entry.type === "generation"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "recipe", baseRevision: 1, takenOver: false }),
      ]);
      expect(executed()).toEqual(allSteps.slice(0, 2));
    } finally {
      fake.browser.storage.local.set = set;
    }
  });

  it("waits a second after the password form shows before sending it", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(700);
    expect(service.generate).not.toHaveBeenCalled();
    await until(() => service.generate.mock.calls.length === 1, 2_000);
    await until(settled("authenticated"));
  });

  it("continues after a same-document URL change to another path", async () => {
    let h!: ReturnType<typeof harness>;
    inPlace(() => {
      // `history.pushState`: only the tab's committed URL shows the new path.
      fake.state.tabUrls[1] = "https://login.example/signin/password";
      fake.state.observedPath = "/signin/password";
      fake.state.unusable = new Set();
      fake.state.present = new Set(["password", "login"]);
      fake.state.extracted = { login: passwordPage("/signin/password") };
    });
    const service = generation(answering(() => h, continuedOn("/signin/password")));
    h = start(service);
    uris.mockClear();
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(service.generate.mock.calls[0]![0].observation.path).toBe("/signin/password");
    // The vault match for the request used the URL the page shows now.
    expect(uris.mock.calls.map(([, url]) => url)).toContain(
      "https://login.example/signin/password",
    );
  });

  it("continues in a new document on another path", async () => {
    let h!: ReturnType<typeof harness>;
    onClick(() => fake.state.gone.add("synthetic-document"));
    const service = generation(answering(() => h, continuedOn("/signin/password")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await until(() => status()?.[0]?.["state"] === "reconciling");
    expect(service.generate).not.toHaveBeenCalled();
    // The password page loads as a new document of the tab.
    fake.state.pageUrl = "https://login.example/signin/password";
    fake.state.observedPath = "/signin/password";
    fake.state.present = new Set(["password", "login"]);
    fake.state.signIn = true;
    fake.state.extracted = { login: passwordPage("/signin/password") };
    expect(await h.hello({ documentId: "password-document" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).toHaveBeenCalledTimes(1);
  });

  it("judges the email form shown again where it posted instead of continuing on it", async () => {
    // An unknown account: the email form shows again on another path, beside a recovery
    // email input that is not the recipe's.
    const again = describedPage("/signin/identifier", [
      { id: "c1", role: "text", target: target("email"), autocomplete: "username" },
      { id: "c2", role: "button", target: target("next"), label: "Next" },
    ]);
    onClick(() => {
      fake.state.observedPath = "/signin/identifier";
      fake.state.present = new Set(["email", "next"]);
      fake.state.signIn = { identifier: true };
      fake.state.extracted = { login: again, "signed-in": again };
    });
    const service = generation(undefined, async () => ({ verdict: "rejected" }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.judge.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).toHaveBeenCalledTimes(1);
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("judges a page whose only sign-in input is an email box once the recipe fills the username", async () => {
    // A page with an unrelated email input, such as a newsletter box, after the email form.
    const page = describedPage("/welcome", [
      { id: "c1", role: "text", target: target("newsletter"), autocomplete: "email" },
      { id: "c2", role: "button", target: target("subscribe"), label: "Subscribe" },
    ]);
    onClick(() => {
      fake.state.observedPath = "/welcome";
      fake.state.present = new Set(["newsletter", "subscribe"]);
      fake.state.signIn = { identifier: true };
      fake.state.extracted = { login: page, "signed-in": page };
    });
    const service = generation(undefined, async () => ({ verdict: "unclear" }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.judge.mock.calls.length === 1);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("continues on a password input revealed below the email field it filled", async () => {
    // A progressive form: Next keeps the email field writable and reveals the password
    // input below it on the same path.
    onClick(() => {
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = { password: true };
      fake.state.extracted = { login: passwordPage("/signin") };
    });
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.generate.mock.calls[0]![0].slots.map((slot) => slot.id)).toEqual(["password"]);
  });

  it("sends the page only once it has loaded and shows the password input", async () => {
    let h!: ReturnType<typeof harness>;
    // The email form goes; the password input shows, or the page finishes loading, later.
    onClick(() => {
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.extracted = { login: passwordPage("/signin") };
      setTimeout(() => (fake.state.signIn = true), 4_000);
    });
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => executed().length === 2);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(service.generate).not.toHaveBeenCalled();
    await until(settled("authenticated"));
    expect(service.generate).toHaveBeenCalledTimes(1);
  });

  it("never sends an incomplete description and never judges the page", async () => {
    inPlace(() => (fake.state.extracted = { login: passwordPage("/signin", false) }));
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]!["continuation"]).toBeUndefined();
    // Logged once for the document, and the skipped judge with why.
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      {
        type: "generation",
        tabId: 1,
        origin,
        outcome: "skipped",
        reason: "incomplete-observation",
        recipeId: emailFirst.id,
        baseRevision: 1,
      },
    ]);
    expect(reports.filter((entry) => entry.type === "judge")).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "continuation", recipeRevision: 1 }),
    ]);
  });

  it("logs the content script's own refusal of the continuation page", async () => {
    inPlace(() => (fake.state.extracted = { login: { ok: false, reason: "no-locator" } }));
    const service = generation();
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).not.toHaveBeenCalled();
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "skipped", reason: "no-locator", baseRevision: 1 }),
    ]);
  });

  it.each([
    ["an abstention", { outcome: "abstained", reason: "ambiguous" }],
    ["a page sent within the retry window", { outcome: "skipped", reason: "sent" }],
    ["a revoked recipe", { outcome: "unavailable", reason: "recipe-revoked" }],
    [
      "refused model output",
      { outcome: "failed", reason: "invalid-output", check: "plan", detail: "incompatible-role" },
    ],
  ] as const)("settles as unknown after %s, with no judge call", async (_label, answer) => {
    inPlace();
    const service = generation(async () => answer);
    const reports: LoginReport[] = [];
    const h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(status()![0]).toMatchObject({ continuation: { operationId: expect.any(String) } });
    // The refused output's check and code are logged with the continuation too.
    const { outcome: answered, ...fields } = answer;
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: answered, ...fields, baseRevision: 1 }),
    ]);
    expect(reports.filter((entry) => entry.type === "judge")).toEqual([
      expect.objectContaining({ verdict: "not-sent", reason: "continuation" }),
    ]);
    // A later document of the same step sends nothing again.
    fake.state.extracted = { login: passwordPage("/signin") };
    expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
  });

  it("gives back a request refused before any model call, for a later document", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(async () => ({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    }));
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    // This document does not send it again; nothing is judged.
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]!["continuation"]).toBeUndefined();
    service.generate.mockImplementation(answering(() => h, continuedOn("/signin")));
    expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(service.generate).toHaveBeenCalledTimes(2);
    expect(executed()).toEqual(allSteps);
  });

  it("never sends a given-back request again from the same document after a path change", async () => {
    inPlace();
    const service = generation(async () => ({
      outcome: "unavailable",
      reason: "busy",
      retry: true,
    }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status()![0]!["continuation"]).toBeUndefined();
    // `history.pushState` to another path: the page still shows the password form.
    fake.state.tabUrls[1] = "https://login.example/signin/password";
    fake.state.observedPath = "/signin/password";
    fake.state.extracted = { login: passwordPage("/signin/password") };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(service.judge).not.toHaveBeenCalled();
    expect(executed()).toEqual(allSteps.slice(0, 2));
  });

  it("offers no custom field that the recipe's generated slot map already names", async () => {
    inPlace();
    const service = generation();
    service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Branch" } }]);
    const h = start(service, {
      custom: [
        { name: "Branch", kind: "text" },
        { name: "PIN", kind: "hidden" },
      ],
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    expect(service.slotFields).toHaveBeenCalledWith(emailFirst.id);
    expect(
      service.generate.mock.calls[0]![0].slots.map((slot) => [slot.id, slot.fieldName]),
    ).toEqual([
      ["password", undefined],
      ["custom-2", "PIN"],
    ]);
  });

  it("never sends the page again after a worker restart during the request", async () => {
    inPlace();
    const lost = generation(() => new Promise(() => undefined));
    const h = start(lost);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => lost.generate.mock.calls.length === 1);
    expect(status()![0]).toMatchObject({ continuation: { operationId: expect.any(String) } });
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    try {
      const service = generation();
      const restarted = start(service);
      expect(await restarted.hello({}, false)).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      // With the continued revision in the cache, the record no longer matches it.
      const later = start(generation());
      later.recipes.recipe.mockResolvedValue(continuedOn("/signin"));
      expect(await later.hello({ documentId: "later" }, false)).toMatchObject({
        ok: false,
        reason: "recipe-not-found",
      });
    } finally {
      fake.browser.tabs.query = query;
    }
  });

  it("takes over a revision that reached the cache while a new document resumed", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    let answer!: () => void;
    const reports: LoginReport[] = [];
    const service = generation(async () => {
      h.recipes.recipe.mockResolvedValue(next);
      await new Promise<void>((resolve) => (answer = resolve));
      return { outcome: "recipe", recipe: next };
    });
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    // The form posts back to its path before the answer; the cache already holds it.
    fake.state.gone.add("synthetic-document");
    expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ recipeRevision: 2, document: { documentId: "again" } });
    answer();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    // The answer reached the document that asked after it was left.
    const generated = reports.filter((entry) => entry.type === "generation");
    expect(generated).toEqual([expect.objectContaining({ outcome: "recipe" })]);
    expect(generated[0]).not.toHaveProperty("takenOver");
  });

  it("takes over an answer that arrives after the new document's ten seconds", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const next = continuedOn("/signin");
    let answer!: () => void;
    const service = generation(async () => {
      await new Promise<void>((resolve) => (answer = resolve));
      return { outcome: "recipe", recipe: next };
    });
    h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(() => service.generate.mock.calls.length === 1);
    // The form posts back to its path; the answer, not yet cached, comes much later.
    fake.state.gone.add("synthetic-document");
    expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    answer();
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(status()![0]).toMatchObject({ recipeRevision: 2, document: { documentId: "again" } });
    expect(service.generate).toHaveBeenCalledTimes(1);
  });

  it("asks for the vault match again after a transient failure", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    h = start(service);
    const get = fake.browser.tabs.get;
    let failures = 0;
    fake.browser.tabs.get = (async (id: number) => {
      // The tab cannot be read for a moment once the password form shows.
      if (fake.state.present?.has("password") && failures < 3) {
        failures += 1;
        throw new Error("tab busy");
      }
      return get(id);
    }) as typeof get;
    try {
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(failures).toBe(3);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual(allSteps);
    } finally {
      fake.browser.tabs.get = get;
    }
  });

  it("asks again while the vault match could not evaluate the login's own item", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    const reports: LoginReport[] = [];
    h = start(service, { report: reports });
    let incomplete = 0;
    uris.mockImplementation(async () => {
      // Once the password form shows, the item's URIs cannot be evaluated for a moment.
      if (!fake.state.present?.has("password") || incomplete >= 3)
        return { ok: true as const, data: uriMatch() };
      incomplete += 1;
      return {
        ok: true as const,
        data: uriMatch({
          candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
          unavailableItemIds: [itemId],
        }),
      };
    });
    try {
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(incomplete).toBe(3);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(executed()).toEqual(allSteps);
      // Each round logs nothing new while the reason stays the same.
      expect(
        reports
          .filter((entry) => entry.type === "generation")
          .map((entry) => [entry.outcome, "reason" in entry ? entry.reason : undefined]),
      ).toEqual([
        ["skipped", "scope-incomplete"],
        ["recipe", undefined],
      ]);
    } finally {
      uris.mockImplementation(async () => ({ ok: true as const, data: uriMatch() }));
    }
  });

  it.each<[string, LoginRecipe]>([
    [
      "changes a step the login ran",
      parseLoginRecipe({
        ...continuedOn("/signin"),
        steps: [
          { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("user") }] },
          ...continuedOn("/signin").steps.slice(1),
        ],
      }),
    ],
    ["is another recipe", parseLoginRecipe({ ...continuedOn("/signin"), id: "gen-other" })],
    ["is not newer", parseLoginRecipe({ ...continuedOn("/signin"), revision: 1 })],
  ])("never takes over a revision that %s", async (_label, next) => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const reports: LoginReport[] = [];
    const service = generation(answering(() => h, next));
    h = start(service, { report: reports });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(service.judge).not.toHaveBeenCalled();
    expect(status()![0]).toMatchObject({ recipeRevision: 1 });
    expect(reports.filter((entry) => entry.type === "generation")).toEqual([
      expect.objectContaining({ outcome: "recipe", takenOver: false }),
    ]);
  });

  it("never takes over a revision the saved binding cannot fill", async () => {
    inPlace();
    let h!: ReturnType<typeof harness>;
    const service = generation(answering(() => h, continuedOn("/signin")));
    // A binding saved for the recipe holds the username slot only.
    h = start(service, {
      settings: {
        bindings: [
          {
            ...savedBinding,
            recipeId: emailFirst.id,
            slots: [{ slot: "username", field: "username" }],
          },
        ],
      },
    });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain("login.password");
  });

  it("judges a code page instead of continuing on it", async () => {
    // A one-time-code input alone is not a sign-in input to continue on.
    const codePage = describedPage("/signin/verify", [
      {
        id: "c1",
        role: "text",
        target: target("code"),
        autocomplete: "one-time-code",
        label: "Code",
      },
      { id: "c2", role: "button", target: target("verify"), label: "Verify" },
    ]);
    onClick(() => {
      fake.state.observedPath = "/signin/verify";
      fake.state.present = new Set(["code", "verify"]);
      fake.state.signIn = false;
      fake.state.extracted = { "signed-in": codePage };
    });
    const service = generation(undefined, async () => ({ verdict: "challenge" }));
    const h = start(service);
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("blocked", "challenge"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).toHaveBeenCalledWith(emailFirst.id, 1, "password", codePage.observation);
  });

  it("judges the page instead when the recipe already has a completion", async () => {
    onClick(() => {
      fake.state.observedPath = "/signin/password";
      fake.state.present = new Set(["password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { "signed-in": passwordPage("/signin/password") };
    });
    const learned = parseLoginRecipe({
      ...emailFirst,
      completion: { path: "/home", target: target("logout") },
    });
    const service = generation(undefined, async () => ({ verdict: "unclear" }));
    const h = start(service, { recipe: learned });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(service.generate).not.toHaveBeenCalled();
    expect(service.judge).toHaveBeenCalledTimes(1);
  });

  it("runs every step of a continued same-path recipe later, with no request", async () => {
    // The swap shows the password form only after Next; the email form hides.
    inPlace();
    const service = generation();
    const h = start(service, { recipe: continuedOn("/signin") });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    // Next is now an advance with a next step on its path, measured with its click.
    expect(measured()).toEqual(["click:next"]);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("runs a continued progressive form later while its password input was hidden before Next", async () => {
    // The password input exists but is hidden until Next; the email field stays writable.
    fake.state.present = new Set(["email", "next", "password"]);
    fake.state.unusable = new Set(["password"]);
    onClick(() => {
      fake.state.unusable = new Set();
      fake.state.present = new Set(["email", "next", "password", "login"]);
    });
    const service = generation();
    const h = start(service, { recipe: continuedOn("/signin") });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("authenticated"));
    expect(executed()).toEqual(allSteps);
    expect(measured()).toEqual(["click:next"]);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("never continues a later run whose password input was writable before Next", async () => {
    // A limitation of the same-path rule (ADR 0013): a password input that was already
    // usable before Next cannot tell that Next worked.
    fake.state.present = new Set(["email", "next", "password"]);
    onClick(() => {
      fake.state.present = new Set(["email", "next", "password", "login"]);
    });
    const service = generation();
    const h = start(service, { recipe: continuedOn("/signin") });
    expect(await h.hello()).toEqual({ ok: true });
    await until(settled("reconciling", "unknown-submit"));
    expect(executed()).toEqual(allSteps.slice(0, 2));
    expect(service.generate).not.toHaveBeenCalled();
  });

  describe("probed independently", () => {
    /** A worker restart: a new runtime over the same storage finds tab 1 open. */
    async function restarted<T>(run: () => Promise<T>): Promise<T> {
      const query = fake.browser.tabs.query;
      fake.browser.tabs.query = async () => [{ id: 1 }] as never;
      try {
        return await run();
      } finally {
        fake.browser.tabs.query = query;
      }
    }
    const fieldReads = (h: ReturnType<typeof harness>) =>
      h.fields.mock.calls.map(([request]) => request.fieldId);
    /** The page signs of ADR 0029 with none shown. */
    const noSigns = { password: false, code: false, captcha: false, invalid: false, alert: false };
    afterEach(() => {
      uris.mockReset();
      uris.mockImplementation(async () => ({ ok: true as const, data: uriMatch() }));
      fake.state.signs = undefined;
      fake.state.loaded = true;
    });

    it("restarts the stable second when the page moves to another path within it", async () => {
      let h!: ReturnType<typeof harness>;
      inPlace();
      const service = generation(answering(() => h, continuedOn("/signin/password")));
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // Shown on /signin first; 600 ms later a same-document URL change moves it.
      await vi.advanceTimersByTimeAsync(600);
      expect(service.generate).not.toHaveBeenCalled();
      fake.state.tabUrls[1] = "https://login.example/signin/password";
      fake.state.observedPath = "/signin/password";
      fake.state.unusable = new Set();
      fake.state.present = new Set(["password", "login"]);
      fake.state.extracted = { login: passwordPage("/signin/password") };
      const moved = Date.now();
      await until(() => service.generate.mock.calls.length === 1, 5_000);
      // Never sent before a full second on the new path.
      expect(Date.now() - moved).toBeGreaterThanOrEqual(1_000);
      expect(service.generate.mock.calls[0]![0].observation.path).toBe("/signin/password");
      // The email field the recipe filled on /signin is not known on this path.
      const extracts = fake.state.messages.filter((entry) => entry.type === "login.extract");
      expect(extracts.every((entry) => !("known" in entry))).toBe(true);
      await until(settled("authenticated"));
      expect(executed()).toEqual(allSteps);
    });

    it("waits a full second again when the sign-in input goes away and comes back", async () => {
      let h!: ReturnType<typeof harness>;
      inPlace();
      const service = generation(answering(() => h, continuedOn("/signin")));
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(500);
      // The password input flickers away for a moment.
      fake.state.signIn = false;
      await vi.advanceTimersByTimeAsync(600);
      expect(service.generate).not.toHaveBeenCalled();
      fake.state.signIn = true;
      const back = Date.now();
      await until(() => service.generate.mock.calls.length === 1, 5_000);
      expect(Date.now() - back).toBeGreaterThanOrEqual(1_000);
      await until(settled("authenticated"));
    });

    it.each([
      [
        "a check-your-email page",
        describedPage("/signin/check-email", [
          { id: "c1", role: "button", target: target("resend"), label: "Resend email" },
        ]),
        ["resend"],
      ],
      [
        "a passkey prompt",
        describedPage("/signin/passkey", [
          { id: "c1", role: "button", target: target("use-passkey"), label: "Use your passkey" },
        ]),
        ["use-passkey"],
      ],
    ] as const)("judges %s instead of continuing on it", async (_label, page, present) => {
      onClick(() => {
        fake.state.observedPath = page.observation.path;
        fake.state.present = new Set(present);
        fake.state.signIn = false;
        fake.state.extracted = { "signed-in": page };
      });
      const service = generation(undefined, async () => ({ verdict: "challenge" }));
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "challenge"));
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).toHaveBeenCalledWith(emailFirst.id, 1, "password", page.observation);
      expect(status()![0]!["continuation"]).toBeUndefined();
    });

    it("sends the page once a later round describes it completely", async () => {
      let h!: ReturnType<typeof harness>;
      inPlace(() => {
        fake.state.extracted = { login: passwordPage("/signin", false) };
        // A widget that finishes rendering a few seconds later.
        setTimeout(() => (fake.state.extracted = { login: passwordPage("/signin") }), 3_000);
      });
      const service = generation(answering(() => h, continuedOn("/signin")));
      const reports: LoginReport[] = [];
      h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      await vi.advanceTimersByTimeAsync(2_500);
      // Incomplete descriptions were read, none sent, and nothing recorded for them.
      expect(
        fake.state.messages.filter((entry) => entry.type === "login.extract").length,
      ).toBeGreaterThan(1);
      expect(service.generate).not.toHaveBeenCalled();
      expect(status()![0]!["continuation"]).toBeUndefined();
      await until(settled("authenticated"));
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0].observation.complete).toBe(true);
      expect(executed()).toEqual(allSteps);
      // The skipped rounds are logged once for the document, and no judge was skipped.
      expect(
        reports
          .filter((entry) => entry.type === "generation")
          .map((entry) => [entry.outcome, "reason" in entry ? entry.reason : undefined]),
      ).toEqual([
        ["skipped", "incomplete-observation"],
        ["recipe", undefined],
      ]);
      const judged = reports.filter((entry) => entry.type === "judge");
      expect(judged.map((entry) => [entry.verdict, entry.recipeRevision])).toEqual([
        ["sent", 2],
        ["signed-in", 2],
      ]);
    });

    it("may send the page again after a restart before the request was recorded", async () => {
      inPlace();
      const first = generation();
      const h = start(first);
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // The worker stops while it matches the vault item for the described page's request.
      let matching = 0;
      uris.mockImplementation(async () => {
        if (!fake.state.messages.some((entry) => entry.type === "login.extract"))
          return { ok: true as const, data: uriMatch() };
        matching += 1;
        return new Promise(() => undefined);
      });
      await until(() => matching > 0, 5_000);
      expect(first.generate).not.toHaveBeenCalled();
      expect(status()![0]!["continuation"]).toBeUndefined();
      uris.mockImplementation(async () => ({ ok: true as const, data: uriMatch() }));
      await restarted(async () => {
        let again!: ReturnType<typeof harness>;
        const service = generation(answering(() => again, continuedOn("/signin")));
        again = start(service);
        expect(await again.hello({}, false)).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(service.generate).toHaveBeenCalledTimes(1);
        expect(service.generate.mock.calls[0]![0]).toMatchObject({
          base: { recipeId: emailFirst.id, revision: 1 },
        });
      });
      expect(first.generate).not.toHaveBeenCalled();
      // Next ran once, before the restart.
      expect(executed().filter((step) => step === "click:next")).toHaveLength(1);
    });

    it("resumes at the continued page's first step after a restart, never clicking Next again", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(answering(() => h, next));
      h = start(service);
      // The worker stops right after it recorded the takeover, before the next step.
      const settingsOf = h.store.handle.getMockImplementation()!;
      let stopped = 0;
      h.store.handle.mockImplementation(async () => {
        const record = status()?.[0];
        if (record?.["recipeRevision"] === 2 && record["state"] === "ready") {
          stopped += 1;
          return new Promise<never>(() => undefined);
        }
        return settingsOf();
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => stopped > 0);
      expect(status()![0]).toMatchObject({ state: "ready", recipeRevision: 2, stepIndex: 2 });
      expect(executed()).toEqual(allSteps.slice(0, 2));
      await restarted(async () => {
        const quiet = generation();
        const again = start(quiet);
        again.recipes.recipe.mockResolvedValue(next);
        expect(await again.hello({}, false)).toEqual({ ok: true });
        await until(settled("authenticated"));
        expect(quiet.generate).not.toHaveBeenCalled();
        expect(fieldReads(again)).toContain("login.password");
      });
      expect(executed()).toEqual(allSteps);
      expect(service.generate).toHaveBeenCalledTimes(1);
    });

    it("takes over another device's continuation found in the cache by a later document", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      // This device's answer could not be used (the model's output was invalid, so the
      // request is spent); another device's continuation synced meanwhile.
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "failed", reason: "invalid-output" };
      });
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(service.judge).not.toHaveBeenCalled();
      // The form posts back to its path: the new document takes the cached revision over.
      fake.state.gone.add("synthetic-document");
      expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual(allSteps);
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(status()![0]).toMatchObject({ recipeRevision: 2, document: { documentId: "again" } });
    });

    it("refuses a cached takeover the saved binding cannot fill: no fill, unknown", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "failed", reason: "invalid-output" };
      });
      h = start(service, {
        settings: {
          bindings: [
            {
              ...savedBinding,
              recipeId: emailFirst.id,
              slots: [{ slot: "username", field: "username" }],
            },
          ],
        },
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      fake.state.gone.add("synthetic-document");
      expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(status()![0]).toMatchObject({
        state: "reconciling",
        outcome: "unknown-submit",
        recipeRevision: 1,
      });
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(fieldReads(h)).not.toContain("login.password");
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.judge).not.toHaveBeenCalled();
    });

    it("stops at a settings sync during the request and never fills the continued page", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        h.login.settingsChanged("synced");
        return { outcome: "recipe", recipe: next };
      });
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "policy-changed"));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(status()![0]).toMatchObject({ state: "blocked", recipeRevision: 1 });
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(fieldReads(h)).not.toContain("login.password");
    });

    it("sends nothing once the login's item no longer matches the page", async () => {
      inPlace();
      const service = generation();
      const reports: LoginReport[] = [];
      const h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(() => executed().length === 2);
      // The item's URI no longer matches: another item is the page's only candidate.
      uris.mockImplementation(async () => ({
        ok: true as const,
        data: uriMatch({
          candidates: [{ itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] }],
        }),
      }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]!["continuation"]).toBeUndefined();
      // The page qualified and was described, so it is not judged either: it settles unknown.
      expect(status()![0]).toMatchObject({ state: "reconciling", outcome: "unknown-submit" });
      expect(fieldReads(h)).not.toContain("login.password");
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "skipped", reason: "no-vault-match", baseRevision: 1 }),
      ]);
      expect(reports.filter((entry) => entry.type === "judge")).toEqual([
        expect.objectContaining({ verdict: "not-sent", reason: "continuation" }),
      ]);
    });

    /** A member ID page: a custom field and Next, no built-in sign-in input. */
    const memberPage = describedPage("/signin", [
      { id: "c1", role: "text", target: target("member"), label: "Member ID" },
      { id: "c2", role: "button", target: target("next-member"), label: "Next" },
    ]);
    /** The first page of a recipe that asks for the member ID before the email address. */
    const memberFirst = parseLoginRecipe({
      ...emailFirst,
      slots: ["branch"],
      steps: [
        { kind: "fill", path: "/signin", fields: [{ slot: "branch", target: target("member") }] },
        { kind: "click", path: "/signin", target: target("next-member"), purpose: "advance" },
      ],
    });

    it("judges a page that asks only for a custom field instead of continuing on it", async () => {
      // Next leads to a member ID page: no password, username or email input to continue on
      // (the fixed rule: only a built-in slot the recipe does not fill yet qualifies).
      onClick(() => {
        // The email form is gone; a page still showing it is never judged.
        fake.state.present = new Set(["member", "next-member"]);
        fake.state.signIn = { password: false, identifier: false };
        fake.state.extracted = { "signed-in": memberPage, login: memberPage };
      });
      const service = generation(undefined, async () => ({ verdict: "unclear" }));
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).toHaveBeenCalledTimes(1);
      expect(status()![0]!["continuation"]).toBeUndefined();
    });

    it("continues twice: member ID, Next, email, Next, password, Log in", async () => {
      const withEmail = parseLoginRecipe({
        ...memberFirst,
        revision: 2,
        slots: ["branch", "username"],
        steps: [
          ...memberFirst.steps,
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "username", target: target("email") }],
          },
          { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
        ],
        maxSubmissions: 2,
      });
      const withPassword = parseLoginRecipe({
        ...withEmail,
        revision: 3,
        slots: ["branch", "username", "password"],
        steps: [
          ...withEmail.steps,
          {
            kind: "fill",
            path: "/signin",
            fields: [{ slot: "password", target: target("password") }],
          },
          { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
        ],
        maxSubmissions: 3,
      });
      const emailPage = describedPage("/signin", [
        { id: "c1", role: "email", target: target("email"), label: "Email" },
        { id: "c2", role: "button", target: target("next"), label: "Next" },
      ]);
      // The member ID form shows first; each Next swaps in the next form on the same path.
      fake.state.present = new Set(["member", "next-member"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click") return;
        if (step.target?.value === "next-member") {
          fake.state.unusable = new Set(["member", "next-member"]);
          fake.state.present = new Set(["member", "next-member", "email", "next"]);
          fake.state.signIn = { identifier: true };
          fake.state.extracted = { login: emailPage };
        }
        if (step.target?.value === "next") {
          fake.state.unusable = new Set(["member", "next-member", "email", "next"]);
          fake.state.present = new Set([
            "member",
            "next-member",
            "email",
            "next",
            "password",
            "login",
          ]);
          fake.state.signIn = { password: true };
          fake.state.extracted = { login: passwordPage("/signin") };
        }
        if (step.target?.value === "login") {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
          fake.state.signIn = false;
          fake.state.extracted = { "signed-in": homePage };
        }
      };
      let h!: ReturnType<typeof harness>;
      const reports: LoginReport[] = [];
      const service = generation(async (request) => {
        const next = request.base?.revision === 1 ? withEmail : withPassword;
        h.recipes.recipe.mockResolvedValue(next);
        return { outcome: "recipe", recipe: next };
      });
      service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Member" } }]);
      h = start(service, {
        recipe: memberFirst,
        report: reports,
        custom: [{ name: "Member", kind: "text" }],
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated"));
      expect(executed()).toEqual([
        "fill:member",
        "click:next-member",
        "fill:email",
        "click:next",
        "fill:password",
        "click:login",
      ]);
      const requests = service.generate.mock.calls.map(([request]) => request);
      expect(requests.map((request) => request.base)).toEqual([
        { recipeId: memberFirst.id, revision: 1 },
        { recipeId: memberFirst.id, revision: 2 },
      ]);
      // Each request offers only the slots the recipe does not fill yet: never the member ID
      // field, which the recipe's generated slot map already names.
      expect(requests.map((request) => request.slots.map((slot) => slot.id))).toEqual([
        ["username", "password"],
        ["password"],
      ]);
      // The second request knows the member ID and email fields the recipe filled.
      const extracts = fake.state.messages.filter(
        (entry) => entry.type === "login.extract" && (entry as { page?: string }).page === "login",
      );
      expect(extracts.at(-1)).toMatchObject({ known: [target("member"), target("email")] });
      expect(status()![0]).toMatchObject({
        recipeRevision: 3,
        stepCount: 6,
        submissions: 3,
        maxSubmissions: 3,
      });
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: memberFirst.id,
          slots: [
            { slot: "branch", field: { custom: "Member" } },
            { slot: "username", field: "username" },
            { slot: "password", field: "password" },
          ],
        }),
      ]);
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "recipe", baseRevision: 1, takenOver: true }),
        expect.objectContaining({ outcome: "recipe", baseRevision: 2, takenOver: true }),
      ]);
      // No value reaches a request or the local log.
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(reports)).not.toContain("synthetic-secret");
    });

    it("proves the sign-in by the continued revision's completion, with no judge call", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const reports: LoginReport[] = [];
      const next = continuedOn("/signin", {
        completion: { path: "/home", target: target("logout") },
      });
      const service = generation(answering(() => h, next));
      h = start(service, { report: reports });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"));
      expect(executed()).toEqual(allSteps);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()![0]).toMatchObject({ recipeRevision: 2 });
      // Neither the request nor the local log carries a value.
      expect(JSON.stringify(service.generate.mock.calls)).not.toContain("synthetic-secret");
      expect(JSON.stringify(reports)).not.toContain("synthetic-secret");
    });

    it("completes on confirmed sign-in evidence once the continuation was not used (ADR 0029)", async () => {
      // The member ID's Next signs in: the page shows the username in its header beside a
      // newsletter email box. The recipe fills no username, so the box qualifies and the
      // page is sent first (an ADR 0018 limitation); the model finds no login form there.
      const home = describedPage("/home", [
        { id: "c1", role: "text", target: target("newsletter"), autocomplete: "email" },
        { id: "c2", role: "button", target: target("logout"), label: "Sign out" },
      ]);
      fake.state.present = new Set(["member", "next-member"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click" || step.target?.value !== "next-member") return;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["newsletter", "logout"]);
        fake.state.signIn = { identifier: true };
        fake.state.extracted = { login: home, "signed-in": home };
        fake.state.signs = { ...noSigns, username: true };
      };
      const reports: LoginReport[] = [];
      const service = generation(async () => ({ outcome: "abstained", reason: "no-login-form" }));
      service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Member" } }]);
      const h = start(service, {
        recipe: memberFirst,
        report: reports,
        custom: [{ name: "Member", kind: "text" }],
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"));
      expect(executed()).toEqual(["fill:member", "click:next-member"]);
      // The request went first, then the evidence completed the login without the judge.
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.generate.mock.calls[0]![0]).toMatchObject({
        base: { recipeId: memberFirst.id, revision: 1 },
        observation: home.observation,
      });
      expect(service.judge).not.toHaveBeenCalled();
      expect(reports.filter((entry) => entry.type === "generation")).toEqual([
        expect.objectContaining({ outcome: "abstained", reason: "no-login-form", baseRevision: 1 }),
      ]);
      expect(reports.filter((entry) => entry.type === "state")).toEqual([
        expect.objectContaining({ s1: false, e2: true, decision: "signed-in" }),
      ]);
      expect(reports.findIndex((entry) => entry.type === "generation")).toBeLessThan(
        reports.findIndex((entry) => entry.type === "state"),
      );
      // Completed, not settled unknown: no skipped judge is logged.
      expect(reports.filter((entry) => entry.type === "judge")).toEqual([]);
      expect(status()![0]).toMatchObject({ recipeRevision: 1, submissions: 1 });
      expect(h.settings.settings.bindings).toEqual([
        expect.objectContaining({
          recipeId: memberFirst.id,
          slots: [{ slot: "branch", field: { custom: "Member" } }],
        }),
      ]);
    });

    it("leaves a qualifying page unknown when its sign-in evidence is never confirmed", async () => {
      // The same page in a document that never finishes loading: the evidence never counts.
      const home = describedPage("/home", [
        { id: "c1", role: "text", target: target("newsletter"), autocomplete: "email" },
        { id: "c2", role: "button", target: target("logout"), label: "Sign out" },
      ]);
      fake.state.present = new Set(["member", "next-member"]);
      fake.state.onExecute = async (message) => {
        const step = (
          message["operation"] as { step: { kind: string; target?: { value: string } } }
        ).step;
        if (step.kind !== "click" || step.target?.value !== "next-member") return;
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["newsletter", "logout"]);
        fake.state.signIn = { identifier: true };
        fake.state.extracted = { login: home, "signed-in": home };
        fake.state.signs = { ...noSigns, username: true };
        fake.state.loaded = false;
      };
      const reports: LoginReport[] = [];
      const service = generation(async () => ({ outcome: "abstained", reason: "no-login-form" }));
      service.slotFields.mockResolvedValue([{ slot: "branch", field: { custom: "Member" } }]);
      const h = start(service, {
        recipe: memberFirst,
        report: reports,
        custom: [{ name: "Member", kind: "text" }],
      });
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("reconciling", "unknown-submit"));
      expect(service.generate).toHaveBeenCalledTimes(1);
      // A qualifying page is still never judged.
      expect(service.judge).not.toHaveBeenCalled();
      expect(reports.filter((entry) => entry.type === "judge")).toEqual([
        expect.objectContaining({ verdict: "not-sent", reason: "continuation" }),
      ]);
      expect(h.settings.settings.bindings).toEqual([]);
    });

    it("after a logout, a fill-only login is never continued, even once Next is pressed", async () => {
      // Next signs in at once on this site: the username shows in the page header.
      onClick(() => {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.signIn = false;
        fake.state.extracted = { "signed-in": homePage };
        fake.state.signs = { ...noSigns, username: true };
      });
      const service = generation();
      const h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("authenticated", "authenticated"));
      expect(executed()).toEqual(allSteps.slice(0, 2));
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      // The site signs out and shows the email page again: the login only fills it (ADR 0021 D).
      fake.state.signs = undefined;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set(["email", "next"]);
      fake.state.unusable = new Set();
      fake.state.extracted = {};
      inPlace();
      expect(await h.hello({ documentId: "signed-out" })).toEqual({ ok: true });
      await until(() => executed().length === 3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(executed()).toEqual([...allSteps.slice(0, 2), "fill:email"]);
      expect(status()).toEqual([]);
      // The person presses Next: the password form shows in the same document, which
      // announces itself again. Nothing continues the recipe there.
      fake.state.unusable = new Set(["email", "next"]);
      fake.state.present = new Set(["email", "next", "password", "login"]);
      fake.state.signIn = true;
      fake.state.extracted = { login: passwordPage("/signin") };
      expect(await h.hello({ documentId: "signed-out" }, false)).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual([...allSteps.slice(0, 2), "fill:email"]);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      expect(fake.state.messages.some((entry) => entry.type === "login.extract")).toBe(false);
      expect(status()).toEqual([]);
      expect(fake.state.badges[1]?.text).toBe("1");
    });

    it("never presses Next again after a policy change stopped the request, and only fills", async () => {
      inPlace();
      let h!: ReturnType<typeof harness>;
      const next = continuedOn("/signin");
      const service = generation(async () => {
        h.recipes.recipe.mockResolvedValue(next);
        // A settings save lands while the model answers.
        await h.store.update(undefined, (snapshot) => snapshot);
        return { outcome: "recipe", recipe: next };
      });
      h = start(service);
      expect(await h.hello()).toEqual({ ok: true });
      await until(settled("blocked", "policy-changed"));
      expect(status()![0]).toMatchObject({ recipeRevision: 1, submissions: 1 });
      // Next submitted, so the form shown again in a new document never starts a login that
      // presses it again (#292 releases only a login that submitted nothing): the tab asks
      // and the form is only filled, with no Next and no request (ADR 0021 D).
      fake.state.gone.add("synthetic-document");
      onClick(() => undefined);
      fake.state.present = new Set(["email", "next"]);
      fake.state.unusable = new Set();
      fake.state.signIn = false;
      fake.state.extracted = {};
      expect(await h.hello({ documentId: "again" })).toEqual({ ok: true });
      await until(() => executed().length === 3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(executed()).toEqual([...allSteps.slice(0, 2), "fill:email"]);
      expect(fieldReads(h)).not.toContain("login.password");
      expect(service.generate).toHaveBeenCalledTimes(1);
      expect(service.judge).not.toHaveBeenCalled();
      expect(status()).toEqual([]);
      expect(fake.state.badges[1]?.text).toBe("1");
    });
  });
});
