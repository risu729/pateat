import {
  parseRecipeBranch,
  recipeHasRoute,
  routeFillTargets,
  routeSignInPaths,
  routeSignInTargets,
  sameLoginTarget,
  showsBesideForm,
  isChooserDocument,
  fillRoles,
  type GenerationUnavailableReason,
  type LoginObservation,
  type LoginRecipe,
  type ObservedCandidate,
  type LoginMarkerTarget,
  type LoginRoute,
  type RecipeCompletionRequest,
  type RecipeCompletionResult,
  type RecipePageSampleRequest,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { loginMoveFits } from "@pateat/contracts/site";
import {
  addCompletion,
  addHandler,
  completionInstructions,
  completionPromptVersion,
  completionStopInstructions,
  completionStopPromptVersion,
  completionBesideInstructions,
  completionBesidePromptVersion,
  createCompletionJudge,
  recipeElements,
} from "@pateat/inference";
import {
  type GenerationBackend,
  type JudgementKey,
  type KeptJudgement,
  type PageJudgementVerdict,
  type UnitSources,
  type UnsentRequest,
} from "../backend";
import { branchUnit, handlerUnit, markerUnit } from "../units";
import {
  type UnsentAnswer,
  roleConfig,
  answerUnsent,
  unavailable,
  failed,
  failureOf,
  modelCall,
  answerable,
} from "./responses";
import { JUDGEMENTS_PER_RECIPE_DAY, utcDayStart, staleHead } from "./policy";
import { routeOf, stored, markWritten } from "./layout";

/**
 * The paths the judge is told the login ran on: from the stored recipe, never from the
 * request; a branch's login started on its chooser's list.
 */
function judgedLoginPaths(head: StoredLoginRecipe, recipe: LoginRecipe, route: LoginRoute) {
  return [
    ...new Set([
      ...(isChooserDocument(head) ? [head.chooser.path] : []),
      ...routeSignInPaths(recipe, route),
      ...(recipe.handlers ?? []).map((handler) => handler.path),
    ]),
  ];
}

/** The roles of the inputs a judged page's kept `challenge` is tied to (ADR 0029). */
const judgedInputRoles: ReadonlySet<ObservedCandidate["role"]> = new Set([...fillRoles, "select"]);

/**
 * The digest of the inputs a judged description shows: each fill-role field's and select's
 * role and locator, in order of neither the page nor the description. A kept `challenge`
 * answers only a page described with the same inputs: one judged on a description that
 * missed its code field, as a page read while it was still being drawn may, kept no
 * handler for it (ADR 0029 amendment of 2026-11-06).
 */
export async function judgedInputs(observation: LoginObservation): Promise<string> {
  const inputs = observation.candidates
    .filter((candidate) => judgedInputRoles.has(candidate.role))
    .map((candidate) => JSON.stringify([candidate.role, candidate.target]))
    .toSorted();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(inputs)),
  );
  return new Uint8Array(digest).toHex().slice(0, 16);
}

/**
 * `POST /v1/recipes/:recipeId/completion`: judges a page after an effect step of the
 * login's route (ADR 0027), on the recipe's origin or on another origin that the login's
 * tab moved to (ADR 0022). Returns `undefined` for a missing recipe and `null` for a page
 * of an origin no move could reach, which the route answers as 404 and 400.
 */
export async function judgeCompletion(
  backend: GenerationBackend,
  recipeId: string,
  request: RecipeCompletionRequest,
): Promise<RecipeCompletionResult | undefined | null> {
  const head = await backend.readHead(recipeId);
  if (!head) return undefined;
  const { observation, route, branch, partial, slots } = request;
  // A page at a `password` login's stop before its item's missing password (ADR 0036, owner
  // 2026-10-13 05:39 UTC): judged though it shows the route's password field, for a
  // `passkey` handler only.
  const stop = request.stop === true;
  // A page that still shows the route's sign-in form beside another form (ADR 0061): judged
  // though it shows a route fill field, for a `detail` handler only.
  const beside = request.beside === true;
  // Each layout (ADR 0060), and each branch of a chooser layout, is judged on its own; its
  // limit per day is the recipe's.
  const judgedBranch = branch;
  // A stop's page is judged under its own prompt version, so its row never answers another
  // login's page of the path, nor theirs it (ADR 0036); so is a page beside the sign-in
  // form (ADR 0061). Rows of every current version stay.
  const usualVersion = await completionPromptVersion();
  const stopVersion = await completionStopPromptVersion();
  const besideVersion = await completionBesidePromptVersion();
  const promptVersion = stop ? stopVersion : beside ? besideVersion : usualVersion;
  /**
   * What the request log keeps of the request, sent or not (ADR 0012): without the login
   * paths while the request names no route of the stored revision to take them from.
   */
  const logged = (loginPaths?: string[]) =>
    ({
      role: "judge",
      promptVersion,
      origin: observation.origin,
      path: observation.path,
      request: {
        instructions: stop
          ? completionStopInstructions
          : beside
            ? completionBesideInstructions
            : completionInstructions,
        recipeId,
        route,
        ...(loginPaths ? { loginPaths } : {}),
        // The account's slots, logged as a generation request's are (owner 2026-10-23).
        slots,
        observation,
        ...(stop ? { stop } : {}),
        ...(beside ? { beside } : {}),
      },
      recipe: { recipeId, branch: judgedBranch, baseRevision: head.revision },
    }) satisfies UnsentRequest;
  const unsent = (answer: Extract<RecipeCompletionResult, UnsentAnswer>, loginPaths?: string[]) =>
    answerUnsent(backend, logged(loginPaths), answer);
  if (head.state === "revoked") return unsent(unavailable("recipe-revoked"));
  // Only a page of the revision that ran, on a route the stored recipe has, is judged: the
  // recipe's own, or for a chooser (ADR 0028) the route of the branch the login took. An
  // entry recipe (ADR 0031) has no route.
  const recipe = routeOf(head.recipe, branch);
  // A page of another origin is one a `password` login's tab moved to right after its
  // submission (ADR 0022): of the site, or of another site right after a second factor,
  // which a page answered by itself may ask for without any recipe step, so the extension
  // alone knows it. The recipe's paths are not that origin's, and its markers there carry
  // that origin.
  const moved = observation.origin !== head.recipe.origin;
  if (
    moved &&
    (route !== "password" || !loginMoveFits(head.recipe.origin, observation.origin, true))
  )
    return null;
  if (!recipe || head.revision !== request.revision || !recipeHasRoute(recipe, route))
    return unsent(unavailable("recipe-conflict"));
  const loginPaths = judgedLoginPaths(head.recipe, recipe, route);
  if (!observation.complete) return unsent(failed("incomplete-observation"), loginPaths);
  // A list of accounts shown again is the sign-in's start, not its result (ADR 0028). A
  // stop's page is judged only on a layout's own route, never a chooser branch's, and on
  // its own origin: the extension never sends a chooser branch's stop (ADR 0036, account
  // lists); nor a page beside the sign-in form (ADR 0061).
  if (
    observation.accounts ||
    ((stop || beside) && (moved || parseRecipeBranch(branch)?.branch !== undefined))
  )
    return unsent(unavailable("not-judgeable"), loginPaths);
  // The checks use the stored recipe, never the request: a page that still shows one of
  // the password route's fill fields, of any variant and on any path, or a signed-in
  // marker is not judged. The request never names the variant the login ran. The passkey
  // route starts beside that form, so the form counts for it too; and a page on its
  // sign-in paths that still shows its button is not judged either: its passkey exchange
  // may still be running, as the extension holds it.
  const markers = (recipe.completion ?? [])
    .filter((marker) => (marker.origin ?? head.recipe.origin) === observation.origin)
    .map((marker) => marker.target);
  const shown = (targets: readonly LoginMarkerTarget[]) =>
    observation.candidates.some((candidate) =>
      targets.some((target) => sameLoginTarget(target, candidate.target)),
    );
  // A stop's page is the sign-in page by design: it must show one of the route's fill
  // fields as a password input, and never a signed-in marker.
  const stopPage = observation.candidates.some(
    (candidate) =>
      candidate.role === "password" &&
      routeFillTargets(recipe, "password").some((target) =>
        sameLoginTarget(target, candidate.target),
      ),
  );
  // A stop's page is judged only for a `passkey` handler, which a path that has one never
  // gets again (`addHandler`'s `duplicate`), so it is not sent to the model.
  const passkeyHandled = (recipe.handlers ?? []).some(
    (handler) => handler.kind === "passkey" && handler.path === observation.path,
  );
  // A page beside the sign-in form shows one of the route's fill fields on a route path,
  // and another form with a text-like input and its button (ADR 0061). It is judged only
  // for a `detail` handler, which a path that has one never gets again.
  const besidePage =
    routeSignInPaths(recipe, route).includes(observation.path) &&
    showsBesideForm(observation, routeFillTargets(recipe, "password"));
  const detailHandled = (recipe.handlers ?? []).some(
    (handler) => handler.kind === "detail" && handler.path === observation.path,
  );
  if (
    stop
      ? !stopPage || shown(markers) || passkeyHandled
      : beside
        ? !besidePage || shown(markers) || detailHandled
        : shown([...routeFillTargets(recipe, "password"), ...markers]) ||
          (routeSignInPaths(recipe, route).includes(observation.path) &&
            shown(routeSignInTargets(recipe, route)))
  )
    return unsent(unavailable("not-judgeable"), loginPaths);

  const judgedPage: JudgementKey = {
    recipeId,
    branch: judgedBranch,
    revision: head.revision,
    origin: observation.origin,
    path: observation.path,
    promptVersion,
  };
  /**
   * The answer a kept judgement of the page gives without a model call, if any. A later
   * login of the revision completes on the path only after a `signed-in` or undecided
   * verdict (ADR 0029): one judged `challenge` or `rejected`, still being judged, or whose
   * request failed does not. A row of an earlier judge prompt does not count: a page it
   * judged `challenge` but kept no handler for, such as a code split into one-digit inputs
   * before those were learned, is judged again. A page the model could not decide on a
   * description that left out a disabled field, as a code field waiting for its code may
   * be, is judged again once the path is described in full; a description that leaves one
   * out again is `already-judged`, which the extension never completes on. A page judged
   * `optional` is judged again each time: another page of the same path, as a single-page
   * sign-in shows, may ask for a step (ADR 0065). A page judged `challenge` is judged again
   * once it is described with other inputs: the judgement may have kept no handler because
   * its description missed the field, as a code field not yet drawn (ADR 0029 amendment of
   * 2026-11-06).
   */
  const inputs = await judgedInputs(observation);
  const judgedAnswer = (
    judged: KeptJudgement | undefined,
  ): GenerationUnavailableReason | undefined => {
    if (
      !judged ||
      (judged.verdict === "partial" && !partial) ||
      judged.verdict === "optional" ||
      (judged.verdict === "challenge" && judged.inputs !== inputs)
    )
      return undefined;
    return judged.verdict === "challenge"
      ? "judged-challenge"
      : judged.verdict === "rejected"
        ? "judged-rejected"
        : judged.verdict === null
          ? "judgement-unanswered"
          : judged.verdict === "signed-in"
            ? "judged-signed-in"
            : "already-judged";
  };
  /**
   * Whether this request took a row kept `challenge` for other inputs: until the new
   * verdict is written the row has none, so a request that ends without one, failed or
   * undecided, puts `challenge` back. The page was a step the person takes, and a row left
   * without a verdict, or `unclear`, would never be judged again for the revision.
   */
  let retakenChallenge = false;
  let kept: KeptJudgement | undefined;
  const call = await backend.call({
    ...logged(loginPaths),
    device: request.deviceModel,
    // Each revision, origin and path is judged once per judge prompt version, and a recipe
    // 20 times a UTC day (ADR 0027), counting a stop's pages and those beside the sign-in
    // form.
    gate: async (now) => {
      const stale = staleHead(await backend.readHead(recipeId), head.revision);
      if (stale) return stale;
      kept = await backend.judgement(judgedPage);
      const judged = judgedAnswer(kept);
      if (judged) return judged;
      return (await backend.judgementsSince(recipeId, utcDayStart(now))) >=
        JUDGEMENTS_PER_RECIPE_DAY
        ? "judgement-limit"
        : undefined;
    },
    // A request the role refuses before sending gives the slot back, as a generation
    // attempt does (ADR 0027); a `partial` or `optional` row judged again, or a
    // `challenge` one of other inputs, takes today's slot and waits for its new verdict.
    // Rows of older revisions or judges go once their day is over. A row another request
    // wrote since the gate stops this one unsent, so a page is never judged twice at once
    // (ADR 0018): it answers as that row does.
    beforeSend: async (now) => {
      if (
        await backend.recordJudgement(
          judgedPage,
          now,
          { expired: utcDayStart(now), versions: [usualVersion, stopVersion, besideVersion] },
          inputs,
        )
      ) {
        retakenChallenge = kept?.verdict === "challenge";
        return undefined;
      }
      return judgedAnswer(await backend.judgement(judgedPage)) ?? "judgement-unanswered";
    },
    invoke: (model) =>
      createCompletionJudge({ model, ...roleConfig })({
        observation,
        loginPaths,
        slots,
        recipeElements: recipeElements(recipe),
        ...(stop ? { stop } : {}),
        ...(beside ? { beside } : {}),
      }),
    logValue: (judgement) => judgement,
  });
  // The verdict goes on the path's row, which tells a later login of the revision what
  // the page was (ADR 0029). A row left without one never completes a login, so a failed
  // write only costs that.
  const keepVerdict = async (verdict: PageJudgementVerdict, keptInputs?: string | null) => {
    try {
      await backend.keepVerdict(judgedPage, verdict, keptInputs);
    } catch {
      console.warn("Page judgement verdict not kept", { recipeId, verdict });
    }
  };
  // A retaken `challenge` row whose request failed is a challenge still, with its earlier
  // inputs, so a later login of the new ones judges the page again.
  const keepChallenge = async () => {
    if (retakenChallenge) await keepVerdict("challenge", kept?.inputs ?? null);
  };
  if (call.status === "unavailable") {
    await keepChallenge();
    return unsent(unavailable(call.reason), loginPaths);
  }
  if (call.status === "device-call") return modelCall(call);
  const { outcome } = call;
  /**
   * The provenance of the handlers or marker this judgement adds to the judged layout and
   * branch (ADR 0060), several under the same request log row.
   */
  const named = parseRecipeBranch(branch);
  const judged = (units: string[]): UnitSources => ({
    origin: "judged",
    units: named
      ? units.map((unit) => ({ layout: named.layout, unit: branchUnit(named.branch, unit) }))
      : [],
    served: call.served,
    promptVersion,
    logId: call.logId,
  });
  if (outcome.status === "failed") {
    await keepChallenge();
    const answer = failed(failureOf(outcome.error));
    // A request the role refused locally, as one too large, was never sent.
    return outcome.calls === 0 ? unsent(answer, loginPaths) : answer;
  }
  if (outcome.status === "abstained") {
    // Undecided on a description that left a disabled field out: not kept as `unclear`,
    // so a later login does not complete on the path once the field is enabled. Undecided
    // on a page kept `challenge` before, it stays one.
    await keepVerdict(retakenChallenge ? "challenge" : partial ? "partial" : "unclear");
    return { version: 1, status: retakenChallenge ? "challenge" : "unclear" };
  }
  const judgement = outcome.value;
  // A stop's page keeps a `passkey` handler and nothing else: no rejection, no marker and
  // no `totp`, `password` or `authenticator` handler. Its other answers are kept as undecided, under the
  // stop's version. So does a page beside the sign-in form, with a `detail` handler (ADR
  // 0061), and its challenge that keeps none.
  if ((stop || beside) && judgement.decision !== "challenge") {
    await keepVerdict("unclear");
    return { version: 1, status: "unclear" };
  }
  // A page beside the sign-in form keeps its verdict once its handlers are known. An
  // optional answer on a description that left out a disabled field is kept as
  // `partial`, as an abstention there is (ADR 0029, ADR 0065).
  // A signed-in page's marker is checked before its verdict is kept: a page that still
  // shows the login's own elements keeps `challenge`, so a later login of the revision
  // never completes on it as judged signed in (ADR 0029 amendment of 2026-10-24).
  const learned =
    judgement.decision === "signed-in"
      ? addCompletion(recipe, observation, judgement.target)
      : undefined;
  // A marker that chooses the authenticator app is a sign-in step's button, so its page is
  // a challenge too (ADR 0081 amendment of 2026-11-03).
  const loginPage =
    learned?.ok === false &&
    (learned.reason === "login-page" || learned.reason === "sign-in-choice");
  if (!beside)
    await keepVerdict(
      loginPage
        ? "challenge"
        : partial && judgement.decision === "optional"
          ? "partial"
          : judgement.decision,
    );
  if (judgement.decision === "rejected") return { version: 1, status: "rejected" };
  // A page the person may put off is signed in, but nothing is learned there (ADR 0065):
  // its elements may never show on the usual signed-in page, so a marker comes only from a
  // page judged `signed-in`, and the path is judged again on the next login.
  if (judgement.decision === "optional") return { version: 1, status: "optional" };
  if (judgement.decision === "challenge") {
    // A page may offer both a security key and a TOTP code, or a button that goes on to
    // the password (ADR 0048); each handler that passes its checks is kept, in one revision
    // (ADR 0027).
    let changed: LoginRecipe | undefined;
    // Kinds and refusal reasons only: never an element, label or value.
    const handlers: {
      kind: "passkey" | "password" | "authenticator" | "totp" | "detail";
      kept: boolean;
      reason?: string;
    }[] = [];
    /** The handler added to the revision after the judged one, with what came before. */
    const keep = (handler: Parameters<typeof addHandler>[2]) => {
      const base = changed ?? recipe;
      const added = addHandler(base, observation, handler);
      if (added.ok) changed = changed ? { ...added.recipe, revision: base.revision } : added.recipe;
      handlers.push({
        kind: handler.kind,
        kept: added.ok,
        ...(added.ok ? {} : { reason: added.reason }),
      });
    };
    // A page beside the sign-in form keeps only a `detail` handler (ADR 0061).
    if (judgement.passkey && beside)
      handlers.push({ kind: "passkey", kept: false, reason: "beside" });
    else if (judgement.passkey) keep({ kind: "passkey", target: judgement.passkey });
    // A stop's page keeps only a `passkey` handler (ADR 0036).
    if (judgement.password && (stop || beside))
      handlers.push({ kind: "password", kept: false, reason: stop ? "stop" : "beside" });
    else if (judgement.password) keep({ kind: "password", target: judgement.password });
    // Nor an `authenticator` handler (ADR 0081): it goes on to a code, never learned there.
    if (judgement.authenticator && (stop || beside))
      handlers.push({ kind: "authenticator", kept: false, reason: stop ? "stop" : "beside" });
    else if (judgement.authenticator)
      keep({ kind: "authenticator", target: judgement.authenticator });
    // A code on a stop's page is never learned (ADR 0036), nor beside the sign-in form.
    if (judgement.totp && (stop || beside))
      handlers.push({ kind: "totp", kept: false, reason: stop ? "stop" : "beside" });
    else if (judgement.totp) keep({ kind: "totp", ...judgement.totp });
    // A code the judge named but its local checks refused is logged with why (ADR 0027).
    if (judgement.totpDropped && !stop && !beside)
      handlers.push({ kind: "totp", kept: false, reason: judgement.totpDropped });
    // Nor are a stop's details (ADR 0036, ADR 0061); each dropped input is logged by why.
    if (judgement.detail && stop) handlers.push({ kind: "detail", kept: false, reason: "stop" });
    else if (judgement.detail) keep({ kind: "detail", ...judgement.detail });
    if (!stop)
      for (const reason of judgement.detailsDropped ?? [])
        handlers.push({ kind: "detail", kept: false, reason });
    if (handlers.length) console.info("Judged page handlers", { recipeId, handlers });
    // The secret questions the judge paired with this account's slots (ADR 0061) answer
    // this request only: the recipe, shared by every account, never holds a field's name.
    // Only a `detail` handler kept for the page pairs anything; a stop keeps none.
    const questions =
      judgement.questions?.length &&
      handlers.some((handler) => handler.kind === "detail" && handler.kept)
        ? { questions: judgement.questions }
        : {};
    const withHandlers = changed && stored(head.recipe, branch, changed);
    // A page beside the sign-in form is a challenge only with the `detail` handler it adds,
    // its only handler there; without one it is still the sign-in page, kept as undecided
    // (ADR 0061).
    if (beside) {
      await keepVerdict(withHandlers ? "challenge" : "unclear");
      if (!withHandlers) return { version: 1, status: "unclear" };
    }
    if (!withHandlers) return { version: 1, status: "challenge", ...questions };
    // Handlers are only appended, so the ones after the judged route's are this call's.
    const before = recipe.handlers?.length ?? 0;
    const added = (changed?.handlers ?? []).slice(before).map((_, index) => before + index);
    const written = await backend.writeRecipe(
      recipeId,
      { version: 1, state: "active", expectedRevision: head.revision, recipe: withHandlers },
      { sources: judged(added.map(handlerUnit)) },
    );
    if (written.ok) {
      await backend.keepLogRevision(call.logId, written.change.revision);
      await markWritten(backend, recipeId, branch);
    }
    // The page is a challenge whether or not its handlers fit the owner's recipe bytes.
    if (!written.ok && written.limited)
      console.warn("Judged page handlers refused by the recipe limit", { recipeId });
    const change = written.ok ? answerable(written.change) : undefined;
    return { version: 1, status: "challenge", ...(change ? { change } : {}), ...questions };
  }
  // A later signed-in page adds its marker, up to four (ADR 0029). A page whose marker
  // cannot be added is still signed in, as with four, a marker the recipe has, one that
  // breaks the recipe's bounds or one of the recipe's own elements that a site's
  // signed-in page shows by the same locator (ADR 0029 amendment of 2026-10-24): only a
  // page that still shows the login's own elements fails closed. A recipe that has a
  // marker already, or a page of another origin of the site (ADR 0022), is signed in
  // even when the revision cannot be stored.
  const signedInAnyway = recipe.completion !== undefined || moved;
  const signedIn = { version: 1, status: "signed-in" } as const;
  if (!learned) return failed("invalid-output");
  if (!learned.ok) {
    console.info("Signed-in marker not learned", { recipeId, reason: learned.reason });
    return loginPage ? failed("invalid-output") : signedIn;
  }
  const learnedRecipe = stored(head.recipe, branch, learned.recipe);
  if (!learnedRecipe) return signedInAnyway ? signedIn : failed("recipe-invalid");
  // The marker learned is the route's last one.
  const learnedMarkers = learned.recipe.completion?.length ?? 0;
  const written = await backend.writeRecipe(
    recipeId,
    { version: 1, state: "active", expectedRevision: head.revision, recipe: learnedRecipe },
    { sources: judged(learnedMarkers ? [markerUnit(learnedMarkers - 1)] : []) },
  );
  if (written.ok) {
    await backend.keepLogRevision(call.logId, written.change.revision);
    await markWritten(backend, recipeId, branch);
  }
  const limited = !written.ok && written.limited;
  if (limited) console.warn("Signed-in marker refused by the recipe limit", { recipeId });
  const change = written.ok ? answerable(written.change) : undefined;
  if (change) return { ...signedIn, change };
  if (signedInAnyway) return signedIn;
  return unavailable(limited ? "recipe-limit" : "recipe-conflict");
}

/**
 * Keeps a repeat login's signed-in page in the request log, with the request built as the
 * judge's would be, without a model call (ADR 0029, owner 2026-10-18 08:05 UTC): `sampled`
 * when it wrote the row, `recent` when the owner already has a sample of the recipe and
 * branch from the last 30 days. `undefined` when the recipe or its revision is not the
 * owner's or not kept, or the revision is a tombstone; `null` for a page the revision
 * cannot have ended on: another origin, an incomplete description, a list of accounts, one
 * of the route's fill fields still shown, or a route or branch the revision does not have.
 * Nothing is logged for either.
 */
export async function samplePage(
  backend: GenerationBackend,
  recipeId: string,
  request: RecipePageSampleRequest,
): Promise<"sampled" | "recent" | undefined | null> {
  const change = await backend.readRevision(recipeId, request.revision);
  if (!change || change.state !== "active") return undefined;
  const { observation, route, branch, slots } = request;
  const recipe = routeOf(change.recipe, branch);
  if (
    !recipe ||
    !recipeHasRoute(recipe, route) ||
    observation.origin !== change.recipe.origin ||
    !observation.complete ||
    observation.accounts !== undefined ||
    // As for the judge, a page that still shows one of the password route's fill fields,
    // of any variant and on any path, is not a signed-in page; kept, it would hold off the
    // recipe's next sample for 30 days.
    observation.candidates.some((candidate) =>
      routeFillTargets(recipe, "password").some((target) =>
        sameLoginTarget(target, candidate.target),
      ),
    )
  )
    return null;
  const sampled = await backend.logPageSample({
    role: "judge",
    promptVersion: await completionPromptVersion(),
    origin: observation.origin,
    path: observation.path,
    request: {
      instructions: completionInstructions,
      recipeId,
      route,
      loginPaths: judgedLoginPaths(change.recipe, recipe, route),
      // The account's slots, as the judge request carries them (owner 2026-10-23).
      slots,
      observation,
    },
    recipe: { recipeId, branch, baseRevision: change.revision },
  });
  return sampled ? "sampled" : "recent";
}
