import * as v from "valibot";
import type { CryptoHost } from "../crypto/host";
import { preparedVault } from "../../../../packages/bitwarden/src/__fixtures__/unlock";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { uriCiphertexts, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { createIndexedDbVaultStore } from "./storage";
import { createLocalVaultManager, type VaultCheckpoint, type LocalVaultHandle } from "./manager";
import { MAX_VAULT_RECORD_BYTES, vaultFailure, type VaultEntry } from "./record";

const requestSchema = v.variant("action", [
  v.strictObject({
    type: v.literal("vault.probe"),
    action: v.literal("accept"),
    kind: v.picklist([
      "v1",
      "v2",
      "organization",
      "corrupt-last",
      "unavailable",
      "uri",
      "uri-without-context",
    ]),
    autoUnlock: v.optional(v.picklist(["enable", "preserve"]), "enable"),
  }),
  v.strictObject({
    type: v.literal("vault.probe"),
    action: v.picklist([
      "restore",
      "disable",
      "resolve",
      "status",
      "inspect",
      "release",
      "abort",
      "cas-conflict",
      "export-gate",
      "oversize",
      "corrupt-key",
    ]),
  }),
  v.strictObject({
    type: v.literal("vault.probe"),
    action: v.literal("match"),
    url: v.pipe(v.string(), v.maxLength(8192)),
  }),
  v.strictObject({
    type: v.literal("vault.probe"),
    action: v.literal("arm"),
    checkpoint: v.picklist(["before-write", "after-write"]),
  }),
]);
/** Fixed public fixtures only; the background authorizes the exact synthetic probe page. */
export function createVaultProbe(host: CryptoHost) {
  const store = createIndexedDbVaultStore({ profile: accountProfile });
  let armed: VaultCheckpoint | undefined;
  let reached = false;
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unpause = () => {
    clearTimeout(timer);
    timer = undefined;
    release?.();
    release = undefined;
    armed = undefined;
    reached = false;
  };
  const manager = createLocalVaultManager({
    profile: accountProfile,
    host,
    store,
    checkpoint: async (stage) => {
      if (stage !== armed) return;
      reached = true;
      await new Promise<void>((resolve) => {
        release = resolve;
        timer = setTimeout(unpause, 30_000);
      });
    },
  });
  let handle: LocalVaultHandle | undefined;
  let aborter: AbortController | undefined;
  async function resolves() {
    if (!handle) return vaultFailure("stale-vault-handle");
    const read = await store.read();
    if (!read.ok) return read;
    const cipher = read.data?.accepted?.prepared.ciphers[0];
    if (!cipher) return vaultFailure("field-missing");
    const itemId = cipher.id as unknown as string;
    const fieldId = cipher.type === 2 ? "notes" : "login.password";
    const expected =
      cipher.type === 2
        ? "Some notes"
        : cipher.organizationId
          ? "synthetic-org-password"
          : "test_password";
    const listed = await manager.listFields(handle, itemId);
    if (!listed.ok) return listed;
    const field = listed.data.find((value) => value.ref.fieldId === fieldId);
    if (!field) return vaultFailure("field-missing");
    const resolved = await manager.resolveField(handle, field.ref, {
      snapshotId: handle.snapshotId,
      allowedFieldIds: [fieldId],
    });
    if (!resolved.ok) return resolved;
    return {
      ok: true as const,
      data: { matches: resolved.data.kind === "text" && resolved.data.value === expected },
    };
  }
  return async (input: unknown) => {
    const request = v.safeParse(requestSchema, input);
    if (!request.success) return vaultFailure("invalid-request");
    const action = request.output;
    try {
      if (action.action === "status")
        return {
          ok: true,
          data: { ...manager.status(), checkpoint: armed ?? null, reached, host: host.status() },
        };
      if (action.action === "arm") {
        if (armed) return vaultFailure("resource-limit");
        armed = action.checkpoint;
        return { ok: true, data: { armed: true } };
      }
      if (action.action === "release") {
        unpause();
        return { ok: true, data: { released: true } };
      }
      if (action.action === "abort") {
        aborter?.abort();
        unpause();
        return { ok: true, data: { aborted: true } };
      }
      if (action.action === "accept") {
        const kind = action.kind === "v2" || action.kind === "organization" ? action.kind : "v1";
        const prepared = preparedVault(kind);
        if (action.kind === "corrupt-last") {
          const last = structuredClone(prepared.ciphers[0]!);
          const name = last.name;
          if (typeof name !== "string") return vaultFailure("invalid-request");
          const parts = name.split("|");
          const mac = parts[2];
          if (!mac) return vaultFailure("invalid-request");
          parts[2] = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
          last.id = crypto.randomUUID() as unknown as typeof last.id;
          last.name = parts.join("|") as unknown as typeof last.name;
          prepared.ciphers.push(last);
        }
        if (action.kind === "uri" || action.kind === "uri-without-context") {
          // Fixed SDK-encrypted synthetic URI; the second rule uses the retained default.
          const rule = { uri: uriCiphertexts.uri, uriChecksum: uriCiphertexts.checksum };
          const login = prepared.ciphers[0]!.login!;
          login.uris = [
            { ...rule, match: 3 },
            { ...rule, match: undefined },
          ] as unknown as typeof login.uris;
          if (action.kind === "uri-without-context") delete prepared.uriMatchContext;
        }
        if (action.kind === "unavailable") {
          prepared.unavailableItems.push({
            itemId: prepared.ciphers[0]!.id as unknown as string,
            reason: "unsupported-cipher-type",
          });
          prepared.ciphers = [];
        }
        const controller = new AbortController();
        aborter = controller;
        try {
          const result = await manager.accept(
            {
              prepared,
              unlock: { kind: "password", password: v1Password },
              autoUnlock: action.autoUnlock,
            },
            controller.signal,
          );
          if (result.ok) handle = result.data.handle;
          return result;
        } finally {
          if (aborter === controller) aborter = undefined;
        }
      }
      if (action.action === "restore") {
        const result = await manager.restore();
        if (result.ok) handle = result.data.handle;
        return result;
      }
      if (action.action === "disable") {
        handle = undefined;
        return manager.disableAutoUnlock();
      }
      if (action.action === "resolve") return resolves();
      if (action.action === "match")
        return handle ? manager.matchUris(handle, action.url) : vaultFailure("stale-vault-handle");
      if (action.action === "inspect") {
        const read = await store.read();
        if (!read.ok) return read;
        const value = read.data;
        const json = JSON.stringify(value);
        return {
          ok: true,
          data: {
            exists: value !== null,
            state: value?.state ?? "missing",
            revision: value?.revision ?? null,
            recordId: value?.accepted?.recordId ?? null,
            snapshotId: value?.accepted?.snapshotId ?? null,
            keyStored: value?.state === "active" && typeof value.userKey === "string",
            passwordAbsent: !json.includes(JSON.stringify(v1Password)),
            tokensAbsent:
              !/"(?:access_token|accessToken|refresh_token|refreshToken|masterPasswordHash)"/u.test(
                json,
              ),
            plaintextAbsent: !["test_password", "test_username", "Some notes"].some((text) =>
              json.includes(JSON.stringify(text)),
            ),
          },
        };
      }
      if (action.action === "export-gate") {
        const prepared = preparedVault();
        const opened = await host.open({
          connectionId: accountProfile.connectionId,
          prepared,
          snapshotId: crypto.randomUUID(),
          unlock: { kind: "password", password: v1Password },
        });
        if (!opened.ok) return opened;
        try {
          const result = await host.exportUnlockMaterial(opened.data.session);
          return { ok: true, data: { denied: !result.ok } };
        } finally {
          await host.lock(opened.data.session);
        }
      }
      const read = await store.read();
      if (!read.ok) return read;
      if (read.data?.state !== "active") return vaultFailure("cache-missing");
      const old = read.data;
      if (action.action === "oversize" || action.action === "corrupt-key") {
        const next: VaultEntry = {
          ...old,
          revision: crypto.randomUUID(),
          userKey:
            action.action === "oversize"
              ? "A".repeat(MAX_VAULT_RECORD_BYTES)
              : btoa(String.fromCharCode(...new Uint8Array(64))),
        };
        const write = await store.compareAndSwap(old.revision, next);
        const check = await store.read();
        return {
          ok: true,
          data: {
            rejected: !write.ok,
            quota: !write.ok && write.error.code === "cache-quota-exceeded",
            unchanged: check.ok && check.data?.revision === old.revision,
          },
        };
      }
      if (action.action === "cas-conflict") {
        const other = createIndexedDbVaultStore({ profile: accountProfile });
        try {
          const disabled: VaultEntry = {
            schemaVersion: 1,
            revision: crypto.randomUUID(),
            profile: accountProfile,
            state: "disabled",
            accepted: old.accepted,
          };
          const first = await other.compareAndSwap(old.revision, disabled);
          if (!first.ok) return first;
          const stale = await store.compareAndSwap(old.revision, {
            ...old,
            revision: crypto.randomUUID(),
          });
          const latest = await other.read();
          const blocked = await resolves();
          return {
            ok: true,
            data: {
              conflict: !stale.ok && stale.error.code === "storage-conflict",
              disabled: latest.ok && latest.data?.state === "disabled",
              blocked: !blocked.ok,
            },
          };
        } finally {
          other.close();
        }
      }
      return vaultFailure("invalid-request");
    } catch {
      return vaultFailure("crypto-failed");
    }
  };
}
