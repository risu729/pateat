import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collapseText,
  controlContent,
  controlName,
  isFragmentButton,
  isScriptButton,
  renderedText,
  shown,
} from "./text";

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

afterEach(() => {
  document.body.innerHTML = "";
});

const read = (html: string, options?: Parameters<typeof renderedText>[2]) => {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return collapseText(renderedText(document.getElementById("root")!, 4000, options) ?? "");
};

describe("renderedText", () => {
  it("separates blocks from the inline text around them, but not inline elements", () => {
    expect(read("<p>Customer</p><label>Number</label>")).toBe("Customer Number");
    expect(read("<span>Sign</span><b>in</b>")).toBe("Signin");
    expect(read("<span>Sign</span><b>in</b>", { everyElement: true })).toBe("Sign in");
  });

  it("ignores hidden line breaks and skipped elements", () => {
    expect(read('Sign<br hidden>in<br style="display:none">now')).toBe("Signinnow");
    expect(read("Sign<br>in")).toBe("Sign in");
    expect(read('Call <a href="tel:1">us</a> now', { skip: "a" })).toBe("Call now");
  });

  it("does not separate words at a <wbr> line-break opportunity", () => {
    expect(read("taro@<wbr>example.com")).toBe("taro@example.com");
    expect.soft(read("taro@<wbr>example.com", { everyElement: true })).toBe("taro@example.com");
    expect(
      read("<header><span>taro.yamada@<wbr>example.com</span></header>", { everyElement: true }),
    ).toBe("taro.yamada@example.com");
  });

  it("reads an element with very many children", () => {
    document.body.innerHTML = `<div id="root"><div id="wide"></div></div>`;
    const root = document.getElementById("root")!;
    const children = document.createDocumentFragment();
    for (let index = 0; index < 200_000; index += 1) children.append("a");
    document.getElementById("wide")!.append(children);
    expect(renderedText(root, 10)).toHaveLength(11);
  });
});

describe("shown", () => {
  it("counts an element with display: contents as shown when its parent is", () => {
    // Cloudflare's saved profiles wrap each address in such a span (2026-10-12).
    expect(
      read(
        '<button><span style="display: contents"><span style="display: block">a@example.com</span></span></button>',
      ),
    ).toBe("a@example.com");
    document.body.innerHTML = `
      <div id="hidden" style="display: none"><span id="inside" style="display: contents">a</span></div>
      <span id="invisible" style="display: contents; visibility: hidden">b</span>
      <span id="aria" aria-hidden="true" style="display: contents">c</span>
      <span id="plain" style="display: contents">d</span>
    `;
    const by = (id: string) => document.getElementById(id)!;
    expect(shown(by("inside"))).toBe(false);
    expect(shown(by("invisible"))).toBe(false);
    expect(shown(by("aria"))).toBe(false);
    expect(shown(by("plain"))).toBe(true);
    // Content its parent does not render.
    document.body.innerHTML = `
      <details><summary>s</summary><span id="closed" style="display: contents">a</span></details>
      <div style="content-visibility: hidden"><span id="skipped" style="display: contents">b</span></div>
      <div><span id="none" style="display: contents"><span style="display: none">c</span></span></div>
      <details open><summary>s</summary><span id="open" style="display: contents">d</span></details>
    `;
    expect(shown(by("closed"))).toBe(false);
    expect(shown(by("skipped"))).toBe(false);
    expect(shown(by("none"))).toBe(false);
    expect(shown(by("open"))).toBe(true);
  });

  it("counts an element as opaque while every transparent ancestor fades in", () => {
    document.body.innerHTML = `
      <div id="outer" style="opacity: 0"><div id="inner" style="opacity: 0">
        <b id="text">Sign in</b></div></div>
      <div id="host"><span id="slotted">Next</span></div>
    `;
    const by = (id: string) => document.getElementById(id)!;
    const fade = (element: HTMLElement) =>
      element.animate([{ opacity: 0 }, { opacity: 1 }], 5000).pause();
    fade(by("inner"));
    // An outer ancestor at opacity 0 without an animation still hides it.
    expect(shown(by("text"))).toBe(false);
    expect(shown(by("text"), false)).toBe(true);
    fade(by("outer"));
    expect(shown(by("text"))).toBe(true);
    expect(collapseText(renderedText(by("outer"), 100) ?? "")).toBe("Sign in");
    // The walk follows the flat tree, from a slotted element through the shadow root.
    const root = by("host").attachShadow({ mode: "open" });
    root.innerHTML = `<div style="opacity: 0"><slot></slot></div>`;
    expect(shown(by("slotted"))).toBe(false);
    fade(root.querySelector("div")!);
    expect(shown(by("slotted"))).toBe(true);
  });

  it("walks a closed shadow root to the slot that renders an element", () => {
    document.body.innerHTML = `<div id="outer"><div id="host"><b id="text">Next</b></div></div>`;
    const by = (id: string) => document.getElementById(id)!;
    const root = by("host").attachShadow({ mode: "closed" });
    closedRoots.set(by("host"), root);
    root.innerHTML = `<div style="opacity: 0"><slot></slot></div>`;
    by("outer").style.opacity = "0";
    by("outer")
      .animate([{ opacity: 0 }, { opacity: 1 }], 5000)
      .pause();
    // The shadow root's transparent container does not fade.
    expect(shown(by("text"))).toBe(false);
    root
      .querySelector("div")!
      .animate([{ opacity: 0 }, { opacity: 1 }], 5000)
      .pause();
    expect(shown(by("text"))).toBe(true);
  });

  it("counts an animation only while its current iteration still raises the opacity", () => {
    document.body.innerHTML = `<style>
        @keyframes out { to { opacity: 0 } }
        @keyframes half { 0% { opacity: 1 } 50%, 100% { opacity: 0 } }
      </style>
      <div id="fade"><b id="text">Sign in</b></div>`;
    const fade = document.getElementById("fade")!;
    const text = document.getElementById("text")!;
    for (const [animation, expected] of [
      // A fade-out played in reverse fades in.
      ["out 5s reverse paused", true],
      // Halfway through the first iteration, heading to opacity 0 for the rest of it.
      ["half 10s -5s alternate infinite paused", false],
      // Halfway through the second iteration, which plays back toward opacity 1.
      ["half 10s -15s alternate infinite paused", true],
      ["half 10s -15s alternate-reverse infinite paused", false],
    ] as const) {
      fade.style.animation = animation;
      expect(getComputedStyle(fade).opacity, animation).toBe("0");
      expect(shown(text), animation).toBe(expected);
    }
  });
});

describe("isScriptButton", () => {
  it("accepts onclick links without href and role=button, but not controls or links", () => {
    document.body.innerHTML = `<a id="a" onclick="return false">Log in</a><div id="b" role=" Button ">Next</div>
      <a id="c">Help</a><a id="d" href="/x" role="button">Docs</a><input id="e" role="button">
      <button id="f" role="button">Go</button><a href="/card"><span id="g" role="button">Open</span></a>
      <select id="h" role="button"></select>`;
    const script = (id: string) => isScriptButton(document.getElementById(id)!);
    expect(["a", "b", "c", "d", "e", "f", "g", "h"].map(script)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("accepts a link without href that shows a pointer cursor, as IIJmio's login", () => {
    document.body.innerHTML = `<style>.btn { cursor: pointer }</style>
      <a id="a" class="btn">ログイン</a><a id="b">ログイン</a><a id="c" href="#" class="btn">Top</a>
      <a id="d" href="/help" class="btn">Help</a><div class="btn"><a id="e">Card</a></div>
      <a id="f" style="cursor: url(data:,), pointer">Go</a>`;
    const script = (id: string) => isScriptButton(document.getElementById(id)!);
    // A link inside a clickable card only inherits the pointer.
    expect(["a", "b", "c", "d", "e", "f"].map(script)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("accepts links that run a script instead of following the link", () => {
    document.body.innerHTML = `<a id="a" href="#" onclick="return false">Log in</a>
      <a id="b" href="javascript:;">Log in</a><a id="c" href=" JavaScript:void(0)">Go</a>
      <a id="d" href="" onclick="go()">Go</a><a id="e" href="#top" role="button">Go</a>
      <a id="f" href="#">Top</a><a id="g" href="#top">Top</a><a id="h" href="/x" onclick="track()">Docs</a>
      <a href="javascript:;"><span id="i" role="button">Open</span></a><a id="j" href="java&#9;script:;">Go</a>
      <a id="k" href="&#1;javascript:;">Go</a><a id="l" href="&#xA0;javascript:x">Go</a><a id="m" role="button">Go</a>
      <a id="n" href="data:text/plain,x">Go</a><a id="o" href="VBScript:x">Go</a>`;
    const script = (id: string) => isScriptButton(document.getElementById(id)!);
    expect(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"].map(script),
    ).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
  });
});

// ADR 0048 amendment of 2026-10-19.
describe("isFragmentButton", () => {
  const link = (attributes: string) => {
    document.body.innerHTML = `<a id="x" ${attributes}>Select</a>`;
    return isFragmentButton(document.getElementById("x")!);
  };

  it("takes a link to a fragment of its own document that opens in the same tab", () => {
    for (const attributes of [
      'href="#"',
      'href="#password"',
      'href=" #"',
      'href="#" target="_self"',
    ])
      expect(link(attributes), attributes).toBe(true);
  });

  it("refuses a link that leaves, reloads, opens elsewhere, downloads or runs a script", () => {
    for (const attributes of [
      'href=""',
      'href="?next#x"',
      'href="/elsewhere#x"',
      'href="#" target="_blank"',
      'href="#" target="login"',
      'href="#" download',
      // A script link is a script button already.
      'href="#" onclick="void 0"',
      'href="#" role="button"',
      'href="javascript:void(0)"',
      // A link without `href`.
      'name="x"',
      // A route a page's router reads, which may go to another page.
      'href="#/account/delete"',
      'href="#/"',
      'href="#!/account"',
      'href="#!"',
    ])
      expect(link(attributes), attributes).toBe(false);
  });

  it("reads the document's <base> as the browser does", () => {
    const base = document.createElement("base");
    document.head.append(base);
    try {
      base.target = "_blank";
      expect(link('href="#"')).toBe(false);
      expect(link('href="#" target="_self"')).toBe(true);
      base.removeAttribute("target");
      base.href = "https://elsewhere.example/";
      expect(link('href="#"')).toBe(false);
      base.href = location.href;
      expect(link('href="#"')).toBe(true);
    } finally {
      base.remove();
    }
  });
});

describe("controlName", () => {
  it("reads aria-labelledby, else aria-label, of a shown control only", () => {
    document.body.innerHTML = `<span id="t1">Use</span><span id="t2">password</span>
      <button id="a" aria-labelledby="t1 t2" aria-label="Ignored">Select</button>
      <a id="b" href="#" aria-label=" Select   Password. ">Select</a>
      <button id="c" aria-label="Hidden" hidden>Select</button>
      <button id="d">Select</button>
      <button id="e" aria-label="${"x".repeat(121)}">Select</button>
      <a id="f" href="/next" aria-label="Leave">Leave</a>
      <input id="g" aria-label="A field">
      <button id="h" aria-labelledby="missing" aria-label="Fallback">Select</button>`;
    expect(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        controlName(document.getElementById(id)!),
      ),
    ).toEqual([
      "Use password",
      "Select Password.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "Fallback",
    ]);
  });
});

describe("controlContent", () => {
  const content = (html: string) => {
    document.body.innerHTML = `<a id="x" href="#" aria-label="Select Password.">${html}</a>`;
    return controlContent(document.getElementById("x")!);
  };

  it("reads all the text a control holds, hidden text too, every element apart", () => {
    expect(content("Select")).toBe("Select");
    expect(content('<span aria-hidden="true">Send code</span>')).toBe("Send code");
    expect(content('<span hidden>Send</span><span style="display:none">code</span>')).toBe(
      "Send code",
    );
    expect(content("<span>Send</span><b>code</b>")).toBe("Send code");
    expect(content('<img alt="Phone"> Select')).toBe("Phone Select");
    expect(content('<input type="button" value="Send code">')).toBe("Send code");
    expect(content('<input type="image" alt="Phone">')).toBe("Phone");
    expect(content("<script>var code = 1</script><style>.code{}</style>Select")).toBe("Select");
  });

  it("reads an input button's own value and an image button's own alt", () => {
    document.body.innerHTML = `<input id="a" type="submit" value="Send code">
      <input id="b" type="image" alt="Phone" value="Ignored">`;
    expect(controlContent(document.getElementById("a")!)).toBe("Send code");
    expect(controlContent(document.getElementById("b")!)).toBe("Phone");
  });

  it("reads open and closed shadow roots", () => {
    document.body.innerHTML = `<button id="x"><span id="open"></span><span id="closed"></span></button>`;
    const by = (id: string) => document.getElementById(id)!;
    by("open").attachShadow({ mode: "open" }).innerHTML = "Send";
    const root = by("closed").attachShadow({ mode: "closed" });
    closedRoots.set(by("closed"), root);
    root.innerHTML = "<b>code</b>";
    expect(controlContent(by("x"))).toBe("Send code");
  });

  it("is empty only for a control that holds no text, and unread when too long", () => {
    expect(content('<svg width="20" height="20"></svg>')).toBe("");
    expect(content("  ")).toBe("");
    // Longer than a button's text, but read in full.
    expect(content("Select ".repeat(30))).toBe("Select ".repeat(30).trim());
    expect(content("Select ".repeat(80))).toBeUndefined();
    expect(content(`<span aria-hidden="true">${"Select ".repeat(80)}</span>`)).toBeUndefined();
  });
});
