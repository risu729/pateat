import { describe, expect, it, vi } from "vitest";
import { maxTargetUrlLength } from "@pateat/bitwarden";
import {
  createDefaultSettings,
  resolveSiteAccount,
  type LocalSettings,
  type VaultCatalog,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import { excludeItem, setAccountPolicy } from "./__fixtures__/policy";
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
  fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" as const }],
});
function catalog(state: VaultCatalog["connections"][number]["state"] = "ready"): VaultCatalog {
  return {
    connections: [
      {
        id: "live",
        label: "Live",
        provider: "bitwarden",
        server: "cloud-us",
        userId,
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
  setAccountPolicy(created, value.connections[0]!);
  return excludeItem(created, value.connections[0]!, excludedId);
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
      provider: "bitwarden",
      server: "cloud-us",
      userId,
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

  // Bitwarden clients match a page URL at any length; the crypto host accepts a
  // `match-uris` target up to Chromium's own URL limit.
  const sized = (length: number) => `${url}?q=${"a".repeat(length - url.length - 3)}`;
  /** Answers as the host does: a target over its limit fails request validation. */
  const hostLimited = () =>
    vi.fn<LiveUriMatcher>(async (_connectionId, targetUrl) =>
      targetUrl.length > maxTargetUrlLength
        ? vaultFailure("invalid-request")
        : { ok: true, data: candidates() },
    );

  it("queries the vault for a page URL longer than a saved URI may be", async () => {
    const value = catalog();
    const match = hostLimited();
    const long = sized(8200);
    expect(long).toHaveLength(8200);
    expect(
      await findLiveSiteCandidates({
        settings: settings(value),
        catalog: value,
        url: long,
        match,
      }),
    ).toMatchObject({
      ok: true,
      candidates: [{ connectionId: "live", itemId: loginId }],
      unavailableConnections: [],
    });
    expect(match).toHaveBeenCalledWith("live", long, undefined);
  });

  it("still queries the vault for a page URL of exactly Chromium's limit", async () => {
    const value = catalog();
    const match = hostLimited();
    const longest = sized(maxTargetUrlLength);
    expect(longest).toHaveLength(maxTargetUrlLength);
    expect(
      await findLiveSiteCandidates({
        settings: settings(value),
        catalog: value,
        url: longest,
        match,
      }),
    ).toMatchObject({ ok: true, unavailableConnections: [] });
    expect(match).toHaveBeenCalledWith("live", longest, undefined);
  });

  it("refuses a page URL longer than Chromium allows without querying the vault", async () => {
    const value = catalog();
    const match = hostLimited();
    const result = await findLiveSiteCandidates({
      settings: settings(value),
      catalog: value,
      url: sized(maxTargetUrlLength + 1),
      match,
    });
    expect(result).toEqual({ ok: false, reason: "url-too-long" });
    expect(match).not.toHaveBeenCalled();
  });

  it("skips disabled connections and reports locked ones without querying", async () => {
    const match = matcher({ ok: true, data: candidates() });
    const value = catalog();
    const local = settings(value);
    setAccountPolicy(local, value.connections[0]!, false);
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
    ["dropped context", vaultFailure("uri-context-unavailable"), "uri-context-unavailable"],
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
