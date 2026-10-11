// Hosted smoke checks for a released server (docs/delivery.md). They exercise the
// deployed entry points over HTTPS: anonymous redemption, device bearer credentials,
// settings and recipe sync, revocation and Access in front of owner pages.
//
// The deploy job seeds synthetic owners through D1 itself, because an owner's own
// approval needs an Access sign-in. Synthetic owners get no `owner_identities` row,
// so no sign-in can ever reach them, and every row they own is deleted afterwards.
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
  "enrollments",
  "generation_attempts",
  "inference_locks",
  "inference_spend",
  "inference_log",
  "inference_credentials",
  "devices",
  "owner_identities",
] as const;

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    const length = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    for (let digit = 0; digit < length; digit += 1)
      output += BASE64URL[(chunk >> (18 - digit * 6)) & 63];
  }
  return output;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The extension's pairing values for a fresh verifier: its challenge and the code the
 * owner would type. A Worker test keeps these equal to `@pateat/contracts`.
 */
export async function createPairing() {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encodeBase64Url(await sha256(verifier));
  const digest = await sha256(`pateat-enrollment-code:${verifier}`);
  let bits = 0n;
  for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let index = 7; index >= 0; index -= 1)
    code += CROCKFORD[Number((bits >> BigInt(index * 5)) & 31n)];
  return { verifier, challenge, code: `${code.slice(0, 4)}-${code.slice(4)}` };
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
    completion: { path: "/home", target: { by: "id", value: "welcome" } },
    maxSubmissions: 1,
  };
}

/**
 * Seeds a synthetic owner with one approved pairing, then redeems it anonymously
 * like the extension does. The owner exists before any device, so a failed redeem
 * still leaves only rows that cleanup removes.
 */
async function pairOwner(origin: string, fetch: Fetch, query: Query): Promise<Device> {
  const ownerId = `${SMOKE_OWNER_PREFIX}${crypto.randomUUID()}`;
  const pairing = await createPairing();
  const now = Date.now();
  await query("INSERT INTO owners (id, created_at) VALUES (?, ?)", [ownerId, String(now)]);
  await query(
    "INSERT INTO enrollments (challenge, owner_id, label, code, approved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      pairing.challenge,
      ownerId,
      "Pateat smoke test",
      pairing.code,
      String(now),
      String(now + ENROLLMENT_TTL_MS),
    ],
  );
  const redeem = () =>
    fetch(`${origin}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, verifier: pairing.verifier }),
    });
  const response = await redeem();
  check(response.status === 200, `redeem answered ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const { deviceId, credential } = body;
  check(
    body["version"] === 1 &&
      typeof deviceId === "string" &&
      typeof credential === "string" &&
      /^pateat_device_[A-Za-z0-9_-]{43}$/.test(credential),
    "redeem returned an unexpected body",
  );
  const replay = await redeem();
  check(replay.status === 404, `a redeemed pairing answered ${replay.status} on replay`);

  // Only a hex SHA-256 digest of the credential is stored.
  const [row] = await query("SELECT owner_id, token_hash FROM devices WHERE id = ?", [deviceId]);
  const digest = [...(await sha256(credential))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  check(row?.["owner_id"] === ownerId, "the redeemed device belongs to another owner");
  check(row?.["token_hash"] === digest, "the stored device credential is not its digest");
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
 * Pairs two synthetic owners and checks device authentication, settings and recipe
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

    const first = await pairOwner(origin, fetch, query);
    const second = await pairOwner(origin, fetch, query);
    passed.push("Two synthetic owners paired through /redeem; a pairing redeems once.");

    const empty = { version: 1, revision: 0, settings: null };
    check(same((await api(first, "/v1/settings")).json, empty), "a new owner has settings");
    const settings = settingsDocument("smoke.pateat.invalid");
    const written = await api(first, "/v1/settings", "PUT", {
      version: 1,
      expectedRevision: 0,
      settings,
    });
    const stored = { version: 1, revision: 1, settings };
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

    check(same((await api(second, "/v1/settings")).json, empty), "another owner's settings leaked");
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
  } finally {
    await removeSmokeOwners(query);
  }
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
  const paths = ["/manage", "/manage/api/devices", "/enroll"];
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
    const body = (await response.json()) as {
      success?: boolean;
      errors?: { code?: number; message?: string }[];
      result?: { success?: boolean; results?: Record<string, unknown>[] }[];
    };
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
