import { namesPasskey, registersPasskey } from "@pateat/contracts";
import { readingPage } from "../page/shadow";
import { redactsPath } from "./path";
import type { ObservationResult, Chosen } from "./extract-types";
import { maxCandidates, fillTypes, enabled } from "./extract-controls";
import { locatorIndex, locate } from "./extract-locators";
import { describeAll } from "./extract-candidates";
import { observe } from "./extract-observe";

/** A button-only passkey start, using the same bounded, value-free observation as login. */
export function extractPasskeyObservation(
  document: Document = globalThis.document,
): ObservationResult {
  return readingPage(() => readPasskey(document));
}

function readPasskey(document: Document): ObservationResult {
  if (!document.location) return { ok: false, reason: "unsupported-page" };
  const found = describeAll(document);
  // Any fillable or unsupported field, shadow trees' included, prevents a button-only start.
  if (
    found.some((entry) =>
      entry.kind === "unsupported" ? entry.field !== undefined : fillTypes[entry.draft.role],
    )
  )
    return { ok: false, reason: "no-candidates" };
  const buttons = passkeyButtons(document, found);
  if (!buttons.length || buttons.length > maxCandidates)
    return { ok: false, reason: "no-candidates" };
  return observe(document, buttons, true);
}

/**
 * The enabled buttons among `found` whose label or lasting locator names a passkey or
 * security key and not its registration (ADR 0053), on a passkey-only start page and
 * beside an account list (ADR 0079). A script button other than a link, such as
 * `<div role="button">` or a pointer tab stop, is located by its text too, as in a login
 * form: naming a passkey already tells it from a menu or a toggle.
 */
export function passkeyButtons(
  document: Document,
  found: readonly ReturnType<typeof describeAll>[number][],
): Chosen[] {
  const tokens = redactsPath(document.location.pathname);
  const index = locatorIndex(document);
  return found.flatMap((entry) => {
    if (
      entry.kind !== "candidate" ||
      entry.draft.role !== "button" ||
      !enabled(entry.draft.element)
    )
      return [];
    const target = locate(entry.draft.element, index, { tokens, lasting: true, roles: true });
    if (!target) return [];
    const button = { target, label: entry.draft.label };
    if (!namesPasskey(button) || registersPasskey(button)) return [];
    return [{ form: entry.form, draft: entry.draft, target }];
  });
}
