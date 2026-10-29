import {
  type LoginFieldTarget,
  type LoginAccount,
  type LoginBindingTemplate,
  type LoginObservation,
  type LayoutCandidate,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRoute,
  type LoginStep,
  type LoginTarget,
  type EntryGenerationRequest,
  type LoginEntryRecipe,
  type LoginLogoutRecipe,
  type RecipeGenerationRequest,
  type SemanticSlot,
  type SettingsResponse,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import type { ServiceTiming } from "../../service/transport";
import { type LoginBadge } from "../badge";
import { type LoginReadiness } from "../wire";
import { type LiveUriMatcher } from "../../vault/site-candidates";
import { type LoginPauses } from "../pause";
import { type RecipeRepairs } from "../repair";
import type { LoginSites } from "../sites";
import type { PasskeyItem } from "../../passkeys/runtime";
import { type LoginFieldSource } from "../vault";
import { type LogoutService } from "../switch";
import {
  type GenerationHold,
  type GenerationOutcome,
  type EntryGenerationOutcome,
  type PageSampleOutcome,
  type RecipeRepairClaim,
  type LoginReport,
} from "./report";

export type SettingsRuntime = {
  handle(value: unknown): Promise<SettingsResponse>;
  /** Trusted background mutation; saves an automatic account choice after confirmed `authenticated`. */
  update?(
    expectedRevision: number | undefined,
    cause: SettingsChangeCause,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ): Promise<SettingsSnapshot>;
};

export type LoginRecipeStart = {
  path: string;
  steps: LoginStep[];
  list?: LoginTarget[];
  /** What the later steps a login may start at when no first step shows wait for (ADR 0049). */
  later?: LoginReadiness[];
};

/**
 * Cached recipes. Account bindings come from synced settings (`settings.bindings`,
 * ADR 0013); neither carries values.
 */
export interface LoginRecipes {
  /**
   * The recipe for a document, or an attempt's own recipe by ID after navigation: one
   * layout of it (ADR 0060), the one named or else the newest.
   */
  recipe(
    origin: string,
    path: string,
    recipeId?: string,
    layout?: string,
  ): Promise<LoginRecipe | undefined>;
  /**
   * Every layout of the recipe that starts on the path, for a new login to choose from
   * (ADR 0060); none when no single recipe starts there.
   */
  layouts?(origin: string, path: string): Promise<LayoutCandidate<LoginRecipe>[]>;
  /**
   * Every layout of a recipe by ID, a chooser's branches for a chooser recipe: a sign-in
   * check reads all their signed-in markers (ADR 0060).
   */
  layoutsOf?(origin: string, recipeId: string): Promise<LoginRecipe[]>;
  /**
   * Whether the recipes, read without failure, no longer hold a layout of the recipe by ID
   * that runs: the recipe or its layout was withdrawn. False when they cannot be read, so a
   * resumed login whose lookup failed stays resumable (owner, 2026-10-23). A sync running
   * or being started by a lookup ends first, for at most a few seconds.
   */
  withdrawn?(origin: string, recipeId: string, layout?: string): Promise<boolean>;
  /** Where every recipe for the origin starts; a document watches for its first steps. */
  starts(origin: string): Promise<LoginRecipeStart[]>;
  /**
   * Each layout of the origin's login recipes with a later step on the path a login may
   * start at (ADR 0049, ADR 0060).
   */
  later?(origin: string, path: string): Promise<LoginRecipe[]>;
  /**
   * The chooser recipe (ADR 0028) whose list shows on the path, or a chooser login's own
   * recipe by ID after navigation: one layout of it, the one named or else the newest.
   */
  chooser?(
    origin: string,
    path: string,
    recipeId?: string,
    layout?: string,
  ): Promise<LoginChooserRecipe | undefined>;
  /** Every layout of the chooser whose list shows on the path (ADR 0060). */
  choosers?(origin: string, path: string): Promise<LayoutCandidate<LoginChooserRecipe>[]>;
  /** The origin's entry recipes (ADR 0031): a start path and the link pressed there. */
  entries(origin: string): Promise<LoginEntryRecipe[]>;
  /** The origin's logout recipes (ADR 0063), for an account switch. */
  logouts?(origin: string): Promise<LoginLogoutRecipe[]>;
  /**
   * Every route recipe of the origin whatever its page kind, and each chooser branch (ADR
   * 0028), which is `sign-in`. `recipe` and `starts` leave out one generated as `confirm`
   * or `unclear` (ADR 0035): its page is never logged in to and is not sent for generation
   * again. Their signed-in markers tell the generation request whether a page shows the
   * user signed in.
   */
  routes?(origin: string): Promise<LoginRecipe[]>;
}

export const noLoginRecipes: LoginRecipes = {
  recipe: async () => undefined,
  starts: async () => [],
  entries: async () => [],
};

/** The service's recipe generation routes (ADR 0016, ADR 0018). */
export interface LoginGeneration {
  /**
   * `true` when a page may be sent, else why not; with `base` and `branch`, as the first
   * page of that chooser branch (ADR 0028). A branch is the name `recipeBranch` gives a
   * layout and chooser branch (ADR 0060).
   */
  available(
    origin: string,
    path: string,
    base?: RecipeGenerationRequest["base"],
    branch?: string,
  ): Promise<true | GenerationHold>;
  /**
   * Sends one page: a recipe's first page, or with `base` the page after the final
   * `advance` step of that revision, which continues it. A continuation pulls recipes only,
   * so the login it belongs to is not stopped by a settings write. `sent` is called just
   * before the request leaves the device, for the local log (ADR 0019).
   */
  generate(request: RecipeGenerationRequest, sent?: () => void): Promise<GenerationOutcome>;
  /**
   * Sends a page without a login form, without slots (ADR 0031); its answer names the
   * page's sign-in entry. Claimed and held as `generate` claims a first page.
   */
  generateEntry(
    request: EntryGenerationRequest,
    sent?: () => void,
  ): Promise<EntryGenerationOutcome>;
  /**
   * Which vault field each custom slot of a recipe generated from this device names, from
   * the request that produced it (ADR 0027); nothing for a recipe it did not generate.
   */
  slotFields(recipeId: string): Promise<LoginBindingTemplate | undefined>;
  /**
   * Sends a page no recipe check explained after an effect step, so the service can
   * learn a signed-in marker or a handler (ADR 0027). `recipe` is the newer
   * revision with a handler added, already in the recipe cache. `sent` is called just
   * before the request leaves the device.
   */
  judge(
    recipeId: string,
    revision: number,
    route: LoginRoute,
    observation: LoginObservation,
    sent?: () => void,
    /**
     * The layout the login ran (ADR 0060), and for a chooser login (ADR 0028) the branch
     * whose route is judged, as `recipeBranch` names them; none for a recipe without layouts.
     */
    branch?: string,
    /**
     * The description left out a disabled field that may not be a sign-in field: the
     * service keeps the model's abstention as `partial`, so a page of the path described
     * in full is judged again (ADR 0029).
     */
    partial?: true,
    /**
     * The page of a login's stop before its item's missing password, which still shows the
     * stop step's password field: the service keeps only a `passkey` handler from it (ADR
     * 0036, owner 2026-10-13 05:39 UTC).
     */
    stop?: true,
    /**
     * The login account's slots, built as for generation (owner 2026-10-23: the same
     * information goes to every model call unless there is a sound reason); `totp` goes
     * only with a page that shows a code field.
     */
    slots?: readonly SemanticSlot[],
    /**
     * The page still shows the route's sign-in form beside another form that may ask for a
     * detail (`showsBesideForm`): the service keeps only a `detail` handler from it (ADR
     * 0061).
     */
    beside?: true,
  ): Promise<{
    /**
     * `retry` for a temporary refusal before any model call, which gives the page back:
     * no paired service, a rejected device, an unreachable or busy service, the service's
     * own request limit, or a request that failed before the model. `unclear` covers
     * every other answer, including permanent refusals and failed model calls. `optional`
     * is a page after the sign-in that the person may put off (ADR 0065).
     */
    verdict: "signed-in" | "rejected" | "challenge" | "optional" | "unclear" | "retry";
    /** For `retry` and `unclear`: the refusal or failure code, for the local log. */
    reason?: string;
    /** A chooser login's is the whole chooser (ADR 0028); either is the judged layout. */
    recipe?: LoginRecipe | LoginChooserRecipe;
    /**
     * With `recipe`: the secret questions the judge paired with a slot sent, by the answer
     * input, for the owner to confirm in the popup (ADR 0061).
     */
    questions?: { field: LoginFieldTarget; slot: string; shown: string }[];
    /** How long the request took, when one was sent (ADR 0019). */
    timing?: ServiceTiming;
  }>;
  /**
   * Sends a repeat login's signed-in page, which the service logs for evaluation without a
   * model call (ADR 0029, owner 2026-10-18 08:05 UTC), when this device sent none of the
   * recipe and branch in the last 30 days and a service is paired. `describe` is called
   * only then; the sample is recorded on the device before it is sent. `sending` is called
   * after that, just before the request leaves the device: a reason it answers, such as a
   * site excluded meanwhile, stops the request and leaves the record. Absent, no page is
   * sampled.
   */
  samplePage?(
    sample: { recipeId: string; revision: number; route: LoginRoute; branch?: string },
    describe: () => Promise<
      { observation: LoginObservation; slots: readonly SemanticSlot[] } | { unsent: string }
    >,
    sending?: () => Promise<string | undefined>,
  ): Promise<PageSampleOutcome>;
  /**
   * Claims a repair of a generated recipe the chosen item cannot run (ADR 0058 A, amended by
   * ADR 0041), at most once per recipe ID and missing `route` in 3 days for this service
   * and device, recorded before the request leaves. Absent, no such repair is sent.
   */
  claimRepair?(recipeId: string, route: LoginRoute): Promise<RecipeRepairClaim>;
  /**
   * Pulls the service's recipes into the cache, so a repair is never asked for a recipe
   * another device has already changed (ADR 0041).
   */
  pullRecipes?(): Promise<void>;
}

export type LoginRuntimeOptions = {
  fields: LoginFieldSource;
  sites?: LoginSites;
  recipes?: LoginRecipes;
  /** Live provider URI matching; without it only static `allowedOrigins` apply. */
  uris?: LiveUriMatcher;
  /** Recipe generation for pages without a recipe; needs `uris` for the vault match. */
  generation?: LoginGeneration;
  /**
   * Which generated recipes' start pages were sent for repair through `generation`
   * (ADR 0041); without it no recipe is repaired.
   */
  repairs?: RecipeRepairs;
  /**
   * The account item's passkey facts, read once when a login starts (ADR 0027). Without
   * it the item counts as holding no passkey, so a `passkey` handler is never run.
   */
  passkeys?: (account: LoginAccount) => Promise<{ passkey: boolean; discoverable: boolean }>;
  /**
   * The items holding a discoverable, usable passkey for the origin, by the criterion of
   * `passkeys`, from one vault search per RP ID (ADR 0034). Without it no popup choice
   * keeps a page's own conditional request waiting.
   */
  passkeyItems?: (origin: string) => Promise<readonly PasskeyItem[]>;
  /**
   * An account switch's logout (ADR 0063): the stored logout recipes and the logout role.
   * Without it the popup offers no switch.
   */
  logout?: LogoutService;
  /**
   * Whether the origin's hostname was just chosen "Always for this site" and its settings
   * write still waits (ADR 0007): the login treats it as listed already.
   */
  pendingBrowserSite?: (origin: string) => boolean;
  /** Receives each attempt state change, refusal and generation result. */
  report?: (report: LoginReport) => void;
  /**
   * The toolbar badge (ADR 0038): the account choice a tab waits on, a tooltip, and a
   * spin while a model request for its page is in flight, from the request's `sent` until
   * it returns; and the tab's last login and model request it read from the reports, for
   * the popup's page section. Without one the runtime writes `chrome.action` itself and
   * keeps nothing across worker restarts.
   */
  badge?: Pick<LoginBadge, "choice" | "note" | "spin" | "status" | "asking"> &
    Partial<Pick<LoginBadge, "paused">>;
  /**
   * The paused sites (ADR 0062); without it they are kept in `storage.session` under
   * `LOGIN_PAUSES_KEY`.
   */
  pauses?: LoginPauses;
  /**
   * Told of each origin of a login that reached signed in, on any route, so a site's
   * passkey registration right after it can be refused (ADR 0007). Never changes the login.
   */
  signedIn?: (tabId: number, origin: string) => void;
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
  /**
   * Told once the runtime has handled a tab's top-frame announcement, which may count
   * the site's items for the toolbar badge (ADR 0021).
   */
  announced?: (tabId: number, url: string) => void;
  /**
   * Asks for the master password of a login's item that has Bitwarden's re-prompt, on a
   * site whose settings honour it, in Pateat's chooser window (ADR 0021; owner, 2026-10-23
   * 12:46 UTC). `verified` once the vault accepted it; `unavailable` when no window may
   * open, as for a tab in the background or in incognito. Without it such an item never
   * starts a login there.
   */
  askMasterPassword?: (input: {
    tabId: number;
    origin: string;
    account: LoginAccount;
    connection: VaultConnectionMetadata;
    item: VaultItemMetadata;
    signal: AbortSignal;
  }) => Promise<"verified" | "closed" | "unavailable">;
};
