import { isCodeField, loginObservationSchema, type ObservedCandidate } from "@pateat/contracts";
import * as v from "valibot";
import { closestAcross, composedOrder, containsAcross, queryAll } from "../page/shadow";
import { observedPath } from "./path";
import type { ObservationGap, ObservationResult, Draft, Chosen } from "./extract-types";
import { landmarks } from "./extract-controls";
import { bounded, uncutText, visibleText, language } from "./extract-text";
import { nearCodeTexts, nearButtonTexts } from "./extract-near-text";

/** A described result marked with why it is incomplete, if it is. */
export const withGap = (
  result: ObservationResult,
  gap: ObservationGap | undefined,
): ObservationResult => (result.ok && gap ? { ...result, gap } : result);

const maxHeadings = 8;

/**
 * Numbers the chosen elements in document order and adds the page's title and headings;
 * with `near`, also the texts near its first code field (`nearCodeTexts`) or, without one,
 * near its buttons (`nearButtonTexts`). Every text is cut at 120 characters once `hide`
 * has run.
 */
export function observe(
  document: Document,
  chosen: Chosen[],
  complete: boolean,
  hideText: (text: string) => string = (text) => text,
  accounts?: readonly string[],
  header?: string,
  path = observedPath(document.location!.pathname),
  near = false,
): ObservationResult {
  const location = document.location!;
  const hide = (text: string) => bounded(hideText(text));
  chosen.sort((left, right) => composedOrder(left.draft.element, right.draft.element));

  const groups = new Map<HTMLFormElement, string>();
  const candidates = chosen.map(
    (
      { form, draft: { element: _element, label, placeholder, description, ...rest }, target },
      at,
    ) => {
      const shownLabel = label && hide(label);
      const shownDescription = description && hide(description);
      const shownPlaceholder = placeholder && hide(placeholder);
      return {
        id: `c${at + 1}`,
        ...rest,
        ...(shownLabel ? { label: shownLabel } : {}),
        ...(shownPlaceholder ? { placeholder: shownPlaceholder } : {}),
        // Still left out when it repeats the label once hidden.
        ...(shownDescription && shownDescription !== shownLabel
          ? { description: shownDescription }
          : {}),
        target,
        ...(form ? { group: groups.getOrInsertComputed(form, () => `f${groups.size + 1}`) } : {}),
      } satisfies ObservedCandidate;
    },
  );

  const pageTitle = uncutText(document.title);
  const title = pageTitle && hide(pageTitle);
  const headings = [
    ...new Set(
      queryAll(document, "h1, h2, h3").flatMap((heading) => {
        const text = visibleText(heading);
        const hidden = text && hide(text);
        return hidden ? [hidden] : [];
      }),
    ),
  ].slice(0, maxHeadings);
  // A split code's first input comes first in page order.
  const codeAt = near ? candidates.findIndex(isCodeField) : -1;
  const code = candidates[codeAt];
  const repeated = new Set([title, ...headings, code?.label, code?.placeholder, code?.description]);
  // A text that repeats one the page already carries, or with fewer than two letters
  // beside its placeholders, such as a timer or one typed character in a box of its own,
  // says nothing about the code or the button.
  const keepNear = (raw: string) => {
    const text = hide(raw);
    return text !== undefined &&
      !repeated.has(text) &&
      (text.replace(/\[(?:email|masked|number)\]/gu, "").match(/\p{L}/gu)?.length ?? 0) >= 2
      ? text
      : undefined;
  };
  const nearCode = code === undefined ? [] : nearCodeTexts(chosen[codeAt]!.draft.element, keepNear);
  // A page without a code field carries the texts near its buttons instead.
  const buttons =
    near && code === undefined ? chosen.filter((_, at) => candidates[at]!.role === "button") : [];
  for (const button of buttons) {
    const candidate = candidates[chosen.indexOf(button)]!;
    if (candidate.label) repeated.add(candidate.label);
  }
  const nearButtons = buttons.length
    ? nearButtonTexts(
        buttons.map((button) => button.draft.element),
        keepNear,
      )
    : [];
  const texts = [
    title ?? "",
    ...headings,
    ...nearCode,
    ...nearButtons,
    ...candidates.flatMap((candidate) => [
      candidate.label ?? "",
      candidate.placeholder ?? "",
      candidate.description ?? "",
    ]),
    ...(accounts ?? []),
  ];
  const parsed = v.safeParse(loginObservationSchema, {
    version: 1,
    origin: location.origin,
    path,
    language: language(texts),
    ...(title ? { title } : {}),
    ...(headings.length ? { headings } : {}),
    ...(header ? { headerText: header } : {}),
    ...(nearCode.length ? { nearCode } : {}),
    ...(nearButtons.length ? { nearButtons } : {}),
    complete,
    candidates,
    ...(accounts?.length ? { accounts } : {}),
  });
  return parsed.success
    ? { ok: true, observation: parsed.output }
    : { ok: false, reason: "unsupported-page" };
}

/**
 * Controls in a page header or navigation first, then those inside one of `modals`, then
 * the rest of the page, such as carousels, ads and news tabs, each in document order: on
 * a signed-in page they may show the account, and on a page without a login form they
 * hold its sign-in entry (ADR 0031). An open modal's few controls, read on a signed-in
 * page, come before the page behind it, so the judge still sees the modal on a long
 * page. The rank reads only the page's structure, never words of one language. `observe`
 * lists the controls kept in document order again.
 */
export function byLandmark<Entry extends { draft: Draft }>(
  entries: readonly Entry[],
  modals: readonly Element[] = [],
): Entry[] {
  const rank = (element: Element) =>
    closestAcross(element, landmarks)
      ? 2
      : modals.some((modal) => containsAcross(modal, element))
        ? 1
        : 0;
  // A stable sort keeps document order within each rank.
  return entries
    .map((entry) => ({ entry, rank: rank(entry.draft.element) }))
    .sort((left, right) => right.rank - left.rank)
    .map(({ entry }) => entry);
}
