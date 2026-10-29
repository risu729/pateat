import { afterEach, beforeEach, vi } from "vitest";
import {
  parseLoginRecipe,
  type ExcludedField,
  type LocalSettings,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../crypto/wire";
import type { LiveUriMatcher } from "../../vault/site-candidates";
import { type RecipeRepairs } from "../repair";
import type { LoginPauses } from "../pause";
import { createLoginBadge, memoryBadgeStorage, setActionBadge, type LoginBadge } from "../badge";
import type { LoginGeneration, LoginRecipeStart, LoginReport } from "../runtime";
import type { LoginFieldSource } from "../vault";
import { type LogoutService } from "../switch";
import type { PasskeyItem } from "../../passkeys/runtime";
import type { createBrowserFake } from "./browser-fake";
const { createLoginRuntime } = await import("../runtime");
const { createLoginSites } = await import("../sites");
const { observedPath } = await import("../../observation/path");
export { createLoginRuntime, createLoginSites, observedPath };
export type CustomField = {
  name: string | null;
  kind: "text" | "hidden" | "linked";
  linkedFieldId?: string;
  /** The catalog's flag for a field shaped like a TOTP key (ADR 0027, owner 2026-10-23). */
  totpSeed?: true;
};
export function createRuntimeTestHarness(fake: ReturnType<typeof createBrowserFake>) {
  const reportedPath = (url: string) => observedPath(new URL(url).pathname);
  const origin = "https://login.example";
  const connectionId = "50000000-0000-4000-8000-000000000001";
  const itemId = "80000000-0000-4000-8000-000000000001";
  const snapshotId = "60000000-0000-4000-8000-000000000001";
  const trusted = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/options.html",
  } as never;
  const sender = (overrides: Record<string, unknown> = {}) => {
    const { url = fake.state.pageUrl } = overrides;
    const parsed = typeof url === "string" ? URL.parse(url) : null;
    return {
      id: "synthetic-extension",
      // Chrome always says whether the tab is in an incognito window.
      tab: { id: 1, incognito: false },
      frameId: 0,
      documentId: "synthetic-document",
      ...(parsed ? { origin: parsed.origin } : {}),
      url,
      ...overrides,
    } as never;
  };
  const target = (value: string) => ({ by: "id" as const, value });
  const startsOf = (steps: LoginStep[]): LoginRecipeStart[] =>
    steps.map((step) => ({ path: step.path, steps: [step] }));
  const recipe = parseLoginRecipe({
    version: 1,
    id: "synthetic-signin",
    revision: 1,
    origin,
    pageKind: "sign-in",
    slots: ["password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("password") }] },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
    completion: [{ target: target("authenticated") }],
    maxSubmissions: 1,
  });
  const userId = "70000000-0000-4000-8000-000000000001";
  const savedBinding: SavedLoginBinding = {
    recipeId: recipe.id,
    origin,
    provider: "bitwarden",
    server: "cloud-us",
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
  const liveAccountPolicy = (
    overrides: Partial<LocalSettings["accountPolicies"][number]> = {},
  ): LocalSettings["accountPolicies"][number] => ({
    provider: "bitwarden",
    server: "cloud-us",
    userId,
    accountName: "Synthetic live vault",
    enabled: true,
    selection: { mode: "all" },
    ...overrides,
  });
  const liveItemPolicy = (
    id: string,
    overrides: Partial<LocalSettings["itemPolicies"][number]> = {},
  ): LocalSettings["itemPolicies"][number] => ({
    provider: "bitwarden",
    server: "cloud-us",
    userId,
    itemId: id,
    itemName: id,
    selected: false,
    excluded: false,
    excludedFields: [],
    ...overrides,
  });
  const liveEvidence = `bitwarden-v1:sha256:${"a".repeat(64)}`;
  const liveRevisionDate = "2026-10-11T07:10:03.1234567Z";
  const liveReview = (id = itemId): LocalSettings["customFieldReviews"][number] => ({
    provider: "bitwarden",
    server: "cloud-us",
    userId,
    itemId: id,
    evidence: liveEvidence,
    revisionDate: liveRevisionDate,
  });
  const excludingLive = (
    excludedFields: ExcludedField[],
    id = itemId,
  ): Pick<LocalSettings, "itemPolicies" | "customFieldReviews"> => ({
    itemPolicies: [liveItemPolicy(id, { excludedFields })],
    customFieldReviews: excludedFields.some((field) => typeof field !== "string")
      ? [liveReview(id)]
      : [],
  });
  const liveDefault = (overrides: Partial<LocalSettings["siteDefaults"][number]> = {}) => ({
    origin,
    provider: "bitwarden",
    server: "cloud-us",
    userId,
    itemId,
    ...overrides,
  });
  function harness(
    overrides: Partial<LocalSettings> = {},
    live: {
      allowedOrigins?: string[];
      uris?: LiveUriMatcher;
      quarantined?: boolean;
      /** Adds a second connection of the same provider account, which shares its policy. */
      duplicateAccount?: boolean;
      /** The device is paired and waits for its first settings sync (ADR 0023). */
      settingsSyncPending?: boolean;
      /** Adds a login username field to the item. */
      username?: boolean;
      /**
       * Adds a login username field to the other item; `empty` when the item holds no value
       * for it, as the catalog flags it.
       */
      otherUsername?: boolean | "empty";
      /** Recipe generation for pages without a recipe. */
      generation?: LoginGeneration;
      /** The repairs of generated recipes' start pages (ADR 0041). */
      repairs?: RecipeRepairs;
      /** The item's passkey facts, read when a login starts (ADR 0027). */
      passkeys?: (account: unknown) => Promise<{ passkey: boolean; discoverable: boolean }>;
      /** The items holding a discoverable passkey for an origin (ADR 0034). */
      passkeyItems?: (origin: string) => Promise<readonly PasskeyItem[]>;
      /** A hostname chosen "Always for this site" whose write still waits (ADR 0007). */
      pendingBrowserSite?: (origin: string) => boolean;
      /** Automatic vault sync (ADR 0025). */
      vault?: Parameters<typeof createLoginRuntime>[1]["vault"];
      /** Receives the runtime's reports for the local log, without page URLs unless `urls`. */
      report?: (report: LoginReport) => void;
      urls?: boolean;
      /** Replaces the item's custom fields. */
      custom?: CustomField[];
      /** Custom fields of the other item, which has none otherwise. */
      otherCustom?: CustomField[];
      /**
       * Further items of the connection, each with a password, these built-in fields, as an
       * identity's or a card's, and these custom fields.
       */
      extraItems?: {
        id: string;
        custom: CustomField[];
        builtin?: { id: string; label: string; kind: "text" | "hidden" }[];
      }[];
      /** Cached sign-in entry recipes (ADR 0031). */
      entries?: LoginEntryRecipe[];
      /** Told of each origin a login signed in (ADR 0007). */
      signedIn?: (tabId: number, origin: string) => void;
      /** Spins a tab's toolbar badge while a model request is in flight. */
      spin?: (tabId: number) => () => void;
      /** The toolbar badge, which keeps the tab's page status for the popup (ADR 0038). */
      badge?: LoginBadge;
      /** An account switch's logout recipes and role (ADR 0063). */
      logout?: LogoutService | undefined;
      /** The paused sites (ADR 0062), instead of the ones in `storage.session`. */
      pauses?: LoginPauses;
      /** The item has Bitwarden's master password re-prompt. */
      reprompt?: boolean;
      /** The other item has it too, as an identity or a card linked to the login may. */
      otherReprompt?: boolean;
      /** Asks for the master password of a re-prompt item. */
      askMasterPassword?: Parameters<typeof createLoginRuntime>[1]["askMasterPassword"];
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
      connections: [],
      accountPolicies: [liveAccountPolicy()],
      itemPolicies: [],
      customFieldReviews: [],
      excludedSites: [],
      passkeyBrowserSites: [],
      repromptSites: [],
      siteDefaults: [liveDefault()],
      // Automatic login runs in private windows too, so the tests of incognito tabs see a
      // login; `privateOff` turns it off, the default (ADR 0062).
      loginInPrivateWindows: true,
      bindings: [savedBinding],
      ...overrides,
    };
    const snapshot: SettingsSnapshot = { version: 1, revision: 1, settings };
    const store = {
      read: vi.fn(async () => structuredClone(snapshot)),
      update: vi.fn(
        async (
          expected: number | undefined,
          _cause: SettingsChangeCause,
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
          ...(live.settingsSyncPending ? { settingsSyncPending: true as const } : {}),
          connections: [
            {
              id: connectionId,
              label: "Synthetic live vault",
              provider: "bitwarden",
              server: "cloud-us",
              ...(current.userId ? { userId: current.userId } : {}),
              snapshotId: current.current,
              state: "ready",
              ...(live.quarantined ? { quarantinedItemIds: [itemId] } : {}),
              groups: [],
              items: [
                {
                  id: itemId,
                  label: "Synthetic item",
                  ...(live.reprompt ? { reprompt: true as const } : {}),
                  allowedOrigins: live.allowedOrigins ?? [origin],
                  groupIds: [],
                  evidence: liveEvidence,
                  revisionDate: liveRevisionDate,
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
                    {
                      id: "login.password",
                      label: "Password",
                      name: null,
                      kind: "hidden" as const,
                    },
                    ...customFields(live.custom ?? [{ name: "Branch", kind: "text" as const }]),
                  ],
                },
                {
                  id: otherItemId,
                  label: "Other synthetic item",
                  ...(live.otherReprompt ? { reprompt: true as const } : {}),
                  allowedOrigins: [],
                  groupIds: [],
                  evidence: liveEvidence,
                  revisionDate: liveRevisionDate,
                  fields: [
                    ...(live.otherUsername
                      ? [
                          {
                            id: "login.username",
                            label: "Username",
                            name: null,
                            kind: "text" as const,
                            ...(live.otherUsername === "empty" ? { empty: true as const } : {}),
                          },
                        ]
                      : []),
                    {
                      id: "login.password",
                      label: "Password",
                      name: null,
                      kind: "hidden" as const,
                    },
                    ...customFields(live.otherCustom ?? []),
                  ],
                },
                ...(live.extraItems ?? []).map((extra) => ({
                  id: extra.id,
                  label: "Extra synthetic item",
                  allowedOrigins: [],
                  groupIds: [],
                  evidence: liveEvidence,
                  revisionDate: liveRevisionDate,
                  fields: [
                    {
                      id: "login.password",
                      label: "Password",
                      name: null,
                      kind: "hidden" as const,
                    },
                    ...(extra.builtin ?? []).map((field) => ({ ...field, name: null })),
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
                    server: "cloud-us",
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
      // A recipe the lookup misses is one the cache could not read unless a test says.
      withdrawn: vi.fn(async (_at: string, _id: string, _layout?: string) => false),
      starts: vi.fn(async (at: string) => (at === origin ? startsOf([recipe.steps[0]!]) : [])),
      chooser: vi.fn(async (): Promise<LoginChooserRecipe | undefined> => undefined),
      entries: vi.fn(async (at: string): Promise<LoginEntryRecipe[]> =>
        (live.entries ?? []).filter((entry) => entry.origin === at),
      ),
      // Every route recipe of the origin whatever its kind (ADR 0035): none unless a test says.
      routes: vi.fn(async (_at: string): Promise<LoginRecipe[]> => []),
    };
    const login = createLoginRuntime(store, {
      fields,
      sites: createLoginSites(store),
      recipes,
      ...(live.uris ? { uris: live.uris } : {}),
      ...(live.generation ? { generation: live.generation } : {}),
      ...(live.repairs ? { repairs: live.repairs } : {}),
      ...(live.passkeys ? { passkeys: live.passkeys } : {}),
      ...(live.passkeyItems ? { passkeyItems: live.passkeyItems } : {}),
      ...(live.pendingBrowserSite ? { pendingBrowserSite: live.pendingBrowserSite } : {}),
      ...(live.vault ? { vault: live.vault } : {}),
      ...(live.signedIn ? { signedIn: live.signedIn } : {}),
      ...(live.logout ? { logout: live.logout } : {}),
      ...(live.pauses ? { pauses: live.pauses } : {}),
      ...(live.askMasterPassword ? { askMasterPassword: live.askMasterPassword } : {}),
      ...(live.badge
        ? { badge: live.badge }
        : live.spin
          ? {
              badge: {
                ...createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() }),
                spin: live.spin,
              },
            }
          : {}),
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
    const hello = (from: Record<string, unknown> = {}, start = true, switched = false) =>
      login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          ...(start
            ? { start: { path: reportedPath(String(from["url"] ?? fake.state.pageUrl)) } }
            : {}),
          ...(switched ? { switched: true } : {}),
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
          signIn: { path: reportedPath(fake.state.pageUrl) },
        },
        sender(),
      );
    return { login, store, fields, recipes, hello, signIn, snapshot: current, settings: snapshot };
  }
  const shownHello = (
    h: { login: { handle(message: unknown, sender: unknown): Promise<unknown> } },
    from: Record<string, unknown> = {},
    shown: Record<string, unknown> = {},
  ) =>
    h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        shown: { path: reportedPath(fake.state.pageUrl), ...shown },
      },
      sender(from),
    );
  const setPause = (
    h: { login: { handle(message: unknown, sender: unknown): Promise<unknown> } },
    paused: boolean,
    tabId = 1,
    length = "1h",
  ) =>
    h.login.handle(
      { version: 1, type: "login.pause.set", tabId, paused, ...(paused ? { length } : {}) },
      { id: "synthetic-extension", url: "chrome-extension://synthetic-extension/popup.html" },
    );
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    vi.setTimerTickMode("nextTimerAsync");
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const realTime = () => void vi.useRealTimers();
  return {
    reportedPath,
    origin,
    connectionId,
    itemId,
    snapshotId,
    trusted,
    sender,
    target,
    startsOf,
    recipe,
    userId,
    savedBinding,
    otherItemId,
    uriMatch,
    liveAccountPolicy,
    liveItemPolicy,
    liveEvidence,
    liveRevisionDate,
    liveReview,
    excludingLive,
    liveDefault,
    harness,
    shownHello,
    setPause,
    realTime,
  };
}
