import * as v from "valibot";
import {
  attemptPlan,
  pagesLeft,
  watchedAtStop,
  loginObservationSchema,
  passkeyAnswersRequest,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  showsBesideForm,
  type LoginAttemptMetadata,
  type LoginObservation,
  type SemanticSlot,
  type ValueShape,
} from "@pateat/contracts";
import type { ServiceTiming } from "../../service/transport";
import { extractResultSchema } from "../wire";
import { observedPath } from "../../observation/path";
import { judgedCompletionResult, settleCompletion, undecidedCandidate } from "../completion-policy";
import { type Execution, type SignInReading } from "./types";
import { report, send, current, change, spinning, spend } from "./attempt";
import { generationSlotsFor, usernameReads, judgeSlots } from "./generation-scope";
import { readUsernames, usernameShape, hideUsernames } from "./markers";
import { branchOf, pairedQuestions } from "./steps";
import { type LoginReport } from "./report";
import { pauseOf } from "./pause";
import { effectful, terminal } from "./attempt-state";
import { observe, passkeyStepAnswered, toStop } from "./reconcile";
import { passkeyButton, readSignInState } from "./sign-in";
import { takeOver } from "./continuation";
import type { Runtime } from "./state";

/**
 * After an effect step that no check explained, sends the resulting page so the
 * service can judge it and learn a signed-in marker or a handler (ADR 0018, ADR 0027).
 * Returns whether the attempt settled or moved on. A page that still shows the route's
 * fields on one of its paths, or a signed-in marker, is not sent. At most
 * `MAX_JUDGED_PAGES` pages count per effect step, and as many again while the login is
 * watched (ADR 0027): a page counts in the attempt once its complete description is in
 * hand, before the request, so a restart cannot resend without bound, and is given back
 * only for a temporary refusal before any model call.
 */
/** Logs why the page was not sent to the judge, as a code: never page text. */
export function notJudged(rt: Runtime, run: Execution, reason: string): false {
  report(rt, run.live.document, {
    type: "judge",
    tabId: run.live.document.tabId,
    origin: run.live.document.origin,
    recipeId: run.recipe.id,
    recipeRevision: run.recipe.revision,
    route: run.metadata.route,
    verdict: "not-sent",
    reason,
    ...(run.metadata.watch ? { watched: true as const } : {}),
  });
  return false;
}

/**
 * The usernames hidden from a judged page: those of the items that match it, as for a
 * page sent for generation, and the login's own account's even when it does not match
 * the page's URL, with the shape of the login's own (`usernameShape`) for the judge's
 * slots, so it is read once. `undefined` when one cannot be read.
 */
export async function judgedUsernames(
  rt: Runtime,
  run: Execution,
): Promise<{ usernames: string[]; shape: ValueShape | undefined } | undefined> {
  const { connectionId, itemId } = run.metadata.account;
  const scope = await generationSlotsFor(rt, run.live).catch(() => undefined);
  let reads = scope ? usernameReads(rt, scope) : [];
  if (
    !scope?.items.some(
      ({ connection, item }) => connection.id === connectionId && item.id === itemId,
    )
  ) {
    const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return undefined;
    const connection = snapshot.catalog.connections.find((entry) => entry.id === connectionId);
    const item = connection?.items.find((entry) => entry.id === itemId);
    if (!connection || !item) return undefined;
    reads = [
      ...reads,
      ...usernameReads(rt, {
        items: [{ connection, item }],
        settings: snapshot.snapshot.settings,
        catalog: snapshot.catalog,
      }),
    ];
  }
  const own = (read: (typeof reads)[number]) =>
    read.connection.id === connectionId && read.itemId === itemId;
  const mine = await readUsernames(rt, run.live.document.origin, reads.filter(own));
  if (!mine) return undefined;
  const shape = usernameShape(rt, { complete: true }, mine);
  const others = await readUsernames(
    rt,
    run.live.document.origin,
    reads.filter((read) => !own(read)),
  );
  if (!others) {
    mine.fill("");
    return undefined;
  }
  return { usernames: [...mine, ...others], shape };
}

/**
 * The page's description for the judge, on `path`, with the usernames of the items that
 * match it and the login's own hidden; or why it is not sent (`unsent`), or nothing when
 * the run was superseded meanwhile.
 */
export async function describeForJudge(
  rt: Runtime,
  run: Execution,
  path: string,
): Promise<
  | {
      observation: LoginObservation;
      disabledLeftOut: boolean;
      inputLeftOut: boolean;
      usernameShape?: ValueShape;
    }
  | { unsent: string }
  | undefined
> {
  let observation: LoginObservation | undefined;
  let unsent = "unreachable";
  let disabledLeftOut = false;
  let inputLeftOut = false;
  try {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(rt, run.live, { type: "login.extract", page: "signed-in" }),
    );
    const parsed =
      extracted.success && extracted.output.ok
        ? v.safeParse(loginObservationSchema, extracted.output.observation)
        : undefined;
    if (!extracted.success || !parsed?.success)
      unsent = extracted.success && !extracted.output.ok ? extracted.output.reason : "invalid-page";
    else if (!parsed.output.complete)
      unsent = (extracted.output.ok && extracted.output.gap) || "incomplete";
    else if (
      parsed.output.origin !== run.live.document.origin ||
      // The description carries the path with any token-like segment replaced.
      parsed.output.path !== observedPath(path)
    )
      unsent = "page-changed";
    else {
      observation = parsed.output;
      disabledLeftOut = extracted.output.ok && extracted.output.disabledLeftOut === true;
      inputLeftOut = extracted.output.ok && extracted.output.inputLeftOut === true;
    }
  } catch {
    // The page could not be asked: `unreachable`.
  }
  if (!current(rt, run)) return undefined;
  if (!observation) return { unsent };
  // A judged page can show the identifier just entered: the usernames of the items that
  // match it, and the login's own, are hidden first.
  const usernames = await judgedUsernames(rt, run).catch(() => undefined);
  const hidden = hideUsernames(rt, observation, usernames?.usernames, run.live);
  if (!current(rt, run)) return undefined;
  if ("reason" in hidden) return { unsent: hidden.reason };
  return {
    observation: hidden.observation,
    disabledLeftOut,
    inputLeftOut,
    ...(usernames?.shape ? { usernameShape: usernames.shape } : {}),
  };
}

/**
 * Sends the page a login ended on, once its recipe's signed-in marker completed it with no
 * model call in the login, as a sample for evaluation (ADR 0029, owner 2026-10-18 08:05
 * UTC): described as for the judge, with the same usernames hidden, at most once in 30
 * days per recipe and branch on this device. It runs in the background after the login
 * ended and never changes it, its badge or its timing; any failure only loses the sample.
 * Conservatively (agent's choice), a login that sent a page to the judge or for
 * continuation, was watched or settled as unknown before, was in a frame, filled only, or
 * stopped at a missing password, is never sampled, nor is a page described with a
 * disabled field left out, or a site excluded since the login started.
 */
export function sampleSignedIn(
  rt: Runtime,
  run: Execution,
  before: LoginAttemptMetadata,
  path: string,
): void {
  const { metadata, recipe, live } = run;
  const sample = rt.generation?.samplePage?.bind(rt.generation);
  if (
    !sample ||
    !current(rt, run) ||
    metadata.state !== "authenticated" ||
    metadata.outcome !== "authenticated" ||
    metadata.unconfirmed ||
    before.state === "authenticated" ||
    live.document.frameId !== 0 ||
    metadata.pageOrigin !== undefined ||
    live.document.origin !== recipe.origin ||
    before.fillOnly ||
    before.judged !== undefined ||
    before.watch !== undefined ||
    before.settled ||
    before.stopAt !== undefined ||
    before.stopJudged ||
    before.continuation !== undefined
  )
    return;
  const branch = branchOf(metadata);
  const reportSample = (
    outcome: Extract<LoginReport, { type: "sample" }>["outcome"],
    reason?: string,
  ) =>
    report(rt, live.document, {
      type: "sample",
      tabId: live.document.tabId,
      origin: live.document.origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      route: metadata.route,
      outcome,
      ...(reason ? { reason } : {}),
    });
  /**
   * Why the sample is not sent: the site is paused, as when a pause or an exclusion rule
   * started meanwhile, since a paused site sends no page (ADR 0062).
   */
  const excluded = async (): Promise<string | undefined> => {
    const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return "settings-unavailable";
    return (await pauseOf(rt, live)) ? "paused" : undefined;
  };
  /** The page as the judge would get it, while it is still the one the login ended on. */
  const describe = async (): Promise<
    { observation: LoginObservation; slots: SemanticSlot[] } | { unsent: string }
  > => {
    const ended = () =>
      current(rt, run) && run.metadata.id === metadata.id && run.metadata.state === "authenticated";
    if (!ended()) return { unsent: "page-changed" };
    const stop = await excluded();
    if (stop) return { unsent: stop };
    if (!ended()) return { unsent: "page-changed" };
    const described = await describeForJudge(rt, run, path);
    if (!described || !ended()) return { unsent: "page-changed" };
    if ("unsent" in described) return described;
    if (described.disabledLeftOut) return { unsent: "disabled-left-out" };
    // The account's slots, as the judge request would carry them (owner 2026-10-23).
    const judged = await judgeSlots(rt, live.document.origin, metadata.account, metadata.route, {
      usernameShape: described.usernameShape,
    });
    if (!ended()) return { unsent: "page-changed" };
    return { observation: described.observation, slots: judged.slots };
  };
  void sample(
    {
      recipeId: recipe.id,
      revision: recipe.revision,
      // As the judge is told it (`learn`).
      route:
        metadata.route === "passkey" && passkeyAnswersRequest(recipe) ? "password" : metadata.route,
      ...(branch ? { branch } : {}),
    },
    describe,
    // A pause started while the page was described or the sample recorded still stops it.
    async () => {
      const stop = await excluded();
      if (!stop) reportSample("sent");
      return stop;
    },
  )
    .then((answer) =>
      answer.outcome === "not-due"
        ? undefined
        : reportSample(answer.outcome, "reason" in answer ? answer.reason : undefined),
    )
    .catch(() => undefined);
}

/**
 * Whether this attempt has sent the account's credential (ADR 0065): its latest effect
 * step submitted, after a route step that typed the password or a second factor's
 * handler (a handler missing from the recipe does not count). The page after an
 * identifier's Next, or after a `password` handler's button, is no page after the
 * sign-in. The `passkey` route never completes on an optional page (ADR 0027), so its
 * own step does not count.
 */
export function credentialSent(_rt: Runtime, run: Execution): boolean {
  const { metadata, recipe } = run;
  if (metadata.operationEffect !== "submit") return false;
  const ran = metadata.operationId === undefined ? metadata.stepIndex : metadata.stepIndex + 1;
  return (attemptPlan(recipe, metadata) ?? [])
    .slice(0, ran)
    .some((entry) =>
      entry.handler === undefined
        ? entry.step.kind === "fill" && entry.step.fields.some((field) => field.slot === "password")
        : ![undefined, "password"].includes(recipe.handlers?.[entry.handler]?.kind),
    );
}

export async function learn(
  rt: Runtime,
  run: Execution,
  reading?: SignInReading,
): Promise<boolean> {
  const { recipe, metadata } = run;
  const { operationId } = metadata;
  // A login watched at its stop has no step in flight; its watch's pages are judged as any
  // watched login's are (ADR 0036, ADR 0027).
  const stopWatched = watchedAtStop(metadata);
  if (!rt.generation || (!stopWatched && (!effectful(metadata) || !operationId))) return false;
  const notSent = (reason: string) => notJudged(rt, run, reason);
  if (pagesLeft(metadata, operationId) <= 0) return notSent("page-limit");
  // Every variant's fill fields and paths count, as on the service, which is never told
  // the variant; on the passkey route, its button and the password form, on its path and
  // the password route's (ADR 0027).
  const paths = routeSignInPaths(recipe, metadata.route);
  const marker = (recipe.completion ?? [])
    .filter((entry) => entry.origin === undefined)
    .map((entry) => entry.target);
  const fills = routeSignInTargets(recipe, metadata.route).slice(0, 24 - marker.length);
  // A hidden marker proves nothing and does not keep the page from the judge.
  const remaining = await observe(
    rt,
    run,
    [...fills, ...marker],
    [
      ...fills.map((target) => (passkeyButton(rt, run, target) ? "present" : "input")),
      ...marker.map(() => "shown" as const),
    ],
    marker.length > 0
      ? {
          links: [...fills.map(() => false), ...marker.map(() => true)],
          hidden: [...fills.map(() => false), ...marker.map(() => true)],
        }
      : {},
  );
  if (!remaining) {
    // A superseded run or a refused one (logged with its own cause) says nothing here.
    if (current(rt, run) && !terminal(run.metadata)) notSent("unreachable");
    return false;
  }
  // A route's sign-in field shows on another path too (S1): such a page is never complete
  // (ADR 0029), and the description may leave the field out when no locator names it.
  const fieldShown =
    paths.includes(remaining.path) &&
    remaining.targets
      .slice(0, fills.length)
      .some((state) => state !== "missing" && state !== "unusable");
  // One on a route path of a password login without a chooser or a stop, read in the tab's
  // top document on the recipe's own origin, may stand beside another form that asks for
  // a detail, which is judged on its own (ADR 0061); a failure shown beside the sign-in
  // form never is, nor a page whose sign-in state was not read.
  const besideCandidate =
    fieldShown &&
    reading !== undefined &&
    reading.decision !== "rejected" &&
    metadata.route === "password" &&
    !metadata.chooser &&
    metadata.stopAt === undefined &&
    metadata.pageOrigin === undefined &&
    run.live.document.frameId === 0 &&
    run.live.topUrl === undefined &&
    run.live.document.origin === recipe.origin;
  if (
    !besideCandidate &&
    (reading?.decision === "unknown" || reading?.decision === "rejected" || fieldShown)
  )
    return notSent("sign-in-shown");
  // A marker shows, but the completion check did not prove the sign-in: more than one
  // match, or an element it needs gone is there.
  if (
    remaining.targets
      .slice(fills.length)
      .some((state) => state === "unique" || state === "ambiguous")
  )
    return notSent("marker-shown");
  const described = await describeForJudge(rt, run, remaining.path);
  if (!described) return true;
  // A page that cannot be described completely is not sent and does not count.
  if ("unsent" in described) return notSent(besideCandidate ? "sign-in-shown" : described.unsent);
  const { observation, disabledLeftOut, inputLeftOut, usernameShape: shape } = described;
  // The sign-in form beside another form with a text-like input and its own button, on a
  // path without a `detail` handler, as the service checks (ADR 0061); otherwise the page
  // is still the sign-in page.
  const beside =
    besideCandidate &&
    showsBesideForm(observation, routeFillTargets(recipe, "password")) &&
    !(recipe.handlers ?? []).some(
      (handler) => handler.kind === "detail" && handler.path === observation.path,
    );
  if (besideCandidate && !beside) return notSent("sign-in-shown");
  const left = pagesLeft(run.metadata, operationId);
  await change(rt, run, { type: "JUDGING", operationId });
  if (!current(rt, run)) return true;
  if (pagesLeft(run.metadata, operationId) !== left - 1) return false;
  // The account's slots go with the page, as with a generation request (owner 2026-10-23).
  const judged = await judgeSlots(rt, run.live.document.origin, metadata.account, metadata.route, {
    usernameShape: shape,
  });
  if (!current(rt, run)) return true;
  const watchedPage = run.metadata.watch !== undefined;
  // The answer's timing, once it came (ADR 0019).
  let timed: { timing?: ServiceTiming } = {};
  const reportJudge = (
    verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
    detail: {
      reason?: string;
      takenOver?: boolean;
      completed?: true;
      notCompleted?: "disabled-left-out" | "password-empty";
    } = {},
  ) =>
    report(rt, run.live.document, {
      type: "judge",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      route: metadata.route,
      verdict,
      ...detail,
      ...(watchedPage ? { watched: true as const } : {}),
      ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
      ...(beside ? { beside: true as const } : {}),
      ...timed,
    });
  // The login's layout and chooser branch (ADR 0060), and whether the description left a
  // disabled field out (ADR 0029). The account's slots go after them, and `beside` only
  // for a page beside the sign-in form (ADR 0061).
  const branch = branchOf(metadata);
  const spin = spinning(rt, run.live.document.tabId);
  const asked = Date.now();
  const {
    verdict,
    reason,
    recipe: added,
    questions,
    timing,
  } = await rt.generation
    .judge(
      recipe.id,
      recipe.revision,
      // The service knows no `passkey` route on a recipe without its button; the page's
      // own request is answered beside the password form, which the service checks for
      // that route the same way (ADR 0034).
      metadata.route === "passkey" && passkeyAnswersRequest(recipe) ? "password" : metadata.route,
      observation,
      spin.sent(() => reportJudge("sent")),
      branch,
      disabledLeftOut ? true : undefined,
      undefined,
      judged.slots,
      ...(beside ? [true as const] : []),
    )
    .finally(spin.stop);
  // The judge's pairings of the page's secret questions with the account's fields, kept
  // for the popup to propose, never to fill from (ADR 0061).
  const paired = pairedQuestions(remaining.path, questions, judged.offers);
  if (paired) run.paired = paired;
  else delete run.paired;
  spend(rt, metadata.id, Date.now() - asked, timing);
  if (timing) timed = { timing };
  if (!current(rt, run)) {
    reportJudge(verdict, {
      ...(reason ? { reason } : {}),
      ...(added ? { takenOver: false } : {}),
    });
    return true;
  }
  // A temporary refusal, such as a busy service, gives the page back.
  if (verdict === "retry") await change(rt, run, { type: "UNJUDGED", operationId });
  // A page with no sign and no evidence completes when the judge cannot decide, unless
  // the login is watched (ADR 0027); one with a sign of another sign-in step goes to the
  // person, as does a page judged `challenge` before (ADR 0029). An optional page after
  // the sign-in completes as signed in, watched or not, and is left as it is (ADR 0065),
  // but only on the `password` route once this attempt sent the credential, without a
  // stop before a missing password and with no radio button, select or text area left
  // out of its description; on the same path once read again.
  const sent = credentialSent(rt, run);
  const candidate = undecidedCandidate({
    verdict,
    reason,
    reading,
    watched: run.metadata.watch !== undefined,
    route: run.metadata.route,
    stopAt: run.metadata.stopAt,
    sent,
    inputLeftOut,
    answered: passkeyStepAnswered(rt, run),
  });
  let again: Awaited<ReturnType<typeof readSignInState>>;
  // The judge's answer can take a while: the page completes only if, once the answer is
  // back, it has loaded and still shows no sign of a sign-in going on.
  if (candidate.completes) {
    again = await readSignInState(rt, run);
    if (!current(rt, run)) {
      reportJudge(verdict, { ...(reason ? { reason } : {}) });
      return true;
    }
  }
  const { completes, notCompleted } = settleCompletion({
    ...candidate,
    again,
    disabledLeftOut,
    // Only an optional page must still be on its path: an undecided one keeps ADR 0029's
    // rule, as on a single-page app that routes on while it is judged.
    ...(verdict === "optional" ? { path: remaining.path } : {}),
  });
  // Reported before the takeover's own entries, once whether it is taken over is known.
  let reported = false;
  // A watched login only reads its pages; it never runs a learned handler (ADR 0027).
  const movedOn =
    verdict === "challenge" &&
    added !== undefined &&
    run.metadata.state !== "watching" &&
    current(rt, run) &&
    (await takeOver(rt, run, added, remaining.path, () => {
      reported = true;
      reportJudge(verdict, { takenOver: true });
    }));
  if (!reported)
    reportJudge(verdict, {
      ...(reason ? { reason } : {}),
      ...(added ? { takenOver: false } : {}),
      ...(completes ? { completed: true } : {}),
      ...(notCompleted ? { notCompleted } : {}),
    });
  if (movedOn || !current(rt, run)) return true;
  const { result, confirmed } = judgedCompletionResult({
    verdict,
    reason,
    reading,
    completes,
    stopHeld: candidate.stopHeld,
    route: run.metadata.route,
    stopAt: run.metadata.stopAt,
    sent,
  });
  // The page after the final advance before a stop just past the plan's last step, not
  // found signed in or rejected and with no handler taken over, takes the login to its
  // stop, where the page's passkey request is answered (ADR 0036).
  if (result === "challenge" && (await toStop(rt, run))) return true;
  // A login watched at its stop submitted no password, so a page judged rejected refuses
  // none: the login stays watched (ADR 0036).
  if (stopWatched && result === "credential-rejected") return true;
  const unconfirmed = result === "authenticated" && !confirmed;
  if (unconfirmed) delete run.choice;
  await change(rt, run, {
    type: "OBSERVED",
    result,
    document: run.live.document,
    ...(unconfirmed ? { unconfirmed: true } : {}),
  });
  return true;
}
