// The page as the content script reads it includes every shadow root, open or closed
// (ADR 0070): a content script reaches a closed one through `dom.openOrClosedShadowRoot`,
// as the official Bitwarden extension's `DomQueryService` does. These helpers walk the
// document and every shadow tree in it in one order, a host's shadow tree right after the
// host and before the host's own children, as Bitwarden's tree walker visits them.

import { browser } from "wxt/browser";

/**
 * The elements besides custom elements that `attachShadow` accepts (DOM standard), the
 * only ones whose closed shadow root is worth asking for, as Bitwarden's
 * `SHADOW_ROOT_CANDIDATE_NODE_NAMES` lists them.
 */
const hostNames = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "span",
]);

/** `element`'s shadow root, open or closed, or `null` when it has none. */
export function shadowRootOf(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  if (!element.localName.includes("-") && !hostNames.has(element.localName)) return null;
  const cached = reading?.roots.get(element);
  if (cached !== undefined) return cached;
  let root: ShadowRoot | null;
  try {
    root = browser?.dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? null;
  } catch {
    root = null;
  }
  reading?.roots.set(element, root);
  return root;
}

/** Each element's closed root and each tree's shadow hosts, while {@link readingPage} runs. */
let reading:
  | {
      roots: WeakMap<Element, ShadowRoot | null>;
      hosts: WeakMap<Document | ShadowRoot, Element[]>;
    }
  | undefined;

/**
 * Runs `read` with each element's closed root and each tree's shadow hosts looked up once:
 * one read of a page asks for the same trees many times, and asking every element for a
 * closed root is the expensive part. Only for a read that changes nothing and dispatches
 * no event, so no page script runs and no shadow root comes or goes meanwhile.
 */
export function readingPage<Result>(read: () => Result): Result {
  if (reading) return read();
  reading = { roots: new WeakMap(), hosts: new WeakMap() };
  try {
    return read();
  } finally {
    reading = undefined;
  }
}

const isHost = (element: Element) => shadowRootOf(element) !== null;

/**
 * The shadow hosts under `scope` in its own tree, in tree order, `scope` left out. Outside
 * {@link readingPage} only `scope`'s own elements are asked, so a query under one element
 * costs what that element holds.
 */
function hostsUnder(scope: Document | ShadowRoot | Element): Element[] {
  if (!reading) return [...scope.querySelectorAll("*")].filter(isHost);
  const tree = scope instanceof Element ? (scope.getRootNode() as Document | ShadowRoot) : scope;
  let hosts = reading.hosts.get(tree);
  if (!hosts) {
    hosts = [...tree.querySelectorAll("*")].filter(isHost);
    reading.hosts.set(tree, hosts);
  }
  return scope === tree ? hosts : hosts.filter((host) => host !== scope && scope.contains(host));
}

const follows = (earlier: Node, later: Node) =>
  (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * Every element under `scope` matching `selector`, in its document and every shadow tree
 * below it, in the order {@link composedOrder} sorts: `querySelectorAll` that also reads
 * shadow roots. An element `scope`'s own shadow tree holds counts as under it. A selector
 * matches within one tree, so a combinator never crosses a shadow boundary.
 */
export function queryAll<E extends Element = Element>(
  scope: Document | ShadowRoot | Element,
  selector: string,
): E[] {
  const found: E[] = [];
  collect(scope, selector, found);
  return found;
}

function collect<E extends Element>(
  scope: Document | ShadowRoot | Element,
  selector: string,
  found: E[],
): void {
  const own = scope instanceof Element ? shadowRootOf(scope) : null;
  if (own) collect(own, selector, found);
  const hosts = hostsUnder(scope);
  const matches = [...scope.querySelectorAll<E>(selector)];
  if (hosts.length === 0) {
    found.push(...matches);
    return;
  }
  let next = 0;
  const shadowOfNext = () => {
    const root = shadowRootOf(hosts[next++]!);
    if (root) collect(root, selector, found);
  };
  for (const match of matches) {
    while (next < hosts.length && follows(hosts[next]!, match)) shadowOfNext();
    found.push(match);
    if (hosts[next] === match) shadowOfNext();
  }
  while (next < hosts.length) shadowOfNext();
}

/** The first element {@link queryAll} finds, or `null`. */
export function queryFirst<E extends Element = Element>(
  scope: Document | ShadowRoot | Element,
  selector: string,
): E | null {
  return queryAll<E>(scope, selector)[0] ?? null;
}

/** Every shadow root in `document`, nested ones too, in {@link composedOrder}. */
export function shadowRoots(document: Document): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const walk = (tree: Document | ShadowRoot) => {
    for (const host of hostsUnder(tree)) {
      const root = shadowRootOf(host);
      if (!root) continue;
      roots.push(root);
      walk(root);
    }
  };
  walk(document);
  return roots;
}

/** The host of the shadow tree that holds `node`, or `null` in the document's own tree. */
export function hostOf(node: Node): Element | null {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** `node`'s parent element, or for the top of a shadow tree, its host. */
export function composedParent(node: Node): Element | null {
  if (node.parentElement) return node.parentElement;
  const parent = node.parentNode;
  return parent instanceof ShadowRoot ? parent.host : null;
}

/**
 * A walk over the text nodes under `start` that `accept` takes, its shadow trees' included,
 * in {@link composedOrder}: `createTreeWalker` with `SHOW_TEXT` that also reads shadow
 * roots.
 */
export function textWalker(
  start: Node,
  accept: (text: Text) => boolean,
): { nextNode: () => Text | null } {
  const document = start.ownerDocument ?? (start as Document);
  const walk = (root: Node) =>
    document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const walkers = [walk(start)];
  const own = start instanceof Element ? shadowRootOf(start) : null;
  if (own) walkers.push(walk(own));
  return {
    nextNode: () => {
      for (let walker = walkers.at(-1); walker; walker = walkers.at(-1)) {
        const node = walker.nextNode();
        if (!node) walkers.pop();
        else if (node instanceof Text) {
          if (accept(node)) return node;
        } else if (node instanceof Element) {
          const root = shadowRootOf(node);
          if (root) walkers.push(walk(root));
        }
      }
      return null;
    },
  };
}

/**
 * `element.closest(selector)` that goes on from the top of a shadow tree to its host, so
 * a field inside a component still sits in the `<form>`, landmark or hidden element that
 * holds the component.
 */
export function closestAcross(element: Element, selector: string): Element | null {
  for (let node: Element | null = element; node; node = hostOf(node)) {
    const found = node.closest(selector);
    if (found) return found;
  }
  return null;
}

/** `ancestor.contains(node)` that also counts a node in a shadow tree below `ancestor`. */
export function containsAcross(ancestor: Node, node: Node): boolean {
  for (let at: Node | null = node; at; at = hostOf(at)) if (ancestor.contains(at)) return true;
  return false;
}

/** The tree that holds `element`, where the IDs it references resolve. */
export const treeOf = (element: Element) => element.getRootNode() as Document | ShadowRoot;

/**
 * The form a control belongs to: its own form owner, else, for one in a shadow tree, the
 * `<form>` that holds its host, as a component that stands for a field inside a form; a
 * form owner never reaches across a shadow boundary itself.
 */
export function formOf(
  element: HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement,
): HTMLFormElement | null {
  if (element.form) return element.form;
  const host = hostOf(element);
  return host ? (closestAcross(host, "form") as HTMLFormElement | null) : null;
}

/** The fields and buttons {@link formOf} gives `form`, or every one without a form for `null`. */
export function controlsOf(
  form: HTMLFormElement | null,
  document: Document,
): (HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement)[] {
  const controls = queryAll<
    HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
  >(document, "input, button, select, textarea");
  return controls.filter((control) => formOf(control) === form);
}

/** The inputs {@link formOf} gives `form`, or every input without a form for `null`. */
export const inputsOf = (form: HTMLFormElement | null, document: Document) =>
  controlsOf(form, document).filter((control) => control instanceof HTMLInputElement);

/** `element` and its hosts, outermost first. */
function lineage(element: Element): Element[] {
  const chain = [element];
  for (let host = hostOf(element); host; host = hostOf(host)) chain.unshift(host);
  return chain;
}

/**
 * Sorts elements as {@link queryAll} lists them: in tree order within one tree, and a
 * shadow tree's elements right after its host. `compareDocumentPosition` alone cannot
 * order elements of different trees.
 */
export function composedOrder(left: Element, right: Element): number {
  if (left === right) return 0;
  const leftChain = lineage(left);
  const rightChain = lineage(right);
  let at = 0;
  while (at < leftChain.length && at < rightChain.length && leftChain[at] === rightChain[at]) at++;
  if (at === leftChain.length) return -1;
  if (at === rightChain.length) return 1;
  return follows(leftChain[at]!, rightChain[at]!) ? -1 : 1;
}
