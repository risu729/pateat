import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import {
  LOGIN_METHODS,
  loginMethodList,
  loginMethodSuspect,
  missedLoginMethod,
  type LoginAttemptMetadata,
  type LoginMethod,
  type LoginMethodWhy,
} from "@pateat/contracts";
import { RESULT_CORRECTION_MS } from "./constants";
import type { RouteChange } from "./report";
import { METHODS_KEY } from "./session-schemas";
import type { Runtime } from "./state";

/**
 * Which sign-in method a login used, beside the methods its vault item holds (ADR 0055 and
 * ADR 0066, amendments of 2026-11-18). A login's record names its route, what it used
 * before it completed and what its item holds, and why it did not use the best of those;
 * a login that passed over a passkey or SSO method for a reason that may be a bug logs a
 * `login.route` warning, which goes to the service with the other problem lines.
 *
 * Kept for the logins that started in this worker, and in session storage
 * (`METHODS_KEY`), so a login a restarted worker ends still names them, as one whose result
 * stayed watched long after the worker stopped (USI, 2026-11-18). A warning held for a
 * second factor is kept in memory only, with the worker kept up for it.
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

type Tables = {
  kept: Map<string, Kept>;
  pending: Map<string, Pending>;
  /** The last write of `kept` to session storage; each write follows the one before. */
  saving: Promise<void>;
  /** What a stopped worker stored, read before this worker writes anything. */
  stored?: Promise<unknown>;
};
const tables = new WeakMap<Runtime, Tables>();

function tablesOf(rt: Runtime): Tables {
  let found = tables.get(rt);
  if (!found) {
    found = { kept: new Map(), pending: new Map(), saving: Promise.resolve() };
    tables.set(rt, found);
  }
  return found;
}

const loginMethodSchema = v.picklist(LOGIN_METHODS);
const keptMethodsSchema = v.pipe(
  v.array(
    v.strictObject({
      attemptId: v.pipe(v.string(), v.maxLength(64)),
      held: v.pipe(v.array(loginMethodSchema), v.maxLength(LOGIN_METHODS.length)),
      used: v.pipe(v.array(loginMethodSchema), v.maxLength(LOGIN_METHODS.length)),
      marks: v.strictObject({
        fillOnly: v.exactOptional(v.literal(true)),
        signInFill: v.exactOptional(v.literal(true)),
        picked: v.exactOptional(v.literal(true)),
        passkeyRefused: v.exactOptional(v.literal(true)),
        later: v.exactOptional(v.literal(true)),
        routeChange: v.exactOptional(
          v.picklist(["request-missing", "answer-failed", "sign-in-rejected", "sign-in-shown"]),
        ),
      }),
    }),
  ),
  v.maxLength(KEPT_ATTEMPTS),
);

/**
 * Writes the kept methods to session storage, as they are when the write runs. Never
 * throws or holds the login: a failed write only loses them after a restart.
 */
function save(rt: Runtime): void {
  const found = tablesOf(rt);
  found.saving = found.saving
    .then(() =>
      storage.setItem(
        METHODS_KEY,
        [...found.kept].map(([attemptId, { held, used, marks }]) => ({
          attemptId,
          held: [...held],
          used: [...used],
          marks,
        })),
      ),
    )
    .catch(() => undefined);
}

/**
 * Reads what a stopped worker kept when this worker starts, before it writes anything, so
 * its first write does not lose it. Never throws.
 */
export function loadMethods(rt: Runtime): void {
  const found = tablesOf(rt);
  const stored = Promise.try(() => storage.getItem(METHODS_KEY)).catch(() => undefined);
  found.stored = stored;
  found.saving = stored.then(() => undefined);
}

/**
 * Takes the methods a stopped worker kept (`loadMethods`) for its logins that still have a
 * record (`attemptIds`), before any of them can end; a login this worker opened meanwhile
 * keeps its own. Never throws.
 */
export async function restoreMethods(rt: Runtime, attemptIds: ReadonlySet<string>): Promise<void> {
  const found = tablesOf(rt);
  const stored = await found.stored;
  delete found.stored;
  const parsed = v.safeParse(keptMethodsSchema, stored ?? []);
  const { kept } = found;
  const restored = new Map<string, Kept>();
  if (parsed.success)
    for (const { attemptId, held, used, marks } of parsed.output)
      if (attemptIds.has(attemptId))
        restored.set(attemptId, { held: new Set(held), used: new Set(used), marks });
  // The restored ones are older than any opened since, so they go first.
  const opened = [...kept];
  kept.clear();
  for (const [attemptId, entry] of [...restored, ...opened]) kept.set(attemptId, entry);
  for (const old of kept.keys()) {
    if (kept.size <= KEPT_ATTEMPTS) break;
    kept.delete(old);
  }
  // Those of logins that ended while the worker was stopped go.
  save(rt);
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
  save(rt);
}

/** The login went back from its passkey to its password (ADR 0034), for this reason. */
export function methodRouteChanged(
  rt: Runtime,
  attemptId: string,
  routeChange: Exclude<RouteChange, "page-request" | "passkey-button">,
): void {
  const found = tablesOf(rt).kept.get(attemptId);
  if (!found) return;
  found.marks.routeChange = routeChange;
  save(rt);
}

/**
 * The login used `method`: it submitted the item's password, or answered its page with the
 * item's passkey. A passkey answered soon after a login completed, before its warning was
 * written, is its second factor, as on a site that asks for a security key after the
 * password: the warning is then left out.
 */
export function methodUsed(rt: Runtime, attemptId: string, method: LoginMethod): void {
  const { kept, pending } = tablesOf(rt);
  const found = kept.get(attemptId);
  if (found && !found.used.has(method)) {
    found.used.add(method);
    save(rt);
  }
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
  if (tablesOf(rt).kept.delete(attemptId)) save(rt);
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
  save(rt);
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
