import { visible } from "./code-submission";

/**
 * Words that name an account identifier (ADR 0016), matched as whole words of an input's
 * name, id, placeholder, `aria-label` or label: `e-mail` and `loginId` split into words
 * first. Japanese words match anywhere, as in `ログインID`.
 */
const identifierWords = new Set([
  "email",
  "mail",
  "user",
  "username",
  "userid",
  "login",
  "loginid",
  "account",
  "id",
]);
const identifierParts = ["メール", "ユーザー", "ログイン", "アカウント"];
/** Words of a field that is not a sign-in identifier, such as a search or newsletter box. */
const otherWords = new Set([
  "search",
  "coupon",
  "promo",
  "tracking",
  "order",
  "newsletter",
  "subscribe",
  "zip",
  "postal",
]);
const otherParts = ["検索", "クーポン", "注文", "追跡", "メルマガ", "マガジン", "購読", "郵便"];

/** Text-like input types, of which a page asking for an identifier alone shows one. */
const textTypes = new Set(["text", "email", "tel", "number", "url"]);

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The texts that describe an input: its name, id, placeholder, `aria-label` and labels. */
function descriptions(input: HTMLInputElement): string[] {
  return [
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("aria-label") ?? "",
    ...[...(input.labels ?? [])].map((label) => label.textContent ?? ""),
  ];
}

function names(input: HTMLInputElement, whole: ReadonlySet<string>, parts: readonly string[]) {
  return descriptions(input).some((text) => {
    const folded = text.normalize("NFKC");
    return (
      words(text).some((word) => whole.has(word)) || parts.some((part) => folded.includes(part))
    );
  });
}

const tokens = (input: HTMLInputElement) => input.autocomplete.toLowerCase().split(/\s+/u);

function writable(input: HTMLInputElement): boolean {
  return visible(input) && !input.disabled && !input.readOnly;
}

/** A search box, by its type, its landmark or its words. */
function searchField(input: HTMLInputElement): boolean {
  return (
    input.type === "search" ||
    input.closest("search, [role='search' i]") !== null ||
    names(input, otherWords, otherParts)
  );
}

/** Whether the input's form also asks for a new password: a sign-up form. */
function signUpForm(input: HTMLInputElement): boolean {
  // `elements` also holds inputs tied to the form by a `form` attribute.
  return (
    input.form !== null &&
    [...input.form.elements].some(
      (element) => element instanceof HTMLInputElement && tokens(element).includes("new-password"),
    )
  );
}

/**
 * Whether the page asks for an account identifier alone (ADR 0016, owner decisions
 * 2026-10-12), and how: `sole` when the input is the page's only text-like one, `email`
 * for an email input beside others. An input counts when it is visible and writable and
 * either an email input by its type or `autocomplete`, or the page's only text-like
 * input with no `autocomplete` and a word of its name, id, placeholder, `aria-label` or
 * label that names an identifier. A search box, or an input with a word of a coupon,
 * order, tracking, postal or newsletter field, neither counts nor is counted beside one,
 * and an input in a sign-up form never counts. Only the page's own markup is read, never
 * a value.
 */
export function identifierInput(document: Document): "sole" | "email" | undefined {
  const inputs = [...document.querySelectorAll("input")].filter(
    (input) => textTypes.has(input.type) && writable(input) && !searchField(input),
  );
  const emails = inputs.filter(
    (input) => (input.type === "email" || tokens(input).includes("email")) && !signUpForm(input),
  );
  if (emails.length) return inputs.length === 1 ? "sole" : "email";
  if (inputs.length !== 1) return undefined;
  const [input] = inputs as [HTMLInputElement];
  const unmarked = tokens(input).every(
    (token) => token === "" || token === "on" || token === "off",
  );
  return input.type === "text" &&
    unmarked &&
    !signUpForm(input) &&
    names(input, identifierWords, identifierParts)
    ? "sole"
    : undefined;
}
