/* oxlint-disable no-await-in-loop -- Ordered credential writes and owner checks verify persisted state between operations. */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { claims, installAccessKeys, ISSUER, ORIGIN, signAccess } from "./access-helpers";

installAccessKeys();
const API = `${ORIGIN}/manage/api/openai`;
const SECRET = "synthetic-owner-openai-key-not-for-provider-use";
const configured = {
  ...env,
  ACCESS_TEAM_DOMAIN: "pateat-test.cloudflareaccess.com",
  ACCESS_AUD: "pateat-test-audience",
  INFERENCE_CREDENTIAL_KEY: "42".repeat(32),
};
let providerRequests = 0;
beforeAll(() => {
  const accessFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (new Request(input, init).url === `${ISSUER}/cdn-cgi/access/certs`)
      return accessFetch(input, init);
    providerRequests += 1;
    throw new Error("Credential management must not call a provider");
  });
});

async function owner(paired = true) {
  const ownerId = crypto.randomUUID();
  const subject = crypto.randomUUID();
  if (paired)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, 1)").bind(ownerId),
      env.DB.prepare(
        "INSERT INTO owner_identities (issuer, subject, owner_id, created_at) VALUES (?, ?, ?, 1)",
      ).bind(ISSUER, subject, ownerId),
    ]);
  return { ownerId, token: await signAccess(claims(subject)) };
}

function request(
  token: string | undefined,
  method = "GET",
  body?: unknown,
  bindings = configured,
  origin: string | null = ORIGIN,
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  if (origin !== null) headers.set("Origin", origin);
  return app.request(
    API,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

describe("OpenAI owner credential management", () => {
  it("saves, replaces and deletes only that owner's key, returning status without a provider call", async () => {
    const [alice, bob] = await Promise.all([owner(), owner()]);
    expect(await (await request(alice.token)).json()).toEqual({
      version: 1,
      configured: false,
      storage: "ready",
      storedInvalid: false,
    });
    for (const key of [SECRET, "synthetic-replacement-openai-key"]) {
      const saved = await request(alice.token, "PUT", { version: 1, apiKey: key });
      expect(saved.status).toBe(200);
      const text = await saved.text();
      expect(text).not.toContain(key);
      expect(JSON.parse(text)).toEqual({
        version: 1,
        configured: true,
        storage: "ready",
        storedInvalid: false,
      });
    }
    expect(await (await request(bob.token)).json()).toMatchObject({ configured: false });
    expect((await request(bob.token, "DELETE")).status).toBe(200);
    expect(await (await request(alice.token)).json()).toMatchObject({ configured: true });
    expect((await request(alice.token, "DELETE")).status).toBe(200);
    expect(await (await request(alice.token)).json()).toMatchObject({ configured: false });
    expect(providerRequests).toBe(0);
  });

  it("requires Access and a paired owner for every operation", async () => {
    const stranger = await owner(false);
    for (const method of ["GET", "PUT", "DELETE"]) {
      const body = method === "PUT" ? { version: 1, apiKey: SECRET } : undefined;
      expect((await request(undefined, method, body)).status).toBe(401);
      expect((await request("not-a-token", method, body)).status).toBe(403);
      const unpaired = await request(stranger.token, method, body);
      expect(unpaired.status).toBe(404);
      expect(await unpaired.json()).toEqual({ error: "not_paired" });
    }
  });

  it("rejects cross-origin or originless writes without changing the key", async () => {
    const alice = await owner();
    expect((await request(alice.token, "PUT", { version: 1, apiKey: SECRET })).status).toBe(200);
    for (const origin of ["https://attacker.invalid", "null", null]) {
      for (const method of ["PUT", "DELETE"]) {
        const body = method === "PUT" ? { version: 1, apiKey: "replacement" } : undefined;
        expect((await request(alice.token, method, body, configured, origin)).status).toBe(403);
      }
    }
    expect(await (await request(alice.token)).json()).toMatchObject({ configured: true });
  });

  it("refuses invalid input and unavailable encryption storage without echoing credentials", async () => {
    const alice = await owner();
    for (const body of [
      { version: 1, apiKey: " " },
      { version: 1, apiKey: "x".repeat(513) },
      { version: 1, apiKey: SECRET, provider: "anthropic" },
      { version: 1 },
    ]) {
      const response = await request(alice.token, "PUT", body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(SECRET);
    }
    const unavailable = { ...configured, INFERENCE_CREDENTIAL_KEY: "invalid" };
    const failed = await request(alice.token, "PUT", { version: 1, apiKey: SECRET }, unavailable);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "credential_storage_unavailable" });
    expect(await (await request(alice.token)).json()).toMatchObject({ configured: false });
    expect(providerRequests).toBe(0);
  });
});
