import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_WORLD_CLICK,
  MAIN_WORLD_SUBMIT,
  installMainWorldClicks,
  pressElement,
  runsScriptUrl,
  submitForm,
} from "./script-url-click";

// One Chromium page plays both worlds here: `installMainWorldClicks` keeps the click it
// found at install, so a spy installed afterwards on `HTMLElement.prototype.click` counts
// only the isolated world's clicks, and a click listener counts every click.
const removals: (() => void)[] = [];
afterEach(() => {
  for (const remove of removals.splice(0)) remove();
  document.body.innerHTML = "";
  delete (window as { ran?: number }).ran;
});

/** Renders `html` (or the element `render` returns), presses `#t` and reports what each world did. */
async function press(html: string | (() => Element), { listener = true } = {}) {
  if (listener) removals.push(installMainWorldClicks());
  if (typeof html === "string") document.body.innerHTML = html;
  const target = typeof html === "string" ? document.getElementById("t")! : html();
  const isolated = vi.spyOn(HTMLElement.prototype, "click");
  let clicks = 0;
  const events: Event[] = [];
  const count = () => {
    clicks += 1;
  };
  const record = (event: Event) => events.push(event);
  target.addEventListener("click", count);
  addEventListener(MAIN_WORLD_CLICK, record, true);
  try {
    await pressElement(target as HTMLElement);
  } finally {
    removeEventListener(MAIN_WORLD_CLICK, record, true);
    target.removeEventListener("click", count);
  }
  const calls = isolated.mock.calls.length;
  isolated.mockRestore();
  return { clicks, isolated: calls, events };
}

describe("runsScriptUrl", () => {
  it("reads the parsed URL of an `<a href>`", () => {
    document.body.innerHTML = `<a id="a" href="javascript:;">A</a><a id="b" href=" JavaScript:void 0">B</a>
      <a id="c" href="java&#9;script:x()">C</a><a id="d" href="#">D</a><a id="e" onclick="x()">E</a>
      <a id="f" href="https://example.test/javascript:">F</a><button id="g">G</button><a id="h" href="data:,x">H</a><a id="i" href="VBScript:x">I</a>`;
    const ids = [...document.querySelectorAll("[id]")]
      .filter((element) => runsScriptUrl(element))
      .map((element) => element.id);
    // `data:` and `vbscript:` URLs never navigate from a page, so either world may click them.
    expect(ids).toEqual(["a", "b", "c", "h", "i"]);
  });

  it("follows a click to the link, area or submit control it activates", () => {
    document.body.innerHTML = `<a href="javascript:;"><span id="a">A</span></a>
      <map name="m"><area id="b" href="javascript:;" alt="B"></map>
      <form action=" JavaScript:void(0);"><input name="action"><button id="c">C</button>
        <input id="d" type="submit"><input id="e" type="image" alt="E">
        <button id="f" type="button">F</button><input id="g" type="text">
        <button id="h" formaction="/sign-in">H</button><label id="i">I <input type="submit"></label></form>
      <form action="/sign-in"><button id="j">J</button><button id="k" formaction="javascript:x()">K</button>
        <button id="l" formaction="">L</button></form>
      <button id="m" form="script">M</button><form id="script" action="javascript:;"></form>
      <form action="javascript:;"><label for="n-control" id="n">N</label><input id="n-control" type="submit"></form>
      <form action="javascript:;"><input name="matches"><input name="parentNode"><input name="parentElement">
        <input name="assignedSlot"><input name="closest"><div id="p" role="button">P</div></form>
      <div id="host"></div>`;
    const link = Object.assign(document.createElement("a"), { href: "javascript:;" });
    link.append(Object.assign(document.createElement("slot")));
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).append(link);
    host.append(Object.assign(document.createElement("span"), { id: "o" }));
    const ids = [...document.querySelectorAll("[id]")]
      .filter((element) => runsScriptUrl(element))
      .map((element) => element.id);
    // A form's `action` is read past its control named `action`; a `formaction` replaces
    // it, also when empty; an element slotted into a `javascript:` link activates it; and
    // the walk up from `p` passes a form whose controls hide its members.
    expect(ids).toEqual(["a", "b", "c", "d", "e", "i", "k", "m", "n", "n-control", "o"]);
  });

  it("follows a click to a `<label>`'s control across shadow roots and slots", () => {
    document.body.innerHTML = `<div id="slotted-host"><span id="slotted">S</span></div>
      <form action="javascript:;"><label><div id="shadow-host"></div><input type="submit"></label></form>`;
    // The label is inside a shadow tree, and the span is slotted into it.
    document.getElementById("slotted-host")!.attachShadow({
      mode: "open",
    }).innerHTML = `<form action="javascript:;"><label><slot></slot><input type="submit"></label></form>`;
    // The span is in a shadow tree whose host is inside the label.
    const inner = document.createElement("span");
    document.getElementById("shadow-host")!.attachShadow({ mode: "open" }).append(inner);
    expect([runsScriptUrl(document.getElementById("slotted")), runsScriptUrl(inner)]).toEqual([
      true,
      true,
    ]);
  });

  it("leaves a link or input inside a `<label>` to its own activation", () => {
    // A click on interactive content inside a label runs only that content's activation.
    document.body.innerHTML = `<form action="javascript:;"><label><input type="submit">
      <a id="a" href="https://example.test/">A</a><input id="b" type="text"></label></form>`;
    expect(["a", "b"].map((id) => runsScriptUrl(document.getElementById(id)))).toEqual([
      false,
      false,
    ]);
  });
});

describe("pressElement", () => {
  it("has the main world click a `javascript:` link once, and runs its URL once", async () => {
    const result = await press(
      `<a id="t" href="javascript:void (window.ran = (window.ran ?? 0) + 1)">Go</a>`,
    );
    expect(result).toMatchObject({ clicks: 1, isolated: 0 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      defaultPrevented: true,
      bubbles: false,
      detail: null,
    });
    await vi.waitFor(() => expect((window as { ran?: number }).ran).toBe(1));
    // No second run follows.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((window as { ran?: number }).ran).toBe(1);
  });

  it("reaches a `javascript:` link inside an open shadow root", async () => {
    const shadowLink = () => {
      document.body.innerHTML = "<div></div>";
      const link = Object.assign(document.createElement("a"), { href: "javascript:void 0" });
      document.querySelector("div")!.attachShadow({ mode: "open" }).append(link);
      return link;
    };
    expect(await press(shadowLink)).toMatchObject({ clicks: 1, isolated: 0 });
  });

  it("has the main world click a submit button whose form's action is `javascript:`, once", async () => {
    let submits = 0;
    const count = () => {
      submits += 1;
    };
    addEventListener("submit", count, true);
    removals.push(() => removeEventListener("submit", count, true));
    const result = await press(
      `<form action="JavaScript:void (window.ran = (window.ran ?? 0) + 1)"><button id="t">Sign in</button></form>`,
    );
    expect(result).toMatchObject({ clicks: 1, isolated: 0 });
    expect(result.events.map((event) => event.defaultPrevented)).toEqual([true]);
    expect(submits).toBe(1);
    await vi.waitFor(() => expect((window as { ran?: number }).ran).toBe(1));
  });

  it("has the main world click text inside a `javascript:` link", async () => {
    const result = await press(`<a href="javascript:void 0"><span id="t">Log in</span></a>`);
    expect(result).toMatchObject({ clicks: 1, isolated: 0 });
    expect(result.events.map((event) => event.defaultPrevented)).toEqual([true]);
  });

  it("clicks other links, buttons and script links without a `javascript:` URL as before", async () => {
    for (const html of [
      `<a id="t" href="#next">Next</a>`,
      `<a id="t" href="#" onclick="return false">Log in</a>`,
      `<a id="t" role="button">Log in</a>`,
      `<button id="t" type="button">Log in</button>`,
      `<input id="t" type="button" value="Log in">`,
    ]) {
      for (const remove of removals.splice(0)) remove();
      // eslint-disable-next-line no-await-in-loop
      const result = await press(html);
      expect(result, html).toMatchObject({ clicks: 1, isolated: 1, events: [] });
    }
  });

  it("clicks a `javascript:` link itself when no main-world listener answers", async () => {
    const result = await press(`<a id="t" href="javascript:void 0">Go</a>`, { listener: false });
    expect(result).toMatchObject({ clicks: 1, isolated: 1 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.defaultPrevented).toBe(false);
  });
});

describe("installMainWorldClicks", () => {
  it("leaves alone an event a page dispatches on any other element", () => {
    removals.push(installMainWorldClicks());
    document.body.innerHTML = `<a id="a" href="#">A</a><button id="b">B</button><a id="c" href="javascript:void 0">C</a>`;
    let clicks = 0;
    const count = () => {
      clicks += 1;
    };
    addEventListener("click", count, true);
    removals.push(() => removeEventListener("click", count, true));
    const send = (id: string) =>
      document
        .getElementById(id)!
        .dispatchEvent(new CustomEvent(MAIN_WORLD_CLICK, { cancelable: true }));
    expect([send("a"), send("b")]).toEqual([true, true]);
    expect(clicks).toBe(0);
    // A page could click its own link anyway; the listener clicks only that link.
    expect(send("c")).toBe(false);
    expect(clicks).toBe(1);
  });

  it("stops clicking once removed", async () => {
    installMainWorldClicks()();
    const result = await press(`<a id="t" href="javascript:void 0">Go</a>`, { listener: false });
    expect(result).toMatchObject({ clicks: 1, isolated: 1 });
  });
});

describe("submitForm", () => {
  /** Submits `#t`, and reports the submit events and the isolated world's `requestSubmit` calls. */
  function submit(html: string, { listener = true } = {}) {
    if (listener) removals.push(installMainWorldClicks());
    document.body.innerHTML = html;
    const form = document.getElementById("t") as HTMLFormElement;
    const isolated = vi.spyOn(HTMLFormElement.prototype, "requestSubmit");
    let submits = 0;
    const count = (event: Event) => {
      submits += 1;
      event.preventDefault();
    };
    const events: Event[] = [];
    const record = (event: Event) => events.push(event);
    form.addEventListener("submit", count);
    addEventListener(MAIN_WORLD_SUBMIT, record, true);
    try {
      submitForm(form);
      return { submits, isolated: isolated.mock.calls.length, events };
    } finally {
      removeEventListener(MAIN_WORLD_SUBMIT, record, true);
      isolated.mockRestore();
    }
  }

  it("has the main world submit a form whose action is `javascript:`", () => {
    const result = submit(`<form id="t" action=" javascript:void 0"><input name="action"></form>`);
    expect(result).toMatchObject({ submits: 1, isolated: 0 });
    expect(result.events.map((event) => event.defaultPrevented)).toEqual([true]);
  });

  it("submits any other form, or one no listener answers, itself", () => {
    expect(submit(`<form id="t" action="/sign-in"></form>`)).toMatchObject({
      submits: 1,
      isolated: 1,
      events: [],
    });
    for (const remove of removals.splice(0)) remove();
    const result = submit(`<form id="t" action="javascript:;"></form>`, { listener: false });
    expect(result).toMatchObject({ submits: 1, isolated: 1 });
    expect(result.events.map((event) => event.defaultPrevented)).toEqual([false]);
  });

  it("leaves alone a submit event a page dispatches on any other form or element", () => {
    removals.push(installMainWorldClicks());
    document.body.innerHTML = `<form id="a" action="/sign-in"></form><a id="b" href="javascript:;">B</a>`;
    const send = (id: string) =>
      document
        .getElementById(id)!
        .dispatchEvent(new CustomEvent(MAIN_WORLD_SUBMIT, { cancelable: true }));
    expect([send("a"), send("b")]).toEqual([true, true]);
  });
});
