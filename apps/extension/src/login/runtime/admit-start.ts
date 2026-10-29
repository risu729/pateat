import {
  attemptRouteChoice,
  createAttemptMetadata,
  isGeneratedRecipeId,
  passkeyAnswersRequest,
  recoverLoginAttempt,
  followPage,
  personAnswered,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  itemAsksForMasterPassword,
  chooserRoute,
  type ChooserClick,
  type LoginRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { type ListMissReport as ListMiss } from "../wire";
import { observedPath } from "../../observation/path";
import { newId } from "@pateat/contracts/ids";
import { quietly } from "./session-store";
import { frameKey, documentKey, codeAwaitsClick, autoSubmitted } from "./steps";
import { asksEveryTime } from "./entry-press";
import {
  probeMode,
  CHOICE_SAVED,
  REPROMPT_GRANT_MS,
  PASSKEY_SIGN_IN_MS,
  PASSKEY_SIGNED_IN,
} from "./constants";
import { pauseOf } from "./pause";
import { saveSession, reportAttempt, publish, report, startTiming, save } from "./attempt";
import { clearChoice, offerChoice } from "./choice";
import { type Readiness, type Execution } from "./types";
import { listClick } from "./markers";
import { note, recipeInUse, retryAfterSync, choicesSaved } from "./generation";
import { tabAttempt, recordFor, heldElsewhere, showHeld } from "./hold";
import { terminal, holdsSite } from "./attempt-state";
import { askMasterPassword, holdPassword } from "./master-password";
import { type PolicyChange } from "./report";
import { addAskFill, reloginLimited } from "./relogin";
import { noteChoice } from "./choice-save";
import { reviewRequests, parkedFor, restartForRequest, retryAfterPasskey } from "./passkey";
import { startsFor } from "./generation-scope";
import { repairUnfit, repairChooser } from "./repair-run";
import { planFor } from "./plan";
import { drive } from "./run-steps";
import type { Runtime } from "./state";
import type { AdmitStartContext } from "./admit-context";

export async function admitStart(rt: Runtime, ctx: AdmitStartContext): Promise<Readiness> {
  const savedBefore = rt.vars.remembered;

  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });

  if (!snapshot.ok) return ctx.refuse(snapshot.error.code);

  if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };

  // A close/navigation can happen while settings storage was awaited.
  try {
    const tab = await browser.tabs.get(ctx.document.tabId);
    if (
      !tab.url ||
      rt.documents.get(ctx.key) !== ctx.live ||
      (ctx.live.topUrl
        ? new URL(tab.url).origin !== new URL(ctx.live.topUrl).origin
        : new URL(tab.url).origin !== ctx.document.origin ||
          observedPath(new URL(tab.url).pathname) !== ctx.live.path)
    )
      return ctx.refuse("stale-document");
  } catch {
    return ctx.refuse("closed-tab");
  }

  // Two automatic logins of the site that ended `authenticated` within 10 minutes, in
  // any tab of this normal or incognito session, keep a third from starting: the tab asks
  // instead, so a site that logs out again at once is not logged in over and over. A pick
  // in the popup still logs in, and is not counted (ADR 0062).
  if (
    !ctx.ask &&
    !ctx.previous &&
    !ctx.switched &&
    reloginLimited(rt, ctx.document.origin, ctx.incognito === true)
  )
    ctx.ask = "relogin-limit";

  // A pick that did not make its account the default makes the site ask every time until
  // the browser closes or a default is saved for it (ADR 0063).
  const everyTime =
    !ctx.previous &&
    !ctx.switched &&
    (await asksEveryTime(rt, ctx.document.origin, ctx.incognito === true, snapshot));

  if (!ctx.ask && everyTime) ctx.ask = "one-time-pick";

  if (ctx.ask && heldElsewhere(rt, ctx.document.tabId, ctx.document.origin)) {
    showHeld(rt, ctx.document.tabId);
    return ctx.refuse("origin-busy");
  }

  const asking = ctx.ask === "relogin-limit" ? ctx.ask : ctx.ask ? "account-asked" : undefined;

  // A new login reads its item's facts once and chooses its route from them (ADR 0027);
  // a resumed one keeps those in its record, so a sync cannot change its route.
  // While the tab asks after a rejection, a stopped login or an abandoned watch, a
  // document is filled once on each path with the single account to use, without
  // pressing anything (ADR 0021 D); the passkey route has nothing to fill, and the relogin
  // limit fills nothing (ADR 0062). A single-page app that shows its next step in place,
  // as a password page after its email page, gets that step filled as a new document
  // would (ADR 0049). A page the site rejected a login on is never filled again, on any
  // path. A site that asks every time after a one-time pick fills nothing, also while
  // the tab asks for another reason (ADR 0063).
  const filledKey = `${documentKey(ctx.document)} ${ctx.live.path}`;

  const fill =
    asking === "account-asked" &&
    !everyTime &&
    !ctx.previous &&
    !ctx.switched &&
    !rt.askFills.has(documentKey(ctx.document)) &&
    !rt.askFills.has(filledKey);

  // A new login answers the page's own passkey request when its item holds a passkey
  // (ADR 0034), as one picked in the popup and one on a chooser's list do, instead of
  // clicking there; a login that only fills keeps its form.
  const pageRequest =
    !ctx.previous && ctx.document.frameId === 0 && parkedFor(rt, ctx.document) !== undefined;

  // A paused site starts no login by itself; a resumed one goes on (ADR 0062).
  const pausedStart = ctx.paused && !ctx.previous;

  const planOf = async (
    route: LoginRecipe,
    from: typeof ctx.later,
  ): Promise<Awaited<ReturnType<typeof planFor>> | undefined> => {
    let planned = await planFor(rt, snapshot, ctx.live, route, {
      ...(asking ? { asking } : {}),
      ...(fill ? { fill } : {}),
      ...(pausedStart ? { paused: true } : {}),
      ...(ctx.previous ? { route: attemptRouteChoice(ctx.previous) } : {}),
      ...(pageRequest ? { pageRequest } : {}),
      ...(from && !from.button ? { later: true } : {}),
    });
    if (rt.documents.get(ctx.key) !== ctx.live) return undefined;
    if (planned.ok && "fillOnly" in planned && planned.route.route !== "password") {
      planned = await planFor(rt, snapshot, ctx.live, route, {
        ...(asking ? { asking } : {}),
        ...(pausedStart ? { paused: true } : {}),
        ...(from && !from.button ? { later: true } : {}),
      });
      if (rt.documents.get(ctx.key) !== ctx.live) return undefined;
    }
    return planned;
  };

  let plan = await planOf(ctx.recipe, ctx.later);

  if (!plan) return { ok: false, reason: "stale-document" };

  // Another layout of the recipe, next in order, runs when the account's plan passes on
  // it and not on the first (ADR 0060); when none passes, the first one's refusal stands.
  /* eslint-disable no-await-in-loop */
  for (const choice of ctx.layoutChoices.slice(1)) {
    if (plan.ok) break;
    const next = await planOf(choice.recipe, choice.later);
    if (!next) return { ok: false, reason: "stale-document" };
    if (next.ok) {
      plan = next;
      ctx.recipe = choice.recipe;
      ctx.later = choice.later;
    }
  }

  /* eslint-enable no-await-in-loop */
  // A passkey-only item on a list whose account branch cannot take the stop (ADR 0036,
  // owner 2026-10-13 06:32 UTC: the account's row, else "another account") still reads
  // the list first, planned on the click alone: it goes on only through `other`, and is
  // refused with the account branch's reason, pressing nothing, when its row fits.
  let deferred: { route: LoginRecipe; detail?: string } | undefined;

  if (!plan.ok && plan.reason === "no-route" && !ctx.previous && ctx.chooser && !ctx.shownOther) {
    const { afterAccount: _afterAccount, ...lists } = ctx.chooser.chooser;
    const bare = chooserRoute({ ...ctx.chooser, chooser: lists }, "entry");
    const alone =
      bare &&
      (await planFor(rt, snapshot, ctx.live, bare, {
        ...(asking ? { asking } : {}),
        ...(fill ? { fill } : {}),
        ...(pageRequest ? { pageRequest } : {}),
        ...(pausedStart ? { paused: true } : {}),
      }));
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (bare && alone && alone.ok && "stopAt" in alone && !("fillOnly" in alone)) {
      deferred = {
        route: bare,
        ...("detail" in plan && typeof plan.detail === "string" ? { detail: plan.detail } : {}),
      };
      plan = alone;
    }
  }

  // A generated recipe the chosen item cannot run, where it holds what a route the recipe
  // lacks needs, has its start page sent for repair in this visit (ADR 0058 A, amended by
  // ADR 0041): only for a new login of the tab's own page that starts at the recipe's first
  // step, neither while the tab asks nor after an account switch, nor on a chooser's
  // list, and while no login of the recipe runs or is watched in any tab. Until the answer
  // the page waits as for a generation; a page the repair did not answer with a recipe is
  // refused as it would have been.
  const unfit =
    !plan.ok && "unfit" in plan && (plan.unfit === "passkey" || plan.unfit === "password")
      ? plan.unfit
      : undefined;

  // Such a recipe still answers the page's own passkey request, which may come only after
  // this start (ADR 0034 amendment of 2026-10-25).
  const awaitsRequest =
    unfit === "passkey" &&
    !pageRequest &&
    !ctx.previous &&
    !ctx.switched &&
    !ctx.ask &&
    !pausedStart &&
    ctx.document.frameId === 0 &&
    !ctx.live.topUrl &&
    passkeyAnswersRequest(ctx.recipe);

  if (
    !plan.ok &&
    unfit &&
    !ctx.previous &&
    !ctx.switched &&
    !ctx.ask &&
    !ctx.chooser &&
    !ctx.shownOther &&
    !deferred &&
    !ctx.later &&
    !pausedStart &&
    ctx.document.frameId === 0 &&
    !ctx.live.topUrl &&
    !(probeMode && ctx.document.origin === rt.vars.origin) &&
    isGeneratedRecipeId(ctx.recipe.id) &&
    rt.generation?.claimRepair &&
    rt.repairs &&
    !recipeInUse(rt, ctx.recipe.id)
  ) {
    // A pause that started meanwhile admits the document again (ADR 0062).
    if ((await pauseOf(rt, ctx.live)) !== undefined) return { ok: false, reason: CHOICE_SAVED };
    if (awaitsRequest) {
      ctx.live.awaitsPageRequest = true;
      ctx.live.repairing = true;
    }
    ctx.live.state = "generating";
    delete ctx.live.reason;
    await publish(rt, ctx.live);
    void repairUnfit(rt, ctx.live, ctx.recipe, {
      reason: plan.reason,
      ...("detail" in plan && typeof plan.detail === "string" ? { detail: plan.detail } : {}),
      route: unfit,
    })
      .catch(() => undefined)
      .finally(() => {
        // A request that waited for it is decided again, also when the repair failed.
        delete ctx.live.repairing;
        reviewRequests(rt);
      });
    return { ok: false, reason: "generating" };
  }

  if (!plan.ok) {
    // An account the page's value picked for a login that did not start is dropped, so
    // a default saved or a logout later decides this document again.
    const site = rt.picked.get(ctx.document.tabId);
    if (site?.site && site.attemptId === undefined && site.documentId === ctx.document.documentId) {
      rt.picked.delete(ctx.document.tabId);
      void quietly(rt, () => saveSession(rt));
    }
    // Only a fresh start can be restarted with a picked account (ADR 0021). The page
    // after an account switch belongs to that login, so it offers none.
    if (!ctx.previous && !ctx.switched && "candidates" in plan && plan.candidates) {
      const asked = "ask" in plan && plan.ask === true ? ctx.ask : undefined;
      const pausedChoice = "paused" in plan && plan.paused === true;
      offerChoice(rt, ctx.document, plan.candidates, asked, pausedChoice);
      // Outside an ask, the page's own conditional request may wait for the pick, on a
      // recipe without a passkey button (ADR 0034); a paused site hands it on (ADR 0062).
      noteChoice(
        rt,
        ctx.document,
        plan.candidates,
        !asked && !pausedChoice && ctx.document.frameId === 0 && passkeyAnswersRequest(ctx.recipe),
      );
    }
    const refused = await ctx.refuse(
      plan.reason,
      "detail" in plan && typeof plan.detail === "string"
        ? plan.detail
        : plan.reason === "account-asked"
          ? // Why the tab asks: its own rejection or stopped login, or another tab's
            // rejection (ADR 0021 D).
            ctx.ask
          : // No vault item matches the page, which a vault sync may change.
            "noUriMatch" in plan && plan.noUriMatch
            ? "no-uri-match"
            : undefined,
      undefined,
      "candidates" in plan && plan.candidates ? plan.candidates.length : undefined,
    );
    // Asked while the page still holds vault replacement off, so a check started by
    // this page's announcement cannot apply before the miss is registered.
    if (!ctx.previous && !ctx.switched && "noUriMatch" in plan && plan.noUriMatch)
      retryAfterSync(rt, ctx.live, plan.reason);
    if (awaitsRequest && rt.documents.get(ctx.key) === ctx.live) {
      ctx.live.awaitsPageRequest = true;
      restartForRequest(rt, ctx.live);
    }
    return refused;
  }

  if (heldElsewhere(rt, ctx.document.tabId, ctx.document.origin)) {
    showHeld(rt, ctx.document.tabId);
    return ctx.refuse("origin-busy");
  }

  // A new login on a chooser's list decides what it clicks there for its account (ADR
  // 0028), and takes the route that click leads to. A fill-only login presses nothing.
  let click: ChooserClick | "none" | undefined = ctx.shownOther ? "other-shown" : undefined;

  let listMiss: ListMiss | undefined;

  if (!ctx.previous && ctx.chooser && !ctx.shownOther && !("fillOnly" in plan)) {
    const chosen = await listClick(rt, snapshot, ctx.live, ctx.chooser, plan.account);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    // Without the account's username nothing on the list can be compared with it.
    if (chosen === "unreadable") return ctx.refuse("field-unavailable", "list-username");
    // The page no longer shows the list, or could not be asked: it announces again.
    if (!chosen) return { ok: false, reason: "stale-document" };
    if (typeof chosen === "string") click = chosen;
    else {
      click = "none";
      listMiss = chosen;
      // A button the chooser names that the list no longer shows, as on a list redesigned
      // or in another language, sends the list for repair while this login goes on
      // (ADR 0041 section 6).
      if (chosen.other === "missing" || chosen.continue === "missing")
        void repairChooser(rt, ctx.live, ctx.chooser).catch(() => undefined);
    }
    // The account's row or its button leads to the branch that cannot take the stop.
    if (deferred && (click === "entry" || click === "continue"))
      return ctx.refuse("no-route", deferred.detail);
    // Nothing fits and there is no button: the login ends on the click alone's route.
    if (deferred && click === "none") ctx.recipe = deferred.route;
    if (click === "other" || click === "continue") {
      const route = chooserRoute(ctx.chooser, click);
      if (!route) return ctx.refuse("recipe-not-found");
      // Another branch's route has other slots, and is planned again for the same account.
      if (click === "other") {
        const replanned = await planFor(rt, snapshot, ctx.live, route, {
          ...(asking ? { asking } : {}),
          ...(pageRequest ? { pageRequest } : {}),
          ...(pausedStart ? { paused: true } : {}),
        });
        if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
        // An item without a password goes on only when that branch can take its stop
        // (ADR 0036); the log names why not, as for the list's own route.
        if (!replanned.ok)
          return ctx.refuse(
            replanned.reason,
            "detail" in replanned && typeof replanned.detail === "string"
              ? replanned.detail
              : undefined,
          );
        // The click was chosen for the planned account; another one is not logged in.
        if (
          replanned.account.connectionId !== plan.account.connectionId ||
          replanned.account.itemId !== plan.account.itemId
        )
          return ctx.refuse("account-changed", "list-other");
        plan = replanned;
      }
      ctx.recipe = route;
    }
  }

  // The vault account whose master password this new login was started with, if any.
  let typedFor: string | undefined;

  if (!ctx.previous) {
    // The lookup answered from the cache while the sync it started may be revoking the
    // recipe, as one removed on the dashboard minutes ago: that sync ends first, and a
    // recipe or layout it removed never starts.
    if (
      !(probeMode && ctx.document.origin === rt.vars.origin) &&
      (await rt.recipes
        .withdrawn?.(ctx.document.origin, ctx.recipe.id, ctx.recipe.layout)
        .catch(() => false))
    ) {
      if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
      return ctx.refuse("recipe-not-found", "withdrawn");
    }
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    // Another login's account choice, being saved now or saved since this snapshot was read,
    // bumps the revision this new login would be checked against: it is admitted again.
    await choicesSaved(rt);
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    if (rt.savingChoices.size || rt.vars.remembered !== savedBefore)
      return { ok: false, reason: CHOICE_SAVED };
    if (heldElsewhere(rt, ctx.document.tabId, ctx.document.origin)) {
      showHeld(rt, ctx.document.tabId);
      return ctx.refuse("origin-busy");
    }
    // An item with Bitwarden's re-prompt starts a login on a site that honours it only
    // after its master password was typed for this document; until then the page is
    // neither filled nor pressed, and the chooser window asks (owner, 2026-10-23 12:46 UTC).
    // Its username may already have been read to match the page's accounts, as Bitwarden
    // shows usernames without asking.
    // The started login goes on across its pages, and answers the site's passkey request
    // with that item (ADR 0027), without asking again.
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === plan.account.connectionId,
    );
    const item = connection?.items.find((entry) => entry.id === plan.account.itemId);
    if (connection && itemAsksForMasterPassword(snapshot.snapshot.settings, item, ctx.live.url)) {
      const grantKey = `${ctx.document.tabId} ${ctx.document.documentId}`;
      const grant = rt.repromptGrants.get(grantKey);
      if (
        grant?.connectionId === plan.account.connectionId &&
        grant.itemId === plan.account.itemId &&
        Date.now() - grant.at <= REPROMPT_GRANT_MS
      ) {
        rt.repromptGrants.delete(grantKey);
        typedFor = grant.connectionId;
        if (ctx.document.frameId === 0) rt.repromptWaiting.delete(ctx.document.tabId);
      } else {
        const awaiting = {
          document: ctx.document,
          account: {
            origin: ctx.document.origin,
            connectionId: plan.account.connectionId,
            itemId: plan.account.itemId,
          },
          ...(rt.picked.get(ctx.document.tabId)?.documentId === ctx.document.documentId
            ? { pick: { ...rt.picked.get(ctx.document.tabId)! } }
            : {}),
        };
        if (ctx.document.frameId === 0) rt.repromptWaiting.set(ctx.document.tabId, awaiting);
        void askMasterPassword(rt, awaiting, connection, item!);
        return ctx.refuse("master-password-reprompt");
      }
    }
  }

  // A pause that started while this announcement was handled stops what it would start
  // or go on with by itself: the document is admitted again and refused as paused. A
  // login a popup pick started goes on (ADR 0062).
  const picking = ctx.previous
    ? rt.picked.get(ctx.document.tabId)?.attemptId === ctx.previous.id
    : "chosen" in plan && (plan.chosen?.source === "pick" || plan.chosen?.source === "switch");

  if (!ctx.paused && !picking && (await pauseOf(rt, ctx.live)) !== undefined) {
    if (rt.documents.get(ctx.key) !== ctx.live) return { ok: false, reason: "stale-document" };
    return { ok: false, reason: CHOICE_SAVED };
  }

  if (!ctx.previous && rt.persisted.size >= 100) return ctx.refuse("attempt-limit");

  // Another document of the tab, such as a frame, may have started an attempt while this
  // one was checked, and the tab runs one attempt at a time. Nothing below awaits until
  // the attempt is registered.
  const latest = tabAttempt(rt, ctx.document.tabId);

  if (
    recordFor(rt, ctx.document.tabId, ctx.document.origin)?.id !== ctx.recorded?.id ||
    (latest && !terminal(latest) && latest.id !== ctx.recorded?.id)
  )
    return ctx.refuse("tab-busy");

  // A passkey Pateat returned to the tab's page, outside a login of it, signed that page
  // in: the site moves on by itself, so no login runs there by itself, as one would fill
  // and submit the password over the passkey's sign-in, also from a later step such as a
  // password page shown alone. Read here, after the admission's last wait, so an answer
  // returned while it waited counts too. A pick in the popup or an account switch still
  // logs in, and the page announces again when the answer's window ends, so a step the
  // site shows after the passkey, such as a one-time code, is filled then.
  if (!ctx.previous && !picking) {
    const answer = rt.passkeyAnswers.get(`${ctx.document.tabId} ${ctx.siteOrigin}`);
    const top =
      ctx.document.frameId === 0
        ? ctx.document.documentId
        : rt.documents.get(frameKey({ tabId: ctx.document.tabId, frameId: 0 }))?.document
            .documentId;
    if (
      answer?.signedIn !== undefined &&
      answer.signedIn === top &&
      Date.now() - answer.at < PASSKEY_SIGN_IN_MS
    ) {
      const refused = await ctx.refuse(PASSKEY_SIGNED_IN);
      retryAfterPasskey(rt, ctx.live, answer.at);
      return refused;
    }
  }

  let metadata: LoginAttemptMetadata;

  let resumedPolicy: PolicyChange | undefined;

  if (ctx.previous) {
    let resumed = recoverLoginAttempt(ctx.previous);
    // The page left the document a TOTP code was filled into before its click,
    // as a code input that submits on its last digit does: the page submitted the code
    // itself, and it is never filled again (ADR 0027).
    // So did a software keyboard's page once a key was pressed (ADR 0067).
    if (
      ctx.previous.document.documentId !== ctx.document.documentId &&
      codeAwaitsClick(ctx.recipe, resumed, rt.keypadPresses.get(resumed.id))
    )
      resumed = transitionLoginAttempt(resumed, autoSubmitted(ctx.recipe, resumed));
    metadata = transitionLoginAttempt(resumed, {
      type: "NAVIGATED",
      document: ctx.document,
    });
    // A new page ends a wait for the person's click, as their press led to it, and the
    // login waits for the site until it read that page (ADR 0019).
    if (!metadata.watch) metadata = followPage(personAnswered(metadata));
    if (ctx.revised)
      metadata = transitionLoginAttempt(metadata, {
        type: "REVISED",
        recipeRevision: ctx.recipe.revision,
      });
    if (metadata.policyRevision !== snapshot.snapshot.revision && !terminal(metadata)) {
      // A watched login keeps watching while the newer settings still plan its account
      // (ADR 0027).
      const kept =
        metadata.watch !== undefined &&
        snapshot.snapshot.revision > metadata.policyRevision &&
        plan.ok &&
        plan.account.connectionId === metadata.account.connectionId &&
        plan.account.itemId === metadata.account.itemId;
      metadata = transitionLoginAttempt(
        metadata,
        kept
          ? { type: "POLICY_REVISED", policyRevision: snapshot.snapshot.revision }
          : { type: "POLICY_CHANGED" },
      );
      if (!kept) resumedPolicy = { cause: "settings-revision" };
    }
  } else {
    // A new login's plan carries the facts it chose its route with.
    if (!("facts" in plan)) return ctx.refuse("no-route");
    // An account whose route is the passkey button that shows beside the later step
    // presses it, as on the first page (ADR 0027).
    if (ctx.later?.button && plan.route.route === "passkey") ctx.later = undefined;
    // A login that starts at a later step takes the first one that shows in the variant
    // its account fits, or a passkey answer that falls back to that variant (ADR 0049); an
    // item without a password goes no further than the step before its password.
    const startVariant =
      plan.route.route === "password"
        ? plan.route.variant
        : "fallback" in plan && typeof plan.fallback === "number"
          ? plan.fallback
          : undefined;
    const startAt =
      ctx.later && startVariant !== undefined
        ? ctx.later.variants.get(startVariant)?.[0]
        : undefined;
    if (ctx.later && startAt === undefined) return ctx.refuse("no-route", "later-variant");
    if (ctx.later && "stopAt" in plan && typeof plan.stopAt === "number" && plan.stopAt <= startAt!)
      return ctx.refuse("no-route", "password-empty:later-start");
    const timing = startTiming(rt, ctx.live, plan.account);
    metadata = transitionLoginAttempt(
      createAttemptMetadata({
        id: newId(),
        recipe: ctx.recipe,
        policyRevision: snapshot.snapshot.revision,
        account: {
          origin: ctx.document.origin,
          connectionId: plan.account.connectionId,
          itemId: plan.account.itemId,
        },
        choice: plan.route,
        ...("fallback" in plan ? { fallback: plan.fallback } : {}),
        facts: plan.facts,
        document: ctx.document,
        ...(ctx.document.frameId === 0 ? {} : { pageOrigin: ctx.siteOrigin }),
        accountSwitched: ctx.switched,
        fillOnly: "fillOnly" in plan,
        ...(ctx.chooser
          ? { chooser: click === undefined || click === "none" ? "entry" : click }
          : {}),
        // An item without a password stops before it (ADR 0036).
        ...("stopAt" in plan && typeof plan.stopAt === "number" ? { stopAt: plan.stopAt } : {}),
        ...(startAt === undefined ? {} : { startAt }),
        ...(startAt !== undefined && ctx.later?.partial.has(`${startVariant}:${startAt}`)
          ? { startPartial: true }
          : {}),
        timing,
      }),
      { type: "RESOLVE" },
    );
    rt.begunIn.delete(metadata.id);
    rt.begunIn.set(metadata.id, ctx.document.documentId);
    for (const old of rt.begunIn.keys()) {
      if (rt.begunIn.size <= 256) break;
      rt.begunIn.delete(old);
    }
    if (typedFor !== undefined) holdPassword(rt, metadata.id, typedFor);
    // No listed account fits, and the list has no button for another one (ADR 0028).
    if (click === "none") metadata = transitionLoginAttempt(metadata, { type: "NOT_LISTED" });
  }

  const run: Execution = {
    metadata,
    recipe: ctx.recipe,
    live: ctx.live,
    running: false,
    ...(ctx.chooser && metadata.chooser ? { chooser: ctx.chooser } : {}),
    // Each document re-derives the choice; every step still checks it is the attempt's account.
    ...(plan.choice &&
    !terminal(metadata) &&
    plan.account.connectionId === metadata.account.connectionId &&
    plan.account.itemId === metadata.account.itemId
      ? { choice: plan.choice }
      : {}),
    ...(ctx.ask && "asked" in plan ? { asked: { candidates: plan.asked, ask: ctx.ask } } : {}),
  };

  // A new document after an advance on the same path, as a form posted back to its own
  // path, is checked against what the advancing document showed before it (ADR 0013).
  const before = rt.attempts.get(ctx.document.tabId);

  if (
    before?.inPlace &&
    before.metadata.id === metadata.id &&
    before.inPlace.operationId === metadata.operationId
  )
    run.inPlace = before.inPlace;

  if (
    before?.siblingsInPlace &&
    before.metadata.id === metadata.id &&
    before.siblingsInPlace.operationId === metadata.operationId
  )
    run.siblingsInPlace = before.siblingsInPlace;

  rt.attempts.set(ctx.document.tabId, run);

  reviewRequests(rt);

  if (!ctx.previous)
    report(rt, ctx.document, {
      type: "start",
      tabId: ctx.document.tabId,
      origin: ctx.document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
      ...(metadata.layout === undefined ? {} : { layout: metadata.layout }),
      ...(ctx.layoutCount > 1 ? { layouts: ctx.layoutCount } : {}),
      route: metadata.route,
      ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
      ...("chosen" in plan && plan.chosen
        ? {
            account: plan.chosen.source,
            ...(plan.chosen.candidates === undefined ? {} : { candidates: plan.chosen.candidates }),
            ...(plan.chosen.source === "match" || plan.chosen.source === "site-value"
              ? { itemId: metadata.account.itemId }
              : {}),
          }
        : {}),
      ...(metadata.fillOnly ? { fillOnly: true as const } : {}),
      ...(metadata.startStep === undefined ? {} : { startStep: metadata.startStep }),
      ...(metadata.startPartial ? { startPartial: true as const } : {}),
      ...(click ? { click } : {}),
      ...(listMiss ? { listMiss } : {}),
    });

  // Each new document of the tab resumes the attempt; only a change is news.
  reportAttempt(
    rt,
    metadata,
    ctx.recipe,
    resumedPolicy,
    ctx.previous &&
      metadata.state === ctx.previous.state &&
      metadata.outcome === ctx.previous.outcome
      ? { repeat: true }
      : {},
  );

  // A page that resumes a login stopped after a submission while it still holds the site
  // (ADR 0022) does nothing, and says why once (ADR 0019).
  if (
    ctx.previous?.state === "blocked" &&
    metadata.state === "blocked" &&
    ctx.previous.submissions > 0 &&
    holdsSite(ctx.previous, Date.now())
  )
    note(rt, ctx.document, ctx.live.url, "not-started", "stopped-login");

  // The choice, pick and ask markers form one session update. Snapshot only once they
  // all name the started login, rather than relying on a deferred save callback.
  let sessionChanged = false;

  const pick = rt.picked.get(ctx.document.tabId);

  if (
    !ctx.previous &&
    pick?.connectionId === plan.account.connectionId &&
    pick.itemId === plan.account.itemId &&
    (pick.attemptId === undefined
      ? pick.documentId === ctx.document.documentId
      : // The login a pick started goes on past an account switch.
        ctx.switched && pick.attemptId === ctx.recorded?.id)
  ) {
    pick.attemptId = metadata.id;
    sessionChanged = true;
  }

  // The login an account switch's pick started ends that pick and the switch (ADR 0063).
  if (!ctx.previous && "chosen" in plan && plan.chosen?.source === "switch") {
    rt.switchStates.delete(ctx.document.tabId);
    void rt.accountPicks.endSwitch(ctx.document.tabId);
  }

  // A login started while the tab asks, as by a pick, ends the tab's asking for this
  // origin, and that of the origin's other tabs it began; filling the page only does not,
  // and the document is not filled again on this path.
  if (metadata.fillOnly) {
    addAskFill(rt, filledKey);
    sessionChanged = true;
  } else if (!ctx.previous) {
    const rejected = rt.rejectedAsks.delete(ctx.askKey);
    if (rt.stoppedAsks.delete(ctx.askKey) || rejected) sessionChanged = true;
  }

  // clearChoice saves the completed update before notifying a badge that may reenter.
  if (!rt.pending.has(ctx.document.tabId) && sessionChanged)
    void quietly(rt, () => saveSession(rt));

  clearChoice(rt, ctx.document.tabId);

  // A hold's tooltip no longer applies once the tab logs in.
  rt.badge.note(ctx.document.tabId, undefined);

  await save(rt, run);

  await publish(rt, ctx.live, metadata);

  void drive(rt, run);

  // A page of a watched login watches for the recipe's first step, which ends the
  // login (ADR 0027).
  if (metadata.watch && ctx.document.documentId !== metadata.watch.documentId) {
    const starts = await startsFor(rt, ctx.document.origin);
    if (rt.documents.get(ctx.key) === ctx.live) return { ok: true, starts };
  }

  return { ok: true };
}
