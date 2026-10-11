import { afterEach, describe, expect, it } from "vitest";
import { collapseText, renderedText } from "./text";

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
