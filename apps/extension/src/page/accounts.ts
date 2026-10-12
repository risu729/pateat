import { renderedText } from "./text";

const readLimit = 4000;
const headingLimit = 8;
const headingReadLimit = 300;
/**
 * An email address, possibly masked: `my2@example.com`, `m***@example.com`. It must not
 * continue a word or a URL (`tarō@…`, `https://user@host`), and its parts are bounded so
 * a long run of letters stays linear.
 */
const emailPattern = /(?<![\p{L}\p{N}._%+\-*/])[A-Za-z0-9._%+\-*]{1,64}@[A-Za-z0-9.\-*]{1,253}/gu;
/** A masked identifier: three or more `*` next to letters or digits, `****1234`. */
const maskedPattern =
  /(?<![A-Za-z0-9*])(?:[A-Za-z0-9]{0,32}\*{3,}[A-Za-z0-9]{1,32}|[A-Za-z0-9]{1,32}\*{3,}[A-Za-z0-9]{0,32})(?![A-Za-z0-9*])/gu;

/**
 * Account identifiers a page shows: email addresses (masked or not) and masked IDs that
 * show at least two characters (`****1234`, `ab***yz`; not `5***`). Fullwidth forms are
 * folded to ASCII and `●` `•` to `*` first.
 */
export function shownAccounts(text: string): string[] {
  const folded = text.normalize("NFKC").replace(/[●•]/gu, "*");
  // Sentence punctuation after an address is not part of it: "as my2@example.com."
  const emails = (folded.match(emailPattern) ?? []).map((email) => email.replace(/[.-]+$/u, ""));
  const masked = (folded.replace(emailPattern, " ").match(maskedPattern) ?? []).filter(
    (entry) => entry.replace(/\*/gu, "").length >= 2,
  );
  return [...emails, ...masked];
}

/**
 * Whether `username` fits `shown`, where each run of `*` stands for one or more unknown
 * characters, ignoring case. A linear wildcard match: a page cannot make it backtrack.
 */
export function fits(shown: string, username: string): boolean {
  // `one` is any one character and `many` any number; a `*` in the username is literal.
  const one = Symbol("one");
  const many = Symbol("many");
  const pattern = shown
    .toLowerCase()
    .split(/(\*+)/u)
    .flatMap((part, index): (string | symbol)[] => (index % 2 ? [one, many] : [...part]));
  const text = [...username.toLowerCase()];
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === one || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (pattern[p] === many) {
      star = p;
      p += 1;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else return false;
  }
  while (pattern[p] === many) p += 1;
  return p === pattern.length;
}

/**
 * Whether the page shows another account than `username`. Only identifiers of the
 * username's kind count: email addresses for an email username; masked IDs for a
 * username of digits only, and only when `masked` is set (a password step: a one-time
 * code page usually shows the masked phone number the code went to). The page
 * conflicts only when it shows such identifiers and none of them fits the username; a
 * masked identifier that fits (`m***@example.com`) cannot be told apart.
 */
export function showsOtherAccount(
  shown: readonly string[],
  username: string,
  { masked }: { masked: boolean },
): boolean {
  const name = username.normalize("NFKC").trim();
  const email = name.includes("@");
  if (!email && !(masked && /^\d+$/u.test(name.replace(/[\s-]/gu, "")))) return false;
  const comparable = shown.filter((entry) => entry.includes("@") === email);
  return comparable.length > 0 && !comparable.some((entry) => fits(entry, name));
}

/**
 * The rendered text of the login form (or the page body for inputs outside a form) and
 * the first headings, with every element boundary separating words. Contact addresses
 * (`mailto:` links, `<address>`, `<footer>`) are not accounts and are skipped.
 */
export function accountText(document: Document, form: HTMLFormElement | null): string {
  const options = { everyElement: true, skip: 'a[href^="mailto:" i], address, footer' };
  const read = (root: Element, limit: number) =>
    (renderedText(root, limit, options) ?? "").slice(0, limit);
  const scope = form ?? document.body;
  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .filter((heading) => !heading.closest(options.skip))
    .slice(0, headingLimit)
    .map((heading) => read(heading, headingReadLimit));
  return [scope ? read(scope, readLimit) : "", ...headings].join(" ");
}
