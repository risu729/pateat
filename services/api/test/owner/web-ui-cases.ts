import { manageDevicesSchema } from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { expect, it } from "vitest";
import { app } from "../../src/app";
import {
  claims,
  deviceApi,
  forgedAccess,
  newSubject,
  ORIGIN,
  owner,
  ownerIdFor,
  request,
} from "../access-helpers";
import { OWNER_LIMIT, withLimiter } from "../limiter";
import type { OwnerTestHelpers } from "../owner.test";

export function registerOwnerWebUiCases({ manageApi, pairDevice }: OwnerTestHelpers) {
  it("serves the app and its assets only at known paths, unframeable and script-limited", async () => {
    const { token } = await owner();
    const page = await request("/manage", { access: token });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain("Pateat test app");
    const policy = page.headers.get("Content-Security-Policy");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const asset = await request("/manage/assets/app.js", { access: token });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Pateat test app");
    expect(asset.headers.get("Content-Security-Policy")).toBe(policy);
    // The built document is reached only through its page path.
    expect((await request("/manage/index.html", { access: token })).status).toBe(404);
    expect((await request("/manage/unknown", { access: token })).status).toBe(404);
    expect((await request("/manage/assets/missing.js", { access: token })).status).toBe(404);
    expect((await request("/manage", { access: token, method: "POST" })).status).toBe(405);
  });

  it("never resolves an asset path outside the asset directory", async () => {
    const { token } = await owner();
    const paths = [
      "/manage/assets/..%5cindex.html",
      "/manage/assets/%2e%2e%5cindex.html",
      "/manage/assets/..%2findex.html",
      "/manage/assets/%2e%2e/index.html",
      "/manage/assets/sub/app.js",
      "/manage/assets/.hidden",
    ];
    const responses = await Promise.all(
      paths.map(async (path) => {
        const response = await request(path, { access: token });
        return [path, response.status, await response.text()] as const;
      }),
    );
    for (const [path, status, body] of responses) {
      expect(status, path).toBe(404);
      expect(body, path).not.toContain("Pateat test app");
    }
  });

  it("answers API Access failures with error codes", async () => {
    const forged = await forgedAccess(claims(newSubject()));
    const rejected = await request("/manage/api/devices", { access: forged });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "forbidden" });
    const { token } = await owner();
    const unconfigured = await app.request(
      `${ORIGIN}/manage/api/devices`,
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      { ...env, ACCESS_AUD: "" },
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "access_unavailable" });
  });

  it("shows an identity that never paired a device no devices", async () => {
    const { subject, token } = await owner();
    const response = await request("/manage/api/devices", { access: token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, devices: [] });
    // Reading creates no owner.
    expect(await ownerIdFor(subject)).toBeNull();
  });

  it("rate limits the API per Access identity before the origin check", async () => {
    const limitedEnv = withLimiter("OWNER_LIMITER", OWNER_LIMIT);
    const send = (path: string, access: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Cf-Access-Jwt-Assertion", access);
      return app.request(`${ORIGIN}${path}`, { ...init, headers }, limitedEnv);
    };
    const { token } = await owner();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < OWNER_LIMIT; attempt += 1)
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
      statuses.push((await send("/manage/api/devices", token)).status);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const limited = await send(`/manage/api/devices/${crypto.randomUUID()}/revoke`, token, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await send("/manage/api/devices", (await owner()).token)).status).toBe(200);
  });

  it("lists only the signed-in owner's devices, newest first", async () => {
    const first = await owner();
    const second = await owner();
    const older = await pairDevice(first, "First owner laptop");
    await pairDevice(second, "Second owner phone");
    const newer = await pairDevice(first, "First owner phone");
    const response = await request("/manage/api/devices", { access: first.token });
    const body = v.parse(manageDevicesSchema, await response.json());
    expect(body.devices.map((device) => [device.id, device.label, device.revokedAt])).toEqual([
      [newer.deviceId, "First owner phone", null],
      [older.deviceId, "First owner laptop", null],
    ]);
    // A new device counts as used when it is paired.
    for (const device of body.devices) expect(device.lastUsedAt).toBe(device.createdAt);
  });

  it("revokes an owned device", async () => {
    const by = await owner();
    const kept = await pairDevice(by, "Kept");
    const revoked = await pairDevice(by, "Revoked");
    const path = `/manage/api/devices/${revoked.deviceId}/revoke`;
    const response = await manageApi(path, by.token, "POST");
    expect(response.status).toBe(204);
    expect(await (await deviceApi(revoked.credential)).json()).toEqual({
      error: "device_revoked",
    });
    expect((await deviceApi(kept.credential)).status).toBe(200);
    const list = v.parse(
      manageDevicesSchema,
      await (await request("/manage/api/devices", { access: by.token })).json(),
    );
    expect(list.devices.find((device) => device.id === revoked.deviceId)?.revokedAt).toEqual(
      expect.any(Number),
    );
    // Revoking again is harmless.
    expect((await manageApi(path, by.token, "POST")).status).toBe(204);
    expect((await manageApi(path, by.token, "GET")).status).toBe(405);
  });

  it("cannot revoke another owner's device or an unknown one", async () => {
    const first = await owner();
    const second = await owner();
    const target = await pairDevice(first);
    await pairDevice(second);
    const responses = await Promise.all([
      ...[second, await owner()].map((by) =>
        manageApi(`/manage/api/devices/${target.deviceId}/revoke`, by.token, "POST"),
      ),
      manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, first.token, "POST"),
      manageApi("/manage/api/devices/not-a-device/revoke", first.token, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
      Array.from({ length: 4 }, () => ({ error: "not_found" })),
    );
    expect((await deviceApi(target.credential)).status).toBe(200);
  });

  it("rejects cross-site and origin-less revocation", async () => {
    const by = await owner();
    const target = await pairDevice(by);
    const path = `/manage/api/devices/${target.deviceId}/revoke`;
    const responses = await Promise.all([
      manageApi(path, by.token, "POST", "https://attacker.example"),
      manageApi(path, by.token, "POST", null),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(await responses[0]!.json()).toEqual({ error: "forbidden" });
    expect((await deviceApi(target.credential)).status).toBe(200);
  });

  it("keeps the web UI's theme per owner, for every browser it signs in with", async () => {
    const first = await owner();
    const second = await owner();
    await Promise.all([pairDevice(first), pairDevice(second)]);
    const put = (by: { token: string }, body: unknown, origin: string | null = ORIGIN) =>
      request("/manage/api/preferences", {
        method: "PUT",
        access: by.token,
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body),
      });
    const read = async (by: { token: string }) => {
      const response = await manageApi("/manage/api/preferences", by.token, "GET");
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await read(first)).toEqual({ version: 1, theme: "system" });
    const saved = await put(first, { version: 1, theme: "dark" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ version: 1, theme: "dark" });
    expect(await read(first)).toEqual({ version: 1, theme: "dark" });
    expect(await read(second)).toEqual({ version: 1, theme: "system" });
    // Browser setting is no stored choice.
    expect((await put(first, { version: 1, theme: "system" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT web_theme FROM owners WHERE id = ?")
      .bind(await ownerIdFor(first.subject))
      .first<{ web_theme: string | null }>();
    expect(row).toEqual({ web_theme: null });
    // Only the three choices, from the page's own origin.
    expect((await put(first, { version: 1, theme: "sepia" })).status).toBe(400);
    expect((await put(first, { version: 1, theme: "dark", extra: 1 })).status).toBe(400);
    expect((await put(first, { version: 1, theme: "dark" }, "https://evil.example")).status).toBe(
      403,
    );
    expect((await manageApi("/manage/api/preferences", first.token, "DELETE")).status).toBe(405);
    expect(await read(first)).toEqual({ version: 1, theme: "system" });
  });

  it("keeps no theme for an identity that never paired a device", async () => {
    const { subject, token } = await owner();
    expect((await manageApi("/manage/api/preferences", token, "GET")).status).toBe(404);
    const response = await request("/manage/api/preferences", {
      method: "PUT",
      access: token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ version: 1, theme: "dark" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_paired" });
    expect(await ownerIdFor(subject)).toBeNull();
  });
}
