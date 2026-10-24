import * as v from "valibot";
import { recipeLayoutKeySchema } from "./login";
import { deviceIdSchema, profileIdSchema } from "./pairing";
import {
  problemEventSchema,
  problemFieldsAllowed,
  problemFieldsSchema,
  problemLevelSchema,
} from "./problems";
import {
  MAX_SETTINGS_DOCUMENT_BYTES,
  settingsDocumentBytes,
  syncRecipeChangeSchema,
  syncRecipeIdSchema,
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
} from "./sync";

// Contracts for the service's owner web UI API under `/manage/api` (see the
// architecture's "Owner web UI"). Every route acts for the owner the Access token
// names; paths and bodies never select an owner.

const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0));
const headRevision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);

export const manageDeviceSchema = v.strictObject({
  id: deviceIdSchema,
  profileId: profileIdSchema,
  /** Empty for a device paired without a label. */
  label: v.pipe(v.string(), v.maxLength(64)),
  createdAt: timestamp,
  /** Recorded at most once a day, so it can lag the real last use by a day. */
  lastUsedAt: timestamp,
  revokedAt: v.nullable(timestamp),
});
/** Newest first. */
export const manageDevicesSchema = v.strictObject({
  version: v.literal(1),
  devices: v.array(manageDeviceSchema),
});

/**
 * The web UI writes the same document devices sync. The service copy never holds
 * device-local vault connections, so a write that names any is refused, and the
 * document stays within the size devices upload.
 */
export const manageSettingsWriteSchema = v.pipe(
  syncSettingsWriteSchema,
  v.check((write) => write.settings.connections.length === 0, "Connections stay on devices"),
  v.check(
    (write) => settingsDocumentBytes(write.settings) <= MAX_SETTINGS_DOCUMENT_BYTES,
    "The settings document is too large",
  ),
);
/** A stale write changes nothing; the current state comes back. */
export const manageSettingsConflictSchema = v.strictObject({
  error: v.literal("settings_conflict"),
  current: syncSettingsStateSchema,
});

/**
 * Who made a layout's first page, a chooser layout's list included (ADR 0060, generation
 * provenance): the model that generated it, or none when a device's document changed or
 * added it, and when that write was recorded.
 */
export const manageLayoutSourceSchema = v.strictObject({
  origin: v.picklist(["generated", "judged", "device"]),
  model: v.nullable(v.pipe(v.string(), v.maxLength(128))),
  createdAt: timestamp,
});
/**
 * One recipe's current head: the active recipe, or a tombstone once revoked, and when each
 * of its layouts was last used (ADR 0058, ADR 0060): by a login that started or ended on it,
 * or a write the login's page caused. `null` for a layout no login used yet. `firstPage` is
 * `null` when the service has no record of it.
 */
export const manageRecipeSchema = v.strictObject({
  change: syncRecipeChangeSchema,
  updatedAt: timestamp,
  layouts: v.array(
    v.strictObject({
      key: recipeLayoutKeySchema,
      lastUsedAt: v.nullable(timestamp),
      firstPage: v.nullable(manageLayoutSourceSchema),
    }),
  ),
});
/**
 * An active head whose stored document no longer passes the recipe contract. Devices
 * receive it as revoked; it stays active on the service until the owner revokes it.
 */
export const manageUnreadableRecipeSchema = v.strictObject({
  recipeId: syncRecipeIdSchema,
  revision: headRevision,
  updatedAt: timestamp,
});
/** Both lists are most recently changed first. */
export const manageRecipesSchema = v.strictObject({
  version: v.literal(1),
  recipes: v.array(manageRecipeSchema),
  unreadable: v.array(manageUnreadableRecipeSchema),
});
/**
 * Revokes the recipe if `expectedRevision` is still its head; devices drop it on sync. The
 * same body removes one layout of it (`/recipes/:recipeId/layouts/:layout/revoke`, ADR
 * 0060): the next revision keeps the others, and removing the last one revokes the recipe.
 */
export const manageRecipeRevokeSchema = v.strictObject({
  version: v.literal(1),
  expectedRevision: headRevision,
});
/** The revocation lost to another write, or the recipe is already revoked. */
export const manageRecipeConflictSchema = v.strictObject({
  error: v.literal("recipe_conflict"),
  current: v.nullable(syncRecipeChangeSchema),
});

/**
 * How long the service keeps each request log row, login result code and login record
 * (ADR 0012, ADR 0055; owner, 2026-10-18), and each problem line devices sent (ADR 0066;
 * owner, 2026-10-23 13:00 UTC).
 */
export const INFERENCE_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * A recipe and branch get one signed-in page sample in this long (ADR 0029, owner
 * 2026-10-18 08:05 UTC: once in 30 days), on the service and on each device.
 */
export const PAGE_SAMPLE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const rowCount = v.pipe(v.number(), v.integer(), v.minValue(0));
/**
 * The owner's request log (ADR 0012): how many requests it holds, how many login result
 * codes devices sent (ADR 0019, amended 2026-10-18), how many login records (ADR 0055),
 * how many problem lines (ADR 0066), and the oldest row's time of any of them.
 */
export const manageRequestLogSchema = v.strictObject({
  version: v.literal(1),
  entries: rowCount,
  outcomes: rowCount,
  logins: rowCount,
  problems: rowCount,
  oldestAt: v.nullable(timestamp),
});
/**
 * Deleting the whole request log: how many requests, login result codes, login records and
 * problem lines it removed.
 */
export const manageRequestLogDeletedSchema = v.strictObject({
  version: v.literal(1),
  deleted: rowCount,
  outcomes: rowCount,
  logins: rowCount,
  problems: rowCount,
});
/** Problem lines `/manage/api/problems` lists at most, newest first. */
export const MANAGE_PROBLEMS_LIMIT = 200;
/** One problem line a device sent (ADR 0066), with the device's label. */
export const manageProblemSchema = v.pipe(
  v.strictObject({
    /** Empty for a device paired without a label. */
    device: v.pipe(v.string(), v.maxLength(64)),
    extensionBuild: v.pipe(v.string(), v.maxLength(40)),
    level: problemLevelSchema,
    event: problemEventSchema,
    fields: problemFieldsSchema,
    /** When the device wrote it, by its clock. */
    loggedAt: timestamp,
    /** When the service received it. */
    receivedAt: timestamp,
  }),
  v.check((problem) => problemFieldsAllowed(problem.event, problem.fields)),
);
export const manageProblemsSchema = v.strictObject({
  version: v.literal(1),
  problems: v.pipe(v.array(manageProblemSchema), v.maxLength(MANAGE_PROBLEMS_LIMIT)),
});

/** The periods the dashboard summarizes, ending now. */
export const manageDashboardRangeSchema = v.picklist(["24h", "7d", "30d"]);
export const MANAGE_DASHBOARD_RANGE_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const satisfies Record<v.InferOutput<typeof manageDashboardRangeSchema>, number>;
/** Below this many values a p90 says little, so the values themselves are given. */
export const MANAGE_DASHBOARD_P90_MIN = 20;
const milliseconds = v.pipe(v.number(), v.integer(), v.minValue(0));
/** A request log role; `logout`, an account switch's logout requests (ADR 0063). */
const dashboardRole = v.picklist(["generate", "judge", "logout"]);
/**
 * Durations in milliseconds: how many (`n`), the nearest-rank median (null when none) and,
 * from `MANAGE_DASHBOARD_P90_MIN` values, the p90; below that, the values ascending
 * instead.
 */
export const manageDurationsSchema = v.strictObject({
  n: rowCount,
  p50: v.nullable(milliseconds),
  p90: v.optional(milliseconds),
  values: v.optional(v.array(milliseconds)),
});
/** One request log row or login record in a failure group, newest first. */
export const manageDashboardEventSchema = v.strictObject({
  at: timestamp,
  origin: v.string(),
  recipeId: v.nullable(v.string()),
  revision: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** The request's role; null for a login result. */
  role: v.nullable(dashboardRole),
  /** The login's `cause` code; null for a request or a login that named none. */
  cause: v.nullable(v.string()),
});
/** One result code: how often it came, the last time and site, and its latest 20 rows. */
export const manageDashboardFailureSchema = v.strictObject({
  /** `request`: a request log `outcome`; `login`: a login record's result code. */
  kind: v.picklist(["request", "login"]),
  code: v.string(),
  count: rowCount,
  lastAt: timestamp,
  lastOrigin: v.string(),
  lastRecipeId: v.nullable(v.string()),
  latest: v.array(manageDashboardEventSchema),
});
const microUsd = v.pipe(v.number(), v.integer(), v.minValue(0));
/**
 * The median of each part of a login's time over `n` signed-in logins: the network part of
 * the service time (only for answers that named the service's own time, so a lower bound),
 * the rest of the service time, the wait for the site's answer to the login's steps (page
 * loads included), and the rest of the login (Pateat's own work and waits, reading pages,
 * filling and clicking). The person's time is apart, never in the login time.
 */
export const manageLoginPartsSchema = v.strictObject({
  n: rowCount,
  networkMs: v.nullable(milliseconds),
  serviceOtherMs: v.nullable(milliseconds),
  pageMs: v.nullable(milliseconds),
  otherMs: v.nullable(milliseconds),
  personMs: v.nullable(milliseconds),
});
/**
 * The owner dashboard over one range, aggregated by the service from the request log, the
 * login records and result codes devices sent, recipes and spend. Latency counts only the
 * recorded times; request log rows logged before they were recorded have none.
 */
export const manageDashboardSchema = v.strictObject({
  version: v.literal(1),
  range: manageDashboardRangeSchema,
  /** The range's start and end (now). */
  from: timestamp,
  to: timestamp,
  /**
   * Login speed from the login records devices sent (ADR 0055). A login's time is its
   * total less the person's time, over the logins that signed in; one waited on the
   * service when its service time is above 0.
   */
  logins: v.strictObject({
    /** Login records in the range, whatever their result. */
    count: rowCount,
    /** Login time of every signed-in login. */
    loginMs: manageDurationsSchema,
    /** Login time of the signed-in logins that waited on the service, and of the rest. */
    withService: manageDurationsSchema,
    recipeOnly: manageDurationsSchema,
    parts: v.strictObject({
      withService: manageLoginPartsSchema,
      recipeOnly: manageLoginPartsSchema,
    }),
    /** Logins per site (the recipe's origin), slowest median login time first. */
    perSite: v.array(
      v.strictObject({
        origin: v.string(),
        logins: rowCount,
        signedIn: rowCount,
        loginMs: manageDurationsSchema,
      }),
    ),
    /** Logins per extension build, most recently used first. */
    perBuild: v.array(
      v.strictObject({
        build: v.string(),
        logins: rowCount,
        lastAt: timestamp,
        loginMs: manageDurationsSchema,
      }),
    ),
  }),
  /** Per role, generation first. */
  llm: v.array(
    v.strictObject({
      role: dashboardRole,
      /**
       * Requests in the range that called the model. The times here count only those;
       * requests answered without a call are in `stats.requests` and the failures.
       */
      calls: rowCount,
      modelMs: manageDurationsSchema,
      tokenMs: manageDurationsSchema,
      preModelMs: manageDurationsSchema,
      serverMs: manageDurationsSchema,
      /**
       * The median of each part of a request's server time, over the rows with all four
       * times (`n`): before the model call apart from the token exchange, the token
       * exchange, the model call and after it.
       */
      parts: v.strictObject({
        n: rowCount,
        preModelOtherMs: v.nullable(milliseconds),
        tokenMs: v.nullable(milliseconds),
        modelMs: v.nullable(milliseconds),
        afterModelMs: v.nullable(milliseconds),
      }),
      inputTokens: rowCount,
      outputTokens: rowCount,
    }),
  ),
  /**
   * Every UTC day the range touches, oldest first; a median is null on a day without one.
   * `logins` counts login records, `authenticatedLogins` those that signed in, and
   * `loginP50` is their median login time.
   */
  daily: v.array(
    v.strictObject({
      day: v.pipe(v.string(), v.isoDate()),
      generateRequests: rowCount,
      judgeRequests: rowCount,
      generateModelP50: v.nullable(milliseconds),
      judgeModelP50: v.nullable(milliseconds),
      logins: rowCount,
      authenticatedLogins: rowCount,
      loginP50: v.nullable(milliseconds),
    }),
  ),
  /** The 10 requests that called the model with the longest server time, slowest first. */
  slowest: v.array(
    v.strictObject({
      at: timestamp,
      role: dashboardRole,
      origin: v.string(),
      outcome: v.string(),
      tokenMs: v.nullable(milliseconds),
      modelMs: v.nullable(milliseconds),
      serverMs: milliseconds,
    }),
  ),
  /**
   * Requests per origin, by median server time, slowest first; the times count only the
   * requests that called the model.
   */
  perSite: v.array(
    v.strictObject({
      origin: v.string(),
      requests: rowCount,
      serverMs: manageDurationsSchema,
      modelMs: manageDurationsSchema,
    }),
  ),
  /**
   * Requests per service build, most recently used first; the times count only the
   * requests that called the model.
   */
  perBuild: v.array(
    v.strictObject({
      /** Null for rows logged before the build was recorded. */
      build: v.nullable(v.string()),
      requests: rowCount,
      lastAt: timestamp,
      modelMs: manageDurationsSchema,
      serverMs: manageDurationsSchema,
    }),
  ),
  stats: v.strictObject({
    /** Request log rows by role and outcome, most frequent first. */
    requests: v.array(
      v.strictObject({ role: dashboardRole, outcome: v.string(), count: rowCount }),
    ),
    /** Login records by outcome, most frequent first: every login a device reported. */
    logins: v.array(v.strictObject({ outcome: v.string(), count: rowCount })),
    /** How many of those signed in (`authenticated`); the success rate is this of their sum. */
    loginsAuthenticated: rowCount,
    /**
     * Login result codes by outcome, most frequent first: only the first login with each
     * recipe revision, kept for the evaluation corpus (ADR 0012).
     */
    firstLogins: v.array(v.strictObject({ outcome: v.string(), count: rowCount })),
    firstLoginsAuthenticated: rowCount,
    inputTokens: rowCount,
    outputTokens: rowCount,
    /** Estimated spend in this UTC day and month, whatever the range, and their limits. */
    spend: v.strictObject({
      dayMicroUsd: microUsd,
      monthMicroUsd: microUsd,
      dailyLimitMicroUsd: microUsd,
      monthlyLimitMicroUsd: microUsd,
    }),
    /** Active recipes now, whatever the range. */
    activeRecipes: rowCount,
    /**
     * Generation requests in the range that started a recipe and wrote its revision
     * (`recipe_page` `first` with a written `revision`): new recipes, and recipes
     * generated again after their revocation.
     */
    recipesGenerated: rowCount,
  }),
  /**
   * Request outcomes other than `ok` and login records whose result is not
   * `authenticated`, by code, most frequent first; `needsPerson` holds the logins that
   * waited for or were stopped by the person (`challenge`, `challenge-abandoned`,
   * `watch-abandoned`, `cancelled`), which are not failures.
   */
  failures: v.array(manageDashboardFailureSchema),
  needsPerson: v.array(manageDashboardFailureSchema),
});

/**
 * The identifiers an owner copies from their own Workload Identity Federation rule in
 * the Claude Console (ADR 0015). None is a secret.
 */
export const wifIdentifiersSchema = v.strictObject({
  federationRuleId: v.pipe(v.string(), v.regex(/^fdrl_[A-Za-z0-9]{1,64}$/)),
  organizationId: v.pipe(v.string(), v.uuid()),
  serviceAccountId: v.pipe(v.string(), v.regex(/^svac_[A-Za-z0-9]{1,64}$/)),
  workspaceId: v.pipe(v.string(), v.regex(/^wrkspc_[A-Za-z0-9]{1,64}$/)),
});

/** What the owner enters in the Claude Console, and the identifiers saved here. */
export const manageClaudeSchema = v.strictObject({
  version: v.literal(1),
  console: v.strictObject({
    /** Null while the operator has not configured this service's OIDC issuer. */
    issuer: v.nullable(v.pipe(v.string(), v.url())),
    /** The federation rule's exact subject: `owner:<ownerId>`. */
    subject: v.pipe(v.string(), v.startsWith("owner:")),
    audience: v.pipe(v.string(), v.url()),
  }),
  /** Null when none are saved, or when the saved row no longer validates. */
  identifiers: v.nullable(wifIdentifiersSchema),
  /** A row is saved but no longer validates; the owner enters the identifiers again. */
  storedInvalid: v.boolean(),
});
/** Replaces the owner's identifiers. */
export const manageClaudeWriteSchema = v.strictObject({
  version: v.literal(1),
  identifiers: wifIdentifiersSchema,
});

const httpStatus = v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599));
/**
 * The outcome of one token exchange with the saved identifiers. The token itself never
 * leaves the service.
 */
export const manageClaudeTestSchema = v.strictObject({
  version: v.literal(1),
  result: v.variant("status", [
    v.strictObject({
      status: v.literal("ready"),
      /** How long Anthropic said the token lasts. */
      expiresInSeconds: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    v.strictObject({
      status: v.picklist(["not_configured", "stored_invalid", "issuer_unavailable"]),
    }),
    v.strictObject({ status: v.literal("rejected"), httpStatus }),
    v.strictObject({ status: v.literal("failed"), httpStatus: v.optional(httpStatus) }),
  ]),
});

export const manageErrorCodeSchema = v.picklist([
  "bad_request",
  /** No Access token: the page must be reloaded through Access. */
  "unauthorized",
  /** The token failed verification, or the request came from another origin. */
  "forbidden",
  /** The service has no Access configuration. */
  "access_unavailable",
  /** Access's signing keys could not be fetched, so no token can be checked. */
  "access_keys_unavailable",
  "not_found",
  /**
   * Settings and Claude identifiers belong to an account with a paired device; this
   * identity has none.
   */
  "not_paired",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  /** A model choice names a model, effort or speed the model list does not offer. */
  "model_unavailable",
  /** Another profile already has the name. */
  "profile_name_taken",
  /** The owner's only profile cannot be deleted. */
  "last_profile",
  /** Too many requests from this identity in the last minute. */
  "rate_limited",
  "internal_error",
]);
export const manageErrorSchema = v.strictObject({ error: manageErrorCodeSchema });
/**
 * A profile that devices still use cannot be deleted; `devices` holds their labels, empty
 * labels included, so the page can name them (ADR 0076).
 */
export const manageProfileInUseSchema = v.strictObject({
  error: v.literal("profile_in_use"),
  devices: v.array(v.pipe(v.string(), v.maxLength(64))),
});

export type ManageDevice = v.InferOutput<typeof manageDeviceSchema>;
export type ManageDevices = v.InferOutput<typeof manageDevicesSchema>;
export type ManageSettingsWrite = v.InferOutput<typeof manageSettingsWriteSchema>;
export type ManageRecipe = v.InferOutput<typeof manageRecipeSchema>;
export type ManageUnreadableRecipe = v.InferOutput<typeof manageUnreadableRecipeSchema>;
export type ManageRecipes = v.InferOutput<typeof manageRecipesSchema>;
export type ManageLayoutSource = v.InferOutput<typeof manageLayoutSourceSchema>;
export type ManageRequestLog = v.InferOutput<typeof manageRequestLogSchema>;
export type ManageRequestLogDeleted = v.InferOutput<typeof manageRequestLogDeletedSchema>;
export type ManageProblem = v.InferOutput<typeof manageProblemSchema>;
export type ManageProblems = v.InferOutput<typeof manageProblemsSchema>;
export type ManageDashboardRange = v.InferOutput<typeof manageDashboardRangeSchema>;
export type ManageDurations = v.InferOutput<typeof manageDurationsSchema>;
export type ManageLoginParts = v.InferOutput<typeof manageLoginPartsSchema>;
export type ManageDashboardEvent = v.InferOutput<typeof manageDashboardEventSchema>;
export type ManageDashboardFailure = v.InferOutput<typeof manageDashboardFailureSchema>;
export type ManageDashboard = v.InferOutput<typeof manageDashboardSchema>;
export type WifIdentifiers = v.InferOutput<typeof wifIdentifiersSchema>;
export type ManageClaude = v.InferOutput<typeof manageClaudeSchema>;
export type ManageClaudeWrite = v.InferOutput<typeof manageClaudeWriteSchema>;
export type ManageClaudeTest = v.InferOutput<typeof manageClaudeTestSchema>;
export type ManageErrorCode = v.InferOutput<typeof manageErrorCodeSchema>;
export type ManageError = v.InferOutput<typeof manageErrorSchema>;
