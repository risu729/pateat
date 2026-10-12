import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Response, type Request } from "miniflare";

const project = fileURLToPath(new URL("../../services/api/", import.meta.url));
const workerDirectory = join(project, ".cloudflare", "output", "v0", "workers", "default");

/** One request as the Access stand-in received it. */
export type FrontRequest = {
  method: string;
  path: string;
  origin: string | null;
  cookie: string | null;
};

export type SyncService = {
  /** The HTTPS origin the extension pairs with; its certificate is self-signed. */
  origin: string;
  deviceId: string;
  credential: string;
  /** With `access`: every request the Access stand-in received, in order. */
  requests: FrontRequest[];
  /** Calls the API as the paired device without going through the browser. */
  request(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  /** Every device row, oldest first. */
  devices(): Promise<{ id: string; label: string; revoked_at: number | null }[]>;
  /** Stops the service; later calls wait for the same shutdown. */
  close(): Promise<void>;
};

// Synthetic Access settings; they name no real Cloudflare organization.
const ACCESS_TEAM_DOMAIN = "pateat-test.cloudflareaccess.com";
const ACCESS_AUD = "pateat-test-audience";
/** The audience of the "pateat pair" application, which covers `/pair` (ADR 0030). */
const ACCESS_PAIR_AUD = "pateat-test-pair-audience";
/** The session cookie the stand-in accepts, as `context.addCookies` sets it. */
export const ACCESS_COOKIE = { name: "CF_Authorization", value: "synthetic" };
/** Paths the real "pateat bypass" Access application exempts (docs/delivery.md). */
const BYPASS = /^\/(?:v1\/|health$|\.well-known\/(?:openid-configuration|jwks\.json)$)/;
/** Paths the real "pateat pair" Access application covers: `/pair` and below it. */
const PAIR = /^\/pair(?:\/|$)/;

/**
 * Plays Cloudflare Access in front of the Worker: bypassed paths pass through, a request
 * carrying the session cookie gets a signed assertion, and any other request is
 * redirected to a login page, as Access does for a browser without a session.
 */
const FRONT_MODULE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/cdn-cgi/access/login")
      return new Response("<!doctype html><title>Synthetic sign-in</title><p>Synthetic sign-in</p>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    const decision = await fetch("https://access-front.invalid/decide", {
      method: "POST",
      body: JSON.stringify({
        method: request.method,
        path: url.pathname,
        origin: request.headers.get("Origin"),
        cookie: request.headers.get("Cookie"),
      }),
    });
    const { pass, assertion } = await decision.json();
    if (!pass) return new Response(null, { status: 302, headers: { Location: "/cdn-cgi/access/login" } });
    const headers = new Headers(request.headers);
    headers.delete("Cf-Access-Jwt-Assertion");
    if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
    return env.API.fetch(new Request(request, { headers }));
  },
};
`;

const base64Url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

/** A synthetic RS256 Access key and a signer for application tokens. */
async function createAccessSigner() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const kid = "synthetic-access-key";
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
    async sign(subject: string, audience: string) {
      const now = Math.floor(Date.now() / 1000);
      const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
      const payload = base64Url(
        JSON.stringify({
          iss: `https://${ACCESS_TEAM_DOMAIN}`,
          aud: [audience],
          sub: subject,
          iat: now,
          nbf: now,
          exp: now + 600,
          type: "app",
        }),
      );
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}

/**
 * Serves the built API Worker (`mise run //services/api:build`) on loopback HTTPS with a fresh
 * local D1 database, one owner and one device. Nothing leaves the machine.
 *
 * `claude` answers the Worker's requests to `https://api.anthropic.com` in place of
 * Anthropic: it gets the path and request body and returns the JSON answer. With it the
 * owner gets synthetic workload identity federation settings and a per-run issuer key,
 * so the recipe generation routes can call the model.
 *
 * `access` puts a loopback stand-in for Cloudflare Access in front of the Worker and
 * gives the Worker synthetic Access settings and a per-run signing key. A request with
 * the `ACCESS_COOKIE` session reaches the owner routes, including `POST /pair`, as one
 * synthetic identity; the Worker keeps its built `PAIRING_EXTENSION_IDS`. Assertions
 * for paths under `/pair` carry the pairing application's audience, as the real
 * "pateat pair" application's do, and every other assertion carries `ACCESS_AUD`.
 */
export async function startSyncService({
  claude,
  access = false,
}: {
  claude?: (path: string, body: string) => unknown;
  access?: boolean;
} = {}): Promise<SyncService> {
  const config = JSON.parse(await readFile(join(workerDirectory, "worker.config.json"), "utf8"));
  const signer = access ? await createAccessSigner() : undefined;
  const requests: FrontRequest[] = [];
  if (access) {
    config.env.ACCESS_TEAM_DOMAIN = { type: "json", value: ACCESS_TEAM_DOMAIN };
    config.env.ACCESS_AUD = { type: "json", value: ACCESS_AUD };
    config.env.ACCESS_PAIR_AUD = { type: "json", value: ACCESS_PAIR_AUD };
  } else {
    // Owner pages need Cloudflare Access; device sync routes do not use it.
    delete config.env?.ACCESS_TEAM_DOMAIN;
    delete config.env?.ACCESS_AUD;
    delete config.env?.ACCESS_PAIR_AUD;
  }
  if (claude) {
    // A synthetic ES256 issuer key generated per run; it never signs for a real organization.
    const key = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", key.privateKey);
    config.env.OIDC_ISSUER = { type: "json", value: "https://pateat.invalid" };
    config.env.OIDC_SIGNING_KEYS = {
      type: "json",
      value: JSON.stringify({
        signingKeyId: "synthetic",
        keys: [{ kty, crv, alg: "ES256", kid: "synthetic", x, y, d }],
      }),
    };
  }
  const mainModule: string = config.manifest.mainModule;
  const front = signer && {
    config: {
      name: "access-front",
      compatibilityDate: config.compatibilityDate,
      env: { API: { type: "worker", worker: config.name } },
      manifest: {
        mainModule: "front.js",
        modules: { "front.js": { type: "esm", contents: FRONT_MODULE } },
      },
    },
    dev: {
      outboundService: {
        type: "fetcher" as const,
        async handler(request: Request) {
          const seen = (await request.json()) as FrontRequest;
          requests.push(seen);
          if (BYPASS.test(seen.path)) return Response.json({ pass: true });
          const session = (seen.cookie ?? "")
            .split(";")
            .some((part) => part.trim() === `${ACCESS_COOKIE.name}=${ACCESS_COOKIE.value}`);
          return Response.json(
            session
              ? {
                  pass: true,
                  assertion: await signer.sign(
                    "synthetic-owner",
                    PAIR.test(seen.path) ? ACCESS_PAIR_AUD : ACCESS_AUD,
                  ),
                }
              : { pass: false },
          );
        },
      },
    },
  };
  const runtime = new Miniflare({
    https: true,
    host: "127.0.0.1",
    port: 0,
    workers: [
      // The first worker answers the HTTPS port.
      ...(front ? [front] : []),
      {
        config: {
          ...config,
          // The owner web UI's built assets; device sync does not use them.
          assets: {
            ...config.assets,
            directory: join(workerDirectory, "assets"),
            hasUserWorker: true,
          },
          manifest: {
            mainModule,
            modules: {
              [mainModule]: {
                type: "esm",
                contents: await readFile(join(workerDirectory, "bundle", mainModule), "utf8"),
              },
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            async handler(request) {
              const url = new URL(request.url);
              if (claude && url.origin === "https://api.anthropic.com")
                return Response.json(claude(url.pathname, await request.text()));
              if (signer && url.href === `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)
                return Response.json(signer.jwks);
              throw new Error("The API Worker must not make other outbound requests");
            },
          },
        },
      },
    ],
  });
  try {
    const url = await runtime.ready;
    const db = await runtime.getD1Database("DB", config.name);
    const migrations = join(project, "migrations");
    for (const name of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort())
      for (const statement of (await readFile(join(migrations, name), "utf8")).split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await db.prepare(statement).run();

    const ownerId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const credential = `pateat_device_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
    const tokenHash = Buffer.from(digest).toString("hex");
    const now = Date.now();
    await db.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, now).run();
    await db
      .prepare(
        "INSERT INTO devices (id, owner_id, token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(deviceId, ownerId, tokenHash, "Synthetic test device", now, now)
      .run();
    if (claude)
      await db
        .prepare(
          "INSERT INTO inference_credentials (owner_id, kind, federation_rule_id, organization_id, service_account_id, workspace_id, updated_at) VALUES (?, 'wif', ?, ?, ?, ?, ?)",
        )
        .bind(
          ownerId,
          "fdrl_01SyntheticRule",
          "00000000-0000-4000-8000-000000000000",
          "svac_01SyntheticAccount",
          "wrkspc_01SyntheticWorkspace",
          now,
        )
        .run();

    const origin = url.origin;
    let closed: Promise<void> | undefined;
    return {
      origin,
      deviceId,
      credential,
      requests,
      devices: async () =>
        (
          await db
            .prepare("SELECT id, label, revoked_at FROM devices ORDER BY created_at, rowid")
            .all<{ id: string; label: string; revoked_at: number | null }>()
        ).results,
      request: (path, init = {}) =>
        runtime.dispatchFetch(`${origin}${path}`, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }) as unknown as Promise<Response>,
      // Safe to call again, e.g. from a `finally` after a test already stopped it.
      close: () => (closed ??= runtime.dispose()),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
