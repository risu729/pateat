// Bundled into each Formasaurus page: runs the extension's own extractor and maps every
// observed candidate back to its form and field name, which the annotations key on.
import { extractLoginObservation } from "../../apps/extension/src/observation/extract";
import { findTargets } from "../../apps/extension/src/page/targets";
import { shown } from "../../apps/extension/src/page/text";

export type ProbedCandidate = {
  id: string;
  /** Index in `document.forms`, or -1 outside a form. */
  form: number;
  name?: string;
  type?: string;
  tag: string;
};
export type ProbeResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      observation: unknown;
      candidates: ProbedCandidate[];
      /** Field names per form, to check the annotations line up with these forms. */
      formNames: string[][];
      /** Shown controls the extractor cannot describe, by tag and type, for coverage notes. */
      unsupported: string[];
    };

function probe(): ProbeResult {
  const result = extractLoginObservation(document);
  if (!result.ok) return { ok: false, reason: result.reason };
  // Not `document.forms`: a form named "forms" shadows it.
  const forms = [...document.querySelectorAll("form")];
  const candidates = result.observation.candidates.map((candidate) => {
    // Links named by their text resolve only among links, as the executor finds them.
    const found = findTargets(document, candidate.target, { links: candidate.role === "link" });
    const element = found.length === 1 ? found[0]! : undefined;
    const form =
      element && "form" in element && element.form instanceof HTMLFormElement
        ? element.form
        : element?.closest("form");
    return {
      id: candidate.id,
      form: form ? forms.indexOf(form) : -1,
      tag: element?.tagName.toLowerCase() ?? "missing",
      ...(element?.getAttribute("name") ? { name: element.getAttribute("name")! } : {}),
      ...(element?.getAttribute("type")
        ? { type: element.getAttribute("type")!.toLowerCase() }
        : {}),
    };
  });
  const formNames = forms.map((form) =>
    [...form.elements].flatMap((element) => element.getAttribute("name") ?? []),
  );
  const describable = new Set([
    "text",
    "email",
    "tel",
    "number",
    "password",
    "checkbox",
    "submit",
    "button",
    "image",
    "hidden",
    "reset",
  ]);
  const unsupported = [...document.querySelectorAll("input, select, textarea")].flatMap(
    (element) => {
      if (!shown(element)) return [];
      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (tag === "input" && describable.has(type)) return [];
      return [
        `${forms.indexOf((element as HTMLInputElement).form!)}:${tag}${tag === "input" ? `[${type}]` : ""}`,
      ];
    },
  );
  return { ok: true, observation: result.observation, candidates, formNames, unsupported };
}

(globalThis as { pateatProbe?: typeof probe }).pateatProbe = probe;
