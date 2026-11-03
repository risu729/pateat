/**
 * When the page defines one of its custom elements (ADR 0070, ADR 0082). An element
 * defined late may attach a shadow root and render a form into it, which no mutation
 * observer reports, so the content script checks the page again then. Chrome's isolated
 * world has no usable `customElements` (it is `null` there), so the page's main world
 * waits for the definitions instead.
 *
 * The isolated world dispatches {@link AWAIT_DEFINITION} on the document once per name of
 * an element that is not defined yet ({@link askDefinitions}), with the name as its
 * detail; the main-world listener ({@link installMainWorldDefinitions}) waits with
 * `customElements.whenDefined` and dispatches {@link ELEMENT_DEFINED} on the window once
 * that name is defined. Neither event carries anything else, and the isolated world reads
 * nothing from the main world but that an element was defined: a page, which controls its
 * main world, can only send that event without a definition, which costs one more check
 * of the page, or keep it back, which leaves the form to be found on the page's next DOM
 * change. The events tell a page that Pateat is installed, as the main-world click does
 * (`script-url-click.ts`).
 */

// Nothing here imports the extension's APIs, which the main world does not have.

/** Asks the main world to report when the element name in the detail is defined. */
export const AWAIT_DEFINITION = "pateat-await-definition";
/** The main world's report that one of the asked names is now defined; no detail. */
export const ELEMENT_DEFINED = "pateat-element-defined";

/** The names each document already asked about, so each is asked once. */
const asked = new WeakMap<Document, Set<string>>();

/**
 * Asks the main world about every element name in `document` and its shadow trees
 * (`roots`, every one the page holds) whose element is not defined yet and was not asked
 * about before. A name the page never defines costs nothing after that.
 */
export function askDefinitions(document: Document, roots: readonly ShadowRoot[]): void {
  let names = asked.get(document);
  if (!names) asked.set(document, (names = new Set()));
  for (const tree of [document, ...roots])
    for (const element of tree.querySelectorAll(":not(:defined)")) {
      const name = element.localName;
      // Only a valid custom element name can be defined later.
      if (!name.includes("-") || names.has(name)) continue;
      names.add(name);
      document.dispatchEvent(new CustomEvent(AWAIT_DEFINITION, { detail: name }));
    }
}

/**
 * Installs the main-world listener: for each name it is asked about, once, it waits until
 * the page defines that name and then reports it. Returns the removal.
 */
export function installMainWorldDefinitions(): () => void {
  // Taken at document start, before page scripts can replace them.
  const registry = globalThis.customElements as CustomElementRegistry | null | undefined;
  if (!registry) return () => undefined;
  const whenDefined = CustomElementRegistry.prototype.whenDefined;
  const waiting = new Set<string>();
  let removed = false;
  const listener = (event: Event) => {
    const name: unknown = (event as CustomEvent).detail;
    if (typeof name !== "string" || waiting.has(name)) return;
    waiting.add(name);
    // An invalid name rejects; it is never defined.
    whenDefined.call(registry, name).then(
      () => (removed ? false : dispatchEvent(new Event(ELEMENT_DEFINED))),
      () => undefined,
    );
  };
  addEventListener(AWAIT_DEFINITION, listener, true);
  return () => {
    removed = true;
    removeEventListener(AWAIT_DEFINITION, listener, true);
  };
}
