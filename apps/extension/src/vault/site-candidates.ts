import {
  getItemEligibility,
  isSiteExcluded,
  parseSiteUrl,
  type LocalSettings,
  type VaultCatalog,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import type { VaultResult } from "./record";

export type LiveUriMatcher = (
  connectionId: string,
  targetUrl: string,
  signal?: AbortSignal,
) => Promise<VaultResult<UriCandidates> | undefined>;
export type LiveSiteCandidate = {
  connectionId: string;
  itemId: string;
  snapshotId: string;
  matches: UriCandidates["candidates"][number]["matches"];
};
export type IncompleteSiteItem = {
  connectionId: string;
  itemId: string;
  /** URI rules that could not be evaluated, e.g. an unavailable default or oversized item. */
  reasons: string[];
};
export type LiveSiteCandidates =
  | {
      ok: true;
      origin: string;
      candidates: LiveSiteCandidate[];
      /** Eligible items with unevaluated rules; they may still belong to this page. */
      incompleteItems: IncompleteSiteItem[];
      /** Connections whose live snapshot could not answer; never treated as "no match". */
      unavailableConnections: { connectionId: string; reason: string }[];
    }
  | { ok: false; reason: "invalid-url" | "site-excluded" };

/** Provider URI matches for one page, narrowed by local settings before anything else.
 * Matches are candidate scope only: they never become `allowedOrigins`, site defaults,
 * or a field grant, and account/recipe/document checks still gate any release.
 * Callers must not pass a per-navigation signal: host cancellation retires the whole
 * session, so aborting a page query would lock the vault.
 */
export async function findLiveSiteCandidates(input: {
  settings: LocalSettings;
  catalog: VaultCatalog;
  url: string;
  match: LiveUriMatcher;
  signal?: AbortSignal;
}): Promise<LiveSiteCandidates> {
  const { settings, catalog, url } = input;
  const parsed = parseSiteUrl(url);
  if (!parsed) return { ok: false, reason: "invalid-url" };
  // Excluded sites never reach vault matching.
  if (isSiteExcluded(settings, url)) return { ok: false, reason: "site-excluded" };
  const candidates: LiveSiteCandidate[] = [];
  const incompleteItems: IncompleteSiteItem[] = [];
  const unavailableConnections: { connectionId: string; reason: string }[] = [];
  for (const connection of catalog.connections) {
    const configured = settings.connections.find((entry) => entry.connectionId === connection.id);
    if (!configured?.enabled) continue;
    if (
      !connection.snapshotId ||
      (connection.state !== "ready" && connection.state !== "review-required")
    ) {
      unavailableConnections.push({
        connectionId: connection.id,
        reason: connection.state ?? "snapshot-unavailable",
      });
      continue;
    }
    let result: VaultResult<UriCandidates> | undefined;
    try {
      // Sequential: each connection shares the bounded native host.
      // eslint-disable-next-line no-await-in-loop
      result = await input.match(connection.id, url, input.signal);
    } catch {
      result = undefined;
    }
    if (!result?.ok) {
      unavailableConnections.push({
        connectionId: connection.id,
        reason: result?.error.code ?? "unavailable",
      });
      continue;
    }
    // Settings and catalog describe one accepted snapshot; a different one needs reconciliation.
    if (
      result.data.connectionId !== connection.id ||
      result.data.snapshotId !== connection.snapshotId ||
      result.data.targetOrigin !== parsed.origin
    ) {
      unavailableConnections.push({ connectionId: connection.id, reason: "stale-snapshot" });
      continue;
    }
    const eligible = (itemId: string) =>
      !connection.quarantinedItemIds?.includes(itemId) &&
      getItemEligibility(settings, catalog, connection.id, itemId).eligible;
    const incomplete = new Map<string, Set<string>>();
    const note = (itemId: string, reason: string) => {
      if (!eligible(itemId)) return;
      const reasons = incomplete.get(itemId) ?? new Set<string>();
      reasons.add(reason);
      incomplete.set(itemId, reasons);
    };
    for (const entry of result.data.unavailableUris) note(entry.itemId, entry.reason);
    for (const itemId of result.data.unavailableItemIds) note(itemId, "item-unavailable");
    for (const [itemId, reasons] of incomplete)
      incompleteItems.push({ connectionId: connection.id, itemId, reasons: [...reasons] });
    for (const entry of result.data.candidates) {
      if (!eligible(entry.itemId)) continue;
      candidates.push({
        connectionId: connection.id,
        itemId: entry.itemId,
        snapshotId: result.data.snapshotId,
        matches: entry.matches,
      });
    }
  }
  return { ok: true, origin: parsed.origin, candidates, incompleteItems, unavailableConnections };
}
