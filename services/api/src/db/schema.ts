import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Times are Unix epoch milliseconds. JSON documents are revalidated on every read.

/** Pairing creates owners from a verified service identity. */
export const owners = sqliteTable("owners", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

/**
 * Maps a verified external identity to its owner. The key is the issuer plus its
 * stable subject, never an email address, so a later identity adapter adds rows.
 */
export const ownerIdentities = sqliteTable(
  "owner_identities",
  {
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.subject] }),
    index("owner_identities_owner_idx").on(table.ownerId),
  ],
);

/** Only a SHA-256 digest of each high-entropy device credential is stored. */
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    /**
     * The last authenticated use, recorded at most once a day. A device unused for
     * `DEVICE_IDLE_LIMIT_MS` is expired. Pairing sets it; the default exists only because
     * SQLite adds a NOT NULL column with one, and a device left at 0 is expired.
     */
    lastUsedAt: integer("last_used_at").notNull().default(0),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("devices_token_hash_unique").on(table.tokenHash),
    index("devices_owner_idx").on(table.ownerId),
  ],
);

export const settings = sqliteTable("settings", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  revision: integer("revision").notNull(),
  document: text("document", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Null when the owner web UI wrote the revision. */
  updatedByDeviceId: text("updated_by_device_id").references(() => devices.id),
});

/**
 * The current pointer for each recipe. `sequence` orders changes per owner for
 * cursor sync; `writeId` lets later statements in a batch detect the winning write.
 */
export const recipeHeads = sqliteTable(
  "recipe_heads",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    recipeId: text("recipe_id").notNull(),
    revision: integer("revision").notNull(),
    state: text("state", { enum: ["active", "revoked"] }).notNull(),
    sequence: integer("sequence").notNull(),
    writeId: text("write_id").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.recipeId] }),
    uniqueIndex("recipe_heads_owner_sequence_unique").on(table.ownerId, table.sequence),
    check("recipe_heads_state_check", sql`${table.state} IN ('active', 'revoked')`),
  ],
);

/**
 * Immutable rows; each recipe keeps its newest revisions (`KEPT_RECIPE_REVISIONS`), and a
 * revoked revision is a tombstone without a document.
 */
export const recipeRevisions = sqliteTable(
  "recipe_revisions",
  {
    ownerId: text("owner_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    revision: integer("revision").notNull(),
    state: text("state", { enum: ["active", "revoked"] }).notNull(),
    document: text("document", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    /** Null when the owner web UI wrote the revision. */
    createdByDeviceId: text("created_by_device_id").references(() => devices.id),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.recipeId, table.revision] }),
    foreignKey({
      columns: [table.ownerId, table.recipeId],
      foreignColumns: [recipeHeads.ownerId, recipeHeads.recipeId],
    }),
    check(
      "recipe_revisions_document_check",
      sql`(${table.state} = 'active' AND ${table.document} IS NOT NULL) OR (${table.state} = 'revoked' AND ${table.document} IS NULL)`,
    ),
  ],
);

/**
 * The owner's Claude credential (ADR 0015). Workload Identity Federation stores only
 * the identifiers of the owner's own Anthropic federation rule, never a key.
 */
export const inferenceCredentials = sqliteTable(
  "inference_credentials",
  {
    ownerId: text("owner_id")
      .primaryKey()
      .references(() => owners.id),
    kind: text("kind", { enum: ["wif"] }).notNull(),
    federationRuleId: text("federation_rule_id").notNull(),
    organizationId: text("organization_id").notNull(),
    serviceAccountId: text("service_account_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("inference_credentials_kind_check", sql`${table.kind} IN ('wif')`)],
);

/** Where a generated page sits in its recipe, for the request log (ADR 0012). */
export const inferenceLogRecipePages = ["first", "continuation"] as const;
/**
 * Every generation and judgement request the service received and its local outcome (ADR
 * 0012), kept for one year (owner, 2026-10-18) unless the owner deletes them all from the
 * web UI. A request answered without a model call (owner, 2026-10-18 08:04 UTC) has no
 * provider, model, usage, result or answer and costs 0. `request` is the instructions and
 * input exactly as sent, or as they would have been sent; vault values never reach
 * inference, so they are never here. The recipe columns, `build`, `observation_hash` and
 * `answer` are null on rows logged before they were recorded.
 */
export const inferenceLog = sqliteTable(
  "inference_log",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    role: text("role", { enum: ["generate", "judge"] }).notNull(),
    /** Null for a request answered without a model call. */
    provider: text("provider"),
    modelId: text("model_id"),
    /**
     * The role's prompt version: 12 hex digits of the SHA-256 of its instructions and
     * response format (`promptVersion`). Rows logged before it was recorded have none.
     */
    promptVersion: text("prompt_version"),
    origin: text("origin").notNull(),
    path: text("path").notNull(),
    request: text("request", { mode: "json" }).notNull(),
    /**
     * The validated result (a plan, a judgement or an abstention reason); for
     * `invalid-output`, the check that refused the output and the refused plan reduced to
     * references (`{ rejection, output? }`); otherwise null.
     */
    result: text("result", { mode: "json" }),
    /**
     * The model's own answer before any local check or adjustment, for every decision and
     * for a refused one too: candidate and slot IDs the request does not hold are `?` and
     * generated names `name-N`, so it quotes no page text or vault field name. Null when the
     * output failed the response format or no answer came.
     */
    answer: text("answer", { mode: "json" }),
    /**
     * `ok`, `abstained` or the failure code; for a request answered without a model call,
     * the code it was answered with (`busy`, `daily-limit`, `input-too-large`…), or `recipe`
     * for a recipe another request already stored.
     */
    outcome: text("outcome").notNull(),
    /** The generated recipe the call is for: the one it starts or continues, or judges. */
    recipeId: text("recipe_id"),
    /** The chooser branch (ADR 0028), or empty for any other page. */
    branch: text("branch"),
    /**
     * The recipe's head revision when the call was made: 0 when it had none, the
     * tombstone's for a revoked recipe generated again, the judged one for the judge. A
     * request answered without a call has the head read when it arrived.
     */
    baseRevision: integer("base_revision"),
    /**
     * The revision this call's answer wrote, set once that write succeeded; null when it
     * wrote none, as for a judged page that kept no handler or a write lost to a device.
     */
    revision: integer("revision"),
    /**
     * For generation: `first` for a page that starts its recipe (a new one, one generated
     * again after its revocation, a list of accounts or an entry page), `continuation` for
     * a page sent with a base (a later page, a chooser branch's pages included).
     */
    recipePage: text("recipe_page", { enum: inferenceLogRecipePages }),
    /** The service commit that made the call (`PATEAT_BUILD_REVISION`). */
    build: text("build"),
    /**
     * 12 hex digits of the SHA-256 of the request's observation as JSON, to count the
     * same page sent more than once.
     */
    observationHash: text("observation_hash"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicroUsd: integer("cost_micro_usd").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("inference_log_owner_created").on(table.ownerId, table.createdAt),
    // Joins a recipe's rows with its revisions, for the backfill and the corpus.
    index("inference_log_owner_recipe").on(table.ownerId, table.recipeId),
    index("inference_log_created").on(table.createdAt),
    check("inference_log_role_check", sql`${table.role} IN ('generate', 'judge')`),
  ],
);

/**
 * How the first login of each recipe revision ended, as a device reported it (ADR 0019 and
 * ADR 0012, amended 2026-10-18): result codes only, never a URL, page text or value. The
 * first report of a revision is kept and later ones from any device are ignored. Kept one
 * year like the request log, and deleted with it.
 */
export const loginOutcomes = sqliteTable(
  "login_outcomes",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    recipeId: text("recipe_id").notNull(),
    /** The chooser branch the login took (ADR 0028), or empty for any other recipe. */
    branch: text("branch").notNull().default(""),
    revision: integer("revision").notNull(),
    /** A `loginOutcomeSchema` code. */
    outcome: text("outcome").notNull(),
    /** A `loginOutcomeCauseSchema` code, or null when the login named none. */
    cause: text("cause"),
    /** The attempt's step index when it ended. */
    step: integer("step").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.recipeId, table.branch, table.revision] }),
    index("login_outcomes_created").on(table.createdAt),
  ],
);

/**
 * Model calls and estimated spend per owner and period: a `YYYY-MM` row for the monthly
 * spend stop and a `YYYY-MM-DD` row for the daily one (UTC).
 */
export const inferenceSpend = sqliteTable(
  "inference_spend",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    period: text("period").notNull(),
    calls: integer("calls").notNull(),
    costMicroUsd: integer("cost_micro_usd").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.period] })],
);

/**
 * The last generation attempt per page, for the retry window of ADR 0016. A page is
 * keyed by the generated recipe it starts or continues and the revision it continues (0
 * for a first page), so the next form of a login that stays on one path is not mistaken
 * for a retry (ADR 0018), nor is the same page reached through another recipe.
 */
export const generationAttempts = sqliteTable(
  "generation_attempts",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    /** The generated recipe the page starts or continues; one origin can hold several. */
    recipeId: text("recipe_id").notNull(),
    /** The chooser branch the page continues (ADR 0028), or empty for any other page. */
    branch: text("branch").notNull().default(""),
    origin: text("origin").notNull(),
    path: text("path").notNull(),
    baseRevision: integer("base_revision").notNull(),
    attemptedAt: integer("attempted_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.recipeId, table.branch, table.path, table.baseRevision],
    }),
  ],
);

/**
 * What the judge answered for a page; `unclear` when the model abstained (ADR 0029), and
 * `partial` when it abstained on a description that left out a disabled field, so the
 * path is judged again once it is described in full.
 */
export const pageJudgementVerdicts = [
  "signed-in",
  "challenge",
  "rejected",
  "unclear",
  "partial",
] as const;
export type PageJudgementVerdict = (typeof pageJudgementVerdicts)[number];
/**
 * Pages sent to the judge per recipe revision, origin and path (ADR 0027): each is judged
 * at most once across devices and Worker restarts, and a recipe at most 20 times a UTC day.
 */
export const pageJudgements = sqliteTable(
  "page_judgements",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    recipeId: text("recipe_id").notNull(),
    /** The chooser branch whose route was judged (ADR 0028), or empty for a route recipe. */
    branch: text("branch").notNull().default(""),
    revision: integer("revision").notNull(),
    /**
     * The judged page's origin: the recipe's own, or another origin, of its site or after a
     * TOTP code of another site, that a login's tab moved to (ADR 0022), whose paths are
     * its own.
     */
    origin: text("origin").notNull(),
    path: text("path").notNull(),
    /**
     * The judge prompt version the page was judged with: a changed judge judges the page
     * again, as it may now keep a handler the earlier one could not (ADR 0027).
     */
    promptVersion: text("prompt_version").notNull().default(""),
    judgedAt: integer("judged_at").notNull(),
    /**
     * The model's verdict once it answered (ADR 0029); empty while the page is being
     * judged, or when the request failed.
     */
    verdict: text("verdict", { enum: pageJudgementVerdicts }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.ownerId,
        table.recipeId,
        table.branch,
        table.revision,
        table.origin,
        table.path,
        table.promptVersion,
      ],
    }),
    index("page_judgements_day").on(table.ownerId, table.recipeId, table.judgedAt),
  ],
);

/** One model call at a time per owner; a lock past `expiresAt` is abandoned. */
export const inferenceLocks = sqliteTable("inference_locks", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  lockId: text("lock_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
