import { afterEach, describe, expect, it } from "vitest";
import { showsAmount } from "./amount";
import { elementProperty, nodeProperty } from "./form-native";
import {
  closestAcross,
  composedParent,
  containsAcross,
  hostOf,
  queryAll,
  shadowRootOf,
  textWalker,
  treeOf,
} from "./shadow";
import { openModals, readBehindModal, renderedText, shown } from "./text";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Controls named after the members a page read uses, which the form's own members hide. */
const names = [
  "contains",
  "isConnected",
  "ownerDocument",
  "getAttribute",
  "querySelector",
  "querySelectorAll",
  "getRootNode",
  "closest",
  "shadowRoot",
  "localName",
  "tagName",
  "parentNode",
  "parentElement",
  "lastChild",
  "previousSibling",
  "children",
  "assignedSlot",
  "checkVisibility",
  "getAnimations",
  "matches",
];

function namedForm() {
  document.body.innerHTML = `<main><p>Before</p><form id="f">
    <p>Pay <b>¥1,000</b></p><input id="pin" type="password">
    ${names.map((name) => `<input type="hidden" name="${name}">`).join("")}</form></main>`;
  const form = document.querySelector("form")!;
  for (const name of names) expect(Reflect.get(form, name), name).toBeInstanceOf(HTMLInputElement);
  return form;
}

describe("forms whose named controls hide their own members", () => {
  it("reads the form's own properties through the prototypes", () => {
    const form = namedForm();
    expect(nodeProperty(form, "isConnected")).toBe(true);
    expect(elementProperty(form, "ownerDocument")).toBe(document);
    expect(elementProperty(form, "localName")).toBe("form");
    expect(nodeProperty(form, "parentElement")).toBe(document.querySelector("main"));
    form.remove();
    expect(nodeProperty(form, "isConnected")).toBe(false);
  });

  it("walks the page's trees through such a form", () => {
    const form = namedForm();
    const pin = document.querySelector("#pin")!;
    expect(queryAll(form, "#pin")).toEqual([pin]);
    expect(queryAll(document, "form")).toEqual([form]);
    expect(containsAcross(form, pin)).toBe(true);
    expect(containsAcross(form, document.querySelector("main")!)).toBe(false);
    expect(closestAcross(form, "main")).toBe(document.querySelector("main"));
    expect(composedParent(form)).toBe(document.querySelector("main"));
    expect(hostOf(form)).toBeNull();
    expect(treeOf(form)).toBe(document);
    expect(shadowRootOf(form)).toBeNull();
  });

  it("reads the visibility and rendered text of such a form", () => {
    const form = namedForm();
    expect(shown(form)).toBe(true);
    expect(renderedText(form, 100)?.replace(/\s+/gu, " ").trim()).toBe("Pay ¥1,000");
    expect(renderedText(document.querySelector("main")!, 100)?.replace(/\s+/gu, " ").trim()).toBe(
      "Before Pay ¥1,000",
    );
    expect(showsAmount(form)).toBe(true);
  });
});

describe("pages whose named elements hide the document's own members", () => {
  it("queries and walks the document through Document", () => {
    document.body.innerHTML = `<img name="querySelectorAll" alt="">
      <form name="createTreeWalker"><p id="text">Signed in</p></form>`;
    expect(Reflect.get(document, "querySelectorAll")).toBeInstanceOf(HTMLImageElement);
    expect(Reflect.get(document, "createTreeWalker")).toBeInstanceOf(HTMLFormElement);
    expect(queryAll(document, "#text")).toEqual([document.querySelector("#text")]);
    const walker = textWalker(document.body, (text) => text.data.includes("Signed"));
    expect(walker.nextNode()?.data).toBe("Signed in");
  });
});

describe("modals beside forms whose named controls hide their own members", () => {
  it("reads the page behind a modal through such forms", () => {
    const named = ["matches", "children", "parentNode", "getAttribute"]
      .map((name) => `<input type="hidden" name="${name}">`)
      .join("");
    document.body.innerHTML = `<form id="beside">${named}</form>
      <form id="outer">${named}<div id="behind" aria-hidden="true"><p id="text">Behind</p></div>
      <div id="modal" role="dialog" aria-modal="true">Offer</div></form>
      <form id="dialog" role="dialog" aria-modal="true">${named}Form dialog</form>`;
    const text = document.querySelector("#text")!;
    expect(openModals(document).map((modal) => modal.id)).toEqual(["modal", "dialog"]);
    expect(shown(text)).toBe(false);
    expect(readBehindModal(document, () => shown(text))).toBe(true);
  });
});
