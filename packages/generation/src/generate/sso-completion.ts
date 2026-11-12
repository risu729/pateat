import { markWritten } from "./layout";
import {
  deviceModelRequestHash,
  isSsoDocument,
  sameLoginTarget,
  type GenerationUnavailableReason,
  type RecipeCompletionResult,
  type SsoCompletionRequest,
} from "@pateat/contracts";
import {
  completionInstructions,
  completionPromptVersion,
  createCompletionJudge,
  unsafeSsoObservation,
} from "@pateat/inference";
import type {
  GenerationBackend,
  JudgementKey,
  JudgementReservation,
  UnsentRequest,
} from "../backend";
import {
  answerable,
  answerUnsent,
  failed,
  failureOf,
  modelCall,
  roleConfig,
  unavailable,
} from "./responses";
import { staleHead, utcDayStart } from "./policy";

/** Same judge role, provider relay and atomic daily reservation as native completion. */
export async function judgeSsoCompletion(
  backend: GenerationBackend,
  recipeId: string,
  request: SsoCompletionRequest,
): Promise<RecipeCompletionResult | undefined | null> {
  const head = await backend.readHead(recipeId);
  if (!head) return undefined;
  const { observation } = request;
  const recipe = head.state === "active" ? head.recipe : undefined;
  if (recipe && recipe.origin !== observation.origin) return null;
  const promptVersion = await completionPromptVersion();
  const layout =
    recipe &&
    isSsoDocument(recipe) &&
    recipe.sso.layouts.find((entry) => entry.key === request.layout);
  const paths = recipe && isSsoDocument(recipe) ? [recipe.sso.path] : [];
  const logged = {
    role: "judge",
    promptVersion,
    origin: observation.origin,
    path: observation.path,
    request: {
      instructions: completionInstructions,
      kind: "sso-completion",
      observation,
      loginPaths: paths,
      slots: [],
    },
    recipe: { recipeId, branch: request.layout, baseRevision: head.revision },
  } satisfies UnsentRequest;
  const unsent = (reason: GenerationUnavailableReason) =>
    answerUnsent(backend, logged, unavailable(reason));
  if (head.state === "revoked") return unsent("recipe-revoked");
  if (head.revision !== request.revision || !layout) return unsent("recipe-conflict");
  // An existing login/chooser, new-account or permission page cannot be positive RP proof.
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
  const key: JudgementKey = {
    recipeId,
    branch: request.layout,
    revision: head.revision,
    origin: observation.origin,
    path: observation.path,
    promptVersion,
  };
  const paired = request.deviceModel?.judgement;
  if (request.deviceModel && !paired) return unsent("judgement-unanswered");
  const operation: JudgementReservation = {
    id: paired?.id ?? crypto.randomUUID(),
    startedAt: paired?.startedAt ?? 0,
    fingerprint: await deviceModelRequestHash(
      JSON.stringify({ ...request, deviceModel: undefined, promptVersion }),
    ),
  };
  if (paired?.cancel) {
    if (request.deviceModel?.responses.length === 0) await backend.cancelJudgement(key, operation);
    return unsent("judgement-unanswered");
  }
  const heldAnswer = async (): Promise<GenerationUnavailableReason | undefined> => {
    const kept = await backend.judgement(key);
    if (!kept) return undefined;
    return kept.verdict === "signed-in"
      ? "judged-signed-in"
      : kept.verdict === null
        ? "judgement-unanswered"
        : "already-judged";
  };
  const reserve = async (now: number): Promise<GenerationUnavailableReason | undefined> => {
    const result = await backend.reserveJudgement(
      key,
      now,
      { expired: utcDayStart(now), versions: [promptVersion] },
      "sso-return",
      operation,
    );
    return result.status === "limited"
      ? "judgement-limit"
      : result.status === "held"
        ? ((await heldAnswer()) ?? "judgement-unanswered")
        : undefined;
  };
  const call = await backend.call({
    ...logged,
    device: request.deviceModel,
    gate: async (now) => {
      const stale = staleHead(await backend.readHead(recipeId), head.revision);
      if (stale) return stale;
      if (paired?.startedAt === undefined) operation.startedAt = now;
      const reservation = await backend.judgementReservation(key, operation, now);
      if (reservation.status === "invalid") return "judgement-unanswered";
      if (reservation.status === "active") {
        if (
          !request.deviceModel ||
          !(await backend.continueJudgement(
            key,
            operation,
            request.deviceModel.responses.map((response) => response.request),
            now,
          ))
        )
          return "judgement-unanswered";
        return undefined;
      }
      if (paired?.startedAt !== undefined || request.deviceModel?.responses.length)
        return "judgement-unanswered";
      return heldAnswer();
    },
    beforeSend: reserve,
    invoke: (model) =>
      createCompletionJudge({ model, ...roleConfig })({
        observation,
        loginPaths: paths,
        slots: [],
        recipeElements: layout.entries.map((entry) => entry.target),
      }),
    logValue: (value) => value,
  });
  if (call.status === "unavailable") return unsent(call.reason);
  if (call.status === "device-call") {
    const refused = await reserve(Date.now());
    if (refused) return unsent(refused);
    if (
      !(await backend.dispatchJudgement(key, operation, {
        index: call.call.index,
        hash: await deviceModelRequestHash(call.call.body),
      }))
    )
      return unsent("judgement-unanswered");
    return { ...modelCall(call), judgement: { id: operation.id, startedAt: operation.startedAt } };
  }
  await backend.finishJudgement(key, operation);
  const { outcome } = call;
  if (outcome.status === "failed") return failed(failureOf(outcome.error));
  const verdict = outcome.status === "abstained" ? "unclear" : outcome.value.decision;
  await backend.keepVerdict(key, verdict, operation.id, "sso-return");
  if (outcome.status !== "ok" || outcome.value.decision !== "signed-in")
    return {
      version: 1,
      status:
        verdict === "rejected" ? "rejected" : verdict === "challenge" ? "challenge" : "unclear",
    };
  const target = outcome.value.target;
  if (
    !target ||
    !observation.candidates.some((candidate) => sameLoginTarget(candidate.target, target)) ||
    layout.entries.some((entry) => sameLoginTarget(entry.target, target)) ||
    !recipe ||
    !isSsoDocument(recipe)
  )
    return unavailable("not-judgeable");
  const markers = layout.completion ?? [];
  if (markers.some((marker) => sameLoginTarget(marker.target, target)))
    return { version: 1, status: "signed-in" };
  if (markers.length >= 4) return unavailable("recipe-limit");
  const learned = {
    ...recipe,
    revision: head.revision + 1,
    sso: {
      ...recipe.sso,
      layouts: recipe.sso.layouts.map((entry) =>
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
        units: [{ layout: layout.key, unit: `sso-marker:${markers.length}` }],
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
