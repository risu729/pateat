import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_WORLD_CLICK,
  installMainWorldClicks,
  pressElement,
  runsScriptUrl,
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
function press(html: string | (() => Element), { listener = true } = {}) {
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
    pressElement(target as HTMLElement);
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
});

describe("pressElement", () => {
  it("has the main world click a `javascript:` link once, and runs its URL once", async () => {
    const result = press(
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

  it("reaches a `javascript:` link inside an open shadow root", () => {
    const shadowLink = () => {
      document.body.innerHTML = "<div></div>";
      const link = Object.assign(document.createElement("a"), { href: "javascript:void 0" });
      document.querySelector("div")!.attachShadow({ mode: "open" }).append(link);
      return link;
    };
    expect(press(shadowLink)).toMatchObject({ clicks: 1, isolated: 0 });
  });

  it("clicks other links, buttons and script links without a `javascript:` URL as before", () => {
    for (const html of [
      `<a id="t" href="#next">Next</a>`,
      `<a id="t" href="#" onclick="return false">Log in</a>`,
      `<a id="t" role="button">Log in</a>`,
      `<button id="t" type="button">Log in</button>`,
      `<input id="t" type="button" value="Log in">`,
    ]) {
      for (const remove of removals.splice(0)) remove();
      const result = press(html);
      expect(result, html).toMatchObject({ clicks: 1, isolated: 1, events: [] });
    }
  });

  it("clicks a `javascript:` link itself when no main-world listener answers", () => {
    const result = press(`<a id="t" href="javascript:void 0">Go</a>`, { listener: false });
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

  it("stops clicking once removed", () => {
    installMainWorldClicks()();
    const result = press(`<a id="t" href="javascript:void 0">Go</a>`, { listener: false });
    expect(result).toMatchObject({ clicks: 1, isolated: 1 });
  });
});
