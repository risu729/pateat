import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { inferenceCredentials } from "../db/schema";
import { readIssuerConfig, signOwnerAssertion } from "./issuer";

// The one place that turns an owner into Claude credentials (ADR 0015). Today the only
// kind is Workload Identity Federation; a registered, encrypted API key is a later kind.

// Pinned like the generation adapter's base URL; nothing in the environment redirects it.
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const EXCHANGE_TIMEOUT_MS = 10_000;

/** The identifiers an owner copies from their federation rule. None is a secret. */
export const wifIdentifiersSchema = v.strictObject({
  federationRuleId: v.pipe(v.string(), v.regex(/^fdrl_[A-Za-z0-9]{1,64}$/)),
  organizationId: v.pipe(v.string(), v.uuid()),
  serviceAccountId: v.pipe(v.string(), v.regex(/^svac_[A-Za-z0-9]{1,64}$/)),
  workspaceId: v.pipe(v.string(), v.regex(/^wrkspc_[A-Za-z0-9]{1,64}$/)),
});
export type WifIdentifiers = v.InferOutput<typeof wifIdentifiersSchema>;

const tokenResponseSchema = v.object({
  access_token: v.pipe(v.string(), v.nonEmpty()),
  token_type: v.picklist(["Bearer", "bearer"]),
  expires_in: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type ClaudeCredentialResult =
  | { status: "ready"; credential: { authToken: string }; expiresAt: number }
  /** The owner has not registered credentials. */
  | { status: "not_configured" }
  /** The operator has not configured the issuer, so nothing can be signed. */
  | { status: "issuer_unavailable" }
  /** Anthropic refused the assertion: wrong identifiers, or the rule was archived. */
  | { status: "rejected"; httpStatus: number }
  /** Network failure, timeout, server error or an unexpected response. */
  | { status: "failed"; httpStatus?: number };

type CredentialEnv = {
  DB: D1Database;
  OIDC_ISSUER?: string | undefined;
  OIDC_SIGNING_KEYS?: string | undefined;
};

export async function saveWifCredential(db: D1Database, ownerId: string, ids: WifIdentifiers) {
  const row = {
    kind: "wif" as const,
    ...v.parse(wifIdentifiersSchema, ids),
    updatedAt: Date.now(),
  };
  await drizzle(db)
    .insert(inferenceCredentials)
    .values({ ownerId, ...row })
    .onConflictDoUpdate({ target: inferenceCredentials.ownerId, set: row });
}

/**
 * Resolves the owner's Claude credential. `ownerId` must come from the authenticated
 * request scope, never from a body or path: the assertion is signed for that owner.
 * Every call signs a new single-use assertion and exchanges it once.
 */
export async function resolveClaudeCredential(
  env: CredentialEnv,
  ownerId: string,
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {},
): Promise<ClaudeCredentialResult> {
  const [row] = await drizzle(env.DB)
    .select()
    .from(inferenceCredentials)
    .where(eq(inferenceCredentials.ownerId, ownerId))
    .limit(1);
  if (!row) return { status: "not_configured" };
  // Stored rows are revalidated like every other stored document.
  const ids = v.parse(wifIdentifiersSchema, {
    federationRuleId: row.federationRuleId,
    organizationId: row.organizationId,
    serviceAccountId: row.serviceAccountId,
    workspaceId: row.workspaceId,
  });

  const config = readIssuerConfig(env);
  if (!config) return { status: "issuer_unavailable" };
  const now = options.now ?? Date.now;
  let assertion: string;
  try {
    assertion = await signOwnerAssertion(config, ownerId, now());
  } catch {
    // A key that passed the shape check but does not import is a configuration error.
    return { status: "issuer_unavailable" };
  }

  let response: Response;
  try {
    // Building the Request first lets the runtime validate every option, test seam or not.
    const request = new Request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
        federation_rule_id: ids.federationRuleId,
        organization_id: ids.organizationId,
        service_account_id: ids.serviceAccountId,
        workspace_id: ids.workspaceId,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      // workerd has no "error" mode; a 3xx is not ok and ends as failed below.
      redirect: "manual",
    });
    response = await (options.fetch ?? globalThis.fetch)(request);
  } catch {
    return { status: "failed" };
  }
  // Anthropic answers every denied assertion with the same opaque 401; the reason is
  // only in the owner's Console authentication history.
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 400 || response.status === 401 || response.status === 403
      ? { status: "rejected", httpStatus: response.status }
      : { status: "failed", httpStatus: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "failed", httpStatus: response.status };
  }
  const token = v.safeParse(tokenResponseSchema, body);
  if (!token.success) return { status: "failed", httpStatus: response.status };
  return {
    status: "ready",
    credential: { authToken: token.output.access_token },
    expiresAt: now() + token.output.expires_in * 1000,
  };
}
