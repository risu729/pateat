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

  it("matches links by text only when asked, for an account switch", () => {
    page(
      `<a id="a" href="/switch"> Use another <b>account</b> </a><a id="b">Use another account</a>
      <a id="c" href="/x" hidden>Use another account</a><button id="d">Use another account</button>`,
    );
    const target = { by: "text", value: "Use another account" } as const;
    expect(ids(findTargets(document, target))).toEqual(["d"]);
    expect(ids(findTargets(document, target, { links: true }))).toEqual(["a", "d"]);
  });

  it("matches links that run a script by text like buttons, and other links only when asked", () => {
    page(
      `<a id="a" href="javascript:;" onclick="login()"><span>ログイン</span></a>
      <a id="b" onclick="login()">パスキー</a><a id="c" href="#" onclick="go()">次へ</a>
      <a id="d" href="/help">次へ</a><div id="e" role="button">ログイン</div>`,
    );
    expect(ids(findTargets(document, { by: "text", value: "ログイン" }))).toEqual(["a"]);
    expect(ids(findTargets(document, { by: "text", value: "パスキー" }))).toEqual(["b"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }))).toEqual(["c"]);
    expect(ids(findTargets(document, { by: "text", value: "次へ" }, { links: true }))).toEqual([
      "c",
      "d",
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
