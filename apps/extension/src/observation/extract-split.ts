import { composedOrder } from "../page/shadow";
import { splitGroups } from "../page/split-identifier";
import { groupLabel } from "./extract-labels";
import type { Chosen } from "./extract-types";

/**
 * A login page's chosen elements with each part of an identifier split over several inputs
 * (`splitGroups`, ADR 0089) marked as such: its group, numbered `s1`, `s2`... in page
 * order, its place in it from 1 and how many parts it has. A group counts only when every
 * part is a chosen text or tel field. The inputs stay candidates of their own, so the
 * judge of a personal detail (ADR 0061), which reads another description, never sees the
 * mark. The first part without a label of its own takes the group's (`groupLabel`), as the
 * sentence above a row of boxes names the number they take.
 */
export function withSplitParts(document: Document, chosen: readonly Chosen[]): Chosen[] {
  const drafts = new Map(chosen.map((entry) => [entry.draft.element, entry]));
  const groups = splitGroups(document)
    .filter((group) =>
      group.every((input) => {
        const role = drafts.get(input)?.draft.role;
        return role === "text" || role === "tel";
      }),
    )
    .sort((left, right) => composedOrder(left[0]!, right[0]!));
  const marked = new Map<Element, Chosen>();
  for (const [index, group] of groups.entries()) {
    const label = drafts.get(group[0]!)!.draft.label === undefined ? groupLabel(group) : undefined;
    for (const [at, input] of group.entries()) {
      const entry = drafts.get(input)!;
      marked.set(input, {
        ...entry,
        draft: {
          ...entry.draft,
          ...(at === 0 && label ? { label } : {}),
          split: { group: `s${index + 1}`, part: at + 1, of: group.length },
        },
      });
    }
  }
  return chosen.map((entry) => marked.get(entry.draft.element) ?? entry);
}
