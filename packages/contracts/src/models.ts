import * as v from "valibot";

// The owner's model configuration for each inference role (ADR 0014, owner 2026-10-23 11:31
// UTC): an ordered list of choices per role, edited only in the web UI. Devices never read
// or write it, so a stolen device token cannot raise the cost per call.

export const modelEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export const modelSpeeds = ["standard", "fast"] as const;
export const modelRoles = ["generate", "judge"] as const;
/** Choices per role: the first, then fallbacks asked after a refusal. */
export const MAX_MODEL_CHOICES = 3;

const claudeModelIdSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

export const modelProviders = ["anthropic", "openai"] as const;
export const openAIModelIds = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
] as const;
const openAIModelIdSchema = v.pipe(
  v.string(),
  v.check((id) => openAIModelIds.some((model) => model === id), "Unsupported OpenAI model"),
);
const choiceSettings = { effort: v.picklist(modelEfforts), speed: v.picklist(modelSpeeds) };

/** A provider and a model it supports; provider identity never comes from the model alone. */
export const modelChoiceSchema = v.variant("provider", [
  v.strictObject({
    provider: v.literal("anthropic"),
    model: claudeModelIdSchema,
    ...choiceSettings,
  }),
  v.strictObject({ provider: v.literal("openai"), model: openAIModelIdSchema, ...choiceSettings }),
]);

const roleChoicesSchema = v.pipe(
  v.array(modelChoiceSchema),
  v.minLength(1),
  v.maxLength(MAX_MODEL_CHOICES),
  v.check(
    (choices) =>
      new Set(choices.map((choice) => `${choice.provider}:${choice.model}`)).size ===
      choices.length,
    "Each model appears once per role",
  ),
);

export const modelConfigSchema = v.strictObject({
  generate: roleChoicesSchema,
  judge: roleChoicesSchema,
});

/** Both roles ask Opus 5.5 at effort low, then Sonnet 5.5 after a refusal (owner, 2026-10-23). */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  generate: [
    { provider: "anthropic", model: "claude-opus-5-5", effort: "low", speed: "standard" },
    { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low", speed: "standard" },
  ],
  judge: [
    { provider: "anthropic", model: "claude-opus-5-5", effort: "low", speed: "standard" },
    { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low", speed: "standard" },
  ],
};

/** A device choosing OpenAI uses only OpenAI defaults; Anthropic defaults remain unchanged. */
export const DEFAULT_OPENAI_MODEL_CONFIG: ModelConfig = {
  generate: [
    { provider: "openai", model: "gpt-6.1-sol", effort: "low", speed: "standard" },
    { provider: "openai", model: "gpt-6.1-terra", effort: "low", speed: "standard" },
  ],
  judge: [
    { provider: "openai", model: "gpt-6.1-sol", effort: "low", speed: "standard" },
    { provider: "openai", model: "gpt-6.1-terra", effort: "low", speed: "standard" },
  ],
};

const ratesSchema = v.strictObject({ input: v.number(), output: v.number() });

/** A model the web UI offers, with what the owner may choose for it. */
const modelOptionSettings = {
  displayName: v.pipe(v.string(), v.maxLength(128)),
  /** The efforts the model accepts. */
  efforts: v.array(v.picklist(modelEfforts)),
  /** USD per million tokens; null when the pricing page lists none, so it cannot be chosen. */
  rates: v.nullable(ratesSchema),
  /**
   * Fast mode: `none` when the pricing page lists no fast price, `failing` when the
   * owner's last fast calls of this model all failed, as when the organization has no
   * fast mode access; neither can be chosen.
   */
  fast: v.picklist(["none", "available", "failing"]),
  fastRates: v.optional(ratesSchema),
};
export const manageModelOptionSchema = v.variant("provider", [
  v.strictObject({
    provider: v.literal("anthropic"),
    id: claudeModelIdSchema,
    ...modelOptionSettings,
  }),
  v.strictObject({
    provider: v.literal("openai"),
    id: openAIModelIdSchema,
    ...modelOptionSettings,
  }),
]);

export const manageModelsSchema = v.strictObject({
  version: v.literal(1),
  config: modelConfigSchema,
  /** False while the owner has saved none and the defaults apply. */
  saved: v.boolean(),
  /**
   * Where the models came from: the Models API with the owner's credential, or the
   * pricing page alone when that call failed (then every effort is offered).
   */
  catalog: v.picklist(["models-api", "pricing"]),
  /** The newest model of each line, and every model the configuration names. */
  models: v.array(manageModelOptionSchema),
});

export const manageModelsWriteSchema = v.strictObject({
  version: v.literal(1),
  config: modelConfigSchema,
});

export type ModelProvider = (typeof modelProviders)[number];
export type OpenAIModelId = (typeof openAIModelIds)[number];
export type ModelEffort = (typeof modelEfforts)[number];
export type ModelSpeed = (typeof modelSpeeds)[number];
export type ModelRole = (typeof modelRoles)[number];
export type ModelChoice = v.InferOutput<typeof modelChoiceSchema>;
export type ModelConfig = v.InferOutput<typeof modelConfigSchema>;
export type ManageModelOption = v.InferOutput<typeof manageModelOptionSchema>;
export type ManageModels = v.InferOutput<typeof manageModelsSchema>;
export type ManageModelsWrite = v.InferOutput<typeof manageModelsWriteSchema>;
