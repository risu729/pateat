import {
  loginMethodList,
  loginMethodSuspect,
  missedLoginMethod,
  type LoginAttemptMetadata,
  type LoginMethod,
  type LoginMethodWhy,
} from "@pateat/contracts";
import { RESULT_CORRECTION_MS } from "./constants";
import type { RouteChange } from "./report";
import type { Runtime } from "./state";

/**
 * Which sign-in method a login used, beside the methods its vault item holds (ADR 0055 and
 * ADR 0066, amendments of 2026-11-18). A login's record names its route, what it used
 * before it completed and what its item holds, and why it did not use the best of those;
 * a login that passed over a passkey or SSO method for a reason that may be a bug logs a
 * `login.route` warning, which goes to the service with the other problem lines.
 *
 * Kept in memory only, for logins that started in this worker, as the parts of a login's
 * own time are (`spans.ts`): one that a restarted worker resumed names none of them.
 */

/** What made the login take the route it did, read when it started and as it ran. */
export type MethodMarks = {
  /** A fill-only login of a tab that asks (ADR 0021 D). */
  fillOnly?: true;
  /** A page whose sign-in setting fills and leaves the submit to the person (ADR 0035). */
  signInFill?: true;
  /** The person picked the method in the popup (ADR 0085). */
  picked?: true;
  /** The site refused the item's passkey, and the chooser picked again without it. */
  passkeyRefused?: true;
  /** The login started at a later step, past the first page's passkey button (ADR 0049). */
  later?: true;
  /** Why the login went back from the passkey to the password (ADR 0034). */
  routeChange?: Exclude<RouteChange, "page-request" | "passkey-button">;
};

type Kept = {
  held: Set<LoginMethod>;
  used: Set<LoginMethod>;
  marks: MethodMarks;
};

/** What an ended login's record and warning name. */
export type AttemptMethods = {
  route: "password" | "passkey" | "sso";
  /** `loginMethodList` of what the login used before it completed. */
  used: string;
  /** `loginMethodList` of what its item holds. */
  held: string;
  /** Why the login did not use a better method its item holds, when it did not. */
  why?: LoginMethodWhy;
};

/** A warning held until a completed login's second factor may still come. */
type Pending = {
  metadata: LoginAttemptMetadata;
  methods: AttemptMethods;
  kept: Kept;
  timer: ReturnType<typeof setTimeout>;
  /** Lets the worker stop again. */
  done: () => void;
};

/** Logins whose methods are kept at once; the oldest goes first. */
const KEPT_ATTEMPTS = 64;

type Tables = { kept: Map<string, Kept>; pending: Map<string, Pending> };
const tables = new WeakMap<Runtime, Tables>();

function tablesOf(rt: Runtime): Tables {
  let found = tables.get(rt);
  if (!found) {
    found = { kept: new Map(), pending: new Map() };
    tables.set(rt, found);
  }
  return found;
}

/**
 * Starts keeping attempt `attemptId`'s methods when its login starts in this worker: what
 * its item holds and why it takes its route. The oldest of more than `KEPT_ATTEMPTS`
 * logins goes first and names none.
 */
export function openMethods(
  rt: Runtime,
  attemptId: string,
  held: Iterable<LoginMethod>,
  marks: MethodMarks = {},
  used: Iterable<LoginMethod> = [],
): void {
  const { kept } = tablesOf(rt);
  kept.delete(attemptId);
  kept.set(attemptId, { held: new Set(held), used: new Set(used), marks: { ...marks } });
  for (const old of kept.keys()) {
    if (kept.size <= KEPT_ATTEMPTS) break;
    kept.delete(old);
  }
}

/** The login went back from its passkey to its password (ADR 0034), for this reason. */
export function methodRouteChanged(
  rt: Runtime,
  attemptId: string,
  routeChange: Exclude<RouteChange, "page-request" | "passkey-button">,
): void {
  const found = tablesOf(rt).kept.get(attemptId);
  if (found) found.marks.routeChange = routeChange;
}

/**
 * The login used `method`: it submitted the item's password, or answered its page with the
 * item's passkey. A passkey answered soon after a login completed, before its warning was
 * written, is its second factor, as on a site that asks for a security key after the
 * password: the warning is then left out.
 */
export function methodUsed(rt: Runtime, attemptId: string, method: LoginMethod): void {
  const { kept, pending } = tablesOf(rt);
  kept.get(attemptId)?.used.add(method);
  const waiting = pending.get(attemptId);
  if (!waiting) return;
  waiting.kept.used.add(method);
  clearTimeout(waiting.timer);
  pending.delete(attemptId);
  waiting.done();
  writeWarning(rt, waiting.metadata, summary(waiting.metadata, waiting.kept));
}

/** Why a login did not use `missed`, from what it saw. */
function whyOf(
  metadata: LoginAttemptMetadata,
  marks: MethodMarks,
  missed: Exclude<LoginMethod, "password">,
): LoginMethodWhy {
  if (marks.fillOnly) return "fill-only";
  if (marks.signInFill) return "sign-in-fill";
  if (marks.picked) return "picked";
  if (missed === "sso") return metadata.route === "password" ? "sso-not-automatic" : "unknown";
  if (marks.routeChange) return marks.routeChange;
  // The login took the passkey's own route, or went on after its passkey button to the
  // step asking for the account (ADR 0060 amendment of 2026-11-18), and ended before an
  // answer: it passed nothing over, and its own line says how it ended.
  if (metadata.route === "passkey" || metadata.passkeyButton) return "not-answered";
  if (marks.passkeyRefused) return "passkey-refused";
  if (marks.later) return "later-start";
  return metadata.route === "password" ? "no-passkey-route" : "unknown";
}

/**
 * Ends that say nothing of the method: the person's cancel, a change of settings, vault or
 * account, a page that left the origin, or a list without the account. They warn of none.
 */
const QUIET_OUTCOMES: ReadonlySet<string> = new Set([
  "cancelled",
  "policy-changed",
  "account-switched",
  "wrong-account",
  "account-not-listed",
  "left-origin",
]);

function summary(metadata: LoginAttemptMetadata, kept: Kept): AttemptMethods {
  const held = [...kept.held];
  const used = [...kept.used];
  const missed = missedLoginMethod(held, used);
  return {
    route: metadata.route,
    used: loginMethodList(used),
    held: loginMethodList(held),
    ...(missed ? { why: whyOf(metadata, kept.marks, missed) } : {}),
  };
}

function writeWarning(rt: Runtime, metadata: LoginAttemptMetadata, methods: AttemptMethods) {
  if (!methods.why || !warns(metadata, methods)) return;
  try {
    rt.options.report?.({
      type: "route",
      tabId: metadata.document.tabId,
      origin: metadata.document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
      ...(metadata.layout === undefined ? {} : { layout: metadata.layout }),
      route: methods.route,
      used: methods.used,
      held: methods.held,
      why: methods.why,
      ...(metadata.outcome ? { outcome: metadata.outcome } : {}),
    });
  } catch {
    // A report must never change the login.
  }
}

function warns(metadata: LoginAttemptMetadata, methods: AttemptMethods): boolean {
  return (
    !!methods.why && loginMethodSuspect(methods.why) && !QUIET_OUTCOMES.has(metadata.outcome ?? "")
  );
}

/** Drops attempt `attemptId`'s methods, as for an SSO hop's own login, which has no record. */
export function dropMethods(rt: Runtime, attemptId: string): void {
  tablesOf(rt).kept.delete(attemptId);
}

/**
 * Attempt `metadata.id`'s methods, taken once when its login ended, for its record; nothing
 * for a login whose methods were not kept. A login that passed over a better method for a
 * reason that may be a bug logs a `login.route` warning: at once when it did not sign in,
 * else once its second factor can no longer come (`RESULT_CORRECTION_MS`), or a passkey
 * answered before that shows it came.
 */
export function takeMethods(
  rt: Runtime,
  metadata: LoginAttemptMetadata,
): AttemptMethods | undefined {
  const { kept, pending } = tablesOf(rt);
  const found = kept.get(metadata.id);
  if (!found) return undefined;
  kept.delete(metadata.id);
  // An item that holds no method Pateat can use here, as one with only a passkey that is
  // not discoverable, names none.
  if (!found.held.size) return undefined;
  const methods = summary(metadata, found);
  if (!warns(metadata, methods)) return methods;
  if (metadata.state !== "authenticated") {
    writeWarning(rt, metadata, methods);
    return methods;
  }
  let done = () => {};
  // The worker stays up for the window, as a stopped one would lose the warning.
  try {
    rt.options.keepAlive?.(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
  } catch {
    // Keeping the worker up never changes the login.
  }
  const timer = setTimeout(() => {
    const waiting = pending.get(metadata.id);
    if (!waiting) return;
    pending.delete(metadata.id);
    waiting.done();
    writeWarning(rt, waiting.metadata, waiting.methods);
  }, RESULT_CORRECTION_MS);
  pending.set(metadata.id, { metadata, methods, kept: found, timer, done });
  for (const [old, waiting] of pending) {
    if (pending.size <= KEPT_ATTEMPTS) break;
    clearTimeout(waiting.timer);
    pending.delete(old);
    waiting.done();
    writeWarning(rt, waiting.metadata, waiting.methods);
  }
  return methods;
}

/**
 * A completed login's result was corrected (ADR 0029, amended 2026-11-03): its warning,
 * if still held, names the corrected outcome.
 */
export function methodsCorrected(rt: Runtime, metadata: LoginAttemptMetadata): void {
  const waiting = tablesOf(rt).pending.get(metadata.id);
  if (waiting) waiting.metadata = metadata;
}
