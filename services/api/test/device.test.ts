import { syncDeviceStateSchema } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createDeviceToken, hashDeviceToken } from "../src/auth";
import { saveWifCredential } from "../src/claude/credentials";

// Synthetic owners and devices only; each test creates its own owner.

type Device = { ownerId: string; deviceId: string; token: string };
const PAIRED_AT = Date.UTC(2026, 9, 11, 10, 5);

async function addDevice(ownerId: string, pairedAt = PAIRED_AT): Promise<Device> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const token = createDeviceToken();
  await env.DB.prepare(
    "INSERT INTO devices (id, owner_id, token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(deviceId, ownerId, await hashDeviceToken(token), "Owner laptop", pairedAt, Date.now())
    .run();
  return { ownerId, deviceId, token };
}

async function owner(): Promise<Device> {
  const ownerId = `owner-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, Date.now())
    .run();
  return addDevice(ownerId);
}

function get(device: Device | undefined) {
  return exports.default.fetch("https://pateat.invalid/v1/device", {
    headers: device ? { Authorization: `Bearer ${device.token}` } : {},
  });
}

const month = () => new Date().toISOString().slice(0, 7);
const day = () => new Date().toISOString().slice(0, 10);

const ids = {
  federationRuleId: "fdrl_01SyntheticRule",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_01SyntheticAccount",
  workspaceId: "wrkspc_01SyntheticWorkspace",
};

describe("device state", () => {
  it("reports an owner with nothing stored and no Claude credentials", async () => {
    const device = await owner();
    const response = await get(device);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      pairedAt: PAIRED_AT,
      recipes: 0,
      settingsRevision: 0,
      generation: "credentials-not-configured",
    });
  });

  it("counts only this owner's live recipes and reports its settings and spend stop", async () => {
    const device = await owner();
    const other = await owner();
    const head = (ownerId: string, recipeId: string, state: string, sequence: number) =>
      env.DB.prepare(
        "INSERT INTO recipe_heads (owner_id, recipe_id, revision, state, sequence, write_id, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
      ).bind(ownerId, recipeId, state, sequence, crypto.randomUUID(), Date.now());
    await env.DB.batch([
      head(device.ownerId, "bank-login", "active", 1),
      head(device.ownerId, "shop-login", "active", 2),
      head(device.ownerId, "old-login", "revoked", 3),
      head(other.ownerId, "other-login", "active", 1),
      env.DB.prepare(
        "INSERT INTO settings (owner_id, revision, document, updated_at) VALUES (?, 7, '{}', ?)",
      ).bind(device.ownerId, Date.now()),
    ]);
    await saveWifCredential(env.DB, device.ownerId, ids);
    const ready = await (await get(device)).json();
    expect(ready).toEqual({
      version: 1,
      pairedAt: PAIRED_AT,
      recipes: 2,
      settingsRevision: 7,
      generation: "ok",
    });
    expect(v.is(syncDeviceStateSchema, ready)).toBe(true);
    // Nothing that names the owner, the device or the credential is returned.
    const text = JSON.stringify(ready);
    for (const secret of [device.ownerId, device.deviceId, "Owner laptop", "fdrl_"])
      expect(text).not.toContain(secret);

    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, month(), 100_000_000)
      .run();
    expect(await (await get(device)).json()).toMatchObject({ generation: "monthly-limit" });
  });

  it("answers for the calling device only", async () => {
    const first = await owner();
    const second = await addDevice(first.ownerId, PAIRED_AT + 60_000);
    expect(await (await get(second)).json()).toMatchObject({ pairedAt: PAIRED_AT + 60_000 });
    expect(await (await get(first)).json()).toMatchObject({ pairedAt: PAIRED_AT });
  });

  it("reports generation states in the order a generation call checks them", async () => {
    const device = await owner();
    // A spend stop is reported first, as a call stops there before reading credentials.
    await env.DB.prepare(
      "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, ?, 1, ?)",
    )
      .bind(device.ownerId, day(), 100_000_000)
      .run();
    expect(await (await get(device)).json()).toMatchObject({ generation: "daily-limit" });
    await env.DB.prepare("DELETE FROM inference_spend WHERE owner_id = ?")
      .bind(device.ownerId)
      .run();

    await saveWifCredential(env.DB, device.ownerId, ids);
    const keys = JSON.parse(env.OIDC_SIGNING_KEYS) as { keys: Record<string, string>[] };
    // Right shape, but not a point on the curve: the key never imports.
    const offCurve = JSON.stringify({
      ...keys,
      keys: [{ ...keys.keys[0], x: "A".repeat(43), y: "A".repeat(43) }],
    });
    for (const OIDC_SIGNING_KEYS of [undefined, offCurve]) {
      // oxlint-disable-next-line no-await-in-loop -- one configuration at a time
      const response = await app.request(
        "https://pateat.invalid/v1/device",
        { headers: { Authorization: `Bearer ${device.token}` } },
        { ...env, OIDC_SIGNING_KEYS },
      );
      // oxlint-disable-next-line no-await-in-loop -- one configuration at a time
      expect(await response.json()).toMatchObject({ generation: "issuer-unavailable" });
    }
  });

  it("requires a live device credential", async () => {
    expect((await get(undefined)).status).toBe(401);
    const device = await owner();
    await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), device.deviceId)
      .run();
    expect((await get(device)).status).toBe(401);
  });
});
