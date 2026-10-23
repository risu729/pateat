import {
  createAttemptMetadata,
  nextLoginOperation,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
} from "../login-attempt";
import { loginStepEffect, type LoginDocument, type LoginRecipe } from "../login";

// Every state a small login can reach: each event of a fixed set is applied to each reached
// state until no new state appears, and each step is checked against the invariants in
// `broken()`. They must hold in any order of events, which the example tests in
// login-attempt.test.ts cannot show. Synthetic origins and identifiers only.

/** More states than this means a guard stopped bounding the attempt. */
const MAX_STATES = 20_000;

export const page: LoginDocument = {
  origin: "https://bank.example",
  tabId: 7,
  frameId: 0,
  documentId: "document-one",
};
const nextPage = { ...page, documentId: "document-two" };
const otherOrigin = { ...page, origin: "https://idp.example", documentId: "document-three" };

/** A recipe of `page`'s origin with the given steps. */
export const recipeOf = (
  parts: Pick<LoginRecipe, "id" | "slots" | "steps" | "maxSubmissions">,
): LoginRecipe => ({
  version: 1,
  revision: 2,
  origin: page.origin,
  pageKind: "sign-in",
  completion: [{ target: { by: "id", value: "authenticated" } }],
  rejection: { by: "id", value: "rejected" },
  ...parts,
});

type AttemptEvent = Record<string, unknown>;

// Operation IDs are named in the order the attempt uses them, so states that differ only in
// which random ID the runtime picked are the same state here.
const fresh = (metadata: LoginAttemptMetadata) =>
  `operation-${metadata.usedOperationIds.length + 1}`;

/** The events that name operation `operationId`. */
function operationEvents(operationId: string): AttemptEvent[] {
  return [
    { type: "MUTATION_INTENT", operationId },
    { type: "OPERATION_OK", operationId },
    { type: "SUBMIT_INTENT", operationId },
    { type: "SUBMITTED", operationId },
    { type: "FAILED", reason: "structural-mismatch", operationId },
    { type: "FAILED", reason: "timeout", operationId, mutation: "none", document: page },
    { type: "FAILED", reason: "timeout", operationId, mutation: "possible" },
    { type: "JUDGING", operationId },
    { type: "UNJUDGED", operationId },
  ];
}
const events: AttemptEvent[] = [
  // A step whose element never showed fails before any operation.
  { type: "FAILED", reason: "structural-mismatch" },
  ...["continue", "authenticated", "credential-rejected", "challenge", "unknown"].map((result) => ({
    type: "OBSERVED",
    result,
  })),
  { type: "NAVIGATED", document: nextPage },
  { type: "NAVIGATED", document: otherOrigin },
  { type: "INTERRUPTED" },
  { type: "RETRY" },
  { type: "RETRY", final: true },
  { type: "WATCH_ENDED" },
  { type: "CANCEL" },
];

/**
 * The events to try in a state. `PREPARE` is built from the recipe's next step, as the
 * runtime does, for a new operation ID; it is also sent for the first used one, which the
 * machine must refuse.
 */
function eventsFor(metadata: LoginAttemptMetadata, recipe: LoginRecipe): AttemptEvent[] {
  const prepares: AttemptEvent[] = [];
  const operationId = fresh(metadata);
  const operation = nextLoginOperation(metadata, recipe, page, operationId, 0);
  if (operation) {
    const effect = loginStepEffect(operation.step);
    const prepare = { type: "PREPARE", kind: operation.step.kind, ...(effect ? { effect } : {}) };
    const used = metadata.usedOperationIds[0];
    prepares.push(
      { ...prepare, operationId },
      ...(used === undefined ? [] : [{ ...prepare, operationId: used }]),
    );
  }
  // For these events, every guard but those of `PREPARE` and `UNJUDGED` treats all IDs
  // other than the one in flight alike, so the new ID stands for the earlier ones;
  // `UNJUDGED` gives back a page of the operation it names, so it is sent for each.
  const named = [...new Set([metadata.operationId ?? operationId, operationId])];
  const earlier = metadata.usedOperationIds.filter((used) => !named.includes(used));
  return [
    ...prepares,
    ...named.flatMap(operationEvents),
    ...earlier.map((used) => ({ type: "UNJUDGED", operationId: used })),
    ...events,
  ];
}

/**
 * The invariants a step from `from` to `to` breaks. The attempt schema, which parses every
 * transition's result, already bounds submissions, retries and judged pages and refuses a
 * used operation ID; a step that breaks one of those throws, which fails the walk too.
 */
function broken(
  from: LoginAttemptMetadata,
  event: AttemptEvent,
  to: LoginAttemptMetadata,
): string[] {
  const names: string[] = [];
  // Once a submission was intended, only a fill whose failure confirmed it changed nothing
  // may be tried again; a click or a fill that may have submitted never is.
  if (
    (from.state === "submit-intent" || from.state === "awaiting-result") &&
    to.state === "retryable" &&
    !(from.operationKind === "fill" && event["type"] === "FAILED" && event["mutation"] === "none")
  )
    names.push("retry after a possible submission");
  // A step that may have submitted is never taken again: when the login goes on, it goes
  // on at a later step.
  if (
    ["submit-intent", "awaiting-result", "reconciling"].includes(from.state) &&
    from.mutationIntent &&
    from.operationEffect !== "prepare" &&
    to.state === "ready" &&
    to.stepIndex <= from.stepIndex
  )
    names.push("possibly submitted step taken again");
  // A `watching` login only reads pages until it ends (ADR 0027).
  if (from.state === "watching" && !["watching", "authenticated", "blocked"].includes(to.state))
    names.push("watched login acted");
  return names;
}

// No guard reads `timing`, which only adds up where the time went; with `now` fixed at 0 it
// never differs, and leaving it out keeps the key from depending on that.
const key = (metadata: LoginAttemptMetadata) => JSON.stringify({ ...metadata, timing: undefined });

/**
 * Walks every state a login of `recipe` can reach. Returns how many there are and the first
 * few broken invariants or thrown errors, each with the events that lead to it.
 */
export function exploreLogin(recipe: LoginRecipe): {
  states: number;
  failures: { broken: string[]; events: AttemptEvent[] }[];
} {
  const start = transitionLoginAttempt(
    createAttemptMetadata({
      timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
      id: "attempt-one",
      recipe,
      policyRevision: 3,
      account: { origin: page.origin, connectionId: "connection-one", itemId: "item-one" },
      choice: { route: "password", variant: 0 },
      facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
      document: page,
    }),
    { type: "RESOLVE" },
    0,
  );
  // Each reached state with the event that first reached it and the state before.
  const reached = new Map<string, { event: AttemptEvent; from: LoginAttemptMetadata } | null>([
    [key(start), null],
  ]);
  const path = (metadata: LoginAttemptMetadata) => {
    const steps: AttemptEvent[] = [];
    for (let step = reached.get(key(metadata)); step; step = reached.get(key(step.from)))
      steps.unshift(step.event);
    return steps;
  };
  const failures: { broken: string[]; events: AttemptEvent[] }[] = [];
  const queue = [start];
  for (let index = 0; index < queue.length && failures.length < 3; index += 1) {
    const from = queue[index]!;
    // An ended attempt takes no more events: transitionLoginAttempt returns it as it is.
    if (from.state === "authenticated" || from.state === "blocked") continue;
    for (const event of eventsFor(from, recipe)) {
      let to: LoginAttemptMetadata;
      try {
        to = transitionLoginAttempt(from, event, 0);
      } catch (error) {
        failures.push({ broken: [String(error)], events: [...path(from), event] });
        continue;
      }
      const names = broken(from, event, to);
      if (names.length) failures.push({ broken: names, events: [...path(from), event] });
      if (!reached.has(key(to))) {
        reached.set(key(to), { event, from });
        queue.push(to);
        if (reached.size > MAX_STATES) {
          failures.push({ broken: [`more than ${MAX_STATES} states`], events: path(to) });
          return { states: reached.size, failures };
        }
      }
    }
  }
  return { states: reached.size, failures };
}
