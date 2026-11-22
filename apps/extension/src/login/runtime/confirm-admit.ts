import { browser } from "wxt/browser";
import { frameKey } from "./steps";
import { publish } from "./attempt";
import {
  confirmRecipeOn,
  offersGeneration,
  generationSlotsFor,
  startsFor,
} from "./generation-scope";
import { generateFor } from "./generation";
import { pageOff } from "./sign-in-fill";
import { pagePermission } from "./page-permission";
import { confirmPage } from "./markers";
import {
  cancelConfirm,
  claimConfirm,
  confirmationGenerationKey,
  hasConfirmClaim,
  confirmBusy,
  hasConfirmAuthentication,
  pressGenerationKey,
  releaseConfirmClaim,
  releasePressHolds,
  sourceOf,
  type ConfirmWork,
} from "./confirm-state";
import { confirmAccount, confirmCurrent } from "./confirm-scope";
import { confirmationSteps, fillConfirmation, type ConfirmFillEnd } from "./confirm-fill";
import {
  confirmEnded,
  confirmEndedBy,
  noteConfirmFill,
  noteConfirmSkipped,
  noteConfirmWaiting,
  settleConfirmFill,
} from "./not-started";
import { manualPending } from "./manual-scope";
import { shownConfirmAccount } from "./confirm-shown";
import { confirmPickFor, endConfirmPick, type ConfirmPick } from "./confirm-pick-scope";
import { explicitlyPicked } from "./page-permission";
import { recordFor, tabAttempt } from "./hold";
import { terminal } from "./attempt-state";
import type { LoginAttemptMetadata, LoginRecipe } from "@pateat/contracts";
import type { Runtime } from "./state";
import type { AdmitContext } from "./admit-context";
import type { GenerationOutcome } from "./report";
import type { ConfirmVisit, LiveDocument, Readiness } from "./types";

const OUTCOMES = {
  filled: "confirm-filled",
  kept: "confirm-fill-kept",
  stopped: "confirm-fill-stopped",
} as const;

/**
 * As the authenticated record's own `logged-in` answer, the page keeps watching the
 * origin's first steps, so a sign-in form showing in place is still read as a logout
 * (ADR 0062), and a verification page reports its first step shown for the log.
 */
async function answer(
  rt: Runtime,
  ctx: AdmitContext,
  reason: string,
  visit?: ConfirmVisit | false,
): Promise<Readiness> {
  const starts = await startsFor(rt, ctx.document.origin);
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  return { ok: false, reason, starts, ...(visit ? { confirm: visit.first } : {}) };
}

/**
 * Whether the authenticated record's `logged-in` answer offers the page for
 * classification (ADR 0035 delivery 3): the content script announces a sign-in input or a
 * secret answer only after an answer with `generate`, and that announcement is what
 * `admitConfirm` classifies once per document and path. A page with a recipe on its path,
 * a paused site, a pending manual login and a page the service would not take now are not
 * offered.
 */
export async function offersConfirmGeneration(
  rt: Runtime,
  ctx: AdmitContext,
  recorded: LoginAttemptMetadata,
): Promise<boolean> {
  if (ctx.paused) return false;
  // The proofs and claims come from the session store.
  await rt.confirmFill.loaded;
  if (!hasConfirmAuthentication(rt, recorded) || manualPending(rt, ctx.live)) return false;
  // A page whose classification on this path already ran never gets here: `admitConfirm`
  // answers it `logged-in` first, by its claim, whatever came of it.
  if ((await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path)) !== undefined) return false;
  return (await offersGeneration(rt, ctx.live)) === true;
}

/**
 * Whether no SSO offer may act on this announcement, since only the offer of
 * {@link offersConfirmGeneration} brings it: the confirmed login of the tab's origin, no
 * recipe on the path, and a sign-in input or secret answer, which `admitConfirm`
 * classifies, or a list of accounts, which the login's record answers `logged-in`.
 * Classifying a page in that tab never starts another login (delivery 3).
 */
export async function confirmClassifies(rt: Runtime, ctx: AdmitContext): Promise<boolean> {
  if (ctx.manual || ctx.start || ctx.entryHello) return false;
  if (
    ctx.signIn?.path !== ctx.live.path &&
    !ctx.list &&
    !(ctx.unoffered?.path === ctx.live.path && ctx.unoffered.why === "text-answer")
  )
    return false;
  const recorded = recordFor(rt, ctx.document.tabId, ctx.document.origin);
  if (!recorded) return false;
  await rt.confirmFill.loaded;
  if (!hasConfirmAuthentication(rt, recorded)) return false;
  return (await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path)) === undefined;
}

/** Runs before the authenticated-record return, preserving that login and its account. */
export async function admitConfirm(rt: Runtime, ctx: AdmitContext): Promise<Readiness | undefined> {
  await rt.confirmFill.loaded;
  // The person's own **Fill** press for this document comes first (amended 2026-11-17).
  const pick = confirmPickFor(rt, ctx.live);
  if (pick) {
    const picked = await admitConfirmPick(rt, ctx, pick);
    if (picked) return picked;
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  }
  const held = await pressHold(rt, ctx);
  if (held) return held;
  const parent = ctx.recorded;
  if (!parent || !hasConfirmAuthentication(rt, parent) || manualPending(rt, ctx.live)) return;
  const recipe = await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  const generationKey = confirmationGenerationKey(parent.id, ctx.live);
  // Classification is not a new login or logout signal. In particular, a generated
  // sign-in result must not release this authenticated record on its reconnect.
  if (!recipe && hasConfirmClaim(rt, generationKey)) {
    ctx.notStarted("logged-in");
    return answer(rt, ctx, "logged-in");
  }
  const candidate =
    (ctx.signIn?.path === ctx.live.path && !ctx.signIn.passkey) ||
    (ctx.unoffered?.path === ctx.live.path && ctx.unoffered.why === "text-answer");
  // Nothing to fill or classify: the record's own answer follows, without a settings read.
  if (!recipe && !candidate) return;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (!snapshot.ok) return ctx.refuse("settings-unavailable");
  const permission = pagePermission(snapshot.snapshot.settings, ctx.live.url, "confirm");
  if (recipe && permission.permission !== "fill")
    return pageOff(rt, ctx.live, recipe, permission.source, ctx.shown?.amount);
  if (ctx.paused) {
    if (recipe) noteConfirmSkipped(rt, ctx.live, recipe, "paused");
    return;
  }
  const visit = recipe && confirmPage(rt, ctx.live, recipe);
  if (
    confirmBusy(rt, ctx.document.tabId) &&
    rt.confirmFill.work.get(ctx.document.tabId)?.live !== ctx.live
  )
    cancelConfirm(rt, ctx.document.tabId);
  if (confirmBusy(rt, ctx.document.tabId)) return answer(rt, ctx, "confirm-fill", visit);
  // The document's fill on this path already went into the page, or the person closed its
  // master password window: it is never started again while the document stays here.
  const ended = visit && confirmEnded(rt, ctx.live);
  if (visit && ended) {
    noteConfirmFill(rt, ctx.live, ctx.shown, visit);
    ctx.live.state = "watching";
    ctx.live.reason = ended;
    await publish(rt, ctx.live);
    return answer(rt, ctx, "confirm-fill", visit);
  }
  const offered = !recipe && candidate && (await offersGeneration(rt, ctx.live)) === true;
  if (!recipe && !offered) return;
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (visit) noteConfirmFill(rt, ctx.live, ctx.shown, visit);
  runConfirmWork(
    rt,
    ctx,
    { live: ctx.live, id: parent.id, account: parent.account, parent },
    recipe,
    generationKey,
  );
  return answer(rt, ctx, recipe ? "confirm-fill" : "generating", visit);
}

/**
 * What was found of the account a document shows on a path, once per document, path and
 * recipe: being read, nothing, or the one account, kept until the document's next
 * announcement takes it. The latest `SHOWN_LOOKS_MAX` are kept.
 */
type ShownLook =
  | "looking"
  | "none"
  | { account: { origin: string; connectionId: string; itemId: string } };
const SHOWN_LOOKS_MAX = 256;
const shownLooks = new WeakMap<Runtime, Map<string, ShownLook>>();
function rememberLook(rt: Runtime, key: string, look: ShownLook | undefined): void {
  const looks = shownLooks.get(rt) ?? new Map<string, ShownLook>();
  shownLooks.set(rt, looks);
  looks.delete(key);
  if (look === undefined) return;
  looks.set(key, look);
  for (const oldest of looks.keys()) {
    if (looks.size <= SHOWN_LOOKS_MAX) break;
    looks.delete(oldest);
  }
}

/**
 * A verification page in a tab without Pateat's login (ADR 0035, amended 2026-11-22):
 * when the page shows the username of exactly one of its matching accounts, that account
 * fills the page's recipe once, as a login's confirmation fill does, pressing nothing and
 * never asking for the master password. The account is read once per document, path and
 * recipe, in the background after the page first announces there, so its answer is not
 * delayed; once found, the document is asked to announce again, and that announcement
 * starts the fill. A paused site, a running login, account switch or **Fill** press, and
 * a fill that ended there leave the page to the popup's **Fill**. Undefined when it does
 * not fill; the caller's answer follows.
 */
export async function admitConfirmShown(
  rt: Runtime,
  ctx: AdmitContext,
  recipe: LoginRecipe,
  visit: ConfirmVisit,
): Promise<Readiness | undefined> {
  const { tabId, frameId, documentId } = ctx.document;
  const { path } = ctx.live;
  await rt.confirmFill.loaded;
  const work = rt.confirmFill.work.get(tabId);
  // This document's own fill is still at work: its announcement is answered as such.
  if (work?.shown && work.live.document.documentId === documentId && work.live.path === path)
    return answer(rt, ctx, "confirm-fill", visit);
  // Its fill ended on this path: the page's rows and status say so, as for a login's.
  const endedBy = confirmEndedBy(rt, ctx.live);
  const ended = confirmEnded(rt, ctx.live);
  if (endedBy === "shown" && ended) {
    noteConfirmFill(rt, ctx.live, ctx.shown, visit, "shown");
    ctx.live.state = "watching";
    ctx.live.reason = ended;
    await publish(rt, ctx.live);
    return answer(rt, ctx, "confirm-fill", visit);
  }
  const running = tabAttempt(rt, tabId);
  const held = () =>
    ctx.paused ||
    ctx.manual ||
    confirmBusy(rt, tabId) ||
    (running !== undefined && !terminal(running)) ||
    recordFor(rt, tabId, ctx.document.origin) !== undefined ||
    rt.manualStarts.get(tabId)?.pick !== undefined ||
    confirmPickFor(rt, ctx.live) !== undefined ||
    manualPending(rt, ctx.live) ||
    rt.switchesRunning.has(tabId) ||
    endedBy !== undefined;
  // Nothing on this path for a fill to do: no account is read for it.
  if (held() || !confirmationSteps(recipe, path).length) return undefined;
  const key = JSON.stringify([tabId, documentId, path, recipe.id]);
  const look = shownLooks.get(rt)?.get(key);
  if (typeof look === "object") {
    rememberLook(rt, key, "none");
    noteConfirmFill(rt, ctx.live, ctx.shown, visit, "shown");
    runConfirmWork(
      rt,
      ctx,
      { live: ctx.live, id: "shown", account: look.account, shown: true },
      recipe,
      confirmationGenerationKey("shown", ctx.live),
    );
    return answer(rt, ctx, "confirm-fill", visit);
  }
  if (look !== undefined) return undefined;
  rememberLook(rt, key, "looking");
  // The document's latest announcement on this path, whichever object holds it.
  const here = () => {
    const page = rt.documents.get(ctx.key);
    return page?.document.documentId === documentId && page.path === path ? page : undefined;
  };
  void (async () => {
    const account = await shownConfirmAccount(rt, ctx.live, here);
    // A document that left the path is read again should it come back.
    if (!here()) return rememberLook(rt, key, undefined);
    if (!account) return rememberLook(rt, key, "none");
    rememberLook(rt, key, { account });
    await browser.tabs
      .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId, documentId })
      .catch(() => rememberLook(rt, key, undefined));
    return undefined;
  })().catch(() => rememberLook(rt, key, undefined));
  return undefined;
}

/**
 * A page a **Fill** press sent for generation that did not come back as a verification
 * starts no login while its document stays on that path, also with a returned sign-in
 * recipe and across a worker restart (the press's generation claim holds it), so a press
 * never leads to a login that presses buttons. The page only watches. The person's own
 * **Log in now** or account pick for the document still logs in. Runs before SSO
 * admission, so no SSO entry is pressed there either.
 */
export async function pressHold(rt: Runtime, ctx: AdmitContext): Promise<Readiness | undefined> {
  await rt.confirmFill.loaded;
  releasePressHolds(rt, ctx.live);
  if (!hasConfirmClaim(rt, pressGenerationKey(ctx.live))) return undefined;
  if (ctx.manual || manualPending(rt, ctx.live) || explicitlyPicked(rt, ctx.document))
    return undefined;
  // While the press's own generation runs, its document's announcements are answered
  // before admission (`rt.confirmFill.work`), so they never reach this.
  const confirm = await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  // A verification came back: the press, or the tab's own login, fills it as usual.
  if (confirm) return undefined;
  const pick = confirmPickFor(rt, ctx.live);
  if (pick) endConfirmPick(pick, "blocked", "not-a-verification-page");
  if (ctx.live.state !== "watching" || ctx.live.reason !== undefined) {
    ctx.live.state = "watching";
    delete ctx.live.reason;
    await publish(rt, ctx.live);
  }
  return { ok: false, reason: "not-a-verification-page" };
}

/**
 * The person's **Fill** press for this document (ADR 0035, amended 2026-11-17): the
 * account they chose fills the page's recipe once, pressing nothing, or a page without one
 * that asks for a secret answer is sent once for generation. Nothing asks the AI to
 * classify a page that has a recipe. A refusal ends the press and leaves the page to its
 * ordinary admission.
 */
async function admitConfirmPick(
  rt: Runtime,
  ctx: AdmitContext,
  pick: ConfirmPick,
): Promise<Readiness | undefined> {
  const { tabId } = ctx.document;
  const refuse = (reason: string) => {
    endConfirmPick(pick, "blocked", reason);
    return undefined;
  };
  const recipe = await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (confirmPickFor(rt, ctx.live) !== pick) return undefined;
  const generationKey = pressGenerationKey(ctx.live);
  // Sent once already and answered: a page that came back as anything but a verification
  // is not one. A generation that got no answer left no claim (`releaseConfirmClaim`).
  if (!recipe && (pick.generated || hasConfirmClaim(rt, generationKey)))
    return refuse("not-a-verification-page");
  if (!recipe && !ctx.live.textAnswer) return refuse("no-recipe-on-path");
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (!snapshot.ok) return refuse("settings-unavailable");
  if (pagePermission(snapshot.snapshot.settings, ctx.live.url, "confirm").permission !== "fill")
    return refuse("page-off");
  const running = tabAttempt(rt, tabId);
  if (
    confirmBusy(rt, tabId) ||
    (running && !terminal(running)) ||
    rt.manualStarts.get(tabId)?.pick !== undefined
  )
    return refuse("login-running");
  if (!recipe) {
    const offer = await offersGeneration(rt, ctx.live);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (offer !== true) return refuse(offer ?? "not-sent");
    if (confirmPickFor(rt, ctx.live) !== pick || confirmBusy(rt, tabId))
      return refuse("login-running");
    pick.generated = true;
  }
  const visit = recipe && confirmPage(rt, ctx.live, recipe);
  if (visit) noteConfirmFill(rt, ctx.live, ctx.shown, visit, "pick");
  pick.status = { requestId: pick.status.requestId, state: recipe ? "preparing" : "generating" };
  pick.taken = true;
  runConfirmWork(
    rt,
    ctx,
    { live: ctx.live, id: pick.id, account: pick.account, pick },
    recipe,
    generationKey,
    (end) => {
      if (end === "filled" || end === "kept") endConfirmPick(pick, end);
      else if (end === "asked") {
        if (pick.active) pick.status = { requestId: pick.status.requestId, state: "asked" };
      } else if (end !== "reconnected")
        endConfirmPick(pick, "blocked", recipe ? "confirm-fill-stopped" : unsent(ctx.live, end));
    },
  );
  return answer(rt, ctx, recipe ? "confirm-fill" : "generating", visit);
}

/**
 * Why a press's page got no recipe: the service judged it no login page of any kind
 * (`abstained`), so it is no verification page either, or the service's own reason, or
 * why the page was not sent.
 */
function unsent(live: LiveDocument, end: ConfirmEnd): string {
  if (typeof end === "object")
    return end.outcome === "abstained" ? "not-a-verification-page" : end.reason;
  return live.generationSkip ?? "not-sent";
}

/** How the tab's confirmation work ended, or the service's answer that brought no recipe. */
type ConfirmEnd =
  | ConfirmFillEnd
  | "reconnected"
  | Exclude<GenerationOutcome, { outcome: "recipe" }>;

/**
 * Starts the tab's confirmation work in the background: it fills with `recipe`, or, with
 * none, sends the page for generation once under `generationKey` and has the document
 * announce again with what came back. `done` hears how it ended: `reconnected` once a
 * generated recipe is announced to the page, or the service's answer without a recipe.
 * A press's generation the service did not answer with a recipe or an abstention drops
 * its claim, so the person may press again.
 */
function runConfirmWork(
  rt: Runtime,
  ctx: AdmitContext,
  authority: Pick<ConfirmWork, "live" | "id" | "account" | "parent" | "pick" | "shown">,
  recipe: LoginRecipe | undefined,
  generationKey: string,
  done?: (end: ConfirmEnd) => void,
): void {
  const work: ConfirmWork = {
    ...authority,
    cancelled: false,
    generation: !recipe,
    topDocumentId: rt.documents.get(frameKey({ tabId: ctx.document.tabId, frameId: 0 }))?.document
      .documentId,
  };
  rt.confirmFill.work.set(ctx.document.tabId, work);
  let reconnected = false;
  let answered: GenerationOutcome | undefined;
  const finish = () => {
    if (rt.confirmFill.work.get(ctx.document.tabId) === work)
      rt.confirmFill.work.delete(ctx.document.tabId);
  };
  void (async () => {
    let end: ConfirmFillEnd = "stopped";
    try {
      const account = await confirmAccount(rt, work);
      if (!account) {
        work.stoppedAt = "account";
        return;
      }
      work.policyRevision = account.snapshot.snapshot.revision;
      if (account.connection.snapshotId !== undefined)
        work.snapshotId = account.connection.snapshotId;
      if (account.scope !== undefined) work.scopeMark = account.scope;
      if (recipe) end = await fillConfirmation(rt, work, recipe);
      else {
        if (!(await claimConfirm(rt, work, generationKey)) || !confirmCurrent(rt, work)) return;
        const scope = await generationSlotsFor(rt, ctx.live, undefined, false, work.account);
        if (!scope || !confirmCurrent(rt, work) || !(await confirmAccount(rt, work))) return;
        ctx.live.state = "generating";
        await publish(rt, ctx.live);
        await generateFor(rt, ctx.live, scope, undefined, undefined, false, undefined, {
          current: async () => Boolean(await confirmAccount(rt, work)),
          // A press's result reaches only the pressed document, never another tab's page.
          only: work.pick !== undefined,
          // Only the tab's own authenticated login vouches for the session; a **Fill**
          // press keeps the header's hint (ADR 0035, amended 2026-11-21).
          ...(work.pick === undefined ? { signedIn: true as const } : {}),
          reconnect: () => {
            reconnected = true;
            finish();
          },
          answered: (outcome) => {
            answered = outcome;
          },
        });
      }
    } catch (error) {
      work.stoppedAt = "error";
      throw error;
    } finally {
      finish();
      // A recipe that came back holds the page even when it reached it no more.
      const unanswered =
        !recipe &&
        (answered === undefined ||
          (answered.outcome !== "recipe" && answered.outcome !== "abstained"));
      if (work.pick && unanswered) await releaseConfirmClaim(rt, generationKey);
      done?.(
        recipe
          ? end
          : reconnected
            ? "reconnected"
            : answered && answered.outcome !== "recipe"
              ? answered
              : "stopped",
      );
      // The document's latest announcement, which may have replaced this one meanwhile. A
      // newer fill of the same document, which cancelled this one, settles for itself.
      const page = rt.documents.get(ctx.key);
      const newer = rt.confirmFill.work.get(ctx.document.tabId);
      const superseded =
        newer !== undefined && newer.live.document.documentId === ctx.document.documentId;
      if (recipe && !superseded && page?.document.documentId === ctx.document.documentId) {
        if (end === "asked" || end === "claimed") {
          noteConfirmWaiting(rt, page, ctx.live.path, end, sourceOf(work));
          if (page === ctx.live) await publish(rt, ctx.live);
        } else
          await settleConfirmFill(
            rt,
            page,
            ctx.live.path,
            OUTCOMES[end],
            false,
            sourceOf(work),
            end === "stopped" ? work.stoppedAt : undefined,
          );
      }
    }
  })().catch(() => undefined);
}
