import {
  loginAutocompleteTokens,
  loginHostChainSchema,
  loginLinkTargetSchema,
  loginTargetSchema,
  namesPasswordControl,
  type LoginMarkerTarget,
  type LoginHostChain,
  type LoginTarget,
} from "@pateat/contracts";
import * as v from "valibot";
import { splitCodeOf } from "../page/code-submission";
import {
  autocompleteTokens,
  findTargets,
  hostScopes,
  linkPath,
  namedControls,
} from "../page/targets";
import { hostOf, queryAll, shadowRootOf } from "../page/shadow";
import { tokenSegment } from "./path";
import {
  buttonText,
  controlContent,
  controlName,
  fieldName,
  hasNativeButton,
  isButton,
  isRoleButton,
  isScriptLink,
  linkText,
  scriptControls,
} from "../page/text";
import { fillTypes, actionTypes, ignoredTypes, visible } from "./extract-controls";
import { observedText, foldWord, shownWords } from "./extract-text";

/**
 * The attributes an element other than a field (`fieldLocators`) is named by, in order: a
 * test attribute first, as test tools
 * do, since a site keeps it as a stable hook while an `id` may be a render counter
 * (Duolingo's `web-ui1`, `web-ui2`, then `web-ui3` for the same password input on its
 * remembered-account screen, 2026-10-24; ADR 0071 amendment).
 */
export const locators = [
  ["test-id", "data-testid"],
  ["data-test", "data-test"],
  ["id", "id"],
  ["name", "name"],
] as const;

/**
 * The attributes a field is named by, in order: its `id` and `name` first, which name each
 * field of a form apart, before a test attribute, which a site may give every field alike
 * (JetBrains Account's `data-test="input__inner"`, whose code input it then names alone
 * on the code view, 2026-11-08, issue #1413; ADR 0071 amendment). A counter-shaped `id`
 * still gives way to every later attribute (`counterId`).
 */
const fieldLocators = [
  ["id", "id"],
  ["name", "name"],
  ["test-id", "data-testid"],
  ["data-test", "data-test"],
] as const;

/**
 * A field a step fills or sets: an `<input>` other than a button, a `<select>` or a
 * `<textarea>`, which `fieldLocators` names. Buttons, links and the other elements a
 * signed-in page's markers name keep `locators`' order, as their IDs more often carry the
 * account.
 */
const isField = (element: Element) =>
  element instanceof HTMLSelectElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement &&
    !actionTypes.has(element.type) &&
    !ignoredTypes.has(element.type));

/** The attributes `element` is named by, in order: `fieldLocators` for a field. */
const locatorsOf = (element: Element) => (isField(element) ? fieldLocators : locators);

/**
 * An ID React's `useId` generated (`:r1:`, `«r1»`, `_r_1_`, a hydrated `:R1aH1:`, also
 * inside a library's prefix such as `radix-:r1:`): its base-32 digits count the
 * components rendered before, so another page of the site gives it to another element.
 */
export const generatedId =
  /:[Rr][0-9a-v]+(?:H[0-9a-v]+)?:|«[Rr][0-9a-v]+(?:H[0-9a-v]+)?»|(?:^|[^0-9A-Za-z])_[Rr]_[0-9a-v]+(?:H[0-9a-v]+)?_(?![0-9A-Za-z])/u;

/**
 * A run of eight or more lower-case base-36 characters that no other letter or digit
 * touches, the shape of `Math.random().toString(36)` that Mantine's `useId` appends
 * after mount (`mantine-4p5f7ku4o`, 2026-10-13): every load gives the element another ID.
 */
const base36Run = /(?<![0-9A-Za-z])[0-9a-z]{8,}(?![0-9A-Za-z])/gu;

/**
 * True for an ID holding a random-looking run: a `base36Run` with a digit and a letter
 * that switches between digits and letters at least twice, which a name such as
 * `password1`, `password-field-1` or `email-address-2024` does not. Stable IDs such as
 * `oauth2login`, `step2of3` or `form-3a7bd3e2` match too, so such an ID is only demoted,
 * not dropped.
 */
const randomId = (value: string) =>
  (value.match(base36Run) ?? []).some((run) => run.match(/\d+|[a-z]+/gu)!.length >= 3);

/**
 * An ID a UI library's own `useId` generated, recognized by the prefix it adds: a rule
 * about the library, like `generatedId` for React's, not about a site (ADR 0033).
 * Mantine's is `mantine-` and a random base-36 run, which can lack a digit
 * (`mantine-ypxwydcwg`, 2026-10-13), or React 18's ID without its colons
 * (`mantine-r5`), and its components derive IDs from it, such as Tabs'
 * `mantine-ypxwydcwg-tab-mypage`.
 */
const libraryId = /^mantine-/u;

/** True for an ID another load may change: `randomId`, or a `libraryId` prefix. */
export const changingId = (value: string) => libraryId.test(value) || randomId(value);

/**
 * An ID shaped like a render counter: lower-case words joined by `-` or `_`, ending in up
 * to four digits, with at least one `-` or `_`, such as Discord's `uid_7` and `uid_9` on
 * its invite login page that read `uid_13` and `uid_15` on `/login` (2026-11-02, #1161),
 * or Duolingo's `web-ui1` (ADR 0071). A unique `name` or `autocomplete` token names the
 * element first; the ID is still used when nothing else does. `address1`, without a
 * separator, is not one.
 */
export const counterId = (value: string) =>
  /^[a-z]+(?:[-_][a-z]+)*[-_]?\d{1,4}$/u.test(value) && /[-_]/u.test(value);

export type LocatorIndex = Map<string, Map<string, number>>;

/**
 * Counts every locator value once, as the executor's whole-page lookup sees them, shadow
 * trees included (ADR 0070).
 */
export function locatorIndex(document: Document): LocatorIndex {
  const index: LocatorIndex = new Map(
    [
      ...locators.map(([, attribute]) => attribute),
      "autocomplete",
      "text",
      "script-text",
      "role-text",
      "link-text",
      "label",
      "link-path",
      "accessible-name",
    ].map((key) => [key, new Map()]),
  );
  const count = (key: string, value: string) => {
    const counts = index.get(key)!;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };
  for (const element of queryAll(document, "[id], [name], [data-testid], [data-test]"))
    for (const [, attribute] of locators) {
      const value = element.getAttribute(attribute);
      if (value !== null) count(attribute, value);
    }
  for (const input of queryAll(document, "input[autocomplete]"))
    for (const token of new Set(autocompleteTokens(input))) count("autocomplete", token);
  for (const element of queryAll(document, "button, input, a")) {
    const text = buttonText(element);
    if (text !== undefined) count(isScriptLink(element) ? "script-text" : "text", text);
  }
  for (const element of queryAll(document, scriptControls)) {
    const text = isRoleButton(element) ? buttonText(element) : undefined;
    if (text !== undefined) count("role-text", text);
  }
  for (const element of queryAll(document, "a[href]")) {
    const text = isScriptLink(element) ? undefined : linkText(element);
    if (text !== undefined) count("link-text", text);
    const path = linkPath(element);
    if (path !== undefined) count("link-path", path);
  }
  for (const input of queryAll<HTMLInputElement>(document, "input")) {
    const name = fieldName(input);
    if (name !== undefined) count("label", name);
  }
  for (const element of queryAll(document, namedControls)) {
    const name = controlName(element);
    if (name !== undefined) count("accessible-name", name);
  }
  return index;
}

/**
 * Whether an attribute or `autocomplete` locator names `element` alone, as the executor
 * finds it (`findTargets`): a value the whole document carries once, or else, without
 * `hidden`, a value only `element` carries among the shown elements (ADR 0037 amendment
 * of 2026-10-22), as a field of a form whose hidden copy shares its names. With `hidden`,
 * which a signed-in page's markers ask for since a marker counts every copy (ADR 0029),
 * only the whole document's count decides.
 */
function namesOnly(
  element: Element,
  target: LoginMarkerTarget,
  count: number | undefined,
  hidden: boolean,
): boolean {
  if (count === 1) return true;
  if (hidden || count === undefined) return false;
  const found = findTargets(element.ownerDocument, target);
  return found.length === 1 && found[0] === element;
}

/**
 * Mirrors the executor's lookup: an attribute value, or else a fillable input's
 * `autocomplete` token, or else a button's text, that matches exactly one element, an
 * attribute value or token counted as `namesOnly` counts it with `hidden`. With
 * `labels`, a fillable input none of those name is located by its visible name
 * (`fieldName`, ADR 0037) when no other shown fillable input has that name, it holds no
 * number other than a split code input's place (`numbersCodeDigit`) and redaction leaves
 * it unchanged, before an ID another load may change. An ID
 * React's `useId` generated is not used, as another page gives it to another element. One
 * that another load may change (`changingId`) is used only when no other locator is
 * unique, as it may as well be stable, and never with `lasting`, which a signed-in
 * marker needs, since it must match on every later visit. One shaped like a render
 * counter (`counterId`) gives way to a unique `name` and `autocomplete` token, and is
 * used otherwise, as it may be stable too. A
 * script link's text must also name no native button, shown or not, which the executor
 * would take first. With `roles`, another `role="button"` element (`isRoleButton`) is
 * located by its text too, when no native button, script link or other such element
 * carries it. Button text is used only when redaction leaves it unchanged, so a
 * locator never carries an email address or a long number. With
 * `redactAttributes` the same holds for attribute values, since a signed-in page's ids
 * and names often carry the account, and a value that may be a token (`tokenSegment`),
 * such as an account ID, is skipped too. With `tokens` only such a value is skipped,
 * which every page whose path had a segment replaced asks for (ADR 0039), so a token its
 * path carries never reaches the service through an ID or a name. With `links`, a link
 * is located by its text too, which only an account switch uses: the text must name no
 * other link and no button. With `paths`, which only a signed-in page's markers use (ADR 0029), a link to the
 * page's own origin is located by its path before its text, when no other link goes there,
 * the path carries no number or token and no segment repeats the link's text or one or
 * two words of the page's header (`paths` holds those words, `shownWords`), so an account
 * link whose text is the person's nickname still has a locator, while a handle or name the
 * page shows (`/taro_y` beside "@taro_y") is not used. A handle the page never shows can still pass,
 * which the judge must refuse. With `names`, a native button none of those name is located
 * by its accessible name (`buttonNameTarget`), before an ID another load may change, as a
 * field's visible name is.
 */
export function locate(
  element: Element,
  index: LocatorIndex,
  {
    redactAttributes = false,
    tokens = false,
    links = false,
    lasting = false,
    labels = false,
    roles = false,
    hidden = false,
    names = false,
    paths,
  }: {
    redactAttributes?: boolean;
    tokens?: boolean;
    links?: boolean;
    lasting?: boolean | undefined;
    labels?: boolean | undefined;
    roles?: boolean;
    hidden?: boolean;
    names?: boolean;
    paths?: ReadonlySet<string>;
  } = {},
): LoginMarkerTarget | undefined {
  let demoted: LoginTarget | undefined;
  let counter: LoginTarget | undefined;
  for (const [by, attribute] of locatorsOf(element)) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    if (attribute === "id" && generatedId.test(value)) continue;
    if ((redactAttributes || tokens) && tokenSegment(value)) continue;
    if (redactAttributes && observedText(value) !== value) continue;
    const target = { by, value };
    if (!v.is(loginTargetSchema, target)) continue;
    if (!namesOnly(element, target, index.get(attribute)!.get(value), hidden)) continue;
    // A counter-shaped ID gives way to a later attribute and an `autocomplete` token.
    // A library's per-load ID (`mantine-r5`) is demoted further below.
    if (attribute === "id" && counterId(value) && !changingId(value)) {
      counter = target;
      continue;
    }
    if (attribute !== "id" || !changingId(value)) return target;
    if (!lasting) demoted = target;
  }
  if (counter) return autocompleteTarget(element, index, hidden) ?? counter;
  return (
    (paths ? pathTarget(element, index, paths) : undefined) ??
    contentTarget(element, index, links, labels, roles, hidden) ??
    (names ? buttonNameTarget(element, index) : undefined) ??
    chainedTarget(element, { redactAttributes, tokens, labels, hidden }) ??
    demoted
  );
}

/**
 * `locate`'s locator for an element of a shadow tree that no locator names once in the
 * whole page (ADR 0070): an attribute, `autocomplete` token or visible name (with
 * `labels`) that names it once among the elements of a host's shadow tree, `within` the
 * fewest hosts, at most three, that name that host alone (`hostScopes`), the hosts
 * nearest it first. A host is named by its `id`, `name`, `data-testid` or `data-test` under the
 * rules an element's own attribute follows in `locate`, and an ID another load may
 * change names no host.
 */
function chainedTarget(
  element: Element,
  options: {
    redactAttributes: boolean;
    tokens: boolean;
    labels: boolean | undefined;
    hidden: boolean;
  },
): LoginTarget | undefined {
  const inner = innerTargets(element, options);
  if (!inner.length) return undefined;
  const hosts: Element[] = [];
  for (let host = hostOf(element); host; host = hostOf(host)) hosts.unshift(host);
  const document = element.ownerDocument;
  const names = hosts.map((host) => hostNames(host, options));
  // The chains of one more host that name a host no shorter chain named alone, grown from
  // the shorter ones, so each host is named once and a deep page costs a few lookups per
  // host.
  const named = new Set<number>();
  let level: { within: LoginHostChain[number][]; at: number }[] = [{ within: [], at: -1 }];
  for (let depth = 1; depth <= 3 && level.length; depth++) {
    level = level.flatMap(({ within, at }) =>
      hosts.flatMap((host, next) => {
        if (next <= at || named.has(next)) return [];
        for (const name of names[next]!) {
          const chain = [...within, name];
          const scopes = hostScopes(document, chain as LoginHostChain);
          if (scopes.length !== 1 || scopes[0] !== shadowRootOf(host)) continue;
          named.add(next);
          return [{ within: chain, at: next }];
        }
        return [];
      }),
    );
    // The hosts nearest the element first.
    for (const { within } of [...level].sort((left, right) => right.at - left.at))
      for (const target of inner) {
        const chained = { ...target, within };
        if (!v.is(loginTargetSchema, chained)) continue;
        const found = findTargets(document, chained, { hidden: options.hidden });
        if (found.length === 1 && found[0] === element) return chained;
      }
  }
  return undefined;
}

/**
 * The `data-testid`, `data-test`, `id` and `name` a host may be named by in
 * `chainedTarget`, in that order, a counter-shaped `id` last.
 */
function hostNames(
  host: Element,
  { redactAttributes, tokens }: { redactAttributes: boolean; tokens: boolean },
): LoginHostChain[number][] {
  const names = locators.flatMap(([by, attribute]) => {
    const value = host.getAttribute(attribute);
    if (value === null) return [];
    if (attribute === "id" && (generatedId.test(value) || changingId(value))) return [];
    if ((redactAttributes || tokens) && tokenSegment(value)) return [];
    if (redactAttributes && observedText(value) !== value) return [];
    const name = { by, value };
    return v.is(loginHostChainSchema, [name]) ? [name] : [];
  });
  // A counter-shaped ID gives way to the host's other names, as in `locate`.
  const counter = (name: (typeof names)[number]) => name.by === "id" && counterId(name.value);
  return [...names.filter((name) => !counter(name)), ...names.filter(counter)];
}

/**
 * The locators `chainedTarget` may name `element` by inside its hosts, in `locate`'s order:
 * a field's `id` and `name` first, a counter-shaped `id` after a login `autocomplete` token.
 */
function innerTargets(
  element: Element,
  {
    redactAttributes,
    tokens,
    labels,
  }: {
    redactAttributes: boolean;
    tokens: boolean;
    labels: boolean | undefined;
  },
): LoginTarget[] {
  const targets: LoginTarget[] = [];
  let counter: LoginTarget | undefined;
  for (const [by, attribute] of locatorsOf(element)) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    // An ID another load may change is never looked for inside hosts: the element keeps
    // it as `locate`'s demoted locator instead.
    if (attribute === "id" && (generatedId.test(value) || changingId(value))) continue;
    if ((redactAttributes || tokens) && tokenSegment(value)) continue;
    if (redactAttributes && observedText(value) !== value) continue;
    // A counter-shaped ID comes after the other attributes and a login `autocomplete`
    // token, as in `locate`.
    if (attribute === "id" && counterId(value)) counter = { by, value };
    else targets.push({ by, value });
  }
  if (!(element instanceof HTMLInputElement && fillTypes[element.type]))
    return counter ? [...targets, counter] : targets;
  for (const value of autocompleteTokens(element))
    if ((loginAutocompleteTokens as readonly string[]).includes(value))
      targets.push({ by: "autocomplete", value } as LoginTarget);
  if (counter) targets.push(counter);
  const name = labels ? fieldName(element) : undefined;
  if (
    name !== undefined &&
    observedText(name) === name &&
    (!/\p{Number}/u.test(name) || numbersCodeDigit(element, name))
  )
    targets.push({ by: "label", value: name });
  return targets;
}

/**
 * `locate`'s link path, when one link alone goes there, it carries no token and no
 * segment, with or without what may be a file extension, folds to the link's text or one
 * of the `headerWords`.
 */
function pathTarget(
  element: Element,
  index: LocatorIndex,
  headerWords: ReadonlySet<string>,
): LoginMarkerTarget | undefined {
  const path = linkPath(element);
  if (path === undefined || index.get("link-path")!.get(path) !== 1 || tokenPath(path))
    return undefined;
  const own = shownWords(linkText(element));
  if (
    path
      .split("/")
      .flatMap((segment) => [segment, segment.replace(/\.[A-Za-z]+$/u, "")])
      .some((segment) => {
        const word = foldWord(segment);
        return word !== "" && (headerWords.has(word) || own.has(word));
      })
  )
    return undefined;
  const target = { by: "href" as const, value: path };
  return v.is(loginLinkTargetSchema, target) ? target : undefined;
}

/**
 * Whether a field's visible name that holds numbers may still name it (owner, 2026-10-22,
 * #850, amending ADR 0037): the field is one input of a code split into one input per
 * digit (`splitCodeInputs`, counting shown inputs only), and every number in the name is
 * its place among them or their count, as in "digit 1 of 6", which never changes as the
 * person types. A name such as "Sent to ••12" or "••• 4 2 7, digit 1" never qualifies.
 */
function numbersCodeDigit(field: HTMLInputElement, name: string): boolean {
  const digits = splitCodeOf(field, visible);
  const place = (digits?.indexOf(field) ?? -1) + 1;
  return (
    digits !== undefined &&
    place > 0 &&
    (name.match(/\p{Number}+/gu) ?? []).every(
      (number) => number === `${place}` || number === `${digits.length}`,
    )
  );
}

/** A fillable input's login `autocomplete` token that names it alone, as `locate` takes it. */
function autocompleteTarget(
  element: Element,
  index: LocatorIndex,
  hidden: boolean,
): LoginTarget | undefined {
  if (!(element instanceof HTMLInputElement) || !fillTypes[element.type]) return undefined;
  for (const value of autocompleteTokens(element)) {
    if (!(loginAutocompleteTokens as readonly string[]).includes(value)) continue;
    const target = { by: "autocomplete" as const, value };
    if (!v.is(loginTargetSchema, target)) continue;
    if (namesOnly(element, target, index.get("autocomplete")!.get(value), hidden)) return target;
  }
  return undefined;
}

/**
 * `locate`'s `autocomplete` token, visible name (with `labels`), link text or button text,
 * when one is unique.
 */
function contentTarget(
  element: Element,
  index: LocatorIndex,
  links: boolean,
  labels: boolean,
  roles: boolean,
  hidden: boolean,
): LoginTarget | undefined {
  // Only a field the login fills; a button is named by its own attributes or text.
  if (element instanceof HTMLInputElement && fillTypes[element.type]) {
    const token = autocompleteTarget(element, index, hidden);
    if (token) return token;
    if (!labels) return undefined;
    const name = fieldName(element);
    // A name holding a number may change as the person types, such as a counter "0/20",
    // unless it numbers an input of a split code.
    if (
      name !== undefined &&
      observedText(name) === name &&
      index.get("label")!.get(name) === 1 &&
      (!/\p{Number}/u.test(name) || numbersCodeDigit(element, name))
    ) {
      const target = { by: "label" as const, value: name };
      if (v.is(loginTargetSchema, target)) return target;
    }
    return passwordFormNameTarget(element, hidden);
  }
  if (
    element instanceof HTMLAnchorElement &&
    element.hasAttribute("href") &&
    !isScriptLink(element)
  ) {
    const text = links ? linkText(element) : undefined;
    if (
      text === undefined ||
      index.get("link-text")!.get(text) !== 1 ||
      index.get("text")!.has(text) ||
      index.get("script-text")!.has(text) ||
      (roles && index.get("role-text")!.has(text)) ||
      observedText(text) !== text
    )
      return undefined;
    const target = { by: "text" as const, value: text };
    return v.is(loginTargetSchema, target) ? target : undefined;
  }
  const text = buttonText(element);
  if (text === undefined || observedText(text) !== text) return undefined;
  const unique = isScriptLink(element)
    ? !index.get("text")!.has(text) &&
      !hasNativeButton(element.ownerDocument, text) &&
      index.get("script-text")!.get(text) === 1
    : isRoleButton(element)
      ? roles &&
        !index.get("text")!.has(text) &&
        !hasNativeButton(element.ownerDocument, text) &&
        !index.get("script-text")!.has(text) &&
        index.get("role-text")!.get(text) === 1
      : index.get("text")!.get(text) === 1;
  if (!unique) return undefined;
  const target = { by: "text" as const, value: text };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

/**
 * The `password-form-name` locator of a field that no other locator names alone
 * (ADR 0072): its `name`, when the executor finds it alone by that name among
 * the elements of forms holding a shown password input not marked `new-password`, as
 * Hacker News's account field `acct`, which its create-account form repeats. A name that
 * may be a token, or that redaction would change, is never used.
 */
function passwordFormNameTarget(
  element: HTMLInputElement,
  hidden: boolean,
): LoginTarget | undefined {
  const value = element.getAttribute("name");
  if (value === null || tokenSegment(value) || observedText(value) !== value) return undefined;
  const target = { by: "password-form-name" as const, value };
  if (!v.is(loginTargetSchema, target)) return undefined;
  const found = findTargets(element.ownerDocument, target, { hidden });
  return found.length === 1 && found[0] === element ? target : undefined;
}

/**
 * The accessible-name locator of a control on a signed-in page that may go on to the
 * password (ADR 0048 amendment of 2026-10-19): its {@link controlName}, when exactly one
 * shown control of the page has that name, counted as the executor sees the page, it
 * holds no number and redaction leaves it unchanged, as a field's visible name (ADR
 * 0037), and it and all the text the control holds ({@link controlContent}, hidden text
 * too) pass `namesPasswordControl`, so a phone's "Select Phone - +61 4•• ••• 123", a
 * "Send code" button, one whose "Send code" is `aria-hidden` and one whose text is too long
 * to read in full are never located this way.
 */
export function passwordChoiceTarget(
  element: Element,
  index: LocatorIndex,
): LoginTarget | undefined {
  const name = controlName(element);
  if (
    name === undefined ||
    /\p{Number}/u.test(name) ||
    observedText(name) !== name ||
    index.get("accessible-name")!.get(name) !== 1 ||
    !namesPasswordControl(name, controlContent(element))
  )
    return undefined;
  const target = { by: "accessible-name" as const, value: name };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

/**
 * The accessible-name locator of a login form's native button that no other locator names
 * alone (ADR 0048 amendment of 2026-10-23), such as an `<input type="submit">`
 * without a `value` labelled by the text it shows: its {@link controlName}, when exactly
 * one shown control of the page has that name, counted as the executor sees the page, it
 * holds no number and redaction leaves it unchanged, as a field's visible name (ADR 0037).
 * A route step's click may then press it; script, role and fragment-link controls never
 * get it here.
 */
function buttonNameTarget(element: Element, index: LocatorIndex): LoginTarget | undefined {
  if (!isButton(element)) return undefined;
  const name = controlName(element);
  if (
    name === undefined ||
    /\p{Number}/u.test(name) ||
    observedText(name) !== name ||
    index.get("accessible-name")!.get(name) !== 1
  )
    return undefined;
  const target = { by: "accessible-name" as const, value: name };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

/** True for a path with a segment that may carry a token (`tokenSegment`). */
const tokenPath = (pathname: string) => pathname.split("/").some(tokenSegment);
