import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  OWNER_TABLES,
  SMOKE_OWNER_PREFIX,
  checkAccessGate,
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

  it("fail when a revoked device keeps working", async () => {
    // Pretend the revocation succeeded without sending it.
    const ignoring: Fetch = (url, init) =>
      new URL(url).pathname === "/v1/device"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : worker(url, init);
    await expect(runHostedSmoke(ORIGIN, ignoring, query)).rejects.toThrow(
      "a revoked device answered 200",
    );
    expect(await smokeRows()).toBe(0);
  });

  it("report the failed check when cleanup fails too", async () => {
    let failCleanup = false;
    const failing: Fetch = (url, init) => {
      if (new URL(url).pathname.startsWith("/v1/recipes/")) failCleanup = true;
      return failCleanup
        ? Promise.resolve(Response.json({ error: "internal_error" }, { status: 500 }))
        : worker(url, init);
    };
    const flaky: Query = (sql, params) =>
      failCleanup && sql.startsWith("DELETE")
        ? Promise.reject(new Error("D1 unavailable"))
        : query(sql, params);
    const error = await runHostedSmoke(ORIGIN, failing, flaky).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String((error as AggregateError).errors[0])).toContain("recipe write 500");
    await removeSmokeOwners(query);
  });

  it("remove leftovers of an interrupted run, children first", async () => {
    const ownerId = `${SMOKE_OWNER_PREFIX}${crypto.randomUUID()}`;
    const deviceId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(ownerId),
      env.DB.prepare("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')").bind(
        ownerId,
        deviceId,
      ),
      env.DB.prepare(
        "INSERT INTO devices (id, owner_id, profile_id, token_hash, created_at) VALUES (?, ?, ?, ?, 1)",
      ).bind(deviceId, ownerId, deviceId, crypto.randomUUID()),
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
      // oxlint-disable-next-line no-await-in-loop -- Two pragmas per table.
      const [columns, references] = await Promise.all([
        query(`PRAGMA table_info(${String(name)})`),
        query(`PRAGMA foreign_key_list(${String(name)})`),
      ]);
      // A row that refers to an owner or a device must go before them.
      if (
        columns.some((column) => column["name"] === "owner_id") ||
        references.some((reference) => ["owners", "devices"].includes(String(reference["table"])))
      )
        owned.push(name);
    }
    expect(owned.sort()).toEqual([...OWNER_TABLES].sort());
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

  it("refuses the Worker's own refusal of a forged token", async () => {
    await expect(checkAccessGate(ORIGIN, worker)).rejects.toThrow("/manage");
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
