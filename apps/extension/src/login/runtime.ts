import * as v from "valibot";
import {
  attemptPlan,
  attemptRouteChoice,
  attemptUsesCode,
  builtInLoginSlots,
  chooseLoginRoute,
  createAttemptMetadata,
  defaultLoginBinding,
  effectfulStep,
  extendsRecipe,
  findLoginBinding,
  getItemEligibility,
  handlerFact,
  handlerSlots,
  handlerSteps,
  handlerTargets,
  isSiteExcluded,
  loginFieldFacts,
  loginFieldSource,
  judgedPages,
  MAX_JUDGED_PAGES,
  loginDocumentSchema,
  loginDisplayNames,
  loginObservationSchema,
  nextLoginOperation,
  loginStepEffect,
  parseAttemptMetadata,
  passwordVariants,
  recipeHasRoute,
  recipeStartSteps,
  recoverLoginAttempt,
  resolveBindingFields,
  resolveLoginPlan,
  routeSignInPaths,
  routeSignInTargets,
  routeSlots,
  sameLoginDocument,
  sameLoginTarget,
  saveLoginChoice,
  siteDefaultConnection,
  templateLoginBinding,
  TOTP_HANDLER_SLOT,
  transitionLoginAttempt,
  withdrawAccountSwitch,
  validateLoginOperation,
  valueShapeOf,
  type LoginAttemptEvent,
  type LoginAccount,
  type LoginBindingTemplate,
  type LoginAccountBinding,
  type LoginChoiceAccount,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginHandler,
  type LoginItemFacts,
  type LoginObservation,
  type LoginOperation,
  type LoginRecipe,
  type LoginRoute,
  type LoginRouteChoice,
  type LoginStep,
  type LoginTarget,
  type LocalSettings,
  type RecipeGenerationRequest,
  type SavedLoginBinding,
  type SemanticSlot,
  type SettingsResponse,
  type SettingsSnapshot,
  type ValueShape,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import {
  authorizeSchema,
  awaitResultSchema,
  cancelSchema,
  configureSchema,
  executionResultSchema,
  extractResultSchema,
  helloSchema,
  observationSchema,
  stateResultSchema,
  statusSchema,
  probeControlSchema,
  loginReadiness,
  HELD_CLICK_WAIT_MS,
  LOGIN_STEP_WAIT_MS,
  type LoginReadiness,
  type TargetState,
  type LoginSecretKind,
} from "./wire";
import {
  DEFAULT_PROBE_ORIGIN,
  DEMO_PROBE_ACCOUNT,
  grantProbeOrigin,
  probeBinding,
  probeRecipe,
  probeStarts,
  type ProbeAccount,
} from "./dummy";
import { findLiveSiteCandidates, type LiveUriMatcher } from "../vault/site-candidates";
import {
  choiceRequestSchema,
  pickRequestSchema,
  type ChoiceResponse,
  type PickResponse,
} from "./choice-wire";
import { customFieldOffers, type CustomFieldOffer } from "./generation-slots";
import { decideSignInState, reachedReturnTarget, type SignInSigns } from "./sign-in-state";
import type { LoginSites } from "./sites";
import {
  loginFillsUsername,
  loginSecretKind,
  loginUsernameFieldId,
  type LoginFieldSource,
} from "./vault";

const STORAGE_KEY = "pateat.login-attempts.v3";
/** The previous attempt store, removed on load; its records are not read. */
const RETIRED_STORAGE_KEY = "pateat.login-attempts.v2";
/** Accounts picked in the toolbar popup, per tab; session storage survives a worker restart. */
const PICKS_KEY = "pateat.login-picks.v1";
const CHOICES_KEY = "pateat.login-choices.v1";
const LOGOUTS_KEY = "pateat.login-logouts.v1";
/** Documents filled once after a logout, as `${tabId} ${documentId}` (ADR 0021 D). */
const LOGOUT_FILLS_KEY = "pateat.login-logout-fills.v1";
const CONFIG_KEY = "pateat.login-probe-origin.v1";
/**
 * How long another tab's login that has not succeeded holds its origin after its record
 * last changed (ADR 0022, owner's choice on 2026-10-12).
 */
const HOLD_MS = 5 * 60_000;
/**
 * How often a login page offered for generation is read before it counts as one that
 * cannot be described, and how long apart: a form rendered in steps settles meanwhile.
 */
const EXTRACT_READS = 3;
const EXTRACT_RETRY_MS = 1000;
type Sender = Browser.runtime.MessageSender;
type SettingsRuntime = {
  handle(value: unknown): Promise<SettingsResponse>;
  /** Trusted background mutation; saves an automatic account choice after `authenticated`. */
  update?(
    expectedRevision: number | undefined,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ): Promise<SettingsSnapshot>;
};
/**
 * An account choice used by an attempt but not saved yet (ADR 0013); `connectionId` is the
 * local connection the attempt used, so only that account is saved. A login on the
 * `passkey` route fills nothing, so it saves the site default without a binding (ADR 0027).
 */
type UnsavedChoice = {
  binding: SavedLoginBinding | LoginChoiceAccount;
  connectionId: string;
  replace?: boolean;
};
/**
 * Settings with the choice added where missing, or replacing the site default for an
 * account picked to become it; the same object when nothing changes.
 */
const withChoice = (value: SettingsSnapshot["settings"], choice: UnsavedChoice) =>
  saveLoginChoice(value, choice.binding, { replace: choice.replace === true });
type LiveDocument = {
  document: LoginDocument;
  token: string;
  /**
   * The document's browser-provided URL: the tab's committed URL for a same-origin top
   * document (it follows history.pushState), else `sender.url`. Provider URI rules match it.
   */
  url: string;
  path: string;
  /**
   * For a document in a frame inside the page: the tab's URL. The account must match it
   * as well as the frame's own URL (ADR 0017).
   */
  topUrl?: string;
  state?: string;
  reason?: string;
  /** A provider URI match for this document only, valid while its snapshot is unchanged. */
  uriMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** A single-match account choice, valid while every connection's snapshot is unchanged. */
  autoChoice?: { snapshots: string; connectionId: string; itemId: string };
  /** A provider URI match for `topUrl`, valid while its snapshot is unchanged. */
  topMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** Why generation last skipped this document, so each reason is logged once. */
  generationSkip?: string;
  /** Why this document's sign-in input last did not start a login, logged once. */
  notStarted?: string;
};
/** Documents are tracked per frame; a tab still runs at most one attempt. */
const frameKey = (document: { tabId: number; frameId: number }) =>
  `${document.tabId}:${document.frameId}`;
/**
 * Attempt records are kept per tab and origin: each origin a tab shows keeps its own
 * record until the tab closes, while the tab still runs one attempt at a time.
 */
const recordKey = (tabId: number, origin: string) => `${tabId} ${origin}`;
/**
 * An account the user picked in the toolbar popup (ADR 0021). It is used instead of the
 * saved default by the refused document it restarted and then by the attempt that
 * document started, on that login's later pages too. It is saved as the default after
 * `authenticated` only with `makeDefault`.
 */
const pickedAccountSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
  documentId: v.string(),
  /** Set once the picked login starts; until then the pick applies to `documentId` only. */
  attemptId: v.optional(v.string()),
  connectionId: v.string(),
  itemId: v.string(),
  makeDefault: v.boolean(),
});
type PickedAccount = v.InferOutput<typeof pickedAccountSchema>;
/**
 * A document refused because several accounts match it, or because its tab logged out
 * of the site (`logout`, ADR 0021 D); the popup offers these candidates.
 */
const pendingChoiceSchema = v.strictObject({
  document: loginDocumentSchema,
  candidates: v.array(v.strictObject({ connectionId: v.string(), itemId: v.string() })),
  logout: v.optional(v.literal(true)),
});
/** A tab and origin that logged out after a Pateat login; it asks until a pick logs in. */
const logoutSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  origin: v.string(),
});
/**
 * A login that ended with a result, or that ended when the tab left its origin (ADR 0022);
 * its first step showing again in the tab's page means a logout (ADR 0021 D). A switch,
 * a stop, or a result still being reconciled does not.
 */
const finishedLogin = (metadata: LoginAttemptMetadata) =>
  metadata.state === "authenticated" ||
  (metadata.state === "blocked" &&
    ["credential-rejected", "wrong-account", "left-origin", "interrupted"].includes(
      metadata.outcome ?? "",
    ));
/**
 * A login Pateat itself stopped with nothing in flight: a withdrawn authorization, a
 * cancel, a value the page would not take, or another account shown. It does not hold the origin
 * against other tabs (ADR 0022). A refusal by the site, a second-factor challenge, a
 * submission limit, an operation the page may have received or a result that may still
 * arrive keeps holding.
 */
const stoppedByPateat = (metadata: LoginAttemptMetadata) =>
  metadata.state === "blocked" &&
  (["policy-changed", "value-mismatch", "wrong-account", "account-switched"].includes(
    metadata.outcome ?? "",
  ) ||
    // A frame login whose page went away also ends `cancelled`; after a submission that
    // is the tab leaving, which holds like `interrupted`.
    (metadata.outcome === "cancelled" && metadata.submissions === 0)) &&
  metadata.mutationIntent !== true &&
  metadata.settled !== true &&
  !(metadata.operationKind === "click" && metadata.operationId !== undefined);
type PendingChoice = v.InferOutput<typeof pendingChoiceSchema>;
type Execution = {
  metadata: LoginAttemptMetadata;
  /** A fill-only login's accounts, offered once it ends (ADR 0021 D). */
  asked?: PendingChoice["candidates"];
  recipe: LoginRecipe;
  live: LiveDocument;
  running: boolean;
  operation?: LoginOperation;
  /** `operation` was sent to the page, so its effect may have started. */
  delivered?: boolean;
  /** Saved only once this attempt reaches `authenticated`. */
  choice?: UnsavedChoice;
  /**
   * The step index of a held click this document performed (ADR 0027): a handler's click
   * or the `passkey` route's. Its page is not judged while the clicked button still shows.
   */
  heldClick?: number;
  /**
   * The elements of the step after an advance on the same path, as the document measured
   * them in the same task as the advance, just before it (ADR 0013): only elements that
   * were not usable then confirm it. Kept in memory and carried to the attempt's next
   * document, never stored.
   */
  inPlace?: { operationId: string; before: TargetState[] };
};
/** An in-memory catalog copy in which one item covers `origin`; never persisted. */
function withItemOrigin(
  catalog: VaultCatalog,
  account: { connectionId: string; itemId: string },
  origin: string,
): VaultCatalog {
  const granted = structuredClone(catalog);
  const item = granted.connections
    .find((entry) => entry.id === account.connectionId)
    ?.items.find((entry) => entry.id === account.itemId);
  if (item && !item.allowedOrigins.includes(origin)) item.allowedOrigins.push(origin);
  return granted;
}
/** Internal: admit again, because an account choice was saved while admitting (ADR 0022). */
const CHOICE_SAVED = "choice-saved";
const terminal = (metadata: LoginAttemptMetadata) =>
  ["authenticated", "blocked"].includes(metadata.state);

/**
 * Where one recipe starts: its start path and the first step of each of its routes and
 * variants, all on that path (ADR 0027).
 */
export type LoginRecipeStart = { path: string; steps: LoginStep[] };
/**
 * Cached recipes. Account bindings come from synced settings (`settings.bindings`,
 * ADR 0013); neither carries values.
 */
export interface LoginRecipes {
  /** The recipe for a document, or an attempt's own recipe by ID after navigation. */
  recipe(origin: string, path: string, recipeId?: string): Promise<LoginRecipe | undefined>;
  /** Where every recipe for the origin starts; a document watches for its first steps. */
  starts(origin: string): Promise<LoginRecipeStart[]>;
}
export const noLoginRecipes: LoginRecipes = {
  recipe: async () => undefined,
  starts: async () => [],
};

/**
 * Why a page is not sent now: no paired service, its request is in flight, or a request
 * for it reached the model within the retry window (ADR 0016).
 */
export type GenerationHold = "not-connected" | "sending" | "sent";
/**
 * What came of one page offered for generation, for the local log: the model's recipe or
 * abstention, a failure or refusal with its code, or why nothing was sent.
 */
export type GenerationOutcome =
  | { outcome: "recipe" }
  | { outcome: "abstained" | "failed" | "unavailable" | "skipped"; reason: string }
  | {
      outcome: "failed";
      reason: "invalid-output";
      /** Which check refused the model's output (`json`, `schema` or `plan`). */
      check: "json" | "schema" | "plan";
      /** The plan check's code or the output format's issue. */
      detail?: string;
      /** For an output format issue: where in the output it was. */
      path?: string;
    };

/** The service's recipe generation routes (ADR 0016, ADR 0018). */
export interface LoginGeneration {
  /** `true` when a page may be sent, else why not. */
  available(origin: string, path: string): Promise<true | GenerationHold>;
  /**
   * Sends one page; `recipe` once the generated recipe is in the recipe cache and the
   * fields its custom slots name are remembered for `slotFields`.
   */
  generate(request: RecipeGenerationRequest): Promise<GenerationOutcome>;
  /**
   * Which vault field each custom slot of a recipe generated from this device names, from
   * the request that produced it (ADR 0027); nothing for a recipe it did not generate.
   */
  slotFields(recipeId: string): Promise<LoginBindingTemplate | undefined>;
  /**
   * Sends a page no recipe check explained after an effect step, so the service can
   * learn the completion or a handler (ADR 0027). `recipe` is the newer
   * revision with a handler added, already in the recipe cache.
   */
  judge(
    recipeId: string,
    revision: number,
    route: LoginRoute,
    observation: LoginObservation,
  ): Promise<{
    /**
     * `retry` for a temporary refusal before any model call, which gives the page back:
     * no paired service, a rejected device, an unreachable or busy service, the service's
     * own request limit, or a request that failed before the model. `unclear` covers
     * every other answer, including permanent refusals and failed model calls.
     */
    verdict: "signed-in" | "rejected" | "challenge" | "unclear" | "retry";
    /** For `retry` and `unclear`: the refusal or failure code, for the local log. */
    reason?: string;
    recipe?: LoginRecipe;
  }>;
}

/**
 * Slot meanings sent for generation, each read from the vault item's built-in field of
 * the same name by `defaultLoginBinding`.
 */
const generationSlots: { slot: SemanticSlot; fieldId: string }[] = [
  { slot: builtInLoginSlots.username, fieldId: "login.username" },
  { slot: builtInLoginSlots.password, fieldId: "login.password" },
  { slot: builtInLoginSlots.totp, fieldId: "login.totp-code" },
];
/**
 * Whether a matching item offers a generation slot's built-in field. The password counts
 * only when it holds a value and is not excluded (ADR 0027); the TOTP field counts when
 * present, so the TOTP flag never decides what the model is offered.
 */
function offersGenerationField(
  settings: LocalSettings,
  entry: { connectionId: string; item: VaultItemMetadata },
  fieldId: string,
): boolean {
  const field = entry.item.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return false;
  if (fieldId !== "login.password") return true;
  return (
    field.empty !== true &&
    !settings.connections.some(
      (connection) =>
        connection.connectionId === entry.connectionId &&
        connection.excludedFields.some(
          (ref) => ref.itemId === entry.item.id && ref.fieldId === fieldId,
        ),
    )
  );
}
/**
 * The field a `totp` handler fills for the login's item (ADR 0027): its built-in TOTP
 * field, or the synthetic probe item's `totp` field. Undefined when the item has none, or
 * when the item's saved binding for the recipe names another field for `totp`: Pateat
 * cannot make a code from a custom field yet, so it never types such a field's raw value,
 * which could be a TOTP seed.
 */
function codeFieldOf(
  connection: VaultConnectionMetadata,
  itemId: string,
  bindings: readonly SavedLoginBinding[],
  recipe: LoginRecipe,
): string | undefined {
  const item = connection.items.find((entry) => entry.id === itemId);
  if (!item) return undefined;
  if (connection.provider === "dummy")
    return item.fields.some((field) => field.id === "totp") ? "totp" : undefined;
  if (connection.provider !== "bitwarden" || !connection.userId) return undefined;
  const saved = findLoginBinding(bindings, recipe, {
    provider: connection.provider,
    userId: connection.userId,
    itemId,
  });
  if (saved?.slots.some((entry) => entry.slot === TOTP_HANDLER_SLOT && entry.field !== "totp"))
    return undefined;
  return item.fields.some((field) => field.id === "login.totp-code")
    ? "login.totp-code"
    : undefined;
}
/**
 * Where the plan step at `index` stands in an entered `totp` handler (ADR 0027): its code
 * fill, or the click on its button that follows the fill.
 */
function codeStep(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): "fill" | "click" | undefined {
  const plan = attemptPlan(recipe, metadata);
  const entry = plan?.[index];
  if (entry?.handler === undefined || recipe.handlers?.[entry.handler]?.kind !== "totp")
    return undefined;
  if (entry.step.kind === "fill") return "fill";
  const before = plan![index - 1];
  return entry.step.kind === "click" &&
    before?.handler === entry.handler &&
    before.step.kind === "fill"
    ? "click"
    : undefined;
}
/**
 * Whether a `totp` handler's fill went in, or may have, and its click has not run (ADR
 * 0027): a page that moved on meanwhile submitted the code by itself.
 */
const codeAwaitsClick = (recipe: LoginRecipe, metadata: LoginAttemptMetadata) =>
  metadata.operationId === undefined
    ? codeStep(recipe, metadata, metadata.stepIndex) === "click"
    : metadata.operationKind === "fill" &&
      metadata.operationEffect === "prepare" &&
      metadata.mutationIntent === true &&
      codeStep(recipe, metadata, metadata.stepIndex) === "fill";
/** The step may have submitted or moved the page, so its result can show a handler. */
const effectful = (metadata: LoginAttemptMetadata) =>
  metadata.operationKind === "click" ||
  metadata.operationEffect === "advance" ||
  metadata.operationEffect === "submit";
const stepTargets = (step: LoginStep) =>
  step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target];
/**
 * What confirms the route step at `index` when it is an advance whose next route step is
 * on the same path, as an identifier-first form that swaps in its password form in place
 * (ADR 0013): the next step's elements, as that step waits for them. Undefined when no
 * element could confirm it: a next step that needs none, one that shares an element with
 * the advance, or a handler's step, which keeps its own rules (ADR 0027).
 */
function inPlaceNext(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): LoginReadiness | undefined {
  const plan = attemptPlan(recipe, metadata);
  const done = plan?.[index];
  const next = plan?.[index + 1];
  if (
    !done ||
    !next ||
    done.handler !== undefined ||
    next.handler !== undefined ||
    loginStepEffect(done.step) !== "advance" ||
    done.step.path !== next.step.path
  )
    return undefined;
  const readiness = loginReadiness(next.step);
  const own = stepTargets(done.step);
  if (
    !readiness.targets.length ||
    readiness.targets.some((target) => own.some((other) => sameLoginTarget(other, target)))
  )
    return undefined;
  return readiness;
}
const probeMode = import.meta.env.MODE === "probe";
/** The order in which handlers shown together are tried: a passkey types nothing. */
const handlerOrder = { passkey: 0, totp: 1 } as const satisfies Record<
  LoginHandler["kind"],
  number
>;

/** Custom-field values read for their shapes per generation request (ADR 0027). */
const MAX_CUSTOM_SHAPE_READS = 32;

/** What a page without a recipe is sent with: its slots and the items that matched it. */
type GenerationScope = {
  /** The built-in slots a matching item can fill. */
  slots: SemanticSlot[];
  /** One slot per custom field a matching item allows, numbered over all of them. */
  offers: CustomFieldOffer[];
  items: {
    connection: VaultConnectionMetadata;
    item: VaultCatalog["connections"][number]["items"][number];
  }[];
  settings: SettingsSnapshot["settings"];
  /** Every enabled connection answered and every item's URI rules were evaluated. */
  complete: boolean;
};

/**
 * Coordinator is packaged production code. Production admits only `sites` documents and
 * uses `recipes`; the loopback probe adapter and its controls exist only in the probe build.
 * Account metadata comes from each live settings read; values come from `fields` per fill.
 */
/**
 * A value-free account of what the runtime decided, for the local log (ADR 0019). The
 * origin and recipe ID are reduced there; account and item IDs are never included.
 */
export type LoginReport =
  | {
      type: "attempt";
      tabId: number;
      origin: string;
      recipeId: string;
      /** The route and password variant the login took when it started (ADR 0027). */
      route: LoginRoute;
      variant?: number;
      state: LoginAttemptMetadata["state"];
      stepIndex: number;
      stepCount: number;
      /** The current step's kind and effect, and the entered handler it belongs to. */
      operation?: string;
      effect?: string;
      handler?: number;
      outcome?: string;
      /** For a `policy-changed` outcome: its cause, and a refused plan's reason. */
      cause?: PolicyChangeCause;
      reason?: string;
      /** The result of the current effect step just settled as unknown (`unknown-submit`). */
      settled?: true;
      /** A new document of the tab resumed the attempt without changing its state or outcome. */
      repeat?: true;
    }
  | {
      type: "refused";
      tabId: number;
      origin: string;
      reason: string;
      /** The refused document is a frame, not the tab's page. */
      frame?: true;
      /**
       * For `no-route` on a recipe with several password variants: why its first variant
       * did not fit, such as `binding-not-found` (ADR 0027). For `logged-out`, which tab
       * logged out; for `not-started`, why a shown sign-in input did not start a login.
       */
      detail?: string;
    }
  | ({ type: "generation"; tabId: number; origin: string } & GenerationOutcome)
  | {
      type: "judge";
      tabId: number;
      origin: string;
      recipeId: string;
      recipeRevision: number;
      route: LoginRoute;
      /**
       * `sent` when the page goes out; the service's verdict when it answers; `not-sent`,
       * with the reason, when the page is not sent or could not be described for it.
       */
      verdict: "sent" | "not-sent" | "signed-in" | "rejected" | "challenge" | "unclear" | "retry";
      reason?: string;
      /** For a returned revision: whether this login took it over. */
      takenOver?: boolean;
    }
  | ({
      type: "state";
      tabId: number;
      origin: string;
      recipeId: string;
      route: LoginRoute;
      /** What ADR 0029 would do with the page; logged only (delivery 1). */
      decision: ReturnType<typeof decideSignInState>;
      /** A later page of an attempt whose result already settled as unknown. */
      settled?: true;
    } & SignInSigns)
  | {
      type: "handler";
      tabId: number;
      origin: string;
      recipeId: string;
      handler: number;
      kind: string;
      /**
       * `entered`; `shown-again` after this login already ran it; `missing-fact` when the
       * item lacks what the handler needs, including a `totp` handler's built-in field;
       * `code-used` when the login already types a TOTP code; `no-room` when the attempt's
       * budget is spent.
       */
      outcome: "entered" | "shown-again" | "missing-fact" | "code-used" | "no-room";
      steps: number;
    };
/**
 * What withdrew a running login's authorization (`POLICY_CHANGED`): a settings sync or a
 * save on the settings page; a settings revision other than the login's, or settings that
 * could not be read; a plan the
 * settings or vault no longer allow; a vault snapshot replaced before delivery; or a
 * vault field that could not be read.
 */
export type PolicyChangeCause =
  | "settings-synced"
  | "settings-saved"
  | "settings-revision"
  | "settings-unavailable"
  | "plan"
  | "vault-replaced"
  | "field-unavailable";
type PolicyChange = { cause: PolicyChangeCause; reason?: string };

export function createLoginRuntime(
  settings: SettingsRuntime,
  options: {
    fields: LoginFieldSource;
    sites?: LoginSites;
    recipes?: LoginRecipes;
    /** Live provider URI matching; without it only static `allowedOrigins` apply. */
    uris?: LiveUriMatcher;
    /** Recipe generation for pages without a recipe; needs `uris` for the vault match. */
    generation?: LoginGeneration;
    /**
     * The account item's passkey facts, read once when a login starts (ADR 0027). Without
     * it the item counts as holding no passkey, so a `passkey` handler is never run.
     */
    passkeys?: (account: LoginAccount) => Promise<{ passkey: boolean; discoverable: boolean }>;
    /** Receives each attempt state change, refusal and generation result. */
    report?: (report: LoginReport) => void;
    /**
     * Automatic vault sync (ADR 0025). Each page announcement starts a due check and
     * holds vault replacement off while it is handled; a page that may start a login
     * first waits briefly for a running check.
     */
    vault?: {
      refreshIfStale(): void;
      enter(waitForCheck: boolean): Promise<() => void>;
      /**
       * Asked when a page with a recipe found no matching vault item: a check limited to
       * once every ten seconds. Answers true when a check applied a new snapshot within
       * ten seconds, after which the refused document is asked to announce again.
       */
      checkAfterMiss?(): Promise<boolean>;
    };
  },
) {
  const { fields, sites, recipes = noLoginRecipes, uris, generation } = options;
  const report = (value: LoginReport) => {
    try {
      options.report?.(value);
    } catch {
      // A report must never change the answer.
    }
  };
  const reportAttempt = (
    metadata: LoginAttemptMetadata,
    recipe: LoginRecipe | undefined,
    policy?: PolicyChange,
    flags: { settled?: true; repeat?: true } = {},
  ) => {
    // Handler steps sit inside the plan, so the plan names the handler a step belongs to.
    const handler =
      recipe && metadata.handlers.length
        ? attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler
        : undefined;
    report({
      type: "attempt",
      tabId: metadata.document.tabId,
      origin: metadata.document.origin,
      recipeId: metadata.recipeId,
      route: metadata.route,
      ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
      state: metadata.state,
      stepIndex: metadata.stepIndex,
      stepCount: metadata.stepCount,
      ...(metadata.operationKind ? { operation: metadata.operationKind } : {}),
      ...(metadata.operationEffect ? { effect: metadata.operationEffect } : {}),
      ...(handler === undefined ? {} : { handler }),
      ...(metadata.outcome ? { outcome: metadata.outcome } : {}),
      ...(metadata.fillOnly ? { reason: "fill-only" } : {}),
      ...(policy && metadata.outcome === "policy-changed" ? policy : {}),
      ...flags,
    });
  };
  let origin = DEFAULT_PROBE_ORIGIN;
  let account: ProbeAccount = DEMO_PROBE_ACCOUNT;
  let probePasskey: "discoverable" | "second-factor" | undefined;
  let probeTotp = false;
  const documents = new Map<string, LiveDocument>();
  const attempts = new Map<number, Execution>();
  // ADR 0029's sign-in state reads these, kept in memory only and never stored.
  /**
   * By tab: when the attempt last delivered an effect step, and whether the step itself asks
   * for a passkey (the `passkey` route, or a `passkey` handler's click), so S5 skips it.
   */
  const effects = new Map<number, { attemptId: string; at: number; passkey: boolean }>();
  /** By tab: the URL of the document the attempt's first fill ran in, for E3. */
  const signInUrls = new Map<number, { attemptId: string; url: string }>();
  /** By tab and origin: the last passkey request of the top document, outside conditional mediation. */
  const passkeyRequests = new Map<string, number>();
  /** By `recordKey`, in the order they were last written. */
  const persisted = new Map<string, LoginAttemptMetadata>();
  const picked = new Map<number, PickedAccount>();
  const pending = new Map<number, PendingChoice>();
  /** By `recordKey`: tabs that logged out of an origin and have not picked an account yet. */
  const logouts = new Set<string>();
  /**
   * Documents filled once after a logout, so neither a re-announcement nor a restarted
   * worker fills over what the user typed (ADR 0021 D). The oldest go first.
   */
  const logoutFills = new Set<string>();
  /** Account choices being saved; each bumps the policy revision (ADR 0022). */
  const savingChoices = new Set<Promise<void>>();
  /** Counts account choices saved or attempted, so a new login sees a bump it missed. */
  let remembered = 0;
  // Toolbar and session storage failures only lose the badge or a pick; never a login.
  const quietly = (work: () => Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        () => undefined,
      );
  // Picks and waiting choices outlive a worker restart, as the tab's badge does. Every
  // change to them happens after this load.
  const sessionLoaded = quietly(async () => {
    const stored = await browser.storage.session.get([
      PICKS_KEY,
      CHOICES_KEY,
      LOGOUTS_KEY,
      LOGOUT_FILLS_KEY,
    ]);
    const picks = v.safeParse(v.array(pickedAccountSchema), stored[PICKS_KEY] ?? []);
    if (picks.success) for (const entry of picks.output) picked.set(entry.tabId, entry);
    const choices = v.safeParse(v.array(pendingChoiceSchema), stored[CHOICES_KEY] ?? []);
    if (choices.success)
      for (const entry of choices.output) pending.set(entry.document.tabId, entry);
    const left = v.safeParse(v.array(logoutSchema), stored[LOGOUTS_KEY] ?? []);
    if (left.success)
      for (const entry of left.output) logouts.add(recordKey(entry.tabId, entry.origin));
    const filled = v.safeParse(
      v.pipe(v.array(v.string()), v.maxLength(256)),
      stored[LOGOUT_FILLS_KEY] ?? [],
    );
    if (filled.success) for (const entry of filled.output) logoutFills.add(entry);
  });
  async function saveSession(): Promise<void> {
    await browser.storage.session.set({
      [PICKS_KEY]: [...picked.values()],
      [CHOICES_KEY]: [...pending.values()],
      [LOGOUTS_KEY]: [...logouts].map((key) => {
        const at = key.indexOf(" ");
        return { tabId: Number(key.slice(0, at)), origin: key.slice(at + 1) };
      }),
      [LOGOUT_FILLS_KEY]: [...logoutFills],
    });
  }
  /** Badges the tab and records the refused document for the popup (ADR 0021). */
  function offerChoice(
    document: LoginDocument,
    candidates: PendingChoice["candidates"],
    logout = false,
  ): void {
    pending.set(document.tabId, { document, candidates, ...(logout ? { logout } : {}) });
    void quietly(saveSession);
    const { tabId } = document;
    void quietly(() => browser.action.setBadgeText({ tabId, text: String(candidates.length) }));
    void quietly(() =>
      browser.action.setTitle({
        tabId,
        title: logout
          ? logouts.has(recordKey(tabId, document.origin))
            ? "Pateat: you logged out of this site in this tab. Click to choose an account."
            : "Pateat: you logged out of this site in another tab. Click to choose an account."
          : `Pateat: ${candidates.length} accounts match this page. Click to choose one.`,
      }),
    );
  }
  function clearChoice(tabId: number): void {
    if (!pending.delete(tabId)) return;
    void quietly(saveSession);
    void quietly(() => browser.action.setBadgeText({ tabId, text: "" }));
    void quietly(() => browser.action.setTitle({ tabId, title: "Pateat" }));
  }
  let storageQueue: Promise<void> = Promise.resolve();
  let storageHealthy = true;
  let checkpoint: "before-delivery" | "before-ack" | undefined;
  let armed: "before-delivery" | "before-ack" | "intent-write-failure" | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseCheckpoint: (() => void) | undefined;
  async function pause(at: "before-delivery" | "before-ack"): Promise<void> {
    if (import.meta.env.MODE !== "probe" || armed !== at) return;
    clearTimeout(armTimer);
    armed = undefined;
    checkpoint = at;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        releaseCheckpoint = undefined;
        checkpoint = undefined;
        reject(new Error("Synthetic checkpoint expired"));
      }, 5000);
      releaseCheckpoint = () => {
        clearTimeout(timer);
        checkpoint = undefined;
        releaseCheckpoint = undefined;
        resolve();
      };
    });
  }
  const loaded = (async () => {
    try {
      await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      const storage = await browser.storage.local.get([STORAGE_KEY, CONFIG_KEY]);
      await browser.storage.local.remove(RETIRED_STORAGE_KEY).catch(() => undefined);
      const config: unknown = storage[CONFIG_KEY];
      if (probeMode && config !== undefined) {
        const parsed = v.parse(configureSchema, {
          version: 1,
          type: "login.probe.configure",
          ...(config as object),
        });
        origin = parsed.origin;
        account = parsed.account ?? DEMO_PROBE_ACCOUNT;
        probePasskey = parsed.passkey;
        probeTotp = parsed.totp === true;
      }
      const stored = storage[STORAGE_KEY];
      if (stored === undefined) return;
      if (!Array.isArray(stored) || stored.length > 100) throw new Error("Invalid attempt store");
      for (const entry of stored) {
        const metadata = recoverLoginAttempt(parseAttemptMetadata(entry));
        const key = recordKey(metadata.document.tabId, metadata.account.origin);
        if (persisted.has(key)) throw new Error("Duplicate attempt scope");
        persisted.set(key, metadata);
      }
      // Complete startup reconciliation before accepting any hello or checking
      // ownership. Closing a tab can wake a worker whose in-memory map is empty.
      const openTabs = await browser.tabs.query({});
      const liveIds = new Set(openTabs.map((tab) => tab.id));
      for (const [key, metadata] of persisted)
        if (!liveIds.has(metadata.document.tabId)) persisted.delete(key);
      await browser.storage.local.set({ [STORAGE_KEY]: [...persisted.values()] });
    } catch {
      storageHealthy = false;
    }
  })();
  const hellos = new Map<string, number>();
  /** The latest announcement of each frame while it is admitted, by the same key. */
  const admitting = new Map<string, Promise<unknown>>();
  const probeDocument = (url: URL) =>
    probeMode && url.origin === origin && url.protocol === "http:" && url.hostname === "127.0.0.1";
  // The synthetic fixture embeds its frames in a page on another loopback port to test refusal.
  const probeTop = (url: URL) =>
    probeMode && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const admitted = async (url: URL) =>
    probeDocument(url) || Boolean(sites && (await sites.admits(url)));
  /**
   * The browser-identified document. A frame inside the page is admitted only when the
   * tab's page is admitted too; excluded sites stop it on either side (ADR 0017).
   */
  async function identify(sender: Sender): Promise<LoginDocument | undefined> {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab?.id === undefined ||
      sender.frameId === undefined ||
      !sender.documentId ||
      // A prerendered page also has a nonzero frame ID; it is not a frame of the tab.
      (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
      !sender.url
    )
      return undefined;
    try {
      const url = new URL(sender.url);
      if (!(await admitted(url))) return undefined;
      if (sender.frameId !== 0) {
        const top = sender.tab.url ? new URL(sender.tab.url) : undefined;
        if (!top || !(probeTop(top) || (await admitted(top)))) return undefined;
      }
      return {
        origin: url.origin,
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
      };
    } catch {
      return undefined;
    }
  }
  const trusted = (sender: Sender) =>
    sender.id === browser.runtime.id &&
    sender.url === browser.runtime.getURL("/options.html") &&
    !sender.tab?.url?.startsWith("http:");
  /**
   * The record of a tab for one origin, also once it ended. A document resumes only its
   * own origin's record; a logout may release exactly this one.
   */
  function recordFor(tabId: number, documentOrigin: string): LoginAttemptMetadata | undefined {
    const run = attempts.get(tabId);
    return run?.metadata.account.origin === documentOrigin
      ? run.metadata
      : persisted.get(recordKey(tabId, documentOrigin));
  }
  /**
   * Whether another tab's login still holds the origin. Cookies can be shared across tabs,
   * so a login that is running, awaits its result, or ended without success there keeps this
   * tab from submitting until that tab closes or its record has not changed for
   * `HOLD_MS` (ADR 0022). One that authenticated, ended without ever submitting, or was
   * stopped by Pateat with nothing in flight does not: the login form showing in this tab
   * then means the site's session has ended.
   */
  function heldElsewhere(tabId: number, siteOrigin: string): boolean {
    const now = Date.now();
    return [...persisted.values()].some(
      (entry) =>
        entry.account.origin === siteOrigin &&
        entry.document.tabId !== tabId &&
        entry.state !== "authenticated" &&
        // A fill-only login never submits (ADR 0021 D).
        !entry.fillOnly &&
        !(entry.state === "blocked" && entry.outcome === "interrupted" && !entry.submissions) &&
        !stoppedByPateat(entry) &&
        // A clock set back ends the hold rather than prolonging it.
        now - (entry.changedAt ?? 0) >= 0 &&
        now - (entry.changedAt ?? 0) < HOLD_MS,
    );
  }
  /** Whether another tab asks for an account after a logout of the origin (ADR 0021 D). */
  function askedElsewhere(tabId: number, siteOrigin: string): boolean {
    return [...logouts].some(
      (key) => key !== recordKey(tabId, siteOrigin) && key.endsWith(` ${siteOrigin}`),
    );
  }
  /** Tells the tab why it does not log in while another tab's login holds the site. */
  function showHeld(tabId: number): void {
    void quietly(() =>
      browser.action.setTitle({
        tabId,
        title:
          "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait 5 minutes and reload this page, to log in here.",
      }),
    );
  }
  /** The attempt a tab runs, else the one it last recorded. */
  function tabAttempt(tabId: number): LoginAttemptMetadata | undefined {
    const run = attempts.get(tabId);
    if (run) return run.metadata;
    const records = [...persisted.values()].filter((entry) => entry.document.tabId === tabId);
    return records.find((entry) => !terminal(entry)) ?? records.at(-1);
  }
  const fromPopup = (sender: Sender) =>
    sender.id === browser.runtime.id && sender.url === browser.runtime.getURL("/popup.html");
  const reviving = new Map<number, Promise<void>>();
  /**
   * Asks a refused document that a restarted worker knows only from session storage to
   * announce again; that offers its choice again, or clears it once the document is gone.
   */
  function revive(waiting: PendingChoice): Promise<void> {
    const { tabId, frameId, documentId } = waiting.document;
    let running = reviving.get(tabId);
    if (!running) {
      running = browser.tabs
        .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId, documentId })
        .then(
          () => undefined,
          () => {
            if (pending.get(tabId) === waiting) clearChoice(tabId);
          },
        )
        .finally(() => reviving.delete(tabId));
      reviving.set(tabId, running);
    }
    return running;
  }
  /** The refused document of a tab and the accounts it could use, for the popup. */
  async function choiceFor(tabId: number): Promise<ChoiceResponse> {
    // The attempt records decide whether another tab holds the site.
    await loaded;
    await sessionLoaded;
    let waiting = pending.get(tabId);
    if (waiting && !documents.has(frameKey(waiting.document))) {
      await revive(waiting);
      // The document may have answered as stale because another announcement of it, such
      // as one asked for by the restarted worker's reconnect of every tab, overtook it.
      await admitting.get(`${tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
      // A document that answered but could not be admitted again, for example after its
      // site access was withdrawn, offers nothing; asking again would only repeat that.
      if (pending.get(tabId) === waiting && !documents.has(frameKey(waiting.document)))
        clearChoice(tabId);
      waiting = pending.get(tabId);
    }
    const live = waiting && documents.get(frameKey(waiting.document));
    if (
      !waiting ||
      !live ||
      !sameLoginDocument(live.document, waiting.document) ||
      recordFor(tabId, waiting.document.origin) !== undefined
    ) {
      // The document announced again without being refused for several accounts.
      if (waiting && live) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    const held = heldElsewhere(tabId, waiting.document.origin) ? { held: true as const } : {};
    if (waiting.logout)
      return {
        ok: true,
        origin: waiting.document.origin,
        documentId: waiting.document.documentId,
        candidates: waiting.candidates,
        logout: true,
        ...held,
      };
    // A default saved since the refusal decides the page's next login instead.
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
    if (
      !snapshot.ok ||
      snapshot.snapshot.settings.siteDefaults.some(
        (entry) => entry.origin === waiting.document.origin,
      )
    ) {
      if (snapshot.ok) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    return {
      ok: true,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      candidates: waiting.candidates,
      ...held,
    };
  }
  /**
   * Restarts the refused document's login with the picked account: the document announces
   * again and a new attempt starts from the recipe's first step, if that step still shows.
   */
  async function pickFor(request: v.InferOutput<typeof pickRequestSchema>): Promise<PickResponse> {
    const offered = await choiceFor(request.tabId);
    const waiting = pending.get(request.tabId);
    if (!offered.ok || !waiting || offered.documentId !== request.documentId)
      return { ok: false, reason: "no-choice" };
    if (
      !offered.candidates.some(
        (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
      )
    )
      return { ok: false, reason: "not-a-candidate" };
    // The pick would be refused as the page announces; the choice stays for a later pick.
    if (offered.held) return { ok: false, reason: "origin-busy" };
    const pick: PickedAccount = {
      tabId: request.tabId,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      connectionId: request.connectionId,
      itemId: request.itemId,
      makeDefault: request.makeDefault,
    };
    picked.set(request.tabId, pick);
    clearChoice(request.tabId);
    let gone = false;
    try {
      await saveSession();
      // The document answers once its new announce is handled, started or refused.
      await browser.tabs.sendMessage(
        request.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: waiting.document.frameId, documentId: waiting.document.documentId },
      );
      // Another announcement of the document may have overtaken this one and take the pick.
      await admitting.get(`${request.tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
    } catch {
      gone = true;
    }
    if (pick.attemptId !== undefined) return { ok: true };
    // A pick that started nothing is dropped; the form's next appearance asks again.
    if (picked.get(request.tabId) === pick) {
      picked.delete(request.tabId);
      await quietly(saveSession);
    }
    if (gone) return { ok: false, reason: "document-gone" };
    // Another tab's login started holding the site after the choice was offered. The page
    // does not announce again once that hold ends, so its choice waits for a later pick.
    const live = documents.get(frameKey(waiting.document));
    if (
      live?.reason === "origin-busy" &&
      live.document.documentId === waiting.document.documentId &&
      !pending.has(request.tabId)
    ) {
      offerChoice(waiting.document, waiting.candidates, waiting.logout === true);
      return { ok: false, reason: "origin-busy" };
    }
    return { ok: false, reason: "not-started" };
  }
  function current(run: Execution): boolean {
    return (
      attempts.get(run.live.document.tabId) === run &&
      documents.get(frameKey(run.live.document)) === run.live
    );
  }
  /**
   * Whether a policy write now would stop this attempt while it can still make progress. A
   * login whose result settled as unknown counts only while this worker checks or judges
   * one of its pages: such a record stays until its tab closes, and counting it would hold
   * policy writes for as long (ADR 0027).
   */
  function inProgress(run: Execution): boolean {
    return current(run) && !terminal(run.metadata) && (run.running || !run.metadata.settled);
  }
  async function save(run: Execution): Promise<void> {
    await keep(run.metadata);
  }
  async function keep(metadata: LoginAttemptMetadata): Promise<void> {
    const key = recordKey(metadata.document.tabId, metadata.account.origin);
    const previous = persisted.get(key);
    const next = parseAttemptMetadata({ ...metadata, changedAt: undefined });
    // Only the login's own progress counts as a change. A new page of its tab (another
    // `documentId`) or a page sent to be judged keeps the time, so a tab left browsing the
    // site after a login that did not succeed stops holding it.
    const progress = (record: LoginAttemptMetadata) =>
      JSON.stringify({
        ...record,
        document: { ...record.document, documentId: undefined },
        judged: undefined,
        changedAt: undefined,
      });
    const unchanged = previous?.changedAt !== undefined && progress(previous) === progress(next);
    // Re-inserted, so the last record of a tab is the one it wrote last.
    persisted.delete(key);
    persisted.set(key, { ...next, changedAt: unchanged ? previous.changedAt : Date.now() });
    await write();
  }
  /** Releases one tab's record for one origin after a logout (ADR 0021 D). */
  async function forget(key: string): Promise<void> {
    persisted.delete(key);
    await write();
  }
  async function write(): Promise<void> {
    const snapshot = [...persisted.values()];
    storageQueue = storageQueue.then(async () => {
      if (!storageHealthy) throw new Error("Attempt storage unavailable");
      await browser.storage.local.set({ [STORAGE_KEY]: snapshot });
      return undefined;
    });
    try {
      await storageQueue;
    } catch {
      storageHealthy = false;
      throw new Error("Attempt storage unavailable");
    }
  }
  async function change(
    run: Execution,
    event: LoginAttemptEvent,
    policy?: PolicyChange,
  ): Promise<void> {
    if (!current(run)) return;
    // A stop before the page received the prepared operation takes its effect back, so the
    // record does not hold the origin as if a submission were in flight (ADR 0022).
    const undelivered =
      event.type === "POLICY_CHANGED" &&
      run.operation &&
      !run.delivered &&
      run.operation.operationId === run.metadata.operationId
        ? run.operation.operationId
        : undefined;
    const previous = run.metadata;
    run.metadata = transitionLoginAttempt(
      run.metadata,
      undelivered ? { type: "POLICY_CHANGED", undelivered } : event,
    );
    // Settling as unknown keeps the state, but it is how a login ends without a result.
    const settled = run.metadata.settled === true && previous.settled !== true ? true : undefined;
    if (run.metadata.state !== previous.state || settled)
      // The log still names the step that was withdrawn.
      reportAttempt(
        undelivered
          ? {
              ...run.metadata,
              operationKind: previous.operationKind,
              operationEffect: previous.operationEffect,
            }
          : run.metadata,
        run.recipe,
        policy,
        settled ? { settled } : {},
      );
    if (
      import.meta.env.MODE === "probe" &&
      armed === "intent-write-failure" &&
      (event.type === "MUTATION_INTENT" || event.type === "SUBMIT_INTENT")
    ) {
      armed = undefined;
      clearTimeout(armTimer);
      storageHealthy = false;
      throw new Error("Synthetic intent write failed");
    }
    await save(run);
    await publish(run.live, run.metadata);
    if (run.metadata.state === "authenticated" && run.choice) await remember(run);
  }
  /**
   * Ends a fill-only login before its first step with an effect and forgets its record, so
   * it neither holds the site nor counts as a login of the tab. The document announces again
   * on this status and asks for an account, as after a logout (ADR 0021 D).
   */
  async function endFillOnly(run: Execution): Promise<void> {
    if (!current(run)) return;
    run.metadata = transitionLoginAttempt(run.metadata, { type: "CANCEL" });
    reportAttempt(run.metadata, run.recipe);
    const tabId = run.live.document.tabId;
    attempts.delete(tabId);
    await forget(recordKey(tabId, run.metadata.account.origin)).catch(() => undefined);
    // The page then waits for a pick, as after a logout; its own announcement after this
    // status carries no start, so the choice is offered here.
    if (run.asked?.length) {
      offerChoice(run.live.document, run.asked, true);
      run.live.state = "denied";
      run.live.reason = "logged-out";
    }
    await publish(run.live, run.metadata);
  }
  async function withdrawSwitch(run: Execution): Promise<void> {
    const tabId = run.live.document.tabId;
    if (
      attempts.get(tabId) !== run ||
      persisted.get(recordKey(tabId, run.metadata.account.origin))?.id !== run.metadata.id
    )
      return;
    run.metadata = withdrawAccountSwitch(run.metadata);
    await save(run);
    await publish(run.live, run.metadata);
  }
  /**
   * Saves an automatic account choice after `authenticated` (ADR 0013). The settings must
   * still be the revision the attempt was authorized under; otherwise nothing is saved and
   * the next login chooses again.
   */
  async function remember(run: Execution): Promise<void> {
    const choice = run.choice;
    delete run.choice;
    const { account: used } = run.metadata;
    if (
      !choice ||
      !settings.update ||
      // Only the account this attempt authenticated with may be saved.
      choice.connectionId !== used.connectionId ||
      choice.binding.itemId !== used.itemId ||
      choice.binding.origin !== used.origin ||
      // Saving bumps the revision every attempt checks; never stop another login with it.
      [...attempts.values()].some((other) => other !== run && inProgress(other))
    )
      return;
    // A login another tab is admitting waits for this save, which no in-progress check above
    // can see yet (see `admit`).
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => (finish = resolve));
    savingChoices.add(saving);
    let writing = false;
    try {
      // Writing bumps the policy revision for every attempt, so skip a choice already saved.
      const latest = await settings.handle({ version: 1, type: "settings.get" });
      if (!latest.ok || withChoice(latest.snapshot.settings, choice) === latest.snapshot.settings)
        return;
      writing = true;
      await settings
        .update(run.metadata.policyRevision, (snapshot) => ({
          ...snapshot,
          settings: withChoice(snapshot.settings, choice),
        }))
        .catch(() => undefined);
    } finally {
      if (writing) remembered += 1;
      savingChoices.delete(saving);
      finish();
    }
  }
  async function send(live: LiveDocument, message: Record<string, unknown>): Promise<unknown> {
    return browser.tabs.sendMessage(
      live.document.tabId,
      { version: 1, token: live.token, ...message },
      { documentId: live.document.documentId, frameId: live.document.frameId },
    );
  }
  async function publish(live: LiveDocument, metadata?: LoginAttemptMetadata): Promise<void> {
    if (documents.get(frameKey(live.document)) !== live) return;
    await send(live, {
      type: "login.status",
      state: metadata?.state ?? live.state ?? "denied",
      stepIndex: metadata?.stepIndex ?? 0,
      ...(metadata?.outcome || live.reason ? { outcome: metadata?.outcome ?? live.reason } : {}),
    }).catch(() => undefined);
  }
  /**
   * Every eligible provider URI match for the document across all enabled connections;
   * in a frame, only items that also match the tab's URL (ADR 0017). Any connection or
   * item that could not be evaluated refuses rather than listing part of them.
   */
  async function siteCandidates(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
  ) {
    const find = (url: string) =>
      findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: snapshot.catalog,
        url,
        match: uris!,
      });
    const scope = await find(live.url);
    if (!scope.ok) return { reason: scope.reason };
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    if (!live.topUrl) return { candidates: scope.candidates };
    const top = await find(live.topUrl);
    if (!top.ok) return { reason: top.reason };
    if (top.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (top.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    return {
      candidates: scope.candidates.filter((entry) =>
        top.candidates.some(
          (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
        ),
      ),
    };
  }
  type Choice = {
    connectionId: string;
    itemId: string;
    saved: boolean;
    pick?: PickedAccount;
    /** After a logout: fill the page without any step with an effect (ADR 0021 D). */
    fillOnly?: true;
    /** With `fillOnly`: the accounts the tab offers once the fill ends. */
    asked?: PendingChoice["candidates"];
  };
  /** `noUriMatch` marks a refusal because no vault item matches the page, which a vault
   * sync may change; it is never reported. */
  type Refusal = {
    reason: string;
    candidates?: PendingChoice["candidates"];
    logout?: true;
    noUriMatch?: true;
  };
  /**
   * The account for this document. A saved site default wins. Without one, a single
   * eligible provider URI match across all enabled connections is used for this attempt
   * only (ADR 0013); none, several, or any connection or item that could not be evaluated
   * refuses rather than guessing.
   */
  async function choose(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    asking = false,
    fill = false,
  ): Promise<Choice | Refusal> {
    // An account picked in the popup wins for the document it restarted and the attempt that
    // document started; its item must still match the page and pass every check below.
    await sessionLoaded;
    const pick = picked.get(live.document.tabId);
    const owner = recordFor(live.document.tabId, live.document.origin);
    if (
      pick?.origin === live.document.origin &&
      (pick.attemptId === undefined
        ? pick.documentId === live.document.documentId
        : owner?.id === pick.attemptId)
    )
      return { connectionId: pick.connectionId, itemId: pick.itemId, saved: false, pick };
    const saved = snapshot.snapshot.settings.siteDefaults.find(
      (entry) => entry.origin === live.document.origin,
    );
    if (asking) {
      // After a logout the tab asks, with the saved default first (ADR 0021 D).
      const listed: PendingChoice["candidates"] = [];
      const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
      if (saved && mapped?.ok)
        listed.push({ connectionId: mapped.connectionId, itemId: saved.itemId });
      if (uris) {
        const found = await siteCandidates(snapshot, live);
        // Without the matches, the saved default alone is still offered.
        if ("reason" in found && !listed.length) return { reason: found.reason };
        for (const entry of "reason" in found ? [] : found.candidates)
          if (
            !listed.some(
              (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
            )
          )
            listed.push({ connectionId: entry.connectionId, itemId: entry.itemId });
      }
      if (!listed.length) return { reason: saved ? "default-unavailable" : "default-not-set" };
      // With one account to use, the saved default or the only match, the page is filled
      // without any click or submitting fill; the tab still asks (ADR 0021 D).
      // A saved default that cannot be used fills nothing, as it would refuse a login.
      const only = saved
        ? mapped?.ok
          ? listed[0]
          : undefined
        : listed.length === 1
          ? listed[0]
          : undefined;
      if (fill && only)
        return { ...only, saved: Boolean(saved), fillOnly: true, asked: listed.slice(0, 100) };
      return { reason: "logged-out", candidates: listed.slice(0, 100), logout: true };
    }
    if (saved) {
      const connection = siteDefaultConnection(saved, snapshot.catalog);
      return connection.ok
        ? { connectionId: connection.connectionId, itemId: saved.itemId, saved: true }
        : { reason: connection.reason };
    }
    if (!uris) return { reason: "default-not-set" };
    // Any sync replaces a snapshot ID, so a new match from a later sync is still noticed.
    const snapshots = JSON.stringify(
      snapshot.catalog.connections.map((entry) => [entry.id, entry.snapshotId, entry.state]),
    );
    const cached = live.autoChoice;
    if (cached?.snapshots === snapshots)
      return { connectionId: cached.connectionId, itemId: cached.itemId, saved: false };
    delete live.autoChoice;
    const found = await siteCandidates(snapshot, live);
    if ("reason" in found) return { reason: found.reason };
    const { candidates } = found;
    if (candidates.length > 1)
      return {
        reason: "account-ambiguous",
        candidates: candidates.map((entry) => ({
          connectionId: entry.connectionId,
          itemId: entry.itemId,
        })),
      };
    const [only] = candidates;
    if (!only) return { reason: "default-not-set", noUriMatch: true };
    // The same answer covers the item origin check below; no second query is needed.
    live.uriMatch = {
      connectionId: only.connectionId,
      itemId: only.itemId,
      snapshotId: only.snapshotId,
    };
    live.autoChoice = { snapshots, connectionId: only.connectionId, itemId: only.itemId };
    return { connectionId: only.connectionId, itemId: only.itemId, saved: false };
  }
  /**
   * Origin scope for the chosen account of this document. A live provider URI match for
   * the document's own URL satisfies the item origin check for that document only; it is
   * never saved as `allowedOrigins`. Only the chosen account's connection is asked, and a
   * match is reused while that connection's snapshot is unchanged.
   */
  async function liveScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
  ): Promise<{ catalog: VaultCatalog } | { reason: "vault-unavailable" | "item-uri-unevaluated" }> {
    const { catalog } = snapshot;
    const connection = catalog.connections.find((entry) => entry.id === selected.connectionId);
    const item = connection?.items.find((entry) => entry.id === selected.itemId);
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden") return { catalog };
    if (!item || item.allowedOrigins.includes(live.document.origin)) return { catalog };
    // An item awaiting field review is unavailable; do not report it as a URI mismatch.
    if (connection.quarantinedItemIds?.includes(item.id)) return { reason: "vault-unavailable" };
    const cached = live.uriMatch;
    if (
      !cached ||
      cached.connectionId !== selected.connectionId ||
      cached.itemId !== selected.itemId ||
      cached.snapshotId !== connection.snapshotId
    ) {
      delete live.uriMatch;
      const scope = await findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: { connections: [connection] },
        url: live.url,
        match: uris,
      });
      if (!scope.ok) return { catalog };
      const matched = scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      );
      if (!matched) {
        // Unevaluated rules may still cover this page; never treat them as a mismatch.
        if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
        return scope.incompleteItems.some((entry) => entry.itemId === selected.itemId)
          ? { reason: "item-uri-unevaluated" }
          : { catalog };
      }
      live.uriMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: connection.snapshotId,
      };
    }
    return { catalog: withItemOrigin(catalog, selected, live.document.origin) };
  }
  /**
   * For a document in a frame inside the page, the chosen item must also match the tab's
   * URL, as the official Bitwarden client requires before it fills a frame (ADR 0017).
   * `granted` is the catalog whose static `allowedOrigins` count; a live provider URI
   * match is reused while that connection's snapshot is unchanged.
   */
  async function topScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
    granted: VaultCatalog,
  ): Promise<{ reason: string } | undefined> {
    if (!live.topUrl) return undefined;
    const top = new URL(live.topUrl).origin;
    if (isSiteExcluded(snapshot.snapshot.settings, top)) return { reason: "site-excluded" };
    const item = granted.connections
      .find((entry) => entry.id === selected.connectionId)
      ?.items.find((entry) => entry.id === selected.itemId);
    if (item?.allowedOrigins.includes(top)) return undefined;
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === selected.connectionId,
    );
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden")
      return { reason: "frame-top-mismatch" };
    const cached = live.topMatch;
    if (
      cached?.connectionId === selected.connectionId &&
      cached.itemId === selected.itemId &&
      cached.snapshotId === connection.snapshotId
    )
      return undefined;
    delete live.topMatch;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: { connections: [connection] },
      url: live.topUrl,
      match: uris,
    });
    if (!scope.ok) return { reason: scope.reason };
    if (
      scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      )
    ) {
      live.topMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: connection.snapshotId,
      };
      return undefined;
    }
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.some((entry) => entry.itemId === selected.itemId))
      return { reason: "item-uri-unevaluated" };
    return { reason: "frame-top-mismatch" };
  }
  /**
   * The chosen item's binding for one route's `slots` (ADR 0027): the synced binding, else
   * the automatic one for built-in slots, else one built from a template: another item's
   * saved binding of the recipe, then the slot map of a recipe generated from this device.
   * A synced binding is never bypassed: it must hold every one of `slots` itself, and its
   * entries for other slots are ignored. It is mapped to this device's field IDs by the
   * catalog's raw field names.
   */
  async function bindingFor(
    catalog: VaultCatalog,
    settingsValue: SettingsSnapshot["settings"],
    recipe: LoginRecipe,
    choice: Choice,
    documentOrigin: string,
    slots: readonly string[],
    slotMap: () => Promise<LoginBindingTemplate | undefined>,
  ): Promise<
    | { ok: true; binding: LoginAccountBinding; synced: SavedLoginBinding; saved: boolean }
    | { ok: false; reason: string }
  > {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return { ok: false, reason: "vault-unavailable" };
    const owner = { provider: connection.provider, userId: connection.userId, itemId: item.id };
    const named = { ...owner, itemName: item.label, accountName: connection.label };
    const fieldNames = item.fields.map((field) => ({ id: field.id, name: field.name }));
    const saved = findLoginBinding(settingsValue.bindings, recipe, owner);
    let binding = saved ?? defaultLoginBinding(slots, recipe, named);
    if (!binding) {
      // Sibling bindings were proven by an authenticated login, so they go first.
      const templates: LoginBindingTemplate[] = settingsValue.bindings
        .filter((entry) => entry.recipeId === recipe.id && entry.origin === recipe.origin)
        .map((entry) => entry.slots);
      const generated = await slotMap();
      if (generated) templates.push(generated);
      const built = templateLoginBinding(slots, recipe, named, templates, fieldNames);
      if (!built.ok) return { ok: false, reason: built.reason };
      binding = built.binding;
    }
    const resolved = resolveBindingFields(binding, slots, fieldNames);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return {
      ok: true,
      binding: {
        origin: documentOrigin,
        connectionId: connection.id,
        itemId: item.id,
        slots: resolved.slots,
      },
      // A default saved from a stored binding is named after this device's connection
      // too; the stored binding itself is never rewritten.
      synced: saved ? { ...saved, accountName: connection.label } : binding,
      saved: saved !== undefined,
    };
  }
  /**
   * The item's facts for a new login (ADR 0027): its password and TOTP fields from the
   * catalog's value-free flags and the account's allowed fields, and its passkeys from one
   * vault search. Read once per login; never sent anywhere.
   */
  async function itemFacts(
    connection: VaultConnectionMetadata,
    owner: { origin: string; connectionId: string; itemId: string; fieldIds: string[] },
  ): Promise<LoginItemFacts> {
    const item = connection.items.find((entry) => entry.id === owner.itemId);
    const fieldFacts = item
      ? loginFieldFacts(item, owner.fieldIds)
      : { password: false, totp: false };
    // The synthetic probe item names its password field `password`; it holds a value.
    if (probeMode && owner.origin === origin && owner.fieldIds.includes("password"))
      fieldFacts.password = true;
    // Its synthetic `totp` field counts as a TOTP secret only when the probe says so.
    if (probeMode && owner.origin === origin && probeTotp && owner.fieldIds.includes("totp"))
      fieldFacts.totp = true;
    // The synthetic item's configured passkey stands in for the vault search.
    if (probeMode && owner.origin === origin && probePasskey)
      return {
        ...fieldFacts,
        passkey: true,
        discoverablePasskey: probePasskey === "discoverable",
      };
    const held = await Promise.resolve(
      options.passkeys?.({
        origin: owner.origin,
        connectionId: owner.connectionId,
        itemId: owner.itemId,
      }),
    ).catch(() => undefined);
    return {
      ...fieldFacts,
      passkey: held?.passkey === true,
      discoverablePasskey: held?.passkey === true && held.discoverable,
    };
  }
  /** Reasons a password variant does not fit the item; any other refusal stops the plan. */
  const variantRefusals = new Set([
    "binding-not-found",
    "binding-slots-mismatch",
    "binding-field-excluded",
    "field-missing",
    "field-ambiguous",
    "field-count-changed",
    "no-route",
  ]);
  /**
   * The chosen item named as a saved default names it, for a login whose route fills
   * nothing (ADR 0027); undefined when its connection or item cannot name it.
   */
  function choiceAccount(
    catalog: VaultCatalog,
    choice: Choice,
    documentOrigin: string,
  ): LoginChoiceAccount | undefined {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return undefined;
    return {
      origin: documentOrigin,
      provider: connection.provider,
      userId: connection.userId,
      itemId: item.id,
      // Named as a binding built for the item is.
      ...loginDisplayNames(item.id, item.label, connection.label),
    };
  }
  /**
   * One account must resolve from a usable connection, and its item must not await review.
   * A new login reads the item's facts once and chooses its route in the owner's order
   * (ADR 0027): the `passkey` route when the recipe has it and the item holds a
   * discoverable passkey, whatever its bindings; otherwise the first password variant
   * whose binding resolves, whose fields are all allowed and whose bound password or TOTP
   * fields hold values. A recipe with one variant keeps that variant's own refusal, and
   * one with several refuses `no-route` with the first variant's reason as its detail. A
   * running or resumed login passes its recorded `route`, which is checked alone and never
   * reads the facts again.
   */
  async function planFor(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    recipe: LoginRecipe,
    request: {
      asking?: boolean;
      /** While asking after a logout, the single account to use may fill the page. */
      fill?: boolean;
      route?: LoginRouteChoice;
      /** Slots of the handlers a running login entered; `totp` reads the built-in field. */
      handlerSlots?: readonly string[];
    } = {},
  ) {
    let catalog: VaultCatalog;
    let chosen: Choice | undefined;
    let savedDefault = false;
    if (probeMode && recipe.origin === origin) {
      catalog = grantProbeOrigin(snapshot.catalog, origin, account);
      const top = await topScope(snapshot, live, account, catalog);
      if (top) return { ok: false as const, reason: top.reason };
    } else {
      const found = await choose(snapshot, live, request.asking === true, request.fill === true);
      if ("reason" in found)
        return {
          ok: false as const,
          reason: found.reason,
          ...(found.candidates ? { candidates: found.candidates } : {}),
          ...(found.logout ? { logout: true as const } : {}),
          ...(found.noUriMatch ? { noUriMatch: true as const } : {}),
        };
      chosen = found;
      savedDefault = found.saved;
      const scope = await liveScope(snapshot, live, found);
      if ("reason" in scope) return { ok: false as const, reason: scope.reason };
      const top = await topScope(snapshot, live, found, snapshot.catalog);
      if (top) return { ok: false as const, reason: top.reason };
      catalog = scope.catalog;
    }
    // The generated slot map is read at most once per plan.
    let generated: Promise<LoginBindingTemplate | undefined> | undefined;
    const slotMap = () =>
      (generated ??= Promise.resolve(generation?.slotFields(recipe.id)).catch(() => undefined));
    /** The plan for one route, or why it does not resolve. */
    const resolveRoute = async (route: LoginRouteChoice) => {
      const slots = routeSlots(recipe, route);
      let policy = snapshot.snapshot;
      let binding: LoginAccountBinding;
      let choice: UnsavedChoice | undefined;
      if (!chosen) binding = probeBinding(recipe, account, slots);
      else {
        let named: SavedLoginBinding | LoginChoiceAccount;
        let unsaved: boolean;
        if (route.route === "passkey") {
          // The route fills nothing, so no binding is read, built or saved (ADR 0027).
          const owner = choiceAccount(catalog, chosen, live.document.origin);
          if (!owner) return { ok: false as const, reason: "vault-unavailable" };
          binding = {
            origin: live.document.origin,
            connectionId: chosen.connectionId,
            itemId: chosen.itemId,
            slots: [],
          };
          named = owner;
          unsaved = !chosen.saved;
        } else {
          const bound = await bindingFor(
            catalog,
            snapshot.snapshot.settings,
            recipe,
            chosen,
            live.document.origin,
            slots,
            slotMap,
          );
          if (!bound.ok) return { ok: false as const, reason: bound.reason };
          binding = bound.binding;
          named = bound.synced;
          unsaved = !chosen.saved || !bound.saved;
        }
        if (!chosen.saved) {
          // The automatic choice acts as this document's default in memory only, named by
          // the chosen item's provider account as a saved default would be. An account
          // connected more than once therefore stays ambiguous, as it would once saved.
          policy = structuredClone(policy);
          // A found account replaces a saved default for this document.
          policy.settings.siteDefaults = policy.settings.siteDefaults.filter(
            (entry) => entry.origin !== live.document.origin,
          );
          policy.settings.siteDefaults.push({
            origin: live.document.origin,
            provider: named.provider,
            userId: named.userId,
            itemId: named.itemId,
            itemName: named.itemName,
            ...(named.accountName ? { accountName: named.accountName } : {}),
          });
        }
        // A pick made for this login only is never saved.
        if (unsaved && (!chosen.pick || chosen.pick.makeDefault))
          choice = {
            binding: named,
            connectionId: chosen.connectionId,
            // An account found to become the default replaces another saved one.
            ...(chosen.pick?.makeDefault ? { replace: true } : {}),
          };
      }
      // An entered `totp` handler reads the item's built-in TOTP field (ADR 0027), for this
      // login only: the binding saved after it authenticates covers the route's slots.
      let planSlots = slots;
      if (request.handlerSlots?.includes(TOTP_HANDLER_SLOT)) {
        const owner = catalog.connections.find((entry) => entry.id === binding.connectionId);
        const code =
          owner && codeFieldOf(owner, binding.itemId, snapshot.snapshot.settings.bindings, recipe);
        if (!code) return { ok: false as const, reason: "code-field-missing" as const };
        binding = {
          ...binding,
          slots: [...binding.slots, { slot: TOTP_HANDLER_SLOT, fieldId: code }],
        };
        planSlots = [...slots, TOTP_HANDLER_SLOT];
      }
      const plan = resolveLoginPlan(policy, catalog, live.url, recipe, binding, planSlots);
      // A saved default's item that no longer matches the page, as after its URI was edited
      // on another device, is also no matching item.
      if (!plan.ok && plan.reason === "item-origin-mismatch" && savedDefault)
        return { ...plan, noUriMatch: true as const };
      if (!plan.ok) return plan;
      const connection = catalog.connections.find(
        (entry) => entry.id === plan.account.connectionId,
      );
      if (
        !connection ||
        // Review blocks only the affected items; unrelated items in the connection stay usable.
        (connection.state !== undefined &&
          connection.state !== "ready" &&
          connection.state !== "review-required") ||
        connection.quarantinedItemIds?.includes(plan.account.itemId)
      )
        return { ok: false as const, reason: "vault-unavailable" as const };
      return {
        ...plan,
        connection,
        route,
        ...(choice ? { choice } : {}),
        ...(chosen?.fillOnly ? { fillOnly: true as const, asked: chosen.asked ?? [] } : {}),
      };
    };
    // A running or resumed login checks its recorded route alone.
    if (request.route) return resolveRoute(request.route);
    let facts: LoginItemFacts | undefined;
    const factsOf = (resolved: Extract<Awaited<ReturnType<typeof resolveRoute>>, { ok: true }>) =>
      itemFacts(resolved.connection, { ...resolved.account, origin: live.document.origin });
    if (recipeHasRoute(recipe, "passkey")) {
      const resolved = await resolveRoute({ route: "passkey" });
      if (resolved.ok) {
        facts = await factsOf(resolved);
        // No binding matters on this route, so a password variant that does not fit never
        // refuses such a login.
        if (chooseLoginRoute(recipe, facts, [])?.route === "passkey") return { ...resolved, facts };
      }
      // Otherwise the password route decides, with its own refusals.
    }
    const routes: LoginRouteChoice[] = passwordVariants(recipe).map((_, variant) => ({
      route: "password",
      variant,
    }));
    const fits: boolean[] = [];
    const refusals: (string | undefined)[] = [];
    // Variants are tried in recipe order and the first that fits stops the search, so the
    // facts and the generated map are read once.
    /* eslint-disable no-await-in-loop */
    for (const [index, route] of routes.entries()) {
      const resolved = await resolveRoute(route);
      if (!resolved.ok) {
        if (!variantRefusals.has(resolved.reason)) return resolved;
        refusals[index] = resolved.reason;
        continue;
      }
      facts ??= await factsOf(resolved);
      // The password route needs every bound password or TOTP field, built in or Linked to
      // one, to hold a value the account may fill.
      const item = resolved.connection.items.find((entry) => entry.id === resolved.account.itemId);
      const known = facts;
      if (
        !resolved.binding.slots.every(({ fieldId }) => {
          const source = item ? loginFieldSource(item, fieldId) : fieldId;
          return source === "login.password"
            ? known.password
            : source === "login.totp-code"
              ? known.totp
              : true;
        })
      ) {
        refusals[index] = "no-route";
        continue;
      }
      fits[index] = true;
      const taken = chooseLoginRoute(recipe, known, fits);
      if (taken?.route === "password" && taken.variant === index)
        return { ...resolved, facts: known };
      // The first variant that fits decides; without the item's password none is taken.
      // The passkey route, when the facts choose it here, did not resolve, so nothing is.
      refusals[index] = "no-route";
      break;
    }
    /* eslint-enable no-await-in-loop */
    const first = refusals[0] ?? "no-route";
    return routes.length === 1
      ? { ok: false as const, reason: first }
      : { ok: false as const, reason: "no-route" as const, detail: first };
  }
  type Authorized = {
    connection: VaultConnectionMetadata;
    binding: LoginAccountBinding;
    /** The account's allowed field IDs and the synced bindings it was authorized with. */
    fieldIds: string[];
    bindings: SavedLoginBinding[];
  };
  /** Resolve against a fresh live catalog; returns the authorizing metadata and binding. */
  async function allowed(run: Execution): Promise<Authorized | undefined> {
    if (!current(run) || !storageHealthy) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!current(run)) return undefined;
    if (!snapshot.ok || snapshot.snapshot.revision !== run.metadata.policyRevision) {
      await change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: snapshot.ok ? "settings-revision" : "settings-unavailable" },
      );
      return undefined;
    }
    // The recorded route alone is checked, so an excluded field of another variant never
    // stops this login, with the fields of the handlers it entered (ADR 0027).
    const plan = await planFor(snapshot, run.live, run.recipe, {
      route: attemptRouteChoice(run.metadata),
      handlerSlots: handlerSlots(run.recipe, run.metadata),
    });
    if (
      !plan.ok ||
      plan.account.connectionId !== run.metadata.account.connectionId ||
      plan.account.itemId !== run.metadata.account.itemId
    ) {
      await change(
        run,
        { type: "POLICY_CHANGED" },
        { cause: "plan", reason: plan.ok ? "account-changed" : plan.reason },
      );
      return undefined;
    }
    return {
      connection: plan.connection,
      binding: plan.binding,
      fieldIds: plan.account.fieldIds,
      bindings: snapshot.snapshot.settings.bindings,
    };
  }
  async function observe(
    run: Execution,
    targets: LoginTarget[],
    require?: ("writable" | "clickable" | "shown" | "present")[],
    links?: boolean[],
  ) {
    // Exclusion/default/policy checks precede even metadata observation.
    if (!(await allowed(run))) return undefined;
    const response = await send(run.live, {
      type: "login.observe",
      path: run.live.path,
      targets,
      ...(require ? { require } : {}),
      ...(links ? { links } : {}),
    });
    if (!current(run)) return undefined;
    const parsed = v.safeParse(observationSchema, response);
    return parsed.success ? parsed.output : undefined;
  }
  /**
   * Asks the document to wait for a step's elements. A document that went away or was
   * cancelled leaves the attempt as it is; its replacement document resumes it.
   */
  async function waitFor(
    run: Execution,
    readiness: LoginReadiness,
  ): Promise<"ready" | "timeout" | "gone"> {
    try {
      const response = await send(run.live, {
        type: "login.await",
        readiness,
        timeoutMs: LOGIN_STEP_WAIT_MS,
      });
      const parsed = v.safeParse(awaitResultSchema, response);
      if (!parsed.success) return "gone";
      return parsed.output.ok ? "ready" : parsed.output.reason === "timeout" ? "timeout" : "gone";
    } catch {
      return "gone";
    }
  }
  /**
   * How a page that does not prove the sign-in ends the login: as itself on the `password`
   * route, and always as `challenge` on the `passkey` route, which never falls back to
   * typing the password (ADR 0027).
   */
  const unproven = (run: Execution, result: "credential-rejected" | "challenge" | "unknown") =>
    run.metadata.route === "passkey" ? "challenge" : result;
  /**
   * Checks the page after an effect step: the completion, the rejection, the plan's next
   * step, then a handler on the page (ADR 0027). Returns `held` while a held click's button
   * still shows in the document that clicked it, so the page is neither judged nor settled
   * yet.
   */
  async function reconcile(run: Execution, settleUnknown = false): Promise<"held" | undefined> {
    const nextIndex =
      run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance"
        ? run.metadata.stepIndex + 1
        : run.metadata.stepIndex;
    const plan = attemptPlan(run.recipe, run.metadata) ?? [];
    const next = plan[nextIndex]?.step;
    // An advance on the next step's own path is confirmed only by that step's elements
    // being ready, as it waits for them, and only if they were not ready before it ran.
    const inPlace =
      run.metadata.operationEffect === "advance"
        ? inPlaceNext(run.recipe, run.metadata, run.metadata.stepIndex)
        : undefined;
    const nextTargets = inPlace ? inPlace.targets : next ? stepTargets(next) : [];
    const { completion, rejection } = run.recipe;
    const proof = completion ? [completion.target, ...(completion.absent ?? [])] : [];
    const checks = [...proof, ...(rejection ? [rejection] : [])];
    const targets = [...checks, ...nextTargets];
    // The completion marker may be a link located by its text (ADR 0018).
    const observed = await observe(
      run,
      targets,
      inPlace
        ? [...checks.map(() => "present" as const), ...nextTargets.map(() => inPlace.require)]
        : undefined,
      completion ? [true] : undefined,
    );
    if (!observed) return undefined;
    // Without a completion target nothing proves a sign-in, so the attempt can settle
    // only as rejected, continued or unknown.
    if (
      completion &&
      observed.path === completion.path &&
      observed.targets[0] === "unique" &&
      observed.targets.slice(1, proof.length).every((state) => state === "missing")
    ) {
      await change(run, { type: "OBSERVED", result: "authenticated", document: run.live.document });
      return undefined;
    }
    const rejectionIndex = proof.length;
    if (rejection && observed.targets[rejectionIndex] === "unique") {
      await change(run, {
        type: "OBSERVED",
        result: unproven(run, "credential-rejected"),
        document: run.live.document,
      });
      return undefined;
    }
    const offset = rejectionIndex + (rejection ? 1 : 0);
    if (
      next &&
      observed.path === next.path &&
      nextTargets.length &&
      observed.targets.slice(offset).every((state) => state === "unique") &&
      // A pending click advances only after evidence of its configured next page: another
      // path, or on the same path, next elements the advance made ready. A click that
      // submits never continues on its own path.
      (!(run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance") ||
        plan[run.metadata.stepIndex]?.step.path !== next.path ||
        (inPlace !== undefined &&
          run.inPlace !== undefined &&
          run.inPlace.operationId === run.metadata.operationId &&
          run.inPlace.before.every((state) => state === "missing" || state === "unusable")))
    ) {
      const continuation: LoginAttemptEvent = {
        type: "OBSERVED",
        result: "continue",
        document: run.live.document,
      };
      // Remaining fields alone do not prove that an uncertain input effect finished.
      const candidate = transitionLoginAttempt(run.metadata, continuation);
      if (candidate.state === "ready" || candidate.state === "retryable") {
        await change(run, continuation);
        return undefined;
      }
    }
    if (effectful(run.metadata)) {
      // A held click, a handler's or the passkey route's, is not judged while its button
      // still shows in the document that clicked it, whatever path a same-document URL
      // change has moved it to: a WebAuthn exchange or a chooser the person answers can
      // take a while (ADR 0027). A new document that shows a handler's button again goes
      // to the person through the handler's own check below; one that shows the passkey
      // route's button again on its path, as after a reload back to the start page, goes
      // to the person at once: it is never clicked again or judged.
      const inFlight = plan[run.metadata.stepIndex];
      const routeClick =
        inFlight !== undefined &&
        inFlight.handler === undefined &&
        run.metadata.route === "passkey";
      if (inFlight && (run.heldClick === run.metadata.stepIndex || routeClick)) {
        const clicked = await observe(run, stepTargets(inFlight.step));
        if (!clicked) return undefined;
        if (clicked.targets.some((state) => state !== "missing")) {
          if (run.heldClick === run.metadata.stepIndex) return "held";
          if (clicked.path === inFlight.step.path) {
            await change(run, {
              type: "OBSERVED",
              result: "challenge",
              document: run.live.document,
            });
            return undefined;
          }
        }
      }
      if (await enterHandler(run, observed.path)) return undefined;
    }
    if (!settleUnknown) return undefined;
    if (effectful(run.metadata)) await logSignInState(run);
    if (!current(run) || terminal(run.metadata)) return undefined;
    if (await learn(run)) return undefined;
    await change(run, {
      type: "OBSERVED",
      result: unproven(run, "unknown"),
      document: run.live.document,
    });
    return undefined;
  }
  /**
   * Logs the sign-in state of ADR 0029 for a page no check explained: its signs and what
   * the ADR would do with it. Delivery 1 changes nothing else. A login in a frame is not
   * read, as the ADR reads the top document. The username goes to the page's content
   * script for its comparison only.
   */
  async function logSignInState(run: Execution): Promise<void> {
    const { recipe, metadata } = run;
    if (run.live.topUrl !== undefined) return;
    const marker = recipe.completion ? [recipe.completion.target] : [];
    const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24 - marker.length);
    const observed = await observe(
      run,
      [...fills, ...marker],
      [...fills, ...marker].map(() => "shown" as const),
      marker.length > 0 ? [...fills.map(() => false), true] : undefined,
    );
    if (!observed) return;
    const authorized = await allowed(run);
    if (!authorized) return;
    let username: string | undefined;
    const usernameField = loginUsernameFieldId(authorized.connection, metadata.account.itemId);
    if (usernameField) {
      try {
        username = await fields({
          account: metadata.account,
          connection: authorized.connection,
          fieldId: usernameField,
        });
      } catch {
        username = undefined;
      }
      if (!current(run)) return;
    }
    let response: unknown;
    try {
      response = await send(run.live, {
        type: "login.state",
        ...(username ? { account: { username } } : {}),
      });
    } catch {
      return;
    }
    if (!current(run)) return;
    const parsed = v.safeParse(stateResultSchema, response);
    if (!parsed.success || !parsed.output.ok) return;
    const page = parsed.output.signs;
    const s1 = observed.targets.slice(0, fills.length).some((state) => state === "unique");
    const { tabId, origin: pageOrigin } = run.live.document;
    const effect = effects.get(tabId);
    const requested = passkeyRequests.get(`${tabId} ${pageOrigin}`);
    const signInUrl = signInUrls.get(tabId);
    const signs: SignInSigns = {
      s1,
      s2: page.password,
      s3: page.code,
      s4: page.captcha,
      s5:
        effect?.attemptId === metadata.id &&
        !effect.passkey &&
        requested !== undefined &&
        requested >= effect.at,
      // A failure counts only next to the sign-in fields.
      f1: s1 && page.invalid,
      f2: s1 && page.alert,
      e1: marker.length > 0 && observed.targets[fills.length] === "unique",
      e2: page.username === true,
      // The document's path now, which follows a route change of a single-page site.
      e3:
        signInUrl?.attemptId === metadata.id &&
        reachedReturnTarget(
          signInUrl.url,
          `${pageOrigin}${observed.path}`,
          routeSignInPaths(recipe, metadata.route),
        ),
    };
    report({
      type: "state",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: recipe.id,
      route: metadata.route,
      ...signs,
      decision: decideSignInState(signs),
      ...(metadata.settled ? { settled: true as const } : {}),
    });
  }
  /**
   * Enters a handler of the recipe on this path all of whose elements show (ADR 0027).
   * Several shown: the first not yet entered whose fact the item has, a `passkey` handler
   * before a `totp` handler, as the routes put the passkey first and it types nothing. A
   * `totp` handler is never entered by a login that already types a code, and needs the
   * item's built-in TOTP field. Returns whether the attempt moved on: to the handler's
   * steps, or to `challenge` when no shown handler qualifies or the attempt's budget has
   * no room for it.
   */
  async function enterHandler(run: Execution, path: string): Promise<boolean> {
    // A fresh handler's elements must be usable: its code field a shown writable input and
    // its button shown, enabled or not, as a Verify button disabled until the code is typed
    // is; so a hidden code input rendered with the sign-in form never stands for a code
    // page. The click step itself waits for the button to be enabled. A `totp` handler whose
    // button is also a route step's on this path, as in a form that asks for the code after
    // the password, needs every fill field of the route there gone: while one shows, the
    // page is still the sign-in page. A handler that already ran counts as shown again
    // whenever its elements are there, hidden or disabled, so it never runs twice.
    const routeFields = passwordVariants(run.recipe)
      .flatMap((variant) => variant.steps)
      .filter((step) => step.path === path)
      .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
      .filter(
        (target, index, all) => all.findIndex((other) => sameLoginTarget(other, target)) === index,
      );
    const routeClicks = passwordVariants(run.recipe)
      .flatMap((variant) => variant.steps)
      .filter((step) => step.path === path)
      .flatMap((step) => (step.kind === "click" ? [step.target] : []));
    const entries = (run.recipe.handlers ?? []).flatMap((handler, index) => {
      if (handler.path !== path) return [];
      const ran = run.metadata.handlers.some((entered) => entered.index === index);
      const sameForm =
        !ran &&
        handler.kind === "totp" &&
        routeClicks.some((target) => sameLoginTarget(target, handler.target));
      const targets = handlerTargets(handler);
      return [
        {
          handler,
          index,
          targets: [...targets, ...(sameForm ? routeFields : [])],
          require: [
            ...(ran
              ? targets.map(() => "present" as const)
              : handler.kind === "totp"
                ? (["writable", "shown"] as const)
                : (["shown"] as const)),
            ...(sameForm ? routeFields.map(() => "writable" as const) : []),
          ],
          own: targets.length,
        },
      ];
    });
    if (!entries.length) return false;
    // A separate observation, so the recipe's own bound of 24 elements still holds; past it,
    // the handlers that do not fit are not entered.
    let room = 24;
    const observable = entries.filter((entry) => {
      if (entry.targets.length > room) return false;
      room -= entry.targets.length;
      return true;
    });
    if (!observable.length) return false;
    const observed = await observe(
      run,
      observable.flatMap((entry) => entry.targets),
      observable.flatMap((entry) => entry.require),
    );
    if (!observed || observed.path !== path) return false;
    let offset = 0;
    const shown = observable
      .filter((entry) => {
        const states = observed.targets.slice(offset, offset + entry.targets.length);
        offset += entry.targets.length;
        return (
          states.length === entry.targets.length &&
          states.slice(0, entry.own).every((state) => state === "unique") &&
          states.slice(entry.own).every((state) => state !== "unique")
        );
      })
      .sort((left, right) => handlerOrder[left.handler.kind] - handlerOrder[right.handler.kind]);
    if (!shown.length) return false;
    const reportHandler = (
      entry: (typeof entries)[number],
      outcome: Extract<LoginReport, { type: "handler" }>["outcome"],
    ) =>
      report({
        type: "handler",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: run.recipe.id,
        handler: entry.index,
        kind: entry.handler.kind,
        outcome,
        steps: handlerSteps(entry.handler).length,
      });
    const challenge = () =>
      change(run, { type: "OBSERVED", result: "challenge", document: run.live.document });
    // A handler page shown again after its handler ran is left to the person, and so is a
    // second code in one login, so a wrong code or key is never retried into a lockout.
    const refusal = (entry: (typeof entries)[number]) =>
      run.metadata.handlers.some((entered) => entered.index === entry.index)
        ? ("shown-again" as const)
        : !run.metadata.facts[handlerFact[entry.handler.kind]]
          ? ("missing-fact" as const)
          : entry.handler.kind === "totp" && attemptUsesCode(run.recipe, run.metadata)
            ? ("code-used" as const)
            : undefined;
    const fresh = shown.find((entry) => refusal(entry) === undefined);
    if (!fresh) {
      reportHandler(shown[0]!, refusal(shown[0]!)!);
      await challenge();
      return true;
    }
    if (fresh.handler.kind === "totp") {
      // The code comes from the item's built-in TOTP field, which the account must allow.
      const authorized = await allowed(run);
      if (!authorized) return true;
      const code = codeFieldOf(
        authorized.connection,
        run.metadata.account.itemId,
        authorized.bindings,
        run.recipe,
      );
      if (!code || !authorized.fieldIds.includes(code)) {
        reportHandler(fresh, "missing-fact");
        await challenge();
        return true;
      }
    }
    const steps = handlerSteps(fresh.handler);
    const event: LoginAttemptEvent = {
      type: "HANDLER",
      handler: fresh.index,
      steps: steps.length,
      effects: steps.filter((step) => {
        const effect = loginStepEffect(step);
        return effect === "advance" || effect === "submit";
      }).length,
      document: run.live.document,
    };
    if (transitionLoginAttempt(run.metadata, event).state !== "ready") {
      reportHandler(fresh, "no-room");
      await challenge();
      return true;
    }
    reportHandler(fresh, "entered");
    await change(run, event);
    return true;
  }
  /**
   * After a `totp` handler's fill, whether the page moved on by itself before the click
   * found its button (ADR 0027): to another path, or to the completion or the rejection
   * without the button. A button still shown is clicked once as planned.
   */
  async function submittedByPage(
    run: Execution,
    click: Extract<LoginStep, { kind: "click" }>,
  ): Promise<boolean> {
    const { completion, rejection } = run.recipe;
    const proof = completion ? [completion.target, ...(completion.absent ?? [])] : [];
    const observed = await observe(
      run,
      [click.target, ...proof, ...(rejection ? [rejection] : [])],
      undefined,
      completion ? [false, true] : undefined,
    );
    if (!observed || !current(run)) return false;
    if (observed.path !== click.path) return true;
    if (observed.targets[0] === "unique") return false;
    const proven =
      completion !== undefined &&
      observed.path === completion.path &&
      observed.targets[1] === "unique" &&
      observed.targets.slice(2, 1 + proof.length).every((state) => state === "missing");
    return proven || (rejection !== undefined && observed.targets[1 + proof.length] === "unique");
  }
  /**
   * The page submitted a `totp` handler's code by itself: the handler's click counts as
   * done, and the page is settled as after a click. The code is never filled again.
   * Returns whether the attempt took it.
   */
  async function codeSubmitted(run: Execution): Promise<boolean> {
    await change(run, { type: "AUTO_SUBMITTED", operationId: crypto.randomUUID() });
    if (
      !current(run) ||
      run.metadata.state !== "reconciling" ||
      run.metadata.operationKind !== "click"
    )
      return false;
    // Held as after the click: a page that shows "Verifying" with the button still there
    // is neither judged nor settled while it verifies.
    run.heldClick = run.metadata.stepIndex;
    await reconcileBounded(run);
    return true;
  }
  /**
   * After an effect step that no check explained, sends the resulting page so the
   * service can judge it and learn the completion or a handler (ADR 0018, ADR 0027).
   * Returns whether the attempt settled or moved on. A page that still shows the route's
   * fields on one of its paths, or the completion marker, is not sent. At most
   * `MAX_JUDGED_PAGES` pages count per effect step: a page counts in the attempt once its
   * complete description is in hand, before the request, so a restart cannot resend
   * without bound, and is given back only for a temporary refusal before any model call.
   */
  async function learn(run: Execution): Promise<boolean> {
    const { recipe, metadata } = run;
    const { operationId } = metadata;
    if (!generation || !effectful(metadata) || !operationId) return false;
    // Why the page was not sent, as a code for diagnostics: never page text.
    const notSent = (reason: string) => {
      report({
        type: "judge",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: metadata.route,
        verdict: "not-sent",
        reason,
      });
      return false;
    };
    if (judgedPages(metadata, operationId) >= MAX_JUDGED_PAGES) return notSent("page-limit");
    // Every variant's fill fields and paths count, as on the service, which is never told
    // the variant; on the passkey route, its button and the password form, on its path and
    // the password route's (ADR 0027).
    const paths = routeSignInPaths(recipe, metadata.route);
    const marker = recipe.completion ? [recipe.completion.target] : [];
    const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24 - marker.length);
    const remaining = await observe(
      run,
      [...fills, ...marker],
      undefined,
      marker.length > 0 ? [...fills.map(() => false), true] : undefined,
    );
    if (!remaining) {
      // A superseded run or a refused one (logged with its own cause) says nothing here.
      if (current(run) && !terminal(run.metadata)) notSent("unreachable");
      return false;
    }
    if (
      paths.includes(remaining.path) &&
      remaining.targets.slice(0, fills.length).some((state) => state !== "missing")
    )
      return notSent("sign-in-shown");
    // The marker shows, but the completion check did not prove the sign-in: another path,
    // more than one match, or an element that must be gone still shows.
    if (marker.length > 0 && remaining.targets[fills.length] !== "missing")
      return notSent("marker-shown");
    let observation: LoginObservation | undefined;
    let unsent = "unreachable";
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(run.live, { type: "login.extract", page: "signed-in" }),
      );
      const parsed =
        extracted.success && extracted.output.ok
          ? v.safeParse(loginObservationSchema, extracted.output.observation)
          : undefined;
      if (!extracted.success || !parsed?.success)
        unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "invalid-page";
      else if (!parsed.output.complete)
        unsent = (extracted.output.ok && extracted.output.gap) || "incomplete";
      else if (
        parsed.output.origin !== run.live.document.origin ||
        parsed.output.path !== remaining.path
      )
        unsent = "page-changed";
      else observation = parsed.output;
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (!current(run)) return true;
    // A page that cannot be described completely is not sent and does not count.
    if (!observation) return notSent(unsent);
    const pages = judgedPages(run.metadata, operationId);
    await change(run, { type: "JUDGING", operationId });
    if (!current(run)) return true;
    if (judgedPages(run.metadata, operationId) !== pages + 1) return false;
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      detail: { reason?: string; takenOver?: boolean } = {},
    ) =>
      report({
        type: "judge",
        tabId: run.live.document.tabId,
        origin: run.live.document.origin,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        route: metadata.route,
        verdict,
        ...detail,
      });
    reportJudge("sent");
    const {
      verdict,
      reason,
      recipe: added,
    } = await generation.judge(recipe.id, recipe.revision, metadata.route, observation);
    if (!current(run)) {
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
      });
      return true;
    }
    // A temporary refusal, such as a busy service, gives the page back.
    if (verdict === "retry") await change(run, { type: "UNJUDGED", operationId });
    // Reported before the takeover's own entries, once whether it is taken over is known.
    let reported = false;
    const movedOn =
      verdict === "challenge" &&
      added !== undefined &&
      current(run) &&
      (await takeOver(run, added, observation.path, () => {
        reported = true;
        reportJudge(verdict, { takenOver: true });
      }));
    if (!reported)
      reportJudge(verdict, {
        ...(reason ? { reason } : {}),
        ...(added ? { takenOver: false } : {}),
      });
    if (movedOn || !current(run)) return true;
    await change(run, {
      type: "OBSERVED",
      result:
        verdict === "signed-in"
          ? "authenticated"
          : unproven(
              run,
              verdict === "rejected"
                ? "credential-rejected"
                : verdict === "challenge"
                  ? "challenge"
                  : "unknown",
            ),
      document: run.live.document,
    });
    return true;
  }
  /**
   * The first login takes over the revision its judged page added a handler to and runs
   * the handler on the page it is on (ADR 0027). Only a revision that keeps the routes and
   * their steps is taken over. Returns whether the attempt moved on.
   */
  async function takeOver(
    run: Execution,
    next: LoginRecipe,
    path: string,
    taking: () => void,
  ): Promise<boolean> {
    if (next.id !== run.recipe.id || !extendsRecipe(run.recipe, next)) return false;
    const event: LoginAttemptEvent = { type: "REVISED", recipeRevision: next.revision };
    if (transitionLoginAttempt(run.metadata, event).recipeRevision !== next.revision) return false;
    taking();
    // The recipe is replaced before the record that names its revision is written.
    run.recipe = next;
    await change(run, event);
    return current(run) && (await enterHandler(run, path));
  }
  // State transitions, journal writes and DOM effects form an ordered protocol.
  // Parallel execution would race policy checks or repeat submission side effects.
  /* eslint-disable no-await-in-loop */
  async function reconcileBounded(run: Execution): Promise<void> {
    // An advance is confirmed by the next step's elements, which get the same wait as any
    // fill or click; other results keep the shorter observation budget.
    let until =
      Date.now() + (run.metadata.operationEffect === "advance" ? LOGIN_STEP_WAIT_MS : 3000);
    // A held click's button may show this long before the page is left to the person.
    const holdUntil = Date.now() + HELD_CLICK_WAIT_MS;
    const observing = () => ["awaiting-result", "reconciling"].includes(run.metadata.state);
    // Each round re-authorizes against settings, so the longer advance budget polls slower.
    const interval = run.metadata.operationEffect === "advance" ? 200 : 50;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    while (current(run) && observing()) {
      const settle = Date.now() >= until;
      const held = await reconcile(run, settle);
      if (!current(run) || !observing()) return;
      if (held) {
        if (Date.now() >= holdUntil) {
          await change(run, { type: "OBSERVED", result: "challenge", document: run.live.document });
          return;
        }
        // Once the button is gone, the result gets the usual budget.
        until = Math.max(until, Date.now() + 3000);
        await sleep(500);
        continue;
      }
      // A failed observation leaves the attempt for its next document to reconcile.
      if (settle) return;
      await sleep(interval);
    }
  }
  async function drive(run: Execution): Promise<void> {
    if (run.running) return;
    run.running = true;
    try {
      if (run.metadata.state === "reconciling" || run.metadata.state === "awaiting-result")
        await reconcileBounded(run);
      while (current(run) && run.metadata.state === "ready") {
        if (!(await allowed(run))) return;
        // A fill or click waits for its elements before any intent, vault read or value
        // delivery; a slow render is not a failure until the owner-approved limit passes.
        const upcoming = attemptPlan(run.recipe, run.metadata)?.[run.metadata.stepIndex]?.step;
        // A fill-only login stops before anything that may advance or submit (ADR 0021 D).
        if (run.metadata.fillOnly && (!upcoming || effectfulStep(upcoming))) {
          await endFillOnly(run);
          return;
        }
        if (upcoming?.kind === "fill" || upcoming?.kind === "click") {
          // A code input may submit by itself once the code is in, as one that submits on
          // its last digit does; its click then has nothing left to do (ADR 0027).
          const afterCode =
            upcoming.kind === "click" &&
            codeStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
          if (afterCode && (await submittedByPage(run, upcoming))) {
            if (!current(run) || run.metadata.state !== "ready") return;
            if (await codeSubmitted(run)) continue;
            await change(run, { type: "FAILED", reason: "structural-mismatch" });
            return;
          }
          if (!current(run) || run.metadata.state !== "ready") return;
          const waited = await waitFor(run, loginReadiness(upcoming));
          if (!current(run) || run.metadata.state !== "ready") return;
          if (waited === "timeout") {
            if (
              afterCode &&
              (await submittedByPage(run, upcoming)) &&
              current(run) &&
              run.metadata.state === "ready" &&
              (await codeSubmitted(run))
            )
              continue;
            if (!current(run) || run.metadata.state !== "ready") return;
            await change(run, { type: "FAILED", reason: "structural-mismatch" });
            return;
          }
          if (waited !== "ready" || !(await allowed(run))) return;
        }
        const operation = nextLoginOperation(
          run.metadata,
          run.recipe,
          run.live.document,
          crypto.randomUUID(),
        );
        if (!operation) {
          await change(run, { type: "FAILED", reason: "structural-mismatch" });
          return;
        }
        // An advance whose next step is on its path is confirmed by that step's elements
        // only if they were not usable just before it (ADR 0013).
        const inPlace = inPlaceNext(run.recipe, run.metadata, operation.stepIndex);
        delete run.inPlace;
        // Known before its intent is recorded, so a stop in between takes the intent back.
        run.operation = operation;
        run.delivered = false;
        await change(run, {
          type: "PREPARE",
          operationId: operation.operationId,
          kind: operation.step.kind,
          effect: loginStepEffect(operation.step),
        });
        if (operation.step.kind === "click")
          await change(run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
        else if (operation.step.kind === "fill")
          await change(run, { type: "MUTATION_INTENT", operationId: operation.operationId });
        const authorized = await allowed(run);
        if (!authorized) return;
        if (
          !validateLoginOperation(
            operation,
            run.metadata,
            run.live.document,
            run.metadata.policyRevision,
          )
        ) {
          await change(run, { type: "FAILED", reason: "timeout" });
          return;
        }
        const values: { slot: string; value: string; secret?: LoginSecretKind }[] = [];
        let expected: { username: string } | undefined;
        let response: unknown;
        try {
          if (operation.step.kind === "fill") {
            for (const field of operation.step.fields) {
              const reference = authorized.binding.slots.find((entry) => entry.slot === field.slot);
              if (!reference) {
                await change(run, { type: "FAILED", reason: "structural-mismatch" });
                return;
              }
              // Vault reads are serial so a denial stops before any later field is released.
              let value: string | undefined;
              try {
                value = await fields({
                  account: run.metadata.account,
                  connection: authorized.connection,
                  fieldId: reference.fieldId,
                });
              } catch {
                // A failed read is not a page mutation; never reclassify it as uncertain.
                value = undefined;
              }
              if (!current(run)) return;
              // Locked, resynchronized or newly denied vault access withdraws this grant.
              if (value === undefined) {
                await change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
                return;
              }
              // A `totp` handler's code fills only a code input, whatever field it reads.
              const secret: LoginSecretKind | undefined =
                codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill"
                  ? "otp"
                  : loginSecretKind(
                      authorized.connection,
                      run.metadata.account.itemId,
                      reference.fieldId,
                    );
              values.push({ slot: field.slot, value, ...(secret ? { secret } : {}) });
            }
            // A step that fills a secret but no username, such as a password page for a
            // remembered account, must not show another account (owner decision,
            // 2026-10-11). Without a readable username the page is not compared.
            const usernameField = loginUsernameFieldId(
              authorized.connection,
              run.metadata.account.itemId,
            );
            if (
              usernameField &&
              values.some((entry) => entry.secret) &&
              !operation.step.fields.some((field) =>
                authorized.binding.slots.some(
                  (entry) =>
                    entry.slot === field.slot &&
                    loginFillsUsername(
                      authorized.connection,
                      run.metadata.account.itemId,
                      entry.fieldId,
                    ),
                ),
              )
            ) {
              let username: string | undefined;
              try {
                username = await fields({
                  account: run.metadata.account,
                  connection: authorized.connection,
                  fieldId: usernameField,
                });
              } catch {
                username = undefined;
              }
              if (!current(run)) return;
              if (username) expected = { username };
            }
          }
          if (operation.step.kind === "fill" || operation.step.kind === "click")
            await pause("before-delivery");
          if (!current(run)) return;
          const latest = await allowed(run);
          if (!latest) return;
          // Values belong to the snapshot that authorized them; a replacement withdraws them.
          if (latest.connection.snapshotId !== authorized.connection.snapshotId) {
            await change(run, { type: "POLICY_CHANGED" }, { cause: "vault-replaced" });
            return;
          }
          const after = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex + 1]?.step;
          const codeSubmit =
            codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
            after?.kind === "click"
              ? after.target
              : undefined;
          run.delivered = true;
          const { tabId } = run.live.document;
          if (
            operation.step.kind === "click" ||
            (operation.step.kind === "fill" && operation.step.effect !== "prepare")
          ) {
            const handler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
            effects.set(tabId, {
              attemptId: run.metadata.id,
              at: Date.now(),
              passkey:
                run.metadata.route === "passkey" ||
                (handler !== undefined && run.recipe.handlers?.[handler]?.kind === "passkey"),
            });
          }
          if (
            operation.step.kind === "fill" &&
            signInUrls.get(tabId)?.attemptId !== run.metadata.id
          )
            signInUrls.set(tabId, { attemptId: run.metadata.id, url: run.live.url });
          response = await send(run.live, {
            type: "login.execute",
            operation,
            values,
            ...(expected ? { account: expected } : {}),
            // One switch per tab: an attempt that follows a switch never clicks another.
            ...(expected && run.recipe.accountSwitch && !run.metadata.accountSwitched
              ? { accountSwitch: run.recipe.accountSwitch }
              : {}),
            // A `totp` handler's code fill watches for the page submitting the code itself.
            ...(codeSubmit ? { code: { submit: codeSubmit } } : {}),
            // An advance whose next step is on its path has the document measure that step
            // just before its effect, in the same task (ADR 0013).
            ...(inPlace ? { next: inPlace } : {}),
          });
        } finally {
          for (const entry of values) entry.value = "";
          if (expected) expected.username = "";
        }
        if (!current(run)) return;
        if (operation.step.kind === "fill" || operation.step.kind === "click")
          await pause("before-ack");
        if (!current(run)) return;
        delete run.operation;
        const result = v.safeParse(executionResultSchema, response);
        const matchedResult =
          result.success &&
          result.output.operationId === operation.operationId &&
          result.output.documentId === run.live.document.documentId;
        // Without the measurement the advance can only be confirmed on another path.
        if (
          matchedResult &&
          result.output.ok &&
          inPlace &&
          result.output.before?.length === inPlace.targets.length
        )
          run.inPlace = { operationId: operation.operationId, before: result.output.before };
        if (
          matchedResult &&
          !result.output.ok &&
          result.output.reason === "wrong-account" &&
          result.output.mutation === "none"
        ) {
          const switched =
            result.output.switchable === true &&
            run.recipe.accountSwitch !== undefined &&
            !run.metadata.accountSwitched;
          await change(run, {
            type: "WRONG_ACCOUNT",
            operationId: operation.operationId,
            document: run.live.document,
            ...(switched ? { switched: true } : {}),
          });
          // The switch is recorded before the click, so the page it leads to starts a new
          // attempt instead of resuming this one (owner decision, 2026-10-11).
          if (run.metadata.outcome === "account-switched") {
            const clicked =
              current(run) &&
              v.safeParse(
                v.object({ ok: v.literal(true) }),
                await send(run.live, {
                  type: "login.switch",
                  operationId: operation.operationId,
                }).catch(() => undefined),
              ).success;
            // Without the click the attempt ends as `wrong-account` and keeps its tab.
            if (!clicked) await withdrawSwitch(run);
          }
          return;
        }
        // The page would not accept the values; the same values would fail again.
        if (
          matchedResult &&
          !result.output.ok &&
          operation.step.kind === "fill" &&
          ((result.output.reason === "value-mismatch" && result.output.mutation === "none") ||
            (result.output.reason === "fill-rejected" && operation.step.effect === "prepare"))
        ) {
          await change(run, {
            type: "VALUE_REJECTED",
            operationId: operation.operationId,
            document: run.live.document,
            stage: result.output.reason === "value-mismatch" ? "before-fill" : "after-fill",
          });
          return;
        }
        // The code page showed that it submits the code by itself, or replaced its form
        // once the code was in.
        if (
          matchedResult &&
          !result.output.ok &&
          (result.output.reason === "submitted" ||
            result.output.reason === "structural-mismatch") &&
          result.output.mutation === "possible" &&
          codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
          (await codeSubmitted(run))
        )
          continue;
        if (!matchedResult || !result.output.ok) {
          await change(
            run,
            matchedResult && result.output.reason === "cancelled"
              ? { type: "CANCEL" }
              : {
                  type: "FAILED",
                  reason:
                    matchedResult && result.output.reason === "timeout"
                      ? "timeout"
                      : "structural-mismatch",
                  mutation: matchedResult ? result.output.mutation : "possible",
                  operationId: operation.operationId,
                  document: run.live.document,
                },
          );
          return;
        }
        if (
          operation.step.kind !== "click" &&
          !(operation.step.kind === "fill" && operation.step.effect !== "prepare")
        ) {
          await change(run, { type: "OPERATION_OK", operationId: operation.operationId });
          continue;
        }
        await change(run, { type: "SUBMITTED", operationId: operation.operationId });
        // A handler's click and the passkey route's click are held (ADR 0027).
        const done = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex];
        if (done && (done.handler !== undefined || run.metadata.route === "passkey"))
          run.heldClick = operation.stepIndex;
        // DOM navigation can replace this document. A same-page result is observed with a finite budget.
        await reconcileBounded(run);
        if (run.metadata.state !== "ready") return;
      }
    } catch {
      if (current(run) && !terminal(run.metadata)) {
        run.metadata = recoverLoginAttempt(run.metadata);
        await save(run).catch(() => undefined);
        await publish(run.live, run.metadata);
      }
    } finally {
      run.running = false;
    }
  }
  /* eslint-enable no-await-in-loop */
  /**
   * First steps a document watches for: every route's and variant's of each recipe,
   * deduplicated and bounded for the wire. A path where several recipes start is left out,
   * because such a page cannot start (ADR 0013); several variants of one recipe starting
   * there do not (ADR 0027).
   */
  async function startsFor(documentOrigin: string): Promise<LoginReadiness[]> {
    const all =
      probeMode && documentOrigin === origin
        ? probeStarts(origin)
        : await recipes.starts(documentOrigin).catch(() => []);
    const steps = all
      .filter((start) => all.filter((other) => other.path === start.path).length === 1)
      .flatMap((start) => start.steps);
    const unique = new Map(
      steps.map((step) => {
        const readiness = loginReadiness(step);
        return [JSON.stringify(readiness), readiness];
      }),
    );
    return [...unique.values()].slice(0, 32);
  }
  /**
   * Whether this document may be sent for generation once it shows a sign-in input: a
   * top-level page on whose path no cached recipe of its origin starts (several starting
   * there count too), and whose path was not sent within the retry window (ADR 0016).
   */
  async function offersGeneration(live: LiveDocument): Promise<true | GenerationHold | undefined> {
    if (!generation || !uris || live.document.frameId !== 0 || live.topUrl) return undefined;
    if (probeMode && live.document.origin === origin) return undefined;
    const starts = await recipes.starts(live.document.origin).catch(() => undefined);
    if (starts === undefined || starts.some((start) => start.path === live.path)) return undefined;
    return generation.available(live.document.origin, live.path).catch(() => undefined);
  }
  /**
   * The slots to generate for when a vault item's URI matches the page, with the
   * matching items. No field value is read here.
   */
  async function generationSlotsFor(live: LiveDocument): Promise<GenerationScope | undefined> {
    if (!uris) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return undefined;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url: live.url,
      match: uris,
    });
    if (!scope.ok) return undefined;
    const items = scope.candidates.flatMap((candidate) => {
      const connection = snapshot.catalog.connections.find(
        (entry) => entry.id === candidate.connectionId,
      );
      const item = connection?.items.find((entry) => entry.id === candidate.itemId);
      return connection && item ? [{ connection, item }] : [];
    });
    // Only slots a matching item can fill; built-in fields keep these IDs on every device.
    const slots = generationSlots.filter(({ fieldId }) =>
      items.some(({ connection, item }) =>
        offersGenerationField(
          snapshot.snapshot.settings,
          { connectionId: connection.id, item },
          fieldId,
        ),
      ),
    );
    // Custom fields are offered by name only when the item allows them (ADR 0027).
    const offers = customFieldOffers(
      items.flatMap(({ connection, item }) => {
        const eligibility = getItemEligibility(
          snapshot.snapshot.settings,
          snapshot.catalog,
          connection.id,
          item.id,
        );
        return eligibility.eligible
          ? [{ connectionId: connection.id, item, allowedFieldIds: eligibility.fieldIds }]
          : [];
      }),
    );
    if (!slots.length && !offers.length) return undefined;
    return {
      slots: slots.map(({ slot }) => slot),
      offers,
      items,
      settings: snapshot.snapshot.settings,
      // An item that could not be checked might have another username.
      complete: !scope.unavailableConnections.length && !scope.incompleteItems.length,
    };
  }
  /**
   * The shape the given values share (ADR 0010), read locally just before the page is sent
   * (owner decision, 2026-10-11): only when every non-empty value gives the same length,
   * character classes and email form. An empty value does not count; a scope with items
   * that could not be checked, a read that fails, or a value too long to shape sends no
   * shape. Values are read one at a time and never kept.
   */
  async function sharedShape(
    pageOrigin: string,
    scope: GenerationScope,
    reads: readonly {
      connection: VaultConnectionMetadata;
      itemId: string;
      fieldId: string;
      source: "username" | "text";
    }[],
  ): Promise<ValueShape | undefined> {
    if (!scope.complete) return undefined;
    let shape: ValueShape | undefined;
    for (const { connection, itemId, fieldId, source } of reads) {
      let value: string | undefined;
      try {
        // Serial reads through the shared vault host, as for a fill.
        // eslint-disable-next-line no-await-in-loop
        value = await fields({
          account: { origin: pageOrigin, connectionId: connection.id, itemId },
          connection,
          fieldId,
        });
      } catch {
        value = undefined;
      }
      if (value === undefined) return undefined;
      if (!value) continue;
      const itemShape = valueShapeOf({ source, value });
      value = "";
      // A value too long to shape cannot be compared.
      if (!itemShape) return undefined;
      if (shape && JSON.stringify(shape) !== JSON.stringify(itemShape)) return undefined;
      shape = itemShape;
    }
    return shape;
  }
  /**
   * The shape of the matching items' username: an item without a username, or whose
   * username the user excluded, does not count.
   */
  function usernameShape(pageOrigin: string, scope: GenerationScope) {
    return sharedShape(
      pageOrigin,
      scope,
      scope.items.flatMap(({ connection, item }) => {
        const excluded = scope.settings.connections
          .find((entry) => entry.connectionId === connection.id)
          ?.excludedFields.some(
            (field) => field.itemId === item.id && field.fieldId === "login.username",
          );
        return excluded || !item.fields.some((field) => field.id === "login.username")
          ? []
          : [
              {
                connection,
                itemId: item.id,
                fieldId: "login.username",
                source: "username" as const,
              },
            ];
      }),
    );
  }
  /**
   * The custom-field slots with the shapes their fields share (ADR 0027): only for Text
   * fields and Linked fields that read the username or a Text field, never for Hidden
   * fields or the password, and within a bound on the values read per request.
   */
  async function customSlots(pageOrigin: string, scope: GenerationScope) {
    let budget = MAX_CUSTOM_SHAPE_READS;
    const slots: SemanticSlot[] = [];
    for (const offer of scope.offers) {
      const reads = offer.members.flatMap(({ connectionId, itemId, fieldId, source }) => {
        const connection = scope.items.find(
          (entry) => entry.connection.id === connectionId,
        )?.connection;
        return connection && source ? [{ connection, itemId, fieldId, source }] : [];
      });
      let shape: ValueShape | undefined;
      if (
        scope.complete &&
        offer.shapeable &&
        reads.length === offer.members.length &&
        reads.length <= budget
      ) {
        budget -= reads.length;
        // eslint-disable-next-line no-await-in-loop
        shape = await sharedShape(pageOrigin, scope, reads);
      }
      slots.push(shape ? { ...offer.slot, valueShape: shape } : offer.slot);
    }
    return slots;
  }
  /** Logs once per document and reason why it was not sent for generation. */
  function skipGeneration(live: LiveDocument, reason: string): void {
    if (live.generationSkip === reason) return;
    live.generationSkip = reason;
    report({
      type: "generation",
      tabId: live.document.tabId,
      origin: live.document.origin,
      outcome: "skipped",
      reason,
    });
  }
  /**
   * Sends this page's observation for generation. A returned recipe is in the recipe
   * cache by then; the document announces again and starts it once its first step is
   * ready (ADR 0018).
   */
  async function generateFor(live: LiveDocument, scope: GenerationScope): Promise<void> {
    if (!generation) return;
    const key = frameKey(live.document);
    try {
      let observation: LoginObservation | undefined;
      // A page that renders its form in steps may offer itself before the form is whole,
      // so a page that cannot be described yet is read again (Vpass, 2026-10-12).
      for (let read = 1; ; read += 1) {
        const extracted = v.safeParse(
          extractResultSchema,
          // eslint-disable-next-line no-await-in-loop
          await send(live, { type: "login.extract", page: "login" }),
        );
        if (documents.get(key) !== live) return;
        // The content script's refusal, such as `no-locator` or `extract-error`;
        // `extract-failed` for an answer that fails its check or never came.
        let unsent =
          extracted.success && !extracted.output.ok ? extracted.output.reason : "extract-failed";
        if (extracted.success && extracted.output.ok) {
          const parsed = v.safeParse(loginObservationSchema, extracted.output.observation);
          // An incomplete observation is not sent (ADR 0016).
          if (
            parsed.success &&
            parsed.output.complete &&
            parsed.output.origin === live.document.origin &&
            parsed.output.path === live.path
          ) {
            observation = parsed.output;
            break;
          }
          unsent = "incomplete-observation";
        }
        if (unsent === "cancelled" || read >= EXTRACT_READS) {
          skipGeneration(live, unsent);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, EXTRACT_RETRY_MS));
        if (documents.get(key) !== live) return;
      }
      const shape = await usernameShape(live.document.origin, scope);
      const custom = await customSlots(live.document.origin, scope);
      if (documents.get(key) !== live) return;
      const result = await generation
        .generate({
          version: 1,
          observation,
          slots: [
            ...scope.slots.map((slot) =>
              slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
            ),
            ...custom,
          ],
        })
        .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error" }));
      report({
        type: "generation",
        tabId: live.document.tabId,
        origin: live.document.origin,
        ...result,
      });
      if (result.outcome !== "recipe" || documents.get(key) !== live) return;
      await browser.tabs.sendMessage(
        live.document.tabId,
        { version: 1, type: "login.reconnect" },
        { documentId: live.document.documentId, frameId: live.document.frameId },
      );
    } catch {
      // The document went away or the service could not answer; nothing was started.
    }
  }
  /**
   * After a refusal because no vault item matches, a vault check may bring the item from
   * another device. Once a check applied a new snapshot in time, only the refused document
   * is asked to announce again, and only while it is still that refused document.
   */
  function retryAfterSync(live: LiveDocument, reason: string): void {
    // A document replaced while the refusal was published could never be reconnected.
    if (documents.get(frameKey(live.document)) !== live) return;
    let synced: Promise<boolean> | undefined;
    try {
      synced = options.vault?.checkAfterMiss?.();
    } catch {
      return;
    }
    void synced
      ?.then(async (applied) => {
        if (
          !applied ||
          documents.get(frameKey(live.document)) !== live ||
          live.state !== "denied" ||
          live.reason !== reason
        )
          return undefined;
        await browser.tabs.sendMessage(
          live.document.tabId,
          { version: 1, type: "login.reconnect" },
          { frameId: live.document.frameId, documentId: live.document.documentId },
        );
        return undefined;
      })
      .catch(() => undefined);
  }
  type Readiness = { ok: boolean; reason?: string; starts?: LoginReadiness[]; generate?: true };
  async function ready(
    sender: Sender,
    token: string,
    start?: { path: string },
    signIn?: { path: string },
    shown?: { path: string },
  ): Promise<Readiness> {
    // Admission is async; a later hello from the same frame must not be overtaken by an older one.
    const helloKey = `${sender.tab?.id}:${sender.frameId}`;
    const sequence = (hellos.get(helloKey) ?? 0) + 1;
    hellos.set(helloKey, sequence);
    // Entered after the sequence is taken, so a hello waiting on the vault check is stale
    // once a later one from the same frame arrives (ADR 0025).
    const admission = (async () => {
      const leave = await options.vault?.enter(start !== undefined);
      try {
        return await admitFresh(sender, token, helloKey, sequence, start, signIn, shown);
      } finally {
        leave?.();
      }
    })();
    admitting.set(helloKey, admission);
    try {
      return await admission;
    } finally {
      if (admitting.get(helloKey) === admission) admitting.delete(helloKey);
    }
  }
  /**
   * A new login is admitted again with fresh settings when another login's account choice
   * was saved meanwhile.
   */
  async function admitFresh(
    sender: Sender,
    token: string,
    helloKey: string,
    sequence: number,
    start?: { path: string },
    signIn?: { path: string },
    shown?: { path: string },
    tries = 0,
  ): Promise<Readiness> {
    const result = await admit(sender, token, helloKey, sequence, start, signIn, shown);
    if (result.reason !== CHOICE_SAVED) return result;
    return tries < 2
      ? admitFresh(sender, token, helloKey, sequence, start, signIn, shown, tries + 1)
      : { ok: false, reason: "stale-document" };
  }
  /** Resolves once no account choice is being saved. */
  async function choicesSaved(): Promise<void> {
    if (!savingChoices.size) return;
    await Promise.all(savingChoices);
    return choicesSaved();
  }
  async function admit(
    sender: Sender,
    token: string,
    helloKey: string,
    sequence: number,
    start?: { path: string },
    signIn?: { path: string },
    shown?: { path: string },
  ): Promise<Readiness> {
    await loaded;
    await sessionLoaded;
    const document = await identify(sender);
    if (!document || !sender.url) return { ok: false, reason: "unauthorized-document" };
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    const key = frameKey(document);
    // A new page in the tab replaces the document that waited for a choice.
    const waiting = pending.get(document.tabId);
    if (
      waiting?.document.frameId === 0 &&
      document.frameId === 0 &&
      waiting.document.documentId !== document.documentId
    )
      clearChoice(document.tabId);
    // `sender.url` keeps the URL the document loaded with; a same-document URL change
    // (history.pushState) of the tab's page shows only in the tab's committed URL. A frame
    // inside the page keeps its load URL and records the tab's URL to match as well.
    let url = sender.url;
    let topUrl: string | undefined;
    try {
      const tab = await browser.tabs.get(document.tabId);
      if (document.frameId !== 0) {
        // A frame's page is a web page; any other URL means the tab moved on.
        if (!tab.url || !/^https?:$/.test(new URL(tab.url).protocol))
          return { ok: false, reason: "stale-document" };
        topUrl = tab.url;
      } else if (tab.url && new URL(tab.url).origin === document.origin) url = tab.url;
    } catch {
      return { ok: false, reason: "closed-tab" };
    }
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
    // page around a framed login, never takes it over or disturbs it. Only a new page in
    // the tab (another top document) ends an attempt held by a frame of the old page.
    let owner = tabAttempt(document.tabId);
    const page = documents.get(frameKey({ tabId: document.tabId, frameId: 0 }));
    let newPage =
      document.frameId === 0 &&
      page !== undefined &&
      page.document.documentId !== document.documentId;
    if (newPage) {
      // Frames of this page may have announced before it did. Only documents that no
      // longer answer went away with the old page.
      // A frame that does not answer in time counts as still there.
      const frames = [...documents].filter(
        ([, entry]) => entry.document.tabId === document.tabId && entry.document.frameId !== 0,
      );
      const answers = await Promise.all(
        frames.map(([, entry]) =>
          Promise.race([
            send(entry, { type: "login.observe", path: entry.path, targets: [] }).then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => setTimeout(resolve, 1000, true)),
          ]),
        ),
      );
      for (const [index, [other]] of frames.entries()) if (!answers[index]) documents.delete(other);
      if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
      owner = tabAttempt(document.tabId);
      const holder = owner && documents.get(frameKey(owner.document));
      if (owner && owner.document.frameId !== 0) {
        if (holder && sameLoginDocument(holder.document, owner.document)) {
          // The frame holding the attempt is still there, so this page is its parent.
          newPage = false;
        } else if (!terminal(owner)) {
          // The frame's page is gone: its attempt ends without resubmitting, whatever
          // origin the new page has.
          const run = attempts.get(document.tabId);
          const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(owner), {
            type: "NAVIGATED",
            document,
          });
          if (run) run.metadata = ended;
          try {
            await keep(ended);
          } catch {
            return { ok: false, reason: "storage-unavailable" };
          }
          if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
          owner = ended;
        }
      }
    }
    // The site the tab shows now. A login on another site's page, in the page or in one of
    // its frames, is a login of a site the tab left: it never holds a document of this
    // site, and a top-level one still running ends below.
    const siteOrigin = topUrl ? new URL(topUrl).origin : document.origin;
    const leftSite = (record: LoginAttemptMetadata) => {
      const site = record.document.frameId === 0 ? record.account.origin : record.pageOrigin;
      return site !== undefined && site !== siteOrigin;
    };
    // A busy document is still recorded, so a later new page in the tab is recognized.
    const busy =
      owner !== undefined &&
      !leftSite(owner) &&
      owner.document.frameId !== document.frameId &&
      !newPage;
    const oldLive = documents.get(key);
    const sameDocument = oldLive !== undefined && sameLoginDocument(oldLive.document, document);
    // A document may announce again when its form appears or its URL changes in place,
    // but never while it already carries an attempt, unless that login finished and the
    // document now watches for a logout (ADR 0021 D).
    const carried = attempts.get(document.tabId);
    if (
      sameDocument &&
      (oldLive.token !== token ||
        (carried?.live === oldLive && !(document.frameId === 0 && finishedLogin(carried.metadata))))
    )
      return { ok: false, reason: "duplicate-document" };
    if (oldLive && !sameDocument)
      await send(oldLive, { type: "login.cancel" }).catch(() => undefined);
    const path = new URL(url).pathname;
    const live: LiveDocument = {
      document,
      token,
      url,
      path,
      ...(topUrl ? { topUrl } : {}),
      // A document announcing again on the same path logs each generation skip once.
      ...(sameDocument && oldLive.path === path && oldLive.generationSkip
        ? { generationSkip: oldLive.generationSkip }
        : {}),
      ...(sameDocument && oldLive.path === path && oldLive.notStarted
        ? { notStarted: oldLive.notStarted }
        : {}),
    };
    documents.set(key, live);
    const refuse = async (reason: string, detail?: string) => {
      report({
        type: "refused",
        tabId: document.tabId,
        origin: document.origin,
        reason,
        ...(detail ? { detail } : {}),
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      });
      live.state = "denied";
      live.reason = reason;
      await publish(live);
      return { ok: false, reason };
    };
    // A sign-in input shows on this path, but the page only watches: logged once per
    // document and path, so a login that silently does not start can be told apart.
    const notStarted = (detail: string) => {
      if (shown?.path !== live.path || live.notStarted === detail) return;
      live.notStarted = detail;
      report({
        type: "refused",
        tabId: document.tabId,
        origin: document.origin,
        reason: "not-started",
        detail,
        ...(document.frameId === 0 ? {} : { frame: true as const }),
      });
    };
    // A report sent only for the log does not log the tab's hold again.
    if (busy)
      return shown && !start && !signIn ? { ok: false, reason: "tab-busy" } : refuse("tab-busy");
    if (!storageHealthy) return refuse("storage-unavailable");
    const holder = tabAttempt(document.tabId);
    if (holder && !terminal(holder) && holder.document.frameId === 0 && leftSite(holder)) {
      // The tab's page moved to another origin: the attempt there ends without
      // resubmitting and keeps its record, and this page or its frame may start its own.
      // A frame stands for the tab's page, which left the attempt's origin.
      const run = attempts.get(document.tabId);
      const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(holder), {
        type: "NAVIGATED",
        document: { ...document, frameId: 0, origin: siteOrigin },
      });
      if (run) run.metadata = ended;
      reportAttempt(ended, run?.recipe);
      try {
        await keep(ended);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
    // A document resumes only its own origin's record in the tab, even an ended one, also
    // one of a site the tab left, so a login never submits there again.
    let recorded = recordFor(document.tabId, document.origin);
    const logoutKey = recordKey(document.tabId, document.origin);
    // A fill-only login is forgotten when it ends; one a stopped worker left ended is too.
    if (recorded?.fillOnly && terminal(recorded)) {
      try {
        await forget(logoutKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    if (
      recorded &&
      finishedLogin(recorded) &&
      recorded.document.frameId === 0 &&
      document.frameId === 0
    ) {
      // Until the recipe's first step shows again, the page keeps watching for it.
      if (start?.path !== live.path) {
        const starts = await startsFor(document.origin);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        // Not a recipe's first step on its path, so not taken as a logout (ADR 0021 D).
        notStarted("logged-in");
        return { ok: false, reason: "logged-in", starts };
      }
      // It shows again after a finished login: a logout. Only this tab's record for this
      // origin is released, and the tab asks for an account (ADR 0021 D).
      const released = recorded;
      if (attempts.get(document.tabId)?.metadata.id === released.id)
        attempts.delete(document.tabId);
      if (picked.get(document.tabId)?.attemptId === released.id) picked.delete(document.tabId);
      // The tab must keep asking after a restart, so its logout is stored first.
      logouts.add(logoutKey);
      try {
        await saveSession();
      } catch {
        logouts.delete(logoutKey);
        return refuse("storage-unavailable");
      }
      try {
        await forget(logoutKey);
      } catch {
        return refuse("storage-unavailable");
      }
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      recorded = undefined;
    }
    // A logout in another tab ends the shared session too, so this tab asks as well.
    const asking =
      !recorded && (logouts.has(logoutKey) || askedElsewhere(document.tabId, document.origin));
    // A tab runs one attempt at a time; another one still running holds it.
    const running = tabAttempt(document.tabId);
    if (running && !terminal(running) && running.id !== recorded?.id) return refuse("tab-busy");
    // After an account switch, the tab's next document of that origin starts a new
    // attempt, which may use another recipe. It carries the switch, so it never clicks
    // another one.
    const switched = recorded?.state === "blocked" && recorded.outcome === "account-switched";
    const previous = switched ? undefined : recorded;
    // Look up the recipe first: a page without one never opens the policy catalog or vault.
    let recipe =
      probeMode && document.origin === origin
        ? previous
          ? probeRecipe(origin, `/${previous.recipeId.replace(/^demo-/, "")}`)
          : probeRecipe(origin, live.path)
        : await recipes.recipe(document.origin, live.path, previous?.recipeId);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A new attempt starts only once the document reports a first step of its recipe ready:
    // any route's or variant's, or the path alone when one of them needs no element. Until
    // then it watches the first steps of every recipe for its origin; this reads no
    // settings, policy catalog or vault.
    if (
      !previous &&
      (!recipe ||
        (recipeStartSteps(recipe).every((step) => loginReadiness(step).targets.length) &&
          start?.path !== live.path))
    ) {
      const starts = await startsFor(document.origin);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      const availability = recipe ? undefined : await offersGeneration(live);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      let offer = availability === true;
      // Only a page that was sent is held, so the log says why it is not sent again.
      if (availability === "sending" || availability === "sent") skipGeneration(live, availability);
      if (offer && signIn?.path === live.path) {
        const scope = await generationSlotsFor(live).catch(() => undefined);
        if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (scope) {
          live.state = "generating";
          delete live.reason;
          await publish(live);
          void generateFor(live, scope);
          return { ok: false, reason: "generating" };
        }
        // No vault item matches this page, so it is not sent.
        skipGeneration(live, "no-vault-match");
        offer = false;
      }
      if (!recipe && !starts.length && !offer) return refuse("recipe-not-found");
      // Only an origin with a recipe: elsewhere every sign-in page would be logged.
      if (starts.length) notStarted(recipe ? "first-step-missing" : "no-recipe-on-path");
      live.state = "watching";
      delete live.reason;
      await publish(live);
      return {
        ok: false,
        reason: recipe ? "form-not-ready" : "recipe-not-found",
        starts,
        ...(offer ? { generate: true as const } : {}),
      };
    }
    // A resumed attempt keeps its own recipe revision; a replaced or different recipe never
    // takes it over. A newer revision that only adds handlers or a completion is taken over
    // when this worker still holds the recorded one to compare (ADR 0027); after a restart
    // only the recorded revision resumes.
    let revised = false;
    if (
      previous &&
      recipe &&
      previous.recipeId === recipe.id &&
      previous.recipeRevision !== recipe.revision
    ) {
      const known = attempts.get(document.tabId);
      const held =
        known?.metadata.id === previous.id &&
        known.recipe.id === previous.recipeId &&
        known.recipe.revision === previous.recipeRevision
          ? known.recipe
          : undefined;
      // A cache that lags behind the attempt keeps the attempt's own recipe.
      if (held && recipe.revision < held.revision) recipe = held;
      else if (held && extendsRecipe(held, recipe)) revised = true;
      else recipe = undefined;
    }
    if (
      !recipe ||
      recipe.origin !== document.origin ||
      (previous && previous.recipeId !== recipe.id)
    )
      return refuse("recipe-not-found");
    const savedBefore = remembered;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return refuse(snapshot.error.code);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A close/navigation can happen while settings storage was awaited.
    try {
      const tab = await browser.tabs.get(document.tabId);
      if (
        !tab.url ||
        documents.get(key) !== live ||
        (live.topUrl
          ? new URL(tab.url).origin !== new URL(live.topUrl).origin
          : new URL(tab.url).origin !== document.origin || new URL(tab.url).pathname !== live.path)
      )
        return refuse("stale-document");
    } catch {
      return refuse("closed-tab");
    }
    if (asking && heldElsewhere(document.tabId, document.origin)) {
      showHeld(document.tabId);
      return refuse("origin-busy");
    }
    // A new login reads its item's facts once and chooses its route from them (ADR 0027);
    // a resumed one keeps those in its record, so a sync cannot change its route.
    // After a logout, a document is filled once with the single account to use, without
    // pressing anything (ADR 0021 D); the passkey route has nothing to fill.
    const filledKey = `${document.tabId} ${document.documentId}`;
    const fill = asking && !previous && !switched && !logoutFills.has(filledKey);
    let plan = await planFor(snapshot, live, recipe, {
      asking,
      fill,
      ...(previous ? { route: attemptRouteChoice(previous) } : {}),
    });
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (plan.ok && "fillOnly" in plan && plan.route.route !== "password") {
      plan = await planFor(snapshot, live, recipe, { asking });
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
    if (!plan.ok) {
      // Only a fresh start can be restarted with a picked account (ADR 0021). The page
      // after an account switch belongs to that login, so it offers none.
      if (!previous && !switched && "candidates" in plan && plan.candidates)
        offerChoice(document, plan.candidates, "logout" in plan && plan.logout === true);
      const refused = await refuse(
        plan.reason,
        "detail" in plan
          ? plan.detail
          : plan.reason === "logged-out"
            ? // Which tab logged out: this one, or another tab of the site (ADR 0021 D).
              logouts.has(logoutKey)
              ? "this-tab"
              : "other-tab"
            : undefined,
      );
      // Asked while the page still holds vault replacement off, so a check started by
      // this page's announcement cannot apply before the miss is registered.
      if (!previous && !switched && "noUriMatch" in plan && plan.noUriMatch)
        retryAfterSync(live, plan.reason);
      return refused;
    }
    if (heldElsewhere(document.tabId, document.origin)) {
      showHeld(document.tabId);
      return refuse("origin-busy");
    }
    if (!previous) {
      // Another login's account choice, being saved now or saved since this snapshot was read,
      // bumps the revision this new login would be checked against: it is admitted again.
      await choicesSaved();
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (savingChoices.size || remembered !== savedBefore)
        return { ok: false, reason: CHOICE_SAVED };
      if (heldElsewhere(document.tabId, document.origin)) {
        showHeld(document.tabId);
        return refuse("origin-busy");
      }
    }
    if (!previous && persisted.size >= 100) return refuse("attempt-limit");
    // Another document of the tab, such as a frame, may have started an attempt while this
    // one was checked, and the tab runs one attempt at a time. Nothing below awaits until
    // the attempt is registered.
    const latest = tabAttempt(document.tabId);
    if (
      recordFor(document.tabId, document.origin)?.id !== recorded?.id ||
      (latest && !terminal(latest) && latest.id !== recorded?.id)
    )
      return refuse("tab-busy");
    let metadata: LoginAttemptMetadata;
    let resumedPolicy: PolicyChange | undefined;
    if (previous) {
      let resumed = recoverLoginAttempt(previous);
      // The page left the document a `totp` handler filled its code into before the click,
      // as a code input that submits on its last digit does: the page submitted the code
      // itself, and it is never filled again (ADR 0027).
      if (previous.document.documentId !== document.documentId && codeAwaitsClick(recipe, resumed))
        resumed = transitionLoginAttempt(resumed, {
          type: "AUTO_SUBMITTED",
          operationId: crypto.randomUUID(),
        });
      metadata = transitionLoginAttempt(resumed, {
        type: "NAVIGATED",
        document,
      });
      if (revised)
        metadata = transitionLoginAttempt(metadata, {
          type: "REVISED",
          recipeRevision: recipe.revision,
        });
      if (metadata.policyRevision !== snapshot.snapshot.revision && !terminal(metadata)) {
        metadata = transitionLoginAttempt(metadata, { type: "POLICY_CHANGED" });
        resumedPolicy = { cause: "settings-revision" };
      }
    } else {
      // A new login's plan carries the facts it chose its route with.
      if (!("facts" in plan)) return refuse("no-route");
      metadata = transitionLoginAttempt(
        createAttemptMetadata({
          id: crypto.randomUUID(),
          recipe,
          policyRevision: snapshot.snapshot.revision,
          account: {
            origin: document.origin,
            connectionId: plan.account.connectionId,
            itemId: plan.account.itemId,
          },
          choice: plan.route,
          facts: plan.facts,
          document,
          ...(document.frameId === 0 ? {} : { pageOrigin: siteOrigin }),
          accountSwitched: switched,
          fillOnly: "fillOnly" in plan,
        }),
        { type: "RESOLVE" },
      );
    }
    const run: Execution = {
      metadata,
      recipe,
      live,
      running: false,
      // Each document re-derives the choice; every step still checks it is the attempt's account.
      ...(plan.choice &&
      !terminal(metadata) &&
      plan.account.connectionId === metadata.account.connectionId &&
      plan.account.itemId === metadata.account.itemId
        ? { choice: plan.choice }
        : {}),
      ...("asked" in plan ? { asked: plan.asked } : {}),
    };
    // A new document after an advance on the same path, as a form posted back to its own
    // path, is checked against what the advancing document showed before it (ADR 0013).
    const before = attempts.get(document.tabId);
    if (
      before?.inPlace &&
      before.metadata.id === metadata.id &&
      before.inPlace.operationId === metadata.operationId
    )
      run.inPlace = before.inPlace;
    attempts.set(document.tabId, run);
    // Each new document of the tab resumes the attempt; only a change is news.
    reportAttempt(
      metadata,
      recipe,
      resumedPolicy,
      previous && metadata.state === previous.state && metadata.outcome === previous.outcome
        ? { repeat: true }
        : {},
    );
    clearChoice(document.tabId);
    // A hold's tooltip no longer applies once the tab logs in.
    void quietly(() => browser.action.setTitle({ tabId: document.tabId, title: "Pateat" }));
    const pick = picked.get(document.tabId);
    if (
      !previous &&
      pick?.connectionId === plan.account.connectionId &&
      pick.itemId === plan.account.itemId &&
      (pick.attemptId === undefined
        ? pick.documentId === document.documentId
        : // The login a pick started goes on past an account switch.
          switched && pick.attemptId === recorded?.id)
    ) {
      pick.attemptId = metadata.id;
      void quietly(saveSession);
    }
    // A login started after a logout ends the tab's asking for this origin; filling the
    // page only does not, and the document is not filled again.
    if (metadata.fillOnly) {
      logoutFills.add(filledKey);
      for (const old of logoutFills) {
        if (logoutFills.size <= 256) break;
        logoutFills.delete(old);
      }
      void quietly(saveSession);
    } else if (!previous && logouts.delete(logoutKey)) void quietly(saveSession);
    await save(run);
    await publish(live, metadata);
    void drive(run);
    return { ok: true };
  }
  async function handle(message: unknown, sender: Sender): Promise<unknown> {
    // Probe controls are compiled into every build but answer only in the probe build.
    if (probeMode && trusted(sender)) {
      const control = v.safeParse(probeControlSchema, message);
      if (control.success) {
        if (control.output.action === "release") {
          if (!releaseCheckpoint) return { ok: false, reason: "checkpoint-not-paused" };
          releaseCheckpoint();
          return { ok: true };
        }
        if (armed || checkpoint) return { ok: false, reason: "checkpoint-busy" };
        armed = control.output.checkpoint;
        armTimer = setTimeout(() => {
          armed = undefined;
        }, 30000);
        return { ok: true };
      }
      const config = v.safeParse(configureSchema, message);
      if (config.success) {
        await loaded;
        if (persisted.size) return { ok: false, reason: "attempts-exist" };
        origin = config.output.origin;
        account = config.output.account ?? DEMO_PROBE_ACCOUNT;
        probePasskey = config.output.passkey;
        probeTotp = config.output.totp === true;
        await browser.storage.local.set({
          [CONFIG_KEY]: {
            origin,
            ...(config.output.account ? { account } : {}),
            ...(probePasskey ? { passkey: probePasskey } : {}),
            ...(probeTotp ? { totp: true } : {}),
          },
        });
        return { ok: true };
      }
      if (v.safeParse(statusSchema, message).success) {
        await loaded;
        return {
          version: 1,
          ok: true,
          ...(checkpoint ? { checkpoint } : {}),
          attempts: [...persisted.values()],
          documents: [...documents.values()].map((live) => ({
            ...live.document,
            ...(live.state ? { state: live.state } : {}),
            ...(live.reason ? { reason: live.reason } : {}),
          })),
        };
      }
      const cancel = v.safeParse(cancelSchema, message);
      if (cancel.success) {
        const run = attempts.get(cancel.output.tabId);
        if (!run) return { ok: false, reason: "attempt-not-found" };
        await change(run, { type: "CANCEL" });
        await send(run.live, { type: "login.cancel" }).catch(() => undefined);
        return { ok: true };
      }
      return undefined;
    }
    if (fromPopup(sender)) {
      const ask = v.safeParse(choiceRequestSchema, message);
      if (ask.success) return choiceFor(ask.output.tabId);
      const pick = v.safeParse(pickRequestSchema, message);
      if (pick.success) return pickFor(pick.output);
      return undefined;
    }
    const hello = v.safeParse(helloSchema, message);
    if (hello.success) {
      options.vault?.refreshIfStale();
      return ready(
        sender,
        hello.output.token,
        hello.output.start,
        hello.output.signIn,
        hello.output.shown,
      );
    }
    const authorization = v.safeParse(authorizeSchema, message);
    if (!authorization.success) return undefined;
    const document = await identify(sender);
    if (!document) return false;
    const run = attempts.get(document.tabId);
    if (
      !run ||
      !current(run) ||
      run.live.token !== authorization.output.token ||
      run.metadata.id !== authorization.output.attemptId ||
      run.operation?.operationId !== authorization.output.operationId ||
      !sameLoginDocument(run.live.document, document) ||
      // A frame's attempt holds only while the tab still shows the page it matched.
      (run.live.topUrl !== undefined &&
        (!sender.tab?.url || new URL(sender.tab.url).origin !== new URL(run.live.topUrl).origin))
    )
      return false;
    if (!(await allowed(run))) return false;
    return validateLoginOperation(
      run.operation,
      run.metadata,
      document,
      run.metadata.policyRevision,
    );
  }
  /** Stops every running login: settings were synced from the service or saved locally. */
  function settingsChanged(source: "synced" | "saved"): void {
    for (const run of attempts.values()) {
      if (!terminal(run.metadata)) {
        // Stop in-flight DOM waits promptly; the journal write may be slower.
        void send(run.live, { type: "login.cancel" }).catch(() => undefined);
        void change(
          run,
          { type: "POLICY_CHANGED" },
          { cause: source === "synced" ? "settings-synced" : "settings-saved" },
        ).catch(() => undefined);
      }
    }
  }
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const key of hellos.keys()) if (key.startsWith(`${tabId}:`)) hellos.delete(key);
    for (const [key, live] of documents) if (live.document.tabId === tabId) documents.delete(key);
    attempts.delete(tabId);
    effects.delete(tabId);
    signInUrls.delete(tabId);
    for (const key of passkeyRequests.keys())
      if (key.startsWith(`${tabId} `)) passkeyRequests.delete(key);
    void sessionLoaded.then(async () => {
      let changed = pending.delete(tabId);
      if (picked.delete(tabId)) changed = true;
      for (const key of logouts)
        if (key.startsWith(`${tabId} `)) changed = logouts.delete(key) || changed;
      for (const key of logoutFills)
        if (key.startsWith(`${tabId} `)) changed = logoutFills.delete(key) || changed;
      if (changed) await quietly(saveSession);
      return undefined;
    });
    storageQueue = storageQueue
      .then(async () => {
        await loaded;
        for (const [key, metadata] of persisted)
          if (metadata.document.tabId === tabId) persisted.delete(key);
        await browser.storage.local.set({ [STORAGE_KEY]: [...persisted.values()] });
        return undefined;
      })
      .catch(() => {
        storageHealthy = false;
      });
  });
  // A worker restart does not reinstall content scripts. Rebind browser-provided
  // document identity before reconciling, without restoring pending side effects.
  void loaded
    .then(async () => {
      if (!storageHealthy) return undefined;
      const patterns = [
        ...(probeMode ? [`${origin}/*`] : []),
        ...(sites ? (await sites.origins()).map((entry) => `${entry}/*`) : []),
        // An automatically chosen account has no saved default until it authenticates.
        ...[...persisted.values()].map((entry) => `${entry.account.origin}/*`),
      ];
      const tabs = patterns.length ? await browser.tabs.query({ url: patterns }) : [];
      // A frame's attempt lives in a tab whose own URL may be on another origin.
      const tabIds = new Set([
        ...tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        ...[...persisted.values()].map((entry) => entry.document.tabId),
      ]);
      for (const tabId of tabIds)
        void browser.tabs
          // Every frame announces again; a frame inside the page may hold the attempt.
          .sendMessage(tabId, { version: 1, type: "login.reconnect" })
          .catch(() => undefined);
      await sessionLoaded;
      for (const waiting of pending.values())
        if (!tabIds.has(waiting.document.tabId)) void revive(waiting);
      return undefined;
    })
    .catch(() => undefined);
  /**
   * Whether a login is in progress; a policy write now would stop it. An attempt between
   * pages has no current document, so its saved state counts too, once it is loaded;
   * a settled one counts only as `inProgress` says.
   */
  async function active(): Promise<boolean> {
    await loaded;
    return (
      [...attempts.values()].some(inProgress) ||
      [...persisted.values()].some((metadata) => !terminal(metadata) && !metadata.settled)
    );
  }
  /**
   * The vault item of the login a tab is running on an origin. The passkey bridge answers
   * that login's requests with this item only (ADR 0027). A login runs while its record,
   * in memory or read back from storage after a worker restart, is neither authenticated
   * nor blocked and its result has not settled as unknown since it last moved on.
   */
  async function loginAccount(
    tabId: number,
    siteOrigin: string,
  ): Promise<{ connectionId: string; itemId: string } | undefined> {
    await loaded;
    const metadata = recordFor(tabId, siteOrigin);
    return metadata && !terminal(metadata) && !metadata.settled
      ? { connectionId: metadata.account.connectionId, itemId: metadata.account.itemId }
      : undefined;
  }
  /** The passkey bridge saw a request of this tab's top document (ADR 0029: S5). */
  function passkeyRequested(tabId: number, siteOrigin: string): void {
    passkeyRequests.set(`${tabId} ${siteOrigin}`, Date.now());
  }
  return { handle, settingsChanged, active, loginAccount, passkeyRequested };
}
