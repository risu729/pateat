import {
  connectionUse,
  getItemEligibility,
  type SettingsResponse,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import type { ConnectionRuntime } from "../connections/runtime";
import type { SsoMethod, SsoMethodRef, SsoMethods } from "../crypto/sso-wire";

type AccountRef = { connectionId: string; itemId: string };
type Snapshot = Extract<SettingsResponse, { ok: true }>;
/** Public metadata intentionally excludes the transient proof and URL-form field value. */
export type SafeSsoMethod = Omit<SsoMethod, "usernameProof" | "origin" | "fieldId">;
export type SsoSourceRef = {
  account: AccountRef;
  method: SsoMethodRef;
  sourceEvidence: string;
};
export type SsoIdpChoice = { account: AccountRef; origin: string };
export type SsoCandidate = { account: AccountRef; snapshotId: string; origins: string[] };
export type SsoDiscovery<T> = { ok: true; data: T } | { ok: false; reason: string; field?: string };
const refused = (reason: string, field?: string): SsoDiscovery<never> => ({
  ok: false,
  reason,
  ...(field ? { field } : {}),
});
type Connections = Pick<ConnectionRuntime, "registry" | "vaultFor" | "current" | "snapshotCurrent">;

/** Local discovery only. It checks the vault timeout without recording credential use. */
export function createVaultSsoSource(
  connections: Connections,
  readSettings: () => Promise<SettingsResponse>,
) {
  async function snapshot(): Promise<Snapshot | undefined> {
    const value = await readSettings().catch(() => undefined);
    return value?.ok && !value.catalog.settingsSyncPending ? value : undefined;
  }
  async function managerFor(connection: VaultConnectionMetadata) {
    if (connection.provider !== "bitwarden" || !connection.snapshotId) return;
    // current(false) checks timeouts and durable state, but never unlocks or calls used().
    const current = await connections.current(connection.id, false).catch(() => undefined);
    if (!current || current.catalog.snapshotId !== connection.snapshotId) return;
    const config = await connections.registry.get(connection.id);
    if (!config) return;
    const manager = connections.vaultFor(config.profile).manager;
    const handle = manager.status().handle;
    if (
      !handle ||
      handle.snapshotId !== connection.snapshotId ||
      handle.userId !== connection.userId
    )
      return;
    return { manager, handle };
  }
  function eligible(saved: Snapshot, account: AccountRef) {
    const connection = saved.catalog.connections.find((entry) => entry.id === account.connectionId);
    const found = getItemEligibility(
      saved.snapshot.settings,
      saved.catalog,
      account.connectionId,
      account.itemId,
    );
    if (!found.eligible) return { ok: false as const, reason: found.reason };
    if (
      !connection ||
      connection.quarantinedItemIds?.includes(account.itemId) ||
      !connection.snapshotId ||
      (connection.state !== undefined && !["ready", "review-required"].includes(connection.state))
    )
      return { ok: false as const, reason: "vault-unavailable" };
    return { ok: true as const, connection, fieldIds: found.fieldIds };
  }
  async function unchanged(saved: Snapshot, touched: VaultConnectionMetadata[]) {
    for (const connection of touched) {
      // oxlint-disable-next-line no-await-in-loop -- check expiry without resetting the timeout
      if (!(await managerFor(connection))) return false;
    }
    // This is the final awaited read. Eligibility cannot change unnoticed during the
    // timeout/durable checks above; the remaining snapshot fences are synchronous.
    const latest = await snapshot();
    return (
      latest !== undefined &&
      latest.snapshot.revision === saved.snapshot.revision &&
      touched.every(
        (connection) =>
          connection.snapshotId !== undefined &&
          connections.snapshotCurrent(connection.id, connection.snapshotId) &&
          JSON.stringify(latest.catalog.connections.find((entry) => entry.id === connection.id)) ===
            JSON.stringify(connection),
      )
    );
  }
  async function methods(saved: Snapshot, account: AccountRef): Promise<SsoDiscovery<SsoMethods>> {
    const use = eligible(saved, account);
    if (!use.ok) return refused(use.reason);
    const vault = await managerFor(use.connection);
    if (!vault) return refused("vault-unavailable");
    const result = await vault.manager.ssoMethods(vault.handle, {
      itemId: account.itemId,
      allowedFieldIds: use.fieldIds,
    });
    if (!result.ok) return refused(result.error.code);
    if (result.data.result.status === "refused")
      return refused(result.data.result.reason, result.data.result.field);
    if (!(await unchanged(saved, [use.connection]))) return refused("scope-changed");
    return { ok: true, data: result.data };
  }
  async function resolve(
    source: SsoSourceRef,
    selected?: SsoIdpChoice,
  ): Promise<
    SsoDiscovery<{
      sourceEvidence: string;
      policyRevision: number;
      candidates: SsoCandidate[];
    }>
  > {
    const saved = await snapshot();
    if (!saved) return refused("settings-unavailable");
    const described = await methods(saved, source.account);
    if (!described.ok) return described;
    if (described.data.sourceEvidence !== source.sourceEvidence) return refused("source-changed");
    const result = described.data.result;
    if (result.status !== "ready") return refused(result.reason, result.field);
    const method = result.methods.find((entry) => entry.method.number === source.method.number);
    if (!method) return refused("method-unavailable");
    const candidates: SsoCandidate[] = [];
    const touched: VaultConnectionMetadata[] = [];
    const sourceConnection = saved.catalog.connections.find(
      (entry) => entry.id === source.account.connectionId,
    );
    if (sourceConnection) touched.push(sourceConnection);
    for (const connection of saved.catalog.connections) {
      if (selected && selected.account.connectionId !== connection.id) continue;
      const use = connectionUse(saved.snapshot.settings, saved.catalog, connection.id);
      if (use === "disabled") continue;
      if (use !== "enabled") return refused(use);
      const inputs = [];
      for (const item of connection.items) {
        if (selected && selected.account.itemId !== item.id) continue;
        const candidate = eligible(saved, { connectionId: connection.id, itemId: item.id });
        if (!candidate.ok) {
          if (
            selected ||
            candidate.reason === "vault-unavailable" ||
            candidate.reason === "review-required"
          )
            return refused(candidate.reason);
          continue;
        }
        if (candidate.fieldIds.includes("login.username"))
          inputs.push({ itemId: item.id, allowedFieldIds: candidate.fieldIds });
      }
      if (!inputs.length) continue;
      // oxlint-disable-next-line no-await-in-loop -- each vault has a bounded native lane
      const vault = await managerFor(connection);
      if (!vault) return refused("vault-unavailable");
      // oxlint-disable-next-line no-await-in-loop -- never run a second job on the same vault
      const matched = await vault.manager.ssoCandidates(vault.handle, {
        usernameProof: method.usernameProof,
        candidates: inputs,
      });
      if (!matched.ok) return refused(matched.error.code);
      touched.push(connection);
      for (const candidate of matched.data.candidates) {
        if (candidate.unavailable) return refused(candidate.unavailable);
        const origins = candidate.origins.filter(
          (origin) =>
            (method.origin === undefined || origin === method.origin) &&
            (selected === undefined || origin === selected.origin),
        );
        if (origins.length)
          candidates.push({
            account: { connectionId: connection.id, itemId: candidate.itemId },
            snapshotId: matched.data.snapshotId,
            origins,
          });
      }
    }
    if (!(await unchanged(saved, touched))) return refused("scope-changed");
    if (selected && (candidates.length !== 1 || candidates[0]?.origins.length !== 1))
      return refused("mapping-unresolved");
    return {
      ok: true,
      data: {
        sourceEvidence: described.data.sourceEvidence,
        policyRevision: saved.snapshot.revision,
        candidates,
      },
    };
  }
  return {
    async describe(
      account: AccountRef,
    ): Promise<
      SsoDiscovery<{ sourceEvidence: string; policyRevision: number; methods: SafeSsoMethod[] }>
    > {
      const saved = await snapshot();
      if (!saved) return refused("settings-unavailable");
      const described = await methods(saved, account);
      if (!described.ok) return described;
      if (described.data.result.status !== "ready")
        return refused(described.data.result.reason, described.data.result.field);
      return {
        ok: true,
        data: {
          sourceEvidence: described.data.sourceEvidence,
          policyRevision: saved.snapshot.revision,
          methods: described.data.result.methods.map(
            ({ usernameProof: _proof, origin: _origin, fieldId: _fieldId, ...method }) => method,
          ),
        },
      };
    },
    candidates: (source: SsoSourceRef) => resolve(source),
    validate: (source: SsoSourceRef, selected: SsoIdpChoice) => resolve(source, selected),
  };
}
export type VaultSsoSource = ReturnType<typeof createVaultSsoSource>;
