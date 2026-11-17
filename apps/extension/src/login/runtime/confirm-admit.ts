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
  type ConfirmWork,
} from "./confirm-state";
import { confirmAccount, confirmCurrent } from "./confirm-scope";
import { fillConfirmation, type ConfirmFillEnd } from "./confirm-fill";
import { confirmEnded, noteConfirmFill, settleConfirmFill } from "./not-started";
import { manualPending } from "./manual-scope";
import {
  confirmPickFor,
  endConfirmPick,
  holdPressed,
  pressHeld,
  type ConfirmPick,
} from "./confirm-pick-scope";
import { tabAttempt } from "./hold";
import { terminal } from "./attempt-state";
import type { LoginRecipe } from "@pateat/contracts";
import type { Runtime } from "./state";
import type { AdmitContext } from "./admit-context";
import type { ConfirmVisit, Readiness } from "./types";

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
  // A page a press sent for generation that did not come back as a verification starts no
  // login while its document stays on that path, also with a sign-in recipe.
  if (pressHeld(rt, ctx.live)) {
    const confirm = await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (!confirm) return ctx.refuse("not-a-verification-page");
  }
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
  if (ctx.paused) return;
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
  // The press's own work is still running, as while its page is sent: it goes on.
  if (rt.confirmFill.work.get(tabId)?.pick === pick)
    return answer(rt, ctx, recipe ? "confirm-fill" : "generating");
  const generationKey = confirmationGenerationKey(pick.id, ctx.live);
  // Sent once already: a page that came back as anything but a verification is not one.
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
    holdPressed(rt, ctx.live);
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
        endConfirmPick(
          pick,
          "blocked",
          recipe ? "confirm-fill-stopped" : (ctx.live.generationSkip ?? "not-sent"),
        );
    },
  );
  return answer(rt, ctx, recipe ? "confirm-fill" : "generating", visit);
}

/**
 * Starts the tab's confirmation work in the background: it fills with `recipe`, or, with
 * none, sends the page for generation once under `generationKey` and has the document
 * announce again with what came back. `done` hears how it ended: `reconnected` once a
 * generated recipe is announced to the page.
 */
function runConfirmWork(
  rt: Runtime,
  ctx: AdmitContext,
  authority: Pick<ConfirmWork, "live" | "id" | "account" | "parent" | "pick">,
  recipe: LoginRecipe | undefined,
  generationKey: string,
  done?: (end: ConfirmFillEnd | "reconnected") => void,
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
  const finish = () => {
    if (rt.confirmFill.work.get(ctx.document.tabId) === work)
      rt.confirmFill.work.delete(ctx.document.tabId);
  };
  void (async () => {
    let end: ConfirmFillEnd = "stopped";
    try {
      const account = await confirmAccount(rt, work);
      if (!account) return;
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
          reconnect: () => {
            reconnected = true;
            finish();
          },
        });
      }
    } finally {
      finish();
      done?.(recipe ? end : reconnected ? "reconnected" : "stopped");
      // The document's latest announcement, which may have replaced this one meanwhile.
      const page = rt.documents.get(ctx.key);
      if (recipe && page?.document.documentId === ctx.document.documentId) {
        if (end === "asked" || end === "claimed") {
          if (page === ctx.live) await publish(rt, ctx.live);
        } else
          await settleConfirmFill(
            rt,
            page,
            ctx.live.path,
            OUTCOMES[end],
            false,
            work.pick ? "pick" : "login",
          );
      }
    }
  })().catch(() => undefined);
}
