import * as v from "valibot";
import type { BitwardenTransportOptions } from "@pateat/bitwarden";
import { rawCustomAccount } from "../../../../packages/bitwarden/src/__fixtures__/connection";
import { v1Email } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import type { ConnectionRuntime } from "./runtime";

const schema = v.variant("action", [
  v.strictObject({
    type: v.literal("setup.probe"),
    action: v.literal("configure"),
    variant: v.picklist(["unchanged", "reordered", "changed", "removed", "builtin-changed"]),
    challenge: v.optional(v.picklist(["none", "mfa", "new-device", "rejected"]), "none"),
    permission: v.optional(v.boolean(), true),
    overflow: v.optional(v.literal("group-refs")),
  }),
  v.strictObject({ type: v.literal("setup.probe"), action: v.picklist(["status", "inspect"]) }),
  v.strictObject({
    type: v.literal("setup.probe"),
    action: v.literal("resolve"),
    field: v.picklist(["password", "custom-0", "custom-1", "linked"]),
  }),
]);
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
          if (!permission) runtime.service.permissionsRemoved();
          return { ok: true };
        }
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
