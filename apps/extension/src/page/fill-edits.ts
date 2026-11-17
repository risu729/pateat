// Value-free document-start guard for profile/site autofill (ADR 0035): it keeps no
// value, only a salted digest of each value Pateat itself wrote, in memory.
// The isolated world's state survives worker restarts and content reconnects. Identity
// aliases protect a replacement input too; an ambiguous identity sacrifices autofill.
import { shadowRootOf, shadowRoots } from "./shadow";

const key = Symbol.for("pateat.fillEdits");
type State = {
  active: boolean;
  touched: WeakSet<Element>;
  identities: Set<string>;
  opaque: boolean;
  filled: Set<string>;
  /**
   * Inputs Pateat itself wrote a value into in this document, each with a salted digest of
   * that value (`seed`), never the value. The digest stays in this isolated world's memory;
   * it is never sent, stored or logged.
   */
  wrote: WeakMap<Element, number>;
  seed: number;
};
type Holder = { [key]?: State };
const aliases = (input: Element): string[] => {
  const kind = `${input.localName}:${input instanceof HTMLInputElement ? input.type : input.localName}`;
  const names = ["id", "name", "autocomplete"].flatMap((name) => {
    const value = input.getAttribute(name);
    return value ? [`${kind}:${name}:${value}`] : [];
  });
  return [kind, ...names];
};
/** Installed at document_start; never reads a value, label, selection or typed key. */
export function recordFillEdits(document: Document, window: Window): () => void {
  const holder = window as unknown as Holder;
  if (holder[key])
    return () => {
      holder[key]!.active = false;
    };
  const state: State = {
    active: document.readyState === "loading",
    touched: new WeakSet(),
    identities: new Set(),
    opaque: false,
    filled: new Set(),
    wrote: new WeakMap(),
    seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
  };
  holder[key] = state;
  const roots = new Set<ShadowRoot>();
  const typed = (event: Event) => {
    if (!event.isTrusted) return;
    const path = event.composedPath();
    const input = path.find(
      (node): node is Element =>
        node instanceof Element && ["input", "select", "textarea"].includes(node.localName),
    );
    if (!input) {
      // A closed shadow root conceals the target from a listener outside it; the root's
      // own listener sees it. One not listened to yet leaves no later field provably
      // untouched. An edit of no field, as of an editable region, touches none.
      const [origin] = path;
      const root = origin instanceof Element ? shadowRootOf(origin) : null;
      if (root && !roots.has(root)) state.opaque = true;
      return;
    }
    state.touched.add(input);
    for (const identity of aliases(input)) state.identities.add(identity);
    if (state.identities.size > 1024) state.opaque = true;
  };
  const events = ["beforeinput", "input", "change", "paste", "drop", "compositionstart"];
  const attach = () => {
    for (const root of shadowRoots(document))
      if (!roots.has(root)) {
        roots.add(root);
        for (const event of events) root.addEventListener(event, typed, true);
      }
  };
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document, { childList: true, subtree: true });
  window.addEventListener("focusin", attach, true);
  for (const event of events) window.addEventListener(event, typed, true);
  return () => {
    state.active = false;
    observer.disconnect();
    window.removeEventListener("focusin", attach, true);
    for (const root of roots)
      for (const event of events) root.removeEventListener(event, typed, true);
    for (const event of events) window.removeEventListener(event, typed, true);
  };
}
export function fillEditsReady(window: Window): boolean {
  return (window as unknown as Holder)[key]?.active === true;
}

export function fillUntouched(window: Window, input: Element): boolean {
  const state = (window as unknown as Holder)[key];
  return Boolean(
    state?.active &&
    !state.opaque &&
    !state.touched.has(input) &&
    !aliases(input).some((identity) => state.identities.has(identity)),
  );
}

/** Claim before mutation; a stale acknowledgement never causes a second write. */
export function claimFill(
  window: Window,
  input: Element,
  attempt: string,
  step: number,
  slot: string,
): boolean {
  const state = (window as unknown as Holder)[key];
  if (
    !state?.active ||
    state.opaque ||
    state.touched.has(input) ||
    aliases(input).some((identity) => state.identities.has(identity))
  )
    return false;
  const identity = JSON.stringify([attempt, step, slot]);
  if (state.filled.has(identity)) return false;
  if (state.filled.size >= 1024) return false;
  state.filled.add(identity);
  return true;
}

/** A salted 53-bit digest (cyrb53), only to tell whether a value is still the one written. */
function digest(seed: number, value: string): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Records that Pateat is about to write `value` into `input`, as any of its fills does. */
export function noteFillWrite(window: Window, input: Element, value: string): void {
  const state = (window as unknown as Holder)[key];
  state?.wrote.set(input, digest(state.seed, value));
}

/**
 * Whether the value in `input` is Pateat's own: Pateat wrote it, nobody edited the input
 * since, and it still holds that value. A value the page or another extension set
 * afterwards is not, so it is never replaced.
 */
export function fillWrote(window: Window, input: Element & { value: string }): boolean {
  const state = (window as unknown as Holder)[key];
  const written = state?.wrote.get(input);
  return (
    state !== undefined &&
    written !== undefined &&
    written === digest(state.seed, input.value) &&
    fillUntouched(window, input)
  );
}
