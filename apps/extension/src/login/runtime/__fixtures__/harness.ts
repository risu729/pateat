import { vi } from "vitest";
import {
  parseLoginRecipe,
  type LocalSettings,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsSnapshot,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { UriCandidates } from "../../../crypto/wire";
import type { LiveUriMatcher } from "../../../vault/site-candidates";
import { createLoginBadge, memoryBadgeStorage, setActionBadge, type LoginBadge } from "../../badge";
import type { LoginGeneration, LoginRecipeStart } from "../recipes";
import type { LoginReport } from "../reports";
import type { LoginFieldSource } from "../../vault";
import type { PasskeyItem } from "../../../passkeys/runtime";
import { fake } from "./browser";

// The production runtime with synthetic settings, vault and recipes, and the values its
// tests share. The runtime loads only after the production mode is set.
vi.stubEnv("MODE", "production");
const { createLoginRuntime } = await import("../../runtime");
const { createLoginSites } = await import("../../sites");

export const origin = "https://login.example";
export const connectionId = "50000000-0000-4000-8000-000000000001";
export const itemId = "80000000-0000-4000-8000-000000000001";
export const snapshotId = "60000000-0000-4000-8000-000000000001";
export const trusted = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/options.html",
} as never;
export const sender = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "synthetic-extension",
    tab: { id: 1 },
    frameId: 0,
    documentId: "synthetic-document",
    url: fake.state.pageUrl,
    ...overrides,
  }) as never;
export const target = (value: string) => ({ by: "id" as const, value });
/** One recipe start per step, as the recipe cache lists single-variant recipes. */
export const startsOf = (steps: LoginStep[]): LoginRecipeStart[] =>
  steps.map((step) => ({ path: step.path, steps: [step] }));
export const recipe = parseLoginRecipe({
  version: 1,
  id: "synthetic-signin",
  revision: 1,
  origin,
  slots: ["password"],
  steps: [
    { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("password") }] },
    { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
  ],
  completion: [{ target: target("authenticated") }],
  maxSubmissions: 1,
});
export const userId = "70000000-0000-4000-8000-000000000001";
export const savedBinding: SavedLoginBinding = {
  recipeId: recipe.id,
  origin,
  provider: "bitwarden",
  userId,
  itemId,
  itemName: "Synthetic item",
  slots: [{ slot: "password", field: "password" }],
};

export const otherItemId = "80000000-0000-4000-8000-000000000002";
export const uriMatch = (overrides: Partial<UriCandidates> = {}): UriCandidates => ({
  connectionId,
  userId,
  snapshotId,
  targetOrigin: origin,
  candidates: [{ itemId, matches: [{ uriIndex: 0, match: 0 }] }],
  unavailableUris: [],
  unavailableItemIds: [],
  ...overrides,
});

export type CustomField = {
  name: string | null;
  kind: "text" | "hidden" | "linked";
  linkedFieldId?: string;
};

export function harness(
  overrides: Partial<LocalSettings> = {},
  live: {
    allowedOrigins?: string[];
    uris?: LiveUriMatcher;
    quarantined?: boolean;
    /** Adds a second, not enabled connection of the same provider account. */
    duplicateAccount?: boolean;
    /** Adds a login username field to the item. */
    username?: boolean;
    /**
     * Adds a login username field to the other item; `empty` when the item holds no value
     * for it, as the catalog flags it.
     */
    otherUsername?: boolean | "empty";
    /** Recipe generation for pages without a recipe. */
    generation?: LoginGeneration;
    /** The item's passkey facts, read when a login starts (ADR 0027). */
    passkeys?: (account: unknown) => Promise<{ passkey: boolean; discoverable: boolean }>;
    /** The items holding a discoverable passkey for an origin (ADR 0034). */
    passkeyItems?: (origin: string) => Promise<readonly PasskeyItem[]>;
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
    /** Cached sign-in entry recipes (ADR 0031). */
    entries?: LoginEntryRecipe[];
    /** Told of each origin a login signed in (ADR 0007). */
    signedIn?: (tabId: number, origin: string) => void;
    /** Spins a tab's toolbar badge while a model request is in flight. */
    spin?: (tabId: number) => () => void;
    /** The toolbar badge, which keeps the tab's page status for the popup (ADR 0038). */
    badge?: LoginBadge;
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
                          ...(live.otherUsername === "empty" ? { empty: true as const } : {}),
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
    chooser: vi.fn(async (): Promise<LoginChooserRecipe | undefined> => undefined),
    entries: vi.fn(async (at: string): Promise<LoginEntryRecipe[]> =>
      (live.entries ?? []).filter((entry) => entry.origin === at),
    ),
  };
  const login = createLoginRuntime(store, {
    fields,
    sites: createLoginSites(store),
    recipes,
    ...(live.uris ? { uris: live.uris } : {}),
    ...(live.generation ? { generation: live.generation } : {}),
    ...(live.passkeys ? { passkeys: live.passkeys } : {}),
    ...(live.passkeyItems ? { passkeyItems: live.passkeyItems } : {}),
    ...(live.vault ? { vault: live.vault } : {}),
    ...(live.signedIn ? { signedIn: live.signedIn } : {}),
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
export const shownHello = (
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
