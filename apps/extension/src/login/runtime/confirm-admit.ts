import { resolvePagePermission } from "@pateat/contracts";
import { frameKey } from "./steps";
import { publish } from "./attempt";
import { confirmRecipeOn, offersGeneration, generationSlotsFor } from "./generation-scope";
import { generateFor } from "./generation";
import { pageOff } from "./sign-in-fill";
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
import { fillConfirmation } from "./confirm-fill";
import { manualPending } from "./manual-scope";
import type { Runtime } from "./state";
import type { AdmitContext } from "./admit-context";
import type { Readiness } from "./types";

/** Runs before the authenticated-record return, preserving that login and its account. */
export async function admitConfirm(rt: Runtime, ctx: AdmitContext): Promise<Readiness | undefined> {
  await rt.confirmFill.loaded;
  const parent = ctx.recorded;
  if (!parent || !hasConfirmAuthentication(rt, parent) || manualPending(rt, ctx.live)) return;
  const recipe = await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path);
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  const generationKey = confirmationGenerationKey(parent, ctx.live);
  // Classification is not a new login or logout signal. In particular, a generated
  // sign-in result must not release this authenticated record on its reconnect.
  if (!recipe && hasConfirmClaim(rt, generationKey)) {
    ctx.notStarted("logged-in");
    return { ok: false, reason: "logged-in" };
  }
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (!snapshot.ok) return ctx.refuse("settings-unavailable");
  const permission = resolvePagePermission(snapshot.snapshot.settings, ctx.live.url, "confirm");
  if (recipe && permission?.permission !== "fill")
    return pageOff(rt, ctx.live, recipe, permission?.source ?? "default", ctx.shown?.amount);
  if (ctx.paused || !permission) return;
  const visit = recipe && confirmPage(rt, ctx.live, recipe);
  if (
    confirmBusy(rt, ctx.document.tabId) &&
    rt.confirmFill.work.get(ctx.document.tabId)?.live !== ctx.live
  )
    cancelConfirm(rt, ctx.document.tabId);
  if (confirmBusy(rt, ctx.document.tabId))
    return { ok: false, reason: "confirm-fill", ...(visit ? { confirm: visit.first } : {}) };
  const candidate =
    (ctx.signIn?.path === ctx.live.path && !ctx.signIn.passkey) ||
    (ctx.unoffered?.path === ctx.live.path && ctx.unoffered.why === "text-answer");
  const offered = !recipe && candidate && (await offersGeneration(rt, ctx.live)) === true;
  if (!recipe && !offered) return;
  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
  if (visit) ctx.notStarted("confirm-fill", visit);
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
    try {
      const account = await confirmAccount(rt, work);
      if (!account) {
        if (visit && rt.documents.get(ctx.key) === ctx.live)
          ctx.notStarted("confirm-fill-stopped", visit);
        return;
      }
      work.policyRevision = account.snapshot.snapshot.revision;
      if (account.connection.snapshotId !== undefined)
        work.snapshotId = account.connection.snapshotId;
      if (account.scope !== undefined) work.scopeMark = account.scope;
      if (recipe) await fillConfirmation(rt, work, recipe);
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
      if (recipe && rt.documents.get(ctx.key) === ctx.live) {
        if (ctx.live.reason === "confirm-fill-stopped" && visit)
          ctx.notStarted("confirm-fill-stopped", visit);
        await publish(rt, ctx.live);
      }
    }
  })().catch(() => undefined);
  return {
    ok: false,
    reason: recipe ? "confirm-fill" : "generating",
    ...(visit ? { confirm: visit.first } : {}),
  };
}
