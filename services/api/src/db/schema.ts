import { pageJudgementVerdicts, recipePages, recipeUnitOrigins } from "@pateat/generation/backend";
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

/** Settings profiles: policy documents scoped by owner and profile (ADR 0024). */
export const profiles = sqliteTable(
  "profiles",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    id: text("id").notNull(),
    name: text("name").notNull(),
    /**
     * The profile's own parts; null until a device or the owner first writes them, and
     * again once the owner deletes the profile.
     */
    document: text("document", { mode: "json" }),
    /**
     * Set when the owner deleted the profile, which also clears its document. The row
     * stays, since revoked devices keep naming it; lists and writes skip it (ADR 0076).
     */
    deletedAt: integer("deleted_at"),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.id] })],
);

/** Only a SHA-256 digest of each high-entropy device credential is stored. */
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    profileId: text("profile_id").notNull(),
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
    /**
     * The `writeId` of this device's last stored settings write, set in the same batch: a
     * device whose write got no answer learns from it whether the write committed. Null
     * until the device writes.
     */
    settingsWriteId: text("settings_write_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.profileId],
      foreignColumns: [profiles.ownerId, profiles.id],
    }),
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
    /**
     * The newest write of the recipe, or reported started or ended login on it (ADR 0058).
     * An active head unused for `RECIPE_IDLE_LIMIT_MS` is revoked by the service. Every
     * write sets it; the default exists only because SQLite adds a NOT NULL column with one.
     */
    lastUsedAt: integer("last_used_at").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.recipeId] }),
    uniqueIndex("recipe_heads_owner_sequence_unique").on(table.ownerId, table.sequence),
    // The idle check reads an owner's least recently used heads first (ADR 0058).
    index("recipe_heads_owner_last_used").on(table.ownerId, table.lastUsedAt),
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
    /**
     * The device that wrote the revision or whose generation or judgement request did. Null
     * when the owner web UI or the service's own checks wrote it, such as a revocation of an
     * unused recipe (ADR 0058) or the removal of an idle layout (ADR 0060).
     */
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
 * When each layout of an active recipe was last used (ADR 0060): by a login that reported
 * starting or ending on it, or a write of the layout that a login's page caused. A layout
 * without a row counts as used when it was created. A layout unused for
 * `RECIPE_IDLE_LIMIT_MS` is removed from its recipe while another one is used; the recipe
 * itself is revoked by its own `lastUsedAt` (ADR 0058). Rows of layouts a write removes go
 * with that write.
 */
export const recipeLayoutUses = sqliteTable(
  "recipe_layout_uses",
  {
    ownerId: text("owner_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    /** The layout's key (`recipeLayoutKeySchema`). */
    layout: text("layout").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.recipeId, table.layout] }),
    foreignKey({
      columns: [table.ownerId, table.recipeId],
      foreignColumns: [recipeHeads.ownerId, recipeHeads.recipeId],
    }),
  ],
);

/**
 * Which call made each part ("unit") of an active recipe and when (ADR 0060): the service's
 * own record, never synced to devices and never in the recipe document. A unit is a page of
 * a layout's route (`page:<n>`), a handler (`handler:<i>`), a signed-in marker
 * (`marker:<i>`), a chooser layout's list buttons (`list`) or an entry recipe (`entry`); a
 * chooser branch's units start with `account/` or `other/` (`packages/generation/src/units.ts`). Rows are
 * written in the batch of the recipe write that adds the unit and only when that write
 * wins; rows of layouts a write drops go with that write, and every row of the recipe with
 * its revocation. The request log's delete-all clears `device_id` and `log_id`.
 */
export const recipeUnitSources = sqliteTable(
  "recipe_unit_sources",
  {
    ownerId: text("owner_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    /** The layout's key (`recipeLayoutKeySchema`); null for an entry recipe, which has none. */
    layout: text("layout"),
    /** The unit's ID within its layout (`packages/generation/src/units.ts`). */
    unit: text("unit").notNull(),
    /** 32 hex digits of the SHA-256 of the unit's content as written (`documentUnits`). */
    digest: text("digest").notNull(),
    /** The recipe revision whose write recorded the unit. */
    revision: integer("revision").notNull(),
    /**
     * `generated` for a page the generation role answered, `judged` for a handler or marker
     * the judge answered, `device` for a unit a device's own document added or changed.
     */
    origin: text("origin", { enum: recipeUnitOrigins }).notNull(),
    /** The model that answered (`ServedModel`); null for a `device` unit. */
    provider: text("provider"),
    model: text("model"),
    effort: text("effort"),
    speed: text("speed", { enum: ["standard", "fast"] }),
    /** The role's prompt version the call was made with; null for a `device` unit. */
    promptVersion: text("prompt_version"),
    /** The service commit that wrote the unit (`PATEAT_BUILD_REVISION`). */
    build: text("build").notNull(),
    /**
     * The device the recipe revision records as its writer: the one whose request generated
     * or judged the unit, or that wrote the document. Null after the request log's
     * delete-all.
     */
    deviceId: text("device_id").references(() => devices.id),
    /**
     * The request log row of the call (`inference_log.id`), not a foreign key: the log is
     * kept one year and its rows may be deleted before the unit's. Null after the request
     * log's delete-all.
     */
    logId: text("log_id"),
    /** When the winning recipe write recorded the unit, not when its call started. */
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("recipe_unit_sources_unit_unique").on(
      table.ownerId,
      table.recipeId,
      table.layout,
      table.unit,
    ),
    // SQLite counts null layouts as distinct, so an entry recipe's unit has its own index.
    uniqueIndex("recipe_unit_sources_entry_unique")
      .on(table.ownerId, table.recipeId, table.unit)
      .where(sql`${table.layout} IS NULL`),
    // `/manage` reads the owner's first pages and lists alone.
    index("recipe_unit_sources_owner_unit").on(table.ownerId, table.unit),
    foreignKey({
      columns: [table.ownerId, table.recipeId],
      foreignColumns: [recipeHeads.ownerId, recipeHeads.recipeId],
    }),
    check(
      "recipe_unit_sources_origin_check",
      sql`${table.origin} IN ('generated', 'judged', 'device')`,
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
 * Every generation and judgement request the service received and its local outcome (ADR
 * 0012), kept for one year (owner, 2026-10-18) unless the owner deletes them all from the
 * web UI. A request answered without a model call (owner, 2026-10-18 08:04 UTC) and a
 * repeat login's signed-in page sample (ADR 0029, owner 2026-10-18 08:05 UTC; a `judge`
 * row with the outcome `sampled`) have no provider, model, usage, result or answer and
 * cost 0. `request` is the instructions and input exactly as sent, or as they would have
 * been sent (for a sample, built as the judge's request would be); vault values never
 * reach inference, so they are never here. The recipe columns, `build`,
 * `observation_hash`, `answer` and the timing columns are null on rows logged before they
 * were recorded.
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
    /**
     * Whose key made the call (ADR 0040): `service` for the owner's credential on the
     * service, `device` for a paired device's own key, whose calls the spend stops and the
     * fast-mode check never count. `service` also for a request answered without a call.
     */
    source: text("source", { enum: ["service", "device"] })
      .notNull()
      .default("service"),
    modelId: text("model_id"),
    /**
     * The effort and speed the call asked for (the owner's model configuration); null for
     * a request answered without a model call and on rows logged before they were recorded.
     */
    effort: text("effort"),
    speed: text("speed", { enum: ["standard", "fast"] }),
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
     * references (`{ rejection, output? }`); for `refused`, the provider's refusal
     * category code when it reported one (`{ refusalCategory }`); otherwise null.
     */
    result: text("result", { mode: "json" }),
    /**
     * The model's own answer before any local check or adjustment, for every decision and
     * for a refused one too: candidate and slot IDs the request does not hold are `?`, so
     * it quotes no page text or vault field name. Null when the output failed the response
     * format or no answer came.
     */
    answer: text("answer", { mode: "json" }),
    /**
     * `ok`, `abstained` or the failure code; for a request answered without a model call,
     * the code it was answered with (`busy`, `daily-limit`, `input-too-large`…), or `recipe`
     * for a recipe another request already stored; `sampled` for a signed-in page sample
     * (ADR 0029), at most one per owner, recipe and branch in 30 days.
     */
    outcome: text("outcome").notNull(),
    /** The generated recipe the call is for: the one it starts or continues, or judges. */
    recipeId: text("recipe_id"),
    /**
     * The recipe layout (ADR 0060) and chooser branch (ADR 0028) as `recipeBranchSchema`
     * names them, or empty for a recipe's first page.
     */
    branch: text("branch"),
    /**
     * The recipe layout (ADR 0060) the row is for: the one a continuation, judgement or
     * signed-in page sample names in `branch`, or, for a recipe's first page sent to the
     * model (a list of accounts included), the key of the layout its answer creates, which
     * exists once `revision` is set. Null for an entry page and for a first page answered
     * without a call.
     */
    layout: text("layout"),
    /**
     * The recipe's head revision when the call was made: 0 when it had none, the
     * tombstone's for a revoked recipe generated again, the judged one for the judge. A
     * request answered without a call has the head read when it arrived, and a signed-in
     * page sample the revision it sampled.
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
     * a page sent with a base (a later page, a chooser branch's pages included), `logout` for
     * any page of an account switch's logout (ADR 0063), which the dashboard counts apart.
     */
    recipePage: text("recipe_page", { enum: recipePages }),
    /**
     * For generation: the device's hint that the page showed the user signed in (ADR 0035),
     * sent with a recipe's first page that lists no accounts; null for any other request.
     */
    signedIn: integer("signed_in", { mode: "boolean" }),
    /**
     * For generation: the page's kind the model's plan answered (ADR 0035), also for a plan
     * the local checks refused; null when the answer was no plan.
     */
    pageKind: text("page_kind", { enum: ["sign-in", "confirm", "unclear"] }),
    /**
     * For generation: whether the model's plan answered that submitting the page cannot be
     * undone (ADR 0035), kept for evaluation only and never on a recipe; null as `pageKind`.
     */
    irreversible: text("irreversible", { enum: ["yes", "no", "unclear"] }),
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
    /**
     * Milliseconds from the Worker receiving the request to just before the model call:
     * device authentication, the request limit, the route's own reads, the owner's call
     * slot, the gate and spend checks, the model configuration and the credential with its
     * token exchange. A later call of the same request (a fallback after a refusal, or the
     * standard speed after fast mode failed) includes the calls before it.
     */
    preModelMs: integer("pre_model_ms"),
    /**
     * Milliseconds of that spent resolving the owner's Claude credential, which signs an
     * assertion and exchanges it for a new token on every call (ADR 0015).
     */
    tokenMs: integer("token_ms"),
    /**
     * Milliseconds of the role's model call and its local output checks. A retried request
     * would count every attempt, though the service allows none (`maxRetries: 0`).
     */
    modelMs: integer("model_ms"),
    /**
     * Milliseconds from the Worker receiving the request to its response, the recipe write
     * included. Set after the response is sent; null when that update failed.
     */
    serverMs: integer("server_ms"),
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
    /**
     * The layout the login ran (ADR 0060) and the chooser branch it took (ADR 0028), as
     * `recipeBranchSchema` names them; empty only in rows written before layouts.
     */
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
 * Every login on a recipe revision that a device reported when it ended, signed in or
 * blocked (ADR 0055): its result code and how long it took, one row per report. `origin`
 * is the recipe revision's own, which the service reads when the row is written; the device
 * sends no URL or origin. Kept one year like the request log, and deleted with it.
 */
export const loginTimings = sqliteTable(
  "login_timings",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    recipeId: text("recipe_id").notNull(),
    /**
     * The layout the login ran (ADR 0060) and the chooser branch it took (ADR 0028), as
     * `recipeBranchSchema` names them; empty only in rows written before layouts.
     */
    branch: text("branch").notNull().default(""),
    revision: integer("revision").notNull(),
    /** The recipe's origin, from the reported revision or else its newest kept one. */
    origin: text("origin").notNull(),
    /** A `loginOutcomeSchema` code. */
    outcome: text("outcome").notNull(),
    /** A `loginOutcomeCauseSchema` code, or null when the login named none. */
    cause: text("cause"),
    /** The extension commit that ran the login, or `development`. */
    extensionBuild: text("extension_build").notNull(),
    /** From the login's first page until it ended, in milliseconds. */
    totalMs: integer("total_ms").notNull(),
    /** Waiting for the service. */
    serviceMs: integer("service_ms").notNull(),
    /**
     * Of the service time, the network's: only for answers that named the service's own
     * time in `Server-Timing`, so a lower bound.
     */
    networkMs: integer("network_ms").notNull(),
    /** Waiting for the person. */
    personMs: integer("person_ms").notNull(),
    /** Waiting for the site's answer to the login's steps, page loads included. */
    pageMs: integer("page_ms").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("login_timings_owner_created").on(table.ownerId, table.createdAt),
    index("login_timings_created").on(table.createdAt),
  ],
);

/**
 * The `warn` and `error` lines of devices' local logs, and the `info` lines that say why
 * Pateat did nothing (ADR 0066), as the extension let them leave: the event, its level,
 * the device's time and its allowlisted fields as JSON, such as `origin`, `recipe`,
 * `outcome` and `cause`. One row per line; a device's retry repeats its log ID and `seq`
 * and changes nothing. Kept a year, and deleted with the request log.
 */
export const problemLog = sqliteTable(
  "problem_log",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    /** The device log's random ID; a log made again on the device has another. */
    logId: text("log_id").notNull(),
    /** The local log's own key in that log. */
    seq: integer("seq").notNull(),
    /** The extension commit that wrote the line, or `development`. */
    extensionBuild: text("extension_build").notNull(),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
    /** A local log event name, such as `login.attempt`. */
    event: text("event").notNull(),
    /** The line's fields as a JSON object of strings, integers and booleans. */
    fields: text("fields").notNull(),
    /** When the device wrote the line, by its clock. */
    loggedAt: integer("logged_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.logId, table.seq] }),
    index("problem_log_owner_created").on(table.ownerId, table.createdAt),
    index("problem_log_created").on(table.createdAt),
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
    /**
     * The layout (ADR 0060) and chooser branch (ADR 0028) the page continues, as
     * `recipeBranchSchema` names them, or empty for a recipe's first page.
     */
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
 * The last repair call per generated recipe and device (ADR 0041): a device asks
 * to repair a recipe whose start page no longer matches at most once a UTC day, whatever
 * came of the call.
 */
export const recipeRepairs = sqliteTable(
  "recipe_repairs",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    recipeId: text("recipe_id").notNull(),
    deviceId: text("device_id").notNull(),
    /** The revision the call was to repair. */
    revision: integer("revision").notNull(),
    repairedAt: integer("repaired_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.recipeId, table.deviceId] })],
);

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
    /**
     * The layout (ADR 0060) and chooser branch (ADR 0028) whose route was judged, as
     * `recipeBranchSchema` names them.
     */
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

/**
 * The owner's model configuration (`modelConfigSchema`), edited only in the web UI: devices
 * never read or write it. No row means the defaults (`DEFAULT_MODEL_CONFIG`).
 */
export const inferenceModelConfigs = sqliteTable("inference_model_configs", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  document: text("document", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * The model calls an owner has running, one row per slot from 0 below
 * `CLAUDE_CALL_LIMITS.concurrentCalls` (ADR 0018); a slot past `expiresAt` is abandoned.
 */
export const inferenceLocks = sqliteTable(
  "inference_locks",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    slot: integer("slot").notNull(),
    lockId: text("lock_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.slot] })],
);
