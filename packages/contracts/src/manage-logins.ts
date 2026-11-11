import * as v from "valibot";
import { loginOriginSchema, loginOutcomeSchema } from "./login";
import {
  MAX_LOGIN_RECORD_MS,
  extensionBuildSchema,
  loginOutcomeCauseSchema,
  syncRecipeIdSchema,
} from "./sync";

/** Owner-only browsing of already retained login records, never request bodies. */
export const MANAGE_LOGIN_HISTORY_LIMIT = 50;
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000));
const recordId = v.pipe(v.string(), v.length(36), v.uuid());
const milliseconds = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(MAX_LOGIN_RECORD_MS),
);

export const manageLoginHistoryFiltersSchema = v.strictObject({
  origin: v.optional(loginOriginSchema),
  outcome: v.optional(loginOutcomeSchema),
});
export const manageLoginHistoryCursorSchema = v.strictObject({
  at: timestamp,
  id: recordId,
});
/** Both cursor components are required together, including when the time is zero. */
export const manageLoginHistoryQuerySchema = v.pipe(
  v.strictObject({
    ...manageLoginHistoryFiltersSchema.entries,
    beforeAt: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(16),
        v.regex(/^(0|[1-9][0-9]*)$/),
        v.transform(Number),
        timestamp,
      ),
    ),
    beforeId: v.optional(recordId),
  }),
  v.check((query) => (query.beforeAt === undefined) === (query.beforeId === undefined)),
);
export const manageLoginHistoryEntrySchema = v.strictObject({
  id: recordId,
  at: timestamp,
  origin: loginOriginSchema,
  recipeId: syncRecipeIdSchema,
  revision: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER - 1)),
  outcome: loginOutcomeSchema,
  cause: v.nullable(loginOutcomeCauseSchema),
  extensionBuild: extensionBuildSchema,
  totalMs: milliseconds,
  personMs: milliseconds,
  serviceMs: milliseconds,
  /** A lower bound on the network part of serviceMs; never add it to serviceMs. */
  networkMs: milliseconds,
  pageMs: milliseconds,
});
export const manageLoginHistorySchema = v.strictObject({
  version: v.literal(1),
  entries: v.pipe(v.array(manageLoginHistoryEntrySchema), v.maxLength(MANAGE_LOGIN_HISTORY_LIMIT)),
  next: v.nullable(manageLoginHistoryCursorSchema),
});
export type ManageLoginHistoryFilters = v.InferOutput<typeof manageLoginHistoryFiltersSchema>;
export type ManageLoginHistoryCursor = v.InferOutput<typeof manageLoginHistoryCursorSchema>;
export type ManageLoginHistoryQuery = v.InferOutput<typeof manageLoginHistoryQuerySchema>;
export type ManageLoginHistory = v.InferOutput<typeof manageLoginHistorySchema>;
