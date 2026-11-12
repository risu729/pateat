import { type LoginRecipe } from "@pateat/contracts";
import { report } from "./attempt";
import { confirmSigns } from "./markers";
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
  if (shown?.path !== live.path || live.notStarted === detail) return;
  live.notStarted = detail;
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
