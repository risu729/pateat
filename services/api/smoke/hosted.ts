// Hosted smoke checks for a released server (docs/delivery.md). They exercise the
// deployed entry points over HTTPS: device bearer credentials, settings and recipe
// sync, revocation and Access in front of owner pages.
//
// The deploy job seeds synthetic owners and their devices through D1 itself, because
// pairing a device needs an owner's Access sign-in. Synthetic owners get no
// `owner_identities` row, so no sign-in can ever reach them, and every row they own
// is deleted afterwards.
//
// Node runs this file directly (type stripping), and the Worker tests import it, so
// it uses Web APIs only and imports nothing from the workspace.

/**
 * Runs one SQL statement and returns its rows. The D1 REST API binds every parameter
 * as text; integer columns convert numeric text on insert.
 */
export type Query = (sql: string, params?: string[]) => Promise<Record<string, unknown>[]>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Real owner IDs are UUIDs, so this prefix never matches one. */
export const SMOKE_OWNER_PREFIX = "smoke-";

/**
 * Every table holding owner rows, children first so foreign keys allow each delete.
 * A Worker test fails when a table with an `owner_id` column is missing here.
 */
export const OWNER_TABLES = [
  "recipe_revisions",
  "recipe_heads",
  "settings",
  "generation_attempts",
  "page_judgements",
  "inference_locks",
  "inference_spend",
  "inference_log",
  "inference_credentials",
  "devices",
  "profiles",
  "owner_identities",
] as const;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest).toHex();
}

/**
 * A device credential shaped like `createDeviceToken` in src/auth.ts and the digest
 * the service stores for it. A Worker test keeps the shape accepted.
 */
export async function createDeviceCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const credential = `pateat_device_${bytes.toBase64({ alphabet: "base64url", omitPadding: true })}`;
  return { credential, tokenHash: await sha256Hex(credential) };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Hosted smoke check failed: ${message}`);
}

/** Deletes every synthetic owner and its rows, including leftovers of a failed run. */
export async function removeSmokeOwners(query: Query) {
  const prefix = (column: string) => `substr(${column}, 1, ${SMOKE_OWNER_PREFIX.length}) = ?`;
  for (const table of OWNER_TABLES)
    // oxlint-disable-next-line no-await-in-loop -- Foreign keys need this order.
    await query(`DELETE FROM ${table} WHERE ${prefix("owner_id")}`, [SMOKE_OWNER_PREFIX]);
  await query(`DELETE FROM owners WHERE ${prefix("id")}`, [SMOKE_OWNER_PREFIX]);
  const [left] = await query(`SELECT count(*) AS count FROM owners WHERE ${prefix("id")}`, [
    SMOKE_OWNER_PREFIX,
  ]);
  check(left?.["count"] === 0, "synthetic owners remain after cleanup");
}

type Device = { ownerId: string; deviceId: string; credential: string };

function settingsDocument(hostname: string) {
  return {
    connections: [],
    excludedSites: [{ hostname, includeSubdomains: true }],
    siteDefaults: [],
    bindings: [],
  };
}

function recipeDocument(id: string, revision: number) {
  return {
    version: 1,
    id,
    revision,
    origin: "https://smoke.pateat.invalid",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [
          { slot: "username", target: { by: "id", value: "username" } },
          { slot: "password", target: { by: "id", value: "password" } },
        ],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "submit" }, purpose: "submit" },
    ],
    completion: [{ target: { by: "id", value: "welcome" } }],
    maxSubmissions: 1,
  };
}

/** Seeds a synthetic owner with one device; the owner row comes first for cleanup. */
async function seedOwner(query: Query): Promise<Device> {
  const ownerId = `${SMOKE_OWNER_PREFIX}${crypto.randomUUID()}`;
  const deviceId = crypto.randomUUID();
  const { credential, tokenHash } = await createDeviceCredential();
  const now = String(Date.now());
  await query("INSERT INTO owners (id, created_at) VALUES (?, ?)", [ownerId, now]);
  await query("INSERT INTO profiles (owner_id, id, name) VALUES (?, ?, 'Default')", [
    ownerId,
    deviceId,
  ]);
  await query(
    "INSERT INTO devices (id, owner_id, profile_id, token_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [deviceId, ownerId, deviceId, tokenHash, "Pateat smoke test", now, now],
  );
  return { ownerId, deviceId, credential };
}

function client(origin: string, fetch: Fetch) {
  return async (
    device: Device | string | undefined,
    path: string,
    method = "GET",
    body?: unknown,
  ) => {
    const headers = new Headers();
    const credential = typeof device === "string" ? device : device?.credential;
    if (credential) headers.set("Authorization", `Bearer ${credential}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: text ? JSON.parse(text) : null,
    };
  };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Seeds two synthetic owners and checks device authentication, settings and recipe
 * round trips, owner separation and revocation. Synthetic rows are always removed.
 * Returns the names of the passed checks for the release summary.
 */
export async function runHostedSmoke(origin: string, fetch: Fetch, query: Query) {
  const passed: string[] = [];
  const api = client(origin, fetch);
  await removeSmokeOwners(query);
  try {
    for (const credential of [undefined, `pateat_device_${"A".repeat(43)}`]) {
      // oxlint-disable-next-line no-await-in-loop -- Two independent requests.
      const refused = await api(credential, "/v1/settings");
      check(
        refused.status === 401 &&
          refused.headers.get("WWW-Authenticate") === 'Bearer realm="pateat"' &&
          same(refused.json, { error: "unauthorized" }),
        `a ${credential ? "unknown" : "missing"} credential answered ${refused.status}`,
      );
    }
    passed.push("Missing and unknown device credentials are refused.");

    const first = await seedOwner(query);
    const second = await seedOwner(query);

    const empty = { version: 1, profileId: first.deviceId, revision: 0, settings: null };
    check(same((await api(first, "/v1/settings")).json, empty), "a new owner has settings");
    const settings = settingsDocument("smoke.pateat.invalid");
    const written = await api(first, "/v1/settings", "PUT", {
      version: 1,
      expectedRevision: 0,
      settings,
    });
    const stored = { version: 1, profileId: first.deviceId, revision: 1, settings };
    check(written.status === 200 && same(written.json, stored), `settings write ${written.status}`);
    check(same((await api(first, "/v1/settings")).json, stored), "settings did not read back");
    passed.push("Settings round trip through D1.");

    const recipeId = "smoke.recipe";
    const published = await api(first, `/v1/recipes/${recipeId}`, "PUT", {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: recipeDocument(recipeId, 1),
    });
    check(published.status === 200, `recipe write ${published.status}`);
    const changes = (await api(first, "/v1/recipes")).json as { changes?: unknown[] };
    check(
      changes.changes?.length === 1 && same(changes.changes[0], published.json.change),
      "the recipe did not read back",
    );
    passed.push("Recipe round trip through D1.");

    check(
      same((await api(second, "/v1/settings")).json, { ...empty, profileId: second.deviceId }),
      "another owner's settings leaked",
    );
    const others = (await api(second, "/v1/recipes")).json as { changes?: unknown[] };
    check(others.changes?.length === 0, "another owner's recipes leaked");
    const separate = await api(second, `/v1/recipes/${recipeId}`, "PUT", {
      version: 1,
      expectedRevision: 0,
      state: "active",
      recipe: recipeDocument(recipeId, 1),
    });
    check(
      separate.status === 200,
      `the same recipe ID for another owner answered ${separate.status}`,
    );
    check(
      same((await api(first, "/v1/settings")).json, stored) &&
        same(((await api(first, "/v1/recipes")).json as { changes?: unknown[] }).changes, [
          published.json.change,
        ]),
      "another owner's write changed the first owner's data",
    );
    passed.push("Owners cannot read or change each other's settings and recipes.");

    const revoked = await api(first, "/v1/device", "DELETE");
    check(revoked.status === 204, `device revocation answered ${revoked.status}`);
    for (const path of ["/v1/settings", "/v1/recipes"]) {
      // oxlint-disable-next-line no-await-in-loop -- Two independent requests.
      const refused = await api(first, path);
      check(
        refused.status === 401 && same(refused.json, { error: "device_revoked" }),
        `a revoked device answered ${refused.status} on ${path}`,
      );
    }
    check((await api(second, "/v1/settings")).status === 200, "revocation affected another owner");
    passed.push("A revoked device is refused; other owners keep working.");
  } catch (error) {
    // Report the failed check even when cleanup fails as well.
    await removeSmokeOwners(query).catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], "A check and the cleanup after it failed", {
        cause: error,
      });
    });
    throw error;
  }
  await removeSmokeOwners(query);
  passed.push("Every synthetic row was removed.");
  return passed;
}

/**
 * Owner pages must be answered by Access, not the Worker, even with a forged token
 * header. Access marks its own responses with `Cf-Access-Domain` or sends the
 * browser to the team's sign-in.
 */
export async function checkAccessGate(origin: string, fetch: Fetch) {
  const { host } = new URL(origin);
  const paths = ["/manage", "/manage/api/devices"];
  const responses = await Promise.all(
    paths.map((path) =>
      fetch(`${origin}${path}`, {
        redirect: "manual",
        headers: { "Cf-Access-Jwt-Assertion": "a.b.c" },
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    const location = response.headers.get("Location");
    const signIn = location
      ? new URL(location, origin).hostname.endsWith(".cloudflareaccess.com")
      : false;
    check(
      response.status >= 300 &&
        response.status < 500 &&
        (response.headers.get("Cf-Access-Domain") === host || signIn),
      `${paths[index]} was not stopped by Access (${response.status})`,
    );
  }
  await Promise.all(responses.map((response) => response.body?.cancel()));
  return "Access answers owner pages before the Worker.";
}

/** Runs statements through the D1 REST API with the deploy job's token. */
export function d1Api(accountId: string, databaseId: string, token: string, fetch: Fetch): Query {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return async (sql, params = []) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000),
    });
    let body: {
      success?: boolean;
      errors?: { code?: number; message?: string }[];
      result?: { success?: boolean; results?: Record<string, unknown>[] }[];
    } = {};
    try {
      body = JSON.parse(await response.text());
    } catch {
      // An error page; the status below still names the failure.
    }
    const [result] = body.result ?? [];
    if (!response.ok || !body.success || !result?.success)
      throw new Error(
        `D1 query failed (${response.status}): ${(body.errors ?? []).map((error) => `${error.code} ${error.message}`).join("; ")}`,
      );
    return result.results ?? [];
  };
}

async function main() {
  const { appendFile } = await import("node:fs/promises");
  const env = process.env;
  const health = env["SERVER_HEALTH_URL"] ?? "";
  check(URL.canParse(health), "SERVER_HEALTH_URL is not a URL");
  const { origin } = new URL(health);
  const account = env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  const database = env["DATABASE"] ?? "";
  const token = env["CLOUDFLARE_API_TOKEN"] ?? "";
  check(origin.startsWith("https://"), "SERVER_HEALTH_URL must be an HTTPS URL");
  check(/^[0-9a-f]{32}$/.test(account), "CLOUDFLARE_ACCOUNT_ID is not an account ID");
  check(/^[0-9a-f-]{36}$/.test(database), "DATABASE is not a D1 database ID");
  check(token.length > 0, "CLOUDFLARE_API_TOKEN is missing");

  const hosted: Fetch = (url, init) =>
    fetch(url, {
      signal: AbortSignal.timeout(10_000),
      ...init,
      redirect: init?.redirect ?? "error",
    });
  const passed = [
    await checkAccessGate(origin, hosted),
    ...(await runHostedSmoke(origin, hosted, d1Api(account, database, token, fetch))),
  ];
  const summary = ["## Hosted smoke checks passed", ...passed.map((line) => `- ${line}`), ""];
  console.log(summary.join("\n"));
  if (env["GITHUB_STEP_SUMMARY"]) await appendFile(env["GITHUB_STEP_SUMMARY"], summary.join("\n"));
}

if (import.meta.main) await main();
