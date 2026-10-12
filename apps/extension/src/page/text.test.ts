import { afterEach, describe, expect, it } from "vitest";
import { collapseText, isScriptButton, renderedText, shown } from "./text";

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
