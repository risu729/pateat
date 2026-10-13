import { fillRoles, loginObservationSchema, type LoginObservation } from "@pateat/contracts";
import * as v from "valibot";
import { escapePattern, foldName, latinEdge, latinWord, namePattern } from "../page/account-list";
import { minUsernameLength } from "../page/sign-in-state";
import { bounded, maxHeaderText, maxText, observedText, withoutNumbers } from "./extract";

/** The placeholders observed text already shows in place of private parts. */
const placeholders = /\[(?:email|masked|number|account)\]/gu;
/**
 * Observed text is cut at its limit in UTF-16 code units (120, or 1,000 for a header),
 * then loses a split surrogate pair and a trailing space; a text this close to its limit
 * may have been cut.
 */
const cutMargin = 2;

/**
 * The forms a username takes in an observation: as it is, as a login page's text shows it
 * (an email or a run of four or more digits already replaced), and as a signed-in page's
 * shows it (every number replaced). A form left with no letter or digit beside its
 * placeholders, as an email username's `[email]`, is already hidden and is not looked for.
 */
function shownForms(username: string): string[] {
  const login = observedText(username);
  return [username, login, login && withoutNumbers(login)].filter(
    (form): form is string =>
      form !== undefined && /[\p{L}\p{N}]/u.test(form.replace(placeholders, "")),
  );
}

/**
 * A text's end that may be the start of a cut name: a proper prefix of one of `names`, at
 * least one character, read as {@link namePattern} reads a whole name.
 */
function cutPattern(names: readonly string[]): RegExp | undefined {
  const prefixes = [
    ...new Set(
      names.map(foldName).flatMap((name) => {
        const characters = [...name];
        return characters.slice(1).map((_, at) => characters.slice(0, at + 1).join(""));
      }),
    ),
  ].sort((left, right) => right.length - left.length);
  if (!prefixes.length) return undefined;
  const source = prefixes
    .map(
      (prefix) =>
        `${latinWord.test(prefix[0]!) ? `(?<!${latinEdge})` : ""}@?${escapePattern(prefix)}`,
    )
    .join("|");
  return new RegExp(`(?:${source})$`, "iu");
}

/** Why an observation is not sent once usernames are hidden from it. */
export type UsernameRefusal = "username-shown";
export type HiddenUsernames =
  | { readonly ok: true; readonly observation: LoginObservation }
  | { readonly ok: false; readonly reason: UsernameRefusal };

/** A path segment as it reads, or as it is when it does not decode. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Whether `username` is long enough to look for, counted as {@link foldName} folds it,
 * after a leading `@`: shorter ones match unrelated text.
 */
const lookedFor = (username: string) => [...foldName(username)].length >= minUsernameLength;

/**
 * Whether a segment of `path` holds one of `usernames` as {@link withoutUsernames} looks
 * for it, which refuses such a page as `username-shown`. A list of accounts on such a
 * page, as a signed-in page under the account's own name, is not read (ADR 0028, owner
 * decision 2026-10-12 19:45 UTC).
 */
export function pathShowsUsername(path: string, usernames: readonly string[]): boolean {
  const source = namePattern(usernames.filter(lookedFor).flatMap(shownForms));
  if (source === undefined) return false;
  const holds = new RegExp(source, "iu");
  return path
    .split("/")
    .some(
      (segment) =>
        holds.test(segment.normalize("NFKC")) || holds.test(decoded(segment).normalize("NFKC")),
    );
}

/**
 * The observation with the account's own usernames hidden, just before it is sent to the
 * service (generation, its continuation after an `advance` step, and the judge). The
 * usernames are those of the vault items that match the page, read locally in the worker;
 * they are never sent or logged. A username of at least three characters (as E2 of ADR
 * 0029 reads one) shows where ADR 0028's rule for a name beside buttons finds it
 * ({@link namePattern}): as a whole text or inside a longer one, in any width or case,
 * with or without a leading `@`, and never inside a longer Latin word, so `ann` is not
 * found in `annual`. Each place in the title, the headings, the header text, the texts
 * near a code field, the account texts and a candidate's label, placeholder and
 * description becomes `[account]`, and so does the start of a name at the end of a text
 * cut at its length limit.
 *
 * A locator value cannot be hidden, since it must name the element as it is, so a button,
 * link or checkbox whose locator holds a username is left out, as ADR 0028 leaves out a
 * control that names one. The page is refused instead when that would leave it
 * incomplete: for a field, and for a button or link of a field's form (its `group`), or a
 * button outside every form beside a field outside every form, which may be the
 * submit. A page with a path segment that holds a username is refused too.
 */
export function withoutUsernames(
  observation: LoginObservation,
  usernames: readonly string[],
): HiddenUsernames {
  const forms = usernames.filter(lookedFor).flatMap(shownForms);
  const source = namePattern(forms);
  if (source === undefined) return { ok: true, observation };
  const holds = new RegExp(source, "iu");
  const pattern = new RegExp(source, "giu");
  const cut = cutPattern(forms);
  const refused = { ok: false, reason: "username-shown" } as const;
  const shows = (text: string) => holds.test(text.normalize("NFKC"));
  const hide = (text: string, limit = maxText): string => {
    const normal = text.normalize("NFKC");
    let hidden = holds.test(normal) ? normal.replace(pattern, "[account]") : text;
    if (text.length >= limit - cutMargin && cut?.test(hidden))
      hidden = hidden.replace(cut, "[account]");
    return hidden === text ? text : (bounded(hidden, limit) ?? "[account]");
  };
  if (pathShowsUsername(observation.path, usernames)) return refused;
  const isField = (role: string) => (fillRoles as readonly string[]).includes(role);
  const fieldGroups = new Set(
    observation.candidates
      .filter((candidate) => isField(candidate.role))
      .map((candidate) => candidate.group),
  );
  const candidates: LoginObservation["candidates"] = [];
  for (const candidate of observation.candidates) {
    const { target, label, placeholder, description } = candidate;
    if (target.by !== "autocomplete" && shows(target.value)) {
      if (
        isField(candidate.role) ||
        ((candidate.role === "button" || candidate.role === "link") &&
          candidate.group !== undefined &&
          fieldGroups.has(candidate.group)) ||
        (candidate.role === "button" && candidate.group === undefined && fieldGroups.has(undefined))
      )
        return refused;
      continue;
    }
    candidates.push({
      ...candidate,
      ...(label === undefined ? {} : { label: hide(label) }),
      ...(placeholder === undefined ? {} : { placeholder: hide(placeholder) }),
      ...(description === undefined ? {} : { description: hide(description) }),
    });
  }
  const { title, headings, headerText, accounts, nearCode, nearButtons } = observation;
  const parsed = v.safeParse(loginObservationSchema, {
    ...observation,
    ...(title === undefined ? {} : { title: hide(title) }),
    ...(headings === undefined ? {} : { headings: headings.map((text) => hide(text)) }),
    ...(headerText === undefined ? {} : { headerText: hide(headerText, maxHeaderText) }),
    ...(accounts === undefined ? {} : { accounts: accounts.map((text) => hide(text)) }),
    ...(nearCode === undefined ? {} : { nearCode: nearCode.map((text) => hide(text)) }),
    ...(nearButtons === undefined ? {} : { nearButtons: nearButtons.map((text) => hide(text)) }),
    candidates,
  });
  return parsed.success ? { ok: true, observation: parsed.output } : refused;
}
