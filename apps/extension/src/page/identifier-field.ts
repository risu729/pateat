import { observedAutocompleteTokens } from "@pateat/contracts";
import { visible } from "./code-submission";
import { autocompleteTokens } from "./targets";

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
/**
 * Words that name the answer to a secret question (ADR 0035), matched as the identifier
 * words are: `secretAnswer` splits into words, and Japanese words match anywhere.
 */
const answerWords = new Set(["answer", "secret"]);
const answerParts = ["答え", "回答", "合言葉", "秘密"];

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

/**
 * The HTML autofill field names, which mark an input for something; `on`, `off`, the
 * section, shipping, billing and contact prefixes and other tokens do not.
 */
const fieldNames: ReadonlySet<string> = new Set([
  ...observedAutocompleteTokens,
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "language",
  "url",
  "photo",
  "impp",
]);

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
      (element) =>
        element instanceof HTMLInputElement && autocompleteTokens(element).includes("new-password"),
    )
  );
}

/**
 * Whether the page asks for an account identifier alone (ADR 0016, owner decisions
 * 2026-10-12), and how: `sole` when the input is the page's only text-like one, `email`
 * for an email input beside others. An input counts when it is visible and writable and
 * either an email input by its type or `autocomplete`, or the page's only text-like
 * input with no autofill field name among its `autocomplete` tokens (so `off`, or a
 * value Chrome ignores such as `chrome-off`, still counts) and a word of its name, id,
 * placeholder, `aria-label` or label that names an identifier. A search box, or an
 * input with a word of a coupon, order, tracking, postal or newsletter field, neither
 * counts nor is counted beside one, and an input in a sign-up form never counts. Only
 * the page's own markup is read, never a value.
 */
export function identifierInput(document: Document): "sole" | "email" | undefined {
  const inputs = [...document.querySelectorAll("input")].filter(
    (input) => textTypes.has(input.type) && writable(input) && !searchField(input),
  );
  const emails = inputs.filter(
    (input) =>
      (input.type === "email" || autocompleteTokens(input).includes("email")) && !signUpForm(input),
  );
  if (emails.length) return inputs.length === 1 ? "sole" : "email";
  if (inputs.length !== 1) return undefined;
  const [input] = inputs as [HTMLInputElement];
  const unmarked = !autocompleteTokens(input).some((token) => fieldNames.has(token));
  return input.type === "text" &&
    unmarked &&
    !signUpForm(input) &&
    names(input, identifierWords, identifierParts)
    ? "sole"
    : undefined;
}

/**
 * Whether the page shows a visible, writable `type="text"` input for the answer to a secret
 * question (ADR 0035): a word of its name, id, placeholder, `aria-label` or label names an
 * answer or a secret, as `secretAnswer`, `秘密の質問の答え` or `合言葉`. Such a page looks like
 * a verification but meets no generation trigger (ADR 0016), so it is only counted. A
 * search box, an input with a word of a coupon, order or other such field and an input in a
 * sign-up form do not count. Only the page's own markup is read, never a value.
 */
export function answerInput(document: Document): boolean {
  return [...document.querySelectorAll("input")].some(
    (input) =>
      input.type === "text" &&
      writable(input) &&
      !searchField(input) &&
      !signUpForm(input) &&
      names(input, answerWords, answerParts),
  );
}
