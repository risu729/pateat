import { type LoginRecipe } from "@pateat/contracts";
import { publish, report } from "./attempt";
import { confirmSigns } from "./markers";
import type { ConfirmOutcome } from "./confirm-state";
import type { Runtime } from "./state";
import type { ConfirmVisit, LiveDocument, Shown } from "./types";

/** Value-free page-kind evaluation also applies while the existing operation stays live. */
export function noteNotStarted(
  rt: Runtime,
  live: LiveDocument,
  shown: Shown | undefined,
  detail: string,
  recipe?: LoginRecipe,
  visit?: ConfirmVisit,
): void {
  if (shown?.path !== live.path || live.notStarted === detail || visit?.noted?.has(detail)) return;
  live.notStarted = detail;
  if (visit) {
    visit.shown = shown;
    (visit.noted ??= new Set()).add(detail);
  }
  const refused = {
    type: "refused" as const,
    tabId: live.document.tabId,
    origin: live.document.origin,
    reason: "not-started",
    detail,
    ...(live.document.frameId === 0 ? {} : { frame: true as const }),
  };
  if (!visit) {
    const later = shown?.later;
    report(rt, live.document, {
      ...refused,
      ...(detail === "first-step-missing" && recipe
        ? { recipeId: recipe.id, recipeRevision: recipe.revision }
        : {}),
      ...(later
        ? { laterSteps: later.steps, laterPartial: later.partial, laterMiss: later.miss }
        : {}),
    });
    return;
  }
  // A page Pateat does not fill also logs what it shows for the evaluation of page kinds
  // (ADR 0035), read first, so the entry names this page's URL; its visit logs the
  // person's submission and the next page once the tab leaves it.
  const amount = shown?.amount;
  visit.logged = confirmSigns(rt, live).then((signs) => {
    report(rt, live.document, {
      ...refused,
      recipeId: visit.recipe.id,
      recipeRevision: visit.recipe.revision,
      pageKind: visit.recipe.pageKind,
      ...(amount === undefined ? {} : { amount }),
      ...signs,
      url: live.url,
    });
    // Read as the `signedIn` hint false: the page was read and neither shows, E2 also
    // when it was not read.
    return signs.e1 === false && signs.e2 !== true;
  });
  void visit.logged.catch(() => undefined);
}

const documentOf = (live: LiveDocument) => `${live.document.tabId} ${live.document.documentId}`;

/**
 * A verification page's rows for its confirmation fill (ADR 0035 delivery 3), each once per
 * visit and with the page's evaluation fields: `confirm-fill` once it is checked, and
 * `confirm-fill-stopped` once the fill on its path stopped. A fill that ended before the
 * page reported its first step shown is logged when it does.
 */
export function noteConfirmFill(
  rt: Runtime,
  live: LiveDocument,
  shown: Shown | undefined,
  visit: ConfirmVisit,
): void {
  const reported = shown?.path === live.path ? shown : visit.shown;
  noteNotStarted(rt, live, reported, "confirm-fill", undefined, visit);
  const outcome = rt.confirmFill.outcomes.get(documentOf(live));
  if (outcome?.path === live.path && outcome.reason === "confirm-fill-stopped")
    noteNotStarted(rt, live, reported, "confirm-fill-stopped", undefined, visit);
}

/** How the document's fill on `path` ended, as the popup shows it, if one did. */
export function confirmOutcome(rt: Runtime, live: LiveDocument): ConfirmOutcome | undefined {
  const outcome = rt.confirmFill.outcomes.get(documentOf(live));
  return outcome?.path === live.path ? outcome.reason : undefined;
}

/**
 * Records how the document's confirmation fill on `path` ended. While `page`, the
 * document's latest announcement, is still on that path, its status shows the end and a
 * stop is logged.
 */
export async function settleConfirmFill(
  rt: Runtime,
  page: LiveDocument,
  path: string,
  reason: ConfirmOutcome,
): Promise<void> {
  rt.confirmFill.outcomes.set(documentOf(page), { path, reason });
  if (page.path !== path) return;
  page.state = "watching";
  page.reason = reason;
  const visit = rt.confirmVisits.get(page.document.tabId);
  if (visit?.document.documentId === page.document.documentId && visit.path === path)
    noteConfirmFill(rt, page, undefined, visit);
  await publish(rt, page);
}
