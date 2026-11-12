import {
  loginObservationSchema,
  loginTargetSchema,
  type LoginObservation,
} from "@pateat/contracts";
import * as v from "valibot";
import { composedParent, containsAcross, queryAll, readingPage } from "../page/shadow";
import { collapseText, renderedText } from "../page/text";
import {
  accountEntries,
  besideEmails,
  inPageChrome,
  entryLike,
  foldName,
  namedAccounts,
  namePattern,
} from "../page/account-list";
import type { ObservationGap, ObservationResult, Chosen } from "./extract-types";
import { withGap, observe } from "./extract-observe";
import { rawLimit, observedText } from "./extract-text";
import { fillTypes, fields } from "./extract-controls";
import { describe, describeAll } from "./extract-candidates";
import { passkeyButtons } from "./extract-passkey";

const maxAccounts = 8;

const atSign = /[@＠]/u;

const maxListControls = 8;

/** Elements examined for list controls; a list page is small. */
const listScanLimit = 4000;

/**
 * The observation of a page without fields that lists accounts to choose from (ADR 0028),
 * such as a saved-profile list: each entry's redacted text (`Taro [email] Last used`) and
 * the other controls outside page chrome, by their text, as context and as the
 * account-independent button the generator may name. An email shown beside at most three
 * separate buttons, as on Wise's "Welcome back" card, counts as a listed account too. A
 * page showing a fillable field, or no email address in an entry or beside buttons, is
 * refused: {@link extractLoginObservation} covers the
 * former, and the latter is no list of accounts. An incomplete result names its first
 * cause as `gap` (`ObservationGap`), for the log only.
 */
export function extractAccountListObservation(
  document: Document = globalThis.document,
  names: readonly string[] = [],
): ObservationResult {
  return readingPage(() => readAccountList(document, names));
}

function readAccountList(document: Document, names: readonly string[]): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };
  const fieldShown = queryAll(document, fields).some((element) => {
    const found = describe(element);
    return found?.kind === "candidate" && fillTypes[found.draft.role] !== undefined;
  });
  if (fieldShown || !document.body) return { ok: false, reason: "no-candidates" };
  const entries = accountEntries(document);
  // An account shown beside separate buttons, as on Wise's "Welcome back" card.
  const listed = [
    ...entries.map((entry) => entry.element),
    // An entry that the beside text holds, or that holds it, is listed once, as the entry.
    ...besideEmails(document)
      .map((account) => account.element)
      .filter(
        (element) =>
          !entries.some(
            (entry) =>
              containsAcross(entry.element, element) || containsAcross(element, entry.element),
          ),
      ),
  ];
  // A shown text that equals a matching item's username that is not an email (ADR 0028),
  // and the other texts beside buttons, which may name accounts not in the vault.
  const beside = names.length ? namedAccounts(document, names) : { named: [], others: [] };
  const named = beside.named.filter(
    (element) =>
      !listed.some((other) => containsAcross(other, element) || containsAcross(element, other)),
  );
  listed.push(...named);
  if (listed.length === 0) return { ok: false, reason: "no-candidates" };
  // A text in which an address survived redaction is left out, never sent; a name is sent
  // only as `[account]`.
  const sent = listed
    .slice(0, maxAccounts)
    .map((element) => ({
      element,
      text: named.includes(element)
        ? "[account]"
        : observedText(renderedText(element, rawLimit, { everyElement: true })),
    }))
    .filter(
      (account): account is { element: HTMLElement; text: string } =>
        account.text !== undefined && !atSign.test(account.text),
    );
  const accounts = sent.map((account) => account.text);
  // Only an entry is clicked for its account; one beside buttons needs a list button.
  const clickable = sent.filter((account) =>
    entries.some((entry) => entry.element === account.element),
  ).length;
  // The first gap is reported, in this order; any gap makes the observation incomplete.
  let gap: ObservationGap | undefined =
    listed.length > maxAccounts
      ? "too-many-accounts"
      : accounts.length !== listed.length
        ? "unlisted-accounts"
        : undefined;

  // The innermost list controls that are not entries, by their whole text, which must
  // survive redaction and name one control only.
  const inEntry = (element: Element) =>
    [...entries.map((entry) => entry.element), ...named].some(
      (entry) => containsAcross(entry, element) || containsAcross(element, entry),
    );
  const scanned = queryAll(document.body, "*");
  if (scanned.length > listScanLimit) gap ??= "too-many-elements";
  const listControls = scanned.slice(0, listScanLimit).filter(
    (element): element is HTMLElement =>
      entryLike(element) &&
      // The page's footer links, as Instagram's 16 on 2026-10-13, are chrome too.
      !inPageChrome(element) &&
      !inEntry(element),
  );
  // A control holding another one is not innermost; marking ancestors keeps this linear.
  const outer = new Set<Element>();
  for (const element of listControls) {
    let parent = composedParent(element);
    while (parent && !outer.has(parent)) {
      outer.add(parent);
      parent = composedParent(parent);
    }
  }
  const innermost = listControls.filter((element) => !outer.has(element));
  const texts = innermost.map((element) => {
    const raw = collapseText(renderedText(element, rawLimit) ?? "");
    return raw && observedText(raw) === raw && !atSign.test(raw) ? raw : undefined;
  });
  const chosen: Chosen[] = innermost.flatMap((element, at) => {
    const text = texts[at];
    if (text === undefined || texts.filter((other) => other === text).length !== 1) return [];
    const target = { by: "text" as const, value: text };
    if (!v.is(loginTargetSchema, target)) return [];
    return [{ form: null, draft: { element, role: "button", label: text }, target }];
  });
  // A passkey button beside the list that no text names, as one showing an icon only, is
  // sent by its own locator, so the answer may name it for the chooser (ADR 0079).
  const passkeys = passkeyButtons(document, describeAll(document)).filter(
    (button) =>
      !inEntry(button.draft.element) &&
      !chosen.some(
        (control) =>
          containsAcross(control.draft.element, button.draft.element) ||
          containsAcross(button.draft.element, control.draft.element),
      ),
  );
  chosen.push(...passkeys);
  if (chosen.length > maxListControls) gap ??= "too-many-controls";
  const described = observe(
    document,
    chosen.slice(0, maxListControls),
    gap === undefined,
    undefined,
    accounts,
  );
  const result = withGap(
    described.ok && described.observation.accounts
      ? { ok: true, observation: { ...described.observation, accountEntries: clickable } }
      : described,
    gap,
  );
  if (!result.ok || !names.length) return result;
  const hidden = beside.others.map((element) =>
    collapseText(renderedText(element, rawLimit) ?? ""),
  );
  return withGap(withoutNames(result.observation, names, hidden, location.pathname), gap);
}

/** The page texts of a candidate, apart from its ID, role and locator kind, one per line. */
function textsOf(value: unknown, key = ""): string {
  if (typeof value === "string") return ["id", "role", "by"].includes(key) ? "" : value;
  if (Array.isArray(value)) return value.map((entry) => textsOf(entry)).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([name, entry]) => textsOf(entry, name))
      .join("\n");
  return "";
}

/**
 * The observation of a list shown by names (ADR 0028) with no name in it: `names`, the
 * texts that name a matching item's username, become `[account]` wherever they show as a
 * whole word, with or without a leading `@` and in any width or case, and a candidate
 * whose text holds one is left out; a text that is wholly one of `hidden`, the other
 * texts beside buttons, which may name accounts not in the vault, becomes `[account]`,
 * and a candidate with such a text is left out. A page whose `path`, read as it is before
 * its token-like segments are replaced (ADR 0039), holds a name is not sent.
 */
function withoutNames(
  observation: LoginObservation,
  names: readonly string[],
  hidden: readonly string[],
  path: string,
): ObservationResult {
  // The texts that name a username show at least one name, so the pattern is never empty.
  const source = namePattern(names) ?? "(?!)";
  const holds = new RegExp(source, "iu");
  const pattern = new RegExp(source, "giu");
  const others = new Set(hidden.map(foldName).filter(Boolean));
  const shows = (text: string) => holds.test(text.normalize("NFKC"));
  const whole = (text: string) => others.has(foldName(text));
  if (shows(decodeURIComponentSafe(path)) || shows(decodeURIComponentSafe(observation.path)))
    return { ok: false, reason: "unsupported-page" };
  const kept = {
    ...observation,
    candidates: observation.candidates.filter((candidate) => {
      const text = textsOf(candidate);
      return !shows(text) && !text.split("\n").some(whole);
    }),
  };
  const hide = (text: string) => {
    if (whole(text)) return "[account]";
    const normal = text.normalize("NFKC");
    return holds.test(normal) ? normal.replace(pattern, "[account]") : text;
  };
  const replaced: unknown = JSON.parse(JSON.stringify(kept), (key, value: unknown) =>
    typeof value === "string" && !["origin", "path", "language", "id", "role", "by"].includes(key)
      ? hide(value)
      : value,
  );
  const parsed = v.safeParse(loginObservationSchema, replaced);
  return parsed.success
    ? { ok: true, observation: parsed.output }
    : { ok: false, reason: "unsupported-page" };
}

/** A path as it reads, or as it is when it does not decode. */
function decodeURIComponentSafe(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
