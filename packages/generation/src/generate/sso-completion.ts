import {
  isSsoDocument,
  sameLoginTarget,
  type GenerationUnavailableReason,
  type RecipeCompletionResult,
  type SsoCompletionRequest,
} from "@pateat/contracts";
import {
  completionBesidePromptVersion,
  completionInstructions,
  completionPromptVersion,
  completionStopPromptVersion,
  createCompletionJudge,
  unsafeSsoObservation,
} from "@pateat/inference";
import type { GenerationBackend, JudgementKey, KeptJudgement, UnsentRequest } from "../backend";
import {
  answerable,
  answerUnsent,
  failed,
  failureOf,
  modelCall,
  roleConfig,
  unavailable,
} from "./responses";
import { JUDGEMENTS_PER_RECIPE_DAY, staleHead, utcDayStart } from "./policy";
import { markWritten } from "./layout";
import { onStartPath } from "./start-alias";
import { ssoMarkerUnit } from "../units";

/** The most signed-in markers one SSO layout keeps on the site's return page. */
const MAX_SSO_MARKERS = 4;

/**
 * Judges the site's own page after the identity provider returned (ADR 0026 amendment of
 * 2026-11-12): the same judge role, provider path, daily limit and kept verdicts as a
 * native completion, with no account, mapping, IdP origin or fill slot in the request. A
 * page judged signed in teaches the SSO layout a marker of its own, which a later return
 * must show again before it completes.
 */
export async function judgeSsoCompletion(
  backend: GenerationBackend,
  recipeId: string,
  request: SsoCompletionRequest,
): Promise<RecipeCompletionResult | undefined | null> {
  const head = await backend.readHead(recipeId);
  if (!head) return undefined;
  // A return to one of the recipe's other start paths is judged as one to its start path
  // (ADR 0060 amendment of 2026-11-18).
  const observation = onStartPath(head, request.observation);
  const recipe = head.state === "active" ? head.recipe : undefined;
  if (recipe && recipe.origin !== observation.origin) return null;
  const promptVersion = await completionPromptVersion();
  const sso = recipe && isSsoDocument(recipe) ? recipe.sso : undefined;
  const layout = sso?.layouts.find((entry) => entry.key === request.layout);
  const loginPaths = sso ? [sso.path] : [];
  const logged = {
    role: "judge",
    promptVersion,
    origin: observation.origin,
    path: observation.path,
    request: {
      instructions: completionInstructions,
      kind: "sso-completion",
      recipeId,
      loginPaths,
      slots: [],
      observation,
    },
    recipe: { recipeId, branch: request.layout, baseRevision: head.revision },
  } satisfies UnsentRequest;
  const unsent = (reason: GenerationUnavailableReason) =>
    answerUnsent(backend, logged, unavailable(reason));
  if (head.state === "revoked") return unsent("recipe-revoked");
  if (head.revision !== request.revision || !layout) return unsent("recipe-conflict");
  // A sign-in form, list of accounts, new-account or permission page, or a page that
  // still shows the layout's own SSO entries, is no proof of the site's signed-in state.
  if (
    !observation.complete ||
    observation.accounts ||
    unsafeSsoObservation(observation) ||
    observation.candidates.some(
      (candidate) =>
        ["text", "email", "tel", "number", "password", "select"].includes(candidate.role) ||
        layout.entries.some((entry) => sameLoginTarget(entry.target, candidate.target)),
    )
  )
    return unsent("not-judgeable");
  const judgedPage: JudgementKey = {
    recipeId,
    branch: request.layout,
    revision: head.revision,
    origin: observation.origin,
    path: observation.path,
    promptVersion,
    // A return page is judged for a marker only: one with a text field is never judged.
    codeSource: "",
  };
  // A page of the revision and path is judged once: a later return completes only on a
  // `signed-in` verdict and the marker it taught.
  const judgedAnswer = (kept: KeptJudgement | undefined): GenerationUnavailableReason | undefined =>
    !kept
      ? undefined
      : kept.verdict === "signed-in"
        ? "judged-signed-in"
        : kept.verdict === null
          ? "judgement-unanswered"
          : "already-judged";
  // A layout that already keeps its most markers can learn no new one, so a page that shows
  // none of them is not sent to the model only for its answer to be dropped.
  const markers = layout.completion ?? [];
  if (
    markers.length >= MAX_SSO_MARKERS &&
    !observation.candidates.some((candidate) =>
      markers.some((marker) => sameLoginTarget(marker.target, candidate.target)),
    )
  )
    return unsent("recipe-limit");
  const versions = [
    promptVersion,
    await completionStopPromptVersion(),
    await completionBesidePromptVersion(),
  ];
  const call = await backend.call({
    ...logged,
    device: request.deviceModel,
    gate: async (now) => {
      const stale = staleHead(await backend.readHead(recipeId), head.revision);
      if (stale) return stale;
      const judged = judgedAnswer(await backend.judgement(judgedPage));
      if (judged) return judged;
      return (await backend.judgementsSince(recipeId, utcDayStart(now))) >=
        JUDGEMENTS_PER_RECIPE_DAY
        ? "judgement-limit"
        : undefined;
    },
    // A row another request wrote since the gate stops this one unsent (ADR 0018).
    beforeSend: async (now) =>
      (await backend.recordJudgement(judgedPage, now, { expired: utcDayStart(now), versions }, ""))
        ? undefined
        : (judgedAnswer(await backend.judgement(judgedPage)) ?? "judgement-unanswered"),
    invoke: (model) =>
      createCompletionJudge({ model, ...roleConfig })({
        observation,
        loginPaths,
        slots: [],
        recipeElements: layout.entries.map((entry) => entry.target),
      }),
    logValue: (value) => value,
  });
  if (call.status === "unavailable") return unsent(call.reason);
  if (call.status === "device-call") return modelCall(call);
  const { outcome } = call;
  if (outcome.status === "failed") {
    const answer = failed(failureOf(outcome.error));
    return outcome.calls === 0 ? answerUnsent(backend, logged, answer) : answer;
  }
  const verdict = outcome.status === "abstained" ? "unclear" : outcome.value.decision;
  await backend.keepVerdict(judgedPage, verdict).catch(() => {
    console.warn("SSO return verdict not kept", { recipeId, verdict });
  });
  if (outcome.status !== "ok" || outcome.value.decision !== "signed-in")
    return {
      version: 1,
      status:
        verdict === "rejected" ? "rejected" : verdict === "challenge" ? "challenge" : "unclear",
    };
  const target = outcome.value.target;
  if (
    !target ||
    !sso ||
    !observation.candidates.some((candidate) => sameLoginTarget(candidate.target, target)) ||
    layout.entries.some((entry) => sameLoginTarget(entry.target, target))
  )
    return unavailable("not-judgeable");
  if (markers.some((marker) => sameLoginTarget(marker.target, target)))
    return { version: 1, status: "signed-in" };
  if (markers.length >= MAX_SSO_MARKERS) return unavailable("recipe-limit");
  const learned = {
    ...recipe!,
    revision: head.revision + 1,
    sso: {
      ...sso,
      layouts: sso.layouts.map((entry) =>
        entry.key === layout.key ? { ...entry, completion: [...markers, { target }] } : entry,
      ),
    },
  };
  const written = await backend.writeRecipe(
    recipeId,
    { version: 1, state: "active", expectedRevision: head.revision, recipe: learned },
    {
      sources: {
        origin: "judged",
        units: [{ layout: layout.key, unit: ssoMarkerUnit(markers.length) }],
        served: call.served,
        promptVersion,
        logId: call.logId,
      },
    },
  );
  if (!written.ok) return unavailable("recipe-conflict");
  await backend.keepLogRevision(call.logId, written.change.revision, layout.key);
  await markWritten(backend, recipeId, layout.key);
  const change = answerable(written.change);
  return change ? { version: 1, status: "signed-in", change } : unavailable("recipe-conflict");
}
