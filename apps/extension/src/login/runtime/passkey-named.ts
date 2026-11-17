import type { LoginDocument } from "@pateat/contracts";
import { terminal } from "./attempt-state";
import { PERSON_STEP_MS, REQUEST_PARK_MS } from "./constants";
import { routesOf } from "./generation-scope";
import { frameKey } from "./steps";
import type { ParkedRequest, PersonStep } from "./types";
import type { Runtime } from "./state";

// A conditional request that names its credentials on a path where no recipe starts (ADR
// 0034 amendment of 2026-11-17, #1673): answered by the passkey it names only right after
// the person's own sign-in step in its tab, and when no login of the tab answers it.

/** A path as a request's is compared: one trailing `/` does not count. */
export const comparable = (path: string) =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * Whether a recipe of the origin starts on `path`, as admission reads it: a login recipe's
 * or chooser's start, a later step a login may start at (ADR 0049), a sign-in entry (ADR
 * 0031), or the first page of a recipe generated as `confirm` or `unclear` (ADR 0035). A
 * path that is not known, or recipes that cannot be read, count as one.
 */
export async function recipeOnPath(
  rt: Runtime,
  origin: string,
  path: string | undefined,
): Promise<boolean> {
  if (path === undefined) return true;
  const on = (other: string) => comparable(other) === comparable(path);
  const [starts, entries, routes] = await Promise.all([
    rt.recipes.starts(origin).catch(() => undefined),
    rt.recipes.entries(origin).catch(() => undefined),
    routesOf(rt, origin),
  ]);
  if (!starts || !entries || !routes) return true;
  return (
    starts.some((start) => on(start.path) || start.later?.some((step) => on(step.path))) ||
    entries.some((entry) => on(entry.entry.path)) ||
    routes.some((recipe) => recipe.steps[0] !== undefined && on(recipe.steps[0].path))
  );
}

/** Whether a login of the tab runs, or is watched, which a named request leaves its answer to. */
export function tabLoginRuns(rt: Runtime, tabId: number): boolean {
  const run = rt.attempts.get(tabId);
  return run !== undefined && !terminal(run.metadata) && run.metadata.settled !== true;
}

/**
 * Records the person's own sign-in step in the tab's top document on `path`, the latest
 * per tab and origin (ADR 0034 amendment of 2026-11-17). A frame's step is none.
 */
export function personStepped(rt: Runtime, document: LoginDocument, path: string): void {
  if (document.frameId !== 0) return;
  rt.personSteps.set(`${document.tabId} ${document.origin}`, {
    documentId: document.documentId,
    path,
    at: Date.now(),
  });
}

/**
 * The tab's step on an origin, forgotten once no request can follow it any more: one that
 * came within `PERSON_STEP_MS` of it waits at most `REQUEST_PARK_MS`.
 */
function stepOf(rt: Runtime, key: string): PersonStep | undefined {
  const step = rt.personSteps.get(key);
  if (step && Date.now() - step.at >= PERSON_STEP_MS + REQUEST_PARK_MS) {
    rt.personSteps.delete(key);
    return undefined;
  }
  return step;
}

/** A top document of the tab announced: the first of its origin after a step is its next. */
export function personStepNext(rt: Runtime, document: LoginDocument): void {
  if (document.frameId !== 0) return;
  const step = stepOf(rt, `${document.tabId} ${document.origin}`);
  if (step && step.next === undefined && step.documentId !== document.documentId)
    step.next = document.documentId;
}

/**
 * The person's own sign-in step a named request follows, if one does: the tab's step on the
 * request's origin less than `PERSON_STEP_MS` before the request, made in the request's
 * document on another path, or in the document before it, the request's being the tab's
 * next top document of the origin after the step. A request of a document after a step
 * that no other document followed yet is that next document.
 */
export function personStepFor(
  rt: Runtime,
  request: { tabId: number; origin: string; documentId: string; path?: string; since: number },
): PersonStep | undefined {
  const step = stepOf(rt, `${request.tabId} ${request.origin}`);
  if (!step) return undefined;
  // A clock set back counts nothing.
  const age = request.since - step.at;
  if (age < 0 || age >= PERSON_STEP_MS) return undefined;
  if (step.documentId === request.documentId)
    return request.path !== undefined && comparable(request.path) !== comparable(step.path)
      ? step
      : undefined;
  step.next ??= request.documentId;
  return step.next === request.documentId ? step : undefined;
}

/**
 * Whether a waiting request's own page announced on the path it came on, with no sign-in
 * on it, and its admission is over: no login of its document can start there, so the
 * request need not wait for one.
 */
export function announcedWithoutStart(rt: Runtime, parked: ParkedRequest): boolean {
  const live = rt.documents.get(frameKey({ tabId: parked.tabId, frameId: 0 }));
  return (
    live?.document.documentId === parked.documentId &&
    live.document.origin === parked.origin &&
    live.shownAt === undefined &&
    !rt.admitting.has(`${parked.tabId}:0`) &&
    parked.path !== undefined &&
    comparable(live.path) === comparable(parked.path)
  );
}

/**
 * Decides a named request no login took, from what is already known: answered by the
 * passkey it names when it follows the person's own sign-in step, which that answer uses
 * up, and handed on as `no-login` otherwise.
 */
export function decideNamed(rt: Runtime, parked: ParkedRequest): void {
  const step = personStepFor(rt, parked);
  if (!step) {
    parked.settle({ kind: "delegate", reason: "no-login", named: true });
    return;
  }
  const key = `${parked.tabId} ${parked.origin}`;
  if (parked.settle({ kind: "named" }) && rt.personSteps.get(key) === step)
    rt.personSteps.delete(key);
}

/**
 * A recipe's first step showed in the tab again, outside the page a passkey answer outside
 * a login signed in: as a logout forgets a login's record (ADR 0062), that sign-in no longer
 * makes a named request of the tab a re-verification (ADR 0035).
 */
export function passkeySignInLeft(rt: Runtime, document: LoginDocument): void {
  const key = `${document.tabId} ${document.origin}`;
  const answer = rt.passkeyAnswers.get(key);
  if (answer?.signedIn === undefined) return;
  const top =
    document.frameId === 0
      ? document.documentId
      : rt.documents.get(frameKey({ tabId: document.tabId, frameId: 0 }))?.document.documentId;
  if (answer.signedIn === top) return;
  const { signedIn: _signedIn, ...rest } = answer;
  rt.passkeyAnswers.set(key, rest);
}

/**
 * Whether a sign-in a passkey answer outside a login made in the tab, on another page than
 * `documentId`, still holds: a named request there is a re-verification (ADR 0035). Kept in
 * memory per tab and origin, so a worker restart forgets it.
 */
export function passkeySignedIn(
  rt: Runtime,
  tabId: number,
  siteOrigin: string,
  documentId: string | undefined,
): boolean {
  const signedIn = rt.passkeyAnswers.get(`${tabId} ${siteOrigin}`)?.signedIn;
  return signedIn !== undefined && signedIn !== documentId;
}
