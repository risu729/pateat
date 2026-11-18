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
/**
 * Words of an entry that signs in on the device itself, as a passkey or Windows Hello
 * does, rather than at a provider: such an entry is never pressed by its label, even
 * where it names the IdP, as `Windows Hello` names `login.windows.net`.
 */
const AUTHENTICATOR = new Set([
  "biometric",
  "biometrics",
  "face",
  "fido",
  "fido2",
  "fingerprint",
  "hello",
  "passkey",
  "passkeys",
  "security",
  "touch",
  "webauthn",
]);
/**
 * The fewest letters of a word that names the IdP by itself, and of a registrable label
 * that may begin a longer entry word, as `ibm` begins `IBMid`: a one- or two-letter name
 * such as `X` appears in too many labels.
 */
const NAME_MIN = 3;

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
const specific = (words: string[]) =>
  words.some((word) => !GENERIC.has(word) && [...word].length >= NAME_MIN);

/**
 * The names of the IdP at `origin`, from its item's name and URIs. The page's own site's
 * registrable label is left out, from the labels and from the item name's words alike:
 * the page names its own site everywhere.
 */
export function idpNames(input: {
  origin: string;
  pageOrigin: string;
  itemName?: string | undefined;
  uris?: readonly string[];
}): IdpNames {
  const own = registrable(input.pageOrigin);
  const ownWords = new Set(own ? labelWords(own) : []);
  const names: string[][] = [];
  const item = (input.itemName ? labelWords(input.itemName) : []).filter(
    (word) => !ownWords.has(word),
  );
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
/**
 * A registrable label that begins a longer word of the entry, as `ibm` begins `IBMid`.
 * Never the other way: `Amazon` begins `amazoncognito` and `Microsoft` begins
 * `microsoftonline`, and both name other things than those IdPs.
 */
const prefixed = (word: string, label: string) =>
  !GENERIC.has(word) && word !== label && word.startsWith(label) && [...label].length >= NAME_MIN;

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
 * rule, gives none: the person chooses then, as before. `others` are the labels of the
 * page's other observed entries, which are never pressed, as a link or an entry that
 * failed its inspection: one of them that names the IdP gives none too. An entry that
 * signs in on the device itself is never the one.
 */
export function labeledEntry<Entry extends { label: string }>(
  entries: readonly Entry[],
  idp: IdpNames,
  others: readonly string[] = [],
): Entry | undefined {
  const named = entries.filter((entry) => labelNamesIdp(entry.label, idp));
  if (named.length !== 1 || others.some((label) => labelNamesIdp(label, idp))) return undefined;
  return labelWords(named[0]!.label).some((word) => AUTHENTICATOR.has(word)) ? undefined : named[0];
}
