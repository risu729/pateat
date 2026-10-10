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

/** Enrollment creates owners from a verified service identity. */
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
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("devices_token_hash_unique").on(table.tokenHash),
    index("devices_owner_idx").on(table.ownerId),
  ],
);

/**
 * An owner-approved pairing, keyed by the SHA-256 challenge of a verifier only the
 * extension holds. Redeemed rows stay so a challenge can never mint a second device.
 */
export const enrollments = sqliteTable(
  "enrollments",
  {
    challenge: text("challenge").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    label: text("label").notNull(),
    /** The normalized code the owner typed; redemption must derive the same one. */
    code: text("code").notNull(),
    approvedAt: integer("approved_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    redeemedAt: integer("redeemed_at"),
    deviceId: text("device_id").references(() => devices.id),
  },
  (table) => [
    index("enrollments_expires_idx").on(table.expiresAt),
    check(
      "enrollments_redemption_check",
      sql`(${table.redeemedAt} IS NULL) = (${table.deviceId} IS NULL)`,
    ),
  ],
);

export const settings = sqliteTable("settings", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  revision: integer("revision").notNull(),
  document: text("document", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedByDeviceId: text("updated_by_device_id")
    .notNull()
    .references(() => devices.id),
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

/** Immutable history; a revoked revision is a tombstone without a document. */
export const recipeRevisions = sqliteTable(
  "recipe_revisions",
  {
    ownerId: text("owner_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    revision: integer("revision").notNull(),
    state: text("state", { enum: ["active", "revoked"] }).notNull(),
    document: text("document", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    createdByDeviceId: text("created_by_device_id")
      .notNull()
      .references(() => devices.id),
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
