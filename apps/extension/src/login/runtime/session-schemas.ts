import * as v from "valibot";
import {
  loginDocumentSchema,
  detailFieldSchema,
  detailLinkSchema,
  loginDetailSchema,
  loginTargetSchema,
  type LoginFieldTarget,
  shownQuestionSchema,
  storedQuestionSchema,
  detailSourceFieldSchema,
  detailFormatFits,
  detailFormatSchema,
  loginFieldTargetSchema,
} from "@pateat/contracts";
import { askReasonSchema } from "../choice-wire";
import { isoTimeSchema } from "../../time";
import { RELOGIN_LIMIT } from "./constants";

export const STORAGE_KEY = "pateat.login-attempts.v5";

/** Accounts picked in the toolbar popup, per tab; session storage survives a worker restart. */
export const PICKS_KEY = "session:pateat.login-picks.v1";

export const CHOICES_KEY = "session:pateat.login-choices.v1";

/**
 * Tabs whose login of an origin stopped after a submission and whose login form then
 * showed again on a later page, or whose watched login was abandoned (ADR 0027); they ask
 * for an account, in that tab only, and fill the page once without pressing anything
 * (ADR 0021 D).
 */
export const STOPPED_ASKS_KEY = "session:pateat.login-stopped-asks.v1";

/**
 * Tabs whose login of an origin the site rejected; they ask for an account, and so do the
 * origin's other tabs while one asks, each filling a page once without pressing anything
 * (ADR 0021 D).
 */
export const REJECTED_ASKS_KEY = "session:pateat.login-rejected-asks.v1";

/**
 * Pages filled once while their tab asks for an account, as `${tabId} ${documentId} ${path}`,
 * and documents a rejected login keeps unfilled, as `${tabId} ${documentId}` (ADR 0021 D).
 */
export const ASK_FILLS_KEY = "session:pateat.login-ask-fills.v1";

/**
 * When automatic logins of a registrable site ended `authenticated`, by site and incognito,
 * so a site that keeps logging out again is not logged in over and over (ADR 0062).
 */
export const RELOGINS_KEY = "session:pateat.login-relogins.v1";

/**
 * Refusal reasons already logged, by tab, document and path, so a page that announces
 * again after a worker restart does not log the same reason as news (ADR 0019).
 */
export const NOTED_KEY = "session:pateat.login-noted.v1";

/**
 * Per tab, the `detail` handler its login stopped at for want of a linked value, and the
 * links filled from the popup that wait for the tab's login to be confirmed (ADR 0061).
 */
export const DETAIL_OFFERS_KEY = "session:pateat.login-detail-offers.v1";

export const PENDING_DETAILS_KEY = "session:pateat.login-pending-details.v1";

/**
 * Links whose value a site refused and that could not be removed from the settings yet;
 * no login uses them, and their removal is tried again after each login (ADR 0061).
 */
export const REFUSED_DETAILS_KEY = "session:pateat.login-refused-details.v1";

export const CONFIG_KEY = "pateat.login-probe-origin.v1";

/** Sign-in entry presses per tab, until the tab closes (ADR 0031). */
export const ENTRY_PRESSES_KEY = "session:pateat.login-entry-presses.v1";

/** Entry recipe revisions blocked on this device after a press that led nowhere (ADR 0031). */
export const ENTRY_BLOCKS_KEY = "pateat.login-entry-blocks.v1";

export const tabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

export const revisionSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * A sign-in entry press (ADR 0031), kept in session storage until its tab closes so the
 * one-press-per-10-minutes limit and the check of the next page survive a worker restart.
 * `documentId` and `url` are the pressed page's, so the same page announcing again is not
 * taken as the next one; `checked` once the next page passed or the recipe was blocked.
 */
export const entryPressSchema = v.strictObject({
  tabId: tabIdSchema,
  origin: v.string(),
  recipeId: v.string(),
  revision: revisionSchema,
  pressedAt: isoTimeSchema,
  documentId: v.string(),
  url: v.string(),
  checked: v.optional(v.literal(true)),
  /**
   * The time the login after the press took on the pressed page (ADR 0019): since when
   * that page was seen, with its service and person time. The login on the next page
   * takes it over once, and it is dropped then.
   */
  timing: v.optional(
    v.strictObject({
      since: v.pipe(v.number(), v.integer(), v.minValue(0)),
      serviceMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
      networkMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
      personMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
});

export type EntryPress = v.InferOutput<typeof entryPressSchema>;

/**
 * The times automatic logins of a registrable site ended `authenticated`, in epoch
 * milliseconds, in the browser's normal or incognito session (ADR 0062).
 */
export const reloginSchema = v.strictObject({
  site: v.string(),
  incognito: v.boolean(),
  at: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(0))), v.maxLength(RELOGIN_LIMIT)),
});

export type Relogins = v.InferOutput<typeof reloginSchema>;

/**
 * An entry recipe revision blocked on this device, until the recipe sync brings a newer
 * revision or removes it (ADR 0031). Revisions only grow, also for a recipe generated
 * again after a revocation, so a block never applies to a later revision.
 */
export const entryBlockSchema = v.strictObject({
  recipeId: v.string(),
  revision: revisionSchema,
  reason: v.picklist(["left-site", "no-sign-in", "sign-up"]),
  blockedAt: isoTimeSchema,
});

export type EntryBlock = v.InferOutput<typeof entryBlockSchema>;

/**
 * An account the user picked in the toolbar popup (ADR 0021). It is used instead of the
 * saved default by the refused document it restarted and then by the attempt that
 * document started, on that login's later pages too. It is saved as the default after
 * confirmed `authenticated` only with `makeDefault`.
 */
export const pickedAccountSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
  documentId: v.string(),
  /** Set once the picked login starts; until then the pick applies to `documentId` only. */
  attemptId: v.optional(v.string()),
  connectionId: v.string(),
  itemId: v.string(),
  makeDefault: v.boolean(),
  /** How long the popup offered the choice before the pick: the person's time (ADR 0019). */
  waitedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Chosen by the value the page set in its account input, not in the popup (ADR 0028
   * amendment of 2026-10-23): kept like a pick so the login's later pages use it too, and
   * never saved as the default.
   */
  site: v.optional(v.literal(true)),
});

export type PickedAccount = v.InferOutput<typeof pickedAccountSchema>;

/**
 * A document refused because several accounts match it, or because its tab asks for an
 * account (`ask`, ADR 0021 D, ADR 0062); the popup offers these candidates.
 */
export const pendingChoiceSchema = v.strictObject({
  document: loginDocumentSchema,
  /** When the document was first offered the choice, in epoch milliseconds (ADR 0019). */
  at: v.pipe(v.number(), v.integer(), v.minValue(0)),
  candidates: v.array(v.strictObject({ connectionId: v.string(), itemId: v.string() })),
  ask: v.optional(askReasonSchema),
  /** Refused because automatic login of the site is paused (ADR 0062). */
  paused: v.optional(v.literal(true)),
});

/**
 * A secret question the judge paired with one of the login item's custom fields (ADR 0061,
 * owner 2026-10-23): the answer input, the field, the question in its compared form, which
 * the page must show as one whole question, and as the judge copied it from the page
 * (`shown`, trimmed), for the popup only. The popup proposes it; only the owner's
 * confirmation links it.
 */
export const pairedQuestionSchema = v.strictObject({
  field: detailSourceFieldSchema.options[1],
  question: storedQuestionSchema,
  shown: shownQuestionSchema,
});

export type PairedQuestion = v.InferOutput<typeof pairedQuestionSchema> & {
  target: LoginFieldTarget;
};

/**
 * A `detail` handler that a tab's login stopped at because no linked vault field had a
 * value for it (ADR 0061); the popup proposes fields for it while the tab shows `document`.
 */
export const detailOfferSchema = v.strictObject({
  document: loginDocumentSchema,
  path: v.string(),
  attemptId: v.string(),
  /** The handler's index in the login's recipe, for the log. */
  handler: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The login item and its site. */
  account: v.strictObject({ connectionId: v.string(), itemId: v.string(), origin: v.string() }),
  /**
   * The handler's fields Pateat fills: one in one input, which for a secret question's
   * answer may carry the judge's pairing until the owner confirms it, or one split over
   * several inputs.
   */
  fields: v.pipe(
    v.array(
      v.union([
        v.pipe(
          v.strictObject({
            detail: loginDetailSchema,
            format: v.optional(detailFormatSchema),
            target: loginFieldTargetSchema,
            paired: v.optional(pairedQuestionSchema),
          }),
          v.check(
            (entry) => detailFormatFits(entry.detail, entry.format),
            "A birth date or card expiry input has a format of its own, and no other input has one",
          ),
        ),
        detailFieldSchema.options[1],
      ]),
    ),
    v.minLength(1),
    v.maxLength(3),
  ),
  /** The handler's button, which must still show for the popup's fill. */
  target: loginTargetSchema,
});

export type DetailOffer = v.InferOutput<typeof detailOfferSchema>;

/** A link filled from the popup, saved once the tab's login `attemptId` is confirmed. */
export const pendingDetailSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  attemptId: v.string(),
  handler: v.pipe(v.number(), v.integer(), v.minValue(0)),
  connectionId: v.string(),
  link: detailLinkSchema,
});

export type PendingDetail = v.InferOutput<typeof pendingDetailSchema>;

/** A refused link; a secret question's answer names its question's field too. */
export const refusedDetailSchema = v.strictObject({
  ...v.omit(detailLinkSchema, ["source"]).entries,
  field: v.optional(detailLinkSchema.entries.source.entries.field),
});

export type RefusedDetail = v.InferOutput<typeof refusedDetailSchema>;

/** A tab and origin that asks for an account until a pick logs in (ADR 0021 D). */
export const askSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
});

export type PendingChoice = v.InferOutput<typeof pendingChoiceSchema>;
