import type { GenerationUnavailableReason, ModelChoice } from "@pateat/contracts";
import type { ClaudeCredential } from "@pateat/inference";
import { resolveOpenAICredential } from "../openai/credentials";
import { readWifCredential, resolveClaudeCredential } from "./credentials";
import { readIssuerConfig, signingKeyImports } from "./issuer";
import type { CallEnv } from "./call-types";

export type ModelCredential = ClaudeCredential;
type Provider = ModelChoice["provider"];
const failures = {
  not_configured: "credentials-not-configured",
  rejected: "credentials-rejected",
  issuer_unavailable: "issuer-unavailable",
  failed: "token-exchange-failed",
} as const;

/** Local availability check before an operator-paid Clef call; never exchanges a token. */
export async function providerUnavailable(
  env: CallEnv,
  ownerId: string,
  provider: Provider,
): Promise<GenerationUnavailableReason | undefined> {
  if (provider === "openai") {
    const result = await resolveOpenAICredential(env, ownerId);
    return result.status === "ready"
      ? undefined
      : result.status === "not_configured"
        ? "credentials-not-configured"
        : "credentials-unavailable";
  }
  if (!(await readWifCredential(env.DB, ownerId))) return "credentials-not-configured";
  const issuer = readIssuerConfig(env);
  return issuer && (await signingKeyImports(issuer)) ? undefined : "issuer-unavailable";
}

/** Resolves only the provider this attempt will call. Secrets stay inside the request. */
export async function resolveModelCredential(
  env: CallEnv,
  ownerId: string,
  provider: Provider,
): Promise<
  | { status: "ready"; credential: ModelCredential }
  | { status: "unavailable"; reason: GenerationUnavailableReason }
> {
  if (provider === "openai") {
    const result = await resolveOpenAICredential(env, ownerId);
    return result.status === "ready"
      ? { status: "ready", credential: result.credential }
      : {
          status: "unavailable",
          reason:
            result.status === "not_configured"
              ? "credentials-not-configured"
              : "credentials-unavailable",
        };
  }
  const result = await resolveClaudeCredential(env, ownerId);
  return result.status === "ready"
    ? { status: "ready", credential: result.credential }
    : { status: "unavailable", reason: failures[result.status] };
}
