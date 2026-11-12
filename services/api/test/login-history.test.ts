import {
  devicePairResultSchema,
  INFERENCE_LOG_RETENTION_MS,
  manageLoginHistorySchema,
  type ManageLoginHistory,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { loginHistoryQuery, readLoginHistory } from "../src/login-history";
import {
  installAccessKeys,
  ORIGIN,
  owner,
  ownerIdFor,
  request,
  type Owner,
} from "./access-helpers";

// Synthetic owners, metadata and retained request contents only.
installAccessKeys();
const SITE = "https://bank.example";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function pair(by: Owner) {
  const response = await request("/pair", {
    access: by.token,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    },
    body: JSON.stringify({ version: 1, label: "Synthetic history device" }),
  });
  expect(response.status).toBe(201);
  const device = v.parse(devicePairResultSchema, await response.json());
  return { ownerId: (await ownerIdFor(by.subject))!, device };
}
function insert(
  ownerId: string,
  n: number,
  at: number,
  origin = SITE,
  outcome = "authenticated",
  cause: string | null = null,
) {
  return env.DB.prepare(
    "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, cause, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'gen-synthetic', '', 2, ?, ?, ?, 'development', 4000, 500, 100, 2000, 1500, ?)",
  ).bind(id(n), ownerId, origin, outcome, cause, at);
}
async function read(by: Owner, query = ""): Promise<ManageLoginHistory> {
  const response = await request(`/manage/api/logins${query}`, { access: by.token });
  expect(response.status).toBe(200);
  return v.parse(manageLoginHistorySchema, await response.json());
}
function cursor(next: NonNullable<ManageLoginHistory["next"]>) {
  return `?beforeAt=${next.at}&beforeId=${next.id}`;
}

describe("owner login history API", () => {
  it("requires Access rather than a device token and isolates foreign owners", async () => {
    const first = await owner();
    const second = await owner();
    const mine = await pair(first);
    const theirs = await pair(second);
    const now = Date.now();
    await env.DB.batch([insert(mine.ownerId, 1, now), insert(theirs.ownerId, 2, now)]);
    expect((await request("/manage/api/logins")).status).toBe(401);
    expect(
      (
        await request("/manage/api/logins", {
          headers: { Authorization: `Bearer ${mine.device.credential}` },
        })
      ).status,
    ).toBe(401);
    expect((await read(first)).entries.map((entry) => entry.id)).toEqual([id(1)]);
    expect((await read(second)).entries.map((entry) => entry.id)).toEqual([id(2)]);
    expect(
      (
        await request("/manage/api/logins", {
          access: first.token,
          method: "POST",
          headers: { Origin: ORIGIN },
        })
      ).status,
    ).toBe(405);
  });

  it("returns an empty unpaired identity without creating an owner", async () => {
    const by = await owner();
    expect(await read(by)).toEqual({ version: 1, entries: [], next: null });
    expect(await ownerIdFor(by.subject)).toBeNull();
    await pair(by);
    expect(await read(by)).toEqual({ version: 1, entries: [], next: null });
  });

  it.each([
    "?beforeAt=1",
    `?beforeId=${id(1)}`,
    `?beforeAt=-1&beforeId=${id(1)}`,
    `?beforeAt=8640000000000001&beforeId=${id(1)}`,
    "?limit=100",
    "?outcome=success",
    "?origin=https%3A%2F%2Fbank.example%2Flogin",
  ])("rejects invalid queries %s", async (query) => {
    const by = await owner();
    const response = await request(`/manage/api/logins${query}`, { access: by.token });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });

  it("filters before limiting and traverses tied timestamps without omissions or duplicates", async () => {
    const by = await owner();
    const { ownerId } = await pair(by);
    const now = Date.now();
    await env.DB.batch([
      ...Array.from({ length: 105 }, (_, n) => insert(ownerId, 1000 + n, now - Math.floor(n / 60))),
      ...Array.from({ length: 60 }, (_, n) =>
        insert(ownerId, 2000 + n, now + 1, "https://bank.example:8443", "timeout"),
      ),
      insert(ownerId, 3000, now + 2, SITE, "timeout"),
    ]);
    const query = "origin=https%3A%2F%2Fbank.example&outcome=authenticated";
    const seen: string[] = [];
    const first = await read(by, `?${query}`);
    const second = await read(by, `${cursor(first.next!)}&${query}`);
    const third = await read(by, `${cursor(second.next!)}&${query}`);
    for (const [page, data] of [first, second, third].entries()) {
      expect(data.entries).toHaveLength(page < 2 ? 50 : 5);
      expect(
        data.entries.every((entry) => entry.origin === SITE && entry.outcome === "authenticated"),
      ).toBe(true);
      seen.push(...data.entries.map((entry) => entry.id));
      if (page < 2) {
        expect(data.next).toEqual({ at: data.entries.at(-1)!.at, id: data.entries.at(-1)!.id });
      } else expect(data.next).toBeNull();
    }
    const expected = Array.from({ length: 105 }, (_, n) => ({
      id: id(1000 + n),
      at: now - Math.floor(n / 60),
    }))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
      .map((entry) => entry.id);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(105);
    expect((await read(by, "?outcome=timeout")).entries).toHaveLength(50);
    expect((await read(by, "?origin=https%3A%2F%2Fbank.example%3A8443")).entries).toHaveLength(50);
  });

  it("keeps an older cursor stable after insertion and deletion, and refreshes newest", async () => {
    const by = await owner();
    const { ownerId } = await pair(by);
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 52 }, (_, n) => insert(ownerId, 4000 + n, now - n)));
    const first = await read(by);
    await env.DB.batch([
      insert(ownerId, 5000, now + 1),
      env.DB.prepare("DELETE FROM login_timings WHERE owner_id = ? AND id = ?").bind(
        ownerId,
        first.next!.id,
      ),
    ]);
    expect((await read(by, cursor(first.next!))).entries.map((entry) => entry.id)).toEqual([
      id(4050),
      id(4051),
    ]);
    expect((await read(by)).entries[0]!.id).toBe(id(5000));
    const deleted = await request("/manage/api/request-log", {
      access: by.token,
      method: "DELETE",
      headers: { Origin: ORIGIN },
    });
    expect(deleted.status).toBe(200);
    expect(await read(by, cursor(first.next!))).toEqual({ version: 1, entries: [], next: null });
  });

  it("seeks an older page through the owner and time index, bounded by the cursor", async () => {
    const by = await owner();
    const { ownerId } = await pair(by);
    const now = Date.now();
    const { sql, params } = loginHistoryQuery(
      env.DB,
      ownerId,
      { outcome: "timeout", beforeAt: now, beforeId: id(1) },
      now,
    ).toSQL();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail)).toContainEqual(
      expect.stringMatching(
        /^SEARCH login_timings USING INDEX login_timings_owner_created \(owner_id=\? AND created_at>\? AND created_at<\?\)$/,
      ),
    );
  });

  it("leaves out rows with codes the contract no longer accepts and pages past them", async () => {
    const by = await owner();
    const { ownerId } = await pair(by);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 53 }, (_, n) =>
        n === 1
          ? insert(ownerId, 7000 + n, now - n, SITE, "renamed-result")
          : n === 49
            ? insert(ownerId, 7000 + n, now - n, SITE, "timeout", "removed-cause")
            : insert(ownerId, 7000 + n, now - n),
      ),
    );
    const first = await read(by);
    expect(first.entries).toHaveLength(48);
    expect(first.entries.map((entry) => entry.id)).not.toContain(id(7001));
    // The cursor is the last row read, here a left-out one, so it is neither repeated nor stuck.
    expect(first.next).toEqual({ at: now - 49, id: id(7049) });
    const second = await read(by, cursor(first.next!));
    expect(second.entries.map((entry) => entry.id)).toEqual([id(7050), id(7051), id(7052)]);
    expect(second.next).toBeNull();
  });

  it("includes the retention boundary and returns only the safe metadata projection", async () => {
    const by = await owner();
    const { ownerId } = await pair(by);
    const now = Date.now();
    const cutoff = now - INFERENCE_LOG_RETENTION_MS;
    await env.DB.batch([
      insert(ownerId, 6000, cutoff - 1),
      insert(ownerId, 6001, cutoff),
      insert(ownerId, 6002, cutoff + 1),
    ]);
    const data = await readLoginHistory(env.DB, ownerId, {}, now);
    expect(data.entries.map((entry) => entry.id)).toEqual([id(6002), id(6001)]);
    expect(data.entries[0]).toEqual({
      id: id(6002),
      at: cutoff + 1,
      origin: SITE,
      recipeId: "gen-synthetic",
      revision: 2,
      outcome: "authenticated",
      cause: null,
      extensionBuild: "development",
      totalMs: 4000,
      personMs: 2000,
      serviceMs: 500,
      networkMs: 100,
      pageMs: 1500,
    });
    expect(Object.keys(data.entries[0]!).sort()).toEqual(
      [
        "id",
        "at",
        "origin",
        "recipeId",
        "revision",
        "outcome",
        "cause",
        "extensionBuild",
        "totalMs",
        "personMs",
        "serviceMs",
        "networkMs",
        "pageMs",
      ].sort(),
    );
    expect(data.next).toBeNull();
    expect(await readLoginHistory(env.DB, null, {}, now)).toEqual({
      version: 1,
      entries: [],
      next: null,
    });
  });
});
