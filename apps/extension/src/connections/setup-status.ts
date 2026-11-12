import type { VaultSyncEntry } from "./auto-sync";
import type { ConnectionSetupDependencies, SetupReply } from "./types";

/** Reads local connection status without opening a vault or contacting its provider. */
export function createSetupStatus(
  deps: ConnectionSetupDependencies,
  now: () => number,
  reviews: Map<string, string[]>,
) {
  /** A finished unchanged check confirms the open snapshot was current when it was sent.
   * One in the future (a clock set back) confirms nothing. */
  function syncedAt(acceptedAt: number, check: VaultSyncEntry | undefined) {
    const unchangedAt = check?.unchangedAt;
    return unchangedAt !== undefined && unchangedAt <= now()
      ? Math.max(acceptedAt, unchangedAt)
      : acceptedAt;
  }
  /** The last automatic check's failure, for the settings page. A later check that did not
   * fail, or a full sync that applied, dropped it; a manual Sync's own failure is answered
   * to the page directly. A stored value the reply cannot carry is left out, so it never
   * fails the whole status. */
  function lastCheckFailure(check: VaultSyncEntry | undefined) {
    const failure = check?.outcome === "failed" ? check.failure : undefined;
    if (!failure || !/^[a-z-]{1,80}$/.test(failure.cause)) return {};
    return {
      syncFailure: {
        at: failure.at,
        code: failure.cause,
        ...(failure.check !== undefined && /^[a-z-]{1,40}$/.test(failure.check)
          ? { check: failure.check }
          : {}),
      },
    };
  }
  async function status(): Promise<SetupReply> {
    const configurations = await deps.registry.list();
    const connections: Extract<SetupReply, { kind: "status" }>["connections"] = [];
    const checks = await deps.revisions?.read().catch(() => undefined);
    for (const configuration of configurations) {
      const vault = deps.vaultFor(configuration.profile);
      // Bounded sequential native-store reads; no provider HTTP is performed by status.
      // eslint-disable-next-line no-await-in-loop
      const record = await vault.store.read();
      const known = record.ok ? record.data : null;
      // A vault status does not open is answered from this worker's last sync.
      const quarantine =
        (known?.accepted && deps.policy.quarantined
          ? // eslint-disable-next-line no-await-in-loop
            await deps.policy.quarantined(
              configuration.profile.connectionId,
              known.accepted.snapshotId,
            )
          : undefined) ??
        reviews.get(configuration.profile.connectionId) ??
        [];
      // eslint-disable-next-line no-await-in-loop
      const providerSession = await deps.sessions.status(configuration.profile);
      // A locked record unlocked in this browser session has its key in memory (ADR 0075).
      const locked =
        // eslint-disable-next-line no-await-in-loop
        known?.state === "locked" && !(await vault.manager.keyFor(known));
      const opened = vault.manager.status();
      const state = !record.ok
        ? "unavailable"
        : known?.state === "disabled"
          ? "disabled"
          : locked
            ? "locked"
            : quarantine.length
              ? "review-required"
              : opened.ready
                ? "ready"
                : "configured";
      connections.push({
        connectionId: configuration.profile.connectionId,
        label: configuration.label,
        email: configuration.email,
        environment: configuration.profile.environment,
        state,
        autoUnlock:
          known?.state === "active"
            ? "enabled"
            : known?.state === "disabled" || known?.state === "locked"
              ? "disabled"
              : "unknown",
        providerSession,
        // Items the account mapper or strict decryption refused are left out (ADR 0006).
        ...(opened.unusableItems?.length && (state === "ready" || state === "review-required")
          ? {
              unusableItemCount: opened.unusableItems.length,
              unusableItems: opened.unusableItems
                .slice(0, 100)
                .map(({ itemId, check }) => ({ itemId, ...(check ? { check } : {}) })),
            }
          : {}),
        // Items used without the fields that did not decrypt (ADR 0006).
        ...(opened.partialItems?.length && (state === "ready" || state === "review-required")
          ? {
              partialItemCount: opened.partialItems.length,
              partialItems: opened.partialItems.slice(0, 100).map(({ itemId, fields }) => ({
                itemId,
                fields: fields.slice(0, 20),
                ...(fields.length > 20 ? { moreFieldCount: fields.length - 20 } : {}),
              })),
            }
          : {}),
        ...lastCheckFailure(checks?.connections[configuration.profile.connectionId]),
        ...(known?.accepted
          ? {
              snapshotId: known.accepted.snapshotId,
              syncedAt: syncedAt(
                known.accepted.acceptedAt,
                checks?.connections[configuration.profile.connectionId],
              ),
            }
          : {}),
      });
    }
    return { ok: true, kind: "status", connections };
  }
  return status;
}
