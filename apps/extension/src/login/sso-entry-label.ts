import { parse } from "tldts";

/**
 * Which provider entry of a broker page names the mapped IdP, for a URL-form SSO method's
 * first visit (ADR 0085, amendment of 2026-11-18: SSO starts automatically on the login
 * page). Only local data names the IdP: the mapped IdP item's name, and the registrable
 * labels of the mapped origin and of the item's own URIs. Nothing is sent anywhere.
 */

/**
 * Words that name a way to sign in rather than a provider: a name made only of them
 * names none, so an IdP item called "SSO" never picks "Sign in with SSO".
 */
const GENERIC = new Set([
  "a",
  "account",
  "accounts",
  "an",
  "and",
  "auth",
  "company",
  "continue",
  "email",
  "enterprise",
  "id",
  "identity",
  "idp",
  "in",
  "log",
  "login",
  "my",
  "next",
  "oauth",
  "oidc",
  "on",
  "or",
  "provider",
  "saml",
  "school",
  "sign",
  "signin",
  "single",
  "sso",
  "the",
  "to",
  "use",
  "via",
  "with",
  "work",
  "your",
]);
/** The shortest registrable label that may begin a longer entry word, as `ibm` in `IBMid`. */
const LABEL_PREFIX_MIN = 3;
/** The shortest entry word that may begin a longer registrable label, as `microsoft` in `microsoftonline`. */
const WORD_PREFIX_MIN = 5;

/** The words of a visible label: NFKC, lower case, split at anything not a letter or digit. */
export function labelWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export type IdpNames = {
  /** Word sequences that name the IdP, matched whole and in order. */
  names: string[][];
  /** Registrable labels without their suffix, as `github` or `microsoftonline`. */
  labels: string[];
};

const registrable = (url: string) => {
  const host = URL.parse(url)?.hostname;
  return host ? (parse(host).domainWithoutSuffix ?? undefined) : undefined;
};
const specific = (words: string[]) => words.some((word) => !GENERIC.has(word));

/**
 * The names of the IdP at `origin`, from its item's name and URIs. A label shared with
 * the page's own site is left out: the page names its own site everywhere.
 */
export function idpNames(input: {
  origin: string;
  pageOrigin: string;
  itemName?: string | undefined;
  uris?: readonly string[];
}): IdpNames {
  const own = registrable(input.pageOrigin);
  const names: string[][] = [];
  const item = input.itemName ? labelWords(input.itemName) : [];
  if (item.length && specific(item)) names.push(item);
  const labels = new Set<string>();
  for (const url of [input.origin, ...(input.uris ?? [])]) {
    const label = registrable(url);
    if (!label || label === own) continue;
    const words = labelWords(label);
    if (!specific(words)) continue;
    names.push(words);
    if (words.length === 1) labels.add(words[0]!);
  }
  return { names, labels: [...labels] };
}

const contains = (words: string[], name: string[]) =>
  name.length > 0 &&
  words.some((_, start) => name.every((word, offset) => words[start + offset] === word));
/** A word and a registrable label where one begins the other, as `IBMid` and `ibm`. */
const prefixed = (word: string, label: string) =>
  !GENERIC.has(word) &&
  word !== label &&
  ((word.startsWith(label) && label.length >= LABEL_PREFIX_MIN) ||
    (label.startsWith(word) && word.length >= WORD_PREFIX_MIN));

/** Whether an entry's visible label names the IdP, by any of the rules. */
export function labelNamesIdp(label: string, idp: IdpNames): boolean {
  const words = labelWords(label);
  return (
    idp.names.some((name) => contains(words, name)) ||
    words.some((word) => idp.labels.some((entry) => prefixed(word, entry)))
  );
}

/**
 * The one entry whose label names the IdP. None, or more than one entry named by any
 * rule, gives none: the person chooses then, as before.
 */
export function labeledEntry<Entry extends { label: string }>(
  entries: readonly Entry[],
  idp: IdpNames,
): Entry | undefined {
  const named = entries.filter((entry) => labelNamesIdp(entry.label, idp));
  return named.length === 1 ? named[0] : undefined;
}
