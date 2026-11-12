import {
  createBitwardenAccountMapper,
  type PasswordTokenOutcome,
  type BitwardenProfile,
} from "@pateat/bitwarden";
import type { LocalVaultHandle } from "../vault/manager";
import type { VaultEntry } from "../vault/record";
import type { VaultApplyHold } from "./auto-sync";
import { error } from "./setup-reply";
import { profileServer } from "./policy";
import type {
  BitwardenConnectionConfiguration,
  ConnectionSetupDependencies,
  SetupReply,
} from "./types";

type Authenticated = Extract<PasswordTokenOutcome, { kind: "authenticated" }>;
/** Results only an automatic check produces; they never reach the settings page. */
type AutoReply =
  | { ok: true; kind: "unchanged" }
  | { ok: true; kind: "deferred" }
  | { ok: false; error: { code: "account-deleted" } };
export type Flow = {
  id: string;
  configuration: BitwardenConnectionConfiguration;
  password: string;
  hash?: string;
  intent: "enable" | "preserve";
  /** An explicit sync with a stored session; only such a flow may be aborted by forget. */
  sync?: boolean;
  controller: AbortController;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  providers?: (0 | 1)[];
  newDevice?: boolean;
  manual: { twoFactor?: { provider: 0 | 1; code: string }; newDeviceOtp?: string };
  published?: boolean;
  retire?: () => Promise<void>;
  retirement?: Promise<void>;
};
type SyncContext = {
  now: () => number;
  alive: (flow: Flow) => boolean;
  stopped: (flow: Flow) => SetupReply;
  permitted: (flow: Flow) => Promise<boolean>;
  clear: (flow: Flow) => void;
  handles: Map<string, LocalVaultHandle>;
  reviews: Map<string, string[]>;
};

/** Coordinates authentication and snapshot publication using the service's live guards. */
export function createSetupSync(deps: ConnectionSetupDependencies, context: SyncContext) {
  const { now, alive, stopped, permitted, clear, handles, reviews } = context;
  function binding(profile: BitwardenProfile, email: string, old: VaultEntry | null) {
    const known = old?.accepted;
    return known
      ? {
          kind: "known" as const,
          profile,
          email: known.prepared.binding.email,
          userId: known.userId,
          accountVersion: known.accountVersion,
          minimumSecurityVersion: known.minimumSecurityVersion,
        }
      : { kind: "bootstrap" as const, email };
  }
  async function acceptSync(
    flow: Flow,
    authenticated: Authenticated,
    unlock: { kind: "password"; password: string } | { kind: "decrypted-key"; userKey: string },
    source: { kind: "password"; receivedAt: number } | { kind: "session"; revision: string },
    /** An automatic check: skip an unchanged vault and wait for logins in progress. */
    auto?: { stored: number | undefined; hold: VaultApplyHold },
  ): Promise<SetupReply | AutoReply> {
    const profile = flow.configuration.profile;
    if (!(await permitted(flow)))
      return alive(flow) ? error("provider-permission-required") : error("cancelled");
    const transport = deps.transportFor(profile);
    if (!transport.ok) return transport;
    const vault = deps.vaultFor(profile);
    const prior = await vault.store.read();
    if (!prior.ok) return prior;
    if (!alive(flow)) return error("cancelled");
    if (!(await permitted(flow)))
      return alive(flow) ? error("provider-permission-required") : error("cancelled");
    // The cheap check comes first, so an unchanged vault keeps its snapshot (ADR 0025).
    const revision = await transport.data.revisionDate(
      { connectionId: profile.connectionId, accessToken: authenticated.tokens.accessToken },
      flow.controller.signal,
    );
    if (!revision.ok) {
      if (
        source.kind === "session" &&
        revision.error.code === "http-error" &&
        revision.error.status === 401
      ) {
        await deps.sessions.discard(profile, source.revision);
        return error("setup-reauthentication-required");
      }
      // A manual sync does not depend on the check; it only stores no revision.
      if (auto) return revision;
    }
    if (!alive(flow)) return error("cancelled");
    const revisionMs =
      revision.ok && revision.data !== null && revision.data >= 0 ? revision.data : undefined;
    if (auto) {
      if (revision.ok && revision.data !== null && revision.data < 0)
        return { ok: false, error: { code: "account-deleted" } };
      if (revisionMs !== undefined && revisionMs === auto.stored)
        return { ok: true, kind: "unchanged" };
      if (!(await auto.hold.ready())) return { ok: true, kind: "deferred" };
      if (!alive(flow)) return error("cancelled");
    }
    const synced = await transport.data.sync(
      { connectionId: profile.connectionId, accessToken: authenticated.tokens.accessToken },
      flow.controller.signal,
    );
    if (!synced.ok) {
      // A server rejection of the stored access token ends that sync session only.
      // Only the session that was used is cleared; a newer one stays.
      if (
        source.kind === "session" &&
        synced.error.code === "http-error" &&
        synced.error.status === 401
      ) {
        await deps.sessions.discard(profile, source.revision);
        return error("setup-reauthentication-required");
      }
      return synced;
    }
    if (!alive(flow)) return error("cancelled");
    const mapper = createBitwardenAccountMapper(
      profile,
      binding(profile, flow.configuration.email, prior.data),
      { nowSeconds: () => Math.floor(now() / 1000) },
    );
    if (!mapper.ok) return mapper;
    const mapped = mapper.data.map({
      connectionId: profile.connectionId,
      authenticated,
      sync: synced.data,
    });
    if (!mapped.ok) {
      // The stored encrypted context no longer matches current account crypto state.
      // Require password sign-in again; the existing cache is left untouched.
      if (source.kind === "session" && mapped.error.code === "account-mismatch") {
        await deps.sessions.discard(profile, source.revision);
        return error("setup-reauthentication-required");
      }
      return mapped;
    }
    // Protected items whose decrypted custom fields are compared with the open snapshot.
    const protectedItems = deps.policy.protectedItems
      ? await deps.policy.protectedItems(profile.connectionId).catch((): string[] => [])
      : [];
    if (!alive(flow)) return error("cancelled");
    // Replacing the snapshot and adopting it stops logins, so none may start meanwhile.
    let release: (() => void) | undefined;
    if (auto) {
      release = await auto.hold.take();
      if (!release) return { ok: true, kind: "deferred" };
    }
    try {
      const accepted = await vault.manager.accept(
        {
          prepared: mapped.data,
          unlock,
          autoUnlock: flow.intent,
          compareCustomFields: protectedItems,
        },
        flow.controller.signal,
      );
      if (!accepted.ok) return accepted;
      flow.retire = async () => {
        // Cancellation of refresh never disables the previously accepted cache.
        // A first-enrollment compensation compares exactly this candidate revision.
        if (!prior.data?.accepted)
          await vault.manager.disableAutoUnlock(accepted.data.summary.revision);
        else await vault.manager.lock?.();
      };
      if (!alive(flow)) {
        clear(flow);
        await flow.retirement;
        return error("storage-uncertain");
      }
      const current = await vault.store.read();
      if (
        !current.ok ||
        !current.data ||
        current.data.state === "disabled" ||
        current.data.revision !== accepted.data.summary.revision
      )
        return error("storage-uncertain");
      const metadata = await vault.manager.catalog(accepted.data.handle, flow.controller.signal);
      if (!metadata.ok) return metadata;
      if (!alive(flow)) {
        clear(flow);
        await flow.retirement;
        return error("storage-uncertain");
      }
      const catalog = {
        id: profile.connectionId,
        label: flow.configuration.label,
        provider: "bitwarden",
        server: profileServer(profile),
        userId: metadata.data.userId,
        groups: metadata.data.groups,
        items: metadata.data.items.map((item) => ({
          id: item.id,
          label: item.label,
          allowedOrigins: [],
          ...(item.inactive ? { inactive: true as const } : {}),
          groupIds: item.groupIds,
          ...(item.reprompt ? { reprompt: true as const } : {}),
          fields: item.fields.map(({ id, label, name, kind, linkedFieldId }) => ({
            id,
            label,
            name,
            kind,
            ...(linkedFieldId ? { linkedFieldId } : {}),
          })),
        })),
      };
      const adopted = await deps.policy.adopt({
        previous: prior.data,
        next: current.data,
        catalog,
        // Only a comparison with the very snapshot this adoption replaces counts.
        sameCustomFields:
          accepted.data.comparedSnapshotId !== undefined &&
          accepted.data.comparedSnapshotId === prior.data?.accepted?.snapshotId
            ? accepted.data.sameCustomFields
            : [],
        ...(auto ? { automatic: true as const } : {}),
      });
      if (!alive(flow)) {
        clear(flow);
        await flow.retirement;
        return error("storage-uncertain");
      }
      handles.set(profile.connectionId, accepted.data.handle);
      reviews.set(profile.connectionId, adopted.policyReviewItemIds);
      flow.published = true;
      await (
        revisionMs === undefined
          ? deps.revisions?.forgetFailure(profile.connectionId)
          : deps.revisions?.setRevision(profile.connectionId, revisionMs)
      )?.catch(() => undefined);
      // A failed write leaves the cache usable; status then asks for sign-in before the next sync.
      if (source.kind === "password") {
        const retained = await deps.sessions.retain(
          profile,
          authenticated,
          { userId: mapped.data.binding.userId, email: mapped.data.binding.email },
          accepted.data.summary.revision,
          source.receivedAt,
        );
        // Permission removal may have forgotten the store before this write landed.
        if (retained.ok && !(await deps.permissions.contains(profile).catch(() => false)))
          await deps.sessions.discard(profile, retained.data);
      }
      return {
        ok: true,
        kind: "ready",
        connectionId: profile.connectionId,
        snapshotId: accepted.data.handle.snapshotId,
        policyReviewItemIds: adopted.policyReviewItemIds,
      };
    } finally {
      release?.();
    }
  }
  async function authorize(flow: Flow): Promise<SetupReply> {
    if (!flow.hash) return error("invalid-request");
    if (!(await permitted(flow)))
      return alive(flow) ? error("provider-permission-required") : error("cancelled");
    const profile = flow.configuration.profile;
    const transport = deps.transportFor(profile);
    if (!transport.ok) return transport;
    const token = await transport.data.passwordToken(
      {
        connectionId: profile.connectionId,
        email: flow.configuration.email,
        masterPasswordHash: flow.hash,
        device: { identifier: flow.configuration.deviceIdentifier, name: "Pateat Chrome" },
        ...(flow.manual.twoFactor
          ? {
              twoFactor: {
                provider: flow.manual.twoFactor.provider,
                token: flow.manual.twoFactor.code,
                remember: false,
              },
            }
          : {}),
        ...(flow.manual.newDeviceOtp ? { newDeviceOtp: flow.manual.newDeviceOtp } : {}),
      },
      flow.controller.signal,
    );
    // Token lifetime counts from receipt, not from the end of sync and acceptance.
    const receivedAt = now();
    // The flow's own end aborts the request too; that reads as its end, not a failure.
    if (!alive(flow)) return stopped(flow);
    if (!token.ok) return token;
    const outcome = token.data;
    // As on the official two-step page, a refused code keeps the sign-in for another try.
    if (
      outcome.kind === "rejected" &&
      outcome.reason === "mfa" &&
      flow.manual.twoFactor &&
      flow.providers
    ) {
      const { twoFactor: _refused, ...manual } = flow.manual;
      flow.manual = manual;
      return {
        ok: true,
        kind: "mfa-required",
        flowId: flow.id,
        providers: flow.providers,
        expiresAt: flow.expiresAt,
        invalidCode: true,
      };
    }
    if (outcome.kind === "mfa-required") {
      if (!outcome.supportedProviders.length)
        return { ok: true, kind: "interaction-required", reason: "unsupported-challenge" };
      flow.providers = outcome.supportedProviders;
      return {
        ok: true,
        kind: "mfa-required",
        flowId: flow.id,
        providers: outcome.supportedProviders,
        expiresAt: flow.expiresAt,
      };
    }
    if (outcome.kind === "new-device-verification-required") {
      flow.newDevice = true;
      return {
        ok: true,
        kind: outcome.kind,
        flowId: flow.id,
        invalidOtp: outcome.invalidOtp,
        expiresAt: flow.expiresAt,
      };
    }
    if (outcome.kind === "interaction-required")
      return { ok: true, kind: outcome.kind, reason: outcome.reason };
    if (outcome.kind !== "authenticated") return error("authentication-rejected");
    // Without `auto`, only setup replies come back.
    return acceptSync(
      flow,
      outcome,
      { kind: "password", password: flow.password },
      { kind: "password", receivedAt },
    ) as Promise<SetupReply>;
  }
  return { acceptSync, authorize };
}
