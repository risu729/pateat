import { deviceCredentialSchema } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { hashDeviceToken } from "../src/auth";
import {
  OWNER_TABLES,
  SMOKE_OWNER_PREFIX,
  checkAccessGate,
  createDeviceCredential,
  removeSmokeOwners,
  runHostedSmoke,
  type Fetch,
  type Query,
} from "../smoke/hosted.ts";

// The release runs these checks against the hosted server; here they run against the
// local Worker and D1 so a contract or schema change cannot break them unnoticed.

const ORIGIN = "https://pateat.invalid";
const worker: Fetch = (url, init) => exports.default.fetch(url, init);
// Like the D1 REST API, bind every parameter as text.
const query: Query = async (sql, params = []) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>()
  ).results;

async function smokeRows() {
  const counts = await Promise.all(
    [...OWNER_TABLES.map((table) => [table, "owner_id"]), ["owners", "id"]].map(
      async ([table, column]) =>
        (await query(`SELECT count(*) AS count FROM ${table} WHERE ${column} LIKE 'smoke-%'`))[0]?.[
          "count"
        ],
    ),
  );
  return counts.reduce((sum: number, count) => sum + Number(count), 0);
}

describe("hosted smoke checks", () => {
  it("pass against the Worker and leave no synthetic rows", async () => {
    const passed = await runHostedSmoke(ORIGIN, worker, query);
    expect(passed).toContain("Owners cannot read or change each other's settings and recipes.");
    expect(await smokeRows()).toBe(0);
  });

  it("clean up even when a check fails", async () => {
    const failing: Fetch = (url, init) =>
      new URL(url).pathname === "/v1/recipes"
        ? Promise.resolve(Response.json({ version: 1, changes: [] }))
        : worker(url, init);
    await expect(runHostedSmoke(ORIGIN, failing, query)).rejects.toThrow(
      "the recipe did not read back",
    );
    expect(await smokeRows()).toBe(0);
  });

  it("fail when another owner's data is visible", async () => {
    let firstCredential: string | undefined;
    const leaking: Fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      const credential = headers.get("Authorization");
      if (new URL(url).pathname === "/v1/settings" && init?.method === "PUT")
        firstCredential ??= credential ?? undefined;
      // Answer every settings read as the first owner.
      if (new URL(url).pathname === "/v1/settings" && firstCredential && credential)
        headers.set("Authorization", firstCredential);
      return worker(url, { ...init, headers });
    };
    await expect(runHostedSmoke(ORIGIN, leaking, query)).rejects.toThrow(
      "another owner's settings leaked",
    );
    expect(await smokeRows()).toBe(0);
  });

  it("remove leftovers of an interrupted run, children first", async () => {
    const ownerId = `${SMOKE_OWNER_PREFIX}${crypto.randomUUID()}`;
    const deviceId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(ownerId),
      env.DB.prepare(
        "INSERT INTO devices (id, owner_id, token_hash, created_at) VALUES (?, ?, ?, 1)",
      ).bind(deviceId, ownerId, crypto.randomUUID()),
      env.DB.prepare(
        "INSERT INTO settings (owner_id, revision, document, updated_at, updated_by_device_id) VALUES (?, 1, '{}', 1, ?)",
      ).bind(ownerId, deviceId),
    ]);
    const realOwner = crypto.randomUUID();
    await query("INSERT INTO owners (id, created_at) VALUES (?, ?)", [realOwner, "1"]);

    await removeSmokeOwners(query);
    expect(await smokeRows()).toBe(0);
    expect(await query("SELECT id FROM owners WHERE id = ?", [realOwner])).toHaveLength(1);
  });

  it("know every table that holds owner rows", async () => {
    const tables = await query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    );
    const owned = [];
    for (const { name } of tables) {
      // oxlint-disable-next-line no-await-in-loop -- One pragma per table.
      const columns = await query(`PRAGMA table_info(${String(name)})`);
      if (columns.some((column) => column["name"] === "owner_id")) owned.push(name);
    }
    expect(owned.sort()).toEqual([...OWNER_TABLES].sort());
  });

  it("create device credentials the service accepts", async () => {
    const { credential, tokenHash } = await createDeviceCredential();
    expect(v.is(deviceCredentialSchema, credential)).toBe(true);
    expect(tokenHash).toBe(await hashDeviceToken(credential));
  });
});

describe("Access gate check", () => {
  const origin = "https://pateat.example";
  const answer =
    (status: number, headers: Record<string, string>): Fetch =>
    () =>
      Promise.resolve(new Response(null, { status, headers }));

  it("accepts an Access refusal or a redirect to the team sign-in", async () => {
    await expect(
      checkAccessGate(origin, answer(403, { "Cf-Access-Domain": "pateat.example" })),
    ).resolves.toBeTypeOf("string");
    await expect(
      checkAccessGate(
        origin,
        answer(302, { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }),
      ),
    ).resolves.toBeTypeOf("string");
  });

  it("refuses an answer from the Worker or another site", async () => {
    await expect(checkAccessGate(origin, answer(200, {}))).rejects.toThrow("/manage");
    await expect(checkAccessGate(origin, answer(503, {}))).rejects.toThrow("/manage");
    await expect(
      checkAccessGate(origin, answer(302, { Location: "https://cloudflareaccess.com.example/" })),
    ).rejects.toThrow("/manage");
    await expect(
      checkAccessGate(origin, answer(403, { "Cf-Access-Domain": "other.example" })),
    ).rejects.toThrow("/manage");
  });
});
