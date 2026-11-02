import { describe, expect, it } from "vitest";
import type { RecipeLanguage } from "./login";
import type { LoginObservation } from "./observation";
import { type LayoutCandidate, type LayoutShown, languageDecides, rankLayouts } from "./recipes";

// Every set of up to three layouts, each of every language, age and fit to the page, and
// every page language, checked against ADR 0060's choice of layout. The table tests in
// recipes.test.ts check single cases.

type Candidate = LayoutCandidate<string>;
const pageLanguages: (LoginObservation["language"] | undefined)[] = [
  undefined,
  "ja",
  "en",
  "mixed",
];
const languages: (RecipeLanguage | undefined)[] = [undefined, "ja", "en"];

/** Negative when `left` fits the page better (ADR 0060): it starts, then fewer missing, then more shown. */
const compare = (left: LayoutShown, right: LayoutShown) =>
  Number(right.starts) - Number(left.starts) ||
  left.missing - right.missing ||
  right.shown - left.shown;

const layouts = (shownValues: readonly LayoutShown[]) =>
  languages.flatMap((language) =>
    [1, 2].flatMap((createdAt) => shownValues.map((shown) => ({ language, createdAt, shown }))),
  );
const everyShown = [false, true].flatMap((starts) =>
  [0, 1].flatMap((missing) => [0, 1].map((shown) => ({ starts, missing, shown }))),
);
// Three layouts are walked with a fit that ties, one better by each rule, and one worse.
const someShown = [
  { starts: false, missing: 1, shown: 0 },
  { starts: false, missing: 0, shown: 0 },
  { starts: false, missing: 0, shown: 1 },
  { starts: true, missing: 1, shown: 0 },
];
type Layout = ReturnType<typeof layouts>[number];
const sets: Layout[][] = [
  [],
  ...layouts(everyShown).map((one) => [one]),
  ...layouts(everyShown).flatMap((one) => layouts(everyShown).map((two) => [one, two])),
  ...layouts(someShown).flatMap((one) =>
    layouts(someShown).flatMap((two) => layouts(someShown).map((three) => [one, two, three])),
  ),
];

const cases = sets.flatMap((set) => {
  const candidates: Candidate[] = set.map(({ language, createdAt }, index) => ({
    recipe: `layout-${index}`,
    ...(language ? { language } : {}),
    createdAt,
  }));
  const shown = set.map((layout) => layout.shown);
  return pageLanguages.map((language) => ({
    set,
    language,
    candidates,
    ranked: rankLayouts(candidates, shown, language),
  }));
});
type Case = (typeof cases)[number];

function broken(rule: (o: Case) => boolean) {
  return cases
    .filter((o) => !rule(o))
    .slice(0, 5)
    .map(({ set, language, ranked }) => ({ set, language, ranked: ranked.map((c) => c.recipe) }));
}

const shownOf = (o: Case, candidate: Candidate) => o.set[o.candidates.indexOf(candidate)]!.shown;

describe("the layouts a login may run, over every set of up to three (ADR 0060)", () => {
  it("walks every case", () => {
    expect(cases.length).toBeGreaterThan(50_000);
  });

  it("keeps exactly the layouts that fit the page best, each once", () => {
    expect(
      broken((o) => {
        if (new Set(o.ranked).size !== o.ranked.length) return false;
        if (o.candidates.length > 0 && o.ranked.length === 0) return false;
        return o.candidates.every((candidate) => {
          const kept = o.ranked.includes(candidate);
          return o.candidates.every((other) => {
            const order = compare(shownOf(o, candidate), shownOf(o, other));
            // A kept layout fits no worse than any; a left one fits worse than a kept one.
            return kept ? order <= 0 : !o.ranked.includes(other) || order > 0;
          });
        });
      }),
    ).toEqual([]);
  });

  it("puts the layouts of the page's language first, then the newest", () => {
    expect(
      broken((o) =>
        o.ranked.every((candidate, index) => {
          const next = o.ranked[index + 1];
          if (!next) return true;
          const speaks = (c: Candidate) =>
            o.language === "ja" || o.language === "en" ? c.language === o.language : false;
          if (speaks(candidate) !== speaks(next)) return speaks(candidate);
          return candidate.createdAt >= next.createdAt;
        }),
      ),
    ).toEqual([]);
  });

  it("reads the page's language only when it can change the order", () => {
    expect(
      broken((o) => {
        if (
          languageDecides(
            rankLayouts(
              o.candidates,
              o.set.map((layout) => layout.shown),
            ),
          )
        )
          return true;
        const order = (ranked: Candidate[]) => ranked.map((candidate) => candidate.recipe);
        return pageLanguages.every(
          (language) =>
            JSON.stringify(
              order(
                rankLayouts(
                  o.candidates,
                  o.set.map((l) => l.shown),
                  language,
                ),
              ),
            ) === JSON.stringify(order(o.ranked)),
        );
      }),
    ).toEqual([]);
  });
});
