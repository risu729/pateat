// Value-free document-start guard for profile/site autofill (ADR 0035).
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
