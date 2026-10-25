import type {
  ChooserBranch,
  DeviceModel,
  DeviceModelCall,
  GenerationUnavailableReason,
  RecipeGenerationResult,
  SavedLoginBinding,
  SyncRecipeChange,
  SyncRecipeWrite,
} from "@pateat/contracts";
import type {
  ClaudeModelChoice,
  createClaudeGenerationModel,
  InferenceOutcome,
} from "@pateat/inference";
import type { RecipeUnit } from "./units";

// What the generation routes need from where they run (ADR 0040): the service's D1 and
// owner credential, or a device that holds its own key and recipes. The routes keep every
// decision; a backend only stores, reads and calls.

/**
 * Request bounds shared by both roles; the same as the benchmark. Every Opus 5.5 call in
 * the 2026-10-23 comparison that succeeded took under 7 s and wrote under 300 tokens
 * (owner decision, 2026-10-23 11:03 UTC).
 */
export const ROLE_LIMITS = { timeoutMs: 10_000, maxInputBytes: 64 * 1024, maxRetries: 0 };
export const MAX_OUTPUT_TOKENS = 1_024;

/**
 * Whether the page a generation request sent starts its recipe, or is an account switch's
 * logout page (ADR 0063), for the request log (ADR 0012).
 */
export const recipePages = ["first", "continuation", "logout"] as const;
export type RecipePage = (typeof recipePages)[number];

/**
 * What the judge answered for a page; `unclear` when the model abstained (ADR 0029), and
 * `partial` when it abstained on a description that left out a disabled field, so the
 * path is judged again once it is described in full; `optional` for a page after the
 * sign-in that the person may put off (ADR 0065).
 */
export const pageJudgementVerdicts = [
  "signed-in",
  "challenge",
  "rejected",
  "optional",
  "unclear",
  "partial",
] as const;
export type PageJudgementVerdict = (typeof pageJudgementVerdicts)[number];

/** How a recipe unit got its current content (ADR 0060, generation provenance). */
export const recipeUnitOrigins = ["generated", "judged", "device"] as const;
export type RecipeUnitOrigin = (typeof recipeUnitOrigins)[number];

export type ClaudeModel = ReturnType<typeof createClaudeGenerationModel>;

/** The model a call asked, as the request log keeps it, for the route that made the call. */
export type ServedModel = {
  provider: "anthropic";
  model: string;
  effort: ClaudeModelChoice["effort"];
  speed: "standard" | "fast";
};

/**
 * What a recipe write records of its units (ADR 0060, generation provenance): the units a
 * call made and the call, or a device's whole document, which names no call.
 */
export type UnitSources =
  | {
      origin: Extract<RecipeUnitOrigin, "generated" | "judged">;
      units: readonly RecipeUnit[];
      served: ServedModel;
      promptVersion: string;
      logId: string | undefined;
    }
  | { origin: "device" };

/** One model call a route makes, with what is logged of it (ADR 0012). */
export type GenerationCall<T> = {
  role: "generate" | "judge";
  /**
   * The role's prompt version (`generationPromptVersion`, `entryGenerationPromptVersion`,
   * `accountListGenerationPromptVersion`, `completionPromptVersion`).
   */
  promptVersion: string;
  origin: string;
  path: string;
  /** What is sent: the instructions and the input, as ADR 0012 requires. */
  request: { instructions: string; observation: unknown; [key: string]: unknown };
  /**
   * The recipe the call is for, logged beside the request: the head revision it starts
   * from (0 for none) and, for generation, whether the page starts the recipe. `layout` is
   * the key of the layout a first page's answer creates (ADR 0060); without it, the row's
   * layout is the one `branch` names.
   */
  recipe: {
    recipeId: string;
    branch: string;
    layout?: string;
    baseRevision: number;
    page?: RecipePage;
  };
  /**
   * Checked once the request holds one of the owner's call slots, before credentials are
   * resolved. Other requests of the owner may run their own checks and calls meanwhile.
   */
  gate?: (now: number) => Promise<GenerationUnavailableReason | undefined>;
  /**
   * Written just before the first model request is sent, so a request the role refuses
   * before sending, as `input-too-large`, writes nothing (ADR 0016, ADR 0027). A reason
   * stops the request there, unsent and uncharged: another request of the owner, running
   * at the same time, took what `gate` found free (ADR 0018).
   */
  beforeSend?: (now: number) => Promise<GenerationUnavailableReason | void>;
  invoke: (model: ClaudeModel) => Promise<InferenceOutcome<T>>;
  /** The structured result to log for an `ok` outcome. */
  logValue: (value: T) => unknown;
  /**
   * The device makes the model calls with its own key (ADR 0040): the owner's credential
   * and the spend stops take no part, and each call is one of `responses`, in order, or
   * the call the device makes next.
   */
  device?: DeviceModel | undefined;
};

/** What the request log keeps of a request answered without a model call (ADR 0012). */
export type UnsentRequest = Pick<
  GenerationCall<unknown>,
  "role" | "promptVersion" | "origin" | "path" | "request" | "recipe"
>;

/**
 * The code a request answered without a model call is logged under: its unavailable
 * reason or failure code, or `recipe` for a recipe another request stored.
 */
export type UnsentOutcome =
  | GenerationUnavailableReason
  | Extract<RecipeGenerationResult, { status: "failed" }>["error"]
  | "recipe";

/**
 * Milliseconds a call spent, as its request log row keeps them: from the request's start
 * to just before the model call, the credential's token exchange, and the model call.
 */
export type GenerationCallTimings = { preModelMs: number; tokenMs: number; modelMs: number };

export type GenerationCallResult<T> =
  /** `tokenMs` once the credential step ran, as for a missing credential or a failed exchange. */
  | { status: "unavailable"; reason: GenerationUnavailableReason; tokenMs?: number }
  /**
   * `logId` names the request log row. A call refused locally has none here: its route logs
   * it with the answer it gives (`logUnsent`).
   */
  | {
      status: "called";
      outcome: InferenceOutcome<T>;
      logId?: string;
      timings: GenerationCallTimings;
      /** The model that gave `outcome`: the last one asked. */
      served: ServedModel;
    }
  /**
   * The device makes the next model call (ADR 0040): the route answers with it, and has
   * written and logged nothing for it.
   */
  | { status: "device-call"; call: DeviceModelCall["call"] };

/** The page a judgement is kept for (ADR 0027): one per revision, origin, path and prompt. */
export type JudgementKey = {
  recipeId: string;
  branch: string;
  revision: number;
  origin: string;
  path: string;
  promptVersion: string;
};

/** A generation attempt's key (ADR 0016): the chooser branch is empty without one. */
export type AttemptKey = {
  recipeId: string;
  branch: string;
  origin: string;
  path: string;
  baseRevision: number;
};

/**
 * Where the generation routes run: one owner's and one device's recipes, limits, request
 * log and model calls, for one request.
 */
export interface GenerationBackend {
  /** The device the request is for: a repair's limit and each write name it. */
  readonly deviceId: string;
  readHead(recipeId: string): Promise<SyncRecipeChange | null>;
  /**
   * One kept revision of a recipe, read as a sync change is: `null` when the revision is
   * not kept, is a tombstone or no longer validates.
   */
  readRevision(recipeId: string, revision: number): Promise<SyncRecipeChange | null>;
  /** Whether the owner may hold one more active recipe. */
  hasRecipeRoom(): Promise<boolean>;
  /** Whether the owner's active recipes have room for `bytes` more. */
  hasRecipeByteRoom(bytes: number): Promise<boolean>;
  /**
   * The slots of the owner's saved bindings for one recipe of one origin, every account's
   * (ADR 0027, amended 2026-10-19): only slot names and field references.
   */
  bindingSlots(origin: string, recipeId: string): Promise<Pick<SavedLoginBinding, "slots">[]>;
  /** When each layout of the recipe was last used, by layout key (ADR 0060). */
  layoutUses(recipeId: string): Promise<ReadonlyMap<string, number> | undefined>;
  /** Marks a layout of the active head used now, when the head still has it (ADR 0060). */
  markLayoutUsed(recipeId: string, layout: string): Promise<void>;
  /**
   * Writes the next revision when `expectedRevision` is still the head. A write the owner's
   * limits refuse is `limited`; one another writer beat gets the current head.
   */
  writeRecipe(
    recipeId: string,
    write: SyncRecipeWrite,
    options: {
      sources?: UnitSources;
      /**
       * Units a layout the write adds takes over from another one, as the pages a later
       * step's repair copies from the stale layout (ADR 0041), under `branch`'s prefix when
       * they become a chooser branch's, as a passkey-only layout's handlers and markers
       * carried beside a list (ADR 0079).
       */
      copied?: { from: string; to: string; units: readonly string[]; branch?: ChooserBranch };
    },
  ): Promise<
    | { ok: true; change: SyncRecipeChange }
    | { ok: false; limited: false; current: SyncRecipeChange | null }
    | { ok: false; limited: true }
  >;

  /** Whether the attempt was made since `since` (ADR 0016). */
  attemptedSince(key: AttemptKey, since: number): Promise<boolean>;
  /**
   * Records the attempt at `now`, and forgets the owner's attempts made before `expired`,
   * in one write.
   */
  recordAttempt(key: AttemptKey, now: number, expired: number): Promise<void>;
  /** Whether this device asked to repair the recipe since `since` (ADR 0041). */
  repairedSince(recipeId: string, since: number): Promise<boolean>;
  /**
   * Records this device's repair of the recipe at `baseRevision`, and forgets the owner's
   * repairs made before `expired`, in one write.
   */
  recordRepair(recipeId: string, baseRevision: number, now: number, expired: number): Promise<void>;
  /** The kept judgement of a page, with its verdict (null while unanswered). */
  judgement(key: JudgementKey): Promise<{ verdict: PageJudgementVerdict | null } | undefined>;
  /** How many of the recipe's pages were judged since `since`. */
  judgementsSince(recipeId: string, since: number): Promise<number>;
  /**
   * Records a page's judgement at `now`, unanswered: a new row, or one whose verdict was
   * `partial` or `optional`, which takes today's slot again. With it, forgets the recipe's
   * rows judged before `expired` whose revision is below `revision` or whose prompt version
   * is none of `versions`. Both happen in one write; a row with any other verdict, or an
   * unanswered one, is left as it is. Returns whether this request took the row: false
   * when another request's row was there, as one written since this request's gate.
   */
  recordJudgement(
    key: JudgementKey,
    now: number,
    stale: { expired: number; versions: readonly string[] },
  ): Promise<boolean>;
  /** Keeps the page's verdict on its row; a failure only costs that. */
  keepVerdict(key: JudgementKey, verdict: PageJudgementVerdict): Promise<void>;

  /**
   * Makes a route's model calls: in one of the owner's call slots, after `gate`, with the
   * spend stops and the request log of where it runs.
   */
  call<T>(call: GenerationCall<T>): Promise<GenerationCallResult<T>>;
  /** Logs a request answered without a model call under its code (ADR 0012). */
  logUnsent(unsent: UnsentRequest, code: UnsentOutcome): Promise<void>;
  /** Names on a call's log row the recipe revision its answer wrote. */
  keepLogRevision(logId: string | undefined, revision: number): Promise<void>;
  /**
   * Keeps a repeat login's signed-in page in the request log (ADR 0029): false when the
   * owner already has a recent sample of the recipe and branch.
   */
  logPageSample(sample: UnsentRequest): Promise<boolean>;
}
