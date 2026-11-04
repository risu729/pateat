import {
  type EntryGenerationRequest,
  type EntryGenerationResult,
  type LoginEntryRecipe,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  createEntryGenerator,
  entryGenerationInstructions,
  entryGenerationPromptVersion,
  entryRecipe,
} from "@pateat/inference";
import { type GenerationBackend, type UnsentRequest } from "../backend";
import { ENTRY_UNIT } from "../units";
import {
  type UnsentAnswer,
  roleConfig,
  answerUnsent,
  unavailable,
  failed,
  modelCall,
  active,
  unsettled,
} from "./responses";
import {
  MIN_GENERATION_RECIPE_ROOM_BYTES,
  generatedRecipeId,
  repairWindow,
  attemptWindow,
} from "./policy";

/**
 * `POST /v1/recipes/generate` without `slots`: an entry request (ADR 0031) for a page
 * without a login form. The model names the link that opens the site's login page, which
 * is stored as the entry recipe of the page's origin and path under its generated ID. The
 * retry window, attempt row, spend limits and request log are a first page's; a login or
 * chooser recipe starting on that path answers `recipe-conflict`.
 */
export async function generateEntry(
  backend: GenerationBackend,
  request: EntryGenerationRequest,
): Promise<EntryGenerationResult> {
  const { observation, repair } = request;
  const { origin, path } = observation;
  const recipeId = await generatedRecipeId(origin, path);
  // An entry's repair names the entry recipe of its own page (ADR 0041 section 6).
  if (repair && repair.recipeId !== recipeId) return unavailable("recipe-conflict");
  const headAtStart = await backend.readHead(recipeId);
  // What the request log keeps of the request, sent or not (ADR 0012).
  const logged = {
    role: "generate",
    promptVersion: await entryGenerationPromptVersion(),
    origin,
    path,
    request: { instructions: entryGenerationInstructions, observation },
    recipe: { recipeId, branch: "", baseRevision: headAtStart?.revision ?? 0, page: "first" },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<EntryGenerationResult, UnsentAnswer>) =>
    answerUnsent(backend, logged, answer);
  if (!observation.complete) return unsent(failed("incomplete-observation"));

  /**
   * What the stored head means for this request: an answer without a model call, or the
   * revision the new recipe follows (its tombstone's, or 0). Checked again once the
   * request holds a call slot.
   */
  const decide = async (
    head: SyncRecipeChange | null,
  ): Promise<
    | { answer: Extract<EntryGenerationResult, { status: "recipe" | "unavailable" }> }
    | { revision: number; repaired?: LoginEntryRecipe }
  > => {
    const current = active(head);
    if (repair && !current)
      return { answer: unavailable(head ? "recipe-revoked" : "recipe-conflict") };
    if (current) {
      // Only the entry recipe generated here answers; a login or chooser recipe on its path,
      // or a device write under the ID for another page, is no entry to answer with.
      const { recipe } = current;
      if (
        !("entry" in recipe) ||
        recipe.origin !== origin ||
        recipe.id !== recipeId ||
        recipe.entry.path !== path
      )
        return { answer: unavailable("recipe-conflict") };
      // A repair of the revision it names asks the model again, as one per device a day
      // (ADR 0041); any other revision answers as it is.
      if (!repair || current.revision !== repair.revision)
        return { answer: { version: 1, status: "recipe", change: { ...current, recipe } } };
      return (await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES))
        ? { revision: current.revision, repaired: recipe }
        : { answer: unavailable("recipe-limit") };
    }
    // A revoked recipe is generated again as the revision after its tombstone (owner,
    // 2026-10-12), and a new one needs room under the active recipe limit.
    if (
      !(await backend.hasRecipeRoom()) ||
      !(await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES))
    )
      return { answer: unavailable("recipe-limit") };
    return { revision: head?.revision ?? 0 };
  };
  const before = await decide(headAtStart);
  if ("answer" in before) return unsent(before.answer);
  const baseRevision = before.revision;
  let raced: Extract<EntryGenerationResult, { status: "recipe" | "unavailable" }> | undefined;

  // Another device may have stored this recipe while this request waited for a call slot.
  const recheck = async () => {
    const latest = await decide(await backend.readHead(recipeId));
    if ("answer" in latest) {
      raced = latest.answer;
      return "recipe-conflict" as const;
    }
    return latest.revision !== baseRevision ? ("recipe-conflict" as const) : undefined;
  };
  const call = await backend.call({
    ...logged,
    device: request.deviceModel,
    recipe: { ...logged.recipe, baseRevision },
    // A repair is limited to one a UTC day per recipe and device (ADR 0041).
    ...(repair
      ? repairWindow(backend, { recipeId, baseRevision }, recheck)
      : attemptWindow(backend, { recipeId, branch: "", origin, path, baseRevision }, recheck)),
    invoke: (model) => createEntryGenerator({ model, ...roleConfig })({ observation }),
    logValue: ({ entry: candidate }) => ({ entry: candidate }),
  });
  if (call.status === "unavailable") return unsent(raced ?? unavailable(call.reason));
  if (call.status === "device-call") return modelCall(call);
  const result = unsettled(call.outcome);
  // A request the role refused locally, as one too large, was never sent; the roles refuse
  // locally only with a failure.
  if ("answer" in result)
    return call.outcome.calls === 0 && result.answer.status === "failed"
      ? unsent(result.answer)
      : result.answer;
  // A repaired entry whose link the model names again keeps its revision (ADR 0041).
  if (
    before.repaired &&
    JSON.stringify(before.repaired.entry.target) === JSON.stringify(result.value.target)
  ) {
    const current = active(await backend.readHead(recipeId));
    return current && "entry" in current.recipe
      ? { version: 1, status: "recipe", change: { ...current, recipe: current.recipe } }
      : unavailable("recipe-conflict");
  }
  // A recipe generated again follows its tombstone's revision, a repaired one its own.
  const built = entryRecipe({
    id: recipeId,
    revision: baseRevision + 1,
    origin,
    path,
    target: result.value.target,
  });
  if (!built.ok) return failed("recipe-invalid");
  const written = await backend.writeRecipe(
    recipeId,
    { version: 1, state: "active", expectedRevision: baseRevision, recipe: built.recipe },
    {
      sources: {
        origin: "generated",
        units: [{ layout: null, unit: ENTRY_UNIT }],
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
  return change && "entry" in change.recipe
    ? { version: 1, status: "recipe", change: { ...change, recipe: change.recipe } }
    : unavailable("recipe-conflict");
}
