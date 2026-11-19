import * as v from "valibot";
import {
  canonicalJson,
  isSsoDocument,
  nativeTargetOn,
  newLayoutKey,
  ssoBesideNative,
  ssoCovers,
  storedLayouts,
  storedLoginRecipeSchema,
  storedRecipeStartPath,
  withSsoEntries,
  type RecipeDocument,
  type SsoGenerationRequest,
  type SsoGenerationResult,
  type SsoRoutes,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  createSsoGenerator,
  ssoGenerationInstructions,
  ssoGenerationPromptVersion,
  ssoObservation,
} from "@pateat/inference";
import type { GenerationBackend, UnsentRequest } from "../backend";
import { aliasedStart } from "./start-alias";
import { SSO_UNIT } from "../units";
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

/**
 * The branch an SSO entry request is logged and retried under (ADR 0016): the recipe's
 * stored SSO entries, whatever labels the request names. Another label set gets no call
 * of its own within the window, so labels absent from the page never buy one call each;
 * only a write of new SSO entries opens the window again, and a native write, which
 * leaves them alone, does not.
 */
export async function ssoBranch(sso: SsoRoutes | undefined) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(sso ?? null)),
  );
  return `sso:${new Uint8Array(digest).toHex().slice(0, 16)}`;
}

/**
 * SSO entries of a page (ADR 0026 amendment of 2026-11-12): the recipe's identity and
 * storage, but a route family and model role of their own, never an executable step.
 */
export async function generateSso(
  backend: GenerationBackend,
  request: SsoGenerationRequest,
): Promise<SsoGenerationResult> {
  const { labels, repair } = request;
  // A page on another recipe's other start path keeps its entries in that recipe, read on
  // its start path (ADR 0060 amendment of 2026-11-18).
  const aliased = await aliasedStart(backend, request.observation);
  const observation = aliased?.observation ?? request.observation;
  const { origin, path } = observation;
  const recipeId = aliased?.recipeId ?? (await generatedRecipeId(origin, path));
  const headAtStart = await backend.readHead(recipeId);
  const startRecipe = active(headAtStart)?.recipe;
  const startDocument =
    startRecipe && !("entry" in startRecipe) && !("logout" in startRecipe)
      ? startRecipe
      : undefined;
  // An element a native route uses is never offered: SSO entries give way to native routes.
  const native = startDocument ? nativeTargetOn(startDocument, path) : () => false;
  const offered = {
    ...observation,
    candidates: observation.candidates.filter((candidate) => !native(candidate.target)),
  };
  const branch = await ssoBranch(startDocument?.sso);
  const logged = {
    role: "generate",
    promptVersion: await ssoGenerationPromptVersion(),
    origin,
    path,
    request: {
      instructions: ssoGenerationInstructions,
      observation: ssoObservation(offered),
      labels,
    },
    recipe: { recipeId, branch, baseRevision: headAtStart?.revision ?? 0, page: "sso" },
  } satisfies UnsentRequest;
  const unsent = (answer: Extract<SsoGenerationResult, UnsentAnswer>) =>
    answerUnsent(backend, logged, answer);
  if (!observation.complete) return unsent(failed("incomplete-observation"));
  if (repair && repair.recipeId !== recipeId) return unsent(unavailable("recipe-conflict"));
  /** The head, when each requested label has an entry on this page in some layout. */
  const covers = (change: SyncRecipeChange | null) => {
    const head = answerable(change);
    return head &&
      isSsoDocument(head.recipe) &&
      head.recipe.id === recipeId &&
      head.recipe.origin === origin &&
      storedRecipeStartPath(head.recipe) === path &&
      ssoCovers(head.recipe.sso, labels)
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
      ? repairWindow(backend, { recipeId, baseRevision, family: "sso" }, recheck)
      : // Keyed by the SSO family, not the revision a native write moves (`ssoBranch`).
        attemptWindow(backend, { recipeId, branch, origin, path, baseRevision: 0 }, recheck)),
    invoke: (model) =>
      createSsoGenerator({ model, ...roleConfig })({ observation: offered, labels }),
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
    const merged = withSsoEntries(
      document,
      path,
      {
        key,
        createdAt,
        ...(observation.language === "mixed" ? {} : { language: observation.language }),
      },
      result.value.map(({ label, target }) => ({ label, target })),
      { repair: repair !== undefined, lastUsed: (layout) => uses?.get(layout) },
    );
    // A native route written meanwhile keeps its elements; entries on them give way.
    const next = ssoBesideNative(merged.recipe);
    if (next === document) {
      // oxlint-disable-next-line no-await-in-loop -- the current conditional head is authoritative
      const current = covers(await backend.readHead(recipeId));
      return current
        ? { version: 1, status: "recipe", change: current }
        : unavailable("recipe-conflict");
    }
    if (!ssoCovers(next.sso, labels)) return unavailable("recipe-conflict");
    const recipe = { ...next, revision: expectedRevision + 1 };
    if (!v.is(storedLoginRecipeSchema, recipe)) return failed("recipe-invalid");
    // oxlint-disable-next-line no-await-in-loop -- at most one rebase over an unchanged SSO family
    const written = await backend.writeRecipe(
      recipeId,
      { version: 1, state: "active", expectedRevision, recipe },
      {
        sources: {
          origin: "generated",
          units: [{ layout: merged.layout, unit: SSO_UNIT }],
          served: call.served,
          promptVersion: call.promptVersion ?? logged.promptVersion,
          logId: call.logId,
        },
      },
    );
    if (written.ok) {
      // oxlint-disable-next-line no-await-in-loop -- keep the revision actually written
      await backend.keepLogRevision(call.logId, written.change.revision, merged.layout);
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
      canonicalJson(current.recipe.sso ?? null) === canonicalJson(before.document?.sso ?? null);
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
