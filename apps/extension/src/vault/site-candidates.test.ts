import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  resolveSiteAccount,
  type LocalSettings,
  type VaultCatalog,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import { vaultFailure } from "./record";
import { findLiveSiteCandidates, type LiveUriMatcher } from "./site-candidates";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const otherSnapshotId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const loginId = "44444444-4444-4444-8444-444444444444";
const quarantinedId = "55555555-5555-4555-8555-555555555555";
const excludedId = "66666666-6666-4666-8666-666666666666";
const url = "https://auth.example.com/login";
const item = (id: string) => ({
  id,
  label: `Synthetic ${id.slice(0, 4)}`,
  allowedOrigins: [],
  groupIds: [],
  fields: [{ id: "login.password", label: "Password" }],
});
function catalog(state: VaultCatalog["connections"][number]["state"] = "ready"): VaultCatalog {
  return {
    connections: [
      {
        id: "live",
        label: "Live",
        provider: "bitwarden",
        snapshotId,
        state,
        quarantinedItemIds: [quarantinedId],
        groups: [],
        items: [item(loginId), item(quarantinedId), item(excludedId)],
      },
    ],
  };
}
function settings(value = catalog()): LocalSettings {
  const created = createDefaultSettings(value);
  // Real connections start disabled; these tests model an explicit owner grant.
  created.connections[0]!.enabled = true;
  created.connections[0]!.excludedItemIds.push(excludedId);
  return created;
}
const candidates = (overrides: Partial<UriCandidates> = {}): UriCandidates => ({
  connectionId: "live",
  userId,
  snapshotId,
  targetOrigin: "https://auth.example.com",
  candidates: [loginId, quarantinedId, excludedId].map((itemId) => ({
    itemId,
    matches: [{ uriIndex: 0, match: 0 }],
  })),
  unavailableUris: [],
  unavailableItemIds: [],
  ...overrides,
});
const matcher = (result: Awaited<ReturnType<LiveUriMatcher>>) =>
  vi.fn<LiveUriMatcher>(async () => result);

describe("live provider URI candidates", () => {
  it("returns eligible live matches without granting an allowed origin", async () => {
    const match = matcher({ ok: true, data: candidates() });
    const value = catalog();
    const local = settings(value);
    expect(await findLiveSiteCandidates({ settings: local, catalog: value, url, match })).toEqual({
      ok: true,
      origin: "https://auth.example.com",
      candidates: [
        { connectionId: "live", itemId: loginId, snapshotId, matches: [{ uriIndex: 0, match: 0 }] },
      ],
      incompleteItems: [],
      unavailableConnections: [],
    });
    expect(match).toHaveBeenCalledWith("live", url, undefined);
    expect(value.connections[0]!.items[0]!.allowedOrigins).toEqual([]);
    local.siteDefaults.push({
      origin: "https://auth.example.com",
      connectionId: "live",
      itemId: loginId,
    });
    expect(resolveSiteAccount(local, value, url)).toEqual({
      ok: false,
      reason: "item-origin-mismatch",
    });
  });

  it("does not query the vault for an excluded site or invalid URL", async () => {
    const match = matcher({ ok: true, data: candidates() });
    const value = catalog();
    const local = settings(value);
    local.excludedSites.push({ hostname: "example.com", includeSubdomains: true });
    expect(await findLiveSiteCandidates({ settings: local, catalog: value, url, match })).toEqual({
      ok: false,
      reason: "site-excluded",
    });
    expect(
      await findLiveSiteCandidates({
        settings: settings(value),
        catalog: value,
        url: "https://user@auth.example.com/",
        match,
      }),
    ).toEqual({ ok: false, reason: "invalid-url" });
    expect(match).not.toHaveBeenCalled();
  });

  it("skips disabled connections and reports locked ones without querying", async () => {
    const match = matcher({ ok: true, data: candidates() });
    const value = catalog();
    const local = settings(value);
    local.connections[0]!.enabled = false;
    expect(await findLiveSiteCandidates({ settings: local, catalog: value, url, match })).toEqual({
      ok: true,
      origin: "https://auth.example.com",
      candidates: [],
      incompleteItems: [],
      unavailableConnections: [],
    });
    const locked = catalog("locked");
    expect(
      await findLiveSiteCandidates({ settings: settings(locked), catalog: locked, url, match }),
    ).toMatchObject({ ok: true, candidates: [], unavailableConnections: [{ reason: "locked" }] });
    expect(match).not.toHaveBeenCalled();
  });

  it.each([
    ["older context", vaultFailure("uri-context-unavailable"), "uri-context-unavailable"],
    ["stale handle", vaultFailure("stale-vault-handle"), "stale-vault-handle"],
    ["missing session", undefined, "unavailable"],
    [
      "other snapshot",
      { ok: true, data: candidates({ snapshotId: otherSnapshotId }) },
      "stale-snapshot",
    ],
    [
      "other origin",
      { ok: true, data: candidates({ targetOrigin: "https://example.net" }) },
      "stale-snapshot",
    ],
    [
      "other connection",
      { ok: true, data: candidates({ connectionId: "other" }) },
      "stale-snapshot",
    ],
  ] as const)("reports %s as unavailable rather than no match", async (_label, result, reason) => {
    const value = catalog();
    expect(
      await findLiveSiteCandidates({
        settings: settings(value),
        catalog: value,
        url,
        match: matcher(result as Awaited<ReturnType<LiveUriMatcher>>),
      }),
    ).toEqual({
      ok: true,
      origin: "https://auth.example.com",
      candidates: [],
      incompleteItems: [],
      unavailableConnections: [{ connectionId: "live", reason }],
    });
  });

  it("reports eligible items with unevaluated rules instead of treating them as no match", async () => {
    const value = catalog();
    const match = matcher({
      ok: true,
      data: candidates({
        candidates: [],
        unavailableUris: [
          { itemId: loginId, uriIndex: 0, reason: "default-match-unavailable" },
          { itemId: loginId, uriIndex: 1, reason: "default-match-unavailable" },
          { itemId: excludedId, uriIndex: 0, reason: "equivalent-domains-unavailable" },
          { itemId: loginId, uriIndex: 2, reason: "unsupported-uri-scheme" },
          { itemId: loginId, uriIndex: 3, reason: "invalid-uri" },
          { itemId: loginId, uriIndex: 4, reason: "unsupported-uri-match" },
        ],
        unavailableItemIds: [quarantinedId],
      }),
    });
    expect(
      await findLiveSiteCandidates({ settings: settings(value), catalog: value, url, match }),
    ).toEqual({
      ok: true,
      origin: "https://auth.example.com",
      candidates: [],
      incompleteItems: [
        {
          connectionId: "live",
          itemId: loginId,
          reasons: ["default-match-unavailable", "unsupported-uri-match"],
        },
      ],
      unavailableConnections: [],
    });
  });

  it("contains a throwing matcher to its own connection", async () => {
    const value = catalog();
    const match = vi.fn<LiveUriMatcher>(async () => {
      throw new Error("synthetic-host-loss");
    });
    const result = await findLiveSiteCandidates({
      settings: settings(value),
      catalog: value,
      url,
      match,
    });
    expect(result).toMatchObject({ ok: true, unavailableConnections: [{ reason: "unavailable" }] });
    expect(JSON.stringify(result)).not.toContain("synthetic-host-loss");
  });
});
