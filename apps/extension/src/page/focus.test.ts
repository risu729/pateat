import { afterEach, describe, expect, it, vi } from "vitest";
import { typeValue } from "./enter-value";
import { blurElement, focusElement } from "./focus";
import { pressElement } from "./script-url-click";

/** Closed shadow roots, which a content script reaches through `dom.openOrClosedShadowRoot`. */
const closedRoots = vi.hoisted(() => new WeakMap<Element, ShadowRoot>());
vi.mock("wxt/browser", () => ({
  browser: {
    dom: {
      openOrClosedShadowRoot: (element: HTMLElement) =>
        closedRoots.get(element) ?? element.shadowRoot,
    },
  },
}));

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/**
 * Makes the page see what Chrome sends while its window is not focused: the document
 * does not have focus, and focus moves, but no focus event reaches the page. Registered
 * first, so it stops Chrome's own events before any later listener sees them.
 */
function unfocusedWindow(): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const swallow = (event: Event) => {
    if (event.isTrusted) event.stopImmediatePropagation();
  };
  for (const type of ["focus", "focusin", "blur", "focusout"]) {
    addEventListener(type, swallow, true);
    cleanups.push(() => removeEventListener(type, swallow, true));
  }
}

/** Records the focus events `targets` get, as `type@id`. */
function record(...targets: HTMLElement[]): string[] {
  const events: string[] = [];
  for (const target of targets)
    for (const type of ["focus", "focusin", "blur", "focusout"]) {
      const listener = (event: Event) => {
        if (event.target === target) events.push(`${type}@${target.id || target.localName}`);
      };
      target.addEventListener(type, listener);
      cleanups.push(() => target.removeEventListener(type, listener));
    }
  return events;
}

describe("focusElement and blurElement", () => {
  it("send no event of their own while Chrome sends them", () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const [a, b] = [...document.querySelectorAll("input")] as [HTMLInputElement, HTMLInputElement];
    a.focus();
    const events = record(a, b);
    expect(focusElement(b)).toBe(true);
    blurElement(b);
    expect(events).toEqual([
      "blur@a",
      "focusout@a",
      "focus@b",
      "focusin@b",
      "blur@b",
      "focusout@b",
    ]);
  });

  it("send the focus move Chrome kept from the page, in Chrome's order", () => {
    document.body.innerHTML = `<input id="a"><input id="b">`;
    const [a, b] = [...document.querySelectorAll("input")] as [HTMLInputElement, HTMLInputElement];
    a.focus();
    unfocusedWindow();
    const events = record(a, b);
    let related: EventTarget | null = null;
    b.addEventListener("focus", (event) => {
      related = event.relatedTarget;
    });
    expect(focusElement(b)).toBe(true);
    blurElement(b);
    expect(events).toEqual([
      "blur@a",
      "focusout@a",
      "focus@b",
      "focusin@b",
      "blur@b",
      "focusout@b",
    ]);
    expect(related).toBe(a);
    expect(document.activeElement).toBe(document.body);
  });

  it("sends nothing when the element cannot take focus", () => {
    document.body.innerHTML = `<input id="a"><div id="plain">Text</div>`;
    const a = document.getElementById("a") as HTMLInputElement;
    const plain = document.getElementById("plain")!;
    a.focus();
    unfocusedWindow();
    const events = record(a, plain);
    expect(focusElement(plain)).toBe(false);
    expect(events).toEqual([]);
  });

  it("lets a page that copies a field on blur see a fill in a window without focus", async () => {
    document.body.innerHTML = `<input id="shown"><input id="sent" type="hidden">`;
    const shown = document.getElementById("shown") as HTMLInputElement;
    const sent = document.getElementById("sent") as HTMLInputElement;
    shown.addEventListener("blur", () => {
      sent.value = shown.value;
    });
    unfocusedWindow();
    expect(await typeValue(shown, "me@example.com", setter)).toBeUndefined();
    expect(sent.value).toBe("me@example.com");
  });

  it("blurs a field inside a shadow root", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<input id="field">`;
    const field = root.getElementById("field") as HTMLInputElement;
    unfocusedWindow();
    const events = record(field);
    expect(await typeValue(field, "me", setter)).toBeUndefined();
    expect(events).toEqual(["focus@field", "focusin@field", "blur@field", "focusout@field"]);
    expect(root.activeElement).toBeNull();
  });

  it("finds the focused field inside a closed shadow root (ADR 0070)", async () => {
    document.body.innerHTML = `<input id="a"><x-field id="host"></x-field>`;
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "closed" });
    closedRoots.set(host, root);
    root.innerHTML = `<input id="field">`;
    const field = root.getElementById("field") as HTMLInputElement;
    (document.getElementById("a") as HTMLInputElement).focus();
    unfocusedWindow();
    const events = record(field);
    expect(focusElement(field)).toBe(true);
    expect(document.activeElement).toBe(host);
    expect(events).toEqual(["focus@field", "focusin@field"]);
  });

  it("sends a press's focus move in a window without focus, and keeps the button focused", async () => {
    document.body.innerHTML = `<input id="code"><button id="t" type="button">Verify</button>`;
    const input = document.getElementById("code") as HTMLInputElement;
    const button = document.getElementById("t")!;
    input.focus();
    unfocusedWindow();
    const events = record(input, button);
    await pressElement(button);
    expect(events).toEqual(["blur@code", "focusout@code", "focus@t", "focusin@t"]);
    expect(document.activeElement).toBe(button);
  });

  it("counts focus a shadow host delegates to an element inside it", async () => {
    document.body.innerHTML = `<input id="code"><div id="host" tabindex="0"></div>`;
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open", delegatesFocus: true });
    root.innerHTML = `<button id="inner">Go</button>`;
    expect(focusElement(host)).toBe(true);
    (document.getElementById("code") as HTMLInputElement).focus();
    await pressElement(host);
    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBe(root.getElementById("inner"));
  });
});
