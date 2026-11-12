import * as v from "valibot";
import {
  isSsoDocument,
  newLayoutKey,
  normalizeSsoLabel,
  storedLayouts,
  storedLoginRecipeSchema,
  storedRecipeStartPath,
  withSsoLayout,
  type RecipeDocument,
  type SsoGenerationRequest,
  type SsoGenerationResult,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  createSsoGenerator,
  ssoGenerationInstructions,
  ssoGenerationPromptVersion,
  ssoObservation,
} from "@pateat/inference";
import type { GenerationBackend, UnsentRequest } from "../backend";
import {
  active,
  answerable,
  answerUnsent,
  failed,
  modelCall,
  roleConfig,
  unavailable,
  unsettled,
  type UnsentAnswer,
} from "./responses";
import {
  attemptWindow,
  generatedRecipeId,
  MIN_GENERATION_RECIPE_ROOM_BYTES,
  repairWindow,
} from "./policy";

/** Shared recipe identity and storage, separate route family and model role; never an executable step. */
export async function generateSso(
  backend: GenerationBackend,
  request: SsoGenerationRequest,
): Promise<SsoGenerationResult> {
  const { observation, labels, repair } = request;
  const { origin, path } = observation;
  const recipeId = await generatedRecipeId(origin, path);
  const headAtStart = await backend.readHead(recipeId);
  const logged = {
    role: "generate",
    promptVersion: await ssoGenerationPromptVersion(),
    origin,
    path,
    request: {
      instructions: ssoGenerationInstructions,
      observation: ssoObservation(observation),
      labels,
    },
    recipe: { recipeId, branch: "", baseRevision: headAtStart?.revision ?? 0, page: "first" },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<SsoGenerationResult, UnsentAnswer>) =>
    answerUnsent(backend, logged, answer);
  if (!observation.complete) return unsent(failed("incomplete-observation"));
  if (repair && repair.recipeId !== recipeId) return unsent(unavailable("recipe-conflict"));
  const covers = (change: SyncRecipeChange | null) => {
    const head = answerable(change);
    if (
      !head ||
      !isSsoDocument(head.recipe) ||
      head.recipe.id !== recipeId ||
      head.recipe.origin !== origin ||
      storedRecipeStartPath(head.recipe) !== path
    )
      return undefined;
    const sso = head.recipe.sso;
    return sso.layouts.some((layout) =>
      labels.every((label) =>
        layout.entries.some((entry) => normalizeSsoLabel(entry.label) === normalizeSsoLabel(label)),
      ),
    )
      ? head
      : undefined;
  };
  const decide = async (head: SyncRecipeChange | null) => {
    const current = active(head);
    if (repair && !current)
      return { answer: unavailable(head ? "recipe-revoked" : "recipe-conflict") };
    if (
      current &&
      (current.recipe.origin !== origin ||
        current.recipe.id !== recipeId ||
        storedRecipeStartPath(current.recipe) !== path ||
        "entry" in current.recipe ||
        "logout" in current.recipe)
    )
      return { answer: unavailable("recipe-conflict") };
    const covered = covers(head);
    if (covered && (!repair || repair.revision !== covered.revision))
      return { answer: { version: 1, status: "recipe", change: covered } as const };
    if (repair && current?.revision !== repair.revision)
      return { answer: unavailable("recipe-conflict") };
    if (
      (!current && !(await backend.hasRecipeRoom())) ||
      !(await backend.hasRecipeByteRoom(MIN_GENERATION_RECIPE_ROOM_BYTES))
    )
      return { answer: unavailable("recipe-limit") };
    return {
      revision: head?.revision ?? 0,
      document: current?.recipe as RecipeDocument | undefined,
    };
  };
  const before = await decide(headAtStart);
  if ("answer" in before) return unsent(before.answer);
  const baseRevision = before.revision;
  const recheck = async () =>
    (await backend.readHead(recipeId))?.revision !== headAtStart?.revision
      ? ("recipe-conflict" as const)
      : undefined;
  const call = await backend.call({
    ...logged,
    device: request.deviceModel,
    ...(repair
      ? repairWindow(backend, { recipeId, baseRevision }, recheck)
      : attemptWindow(backend, { recipeId, branch: "sso", origin, path, baseRevision }, recheck)),
    invoke: (model) => createSsoGenerator({ model, ...roleConfig })({ observation, labels }),
    logValue: (entries) => ({
      entries: entries.map(({ label, candidate }) => ({ label, candidate })),
    }),
  });
  if (call.status === "unavailable") return unsent(unavailable(call.reason));
  if (call.status === "device-call") return modelCall(call);
  const result = unsettled(call.outcome);
  if ("answer" in result)
    return call.outcome.calls === 0 && result.answer.status === "failed"
      ? unsent(result.answer)
      : result.answer;
  const createdAt = Date.now();
  const uses = await backend.layoutUses(recipeId);
  let document: RecipeDocument = before.document ?? {
    version: 1,
    id: recipeId,
    revision: baseRevision,
    origin,
  };
  let expectedRevision = baseRevision;
  for (let tries = 0; tries < 2; tries += 1) {
    const key = newLayoutKey(
      createdAt,
      storedLayouts(document).map((layout) => layout.key),
    );
    const next = withSsoLayout(
      document,
      path,
      {
        key,
        createdAt,
        ...(observation.language === "mixed" ? {} : { language: observation.language }),
        entries: result.value.map(({ label, target }) => ({ label, target })),
      },
      (layout) => uses?.get(layout),
    );
    if (next === document) {
      // oxlint-disable-next-line no-await-in-loop -- the current conditional head is authoritative
      const current = covers(await backend.readHead(recipeId));
      return current
        ? { version: 1, status: "recipe", change: current }
        : unavailable("recipe-conflict");
    }
    const recipe = { ...next, revision: expectedRevision + 1 };
    if (!v.is(storedLoginRecipeSchema, recipe)) return failed("recipe-invalid");
    // oxlint-disable-next-line no-await-in-loop -- at most one rebase over an unchanged SSO family
    const written = await backend.writeRecipe(
      recipeId,
      { version: 1, state: "active", expectedRevision, recipe },
      {
        sources: {
          origin: "generated",
          units: [{ layout: key, unit: "sso" }],
          served: call.served,
          promptVersion: call.promptVersion ?? logged.promptVersion,
          logId: call.logId,
        },
      },
    );
    if (written.ok) {
      // oxlint-disable-next-line no-await-in-loop -- keep the revision actually written
      await backend.keepLogRevision(call.logId, written.change.revision, key);
      const change = covers(written.change);
      return change ? { version: 1, status: "recipe", change } : unavailable("recipe-conflict");
    }
    if (written.limited) return unavailable("recipe-limit");
    const current = answerable(written.current);
    const unchanged =
      current &&
      current.recipe.id === recipeId &&
      current.recipe.origin === origin &&
      storedRecipeStartPath(current.recipe) === path &&
      !("entry" in current.recipe) &&
      !("logout" in current.recipe) &&
      JSON.stringify(current.recipe.sso) === JSON.stringify(before.document?.sso);
    // A native-only write does not repair stale SSO entries: retain this paid answer.
    if (!unchanged) {
      const won = covers(written.current);
      return won ? { version: 1, status: "recipe", change: won } : unavailable("recipe-conflict");
    }
    document = current.recipe;
    expectedRevision = current.revision;
  }
  return unavailable("recipe-conflict");
}
