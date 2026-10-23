import { problemEntrySchema, syncDeviceStateSchema } from "@pateat/contracts";
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

describe("problem reports (ADR 0066)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const LOGGED_AT = Date.UTC(2026, 9, 23, 1, 2, 3);
  const line = (seq: number, fields: Record<string, unknown> = {}) => ({
    seq,
    time: LOGGED_AT,
    level: "warn",
    event: "login.attempt",
    fields: {
      origin: "https://bank.example",
      recipe: "gen-0123456789abcdef0123456789abcdef",
      recipeRevision: 4,
      state: "blocked",
      outcome: "target-missing",
      cause: "step-timeout",
      settled: false,
      url: "/[id]/signin",
      tab: 12,
      ...fields,
    },
  });
  const LOG_ID = "0123456789abcdef0123456789abcdef";
  const report = (...entries: unknown[]) => ({
    version: 1,
    extensionBuild: "1c42ad3",
    logId: LOG_ID,
    entries,
  });
  const send = (device: Device | undefined, body: unknown, type = "application/json") =>
    exports.default.fetch("https://pateat.invalid/v1/device/problems", {
      method: "POST",
      headers: {
        "Content-Type": type,
        ...(device ? { Authorization: `Bearer ${device.token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const stored = async (ownerId: string) =>
    (
      await env.DB.prepare(
        "SELECT device_id, seq, extension_build, level, event, fields, logged_at FROM problem_log WHERE owner_id = ? ORDER BY created_at, device_id, seq",
      )
        .bind(ownerId)
        .all()
    ).results;

  it("keeps each line once per device, with the build and the device's time", async () => {
    const device = await owner();
    const other = await addDevice(device.ownerId);
    expect((await send(device, report(line(41), line(42)))).status).toBe(204);
    // A retry repeats a line's seq and changes nothing; another device's seq is its own.
    expect((await send(device, report(line(42), line(43)))).status).toBe(204);
    expect((await send(other, report(line(41)))).status).toBe(204);
    const rows = await stored(device.ownerId);
    expect(
      rows.map((row) => `${row["device_id"] === device.deviceId ? "a" : "b"}${row["seq"]}`).sort(),
    ).toEqual(["a41", "a42", "a43", "b41"]);
    const kept = rows.find((row) => row["device_id"] === device.deviceId && row["seq"] === 41)!;
    expect(kept).toMatchObject({
      extension_build: "1c42ad3",
      level: "warn",
      event: "login.attempt",
      logged_at: LOGGED_AT,
    });
    expect(JSON.parse(String(kept["fields"]))).toEqual(line(41).fields);
  });

  it("keeps a log made again on the device apart from the old one, though its seq restarts", async () => {
    const device = await owner();
    expect((await send(device, report(line(1), line(2)))).status).toBe(204);
    const again = { ...report(line(1, { step: 9 })), logId: "fedcba9876543210fedcba9876543210" };
    expect((await send(device, again)).status).toBe(204);
    const rows = await env.DB.prepare(
      "SELECT log_id, seq FROM problem_log WHERE owner_id = ? ORDER BY created_at, log_id, seq",
    )
      .bind(device.ownerId)
      .all();
    expect(
      rows.results.map((row) => `${String(row["log_id"]).slice(0, 4)}:${String(row["seq"])}`),
    ).toEqual(["0123:1", "0123:2", "fedc:1"]);
  });

  it("keeps the lines that pass beside ones it refuses, as from a newer extension", async () => {
    const device = await owner();
    const response = await send(
      device,
      report(
        line(1),
        { ...line(2), event: "login.later" },
        line(3, { later: "field" }),
        { ...line(4), level: "fatal" },
        "not a line",
        line(5),
      ),
    );
    expect(response.status).toBe(204);
    expect((await stored(device.ownerId)).map((row) => row["seq"])).toEqual([1, 5]);
    // A retry adds nothing, and the refused line stays out.
    expect((await send(device, report(line(1), line(3, { later: "field" })))).status).toBe(204);
    expect((await stored(device.ownerId)).map((row) => row["seq"])).toEqual([1, 5]);
  });

  it("keeps the info lines that say why Pateat did nothing, and no other info line", async () => {
    const device = await owner();
    const info = (seq: number, event: string, fields: Record<string, unknown>) => ({
      seq,
      time: LOGGED_AT,
      level: "info",
      event,
      fields: { origin: "https://bank.example", url: "/signin", tab: 12, ...fields },
    });
    const response = await send(
      device,
      report(
        info(1, "login.refused", { reason: "account-ambiguous", candidates: 2 }),
        info(2, "login.entry", { outcome: "refused", reason: "target-missing" }),
        info(3, "recipe.generate", { outcome: "skipped", reason: "incomplete-observation" }),
        info(4, "login.entry", { outcome: "pressed" }),
        info(5, "recipe.generate", { outcome: "recipe" }),
        info(6, "login.start", { route: "password" }),
      ),
    );
    expect(response.status).toBe(204);
    expect(
      (await stored(device.ownerId)).map((row) => `${String(row["seq"])}:${String(row["level"])}`),
    ).toEqual(["1:info", "2:info", "3:info"]);
  });

  it("refuses free text, other levels and anything beyond the contract, without echoing it", async () => {
    const device = await owner();
    const refusal = {
      seq: 1,
      time: LOGGED_AT,
      level: "info",
      event: "login.refused",
      fields: { origin: "https://bank.example", reason: "not-started", detail: "logged-in" },
    };
    // The same line without another page's path passes.
    expect(v.is(problemEntrySchema, refusal)).toBe(true);
    const refused = [
      report(),
      report({ ...line(1), level: "info" }),
      report({ ...line(1), level: "debug" }),
      report({ ...line(1), message: "extra" }),
      report(line(1, { reason: "Wrong password for alice@example.com\nTry again" })),
      report(line(1, { outcome: "パスワード" })),
      report(line(1, { reason: "wrong password" })),
      report(line(1, { url: "https://bank.example/cb?code=abc" })),
      report(line(1, { url: "/u/alice@example.com" })),
      report(line(1, { url: "/session;jsessionid=abc/login" })),
      report(line(1, { url: "/login/token=abc" })),
      report(line(1, { origin: "https://bank.example/login" })),
      report(line(1, { label: "x" })),
      report(line(1, { item: "item:0123abcd" })),
      // Only a line's own page may leave, never the tab's previous one.
      report({ ...refusal, fields: { ...refusal.fields, previousUrl: "/home" } }),
      report({ ...line(1), event: "login.unknown" }),
      report(line(1, { nested: { value: "x" } })),
      report(line(1, { long: "a".repeat(513) })),
      report(line(1, { negative: -1 })),
      report(line(1, { "bad-key": "x" })),
      report({ ...line(1), event: "Login Attempt" }),
      report(line(0)),
      { ...report(line(1)), extensionBuild: "main" },
      { ...report(line(1)), logId: "not-an-id" },
      { ...report(line(1)), device: "laptop" },
      report(...Array.from({ length: 101 }, (_, at) => line(at + 1))),
    ];
    for (const body of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const response = await send(device, body);
      expect(response.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
    expect((await send(device, report(line(1)), "text/plain")).status).toBe(415);
    const wide = Object.fromEntries(
      Array.from({ length: 20 }, (_, at) => [`field${at}`, "x".repeat(30)]),
    );
    // Within the 128 KiB every device request may carry, past this route's 64 KiB.
    const huge = report(...Array.from({ length: 100 }, (_, at) => line(at + 1, wide)));
    expect(JSON.stringify(huge).length).toBeGreaterThan(64 * 1024);
    expect(JSON.stringify(huge).length).toBeLessThan(128 * 1024);
    expect((await send(device, huge)).status).toBe(413);
    expect(await stored(device.ownerId)).toEqual([]);
  });

  it("refuses a report that would pass the owner's lines for 24 hours, and takes it later", async () => {
    const device = await owner();
    const other = await addDevice(device.ownerId);
    // 1,999 lines from the owner's other device within the last day.
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1999) INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) SELECT ?, ?, '0000000000000000000000000000000a', i, 'development', 'warn', 'login.attempt', '{}', ?, ? FROM n",
    )
      .bind(device.ownerId, other.deviceId, Date.now(), Date.now() - 1000)
      .run();
    const limited = await send(device, report(line(1), line(2)));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3600");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await send(device, report(line(1)))).status).toBe(204);
    // A retry of a line already kept adds nothing and is not counted, even at the limit.
    expect((await send(device, report(line(1)))).status).toBe(204);
    expect((await send(device, report(line(1), line(2)))).status).toBe(429);
    // Lines older than a day no longer count.
    await env.DB.prepare("UPDATE problem_log SET created_at = ? WHERE owner_id = ?")
      .bind(Date.now() - DAY_MS - 1000, device.ownerId)
      .run();
    expect((await send(device, report(line(2), line(3)))).status).toBe(204);
  });

  it("deletes lines older than a year when a report is kept", async () => {
    const device = await owner();
    const insert = (seq: number, age: number) =>
      env.DB.prepare(
        "INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) VALUES (?, ?, '0000000000000000000000000000000a', ?, 'development', 'error', 'error.unhandled', '{}', ?, ?)",
      ).bind(device.ownerId, device.deviceId, seq, Date.now() - age, Date.now() - age);
    await env.DB.batch([insert(1, 366 * DAY_MS), insert(2, 364 * DAY_MS)]);
    expect((await send(device, report(line(3)))).status).toBe(204);
    expect((await stored(device.ownerId)).map((row) => row["seq"])).toEqual([2, 3]);
  });

  it("requires a live device credential and answers other methods with 405", async () => {
    expect((await send(undefined, report(line(1)))).status).toBe(401);
    const device = await owner();
    const wrong = await exports.default.fetch("https://pateat.invalid/v1/device/problems", {
      headers: { Authorization: `Bearer ${device.token}` },
    });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("POST");
    await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), device.deviceId)
      .run();
    expect((await send(device, report(line(1)))).status).toBe(401);
    expect(await stored(device.ownerId)).toEqual([]);
  });
});
