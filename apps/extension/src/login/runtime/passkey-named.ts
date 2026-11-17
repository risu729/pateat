import type { LoginDocument } from "@pateat/contracts";
import { observedPath } from "../../observation/path";
import { terminal, idle } from "./attempt-state";
import { AFTER_SIGN_IN_MS } from "./constants";
import { routesOf } from "./generation-scope";
import { frameKey } from "./steps";
import type { ParkedRequest } from "./types";
import type { Runtime } from "./state";

// A conditional request that names its credentials on a path where no recipe starts (ADR
// 0034 amendment of 2026-11-17, #1673): answered by the passkey it names only when its page
// follows the person's sign-in step in its tab, and no login of the tab answers it.

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
  const [starts, routes] = await Promise.all([
    signInStartsOn(rt, origin, path),
    routesOf(rt, origin),
  ]);
  if (starts !== false || !routes) return true;
  return routes.some((recipe) => recipe.steps[0] !== undefined && on(recipe.steps[0].path));
}

/**
 * Whether a person's sign-in step of the origin shows on `path`: a recipe's or chooser's
 * start, a later step a login may start at (ADR 0049) or a sign-in entry (ADR 0031);
 * `undefined` when the origin's recipes cannot be read.
 */
async function signInStartsOn(
  rt: Runtime,
  origin: string,
  path: string,
): Promise<boolean | undefined> {
  const on = (other: string) => comparable(other) === comparable(path);
  const [starts, entries] = await Promise.all([
    rt.recipes.starts(origin).catch(() => undefined),
    rt.recipes.entries(origin).catch(() => undefined),
  ]);
  if (!starts || !entries) return undefined;
  return (
    starts.some((start) => on(start.path) || start.later?.some((step) => on(step.path))) ||
    entries.some((entry) => on(entry.entry.path))
  );
}

/** Whether a login of the tab runs, which a named request leaves its answer to. */
export function tabLoginRuns(rt: Runtime, tabId: number): boolean {
  const run = rt.attempts.get(tabId);
  return run !== undefined && !terminal(run.metadata) && !idle(run.metadata);
}

/**
 * Whether the tab's page of `documentId` is, or will be when it announces, the page right
 * after a sign-in form the person submitted on the origin (ADR 0028): a request of an origin
 * without a recipe may follow only such a step.
 */
export function afterSubmit(
  rt: Runtime,
  tabId: number,
  origin: string,
  documentId: string,
): boolean {
  if (rt.afterSignIn.get(tabId) === documentId) return true;
  const submitted = rt.signInSubmits.get(tabId);
  return (
    submitted !== undefined &&
    submitted.origin === origin &&
    submitted.documentId !== documentId &&
    Date.now() - submitted.at < AFTER_SIGN_IN_MS
  );
}

/**
 * Whether a waiting request's page follows the person's sign-in step on its origin in its
 * tab, as the owner's decision has it ("after the email is entered"): its page announced
 * as the page right after a submitted sign-in form (ADR 0028), or the tab's page before it
 * on the origin showed a recipe's start, a later step or a sign-in entry. A page that has
 * not announced, or recipes that cannot be read, follow none.
 */
export async function followsSignIn(rt: Runtime, parked: ParkedRequest): Promise<boolean> {
  const live = rt.documents.get(frameKey({ tabId: parked.tabId, frameId: 0 }));
  if (live?.document.documentId !== parked.documentId || live.document.origin !== parked.origin)
    return false;
  if (rt.afterSignIn.get(parked.tabId) === parked.documentId) return true;
  const previous = live.previousUrl === undefined ? null : URL.parse(live.previousUrl);
  if (previous?.origin !== parked.origin) return false;
  return (await signInStartsOn(rt, parked.origin, observedPath(previous.pathname))) === true;
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
 * Decides a named request no login took: answered by the passkey it names when its page
 * follows the person's sign-in step, handed on as `no-login` otherwise. A login that started
 * while that was read leaves the request to `reviewRequests`.
 */
export async function decideNamed(rt: Runtime, parked: ParkedRequest): Promise<void> {
  if (parked.deciding) return;
  parked.deciding = true;
  const follows = await followsSignIn(rt, parked).catch(() => false);
  delete parked.deciding;
  if (
    !rt.parkedRequests.has(parked) ||
    parked.during ||
    tabLoginRuns(rt, parked.tabId) ||
    rt.attempts.get(parked.tabId)?.live.document.documentId === parked.documentId
  )
    return;
  parked.settle(
    follows ? { kind: "named" } : { kind: "delegate", reason: "no-login", named: true },
  );
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
 * `documentId`, still holds: a named request there is a re-verification (ADR 0035).
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
