import * as v from "valibot";
import {
  loginObservationSchema,
  recoverLoginAttempt,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginObservation,
  isLoginRouteRecipe,
  chooserRoute,
  type LoginRecipe,
} from "@pateat/contracts";
import type { ServiceTiming } from "../../service/transport";
import { extractResultSchema, observationSchema, stateResultSchema } from "../wire";
import { loginUsernameFieldId } from "../vault";
import { loginMoveFits } from "@pateat/contracts/site";
import { type LiveDocument } from "./types";
import { type LoginReport } from "./report";
import { report, send, spinning, spend, reportAttempt } from "./attempt";
import { frameKey, markerProof, branchOf } from "./steps";
import { usernameShape, readUsernames, hideUsernames } from "./markers";
import { generationSlotsFor, usernameReads, judgeSlots } from "./generation-scope";
import { SITE_MOVE_READINGS, SIGN_IN_RECHECK_MS, SITE_MOVE_MS } from "./constants";
import { tabAttempt } from "./hold";
import { siteWaitOver, terminal, watchOver } from "./attempt-state";
import { keep } from "./session-store";
import { browser } from "wxt/browser";
import type { Runtime } from "./state";

/**
 * The recipe revision a login on another page of its tab ran, from its execution or the
 * recipe cache: for a chooser login (ADR 0028), the route of its click. `undefined` when
 * that revision is no longer at hand.
 */
export async function attemptRecipe(
  rt: Runtime,
  record: LoginAttemptMetadata,
): Promise<LoginRecipe | undefined> {
  const run = rt.attempts.get(record.document.tabId);
  if (run?.metadata.id === record.id && run.recipe.revision === record.recipeRevision)
    return run.recipe;
  const { origin: loginOrigin } = record.account;
  const click = record.chooser?.click;
  const found = click
    ? await rt.recipes.chooser?.(loginOrigin, "/", record.recipeId, record.layout)
    : await rt.recipes.recipe(loginOrigin, "/", record.recipeId, record.layout);
  const route = found && (click && !isLoginRouteRecipe(found) ? chooserRoute(found, click) : found);
  return route && isLoginRouteRecipe(route) && route.revision === record.recipeRevision
    ? route
    : undefined;
}

/**
 * For a `password` login whose tab moved to `live`, a quiet page of another origin
 * (`passwordMoveFits`) that does not show the account's username (ADR 0022) after a step
 * that sent no credential: whether a signed-in marker learned on that origin shows, or
 * else the judge of ADR 0029, asked once, answers `signed-in` for the page or found it
 * signed in before. A judge that cannot decide, a page that cannot be described or sent,
 * and any other verdict end the login `left-origin` (a watched one where it stopped),
 * each logged.
 * Once the answer is back, the page must still be loaded and show no password field,
 * code input or CAPTCHA, with no passkey request since `since`, the step the move
 * follows. `username` is the login's own, hidden from the page as for any judged page.
 */
export async function judgeMove(
  rt: Runtime,
  record: LoginAttemptMetadata,
  live: LiveDocument,
  username: string,
  since: number,
): Promise<boolean> {
  const { document } = live;
  const recipe = await attemptRecipe(rt, record);
  let disabledLeftOut = false;
  // The answer's timing, once it came (ADR 0019).
  let timed: { timing?: ServiceTiming } = {};
  const reportJudge = (
    verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
    reason?: string,
  ) =>
    report(rt, document, {
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
      ...timed,
    });
  const stale = () =>
    rt.documents.get(frameKey(document))?.document.documentId !== document.documentId;
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
        await send(rt, live, {
          type: "login.observe",
          path: live.path,
          targets: proof.targets,
          require: proof.shown,
          links: proof.links,
          hidden: proof.hidden,
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
  if (!rt.generation) {
    reportJudge("not-sent", "no-service");
    return false;
  }
  let observation: LoginObservation | undefined;
  let unsent = "unreachable";
  try {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(rt, live, { type: "login.extract", page: "signed-in" }),
    );
    const parsed =
      extracted.success && extracted.output.ok
        ? v.safeParse(loginObservationSchema, extracted.output.observation)
        : undefined;
    if (!extracted.success || !parsed?.success)
      unsent = extracted.success && !extracted.output.ok ? extracted.output.reason : "invalid-page";
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
  // The login's own username's shape, for the judge's slots, from the value already read.
  const shape = usernameShape(rt, { complete: true }, username ? [username] : []);
  // The usernames of the items that match the page are hidden too, as for any judged page.
  const scope = await generationSlotsFor(rt, live).catch(() => undefined);
  const others = await readUsernames(
    rt,
    document.origin,
    scope
      ? usernameReads(rt, scope).filter(
          ({ connection, itemId }) =>
            connection.id !== record.account.connectionId || itemId !== record.account.itemId,
        )
      : [],
  );
  const hidden = hideUsernames(rt, observation, others && [username, ...others], live);
  if (stale()) return false;
  if ("reason" in hidden) {
    reportJudge("not-sent", hidden.reason);
    return false;
  }
  // The account's slots go with the page, as for every judged page (owner 2026-10-23).
  const judged = await judgeSlots(rt, document.origin, record.account, record.route, {
    usernameShape: shape,
  });
  if (stale()) return false;
  const spin = spinning(rt, document.tabId);
  const asked = Date.now();
  const { verdict, reason, timing } = await rt.generation
    .judge(
      recipe.id,
      recipe.revision,
      "password",
      hidden.observation,
      spin.sent(() => reportJudge("sent")),
      // A description that left out a disabled field says so (ADR 0029).
      branchOf(record),
      disabledLeftOut ? true : undefined,
      undefined,
      judged.slots,
    )
    .finally(spin.stop);
  spend(rt, record.id, Date.now() - asked, timing);
  if (timing) timed = { timing };
  reportJudge(verdict, reason);
  // `optional` (ADR 0065) never completes it: a login whose password or code went in
  // completes on a quiet page alone (`credentialMoveFits`), so only a step before them,
  // as an identifier's Next, or a stop before the item's missing password (ADR 0036)
  // leads here, and the sign-in may still be ahead.
  if (verdict !== "signed-in" && !(verdict === "unclear" && reason === "judged-signed-in"))
    return false;
  // The answer can take a while: the page must still be loaded and show no sign-in step.
  let again: unknown;
  try {
    again = await send(rt, live, { type: "login.state" });
  } catch {
    return false;
  }
  const parsed = v.safeParse(stateResultSchema, again);
  if (stale() || !parsed.success || !parsed.output.ok || !parsed.output.loaded) return false;
  const { signs } = parsed.output;
  const requested = rt.passkeyRequests.get(`${document.tabId} ${document.origin}`);
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
export async function quietMove(
  _rt: Runtime,
  live: LiveDocument,
  since: number,
  username?: string,
): Promise<boolean>;

/**
 * As above, with `split` telling apart, as `unproven`, a page that showed no such sign
 * in its last two loaded readings but never the username in two.
 */
export async function quietMove(
  _rt: Runtime,
  live: LiveDocument,
  since: number,
  username: string,
  split: true,
): Promise<"signed-in" | "unproven" | false>;

export async function quietMove(
  rt: Runtime,
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
    if (reading > 0) await new Promise<void>((resolve) => setTimeout(resolve, SIGN_IN_RECHECK_MS));
    if (rt.documents.get(frameKey(live.document)) !== live) return false;
    let response: unknown;
    try {
      response = await send(rt, live, {
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
    const requested = rt.passkeyRequests.get(`${tabId} ${pageOrigin}`);
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
 * The time of the attempt's last credential step at most `SITE_MOVE_MS` ago, the step
 * after which a move of its tab completes it on a quiet page (ADR 0022), whatever its
 * route (owner's choice on 2026-11-08 at 02:58 UTC): its last effect step, not one that
 * asks for a passkey, once a submitting step followed its fill of the item's password; a
 * TOTP code it entered; or a passkey Pateat answered for its page after its last effect
 * step. Once a page of another origin asked for a passkey and holds the attempt
 * (`passkeyPages`), only a passkey answered since counts: for the attempt's page, or for
 * that page and signed with the attempt's own item.
 */
export function lastCredential(
  rt: Runtime,
  record: LoginAttemptMetadata,
  tabId: number,
): number | undefined {
  const effect = rt.effects.get(tabId);
  if (effect?.attemptId !== record.id) return undefined;
  const kept = rt.passkeyPages.get(tabId);
  const page = kept?.attemptId === record.id ? kept : undefined;
  const fill = rt.passwordFills.get(tabId);
  const moved = page && rt.passkeyAnswers.get(`${tabId} ${page.document.origin}`);
  const own =
    moved?.item?.connectionId === record.account.connectionId &&
    moved.item.itemId === record.account.itemId
      ? moved
      : undefined;
  const since = page?.requestedAt ?? effect.at;
  const steps = [
    ...(page
      ? []
      : [
          ...(!effect.passkey && fill?.attemptId === record.id && fill.submitted
            ? [effect.at]
            : []),
          ...(effect.code === undefined ? [] : [effect.code]),
        ]),
    ...[rt.passkeyAnswers.get(`${tabId} ${record.document.origin}`), own].flatMap((answer) =>
      answer && answer.at >= since ? [answer.at] : [],
    ),
  ];
  const at = steps.length > 0 ? Math.max(...steps) : undefined;
  return at !== undefined && Date.now() - at <= SITE_MOVE_MS ? at : undefined;
}

/**
 * The credential step that lets a top-level attempt's tab moving to `siteOrigin` complete
 * on a quiet page (`lastCredential`, ADR 0022), if any: `siteOrigin` is an HTTPS origin of
 * any site, or an HTTP one for a login on an `http:` origin (ADR 0050), such as
 * `https://www.logicool.co.jp` after a passkey of `id.logi.com`.
 */
export function credentialMoveFits(
  rt: Runtime,
  record: LoginAttemptMetadata,
  tabId: number,
  siteOrigin: string,
): { at: number } | undefined {
  if (record.document.frameId !== 0 || !loginMoveFits(record.document.origin, siteOrigin, true))
    return undefined;
  const at = lastCredential(rt, record, tabId);
  return at === undefined ? undefined : { at };
}

/**
 * Whether `document`, the new top page of a top-level attempt's tab on `siteOrigin`, may
 * hold the attempt while it answers a passkey (ADR 0022). The page already holding it
 * may, within `SITE_MOVE_MS` of its request, or of an answer given there since (its
 * signs are read by `stillAsking`). Another page may while none was answered since the
 * last such page asked: an HTTPS origin of any site, whatever the login's route (owner's
 * choice on 2026-11-08 at 02:58 UTC), whose page asked for a passkey after the attempt's
 * last effect step, at most `SITE_MOVE_MS` after it, and after the request of the page
 * that held it before.
 */
export function passkeyPageFits(
  rt: Runtime,
  record: LoginAttemptMetadata,
  document: LoginDocument,
  siteOrigin: string,
): boolean {
  const { tabId } = document;
  const effect = rt.effects.get(tabId);
  const kept = rt.passkeyPages.get(tabId);
  const page = kept?.attemptId === record.id ? kept : undefined;
  const answer = page && rt.passkeyAnswers.get(`${tabId} ${page.document.origin}`);
  const answered = page !== undefined && answer !== undefined && answer.at >= page.requestedAt;
  if (page?.document.documentId === document.documentId)
    return Date.now() - (answered ? answer!.at : page.requestedAt) <= SITE_MOVE_MS;
  const requested = rt.passkeyRequests.get(`${tabId} ${siteOrigin}`);
  return (
    record.document.frameId === 0 &&
    effect?.attemptId === record.id &&
    !answered &&
    requested !== undefined &&
    requested >= effect.at &&
    requested - effect.at <= SITE_MOVE_MS &&
    (page === undefined || requested > page.requestedAt) &&
    // Any site may hold it, as OpenAI's sign-in on `auth.openai.com` for `chatgpt.com`.
    loginMoveFits(record.document.origin, siteOrigin, true)
  );
}

/**
 * The last effect step of a top-level login whose tab moved to `siteOrigin`, a page of any
 * site, if that page is to be read for a passkey request that would hold it
 * (`passkeyPageFits`) when nothing else decides the move: delivered at most
 * `SITE_MOVE_MS` ago, with no page holding it yet.
 */
export function requestMoveFits(
  rt: Runtime,
  record: LoginAttemptMetadata,
  tabId: number,
  siteOrigin: string,
): { at: number } | undefined {
  const step = rt.effects.get(tabId);
  return record.document.frameId === 0 &&
    step?.attemptId === record.id &&
    Date.now() - step.at <= SITE_MOVE_MS &&
    rt.passkeyPages.get(tabId)?.attemptId !== record.id &&
    loginMoveFits(record.document.origin, siteOrigin, true)
    ? step
    : undefined;
}

/**
 * Whether the page holding a moved attempt while it answers a passkey, announcing again,
 * still shows no password field, code input or CAPTCHA (ADR 0022), as when the person
 * dismissed the passkey prompt and the page offers its sign-in form instead. Only reads.
 */
export async function stillAsking(rt: Runtime, live: LiveDocument): Promise<boolean> {
  try {
    const parsed = v.safeParse(stateResultSchema, await send(rt, live, { type: "login.state" }));
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
export function holdForPasskey(rt: Runtime, tabId: number): void {
  const held = rt.passkeyPages.get(tabId);
  if (!held) return;
  setTimeout(
    () => {
      if (rt.passkeyPages.get(tabId) !== held) return;
      // A check of the tab's next page decides instead.
      if (rt.siteMoves.has(tabId)) {
        holdForPasskey(rt, tabId);
        return;
      }
      rt.passkeyPages.delete(tabId);
      const run = rt.attempts.get(tabId);
      const latest = run?.metadata ?? tabAttempt(rt, tabId);
      if (latest?.id !== held.attemptId || terminal(latest)) return;
      const before = run?.metadata ?? recoverLoginAttempt(latest);
      // A hold kept past the login's wait for the site ends it when that ran out (ADR 0022).
      const now = Date.now();
      const endedAt = siteWaitOver(before, now) ?? now;
      const ended = transitionLoginAttempt(
        before,
        { type: "NAVIGATED", document: held.document },
        endedAt,
      );
      if (run) run.metadata = ended;
      reportAttempt(rt, ended, run?.recipe, undefined, { endedAt });
      void keep(rt, ended).catch(() => undefined);
    },
    2 * SITE_MOVE_MS + SIGN_IN_RECHECK_MS,
  );
}

/**
 * The time of the step that lets a top-level `password` attempt's tab moving to
 * `siteOrigin`, an HTTPS origin of the attempt's registrable domain, complete on the
 * account's username or the judge (ADR 0022) when no credential step lets it complete
 * (`credentialMoveFits`), as after an identifier's Next: the attempt's last effect step,
 * not one that asks for a passkey, delivered at most `SITE_MOVE_MS` ago. Once a page of
 * the site the tab moved to asked for a passkey (`passkeyPages`), only a passkey answered
 * there decides.
 */
export function passwordMoveFits(
  rt: Runtime,
  record: LoginAttemptMetadata,
  tabId: number,
  siteOrigin: string,
): { at: number } | undefined {
  const effect = rt.effects.get(tabId);
  return record.route === "password" &&
    record.document.frameId === 0 &&
    effect?.attemptId === record.id &&
    !credentialMoveFits(rt, record, tabId, siteOrigin) &&
    rt.passkeyPages.get(tabId)?.attemptId !== record.id &&
    !effect.passkey &&
    Date.now() - effect.at <= SITE_MOVE_MS &&
    loginMoveFits(record.document.origin, siteOrigin, false)
    ? effect
    : undefined;
}

/**
 * For a login in a frame whose tab showed a new top-level page (ADR 0086): the time of the
 * step the move follows, when that page is to be read for the login's result, as a
 * top-level login's move is: its last credential step (`lastCredential`), after which a
 * quiet page completes it (`credential`); or, for a `password` login, its last effect step,
 * other than a passkey's, at most `SITE_MOVE_MS` ago, or its watch while it lasts, as when
 * the person entered a code the site sent. A login with a stop never runs in a frame.
 */
export function frameMoveFits(
  rt: Runtime,
  record: LoginAttemptMetadata,
  tabId: number,
): { at: number; credential?: true } | undefined {
  if (record.document.frameId === 0) return undefined;
  const credential = lastCredential(rt, record, tabId);
  if (credential !== undefined) return { at: credential, credential: true };
  if (record.route !== "password") return undefined;
  const now = Date.now();
  const effect = rt.effects.get(tabId);
  const own = effect?.attemptId === record.id && !effect.passkey ? effect : undefined;
  const at = own?.at;
  if (at !== undefined && now >= at && now - at <= SITE_MOVE_MS) return { at };
  if (record.watch !== undefined && !watchOver(record, now))
    return { at: at ?? record.watch.since };
  return undefined;
}

/**
 * Whether frame `frameId` of the tab still shows a document, asked by its frame ID alone,
 * which any document of it answers from its start (`login.frame.present`, ADR 0086): a
 * frame that moved to its next document is still there. Only Chrome's own answer that no
 * document of the frame listens means it is gone; a document that went away before it
 * answered, as one swapped for the frame's next, leaves the frame there. A frame that
 * does not answer within a second counts as still there, as for a new page (ADR 0017).
 */
export async function framePresent(tabId: number, frameId: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.tabs
        .sendMessage(tabId, { version: 1, type: "login.frame.present" }, { frameId })
        .then(
          (answer) => answer === true,
          (error: unknown) => !String(error).includes("Receiving end does not exist"),
        ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, 1000, true);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tab's page changed its URL: when a `password` login in one of its frames may end
 * on the page there (`frameMoveFits`) and that frame no longer shows a document, as when a
 * single-page site's route replaced the sign-in frame after the sign-in (ADR 0086), the
 * tab's top document is asked to announce again, so its page is read for that login's
 * result as a new page around the frame is (`framePresent`).
 */
export async function frameLeftInPlace(rt: Runtime, tab: { id?: number | undefined }) {
  const tabId = tab.id;
  if (tabId === undefined) return;
  await rt.vars.sessionLoaded;
  const record = tabAttempt(rt, tabId);
  if (!record || terminal(record) || !frameMoveFits(rt, record, tabId)) return;
  const { frameId } = record.document;
  const key = frameKey({ tabId, frameId });
  const frame = rt.documents.get(key);
  const answers = await framePresent(tabId, frameId);
  const latest = tabAttempt(rt, tabId);
  const top = rt.documents.get(frameKey({ tabId, frameId: 0 }));
  if (answers || !top || latest?.id !== record.id || terminal(latest)) return;
  // A document of the frame that announced during the question is kept.
  if (rt.documents.get(key) === frame) rt.documents.delete(key);
  rt.leftFrames.set(tabId, record.id);
  await browser.tabs
    .sendMessage(
      tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: 0, documentId: top.document.documentId },
    )
    .catch(() => undefined);
}

/**
 * The username of a login's own account, for the E2 comparison on the page its tab moved
 * to (ADR 0022), read with the settings the login was authorized with. `undefined` when
 * the settings changed since, or the item has no username or it cannot be read.
 */
export async function moveUsername(
  rt: Runtime,
  record: LoginAttemptMetadata,
): Promise<string | undefined> {
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!snapshot.ok || snapshot.snapshot.revision !== record.policyRevision) return undefined;
  const { connectionId, itemId } = record.account;
  const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
  const fieldId = connection && loginUsernameFieldId(connection, itemId);
  if (!connection || !fieldId) return undefined;
  try {
    return (await rt.fields({ account: record.account, connection, fieldId })) || undefined;
  } catch {
    return undefined;
  }
}
