import {
  deviceCredentialSchema,
  devicePairResultSchema,
  manageDevicesSchema,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { hashDeviceToken, TOKEN_PATTERN } from "../src/auth";
import {
  deviceApi,
  installAccessKeys,
  ISSUER,
  ORIGIN,
  owner,
  ownerIdFor,
  rejectedTokens,
  request,
  type Owner,
} from "./access-helpers";
import { awaitRoomInMinute } from "./limiter";

// Synthetic Access keys, identities and extension IDs only (see vitest.config.ts).

installAccessKeys();

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

type PairOptions = {
  origin?: string | null;
  body?: BodyInit;
  contentType?: string;
};

function pairInit(access: string | undefined, options: PairOptions = {}): RequestInit {
  const headers = new Headers({ "Content-Type": options.contentType ?? "application/json" });
  const origin = options.origin === undefined ? EXTENSION_ORIGIN : options.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (access) headers.set("Cf-Access-Jwt-Assertion", access);
  return {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({ version: 1, label: "Test laptop" }),
  };
}

function pair(by: Owner | undefined, options: PairOptions = {}) {
  return request("/pair", pairInit(by?.token, options));
}

async function devicesOf(subject: string) {
  const ownerId = await ownerIdFor(subject);
  if (!ownerId) return [];
  const { results } = await env.DB.prepare(
    "SELECT id, owner_id, token_hash, label, created_at, last_used_at, revoked_at FROM devices WHERE owner_id = ?",
  )
    .bind(ownerId)
    .all();
  return results;
}

function corsHeaders(response: Response) {
  return [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
}

describe("direct pairing", () => {
  it("issues one working credential and stores only its hash and the trimmed label", async () => {
    const by = await owner();
    const response = await pair(by, {
      body: JSON.stringify({ version: 1, label: "  Work laptop  " }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(corsHeaders(response)).toEqual([]);
    const result = v.parse(devicePairResultSchema, await response.json());

    expect(await devicesOf(by.subject)).toEqual([
      {
        id: result.deviceId,
        owner_id: await ownerIdFor(by.subject),
        token_hash: await hashDeviceToken(result.credential),
        label: "Work laptop",
        created_at: expect.any(Number),
        last_used_at: expect.any(Number),
        revoked_at: null,
      },
    ]);
    // A new device starts its idle window at pairing, not at the column's default of 0.
    const [row] = await devicesOf(by.subject);
    expect(row?.["last_used_at"]).toBe(row?.["created_at"]);
    expect((await deviceApi(result.credential)).status).toBe(200);
    const listed = v.parse(
      manageDevicesSchema,
      await (await request("/manage/api/devices", { access: by.token })).json(),
    );
    expect(listed.devices.map((device) => device.id)).toEqual([result.deviceId]);
  });

  it("creates the owner on first pairing and reuses it for the same identity only", async () => {
    const first = await owner();
    const other = await owner();
    expect(await ownerIdFor(first.subject)).toBeNull();
    expect((await pair(first)).status).toBe(201);
    const ownerId = await ownerIdFor(first.subject);
    expect(ownerId).not.toBeNull();
    expect((await pair(await owner(first.subject))).status).toBe(201);
    expect(await ownerIdFor(first.subject)).toBe(ownerId);
    expect(await devicesOf(first.subject)).toHaveLength(2);

    expect((await pair(other)).status).toBe(201);
    const otherOwnerId = await ownerIdFor(other.subject);
    expect(otherOwnerId).not.toBeNull();
    expect(otherOwnerId).not.toBe(ownerId);
    expect(await devicesOf(other.subject)).toHaveLength(1);
  });

  it("maps one identity to one owner under concurrent first pairings", async () => {
    const by = await owner();
    const responses = await Promise.all([pair(by), pair(by), pair(by)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const { results } = await env.DB.prepare(
      "SELECT owner_id FROM owner_identities WHERE issuer = ? AND subject = ?",
    )
      .bind(ISSUER, by.subject)
      .all();
    expect(results).toHaveLength(1);
    expect(await devicesOf(by.subject)).toHaveLength(3);
    const orphans = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM owners WHERE id NOT IN (SELECT owner_id FROM owner_identities) AND id NOT LIKE 'owner-%'",
    ).first<{ count: number }>();
    expect(orphans?.count).toBe(0);
  });

  it("keeps the credential shape the device routes accept", () => {
    expect(deviceCredentialSchema.pipe[1].requirement.source).toBe(TOKEN_PATTERN.source);
    expect(deviceCredentialSchema.pipe[1].requirement.flags).toBe(TOKEN_PATTERN.flags);
  });
});

/** The rejected tokens carry subjects the test never sees, so count every row instead. */
async function rowCounts() {
  return await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM owners) AS owners",
  ).first();
}

describe("pairing sign-in", () => {
  it("requires a login token", async () => {
    const response = await pair(undefined);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it.each(rejectedTokens)("rejects %s without creating a device", async (_, token) => {
    const before = await rowCounts();
    const response = await request("/pair", pairInit(await token()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await rowCounts()).toEqual(before);
  });

  it("creates no owner for a rejected request", async () => {
    const by = await owner();
    expect((await pair(by, { origin: ORIGIN })).status).toBe(403);
    expect((await pair(by, { body: "{" })).status).toBe(400);
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("fails closed without Access configuration", async () => {
    const by = await owner();
    const response = await app.request(`${ORIGIN}/pair`, pairInit(by.token), {
      ...env,
      ACCESS_AUD: "",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "access_unavailable" });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("checks Access and the origin before reading the body", async () => {
    const big = "x".repeat(5 * 1024);
    expect((await pair(undefined, { body: big, contentType: "text/plain" })).status).toBe(401);
    const by = await owner();
    const response = await pair(by, { origin: null, body: big, contentType: "text/plain" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "extension_not_allowed" });
  });

  it("leaves the device routes to device credentials only", async () => {
    const { token } = await owner();
    const response = await request("/v1/settings", {
      access: token,
      headers: { Cookie: `CF_Authorization=${token}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

describe("pairing origin", () => {
  it.each([
    ["no origin", null],
    ["an opaque origin", "null"],
    ["the service's own origin", ORIGIN],
    ["another site", "https://evil.example"],
    ["another extension", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ["the allowed ID in uppercase", `chrome-extension://${EXTENSION_ID.toUpperCase()}`],
    ["the allowed ID with a trailing slash", `${EXTENSION_ORIGIN}/`],
  ])("refuses %s", async (_, origin) => {
    const by = await owner();
    expect((await pair(by)).status).toBe(201);
    const response = await pair(by, { origin });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "extension_not_allowed" });
    expect(corsHeaders(response)).toEqual([]);
    expect(await devicesOf(by.subject)).toHaveLength(1);
  });

  it.each([
    ["an empty list", []],
    ["a malformed ID", ["not-an-id"]],
    ["a bare string", EXTENSION_ID],
    ["no list", undefined],
  ])("refuses every pairing with %s", async (_, ids) => {
    const by = await owner();
    const response = await app.request(`${ORIGIN}/pair`, pairInit(by.token), {
      ...env,
      PAIRING_EXTENSION_IDS: ids,
    } as unknown as Env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "pairing_unavailable" });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });
});

describe("pairing bodies", () => {
  it.each([
    ["plain text", 415, JSON.stringify({ version: 1, label: "Laptop" }), "text/plain"],
    ["a form", 415, "version=1&label=Laptop", "application/x-www-form-urlencoded"],
    ["a JSON variant", 415, JSON.stringify({ version: 1, label: "Laptop" }), "application/ld+json"],
    ["5 KiB", 413, JSON.stringify({ version: 1, label: "x".repeat(5 * 1024) }), undefined],
    ["malformed JSON", 400, "{", undefined],
    ["a blank label", 400, JSON.stringify({ version: 1, label: "  " }), undefined],
    ["a control character", 400, JSON.stringify({ version: 1, label: "a\u0000b" }), undefined],
    ["a long label", 400, JSON.stringify({ version: 1, label: "x".repeat(65) }), undefined],
    ["an extra field", 400, JSON.stringify({ version: 1, label: "L", ownerId: "x" }), undefined],
    ["version 2", 400, JSON.stringify({ version: 2, label: "Laptop" }), undefined],
  ])("refuses %s", async (_, status, body, contentType) => {
    const by = await owner();
    const response = await pair(by, { body, ...(contentType ? { contentType } : {}) });
    expect(response.status).toBe(status);
    expect(Object.keys(await response.json())).toEqual(["error"]);
    expect(await ownerIdFor(by.subject)).toBeNull();
  });
});

describe("pairing limits and methods", () => {
  it("rate limits each identity", async () => {
    const by = await owner();
    const statuses: number[] = [];
    await awaitRoomInMinute();
    for (let attempt = 0; attempt < 11; attempt += 1)
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
      statuses.push((await pair(by)).status);
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 201));
    const limited = await pair(by);
    expect(statuses[10]).toBe(429);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(await devicesOf(by.subject)).toHaveLength(10);
    expect((await pair(await owner())).status).toBe(201);
  }, 20_000);

  it("answers no preflight and sends no CORS headers", async () => {
    const response = await request("/pair", {
      method: "OPTIONS",
      headers: {
        Origin: EXTENSION_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(corsHeaders(response)).toEqual([]);
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
    expect((await request("/pair")).status).toBe(405);
  });
});
