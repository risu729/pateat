import {
  manageProblemsSchema,
  manageRequestLogDeletedSchema,
  manageRequestLogSchema,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { expect, it } from "vitest";
import {
  claims,
  deviceApi,
  forgedAccess,
  newSubject,
  ORIGIN,
  owner,
  ownerIdFor,
  request,
  type Owner,
} from "../access-helpers";
import type { OwnerTestHelpers } from "../owner.test";

export function registerOwnerRequestLogCases({ manageApi, pairDevice }: OwnerTestHelpers) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  /** Writes a synthetic request log row, judgement or spend row for an owner. */
  const insertLog = (ownerId: string, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, recipe_id, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'm', 'https://bank.example', '/login', '{}', 'ok', 'gen-synthetic', 0, ?)",
    ).bind(`log-${crypto.randomUUID()}`, ownerId, createdAt);
  /** A synthetic login result code a device sent (ADR 0019, amended 2026-10-18). */
  const insertOutcome = (ownerId: string, revision: number, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO login_outcomes (owner_id, recipe_id, branch, revision, outcome, cause, step, created_at) VALUES (?, 'gen-synthetic', '', ?, 'unknown-submit', 'settled', 1, ?)",
    ).bind(ownerId, revision, createdAt);
  /** A synthetic login record a device sent (ADR 0055). */
  const insertLogin = (ownerId: string, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'gen-synthetic', '', 1, 'https://bank.example', 'authenticated', 'development', 4000, 0, 0, 0, 0, ?)",
    ).bind(`login-${crypto.randomUUID()}`, ownerId, createdAt);
  /** A synthetic problem line a device sent (ADR 0066). */
  const insertProblem = (ownerId: string, deviceId: string, seq: number, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) VALUES (?, ?, '0000000000000000000000000000000a', ?, 'development', 'warn', 'login.attempt', '{\"outcome\":\"target-missing\"}', ?, ?)",
    ).bind(ownerId, deviceId, seq, createdAt, createdAt);
  const loginCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_timings WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const problemCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM problem_log WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const outcomeCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_outcomes WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const logCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM inference_log WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const read = async (by: Owner) => {
    const response = await request("/manage/api/request-log", { access: by.token });
    expect(response.status).toBe(200);
    return v.parse(manageRequestLogSchema, await response.json());
  };

  it("serves its page", async () => {
    const { token } = await owner();
    const page = await request("/manage/request-log", { access: token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pateat test app");
    expect((await request("/manage/request-log")).status).toBe(401);
    expect((await request("/manage/request-log", { access: token, method: "POST" })).status).toBe(
      405,
    );
  });

  it("counts and deletes only the signed-in owner's rows and codes, keeping recipes, settings and spend", async () => {
    const first = await owner();
    const second = await owner();
    const devicesOf = await Promise.all([pairDevice(first), pairDevice(second)]);
    const [mine, theirs] = await Promise.all([
      ownerIdFor(first.subject),
      ownerIdFor(second.subject),
    ]);
    // Each owner holds a recipe its device wrote, with a record of its units (ADR 0060).
    for (const { credential } of devicesOf) {
      // oxlint-disable-next-line no-await-in-loop -- One recipe per owner.
      const written = await deviceApi(credential, "/v1/recipes/bank-signin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          expectedRevision: 0,
          state: "active",
          recipe: {
            version: 1,
            id: "bank-signin",
            revision: 1,
            origin: "https://bank.example",
            entry: { path: "/", target: { by: "text", value: "Log in" } },
          },
        }),
      });
      expect(written.status).toBe(200);
    }
    /** The owner's unit rows: which device and log row each names. */
    const units = async (ownerId: string) =>
      (
        await env.DB.prepare(
          "SELECT unit, origin, device_id, log_id FROM recipe_unit_sources WHERE owner_id = ?",
        )
          .bind(ownerId)
          .all()
      ).results;
    const [myDevice, theirDevice] = devicesOf.map(({ deviceId }) => deviceId);
    // Stands in for the log row a generated unit names.
    await env.DB.prepare("UPDATE recipe_unit_sources SET log_id = 'log-1'").run();
    expect(await units(mine!)).toEqual([
      { unit: "entry", origin: "device", device_id: myDevice, log_id: "log-1" },
    ]);
    const oldest = Date.now() - 40 * DAY_MS;
    await env.DB.batch([
      insertLog(mine!, Date.now() - 30 * DAY_MS),
      insertLog(mine!, Date.now()),
      insertLog(theirs!, Date.now() - 60 * DAY_MS),
      // The oldest row may be a login result code.
      insertOutcome(mine!, 1, oldest),
      insertOutcome(theirs!, 1, Date.now()),
      insertLogin(mine!, Date.now() - DAY_MS),
      insertLogin(mine!, Date.now()),
      insertLogin(mine!, Date.now()),
      insertLogin(theirs!, Date.now()),
      insertProblem(mine!, myDevice!, 1, Date.now()),
      insertProblem(mine!, myDevice!, 2, Date.now()),
      insertProblem(theirs!, theirDevice!, 1, Date.now()),
      env.DB.prepare(
        "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, '2026-10', 2, 900)",
      ).bind(mine),
      env.DB.prepare(
        "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict) VALUES (?, 'gen-synthetic', '', 1, 'https://bank.example', '/home', 'v', ?, 'signed-in')",
      ).bind(mine, Date.now()),
    ]);
    // The owner's first profile has the owner's ID.
    const settings = await request(`/manage/api/profiles/${mine}/settings`, {
      method: "PUT",
      access: first.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        expectedRevision: 0,
        settings: {
          connections: [],
          accountPolicies: [],
          itemPolicies: [],
          customFieldReviews: [],
          excludedSites: [],
          passkeyBrowserSites: [],
          repromptSites: [],
          siteDefaults: [],
          bindings: [],
        },
      }),
    });
    expect(settings.status).toBe(200);
    expect(await read(first)).toEqual({
      version: 1,
      entries: 2,
      outcomes: 1,
      logins: 3,
      problems: 2,
      oldestAt: oldest,
    });

    const deleted = await manageApi("/manage/api/request-log", first.token, "DELETE");
    expect(deleted.status).toBe(200);
    expect(v.parse(manageRequestLogDeletedSchema, await deleted.json())).toEqual({
      version: 1,
      deleted: 2,
      outcomes: 1,
      logins: 3,
      problems: 2,
    });
    expect(await read(first)).toEqual({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 0,
      problems: 0,
      oldestAt: null,
    });
    expect(await logCount(theirs!)).toBe(1);
    expect(await outcomeCount(theirs!)).toBe(1);
    expect(await loginCount(theirs!)).toBe(1);
    expect(await problemCount(theirs!)).toBe(1);
    // The record of which call made each part of a recipe stays without the device and the
    // log row it named (ADR 0060).
    expect(await units(mine!)).toEqual([
      { unit: "entry", origin: "device", device_id: null, log_id: null },
    ]);
    expect(await units(theirs!)).toEqual([
      { unit: "entry", origin: "device", device_id: theirDevice, log_id: "log-1" },
    ]);
    // Only the log goes: the spend the limits count, judged pages, settings and recipes stay.
    const kept = await env.DB.batch([
      env.DB.prepare("SELECT calls FROM inference_spend WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT verdict FROM page_judgements WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT revision FROM settings WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT state FROM recipe_heads WHERE owner_id = ?").bind(mine),
    ]);
    expect(kept.map((result) => result.results)).toEqual([
      [{ calls: 2 }],
      [{ verdict: "signed-in" }],
      [{ revision: 1 }],
      [{ state: "active" }],
    ]);
    // Deleting an empty log is harmless.
    expect(
      await (await manageApi("/manage/api/request-log", first.token, "DELETE")).json(),
    ).toEqual({ version: 1, deleted: 0, outcomes: 0, logins: 0, problems: 0 });
  });

  it("shows an identity without a paired device an empty log and creates no owner", async () => {
    const by = await owner();
    expect(await read(by)).toEqual({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 0,
      problems: 0,
      oldestAt: null,
    });
    const deleted = await manageApi("/manage/api/request-log", by.token, "DELETE");
    expect(await deleted.json()).toEqual({
      version: 1,
      deleted: 0,
      outcomes: 0,
      logins: 0,
      problems: 0,
    });
    const problems = await request("/manage/api/problems", { access: by.token });
    expect(await problems.json()).toEqual({ version: 1, problems: [] });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("lists only the signed-in owner's newest problem lines with each device's label (ADR 0066)", async () => {
    const first = await owner();
    const second = await owner();
    const [laptop, theirDevice] = await Promise.all([
      pairDevice(first, "Laptop"),
      pairDevice(second),
    ]);
    const desktop = await pairDevice(first, "Desktop");
    const [mine, theirs] = await Promise.all([
      ownerIdFor(first.subject),
      ownerIdFor(second.subject),
    ]);
    const now = Date.now();
    await env.DB.batch([
      insertProblem(mine!, laptop.deviceId, 7, now - DAY_MS),
      insertProblem(mine!, desktop.deviceId, 3, now),
      insertProblem(theirs!, theirDevice.deviceId, 1, now),
      // A stored line that no longer passes the contract is left out.
      env.DB.prepare(
        "INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) VALUES (?, ?, '0000000000000000000000000000000a', 8, 'development', 'warn', 'login.attempt', 'not json', ?, ?)",
      ).bind(mine, laptop.deviceId, now, now),
    ]);
    const response = await request("/manage/api/problems", { access: first.token });
    expect(response.status).toBe(200);
    expect(v.parse(manageProblemsSchema, await response.json())).toEqual({
      version: 1,
      problems: [
        {
          device: "Desktop",
          extensionBuild: "development",
          level: "warn",
          event: "login.attempt",
          fields: { outcome: "target-missing" },
          loggedAt: now,
          receivedAt: now,
        },
        {
          device: "Laptop",
          extensionBuild: "development",
          level: "warn",
          event: "login.attempt",
          fields: { outcome: "target-missing" },
          loggedAt: now - DAY_MS,
          receivedAt: now - DAY_MS,
        },
      ],
    });
    expect((await request("/manage/api/problems")).status).toBe(401);
    expect((await manageApi("/manage/api/problems", first.token, "DELETE")).status).toBe(405);
  });

  it("refuses deletion without Access, from another origin or without one", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const ownerId = await ownerIdFor(by.subject);
    await env.DB.batch([
      insertLog(ownerId!, Date.now()),
      insertOutcome(ownerId!, 1, Date.now()),
      insertLogin(ownerId!, Date.now()),
      insertProblem(ownerId!, device.deviceId, 1, Date.now()),
    ]);
    const forged = await forgedAccess(claims(newSubject()));
    const responses = await Promise.all([
      manageApi("/manage/api/request-log", undefined, "DELETE"),
      manageApi("/manage/api/request-log", forged, "DELETE"),
      manageApi("/manage/api/request-log", by.token, "DELETE", "https://attacker.example"),
      manageApi("/manage/api/request-log", by.token, "DELETE", null),
      manageApi("/manage/api/request-log", by.token, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 403, 403, 403, 405]);
    expect(await logCount(ownerId!)).toBe(1);
    expect(await outcomeCount(ownerId!)).toBe(1);
    expect(await loginCount(ownerId!)).toBe(1);
    expect(await problemCount(ownerId!)).toBe(1);
    expect((await request("/manage/api/request-log")).status).toBe(401);
  });
}
