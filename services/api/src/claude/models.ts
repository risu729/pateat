import {
  DEFAULT_MODEL_CONFIG,
  modelConfigSchema,
  modelEfforts,
  type ManageModelOption,
  type ManageModels,
  type ModelConfig,
  type ModelEffort,
} from "@pateat/contracts";
import { claudeModelRates, claudePricedModels, type ClaudeCredential } from "@pateat/inference";
import { and, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { inferenceLog, inferenceModelConfigs } from "../db/schema";
import { resolveClaudeCredential } from "./credentials";

// The owner's model configuration (ADR 0014, owner 2026-10-23 11:31 UTC): which Claude
// models each role asks, in order, at which effort and speed. Only the web UI reads and
// writes it; the model list comes from the Models API with the owner's own credential,
// and the rates from the committed pricing page.

// Pinned like the generation adapter's base URL; nothing in the environment redirects it.
const MODELS_URL = "https://api.anthropic.com/v1/models";
const MODELS_TIMEOUT_MS = 10_000;
/** Enough pages for every model the API lists today (13 on 2026-10-23) many times over. */
const MAX_MODEL_PAGES = 5;

/** Fast mode counts as failing once the owner's last this many fast calls of a model failed. */
export const FAST_FAILURE_RUN = 3;
/** Only fast calls this recent count, so a model is offered again a week after its failures. */
export const FAST_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The failures fast mode answers when the organization cannot use it or the model is busy. */
const FAST_FAILURES = new Set(["rate-limited", "provider-error", "timeout"]);

type Db = D1Database;

/** The owner's saved configuration, or the defaults; a stored copy is revalidated. */
export async function readModelConfig(
  db: Db,
  ownerId: string,
): Promise<{ config: ModelConfig; saved: boolean }> {
  const [row] = await drizzle(db)
    .select({ document: inferenceModelConfigs.document })
    .from(inferenceModelConfigs)
    .where(eq(inferenceModelConfigs.ownerId, ownerId))
    .limit(1);
  if (!row) return { config: DEFAULT_MODEL_CONFIG, saved: false };
  const stored = v.safeParse(modelConfigSchema, row.document);
  if (stored.success) return { config: stored.output, saved: true };
  console.error("Stored model configuration is invalid; using the defaults");
  return { config: DEFAULT_MODEL_CONFIG, saved: false };
}

export async function saveModelConfig(db: Db, ownerId: string, config: ModelConfig) {
  const row = { document: v.parse(modelConfigSchema, config), updatedAt: Date.now() };
  await drizzle(db)
    .insert(inferenceModelConfigs)
    .values({ ownerId, ...row })
    .onConflictDoUpdate({ target: inferenceModelConfigs.ownerId, set: row });
}

const supported = v.object({ supported: v.boolean() });
const apiModelSchema = v.object({
  id: v.string(),
  display_name: v.string(),
  created_at: v.string(),
  line: v.optional(v.nullable(v.string())),
  capabilities: v.optional(
    v.nullable(
      v.object({
        effort: v.optional(
          v.nullable(
            v.object({
              supported: v.boolean(),
              ...Object.fromEntries(modelEfforts.map((effort) => [effort, v.optional(supported)])),
            }),
          ),
        ),
        structured_outputs: v.optional(v.nullable(supported)),
      }),
    ),
  ),
});
const apiPageSchema = v.object({
  data: v.array(v.unknown()),
  has_more: v.boolean(),
  last_id: v.nullable(v.string()),
});

/** A model as the Models API lists it, with the efforts it accepts. */
export type ApiModel = {
  id: string;
  displayName: string;
  createdAt: string;
  line: string;
  efforts: ModelEffort[];
  structuredOutputs: boolean;
};

/**
 * Lists the models the owner's organization can call, from the Models API with the
 * owner's own credential. Undefined when the call fails, so the page falls back to the
 * pricing page alone. Entries of a shape the service does not read are left out.
 */
export async function listApiModels(
  credential: ClaudeCredential,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<ApiModel[] | undefined> {
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    ...("authToken" in credential
      ? { Authorization: `Bearer ${credential.authToken}` }
      : { "x-api-key": credential.apiKey }),
  };
  const models: ApiModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const url = new URL(MODELS_URL);
    url.searchParams.set("limit", "100");
    if (after !== null) url.searchParams.set("after_id", after);
    let body: unknown;
    try {
      // Pages depend on the previous page's last ID, so they are read in turn.
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetcher(
        new Request(url, {
          headers,
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
          redirect: "manual",
        }),
      );
      if (!response.ok) {
        // oxlint-disable-next-line no-await-in-loop
        await response.body?.cancel();
        console.warn("Models API call failed", { status: response.status });
        return undefined;
      }
      // oxlint-disable-next-line no-await-in-loop
      body = await response.json();
    } catch {
      console.warn("Models API call failed");
      return undefined;
    }
    const parsed = v.safeParse(apiPageSchema, body);
    if (!parsed.success) return undefined;
    for (const entry of parsed.output.data) {
      const model = v.safeParse(apiModelSchema, entry);
      if (!model.success) continue;
      const { id, display_name, created_at, line, capabilities } = model.output;
      const effort = capabilities?.effort as
        | (Record<string, { supported: boolean } | undefined> & { supported: boolean })
        | null
        | undefined;
      models.push({
        id,
        displayName: display_name,
        createdAt: created_at,
        line: line ?? id,
        efforts:
          effort?.supported === true
            ? modelEfforts.filter((level) => effort[level]?.supported === true)
            : [],
        structuredOutputs: capabilities?.structured_outputs?.supported === true,
      });
    }
    if (!parsed.output.has_more || parsed.output.last_id === null) return models;
    after = parsed.output.last_id;
  }
  return models;
}

/**
 * The models whose fast mode failed on the owner's last `FAST_FAILURE_RUN` fast calls
 * within `FAST_FAILURE_WINDOW_MS`, as when the organization has no fast mode access.
 */
export async function fastFailingModels(
  db: Db,
  ownerId: string,
  now: number,
  /** Whose key's calls count (ADR 0040): a device's key fails apart from the owner's. */
  source: "service" | "device" = "service",
) {
  const rows = await drizzle(db)
    .select({ modelId: inferenceLog.modelId, outcome: inferenceLog.outcome })
    .from(inferenceLog)
    .where(
      and(
        eq(inferenceLog.ownerId, ownerId),
        eq(inferenceLog.source, source),
        eq(inferenceLog.speed, "fast"),
        gt(inferenceLog.createdAt, now - FAST_FAILURE_WINDOW_MS),
      ),
    )
    .orderBy(desc(inferenceLog.createdAt))
    .limit(500);
  const recent = new Map<string, string[]>();
  for (const { modelId, outcome } of rows) {
    if (modelId === null) continue;
    const outcomes = recent.get(modelId) ?? [];
    if (outcomes.length < FAST_FAILURE_RUN) recent.set(modelId, [...outcomes, outcome]);
  }
  return new Set(
    [...recent]
      .filter(
        ([, outcomes]) =>
          outcomes.length === FAST_FAILURE_RUN &&
          outcomes.every((outcome) => FAST_FAILURES.has(outcome)),
      )
      .map(([modelId]) => modelId),
  );
}

function option(
  model: { id: string; displayName: string; efforts: readonly ModelEffort[] },
  fastFailing: ReadonlySet<string>,
): ManageModelOption {
  const rates = claudeModelRates(model.id);
  const fastRates = claudeModelRates(model.id, "fast");
  return {
    provider: "anthropic",
    id: model.id,
    displayName: model.displayName,
    efforts: [...model.efforts],
    rates: rates === undefined ? null : { input: rates.input, output: rates.output },
    fast: fastRates === undefined ? "none" : fastFailing.has(model.id) ? "failing" : "available",
    ...(fastRates === undefined
      ? {}
      : { fastRates: { input: fastRates.input, output: fastRates.output } }),
  };
}

/**
 * What the web UI offers: the newest model of each line (and, when that one has no
 * price yet, the newest priced one too), then every configured model not among them.
 * Models without structured output are left out, since every role needs it. A listed
 * model the pricing page does not price is offered as unavailable and written to the
 * Worker log, so a new model waiting for its price shows there (owner, 2026-10-23).
 */
export function modelOptions(
  apiModels: ApiModel[] | undefined,
  config: ModelConfig,
  fastFailing: ReadonlySet<string>,
): Pick<ManageModels, "catalog" | "models"> {
  type Candidate = { id: string; displayName: string; line: string; efforts: ModelEffort[] };
  const candidates: (Candidate & { order: number })[] =
    apiModels === undefined
      ? claudePricedModels().map((model) => ({
          id: model.modelId,
          displayName: model.displayName,
          line: model.line,
          // Without the Models API the service cannot tell; a refused effort fails visibly.
          efforts: [...modelEfforts],
          order: model.version,
        }))
      : apiModels
          .filter((model) => model.structuredOutputs)
          .map((model) => ({ ...model, order: Date.parse(model.createdAt) || 0 }));
  for (const model of candidates)
    if (claudeModelRates(model.id) === undefined)
      console.warn("Claude model has no price", { model: model.id });

  const lines = new Map<string, (Candidate & { order: number })[]>();
  for (const model of candidates) lines.set(model.line, [...(lines.get(model.line) ?? []), model]);
  const shown: Candidate[] = [];
  for (const models of lines.values()) {
    const newest = models.toSorted((a, b) => b.order - a.order);
    const first = newest[0]!;
    shown.push(first);
    if (claudeModelRates(first.id) === undefined) {
      const priced = newest.find((model) => claudeModelRates(model.id) !== undefined);
      if (priced) shown.push(priced);
    }
  }
  const byId = new Map(candidates.map((model) => [model.id, model]));
  for (const choice of [...config.generate, ...config.judge])
    if (!shown.some((model) => model.id === choice.model))
      shown.push(
        byId.get(choice.model) ?? {
          id: choice.model,
          displayName: choice.model,
          line: choice.model,
          // No longer listed: shown so the owner sees it, with nothing to choose.
          efforts: [],
        },
      );
  return {
    catalog: apiModels === undefined ? "pricing" : "models-api",
    models: shown.map((model) => option(model, fastFailing)),
  };
}

/**
 * Whether every choice names an offered, priced model at an effort it accepts, and fast
 * mode only where it is available.
 */
export function configOffered(config: ModelConfig, models: readonly ManageModelOption[]) {
  return [...config.generate, ...config.judge].every((choice) => {
    const model = models.find((entry) => entry.id === choice.model);
    return (
      model !== undefined &&
      model.rates !== null &&
      model.efforts.includes(choice.effort) &&
      (choice.speed === "standard" || model.fast === "available")
    );
  });
}

/**
 * What the web UI's view is built from: the saved configuration, the models the owner's
 * organization lists and the models whose fast mode keeps failing. The model list is read
 * for each request with a newly exchanged token (ADR 0015), never cached; without a
 * credential, or when the call fails, only the pricing page lists models.
 */
export async function readModelCatalog(
  env: { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string },
  ownerId: string,
  now: number,
) {
  const [{ config, saved }, credential, fastFailing] = await Promise.all([
    readModelConfig(env.DB, ownerId),
    resolveClaudeCredential(env, ownerId),
    fastFailingModels(env.DB, ownerId, now),
  ]);
  const apiModels =
    credential.status === "ready" ? await listApiModels(credential.credential) : undefined;
  return { config, saved, apiModels, fastFailing };
}

/** The web UI's view of a configuration. */
export function manageModels(
  catalog: Awaited<ReturnType<typeof readModelCatalog>>,
  config: ModelConfig,
  saved: boolean,
): ManageModels {
  return {
    version: 1,
    config,
    saved,
    ...modelOptions(catalog.apiModels, config, catalog.fastFailing),
  };
}
