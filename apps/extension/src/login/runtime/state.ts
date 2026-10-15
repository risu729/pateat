import {
  attemptPlan,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { createLoginBadge, memoryBadgeStorage, setActionBadge } from "../badge";
import { DEFAULT_PROBE_ORIGIN, DEMO_PROBE_ACCOUNT, type ProbeAccount } from "../dummy";
import {
  type ChoicePasskeys,
  DocumentGone,
  type EntryBlock,
  type EntryPress,
  type Execution,
  frameKey,
  type LiveDocument,
  type ParkedRequest,
  type PendingChoice,
  type PickedAccount,
  type SettingsRuntime,
} from "./model";
import { type GenerationOutcome, noLoginRecipes } from "./recipes";
import type { LoginReport, PolicyChange, RouteChange, StopCause } from "./reports";
import type { LoginRuntimeOptions } from "../runtime";

/** What more than one part of the login runtime reassigns, so each reads and writes it there. */
type RuntimeVariables = {
  origin: string;
  account: ProbeAccount;
  probePasskey: "discoverable" | "second-factor" | undefined;
  probeTotp: boolean;
  /** Counts account choices saved or attempted, so a new login sees a bump it missed. */
  remembered: number;
  storageQueue: Promise<void>;
  storageHealthy: boolean;
  checkpoint: "before-delivery" | "before-ack" | undefined;
  armed: "before-delivery" | "before-ack" | "intent-write-failure" | undefined;
  armTimer: ReturnType<typeof setTimeout> | undefined;
  releaseCheckpoint: (() => void) | undefined;
};

/**
 * The state every part of the login runtime shares: its settings and options, what it
 * keeps in memory about documents, attempts and tabs, the values more than one part
 * reassigns, and the helpers that report and message documents.
 */
export function createRuntimeState(settings: SettingsRuntime, options: LoginRuntimeOptions) {
  const { fields, sites, recipes = noLoginRecipes, uris, generation } = options;
  const badge =
    options.badge ?? createLoginBadge({ setBadge: setActionBadge, storage: memoryBadgeStorage() });
  /** Spins the tab's badge from a model request's `sent` until `stop`, once the request returns. */
  function spinning(tabId: number) {
    let stop: (() => void) | undefined;
    return {
      sent: (then: () => void) => () => {
        stop ??= badge.spin(tabId);
        then();
      },
      stop: () => stop?.(),
    };
  }
  /** Reports about `source`'s document; only the tab's own page gets its URL (ADR 0019). */
  const report = (source: { frameId: number }, value: LoginReport) => {
    try {
      // A report that names its page's URL, even as none, keeps it.
      const page = documents.get(frameKey({ tabId: value.tabId, frameId: 0 }));
      const url =
        "url" in value
          ? value.url
          : source.frameId === 0 && page && page.document.origin === value.origin
            ? page.url
            : undefined;
      const { url: _named, ...rest } = value;
      options.report?.(url ? { ...rest, url } : rest);
    } catch {
      // A report must never change the answer.
    }
  };
  const reportAttempt = (
    metadata: LoginAttemptMetadata,
    recipe: LoginRecipe | undefined,
    policy?: PolicyChange,
    flags: {
      settled?: true;
      repeat?: true;
      stop?: StopCause;
      reason?: string;
      routeChange?: RouteChange;
    } = {},
  ) => {
    const { stop, ...marks } = flags;
    // Handler steps sit inside the plan, so the plan names the handler a step belongs to.
    const handler =
      recipe && metadata.handlers.length
        ? attemptPlan(recipe, metadata)?.[metadata.stepIndex]?.handler
        : undefined;
    report(metadata.document, {
      type: "attempt",
      tabId: metadata.document.tabId,
      origin: metadata.document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
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
      ...(metadata.stopAt === undefined ? {} : { stop: "password" as const }),
      ...(policy && metadata.outcome === "policy-changed" ? policy : {}),
      ...(stop ? { cause: stop } : {}),
      ...marks,
    });
  };
  const documents = new Map<string, LiveDocument>();
  const attempts = new Map<number, Execution>();
  // ADR 0029's sign-in state reads these, kept in memory only and never stored.
  /**
   * By tab: when the attempt last delivered an effect step, the document it ran in, whether
   * the step submits (`submit`), whether it asks for a passkey itself (the `passkey` route,
   * or a `passkey` handler's click), so S5 skips it, and the first other top document of the
   * tab announced after it, within `SITE_MOVE_MS` (`next`). After a password step's
   * submission, that first new document alone is read for a sign-in form shown again
   * (ADR 0029). `code`: when the attempt last submitted a TOTP code, or may have, as the
   * code's click or a code fill the page may submit by itself, which lets a move to
   * another site stand for its result (ADR 0022).
   */
  const effects = new Map<
    number,
    {
      attemptId: string;
      at: number;
      document: LoginDocument;
      submits: boolean;
      passkey: boolean;
      next?: string;
      code?: number;
    }
  >();
  /**
   * By tab: the attempt that filled the item's password into its page and whether a
   * submitting step followed (`submitted`), so a passkey answered after that is a second
   * factor rather than the sign-in itself (ADR 0022).
   */
  const passwordFills = new Map<number, { attemptId: string; submitted: boolean }>();
  /** By tab: the URL of the document the attempt's first fill ran in, for E3. */
  const signInUrls = new Map<number, { attemptId: string; url: string }>();
  /** By tab and origin: the last passkey request of the top document, outside conditional mediation. */
  const passkeyRequests = new Map<string, number>();
  /**
   * By tab and origin: the last assertion the passkey bridge returned, its RP ID and the
   * vault item it was signed with.
   */
  const passkeyAnswers = new Map<
    string,
    { at: number; rpId: string; item?: { connectionId: string; itemId: string } }
  >();
  /**
   * By tab: the page of another origin of the site that a top-level attempt's tab moved to
   * and that asked for a passkey, while the attempt waits for the tab's next top page (ADR
   * 0022): a passkey answered there with the attempt's own item lets that page complete it.
   */
  const passkeyPages = new Map<
    number,
    { attemptId: string; document: LoginDocument; requestedAt: number }
  >();
  /**
   * By tab: the check of a move to another origin after a passkey answer, a password
   * submission or a second factor, while its new top page is read (ADR 0022).
   */
  const siteMoves = new Map<number, Promise<boolean>>();
  /**
   * By attempt: the judgement of the page its tab moved to after a password submission
   * (ADR 0022), while it runs, so the same document announcing again waits for it rather
   * than sending the page twice.
   */
  const moveJudgements = new Map<string, { documentId: string; verdict: Promise<boolean> }>();
  /** Top documents' own conditional passkey requests, waiting for their login (ADR 0034). */
  const parkedRequests = new Set<ParkedRequest>();
  /** By tab: its popup choice outside a logout and whether it offers a passkey (ADR 0034). */
  const choicePasskeys = new Map<number, ChoicePasskeys>();
  /**
   * The continuation each attempt asked for and the step it was asked for, by attempt ID
   * (ADR 0018): a later document of the login may use the answer. Kept in memory only, so
   * after a worker restart only the recipe cache can bring it.
   */
  const continuations = new Map<
    string,
    { operationId: string; answer: Promise<GenerationOutcome> }
  >();
  /** By `recordKey`, in the order they were last written. */
  const persisted = new Map<string, LoginAttemptMetadata>();
  /**
   * Tabs Chrome replaced, by their old ID: their records move to the new ID once loaded,
   * so the startup check keeps them although their old ID is no longer open.
   */
  const replacedTabs = new Set<number>();
  const picked = new Map<number, PickedAccount>();
  const pending = new Map<number, PendingChoice>();
  /** By `recordKey`: tabs that logged out of an origin and have not picked an account yet. */
  const logouts = new Set<string>();
  /** Reasons already logged, by tab, document and path; stored like the logout fills. */
  const noted = new Map<string, Set<string>>();
  /** By `recordKey`: tabs that ask after their own login stopped once it submitted. */
  const stoppedAsks = new Set<string>();
  /** By `recordKey`: the `logouts` that the site's rejection of the tab's login began. */
  const rejectedAsks = new Set<string>();
  /**
   * Documents filled once after a logout, so neither a re-announcement nor a restarted
   * worker fills over what the user typed (ADR 0021 D). The oldest go first.
   */
  const logoutFills = new Set<string>();
  /** By tab: its sign-in entry press, kept until the tab closes (ADR 0031). */
  const entryPresses = new Map<number, EntryPress>();
  /** By tab: the document whose sign-in entry is being checked and pressed now (ADR 0031). */
  const pressing = new Map<number, string>();
  /**
   * By `${tabId} ${documentId}`: the check of a page after an entry press while it runs, so
   * the same document announcing again waits for it.
   */
  const entryChecks = new Map<string, Promise<void>>();
  /** By tab: when an entry press with no next page so far is checked. */
  const entryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Pages after an entry press that blocked its recipe, as `${tabId} ${documentId}`: they
   * are never sent for generation and start no login (ADR 0031). The oldest go first.
   */
  const entryRefused = new Set<string>();
  /**
   * Blocks this worker could not store, because the device's blocks could not be read or
   * written; they hold until the worker stops (ADR 0031).
   */
  const unsavedBlocks: EntryBlock[] = [];
  /** Account choices being saved; each bumps the policy revision (ADR 0022). */
  const savingChoices = new Set<Promise<void>>();
  // Toolbar and session storage failures only lose the badge or a pick; never a login.
  const quietly = (work: () => Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then(
        () => undefined,
        () => undefined,
      );
  async function send(live: LiveDocument, message: Record<string, unknown>): Promise<unknown> {
    try {
      return await browser.tabs.sendMessage(
        live.document.tabId,
        { version: 1, token: live.token, ...message },
        { documentId: live.document.documentId, frameId: live.document.frameId },
      );
    } catch (error) {
      // The browser rejects when no listener in the document answered: the document has no
      // receiver anymore, or it unloaded before its answer.
      throw new DocumentGone(error);
    }
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
  const variables: RuntimeVariables = {
    origin: DEFAULT_PROBE_ORIGIN,
    account: DEMO_PROBE_ACCOUNT,
    probePasskey: undefined,
    probeTotp: false,
    remembered: 0,
    storageQueue: Promise.resolve(),
    storageHealthy: true,
    checkpoint: undefined,
    armed: undefined,
    armTimer: undefined,
    releaseCheckpoint: undefined,
  };
  return {
    settings,
    options,
    fields,
    sites,
    recipes,
    uris,
    generation,
    badge,
    spinning,
    report,
    reportAttempt,
    documents,
    attempts,
    effects,
    passwordFills,
    signInUrls,
    passkeyRequests,
    passkeyAnswers,
    passkeyPages,
    siteMoves,
    moveJudgements,
    parkedRequests,
    choicePasskeys,
    continuations,
    persisted,
    replacedTabs,
    picked,
    pending,
    logouts,
    noted,
    stoppedAsks,
    rejectedAsks,
    logoutFills,
    entryPresses,
    pressing,
    entryChecks,
    entryTimers,
    entryRefused,
    unsavedBlocks,
    savingChoices,
    quietly,
    send,
    publish,
    ...variables,
  };
}

export type RuntimeState = ReturnType<typeof createRuntimeState>;
