import * as v from "valibot";

// Clef's models, rates and REST URL, without the adapter, for a caller that prices or
// checks a call it sends itself (ADR 0083).

/**
 * Cloudflare's Clef decision models on Workers AI, with their published input rates (Clef
 * charges no output tokens) and context windows. Checked 2026-11-03 on
 * https://developers.cloudflare.com/workers-ai/platform/pricing/ and each model's page.
 */
export const clefModels = {
  "clef-flash": { inputUsdPerMillion: 0.038, contextTokens: 24_576 },
  clef: { inputUsdPerMillion: 0.24, contextTokens: 65_536 },
  "clef-omni": { inputUsdPerMillion: 0.15, contextTokens: 64_000 },
} as const;
export type ClefModelId = keyof typeof clefModels;
export const isClefModel = (modelId: string): modelId is ClefModelId =>
  Object.hasOwn(clefModels, modelId);

/** Estimated cost from reported input tokens; undefined when usage is unknown. */
export function estimateClefCostUsd(
  inputTokens: number | null,
  modelId: ClefModelId,
): number | undefined {
  return inputTokens === null
    ? undefined
    : (inputTokens * clefModels[modelId].inputUsdPerMillion) / 1_000_000;
}

// Pinned, so no setting can send the token to another host.
const apiBase = "https://api.cloudflare.com/client/v4/accounts";
/** A Cloudflare account ID: 32 lowercase hexadecimal characters. */
export const clefAccountIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u));

/** The Workers AI REST URL of a Clef model for an account, the only one the adapter calls. */
export const clefUrl = (account: string, modelId: ClefModelId) =>
  `${apiBase}/${v.parse(clefAccountIdSchema, account)}/ai/run/@cf/cloudflare/${modelId}`;
