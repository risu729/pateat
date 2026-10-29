import {
  recoverLoginAttempt,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
} from "@pateat/contracts";
import { quietly, keep, forget } from "./session-store";
import { recordKey, documentKey } from "./steps";
import { probeMode, WATCH_MS } from "./constants";
import { saveSession, reportAttempt } from "./attempt";
import { type Readiness } from "./types";
import { confirmPage } from "./markers";
import { recordFor } from "./hold";
import { nextRecordStep, type RecordPhase, type RecordSeen } from "./admit-record-policy";
import { addAskFill } from "./relogin";
import { confirmRecipeOn, startsFor } from "./generation-scope";
import type { Runtime } from "./state";
import { admitRecipe } from "./admit-recipe";
import type { AdmitContext } from "./admit-context";

export async function admitRecord(rt: Runtime, ctx: AdmitContext): Promise<Readiness> {
  // A document resumes only its own origin's record in the tab, even an ended one, also
  // one of a site the tab left, so a login never submits there again.
  ctx.recorded = recordFor(rt, ctx.document.tabId, ctx.document.origin);

  ctx.askKey = recordKey(ctx.document.tabId, ctx.document.origin);

  // Each decision sees the current context and picks after the preceding awaited effect.
  const recordStep = (phase: RecordPhase, seen: Omit<RecordSeen, "phase"> = {}, now = 0) =>
    nextRecordStep(
      ctx.recorded,
      {
        frameId: ctx.document.frameId,
        documentId: ctx.document.documentId,
        showsFirstStep: ctx.start?.path === ctx.live.path,
        hasTopUrl: Boolean(ctx.live.topUrl),
        paused: ctx.paused,
        probe: probeMode && ctx.document.origin === rt.vars.origin,
        pickedAttemptId: rt.picked.get(ctx.document.tabId)?.attemptId,
      },
      { phase, ...seen },
      now,
    );

  // A fill-only login is forgotten when it ends; one a stopped worker left ended is too.
  if (ctx.recorded && recordStep("fill-only").kind === "forget-fill-only") {
    try {
      await forget(rt, ctx.askKey);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    ctx.recorded = undefined;
  }

  /**
   * Releases a tab's finished login of this origin once its first step shows again (ADR
   * 0021 D, ADR 0062): the page then logs in as on any visit. After the site rejected that
   * login, the tab and the origin's other tabs ask for an account instead, and the page
   * that showed the rejection is never filled again. Returns a refusal when it could not,
   * else undefined.
   */
  const releaseFinished = async (
    released: LoginAttemptMetadata,
  ): Promise<Readiness | undefined> => {
    const { tabId } = released.document;
    const releasedKey = recordKey(tabId, ctx.document.origin);
    const rejected = released.outcome === "credential-rejected";
    if (rt.attempts.get(tabId)?.metadata.id === released.id) rt.attempts.delete(tabId);
    const unpicked = rt.picked.get(tabId)?.attemptId === released.id && rt.picked.delete(tabId);
    // The page that showed the rejection is never filled with an account again: the site
    // just refused what was filled there.
    const rejectedPage = documentKey(released.document);
    const asked = !rejected || rt.rejectedAsks.has(releasedKey);
    const unfilled = rejected && !rt.askFills.has(rejectedPage);
    // The tab must keep asking after a restart, so its ask is stored first.
    if (!asked || unfilled) {
      rt.rejectedAsks.add(releasedKey);
      if (unfilled) addAskFill(rt, rejectedPage);
      try {
        await saveSession(rt);
      } catch {
        if (!asked) rt.rejectedAsks.delete(releasedKey);
        if (unfilled) rt.askFills.delete(rejectedPage);
        return ctx.refuse("storage-unavailable");
      }
    } else if (unpicked) void quietly(rt, () => saveSession(rt));
    try {
      await forget(rt, releasedKey);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    // A page of that tab admitted meanwhile may have resumed the record; it stops too.
    if (rt.attempts.get(tabId)?.metadata.id === released.id) rt.attempts.delete(tabId);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    return undefined;
  };

  /**
   * Ends a watched login, which never signed in, once the recipe's first step shows again,
   * as after a code or an approval expired (ADR 0027). Only the watched login's tab asks
   * and fills, as after a stopped login (owner, 2026-10-13). Only its own tab's page ends
   * it: until the watch ends, the site's other tabs that share its cookies wait (owner,
   * 2026-10-23). Returns a refusal when it could not, else undefined.
   */
  const abandonWatch = async (
    watchedLogin: LoginAttemptMetadata,
  ): Promise<Readiness | undefined> => {
    const { tabId } = watchedLogin.document;
    const watchedKey = recordKey(tabId, ctx.document.origin);
    const run = rt.attempts.get(tabId);
    const own = run?.metadata.id === watchedLogin.id ? run : undefined;
    if (own) rt.attempts.delete(tabId);
    if (rt.picked.get(tabId)?.attemptId === watchedLogin.id) rt.picked.delete(tabId);
    // The tab must keep asking after a restart, so its ask is stored first.
    rt.stoppedAsks.add(watchedKey);
    try {
      await saveSession(rt);
    } catch {
      rt.stoppedAsks.delete(watchedKey);
      return ctx.refuse("storage-unavailable");
    }
    reportAttempt(
      rt,
      transitionLoginAttempt(own?.metadata ?? watchedLogin, {
        type: "WATCH_ENDED",
        abandoned: true,
      }),
      own?.recipe,
    );
    try {
      await forget(rt, watchedKey);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    // A page of that tab admitted meanwhile may have resumed the record; it stops too.
    if (rt.attempts.get(tabId)?.metadata.id === watchedLogin.id) rt.attempts.delete(tabId);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    return undefined;
  };

  // A watch that ran out ends the login where it stopped (ADR 0027). Its record keeps its
  // time, so it does not hold the site again.
  // The page a watch that ran out began in; another page that shows the first step then
  // asks as after a stopped login (below).
  let watchEnded: string | undefined;

  if (ctx.recorded && recordStep("watch", {}, Date.now()).kind === "end-watch") {
    watchEnded = ctx.recorded.watch?.documentId;
    const run = rt.attempts.get(ctx.document.tabId);
    const own = run?.metadata.id === ctx.recorded.id ? run : undefined;
    // It ended when the watch ran out, which may be long before this page showed; the
    // time between counts for nothing (ADR 0019).
    const endedAt = Math.min(Date.now(), (ctx.recorded.watch?.since ?? 0) + WATCH_MS);
    const ended = transitionLoginAttempt(
      own?.metadata ?? ctx.recorded,
      { type: "WATCH_ENDED" },
      endedAt,
    );
    if (own) own.metadata = ended;
    reportAttempt(rt, ended, own?.recipe, undefined, { endedAt });
    try {
      await keep(rt, ended, false);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    ctx.recorded = ended;
  }

  // While a login is watched, its recipe's first step showing in a new page of the tab
  // means the person is back at the start, as when a code or an approval expired: the
  // login never signed in. It ends, and only this tab asks and fills without pressing
  // anything (ADR 0027). The page the watch began in never ends it.
  if (ctx.recorded && recordStep("abandon-watch").kind === "abandon-watch") {
    const refused = await abandonWatch(ctx.recorded);
    if (refused) return refused;
    ctx.recorded = undefined;
  }

  // A paused site's automatic login that has not ended stops on its next page before any
  // step, as when its pause started (ADR 0062); one a popup pick started goes on.
  if (ctx.recorded && recordStep("pause").kind === "stop-paused") {
    const run = rt.attempts.get(ctx.document.tabId);
    const own = run?.metadata.id === ctx.recorded.id ? run : undefined;
    const ended = transitionLoginAttempt(own?.metadata ?? recoverLoginAttempt(ctx.recorded), {
      type: "POLICY_CHANGED",
    });
    if (own) rt.attempts.delete(ctx.document.tabId);
    reportAttempt(rt, ended, own?.recipe, { cause: "paused" });
    try {
      await forget(rt, recordKey(ctx.document.tabId, ctx.recorded.account.origin));
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    ctx.recorded = undefined;
  }

  const finished = recordStep("finished");

  if (ctx.recorded && finished.kind === "read-confirm") {
    // Until the recipe's first step shows again, the page keeps watching for it. The page
    // a rejection was read in shows the sign-in form again with the failure, which may be
    // on another path, such as the one the form posted to: it asks at once.
    const rejectedHere = finished.rejectedHere;
    // A page generated as a verification while signed in is no logout either, even when
    // it announces a start from starts read before its recipe was generated again (ADR
    // 0035): the service keeps one recipe per path, so no sign-in recipe starts there.
    const confirm = finished.read
      ? await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path)
      : undefined;
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (
      recordStep(finished.next, { confirm: confirm !== undefined, rejectedHere }).kind ===
      "keep-watching"
    ) {
      const starts = await startsFor(rt, ctx.document.origin);
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      // Not a recipe's first step on its path, so the login stays (ADR 0021 D).
      const visit = confirm && confirmPage(rt, ctx.live, confirm);
      if (visit) ctx.notStarted("confirm-unsupported", visit);
      else ctx.notStarted("logged-in");
      return {
        ok: false,
        reason: "logged-in",
        starts,
        ...(visit ? { confirm: visit.first } : {}),
      };
    }
    // It shows again after a finished login, as after a logout. Only this tab's record
    // for this origin is released, and the page logs in again (ADR 0062).
    const refused = await releaseFinished(ctx.recorded);
    if (refused) return refused;
    ctx.recorded = undefined;
  }

  if (ctx.recorded && recordStep("stopped").kind === "release-stopped") {
    // A login Pateat itself stopped before submitting anything holds no tab, its own
    // included: a new page of the tab logs in as a new tab would, with the saved default
    // or by asking when several accounts match (ADR 0022). One that submitted is resumed,
    // so a site that sends the tab back to its first step never gets it again; only its
    // form showing on a later page makes the tab ask and fill (below).
    const released = ctx.recorded;
    if (rt.attempts.get(ctx.document.tabId)?.metadata.id === released.id)
      rt.attempts.delete(ctx.document.tabId);
    if (rt.picked.get(ctx.document.tabId)?.attemptId === released.id) {
      rt.picked.delete(ctx.document.tabId);
      void quietly(rt, () => saveSession(rt));
    }
    try {
      await forget(rt, ctx.askKey);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    ctx.recorded = undefined;
  }

  const submitted = recordStep("submitted", { watchEnded }, Date.now());

  if (ctx.recorded && submitted.kind === "read-confirm") {
    // A login that stopped after it submitted is resumed by the tab's later pages, so it
    // never submits again. Its form showing again on one of them asks for an account, in
    // this tab only, and fills without pressing anything (ADR 0021 D, owner's choice
    // 2026-10-12); until then the page watches for it.
    const confirm = submitted.read
      ? await confirmRecipeOn(rt, ctx.document.origin, ctx.live.path)
      : undefined;
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    const withdrawal = recordStep(submitted.next, { confirm: confirm !== undefined });
    // Nor does its recipe's first step show again once the recipe was withdrawn, as one
    // revoked on the dashboard: the tab is released as after it, so its pages may be sent
    // for generation again. A recipe that only dropped the login's layout still starts.
    const withdrawn =
      withdrawal.kind === "read-withdrawn" &&
      withdrawal.read &&
      (await rt.recipes.withdrawn?.(ctx.document.origin, ctx.recorded.recipeId).catch(() => false));
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (
      recordStep("submitted-withdrawn", {
        confirm: confirm !== undefined,
        withdrawn: withdrawn === true,
      }).kind === "keep-watching"
    ) {
      const starts = await startsFor(rt, ctx.document.origin);
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      const visit = confirm && confirmPage(rt, ctx.live, confirm);
      if (visit) ctx.notStarted("confirm-unsupported", visit);
      else ctx.notStarted("stopped-login");
      return {
        ok: false,
        reason: "login-stopped",
        starts,
        ...(visit ? { confirm: visit.first } : {}),
      };
    }
    const released = ctx.recorded;
    if (rt.attempts.get(ctx.document.tabId)?.metadata.id === released.id)
      rt.attempts.delete(ctx.document.tabId);
    if (rt.picked.get(ctx.document.tabId)?.attemptId === released.id)
      rt.picked.delete(ctx.document.tabId);
    rt.stoppedAsks.add(ctx.askKey);
    try {
      await saveSession(rt);
    } catch {
      rt.stoppedAsks.delete(ctx.askKey);
      return ctx.refuse("storage-unavailable");
    }
    try {
      await forget(rt, ctx.askKey);
    } catch {
      return ctx.refuse("storage-unavailable");
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    ctx.recorded = undefined;
  }

  return admitRecipe(rt, ctx);
}
