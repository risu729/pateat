import * as v from "valibot";
import {
  loginObservationSchema,
  recoverLoginAttempt,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginObservation,
  isLoginRouteRecipe,
  chooserClickBranch,
  chooserRoute,
  type LoginRecipe,
} from "@pateat/contracts";
import { extractResultSchema, observationSchema, stateResultSchema } from "../wire";
import { loginUsernameFieldId } from "../vault";
import { loginMoveFits } from "@pateat/contracts/site";
import {
  frameKey,
  type LiveDocument,
  markerProof,
  SIGN_IN_RECHECK_MS,
  SITE_MOVE_MS,
  SITE_MOVE_READINGS,
  terminal,
} from "./model";
import type { LoginReport } from "./reports";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * A login's tab moving to another origin of the site after a passkey answer or a password
 * submission (ADR 0022), and the passkey bridge's reports of requests and answers.
 */
export function createSiteMoves(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    passkeyRequests,
    passkeyAnswers,
    documents,
    moveJudgements,
    attempts,
    recipes,
    report,
    send,
    generation,
    spinning,
    effects,
    passkeyPages,
    siteMoves,
    reportAttempt,
    passwordFills,
    settings,
    fields,
  } = shared;
  /** The passkey bridge saw a request of this tab's top document (ADR 0029: S5). */
  function passkeyRequested(tabId: number, siteOrigin: string): void {
    passkeyRequests.set(`${tabId} ${siteOrigin}`, Date.now());
  }
  /**
   * The passkey bridge returned an assertion for `rpId`, signed with `item`, to a page of
   * this tab (ADR 0022).
   */
  function passkeyAnswered(
    tabId: number,
    siteOrigin: string,
    rpId: string,
    item?: { connectionId: string; itemId: string },
  ): void {
    passkeyAnswers.set(`${tabId} ${siteOrigin}`, {
      at: Date.now(),
      rpId,
      ...(item ? { item: { connectionId: item.connectionId, itemId: item.itemId } } : {}),
    });
  }
  /**
   * Whether a top-level attempt's tab moving to `live`, a top page of another origin, ended
   * its sign-in (ADR 0022): after its last effect step, and shortly before the move, Pateat
   * answered the attempt's page's passkey request; the new page's host is the passkey's RP
   * ID or a subdomain of it; and that page is quiet (`quietMove`). Only reads.
   */
  async function signedInByPasskey(
    record: LoginAttemptMetadata,
    live: LiveDocument,
  ): Promise<boolean> {
    delete live.moveMiss;
    const answer = passkeyMoveFits(record, live.document.tabId, live.document.origin);
    if (!answer || live.document.frameId !== 0 || live.topUrl !== undefined) {
      live.moveMiss = "no-factor";
      return false;
    }
    return quietMove(live, answer.at);
  }
  /**
   * Whether a top-level `password` attempt's tab moving to `live`, a top page of another
   * origin of the same site, or of any site after a second factor, ended its sign-in (ADR
   * 0022): the attempt's last effect step or second factor ran shortly before the move
   * (`passwordMoveFits`), and that page is quiet and shows the account's username
   * in its header or navigation (`quietMove`, ADR 0029: E2), or, quiet without it, shows a
   * signed-in marker learned on its origin or is judged `signed-in` once (`judgeMove`). A
   * login that stops before its item's missing password skips the username (ADR 0036).
   * Pateat fills and clicks nothing there.
   */
  async function signedInByPassword(
    record: LoginAttemptMetadata,
    live: LiveDocument,
  ): Promise<boolean> {
    delete live.moveMiss;
    if (live.document.frameId !== 0 || live.topUrl !== undefined) {
      live.moveMiss = "no-factor";
      return false;
    }
    const stillLive = () => documents.get(frameKey(live.document)) === live;
    // The same document announcing again while its page is judged waits for that verdict.
    const judging = moveJudgements.get(record.id);
    if (judging?.documentId === live.document.documentId)
      return (await judging.verdict) && stillLive();
    const effect = passwordMoveFits(record, live.document.tabId, live.document.origin);
    if (!effect) {
      live.moveMiss = "no-factor";
      return false;
    }
    const username = await moveUsername(record);
    if (!stillLive()) return false;
    if (!username) {
      live.moveMiss = "no-username";
      return false;
    }
    // A login that stops before its item's missing password is not signed in by the
    // username in the header or navigation (ADR 0036): a quiet page is judged.
    const reading =
      record.stopAt === undefined
        ? await quietMove(live, effect.at, username, true)
        : (await quietMove(live, effect.at)) && ("unproven" as const);
    if (reading !== "unproven" || !stillLive()) return reading === "signed-in";
    const verdict = judgeMove(record, live, username, effect.at);
    moveJudgements.set(record.id, { documentId: live.document.documentId, verdict });
    try {
      return (await verdict) && stillLive();
    } finally {
      if (moveJudgements.get(record.id)?.verdict === verdict) moveJudgements.delete(record.id);
    }
  }
  /**
   * The recipe revision a login on another page of its tab ran, from its execution or the
   * recipe cache: for a chooser login (ADR 0028), the route of its click. `undefined` when
   * that revision is no longer at hand.
   */
  async function attemptRecipe(record: LoginAttemptMetadata): Promise<LoginRecipe | undefined> {
    const run = attempts.get(record.document.tabId);
    if (run?.metadata.id === record.id && run.recipe.revision === record.recipeRevision)
      return run.recipe;
    const { origin: loginOrigin } = record.account;
    const click = record.chooser?.click;
    const found = click
      ? await recipes.chooser?.(loginOrigin, "/", record.recipeId)
      : await recipes.recipe(loginOrigin, "/", record.recipeId);
    const route =
      found && (click && !isLoginRouteRecipe(found) ? chooserRoute(found, click) : found);
    return route && isLoginRouteRecipe(route) && route.revision === record.recipeRevision
      ? route
      : undefined;
  }
  /**
   * For a `password` login whose tab moved to `live`, a quiet page of another origin
   * (`passwordMoveFits`) that does not show the account's username (ADR 0022): whether a
   * signed-in marker learned on that origin shows, or else the judge of ADR 0029, asked
   * once, answers `signed-in` for the page or found it signed in before. A judge that
   * cannot decide, a page that cannot be described or sent, and any other verdict end the
   * login `left-origin` (a watched one where it stopped), each logged. Once the answer is
   * back, the page must still be
   * loaded and quiet, with no passkey request since `since`, the step the move follows.
   * `username` is the login's own, hidden from the page as for any judged page.
   */
  async function judgeMove(
    record: LoginAttemptMetadata,
    live: LiveDocument,
    username: string,
    since: number,
  ): Promise<boolean> {
    const { document } = live;
    const recipe = await attemptRecipe(record);
    let disabledLeftOut = false;
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      reason?: string,
    ) =>
      report(document, {
        type: "judge",
        tabId: document.tabId,
        origin: document.origin,
        recipeId: record.recipeId,
        recipeRevision: record.recipeRevision,
        route: record.route,
        verdict,
        ...(reason ? { reason } : {}),
        moved: true,
        ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
      });
    const stale = () =>
      documents.get(frameKey(document))?.document.documentId !== document.documentId;
    if (!recipe) {
      reportJudge("not-sent", "recipe-unavailable");
      return false;
    }
    // A marker learned on this origin proves the sign-in, as on the recipe's own origin.
    const proof = markerProof(recipe, document.origin);
    if (proof.targets.length > 0) {
      let observed: v.InferOutput<typeof observationSchema> | undefined;
      try {
        const parsed = v.safeParse(
          observationSchema,
          await send(live, {
            type: "login.observe",
            path: live.path,
            targets: proof.targets,
            require: proof.shown,
            links: proof.links,
          }),
        );
        observed = parsed.success ? parsed.output : undefined;
      } catch {
        observed = undefined;
      }
      if (stale()) return false;
      if (observed && proof.proves(observed.targets)) return true;
      if (
        observed?.targets.some(
          (state, index) => proof.links[index] && (state === "unique" || state === "ambiguous"),
        )
      ) {
        // A marker shows, but does not prove the sign-in: the service would not judge it.
        reportJudge("not-sent", "marker-shown");
        return false;
      }
    }
    if (!generation) {
      reportJudge("not-sent", "no-service");
      return false;
    }
    let observation: LoginObservation | undefined;
    let unsent = "unreachable";
    try {
      const extracted = v.safeParse(
        extractResultSchema,
        await send(live, { type: "login.extract", page: "signed-in" }),
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
      // The page may have changed its own URL since it announced (history.pushState), as a
      // signed-in single-page app does while it loads; no recipe path applies on this
      // origin, so the page is judged at the path it shows now.
      else if (parsed.output.origin !== document.origin) unsent = "page-changed";
      else {
        observation = parsed.output;
        disabledLeftOut = extracted.output.ok && extracted.output.disabledLeftOut === true;
      }
    } catch {
      // The page could not be asked: `unreachable`.
    }
    if (stale()) return false;
    if (!observation) {
      reportJudge("not-sent", unsent);
      return false;
    }
    // The usernames of the items that match the page are hidden too, as for any judged page.
    const scope = await runtime.generationSlotsFor(live).catch(() => undefined);
    const others = await runtime.readUsernames(
      document.origin,
      scope
        ? runtime
            .usernameReads(scope)
            .filter(
              ({ connection, itemId }) =>
                connection.id !== record.account.connectionId || itemId !== record.account.itemId,
            )
        : [],
    );
    const hidden = runtime.hideUsernames(observation, others && [username, ...others]);
    if (stale()) return false;
    if ("reason" in hidden) {
      reportJudge("not-sent", hidden.reason);
      return false;
    }
    const spin = spinning(document.tabId);
    const { verdict, reason } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        "password",
        hidden.observation,
        spin.sent(() => reportJudge("sent")),
        // A description that left out a disabled field says so (ADR 0029); only `signed-in`
        // completes a moved login anyway.
        record.chooser ? chooserClickBranch(record.chooser.click) : undefined,
        ...(disabledLeftOut ? [true as const] : []),
      )
      .finally(spin.stop);
    reportJudge(verdict, reason);
    if (verdict !== "signed-in" && !(verdict === "unclear" && reason === "judged-signed-in"))
      return false;
    // The answer can take a while: the page must still be loaded and show no sign-in step.
    let again: unknown;
    try {
      again = await send(live, { type: "login.state" });
    } catch {
      return false;
    }
    const parsed = v.safeParse(stateResultSchema, again);
    if (stale() || !parsed.success || !parsed.output.ok || !parsed.output.loaded) return false;
    const { signs } = parsed.output;
    const requested = passkeyRequests.get(`${document.tabId} ${document.origin}`);
    return !signs.password && !signs.code && !signs.captcha && (requested ?? 0) < since;
  }
  /**
   * Whether `live`, the new top page of a move to another origin (ADR 0022), once loaded
   * and read again a second later, shows no password field, code input or CAPTCHA and has
   * not asked for a passkey since `since`, the page signs of ADR 0029. With `username`, it
   * must also show the account's username in its header or navigation (E2) in both
   * readings; the username goes to the page's content script for that comparison only, as
   * for E2 after an effect step. A page still loading, or not showing the username yet, is
   * read again, a second apart. Only reads.
   */
  async function quietMove(live: LiveDocument, since: number, username?: string): Promise<boolean>;
  /**
   * As above, with `split` telling apart, as `unproven`, a page that showed no such sign
   * in its last two loaded readings but never the username in two.
   */
  async function quietMove(
    live: LiveDocument,
    since: number,
    username: string,
    split: true,
  ): Promise<"signed-in" | "unproven" | false>;
  async function quietMove(
    live: LiveDocument,
    since: number,
    username?: string,
    split = false,
  ): Promise<boolean | "signed-in" | "unproven"> {
    const { tabId, origin: pageOrigin } = live.document;
    let quiet = 0;
    let calm = 0;
    // Each reading depends on the time passed since the last, so they run one after another.
    /* eslint-disable no-await-in-loop */
    for (let reading = 0; reading < SITE_MOVE_READINGS && quiet < 2; reading++) {
      if (reading > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
      if (documents.get(frameKey(live.document)) !== live) return false;
      let response: unknown;
      try {
        response = await send(live, {
          type: "login.state",
          ...(username ? { account: { username } } : {}),
        });
      } catch {
        live.moveMiss = "page-gone";
        return false;
      }
      const parsed = v.safeParse(stateResultSchema, response);
      if (!parsed.success || !parsed.output.ok) {
        live.moveMiss = "unreadable";
        return false;
      }
      const { signs } = parsed.output;
      const requested = passkeyRequests.get(`${tabId} ${pageOrigin}`);
      if (signs.password || signs.code || signs.captcha) {
        live.moveMiss = "sign-in-shown";
        return false;
      }
      if ((requested ?? 0) >= since) {
        live.moveMiss = "passkey-request";
        return false;
      }
      // A page that renders its header late, as a single-page site does, is read again.
      quiet = parsed.output.loaded && (!username || signs.username === true) ? quiet + 1 : 0;
      calm = parsed.output.loaded ? calm + 1 : 0;
    }
    /* eslint-enable no-await-in-loop */
    if (quiet >= 2) return split ? "signed-in" : true;
    if (split && calm >= 2) return "unproven";
    live.moveMiss = "not-quiet";
    return false;
  }
  /**
   * The passkey answer that lets a top-level attempt's tab moving to `siteOrigin` complete
   * (ADR 0022), if any: given after the attempt's last effect step and at most
   * `SITE_MOVE_MS` ago, for an RP ID that `siteOrigin`'s HTTPS host is or is under. It was
   * given to the attempt's page, or to the page of another origin of the site the tab moved
   * to and that asked for it (`passkeyPages`), there signed with the attempt's own item;
   * once such a page asked, only an answer given since counts.
   */
  function passkeyMoveFits(
    record: LoginAttemptMetadata,
    tabId: number,
    siteOrigin: string,
  ): { at: number; rpId: string } | undefined {
    const effect = effects.get(tabId);
    if (effect?.attemptId !== record.id) return undefined;
    const kept = passkeyPages.get(tabId);
    const page = kept?.attemptId === record.id ? kept : undefined;
    const moved = page && passkeyAnswers.get(`${tabId} ${page.document.origin}`);
    const { protocol, hostname } = new URL(siteOrigin);
    const fits = (answer: { at: number; rpId: string } | undefined) =>
      answer !== undefined &&
      answer.at >= (page?.requestedAt ?? effect.at) &&
      Date.now() - answer.at <= SITE_MOVE_MS &&
      protocol === "https:" &&
      (hostname === answer.rpId || hostname.endsWith(`.${answer.rpId}`));
    return [
      passkeyAnswers.get(`${tabId} ${record.document.origin}`),
      moved?.item?.connectionId === record.account.connectionId &&
      moved.item.itemId === record.account.itemId
        ? moved
        : undefined,
    ]
      .filter(fits)
      .sort((a, b) => b!.at - a!.at)[0];
  }
  /**
   * Whether `document`, the new top page of a top-level attempt's tab on `siteOrigin`, may
   * hold the attempt while it answers a passkey (ADR 0022). The page already holding it
   * may, within `SITE_MOVE_MS` of its request, or of an answer given there since (its
   * signs are read by `stillAsking`). Another page may while none was answered since the
   * last such page asked: an HTTPS origin of the attempt's registrable domain whose page
   * asked for a passkey after the attempt's last effect step, at most `SITE_MOVE_MS` after
   * it, and after the request of the page that held it before.
   */
  function passkeyPageFits(
    record: LoginAttemptMetadata,
    document: LoginDocument,
    siteOrigin: string,
  ): boolean {
    const { tabId } = document;
    const effect = effects.get(tabId);
    const kept = passkeyPages.get(tabId);
    const page = kept?.attemptId === record.id ? kept : undefined;
    const answer = page && passkeyAnswers.get(`${tabId} ${page.document.origin}`);
    const answered = page !== undefined && answer !== undefined && answer.at >= page.requestedAt;
    if (page?.document.documentId === document.documentId)
      return Date.now() - (answered ? answer!.at : page.requestedAt) <= SITE_MOVE_MS;
    const requested = passkeyRequests.get(`${tabId} ${siteOrigin}`);
    return (
      record.document.frameId === 0 &&
      effect?.attemptId === record.id &&
      !answered &&
      requested !== undefined &&
      requested >= effect.at &&
      requested - effect.at <= SITE_MOVE_MS &&
      (page === undefined || requested > page.requestedAt) &&
      loginMoveFits(record.document.origin, siteOrigin, false)
    );
  }
  /**
   * Whether the page holding a moved attempt while it answers a passkey, announcing again,
   * still shows no password field, code input or CAPTCHA (ADR 0022), as when the person
   * dismissed the passkey prompt and the page offers its sign-in form instead. Only reads.
   */
  async function stillAsking(live: LiveDocument): Promise<boolean> {
    try {
      const parsed = v.safeParse(stateResultSchema, await send(live, { type: "login.state" }));
      if (!parsed.success || !parsed.output.ok) return false;
      const { signs } = parsed.output;
      return !signs.password && !signs.code && !signs.captcha;
    } catch {
      return false;
    }
  }
  /**
   * Ends a moved attempt still held by a page that asked for a passkey once no next page
   * can complete it any more (ADR 0022), as when that page stays open: `left-origin`, on
   * that page, without resubmitting. Kept in memory only, as the hold is.
   */
  function holdForPasskey(tabId: number): void {
    const held = passkeyPages.get(tabId);
    if (!held) return;
    setTimeout(
      () => {
        if (passkeyPages.get(tabId) !== held) return;
        // A check of the tab's next page decides instead.
        if (siteMoves.has(tabId)) {
          holdForPasskey(tabId);
          return;
        }
        passkeyPages.delete(tabId);
        const run = attempts.get(tabId);
        const latest = run?.metadata ?? runtime.tabAttempt(tabId);
        if (latest?.id !== held.attemptId || terminal(latest)) return;
        const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(latest), {
          type: "NAVIGATED",
          document: held.document,
        });
        if (run) run.metadata = ended;
        reportAttempt(ended, run?.recipe);
        void runtime.keep(ended).catch(() => undefined);
      },
      2 * SITE_MOVE_MS + SIGN_IN_RECHECK_MS,
    );
  }

  /**
   * The time of the step that lets a top-level `password` attempt's tab moving to
   * `siteOrigin` complete on the account's username (ADR 0022), if any: the attempt's last
   * effect step, not one that asks for a passkey, delivered at most `SITE_MOVE_MS` ago,
   * with `siteOrigin` an HTTPS origin of the attempt's registrable domain; or, for an HTTPS
   * origin of any site, its second factor at most `SITE_MOVE_MS` ago: a TOTP code it
   * submitted (owner's choice on 2026-10-13, 01:59 UTC), or a passkey answered for its page
   * after its last effect step, once a submitting step followed its fill of the item's
   * password (03:13 UTC). A passkey answer for the new page's host decides the move instead
   * (`passkeyMoveFits`), and so does it alone once a page of the site the tab moved to asked
   * for a passkey (`passkeyPages`).
   */
  function passwordMoveFits(
    record: LoginAttemptMetadata,
    tabId: number,
    siteOrigin: string,
  ): { at: number } | undefined {
    const effect = effects.get(tabId);
    if (
      record.route !== "password" ||
      record.document.frameId !== 0 ||
      effect?.attemptId !== record.id ||
      passkeyMoveFits(record, tabId, siteOrigin) ||
      // After a page of the site asked for a passkey, only an answer there decides.
      passkeyPages.get(tabId)?.attemptId === record.id
    )
      return undefined;
    const now = Date.now();
    if (
      !effect.passkey &&
      now - effect.at <= SITE_MOVE_MS &&
      loginMoveFits(record.document.origin, siteOrigin, false)
    )
      return effect;
    const answer = passkeyAnswers.get(`${tabId} ${record.document.origin}`);
    const factors = [
      ...(effect.code === undefined ? [] : [effect.code]),
      ...(answer &&
      answer.at >= effect.at &&
      passwordFills.get(tabId)?.attemptId === record.id &&
      passwordFills.get(tabId)?.submitted
        ? [answer.at]
        : []),
    ];
    const factor = factors.length > 0 ? Math.max(...factors) : undefined;
    return factor !== undefined &&
      now - factor <= SITE_MOVE_MS &&
      loginMoveFits(record.document.origin, siteOrigin, true)
      ? { at: factor }
      : undefined;
  }
  /**
   * The username of a login's own account, for the E2 comparison on the page its tab moved
   * to (ADR 0022), read with the settings the login was authorized with. `undefined` when
   * the settings changed since, or the item has no username or it cannot be read.
   */
  async function moveUsername(record: LoginAttemptMetadata): Promise<string | undefined> {
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok || snapshot.snapshot.revision !== record.policyRevision) return undefined;
    const { connectionId, itemId } = record.account;
    const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
    const fieldId = connection && loginUsernameFieldId(connection, itemId);
    if (!connection || !fieldId) return undefined;
    try {
      return (await fields({ account: record.account, connection, fieldId })) || undefined;
    } catch {
      return undefined;
    }
  }
  return {
    passkeyMoveFits,
    passwordMoveFits,
    signedInByPasskey,
    signedInByPassword,
    passkeyPageFits,
    stillAsking,
    holdForPasskey,
    passkeyRequested,
    passkeyAnswered,
  };
}
