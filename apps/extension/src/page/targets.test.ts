import { afterEach, describe, expect, it } from "vitest";
import { findTargets } from "./targets";
import { buttonText } from "./text";

// Runs in Chromium (vitest browser mode) so rendering decides which text counts.
const page = (html: string) => {
  document.body.innerHTML = html;
};
const ids = (elements: Element[]) => elements.map((element) => element.id);
afterEach(() => {
  document.body.innerHTML = "";
});

describe("findTargets", () => {
  it("compares attribute strings, so selector syntax in a value is inert", () => {
    page(
      `<input id="a" name="ctl00$Main$txtUserId"><input id="b" name="user[login]">
      <input id="c" data-testid="go"><input id="d" name="x'] , [name"><input id="e" name="x">`,
    );
    expect(ids(findTargets(document, { by: "name", value: "ctl00$Main$txtUserId" }))).toEqual([
      "a",
    ]);
    expect(ids(findTargets(document, { by: "name", value: "user[login]" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "test-id", value: "go" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "name", value: "x'] , [name" }))).toEqual(["d"]);
    expect(ids(findTargets(document, { by: "id", value: "a" }))).toEqual(["a"]);
  });

  it("matches links by text only when asked and no button shows the text, for an account switch", () => {
    page(
      `<a id="a" href="/switch"> Use another <b>account</b> </a><a id="b">Use another account</a>
      <a id="c" href="/x" hidden>Use another account</a><button id="d">Use another account</button>`,
    );
    const target = { by: "text", value: "Use another account" } as const;
    expect(ids(findTargets(document, target))).toEqual(["d"]);
    // A button with the text hides the link; without one, the link alone matches.
    expect(ids(findTargets(document, target, { links: true }))).toEqual(["d"]);
    document.getElementById("d")!.remove();
    expect(ids(findTargets(document, target, { links: true }))).toEqual(["a"]);
  });

  it("matches links that run a script by text when no native button shows it", () => {
    page(
      `<a id="a" href="javascript:;" onclick="login()"><span>ログイン</span></a>
      <a id="b" onclick="login()">パスキー</a><a id="c" href="#" onclick="go()">次へ</a>
      <a id="d" href="/help">次へ</a><div id="e" role="button">ログイン</div>
      <a id="f" href="#" onclick="tab()">Login</a><input id="g" type="submit" value="Login">`,
    );
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["a"]);
    expect(ids(findTargets(document, { by: "text", value: "パスキー" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }, { links: true }))).toEqual([
      "c",
    ]);
    // A button of either kind hides other links from an account switch.
    page(`<a id="h" href="#" onclick="sw()">Switch</a><a id="i" href="/other">Switch</a>`);
    expect(ids(findTargets(document, { by: "text", value: "Switch" }, { links: true }))).toEqual([
      "h",
    ]);
    // A hidden native button with the text hides script links too, so a click waits for it.
    page(
      `<a id="j" href="#" role="button">次へ</a><button id="k" style="display:none">次へ</button>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual([]);
    // A switch link still matches: the hidden button holds back script links only.
    page(`<a id="l" href="/switch">Switch</a><button id="m" type="button" hidden>Switch</button>`);
    expect(ids(findTargets(document, { by: "text", value: "Switch" }, { links: true }))).toEqual([
      "l",
    ]);
    page(
      `<a id="j" href="#" role="button">次へ</a><button id="k" style="display:none">次へ</button>`,
    );
    document.getElementById("k")!.style.display = "";
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["k"]);
    page(`<a id="f" href="#" onclick="tab()">Login</a><input id="g" type="submit" value="Login">`);
    // A native button with the text hides script links, also from an account switch.
    expect(ids(findTargets(document, { by: "text", value: "Login" }))).toEqual(["g"]);
    expect(ids(findTargets(document, { by: "text", value: "Login" }, { links: true }))).toEqual([
      "g",
    ]);
  });

  it("matches buttons by collapsed rendered text, input value or image alt", () => {
    page(
      `<button id="a"> <span>ログ</span><span>​イン</span> </button>
      <input id="b" type="submit" value=" Sign
        in ">
      <input id="c" type="image" src="data:," alt="次へ" width="20" height="20">
      <input id="d" type="button" value="Back">
      <button id="e"><img src="data:," alt="ignored">Help<script>x</script><span hidden>!</span></button>
      <button id="f"><img src="data:," alt="ログイン" width="20" height="20"></button>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "Sign in" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "text", value: "Back" }))).toEqual(["d"]);
    expect(ids(findTargets(document, { by: "text", value: "Help" }))).toEqual(["e"]);
    // A text button and an image-only button with the same name are ambiguous.
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["a", "f"]);
    document.getElementById("a")!.remove();
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["f"]);
  });

  it("matches an image-only link by its images' alt, with links", () => {
    page(
      `<a id="a" href="/my/"><img src="data:," alt="マイページ" width="24" height="24"></a>
      <a id="b" href="/news"><img src="data:," alt="ignored">News</a>
      <a id="c" href="/logout"><img src="data:," alt="ログアウト" hidden></a>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "マイページ" }))).toEqual([]);
    expect(
      ids(findTargets(document, { by: "text", value: "マイページ" }, { links: true })),
    ).toEqual(["a"]);
    // Text wins over images, and a hidden image names nothing.
    expect(ids(findTargets(document, { by: "text", value: "News" }, { links: true }))).toEqual([
      "b",
    ]);
    expect(findTargets(document, { by: "text", value: "ignored" }, { links: true })).toEqual([]);
    expect(findTargets(document, { by: "text", value: "ログアウト" }, { links: true })).toEqual([]);
  });

  it("never matches non-buttons, hidden buttons or partial text, and returns every duplicate", () => {
    page(
      `<a id="a" href="/">Log in</a><label id="b">Log in</label><input id="c" value="Log in">
      <input id="d" type="reset" value="Log in"><button id="e" hidden>Log in</button>
      <button id="f" style="display:none">Log in</button><div aria-hidden="true"><button id="g">Log in</button></div>
      <button id="h">Log in now</button>`,
    );
    expect(findTargets(document, { by: "text", value: "Log in" })).toEqual([]);
    page(`<button id="a">OK</button><input id="b" type="submit" value="OK">`);
    expect(ids(findTargets(document, { by: "text", value: "OK" }))).toEqual(["a", "b"]);
  });

  it("gives no text to buttons whose text is empty or longer than the locator limit", () => {
    page(
      `<button id="a"></button><input id="b" type="submit"><button id="c">${"x".repeat(121)}</button>
      <button id="d">${"x".repeat(120)}</button>
      <button id="e"><span>Sign in</span>${" ".repeat(500)}<span>and delete account</span></button>`,
    );
    expect(["a", "b", "c", "d", "e"].map((id) => buttonText(document.getElementById(id)!))).toEqual(
      [undefined, undefined, undefined, "x".repeat(120), undefined],
    );
  });
});
