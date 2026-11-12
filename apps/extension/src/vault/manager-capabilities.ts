import type { LocalFieldReference } from "@pateat/bitwarden";
import type { PasskeySignRequest } from "../crypto/passkey";
import { vaultFailure } from "./record";
import type { LocalVaultHandle } from "./manager-types";
import type { VaultSession } from "./manager-session";

export function vaultCapabilities(context: VaultSession) {
  return {
    async listFields(handle: LocalVaultHandle, itemId: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      return context.withLiveVault(handle, (session) =>
        context.options.host.listFields(session, itemId, signal),
      );
    },
    async catalog(handle: LocalVaultHandle, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      return context.withLiveVault(handle, (session) =>
        context.options.host.catalog(session, signal),
      );
    },
    /** Candidate signal for the live accepted snapshot only; it grants no field release. */
    async matchUris(handle: LocalVaultHandle, targetUrl: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof targetUrl !== "string") return vaultFailure("invalid-uri-input");
      return context.withLiveVault(handle, (session) =>
        context.options.host.matchUris(session, targetUrl, signal),
      );
    },
    /**
     * The login usernames of these items in the live accepted snapshot, which its crypto
     * Worker kept when it verified the snapshot (ADR 0080); no other field.
     */
    async loginUsernames(
      handle: LocalVaultHandle,
      itemIds: readonly string[],
      signal?: AbortSignal,
    ) {
      let ids: string[];
      try {
        handle = structuredClone(handle);
        ids = structuredClone([...itemIds]);
      } catch {
        return vaultFailure("invalid-request");
      }
      return context.withLiveVault(handle, (session) =>
        context.options.host.loginUsernames(session, ids, signal),
      );
    },
    /** Secret-free metadata for the live accepted snapshot's passkeys with this RP ID. */
    async findPasskeys(handle: LocalVaultHandle, rpId: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof rpId !== "string") return vaultFailure("invalid-request");
      return context.withLiveVault(handle, (session) =>
        context.options.host.findPasskeys(session, rpId, signal),
      );
    },
    /** The RP IDs of one item's stored passkeys in the live accepted snapshot (ADR 0084). */
    async passkeyRpIds(handle: LocalVaultHandle, itemId: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof itemId !== "string") return vaultFailure("invalid-request");
      return context.withLiveVault(handle, (session) =>
        context.options.host.passkeyRpIds(session, itemId, signal),
      );
    },
    /** One assertion signature from the live snapshot's stored key for that item. */
    async signPasskey(
      handle: LocalVaultHandle,
      input: { itemId: string } & PasskeySignRequest,
      signal?: AbortSignal,
    ) {
      try {
        handle = structuredClone(handle);
        input = structuredClone(input);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof input !== "object" || input === null) return vaultFailure("invalid-request");
      return context.withLiveVault(handle, (session) =>
        context.options.host.signPasskey(session, input, signal),
      );
    },
    /**
     * Whether `password` is the master password of the live session's account, checked
     * offline against the accepted record's unlock data, as before a re-prompt item is used.
     */
    async verifyMasterPassword(handle: LocalVaultHandle, password: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof password !== "string" || !password) return vaultFailure("invalid-request");
      return context.withLiveVault(handle, (session) =>
        context.options.host.verifyMasterPassword(session, password, signal),
      );
    },
    async resolveField(
      handle: LocalVaultHandle,
      ref: LocalFieldReference,
      grant: {
        snapshotId: string;
        allowedFieldIds: readonly string[];
        nowMs?: number;
        code?: true;
      },
      signal?: AbortSignal,
    ) {
      try {
        handle = structuredClone(handle);
        ref = structuredClone(ref);
        grant = structuredClone(grant);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (!context.validHandle(handle) || !context.live) return vaultFailure("stale-vault-handle");
      if (grant.snapshotId !== context.live.handle.snapshotId)
        return vaultFailure("stale-field-reference");
      const currentLive = context.live;
      const before = await context.checkDurable(currentLive);
      if (!before.ok || !context.validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const { snapshotId: _snapshotId, ...fields } = grant;
      const result = await context.options.host.resolveField(
        currentLive.opened.session,
        ref,
        fields,
        signal,
      );
      const after = await context.checkDurable(currentLive);
      if (!after.ok) return after;
      return context.validHandle(handle) && context.live === currentLive
        ? result
        : vaultFailure("stale-vault-handle");
    },
    /**
     * `resolveField` for several fields of the live snapshot, with one durable check before
     * and one after all of them: every value is refused once the vault changed meanwhile.
     */
    async resolveFields(
      handle: LocalVaultHandle,
      fields: readonly {
        ref: LocalFieldReference;
        grant: { snapshotId: string; allowedFieldIds: readonly string[]; code?: true };
      }[],
      signal?: AbortSignal,
    ) {
      let captured: typeof fields;
      try {
        handle = structuredClone(handle);
        captured = structuredClone(fields);
      } catch {
        return fields.map(() => vaultFailure("invalid-request"));
      }
      const all = (code: Parameters<typeof vaultFailure>[0]) =>
        captured.map(() => vaultFailure(code));
      if (!context.validHandle(handle) || !context.live) return all("stale-vault-handle");
      const currentLive = context.live;
      const before = await context.checkDurable(currentLive);
      if (!before.ok) return all(before.error.code);
      if (!context.validHandle(handle)) return all("stale-vault-handle");
      const results = [];
      for (const { ref, grant } of captured) {
        if (grant.snapshotId !== currentLive.handle.snapshotId) {
          results.push(vaultFailure("stale-field-reference"));
          continue;
        }
        const { snapshotId: _snapshotId, ...rest } = grant;
        // oxlint-disable-next-line no-await-in-loop -- the crypto Worker takes one job at a time
        const result = await context.options.host.resolveField(
          currentLive.opened.session,
          ref,
          rest,
          signal,
        );
        results.push(result);
      }
      const after = await context.checkDurable(currentLive);
      if (!after.ok) return all(after.error.code);
      return context.validHandle(handle) && context.live === currentLive
        ? results
        : all("stale-vault-handle");
    },
  };
}
