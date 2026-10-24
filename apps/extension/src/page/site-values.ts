// The value a site itself puts into an account input, such as the email Money Forward
// remembers in its sign-in form, read only to choose among several matching vault items
// (owner, 2026-10-23 22:32 UTC; ADR 0028 amendment of that date). It is an exception to the
// rule that logins never read what the person types (docs/architecture.md): only a value
// the page set before anyone could type counts.
//
// A content script that runs at `document_start` records each account input's `value`
// attribute as the page inserts the input or sets the attribute, and stops recording for
// the whole document at the person's first trusted input of any kind, or when Pateat starts
// to act on the page. A framework that copies typed text into the attribute, or mounts a
// new input holding it, does so only after such an input, so what was recorded before it is
// the page's own. Browser autofill and form restore set the property, not the attribute,
// and fire a trusted `input` too. A document whose recording did not start with it, as
// after an extension reload, or an input inside a shadow root, has nothing recorded, and
// nothing is read later instead. The values stay in this content script's memory and are
// only compared with usernames there; they are never stored, logged or sent.

/** Account input types whose `value` attribute may be recorded. */
const recordedTypes = new Set(["", "text", "email", "tel"]);
/** Events after which nothing more is recorded, when trusted. */
const typingEvents = [
  "keydown",
  "beforeinput",
  "input",
  "change",
  "paste",
  "drop",
  "compositionstart",
] as const;
/** Inputs recorded at most, so a page that keeps adding inputs stops the recording. */
const recordLimit = 64;

type SiteValues = {
  values: WeakMap<HTMLInputElement, string>;
  stopped: boolean;
  stop: () => void;
  /** Takes the changes the observer has not handled yet. */
  flush: () => void;
};

// Every content script of the extension in one frame shares this isolated world, so the
// recorder that runs at `document_start` and the login content script meet here.
const key = Symbol.for("pateat.siteValues");
type Holder = { [key]?: SiteValues };

function recordable(element: Element): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    recordedTypes.has((element.getAttribute("type") ?? "").toLowerCase())
  );
}

/**
 * Starts recording the `value` attributes the page sets on account inputs, until the
 * first trusted input event or {@link stopSiteValues}. Call it once at `document_start`;
 * returns the function that stops it.
 */
export function recordSiteValues(document: Document, window: Window): () => void {
  const holder = window as unknown as Holder;
  if (holder[key]) return holder[key].stop;
  const values = new WeakMap<HTMLInputElement, string>();
  let recorded = 0;
  const state: SiteValues = {
    values,
    stopped: false,
    stop: () => {
      if (state.stopped) return;
      state.stopped = true;
      observer.disconnect();
      for (const type of typingEvents) window.removeEventListener(type, typed, true);
    },
    flush: () => {
      if (!state.stopped) handle(observer.takeRecords());
    },
  };
  const record = (input: HTMLInputElement) => {
    if (state.stopped) return;
    const value = input.getAttribute("value");
    if (!values.has(input)) {
      recorded += 1;
      if (recorded > recordLimit) {
        state.stop();
        return;
      }
    }
    values.set(input, value ?? "");
  };
  const handle = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      if (state.stopped) return;
      if (mutation.type === "attributes") {
        if (recordable(mutation.target as Element)) record(mutation.target as HTMLInputElement);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (recordable(node)) record(node);
        for (const input of node.querySelectorAll("input")) if (recordable(input)) record(input);
      }
    }
  };
  const observer = new MutationObserver(handle);
  const typed = (event: Event) => {
    if (event.isTrusted) state.stop();
  };
  for (const type of typingEvents) window.addEventListener(type, typed, true);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["value", "type"],
  });
  holder[key] = state;
  return state.stop;
}

/** Stops the recording, as before Pateat fills anything in the document. */
export function stopSiteValues(window: Window): void {
  (window as unknown as Holder)[key]?.stop();
}

/**
 * The value the page itself set on `input`, when it was recorded before anyone could type
 * and the input still holds it; otherwise `undefined`.
 */
export function siteValue(window: Window, input: Element): string | undefined {
  const state = (window as unknown as Holder)[key];
  if (!state || !(input instanceof HTMLInputElement)) return undefined;
  // Pending records are taken first, so a value the page set just now is not missed.
  state.flush();
  const value = state.values.get(input);
  if (!value || input.value !== value) return undefined;
  return value;
}

/** ASCII case-insensitive equality, as an email username is compared; nothing is trimmed. */
export function sameAccountValue(left: string, right: string): boolean {
  const fold = (text: string) => text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return left.length === right.length && fold(left) === fold(right);
}

/**
 * The index of the one username in `usernames` that equals the one value the page set in
 * `inputs`, or `undefined` when the inputs hold no such value, different ones, or it equals
 * no username or several.
 */
export function siteValueChoice(
  window: Window,
  inputs: readonly Element[],
  usernames: readonly string[],
): number | undefined {
  const values = new Set<string>();
  for (const input of inputs) {
    const value = siteValue(window, input);
    if (value === undefined) return undefined;
    values.add(value);
  }
  const [value] = values;
  if (values.size !== 1 || value === undefined) return undefined;
  const found = usernames.flatMap((username, index) =>
    username && sameAccountValue(username, value) ? [index] : [],
  );
  return found.length === 1 ? found[0] : undefined;
}
