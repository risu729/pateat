import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addDevice, api, enrollOwner, put, settings } from "./sync/harness";

const account = { provider: "bitwarden", server: "cloud-us", userId: "synthetic-user" };
const mapping = (method = 1) => ({
  ...account,
  itemId: "a0000000-0000-4000-8000-000000000001",
  method,
  idp: {
    ...account,
    itemId: "a0000000-0000-4000-8000-000000000002",
    origin: "https://idp.example",
  },
});

describe("SSO mappings (ADR 0085)", () => {
  it("stores them with the owner's shared parts, for every profile, with the IdP origin", async () => {
    const laptop = await enrollOwner();
    const profileId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Agent')")
      .bind(laptop.ownerId, profileId)
      .run();
    const agent = await addDevice(laptop.ownerId);
    await env.DB.prepare("UPDATE devices SET profile_id = ? WHERE id = ?")
      .bind(profileId, agent.deviceId)
      .run();
    const written = { ...settings(), ssoMappings: [mapping(1), mapping(2)] };
    const created = await put(laptop, "/v1/settings", {
      version: 1,
      expectedRevision: 0,
      settings: written,
    });
    expect(created.status).toBe(200);

    const shared = await env.DB.prepare("SELECT document FROM settings WHERE owner_id = ?")
      .bind(laptop.ownerId)
      .first<{ document: string }>();
    expect(JSON.parse(shared!.document)).toMatchObject({ ssoMappings: written.ssoMappings });
    const profile = await env.DB.prepare(
      "SELECT document FROM profiles WHERE owner_id = ? AND id = ?",
    )
      .bind(laptop.ownerId, laptop.ownerId)
      .first<{ document: string }>();
    expect(JSON.parse(profile!.document)).not.toHaveProperty("ssoMappings");
    expect(await (await api(agent, "/v1/settings")).json()).toMatchObject({
      revision: 1,
      settings: { ssoMappings: written.ssoMappings },
    });

    // Removing one from another profile removes it for every profile.
    const removed = await put(agent, "/v1/settings", {
      version: 1,
      expectedRevision: 1,
      settings: { ...settings("agent.example"), ssoMappings: [mapping(2)] },
    });
    expect(removed.status).toBe(200);
    expect(await (await api(laptop, "/v1/settings")).json()).toMatchObject({
      revision: 2,
      settings: { ssoMappings: [mapping(2)] },
    });
  });

  it("refuses two mappings for one method, or one with another field", async () => {
    const laptop = await enrollOwner();
    const { idp } = mapping(1);
    for (const ssoMappings of [
      [mapping(1), mapping(1)],
      [{ ...mapping(1), label: "Provider" }],
      [{ ...mapping(1), idp: { ...idp, origin: "https://idp.example/path" } }],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each write is checked on its own
      const response = await put(laptop, "/v1/settings", {
        version: 1,
        expectedRevision: 0,
        settings: { ...settings(), ssoMappings },
      });
      expect(response.status).toBe(400);
    }
  });
});
