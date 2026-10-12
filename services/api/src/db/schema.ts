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

/**
 * Every inference request the service sent and its local outcome (ADR 0012), kept for
 * 90 days (ADR 0018). A request refused locally before any model call is not logged.
 * `request` is the instructions and input exactly as sent; vault values never reach
 * inference, so they are never here.
 */
export const inferenceLog = sqliteTable(
  "inference_log",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    role: text("role", { enum: ["generate", "judge"] }).notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
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
    /** `ok`, `abstained` or the failure code. */
    outcome: text("outcome").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicroUsd: integer("cost_micro_usd").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("inference_log_owner_created").on(table.ownerId, table.createdAt),
    index("inference_log_created").on(table.createdAt),
    check("inference_log_role_check", sql`${table.role} IN ('generate', 'judge')`),
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
 * Pages sent to the judge per recipe revision and path (ADR 0027): each is judged at most
 * once across devices and Worker restarts, and a recipe at most 20 times a UTC day.
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
    path: text("path").notNull(),
    judgedAt: integer("judged_at").notNull(),
    /**
     * `challenge` or `rejected` once the model judged the page so (ADR 0029); other
     * verdicts are not kept.
     */
    verdict: text("verdict", { enum: ["challenge", "rejected"] }),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.recipeId, table.branch, table.revision, table.path],
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
