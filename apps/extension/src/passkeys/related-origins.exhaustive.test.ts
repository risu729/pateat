import { expect, it } from "vitest";
import { RELATED_ORIGIN_MAX_LABELS, relatedOriginListed } from "./related-origins";

// Every list of up to six entries, up to renaming its labels (12,866 lists), against an
// oracle written from the WebAuthn related origins validation procedure rather than from
// the code: the caller is listed when one of its entries has the caller's origin and the
// caller's label is among the first five labels the valid entries name up to there.

const caller = "https://login.t.example";

/** An entry, with the label and origin the oracle knows it by (no URL parsing). */
type Entry = { text: string; label?: string; origin?: string };

const entry = (text: string, label?: string, origin?: string): Entry => ({
  text,
  ...(label === undefined ? {} : { label }),
  ...(origin === undefined ? {} : { origin }),
});

/** The entries a list may hold after `labels` other labels were named, in order. */
function choices(labels: number): Entry[] {
  const names = "abcde";
  return [
    // A label not seen yet; labels are renamed so that new ones come in order.
    ...(labels < names.length
      ? [
          entry(
            `https://${names[labels]}.example`,
            names[labels],
            `https://${names[labels]}.example`,
          ),
        ]
      : []),
    // A label seen already, under another suffix.
    ...[...names.slice(0, labels)].map((name) =>
      entry(`https://${name}.test`, name, `https://${name}.test`),
    ),
    // The caller, and its label on another origin: another port, written with a path.
    entry(caller, "t", caller),
    entry("https://login.t.example:8443/", "t", "https://login.t.example:8443"),
    // An entry the procedure skips, a public suffix with no label.
    entry("https://com"),
  ];
}

function oracle(list: readonly Entry[]): boolean {
  const first: string[] = [];
  for (const { label, origin } of list) {
    if (label === undefined) continue;
    if (first.length < RELATED_ORIGIN_MAX_LABELS && !first.includes(label)) first.push(label);
    if (origin === caller && first.includes("t")) return true;
  }
  return false;
}

it("lists the caller in every short list exactly as the related origins procedure does", () => {
  const mismatches: string[][] = [];
  let lists = 0;
  const walk = (list: Entry[], labels: number) => {
    lists += 1;
    const texts = list.map(({ text }) => text);
    if (relatedOriginListed(caller, { origins: texts }) !== oracle(list) && mismatches.length < 5)
      mismatches.push(texts);
    if (list.length === 6) return;
    for (const next of choices(labels)) {
      const fresh =
        next.label !== undefined &&
        next.label !== "t" &&
        !list.some(({ label }) => label === next.label);
      list.push(next);
      walk(list, labels + (fresh ? 1 : 0));
      list.pop();
    }
  };
  walk([], 0);
  expect(mismatches).toEqual([]);
  expect(lists).toBe(12_866);
});
