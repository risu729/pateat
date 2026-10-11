import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { html } from "hono/html";
import { requireAccess } from "../access";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import {
  resolveClaudeCredential,
  saveWifCredential,
  wifIdentifiersSchema,
  type WifIdentifiers,
} from "../claude/credentials";
import { ASSERTION_AUDIENCE, ownerSubject, readIssuerConfig } from "../claude/issuer";
import { inferenceCredentials } from "../db/schema";
import { findOwner } from "../owners";
import { message, page } from "../pages";
import { requireFormBody } from "../validation";

// A temporary script-free page for entering the owner's Workload Identity Federation
// identifiers (ADR 0015). The owner chose it so WIF can be tried before the React web UI
// exists; that UI replaces it.

const FIELDS = [
  ["federationRuleId", "Federation rule ID", "fdrl_…"],
  ["organizationId", "Organization ID", "00000000-0000-0000-0000-000000000000"],
  ["serviceAccountId", "Service account ID", "svac_…"],
  ["workspaceId", "Workspace ID", "wrkspc_…"],
] as const satisfies readonly (readonly [keyof WifIdentifiers, string, string])[];

const formField = v.optional(v.pipe(v.string(), v.maxLength(200), v.trim()), "");
const formSchema = v.object({
  federationRuleId: formField,
  organizationId: formField,
  serviceAccountId: formField,
  workspaceId: formField,
});

type FormValues = Record<keyof WifIdentifiers, string>;

const STATUS_TEXT = {
  not_configured: "Save the identifiers first.",
  issuer_unavailable: "This server's OIDC issuer is not configured, so nothing can be signed.",
  rejected:
    "Anthropic refused the assertion. Check the identifiers and the rule, then look at the authentication history in the Claude Console for the reason.",
  failed: "The token exchange did not complete. Try again later.",
} as const;

async function storedValues(db: D1Database, ownerId: string): Promise<FormValues | null> {
  const [row] = await drizzle(db)
    .select()
    .from(inferenceCredentials)
    .where(eq(inferenceCredentials.ownerId, ownerId))
    .limit(1);
  return row
    ? {
        federationRuleId: row.federationRuleId,
        organizationId: row.organizationId,
        serviceAccountId: row.serviceAccountId,
        workspaceId: row.workspaceId,
      }
    : null;
}

function settingsPage(
  c: Parameters<typeof page>[0],
  status: 200 | 400,
  ownerId: string,
  values: FormValues | null,
  notice?: string,
) {
  const issuer = readIssuerConfig(c.env)?.issuer;
  return page(
    c,
    status,
    "Claude",
    html`${notice ? html`<p role="status"><strong>${notice}</strong></p>` : ""}
      <p>
        Pateat signs in to Claude with Workload Identity Federation in your own Anthropic
        organization. In the Claude Console, open Settings, Workload identity, Connect workload,
        Custom OIDC, and use these values:
      </p>
      <table>
        <tbody>
          <tr>
            <th scope="row">Issuer URL</th>
            <td><code>${issuer ?? "Not configured on this server"}</code></td>
          </tr>
          <tr>
            <th scope="row">Subject (exact match)</th>
            <td><code>${ownerSubject(ownerId)}</code></td>
          </tr>
          <tr>
            <th scope="row">Audience (optional match)</th>
            <td><code>${ASSERTION_AUDIENCE}</code></td>
          </tr>
          <tr>
            <th scope="row">Scope</th>
            <td><code>workspace:inference</code></td>
          </tr>
        </tbody>
      </table>
      <p>Then copy the identifiers the Console shows for that rule. None of them is a secret.</p>
      <form method="post" action="/manage/claude">
        ${FIELDS.map(
          ([name, label, placeholder]) =>
            html`<p>
              <label
                >${label}<br /><input
                  name="${name}"
                  value="${values?.[name] ?? ""}"
                  placeholder="${placeholder}"
                  required
                  autocomplete="off"
                  spellcheck="false"
                  size="44"
              /></label>
            </p>`,
        )}
        <p><button type="submit">Save</button></p>
      </form>
      <form method="post" action="/manage/claude/test">
        <p>
          <button type="submit">Test the token exchange</button> Asks Anthropic for a token without
          calling Claude, so it costs nothing.
        </p>
      </form>`,
  );
}

/**
 * Guards its own routes instead of relying on the app-wide `/manage/*` middleware, so
 * it stays Access-only and same-origin if that middleware changes.
 */
export const manageClaudeRoutes = new Hono<ApiEnv>()
  .use(
    requireAccess,
    csrf(),
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) => message(c, 413, "Too large", "The form was too large."),
    }),
  )
  .get("/", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return message(c, 404, "Not found", "Pair a device with this account first.");
    return settingsPage(c, 200, ownerId, await storedValues(c.env.DB, ownerId));
  })
  .post("/", requireFormBody, async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return message(c, 404, "Not found", "Pair a device with this account first.");
    const form = v.safeParse(formSchema, await c.req.parseBody());
    if (!form.success) return message(c, 400, "Invalid request", "The form was malformed.");
    const ids = v.safeParse(wifIdentifiersSchema, form.output);
    if (!ids.success)
      return settingsPage(
        c,
        400,
        ownerId,
        form.output,
        "Check the identifiers: fdrl_…, an organization UUID, svac_… and wrkspc_….",
      );
    await saveWifCredential(c.env.DB, ownerId, ids.output);
    return c.redirect("/manage/claude", 303);
  })
  .post("/test", requireFormBody, async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return message(c, 404, "Not found", "Pair a device with this account first.");
    const result = await resolveClaudeCredential(c.env, ownerId);
    // The token itself is discarded; only the outcome is shown.
    const notice =
      result.status === "ready"
        ? `Anthropic issued a token valid for ${Math.round((result.expiresAt - Date.now()) / 60_000)} minutes.`
        : STATUS_TEXT[result.status] +
          ("httpStatus" in result && result.httpStatus ? ` (HTTP ${result.httpStatus})` : "");
    return settingsPage(c, 200, ownerId, await storedValues(c.env.DB, ownerId), notice);
  });
