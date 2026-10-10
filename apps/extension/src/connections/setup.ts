import * as v from "valibot";
import {
  createBitwardenAccountMapper,
  normalizeBitwardenProfile,
  type PasswordTokenOutcome,
  type BitwardenProfile,
} from "@pateat/bitwarden";
import type { LocalVaultHandle } from "../vault/manager";
import type { VaultEntry } from "../vault/record";
import { setupBeginSchema, setupContinuationSchema } from "./wire";
import type {
  BitwardenConnectionConfiguration,
  ConnectionSetupDependencies,
  SetupReply,
} from "./types";

const error = (code: Extract<SetupReply, { ok: false }>["error"]["code"]): SetupReply => ({
  ok: false,
  error: { code },
});
type Authenticated = Extract<PasswordTokenOutcome, { kind: "authenticated" }>;
type Flow = {
  id: string;
  configuration: BitwardenConnectionConfiguration;
  password: string;
  hash?: string;
  enabled?: boolean;
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

/** Only the exact trusted options Port gets a caller. Secrets never enter a metadata query cache. */
export function createConnectionSetupService(deps: ConnectionSetupDependencies) {
  const now = deps.nowMs ?? Date.now;
  const random = deps.randomId ?? (() => crypto.randomUUID());
  const active = new Map<string, Flow>();
  const disabling = new Set<string>();
  const connectionEpoch = new Map<string, number>();
  const handles = new Map<string, LocalVaultHandle>();
  const reviews = new Map<string, string[]>();
  const alive = (flow: Flow) => !flow.controller.signal.aborted && now() < flow.expiresAt;
  function clear(flow: Flow) {
    clearTimeout(flow.timer);
    flow.controller.abort();
    flow.password = "";
    delete flow.hash;
    flow.manual = {};
    if (!flow.published && flow.retire && !flow.retirement)
      flow.retirement = flow.retire().catch(() => undefined);
    if (active.get(flow.configuration.profile.connectionId) === flow)
      active.delete(flow.configuration.profile.connectionId);
  }
  async function permitted(flow: Flow) {
    if (!alive(flow)) return false;
    const allowed = await deps.permissions.contains(flow.configuration.profile);
    return allowed && alive(flow);
  }
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
  ): Promise<SetupReply> {
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
    const accepted = await vault.manager.accept(
      { prepared: mapped.data, unlock, autoUnlock: flow.intent },
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
      current.data?.state !== "active" ||
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
      groups: metadata.data.groups,
      items: metadata.data.items.map((item) => ({
        id: item.id,
        label: item.label,
        allowedOrigins: [],
        groupIds: item.groupIds,
        fields: item.fields.map(({ id, label }) => ({ id, label })),
      })),
    };
    const adopted = await deps.policy.adopt({
      previous: prior.data,
      next: current.data,
      catalog,
      ...(flow.enabled === undefined ? {} : { enabled: flow.enabled }),
    });
    if (!alive(flow)) {
      clear(flow);
      await flow.retirement;
      return error("storage-uncertain");
    }
    handles.set(profile.connectionId, accepted.data.handle);
    reviews.set(profile.connectionId, adopted.policyReviewItemIds);
    flow.published = true;
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
    if (!token.ok) return token;
    if (!alive(flow)) return error("cancelled");
    const outcome = token.data;
    if (outcome.kind === "mfa-required") {
      if (!outcome.supportedProviders.length)
        return { ok: true, kind: "interaction-required", reason: "unsupported-challenge" };
      flow.providers = outcome.supportedProviders;
      return {
        ok: true,
        kind: "mfa-required",
        flowId: flow.id,
        providers: outcome.supportedProviders,
      };
    }
    if (outcome.kind === "new-device-verification-required") {
      flow.newDevice = true;
      return { ok: true, kind: outcome.kind, flowId: flow.id, invalidOtp: outcome.invalidOtp };
    }
    if (outcome.kind === "interaction-required")
      return { ok: true, kind: outcome.kind, reason: outcome.reason };
    if (outcome.kind !== "authenticated") return error("authentication-rejected");
    return acceptSync(
      flow,
      outcome,
      { kind: "password", password: flow.password },
      { kind: "password", receivedAt },
    );
  }
  async function status(): Promise<SetupReply> {
    const configurations = await deps.registry.list();
    const connections: Extract<SetupReply, { kind: "status" }>["connections"] = [];
    for (const configuration of configurations) {
      const vault = deps.vaultFor(configuration.profile);
      // Bounded sequential native-store reads; no provider HTTP is performed by status.
      // eslint-disable-next-line no-await-in-loop
      const record = await vault.store.read();
      const known = record.ok ? record.data : null;
      const quarantine =
        known?.accepted && deps.policy.quarantined
          ? // eslint-disable-next-line no-await-in-loop
            await deps.policy.quarantined(
              configuration.profile.connectionId,
              known.accepted.snapshotId,
            )
          : (reviews.get(configuration.profile.connectionId) ?? []);
      // eslint-disable-next-line no-await-in-loop
      const providerSession = await deps.sessions.status(configuration.profile);
      const state = !record.ok
        ? "unavailable"
        : known?.state === "disabled"
          ? "disabled"
          : quarantine.length
            ? "review-required"
            : vault.manager.status().ready
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
            : known?.state === "disabled"
              ? "disabled"
              : "unknown",
        providerSession,
        ...(known?.accepted ? { snapshotId: known.accepted.snapshotId } : {}),
      });
    }
    return { ok: true, kind: "status", connections };
  }
  return {
    status,
    /** Fence in-flight work now, then forget sessions only for providers that lost access.
     * Never rejects: a failed check or forget leaves that session for status to report. */
    async permissionsRemoved() {
      for (const flow of active.values()) clear(flow);
      let configurations: BitwardenConnectionConfiguration[];
      try {
        configurations = await deps.registry.list();
      } catch {
        return;
      }
      for (const configuration of configurations) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (!(await deps.permissions.contains(configuration.profile)))
            // eslint-disable-next-line no-await-in-loop
            await deps.sessions.forget(configuration.profile);
        } catch {
          // Continue with the remaining connections.
        }
      }
    },
    createCaller() {
      let closed = false;
      let busy = false;
      let owned: Flow | undefined;
      const run = async (job: () => Promise<SetupReply>): Promise<SetupReply> => {
        if (closed) return error("setup-unavailable");
        if (busy) return error("resource-limit");
        busy = true;
        try {
          const result = await job();
          if (
            !(
              result.ok &&
              (result.kind === "mfa-required" || result.kind === "new-device-verification-required")
            )
          ) {
            if (owned) clear(owned);
            owned = undefined;
          }
          return result;
        } catch {
          if (owned) clear(owned);
          owned = undefined;
          return error("setup-unavailable");
        } finally {
          busy = false;
        }
      };
      function flow(
        configuration: BitwardenConnectionConfiguration,
        password: string,
        intent: "enable" | "preserve",
        enabled?: boolean,
      ) {
        const current: Flow = {
          id: random(),
          configuration,
          password,
          intent,
          ...(enabled === undefined ? {} : { enabled }),
          controller: new AbortController(),
          expiresAt: now() + 300000,
          timer: setTimeout(() => {
            clear(current);
            if (owned === current) owned = undefined;
          }, 300000),
          manual: {},
        };
        owned = current;
        active.set(configuration.profile.connectionId, current);
        return current;
      }
      return {
        begin(input: unknown): Promise<SetupReply> {
          return run(async () => {
            const checked = v.safeParse(setupBeginSchema, structuredClone(input));
            if (!checked.success) return error("invalid-request");
            if (owned) return error("resource-limit");
            const value = checked.output;
            let configuration: BitwardenConnectionConfiguration;
            const capturedEpoch =
              value.kind === "existing" ? (connectionEpoch.get(value.connectionId) ?? 0) : 0;
            if (value.kind === "new") {
              const profile = normalizeBitwardenProfile({
                connectionId: random(),
                environment: value.environment,
              });
              if (!profile.ok) return profile;
              configuration = {
                profile: profile.data,
                label: value.label,
                email: value.email.trim().toLowerCase(),
                deviceIdentifier: random(),
              };
            } else {
              const existing = await deps.registry.get(value.connectionId);
              if (!existing) return error("invalid-request");
              configuration = structuredClone(existing);
            }
            if (closed) return error("cancelled");
            if (
              value.kind === "existing" &&
              (connectionEpoch.get(value.connectionId) ?? 0) !== capturedEpoch
            )
              return error("cancelled");
            if (
              disabling.has(configuration.profile.connectionId) ||
              active.has(configuration.profile.connectionId) ||
              active.size >= 4
            )
              return error("resource-limit");
            const current = flow(
              configuration,
              value.password,
              value.kind === "new" ? "enable" : value.autoUnlock,
              value.kind === "new" ? value.enabled : undefined,
            );
            if (!(await permitted(current)))
              return alive(current) ? error("provider-permission-required") : error("cancelled");
            if (value.kind === "new") await deps.registry.put(configuration);
            if (!alive(current)) return error("cancelled");
            const transport = deps.transportFor(configuration.profile);
            if (!transport.ok) return transport;
            if (!(await permitted(current)))
              return alive(current) ? error("provider-permission-required") : error("cancelled");
            const prelogin = await transport.data.prelogin(
              {
                connectionId: configuration.profile.connectionId,
                email: configuration.email,
                mode: "password",
              },
              current.controller.signal,
            );
            if (!prelogin.ok) return prelogin;
            if (!alive(current)) return error("cancelled");
            const hash = await deps.host.deriveAuthentication(
              {
                connectionId: configuration.profile.connectionId,
                email: configuration.email,
                password: current.password,
                prelogin: { mode: "password", response: prelogin.data },
              },
              current.controller.signal,
            );
            if (!hash.ok) return hash;
            if (!alive(current)) return error("cancelled");
            current.hash = hash.data.masterPasswordHash;
            return authorize(current);
          });
        },
        continue(input: unknown): Promise<SetupReply> {
          return run(async () => {
            const checked = v.safeParse(setupContinuationSchema, structuredClone(input));
            if (!checked.success) return error("invalid-request");
            const current = owned;
            if (!current || checked.output.flowId !== current.id) return error("invalid-request");
            if (!alive(current)) return error("setup-expired");
            const manual = checked.output;
            if (manual.twoFactor && !current.providers?.includes(manual.twoFactor.provider))
              return error("invalid-request");
            if (manual.newDeviceOtp && !current.newDevice) return error("invalid-request");
            current.manual = {
              ...current.manual,
              ...(manual.twoFactor ? { twoFactor: manual.twoFactor } : {}),
              ...(manual.newDeviceOtp ? { newDeviceOtp: manual.newDeviceOtp } : {}),
            };
            return authorize(current);
          });
        },
        async cancel(flowId: string): Promise<SetupReply> {
          if (!owned || owned.id !== flowId) return error("invalid-request");
          clear(owned);
          await owned.retirement;
          owned = undefined;
          return busy ? error("storage-uncertain") : { ok: true, kind: "cancelled" };
        },
        status,
        sync(connectionId: string): Promise<SetupReply> {
          return run(async () => {
            const capturedEpoch = connectionEpoch.get(connectionId) ?? 0;
            const configuration = await deps.registry.get(connectionId);
            if (!configuration) return error("setup-reauthentication-required");
            if (closed || (connectionEpoch.get(connectionId) ?? 0) !== capturedEpoch)
              return error("cancelled");
            if (
              closed ||
              disabling.has(connectionId) ||
              active.has(connectionId) ||
              active.size >= 4
            )
              return error("resource-limit");
            const current = flow(configuration, "", "preserve");
            current.sync = true;
            if (!(await permitted(current))) return error("provider-permission-required");
            const vault = deps.vaultFor(configuration.profile);
            const prior = await vault.store.read();
            if (!prior.ok) return prior;
            if (prior.data?.state !== "active") return error("auto-unlock-disabled");
            const transport = deps.transportFor(configuration.profile);
            if (!transport.ok) return transport;
            const authorization = await deps.sessions.acquire(configuration.profile, {
              cacheRevision: prior.data.revision,
              transport: transport.data,
              permitted: () => permitted(current),
              signal: current.controller.signal,
            });
            if (!authorization.ok) return error(authorization.error.code);
            if (!alive(current)) return error("cancelled");
            return acceptSync(
              current,
              authorization.data.authenticated,
              { kind: "decrypted-key", userKey: prior.data.userKey },
              { kind: "session", revision: authorization.data.revision },
            );
          });
        },
        /** Local forget only. No verified server-wide revocation endpoint is called.
         * It touches only the session store: a password or setup flow is never cleared
         * (its compensation could disable a first enrollment), so it reports busy instead. */
        async forget(connectionId: string): Promise<SetupReply> {
          const setupActive = () => {
            const current = active.get(connectionId);
            return current !== undefined && !current.sync;
          };
          if (closed || disabling.has(connectionId) || setupActive())
            return error("resource-limit");
          connectionEpoch.set(connectionId, (connectionEpoch.get(connectionId) ?? 0) + 1);
          const configuration = await deps.registry.get(connectionId);
          if (!configuration) return error("invalid-request");
          if (setupActive()) return error("resource-limit");
          const current = active.get(connectionId);
          if (current) {
            clear(current);
            if (owned === current) owned = undefined;
            await current.retirement;
          }
          const forgotten = await deps.sessions.forget(configuration.profile);
          return forgotten.ok ? { ok: true, kind: "forgotten", connectionId } : forgotten;
        },
        async disable(connectionId: string): Promise<SetupReply> {
          if (closed || disabling.has(connectionId)) return error("resource-limit");
          disabling.add(connectionId);
          connectionEpoch.set(connectionId, (connectionEpoch.get(connectionId) ?? 0) + 1);
          try {
            const configuration = await deps.registry.get(connectionId);
            if (!configuration) return error("invalid-request");
            const current = active.get(connectionId);
            if (current) clear(current);
            if (owned === current) owned = undefined;
            const disabled = await deps.vaultFor(configuration.profile).manager.disableAutoUnlock();
            handles.delete(connectionId);
            // Sync needs the retained key, so its credentials go with it.
            const forgotten = await deps.sessions.forget(configuration.profile);
            if (!disabled.ok) return disabled;
            return forgotten.ok ? { ok: true, kind: "disabled", connectionId } : forgotten;
          } finally {
            disabling.delete(connectionId);
          }
        },
        async review(
          input: Parameters<NonNullable<ConnectionSetupDependencies["policy"]["review"]>>[0],
        ): Promise<SetupReply> {
          if (!deps.policy.review) return error("setup-unavailable");
          try {
            const captured = structuredClone(input);
            const reviewed = await deps.policy.review(captured);
            reviews.set(captured.connectionId, reviewed.policyReviewItemIds);
            return {
              ok: true,
              kind: "ready",
              connectionId: captured.connectionId,
              snapshotId: captured.snapshotId,
              policyReviewItemIds: reviewed.policyReviewItemIds,
            };
          } catch {
            return error("revision-conflict");
          }
        },
        dispose() {
          closed = true;
          if (owned) clear(owned);
          owned = undefined;
        },
      };
    },
  };
}
export type ConnectionSetupService = ReturnType<typeof createConnectionSetupService>;
