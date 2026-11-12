import {
  createDefaultSettings,
  DEVICE_IDLE_LIMIT_MS,
  MAX_SETTINGS_DOCUMENT_BYTES,
  type LocalSettings,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDeviceToken } from "../../src/auth";
import { writeSettings } from "../../src/settings-store";

import {
  type Device,
  enrollOwner,
  addDevice,
  recordedUse,
  DAY_MS,
  api,
  put,
  settings,
  detailLink,
  answerLink,
} from "./harness";

export function registerDeviceAuthenticationTests() {
  describe("device authentication", () => {
    it.each([
      ["no credential", undefined],
      ["a non-bearer scheme", "Basic c3ludGhldGljOnVudXNlZA=="],
      ["a malformed token", "Bearer synthetic-token"],
      ["an unknown token", `Bearer ${createDeviceToken()}`],
    ])("rejects %s without revealing data", async (_, authorization) => {
      const response = await exports.default.fetch("https://pateat.invalid/v1/settings", {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="pateat"');
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "unauthorized" });
    });

    it("stops a revoked device without affecting the owner's other devices", async () => {
      const first = await enrollOwner();
      const second = await addDevice(first.ownerId);
      await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(Date.now(), first.deviceId)
        .run();

      const write = await put(first, "/v1/settings", {
        version: 1,
        expectedRevision: 0,
        settings: settings(),
      });
      expect(write.status).toBe(401);
      expect(await write.json()).toEqual({ error: "device_revoked" });
      expect((await api(first, "/v1/recipes")).status).toBe(401);

      const read = await api(second, "/v1/settings");
      expect(await read.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 0,
        settings: null,
      });
    });

    it("renews a device used 89 days ago", async () => {
      const owner = await enrollOwner();
      const device = await addDevice(owner.ownerId, Date.now() - 89 * DAY_MS);
      const before = Date.now();
      expect((await api(device, "/v1/settings")).status).toBe(200);
      expect(await recordedUse(device)).toBeGreaterThanOrEqual(before);
    });

    it("expires a device unused for more than 90 days", async () => {
      const owner = await enrollOwner();
      const idleSince = Date.now() - DEVICE_IDLE_LIMIT_MS - 60_000;
      const device = await addDevice(owner.ownerId, idleSince);
      const response = await api(device, "/v1/settings");
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="pateat"');
      expect(await response.json()).toEqual({ error: "device_expired" });
      // A refused request does not renew the credential.
      expect(await recordedUse(device)).toBe(idleSince);
      expect((await api(owner, "/v1/settings")).status).toBe(200);
    });

    it("does not rewrite a device used within the last day", async () => {
      const owner = await enrollOwner();
      const recent = Date.now() - DAY_MS + 60_000;
      const device = await addDevice(owner.ownerId, recent);
      expect((await api(device, "/v1/settings")).status).toBe(200);
      expect(await recordedUse(device)).toBe(recent);
    });

    it("reports a revoked device as revoked even after it went idle", async () => {
      const owner = await enrollOwner();
      const device = await addDevice(owner.ownerId, Date.now() - DEVICE_IDLE_LIMIT_MS - DAY_MS);
      await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(Date.now(), device.deviceId)
        .run();
      const response = await api(device, "/v1/settings");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "device_revoked" });
    });

    it("accepts the bearer scheme case-insensitively", async () => {
      const device = await enrollOwner();
      const response = await exports.default.fetch("https://pateat.invalid/v1/settings", {
        headers: { Authorization: `bearer ${device.token}` },
      });
      expect(response.status).toBe(200);
    });

    it("authenticates before reading a request body", async () => {
      const response = await exports.default.fetch("https://pateat.invalid/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{not json".repeat(20_000),
      });
      expect(response.status).toBe(401);
    });

    it("does not offer cross-origin access", async () => {
      const device = await enrollOwner();
      const response = await api(device, "/v1/settings", {
        headers: { Origin: "https://attacker.example" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
}

export function registerSettingsSyncTests() {
  describe("settings sync", () => {
    it("starts empty and accepts the first write only at revision 0", async () => {
      const device = await enrollOwner();
      expect(await (await api(device, "/v1/settings")).json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 0,
        settings: null,
      });

      const created = await put(device, "/v1/settings", {
        version: 1,
        expectedRevision: 0,
        settings: settings(),
      });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 1,
        settings: settings(),
      });

      const duplicate = await put(device, "/v1/settings", {
        version: 1,
        expectedRevision: 0,
        settings: settings("other.example"),
      });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({
        error: "settings_conflict",
        current: { version: 1, profileId: expect.any(String), revision: 1, settings: settings() },
      });
    });

    it("tells each device the write ID of its own last stored write, and only its own", async () => {
      // A device whose write got no answer learns from it whether the write committed.
      const laptop = await enrollOwner();
      const phone = await addDevice(laptop.ownerId);
      const read = async (device: Device) =>
        (await (await api(device, "/v1/settings")).json()) as {
          revision: number;
          written?: string;
        };
      expect(await read(laptop)).not.toHaveProperty("written");

      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const write = (device: Device, expectedRevision: number, writeId?: string) =>
        put(device, "/v1/settings", {
          version: 1,
          expectedRevision,
          settings: settings(),
          ...(writeId === undefined ? {} : { writeId }),
        });
      const first = await write(laptop, 0, id(1));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ revision: 1, written: id(1) });
      expect((await write(phone, 1, id(2))).status).toBe(200);
      // A losing write changes neither the settings nor the writer's `written`, and its
      // conflict answer names the write that did commit.
      const lost = await write(laptop, 1, id(3));
      expect(lost.status).toBe(409);
      expect(await lost.json()).toMatchObject({ current: { revision: 2, written: id(1) } });
      expect(await read(laptop)).toMatchObject({ revision: 2, written: id(1) });
      expect(await read(phone)).toMatchObject({ revision: 2, written: id(2) });

      // The owner's web UI writes as no device.
      const profile = await env.DB.prepare("SELECT profile_id FROM devices WHERE id = ?")
        .bind(laptop.deviceId)
        .first<{ profile_id: string }>();
      const managed = await writeSettings(
        env.DB,
        laptop.ownerId,
        profile!.profile_id,
        { version: 1, expectedRevision: 2, settings: settings() },
        null,
      );
      expect(managed).toMatchObject({ ok: true, state: { revision: 3 } });
      expect(managed.ok && managed.state).not.toHaveProperty("written");
      expect(await read(laptop)).toMatchObject({ revision: 3, written: id(1) });
      // A write without an ID clears the device's last one.
      expect((await write(phone, 3)).status).toBe(200);
      expect(await read(phone)).not.toHaveProperty("written");
    });

    it("stores personal-detail links with the owner's bindings, shared by every profile", async () => {
      // Links name vault items and fields per site, as bindings do (ADR 0061, ADR 0076).
      const laptop = await enrollOwner();
      const agentProfile = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Agent')")
        .bind(laptop.ownerId, agentProfile)
        .run();
      const agent = await addDevice(laptop.ownerId);
      await env.DB.prepare("UPDATE devices SET profile_id = ? WHERE id = ?")
        .bind(agentProfile, agent.deviceId)
        .run();
      const written = { ...settings(), detailLinks: [detailLink(), answerLink()] };
      const created = await put(laptop, "/v1/settings", {
        version: 1,
        expectedRevision: 0,
        settings: written,
      });
      expect(created.status).toBe(200);
      expect(await (await api(laptop, "/v1/settings")).json()).toMatchObject({
        revision: 1,
        settings: written,
      });

      const shared = await env.DB.prepare("SELECT document FROM settings WHERE owner_id = ?")
        .bind(laptop.ownerId)
        .first<{ document: string }>();
      expect(JSON.parse(shared!.document)).toEqual({
        bindings: [],
        detailLinks: written.detailLinks,
      });
      const profile = await env.DB.prepare(
        "SELECT document FROM profiles WHERE owner_id = ? AND id = ?",
      )
        .bind(laptop.ownerId, laptop.ownerId)
        .first<{ document: string }>();
      expect(JSON.parse(profile!.document)).not.toHaveProperty("detailLinks");

      // A device on another profile gets the owner's links but not the profile's sites.
      expect(await (await api(agent, "/v1/settings")).json()).toEqual({
        version: 1,
        profileId: agentProfile,
        revision: 1,
        newProfile: true,
        settings: {
          connections: [],
          accountPolicies: [],
          itemPolicies: [],
          customFieldReviews: [],
          excludedSites: [],
          repromptSites: [],
          passkeyBrowserSites: [],
          siteDefaults: [],
          bindings: [],
          detailLinks: written.detailLinks,
        },
      });

      // Removing a link is a write like any other, from any profile.
      const removed = await put(agent, "/v1/settings", {
        version: 1,
        expectedRevision: 1,
        settings: { ...createDefaultSettings(), connections: [], detailLinks: [answerLink()] },
      });
      expect(removed.status).toBe(200);
      expect(await (await api(laptop, "/v1/settings")).json()).toMatchObject({
        revision: 2,
        settings: { excludedSites: written.excludedSites, detailLinks: [answerLink()] },
      });

      // Omitting owner links replaces them for every profile, while each profile keeps its
      // own site policy. A stale writer on another profile cannot bring the links back.
      const clearingWriteId = crypto.randomUUID();
      const cleared = await put(agent, "/v1/settings", {
        version: 1,
        expectedRevision: 2,
        writeId: clearingWriteId,
        settings: settings("agent.example"),
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ revision: 3, written: clearingWriteId });
      const laptopState = {
        version: 1,
        profileId: laptop.ownerId,
        revision: 3,
        settings: settings(),
      };
      expect(await (await api(laptop, "/v1/settings")).json()).toEqual(laptopState);
      const stale = await put(laptop, "/v1/settings", {
        version: 1,
        expectedRevision: 2,
        writeId: crypto.randomUUID(),
        settings: { ...settings("stale.example"), detailLinks: written.detailLinks },
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "settings_conflict", current: laptopState });
      expect(await (await api(agent, "/v1/settings")).json()).toEqual({
        version: 1,
        profileId: agentProfile,
        revision: 3,
        settings: settings("agent.example"),
        written: clearingWriteId,
      });
    });

    it.each(["omitted", "empty", "retained"] as const)(
      "replaces detail links with the submitted document when they are %s",
      async (mode) => {
        const device = await enrollOwner();
        const links = [detailLink(), answerLink()];
        const initialWriteId = crypto.randomUUID();
        const replacementWriteId = crypto.randomUUID();
        expect(
          (
            await put(device, "/v1/settings", {
              version: 1,
              expectedRevision: 0,
              writeId: initialWriteId,
              settings: { ...settings(), detailLinks: links },
            })
          ).status,
        ).toBe(200);
        const replacement = {
          ...settings("replacement.example"),
          ...(mode === "omitted" ? {} : { detailLinks: mode === "empty" ? [] : links }),
        };
        const saved = await put(device, "/v1/settings", {
          version: 1,
          expectedRevision: 1,
          writeId: replacementWriteId,
          settings: replacement,
        });
        expect(saved.status).toBe(200);
        const expected = {
          version: 1,
          profileId: device.ownerId,
          revision: 2,
          settings: replacement,
          written: replacementWriteId,
        };
        expect(await saved.json()).toEqual(expected);
        expect(await (await api(device, "/v1/settings")).json()).toEqual(expected);

        // A stale replacement must change neither profile policy nor owner links or the
        // acknowledgement of the write that actually committed.
        const stale = await put(device, "/v1/settings", {
          version: 1,
          expectedRevision: 1,
          writeId: crypto.randomUUID(),
          settings: {
            ...settings("stale.example"),
            detailLinks: [detailLink("https://stale.example")],
          },
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({ error: "settings_conflict", current: expected });
        expect(await (await api(device, "/v1/settings")).json()).toEqual(expected);
      },
    );

    it("stores only the validated replacement without adding omitted links past its byte limit", async () => {
      const device = await enrollOwner();
      const detailLinks = Array.from({ length: 250 }, (_, index) =>
        detailLink(`https://site-${index}.example`, `${"F".repeat(160)}${index}`),
      );
      const original = { ...settings(), detailLinks };
      expect(new TextEncoder().encode(JSON.stringify(original)).byteLength).toBeLessThanOrEqual(
        MAX_SETTINGS_DOCUMENT_BYTES,
      );
      expect(
        (
          await put(device, "/v1/settings", {
            version: 1,
            expectedRevision: 0,
            settings: original,
          })
        ).status,
      ).toBe(200);

      const replacement = {
        ...settings(),
        excludedSites: Array.from({ length: 500 }, (_, index) => ({
          hostname: `${"x".repeat(40)}${index}.example`,
          includeSubdomains: true,
        })),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(replacement)).byteLength;
      expect(bytes).toBeLessThanOrEqual(MAX_SETTINGS_DOCUMENT_BYTES);
      expect(
        new TextEncoder().encode(JSON.stringify({ ...replacement, detailLinks })).byteLength,
      ).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
      const saved = await put(device, "/v1/settings", {
        version: 1,
        expectedRevision: 1,
        settings: replacement,
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ revision: 2, settings: replacement });
      const current = (await (await api(device, "/v1/settings")).json()) as {
        settings: LocalSettings;
      };
      expect(current.settings).toEqual(replacement);
      expect(new TextEncoder().encode(JSON.stringify(current.settings)).byteLength).toBe(bytes);
    });

    it("refuses detail links that push the document over its limit", async () => {
      const device = await enrollOwner();
      // Under the request body limit, over the settings document's.
      const detailLinks = Array.from({ length: 325 }, (_, index) =>
        detailLink(`https://site-${index}.example`, `${"F".repeat(160)}${index}`),
      );
      const write = {
        version: 1,
        expectedRevision: 0,
        settings: { ...settings(), detailLinks },
      };
      const bytes = new TextEncoder().encode(JSON.stringify(write)).byteLength;
      expect(bytes).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
      expect(bytes).toBeLessThan(128 * 1024);
      const response = await put(device, "/v1/settings", write);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
      expect(await (await api(device, "/v1/settings")).json()).toMatchObject({ revision: 0 });
    });

    it("reads a profile document stored before passkeyBrowserSites as listing no site", async () => {
      const device = await enrollOwner();
      // A profile document as the previous schema wrote it, without the list (ADR 0076).
      const {
        connections: _connections,
        bindings,
        passkeyBrowserSites: _list,
        ...old
      } = settings();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 3, ?, 1000, NULL)",
        ).bind(device.ownerId, JSON.stringify({ bindings })),
        env.DB.prepare("UPDATE profiles SET document = ? WHERE owner_id = ?").bind(
          JSON.stringify(old),
          device.ownerId,
        ),
      ]);
      const read = await api(device, "/v1/settings");
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 3,
        settings: { ...settings(), passkeyBrowserSites: [] },
      });
    });

    it("keeps the popup's hidden page status in the profile and drops a shown one", async () => {
      const device = await enrollOwner();
      const hidden = { ...settings(), popupPageSection: false };
      const saved = await put(device, "/v1/settings", {
        version: 1,
        expectedRevision: 0,
        settings: hidden,
      });
      expect(await saved.json()).toMatchObject({ revision: 1, settings: hidden });
      expect(await (await api(device, "/v1/settings")).json()).toMatchObject({ settings: hidden });
      // Shown is the default, so it is stored as no field at all.
      const shown = await put(device, "/v1/settings", {
        version: 1,
        expectedRevision: 1,
        settings: { ...settings(), popupPageSection: true },
      });
      expect(shown.status).toBe(200);
      const read = (await (await api(device, "/v1/settings")).json()) as {
        settings: LocalSettings;
      };
      expect(read.settings).toEqual(settings());
      expect(read.settings).not.toHaveProperty("popupPageSection");
    });

    it("never lets a stale device overwrite a newer restriction", async () => {
      const laptop = await enrollOwner();
      const desktop = await addDevice(laptop.ownerId);
      await put(laptop, "/v1/settings", { version: 1, expectedRevision: 0, settings: settings() });

      const newer = settings("newer.example");
      expect(
        (await put(desktop, "/v1/settings", { version: 1, expectedRevision: 1, settings: newer }))
          .status,
      ).toBe(200);
      const stale = await put(laptop, "/v1/settings", {
        version: 1,
        expectedRevision: 1,
        settings: { ...createDefaultSettings(), connections: [] },
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error: "settings_conflict",
        current: { version: 1, profileId: expect.any(String), revision: 2, settings: newer },
      });
    });

    it("accepts exactly one of two concurrent writes from the same revision", async () => {
      const device = await enrollOwner();
      await put(device, "/v1/settings", { version: 1, expectedRevision: 0, settings: settings() });
      const responses = await Promise.all(
        ["a.example", "b.example"].map((hostname) =>
          put(device, "/v1/settings", {
            version: 1,
            expectedRevision: 1,
            settings: settings(hostname),
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await (await api(device, "/v1/settings")).json()).toMatchObject({ revision: 2 });
    });

    it("isolates owners even when another owner's revision would match", async () => {
      const alice = await enrollOwner();
      const bob = await enrollOwner();
      await put(alice, "/v1/settings", { version: 1, expectedRevision: 0, settings: settings() });

      expect(await (await api(bob, "/v1/settings")).json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 0,
        settings: null,
      });
      const crossWrite = await put(bob, "/v1/settings", {
        version: 1,
        expectedRevision: 1,
        settings: { ...createDefaultSettings(), connections: [] },
      });
      expect(crossWrite.status).toBe(409);
      expect(await (await api(alice, "/v1/settings")).json()).toEqual({
        version: 1,
        profileId: expect.any(String),
        revision: 1,
        settings: settings(),
      });
    });

    it.each([
      ["an unsupported schema version", { version: 2, expectedRevision: 0, settings: settings() }],
      [
        "device-local field policies",
        { version: 1, expectedRevision: 0, settings: settings(), fieldPolicies: [] },
      ],
      [
        "a value-bearing setting",
        {
          version: 1,
          expectedRevision: 0,
          settings: { ...settings(), password: "synthetic-forbidden-value" },
        },
      ],
      ["a negative revision", { version: 1, expectedRevision: -1, settings: settings() }],
      [
        "a detail link that carries a value",
        {
          version: 1,
          expectedRevision: 0,
          settings: {
            ...settings(),
            detailLinks: [{ ...detailLink(), value: "synthetic-forbidden-value" }],
          },
        },
      ],
      [
        "two detail links of one login item for the same detail",
        {
          version: 1,
          expectedRevision: 0,
          settings: {
            ...settings(),
            detailLinks: [detailLink(), detailLink("https://bank.example", "Other date")],
          },
        },
      ],
      [
        "two answers that store the same question",
        {
          version: 1,
          expectedRevision: 0,
          settings: {
            ...settings(),
            detailLinks: [answerLink("Answer 1"), answerLink("Answer 2")],
          },
        },
      ],
      [
        "a stored question on a detail other than an answer",
        {
          version: 1,
          expectedRevision: 0,
          settings: {
            ...settings(),
            detailLinks: [{ ...detailLink(), question: "what is your birth date" }],
          },
        },
      ],
      [
        "a stored question not in its compared form",
        {
          version: 1,
          expectedRevision: 0,
          settings: {
            ...settings(),
            detailLinks: [{ ...answerLink(), question: "What Was Your First Pet?" }],
          },
        },
      ],
    ])("rejects %s", async (_, body) => {
      const device = await enrollOwner();
      const response = await put(device, "/v1/settings", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
      expect(await (await api(device, "/v1/settings")).json()).toMatchObject({ revision: 0 });
    });

    it("rejects non-JSON media, malformed JSON and oversized bodies", async () => {
      const device = await enrollOwner();
      const body = JSON.stringify({ version: 1, expectedRevision: 0, settings: settings() });
      const text = await api(device, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      expect(text.status).toBe(415);
      expect(await text.json()).toEqual({ error: "unsupported_media_type" });

      const suffixed = await api(device, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/synthetic+json" },
        body: "{",
      });
      expect(suffixed.status).toBe(415);

      const malformed = await api(device, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "bad_request" });

      const oversized = await api(device, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(200 * 1024) }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({ error: "payload_too_large" });
    });

    it("fails closed without details when a stored document is corrupt", async () => {
      const device = await enrollOwner();
      await env.DB.prepare(
        "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 1, ?, 0, ?)",
      )
        .bind(device.ownerId, JSON.stringify({ synthetic: "corrupt" }), device.deviceId)
        .run();
      const response = await api(device, "/v1/settings");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
    });

    it("fails closed when a stored document's policy list is over its limit", async () => {
      const device = await enrollOwner();
      const over = {
        ...settings(),
        accountPolicies: Array.from({ length: 101 }, (_, index) => ({
          provider: "bitwarden",
          server: "cloud-us",
          userId: `user-${index}`,
          accountName: "Vault",
          enabled: true,
          selection: { mode: "all" },
        })),
      };
      // The lists are profile parts (ADR 0024), kept in the device's Default profile.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 1, ?, 0, ?)",
        ).bind(device.ownerId, JSON.stringify({ bindings: [] }), device.deviceId),
        env.DB.prepare("UPDATE profiles SET document = ? WHERE owner_id = ? AND id = ?").bind(
          JSON.stringify(over),
          device.ownerId,
          device.ownerId,
        ),
      ]);
      const response = await api(device, "/v1/settings");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
    });

    it("limits each path to its supported methods", async () => {
      const device = await enrollOwner();
      const response = await api(device, "/v1/settings", { method: "DELETE" });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, PUT");
    });
  });
}
