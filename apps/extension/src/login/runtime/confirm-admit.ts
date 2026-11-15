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
import { confirmOutcome, noteConfirmFill, settleConfirmFill } from "./not-started";
import { manualPending } from "./manual-scope";
import type { Runtime } from "./state";
import type { AdmitContext } from "./admit-context";
import type { ConfirmVisit, Readiness } from "./types";

const OUTCOMES = {
  filled: "confirm-filled",
  kept: "confirm-fill-kept",
  stopped: "confirm-fill-stopped",
} as const;

/** Runs before the authenticated-record return, preserving that login and its account. */
export async function admitConfirm(rt: Runtime, ctx: AdmitContext): Promise<Readiness | undefined> {
  await rt.confirmFill.loaded;
  const parent = ctx.recorded;
  if (!parent || !hasConfirmAuthentication(rt, parent) || manualPending(rt, ctx.live)) return;
  const recipe = await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  // As the authenticated record's own `logged-in` answer, the page keeps watching the
  // origin's first steps, so a sign-in form showing in place is still read as a logout
  // (ADR 0062), and a verification page reports its first step shown for the log.
  const answer = async (reason: string, visit?: ConfirmVisit | false): Promise<Readiness> => {
    const starts = await startsFor(rt, ctx.document.origin);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    return { ok: false, reason, starts, ...(visit ? { confirm: visit.first } : {}) };
  };
  const generationKey = confirmationGenerationKey(parent, ctx.live);
  // Classification is not a new login or logout signal. In particular, a generated
  // sign-in result must not release this authenticated record on its reconnect.
  if (!recipe && hasConfirmClaim(rt, generationKey)) {
    ctx.notStarted("logged-in");
    return answer("logged-in");
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
  if (confirmBusy(rt, ctx.document.tabId)) return answer("confirm-fill", visit);
  // The document's fill on this path already went into the page: it is never repeated.
  const ended = visit && confirmOutcome(rt, ctx.live);
  if (visit && (ended === "confirm-filled" || ended === "confirm-fill-kept")) {
    noteConfirmFill(rt, ctx.live, ctx.shown, visit);
    ctx.live.state = "watching";
    ctx.live.reason = ended;
    await publish(rt, ctx.live);
    return answer("confirm-fill", visit);
  }
  const offered = !recipe && candidate && (await offersGeneration(rt, ctx.live)) === true;
  if (!recipe && !offered) return;
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (visit) noteConfirmFill(rt, ctx.live, ctx.shown, visit);
  const work: ConfirmWork = {
    live: ctx.live,
    parent,
    cancelled: false,
    generation: !recipe,
    topDocumentId: rt.documents.get(frameKey({ tabId: ctx.document.tabId, frameId: 0 }))?.document
      .documentId,
  };
  rt.confirmFill.work.set(ctx.document.tabId, work);
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
        const scope = await generationSlotsFor(rt, ctx.live, undefined, false, parent.account);
        if (!scope || !confirmCurrent(rt, work) || !(await confirmAccount(rt, work))) return;
        ctx.live.state = "generating";
        await publish(rt, ctx.live);
        await generateFor(rt, ctx.live, scope, undefined, undefined, false, undefined, {
          current: async () => Boolean(await confirmAccount(rt, work)),
          reconnect: finish,
        });
      }
    } finally {
      finish();
      // The document's latest announcement, which may have replaced this one meanwhile.
      const page = rt.documents.get(ctx.key);
      if (recipe && page?.document.documentId === ctx.document.documentId) {
        if (end === "asked" || end === "claimed") {
          if (page === ctx.live) await publish(rt, ctx.live);
        } else await settleConfirmFill(rt, page, ctx.live.path, OUTCOMES[end]);
      }
    }
  })().catch(() => undefined);
  return answer(recipe ? "confirm-fill" : "generating", visit);
}
