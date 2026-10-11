import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type SettingsResponse,
  type VaultCatalog,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import { vaultFailure } from "./record";
import { createSiteAccountsHandler, findSiteAccounts, rpIdsFor } from "./site-accounts";
import type { LiveUriMatcher } from "./site-candidates";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
const uriItem = "44444444-4444-4444-8444-444444444444";
const passkeyItem = "55555555-5555-4555-8555-555555555555";
const otherItem = "66666666-6666-4666-8666-666666666666";
const excludedItem = "77777777-7777-4777-8777-777777777777";
const origin = "https://my.bank.example";
const item = (id: string) => ({
  id,
  label: "Same name",
  allowedOrigins: [],
  groupIds: [],
  fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" as const }],
});

function saved(state: "ready" | "unavailable" = "ready"): Extract<SettingsResponse, { ok: true }> {
  const catalog: VaultCatalog = {
    connections: [
      ...structuredClone(DUMMY_VAULT_CATALOG.connections),
      {
        id: "live",
        label: "Live",
        provider: "bitwarden",
        userId,
        ...(state === "ready" ? { snapshotId } : {}),
        state,
        groups: [],
        items: [uriItem, passkeyItem, otherItem, excludedItem].map(item),
      },
    ],
  };
  const settings = createDefaultSettings(catalog);
  // Real connections start disabled; these tests model an explicit owner grant.
  settings.connections.find((entry) => entry.connectionId === "live")!.enabled = true;
  settings.connections
    .find((entry) => entry.connectionId === "live")!
    .excludedItemIds.push(excludedItem);
  return { version: 1, ok: true, snapshot: { version: 1, revision: 3, settings }, catalog };
}

const uris = (overrides: Partial<UriCandidates> = {}): UriCandidates => ({
  connectionId: "live",
  userId,
  snapshotId,
  targetOrigin: origin,
  candidates: [uriItem, excludedItem].map((itemId) => ({
    itemId,
    matches: [{ uriIndex: 0, match: 0 }],
  })),
  unavailableUris: [],
  unavailableItemIds: [],
  ...overrides,
});

describe("findSiteAccounts", () => {
  it("lists eligible URI matches and passkey holders for the origin, nothing else", async () => {
    const matchUris = vi.fn<LiveUriMatcher>().mockResolvedValue({ ok: true, data: uris() });
    const findPasskeys = vi.fn(async (_origin: string, rpId: string) => ({
      candidates:
        rpId === "bank.example"
          ? [
              { connectionId: "live", itemId: passkeyItem },
              { connectionId: "live", itemId: uriItem },
            ]
          : [],
      complete: true,
    }));
    const result = await findSiteAccounts({ saved: saved(), origin, matchUris, findPasskeys });
    expect(result).toEqual({
      version: 1,
      ok: true,
      origin,
      accounts: [
        { connectionId: "live", itemId: uriItem, uri: true, passkey: true },
        { connectionId: "live", itemId: passkeyItem, uri: false, passkey: true },
      ],
      complete: true,
    });
    expect(matchUris).toHaveBeenCalledWith("live", `${origin}/`, undefined);
    // Every RP ID a page on this host may use is searched.
    expect(findPasskeys.mock.calls.map(([, rpId]) => rpId)).toEqual([
      "my.bank.example",
      "bank.example",
    ]);
  });

  it("lists bundled demo items by their static origins", async () => {
    const result = await findSiteAccounts({
      saved: saved(),
      origin: "https://mail.example",
      matchUris: async () => ({
        ok: true,
        data: uris({ targetOrigin: "https://mail.example", candidates: [] }),
      }),
      findPasskeys: async () => ({ candidates: [], complete: true }),
    });
    expect(result).toMatchObject({
      ok: true,
      accounts: [{ connectionId: "demo-personal", itemId: "secondary", uri: true, passkey: false }],
      complete: true,
    });
  });

  it("reports an unsearched vault as incomplete instead of an empty answer", async () => {
    const result = await findSiteAccounts({
      saved: saved("unavailable"),
      origin,
      matchUris: async () => vaultFailure("crypto-locked"),
      findPasskeys: async () => ({ candidates: [], complete: false }),
    });
    expect(result).toEqual({ version: 1, ok: true, origin, accounts: [], complete: false });
  });

  it("refuses an excluded site before asking any vault", async () => {
    const value = saved();
    value.snapshot.settings.excludedSites.push({
      hostname: "bank.example",
      includeSubdomains: true,
    });
    const matchUris = vi.fn<LiveUriMatcher>();
    const findPasskeys = vi.fn();
    expect(await findSiteAccounts({ saved: value, origin, matchUris, findPasskeys })).toEqual({
      version: 1,
      ok: false,
      reason: "site-excluded",
    });
    expect(matchUris).not.toHaveBeenCalled();
    expect(findPasskeys).not.toHaveBeenCalled();
  });
});

describe("createSiteAccountsHandler", () => {
  it("rejects malformed requests and answers from the saved settings", async () => {
    const handle = createSiteAccountsHandler({
      settings: { handle: async () => saved() },
      matchUris: async () => ({ ok: true, data: uris() }),
      findPasskeys: async () => ({ candidates: [], complete: true }),
    });
    expect(
      await handle({ version: 1, type: "settings.site-accounts", origin: `${origin}/path` }),
    ).toEqual({ version: 1, ok: false, reason: "invalid-request" });
    expect(await handle({ version: 1, type: "settings.site-accounts", origin })).toMatchObject({
      ok: true,
      accounts: [{ itemId: uriItem }],
    });
  });
});

describe("rpIdsFor", () => {
  it("lists the host and its parent domains, and an IP address alone", () => {
    expect(rpIdsFor("my.jcb.co.jp")).toEqual(["my.jcb.co.jp", "jcb.co.jp", "co.jp"]);
    expect(rpIdsFor("example.com")).toEqual(["example.com"]);
    expect(rpIdsFor("127.0.0.1")).toEqual(["127.0.0.1"]);
  });
});
