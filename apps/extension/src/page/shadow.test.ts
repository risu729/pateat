import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closestAcross,
  composedOrder,
  containsAcross,
  formOf,
  inputsOf,
  queryAll,
  readingPage,
  shadowRoots,
  textWalker,
} from "./shadow";

/** Closed shadow roots, which a content script reaches through `dom.openOrClosedShadowRoot`. */
const closedRoots = vi.hoisted(() => new WeakMap<Element, ShadowRoot>());
/** How many times the content script asked an element for its closed root. */
const asked = vi.hoisted(() => ({ count: 0 }));
vi.mock("wxt/browser", () => ({
  browser: {
    dom: {
      openOrClosedShadowRoot: (element: HTMLElement) => {
        asked.count++;
        return closedRoots.get(element) ?? element.shadowRoot;
      },
    },
  },
}));

afterEach(() => {
  document.body.innerHTML = "";
});

/** Gives `host` a shadow root holding `html`. */
const shadow = (host: Element, html: string, mode: ShadowRootMode = "open") => {
  const root = host.attachShadow({ mode });
  if (mode === "closed") closedRoots.set(host, root);
  root.innerHTML = html;
  return root;
};
const ids = (elements: readonly Element[]) => elements.map((element) => element.id);

describe("queryAll", () => {
  it("reads every shadow tree, a host's right after it and before its children", () => {
    document.body.innerHTML = `<i id="a"></i><x-host id="b"><i id="c"></i></x-host><i id="d"></i>`;
    const outer = shadow(
      document.querySelector("#b")!,
      `<i id="s1"></i><x-inner id="n"></x-inner><slot></slot>`,
    );
    shadow(outer.querySelector("#n")!, `<i id="s2"></i>`, "closed");
    expect(ids(queryAll(document, "i"))).toEqual(["a", "s1", "s2", "c", "d"]);
    // Every matched element sorts the same way.
    const shuffled = [...queryAll(document, "i")].reverse().sort(composedOrder);
    expect(ids(shuffled)).toEqual(["a", "s1", "s2", "c", "d"]);
    // A host that matches comes before its own shadow tree.
    expect(ids(queryAll(document, "x-host, i, x-inner"))).toEqual([
      "a",
      "b",
      "s1",
      "n",
      "s2",
      "c",
      "d",
    ]);
    // Under an element: its own shadow tree and those below it.
    expect(ids(queryAll(document.querySelector("#b")!, "i"))).toEqual(["s1", "s2", "c"]);
    expect(shadowRoots(document)).toHaveLength(2);
  });

  it("matches a selector within one tree, never across a shadow boundary", () => {
    document.body.innerHTML = `<form id="f"><x-field id="host"></x-field></form>`;
    shadow(document.querySelector("#host")!, `<input id="in">`);
    expect(queryAll(document, "form input")).toEqual([]);
    expect(ids(queryAll(document, "input"))).toEqual(["in"]);
  });

  it("finds a shadow root attached after an earlier read, but not within one page read", () => {
    document.body.innerHTML = `<x-late id="host"></x-late>`;
    expect(queryAll(document, "input")).toEqual([]);
    readingPage(() => {
      expect(queryAll(document, "input")).toEqual([]);
      shadow(document.querySelector("#host")!, `<input id="in">`);
      // A read runs no page script, so its hosts are looked up once.
      expect(queryAll(document, "input")).toEqual([]);
    });
    expect(ids(queryAll(document, "input"))).toEqual(["in"]);
  });

  it("asks each element for its closed root once within one page read", () => {
    document.body.innerHTML = Array.from(
      { length: 100 },
      (_, at) => `<div><x-field id="h${at}"></x-field><span></span></div>`,
    ).join("");
    for (const host of document.querySelectorAll("x-field"))
      shadow(host, `<label>Field <input id="in-${host.id}"></label><x-icon></x-icon>`, "closed");
    // The `body`, the light tree's 100 `x-field`, 100 `div` and 100 `span`, and the 100
    // `x-icon` inside: each element `attachShadow` accepts, once.
    const candidates = 401;
    asked.count = 0;
    readingPage(() => {
      for (let read = 0; read < 10; read++) {
        expect(queryAll(document, "input")).toHaveLength(100);
        for (const host of document.querySelectorAll("x-field")) queryAll(host, "input");
      }
      expect(shadowRoots(document)).toHaveLength(100);
    });
    expect(asked.count).toBe(candidates);
  });
});

describe("ancestors across shadow boundaries", () => {
  it("goes on from the top of a shadow tree to its host", () => {
    document.body.innerHTML = `<nav id="nav"><form id="f"><x-field id="host"></x-field></form></nav>`;
    const root = shadow(document.querySelector("#host")!, `<div><input id="in"></div>`, "closed");
    const input = root.querySelector("input")!;
    expect(input.closest("form")).toBeNull();
    expect(closestAcross(input, "form")?.id).toBe("f");
    expect(closestAcross(input, "nav")?.id).toBe("nav");
    expect(containsAcross(document.querySelector("#f")!, input)).toBe(true);
    expect(containsAcross(input, document.querySelector("#f")!)).toBe(false);
  });

  it("gives a component's fields the form that holds the component", () => {
    document.body.innerHTML = `<form id="f"><input id="own"><x-field id="host"></x-field></form>
      <input id="tied" form="f"><input id="free">`;
    const root = shadow(document.querySelector("#host")!, `<input id="in">`);
    const input = root.querySelector("input")!;
    expect(input.form).toBeNull();
    expect(formOf(input)?.id).toBe("f");
    expect(ids(inputsOf(document.querySelector("form"), document))).toEqual(["own", "in", "tied"]);
    expect(ids(inputsOf(null, document))).toEqual(["free"]);
    // A form inside the shadow tree is the field's own.
    document.body.innerHTML = `<form id="outer"><x-field id="host"></x-field></form>`;
    // Built by hand: parsing markup into the shadow root of a host inside a form drops a
    // `<form>` tag, as the parser allows no form inside another.
    const inner = document.createElement("form");
    inner.id = "inner";
    inner.append(document.createElement("input"));
    shadow(document.querySelector("#host")!, "").append(inner);
    expect(formOf(inner.querySelector("input")!)?.id).toBe("inner");
  });
});

describe("textWalker", () => {
  it("walks the text of shadow trees in the page's order", () => {
    document.body.innerHTML = `<p>one</p><x-host id="host"><b>three</b></x-host><p>four</p>`;
    shadow(document.querySelector("#host")!, `two <slot></slot>`, "closed");
    const walker = textWalker(document.body, (text) => text.data.trim() !== "");
    const texts: string[] = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text.data.trim());
    expect(texts).toEqual(["one", "two", "three", "four"]);
  });
});
