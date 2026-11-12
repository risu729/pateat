// A `<form>` element exposes each of its named controls as a property of that name, and
// those hide the platform's own members, inherited ones too (`[LegacyOverrideBuiltIns]`
// in HTML): in `<form><input name="contains"></form>`, `form.contains` is the input. Code
// that may hold a form, whether a form variable or a node a walk of the page may meet,
// reads its properties through these and calls its methods through the platform's
// prototypes, as `Node.prototype.contains.call(form, node)`; the prototypes of the content
// script's world are the platform's own.

/** The keys of `T` that are no methods. */
type Property<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? never : K;
}[keyof T];

/** `node[key]` as `Node` defines it, never a form's control named `key`. */
export function nodeProperty<K extends Property<Node>>(node: Node, key: K): Node[K] {
  return Reflect.get(Node.prototype, key, node) as Node[K];
}

/** `element[key]` as `Element` defines it, never a form's control named `key`. */
export function elementProperty<K extends Property<Element>>(element: Element, key: K): Element[K] {
  return Reflect.get(Element.prototype, key, element) as Element[K];
}
