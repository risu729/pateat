import { afterEach, describe, expect, it } from "vitest";
import { pressPointer } from "./pointer-press";
import { pressElement } from "./script-url-click";

const names = [
  "pointerout",
  "pointerleave",
  "pointerover",
  "pointerenter",
  "mouseout",
  "mouseleave",
  "mouseover",
  "mouseenter",
  "pointermove",
  "mousemove",
  "pointerdown",
  "mousedown",
  "focus",
  "pointerup",
  "mouseup",
  "click",
] as const;

afterEach(() => {
  document.body.innerHTML = "";
});

/** Records the events `targets` get, in order, while `press` runs. */
async function record(
  targets: readonly EventTarget[],
  press: () => Promise<unknown>,
): Promise<{ type: string; at: EventTarget; event: Event }[]> {
  const events: { type: string; at: EventTarget; event: Event }[] = [];
  const listeners = targets.map((at) => {
    const listener = (event: Event) => {
      // Only events sent to this target itself, not ones bubbling up from below, and not
      // the trusted boundary events Chromium sends when the page changes under the test's
      // mouse; `focus()` sends a trusted `focus`.
      if (event.target === at && (!event.isTrusted || event.type === "focus"))
        events.push({ type: event.type, at, event });
    };
    for (const name of names) at.addEventListener(name, listener);
    return () => {
      for (const name of names) at.removeEventListener(name, listener);
    };
  });
  try {
    await press();
  } finally {
    for (const remove of listeners) remove();
  }
  return events;
}

const typesOf = (events: { type: string }[]) => events.map(({ type }) => type);

describe("pressElement", () => {
  it("sends a person's mouse events, at the button's centre, before one click", async () => {
    document.body.innerHTML = `<form><input id="password" type="password">
      <button id="t" type="button" style="position: fixed; left: 40px; top: 60px; width: 100px; height: 20px">Log in</button></form>`;
    const button = document.getElementById("t")!;
    document.getElementById("password")!.focus();
    const events = await record([button], () => pressElement(button));
    expect(typesOf(events)).toEqual([
      "pointerover",
      "pointerenter",
      "mouseover",
      "mouseenter",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "focus",
      "pointerup",
      "mouseup",
      "click",
    ]);
    for (const { type, event } of events) {
      if (type === "click" || type === "focus") continue;
      expect(event, type).toMatchObject({ clientX: 90, clientY: 70, isTrusted: false });
      const enter = type.endsWith("enter");
      expect(event, type).toMatchObject({
        bubbles: !enter,
        cancelable: !enter,
        composed: !enter,
      });
    }
    const event = (type: string) => events.find((sent) => sent.type === type)!.event;
    expect(event("pointerover")).toMatchObject({ button: -1, relatedTarget: null });
    expect(event("pointerdown")).toMatchObject({
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      pressure: 0.5,
      detail: 0,
    });
    expect(event("mousedown")).toMatchObject({ button: 0, buttons: 1, detail: 1 });
    expect(event("pointerup")).toMatchObject({ buttons: 0, pressure: 0, detail: 0 });
    expect(event("mouseup")).toMatchObject({ button: 0, buttons: 0, detail: 1 });
    expect(document.activeElement).toBe(button);
  });

  it("enters the element's ancestors outermost first, and leaves the last pressed one", async () => {
    document.body.innerHTML = `<div id="menu"><button id="a" type="button">A</button></div>
      <div id="form"><span id="wrap"><button id="b" type="button">B</button></span></div>`;
    const [menu, a, form, wrap, b] = ["menu", "a", "form", "wrap", "b"].map((id) =>
      document.getElementById(id)!,
    ) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    const first = await record([document.body, menu, a], () => pressElement(a));
    expect(
      first.filter(({ type }) => type === "mouseenter").map(({ at }) => (at as Element).id),
    ).toEqual(["", "menu", "a"]);
    const second = await record([document.body, menu, a, form, wrap, b], () => pressElement(b));
    const boundary = second
      .filter(({ type }) => !/move|down|up|click|focus/u.test(type))
      .map(({ type, at }) => `${type}@${(at as Element).id}`);
    expect(boundary).toEqual([
      "pointerout@a",
      "pointerleave@a",
      "pointerleave@menu",
      "pointerover@b",
      "pointerenter@form",
      "pointerenter@wrap",
      "pointerenter@b",
      "mouseout@a",
      "mouseleave@a",
      "mouseleave@menu",
      "mouseover@b",
      "mouseenter@form",
      "mouseenter@wrap",
      "mouseenter@b",
    ]);
    expect(second.find(({ type }) => type === "mouseout")!.event).toMatchObject({
      relatedTarget: b,
    });
    expect(second.find(({ type }) => type === "mouseover")!.event).toMatchObject({
      relatedTarget: a,
    });
    // Pressing it again moves no mouse onto it.
    const third = await record([b], () => pressElement(b));
    expect(typesOf(third)[0]).toBe("pointermove");
  });

  it("moves between two buttons of one shadow root without leaving the page", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<div id="sa"><button id="a">A</button></div><div id="sb"><button id="b">B</button></div>`;
    const [sa, a, sb, b] = ["sa", "a", "sb", "b"].map((id) => root.getElementById(id)!);
    await pressElement(a!);
    const targets = [document.documentElement, document.body, host, sa!, a!, sb!, b!];
    const moved = await record(targets, () => pressElement(b!));
    expect(
      moved
        .filter(({ type }) => /^mouse(leave|enter)$/u.test(type))
        .map(({ type, at }) => `${type}@${(at as Element).id}`),
    ).toEqual(["mouseleave@a", "mouseleave@sa", "mouseenter@sb", "mouseenter@b"]);
  });

  it("presses a control that acts only on `mousedown`", async () => {
    document.body.innerHTML = `<div id="t" role="button">Log in</div>`;
    const control = document.getElementById("t")!;
    let pressed = 0;
    control.addEventListener("mousedown", () => {
      pressed += 1;
    });
    expect(await pressElement(control)).toBe("clicked");
    expect(pressed).toBe(1);
  });

  it("lets a page render between `mousedown` and the click, as it does for a person", async () => {
    document.body.innerHTML = `<form id="f"><button id="t">Log in</button></form>`;
    const form = document.getElementById("f") as HTMLFormElement;
    const button = document.getElementById("t") as HTMLButtonElement;
    let submits = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submits += 1;
    });
    // A framework that submits on `mousedown` and disables the button in its next render.
    button.addEventListener("mousedown", () => {
      submits += 1;
      queueMicrotask(() => {
        button.disabled = true;
      });
    });
    await pressElement(button);
    expect(submits).toBe(1);
  });

  it("sends no `mousedown` or `mouseup` after a cancelled `pointerdown`, and still clicks", async () => {
    document.body.innerHTML = `<input id="code"><button id="t" type="button">Log in</button>`;
    const input = document.getElementById("code") as HTMLInputElement;
    const button = document.getElementById("t")!;
    input.focus();
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    const types = typesOf(await record([button], () => pressElement(button)));
    expect(types).not.toContain("mousedown");
    expect(types).not.toContain("mouseup");
    expect(types).not.toContain("focus");
    expect(types.at(-1)).toBe("click");
    expect(document.activeElement).toBe(input);
  });

  it("keeps focus where it was after a cancelled `mousedown`", async () => {
    document.body.innerHTML = `<input id="code"><button id="t" type="button">Verify</button>`;
    const input = document.getElementById("code") as HTMLInputElement;
    const button = document.getElementById("t")!;
    input.focus();
    button.addEventListener("mousedown", (event) => event.preventDefault());
    const types = typesOf(await record([button], () => pressElement(button)));
    expect(types).toContain("mouseup");
    expect(types.at(-1)).toBe("click");
    expect(document.activeElement).toBe(input);
  });

  it("focuses the nearest focusable ancestor, or blurs the field when there is none", async () => {
    document.body.innerHTML = `<input id="code"><div id="card" tabindex="-1"><span id="inner">Go</span></div>
      <div id="plain" role="button">Log in</div>`;
    const input = document.getElementById("code") as HTMLInputElement;
    input.focus();
    await pressElement(document.getElementById("inner")!);
    expect(document.activeElement).toBe(document.getElementById("card"));
    input.focus();
    let blurred = 0;
    input.addEventListener("blur", () => {
      blurred += 1;
    });
    await pressElement(document.getElementById("plain")!);
    expect(blurred).toBe(1);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not click a button its `mousedown` handler removed", async () => {
    document.body.innerHTML = `<form id="f"><button id="t" type="submit">Log in</button></form>`;
    const form = document.getElementById("f") as HTMLFormElement;
    const button = document.getElementById("t")!;
    let submits = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submits += 1;
    });
    button.addEventListener("mousedown", () => {
      form.requestSubmit();
      form.replaceChildren();
    });
    let pressed: string | undefined;
    const types = typesOf(
      await record([button], async () => {
        pressed = await pressElement(button);
      }),
    );
    expect(pressed).toBe("stopped");
    expect(types).not.toContain("click");
    expect(submits).toBe(1);
  });

  it("presses nothing when the moving events removed the element, or `between` stops it", async () => {
    document.body.innerHTML = `<div id="box"><button id="t" type="button">Log in</button></div>`;
    const button = document.getElementById("t")!;
    button.addEventListener("mouseover", () => document.getElementById("box")!.replaceChildren());
    const types = typesOf(await record([button], () => pressElement(button)));
    expect(types).not.toContain("pointerdown");
    expect(types).not.toContain("click");
    document.body.innerHTML = `<button id="t" type="button">Log in</button>`;
    const other = document.getElementById("t")!;
    expect(await pressElement(other, () => false)).toBe("missed");
  });

  it("submits a form once through its button", async () => {
    document.body.innerHTML = `<form id="f"><input name="u" value="me"><button id="t">Log in</button></form>`;
    const form = document.getElementById("f") as HTMLFormElement;
    let submits = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submits += 1;
    });
    expect(await pressElement(document.getElementById("t")!)).toBe("clicked");
    expect(submits).toBe(1);
  });
});

describe("pressPointer", () => {
  it("aims at the first box of a link that wraps onto two lines", async () => {
    document.body.innerHTML = `<p style="width: 120px; font: 16px/20px monospace; margin: 0">
      <a id="t" href="#">sign in to your account now</a></p>`;
    const link = document.getElementById("t")!;
    const [first] = link.getClientRects();
    const events = await record([link], () => pressPointer(link));
    expect(events[0]!.event).toMatchObject({
      clientX: first!.left + first!.width / 2,
      clientY: first!.top + first!.height / 2,
    });
  });
});
