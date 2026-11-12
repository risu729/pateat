import * as v from "valibot";
import { normalizeBitwardenProfile } from "@pateat/bitwarden";
import type { LocalVaultHandle } from "../vault/manager";
import type { VaultApplyHold, VaultSyncResult } from "./auto-sync";
import { setupBeginSchema, setupContinuationSchema } from "./wire";
import { error, replyOf } from "./setup-reply";
import { createSetupSync, type Flow } from "./setup-sync";
import { createSetupStatus } from "./setup-status";
import type {
  BitwardenConnectionConfiguration,
  ConnectionSetupDependencies,
  SetupReply,
} from "./types";
import { newId } from "@pateat/contracts/ids";

/** Carry codes, HTTP status and a decryption failure's detail only, never provider values or
 * error messages. */
function syncFailure(failure: {
  code: string;
  status?: number;
  check?: string;
  item?: string;
  revised?: number;
}): VaultSyncResult {
  return {
    outcome: "failed",
    cause: failure.code,
    ...(failure.code === "http-error" && failure.status !== undefined
      ? { status: failure.status }
      : {}),
    ...(failure.code === "crypto-failed" && failure.check
      ? {
          check: failure.check,
          ...(failure.item === undefined ? {} : { item: failure.item }),
          ...(failure.revised === undefined ? {} : { revised: failure.revised }),
        }
      : {}),
  };
}

/** Only the exact trusted options Port gets a caller. Secrets never enter a metadata query cache. */
export function createConnectionSetupService(deps: ConnectionSetupDependencies) {
  const now = deps.nowMs ?? Date.now;
  const random = deps.randomId ?? newId;
  const active = new Map<string, Flow>();
  const disabling = new Set<string>();
  const connectionEpoch = new Map<string, number>();
  const handles = new Map<string, LocalVaultHandle>();
  /** Automatic checks are kept out of `active`, so they never make setup report busy. */
  const autoFlows = new Map<string, Flow>();
  const autoRuns = new Map<string, Promise<unknown>>();
  /** Connections with a manual sync or password sign-in waiting or running. */
  const manualWork = new Map<string, number>();
  function stopAuto(connectionId: string) {
    const flow = autoFlows.get(connectionId);
    if (flow) {
      clearTimeout(flow.timer);
      flow.controller.abort();
    }
  }
  /**
   * Keeps automatic checks of a connection out while manual work runs. It returns once the
   * check in progress, stopped first when asked, has finished, so the two never hold the
   * session or replace the vault at the same time.
   */
  async function excludeAuto(connectionId: string, stop: boolean): Promise<() => void> {
    manualWork.set(connectionId, (manualWork.get(connectionId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (manualWork.get(connectionId) ?? 1) - 1;
      if (left > 0) manualWork.set(connectionId, left);
      else manualWork.delete(connectionId);
    };
    if (stop) stopAuto(connectionId);
    await autoRuns.get(connectionId);
    return release;
  }
  const reviews = new Map<string, string[]>();
  const alive = (flow: Flow) => !flow.controller.signal.aborted && now() < flow.expiresAt;
  /** Why a flow stopped during a provider call: its 5 minutes ran out, or it was stopped. */
  const stopped = (flow: Flow) => error(now() >= flow.expiresAt ? "setup-expired" : "cancelled");
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
  const { acceptSync, authorize } = createSetupSync(deps, {
    now,
    alive,
    stopped,
    permitted,
    clear,
    handles,
    reviews,
  });
  const status = createSetupStatus(deps, now, reviews);
  /**
   * One automatic check (ADR 0025): revision date first, a full sync only when it moved,
   * and no replacement while a login or passkey request runs. It never asks for input and
   * never makes setup or the Sync button report busy.
   */
  function autoSync(connectionId: string, hold: VaultApplyHold): Promise<VaultSyncResult> {
    if (
      disabling.has(connectionId) ||
      active.has(connectionId) ||
      manualWork.has(connectionId) ||
      autoRuns.has(connectionId)
    )
      return Promise.resolve("skipped");
    // Registered before the first await, so manual work that starts now waits for it, and
    // removed before the outcome is answered, so the next check is not skipped.
    let settled!: Promise<void>;
    const work = autoCheck(connectionId, hold)
      .catch((): VaultSyncResult => ({ outcome: "failed", cause: "exception" }))
      .finally(() => {
        if (autoRuns.get(connectionId) === settled) autoRuns.delete(connectionId);
      });
    settled = work.then(
      () => undefined,
      () => undefined,
    );
    autoRuns.set(connectionId, settled);
    return work;
  }
  async function autoCheck(connectionId: string, hold: VaultApplyHold): Promise<VaultSyncResult> {
    const capturedEpoch = connectionEpoch.get(connectionId) ?? 0;
    const configuration = await deps.registry.get(connectionId);
    if (!configuration) return "skipped";
    const vault = deps.vaultFor(configuration.profile);
    const prior = await vault.store.read();
    if (!prior.ok || !prior.data) return "skipped";
    const entry = prior.data;
    // A locked vault has no key to open the next snapshot with; it syncs once unlocked.
    const userKey = await vault.manager.keyFor(entry);
    if (!userKey) return "skipped";
    const session = await deps.sessions.status(configuration.profile);
    if (session === "reauthentication-required") return "reauthentication-required";
    if (session !== "active" && session !== "refresh-required") return "skipped";
    if (
      (connectionEpoch.get(connectionId) ?? 0) !== capturedEpoch ||
      disabling.has(connectionId) ||
      active.has(connectionId) ||
      manualWork.has(connectionId)
    )
      return "skipped";
    const current: Flow = {
      id: random(),
      configuration,
      password: "",
      intent: "preserve",
      sync: true,
      controller: new AbortController(),
      expiresAt: now() + 300000,
      timer: setTimeout(() => current.controller.abort(), 300000),
      manual: {},
    };
    autoFlows.set(connectionId, current);
    return (async (): Promise<VaultSyncResult> => {
      if (!(await permitted(current))) return "skipped";
      const transport = deps.transportFor(configuration.profile);
      if (!transport.ok) return syncFailure(transport.error);
      const authorization = await deps.sessions.acquire(configuration.profile, {
        cacheRevision: entry.revision,
        transport: transport.data,
        permitted: () => permitted(current),
        signal: current.controller.signal,
      });
      if (!authorization.ok) {
        const failure = authorization.error as { code: string; status?: number };
        if (failure.code === "setup-reauthentication-required") return "reauthentication-required";
        // Another refresh of this connection is running in this worker.
        if (failure.code === "cancelled") return "skipped";
        return failure.code === "http-error" && failure.status === 429
          ? "rate-limited"
          : syncFailure(failure);
      }
      if (!alive(current) || (connectionEpoch.get(connectionId) ?? 0) !== capturedEpoch)
        return "skipped";
      const reply = await acceptSync(
        current,
        authorization.data.authenticated,
        { kind: "decrypted-key", userKey },
        { kind: "session", revision: authorization.data.revision },
        { stored: await deps.revisions?.revision(connectionId), hold },
      );
      if (reply.ok)
        return reply.kind === "unchanged" || reply.kind === "deferred" ? reply.kind : "synced";
      const failure = reply.error as Parameters<typeof syncFailure>[0];
      if (failure.code === "account-deleted") return "account-deleted";
      // Stopped by a sign-in, forget, removal or permission loss.
      if (failure.code === "cancelled") return "skipped";
      if (failure.code === "setup-reauthentication-required") return "reauthentication-required";
      return failure.code === "http-error" && failure.status === 429
        ? "rate-limited"
        : syncFailure(failure);
    })()
      .catch((): VaultSyncResult => ({ outcome: "failed", cause: "exception" }))
      .finally(() => {
        clearTimeout(current.timer);
        current.password = "";
        if (autoFlows.get(connectionId) === current) autoFlows.delete(connectionId);
      });
  }
  return {
    status,
    autoSync,
    /** Fence in-flight work now, then forget sessions only for providers that lost access.
     * Never rejects: a failed check or forget leaves that session for status to report. */
    async permissionsRemoved() {
      for (const flow of active.values()) clear(flow);
      for (const connectionId of autoFlows.keys()) stopAuto(connectionId);
      let configurations: BitwardenConnectionConfiguration[];
      try {
        configurations = await deps.registry.list();
      } catch {
        return;
      }
      for (const configuration of configurations) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (!(await deps.permissions.contains(configuration.profile))) {
            // eslint-disable-next-line no-await-in-loop
            await deps.sessions.forget(configuration.profile);
            // eslint-disable-next-line no-await-in-loop
            await deps.revisions?.clear(configuration.profile.connectionId);
          }
        } catch {
          // Continue with the remaining connections.
        }
      }
    },
    createCaller() {
      let closed = false;
      let busy = false;
      let owned: Flow | undefined;
      /** The flow the running job started or continued. Only that flow ends with the job,
       * so a refused request leaves a sign-in that waits for its code usable. */
      let taken: Flow | undefined;
      const end = () => {
        if (!taken) return;
        clear(taken);
        if (owned === taken) owned = undefined;
      };
      /** Whether this page's challenge still waits. One that permission removal or another
       * page already ended no longer holds the page. */
      const waiting = () => {
        if (owned && !alive(owned)) {
          clear(owned);
          owned = undefined;
        }
        return owned !== undefined;
      };
      const run = async (job: () => Promise<SetupReply>): Promise<SetupReply> => {
        if (closed) return error("setup-unavailable");
        if (busy) return error("resource-limit");
        busy = true;
        taken = undefined;
        try {
          const result = await job();
          if (
            !(
              result.ok &&
              (result.kind === "mfa-required" ||
                result.kind === "new-device-verification-required" ||
                result.kind === "email-code")
            )
          )
            end();
          return result;
        } catch {
          end();
          return error("setup-unavailable");
        } finally {
          taken = undefined;
          busy = false;
        }
      };
      function flow(
        configuration: BitwardenConnectionConfiguration,
        password: string,
        intent: "enable" | "preserve",
      ) {
        const current: Flow = {
          id: random(),
          configuration,
          password,
          intent,
          controller: new AbortController(),
          expiresAt: now() + 300000,
          timer: setTimeout(() => {
            clear(current);
            if (owned === current) owned = undefined;
          }, 300000),
          manual: {},
        };
        owned = current;
        taken = current;
        active.set(configuration.profile.connectionId, current);
        return current;
      }
      const caller = {
        begin(input: unknown): Promise<SetupReply> {
          let releaseAuto: (() => void) | undefined;
          return run(async () => {
            const checked = v.safeParse(setupBeginSchema, structuredClone(input));
            if (!checked.success) return error("invalid-request");
            if (waiting()) return error("resource-limit");
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
              // A password sign-in replaces whatever an automatic check would bring.
              releaseAuto = await excludeAuto(value.connectionId, true);
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
            // A password sign-in unlocks the vault, as in the official extension.
            const current = flow(configuration, value.password, "enable");
            if (!(await permitted(current)))
              return alive(current) ? error("provider-permission-required") : error("cancelled");
            if (value.kind === "new") {
              await deps.policy.register(configuration.profile.connectionId, value.enabled);
              await deps.registry.put(configuration);
            }
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
          }).finally(() => releaseAuto?.());
        },
        continue(input: unknown): Promise<SetupReply> {
          return run(async () => {
            const checked = v.safeParse(setupContinuationSchema, structuredClone(input));
            if (!checked.success) return error("invalid-request");
            const current = owned;
            if (!current || checked.output.flowId !== current.id) return error("invalid-request");
            taken = current;
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
        /** Asks the flow's own server to email a code, sending the hash the password grant
         * already sent. Any answer, a failed request included, leaves the sign-in waiting. */
        sendEmailCode(flowId: string): Promise<SetupReply> {
          return run(async () => {
            const current = owned;
            if (!current || current.id !== flowId) return error("invalid-request");
            // As in `continue`, a request this flow cannot take ends it.
            taken = current;
            if (!current.providers?.includes(1) || !current.hash) return error("invalid-request");
            if (!alive(current)) return error("setup-expired");
            if (!(await permitted(current)))
              return alive(current) ? error("provider-permission-required") : error("cancelled");
            const profile = current.configuration.profile;
            const transport = deps.transportFor(profile);
            if (!transport.ok) return transport;
            const sent = await transport.data.sendEmailLoginCode(
              {
                connectionId: profile.connectionId,
                email: current.configuration.email,
                masterPasswordHash: current.hash,
                deviceIdentifier: current.configuration.deviceIdentifier,
              },
              current.controller.signal,
            );
            if (!alive(current)) return stopped(current);
            return {
              ok: true,
              kind: "email-code",
              flowId: current.id,
              result: sent.ok ? sent.data.kind : "failed",
            };
          });
        },
        /**
         * The settings page's heartbeat while its challenge waits. The flow, password
         * included, lives only in this worker, which Chrome stops after 30 seconds without
         * an event; each message on the Port restarts that count. Answers whether the flow
         * still waits, without taking this page's one running request.
         */
        async keepAlive(flowId: string): Promise<SetupReply> {
          if (closed) return error("setup-unavailable");
          if (!waiting() || owned?.id !== flowId) return error("setup-expired");
          return { ok: true, kind: "waiting", flowId };
        },
        async cancel(flowId: string): Promise<SetupReply> {
          const current = owned;
          if (!current || current.id !== flowId) return error("invalid-request");
          clear(current);
          await current.retirement;
          if (owned === current) owned = undefined;
          return busy ? error("storage-uncertain") : { ok: true, kind: "cancelled" };
        },
        status,
        sync(connectionId: string): Promise<SetupReply> {
          let releaseAuto: (() => void) | undefined;
          return run(async () => {
            // A sign-in waiting for its code keeps this page's one flow.
            if (waiting()) return error("resource-limit");
            // An automatic check in progress finishes first; the button then always sends
            // a full sync.
            releaseAuto = await excludeAuto(connectionId, false);
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
            const userKey = await vault.manager.keyFor(prior.data);
            if (!prior.data || !userKey)
              return error(
                prior.data?.state === "locked" ? "vault-locked" : "auto-unlock-disabled",
              );
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
              { kind: "decrypted-key", userKey },
              { kind: "session", revision: authorization.data.revision },
            ) as Promise<SetupReply>;
          }).finally(() => releaseAuto?.());
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
          stopAuto(connectionId);
          await deps.revisions?.clear(connectionId).catch(() => undefined);
          const forgotten = await deps.sessions.forget(configuration.profile);
          return forgotten.ok ? { ok: true, kind: "forgotten", connectionId } : forgotten;
        },
        /** Local deletion only. No verified server-wide revocation endpoint is called, and
         * service-held settings are not modified. Like forget, it refuses while a password
         * setup flow for this connection is active. The registry entry goes last, so a
         * failed step leaves the connection listed for another attempt. */
        async remove(connectionId: string): Promise<SetupReply> {
          const setupActive = () => {
            const current = active.get(connectionId);
            return current !== undefined && !current.sync;
          };
          if (closed || disabling.has(connectionId) || setupActive())
            return error("resource-limit");
          disabling.add(connectionId);
          connectionEpoch.set(connectionId, (connectionEpoch.get(connectionId) ?? 0) + 1);
          try {
            const configuration = await deps.registry.get(connectionId);
            if (!configuration) return error("invalid-request");
            if (setupActive()) return error("resource-limit");
            const current = active.get(connectionId);
            if (current) {
              clear(current);
              if (owned === current) owned = undefined;
              await current.retirement;
            }
            handles.delete(connectionId);
            reviews.delete(connectionId);
            stopAuto(connectionId);
            await deps.revisions?.clear(connectionId).catch(() => undefined);
            const forgotten = await deps.sessions.forget(configuration.profile);
            if (!forgotten.ok) return forgotten;
            // The manager locks any open native session before deleting the record and key.
            const removed = await deps.vaultFor(configuration.profile).manager.remove();
            if (!removed.ok) return removed;
            try {
              await deps.registry.remove(connectionId);
            } catch {
              return error("storage-failed");
            }
            // Best effort: a choice left behind only waits for a connection that is gone.
            await deps.policy.forget?.(connectionId).catch(() => undefined);
            return { ok: true, kind: "deleted", connectionId };
          } finally {
            // A begin or sync that read the registry while this ran saw the stale entry;
            // a second bump makes its epoch check fail after disabling is cleared.
            connectionEpoch.set(connectionId, (connectionEpoch.get(connectionId) ?? 0) + 1);
            disabling.delete(connectionId);
          }
        },
        /** Unlocks a locked vault offline with its master password (ADR 0075). */
        unlock(input: { connectionId: string; password: string }): Promise<SetupReply> {
          let releaseAuto: (() => void) | undefined;
          return run(async () => {
            if (waiting()) return error("resource-limit");
            const { connectionId, password } = input;
            const capturedEpoch = connectionEpoch.get(connectionId) ?? 0;
            releaseAuto = await excludeAuto(connectionId, false);
            const configuration = await deps.registry.get(connectionId);
            if (!configuration) return error("invalid-request");
            if ((connectionEpoch.get(connectionId) ?? 0) !== capturedEpoch)
              return error("cancelled");
            if (closed || disabling.has(connectionId) || active.has(connectionId))
              return error("resource-limit");
            const unlocked = await deps.vaultFor(configuration.profile).manager.unlock(password);
            if (!unlocked.ok) return unlocked;
            handles.set(connectionId, unlocked.data.handle);
            return { ok: true, kind: "unlocked", connectionId };
          }).finally(() => releaseAuto?.());
        },
        /** Locks the vault and keeps its sync sign-in, as the official extension's Lock. */
        async lock(connectionId: string): Promise<SetupReply> {
          if (closed || disabling.has(connectionId)) return error("resource-limit");
          disabling.add(connectionId);
          connectionEpoch.set(connectionId, (connectionEpoch.get(connectionId) ?? 0) + 1);
          try {
            const configuration = await deps.registry.get(connectionId);
            if (!configuration) return error("invalid-request");
            const current = active.get(connectionId);
            if (current) {
              clear(current);
              if (owned === current) owned = undefined;
              await current.retirement;
            }
            stopAuto(connectionId);
            const locked = await deps.vaultFor(configuration.profile).manager.lockVault();
            handles.delete(connectionId);
            return locked.ok ? { ok: true, kind: "locked", connectionId } : locked;
          } finally {
            // Work admitted during the lock must not resume after its guard is released.
            connectionEpoch.set(connectionId, (connectionEpoch.get(connectionId) ?? 0) + 1);
            disabling.delete(connectionId);
          }
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
            stopAuto(connectionId);
            await deps.revisions?.clear(connectionId).catch(() => undefined);
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
      return {
        begin: (input: unknown) => caller.begin(input).then(replyOf),
        continue: (input: unknown) => caller.continue(input).then(replyOf),
        cancel: (flowId: string) => caller.cancel(flowId).then(replyOf),
        sendEmailCode: (flowId: string) => caller.sendEmailCode(flowId).then(replyOf),
        keepAlive: (flowId: string) => caller.keepAlive(flowId).then(replyOf),
        status: () => caller.status().then(replyOf),
        sync: (connectionId: string) => caller.sync(connectionId).then(replyOf),
        forget: (connectionId: string) => caller.forget(connectionId).then(replyOf),
        disable: (connectionId: string) => caller.disable(connectionId).then(replyOf),
        unlock: (input: { connectionId: string; password: string }) =>
          caller.unlock(input).then(replyOf),
        lock: (connectionId: string) => caller.lock(connectionId).then(replyOf),
        remove: (connectionId: string) => caller.remove(connectionId).then(replyOf),
        review: (input: Parameters<typeof caller.review>[0]) => caller.review(input).then(replyOf),
        dispose: caller.dispose,
      };
    },
  };
}
export type ConnectionSetupService = ReturnType<typeof createConnectionSetupService>;
