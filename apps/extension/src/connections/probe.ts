import * as v from "valibot";
import type { BitwardenTransportOptions } from "@pateat/bitwarden";
import {
  accountProfile,
  accountUserId,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { rawCustomAccount } from "../../../../packages/bitwarden/src/__fixtures__/connection";
import { v1Email } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import {
  createVaultDatabase,
  PROVIDER_SESSIONS_STORE,
  RECORDS_STORE,
  runVaultTransaction,
  type VaultStoreName,
} from "../vault/database";
import type { ConnectionRuntime } from "./runtime";
import type { ProviderSessionEntry } from "./session-record";
import { createIndexedDbProviderSessionStore } from "./session-store";

const schema = v.variant("action", [
  v.strictObject({
    type: v.literal("setup.probe"),
    action: v.literal("configure"),
    variant: v.picklist([
      "unchanged",
      "reordered",
      "changed",
      "removed",
      "builtin-changed",
      "passkey",
    ]),
    challenge: v.optional(v.picklist(["none", "mfa", "new-device", "rejected"]), "none"),
    permission: v.optional(v.boolean(), true),
    overflow: v.optional(v.literal("group-refs")),
  }),
  v.strictObject({
    type: v.literal("setup.probe"),
    action: v.picklist(["status", "inspect", "session-store"]),
  }),
  v.strictObject({
    type: v.literal("setup.probe"),
    action: v.literal("resolve"),
    field: v.picklist(["password", "custom-0", "custom-1", "linked"]),
  }),
]);
/** Native compare-and-swap of the session store in a separate synthetic database.
 * Returns only result codes and booleans, never a stored value. */
async function probeSessionStore() {
  const databaseName = `pateat.session-store-probe.${crypto.randomUUID()}`;
  const database = createVaultDatabase({ databaseName });
  const store = createIndexedDbProviderSessionStore({ profile: accountProfile, databaseName });
  const code = (result: { ok: boolean; error?: { code: string } }) =>
    result.ok ? "ok" : (result.error?.code ?? "unknown");
  const raw = async (name: VaultStoreName, value: unknown) =>
    runVaultTransaction(
      await database.open(),
      name,
      "readwrite",
      database.timeout,
      (stores, set) => {
        stores(name).put(value, accountProfile.connectionId);
        set({ ok: true, data: true });
      },
    );
  const entry = (): ProviderSessionEntry => ({
    schemaVersion: 1,
    revision: crypto.randomUUID(),
    profile: accountProfile,
    binding: { userId: accountUserId, email: v1Email },
    encryptedAccount: {},
    state: "active",
    accessToken: "a.b.c",
    refreshToken: "synthetic-refresh",
    receivedAt: 1,
    expiresIn: 60,
  });
  const cache = crypto.randomUUID();
  const guard = { cacheRevision: cache };
  const revisionOf = async () => {
    const read = await store.read();
    return read.ok ? (read.data?.revision ?? null) : code(read);
  };
  try {
    await raw(RECORDS_STORE, { state: "active", revision: cache });
    const first = entry();
    const second = entry();
    const results: Record<string, unknown> = {};
    results["retain"] = code(await store.compareAndSwap(null, first, guard));
    results["guardMismatch"] = code(
      await store.compareAndSwap(first.revision, second, { cacheRevision: crypto.randomUUID() }),
    );
    await raw(RECORDS_STORE, { state: "disabled", revision: cache });
    results["guardDisabled"] = code(await store.compareAndSwap(first.revision, second, guard));
    await raw(RECORDS_STORE, { state: "active", revision: cache });
    results["revisionConflict"] = code(
      await store.compareAndSwap(crypto.randomUUID(), second, guard),
    );
    results["unchanged"] = (await revisionOf()) === first.revision;
    results["swap"] = code(await store.compareAndSwap(first.revision, second, guard));
    results["readback"] = (await revisionOf()) === second.revision;
    await raw(PROVIDER_SESSIONS_STORE, { schemaVersion: 1, state: "active", accessToken: "x" });
    results["corruptRead"] = await revisionOf();
    results["corruptReplace"] = code(await store.compareAndSwap(second.revision, entry(), guard));
    results["corruptDeleteWithRevision"] = code(await store.compareAndSwap(second.revision, null));
    results["corruptKept"] = (await revisionOf()) === "invalid-cache-record";
    results["corruptDelete"] = code(await store.compareAndSwap(null, null));
    results["deleted"] = (await revisionOf()) === null;
    await raw(PROVIDER_SESSIONS_STORE, {
      ...entry(),
      profile: { ...accountProfile, connectionId: crypto.randomUUID() },
    });
    const replacement = entry();
    results["mismatchRead"] = await revisionOf();
    results["mismatchReplace"] = code(await store.compareAndSwap(null, replacement, guard));
    results["replaced"] = (await revisionOf()) === replacement.revision;
    return { ok: true, results };
  } finally {
    store.close();
    database.close();
    indexedDB.deleteDatabase(databaseName);
  }
}

/** Fixed public synthetic responses, compiled out of production. No actual provider request. */
export function createConnectionProbeTransport() {
  let variant: Parameters<typeof rawCustomAccount>[0] = "unchanged";
  let challenge: "none" | "mfa" | "new-device" | "rejected" = "none";
  let permission = true;
  let overflow = false;
  let calls = 0;
  let preloginCalls = 0;
  let tokenCalls = 0;
  let syncCalls = 0;
  const transportOptions: BitwardenTransportOptions = {
    async fetch(url, init) {
      calls += 1;
      const raw = rawCustomAccount(variant, Math.floor(Date.now() / 1000));
      if (overflow)
        (raw.sync.ciphers[0]! as unknown as { collectionIds: string[] }).collectionIds = Array.from(
          { length: 1001 },
          (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        );
      const json = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      if (
        url === "https://identity.bitwarden.com/accounts/prelogin/password" &&
        init.method === "POST"
      ) {
        preloginCalls += 1;
        return json({
          kdf: 0,
          kdfIterations: 100000,
          kdfMemory: null,
          kdfParallelism: null,
          kdfSettings: { kdfType: 0, iterations: 100000, memory: null, parallelism: null },
          salt: v1Email,
        });
      }
      if (url === "https://identity.bitwarden.com/connect/token" && init.method === "POST") {
        tokenCalls += 1;
        const form = new URLSearchParams(String(init.body));
        if (challenge === "rejected")
          return json(
            { error: "invalid_grant", error_description: "invalid_username_or_password" },
            400,
          );
        if (challenge === "mfa" && form.get("twoFactorToken") !== "123456")
          return json(
            {
              error: "invalid_grant",
              TwoFactorProviders: ["0"],
              TwoFactorProviders2: { "0": null },
            },
            400,
          );
        if (challenge === "new-device" && form.get("newDeviceOtp") !== "123456")
          return json(
            {
              error: "device_error",
              error_description: "New device verification required",
            },
            400,
          );
        return json(raw.token);
      }
      if (url === "https://api.bitwarden.com/sync" && init.method === "GET") {
        syncCalls += 1;
        return json(raw.sync);
      }
      return json({ error: "unsupported-synthetic-request" }, 400);
    },
  };
  return {
    transportOptions,
    containsPermission: async () => permission,
    handler(runtime: ConnectionRuntime) {
      return async (input: unknown) => {
        const checked = v.safeParse(schema, input);
        if (!checked.success) return { ok: false, error: { code: "invalid-request" } };
        const request = checked.output;
        if (request.action === "configure") {
          variant = request.variant;
          challenge = request.challenge;
          permission = request.permission;
          overflow = request.overflow === "group-refs";
          if (!permission) await runtime.service.permissionsRemoved();
          return { ok: true };
        }
        if (request.action === "session-store") return probeSessionStore();
        const configurations = await runtime.registry.list();
        const saved = await runtime.settings.handle({ version: 1, type: "settings.get" });
        if (request.action === "status" || request.action === "inspect")
          return {
            ok: true,
            permission,
            calls,
            preloginCalls,
            tokenCalls,
            syncCalls,
            configuredIds: configurations.map((entry) => entry.profile.connectionId),
            metadataOnly: !JSON.stringify(configurations).includes("asdfasdfasdf"),
            ...(saved.ok
              ? {
                  revision: saved.snapshot.revision,
                  catalogs: saved.catalog.connections
                    .filter((entry) => entry.provider === "bitwarden")
                    .map((entry) => ({
                      connectionId: entry.id,
                      snapshotId: entry.snapshotId,
                      itemCount: entry.items.length,
                      quarantineCount: entry.quarantinedItemIds?.length ?? 0,
                      state: entry.state,
                    })),
                }
              : {}),
          };
        if (!saved.ok) return { ok: false, error: { code: "storage-uncertain" } };
        if (request.action !== "resolve") return { ok: false, error: { code: "invalid-request" } };
        const connection = saved.catalog.connections.find(
          (entry) => entry.provider === "bitwarden" && entry.items.length,
        );
        const item = connection?.items[0];
        const fieldId =
          request.field === "password"
            ? "login.password"
            : `custom.${connection?.snapshotId}.${request.field === "custom-0" ? 0 : request.field === "custom-1" ? 1 : 3}`;
        const configuration = configurations.find(
          (entry) => entry.profile.connectionId === connection?.id,
        );
        if (!connection?.snapshotId || !item || !configuration)
          return { ok: false, error: { code: "field-missing" } };
        const entry = await runtime.vaultFor(configuration.profile).store.read();
        if (!entry.ok || !entry.data?.accepted)
          return { ok: false, error: { code: "cache-missing" } };
        const resolved = await runtime.resolveField(connection.id, {
          connectionId: connection.id,
          userId: entry.data.accepted.userId,
          itemId: item.id,
          snapshotId: connection.snapshotId,
          fieldId,
        });
        if (!resolved.ok) return resolved;
        const expected =
          request.field === "custom-0"
            ? variant === "changed" || variant === "reordered"
              ? "00001234"
              : "007"
            : request.field === "custom-1"
              ? variant === "reordered"
                ? "007"
                : "00001234"
              : variant === "builtin-changed"
                ? "test_username"
                : "test_password";
        return {
          ok: true,
          matched: resolved.data.kind === "text" && resolved.data.value === expected,
        };
      };
    },
  };
}
