import {
  attemptPlan,
  createAttemptMetadata,
  fillOnlyStep,
  MAX_ATTEMPT_SUBMISSIONS,
  nextLoginOperation,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
} from "../login-attempt";
import {
  continuesRecipe,
  extendsRecipe,
  handlerSteps,
  loginStepEffect,
  routeSteps,
  TOTP_HANDLER_SLOT,
  type ChooserClick,
  type LoginDocument,
  type LoginItemFacts,
  type LoginRecipe,
  type LoginRouteChoice,
  type LoginStep,
} from "../login";

// Every state a small login can reach: each event of a fixed set is applied to each reached
// state until no new state appears, and each step is checked against the invariants in
// `broken()`. They must hold in any order of events, which the example tests in
// login-attempt.test.ts cannot show. Synthetic origins and identifiers only.
//
// The set holds every event type the machine takes. Those that carry what only the runtime
// can work out (a handler's steps, a continued or other layout's steps and budget, a
// route's steps) are built from the walk's recipes as the runtime builds them, so the
// steps after them are walked too; the guards still see each in every state.

/** More states than this means a guard stopped bounding the attempt. */
const MAX_STATES = 60_000;

export const page: LoginDocument = {
  origin: "https://bank.example",
  tabId: 7,
  frameId: 0,
  documentId: "document-one",
};
const nextPage = { ...page, documentId: "document-two" };
const otherOrigin = { ...page, origin: "https://idp.example", documentId: "document-three" };
/** A frame of `page`'s tab, inside a page of `parentOrigin`. */
export const framePage: LoginDocument = { ...page, frameId: 4, documentId: "frame-one" };
export const parentOrigin = "https://portal.example";

/** A recipe of `page`'s origin with the given steps. */
export const recipeOf = (
  parts: Pick<LoginRecipe, "id" | "slots" | "steps" | "maxSubmissions"> & Partial<LoginRecipe>,
): LoginRecipe => ({
  version: 1,
  revision: 2,
  origin: page.origin,
  pageKind: "sign-in",
  completion: [{ target: { by: "id", value: "authenticated" } }],
  rejection: { by: "id", value: "rejected" },
  ...parts,
});

const id = (value: string) => ({ by: "id" as const, value });
/** A fill of `slots` on `/login`, each into the input of its own name. */
export const fill = (...slots: string[]): LoginStep => ({
  kind: "fill",
  effect: "prepare",
  path: "/login",
  fields: slots.map((slot) => ({ slot, target: id(slot) })),
});
/** A click on `/login`'s element `value`. */
export const click = (value: string, purpose: "advance" | "submit"): LoginStep => ({
  kind: "click",
  path: "/login",
  target: id(value),
  purpose,
});
/** A login of `parts` walked, with what it must reach so that it cannot pass trivially. */
export function walk(
  parts: Parameters<typeof recipeOf>[0],
  start: WalkStart = {},
  takeovers: Partial<LoginRecipe>[] = [],
) {
  const recipe = recipeOf(parts);
  return exploreLogin(
    recipe,
    start,
    takeovers.map((takeover) => ({ ...recipe, ...takeover })),
  );
}

/** How the walked login starts, beside its recipe. */
export type WalkStart = {
  choice?: LoginRouteChoice;
  fallback?: number;
  facts?: LoginItemFacts;
  /** Where an item without a password stops (ADR 0036). */
  stopAt?: number;
  chooser?: ChooserClick;
  fillOnly?: boolean;
  accountSwitched?: boolean;
  /** A login in a frame of the tab (ADR 0022), never watched. */
  frame?: boolean;
  /** Sends `ROUTE` too, as a page whose own passkey request comes and goes (ADR 0034). */
  routes?: boolean;
  /**
   * Leaves out the events whose orders the walks of the plain recipes already cover and
   * that only multiply the states of a longer one: a same-scope move to another document,
   * a judged page given back, newer settings for a watched login, a final retry, an
   * unconfirmed sign-in, and the events that name an operation other than the one in
   * flight, which every guard refuses alike.
   */
  focused?: boolean;
};

type AttemptEvent = Record<string, unknown>;

// Operation IDs are named in the order the attempt uses them, so states that differ only in
// which random ID the runtime picked are the same state here.
const fresh = (metadata: LoginAttemptMetadata) =>
  `operation-${metadata.usedOperationIds.length + 1}`;

/** The events that name operation `operationId` on `document`. */
function operationEvents(
  operationId: string,
  document: LoginDocument,
  focused: boolean,
): AttemptEvent[] {
  return [
    { type: "MUTATION_INTENT", operationId },
    { type: "OPERATION_OK", operationId },
    { type: "SUBMIT_INTENT", operationId },
    { type: "SUBMITTED", operationId },
    { type: "FAILED", reason: "structural-mismatch", operationId },
    { type: "FAILED", reason: "timeout", operationId, mutation: "none", document },
    { type: "FAILED", reason: "timeout", operationId, mutation: "possible" },
    { type: "JUDGING", operationId },
    ...(focused ? [] : [{ type: "UNJUDGED", operationId }]),
    { type: "WRONG_ACCOUNT", operationId, document },
    { type: "WRONG_ACCOUNT", operationId, document, switched: true },
    { type: "VALUE_REJECTED", operationId, document, stage: "before-fill" },
    { type: "VALUE_REJECTED", operationId, document, stage: "before-fill", challenge: true },
    { type: "VALUE_REJECTED", operationId, document, stage: "after-fill" },
    { type: "VALUE_REJECTED", operationId, document, stage: "code-refused" },
    { type: "CONTINUING", operationId },
    { type: "UNCONTINUED", operationId },
    { type: "POLICY_CHANGED", undelivered: operationId },
  ];
}

/** Events that name nothing of the attempt's own, or only its document. */
function fixedEvents(document: LoginDocument, focused: boolean): AttemptEvent[] {
  const otherOrigins = [{ ...otherOrigin, frameId: document.frameId }];
  const unfocused = [
    { type: "OBSERVED", result: "authenticated", unconfirmed: true },
    { type: "NAVIGATED", document: { ...document, documentId: "document-two" } },
    ...(document.frameId === 0 ? [] : [{ type: "NAVIGATED", document: nextPage }]),
    { type: "RETRY", final: true },
    { type: "POLICY_REVISED", policyRevision: 4 },
  ];
  return [
    ...(focused ? [] : unfocused),
    // A step whose element never showed fails before any operation.
    { type: "FAILED", reason: "structural-mismatch" },
    ...["continue", "authenticated", "credential-rejected", "challenge", "unknown"].map(
      (result) => ({ type: "OBSERVED", result }),
    ),
    ...otherOrigins.flatMap((moved) => [
      { type: "NAVIGATED", document: moved },
      { type: "NAVIGATED", document: moved, signedIn: true },
    ]),
    // The tab shows no web page once the wait for the site ran out (ADR 0022).
    { type: "LEFT" },
    { type: "INTERRUPTED" },
    { type: "RETRY" },
    { type: "WATCH_ENDED" },
    { type: "WATCH_ENDED", abandoned: true },
    { type: "POLICY_CHANGED" },
    { type: "CANCEL" },
  ];
}

/** The recipe a state runs: the walk's recipe of its revision and layout. */
const recipeFor = (metadata: LoginAttemptMetadata, recipes: readonly LoginRecipe[]) =>
  recipes.find(
    (recipe) => recipe.revision === metadata.recipeRevision && recipe.layout === metadata.layout,
  );

const effects = (steps: readonly LoginStep[]) =>
  steps.filter((step) => {
    const effect = loginStepEffect(step);
    return effect !== undefined && effect !== "prepare";
  }).length;

/**
 * The events that carry what the runtime works out from the recipes: a handler's steps, a
 * revision that only adds handlers, a continued page, another layout and another route.
 * Each is built as the runtime builds it, from the state's own recipe, so the machine
 * decides only whether the state may take it.
 */
function recipeEvents(
  metadata: LoginAttemptMetadata,
  recipes: readonly LoginRecipe[],
  document: LoginDocument,
  routes: boolean,
): AttemptEvent[] {
  const recipe = recipeFor(metadata, recipes);
  if (!recipe) return [];
  const events: AttemptEvent[] = [];
  for (const [handler, entry] of (recipe.handlers ?? []).entries())
    for (const field of entry.kind === "detail" ? entry.fields.keys() : [undefined]) {
      const steps = handlerSteps(entry, field);
      events.push({
        type: "HANDLER",
        handler,
        ...(field === undefined ? {} : { field }),
        steps: steps.length,
        // A handler's steps always spend one submission at least: its click, or its code.
        effects: Math.max(1, effects(steps)),
        document,
      });
    }
  const choice: LoginRouteChoice =
    metadata.route === "passkey"
      ? { route: "passkey" }
      : { route: "password", variant: metadata.variant ?? 0 };
  const own = routeSteps(recipe, choice);
  for (const next of recipes) {
    if (extendsRecipe(recipe, next))
      events.push({ type: "REVISED", recipeRevision: next.revision });
    const nextSteps = routeSteps(next, choice);
    if (continuesRecipe(recipe, next)) {
      const added = nextSteps.length - own.length;
      // A login with a stop past its plan names a stop among or just past the new steps.
      const stops =
        metadata.stopAt === undefined
          ? [undefined]
          : [metadata.stepCount, metadata.stepCount + added];
      for (const stopAt of stops)
        events.push({
          type: "CONTINUED",
          recipeRevision: next.revision,
          steps: added,
          effects: effects(nextSteps.slice(own.length)),
          document,
          ...(stopAt === undefined ? {} : { stopAt }),
        });
    }
    if (continuesRecipe(recipe, next, { replacesLast: true }))
      events.push({
        type: "CONTINUED",
        recipeRevision: next.revision,
        steps: nextSteps.length - own.length + 1,
        effects: effects(nextSteps.slice(own.length - 1)),
        document,
        replacesLast: true,
      });
    if (next.id === recipe.id && next.layout !== undefined && next.layout !== recipe.layout)
      events.push({
        type: "LAYOUT",
        layout: next.layout,
        recipeRevision: next.revision,
        steps: attemptPlan(next, metadata)?.length ?? nextSteps.length,
        // What the login holds beyond its recipe's budget stays with it, as the runtime's
        // `switchLayout` keeps it.
        maxSubmissions: Math.min(
          MAX_ATTEMPT_SUBMISSIONS,
          next.maxSubmissions + Math.max(0, metadata.maxSubmissions - recipe.maxSubmissions),
        ),
        document,
      });
  }
  // A route the login may take, with its steps on the state's recipe (ADR 0034).
  if (!routes) return events;
  if (metadata.route === "password")
    events.push({
      type: "ROUTE",
      route: "passkey",
      steps: routeSteps(recipe, { route: "passkey" }).length,
    });
  if (metadata.route === "passkey" && metadata.variant !== undefined) {
    const steps = routeSteps(recipe, { route: "password", variant: metadata.variant }).length;
    if (steps > 0) events.push({ type: "ROUTE", route: "password", steps });
  }
  return events;
}

/**
 * The events to try in a state. `PREPARE` is built from the recipe's next step, as the
 * runtime does, for a new operation ID; it is also sent for the first used one, which the
 * machine must refuse.
 */
function eventsFor(
  metadata: LoginAttemptMetadata,
  recipes: readonly LoginRecipe[],
  document: LoginDocument,
  { routes = false, focused = false }: WalkStart,
): AttemptEvent[] {
  const prepares: AttemptEvent[] = [];
  const operationId = fresh(metadata);
  const recipe = recipeFor(metadata, recipes);
  const operation =
    recipe && nextLoginOperation(metadata, recipe, metadata.document, operationId, 0);
  // A fill-only login is issued only what it may fill (ADR 0021 D).
  if (operation && metadata.fillOnly && fillOnlyStep(operation.step) !== operation.step)
    throw new Error("Fill-only login issued a step it never takes");
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
  const named = [
    ...new Set([metadata.operationId ?? operationId, ...(focused ? [] : [operationId])]),
  ];
  const earlier = focused ? [] : metadata.usedOperationIds.filter((used) => !named.includes(used));
  return [
    ...prepares,
    ...named.flatMap((name) => operationEvents(name, metadata.document, focused)),
    ...earlier.map((used) => ({ type: "UNJUDGED", operationId: used })),
    ...planEvents(metadata, recipe, operationId),
    ...recipeEvents(metadata, recipes, metadata.document, routes),
    ...fixedEvents(document, focused),
  ];
}

type PlanEntry = { step: LoginStep; handler?: number } | undefined;

/**
 * Where plan entry `index` stands in a TOTP code the page may submit by itself, as the
 * runtime's `codeStep` reads it (ADR 0027): a `totp` handler's fill or the click after it,
 * or a route's fill of the code alone and its submit click on the same path.
 */
function codeStep(
  recipe: LoginRecipe,
  plan: readonly PlanEntry[],
  index: number,
): "fill" | "click" | undefined {
  const entry = plan[index];
  if (!entry) return undefined;
  const before = plan[index - 1];
  if (entry.handler !== undefined) {
    if (recipe.handlers?.[entry.handler]?.kind !== "totp") return undefined;
    if (entry.step.kind === "fill") return "fill";
    return before?.handler === entry.handler && before.step.kind === "fill" ? "click" : undefined;
  }
  const routeCode = (at: PlanEntry) =>
    at?.handler === undefined &&
    at?.step.kind === "fill" &&
    at.step.fields.length === 1 &&
    at.step.fields[0]!.slot === TOTP_HANDLER_SLOT;
  const submits = (at: PlanEntry, path: string) =>
    at?.handler === undefined &&
    at?.step.kind === "click" &&
    at.step.purpose === "submit" &&
    at.step.path === path;
  if (routeCode(entry)) return submits(plan[index + 1], entry.step.path) ? "fill" : undefined;
  return routeCode(before) && submits(entry, before!.step.path) ? "click" : undefined;
}

/**
 * The events the runtime sends only for a kind of step or login, as it checks before it
 * sends them; the machine still decides whether the state may take each.
 */
function planEvents(
  metadata: LoginAttemptMetadata,
  recipe: LoginRecipe | undefined,
  operationId: string,
): AttemptEvent[] {
  const plan = recipe && attemptPlan(recipe, metadata);
  const at = plan?.[metadata.stepIndex];
  const events: AttemptEvent[] = [];
  const code = recipe && plan ? codeStep(recipe, plan, metadata.stepIndex) : undefined;
  // A page that submitted a code by itself, with the code's fill unanswered or after it,
  // at its click (`codeAwaitsClick`). A fill-only login never types the code, so the
  // runtime never sends it one; it is sent at the code's fill anyway, which only the
  // machine's own refusal turns away (ADR 0021 D).
  if (
    metadata.operationId === undefined
      ? code === "click" || (metadata.fillOnly === true && code === "fill")
      : code === "fill"
  )
    events.push({
      type: "AUTO_SUBMITTED",
      operationId,
      ...(at?.handler === undefined ? { routeStep: true } : {}),
    });
  // The final `advance` click a continued page replaces is the step the login stands at.
  if (
    at?.step.kind === "click" &&
    loginStepEffect(at.step) === "advance" &&
    metadata.stepIndex + 1 === plan?.length
  )
    events.push(
      { type: "CONTINUING", before: metadata.stepIndex },
      { type: "UNCONTINUED", before: metadata.stepIndex },
    );
  // A login of an item without a password answers, judges and is watched at its stop, where
  // its watch's pages name no step (ADR 0036).
  if (metadata.stopAt !== undefined)
    events.push(
      { type: "STOP_ANSWERED", operationId },
      { type: "STOP_JUDGING" },
      { type: "JUDGING" },
      { type: "UNJUDGED" },
    );
  if (metadata.chooser !== undefined) events.push({ type: "NOT_LISTED" });
  return events;
}

/** Events after which the attempt's count of submissions may go down. */
const takesBack = (event: AttemptEvent) =>
  (event["type"] === "FAILED" && event["mutation"] === "none") ||
  event["type"] === "WRONG_ACCOUNT" ||
  (event["type"] === "VALUE_REJECTED" && event["stage"] === "before-fill") ||
  (event["type"] === "POLICY_CHANGED" && event["undelivered"] !== undefined);
/** Events after which the attempt may count a new submission. */
const submits = (event: AttemptEvent) =>
  ["MUTATION_INTENT", "SUBMIT_INTENT", "AUTO_SUBMITTED", "STOP_ANSWERED"].includes(
    String(event["type"]),
  );

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
  const type = event["type"];
  // Once a submission was intended, only a fill whose failure confirmed it changed nothing
  // may be tried again; a click or a fill that may have submitted never is.
  if (
    (from.state === "submit-intent" || from.state === "awaiting-result") &&
    to.state === "retryable" &&
    !(from.operationKind === "fill" && type === "FAILED" && event["mutation"] === "none")
  )
    names.push("retry after a possible submission");
  // A step that may have submitted is never taken again: when the login goes on, it goes
  // on at a later step.
  if (
    ["submit-intent", "awaiting-result", "reconciling"].includes(from.state) &&
    from.mutationIntent &&
    from.operationEffect !== "prepare" &&
    to.state === "ready" &&
    to.stepIndex <= from.stepIndex &&
    // The passkey route's answer falls back to the password route's first step (ADR 0034).
    !(type === "ROUTE" && to.route !== from.route)
  )
    names.push("possibly submitted step taken again");
  // A `watching` login only reads pages until it ends (ADR 0027).
  if (from.state === "watching" && !["watching", "authenticated", "blocked"].includes(to.state))
    names.push("watched login acted");
  if (from.state === "watching" && to.submissions !== from.submissions)
    names.push("watched login counted a submission");
  // Nothing at or after the stop of an item without a password runs (ADR 0036): the login
  // never stands past it, and never prepares the step there.
  if (to.route === "password" && to.stopAt !== undefined) {
    if (to.stepIndex > to.stopAt) names.push("went past the stop");
    if (to.state === "executing" && to.stepIndex >= to.stopAt) names.push("prepared the stop");
  }
  // A login with a stop never goes back to the password its item lacks (ADR 0036).
  if (from.stopAt !== undefined && from.route === "passkey" && to.route === "password")
    names.push("fell back to a missing password");
  // A fill-only login never clicks or submits (ADR 0021 D).
  if (to.fillOnly && to.submissions > from.submissions) names.push("fill-only login submitted");
  if (to.fillOnly && to.operationKind === "click") names.push("fill-only login clicked");
  // Submissions only go up by one when a step intends one, and only go back down when a
  // step proves it never began, before the page could have received it.
  if (
    to.submissions > from.submissions &&
    (!submits(event) || to.submissions !== from.submissions + 1)
  )
    // ROUTE gives the password route back its budget, not its count.
    names.push("counted a submission no step intended");
  if (to.submissions < from.submissions) {
    if (!takesBack(event)) names.push("took back a submission without proof");
    // Once the page said it took the step; in `reconciling` the machine trusts the
    // runtime's own record of what it delivered (ADR 0022).
    if (from.state === "awaiting-result" || from.state === "watching")
      names.push("took back a submission the page took");
  }
  // Only a page that proves it, or a confirmed move to another origin, signs in.
  if (
    to.state === "authenticated" &&
    !(type === "OBSERVED" && event["result"] === "authenticated") &&
    !(type === "NAVIGATED" && event["signedIn"] === true)
  )
    names.push("authenticated without proof");
  // A move to another origin signs in only a login that submitted or filled something.
  if (
    to.state === "authenticated" &&
    type === "NAVIGATED" &&
    from.submissions === 0 &&
    from.operationKind === undefined
  )
    names.push("signed in by a move before anything was filled");
  return names;
}

/**
 * How often a walk changes route. The machine lets a login that submitted nothing switch
 * route again each time the page's request comes and goes (ADR 0034), each time from its
 * first step, so the walk would only stop at the attempt's cap of operation IDs; a walk
 * switches at most this often, and the states are keyed by how often they did.
 */
const MAX_ROUTE_CHANGES = 2;

type Reached = { metadata: LoginAttemptMetadata; routes: number };

// No guard reads `timing`, which only adds up where the time went; with `now` fixed at 0 it
// never differs, and leaving it out keeps the key from depending on that.
const key = ({ metadata, routes }: Reached) =>
  JSON.stringify({ ...metadata, timing: undefined, routes });

/**
 * Walks every state a login of `recipes[0]` can reach; the other recipes are revisions and
 * layouts of it that its events may take over. Returns how many states there are, which
 * event types changed a state at least once, and the first few broken invariants or thrown
 * errors, each with the events that lead to it.
 */
export function exploreLogin(
  recipe: LoginRecipe,
  start: WalkStart = {},
  takeovers: readonly LoginRecipe[] = [],
): {
  states: number;
  types: Set<string>;
  failures: { broken: string[]; events: AttemptEvent[] }[];
} {
  const recipes = [recipe, ...takeovers];
  const document = start.frame ? framePage : page;
  const choice = start.choice ?? { route: "password", variant: 0 };
  const initial = transitionLoginAttempt(
    createAttemptMetadata({
      timing: { since: 0, serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
      id: "attempt-one",
      recipe,
      policyRevision: 3,
      account: { origin: page.origin, connectionId: "connection-one", itemId: "item-one" },
      choice,
      ...(start.fallback === undefined ? {} : { fallback: start.fallback }),
      facts: start.facts ?? {
        password: true,
        totp: false,
        passkey: false,
        discoverablePasskey: false,
      },
      document,
      ...(start.frame ? { pageOrigin: parentOrigin } : {}),
      ...(start.stopAt === undefined ? {} : { stopAt: start.stopAt }),
      ...(start.chooser === undefined ? {} : { chooser: start.chooser }),
      ...(start.fillOnly ? { fillOnly: true } : {}),
      ...(start.accountSwitched ? { accountSwitched: true } : {}),
    }),
    { type: "RESOLVE" },
    0,
  );
  // Each reached state with the event that first reached it and the state before.
  const first: Reached = { metadata: initial, routes: 0 };
  const reached = new Map<string, { event: AttemptEvent; from: Reached } | null>([
    [key(first), null],
  ]);
  const path = (state: Reached) => {
    const steps: AttemptEvent[] = [];
    for (let step = reached.get(key(state)); step; step = reached.get(key(step.from)))
      steps.unshift(step.event);
    return steps;
  };
  const types = new Set<string>();
  const failures: { broken: string[]; events: AttemptEvent[] }[] = [];
  const queue = [first];
  for (let index = 0; index < queue.length && failures.length < 3; index += 1) {
    const state = queue[index]!;
    const from = state.metadata;
    // An ended attempt takes no more events: transitionLoginAttempt returns it as it is.
    if (from.state === "authenticated" || from.state === "blocked") continue;
    for (const event of eventsFor(from, recipes, document, start)) {
      if (event["type"] === "ROUTE" && state.routes >= MAX_ROUTE_CHANGES) continue;
      let to: LoginAttemptMetadata;
      try {
        to = transitionLoginAttempt(from, event, 0);
      } catch (error) {
        failures.push({ broken: [String(error)], events: [...path(state), event] });
        continue;
      }
      const next: Reached = {
        metadata: to,
        routes: state.routes + (to.route === from.route ? 0 : 1),
      };
      const nextKey = key(next);
      if (nextKey === key(state)) continue;
      types.add(String(event["type"]));
      const names = broken(from, event, to);
      if (names.length) failures.push({ broken: names, events: [...path(state), event] });
      if (!reached.has(nextKey)) {
        reached.set(nextKey, { event, from: state });
        queue.push(next);
        if (reached.size > MAX_STATES) {
          failures.push({ broken: [`more than ${MAX_STATES} states`], events: path(next) });
          return { states: reached.size, types, failures };
        }
      }
    }
  }
  return { states: reached.size, types, failures };
}
