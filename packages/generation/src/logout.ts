import {
  isGeneratedRecipeId,
  safeLogoutName,
  type LoginLogoutRecipe,
  type LogoutAbstention,
  type LogoutGenerationRequest,
  type LogoutGenerationResult,
  type StoredLoginRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  accountText,
  appendLogoutClick,
  createLogoutGenerator,
  logoutInstructions,
  logoutPromptVersion,
  outputRejection,
} from "@pateat/inference";
import type { GenerationBackend, UnsentRequest } from "./backend";
import {
  active,
  answerUnsent,
  attemptWindow,
  failed,
  failureOf,
  MIN_GENERATION_RECIPE_ROOM_BYTES,
  modelCall,
  roleConfig,
  unavailable,
  type UnsentAnswer,
} from "./generate";
import { LOGOUT_UNIT } from "./units";

// The logout route of an account switch (ADR 0063): a signed-in page of the tab the switch
// runs in, one round at a time, answered with the click that signs out, opens the menu
// holding it or confirms it, kept as the origin and path's logout recipe.

/**
 * The ID of an origin and path's logout recipe: derived as a generated recipe's is, but
 * from a different input, so it never collides with the login, chooser or entry recipe
 * that starts on the same path (ADR 0016's one generated recipe per origin and start path).
 */
export async function generatedLogoutRecipeId(origin: string, path: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["logout", origin, path])),
  );
  return `gen-${new Uint8Array(digest).toHex().slice(0, 32)}`;
}

type Decided =
  | { answer: Extract<LogoutGenerationResult, { status: "recipe" | "unavailable" }> }
  | { base: LoginLogoutRecipe | undefined; revision: number };

const logoutAbstentions = new Set<string>([
  "no-logout-control",
  "ambiguous",
  "insufficient-evidence",
  "unsafe-instructions",
]);

/**
 * `POST /v1/recipes/logout`. Returns `undefined` when `base` names a recipe ID that is not a
 * generated one, or `local` a control by an account's text, which the route answers as a
 * bad request. Without `base` a stored logout recipe of the origin and path (`local`'s path
 * after a local click) answers without a model call; with `base`, a head newer than it
 * does, as another device appended the page first. The answer's click is appended as the
 * next revision, after `base`'s clicks (those before `keep` when it is set) and then
 * `local`'s click; a `signed-out` answer and an abstention store nothing.
 */
export async function generateLogout(
  backend: GenerationBackend,
  request: LogoutGenerationRequest,
): Promise<LogoutGenerationResult | undefined> {
  const { observation, base, local } = request;
  const { origin, path } = observation;
  // A control the extension found by its words never names an account (ADR 0028's rule),
  // nor logs out elsewhere or ends the account (ADR 0063).
  if (
    local &&
    (accountText.test(local.target.value) || !safeLogoutName(local.target.value, "logout"))
  )
    return undefined;
  const recipeId = base?.recipeId ?? (await generatedLogoutRecipeId(origin, local?.path ?? path));
  if (!isGeneratedRecipeId(recipeId)) return undefined;
  const headAtStart = await backend.readHead(recipeId);
  // What the request log keeps of the request, sent or not (ADR 0012).
  const logged = {
    role: "generate",
    promptVersion: await logoutPromptVersion(),
    origin,
    path,
    request: { instructions: logoutInstructions, observation },
    recipe: {
      recipeId,
      branch: "",
      baseRevision: headAtStart?.revision ?? 0,
      // Its own page, so the dashboard keeps logouts apart from login generation.
      page: "logout",
    },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<LogoutGenerationResult, UnsentAnswer>) =>
    answerUnsent(backend, logged, answer);
  if (!observation.complete) return unsent(failed("incomplete-observation"));

  /** Whether a stored recipe is the logout recipe generated under this ID for this origin. */
  const ours = async (recipe: StoredLoginRecipe): Promise<boolean> =>
    "logout" in recipe &&
    recipe.origin === origin &&
    recipe.id === recipeId &&
    (await generatedLogoutRecipeId(origin, recipe.logout.path)) === recipeId;
  const room = async () =>
    (await backend.hasRecipeRoom()) &&
    (await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES));
  const stored = (change: SyncRecipeChange & { state: "active" }) =>
    "logout" in change.recipe
      ? ({ version: 1, status: "recipe", change: { ...change, recipe: change.recipe } } as const)
      : unavailable("recipe-conflict");

  /** What the stored head means for this request; checked again under the owner's lock. */
  const decide = async (head: SyncRecipeChange | null): Promise<Decided> => {
    // A revoked recipe is generated again from its first page, as the revision after its
    // tombstone; a later page never continues it.
    if (head?.state === "revoked") {
      if (base) return { answer: unavailable("recipe-revoked") };
      return (await room())
        ? { base: undefined, revision: head.revision }
        : { answer: unavailable("recipe-limit") };
    }
    const current = active(head);
    if (current && !(await ours(current.recipe))) return { answer: unavailable("recipe-conflict") };
    if (!base) {
      if (current) return { answer: stored(current) };
      return (await room())
        ? { base: undefined, revision: 0 }
        : { answer: unavailable("recipe-limit") };
    }
    if (!current) return { answer: unavailable("recipe-conflict") };
    // Another device already appended a page after this base: use that.
    if (current.revision !== base.revision) return { answer: stored(current) };
    if (!(await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES)))
      return { answer: unavailable("recipe-limit") };
    return "logout" in current.recipe
      ? { base: current.recipe, revision: current.revision }
      : { answer: unavailable("recipe-conflict") };
  };
  const before = await decide(headAtStart);
  if ("answer" in before) return unsent(before.answer);
  const baseRevision = before.revision;
  let raced: Extract<LogoutGenerationResult, { status: "recipe" | "unavailable" }> | undefined;

  const call = await backend.call({
    ...logged,
    device: request.deviceModel,
    recipe: { ...logged.recipe, baseRevision },
    ...attemptWindow(backend, { recipeId, branch: "", origin, path, baseRevision }, async () => {
      // Another device may have stored this page while this request waited for the lock.
      const latest = await decide(await backend.readHead(recipeId));
      if ("answer" in latest) {
        raced = latest.answer;
        return "recipe-conflict";
      }
      return latest.revision !== baseRevision ? "recipe-conflict" : undefined;
    }),
    invoke: (model) => createLogoutGenerator({ model, ...roleConfig })({ observation }),
    logValue: (value) =>
      value.decision === "logout"
        ? { decision: value.decision, control: value.control, purpose: value.purpose }
        : value,
  });
  if (call.status === "unavailable") return unsent(raced ?? unavailable(call.reason));
  if (call.status === "device-call") return modelCall(call);
  const { outcome } = call;
  if (outcome.status === "failed") {
    const rejection = outputRejection(outcome);
    const answer = { ...failed(failureOf(outcome.error)), ...(rejection ? { rejection } : {}) };
    // A request the role refused locally, as one too large, was never sent.
    return outcome.calls === 0 ? unsent(answer) : answer;
  }
  if (outcome.status === "abstained")
    return {
      version: 1,
      status: "abstained",
      reason: (logoutAbstentions.has(outcome.reason)
        ? outcome.reason
        : "insufficient-evidence") as LogoutAbstention,
    };
  const answer = outcome.value;
  if (answer.decision === "signed-out") return { version: 1, status: "signed-out" };
  // The base's clicks that still worked (all of them without `keep`), then the local click
  // the page follows, if any; the answer's click comes after them.
  const kept = before.base?.logout.targets.slice(0, base?.keep) ?? [];
  const localClick = local && {
    kind: "click" as const,
    path: local.path,
    target: local.target,
    purpose: "logout" as const,
  };
  const targets = localClick ? [...kept, localClick] : kept;
  const start: LoginLogoutRecipe | undefined = targets.length
    ? {
        version: 1,
        id: recipeId,
        revision: baseRevision,
        origin,
        // The recipe starts where its ID was derived: the base's path, else the local click's.
        logout: { path: before.base?.logout.path ?? local?.path ?? path, targets },
      }
    : undefined;
  const built = appendLogoutClick(
    start,
    { id: recipeId, revision: baseRevision + 1, origin, path },
    answer,
  );
  if (!built.ok) return failed("recipe-invalid");
  const written = await backend.writeRecipe(
    recipeId,
    { version: 1, state: "active", expectedRevision: baseRevision, recipe: built.recipe },
    {
      sources: {
        origin: "generated",
        units: [{ layout: null, unit: LOGOUT_UNIT }],
        served: call.served,
        promptVersion: logged.promptVersion,
        logId: call.logId,
      },
    },
  );
  if (!written.ok) {
    if (written.limited) return unavailable("recipe-limit");
    // A write lost to another device answers with that device's recipe, as above.
    const lost = await decide(written.current);
    return "answer" in lost ? lost.answer : unavailable("recipe-conflict");
  }
  await backend.keepLogRevision(call.logId, written.change.revision);
  const change = active(written.change);
  return change ? stored(change) : unavailable("recipe-conflict");
}
