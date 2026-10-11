import { renderedText } from "./text";

const mask = "*●•＊";
const readLimit = 4000;
/** An email address, possibly masked: `my2@example.com`, `m***@example.com`. */
const emailPattern = new RegExp(`[A-Za-z0-9._%+\\-${mask}]+@[A-Za-z0-9.\\-${mask}]+`, "gu");
/** A masked identifier: three or more mask characters next to letters or digits, `****1234`. */
const maskedPattern = new RegExp(
  `[A-Za-z0-9]*[${mask}]{3,}[A-Za-z0-9]+|[A-Za-z0-9]+[${mask}]{3,}[A-Za-z0-9]*`,
  "gu",
);

/**
 * Account identifiers a page shows: email addresses (masked or not) and masked IDs such
 * as `****1234`. Fullwidth forms are folded to ASCII first.
 */
export function shownAccounts(text: string): string[] {
  const folded = text.normalize("NFKC").replace(/[●•]/gu, "*");
  // Sentence punctuation after an address is not part of it: "as my2@example.com."
  const emails = (folded.match(emailPattern) ?? []).map((email) => email.replace(/[.-]+$/u, ""));
  const rest = folded.replace(emailPattern, " ");
  return [...emails, ...(rest.match(maskedPattern) ?? [])];
}

/** Each run of mask characters stands for one or more unknown characters. */
function fits(shown: string, username: string): boolean {
  const pattern = shown
    .split(/\*+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".+");
  return new RegExp(`^${pattern}$`, "iu").test(username);
}

/**
 * Whether the page shows another account than `username`. Only identifiers of the
 * username's kind count: email addresses for an email username, masked IDs otherwise.
 * The page conflicts only when it shows such identifiers and none of them fits the
 * username; a masked identifier that fits (`m***@example.com`) cannot be told apart.
 */
export function showsOtherAccount(shown: readonly string[], username: string): boolean {
  const name = username.normalize("NFKC").trim();
  if (!name) return false;
  const email = name.includes("@");
  const comparable = shown.filter((entry) => entry.includes("@") === email);
  return comparable.length > 0 && !comparable.some((entry) => fits(entry, name));
}

/** The rendered text of the login form (or the page body for inputs outside a form) and headings. */
export function accountText(document: Document, form: HTMLFormElement | null): string {
  const scope = form ?? document.body;
  const headings = [...document.querySelectorAll("h1, h2, h3")].map(
    (heading) => renderedText(heading, readLimit) ?? "",
  );
  return [scope ? (renderedText(scope, readLimit) ?? "") : "", ...headings].join(" ");
}
