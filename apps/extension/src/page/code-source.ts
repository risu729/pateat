import { codeSourceOf, type CodeSource } from "@pateat/contracts";
import {
  nearCodeDescription,
  nearCodeHeadings,
  nearCodeTexts,
} from "../observation/extract-near-text";

/**
 * Where the code `field` takes comes from, as its page's words say (`codeSourceOf`, ADR
 * 0027 amendment of 2026-11-17): read from the texts the judged page carries near a code
 * field (`nearCodeTexts`, each kept whatever its length), the text its `aria-describedby`
 * names without links, buttons and other controls (`nearCodeDescription`), and the
 * headings of the field's part of the page (`nearCodeHeadings`). Only the class leaves
 * this function: the texts are never sent or logged.
 */
export function codeFieldSource(field: HTMLElement): CodeSource | undefined {
  const description = nearCodeDescription(field);
  return codeSourceOf([
    ...nearCodeTexts(field, (text) => text),
    ...(description ? [description] : []),
    ...nearCodeHeadings(field),
  ]);
}
